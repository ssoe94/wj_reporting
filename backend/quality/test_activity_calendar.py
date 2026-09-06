from datetime import date, datetime, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import DatabaseError
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord, InjectionMonitoringRollup, UserProfile

from .activity_calendar import _machine_day, build_activity_calendar
from .analysis import SHANGHAI, parse_analysis_filters
from .models import QualityReport


DAY = date(2026, 9, 4)
START = datetime(2026, 9, 4, tzinfo=SHANGHAI)
NOW = datetime(2026, 9, 7, 12, tzinfo=SHANGHAI)


def scope(**changes):
    return {"start_date": DAY, "end_date": DAY, "section": "LQC_INJ", "machine_number": 1, **changes}


def quality(*, reports=0, quantity=None):
    return {"trend": [{"date": DAY.isoformat(), "report_count": reports, "reported_defect_qty": quantity}]}


class ActivityCalendarTests(TestCase):
    def samples(self, *, machine=1, value=0, minutes=None, shift=0, values=None, device=None):
        minutes = list(range(0, 1441, 10)) if minutes is None else minutes
        InjectionMonitoringRecord.objects.bulk_create([
            InjectionMonitoringRecord(machine_name=f"{machine}호기", device_code=device or f"synthetic-{machine}",
                                      timestamp=START + timedelta(minutes=minute + shift),
                                      capacity=values.get(minute, value) if values else value)
            for minute in minutes
        ])

    def calendar(self, result=None, **filters):
        return build_activity_calendar(result if result is not None else quality(), scope(**filters), now=NOW)

    def test_observed_zero_counter_at_exact_midnights_can_collapse_only_unrecorded_day(self):
        self.samples()
        with self.assertNumQueries(1):
            result = self.calendar()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["days"][0], {"date": "2026-09-04", "status": "no_change",
                         "reason": "continuous_constant_capacity", "can_collapse": True, "observed_machine_count": 1})

    def test_nearby_boundary_baselines_are_accepted_but_absent_boundaries_are_not(self):
        self.samples(minutes=list(range(-5, 1446, 10)), value=100)
        self.assertTrue(self.calendar()["days"][0]["can_collapse"])
        InjectionMonitoringRecord.objects.filter(timestamp=START - timedelta(minutes=5)).delete()
        day = self.calendar()["days"][0]
        self.assertEqual(day["status"], "unknown")
        self.assertEqual(day["reason"], "boundary_not_observed")

    def test_missing_end_boundary_is_unknown(self):
        self.samples(minutes=list(range(0, 1440, 10)))
        self.assertEqual(self.calendar()["days"][0]["reason"], "boundary_not_observed")

    def test_interior_gap_and_hourly_compaction_cannot_be_filled_by_zero_rollups(self):
        self.samples(minutes=[minute for minute in range(0, 1441, 10) if minute != 720])
        self.assertEqual(self.calendar()["days"][0]["reason"], "observation_gap")
        InjectionMonitoringRecord.objects.all().delete()
        self.samples(minutes=list(range(0, 1441, 60)))
        InjectionMonitoringRollup.objects.create(machine_name="1호기", device_code="synthetic-1",
                                                bucket_start=START, bucket_minutes=1440, shot_count=0)
        day = self.calendar()["days"][0]
        self.assertEqual(day["status"], "unknown")
        self.assertEqual(day["reason"], "observation_gap")
        self.assertFalse(day["can_collapse"])

    def test_temperature_only_rows_do_not_bridge_capacity_gaps(self):
        self.samples(values={720: None})
        self.assertEqual(self.calendar()["days"][0]["reason"], "observation_gap")

    def test_null_capacity_retains_device_identity_without_breaking_valid_coverage(self):
        self.samples()
        self.samples(minutes=[725], value=None)
        self.assertTrue(self.calendar()["days"][0]["can_collapse"])
        self.samples(minutes=[725], value=None, device="other-device")
        day = self.calendar()["days"][0]
        self.assertEqual(day["reason"], "ambiguous_device_identity")
        self.assertFalse(day["can_collapse"])

    def test_a_rise_within_the_date_is_activity(self):
        self.samples(value=10, values={minute: 11 for minute in range(720, 1441, 10)})
        day = self.calendar()["days"][0]
        self.assertEqual(day["status"], "activity")
        self.assertFalse(day["can_collapse"])

    def test_decrease_or_reset_is_ambiguous_even_with_later_increase(self):
        self.samples(value=100, values={minute: 0 if minute < 800 else 10 for minute in range(720, 1441, 10)})
        day = self.calendar()["days"][0]
        self.assertEqual(day["status"], "unknown")
        self.assertEqual(day["reason"], "counter_decreased")

    def test_change_only_across_midnight_boundary_is_not_assigned_to_this_day(self):
        self.samples(minutes=list(range(-5, 1446, 10)), value=10, values={1445: 11})
        day = self.calendar()["days"][0]
        self.assertEqual(day["status"], "unknown")
        self.assertEqual(day["reason"], "boundary_counter_change")

    def test_negative_capacity_and_duplicate_device_identity_are_unknown(self):
        self.samples(values={720: -1})
        self.assertEqual(self.calendar()["days"][0]["reason"], "invalid_capacity")
        InjectionMonitoringRecord.objects.all().delete()
        self.samples()
        self.samples(minutes=[0], device="other-device")
        self.assertEqual(self.calendar()["days"][0]["reason"], "ambiguous_device_identity")

    def test_explicit_zero_report_and_any_known_quantity_are_never_collapsed(self):
        self.samples()
        for result in (quality(reports=1, quantity=0), quality(reports=1), quality(quantity=0)):
            with self.subTest(result=result):
                day = self.calendar(result)["days"][0]
                self.assertEqual(day["status"], "no_change")
                self.assertEqual(day["reason"], "quality_records_present")
                self.assertFalse(day["can_collapse"])

    def test_all_17_machines_are_required_and_a_missing_machine_is_not_inferred_idle(self):
        for machine in range(1, 17):
            self.samples(machine=machine)
        result = self.calendar(machine_number=None, section=None)
        self.assertEqual(result["expected_machine_count"], 17)
        self.assertEqual(result["days"][0]["observed_machine_count"], 16)
        self.assertEqual(result["days"][0]["status"], "unknown")
        self.samples(machine=17)
        self.assertTrue(self.calendar(machine_number=None)["days"][0]["can_collapse"])

    def test_unsupported_scope_and_current_day_do_not_query_or_collapse(self):
        for changes in ({"section": "OQC"}, {"section": "LQC_ASM"}, {"machine_number": "unknown"}):
            with self.subTest(changes=changes), self.assertNumQueries(0):
                result = self.calendar(**changes)
                self.assertEqual(result["status"], "not_applicable")
                self.assertEqual(result["days"][0]["status"], "unknown")
                self.assertFalse(result["days"][0]["can_collapse"])
        with self.assertNumQueries(0):
            result = build_activity_calendar(quality(), scope(), now=START + timedelta(hours=20))
        self.assertEqual(result["days"][0]["reason"], "current_day_incomplete")

    def test_row_limit_or_query_failure_invalidates_all_days_without_partial_decisions(self):
        self.samples()
        for manager_patch in (
            patch("quality.activity_calendar.MAX_RAW_ROWS", 3),
            patch("quality.activity_calendar.InjectionMonitoringRecord.objects.filter", side_effect=DatabaseError("synthetic")),
        ):
            with manager_patch:
                result = self.calendar(end_date=DAY + timedelta(days=1))
            self.assertEqual(result["status"], "unavailable")
            self.assertTrue(all(row["status"] == "unknown" and not row["can_collapse"] for row in result["days"]))
            self.assertTrue(all(row["observed_machine_count"] == 0 for row in result["days"]))


