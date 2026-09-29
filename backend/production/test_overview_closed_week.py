from datetime import date
from unittest.mock import patch

from django.core.cache import cache
from django.db import DatabaseError
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from .overview_closed_week import build_closed_week_summary


def context(injection_plan=100, injection_actual=90, assembly_plan=80, assembly_actual=40):
    return {
        "injection": {
            "planned_qty": injection_plan,
            "actual_qty": injection_actual,
            "capacity_coverage_complete": True,
            "latest_mes_time": "2026-09-28T18:00:00+08:00",
            "monitoring_row_count": 10,
        },
        "machining": {
            "planned_qty": assembly_plan,
            "actual_qty": assembly_actual,
            "mes_row_count": 1,
        },
    }


class ClosedWeekSummaryTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    @patch("production.overview_closed_week.get_daily_production_context")
    def test_tuesday_uses_only_closed_monday_and_labels_yesterday(self, retrieve):
        retrieve.return_value = context()
        result = build_closed_week_summary(date(2026, 9, 29))

        retrieve.assert_called_once_with(date(2026, 9, 28))
        self.assertEqual(result["previous_day"]["business_date"], "2026-09-28")
        self.assertEqual(result["previous_day"]["injection"]["completion_rate"], 90.0)
        self.assertEqual(result["previous_day"]["assembly"]["completion_rate"], 50.0)
        self.assertEqual(result["week"]["start_date"], "2026-09-28")
        self.assertEqual(result["week"]["closed_day_count"], 1)
        self.assertEqual(result["week"]["injection"]["completion_rate"], 90.0)

    @patch("production.overview_closed_week.get_daily_production_context")
    def test_week_rate_uses_sum_of_quantities_across_closed_days(self, retrieve):
        daily = {
            date(2026, 9, 28): context(100, 50, 80, 40),
            date(2026, 9, 29): context(300, 270, 120, 120),
            date(2026, 9, 30): context(100, 100, 100, 50),
        }
        retrieve.side_effect = lambda day: daily[day]

        result = build_closed_week_summary(date(2026, 10, 1))

        self.assertEqual(result["week"]["closed_day_count"], 3)
        self.assertEqual(result["week"]["injection"]["planned_quantity"], 500)
        self.assertEqual(result["week"]["injection"]["actual_quantity"], 420)
        self.assertEqual(result["week"]["injection"]["completion_rate"], 84.0)
        self.assertEqual(result["week"]["assembly"]["completion_rate"], 70.0)
        self.assertEqual(result["previous_day"]["business_date"], "2026-09-30")

    @patch("production.overview_closed_week.get_daily_production_context")
    def test_missing_mes_does_not_turn_into_zero_performance(self, retrieve):
        missing = context()
        missing["injection"]["monitoring_row_count"] = 0
        missing["injection"]["latest_mes_time"] = None
        retrieve.side_effect = [context(), missing]

        result = build_closed_week_summary(date(2026, 9, 30))

        self.assertEqual(result["previous_day"]["injection"]["status"], "unavailable")
        self.assertIsNone(result["previous_day"]["injection"]["completion_rate"])
        self.assertEqual(result["week"]["injection"]["status"], "partial")
        self.assertIsNone(result["week"]["injection"]["completion_rate"])
        self.assertEqual(result["week"]["assembly"]["status"], "ok")

    @patch("production.overview_closed_week.get_daily_production_context")
    def test_monday_has_no_closed_days_in_current_week(self, retrieve):
        retrieve.return_value = context()
        result = build_closed_week_summary(date(2026, 10, 5))

        retrieve.assert_called_once_with(date(2026, 10, 4))
        self.assertEqual(result["week"]["closed_day_count"], 0)
        self.assertIsNone(result["week"]["end_date"])
        self.assertEqual(result["week"]["injection"]["status"], "pending")

    @patch("production.overview_closed_week.get_daily_production_context", side_effect=DatabaseError("source unavailable"))
    def test_failed_day_is_marked_unavailable(self, _retrieve):
        result = build_closed_week_summary(date(2026, 9, 29))

        self.assertEqual(result["week"]["unavailable_days"], 1)
        self.assertEqual(result["week"]["injection"]["status"], "partial")
        self.assertEqual(result["previous_day"]["assembly"]["status"], "unavailable")

    def test_endpoint_rejects_invalid_date(self):
        response = APIClient().get("/api/production/overview-board/closed-week/?date=bad")
        self.assertEqual(response.status_code, 400)
