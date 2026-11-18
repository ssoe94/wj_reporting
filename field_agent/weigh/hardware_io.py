"""Explicit, lazy device adapters. Importing this module opens no devices.

PATLITE protocol: manufacturer manual B95100543-2_03, section 7.4,
https://docs.rs-online.com/d3b3/A700000009188922.pdf (original hosted by RS).
Windows RAW API sequence:
https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer
"""
import ctypes
from ctypes import wintypes
import os
import re
import socket
import threading
import time
import uuid


class HardwareError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(f"{code}: {message}")


def _payload(data):
    if not isinstance(data, bytes) or not data:
        raise HardwareError("INVALID_PAYLOAD", "Non-empty bytes are required")
    return data


def _name(value, field):
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise HardwareError("NOT_CONFIGURED", f"Configure {field}")
    return value.strip()


def _win_error(operation):
    return HardwareError("WINDOWS_IO", f"{operation} failed (Windows error {ctypes.get_last_error()})")


def _windows_dll(name):
    if os.name != "nt":
        raise HardwareError("UNSUPPORTED_OS", "This adapter requires Windows")
    return ctypes.WinDLL(name, use_last_error=True)


class TcpPrinterTransport:
    def __init__(self, host, port=9100, timeout=5.0):
        self.host = _name(host, "printer_host")
        try:
            self.port = int(port)
        except (TypeError, ValueError):
            raise HardwareError("INVALID_PORT", "Printer port must be an integer") from None
        if isinstance(port, bool) or str(self.port) != str(port) or not 1 <= self.port <= 65535:
            raise HardwareError("INVALID_PORT", "Printer port must be between 1 and 65535")
        self.timeout = float(timeout)
        if not 0 < self.timeout <= 60:
            raise HardwareError("INVALID_TIMEOUT", "Timeout must be between 0 and 60 seconds")

    def __call__(self, data):
        write_attempted = False
        try:
            data = _payload(data)
            # Once sendall starts, a timeout may follow a partial transfer.
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as connection:
                connection.settimeout(self.timeout)
                write_attempted = True
                connection.sendall(data)
        except Exception as exc:
            exc.print_data_sent = None if write_attempted else False
            raise


class _DocInfo1(ctypes.Structure):
    _fields_ = [("pDocName", wintypes.LPWSTR), ("pOutputFile", wintypes.LPWSTR),
                ("pDatatype", wintypes.LPWSTR)]


class _PrinterInfo4(ctypes.Structure):
    _fields_ = [("pPrinterName", wintypes.LPWSTR), ("pServerName", wintypes.LPWSTR),
                ("Attributes", wintypes.DWORD)]


