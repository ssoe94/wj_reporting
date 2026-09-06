from datetime import date, datetime, timezone as datetime_timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.http import QueryDict
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import path
from rest_framework.exceptions import ValidationError
from rest_framework.test import APIClient

from injection.models import UserProfile

from .analysis import (
    SHANGHAI, aggregate_quality_analysis, build_quality_analysis,
    parse_analysis_filters, recorded_machine_number,
)
from .analysis_views import QualityAnalysisView
from .models import QualityImportBatch, QualityImportRow, QualityReport


urlpatterns = [path("api/quality/analysis/", QualityAnalysisView.as_view())]
DAY = date(2026, 9, 4)


def filters(**changes):
    return {"start_date": DAY, "end_date": DAY, "section": None, "machine_number": None, **changes}


def source_row(index=1, **changes):
    return {
        "id": index, "report_dt": datetime(2026, 9, 4, 10, tzinfo=SHANGHAI),
        "updated_at": datetime(2026, 9, 5, 10, tzinfo=SHANGHAI),
        "section": "LQC_INJ", "part_no": "SYNTHETIC-PART", "phenomenon": "擦伤",
        "judgement": "NG", "lot_qty": 100, "inspection_qty": 10, "defect_qty": 2,
        "source_import_row__occurrence_location": None,
        "excel_source__occurrence_location": "IMM01", **changes,
    }


class QualityAnalysisCalculationsTests(SimpleTestCase):
    def test_no_records_unknown_quantities_and_zero_report_are_distinct(self):
        empty = aggregate_quality_analysis([], filters())
        self.assertEqual(empty["status"], "no_records")
        self.assertEqual(empty["summary"]["report_count"], 0)
        self.assertIsNone(empty["summary"]["reported_defect_qty"])
        self.assertIsNone(empty["trend"][0]["reported_defect_qty"])
        unknown = aggregate_quality_analysis([source_row(defect_qty=None)], filters())
        self.assertEqual(unknown["summary"]["report_count"], 1)
        self.assertIsNone(unknown["summary"]["reported_defect_qty"])
        zero = aggregate_quality_analysis([source_row(defect_qty=0)], filters())
        self.assertEqual(zero["summary"]["reported_defect_qty"], 0)
        self.assertEqual(zero["summary"]["zero_defect_report_count"], 1)

    def test_partial_quantity_sum_preserves_coverage_without_rate(self):
        result = aggregate_quality_analysis([
            source_row(1, defect_qty=4, inspection_qty=2),
            source_row(2, defect_qty=None, inspection_qty=None),
            source_row(3, defect_qty=-1, inspection_qty=3),
        ], filters())
        self.assertEqual(result["summary"]["reported_defect_qty"], 4)
        self.assertEqual(result["summary"]["defect_quantity_record_count"], 1)
        self.assertEqual(result["data_quality"]["inconsistent_quantity_count"], 1)
        self.assertEqual(result["data_quality"]["invalid_quantity_count"], 1)
        self.assertEqual(result["data_quality"]["missing_defect_qty_count"], 1)
        self.assertEqual(result["data_quality"]["paired_quantity_record_count"], 1)
        self.assertNotIn("defect_rate", result["summary"])
        self.assertNotIn("yield", result["summary"])

    def test_pareto_uses_exclusive_types_and_reconciles_to_all_reports(self):
        result = aggregate_quality_analysis([
            source_row(1, phenomenon="擦伤 黑点", defect_qty=3),
            source_row(2, phenomenon="擦伤", defect_qty=2),
            source_row(3, phenomenon="", defect_qty=None),
            source_row(4, phenomenon="unrecognized synthetic observation", defect_qty=0),
        ], filters())
        self.assertEqual(sum(row["report_count"] for row in result["pareto"]), 4)
        self.assertEqual(sum(row["reported_defect_qty"] or 0 for row in result["pareto"]), 5)
        self.assertEqual(result["pareto"][-1]["cumulative_report_share_percent"], 100)
        self.assertEqual(result["data_quality"]["multi_type_count"], 1)
        self.assertEqual(result["data_quality"]["missing_phenomenon_count"], 1)
        self.assertEqual(result["data_quality"]["unclassified_type_count"], 1)

    def test_exact_duplicate_candidates_are_advisory_and_do_not_remove_quantities(self):
        result = aggregate_quality_analysis([source_row(1), source_row(2), source_row(3, defect_qty=3)], filters())
        self.assertEqual(result["summary"]["report_count"], 3)
        self.assertEqual(result["summary"]["reported_defect_qty"], 7)
        self.assertEqual(result["data_quality"]["duplicate_candidate_group_count"], 1)
        self.assertEqual(result["data_quality"]["duplicate_candidate_report_count"], 2)

    def test_machine_filter_does_not_inherit_unassigned_reports_or_change_option_scope(self):
        rows = [source_row(1), source_row(2, **{"excel_source__occurrence_location": "注塑"})]
        selected = aggregate_quality_analysis(rows, filters(machine_number=1))
        self.assertEqual(selected["summary"]["report_count"], 1)
        self.assertEqual(selected["data_quality"]["unassigned_machine_count"], 0)
        self.assertEqual(len(selected["options"]["machines"]), 2)
        unknown = aggregate_quality_analysis(rows, filters(machine_number="unknown"))
        self.assertEqual(unknown["summary"]["report_count"], 1)
        self.assertEqual(unknown["data_quality"]["unassigned_machine_count"], 1)

    def test_machine_identifiers_are_explicit_and_ambiguous_locations_remain_unknown(self):
        for value in ("IMM01", "1호기", "850T-1", "1号机", "机台1"):
            self.assertEqual(recorded_machine_number(value), 1, value)
        for value in ("注塑", "1", "IMM01 IMM02", "IMM01/02", "IMM01,02", "1/2호기", "1호기/2", "IMM01A", "IMM1.5", "1.5호기", "18号机"):
            self.assertIsNone(recorded_machine_number(value), value)

    def test_concentration_top_groups_keep_full_denominator_and_bounded_evidence_ids(self):
        rows = [source_row(index, part_no=f"PART-{index}") for index in range(1, 23)]
        rows += [source_row(index, part_no="REPEATED") for index in range(23, 31)]
        result = aggregate_quality_analysis(rows, filters())
        group = result["concentrations"]["parts"]
        self.assertEqual(group["total_group_count"], 23)
        self.assertEqual(len(group["items"]), 20)
        self.assertEqual(group["other_report_count"], 3)
        self.assertEqual(group["items"][0]["report_count"], 8)
        self.assertEqual(len(group["items"][0]["sample_report_ids"]), 5)
        self.assertAlmostEqual(group["items"][0]["share_of_reports_percent"], 26.67)

    def test_invalid_scope_parameters_and_large_ranges_are_rejected(self):
        for params in (
            {"start_date": "2026-02-30"}, {"end_date": "2027-01-01"},
            {"start_date": "2024-01-01", "end_date": "2026-01-01"},
            {"start_date": "2026-09-05", "end_date": "2026-09-04"},
            {"section": "all"}, {"machine_number": "01"}, {"machine_number": "18"},
            {"machine_number": "1.0"}, {"machine_number": ""},
            QueryDict("machine_number=1&machine_number=2"),
        ):
            with self.subTest(params=params), self.assertRaises(ValidationError):
                parse_analysis_filters(params, today=DAY)
        self.assertEqual(parse_analysis_filters({"end_date": "0001-01-01"}, today=DAY)["start_date"], date.min)

    @patch("quality.analysis.MAX_SOURCE_ROWS", 2)
    def test_source_limit_fails_instead_of_returning_truncated_totals(self):
        with self.assertRaises(ValidationError):
            aggregate_quality_analysis([source_row(1), source_row(2), source_row(3)], filters())


