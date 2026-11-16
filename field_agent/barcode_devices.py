"""Bounded frame decoding and exclusive A/B serial-port ownership."""

from collections import Counter
from dataclasses import dataclass
from time import monotonic


LANES = ("A", "B")
SUPPORTED_USB_IDS = {(0x26F1, 0xD001)}
GENERIC_SERIALS = {"", "0", "000000", "NONE", "UNKNOWN", "N/A"}
MAX_FRAME_BYTES = 256
BARCODE_LENGTH = 21
IDLE_SECONDS = 0.4
RECONNECT_SECONDS = 2.0


class FrameDecoder:
    def __init__(self):
        self._buffer = bytearray()
        self._overflow = False
        self._last_byte_at = None

    def _finish(self, *, idle=False, interrupted=False):
        if self._last_byte_at is None:
            return []
        raw = bytes(self._buffer)
        overflow = self._overflow
        self._buffer.clear()
        self._overflow = False
        self._last_byte_at = None
        if overflow:
            return [("error", "oversize")]
        if interrupted:
            return [("error", "partial")]
        try:
            value = raw.decode("utf-8").replace("\x00", "").strip()
        except UnicodeDecodeError:
            return [("error", "decode")]
        if value.startswith("#"):
            value = value[1:]
        value = value.strip()
        if not value:
            return []
        # Without a terminator, a short fragment cannot establish a completed scan.
        if idle and len(value.upper()) < BARCODE_LENGTH:
            return [("error", "partial")]
        return [("scan", value)]

    def feed(self, raw, now):
        events = self.expire(now)
        for byte in raw:
            if byte in (10, 13):
                # With an empty buffer the LF after a CR produces no second frame.
                events.extend(self._finish())
                continue
            self._last_byte_at = now
            if len(self._buffer) < MAX_FRAME_BYTES:
                self._buffer.append(byte)
            else:
                self._overflow = True
        return events

    def expire(self, now):
        if self._last_byte_at is not None and now >= self._last_byte_at + IDLE_SECONDS:
            return self._finish(idle=True)
        return []

    def disconnect(self):
        return self._finish(interrupted=True)


@dataclass(frozen=True)
class ScannerPort:
    id: str
    port: str
    location: str


def discover_scanners(ports):
    candidates = set()
    for info in ports:
        usb_id = (getattr(info, "vid", None), getattr(info, "pid", None))
        device = str(getattr(info, "device", None) or "").strip()
        if usb_id not in SUPPORTED_USB_IDS or not device:
            continue
        location = str(getattr(info, "location", None) or "").strip()
        serial = str(getattr(info, "serial_number", None) or "").strip()
        usb = "usb:{:04x}:{:04x}:".format(*usb_id)
        # Use the physical socket for identical scanners. A unique actual serial
        # is sufficient on hosts that omit USB location from port enumeration.
        if location:
            identity = usb + "location:" + location
        elif serial.upper() not in GENERIC_SERIALS:
            identity = usb + "serial:" + serial
        else:
            continue
        candidates.add(ScannerPort(identity, device, location))

    identities = Counter(candidate.id for candidate in candidates)
    devices = Counter(candidate.port.casefold() for candidate in candidates)
    return {
        candidate.id: candidate for candidate in sorted(candidates, key=lambda item: item.id)
        if identities[candidate.id] == 1 and devices[candidate.port.casefold()] == 1
    }


class SerialBarcodeBackend:
    def list_ports(self):
        try:
            from serial.tools import list_ports
        except ImportError:
            return ()
        return list_ports.comports()

    def open(self, port):
        from serial import Serial

        # A bounded blocking read limits Windows USB CDC driver polling.
        return Serial(port, baudrate=9600, timeout=0.10)


@dataclass
class _Session:
    port: ScannerPort
    connection: object
    decoder: FrameDecoder