def _spooler():
    api = _windows_dll("winspool.drv")
    signatures = {
        "OpenPrinterW": ([wintypes.LPWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p], wintypes.BOOL),
        "StartDocPrinterW": ([wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(_DocInfo1)], wintypes.DWORD),
        "StartPagePrinter": ([wintypes.HANDLE], wintypes.BOOL),
        "WritePrinter": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        "EndPagePrinter": ([wintypes.HANDLE], wintypes.BOOL),
        "EndDocPrinter": ([wintypes.HANDLE], wintypes.BOOL),
        "AbortPrinter": ([wintypes.HANDLE], wintypes.BOOL),
        "ClosePrinter": ([wintypes.HANDLE], wintypes.BOOL),
        "EnumPrintersW": ([wintypes.DWORD, wintypes.LPWSTR, wintypes.DWORD, ctypes.c_void_p,
                           wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
    }
    for name, (args, result) in signatures.items():
        getattr(api, name).argtypes = args
        getattr(api, name).restype = result
    return api


class WindowsRawTransport:
    def __init__(self, printer_name):
        self.printer_name = _name(printer_name, "windows_printer")

    def __call__(self, data):
        write_attempted = False
        try:
            data = _payload(data)
            if len(data) > 0xFFFFFFFF:
                raise HardwareError("INVALID_PAYLOAD", "Print job is too large")
            api, handle = _spooler(), wintypes.HANDLE()
            if not api.OpenPrinterW(self.printer_name, ctypes.byref(handle), None):
                raise _win_error("OpenPrinter")
            started = False
            try:
                info = _DocInfo1("Weighing label job", None, "RAW")
                if not api.StartDocPrinterW(handle, 1, ctypes.byref(info)):
                    raise _win_error("StartDocPrinter")
                started = True
                if not api.StartPagePrinter(handle):
                    raise _win_error("StartPagePrinter")
                written, buffer = wintypes.DWORD(), ctypes.create_string_buffer(data)
                write_attempted = True
                if not api.WritePrinter(handle, buffer, len(data), ctypes.byref(written)):
                    raise _win_error("WritePrinter")
                if written.value != len(data):
                    raise HardwareError("PARTIAL_WRITE", f"Spooler accepted {written.value} of {len(data)} bytes")
                if not api.EndPagePrinter(handle):
                    raise _win_error("EndPagePrinter")
                if not api.EndDocPrinter(handle):
                    raise _win_error("EndDocPrinter")
                started = False
            except BaseException:
                if started:
                    api.AbortPrinter(handle)
                raise
            finally:
                api.ClosePrinter(handle)
        except Exception as exc:
            exc.print_data_sent = None if write_attempted else False
            raise


def list_windows_printers():
    """Read names from the local Windows printer cache (no print job)."""
    if os.name != "nt":
        return []
    api = _spooler()
    needed, returned = wintypes.DWORD(), wintypes.DWORD()
    success = api.EnumPrintersW(6, None, 4, None, 0, ctypes.byref(needed), ctypes.byref(returned))
    if not needed.value:
        if not success and ctypes.get_last_error() not in (0, 122):
            raise _win_error("EnumPrinters")
        return []
    buffer = ctypes.create_string_buffer(needed.value)
    if not api.EnumPrintersW(6, None, 4, buffer, needed.value, ctypes.byref(needed), ctypes.byref(returned)):
        raise _win_error("EnumPrinters")
    rows = ctypes.cast(buffer, ctypes.POINTER(_PrinterInfo4))
    return sorted({rows[index].pPrinterName for index in range(returned.value) if rows[index].pPrinterName})


# Windows exposes USB printer bulk endpoints through this device-interface
# class.  It is an interface class GUID, not a particular printer instance;
# compatibility is confirmed from each device's IEEE-1284 identity below.
USBPRINT_INTERFACE_GUID = "{28d78fad-5a12-11d1-ae5b-0000f803a8c2}"
# CTL_CODE(FILE_DEVICE_UNKNOWN, USBPRINT_IOCTL_INDEX + 13,
#          METHOD_BUFFERED, FILE_ANY_ACCESS), from Windows usbprint.h.
_IOCTL_USBPRINT_GET_1284_ID = 0x00220034
_ERROR_INSUFFICIENT_BUFFER = 122
_ERROR_NO_MORE_ITEMS = 259
_ERROR_IO_PENDING = 997
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 258
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _Guid(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    @classmethod
    def parse(cls, value):
        raw = uuid.UUID(value.strip("{}"))
        return cls.from_buffer_copy(raw.bytes_le)


class _DeviceInterfaceData(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("InterfaceClassGuid", _Guid),
        ("Flags", wintypes.DWORD),
        ("Reserved", ctypes.c_size_t),
    ]


class _Overlapped(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_size_t),
        ("InternalHigh", ctypes.c_size_t),
        ("Offset", wintypes.DWORD),
        ("OffsetHigh", wintypes.DWORD),
        ("hEvent", wintypes.HANDLE),
    ]


def _setupapi():
    api = _windows_dll("setupapi")
    api.SetupDiGetClassDevsW.argtypes = [
        ctypes.POINTER(_Guid), wintypes.LPCWSTR, wintypes.HWND, wintypes.DWORD,
    ]
    api.SetupDiGetClassDevsW.restype = wintypes.HANDLE
    api.SetupDiEnumDeviceInterfaces.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(_Guid), wintypes.DWORD,
        ctypes.POINTER(_DeviceInterfaceData),
    ]
    api.SetupDiEnumDeviceInterfaces.restype = wintypes.BOOL
    api.SetupDiGetDeviceInterfaceDetailW.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(_DeviceInterfaceData), ctypes.c_void_p,
        wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    api.SetupDiGetDeviceInterfaceDetailW.restype = wintypes.BOOL
    api.SetupDiDestroyDeviceInfoList.argtypes = [wintypes.HANDLE]
    api.SetupDiDestroyDeviceInfoList.restype = wintypes.BOOL
    return api


def _usb_kernel():
    api = _windows_dll("kernel32")
    signatures = {
        "CreateFileW": ([wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                         ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                         wintypes.HANDLE], wintypes.HANDLE),
        "DeviceIoControl": ([wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p,
                             wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                             ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
        "CreateEventW": ([ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL,
                          wintypes.LPCWSTR], wintypes.HANDLE),
        "ReadFile": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                      ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(_Overlapped)], wintypes.BOOL),
        "WriteFile": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                       ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(_Overlapped)], wintypes.BOOL),
        "GetOverlappedResult": ([wintypes.HANDLE, ctypes.POINTER(_Overlapped),
                                 ctypes.POINTER(wintypes.DWORD), wintypes.BOOL], wintypes.BOOL),
        "CancelIoEx": ([wintypes.HANDLE, ctypes.POINTER(_Overlapped)], wintypes.BOOL),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (args, result) in signatures.items():
        getattr(api, name).argtypes = args
        getattr(api, name).restype = result
    return api


