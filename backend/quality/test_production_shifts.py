from datetime import date, datetime, timedelta
from unittest.mock import patch

from django.db import DatabaseError
from django.test import SimpleTestCase, TestCase

from injection.models import InjectionMonitoringRecord, InjectionMonitoringRollup

from .analysis import SHANGHAI
from .models import QualityReport
from .production_shifts import aggregate_production_shifts, build_production_shifts


DAY = date(2026, 9, 4)
START = datetime(2026, 9, 4, 8, tzinfo=SHANGHAI)
NOW = START + timedelta(days=3)


def scope(**changes):
    return {"start_date": DAY, "end_date": DAY, "section": "LQC_INJ", "machine_number": 1, **changes}


def report(index=1, *, minute=60, **changes):
    return {"id": index, "section": "LQC_INJ", "report_dt": START + timedelta(minutes=minute),
            "source_import_row__occurrence_location": None, "excel_source__occurrence_location": "IMM01", **changes}


def sample(minute, value=0, *, machine=1, device=None, **changes):
    return {"machine_name": f"{machine}호기", "device_code": device or f"synthetic-{machine}",
            "timestamp": START + timedelta(minutes=minute), "capacity": value, **changes}


def continuous(*, machine=1, days=1, active=False):
    return [sample(minute, max(0, (minute - 60) // 720 + 1) if active else 0, machine=machine)
            for minute in range(-10, days * 1440 + 11, 10)]


def aggregate(rows=(), reports=(), *, now=NOW, **filters):
    return aggregate_production_shifts(rows, reports, scope(**filters), now=now)


class ProductionShiftCalculationsTests(SimpleTestCase):
    def test_two_active_shifts_count_machine_once_per_shift_not_per_model_or_sample(self):
        rows = continuous(active=True)
        for index, row in enumerate(rows):
            row.update(model=f"MODEL-{index}", part_no=f"PART-{index}")
        result = aggregate(reversed(rows), [report(1), report(2), report(3)])
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["summary"], {"report_count": 3, "active_shift_count": 2,
                         "no_change_shift_count": 0, "unknown_shift_count": 0, "open_shift_count": 0,
                         "reports_per_shift": 1.5})

    def test_continuous_zero_is_known_no_change_but_never_a_zero_denominator_rate(self):
        result = aggregate(continuous())
        self.assertEqual(result["summary"]["no_change_shift_count"], 2)
        self.assertEqual(result["summary"]["report_count"], 0)
        self.assertIsNone(result["summary"]["reports_per_shift"])
        self.assertEqual(aggregate(continuous(active=True))["summary"]["reports_per_shift"], 0)

    def test_missing_logs_leave_all_closed_shifts_unknown_and_preserve_reports(self):
        result = aggregate([], [report()])
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["source_status"], {"reports": "ready", "monitoring": "ready"})
        self.assertEqual(result["summary"]["report_count"], 1)
        self.assertEqual(result["summary"]["unknown_shift_count"], 2)
        self.assertIsNone(result["summary"]["reports_per_shift"])

    def test_hourly_increase_proves_binary_activity_but_hourly_zero_cannot_prove_inactivity(self):
        quiet = [sample(minute) for minute in range(0, 1441, 60)]
        self.assertEqual(aggregate(quiet)["summary"]["unknown_shift_count"], 2)
        positive = [sample(60, 0), sample(120, 1)]
        result = aggregate(positive, [report()])
        self.assertEqual(result["summary"]["active_shift_count"], 1)
        self.assertEqual(result["summary"]["unknown_shift_count"], 1)
        self.assertIsNone(result["summary"]["reports_per_shift"])

    def test_boundary_only_increase_and_one_minute_timestamp_margin_do_not_double_count_shifts(self):
        for rows in ([sample(710, 0), sample(730, 1)], [sample(0.5, 0), sample(1.5, 1)],
                     [sample(718.5, 0), sample(719.5, 1)]):
            with self.subTest(rows=rows):
                self.assertEqual(aggregate(rows)["summary"]["active_shift_count"], 0)
        self.assertEqual(aggregate([sample(1, 0), sample(2, 1)])["summary"]["active_shift_count"], 1)

    def test_reset_invalid_values_and_device_changes_prevent_a_normalized_denominator(self):
        fixtures = [
            [sample(60, 100), sample(120, 0), sample(180, 10)],
            [sample(60, 0), sample(120, 10, device="replacement")],
            [sample(60, 0), sample(120, 10), sample(30, None, device="replacement")],
            [sample(60, 0, device_code=" "), sample(120, 10, device_code=" ")],
        ]
        for invalid in (-1, float("inf"), float("nan"), True):
            fixtures.append([sample(60, 0), sample(120, invalid), sample(180, 10)])
        for rows in fixtures:
            with self.subTest(rows=rows):
                result = aggregate(rows, [report()])
                self.assertEqual(result["summary"]["active_shift_count"], 0)
                self.assertEqual(result["summary"]["unknown_shift_count"], 2)
                self.assertIsNone(result["summary"]["reports_per_shift"])

    def test_temperature_rows_do_not_fill_a_capacity_gap_but_keep_device_identity(self):
        rows = continuous()
        next(row for row in rows if row["timestamp"] == START + timedelta(hours=6))["capacity"] = None
        result = aggregate(rows)
        self.assertEqual(result["summary"]["unknown_shift_count"], 1)
        self.assertEqual(result["summary"]["no_change_shift_count"], 1)
        rows = continuous() + [sample(365, None, device="replacement")]
        self.assertEqual(aggregate(rows)["summary"]["unknown_shift_count"], 1)

    def test_both_boundary_observations_are_required_for_constant_counter_classification(self):
        rows = [sample(minute) for minute in range(10, 1440, 10)]
        result = aggregate(rows)
        self.assertEqual(result["summary"]["unknown_shift_count"], 2)
        self.assertIsNone(result["summary"]["reports_per_shift"])

    def test_all_17_machines_are_fixed_units_and_missing_equipment_is_unknown(self):
        rows = [row for machine in range(1, 17) for row in continuous(machine=machine)]
        result = aggregate(rows, machine_number=None, section=None)
        self.assertEqual(result["expected_machine_count"], 17)
        self.assertEqual(result["summary"]["no_change_shift_count"], 32)
        self.assertEqual(result["summary"]["unknown_shift_count"], 2)
        self.assertIsNone(result["summary"]["reports_per_shift"])

    def test_open_shifts_are_counted_separately_and_never_normalized(self):
        result = aggregate(continuous(active=True), [report()], now=START + timedelta(hours=13))
        self.assertEqual(result["summary"]["active_shift_count"], 1)
        self.assertEqual(result["summary"]["open_shift_count"], 1)
        self.assertEqual(result["summary"]["unknown_shift_count"], 0)
        self.assertIsNone(result["summary"]["reports_per_shift"])
        self.assertEqual(aggregate(now=START - timedelta(minutes=1))["summary"]["open_shift_count"], 2)

    def test_next_morning_manual_reports_share_the_previous_business_date_without_shift_allocation(self):
        reports = [report(1, minute=-1), report(2, minute=0), report(3, minute=16 * 60),
                   report(4, minute=24 * 60 - 1), report(5, minute=24 * 60)]
        result = aggregate(continuous(active=True), reports)
        self.assertEqual(result["summary"]["report_count"], 3)
        self.assertEqual(result["days"][0]["date"], DAY.isoformat())
        self.assertNotIn("day_report_count", result["days"][0])
        self.assertNotIn("night_report_count", result["days"][0])

    def test_only_injection_reports_match_recorded_equipment_and_import_source_precedence(self):
        reports = [
            report(1), report(2, section="LQC_ASM"), report(3, section="OQC"),
            report(4, **{"source_import_row__occurrence_location": "IMM02"}),
            report(5, **{"source_import_row__occurrence_location": ""}),
            report(6, **{"excel_source__occurrence_location": "unknown"}),
        ]
        self.assertEqual(aggregate([], reports)["summary"]["report_count"], 1)
        self.assertEqual(aggregate([], reports, machine_number=None, section=None)["summary"]["report_count"], 4)

    def test_report_ids_count_once_but_distinct_duplicate_candidate_reports_are_preserved(self):
        result = aggregate(continuous(active=True), [report(1), report(1), report(2)])
        self.assertEqual(result["summary"]["report_count"], 2)

    def test_period_rate_is_ratio_of_sums_and_can_exceed_100(self):
        rows = continuous(days=2, active=True)
        # Only the first shift of the second day increases.
        for row in rows:
            if row["timestamp"] >= START + timedelta(days=1, hours=12):
                row["capacity"] = 3
        reports = [report(index, minute=60 if index <= 2 else 1500) for index in range(1, 9)]
        result = aggregate(rows, reports, end_date=DAY + timedelta(days=1))
        self.assertEqual([day["reports_per_shift"] for day in result["days"]], [1, 6])
        self.assertEqual(result["summary"]["reports_per_shift"], 2.6667)
        large = aggregate(continuous(active=True), [report(index) for index in range(1, 302)])
        self.assertEqual(large["summary"]["reports_per_shift"], 150.5)

    def test_row_caps_discard_partial_results_and_preserve_the_other_source(self):
        reports = [report(1), report(2), report(3)]
        with patch("quality.production_shifts.MAX_RAW_ROWS", 1):
            result = aggregate(continuous(active=True), reports)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["source_status"], {"reports": "ready", "monitoring": "unavailable"})
        self.assertEqual(result["summary"]["report_count"], 3)
        self.assertEqual(result["summary"]["active_shift_count"], 0)
        self.assertEqual(result["summary"]["unknown_shift_count"], 2)
        with patch("quality.production_shifts.MAX_REPORT_ROWS", 2):
            result = aggregate(continuous(active=True), reports)
        self.assertEqual(result["source_status"], {"reports": "unavailable", "monitoring": "ready"})
        self.assertIsNone(result["summary"]["report_count"])
        self.assertEqual(result["summary"]["active_shift_count"], 2)
        self.assertIsNone(result["summary"]["reports_per_shift"])

    def test_stream_failure_after_partial_rows_cannot_publish_partial_counts(self):
        def failed(rows):
            yield from rows
            raise DatabaseError("synthetic stream failure")

        result = aggregate(failed([sample(60, 0), sample(120, 1)]), failed([report()]))
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["summary"]["report_count"])
        self.assertEqual(result["summary"]["active_shift_count"], 0)
        self.assertEqual(result["summary"]["unknown_shift_count"], 2)

    def test_year_boundary_and_multi_day_unknowns_preserve_all_machine_shift_units(self):
        target = date(2025, 12, 31)
        result = aggregate(start_date=target, end_date=target + timedelta(days=1), machine_number=None)
        self.assertEqual([day["date"] for day in result["days"]], ["2025-12-31", "2026-01-01"])
        self.assertEqual(result["summary"]["unknown_shift_count"], 68)
        self.assertIsNone(result["summary"]["reports_per_shift"])


