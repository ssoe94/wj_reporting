import json
from pathlib import Path
import tempfile
import unittest
from decimal import Decimal
from unittest.mock import patch

from field_agent.weigh.profiles import ProfileStore, ProfileStoreError
from field_agent.weigh.rules import CalibrationSession, CycleGate, WeightProfile, evaluate_weight


def make_profile(size="MODEL-A", part_no="PART-A", unit="100"):
    unit = Decimal(unit)
    session = CalibrationSession(size, part_no, "0")
    for quantity in range(1, 6):
        session.record(quantity, unit * quantity)
    return session.finish()


class CalibrationTests(unittest.TestCase):
    def test_five_cumulative_readings_subtract_tare_and_fit_through_origin(self):
        session = CalibrationSession("MODEL-A", "PART-A", "12.5")
        net_weights = [Decimal(value) for value in ("100.1", "199.9", "300.2", "400", "500.1")]
        for quantity, net in enumerate(net_weights, 1):
            self.assertEqual(session.next_quantity, quantity)
            self.assertEqual(session.record(quantity, net + Decimal("12.5")), net)
        self.assertIsNone(session.next_quantity)
        profile = session.finish()
        self.assertEqual(profile.calibration_g, tuple(net_weights))
        self.assertEqual(profile.unit_weight_g, sum(n * w for n, w in enumerate(net_weights, 1)) / 55)

    def test_missing_or_out_of_order_steps_fail(self):
        session = CalibrationSession("A", "P", "0")
        with self.assertRaises(ValueError):
            session.record(2, "200")
        with self.assertRaises(ValueError):
            session.record(True, "100")
        session.record(1, "100")
        with self.assertRaises(ValueError):
            session.finish()
        with self.assertRaises(ValueError):
            session.record(1, "100")
        self.assertEqual(session.next_quantity, 2)

    def test_invalid_readings_do_not_advance_calibration(self):
        session = CalibrationSession("A", "P", "5")
        for value in ("NaN", "sNaN", "Infinity", "-Infinity", "oops", "5", "-10", "6"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                session.record(1, value)
            self.assertEqual(session.next_quantity, 1)
        session.record(1, "105")
        with self.assertRaises(ValueError):
            session.record(2, "104")
        self.assertEqual(session.next_quantity, 2)

    def test_wrong_count_in_calibration_fails_final_validation(self):
        session = CalibrationSession("A", "P", "0")
        for quantity, value in enumerate((100, 200, 300, 400, 600), 1):
            session.record(quantity, value)
        with self.assertRaisesRegex(ValueError, "5%"):
            session.finish()

    def test_calibration_exact_five_percent_is_rejected(self):
        session = CalibrationSession("A", "P", "0")
        # These totals fit exactly 100 g per product, with step 1 at -5%.
        for quantity, value in enumerate(("95", "202.5", "300", "400", "500"), 1):
            session.record(quantity, value)
        with self.assertRaisesRegex(ValueError, "5.00%"):
            session.finish()

    def test_calibration_retains_total_weight_limit_for_existing_profiles(self):
        session = CalibrationSession("A", "P", "0")
        # The fit remains exactly 100 g; steps 4 and 5 exceed the new
        # inspection limits but remain within the calibration's total 5%.
        for quantity, value in enumerate(("100", "200", "300", "416", "487.2"), 1):
            session.record(quantity, value)
        self.assertEqual(session.finish().unit_weight_g, Decimal("100"))

    def test_tiny_product_conflicting_with_empty_threshold_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "4 g"):
            make_profile(unit="4")
        self.assertEqual(make_profile(unit="4.001").unit_weight_g, Decimal("4.001"))

    def test_profile_rejects_unit_inconsistent_with_calibration(self):
        valid = make_profile()
        with self.assertRaises(ValueError):
            WeightProfile(valid.size, valid.part_no, "101", valid.calibration_g, valid.calibrated_at)


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.profile = make_profile()

    def test_infers_each_quantity(self):
        for quantity in range(1, 6):
            with self.subTest(quantity=quantity):
                decision = evaluate_weight(100 * quantity, self.profile)
                self.assertTrue(decision.accepted)
                self.assertEqual(decision.quantity, quantity)
                self.assertEqual(decision.deviation_percent, Decimal(0))

    def test_exact_five_percent_rejected_on_both_sides_for_every_quantity(self):
        for quantity in range(1, 6):
            for ratio in (Decimal(".95"), Decimal("1.05")):
                with self.subTest(quantity=quantity, ratio=ratio):
                    decision = evaluate_weight(100 * quantity * ratio, self.profile)
                    self.assertFalse(decision.accepted)
                    self.assertEqual(decision.deviation_percent, Decimal(5))

    def test_single_item_just_inside_five_percent_passes(self):
        for value in ("95.000001", "104.999999"):
            with self.subTest(value=value):
                self.assertTrue(evaluate_weight(value, self.profile).accepted)

    def test_four_normal_slightly_heavy_items_pass_with_reduced_total_limit(self):
        decision = evaluate_weight("408", self.profile)
        self.assertTrue(decision.accepted)
        self.assertEqual(decision.quantity, 4)
        self.assertEqual(decision.expected_g, Decimal("400"))
        self.assertEqual(decision.difference_g, Decimal("8"))
        self.assertEqual(decision.limit_g, Decimal("10"))
        # Keep the displayed deviation as a percentage of expected total.
        self.assertEqual(decision.deviation_percent, Decimal("2"))

    def test_four_item_exact_limit_rejected_and_immediately_inside_passes(self):
        for value, accepted in (
            ("390", False), ("390.000001", True),
            ("409.999999", True), ("410", False),
        ):
            with self.subTest(value=value):
                decision = evaluate_weight(value, self.profile)
                self.assertEqual(decision.quantity, 4)
                self.assertEqual(decision.accepted, accepted)

    def test_four_item_deviations_previously_inside_total_five_percent_rejected(self):
        for value in ("385", "415"):
            with self.subTest(value=value):
                decision = evaluate_weight(value, self.profile)
                self.assertEqual(decision.quantity, 4)
                self.assertFalse(decision.accepted)
                self.assertEqual(decision.deviation_percent, Decimal("3.75"))

    def test_non_square_quantities_use_unrounded_limits_on_both_sides(self):
        # Independently tabulated weights bracket each limit by less than
        # one microgram; rounded display values must not affect acceptance.
        cases = (
            (2, "192.928932", False), (2, "192.928933", True),
            (2, "207.071067", True), (2, "207.071068", False),
            (3, "291.339745", False), (3, "291.339746", True),
            (3, "308.660254", True), (3, "308.660255", False),
            (5, "488.819660", False), (5, "488.819661", True),
            (5, "511.180339", True), (5, "511.180340", False),
        )
        for quantity, value, accepted in cases:
            with self.subTest(quantity=quantity, value=value):
                decision = evaluate_weight(value, self.profile)
                self.assertEqual(decision.quantity, quantity)
                self.assertEqual(decision.accepted, accepted)

    def test_limit_scales_with_model_unit_weight(self):
        other = make_profile(size="MODEL-B", part_no="PART-B", unit="80")
        for value, accepted in (("312", False), ("312.000001", True),
                                ("327.999999", True), ("328", False)):
            with self.subTest(value=value):
                decision = evaluate_weight(value, other)
                self.assertEqual(decision.quantity, 4)
                self.assertEqual(decision.expected_g, Decimal("320"))
                self.assertEqual(decision.limit_g, Decimal("8"))
                self.assertEqual(decision.accepted, accepted)

    def test_out_of_range_and_between_quantity_weights_are_not_clamped_into_pass(self):
        for value in ("1.001", "50", "150", "450", "525", "550", "600", "10000"):
            with self.subTest(value=value):
                self.assertFalse(evaluate_weight(value, self.profile).accepted)

    def test_empty_and_negative_values_do_not_infer_a_quantity(self):
        for value in ("-100", "0", "1", "2"):
            decision = evaluate_weight(value, self.profile)
            self.assertFalse(decision.accepted)
            self.assertIsNone(decision.quantity)

    def test_invalid_values_raise_instead_of_accepting(self):
        for value in ("NaN", "Infinity", None, "x"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                evaluate_weight(value, self.profile)

    def test_model_profiles_produce_independent_results(self):
        other = make_profile(size="MODEL-B", unit="80")
        self.assertTrue(evaluate_weight("100", self.profile).accepted)
        self.assertFalse(evaluate_weight("100", other).accepted)


class CycleGateTests(unittest.TestCase):
    def setUp(self):
        self.profile = make_profile()
        self.gate = CycleGate()

    def test_requires_explicit_empty_confirmation_on_start_and_after_reset(self):
        self.assertEqual(self.gate.observe("100", self.profile).status, "waiting_empty")
        self.assertFalse(self.gate.armed)
        self.gate.confirm_empty("4")
        self.assertEqual(self.gate.tare_g, Decimal(4))
        self.assertFalse(self.gate.latched)
        self.assertEqual(self.gate.observe("104", self.profile).status, "accepted")
        self.assertTrue(self.gate.latched)
        self.gate.reset()
        self.assertIsNone(self.gate.tare_g)
        self.assertEqual(self.gate.observe("4", self.profile).status, "waiting_empty")

    def test_repeated_load_passes_only_once_and_needs_stable_removal(self):
        self.gate.confirm_empty("0")
        self.assertEqual(self.gate.observe("100", self.profile, stable=False).status, "unstable")
        self.assertTrue(self.gate.armed)
        self.assertEqual(self.gate.observe("100", self.profile).status, "accepted")
        for value in ("100", "99.9", "200", "0"):
            if value == "0":
                event = self.gate.observe(value, self.profile, stable=False)
                self.assertEqual(event.status, "unstable")
            else:
                self.assertEqual(self.gate.observe(value, self.profile).status, "latched")
            self.assertFalse(self.gate.armed)
        self.assertEqual(self.gate.observe("1", self.profile).status, "empty")
        self.assertEqual(self.gate.observe("200", self.profile).status, "accepted")

    def test_rejected_load_also_latches_until_removed(self):
        self.gate.confirm_empty("0")
        self.assertEqual(self.gate.observe("150", self.profile).status, "rejected")
        self.assertEqual(self.gate.observe("100", self.profile).status, "latched")
        self.assertEqual(self.gate.observe("-0.2", self.profile).status, "empty")
        self.assertEqual(self.gate.observe("100", self.profile).status, "accepted")

    def test_large_negative_reading_is_not_empty(self):
        self.gate.confirm_empty("0")
        self.assertEqual(self.gate.observe("-50", self.profile).status, "rejected")
        self.assertFalse(self.gate.armed)

    def test_two_gram_empty_band_uses_confirmed_tare_and_includes_boundaries(self):
        self.gate.confirm_empty("4")
        for value in ("2", "2.01", "4", "5.99", "6"):
            self.assertEqual(self.gate.observe(value, self.profile).status, "empty")
            self.assertTrue(self.gate.armed)
        self.assertEqual(self.gate.observe("104", self.profile).status, "accepted")
        self.assertEqual(self.gate.observe("6", self.profile, stable=False).status, "unstable")
        self.assertTrue(self.gate.latched)
        self.assertEqual(self.gate.observe("6", self.profile).status, "empty")
        self.assertEqual(self.gate.observe("204", self.profile).status, "accepted")

    def test_outside_two_gram_empty_band_still_rejects_and_latches(self):
        for value in ("-2.001", "2.001"):
            self.gate.confirm_empty("0")
            self.assertEqual(self.gate.observe(value, self.profile).status, "rejected")
            self.assertTrue(self.gate.latched)


class ProfileStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "data" / "weight_profiles.json"
        self.store = ProfileStore(self.path)

    def test_missing_file_is_empty_then_persists_per_model_and_part(self):
        self.assertEqual(self.store.all(), [])
        profiles = [make_profile(), make_profile(part_no="PART-B", unit="80"), make_profile(size="MODEL-B", unit="120")]
        for profile in profiles:
            self.store.save(profile)
        reloaded = ProfileStore(self.path)
        self.assertEqual(len(reloaded.all()), 3)
        for profile in profiles:
            self.assertEqual(reloaded.get(*profile.key), profile)
        self.assertIsNone(reloaded.get("MISSING", "PART-A"))

    def test_saving_same_key_updates_only_that_profile(self):
        self.store.save(make_profile())
        self.store.save(make_profile(part_no="PART-B", unit="80"))
        self.store.save(make_profile(unit="110"))
        self.assertEqual(len(self.store.all()), 2)
        self.assertEqual(self.store.get("MODEL-A", "PART-A").unit_weight_g, Decimal(110))
        self.assertEqual(self.store.get("MODEL-A", "PART-B").unit_weight_g, Decimal(80))

    def test_malformed_and_invalid_files_are_never_overwritten(self):
        self.path.parent.mkdir(parents=True)
        for data in ("{broken", "{}", '{"version":2,"profiles":[]}', '{"version":true,"profiles":[]}', '{"version":1,"profiles":[{}]}'):
            with self.subTest(data=data):
                self.path.write_text(data, encoding="utf-8")
                with self.assertRaises(ProfileStoreError):
                    self.store.all()
                with self.assertRaises(ProfileStoreError):
                    self.store.save(make_profile())
                self.assertEqual(self.path.read_text(encoding="utf-8"), data)

    def test_corrupted_numeric_field_and_duplicate_profiles_fail(self):
        self.store.save(make_profile())
        document = json.loads(self.path.read_text(encoding="utf-8"))
        document["profiles"][0]["unit_weight_g"] = "NaN"
        self.path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaises(ProfileStoreError):
            self.store.all()
        document["profiles"][0]["unit_weight_g"] = "100"
        document["profiles"].append(document["profiles"][0].copy())
        self.path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaises(ProfileStoreError):
            self.store.all()

    def test_failed_atomic_replace_preserves_prior_file_and_cleans_temporary(self):
        self.store.save(make_profile())
        before = self.path.read_bytes()
        with patch("field_agent.weigh.profiles.os.replace", side_effect=OSError("simulated disk error")):
            with self.assertRaises(ProfileStoreError):
                self.store.save(make_profile(unit="110"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