def _list_usbprint_interface_paths():
    """Enumerate present USB printer interfaces without opening print jobs."""
    if os.name != "nt":
        return []
    api, interface_guid = _setupapi(), _Guid.parse(USBPRINT_INTERFACE_GUID)
    # DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
    device_set = api.SetupDiGetClassDevsW(ctypes.byref(interface_guid), None, None, 0x12)
    if device_set in (None, _INVALID_HANDLE_VALUE):
        raise _win_error("SetupDiGetClassDevs")
    paths = []
    try:
        index = 0
        while True:
            interface = _DeviceInterfaceData()
            interface.cbSize = ctypes.sizeof(_DeviceInterfaceData)
            ctypes.set_last_error(0)
            if not api.SetupDiEnumDeviceInterfaces(
                    device_set, None, ctypes.byref(interface_guid), index, ctypes.byref(interface)):
                error = ctypes.get_last_error()
                if error == _ERROR_NO_MORE_ITEMS:
                    break
                raise _win_error("SetupDiEnumDeviceInterfaces")
            needed = wintypes.DWORD()
            ctypes.set_last_error(0)
            api.SetupDiGetDeviceInterfaceDetailW(
                device_set, ctypes.byref(interface), None, 0, ctypes.byref(needed), None,
            )
            if not needed.value or ctypes.get_last_error() not in (0, _ERROR_INSUFFICIENT_BUFFER):
                raise _win_error("Size USB printer device path")
            buffer = ctypes.create_string_buffer(needed.value)
            # SP_DEVICE_INTERFACE_DETAIL_DATA_W.cbSize is 8 on 64-bit Windows
            # and 6 on 32-bit Windows. DevicePath itself begins at byte 4.
            ctypes.cast(buffer, ctypes.POINTER(wintypes.DWORD))[0] = 8 if ctypes.sizeof(ctypes.c_void_p) == 8 else 6
            if not api.SetupDiGetDeviceInterfaceDetailW(
                    device_set, ctypes.byref(interface), buffer, needed.value,
                    ctypes.byref(needed), None):
                raise _win_error("Read USB printer device path")
            paths.append(ctypes.wstring_at(ctypes.addressof(buffer) + ctypes.sizeof(wintypes.DWORD)))
            index += 1
    finally:
        api.SetupDiDestroyDeviceInfoList(device_set)
    return sorted(set(paths), key=str.casefold)


def _read_usbprint_ieee1284_id(path):
    """Read the USB printer identity; this command cannot create a print job."""
    api, handle = _usb_kernel(), None
    handle = api.CreateFileW(path, 0xC0000000, 3, None, 3, 0, None)
    if handle in (None, _INVALID_HANDLE_VALUE):
        raise _win_error("Open USB printer identity")
    try:
        # Microsoft documents that some USB printers reject 65535-byte output
        # buffers and recommends 4094 bytes or less for this request.
        buffer, returned = ctypes.create_string_buffer(4094), wintypes.DWORD()
        if not api.DeviceIoControl(
                handle, _IOCTL_USBPRINT_GET_1284_ID, None, 0, buffer, len(buffer),
                ctypes.byref(returned), None):
            raise _win_error("Read USB printer IEEE-1284 identity")
        return bytes(buffer.raw[:returned.value])
    finally:
        api.CloseHandle(handle)


def _parse_ieee1284_id(raw):
    if not isinstance(raw, (bytes, bytearray)):
        raise HardwareError("INVALID_IDENTITY", "USB printer identity must be bytes")
    payload = bytes(raw).rstrip(b"\0")
    # usbprint commonly prefixes the IEEE-1284 string with a two-byte,
    # big-endian length. Searching for the first known field also handles
    # drivers that include or omit those bytes from the reported length.
    upper = payload.upper()
    starts = [position for marker in (b"MANUFACTURER:", b"MFG:")
              if (position := upper.find(marker)) >= 0]
    if starts:
        payload = payload[min(starts):]
    text = payload.decode("ascii", "replace").strip("\0 \r\n;")
    fields = {}
    for item in text.split(";"):
        if ":" not in item:
            continue
        key, value = item.split(":", 1)
        key = " ".join(key.upper().split())
        value = value.strip()
        if key and value:
            fields[key] = value
    return text, fields


