"""Read-only A/B (+ optional wireless W) scanner capture with observable status.

Workers own their serial handles and never write/reset scanner settings.  The Tk
thread calls ``drain_events`` and persists each ``scan`` event before updating its
UI.  Port-open means only that the OS handle opened; ``verified_scan`` becomes
true only after an actual complete frame is received on that connection.

Lane W is an optional wireless receiver for emergency or packing sweeps. It is
never auto-assigned to A/B, and an absent receiver only reports ``waiting``.
"""

from collections import deque
from datetime import datetime, timezone
import copy
import threading
import time


SCANNER_USB_IDS = {(0x26F1, 0xD001)}
# Wireless receiver (USB virtual COM + HID keyboard composite), seen 2026-09-18.
WIRELESS_USB_IDS = {(0x0483, 0x0115)}
EXCLUDED_USB_IDS = {(0x1A86, 0x7523)}  # K50L signal tower, not a scanner.
EXCLUDED_USB_VIDS = {0x067B}  # Prolific scale adapter.
_GENERIC_SERIALS = {"", "0", "000000", "NONE", "UNKNOWN", "N/A"}
PRIMARY_LANES = ("A", "B")
WIRELESS_LANE = "W"
LANES = PRIMARY_LANES + (WIRELESS_LANE,)


def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _device(value):
    return str(value or "").strip().upper()


def _serial(value):
    value = str(value or "").strip()
    return "" if value.upper() in _GENERIC_SERIALS else value


def port_identity(port):
    result = {}
    for key in ("device", "serial_number", "vid", "pid", "location", "manufacturer", "product"):
        value = getattr(port, key, None)
        if key == "device":
            value = _device(value)
        elif key == "serial_number":
            value = _serial(value)
        if value is not None and value != "":
            result[key] = value
    return result


def _matches(port, identity):
    serial_number = _serial(identity.get("serial_number"))
    if serial_number:
        return (
            _serial(getattr(port, "serial_number", None)) == serial_number
            and all(identity.get(key) is None or identity[key] == getattr(port, key, None)
                    for key in ("vid", "pid"))
        )
    if identity.get("location") and all(identity.get(key) is not None for key in ("vid", "pid")):
        return all(identity[key] == getattr(port, key, None) for key in ("location", "vid", "pid"))
    return False


def _has_identity(identity):
    return bool(_serial(identity.get("serial_number")) or (
        identity.get("location") and all(identity.get(key) is not None for key in ("vid", "pid"))))


def _blocked(port, reserved_ports=()):
    return (
        _device(getattr(port, "device", "")) in {_device(value) for value in reserved_ports}
        or getattr(port, "vid", None) in EXCLUDED_USB_VIDS
        or (getattr(port, "vid", None), getattr(port, "pid", None)) in EXCLUDED_USB_IDS
    )


def _sort_port(port):
    device = _device(getattr(port, "device", ""))
    return (0, int(device[3:])) if device.startswith("COM") and device[3:].isdigit() else (1, device)


def detect_scanner_ports(available_ports, reserved_ports=(), usb_ids=SCANNER_USB_IDS):
    """Identify only the scanner USB model documented in the field handoff."""
    return sorted([
        port for port in available_ports
        if (getattr(port, "vid", None), getattr(port, "pid", None)) in usb_ids
        and not _blocked(port, reserved_ports)
    ], key=_sort_port)


def detect_wireless_ports(available_ports, reserved_ports=()):
    return detect_scanner_ports(available_ports, reserved_ports, WIRELESS_USB_IDS)


def wireless_enabled(config):
    return config.get("wireless_enabled", True) is not False


