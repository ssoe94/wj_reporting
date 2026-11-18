"""Hardware boundary and in-memory devices for a weight and label station."""
from collections import deque
from decimal import Decimal
from threading import Event, Lock
import math

from .hardware_io import HardwareError, VirtualSignal, create_signal, make_printer_transport
from .scanner_io import LANES, ScannerService, _utc_now
from .signal_worker import SignalWorker


class SerialScale:
    """Read-only 8N1 serial scale. One station worker owns the connection."""

    def __init__(self, port, baudrate=9600, timeout=0.1, serial_factory=None):
        if not isinstance(port, str) or not port.strip() or "\0" in port:
            raise ValueError("A scale port is required")
        if type(baudrate) is not int or baudrate <= 0:
            raise ValueError("Invalid scale baud rate")
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 0.5:
            raise ValueError("Invalid scale timeout")
        self.port = port.strip()
        self.baudrate = baudrate
        self.timeout = timeout
        self._serial_factory = serial_factory
        self._connection = None

    @property
    def connected(self):
        return self._connection is not None

    def _open(self):
        factory = self._serial_factory
        if factory is None:
            try:
                import serial
            except ImportError as exc:
                raise OSError("pyserial is required to read the scale") from exc
            factory = serial.Serial
        device = factory(port=None, baudrate=self.baudrate, bytesize=8, parity="N", stopbits=1,
                         timeout=self.timeout, xonxoff=False, rtscts=False, dsrdtr=False)
        try:
            device.dtr = False
            device.rts = False
            device.port = self.port
            device.open()
        except BaseException:
            device.close()
            raise
        self._connection = device

    def read(self, size=512):
        if self._connection is None:
            self._open()
        try:
            waiting = self._connection.in_waiting
            return self._connection.read(min(waiting or 1, size))
        except OSError:
            self.close()
            raise

    def close(self):
        connection, self._connection = self._connection, None
        if connection is not None:
            connection.close()


class FakeScale:
    """Feed raw chunks or scripted readings through the normal scale decoder."""

    def __init__(self, frames=()):
        self._input = bytearray()
        self._lock = Lock()
        self.connected = True
        for frame in frames:
            self.feed(frame)

    def feed(self, chunk):
        if not isinstance(chunk, bytes):
            raise TypeError("A scale frame must be bytes")
        with self._lock:
            if len(self._input) + len(chunk) > 65536:
                raise BufferError("Fake scale input buffer is full")
            self._input.extend(chunk)

    def add_weight(self, grams, status="ST", mode="GS"):
        weight = Decimal(str(grams))
        if not weight.is_finite() or status not in ("ST", "US") or len(mode) != 2 or not (
            mode.isascii() and mode.isalpha() and mode.isupper()
        ):
            raise ValueError("Invalid script reading")
        sign = "-" if weight.is_signed() else "+"
        self.feed(f"{status},{mode},{sign}{abs(weight):f} g\r\n".encode("ascii"))

    def play_script(self, steps, stop=None):
        """Replay (delay_seconds, raw_chunk) steps, interruptible between frames."""
        stop = stop if stop is not None else Event()
        for delay, frame in steps:
            if not math.isfinite(delay) or delay < 0:
                raise ValueError("Frame delay must be finite and nonnegative")
            if stop.wait(delay):
                break
            self.feed(frame)

    def read(self, size=512):
        with self._lock:
            raw = bytes(self._input[:size])
            del self._input[:size]
            return raw

    def close(self):
        self.connected = False


class FakePrinter:
    """Raw payload sink with observable pre-write and partial-write outcomes."""

    def __init__(self, columns=1, *, peel=False):
        if type(columns) is not int or not 1 <= columns <= 3:
            raise ValueError("The row must have one to three columns")
        self.columns = columns
        self.peel = bool(peel)
        self.sent = []
        self.attempts = []
        self.label_waiting = False
        self._outcomes = deque()
        self._lock = Lock()

    def inject(self, outcome):
        if outcome not in ("submitted", "rejected_unsent", "uncertain"):
            raise ValueError("Unknown simulated print outcome")
        with self._lock:
            self._outcomes.append(outcome)

    def set_label_waiting(self, waiting):
        with self._lock:
            self.label_waiting = bool(waiting)

    def queue_status(self, command_language="zpl"):
        with self._lock:
            return {"ready": not self.label_waiting, "label_waiting": self.label_waiting,
                    "busy": False, "activity": False, "paused": False, "errors": [],
                    "warnings": [], "message": "peel_wait" if self.label_waiting else "ready",
                    "physical_count_known": False, "command_language": command_language}

    def __call__(self, payload):
        if not isinstance(payload, bytes) or not payload:
            raise ValueError("A print payload must be nonempty bytes")
        with self._lock:
            self.attempts.append(payload)
            outcome = self._outcomes.popleft() if self._outcomes else "submitted"
            if outcome == "rejected_unsent" or self.label_waiting:
                error = HardwareError("PRINTER_NOT_READY", "The payload was rejected before writing")
                error.print_data_sent = False
                raise error
            if outcome == "uncertain":
                self.sent.append(payload[:max(1, len(payload) // 2)])
                error = TimeoutError("Synthetic partial write timed out")
                error.print_data_sent = None
                raise error
            self.sent.append(payload)
            if self.peel:
                self.label_waiting = True


class FakeScanner:
    """Deliver the same scan event shape as ScannerService."""

    def __init__(self):
        self._events = deque()
        self._lock = Lock()
        self._connected = False
        self._last_scan = dict.fromkeys(LANES)

    def start(self):
        self._connected = True

    def stop(self, timeout=2.0):
        self._connected = False
        return True

    def feed(self, device, barcode):
        if device not in LANES + ("KEYBOARD",) or not isinstance(barcode, str) or not barcode or (
            "\0" in barcode or len(barcode.encode("utf-8")) > 256
        ):
            raise ValueError("Invalid simulated scan")
        with self._lock:
            if len(self._events) >= 2000:
                raise BufferError("Fake scanner input buffer is full")
            recorded = _utc_now()
            self._events.append({"type": "scan", "lane": device, "barcode": barcode, "received_at": recorded})
            if device in self._last_scan:
                self._last_scan[device] = recorded

    def drain_events(self, limit=200):
        with self._lock:
            return [self._events.popleft() for _ in range(min(len(self._events), max(0, int(limit))))]

    def snapshots(self):
        with self._lock:
            return {lane: {"lane": lane, "state": "open" if self._connected else "stopped",
                           "port_open": self._connected, "verified_scan": moment is not None,
                           "last_scan_at": moment}
                    for lane, moment in self._last_scan.items()}


__all__ = [
    "FakePrinter", "FakeScale", "FakeScanner", "ScannerService", "SerialScale", "SignalWorker", "VirtualSignal",
    "create_signal", "make_printer_transport",
]
