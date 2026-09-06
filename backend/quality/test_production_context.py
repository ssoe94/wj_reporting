from datetime import date, datetime, timedelta
from unittest.mock import patch

from django.db import DatabaseError
from django.test import SimpleTestCase, TestCase

from injection.models import InjectionReport
from production.models import ProductionExecution, ProductionPlan

from .analysis import SHANGHAI, aggregate_quality_analysis, build_quality_analysis
from .models import QualityReport
from .production_context import BASES, SUMMARY_FIELDS, _aggregate, _model_display, _resolve, build_production_context
from .test_analysis import filters, source_row


DAY = date(2026, 9, 4)


def report(index=1, **changes):
    return source_row(index, model="SYNTH-M45", **{
        "excel_source__occurrence_location": "注塑",
        "excel_source__item_name": "B/C", **changes,
    })


def selected(rows, **scope):
    collected = []
    result = aggregate_quality_analysis(rows, filters(**scope), context_rows=collected)
    return result, collected


def key():
    return DAY, "SYNTHETIC-PART"


class ProductionContextCalculationTests(SimpleTestCase):
    def test_quality_model_and_item_are_primary_and_quantities_keep_null_and_zero(self):
        _, rows = selected([report(1, defect_qty=0), report(2, defect_qty=None)])
        result = _aggregate(rows, {}, {})
        group = result["model_parts"]["items"][0]
        self.assertEqual(group["label"], "SYNTH-M45 - B/C")
        self.assertEqual(group["model_display"], "SYNTH-M45 - B/C")
        self.assertEqual(group["part_no"], "SYNTHETIC-PART")
        self.assertIsNone(group["machine_number"])
        self.assertEqual(group["report_count"], 2)
        self.assertEqual(group["defect_quantity_record_count"], 1)
        self.assertEqual(group["reported_defect_qty"], 0)
        self.assertEqual(result["summary"]["unmatched_count"], 2)

    def test_different_models_for_one_part_are_separate_stable_groups(self):
        sources = [report(1), {**report(2), "model": "SYNTH-M46"}]
        _, rows = selected(sources)
        first = _aggregate(rows, {}, {})["model_parts"]
        second = _aggregate(list(reversed(rows)), {}, {})["model_parts"]
        self.assertEqual(first["total_group_count"], 2)
        self.assertEqual([row["key"] for row in first["items"]], [row["key"] for row in second["items"]])

    def test_missing_model_is_counted_even_when_an_item_name_is_available(self):
        _, rows = selected([{**report(), "model": ""}])
        result = _aggregate(rows, {}, {})
        self.assertEqual(result["summary"]["missing_model_count"], 1)
        self.assertEqual(result["model_parts"]["items"][0]["model_display"], "")
        self.assertEqual(result["model_parts"]["items"][0]["label"], "SYNTHETIC-PART")

    def test_exact_product_family_aliases_do_not_duplicate_existing_model_tokens(self):
        for model, item, expected in (
            ("45GX95", "BC", "45GX95 - B/C"),
            ("45GX95 - B/C", "B/C", "45GX95 - B/C"),
            ("45GX95 - BC", "B/C", "45GX95 - B/C"),
            ("SYNTH-M45 (CA)", "C/A", "SYNTH-M45 (C/A)"),
            ("SYNTH-M45", "GP", "SYNTH-M45 - G/P"),
            ("ABC95", "BC", "ABC95 - B/C"),
            ("", "B/C", ""),
        ):
            with self.subTest(model=model, item=item):
                self.assertEqual(_model_display(model, item), expected)

    def test_linked_source_item_takes_precedence_and_is_not_replaced_when_blank(self):
        _, rows = selected([report(**{"source_import_row__item_name": "C/A"}),
                            report(2, **{"source_import_row__item_name": ""})])
        self.assertEqual(rows[0]["model_display"], "SYNTH-M45 - C/A")
        self.assertEqual(rows[1]["model_display"], "SYNTH-M45")

    def test_production_evidence_and_agreeing_plan_prefer_production_basis(self):
        _, rows = selected([report()])
        self.assertEqual(_resolve(rows[0], {key(): {("SYNTH-M45", 2)}},
                                  {key(): {("SYNTH-M45", 2)}}), (2, "production_record"))
        self.assertEqual(_resolve(rows[0], {}, {key(): {("SYNTH-M45", 2)}}), (2, "stored_plan"))

    def test_multiple_machines_source_conflicts_and_unidentified_candidates_are_ambiguous(self):
        _, rows = selected([report()])
        for actual, plans in (
            ({key(): {("SYNTH-M45", 1), ("SYNTH-M45", 2)}}, {}),
            ({key(): {("SYNTH-M45", 1)}}, {key(): {("SYNTH-M45", 2)}}),
            ({key(): {("SYNTH-M45", None)}}, {key(): {("SYNTH-M45", 2)}}),
        ):
            with self.subTest(actual=actual, plans=plans):
                self.assertEqual(_resolve(rows[0], actual, plans), (None, "ambiguous"))

    def test_model_must_match_when_present_and_can_be_omitted_only_when_missing(self):
        _, rows = selected([report(), {**report(2), "model": ""}])
        actual = {key(): {("DIFFERENT-MODEL", 2)}}
        self.assertEqual(_resolve(rows[0], actual, {}), (None, "ambiguous"))
        self.assertEqual(_resolve(rows[1], actual, {}), (2, "production_record"))
        self.assertEqual(_resolve(rows[0], {(DAY, "SYNTHETIC-PART-SUFFIX"): {("SYNTH-M45", 2)}}, {}),
                         (None, "unmatched"))

    def test_recorded_machine_is_never_overwritten_and_non_injection_is_not_inferred(self):
        _, rows = selected([report(**{"excel_source__occurrence_location": "IMM01"}), report(2, section="OQC")])
        result = _aggregate(rows, {key(): {("SYNTH-M45", 2)}}, {})
        self.assertEqual(result["summary"]["ambiguous_count"], 1)
        self.assertEqual(result["summary"]["not_injection_count"], 1)
        machines = {row["machine_number"] for row in result["machine_models"]["items"]}
        self.assertEqual(machines, {1, None})

    def test_imported_date_remains_recorded_day_but_manual_early_time_uses_previous_business_day(self):
        early = datetime(2026, 9, 4, 7, tzinfo=SHANGHAI)
        _, rows = selected([report(1, report_dt=early),
                            report(2, report_dt=early, excel_import_key="synthetic-key"),
                            report(3, report_dt=early, **{"source_import_row__id": 10})])
        self.assertEqual([row["business_date"] for row in rows], [DAY - timedelta(days=1), DAY, DAY])

    def test_context_selection_exactly_matches_core_calendar_section_and_recorded_machine_scope(self):
        sources = [report(1), report(2, **{"excel_source__occurrence_location": "IMM01"}),
                   report(3, section="OQC"), report(4, report_dt=datetime(2026, 9, 5, 0, tzinfo=SHANGHAI))]
        result, rows = selected(sources, section="LQC_INJ", machine_number="unknown")
        context = _aggregate(rows, {}, {key(): {("SYNTH-M45", 1)}})
        self.assertEqual(result["summary"]["report_count"], 1)
        self.assertEqual(context["summary"]["report_count"], 1)
        self.assertEqual(rows[0]["id"], 1)
        self.assertEqual(context["machine_models"]["items"][0]["machine_number"], 1)
        self.assertEqual(result["concentrations"]["machines"]["items"][0]["key"], "unknown")

    def test_concentrations_keep_full_denominator_bounded_samples_and_all_six_basis_totals(self):
        _, rows = selected([report(index, part_no=f"SYNTH-{index}") for index in range(1, 24)]
                           + [report(index) for index in range(24, 32)])
        result = _aggregate(rows, {}, {})
        self.assertEqual(sum(result["summary"][field] for field in SUMMARY_FIELDS.values()), len(rows))
        for name in ("model_parts", "machine_models"):
            concentration = result[name]
            self.assertEqual(len(concentration["items"]), 20)
            self.assertEqual(concentration["total_group_count"], 24)
            self.assertEqual(sum(row["report_count"] for row in concentration["items"]) + concentration["other_report_count"], len(rows))
            self.assertEqual(len(concentration["items"][0]["sample_report_ids"]), 5)
            for row in concentration["items"]:
                self.assertEqual(sum(row["match_basis_counts"][basis] for basis in BASES), row["report_count"])


