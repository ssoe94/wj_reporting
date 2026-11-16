"""Run the scale, print and reread paths independently of browser and network I/O."""

from decimal import Decimal
import sqlite3
from threading import Event, RLock
from time import monotonic
from uuid import uuid4

from .. import __version__
from ..protocol import event_time, timestamp
from .devices import (
    FakePrinter, FakeScale, FakeScanner, ScannerService, SerialScale, SignalWorker, VirtualSignal,
    make_printer_transport,
)
from .rules import CycleGate
from .scale_protocol import FrameDecoder
from .scale_stability import RangeStability
from .store import WeighStore


def make_devices(settings, fake=False):
    if fake:
        return FakeScale(), FakePrinter(), FakeScanner(), SignalWorker(device=VirtualSignal())
    devices = settings.devices
    scale_config = devices.get("scale", {})
    printer_config = devices.get("printer", {})
    scanner_config = dict(devices.get("scanner", {}))
    light_config = devices.get("signal", {})
    scale = SerialScale(scale_config.get("port"), scale_config.get("baudrate", 9600))
    signal_port = light_config.get("light_serial_port") if light_config.get("light_mode") == "k50l_serial" else None
    if isinstance(signal_port, str) and signal_port.strip().upper() == scale.port.upper():
        raise ValueError("The scale and K50L signal need different ports")
    if printer_config.get("printer_mode") not in ("tcp", "windows_raw", "idprt_usb"):
        raise ValueError("Select a weigh printer or use fake devices")
    if printer_config["printer_mode"] == "idprt_usb" and any(
        variant["layout"]["language"] != "zpl"
        for item in settings.products.values() for variant in item.templates.values()
    ):
        raise ValueError("The notebook USBPRINT driver uses native ZPL layouts")
    printer = make_printer_transport(printer_config)
    reserved = [scale.port, signal_port]
    scanner_config["reserved_ports"] = [port for port in reserved if port]
    return scale, printer, ScannerService(scanner_config), SignalWorker(light_config)


