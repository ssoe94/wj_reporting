"""K50L USB serial signal tower, using the supplied manufacturer's table.

The table specifies 9600 baud, 8 data bits, even parity and one stop bit.
Only its documented all-off, solid-color and buzzer on/off commands are used.
The connected unit returned the exact 8-byte command as an echo in the local
2026-09-14 smoke test. Echo is checked as command acceptance, not physical lamp
feedback. Importing or constructing this adapter opens no port.
"""
import threading
import time

from .hardware_io import HardwareError


VID, PID = 0x1A86, 0x7523
COLORS = ("off", "red", "yellow", "green")
BUZZERS = ("off", "ok", "ng")
# Eight bytes occupy 9.17 ms at 9600/8E1. This gap also leaves more than
# 3.5 character times of Modbus RTU silence, without an unbounded flush().
COMMAND_GAP_SECONDS = 0.020
READ_TIMEOUT_SECONDS = 0.05
WRITE_TIMEOUT_SECONDS = 0.25
ECHO_TIMEOUT_SECONDS = 0.4


def build_k50l_command(coil, enabled):
    """Build the documented address-1 Modbus write-single-coil frame."""
    if type(coil) is not int or coil not in range(5) or type(enabled) is not bool:
        raise HardwareError("INVALID_SIGNAL", "K50L coil must be 0..4 and enabled must be boolean")
    if coil == 0 and enabled:
        raise HardwareError("INVALID_SIGNAL", "K50L coil 0 only documents the all-off command")
    payload = bytes((1, 5, 0, coil, 0xFF if enabled else 0, 0))
    crc = 0xFFFF
    for byte in payload:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return payload + crc.to_bytes(2, "little")


ALL_OFF = build_k50l_command(0, False)
BUZZER_ON = build_k50l_command(4, True)
BUZZER_OFF = build_k50l_command(4, False)


def _serial_module():
    try:
        import serial
    except ImportError:
        raise HardwareError("SERIAL_NOT_INSTALLED", "Install pyserial for the K50L signal tower") from None
    return serial


def list_k50l_ports():
    """List matching USB bridge candidates without opening any serial port.

    The VID/PID identify the supplied USB bridge, not the tower model. Selection
    is intended for a known K50L installation; never probe unrelated ports.
    """
    _serial_module()
    from serial.tools import list_ports
    rows = {}
    for port in list_ports.comports():
        if port.vid != VID or port.pid != PID or not port.device:
            continue
        name = port.device
        suffix = port.serial_number or port.description or "USB Serial"
        rows[name.casefold()] = {
            "id": name, "path": name, "port": name,
            "label": f"K50L USB serial candidate · {name} · {suffix}",
        }
    return sorted(rows.values(), key=lambda row: row["port"].casefold())