class ProductionContextQueryTests(TestCase):
    def quality(self, *, model="SYNTH-M45", part="SYNTHETIC-PART", location="注塑", defect=0, hour=10):
        return QualityReport.objects.create(report_dt=datetime(2026, 9, 4, hour, tzinfo=SHANGHAI),
                                            section="LQC_INJ", model=model, part_no=part, defect_qty=defect,
                                            phenomenon="擦伤", excel_source={"occurrence_location": location, "item_name": "B/C"})

    def daily(self, *, machine=2, part="SYNTHETIC-PART", model="SYNTH-M45", quantity=10, day=DAY):
        return InjectionReport.objects.create(date=day, machine_no=machine, tonnage="SYNTHETIC",
                                              model=model, section="B/C", part_no=part,
                                              plan_qty=10, actual_qty=quantity, reported_defect=0, actual_defect=0)

    def plan(self, *, machine="2호기", quantity=10, part="SYNTHETIC-PART", day=DAY):
        return ProductionPlan.objects.create(plan_date=day, plan_type="injection", machine_name=machine,
                                             model_name="SYNTH-M45", part_no=part, planned_quantity=quantity)

    def execution(self, *, status="completed", quantity=10):
        return ProductionExecution.objects.create(plan_date=DAY, plan_type="injection", machine_name="2호기",
                                                  model_name="SYNTH-M45", part_no="SYNTHETIC-PART",
                                                  actual_qty=quantity, status=status)

    def test_default_one_quality_query_is_preserved_and_optional_context_uses_three_bounded_source_queries(self):
        self.quality()
        self.daily()
        self.daily()  # Duplicate source evidence is one candidate, not two quality incidents.
        self.execution()
        self.plan()
        with self.assertNumQueries(1):
            baseline = build_quality_analysis(filters())
        with self.assertNumQueries(4):
            result = build_quality_analysis(filters(), include_production_context=True)
        context = result.pop("production_context")
        baseline["freshness"].pop("generated_at")
        result["freshness"].pop("generated_at")
        self.assertEqual(result, baseline)
        self.assertEqual(context["summary"]["production_record_match_count"], 1)
        self.assertEqual(context["machine_models"]["items"][0]["machine_number"], 2)

    def test_zero_and_pending_executions_are_not_positive_production_evidence(self):
        self.quality()
        self.daily(quantity=0)
        self.execution(status="pending")
        self.plan()
        result = build_quality_analysis(filters(), include_production_context=True)["production_context"]
        self.assertEqual(result["summary"]["plan_match_count"], 1)

    def test_manual_early_report_queries_previous_business_date_without_expanding_quality_scope(self):
        self.quality(hour=7)
        self.daily(day=DAY - timedelta(days=1))
        result = build_quality_analysis(filters(), include_production_context=True)
        self.assertEqual(result["summary"]["report_count"], 1)
        self.assertEqual(result["production_context"]["summary"]["production_record_match_count"], 1)

    def test_shared_source_cap_excludes_all_partial_attribution_but_keeps_quality_labels_and_counts(self):
        self.quality()
        self.daily()
        self.execution()
        self.plan()
        with patch("quality.production_context.MAX_PRODUCTION_ROWS", 2):
            result = build_quality_analysis(filters(), include_production_context=True)
        context = result["production_context"]
        self.assertEqual(context["status"], "unavailable")
        self.assertEqual(context["summary"]["unmatched_count"], 1)
        self.assertEqual(context["summary"]["production_record_match_count"], 0)
        self.assertEqual(context["model_parts"]["items"][0]["reported_defect_qty"], 0)
        self.assertIn("source_row_limit_exceeded", context["limitations"][-1])
        self.assertEqual(result["summary"]["report_count"], 1)

    def test_database_failure_retains_core_and_recorded_only_context_without_silent_partial_matches(self):
        self.quality(location="IMM01", defect=None)
        self.daily(machine=1)
        with patch("quality.production_context.ProductionExecution.objects.filter", side_effect=DatabaseError("synthetic")):
            result = build_quality_analysis(filters(), include_production_context=True)
        context = result["production_context"]
        self.assertEqual(context["status"], "unavailable")
        self.assertEqual(context["summary"]["recorded_only_count"], 1)
        self.assertEqual(context["machine_models"]["items"][0]["machine_number"], 1)
        self.assertIsNone(result["summary"]["reported_defect_qty"])

    def test_empty_or_non_injection_context_does_not_query_production(self):
        with self.assertNumQueries(0):
            empty = build_production_context([])
        self.assertEqual(empty["summary"]["report_count"], 0)
        self.assertEqual(empty["model_parts"]["items"], [])
        _, rows = selected([report(section="OQC")])
        with self.assertNumQueries(0):
            context = build_production_context(rows)
        self.assertEqual(context["summary"]["not_injection_count"], 1)

    def test_production_machine_number_is_explicit_and_full_part_is_required(self):
        self.quality()
        self.daily(machine=None)
        self.plan(machine="2호기", part="SYNTHETIC-PART-SUFFIX")
        result = build_quality_analysis(filters(), include_production_context=True)["production_context"]
        self.assertEqual(result["summary"]["ambiguous_count"], 1)
        self.assertIsNone(result["machine_models"]["items"][0]["machine_number"])