class ActivityCalendarNumericTests(SimpleTestCase):
    def test_earliest_accepted_date_does_not_underflow_the_boundary_window(self):
        filters = parse_analysis_filters({"start_date": "0001-01-01", "end_date": "0001-01-01"})
        start = datetime.combine(filters["start_date"], datetime.min.time(), tzinfo=SHANGHAI)
        result = _machine_day([], [], start, start + timedelta(days=1))
        self.assertEqual(result["reason"], "no_capacity_observations")

    def test_nonfinite_capacity_cannot_confirm_constant_activity(self):
        for invalid in (float("nan"), float("inf")):
            samples = [(START, "synthetic", 0), (START + timedelta(hours=12), "synthetic", invalid),
                       (START + timedelta(days=1), "synthetic", 0)]
            result = _machine_day(samples, [row[0] for row in samples], START, START + timedelta(days=1))
            self.assertEqual(result["reason"], "invalid_capacity")


@override_settings(ROOT_URLCONF="quality.test_analysis")
class ActivityCalendarApiTests(TestCase):
    def test_optional_source_failure_preserves_quality_result_and_permission_gate(self):
        client = APIClient()
        endpoint = "/api/quality/analysis/?start_date=2026-09-04&end_date=2026-09-04&section=LQC_INJ"
        user = get_user_model().objects.create_user(username="synthetic-calendar")
        UserProfile.objects.filter(user=user).update(can_view_quality=False)
        client.force_authenticate(get_user_model().objects.get(pk=user.pk))
        with patch("quality.activity_calendar.InjectionMonitoringRecord.objects.filter") as source:
            self.assertEqual(client.get(endpoint).status_code, 403)
            source.assert_not_called()
        UserProfile.objects.filter(user=user).update(can_view_quality=True)
        client.force_authenticate(get_user_model().objects.get(pk=user.pk))
        QualityReport.objects.create(report_dt=START + timedelta(hours=10), section="LQC_INJ", defect_qty=0)
        with patch("quality.activity_calendar.InjectionMonitoringRecord.objects.filter", side_effect=DatabaseError("synthetic")):
            response = client.get(endpoint)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["summary"]["report_count"], 1)
        self.assertEqual(response.data["summary"]["reported_defect_qty"], 0)
        self.assertEqual(response.data["activity_calendar"]["status"], "unavailable")