class K50LSignal:
    """Lazy, synchronous adapter intended for the single SignalWorker thread.

    A command failure releases the stale serial handle for a bounded worker
    reconnect. Only explicit close permanently disables this adapter.
    One color is requested at a time. Buzzer patterns have finite host-side
    durations and attempt buzzer-off and all-off cleanup on failure. A USB
    disconnect can prevent cleanup from reaching the device; submission is
    never reported as proof that the physical lamp or buzzer changed state.
    """

    supports_reconnect = True

    def __init__(self, port=None):
        if port is not None and (not isinstance(port, str) or
                                 any(ord(char) < 32 for char in port)):
            raise HardwareError("NOT_CONFIGURED", "Configure a K50L serial port")
        self.port = port.strip() if port and port.strip() else None
        self.device = None
        self.status = "not_connected" if self.port else "not_configured"
        self._closed = False
        self._opened_once = False
        self._lock = threading.Lock()

    def _open(self):
        candidates = list_k50l_ports()
        if self.port:
            matches = [row for row in candidates if row["port"].casefold() == self.port.casefold()]
            # A known adapter can be assigned a different COM port after a
            # replug. Never guess among bridges or replace an initial explicit
            # port selection that has not yet been successfully opened.
            if not matches and self._opened_once and len(candidates) == 1:
                matches = candidates
            if len(matches) != 1:
                raise HardwareError("SIGNAL_NOT_FOUND", "Selected K50L USB serial port is not connected")
            selected = matches[0]
        else:
            if not candidates:
                raise HardwareError("SIGNAL_NOT_FOUND", "No K50L USB serial candidate is connected")
            if len(candidates) != 1:
                raise HardwareError("SIGNAL_SELECTION_REQUIRED", "Select exactly one K50L USB serial port")
            selected = candidates[0]
        serial = _serial_module()
        self.port = selected["port"]
        try:
            self.device = serial.Serial(
                port=self.port, baudrate=9600, bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_EVEN, stopbits=serial.STOPBITS_ONE,
                timeout=READ_TIMEOUT_SECONDS, write_timeout=WRITE_TIMEOUT_SECONDS,
                xonxoff=False, rtscts=False, dsrdtr=False,
            )
        except OSError as exc:
            failure = HardwareError("SIGNAL_OPEN_FAILED", "K50L USB port could not be opened: " + str(exc))
            failure.details = {"port": self.port, "exception_type": type(exc).__name__,
                               "reason": str(exc), "winerror": getattr(exc, "winerror", None)}
            raise failure from exc
        self._opened_once = True

    def _write(self, command):
        # Drop old replies so a previous command cannot satisfy this check.
        # reset_input_buffer purges receive bytes; unlike flush(), it never
        # waits for the output queue to empty.
        self.device.reset_input_buffer()
        try:
            count = self.device.write(command)
        finally:
            # The next frame, including cleanup after a partial write, must
            # start after a frame boundary. Serial.flush() can block forever.
            time.sleep(COMMAND_GAP_SECONDS)
        if count != len(command):
            raise HardwareError("SIGNAL_PARTIAL_WRITE", "Incomplete K50L command; physical state is unknown")
        deadline = time.monotonic() + ECHO_TIMEOUT_SECONDS
        response = bytearray()
        while len(response) < len(command):
            if time.monotonic() >= deadline:
                raise HardwareError("SIGNAL_ECHO_TIMEOUT", "K50L command echo timed out; physical state is unknown")
            chunk = self.device.read(len(command) - len(response))
            if not isinstance(chunk, bytes):
                raise HardwareError("SIGNAL_INVALID_ECHO", "K50L returned a non-byte response")
            response.extend(chunk)
        if response != command:
            raise HardwareError("SIGNAL_INVALID_ECHO", "K50L command echo did not match; physical state is unknown")

    def _best_effort_write(self, command):
        if self.device is not None:
            try:
                self._write(command)
            except Exception:
                pass

    def _pulse_buzzer(self, duration):
        try:
            self._write(BUZZER_ON)
            time.sleep(duration)
        except BaseException:
            # The device may have received ON even when its write failed.
            self._best_effort_write(BUZZER_OFF)
            raise
        else:
            self._write(BUZZER_OFF)

    def set_state(self, color, buzzer="off"):
        if color not in COLORS or buzzer not in BUZZERS:
            raise HardwareError("INVALID_SIGNAL", "Unsupported lamp color or buzzer pattern")
        with self._lock:
            if self._closed:
                raise HardwareError("SIGNAL_CLOSED", "K50L adapter is closed")
            try:
                if self.device is None:
                    self._open()
                self._write(ALL_OFF)
                if color != "off":
                    self._write(build_k50l_command({"red": 1, "yellow": 2, "green": 3}[color], True))
                if buzzer == "ok":
                    self._pulse_buzzer(0.14)
                elif buzzer == "ng":
                    for index in range(3):
                        if index:
                            time.sleep(0.08)
                        self._pulse_buzzer(0.18)
                self.status = "submitted"
            except BaseException:
                self.status = "error"
                self._best_effort_write(ALL_OFF)
                if self.device is not None:
                    try:
                        self.device.close()
                    except Exception:
                        pass
                    finally:
                        self.device = None
                raise

    def close(self):
        with self._lock:
            try:
                if self.device is not None:
                    self._write(ALL_OFF)
            except BaseException:
                self.status = "error"
                raise
            finally:
                try:
                    if self.device is not None:
                        self.device.close()
                finally:
                    self.device = None
                    self._closed = True
                    if self.status != "error":
                        self.status = "closed"