class ProductionShiftQueryTests(TestCase):
    def test_two_read_only_queries_use_business_boundaries_and_keep_core_calendar_independent(self):
        InjectionMonitoringRecord.objects.bulk_create([InjectionMonitoringRecord(**row) for row in continuous(active=True)])
        for minute in (-1, 0, 960, 1439, 1440):
            QualityReport.objects.create(report_dt=START + timedelta(minutes=minute), section="LQC_INJ",
                                         excel_source={"occurrence_location": "IMM01"}, defect_qty=0)
        QualityReport.objects.create(report_dt=START + timedelta(hours=1), section="OQC", defect_qty=0)
        with self.assertNumQueries(2):
            result = build_production_shifts(scope(), now=NOW)
        self.assertEqual(result["summary"]["report_count"], 3)
        self.assertEqual(result["summary"]["active_shift_count"], 2)
        self.assertEqual(QualityReport.objects.count(), 6)
        self.assertEqual(InjectionMonitoringRecord.objects.count(), len(continuous(active=True)))

    def test_zero_rollups_do_not_supplement_absent_raw_logs(self):
        InjectionMonitoringRollup.objects.create(machine_name="1호기", device_code="synthetic-1", bucket_start=START,
                                                bucket_minutes=720, shot_count=100, sample_count=72)
        result = build_production_shifts(scope(), now=NOW)
        self.assertEqual(result["summary"]["active_shift_count"], 0)
        self.assertEqual(result["summary"]["unknown_shift_count"], 2)

    def test_unsupported_scope_performs_no_queries_and_never_claims_zero_reports(self):
        for changes in ({"section": "OQC"}, {"section": "LQC_ASM"}, {"machine_number": "unknown"}):
            with self.subTest(changes=changes), self.assertNumQueries(0):
                result = build_production_shifts(scope(**changes), now=NOW)
            self.assertEqual(result["status"], "not_applicable")
            self.assertEqual(result["summary"]["unknown_shift_count"], 2 * result["expected_machine_count"])
            self.assertIsNone(result["summary"]["report_count"])
            self.assertIsNone(result["summary"]["reports_per_shift"])

    def test_database_failures_preserve_independent_source_results(self):
        QualityReport.objects.create(report_dt=START + timedelta(hours=1), section="LQC_INJ",
                                     excel_source={"occurrence_location": "IMM01"})
        with patch("quality.production_shifts.InjectionMonitoringRecord.objects.filter", side_effect=DatabaseError("synthetic")):
            result = build_production_shifts(scope(), now=NOW)
        self.assertEqual(result["summary"]["report_count"], 1)
        self.assertEqual(result["summary"]["unknown_shift_count"], 2)
        InjectionMonitoringRecord.objects.bulk_create([InjectionMonitoringRecord(**row) for row in continuous(active=True)])
        with patch("quality.production_shifts.QualityReport.objects.filter", side_effect=DatabaseError("synthetic")):
            result = build_production_shifts(scope(), now=NOW)
        self.assertIsNone(result["summary"]["report_count"])
        self.assertEqual(result["summary"]["active_shift_count"], 2)