def _idprt_identity(path, raw):
    text, fields = _parse_ieee1284_id(raw)
    manufacturer = fields.get("MANUFACTURER", fields.get("MFG", ""))
    model = fields.get("MODEL", fields.get("MDL", ""))
    active = fields.get("ACTIVE COMMAND", "")
    # The same verified 300 dpi device reports iF43T in TSPL and iF43 in ZPL.
    # Do not accept generic iF4 / 203 dpi iF42 identities for these coordinates.
    if manufacturer.casefold() != "idprt" or model.casefold() not in ("if43t", "if43"):
        return None
    language = _normalize_idprt_language(active)
    if language not in ("tspl", "zpl"):
        return None
    return {
        "id": path,
        "path": path,
        "label": f"iDPRT {model} · USB direct · {active}",
        "manufacturer": manufacturer,
        "model": model,
        "command": active,
        "device_id": text,
    }


def list_idprt_usb_printers():
    """Return verified 300 dpi iF43T interfaces operating in TSPL or ZPL."""
    rows = []
    for path in _list_usbprint_interface_paths():
        try:
            row = _idprt_identity(path, _read_usbprint_ieee1284_id(path))
        except HardwareError:
            # An inaccessible or unrelated USB printer does not make another
            # compatible, readable iF4 disappear from discovery.
            continue
        if row is not None:
            rows.append(row)
    return sorted(rows, key=lambda row: (row["label"].casefold(), row["path"].casefold()))


class _WindowsUsbPrinterDevice:
    """A single direct USB printer handle with bounded overlapped I/O."""
    def __init__(self, path):
        self.api = _usb_kernel()
        # GENERIC_READ|GENERIC_WRITE, share read/write, OPEN_EXISTING,
        # FILE_FLAG_OVERLAPPED. Sharing matches the proven iF4 diagnostic and
        # allows the driver/status utilities to coexist.
        self.handle = self.api.CreateFileW(path, 0xC0000000, 3, None, 3, 0x40000000, None)
        if self.handle in (None, _INVALID_HANDLE_VALUE):
            self.handle = None
            raise _win_error("Open iDPRT USB interface")

    def _transfer(self, data=None, size=4096, timeout=5.0, timeout_is_empty=False):
        if self.handle is None:
            raise HardwareError("PRINTER_CLOSED", "iDPRT USB interface is closed")
        timeout_ms = max(1, min(60000, int(float(timeout) * 1000)))
        event = self.api.CreateEventW(None, True, False, None)
        if not event:
            raise _win_error("Create iDPRT USB I/O event")
        overlap, count = _Overlapped(hEvent=event), wintypes.DWORD()
        buffer = ctypes.create_string_buffer(size if data is None else data)
        operation = self.api.ReadFile if data is None else self.api.WriteFile
        length = size if data is None else len(data)
        try:
            ctypes.set_last_error(0)
            complete = operation(
                self.handle, buffer, length, ctypes.byref(count), ctypes.byref(overlap),
            )
            if not complete:
                error = ctypes.get_last_error()
                if error != _ERROR_IO_PENDING:
                    raise _win_error("Read iDPRT USB" if data is None else "Write iDPRT USB")
                wait = self.api.WaitForSingleObject(event, timeout_ms)
                if wait == _WAIT_TIMEOUT:
                    # Cancel this exact operation and reap it before the stack
                    # OVERLAPPED/buffer objects go out of scope.
                    self.api.CancelIoEx(self.handle, ctypes.byref(overlap))
                    self.api.GetOverlappedResult(
                        self.handle, ctypes.byref(overlap), ctypes.byref(count), True,
                    )
                    if data is None and timeout_is_empty:
                        return b""
                    raise HardwareError("USB_TIMEOUT", "iDPRT USB operation timed out; no retry was made")
                if wait != _WAIT_OBJECT_0:
                    error = _win_error("Wait for iDPRT USB operation")
                    # A failed wait does not complete the pending I/O. Reap it
                    # before freeing the OVERLAPPED, buffer or event, just as
                    # on timeout. Keep the wait error before cleanup changes it.
                    self.api.CancelIoEx(self.handle, ctypes.byref(overlap))
                    self.api.GetOverlappedResult(
                        self.handle, ctypes.byref(overlap), ctypes.byref(count), True,
                    )
                    raise error
                if not self.api.GetOverlappedResult(
                        self.handle, ctypes.byref(overlap), ctypes.byref(count), False):
                    raise _win_error("Complete iDPRT USB operation")
            if data is not None:
                if count.value != len(data):
                    raise HardwareError(
                        "PARTIAL_WRITE",
                        f"iDPRT USB accepted {count.value} of {len(data)} bytes; no retry was made",
                    )
                return count.value
            return bytes(buffer.raw[:count.value])
        finally:
            self.api.CloseHandle(event)

    def read(self, size=4096, timeout=5.0, timeout_is_empty=False):
        return self._transfer(size=size, timeout=timeout, timeout_is_empty=timeout_is_empty)

    def write(self, data, timeout=5.0):
        return self._transfer(data=_payload(data), timeout=timeout)

    def close(self):
        if self.handle is not None:
            self.api.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


