import unittest
from unittest.mock import Mock

from field_agent.weigh.devices import FakePrinter, FakeScale, FakeScanner, SerialScale
from field_agent.weigh.hardware_io import HardwareError
from field_agent.weigh.scale_protocol import FrameDecoder


class DevicesTests(unittest.TestCase):
    def test_scale_setup_stays_read_only_and_disconnect_releases_handle(self):
        first = Mock(in_waiting=0)
        first.read.side_effect = OSError("port disappeared")
        next_device = Mock(in_waiting=31)
        next_device.read.return_value = b"ST,GS,+ 0.10 kg\r\n"
        opened_levels = []
        next_device.open.side_effect = lambda: opened_levels.append(
            (next_device.port, next_device.dtr, next_device.rts)
        )
        factory = Mock(side_effect=[first, next_device])
        adapter = SerialScale("COM42", serial_factory=factory)
        factory.assert_not_called()
        with self.assertRaises(OSError):
            adapter.read()
        first.close.assert_called_once()
        self.assertFalse(adapter.connected)
        reading, = FrameDecoder().feed(adapter.read())
        self.assertTrue(adapter.connected)
        self.assertEqual(reading.grams, "100.00")
        self.assertEqual(opened_levels, [("COM42", False, False)])
        options = factory.call_args.kwargs
        self.assertEqual((options["xonxoff"], options["rtscts"], options["dsrdtr"]), (False, False, False))

    def test_scripts_and_scans_feed_complete_events_without_hardware(self):
        scale = FakeScale()
        scale.play_script(((0, b"US,GS,+"), (0, b"100 g\n")))
        scale.add_weight("-2.0", mode="NT")
        first, second = FrameDecoder().feed(scale.read())
        self.assertEqual((first.status, first.grams, second.mode, second.grams), ("US", "100", "NT", "-2.0"))
        scanner = FakeScanner()
        scanner.start()
        self.assertTrue(scanner.snapshots()["W"]["port_open"])
        self.assertIsNone(scanner.snapshots()["W"]["last_scan_at"])
        scanner.feed("W", "SYNTH-REREAD")
        event, = scanner.drain_events()
        self.assertEqual((event["lane"], event["barcode"]), ("W", "SYNTH-REREAD"))
        self.assertEqual(scanner.snapshots()["W"]["last_scan_at"], event["received_at"])

    def test_fake_transport_distinguishes_rejection_partial_and_peel_hold(self):
        printer = FakePrinter(peel=True)
        data = b"^XA^XZ"
        printer.inject("rejected_unsent")
        with self.assertRaises(HardwareError) as rejected:
            printer(data)
        self.assertIs(rejected.exception.print_data_sent, False)
        self.assertEqual(printer.sent, [])
        printer.inject("uncertain")
        with self.assertRaises(TimeoutError) as partial:
            printer(data)
        self.assertIsNone(partial.exception.print_data_sent)
        self.assertEqual(printer.sent, [data[:3]])
        printer(data)
        self.assertTrue(printer.queue_status()["label_waiting"])
        with self.assertRaises(HardwareError):
            printer(data)
        printer.set_label_waiting(False)
        self.assertTrue(printer.queue_status()["ready"])
        self.assertEqual(printer.sent, [data[:3], data])
