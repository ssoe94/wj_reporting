import ctypes
from ctypes import wintypes
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from field_agent.weigh import hardware_io as io


def set_dword(pointer, value):
    ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD))[0] = value


class PrinterTransportTests(unittest.TestCase):
    def setUp(self):
        # The spooler methods are stubbed, including its Windows error number.
        error = patch.object(ctypes, "get_last_error", return_value=6, create=True)
        error.start()
        self.addCleanup(error.stop)

    def test_if4_factory_defaults_to_zpl_and_defers_every_hardware_operation(self):
        with patch.object(io, "list_idprt_usb_printers") as discover, \
                patch.object(io, "_WindowsUsbPrinterDevice") as device:
            transport = io.make_printer_transport({
                "printer_mode": "idprt_usb", "idprt_device_path": "fake-USB",
                "idprt_command_language": "tspl",  # Retired preference cannot re-enable TSPL.
                # Legacy setting values cannot select a different runtime language.
                "command_language": "tspl", "label_mode": "device",
            })
        self.assertIsInstance(transport, io.IdprtUsbTransport)
        self.assertEqual(transport.command_language, "zpl")
        self.assertEqual(transport.device_path, "fake-USB")
        discover.assert_not_called()
        device.assert_not_called()

    def test_default_and_construction_never_connect(self):
        with patch.object(io.socket, "create_connection") as connect, patch.object(io, "_spooler") as spool:
            transport = io.make_printer_transport({})
            with self.assertRaises(io.HardwareError) as error:
                transport(b"^XA^XZ")
            self.assertEqual(error.exception.code, "SIMULATION_ONLY")
            io.make_printer_transport({"printer_mode": "tcp", "printer_host": "192.0.2.10"})
            io.make_printer_transport({"printer_mode": "windows_raw", "windows_printer": "Zebra test"})
            connect.assert_not_called()
            spool.assert_not_called()

    def test_tcp_sends_exact_bytes_once_and_closes(self):
        connection = MagicMock()
        with patch.object(io.socket, "create_connection", return_value=connection) as create:
            transport = io.TcpPrinterTransport("192.0.2.10", "9100")
            transport(b"^XA\x00^XZ")
            create.assert_called_once_with(("192.0.2.10", 9100), timeout=5.0)
            connection.__enter__.return_value.sendall.assert_called_once_with(b"^XA\x00^XZ")
            connection.__exit__.assert_called_once()

    def test_tcp_error_is_not_retried(self):
        connection = MagicMock()
        connection.__enter__.return_value.sendall.side_effect = TimeoutError("possible partial send")
        with patch.object(io.socket, "create_connection", return_value=connection) as create:
            with self.assertRaises(TimeoutError) as error:
                io.TcpPrinterTransport("192.0.2.10")(b"^XA^XZ")
            self.assertIsNone(error.exception.print_data_sent)
            self.assertEqual(create.call_count, 1)
            connection.__exit__.assert_called_once()

    def test_connect_rejection_is_explicitly_unsent(self):
        with patch.object(io.socket, "create_connection", side_effect=TimeoutError("connect timeout")):
            with self.assertRaises(TimeoutError) as error:
                io.TcpPrinterTransport("192.0.2.10")(b"^XA^XZ")
        self.assertIs(error.exception.print_data_sent, False)

    def test_invalid_config_fails_before_io(self):
        for config in ({"printer_mode": "bad"}, {"printer_mode": "tcp", "printer_host": ""},
                       {"printer_mode": "windows_raw", "windows_printer": ""},
                       {"printer_mode": "tcp", "printer_host": "x", "printer_port": 0},
                       {"printer_mode": "tcp", "printer_host": "x", "printer_port": True}):
            with self.subTest(config=config), self.assertRaises(io.HardwareError):
                io.make_printer_transport(config)

    def fake_spooler(self, write_count=None):
        api = MagicMock()
        api.OpenPrinterW.return_value = 1
        api.StartDocPrinterW.return_value = 42
        api.StartPagePrinter.return_value = 1
        api.EndPagePrinter.return_value = 1
        api.EndDocPrinter.return_value = 1
        def write(handle, buffer, length, written):
            set_dword(written, length if write_count is None else write_count)
            return 1
        api.WritePrinter.side_effect = write
        return api

    def test_windows_raw_handles_are_closed_and_data_is_raw(self):
        api = self.fake_spooler()
        with patch.object(io, "_spooler", return_value=api):
            io.WindowsRawTransport("Zebra 测试")(b"^XA^XZ")
        info_pointer = api.StartDocPrinterW.call_args.args[2]
        self.assertEqual(ctypes.cast(info_pointer, ctypes.POINTER(io._DocInfo1)).contents.pDatatype, "RAW")
        self.assertEqual(api.WritePrinter.call_args.args[2], 6)
        api.ClosePrinter.assert_called_once()
        api.AbortPrinter.assert_not_called()

    def test_partial_spool_write_aborts_closes_and_never_retries(self):
        api = self.fake_spooler(write_count=2)
        with patch.object(io, "_spooler", return_value=api):
            with self.assertRaises(io.HardwareError) as error:
                io.WindowsRawTransport("Test")(b"^XA^XZ")
        self.assertEqual(error.exception.code, "PARTIAL_WRITE")
        self.assertIsNone(error.exception.print_data_sent)
        api.AbortPrinter.assert_called_once()
        api.ClosePrinter.assert_called_once()
        api.WritePrinter.assert_called_once()
        api.EndDocPrinter.assert_not_called()

    def test_spool_finalize_failure_aborts_and_closes(self):
        api = self.fake_spooler()
        api.EndDocPrinter.return_value = 0
        with patch.object(io, "_spooler", return_value=api):
            with self.assertRaises(io.HardwareError):
                io.WindowsRawTransport("Test")(b"^XA^XZ")
        api.AbortPrinter.assert_called_once()
        api.ClosePrinter.assert_called_once()

    def test_printer_listing_uses_local_cache_level_four_without_opening(self):
        api = MagicMock()
        row = io._PrinterInfo4("Zebra test", None, 0)
        def enumerate_printers(flags, name, level, buffer, size, needed, returned):
            set_dword(needed, ctypes.sizeof(row))
            if buffer is not None:
                ctypes.memmove(buffer, ctypes.byref(row), ctypes.sizeof(row))
                set_dword(returned, 1)
                return 1
            return 0
        api.EnumPrintersW.side_effect = enumerate_printers
        with patch.object(io, "_spooler", return_value=api), patch.object(io.os, "name", "nt"):
            self.assertEqual(io.list_windows_printers(), ["Zebra test"])
        self.assertTrue(all(call.args[:3] == (6, None, 4) for call in api.EnumPrintersW.call_args_list))
        api.OpenPrinterW.assert_not_called()