def _normalize_idprt_language(value):
    compact = re.sub(r"[\s_-]+", "", str(value).casefold())
    if compact in ("zpl", "zpl2", "zplii"):
        return "zpl"
    return compact


def _parse_zpl_host_status(raw):
    """Parse all three framed ~HS strings; incomplete replies are not ready.

    Zebra's documented host-status fields distinguish peeler label waiting
    and queued formats from media/head/ribbon errors. None means proven output
    count, so these values must never reconcile a physical label count.
    https://docs.zebra.com/content/tcm/us/en/printers/software/zpl-pg/zpl-commands/~hs4.html
    """
    if not isinstance(raw, bytes):
        raise HardwareError("INVALID_STATUS", "ZPL host status must be bytes")
    frames = re.findall(rb"\x02([^\x02\x03]*)\x03\r\n", raw)
    if len(frames) != 3 or re.sub(rb"\x02[^\x02\x03]*\x03\r\n", b"", raw).strip():
        raise HardwareError("INVALID_STATUS", "Expected three complete ZPL host-status strings")
    rows = [frame.split(b",") for frame in frames]
    if [len(row) for row in rows] != [12, 11, 2]:
        raise HardwareError("INVALID_STATUS", "Unexpected ZPL host-status field count")
    # Field 2.5 is print mode and can be a letter on newer printers. Every
    # other field used here must be decimal; no prefix/partial integer parses.
    for row_index, row in enumerate(rows):
        for field_index, value in enumerate(row):
            if row_index == 1 and field_index == 5:
                if not re.fullmatch(rb"[0-9A-Z]", value):
                    raise HardwareError("INVALID_STATUS", "Invalid ZPL print mode")
            elif not re.fullmatch(rb"[0-9]+", value):
                raise HardwareError("INVALID_STATUS", "Invalid ZPL host-status number")
    one, two = rows[:2]
    flags = {
        "paper_out": int(one[1]), "paused": int(one[2]),
        "buffer_full": int(one[5]), "diagnostic_mode": int(one[6]),
        "partial_format": int(one[7]), "corrupt_ram": int(one[9]),
        "under_temperature": int(one[10]), "over_temperature": int(one[11]),
        "head_open": int(two[2]), "ribbon_out": int(two[3]),
        "label_waiting": int(two[7]),
    }
    if any(value not in (0, 1) for value in flags.values()):
        raise HardwareError("INVALID_STATUS", "Invalid ZPL host-status flag")
    errors = [key for key, value in flags.items() if value and key != "label_waiting"]
    formats = int(one[4])
    remaining = int(two[8])
    busy = bool(formats or remaining or flags["label_waiting"])
    return {**flags, "formats_in_buffer": formats, "labels_remaining": remaining,
            "print_mode": two[5].decode("ascii"), "errors": errors,
            "busy": busy, "ready": not errors and not busy}


def _parse_tspl_extended_status(raw):
    """Parse the exact ESC !S reply, without treating idle as a label count.

    TSC documents the eight-byte reply and explicit peel-wait state in its
    TSPL manual, pages 129-132: https://fs.tscprinters.com/en/dl/1/2541.
    iDPRT emulation must answer this protocol correctly to use the queue gate;
    the older one-byte ESC !? reply cannot substitute for peel feedback.
    """
    if not isinstance(raw, bytes) or len(raw) != 8 or raw[:1] != b"\x02" or raw[5:] != b"\x03\r\n":
        raise HardwareError("INVALID_STATUS", "Expected one complete TSPL extended-status frame")
    message_byte, warning_byte, error_byte, media_byte = raw[1:5]
    messages = {
        0x40: "normal", 0x60: "paused", 0x42: "backing_label", 0x43: "cutting",
        0x45: "printer_error", 0x46: "feeding", 0x4B: "waiting_for_key",
        0x4C: "label_waiting", 0x50: "printing", 0x57: "imaging",
    }
    if message_byte not in messages:
        raise HardwareError("INVALID_STATUS", "Unknown TSPL extended-status message")
    # Bit 6 is the fixed printable-ASCII offset. Undocumented/reserved bits
    # are not a ready state. Documented warning/error bits can be combined.
    for value, mask in ((warning_byte, 0x2B), (error_byte, 0x1F), (media_byte, 0x2F)):
        if value & 0xC0 != 0x40 or value & 0x3F & ~mask:
            raise HardwareError("INVALID_STATUS", "Unknown TSPL extended-status bits")
    warning_bits = warning_byte & 0x3F
    error_bits = error_byte & 0x3F
    media_bits = media_byte & 0x3F
    warnings = [name for bit, name in (
        (1, "paper_low"), (2, "ribbon_low"), (8, "receive_buffer_full"), (32, "unhealthy_dots"),
    ) if warning_bits & bit]
    errors = [name for bit, name in (
        (1, "head_over_temperature"), (2, "motor_over_temperature"), (4, "head_error"),
        (8, "cutter_jam"), (16, "insufficient_memory"),
    ) if error_bits & bit]
    errors += [name for bit, name in (
        (1, "paper_out"), (2, "paper_jam"), (4, "ribbon_out"), (8, "ribbon_jam"), (32, "head_open"),
    ) if media_bits & bit]
    if message_byte == 0x45 and not errors:
        errors.append("printer_error")
    message = messages[message_byte]
    busy = message_byte != 0x40
    blocking_warning = bool(warning_bits & (8 | 32))
    return {
        "message": message, "raw_status": raw.hex().upper(),
        "label_waiting": message_byte == 0x4C,
        "activity": message_byte in (0x42, 0x43, 0x46, 0x4C, 0x50, 0x57),
        "paused": message_byte == 0x60, "errors": errors, "warnings": warnings,
        "busy": busy, "ready": not busy and not errors and not blocking_warning,
        "physical_count_known": False,
    }


