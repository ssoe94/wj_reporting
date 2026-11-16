import unittest

from field_agent.weigh.scale_protocol import FrameDecoder, parse_frame


class ParseFrameTests(unittest.TestCase):
    def test_observed_stable_grams_frame(self):
        reading = parse_frame(b"ST,TR,+   0.06 g\r\n")
        self.assertIsNotNone(reading)
        self.assertEqual(
            (reading.value, reading.unit, reading.grams, reading.status, reading.mode),
            ("0.06", "g", "0.06", "ST", "TR"),
        )
        self.assertEqual(reading.raw, "ST,TR,+   0.06 g")

    def test_observed_unstable_grams_frame(self):
        reading = parse_frame(b"US,TR,+   0.03 g")
        self.assertEqual((reading.value, reading.status, reading.mode), ("0.03", "US", "TR"))

    def test_negative_grams_keep_sign_and_precision(self):
        reading = parse_frame(b"ST,TR,-   12.30 g")
        self.assertEqual((reading.value, reading.grams), ("-12.30", "-12.30"))

    def test_kilograms_convert_to_grams_exactly(self):
        for frame, value, grams in (
            (b"ST,TR,+   1.234 kg", "1.234", "1234.000"),
            (b"US,NT,-   0.001 kg", "-0.001", "-1.000"),
        ):
            with self.subTest(frame=frame):
                reading = parse_frame(frame)
                self.assertEqual((reading.value, reading.unit, reading.grams), (value, "kg", grams))

    def test_malformed_frames_are_rejected(self):
        for frame in (
            b"", b"\r\n", b"ST,TR,+   0.06", b"ST,TR,+   0.06 lb",
            b"ST,TR,   0.06 g", b"ST,TR,+   NaN g", b"ST,TR,+   1e3 g",
            b"OL,TR,+   0.06 g", b"ST,T,+   0.06 g", b"ST,TR,+   0.06.1 g",
            b"noiseST,TR,+   0.06 g", b"ST,TR,+   0.06 gnoise",
        ):
            with self.subTest(frame=frame):
                self.assertIsNone(parse_frame(frame))

    def test_non_ascii_frame_is_rejected(self):
        self.assertIsNone(parse_frame(b"ST,TR,+   0.06 g\xff"))


class FrameDecoderTests(unittest.TestCase):
    def test_fragmented_frame_waits_for_newline(self):
        decoder = FrameDecoder()
        for chunk in (b"ST,", b"TR,+   ", b"0.", b"06 g", b"\r"):
            self.assertEqual(decoder.feed(chunk), [])
        readings = decoder.feed(b"\n")
        self.assertEqual(len(readings), 1)
        self.assertEqual(readings[0].value, "0.06")

    def test_coalesced_frames_keep_order_and_trailing_fragment(self):
        decoder = FrameDecoder()
        readings = decoder.feed(b"ST,TR,+   0.06 g\r\nUS,TR,+   0.03 g\r\nST,TR,-")
        self.assertEqual([reading.value for reading in readings], ["0.06", "0.03"])
        readings = decoder.feed(b"   2.00 g\r\n")
        self.assertEqual([reading.value for reading in readings], ["-2.00"])

    def test_invalid_frame_does_not_hide_next_valid_frame(self):
        decoder = FrameDecoder()
        readings = decoder.feed(b"\xffbroken\r\nST,TR,+   0.06 g\r\n")
        self.assertEqual(len(readings), 2)
        self.assertIsNone(readings[0])
        self.assertEqual(readings[1].grams, "0.06")

    def test_oversized_frame_discards_valid_looking_suffix_until_newline(self):
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(b"x" * 257), [])
        self.assertEqual(decoder.feed(b"ST,TR,+   0.06 g"), [])
        readings = decoder.feed(b"\r\nST,TR,+   0.03 g\r\n")
        self.assertEqual(len(readings), 2)
        self.assertIsNone(readings[0])
        self.assertEqual(readings[1].value, "0.03")

    def test_empty_feed_preserves_partial_frame(self):
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(b"ST,TR,+"), [])
        self.assertEqual(decoder.feed(b""), [])
        self.assertEqual(decoder.feed(b"   0.06 g\n")[0].value, "0.06")


if __name__ == "__main__":
    unittest.main()