def resolve_scanner_ports(config, available_ports):
    """Resolve A/B/W without stealing a saved identity or any scale/tower port.

    Explicitly configured non-scanner VID/PID devices are accepted except for the
    known scale/tower adapters. Automatic A/B assignment only uses
    SCANNER_USB_IDS, and missing stable A/B identities remain missing rather
    than following a reused COM. W has a single role, so a replacement receiver
    of the known wireless model is found again by USB ID, never by COM number.
    """
    configured = config.get("ports", {})
    identities = config.get("identities", {})
    reserved = config.get("reserved_ports", ())
    lanes = LANES if wireless_enabled(config) else PRIMARY_LANES
    available = [port for port in available_ports if not _blocked(port, reserved)]
    by_device = {_device(port.device): port for port in available}
    selected, used = {}, set()
    for lane in lanes:
        identity = identities.get(lane, {}) or {}
        matches = [port for port in available if _matches(port, identity)]
        if len(matches) == 1 and _device(matches[0].device) not in used:
            selected[lane] = _device(matches[0].device)
            used.add(selected[lane])
    for lane in lanes:
        if lane in selected or _has_identity(identities.get(lane, {}) or {}):
            continue
        desired = _device(configured.get(lane))
        if desired in by_device and desired not in used:
            selected[lane] = desired
            used.add(desired)
    if config.get("auto_detect", False):
        if WIRELESS_LANE in lanes and WIRELESS_LANE not in selected:
            receivers = [port for port in detect_wireless_ports(available, reserved)
                         if _device(port.device) not in used]
            # A present manually chosen W port has already won above.
            if len(receivers) == 1:
                selected[WIRELESS_LANE] = _device(receivers[0].device)
                used.add(selected[WIRELESS_LANE])
        candidates = detect_scanner_ports(available, reserved)
        remaining = [port for port in candidates if _device(port.device) not in used]
        empty_lanes = [lane for lane in PRIMARY_LANES if lane not in selected
                       and not _has_identity(identities.get(lane, {}) or {})
                       and not _device(configured.get(lane))]
        # Two identical new scanners do not reveal their physical A/B roles.
        # One uniquely remaining scanner may fill A (or the other open role).
        if len(remaining) == 1 and empty_lanes:
            selected[empty_lanes[0]] = _device(remaining[0].device)
    return {lane: selected.get(lane, "") for lane in LANES}


class FrameDecoder:
    """Bounded CR/LF framing; idle completion supports scanners without suffixes."""

    def __init__(self, max_frame_bytes=256, idle_seconds=0.4):
        self.max_frame_bytes = max(21, min(int(max_frame_bytes), 4096))
        self.idle_seconds = max(0.1, float(idle_seconds))
        self.buffer = bytearray()
        self.overflow = False
        self.last_byte_at = None
        self.frame_byte_count = 0

    def _finish(self, framing):
        raw = bytes(self.buffer)
        overflow = self.overflow
        evidence = {"raw_hex": raw.hex(), "frame_byte_count": self.frame_byte_count,
                    "raw_truncated": self.frame_byte_count > len(raw)}
        self.buffer.clear()
        self.overflow = False
        self.last_byte_at = None
        self.frame_byte_count = 0
        if overflow:
            return {"type": "frame_error", "reason": "frame_too_long", **evidence, "framing": framing}
        raw = raw.strip(b"\x00\r\n \t")
        if not raw:
            return None
        if raw.startswith(b"#"):
            raw = raw[1:]
        try:
            barcode = raw.decode("ascii")
        except UnicodeDecodeError:
            return {"type": "frame_error", "reason": "non_ascii", **evidence, "framing": framing}
        if not barcode or any(ord(char) < 32 or ord(char) > 126 for char in barcode):
            return {"type": "frame_error", "reason": "invalid_control", **evidence, "framing": framing}
        return {"type": "scan", "barcode": barcode, **evidence, "framing": framing}

    def feed(self, raw, now=None):
        now = time.monotonic() if now is None else now
        events = []
        # Expire an older fragment before joining a new, separate USB receive.
        events.extend(self.expire(now))
        for byte in raw:
            if byte in (10, 13):
                result = self._finish("delimiter")
                if result:
                    events.append(result)
            else:
                self.last_byte_at = now
                self.frame_byte_count += 1
                if len(self.buffer) < self.max_frame_bytes:
                    self.buffer.append(byte)
                else:
                    self.overflow = True
        return events

    def expire(self, now=None):
        now = time.monotonic() if now is None else now
        if self.last_byte_at is None or now - self.last_byte_at < self.idle_seconds:
            return []
        result = self._finish("idle_timeout")
        return [result] if result else []

    def disconnect(self):
        """Never concatenate an incomplete frame across two connections."""
        if self.last_byte_at is None:
            return []
        raw = bytes(self.buffer)
        byte_count = self.frame_byte_count
        self.buffer.clear()
        self.overflow = False
        self.last_byte_at = None
        self.frame_byte_count = 0
        return [{"type": "frame_error", "reason": "incomplete_disconnect", "raw_hex": raw.hex(),
                 "frame_byte_count": byte_count, "raw_truncated": byte_count > len(raw), "framing": "disconnect"}]