class IdprtUsbTransport:
    """Submit one payload to an iF43T whose active language matches the job.

    Device selection, opening and the ready check are deliberately lazy. A
    write is attempted exactly once. Callers must reconcile uncertain output;
    this transport never repeats print bytes after a timeout or partial write.
    """
    def __init__(self, device_path=None, timeout=5.0, *, command_language="tspl"):
        self.device_path = device_path.strip() if isinstance(device_path, str) and device_path.strip() else None
        self.timeout = float(timeout)
        if not 0 < self.timeout <= 60:
            raise HardwareError("INVALID_TIMEOUT", "Timeout must be between 0 and 60 seconds")
        if command_language not in ("tspl", "zpl", "auto"):
            raise HardwareError("INVALID_COMMAND_LANGUAGE", "iDPRT command language must be tspl, zpl, or auto")
        self.command_language = command_language
        self._lock = threading.Lock()

    def _payload_language(self, data):
        if self.command_language != "auto":
            return self.command_language
        if data.lstrip().startswith(b"^XA"):
            return "zpl"
        if re.match(rb"SIZE[ \t]+[0-9]", data.lstrip()):
            return "tspl"
        raise HardwareError("INVALID_COMMAND_LANGUAGE", "Cannot identify the print payload language")

    def _select(self):
        candidates = list_idprt_usb_printers()
        if self.device_path:
            matches = [row for row in candidates if row["path"].casefold() == self.device_path.casefold()]
            if len(matches) != 1:
                raise HardwareError("IDPRT_NOT_FOUND", "Selected iDPRT iF43T USB interface is not connected")
            return matches[0]
        if not candidates:
            raise HardwareError("IDPRT_NOT_FOUND", "No iDPRT iF43T in TSPL or ZPL mode is connected")
        if len(candidates) != 1:
            raise HardwareError("IDPRT_SELECTION_REQUIRED", "Select exactly one iDPRT iF43T USB interface")
        return candidates[0]

    def _drain_status(self, device):
        # Remove replies left by an earlier diagnostic. Each read is short and
        # bounded; empty reads are normal here.
        for _ in range(4):
            if not device.read(4096, timeout=min(0.05, self.timeout), timeout_is_empty=True):
                break

    def _ready_status(self, device):
        self._drain_status(device)
        device.write(b"\x1b!?", timeout=self.timeout)
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HardwareError("STATUS_TIMEOUT", "iDPRT ready status timed out; no print data was sent")
            status = device.read(1, timeout=min(0.25, remaining), timeout_is_empty=True)
            if status:
                return status

    def _zpl_ready_status(self, device):
        self._drain_status(device)
        device.write(b"~HS\r\n", timeout=self.timeout)
        deadline = time.monotonic() + self.timeout
        response = b""
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            response += device.read(4096, timeout=min(.25, remaining), timeout_is_empty=True)
            if len(response) > 4096:
                raise HardwareError("INVALID_STATUS", "ZPL status response exceeded its size limit")
            if response.count(b"\x03\r\n") >= 3:
                return _parse_zpl_host_status(response)
        raise HardwareError("STATUS_TIMEOUT", "iDPRT ZPL status timed out; no print data was sent")

    def _tspl_extended_status(self, device):
        self._drain_status(device)
        device.write(b"\x1b!S", timeout=self.timeout)
        deadline = time.monotonic() + self.timeout
        response = b""
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            response += device.read(4096, timeout=min(.25, remaining), timeout_is_empty=True)
            if len(response) >= 8:
                return _parse_tspl_extended_status(response)
        raise HardwareError("STATUS_TIMEOUT", "iDPRT TSPL extended status timed out; no print data was sent")

    def queue_status(self, command_language=None):
        """Query printer activity/peel waiting without sending print commands.

        This is a queue dispatch gate, never proof of how many labels were
        printed or taken. In TSPL, 'ready' has no remaining-format count. An
        unsupported extended query fails closed instead of falling back to
        ESC !?, which does not expose the label-taken sensor state.
        """
        try:
            requested = self.command_language if command_language is None else command_language
            if requested not in ("tspl", "zpl", "auto"):
                raise HardwareError("INVALID_COMMAND_LANGUAGE", "Queue status requires tspl, zpl, or auto")
            with self._lock:
                selected = self._select()
                active = _normalize_idprt_language(selected.get("command", ""))
                language = active if requested == "auto" else requested
                if language not in ("tspl", "zpl") or active != language:
                    raise HardwareError("LANGUAGE_MISMATCH", "iDPRT active language does not match the queue status query")
                with _WindowsUsbPrinterDevice(selected["path"]) as device:
                    if language == "tspl":
                        status = self._tspl_extended_status(device)
                    else:
                        status = self._zpl_ready_status(device)
                        status = {**status, "label_waiting": bool(status["label_waiting"]),
                                  "activity": bool(status["busy"]), "warnings": [],
                                  "message": "ready" if status["ready"] else "not_ready",
                                  "physical_count_known": False}
                return {**status, "command_language": language}
        except BaseException as exc:
            exc.print_data_sent = False
            raise

    def __call__(self, data):
        print_attempted = False
        try:
            data = _payload(data)
            if len(data) > 0xFFFFFFFF:
                raise HardwareError("INVALID_PAYLOAD", "Print job is too large")
            language = self._payload_language(data)
            with self._lock:
                selected = self._select()
                # Both languages are supported by the product family, but a
                # command query did not prove automatic switching on this
                # device. Require its fresh IEEE-1284 active-language report.
                active = _normalize_idprt_language(selected.get("command", ""))
                if active != language:
                    raise HardwareError(
                        "LANGUAGE_MISMATCH",
                        f"iDPRT active language is {active or 'unknown'}; job requires {language}. "
                        "Set the printer language in the manufacturer utility; no print data was sent",
                    )
                with _WindowsUsbPrinterDevice(selected["path"]) as device:
                    if language == "tspl":
                        status = self._ready_status(device)
                        if status != b"\x00":
                            raise HardwareError(
                                "PRINTER_NOT_READY",
                                f"iDPRT status is 0x{status.hex().upper()}; no print data was sent",
                            )
                    else:
                        status = self._zpl_ready_status(device)
                        if not status["ready"]:
                            detail = ", ".join(status["errors"]) or "previous labels or formats remain"
                            raise HardwareError("PRINTER_NOT_READY", "iDPRT ZPL " + detail + "; no print data was sent")
                    # Mark before the call: even a timeout can follow a partial
                    # transfer. Never convert that uncertainty to a zero count.
                    print_attempted = True
                    device.write(data, timeout=self.timeout)
        except BaseException as exc:
            exc.print_data_sent = None if print_attempted else False
            raise