class WeighApp:
    def __init__(self, ledger, settings, devices, changed, *, clock=timestamp, tick=monotonic):
        self.settings = settings
        self.scale, self.printer, self.scanner, self.signal = devices
        self.changed, self.clock, self.tick = changed, clock, tick
        self.store = WeighStore(ledger, settings, clock=clock)
        self.lock = RLock()
        self.print_wake = Event()
        self.decoder = FrameDecoder()
        self.stability = RangeStability()
        self.gate = CycleGate()
        self.storage_error = False
        self.disk_full = False
        self.coverage = "known"
        self._refresh()
        self.last_result, self.last_reread = self.store.last()
        self.last_work = max((row["time"] for row in (self.last_result, self.last_reread) if row), default=None)
        self.scale_state = "disconnected"
        self.scale_input = None
        self._scale_tick = None
        self._reading = None
        self._stable = self._empty = False
        self._scanner_state = {}
        self._printer_state = "unknown"
        self._printer_input = None
        self._next_try = 0.0

    def _notify(self, state_changed=False, activity=True):
        self.changed(state_changed=state_changed, activity=activity)
        self.print_wake.set()

    def _refresh(self):
        self.state = self.store.queue()
        self.jobs = self.store.recent_jobs()
        self.serial = self.store.serial_status(event_time(self.clock()).date())

    def _fault(self, error):
        self.storage_error = True
        self.disk_full = self.disk_full or getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL
        self.coverage = "partial"
        self.gate.reset()
        if self.signal:
            self.signal.set_state("red", "ng")
        self._notify(state_changed=True)

    def _disconnect(self):
        with self.lock:
            changed = self.scale_state != "fault"
            self.decoder = FrameDecoder()
            self.stability.reset()
            self.gate.reset()
            self._scale_tick = None
            self._stable = self._empty = False
            self.scale_state = "fault"
            if changed:
                self._notify(state_changed=True, activity=False)

    def feed_scale(self, chunk, *, seen_at=None, received_at=None):
        """Process complete LF frames on the scale owner. No network or printer call."""
        with self.lock:
            for reading in self.decoder.feed(chunk):
                if reading is None:
                    # A malformed or discarded line breaks the continuous stability window.
                    self.stability.reset()
                    self.gate.reset()
                    self._scale_tick = None
                    self._stable = self._empty = False
                    continue
                stamped = self.tick() if seen_at is None else seen_at
                # A queue of old samples cannot stand in for a fresh reading.
                if self.tick() - stamped > 0.5:
                    self.gate.reset()
                    self.stability.reset()
                    self._stable = self._empty = False
                    continue
                state_change = self.scale_state != "connected" or self.scale_input is None
                if (self._scale_tick is not None and (stamped < self._scale_tick
                        or stamped - self._scale_tick > 0.5 or reading.mode != self._reading.mode)):
                    self.gate.reset()
                self.scale_state = "connected"
                self.scale_input = received_at or self.clock()
                self._reading, self._scale_tick = reading, stamped
                self._stable = self.stability.update(reading.grams, reading.mode, stamped)["stable"]
                grams = Decimal(reading.grams)
                profile = self.store.product.profile
                zero = self.gate.baseline_g if self.gate.baseline_g is not None else Decimal(0)
                previously_empty = self._empty
                self._empty = self._stable and abs(grams - zero) <= profile.empty_threshold_g
                if self.signal and self._empty and not previously_empty and not self.storage_error:
                    self.signal.set_state("yellow")
                if state_change:
                    self._notify(state_changed=True, activity=False)
                if self.state["paused"] or self.storage_error or not self._stable:
                    continue
                if self.gate.baseline_g is None:
                    if self._empty:
                        self.gate.confirm_empty(grams)
                    continue
                cycle = self.gate.observe(grams, profile, stable=True)
                if cycle.status not in ("accepted", "rejected"):
                    continue
                try:
                    recorded = self.store.record(cycle, scale_status=reading.status, scale_mode=reading.mode,
                                                 moment=self.scale_input)
                except sqlite3.Error as error:
                    self._fault(error)
                    return
                if recorded is not None:
                    self.last_result, self.last_work = recorded, recorded["time"]
                    try:
                        self._refresh()
                    except sqlite3.Error as error:
                        self._fault(error)
                        return
                    if self.signal:
                        ok = recorded["result"] == "ok" and "reservation_blocked" not in recorded
                        self.signal.set_state("green" if ok else "red", "ok" if ok else "ng")
                    self._notify(state_changed=self.state["paused"])

    def reread(self, barcode, device, *, source=None, request_id=None, moment=None):
        with self.lock:
            try:
                data = self.store.reread(barcode, device, source=source or ("keyboard" if device == "KEYBOARD" else "serial"),
                                         request_id=request_id, moment=moment)
                if self.last_reread is None or data["seq"] > self.last_reread["seq"]:
                    self.jobs = self.store.recent_jobs()
                    self.last_work, self.last_reread = data["time"], data
                    self._notify()
                return data
            except sqlite3.Error as error:
                self._fault(error)
                raise

    def action(self, action, data):
        if not isinstance(data, dict):
            raise ValueError("Invalid weigh action")
        with self.lock:
            try:
                if action == "reread" and set(data) == {"barcode", "request_id", "source"}:
                    if data["source"] not in ("keyboard", "manual"):
                        raise ValueError("Invalid browser input source")
                    return self.reread(data["barcode"], "KEYBOARD", source=data["source"],
                                       request_id=data["request_id"])
                if action == "product" and set(data) == {"part_no"}:
                    if self.store.select(data["part_no"]):
                        self.gate.reset()
                        self.stability.reset()
                        self._stable = self._empty = False
                elif action == "template" and set(data) == {"template_id", "values"}:
                    if self.store.select_template(data["template_id"], data["values"]):
                        self.gate.reset()
                        self.stability.reset()
                        self._stable = self._empty = False
                else:
                    self.store.action(action, data, storage_recovery=self.storage_error)
                    if action == "resume":
                        self.storage_error = self.disk_full = False
                        self.gate.reset()
                        self._next_try = 0.0
                self._refresh()
            except sqlite3.Error as error:
                self._fault(error)
                raise RuntimeError("The weigh ledger could not save the action") from None
            self._notify(state_changed=True)

    def _observe_printer(self):
        status_method = getattr(self.printer, "queue_status", None)
        if status_method is None:
            return None
        try:
            status = status_method()
            if not isinstance(status, dict) or status.get("errors"):
                raise ValueError("Printer status unavailable")
        except Exception:
            with self.lock:
                changed = self._printer_state != "fault"
                self._printer_state = "fault"
                if changed:
                    self._notify(state_changed=True, activity=False)
            return None
        with self.lock:
            changed = self._printer_state != "connected" or self._printer_input is None
            self._printer_state, self._printer_input = "connected", self.clock()
            if changed:
                self._notify(state_changed=True, activity=False)
        return status

    def dispatch_once(self):
        """Run only on the printer owner; transport begins after a successful commit."""
        with self.lock:
            now = self.tick()
            if self.storage_error or now < self._next_try:
                return None
            peel_pending = self.state["peel_wait"]
            paused = self.state["paused"]
            ready = self.state["waiting"] and not self.state["partial"]
        if not ready and not peel_pending:
            return None
        # Only a submitted row's actual waiting -> ready edge clears its peel gate.
        if peel_pending:
            status = self._observe_printer()
            if status is not None:
                observation = ("waiting" if status.get("label_waiting") is True else
                               "ready" if status.get("ready") is True else None)
                with self.lock:
                    try:
                        if self.store.observe_peel(observation):
                            self._refresh()
                            self._notify(state_changed=True)
                    except sqlite3.Error as error:
                        self._fault(error)
            return None
        if paused:
            return None
        with self.lock:
            try:
                pending = self.store.begin_dispatch()
                self._refresh()
            except sqlite3.Error as error:
                self._fault(error)
                return None
        if pending is None:
            return None
        row, attempt = pending
        result, cause = "submitted", None
        try:
            if isinstance(self.printer, FakePrinter):
                self.printer.peel = bool(row["peel"])
            if self.printer(row["payload"]) is False:
                raise OSError("Printer did not acknowledge transport")
        except Exception as error:
            result = "not_sent" if getattr(error, "print_data_sent", None) is False else "uncertain"
            code = getattr(error, "code", None)
            cause = code.lower().replace("-", "_")[:64] if isinstance(code, str) and code.isascii() else "transport_failure"
        with self.lock:
            self._printer_state = "connected" if result == "submitted" else "fault"
            if result == "submitted":
                self._printer_input = self.clock()
            try:
                self.store.finish(row, attempt, result, cause)
                self._refresh()
            except sqlite3.Error as error:
                # A pre-send journal row remains; startup recovers it as uncertain.
                self._fault(error)
                return None
            if result == "not_sent":
                self._next_try = self.tick() + 2.0
            self._notify(state_changed=True)
        return result

    def run_scale(self, stop):
        try:
            while not stop.is_set():
                try:
                    raw = self.scale.read()
                except OSError:
                    self._disconnect()
                    stop.wait(2)
                    continue
                if raw:
                    self.feed_scale(raw)
                else:
                    with self.lock:
                        if self.scale_state != "connected" and getattr(self.scale, "connected", False):
                            self.scale_state = "connected"
                            self._notify(state_changed=True, activity=False)
                    stop.wait(0.02)
        finally:
            self.scale.close()

    def run_printer(self, stop):
        while not stop.is_set():
            self.dispatch_once()
            self.print_wake.wait(0.25)
            self.print_wake.clear()

    def run_scanner(self, stop):
        pending = None
        buffered = []
        self.scanner.start()
        scanner_held = False
        try:
            while not stop.is_set():
                if pending is None:
                    if not buffered:
                        buffered = self.scanner.drain_events(limit=30)
                    if not buffered:
                        stop.wait(0.08)
                    else:
                        event = buffered.pop(0)
                        kind = event["type"]
                        lane = event["lane"]
                        if kind == "scan":
                            pending = (event["barcode"], lane, uuid4().hex, event["received_at"])
                        elif kind == "frame_error":
                            pending = ("[FRAME:" + str(event.get("raw_hex", ""))[:480] + "]",
                                       lane, uuid4().hex, event["received_at"])
                    snapshots = self.scanner.snapshots()
                    with self.lock:
                        old = {key: (info.get("port_open"), bool(info.get("last_scan_at"))) for key, info in self._scanner_state.items()}
                        self._scanner_state = snapshots
                        new = {key: (info.get("port_open"), bool(info.get("last_scan_at"))) for key, info in snapshots.items()}
                        if new != old:
                            self._notify(state_changed=True, activity=False)
                if pending is not None:
                    if self.storage_error:
                        if not scanner_held:
                            self.scanner.stop(timeout=2)
                            scanner_held = True
                        stop.wait(0.25)
                        continue
                    barcode, lane, request_id, moment = pending
                    try:
                        self.reread(barcode, lane, request_id=request_id, moment=moment)
                    except sqlite3.Error:
                        continue
                    pending = None
                    if scanner_held:
                        self.scanner.start()
                        scanner_held = False
        finally:
            self.scanner.stop(timeout=2)

    def snapshot(self):
        with self.lock:
            fresh = self._scale_tick is not None and 0 <= self.tick() - self._scale_tick <= 0.5
            day = event_time(self.clock()).date()
            if day.isoformat() != self.serial["day"]:
                try:
                    self.serial = self.store.serial_status(day)
                except sqlite3.Error as error:
                    self._fault(error)
            state = dict(self.state)
            if self.storage_error:
                state.update(paused=True, pause_reason="storage_error")
            return {
                "products": [{"part_no": part, "name": item.name} for part, item in self.settings.products.items()],
                "part_no": self.store.product.profile.part_no, "mode": self.settings.mode,
                "weight_g": self._reading.grams if fresh else None, "stable": fresh and self._stable,
                "empty": fresh and self._empty, "storage_error": self.storage_error, "queue": state,
                "last_result": self.last_result, "last_reread": self.last_reread,
                "labels": self.store.label_options(), "jobs": self.jobs, "serial": self.serial,
            }

    def health(self):
        with self.lock:
            apps = [{"app": "weigh_label", "version": __version__, "mode": self.settings.mode,
                     "state": "fault" if self.storage_error else "running", "last_work_at": self.last_work}]
            devices = [
                {"app": "weigh_label", "device": "scale", "state": self.scale_state, "last_input_at": self.scale_input},
                {"app": "weigh_label", "device": "printer", "state": self._printer_state, "last_input_at": self._printer_input},
            ]
            for lane, info in self._scanner_state.items():
                last = info.get("last_scan_at")
                devices.append({"app": "weigh_label", "device": lane,
                                "state": "connected" if info.get("port_open") else "disconnected",
                                "last_input_at": timestamp(event_time(last)) if last else None})
            return apps, devices, self.coverage, self.disk_full

    def stop(self):
        if self.signal:
            self.signal.close()
        self.store.stop()