class ScannerService:
    """One reader thread per lane; GUI notifications are drained by the GUI thread.

    Config: ports/identities dictionaries keyed A/B/W, enabled (default True),
    wireless_enabled (default True), auto_detect (default False),
    reserved_ports, retry_seconds, idle_seconds, max_frame_bytes. No
    configuration or ledger files are written here.
    """

    def __init__(self, config=None, serial_factory=None, port_provider=None):
        self._config = copy.deepcopy(config or {})
        self._serial_factory = serial_factory
        self._port_provider = port_provider
        self._lock = threading.RLock()
        self._events = deque()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._threads = []
        self._revision = 0
        self._claims = {}
        self._snapshots = {lane: {
            "lane": lane, "state": "stopped", "port": "", "port_open": False,
            "verified_scan": False, "bytes_received": 0, "frames_received": 0,
            "scan_count": 0, "error_count": 0, "last_receive_at": None,
            "last_scan_at": None, "last_barcode": "", "message": "", "identity": {},
        } for lane in LANES}

    def _ports(self):
        if self._port_provider is not None:
            return list(self._port_provider())
        from serial.tools import list_ports
        return list(list_ports.comports())

    def detected_ports(self):
        """Known A/B scanner and wireless receiver ports, never scale/tower ports."""
        with self._lock:
            config = copy.deepcopy(self._config)
        ports = self._ports()
        reserved = config.get("reserved_ports", ())
        return ([dict(port_identity(port), kind="scanner") for port in detect_scanner_ports(ports, reserved)]
                + [dict(port_identity(port), kind="wireless") for port in detect_wireless_ports(ports, reserved)])

    def configure(self, config):
        with self._lock:
            self._config = copy.deepcopy(config)
            self._revision += 1
        self._wake.set()

    def start(self):
        with self._lock:
            if any(thread.is_alive() for thread in self._threads):
                return
            self._stop.clear()
            self._threads = [threading.Thread(target=self._run, args=(lane,), name="Scanner-" + lane, daemon=True) for lane in LANES]
            for thread in self._threads:
                thread.start()

    def stop(self, timeout=2.0):
        self._stop.set()
        self._wake.set()
        deadline = time.monotonic() + max(0.0, timeout)
        for thread in self._threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        return not any(thread.is_alive() for thread in self._threads)

    def snapshots(self):
        with self._lock:
            return copy.deepcopy(self._snapshots)

    def drain_events(self, limit=200):
        with self._lock:
            events = []
            for _ in range(max(0, int(limit))):
                if not self._events:
                    break
                events.append(self._events.popleft())
            return events

    def _state(self, lane, state, port="", message="", identity=None):
        with self._lock:
            snapshot = self._snapshots[lane]
            previous = (snapshot["state"], snapshot["port"], snapshot["message"])
            snapshot.update(state=state, port=port, message=message, port_open=(state == "open"))
            if state != "open" or snapshot["port"] != previous[1]:
                snapshot["verified_scan"] = False
            if identity is not None:
                snapshot["identity"] = identity
            if previous != (state, port, message):
                self._events.append({"type": "state", **copy.deepcopy(snapshot)})

    def _receive(self, lane, port, events):
        for event in events:
            with self._lock:
                snapshot = self._snapshots[lane]
                snapshot["frames_received"] += 1
                received_at = _utc_now()
                if event["type"] == "scan":
                    snapshot["scan_count"] += 1
                    snapshot["verified_scan"] = True
                    snapshot["last_scan_at"] = received_at
                    snapshot["last_barcode"] = event["barcode"]
                else:
                    snapshot["error_count"] += 1
                self._events.append({**event, "lane": lane, "port": port, "received_at": received_at,
                                     "bytes_received": snapshot["bytes_received"], "frames_received": snapshot["frames_received"]})

    def _current(self, revision):
        with self._lock:
            return not self._stop.is_set() and self._revision == revision

    def _wait(self, seconds):
        self._wake.wait(seconds)
        self._wake.clear()

    def _run(self, lane):
        while not self._stop.is_set():
            with self._lock:
                config, revision = copy.deepcopy(self._config), self._revision
            retry_seconds = max(0.1, float(config.get("retry_seconds", 2.0)))
            connection, port, decoder = None, "", None
            try:
                if not config.get("enabled", True) or (lane == WIRELESS_LANE and not wireless_enabled(config)):
                    self._state(lane, "paused")
                    self._wait(0.25)
                    continue
                available = self._ports()
                resolved = resolve_scanner_ports(config, available)
                port = resolved[lane]
                if not port:
                    ambiguous = (lane in PRIMARY_LANES and config.get("auto_detect", False)
                                 and len(detect_scanner_ports(available, config.get("reserved_ports", ()))) > 1
                                 and not any(resolved[item] for item in PRIMARY_LANES))
                    self._state(lane, "waiting", message="lane_selection_required" if ambiguous else "scanner_not_found")
                    self._wait(retry_seconds)
                    continue
                with self._lock:
                    if port in self._claims and self._claims[port] != lane:
                        port = ""
                    elif self._revision == revision:
                        self._claims[port] = lane
                    else:
                        continue
                if not port:
                    self._state(lane, "waiting", message="port_in_use")
                    self._wait(retry_seconds)
                    continue
                self._state(lane, "connecting", port)
                factory = self._serial_factory
                if factory is None:
                    import serial
                    factory = serial.Serial
                # Short blocking read only. Do not use in_waiting, flush,
                # reset_input_buffer, USB reset, or configuration commands.
                connection = factory(port=port, baudrate=9600, bytesize=8, parity="N", stopbits=1, timeout=0.1)
                if not self._current(revision):
                    continue
                identity = port_identity(next(item for item in available if _device(item.device) == port))
                self._state(lane, "open", port, identity=identity)
                decoder = FrameDecoder(config.get("max_frame_bytes", 256), config.get("idle_seconds", 0.4))
                while self._current(revision):
                    raw = connection.read(256)
                    if raw:
                        with self._lock:
                            snapshot = self._snapshots[lane]
                            snapshot["bytes_received"] += len(raw)
                            snapshot["last_receive_at"] = _utc_now()
                        self._receive(lane, port, decoder.feed(raw))
                    else:
                        self._receive(lane, port, decoder.expire())
            except Exception as exc:
                if self._current(revision):
                    self._state(lane, "retrying", port, "{}: {}".format(type(exc).__name__, exc))
            finally:
                if decoder:
                    self._receive(lane, port, decoder.disconnect())
                if connection is not None:
                    try:
                        connection.close()
                    except Exception:
                        pass
                with self._lock:
                    if port and self._claims.get(port) == lane:
                        self._claims.pop(port, None)
                    self._snapshots[lane]["port_open"] = False
                    self._snapshots[lane]["verified_scan"] = False
            if self._current(revision):
                self._wait(retry_seconds)
        self._state(lane, "stopped")