def make_printer_transport(settings):
    mode = settings.get("printer_mode", "simulation")
    if mode == "tcp":
        return TcpPrinterTransport(settings.get("printer_host"), settings.get("printer_port", 9100))
    if mode == "windows_raw":
        return WindowsRawTransport(settings.get("windows_printer"))
    if mode == "idprt_usb":
        return IdprtUsbTransport(settings.get("idprt_device_path"), command_language='zpl')
    if mode == "simulation":
        def disabled(data):
            raise HardwareError("SIMULATION_ONLY", "Use SimulatorPrinter for virtual labels")
        return disabled
    raise HardwareError("INVALID_MODE", "Unsupported printer mode")


VID, PID = 0x191A, 0x8003
COLORS = ("off", "yellow", "green", "red")
BUZZERS = ("off", "ok", "ng")


def build_patlite_report(color, buzzer="off"):
    """One report ID byte + the manual's 8-byte protocol payload.

    OK uses one second of pattern 2 (one 500 ms beep); NG uses one second
    of pattern 3 (three short beeps). Both limits are one, never continuous.
    """
    if color not in COLORS or buzzer not in BUZZERS:
        raise HardwareError("INVALID_SIGNAL", "Unsupported lamp color or buzzer pattern")
    buzzer_control = {"off": 0x00, "ok": 0x13, "ng": 0x14}[buzzer]
    red_yellow = 0x10 if color == "red" else 0x01 if color == "yellow" else 0x00
    green_blue = 0x10 if color == "green" else 0x00
    return bytes((0, 0, 0, buzzer_control, 0x60, red_yellow, green_blue, 0, 0))


