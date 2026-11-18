import unittest
from decimal import Decimal

from field_agent.weigh.scale_stability import RangeStability


class RangeStabilityTests(unittest.TestCase):
    def assert_reset(self, state):
        self.assertFalse(state["stable"])
        self.assertEqual(state["held_seconds"], 0.0)
        self.assertEqual(state["required_seconds"], 1.0)
        self.assertEqual(Decimal(state["tolerance_grams"]), Decimal("2.0"))
        for key in ("min_grams", "max_grams", "range_grams"):
            self.assertIsNone(state[key])

    def make_stable(self, tracker, grams="1.00", mode="TR", start=0.0):
        for offset in (0.0, 0.25, 0.5, 0.75, 1.0):
            state = tracker.update(grams, mode, start + offset)
        self.assertTrue(state["stable"])
        return state

    def test_initial_snapshot_has_no_weight(self):
        self.assert_reset(RangeStability().snapshot(0.0))

    def test_crossing_integer_boundary_stays_within_range(self):
        tracker = RangeStability(tolerance_grams="0.1")
        for index, grams in enumerate(("0.98", "1.00", "0.99", "0.98", "1.00")):
            state = tracker.update(grams, "TR", index * 0.25)
            self.assertEqual(state["stable"], index == 4)
        self.assertEqual(Decimal(state["min_grams"]), Decimal("0.98"))
        self.assertEqual(Decimal(state["max_grams"]), Decimal("1.00"))
        self.assertEqual(Decimal(state["range_grams"]), Decimal("0.02"))

    def test_returning_to_start_does_not_hide_excursion(self):
        tracker = RangeStability(tolerance_grams="0.1")
        for index, grams in enumerate(("1.00", "1.00", "1.20", "1.00", "1.00")):
            state = tracker.update(grams, "TR", index * 0.25)
        self.assertFalse(state["stable"])
        self.assertEqual(Decimal(state["range_grams"]), Decimal("0.20"))

    def test_small_step_monotonic_drift_exceeds_total_tolerance(self):
        tracker = RangeStability(tolerance_grams="0.1")
        for index, grams in enumerate(("1.00", "1.05", "1.10", "1.15", "1.20")):
            state = tracker.update(grams, "TR", index * 0.25)
        self.assertFalse(state["stable"])
        self.assertEqual(Decimal(state["range_grams"]), Decimal("0.20"))

    def test_exact_tolerance_is_inclusive_and_decimal_exact(self):
        tracker = RangeStability(tolerance_grams="0.1")
        for index, grams in enumerate(("0.20", "0.30", "0.20", "0.30", "0.20")):
            state = tracker.update(grams, "TR", index * 0.25)
        self.assertTrue(state["stable"])
        self.assertEqual(Decimal(state["range_grams"]), Decimal("0.10"))
        state = tracker.update("0.30001", "TR", 1.25)
        self.assertFalse(state["stable"])

    def test_negative_weights_and_zero_crossing_use_actual_range(self):
        tracker = RangeStability(tolerance_grams="0.1")
        for index, grams in enumerate(("-0.08", "-0.01", "0.01", "-0.02", "-0.08")):
            state = tracker.update(grams, "TR", index * 0.25)
        self.assertTrue(state["stable"])
        self.assertEqual(Decimal(state["min_grams"]), Decimal("-0.08"))
        self.assertEqual(Decimal(state["max_grams"]), Decimal("0.01"))
        self.assertEqual(Decimal(state["range_grams"]), Decimal("0.09"))

    def test_outlier_remains_until_its_full_window_has_passed(self):
        tracker = RangeStability(tolerance_grams="0.1")
        self.make_stable(tracker)
        self.assertFalse(tracker.update("1.20", "TR", 1.25)["stable"])
        for timestamp in (1.5, 1.75, 2.0, 2.25):
            state = tracker.update("1.00", "TR", timestamp)
            self.assertFalse(state["stable"])
        state = tracker.update("1.00", "TR", 2.5)
        self.assertTrue(state["stable"])
        self.assertEqual(Decimal(state["range_grams"]), Decimal("0.00"))

    def test_irregular_samples_keep_predecessor_for_complete_window(self):
        tracker = RangeStability(tolerance_grams="0.1")
        tracker.update("1.20", "TR", 0.0)
        tracker.update("1.00", "TR", 0.4)
        tracker.update("1.00", "TR", 0.8)
        state = tracker.update("1.00", "TR", 1.2)
        self.assertFalse(state["stable"])
        self.assertEqual(Decimal(state["max_grams"]), Decimal("1.20"))
        self.assertTrue(tracker.update("1.00", "TR", 1.6)["stable"])

    def test_snapshot_cannot_advance_hold_without_received_sample(self):
        tracker = RangeStability()
        for timestamp in (0.0, 0.25, 0.5, 0.75):
            tracker.update("1.00", "TR", timestamp)
        state = tracker.snapshot(1.0)
        self.assertFalse(state["stable"])
        self.assertEqual(state["held_seconds"], 0.75)
        self.assertTrue(tracker.update("1.00", "TR", 1.0)["stable"])

    def test_long_gap_restarts_hold_on_next_sample(self):
        tracker = RangeStability()
        self.make_stable(tracker)
        state = tracker.update("1.00", "TR", 1.75)
        self.assertFalse(state["stable"])
        self.assertEqual(state["held_seconds"], 0.0)
        for timestamp in (2.0, 2.25, 2.5, 2.75):
            state = tracker.update("1.00", "TR", timestamp)
        self.assertTrue(state["stable"])

    def test_exact_maximum_gap_is_allowed(self):
        tracker = RangeStability()
        tracker.update("1.00", "TR", 0.0)
        tracker.update("1.00", "TR", 0.5)
        self.assertTrue(tracker.update("1.00", "TR", 1.0)["stable"])

    def test_snapshot_invalidates_stability_after_gap(self):
        tracker = RangeStability()
        self.make_stable(tracker)
        self.assertTrue(tracker.snapshot(1.25)["stable"])
        self.assert_reset(tracker.snapshot(1.75))
        state = tracker.update("1.00", "TR", 2.0)
        self.assertFalse(state["stable"])
        self.assertEqual(state["held_seconds"], 0.0)

    def test_mode_change_restarts_hold(self):
        tracker = RangeStability()
        self.make_stable(tracker)
        state = tracker.update("1.00", "NT", 1.25)
        self.assertFalse(state["stable"])
        self.assertEqual(state["held_seconds"], 0.0)

    def test_manual_reset_removes_previous_range(self):
        tracker = RangeStability()
        self.make_stable(tracker)
        tracker.reset()
        self.assert_reset(tracker.snapshot(1.25))
        state = tracker.update("1.00", "TR", 1.5)
        self.assertFalse(state["stable"])
        self.assertEqual(state["held_seconds"], 0.0)

    def test_invalid_and_nonfinite_weights_reset_state(self):
        for grams in ("", "not a weight", "NaN", "sNaN", "Infinity", "-Infinity"):
            with self.subTest(grams=grams):
                tracker = RangeStability()
                self.make_stable(tracker)
                self.assert_reset(tracker.update(grams, "TR", 1.25))
                state = tracker.update("1.00", "TR", 1.5)
                self.assertFalse(state["stable"])
                self.assertEqual(state["held_seconds"], 0.0)

    def test_constructor_rejects_nonpositive_and_nonfinite_intervals(self):
        for argument in ("hold_seconds", "max_gap_seconds"):
            for value in (0, -1, float("nan"), float("inf"), float("-inf")):
                with self.subTest(argument=argument, value=value):
                    with self.assertRaises(ValueError):
                        RangeStability(**{argument: value})

    def test_constructor_rejects_negative_and_nonfinite_tolerance(self):
        for value in ("-0.1", "NaN", "Infinity", "-Infinity", "bad"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    RangeStability(tolerance_grams=value)

    def test_default_tolerance_is_two_grams_with_inclusive_boundary(self):
        tracker = RangeStability()
        for index, grams in enumerate(("38.60", "40.60", "39.00", "38.90", "39.10")):
            state = tracker.update(grams, "TR", index * 0.25)
        self.assertEqual(Decimal(state["tolerance_grams"]), Decimal("2.0"))
        self.assertTrue(state["stable"])
        self.assertFalse(tracker.update("38.59", "TR", 1.25)["stable"])

    def test_zero_tolerance_requires_exactly_equal_weights(self):
        tracker = RangeStability(tolerance_grams="0")
        self.make_stable(tracker)
        self.assertFalse(tracker.update("1.00001", "TR", 1.25)["stable"])


if __name__ == "__main__":
    unittest.main()
