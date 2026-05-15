from unittest import TestCase

from .counter_utils import calculate_cumulative_counter_delta


class CumulativeCounterDeltaTests(TestCase):
    def test_missing_baseline_uses_first_value_as_starting_point(self):
        result = calculate_cumulative_counter_delta([104726, 104728, 104730], baseline=None)

        self.assertEqual(result, 4)

    def test_existing_baseline_counts_first_in_window_delta(self):
        result = calculate_cumulative_counter_delta([104726, 104728, 104730], baseline=104700)

        self.assertEqual(result, 30)

    def test_counter_reset_counts_post_reset_counter(self):
        result = calculate_cumulative_counter_delta([100, 5, 9], baseline=90)

        self.assertEqual(result, 19)

    def test_small_counter_correction_is_not_treated_as_reset(self):
        result = calculate_cumulative_counter_delta([104820, 104822, 104821, 104825], baseline=None)

        self.assertEqual(result, 6)
