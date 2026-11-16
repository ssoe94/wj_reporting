import ctypes
from ctypes import wintypes
import unittest
from unittest.mock import MagicMock, patch

from field_agent.weigh import hardware_io as io


def set_dword(pointer, value):
    ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD))[0] = value


IEEE_ID = (
    b"\x00\x72MANUFACTURER:iDPRT;MODEL:iF43T;COMMAND SET:TSPL;"
    b"COMMENT:Impact Printer;ACTIVE COMMAND:TSPL;\x00"
)


def zpl_status(*, first=None, second=None):
    rows = [
        ["030", "0", "0", "0354", "000", "0", "0", "0", "000", "0", "0", "0"],
        ["000", "0", "0", "0", "1", "1", "0", "0", "00000000", "1", "000"],
        ["0000", "0"],
    ]
    for index, value in (first or {}).items():
        rows[0][index] = str(value)
    for index, value in (second or {}).items():
        rows[1][index] = str(value)
    return b"".join(b"\x02" + ",".join(row).encode("ascii") + b"\x03\r\n" for row in rows)


class FakeDevice:
    def __init__(self, reads=(), payload_error=None):
        self.reads = list(reads)
        self.payload_error = payload_error
        self.writes = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def read(self, size=4096, timeout=5.0, timeout_is_empty=False):
        return self.reads.pop(0) if self.reads else b""

    def write(self, data, timeout=5.0):
        self.writes.append(data)
        if data not in (b"\x1b!?", b"~HS\r\n") and self.payload_error is not None:
            raise self.payload_error
        return len(data)

    def close(self):
        self.closed = True


class IdprtDiscoveryTests(unittest.TestCase):
    def test_native_zpl_model_alias_preserves_300dpi_filter(self):
        raw = b'MANUFACTURER:iDPRT;MODEL:iF43;COMMAND SET:ZPL;COMMENT:Impact Printer;ACTIVE COMMAND:ZPL'
        row = io._idprt_identity('same-physical-usb-device', raw)
        self.assertEqual(row['model'], 'iF43')
        self.assertEqual(row['command'], 'ZPL')
        for model in (b'iF42', b'iF42T', b'iF4'):
            self.assertIsNone(io._idprt_identity('other', raw.replace(b'iF43', model)))

    def test_ieee1284_parser_handles_usbprint_length_prefix(self):
        text, fields = io._parse_ieee1284_id(IEEE_ID)
        self.assertTrue(text.startswith("MANUFACTURER:iDPRT"))
        self.assertEqual(fields["MODEL"], "iF43T")
        self.assertEqual(fields["ACTIVE COMMAND"], "TSPL")

    def test_discovery_keeps_verified_300dpi_idprt_with_active_tspl_or_zpl(self):
        identities = {
            "if4": IEEE_ID,
            "other-brand": b"MFG:Other;MDL:iF43T;ACTIVE COMMAND:TSPL;",
            "zpl-mode": b"MANUFACTURER:iDPRT;MODEL:iF43T;ACTIVE COMMAND:ZPL;",
            "unknown-mode": b"MANUFACTURER:iDPRT;MODEL:iF43T;ACTIVE COMMAND:UNKNOWN;",
            "wrong-model": b"MANUFACTURER:iDPRT;MODEL:HT330;ACTIVE COMMAND:TSPL;",
            "wrong-resolution": b"MANUFACTURER:iDPRT;MODEL:iF42T;ACTIVE COMMAND:TSPL;",
            "unknown-resolution": b"MANUFACTURER:iDPRT;MODEL:iF4;ACTIVE COMMAND:TSPL;",
        }
        with patch.object(io, "_list_usbprint_interface_paths", return_value=list(identities)), \
                patch.object(io, "_read_usbprint_ieee1284_id", side_effect=lambda path: identities[path]):
            rows = io.list_idprt_usb_printers()
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["path"] for row in rows}, {"if4", "zpl-mode"})
        self.assertEqual(rows[0]["model"], "iF43T")
        self.assertEqual(rows[0]["command"], "TSPL")
        self.assertIn("USB direct", rows[0]["label"])

    def test_unreadable_unrelated_interface_does_not_hide_compatible_device(self):
        def identity(path):
            if path == "blocked":
                raise io.HardwareError("WINDOWS_IO", "access denied")
            return IEEE_ID

        with patch.object(io, "_list_usbprint_interface_paths", return_value=["blocked", "if4"]), \
                patch.object(io, "_read_usbprint_ieee1284_id", side_effect=identity):
            self.assertEqual([row["path"] for row in io.list_idprt_usb_printers()], ["if4"])