class BarcodeDevices:
    """Discover candidates and read assigned scanners on one owner thread."""

    def __init__(self, app, assignments, backend=None, *, clock=monotonic):
        self.app = app
        self.assignments = assignments
        self.backend = backend if backend is not None else SerialBarcodeBackend()
        self.clock = clock
        self._ports = {}
        self._discover_at = float("-inf")
        self._seen_assignments = None
        self._sessions = {}
        self._retry = {}
        self._states = {}

    def ports(self):
        """Snapshot detected choices without performing USB I/O on the caller thread."""
        return [
            {"id": item.id, "port": item.port, "location": item.location}
            for item in self._ports.values()
        ]

    def _status(self, lane, state, port="", *, identity):
        current = (state, port, identity)
        if self._states.get(lane) != current:
            self._states[lane] = current
            self.app.device_status(lane, state, port, identity=identity)

    def _report_frames(self, lane, frames, identity):
        for kind, value in frames:
            if kind == "error":
                self.app.frame_error(lane, value, identity=identity)
            else:
                self.app.receive(lane, value, identity=identity)

    def _release(self, lane):
        session = self._sessions.pop(lane)
        try:
            session.connection.close()
        except OSError:
            pass
        self._report_frames(lane, session.decoder.disconnect(), session.port.id)

    def _failed(self, lane, port):
        self._retry[lane] = (port, self.clock() + RECONNECT_SECONDS)
        self._status(lane, "fault", port.port, identity=port.id)

    def _open(self, lane, port):
        retry = self._retry.get(lane)
        if retry is not None and retry[0] == port and self.clock() < retry[1]:
            return
        try:
            connection = self.backend.open(port.port)
        except OSError:
            self._failed(lane, port)
            return
        self._retry.pop(lane, None)
        self._sessions[lane] = _Session(port, connection, FrameDecoder())
        self._status(lane, "connected", port.port, identity=port.id)

    def poll(self):
        """Run a bounded pass. Only the serial owner calls this method."""
        now = self.clock()
        assigned = self.assignments()
        should_discover = now >= self._discover_at or assigned != self._seen_assignments
        self._seen_assignments = assigned.copy()
        for lane, (port, deadline) in list(self._retry.items()):
            if assigned.get(lane) != port.id:
                self._retry.pop(lane)
            elif now >= deadline:
                self._retry.pop(lane)
                should_discover = True

        refreshed = False
        if should_discover:
            try:
                self._ports = discover_scanners(self.backend.list_ports())
            except OSError:
                # A failed enumeration supplies no new evidence about open ports.
                pass
            else:
                refreshed = True
            self._discover_at = self.clock() + RECONNECT_SECONDS

        desired = {lane: self._ports.get(assigned.get(lane)) for lane in LANES}
        if desired["A"] is not None and desired["A"] == desired["B"]:
            desired["B"] = None

        # Close old owners before opening any candidates, including an A/B swap.
        for lane, session in list(self._sessions.items()):
            if session.port != desired[lane]:
                self._release(lane)
                self._status(lane, "disconnected", identity=assigned.get(lane) or None)

        for lane, port in desired.items():
            if port is None:
                self._status(lane, "disconnected", identity=assigned.get(lane) or None)
                continue
            # A cached choice may refer to a COM the OS has already reassigned.
            if lane not in self._sessions and refreshed:
                self._open(lane, port)
            session = self._sessions.get(lane)
            if session is None:
                continue
            try:
                raw = session.connection.read(512)
            except OSError:
                self._release(lane)
                self._failed(lane, port)
                continue
            identity = self.assignments().get(lane)
            if identity != port.id:
                self._release(lane)
                self._status(lane, "disconnected", identity=identity or None)
                continue
            self._report_frames(lane, session.decoder.feed(raw, self.clock()), port.id)

    def run(self, stop_event):
        try:
            while not stop_event.is_set():
                self.poll()
                stop_event.wait(0.025 if self._sessions else 0.25)
        finally:
            for lane in list(self._sessions):
                self._release(lane)
                self._status(lane, "disconnected", identity=self.assignments().get(lane) or None)
