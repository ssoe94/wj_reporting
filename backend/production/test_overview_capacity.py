"""Synthetic contract tests; no source queries or production fixtures."""

from datetime import datetime

from django.test import SimpleTestCase

from .ai_metrics import SHANGHAI_TZ
from .overview_board import _build_equipment, _process_summary


class OverviewCapacityContractTests(SimpleTestCase):
    latest = datetime(2026, 9, 4, 12, 0, tzinfo=SHANGHAI_TZ)

    def equipment(self, machine_rows, active_rows=None):
        return _build_equipment(
            {"machine_rows": machine_rows, "total_equipment_count": 17},
            {},
            injection_activity={
                "latest_mes_time": self.latest,
                "is_stale": False,
                "rows": active_rows or [],
            },
        )["injection"]

    def test_fresh_fleet_activity_does_not_override_missing_machine_capacity(self):
        rows = self.equipment([{
            "machine_number": 1, "planned_qty": 100, "actual_qty": 0,
            "latest_capacity_time": None, "capacity_data_available": False,
            "data_warning": "injection_capacity_data_missing",
        }])
        self.assertEqual(rows[0]["source_status"], "ok")
        self.assertEqual(rows[0]["source_latest_at"], self.latest.isoformat())
        self.assertIsNone(rows[0]["latest_capacity_time"])
        self.assertIs(rows[0]["capacity_data_available"], False)
        self.assertEqual(rows[0]["data_warning"], "injection_capacity_data_missing")

    def test_stale_machine_timestamp_is_preserved_independently(self):
        old = datetime(2026, 9, 4, 10, 0, tzinfo=SHANGHAI_TZ)
        rows = self.equipment([{
            "machine_number": 1, "planned_qty": 100, "actual_qty": 20,
            "latest_capacity_time": old, "capacity_data_available": False,
            "data_warning": "injection_capacity_data_stale",
        }])
        self.assertEqual(rows[0]["latest_capacity_time"], old.isoformat())
        self.assertIs(rows[0]["capacity_data_available"], False)
        self.assertEqual(rows[0]["data_warning"], "injection_capacity_data_stale")

    def test_verified_historical_zero_is_not_reclassified_by_current_clock(self):
        rows = self.equipment([{
            "machine_number": 1, "planned_qty": 100, "actual_qty": 0,
            "latest_capacity_time": self.latest, "capacity_data_available": True,
            "data_warning": None,
        }])
        self.assertIs(rows[0]["capacity_data_available"], True)
        self.assertEqual(rows[0]["actual_qty"], 0)
        self.assertIsNone(rows[0]["data_warning"])

    def test_unplanned_activity_cannot_assert_quantity_coverage(self):
        rows = self.equipment([], [{"machine_number": 2, "shot_count": 10}])
        self.assertEqual(rows[0]["production_state"], "running_without_plan")
        self.assertIsNone(rows[0]["capacity_data_available"])
        self.assertIsNone(rows[0]["latest_capacity_time"])

    def test_process_preserves_true_false_and_unknown_coverage(self):
        for coverage in (True, False, None):
            with self.subTest(coverage=coverage):
                summary = _process_summary(
                    {"capacity_coverage_complete": coverage},
                    key="injection", source_process="injection", title="Synthetic",
                    display_semantics="injection",
                )
                self.assertIs(summary["capacity_coverage_complete"], coverage)
