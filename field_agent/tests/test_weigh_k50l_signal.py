from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import sys

from field_agent.weigh import k50l_signal as k50l
from field_agent.weigh.hardware_io import HardwareError


def candidate(port="COM8"):
    return {"id": port, "path": port, "port": port, "label": port}


class K50LProtocolTests(unittest.TestCase):
    def test_exact_manufacturer_command_table_including_crc(self):
        examples = {
            (0, False): "01 05 00 00 00 00 CD CA",
            (1, True): "01 05 00 01 FF 00 DD FA",
            (1, False): "01 05 00 01 00 00 9C 0A",
            (2, True): "01 05 00 02 FF 00 2D FA",
            (2, False): "01 05 00 02 00 00 6C 0A",
            (3, True): "01 05 00 03 FF 00 7C 3A",
            (3, False): "01 05 00 03 00 00 3D CA",
            (4, True): "01 05 00 04 FF 00 CD FB",
            (4, False): "01 05 00 04 00 00 8C 0B",
        }
        for args, expected in examples.items():
            with self.subTest(args=args):
                self.assertEqual(k50l.build_k50l_command(*args), bytes.fromhex(expected))

    def test_undocumented_or_malformed_commands_are_rejected(self):
        for args in ((0, True), (5, True), (-1, False), (True, True), (1, 1), ("1", True)):
            with self.subTest(args=args), self.assertRaises(HardwareError):
                k50l.build_k50l_command(*args)

    def test_discovery_excludes_scale_and_does_not_open_ports(self):
        serial = ModuleType("serial")
        serial.Serial = MagicMock()
        serial.tools = ModuleType("serial.tools")
        list_ports = SimpleNamespace(comports=MagicMock())
        serial.tools.list_ports = list_ports
        ports = [
            SimpleNamespace(vid=0x067B, pid=0x2303, device="COM9", serial_number=None, description="scale"),
            SimpleNamespace(vid=0x1A86, pid=0x7523, device="COM8", serial_number="K123", description="USB Serial"),
            SimpleNamespace(vid=None, pid=None, device="COM1", serial_number=None, description="Serial"),
        ]
        with patch.dict(sys.modules, {"serial": serial, "serial.tools": serial.tools}), \
                patch.object(list_ports, "comports", return_value=ports), patch.object(serial, "Serial") as opened:
            rows = k50l.list_k50l_ports()
        self.assertEqual([row["port"] for row in rows], ["COM8"])
        self.assertIn("K123", rows[0]["label"])
        self.assertIn("candidate", rows[0]["label"])
        opened.assert_not_called()