class SignalTests(unittest.TestCase):
    def test_k50l_factory_keeps_com_selection_and_opens_lazily(self):
        from field_agent.weigh.k50l_signal import K50LSignal
        with patch("field_agent.weigh.k50l_signal.list_k50l_ports") as discover, patch("field_agent.weigh.k50l_signal._serial_module") as serial:
            signal = io.create_signal({"light_mode": "k50l_serial", "light_serial_port": "COM10"})
            self.assertIsInstance(signal, K50LSignal)
            self.assertEqual(signal.port, "COM10")
            self.assertIsNone(signal.device)
            signal.close()
            discover.assert_not_called()
            serial.assert_not_called()

    def test_manual_protocol_color_nibbles_and_bounded_buzzer(self):
        for color, led_bytes in (("off", (0, 0)), ("red", (0x10, 0)),
                                 ("yellow", (1, 0)), ("green", (0, 0x10))):
            for buzzer, code in (("off", 0), ("ok", 0x13), ("ng", 0x14)):
                report = io.build_patlite_report(color, buzzer)
                self.assertEqual(report, bytes((0, 0, 0, code, 0x60, *led_bytes, 0, 0)))
                if buzzer != "off":
                    self.assertEqual(report[3] >> 4, 1)
        with self.assertRaises(io.HardwareError):
            io.build_patlite_report("blue", "on")

    def test_default_signal_is_virtual_and_hardware_construction_is_lazy(self):
        with patch.object(io, "_hid_module") as hid, patch.object(io, "_WindowsHidDevice") as device:
            signal = io.create_signal({})
            signal.set_state("green", "ok")
            self.assertEqual(signal.status, "virtual")
            signal.close()
            self.assertEqual((signal.color, signal.buzzer), ("off", "off"))
            io.create_signal({"light_mode": "patlite_usb"})
            hid.assert_not_called()
            device.assert_not_called()

    def test_discovery_only_enumerates_exact_model_and_serializes_paths(self):
        hid = SimpleNamespace(enumerate=MagicMock(return_value=[{"path": b"hid-path", "serial_number": "123"}]))
        with patch.object(io, "_hid_module", return_value=hid):
            rows = io.list_signal_devices()
        hid.enumerate.assert_called_once_with(0x191A, 0x8003)
        self.assertEqual(rows[0]["path"], b"hid-path".hex())
        self.assertEqual(rows[0]["id"], rows[0]["path"])
        self.assertIn("123", rows[0]["label"])

    def test_signal_selects_exact_device_and_close_sends_off(self):
        path = b"hid-path".hex()
        fake = MagicMock()
        fake.write.return_value = 9
        with patch.object(io, "list_signal_devices", return_value=[{"path": path}]), patch.object(io, "_WindowsHidDevice", return_value=fake) as opened:
            signal = io.PatliteSignal(path)
            signal.set_state("green", "ok")
            opened.assert_called_once_with(b"hid-path")
            self.assertEqual(signal.status, "connected")
            signal.close()
        self.assertEqual(fake.write.call_args_list[-1].args[0], io.build_patlite_report("off", "off"))
        fake.close.assert_called_once()

    def test_multiple_devices_require_selection(self):
        with patch.object(io, "list_signal_devices", return_value=[{"path": "aa"}, {"path": "bb"}]), patch.object(io, "_WindowsHidDevice") as opened:
            with self.assertRaises(io.HardwareError) as error:
                io.PatliteSignal().set_state("yellow")
            self.assertEqual(error.exception.code, "SIGNAL_SELECTION_REQUIRED")
            opened.assert_not_called()

    def test_partial_hid_write_releases_handle_and_disables_retries(self):
        fake = MagicMock()
        fake.write.return_value = 2
        path = b"hid-path".hex()
        with patch.object(io, "list_signal_devices", return_value=[{"path": path}]), patch.object(io, "_WindowsHidDevice", return_value=fake) as opened:
            signal = io.PatliteSignal(path)
            with self.assertRaises(io.HardwareError):
                signal.set_state("red", "ng")
            fake.close.assert_called_once()
            with self.assertRaises(io.HardwareError) as error:
                signal.set_state("yellow")
            self.assertEqual(error.exception.code, "SIGNAL_CLOSED")
            opened.assert_called_once()

    def test_windows_hid_opens_bidirectional_with_no_sharing(self):
        api = MagicMock()
        api.CreateFileW.return_value = 123
        def write(handle, buffer, length, written, overlap):
            set_dword(written, length)
            return 1
        api.WriteFile.side_effect = write
        with patch.object(io, "_windows_dll", return_value=api):
            device = io._WindowsHidDevice(b"test-path")
            self.assertEqual(device.write(io.build_patlite_report("yellow")), 9)
            device.close()
            device.close()
        self.assertEqual(api.CreateFileW.call_args.args[1:3], (0xC0000000, 0))
        api.CloseHandle.assert_called_once_with(123)


if __name__ == "__main__":
    unittest.main()