def _hid_module():
    try:
        import hid
    except ImportError:
        raise HardwareError("HID_NOT_INSTALLED", "Install hidapi==0.15.0 for PATLITE USB discovery") from None
    return hid


def list_signal_devices():
    rows = []
    for item in _hid_module().enumerate(VID, PID):
        path = item.get("path")
        if not isinstance(path, bytes) or not path:
            continue
        identity = path.hex()
        suffix = item.get("serial_number") or item.get("product_string") or "USB signal tower"
        rows.append({"id": identity, "path": identity, "label": f"PATLITE LR6-USB · {suffix}"})
    return rows


class _WindowsHidDevice:
    """Exclusive Windows handle, unlike hidapi's shared Windows open mode."""
    def __init__(self, path):
        self.api = _windows_dll("kernel32")
        self.api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                         ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.api.CreateFileW.restype = wintypes.HANDLE
        self.api.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                                       ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        self.api.WriteFile.restype = wintypes.BOOL
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.api.CloseHandle.restype = wintypes.BOOL
        # GENERIC_READ|GENERIC_WRITE, share mode=0, OPEN_EXISTING.
        self.handle = self.api.CreateFileW(path.decode("utf-8"), 0xC0000000, 0, None, 3, 0, None)
        if self.handle in (None, ctypes.c_void_p(-1).value):
            self.handle = None
            raise _win_error("Open exclusive PATLITE USB handle")

    def write(self, report):
        if self.handle is None:
            raise HardwareError("SIGNAL_CLOSED", "Signal device is closed")
        written = wintypes.DWORD()
        buffer = ctypes.create_string_buffer(report)
        if not self.api.WriteFile(self.handle, buffer, len(report), ctypes.byref(written), None):
            raise _win_error("Write PATLITE report")
        return written.value

    def close(self):
        if self.handle is not None:
            self.api.CloseHandle(self.handle)
            self.handle = None


class VirtualSignal:
    status = "virtual"

    def __init__(self):
        self.color, self.buzzer = "off", "off"

    def set_state(self, color, buzzer="off"):
        build_patlite_report(color, buzzer)
        self.color, self.buzzer = color, buzzer

    def close(self):
        self.color, self.buzzer = "off", "off"


class PatliteSignal:
    """Lazy open on explicit set_state; no retry after an I/O error."""
    def __init__(self, device_path=None):
        self.device_path = device_path
        self.device = None
        self.status = "not_configured" if not device_path else "not_connected"
        self._lock = threading.Lock()
        self._closed = False

    def _open(self):
        candidates = list_signal_devices()
        if not self.device_path:
            if len(candidates) != 1:
                raise HardwareError("SIGNAL_SELECTION_REQUIRED", "Select exactly one PATLITE LR6-USB device")
            self.device_path = candidates[0]["path"]
        if self.device_path not in {row["path"] for row in candidates}:
            raise HardwareError("SIGNAL_NOT_FOUND", "Selected PATLITE LR6-USB is not connected")
        self.device = _WindowsHidDevice(bytes.fromhex(self.device_path))
        self.status = "connected"

    def set_state(self, color, buzzer="off"):
        report = build_patlite_report(color, buzzer)
        with self._lock:
            if self._closed:
                raise HardwareError("SIGNAL_CLOSED", "Signal device is closed")
            try:
                if self.device is None:
                    self._open()
                if self.device.write(report) != len(report):
                    raise HardwareError("SIGNAL_PARTIAL_WRITE", "Incomplete HID output report")
            except Exception:
                self.status = "error"
                if self.device is not None:
                    self.device.close()
                    self.device = None
                # Reconnect is explicit: create a new adapter after an error.
                self._closed = True
                raise

    def close(self):
        with self._lock:
            try:
                if self.device is not None:
                    if self.device.write(build_patlite_report("off", "off")) != 9:
                        raise HardwareError("SIGNAL_PARTIAL_WRITE", "Unable to confirm all-off report submission")
            finally:
                if self.device is not None:
                    self.device.close()
                    self.device = None
                self.status, self._closed = "closed", True


def create_signal(settings):
    mode = settings.get("light_mode", "virtual")
    if mode == "virtual":
        return VirtualSignal()
    if mode == "patlite_usb":
        return PatliteSignal(settings.get("light_device_path"))
    if mode == "k50l_serial":
        from .k50l_signal import K50LSignal
        return K50LSignal(settings.get("light_serial_port"))
    raise HardwareError("INVALID_MODE", "Unsupported signal mode")
