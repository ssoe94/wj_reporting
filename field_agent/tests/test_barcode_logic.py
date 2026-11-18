import unittest

from field_agent.barcode_logic import BarcodeRules, FieldPartError, build_field_parts


CONFIG = {
    "prefixes": ["TST"],
    "length": 21,
    "parity_index": 10,
    "allowed_sizes": ["55", "65", "75"],
    "size_groups": {"50/55": ["55"], "60/65": ["65"], "70/75/86": ["75"]},
    "site_vendor_codes": ["SYN"],
    "serial_length": 4,
    "any_scanner_parts": ["TST30000032"],
    "part_rules": [
        {"part_no": "TST10000011", "size": "55", "group": "50/55", "scanner": "A"},
        {"part_no": "TST10000012", "size": "55", "group": "50/55", "scanner": "B"},
        {"part_no": "TST20000021", "size": "65", "group": "60/65", "scanner": "A"},
        {"part_no": "TST30000032", "size": "75", "group": "70/75/86", "scanner": "ANY"},
        {"part_no": "TST30000033", "size": "75", "group": "70/75/86", "scanner": ""},
    ],
}


class BarcodeRulesTests(unittest.TestCase):
    def setUp(self):
        self.rules = BarcodeRules(CONFIG)
        self.a55 = "TST10000011SYNXYZ00DE"
        self.b55 = "TST10000012SYNXYZ007U"

    def test_valid_registered_parts_and_scanners(self):
        self.assertTrue(self.rules.is_valid_barcode(self.a55))
        self.assertEqual("A", self.rules.get_expected_scanner(self.a55))
        self.assertEqual("B", self.rules.get_expected_scanner(self.b55))

    def test_ok_and_wrong_scanner(self):
        ok = self.rules.evaluate("A", self.a55, "50/55")
        wrong = self.rules.evaluate("B", self.a55, "50/55")
        self.assertTrue(ok.success)
        self.assertEqual("ok", ok.status)
        self.assertEqual("wrong_scanner_A", wrong.status)

    def test_product_group_mismatch(self):
        result = self.rules.evaluate("A", self.a55, "60/65")
        self.assertEqual("wrong_product_group", result.status)
        self.assertEqual("50/55", result.product_group)

    def test_duplicate_rules_preserve_existing_behavior(self):
        same = self.rules.evaluate("A", self.a55, "50/55", last_ok_scanner="A")
        other = self.rules.evaluate("B", self.a55, "50/55", last_ok_scanner="A")
        self.assertEqual("duplicate", same.status)
        self.assertEqual("wrong_scanner_A", other.status)

    def test_invalid_length_vendor_serial_and_part(self):
        values = [
            self.a55[:-1],
            self.a55.replace("SYN", "BAD"),
            self.a55[:-1] + "I",
            "TST99999999SYNXYZ00DE",
        ]
        for value in values:
            with self.subTest(value=value):
                self.assertEqual("invalid", self.rules.evaluate("A", value, "50/55").status)

    def test_overlength_is_distinct(self):
        self.assertEqual("over21", self.rules.evaluate("A", self.a55 + "X", "50/55").status)

    def test_any_scanner_part_accepts_a_and_b_in_one_duplicate_silo(self):
        barcode = "TST30000032SYNXYZ00DE"
        self.assertTrue(self.rules.is_valid_barcode(barcode))
        self.assertEqual("ANY", self.rules.get_expected_scanner(barcode))
        self.assertTrue(self.rules.evaluate("A", barcode, "70/75/86").success)
        self.assertTrue(self.rules.evaluate("B", barcode, "70/75/86").success)
        self.assertEqual(
            "duplicate",
            self.rules.evaluate("A", barcode, "70/75/86", last_ok_scanner="A").status,
        )
        self.assertEqual(
            "duplicate",
            self.rules.evaluate("B", barcode, "70/75/86", last_ok_scanner="A").status,
        )

    def test_unassigned_non_any_part_still_uses_parity(self):
        barcode = "TST30000033SYNXYZ00DE"
        self.assertEqual("A", self.rules.get_expected_scanner(barcode))

    def test_build_field_parts_from_last_four_digits(self):
        parts = build_field_parts("TST2000", "0701", "0702")
        self.assertEqual({"A": "TST20000701", "B": "TST20000702"}, parts)
        self.assertEqual({"A": "TST20000701"}, build_field_parts("tst2000", " 0701 ", ""))

    def test_build_field_parts_keeps_a_odd_b_even(self):
        cases = [
            (("TST2000", "0702", ""), "parity_mismatch", "A"),
            (("TST2000", "", "0701"), "parity_mismatch", "B"),
            (("TST2000", "701", ""), "suffix_invalid", "A"),
            (("TST2000", "07O1", ""), "suffix_invalid", "A"),
            (("TST2000", "", ""), "suffix_required", ""),
            (("", "0701", ""), "prefix_invalid", ""),
        ]
        for args, code, scanner in cases:
            with self.subTest(args=args):
                with self.assertRaises(FieldPartError) as ctx:
                    build_field_parts(*args)
                self.assertEqual(code, ctx.exception.code)
                self.assertEqual(scanner, ctx.exception.scanner)

    def test_field_parts_become_valid_targets(self):
        config = dict(CONFIG, field_parts={"60/65": {"A": "TST20000701", "B": "TST20000702"}})
        rules = BarcodeRules(config)
        a65 = "TST20000701SYNXYZ00DE"
        b65 = "TST20000702SYNXYZ007U"
        # Unregistered before field setup, valid after.
        self.assertEqual("invalid", self.rules.evaluate("A", a65, "60/65").status)
        self.assertTrue(rules.evaluate("A", a65, "60/65").success)
        self.assertTrue(rules.evaluate("B", b65, "60/65").success)
        self.assertEqual("65", rules.get_product_size(a65))
        self.assertEqual("wrong_scanner_A", rules.evaluate("B", a65, "60/65").status)
        self.assertEqual("wrong_scanner_B", rules.evaluate("A", b65, "60/65").status)
        self.assertEqual("wrong_product_group", rules.evaluate("A", a65, "50/55").status)
        # Registered parts keep working alongside field-set parts.
        self.assertTrue(rules.evaluate("A", self.a55, "50/55").success)
        # Other last-four values of the same model stay invalid.
        self.assertEqual("invalid", rules.evaluate("A", "TST20000703SYNXYZ00DE", "60/65").status)

    def test_field_parts_for_unknown_group_are_ignored(self):
        rules = BarcodeRules(dict(CONFIG, field_parts={"99": {"A": "TST20000701"}}))
        self.assertFalse(rules.is_valid_barcode("TST20000701SYNXYZ00DE"))


if __name__ == "__main__":
    unittest.main()