class IdprtTransportTests(unittest.TestCase):
    def test_construction_is_lazy(self):
        with patch.object(io, "list_idprt_usb_printers") as discover, \
                patch.object(io, "_WindowsUsbPrinterDevice") as open_device:
            transport = io.IdprtUsbTransport()
            via_factory = io.make_printer_transport({"printer_mode": "idprt_usb"})
        self.assertIsInstance(transport, io.IdprtUsbTransport)
        self.assertIsInstance(via_factory, io.IdprtUsbTransport)
        self.assertEqual(via_factory.command_language, "zpl")
        discover.assert_not_called()
        open_device.assert_not_called()

    def test_zero_or_multiple_devices_fail_before_open(self):
        for rows, expected in (
                ([], "IDPRT_NOT_FOUND"),
                ([{"path": "a"}, {"path": "b"}], "IDPRT_SELECTION_REQUIRED")):
            with self.subTest(rows=rows), \
                    patch.object(io, "list_idprt_usb_printers", return_value=rows), \
                    patch.object(io, "_WindowsUsbPrinterDevice") as open_device, \
                    self.assertRaises(io.HardwareError) as error:
                io.IdprtUsbTransport()(b"PRINT 1,1\r\n")
            self.assertEqual(error.exception.code, expected)
            self.assertIs(error.exception.print_data_sent, False)
            open_device.assert_not_called()

    def test_selected_path_must_still_be_compatible_and_present(self):
        rows = [{"path": "present"}]
        with patch.object(io, "list_idprt_usb_printers", return_value=rows), \
                patch.object(io, "_WindowsUsbPrinterDevice") as open_device, \
                self.assertRaises(io.HardwareError) as error:
            io.IdprtUsbTransport("missing")(b"PRINT 1,1\r\n")
        self.assertEqual(error.exception.code, "IDPRT_NOT_FOUND")
        open_device.assert_not_called()

    def test_ready_check_then_exactly_one_payload_write_and_close(self):
        # First empty read drains old replies; second returns fresh status 0x00.
        device = FakeDevice(reads=[b"", b"\x00"])
        rows = [{"path": "if4", "command": "TSPL"}]
        payload = b"CLS\r\nPRINT 1,1\r\n"
        with patch.object(io, "list_idprt_usb_printers", return_value=rows), \
                patch.object(io, "_WindowsUsbPrinterDevice", return_value=device) as opened:
            io.IdprtUsbTransport()(payload)
        opened.assert_called_once_with("if4")
        self.assertEqual(device.writes, [b"\x1b!?", payload])
        self.assertEqual(device.writes.count(payload), 1)
        self.assertTrue(device.closed)

    def test_non_ready_status_prevents_print_bytes(self):
        device = FakeDevice(reads=[b"", b"\x04"])
        rows = [{"path": "if4", "command": "TSPL"}]
        with patch.object(io, "list_idprt_usb_printers", return_value=rows), \
                patch.object(io, "_WindowsUsbPrinterDevice", return_value=device), \
                self.assertRaises(io.HardwareError) as error:
            io.IdprtUsbTransport()(b"PRINT 1,1\r\n")
        self.assertEqual(error.exception.code, "PRINTER_NOT_READY")
        self.assertIs(error.exception.print_data_sent, False)
        self.assertEqual(device.writes, [b"\x1b!?"])
        self.assertTrue(device.closed)

    def test_auto_routes_zpl_and_waits_for_all_fragmented_status_strings(self):
        status = zpl_status()
        device = FakeDevice(reads=[b"", status[:10], status[10:48], status[48:]])
        payload = b"^XA\n^PW709\n^XZ\n"
        with patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": "ZPL-II"}]), \
                patch.object(io, "_WindowsUsbPrinterDevice", return_value=device):
            io.IdprtUsbTransport(command_language="auto")(payload)
        self.assertEqual(device.writes, [b"~HS\r\n", payload])
        self.assertTrue(device.closed)

    def test_auto_routes_tspl_without_changing_the_payload(self):
        device = FakeDevice(reads=[b"", b"\x00"])
        payload = b"SIZE 100 mm,80 mm\r\nCLS\r\nPRINT 1,1\r\n"
        with patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": "TSPL"}]), \
                patch.object(io, "_WindowsUsbPrinterDevice", return_value=device):
            io.IdprtUsbTransport(command_language="auto")(payload)
        self.assertEqual(device.writes, [b"\x1b!?", payload])

    def test_language_mismatch_or_unknown_identity_cannot_send_any_bytes(self):
        for active in ("TSPL", "AUTO", "", "EPL"):
            with self.subTest(active=active), \
                    patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": active}]), \
                    patch.object(io, "_WindowsUsbPrinterDevice") as opened, \
                    self.assertRaises(io.HardwareError) as error:
                io.IdprtUsbTransport(command_language="auto")(b"^XA\n^XZ\n")
            self.assertEqual(error.exception.code, "LANGUAGE_MISMATCH")
            self.assertIs(error.exception.print_data_sent, False)
            opened.assert_not_called()

    def test_unknown_auto_payload_fails_before_discovery(self):
        with patch.object(io, "list_idprt_usb_printers") as discover, self.assertRaises(io.HardwareError) as error:
            io.IdprtUsbTransport(command_language="auto")(b"arbitrary bytes")
        self.assertIs(error.exception.print_data_sent, False)
        discover.assert_not_called()

    def test_open_and_status_query_failures_prove_no_print_data_sent(self):
        for phase in ("open", "status"):
            failure = io.HardwareError("USB_TIMEOUT", phase)
            with self.subTest(phase=phase), \
                    patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": "TSPL"}]), \
                    patch.object(io, "_WindowsUsbPrinterDevice") as opened, \
                    patch.object(io.IdprtUsbTransport, "_ready_status") as ready:
                if phase == "open":
                    opened.side_effect = failure
                else:
                    ready.side_effect = failure
                with self.assertRaises(io.HardwareError) as error:
                    io.IdprtUsbTransport()(b"PRINT 1,1\r\n")
                self.assertIs(error.exception.print_data_sent, False)
                self.assertIs(error.exception, failure)

    def test_zpl_errors_and_existing_peel_or_buffer_wait_block_new_print(self):
        for status in (zpl_status(first={1: 1}), zpl_status(second={2: 1}), zpl_status(second={3: 1}),
                       zpl_status(second={7: 1}), zpl_status(first={4: 2}), zpl_status(second={8: 2})):
            device = FakeDevice(reads=[b"", status])
            with self.subTest(status=status), \
                    patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": "ZPL"}]), \
                    patch.object(io, "_WindowsUsbPrinterDevice", return_value=device), \
                    self.assertRaises(io.HardwareError) as error:
                io.IdprtUsbTransport(command_language="zpl")(b"^XA\n^XZ\n")
            self.assertEqual(error.exception.code, "PRINTER_NOT_READY")
            self.assertIs(error.exception.print_data_sent, False)
            self.assertEqual(device.writes, [b"~HS\r\n"])

    def test_incomplete_zpl_status_times_out_without_payload(self):
        device = FakeDevice(reads=[b"", zpl_status()[:30]])
        with patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": "ZPL"}]), \
                patch.object(io, "_WindowsUsbPrinterDevice", return_value=device), \
                self.assertRaises(io.HardwareError) as error:
            io.IdprtUsbTransport(timeout=.002, command_language="zpl")(b"^XA\n^XZ\n")
        self.assertEqual(error.exception.code, "STATUS_TIMEOUT")
        self.assertIs(error.exception.print_data_sent, False)
        self.assertEqual(device.writes, [b"~HS\r\n"])

    def test_payload_failure_is_not_retried(self):
        failure = io.HardwareError("PARTIAL_WRITE", "possible partial print submission")
        device = FakeDevice(reads=[b"", b"\x00"], payload_error=failure)
        payload = b"PRINT 1,1\r\n"
        with patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": "TSPL"}]), \
                patch.object(io, "_WindowsUsbPrinterDevice", return_value=device), \
                self.assertRaises(io.HardwareError) as error:
            io.IdprtUsbTransport()(payload)
        self.assertIs(error.exception, failure)
        self.assertIsNone(error.exception.print_data_sent)
        self.assertEqual(device.writes.count(payload), 1)
        self.assertTrue(device.closed)