class K50LAdapterTests(unittest.TestCase):
    def setUp(self):
        self.device = MagicMock()
        self.device.write.side_effect = lambda command: len(command)
        self.device.read.side_effect = lambda size: self.device.write.call_args.args[0][:size]
        self.serial = SimpleNamespace(
            Serial=MagicMock(return_value=self.device), EIGHTBITS=8, PARITY_EVEN="E", STOPBITS_ONE=1,
        )
        self.serial_patch = patch.object(k50l, "_serial_module", return_value=self.serial)
        self.discovery_patch = patch.object(k50l, "list_k50l_ports", return_value=[candidate()])
        self.sleep_patch = patch.object(k50l.time, "sleep")
        self.serial_patch.start()
        self.discovery = self.discovery_patch.start()
        self.sleep = self.sleep_patch.start()
        self.addCleanup(self.serial_patch.stop)
        self.addCleanup(self.discovery_patch.stop)
        self.addCleanup(self.sleep_patch.stop)

    def commands(self):
        return [call.args[0] for call in self.device.write.call_args_list]

    def test_construction_and_unused_close_have_no_io(self):
        signal = k50l.K50LSignal("COM8")
        signal.close()
        self.discovery.assert_not_called()
        self.serial.Serial.assert_not_called()
        self.device.write.assert_not_called()

    def test_exact_serial_settings_and_single_color_after_all_off(self):
        signal = k50l.K50LSignal()
        signal.set_state("red")
        signal.set_state("green")
        self.serial.Serial.assert_called_once_with(
            port="COM8", baudrate=9600, bytesize=8, parity="E", stopbits=1,
            timeout=0.05, write_timeout=0.25, xonxoff=False, rtscts=False, dsrdtr=False,
        )
        self.assertEqual(self.commands(), [k50l.ALL_OFF, k50l.build_k50l_command(1, True),
                                          k50l.ALL_OFF, k50l.build_k50l_command(3, True)])
        self.assertEqual(signal.status, "submitted")
        self.device.flush.assert_not_called()
        self.assertEqual(self.device.reset_input_buffer.call_count, 4)
        self.assertEqual(self.device.read.call_count, 4)
        self.sleep.assert_any_call(k50l.COMMAND_GAP_SECONDS)

    def test_no_port_multiple_ports_and_explicit_scale_port_fail_before_open(self):
        scenarios = [([], None, "SIGNAL_NOT_FOUND"),
                     ([candidate(), candidate("COM10")], None, "SIGNAL_SELECTION_REQUIRED"),
                     ([candidate()], "COM9", "SIGNAL_NOT_FOUND")]
        for rows, port, expected in scenarios:
            with self.subTest(rows=rows, port=port):
                self.discovery.return_value = rows
                with self.assertRaises(HardwareError) as error:
                    k50l.K50LSignal(port).set_state("yellow")
                self.assertEqual(error.exception.code, expected)
        self.serial.Serial.assert_not_called()

    def test_explicit_selection_among_multiple_candidates(self):
        self.discovery.return_value = [candidate(), candidate("COM10")]
        k50l.K50LSignal("com10").set_state("yellow")
        self.assertEqual(self.serial.Serial.call_args.kwargs["port"], "COM10")

    def test_present_port_open_failure_is_distinct_from_missing_device_and_sends_nothing(self):
        self.serial.Serial.side_effect = PermissionError("Access denied")
        signal = k50l.K50LSignal("COM8")
        with self.assertRaises(HardwareError) as error:
            signal.set_state("yellow")
        self.assertEqual(error.exception.code, "SIGNAL_OPEN_FAILED")
        self.assertEqual(error.exception.details["port"], "COM8")
        self.assertEqual(error.exception.details["exception_type"], "PermissionError")
        self.assertIn("Access denied", error.exception.details["reason"])
        self.assertEqual(signal.status, "error")
        self.assertIsNone(signal.device)
        self.device.write.assert_not_called()

    def test_fragmented_echo_is_accumulated_until_exact_command(self):
        self.device.read.side_effect = [k50l.ALL_OFF[:2], b"", k50l.ALL_OFF[2:]]
        signal = k50l.K50LSignal()
        signal.set_state("off")
        self.assertEqual(signal.status, "submitted")
        self.assertEqual([call.args[0] for call in self.device.read.call_args_list], [8, 6, 6])
        self.assertEqual(self.commands(), [k50l.ALL_OFF])

    def test_bad_echo_reports_error_and_sends_only_all_off_cleanup(self):
        self.device.read.side_effect = [b"12345678", k50l.ALL_OFF]
        signal = k50l.K50LSignal()
        with self.assertRaises(HardwareError) as error:
            signal.set_state("red")
        self.assertEqual(error.exception.code, "SIGNAL_INVALID_ECHO")
        self.assertEqual(self.commands(), [k50l.ALL_OFF, k50l.ALL_OFF])
        self.assertEqual(signal.status, "error")
        self.device.close.assert_called_once()

    def test_echo_deadline_is_bounded_and_timeout_is_not_retried(self):
        ticks = iter((0.0, 0.1, 0.5, 0.6, 0.7))
        self.device.read.side_effect = [b"", k50l.ALL_OFF]
        signal = k50l.K50LSignal()
        with patch.object(k50l.time, "monotonic", side_effect=lambda: next(ticks)):
            with self.assertRaises(HardwareError) as error:
                signal.set_state("green", "ok")
        self.assertEqual(error.exception.code, "SIGNAL_ECHO_TIMEOUT")
        self.assertEqual(self.commands(), [k50l.ALL_OFF, k50l.ALL_OFF])
        self.device.close.assert_called_once()

    def test_ok_and_ng_have_finite_pulses_and_end_in_buzzer_off(self):
        for pattern, count, duration in (("ok", 1, 0.14), ("ng", 3, 0.18)):
            with self.subTest(pattern=pattern):
                self.device.write.reset_mock()
                self.sleep.reset_mock()
                k50l.K50LSignal().set_state("green", pattern)
                commands = self.commands()
                self.assertEqual(commands.count(k50l.BUZZER_ON), count)
                self.assertEqual(commands.count(k50l.BUZZER_OFF), count)
                self.assertEqual(commands[-1], k50l.BUZZER_OFF)
                self.assertEqual(sum(call.args == (duration,) for call in self.sleep.call_args_list), count)
                self.assertLessEqual(sum(call.args[0] for call in self.sleep.call_args_list), 0.9)

    def test_partial_write_cleans_up_closes_without_inline_retry(self):
        self.device.write.side_effect = [8, 3, 8]
        signal = k50l.K50LSignal()
        with self.assertRaises(HardwareError) as error:
            signal.set_state("red", "ng")
        self.assertEqual(error.exception.code, "SIGNAL_PARTIAL_WRITE")
        self.assertEqual(self.commands(), [k50l.ALL_OFF, k50l.build_k50l_command(1, True), k50l.ALL_OFF])
        self.assertEqual(signal.status, "error")
        self.device.close.assert_called_once()
        self.serial.Serial.assert_called_once()
        signal.close()
        self.assertEqual(signal.status, "error")
        with self.assertRaises(HardwareError) as error:
            signal.set_state("yellow")
        self.assertEqual(error.exception.code, "SIGNAL_CLOSED")
        self.serial.Serial.assert_called_once()

    def test_transient_failure_reopens_handle_and_restores_color_after_ack(self):
        self.device.write.side_effect = OSError("USB disconnected")
        signal = k50l.K50LSignal("COM8")
        with self.assertRaisesRegex(OSError, "USB disconnected"):
            signal.set_state("red", "ng")
        self.assertEqual(signal.status, "error")
        self.assertIsNone(signal.device)

        recovered = MagicMock()
        recovered.write.side_effect = lambda command: len(command)
        recovered.read.side_effect = lambda size: recovered.write.call_args.args[0][:size]
        self.serial.Serial.return_value = recovered
        signal.set_state("red", "off")
        self.assertEqual(signal.status, "submitted")
        self.assertEqual(self.serial.Serial.call_count, 2)
        self.assertEqual([call.args[0] for call in recovered.write.call_args_list],
                         [k50l.ALL_OFF, k50l.build_k50l_command(1, True)])
        self.assertEqual(recovered.read.call_count, 2)

    def test_reopen_without_valid_echo_does_not_report_recovered(self):
        signal = k50l.K50LSignal("COM8")
        self.device.read.side_effect = lambda size: b"12345678"
        for _ in range(2):
            with self.assertRaises(HardwareError):
                signal.set_state("yellow")
            self.assertEqual(signal.status, "error")
            self.assertIsNone(signal.device)
        self.assertEqual(self.serial.Serial.call_count, 2)

    def test_reconnect_tracks_unique_bridge_after_com_port_changes(self):
        signal = k50l.K50LSignal("COM8")
        self.device.write.side_effect = OSError("replugged")
        with self.assertRaises(OSError):
            signal.set_state("yellow")
        self.discovery.return_value = [candidate("COM10")]
        self.device.write.side_effect = lambda command: len(command)
        signal.set_state("yellow")
        self.assertEqual(signal.port, "COM10")
        self.assertEqual(self.serial.Serial.call_args.kwargs["port"], "COM10")

    def test_reconnect_does_not_guess_among_different_bridges(self):
        signal = k50l.K50LSignal("COM8")
        self.device.write.side_effect = OSError("replugged")
        with self.assertRaises(OSError):
            signal.set_state("yellow")
        self.discovery.return_value = [candidate("COM10"), candidate("COM11")]
        with self.assertRaises(HardwareError) as error:
            signal.set_state("yellow")
        self.assertEqual(error.exception.code, "SIGNAL_NOT_FOUND")
        self.serial.Serial.assert_called_once()

    def test_buzzer_write_timeout_attempts_buzzer_off_then_all_off(self):
        timeout = TimeoutError("write timed out")
        self.device.write.side_effect = [8, 8, timeout, 8, 8]
        signal = k50l.K50LSignal()
        with self.assertRaises(TimeoutError) as error:
            signal.set_state("red", "ng")
        self.assertIs(error.exception, timeout)
        self.assertEqual(self.commands()[-3:], [k50l.BUZZER_ON, k50l.BUZZER_OFF, k50l.ALL_OFF])
        self.assertEqual(self.commands().count(k50l.BUZZER_ON), 1)
        self.device.close.assert_called_once()

    def test_interrupted_buzzer_attempts_off_even_if_cleanup_also_fails(self):
        def sleep(duration):
            if duration == 0.14:
                raise RuntimeError("interrupted pulse")
        self.sleep.side_effect = sleep
        self.device.write.side_effect = [8, 8, 8, OSError("disconnected"), OSError("disconnected")]
        signal = k50l.K50LSignal()
        with self.assertRaisesRegex(RuntimeError, "interrupted pulse"):
            signal.set_state("green", "ok")
        self.assertEqual(self.commands()[-2:], [k50l.BUZZER_OFF, k50l.ALL_OFF])
        self.device.close.assert_called_once()
        self.assertEqual(signal.status, "error")

    def test_close_sends_all_off_and_releases_handle_once(self):
        signal = k50l.K50LSignal()
        signal.set_state("yellow")
        signal.close()
        signal.close()
        self.assertEqual(self.commands()[-1], k50l.ALL_OFF)
        self.device.close.assert_called_once()
        self.assertEqual(signal.status, "closed")

    def test_close_releases_handle_when_all_off_fails(self):
        signal = k50l.K50LSignal()
        signal.set_state("yellow")
        self.device.write.side_effect = TimeoutError("unplugged")
        with self.assertRaises(TimeoutError):
            signal.close()
        self.device.close.assert_called_once()
        self.assertIsNone(signal.device)
        self.assertEqual(signal.status, "error")

    def test_invalid_state_does_not_open_or_poison_adapter(self):
        signal = k50l.K50LSignal()
        with self.assertRaises(HardwareError):
            signal.set_state("blue", "continuous")
        self.serial.Serial.assert_not_called()
        signal.set_state("off")
        self.assertEqual(self.commands(), [k50l.ALL_OFF])


if __name__ == "__main__":
    unittest.main()