@override_settings(ROOT_URLCONF=__name__)
class QualityAnalysisApiTests(TestCase):
    def report(self, **changes):
        fields = source_row(**changes)
        fields.pop("id")
        fields.pop("updated_at")
        fields.pop("source_import_row__occurrence_location")
        location = fields.pop("excel_source__occurrence_location")
        return QualityReport.objects.create(**fields, excel_source={"occurrence_location": location})

    def test_query_uses_shanghai_calendar_day_and_one_joined_source_query(self):
        self.report(report_dt=datetime(2026, 9, 3, 16, tzinfo=datetime_timezone.utc))
        self.report(report_dt=datetime(2026, 9, 4, 15, 59, tzinfo=datetime_timezone.utc))
        self.report(report_dt=datetime(2026, 9, 4, 16, tzinfo=datetime_timezone.utc))
        self.report(report_dt=datetime(2026, 9, 3, 15, 59, tzinfo=datetime_timezone.utc))
        with self.assertNumQueries(1):
            result = build_quality_analysis(filters())
        self.assertEqual(result["summary"]["report_count"], 2)
        self.assertEqual(result["filters"]["date_basis"], "report_dt_calendar_day")

    def test_imported_source_location_takes_precedence_without_n_plus_one(self):
        report = self.report()
        batch = QualityImportBatch.objects.create(original_filename="synthetic.xlsx", sha256="a" * 64, file_size=1)
        QualityImportRow.objects.create(batch=batch, source_row_number=1, approved_report=report,
                                       occurrence_location="IMM02")
        with self.assertNumQueries(1):
            result = build_quality_analysis(filters(machine_number=2))
        self.assertEqual(result["summary"]["report_count"], 1)
        self.assertEqual(build_quality_analysis(filters(machine_number=1))["summary"]["report_count"], 0)

    def test_section_filter_applies_to_summary_trend_and_dimensions(self):
        self.report(section="LQC_INJ")
        self.report(section="OQC", defect_qty=10)
        result = build_quality_analysis(filters(section="OQC"))
        self.assertEqual(result["summary"]["reported_defect_qty"], 10)
        self.assertEqual(result["trend"][0]["report_count"], 1)
        self.assertEqual(result["concentrations"]["sections"]["items"][0]["key"], "OQC")

    def test_quality_read_permission_is_required_and_get_never_writes(self):
        client = APIClient()
        endpoint = "/api/quality/analysis/?start_date=2026-09-04&end_date=2026-09-04"
        self.assertIn(client.get(endpoint).status_code, (401, 403))
        user = get_user_model().objects.create_user(username="synthetic-reader")
        UserProfile.objects.filter(user=user).delete()
        user = get_user_model().objects.get(pk=user.pk)
        client.force_authenticate(user)
        self.assertEqual(client.get(endpoint).status_code, 403)
        profile = UserProfile.objects.create(user=user, can_view_quality=False)
        user = get_user_model().objects.get(pk=user.pk)
        client.force_authenticate(user)
        self.assertEqual(client.get(endpoint).status_code, 403)
        profile.can_view_quality = True
        profile.save(update_fields=["can_view_quality"])
        user = get_user_model().objects.get(pk=user.pk)
        client.force_authenticate(user)
        self.assertEqual(client.get(endpoint).status_code, 200)
        self.assertEqual(QualityReport.objects.count(), 0)
        self.assertEqual(client.post(endpoint, {}).status_code, 405)