class ZplHostStatusTests(unittest.TestCase):
    def test_ready_and_peel_wait_are_distinct(self):
        ready = io._parse_zpl_host_status(zpl_status())
        self.assertTrue(ready["ready"])
        waiting = io._parse_zpl_host_status(zpl_status(second={7: 1}))
        self.assertFalse(waiting["ready"])
        self.assertTrue(waiting["busy"])
        self.assertEqual(waiting["errors"], [])
        self.assertEqual(waiting["label_waiting"], 1)

    def test_does_not_accept_partial_malformed_or_extra_response(self):
        for raw in (b"", zpl_status()[:-1], b"junk" + zpl_status(), zpl_status() + zpl_status(),
                    zpl_status(first={1: "X"}), zpl_status(first={1: 2}), zpl_status(second={7: -1})):
            with self.subTest(raw=raw), self.assertRaises(io.HardwareError) as error:
                io._parse_zpl_host_status(raw)
            self.assertEqual(error.exception.code, "INVALID_STATUS")


class OverlappedUsbTests(unittest.TestCase):
    def setUp(self):
        # Overlapped I/O is mocked; ctypes' last-error slot exists on Windows only.
        error_number = [0]

        def set_error(code):
            error_number[0] = code

        for name, fake in (("get_last_error", lambda: error_number[0]), ("set_last_error", set_error)):
            patcher = patch.object(ctypes, name, fake, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def fake_api(self):
        api = MagicMock()
        api.CreateFileW.return_value = 123
        api.CreateEventW.return_value = 456
        return api

    def test_low_level_partial_write_fails_after_one_write(self):
        api = self.fake_api()

        def write(handle, buffer, length, count, overlap):
            set_dword(count, length - 1)
            return 1

        api.WriteFile.side_effect = write
        with patch.object(io, "_usb_kernel", return_value=api):
            device = io._WindowsUsbPrinterDevice("if4")
            with self.assertRaises(io.HardwareError) as error:
                device.write(b"1234", timeout=0.1)
            device.close()
        self.assertEqual(error.exception.code, "PARTIAL_WRITE")
        api.WriteFile.assert_called_once()
        api.CloseHandle.assert_any_call(456)
        api.CloseHandle.assert_any_call(123)

    def test_low_level_pending_write_is_cancelled_at_deadline_without_retry(self):
        api = self.fake_api()

        def pending(handle, buffer, length, count, overlap):
            ctypes.set_last_error(io._ERROR_IO_PENDING)
            return 0

        api.WriteFile.side_effect = pending
        api.WaitForSingleObject.return_value = io._WAIT_TIMEOUT
        api.CancelIoEx.return_value = 1
        api.GetOverlappedResult.return_value = 0
        with patch.object(io, "_usb_kernel", return_value=api):
            device = io._WindowsUsbPrinterDevice("if4")
            with self.assertRaises(io.HardwareError) as error:
                device.write(b"1234", timeout=0.01)
            device.close()
        self.assertEqual(error.exception.code, "USB_TIMEOUT")
        api.WriteFile.assert_called_once()
        api.CancelIoEx.assert_called_once()
        api.GetOverlappedResult.assert_called_once()

    def test_failed_wait_cancels_and_reaps_pending_io_before_closing_event(self):
        for read in (False, True):
            with self.subTest(read=read):
                api = self.fake_api()
                events = []

                def pending(*args):
                    ctypes.set_last_error(io._ERROR_IO_PENDING)
                    return 0

                def failed_wait(*args):
                    ctypes.set_last_error(6)
                    return 0xFFFFFFFF

                def cancel(*args):
                    events.append("cancel")
                    ctypes.set_last_error(1168)
                    return 0

                def reap(handle, overlap, count, wait):
                    self.assertTrue(wait)
                    events.append("reap")
                    return 0

                api.ReadFile.side_effect = pending
                api.WriteFile.side_effect = pending
                api.WaitForSingleObject.side_effect = failed_wait
                api.CancelIoEx.side_effect = cancel
                api.GetOverlappedResult.side_effect = reap
                api.CloseHandle.side_effect = lambda handle: events.append("close")
                with patch.object(io, "_usb_kernel", return_value=api):
                    device = io._WindowsUsbPrinterDevice("if4")
                    with self.assertRaises(io.HardwareError) as error:
                        if read:
                            device.read(timeout=0.01, timeout_is_empty=True)
                        else:
                            device.write(b"1234", timeout=0.01)
                    self.assertEqual(error.exception.code, "WINDOWS_IO")
                    self.assertIn("Windows error 6", str(error.exception))
                    self.assertEqual(events, ["cancel", "reap", "close"])
                    device.close()
                operation = api.ReadFile if read else api.WriteFile
                operation.assert_called_once()
                api.CancelIoEx.assert_called_once()
                api.GetOverlappedResult.assert_called_once()


if __name__ == "__main__":
    unittest.main()
