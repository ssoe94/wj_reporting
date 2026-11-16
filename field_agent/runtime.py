"""Keep the device path independent of network, backup and browser work."""

from threading import Event, Lock, Thread
from time import monotonic
import sqlite3

from . import __version__
from .backup import Backup, DEFAULT_MIN_FREE
from .barcode_app import BarcodeApp
from .barcode_devices import BarcodeDevices
from .barcode_legacy import LegacyBarcodeCollector
from .devices import FakeBarcodeApp, FakeLineDevice
from .local_ui import LocalUI
from .protocol import timestamp
from .resources import Resources
from .uploader import Uploader


class Runtime:
    def __init__(self, ledger, transport, *, demo=False, port=None, backup_idle=60,
                 backup_keep=30, min_free_bytes=DEFAULT_MIN_FREE, barcode_config=None,
                 legacy_barcode_db=None, barcode_backend=None):
        if sum((demo, barcode_config is not None, legacy_barcode_db is not None)) > 1:
            raise ValueError("Select only one barcode input mode")
        self.ledger = ledger
        self.station_id = ledger.station_id
        self._halt = Event()
        self._lock = Lock()
        self._threads = []
        self._last_activity = monotonic()
        self._last_work_at = None
        self._last_input_at = None
        self._device_error = None
        self._coverage = "known"
        self._committed = 0
        self.port = port
        self.local_ui = None
        self.device = FakeLineDevice() if demo else None
        self.app = FakeBarcodeApp(ledger, __version__) if demo else None
        self.resources = Resources(ledger.path)
        self.backup = Backup(
            ledger, ledger.path.parent / "backup", keep=backup_keep,
            min_free_bytes=min_free_bytes, idle_seconds=backup_idle,
            transition=self._backup_changed,
        )
        self.uploader = Uploader(ledger, transport, self._heartbeat_snapshot)
        self.minimum_free = min_free_bytes
        self.barcode = BarcodeApp(ledger, barcode_config, self._barcode_changed) if barcode_config else None
        self.barcode_devices = None
        if self.barcode:
            self.barcode_devices = BarcodeDevices(self.barcode, self.barcode.scanner_assignments, backend=barcode_backend)
        self.legacy = (LegacyBarcodeCollector(ledger, legacy_barcode_db)
                       if legacy_barcode_db is not None else None)
        self.legacy_status = {"coverage": "unknown", "state": "running", "last_work_at": None}

    def _barcode_changed(self, *, state_changed, activity):
        if activity:
            with self._lock:
                self._last_activity = monotonic()
        self.uploader.wake(state_changed=state_changed)

    def _poll_legacy(self):
        try:
            while not self._halt.is_set():
                try:
                    count = self.legacy.poll()
                    status = self.legacy.status()
                except (OSError, ValueError, sqlite3.Error):
                    count = 0
                    status = {"coverage": "partial", "state": "fault", "last_work_at": None}
                with self._lock:
                    changed = status != self.legacy_status
                    self.legacy_status = status
                    if count:
                        self._last_activity = monotonic()
                        self._committed += count
                if changed or count:
                    self.uploader.wake(state_changed=changed)
                self._halt.wait(5)
        finally:
            self.legacy.close()

    def _backup_changed(self):
        self.uploader.wake(state_changed=True)

    @property
    def committed(self):
        if self.barcode:
            return self.barcode.committed
        with self._lock:
            return self._committed

    def _app_devices(self):
        if self.barcode:
            return self.barcode.health()
        if self.legacy:
            with self._lock:
                status = dict(self.legacy_status)
            # A readable file supplies rows, with no evidence about the live
            # source application's process, version or devices.
            apps = [{"app": "barcode", "version": None, "mode": "unknown", "state": "unknown",
                     "last_work_at": status["last_work_at"]}]
            return apps, [], status["coverage"], False
        if self.app is None:
            return [], [], "known", False
        with self._lock:
            fault = self._device_error is not None
            apps = [{
                "app": "barcode", "version": __version__, "mode": "test",
                "state": "fault" if fault else "running", "last_work_at": self._last_work_at,
            }]
            devices = [{
                "app": "barcode", "device": "A", "state": "fault" if fault else "connected",
                "last_input_at": self._last_input_at,
            }]
            return apps, devices, self._coverage, self._device_error == "ledger_full"

    def _heartbeat_snapshot(self):
        apps, devices, coverage, write_pressure = self._app_devices()
        resources = self.resources.snapshot()
        disk_free = resources["disk_free_bytes"]
        backup_low = self.backup.status()["reason"] == "disk_low"
        state = backup_low or write_pressure or (disk_free is not None and disk_free < self.minimum_free)
        return {
            "agent_version": __version__, "apps": apps, "devices": devices, "resources": resources,
            "storage_pressure": state, "coverage": coverage,
        }

    def snapshot(self):
        """Local UI interface, with a bounded read at a barcode shift boundary."""
        apps, devices, _, _ = self._app_devices()
        with self._lock:
            device_error = self._device_error
        snapshot = {
            "station_id": self.station_id, "agent_version": __version__, "apps": apps, "devices": devices,
            "outbox": self.uploader.status(), "clock_offset_seconds": self.uploader.clock_offset_seconds,
            "heartbeat_error": self.uploader.heartbeat_error, "backup": self.backup.status(),
            "device_error": device_error,
        }
        if self.barcode:
            ports = [{"id": item["id"], "label": " · ".join(filter(None, (item["port"], item["location"])))}
                     for item in self.barcode_devices.ports()]
            snapshot["barcode"] = self.barcode.snapshot(ports)
        return snapshot

    def _read_device(self):
        while not self._halt.is_set():
            frame = self.device.read_line()
            if frame is None:
                continue
            moment = timestamp()
            with self._lock:
                self._last_input_at = moment
                self._last_activity = monotonic()
            error = None
            try:
                self.app.record(frame, moment)
            except (UnicodeError, ValueError):
                error = "invalid_demo_frame"
            except sqlite3.Error as exc:
                error = "ledger_full" if getattr(exc, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL else "ledger_write_failed"
            with self._lock:
                changed = self._device_error != error
                self._device_error = error
                if error is None:
                    self._last_work_at = moment
                    self._committed += 1
                else:
                    self._coverage = "partial"
            # The thread receives no completion callbacks from uploader or backup.
            if error is None or changed:
                self.uploader.wake(state_changed=changed)

    def _run_backup(self):
        while not self._halt.is_set():
            with self._lock:
                idle_for = monotonic() - self._last_activity
            self.backup.due(idle_for, self._halt)
            self._halt.wait(5)

    def start(self):
        if self.port is not None:
            barcode_api = {}
            if self.barcode:
                barcode_api = {"barcode_action": self.barcode.action, "barcode_csv": self.barcode.csv}
            self.local_ui = LocalUI(self.snapshot, port=self.port, **barcode_api).start()
        targets = [("field-upload", lambda: self.uploader.run(self._halt)), ("field-backup", self._run_backup)]
        if self.app is not None:
            targets.append(("field-fake-scanner", self._read_device))
        if self.barcode_devices:
            targets.append(("field-barcode", lambda: self.barcode_devices.run(self._halt)))
        if self.legacy:
            targets.append(("field-barcode-import", self._poll_legacy))
        for name, target in targets:
            thread = Thread(name=name, target=target, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def stop(self):
        self._halt.set()
        self.uploader.wake()
        if self.local_ui is not None:
            self.local_ui.stop()
        for thread in self._threads:
            thread.join(10)
        if any(thread.is_alive() for thread in self._threads):
            raise RuntimeError("A station worker did not stop")
        if self.barcode:
            # The durable stop marker is delivered on the next start.
            self.barcode.stop()
