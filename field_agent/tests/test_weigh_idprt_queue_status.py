import unittest
from unittest.mock import patch

from field_agent.weigh import hardware_io as io
from field_agent.tests.test_weigh_idprt_usb_transport import FakeDevice, zpl_status


def tspl_status(message=b"@", warning=b"@", error=b"@", media=b"@"):
    return b"\x02" + message + warning + error + media + b"\x03\r\n"


class TsplExtendedStatusTests(unittest.TestCase):
    def test_normal_has_no_physical_count_claim(self):
        status = io._parse_tspl_extended_status(tspl_status())
        self.assertTrue(status["ready"])
        self.assertFalse(status["busy"])
        self.assertFalse(status["label_waiting"])
        self.assertFalse(status["physical_count_known"])
        self.assertNotIn("labels_remaining", status)

    def test_peeler_printing_and_transient_activity_block_dispatch(self):
        for message in (b"L", b"P", b"W", b"B", b"C", b"F"):
            with self.subTest(message=message):
                status = io._parse_tspl_extended_status(tspl_status(message))
                self.assertFalse(status["ready"])
                self.assertTrue(status["busy"])
                self.assertTrue(status["activity"])
                self.assertEqual(status["label_waiting"], message == b"L")

    def test_pause_key_wait_and_error_cannot_count_as_printing_activity(self):
        for message in (b"`", b"K", b"E"):
            with self.subTest(message=message):
                status = io._parse_tspl_extended_status(tspl_status(message))
                self.assertFalse(status["ready"])
                self.assertFalse(status["activity"])

    def test_combined_media_faults_are_decoded_and_block_even_normal_message(self):
        status = io._parse_tspl_extended_status(tspl_status(media=b"e"))
        self.assertEqual(status["errors"], ["paper_out", "ribbon_out", "head_open"])
        self.assertFalse(status["ready"])
        status = io._parse_tspl_extended_status(tspl_status(error=b"Q"))
        self.assertEqual(status["errors"], ["head_over_temperature", "insufficient_memory"])
        self.assertFalse(status["ready"])

    def test_buffer_full_and_bad_dots_block_but_low_consumables_are_warnings(self):
        for warning in (b"H", b"`", b"k"):
            with self.subTest(warning=warning):
                self.assertFalse(io._parse_tspl_extended_status(tspl_status(warning=warning))["ready"])
        low = io._parse_tspl_extended_status(tspl_status(warning=b"C"))
        self.assertTrue(low["ready"])
        self.assertEqual(low["warnings"], ["paper_low", "ribbon_low"])

    def test_rejects_short_extra_unframed_unknown_and_reserved_status(self):
        for raw in (None, "@@@@", b"\x00", b"@@@@", tspl_status()[:-1],
                    tspl_status() + b"\x00", tspl_status() * 2, b"junk" + tspl_status(),
                    tspl_status(b"A"), tspl_status(warning=b"D"),
                    tspl_status(error=b"`"), tspl_status(media=b"P"),
                    tspl_status(warning=b"\x00"), tspl_status(media=b"\xc0")):
            with self.subTest(raw=raw), self.assertRaises(io.HardwareError) as error:
                io._parse_tspl_extended_status(raw)
            self.assertEqual(error.exception.code, "INVALID_STATUS")


class QueueStatusTransportTests(unittest.TestCase):
    def query(self, device, active="TSPL", expected="auto"):
        with patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": active}]), \
                patch.object(io, "_WindowsUsbPrinterDevice", return_value=device):
            return io.IdprtUsbTransport(timeout=.002, command_language="auto").queue_status(expected)

    def test_extended_query_handles_fragmented_reply_and_sends_no_print_bytes(self):
        frame = tspl_status(b"L")
        device = FakeDevice(reads=[b"", frame[:2], frame[2:6], frame[6:]])
        status = self.query(device)
        self.assertEqual(device.writes, [b"\x1b!S"])
        self.assertTrue(device.closed)
        self.assertTrue(status["label_waiting"])
        self.assertFalse(status["ready"])
        self.assertEqual(status["command_language"], "tspl")

    def test_zpl_status_preserves_remaining_and_wait_information(self):
        device = FakeDevice(reads=[b"", zpl_status(first={4: 2}, second={7: 1, 8: 4})])
        status = self.query(device, active="ZPL-II")
        self.assertEqual(device.writes, [b"~HS\r\n"])
        self.assertEqual(status["formats_in_buffer"], 2)
        self.assertEqual(status["labels_remaining"], 4)
        self.assertTrue(status["label_waiting"])
        self.assertFalse(status["physical_count_known"])
        self.assertFalse(status["ready"])

    def test_status_timeout_cannot_fall_back_to_basic_ready_or_send_payload(self):
        for response in (b"", b"\x00", tspl_status()[:5]):
            with self.subTest(response=response):
                device = FakeDevice(reads=[b"", response])
                with self.assertRaises(io.HardwareError) as error:
                    self.query(device)
                self.assertEqual(error.exception.code, "STATUS_TIMEOUT")
                self.assertIs(error.exception.print_data_sent, False)
                self.assertEqual(device.writes, [b"\x1b!S"])
                self.assertTrue(device.closed)

    def test_bad_extended_response_fails_closed(self):
        device = FakeDevice(reads=[b"", tspl_status() + b"garbage"])
        with self.assertRaises(io.HardwareError) as error:
            self.query(device)
        self.assertEqual(error.exception.code, "INVALID_STATUS")
        self.assertIs(error.exception.print_data_sent, False)

    def test_language_mismatch_fails_before_open(self):
        for active, expected in (("TSPL", "zpl"), ("", "auto"), ("EPL", "auto"), ("ZPL", "arbitrary")):
            with self.subTest(active=active, expected=expected), \
                    patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": active}]), \
                    patch.object(io, "_WindowsUsbPrinterDevice") as opened, \
                    self.assertRaises(io.HardwareError) as error:
                io.IdprtUsbTransport(command_language="auto").queue_status(expected)
            opened.assert_not_called()
            self.assertIs(error.exception.print_data_sent, False)

    def test_open_failure_is_proven_to_have_sent_no_print_data(self):
        failure = io.HardwareError("USB_ERROR", "open failed")
        with patch.object(io, "list_idprt_usb_printers", return_value=[{"path": "if4", "command": "TSPL"}]), \
                patch.object(io, "_WindowsUsbPrinterDevice", side_effect=failure), \
                self.assertRaises(io.HardwareError) as error:
            io.IdprtUsbTransport().queue_status()
        self.assertIs(error.exception, failure)
        self.assertIs(error.exception.print_data_sent, False)


if __name__ == "__main__":
    unittest.main()
