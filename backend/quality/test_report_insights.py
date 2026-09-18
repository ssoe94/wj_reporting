from datetime import date, datetime, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import DatabaseError
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord, UserProfile
from production.models import ProductionPlan

from .analysis import SHANGHAI, build_quality_analysis
from .models import QualityReport
from .report_insights import attribute_shots, build_operating_days, summarize_report


MONDAY = date(2026, 8, 31)
LABEL = {"ko": "스크래치", "zh": "擦伤"}


def scope(days=7, **changes):
    return {"start_date": MONDAY, "end_date": MONDAY + timedelta(days=days - 1), "section": None,
            "machine_number": None, **changes}


def sample(hours, value, *, machine=1, day=MONDAY):
    return {"machine_name": f"{machine}호기", "device_code": f"synthetic-{machine}",
            "timestamp": datetime.combine(day, datetime.min.time(), tzinfo=SHANGHAI) + timedelta(hours=hours),
            "capacity": value}


def quality_row(index, day, *, section="LQC_INJ", machine=1, part="PART-A", types=(("scratch", LABEL),)):
    return {"id": index, "date": day, "section": section, "machine_number": machine, "part_no": part,
            "model_display": "MODEL-A", "types": list(types)}


class OperatingCalendarTests(SimpleTestCase):
    def test_increase_is_dated_by_the_0800_business_day_and_split_across_the_boundary(self):
        shots, _ = attribute_shots([sample(6, 0), sample(7, 100), sample(9, 300)], MONDAY - timedelta(days=1), MONDAY)
        # 06-07h belongs to Sunday's business day; 07-09h is split evenly at 08:00.
        self.assertEqual(round(shots[MONDAY - timedelta(days=1)]["1호기"]), 200)
        self.assertEqual(round(shots[MONDAY]["1호기"]), 100)

    def test_long_collection_gap_and_counter_correction_add_no_dated_shots(self):
        shots, _ = attribute_shots([sample(9, 100), sample(40, 900), sample(41, 850)], MONDAY, MONDAY + timedelta(days=2))
        self.assertEqual(sum(sum(day.values()) for day in shots.values()), 0)

    def test_interleaved_devices_keep_their_own_counter_sequence(self):
        rows = sorted([sample(9, 0), sample(10, 400), sample(11, 900),
                       sample(9, 50, machine=2), sample(10, 50, machine=2), sample(11, 250, machine=2)],
                      key=lambda row: (row["machine_name"], row["timestamp"]))
        shots, _ = attribute_shots(rows, MONDAY, MONDAY)
        self.assertEqual({name: round(value) for name, value in shots[MONDAY].items()}, {"1호기": 900, "2호기": 200})

    def test_machine_three_uses_the_shared_capacity_factor(self):
        shots, _ = attribute_shots([sample(9, 0, machine=3), sample(10, 100, machine=3)], MONDAY, MONDAY)
        self.assertEqual(shots[MONDAY]["3호기"], 50)

    def test_a_sampled_date_is_observed_even_when_no_counter_moves(self):
        shots, observed = attribute_shots([sample(9, 500), sample(12, 500)], MONDAY, MONDAY)
        self.assertEqual(dict(shots), {})
        self.assertEqual(observed, {MONDAY})

    def test_a_few_shots_are_setup_not_production_even_with_a_stored_plan(self):
        shots = {MONDAY: {"1호기": 500.0, "2호기": 3.0}, MONDAY + timedelta(days=1): {"1호기": 60.0}}
        plans = {day: {"quantity": 1200.0, "machines": {4}} for day in (MONDAY + timedelta(days=1), MONDAY + timedelta(days=2))}
        days = build_operating_days(MONDAY, MONDAY + timedelta(days=2), range(1, 18), shots=shots, plans=plans)
        self.assertEqual([day["operating"] for day in days], [True, False, True])
        self.assertEqual((days[0]["shot_count"], days[0]["running_machine_count"]), (500, 1))
        self.assertEqual((days[2]["planned_quantity"], days[2]["planned_machine_count"]), (1200, 1))

    def test_a_plan_covers_an_unobserved_date_but_not_an_observed_idle_one(self):
        plans = {MONDAY: {"quantity": 900.0, "machines": {1}}}
        idle = build_operating_days(MONDAY, MONDAY, range(1, 18), shots={}, observed={MONDAY}, plans=plans)
        gap = build_operating_days(MONDAY, MONDAY, range(1, 18), shots={}, observed=set(), plans=plans)
        self.assertFalse(idle[0]["operating"])
        self.assertTrue(gap[0]["operating"])


class ReportSummaryTests(SimpleTestCase):
    def days(self, shots=None, plans=None, observed=None, first=MONDAY, last=MONDAY + timedelta(days=6)):
        return build_operating_days(first, last, range(1, 18), shots=shots, observed=observed, plans=plans)

    def test_idle_days_are_hidden_but_a_reported_idle_day_stays(self):
        shots = {MONDAY: {"1호기": 20_000.0}}
        rows = [quality_row(1, MONDAY), quality_row(2, MONDAY + timedelta(days=5))]
        result = summarize_report(rows, scope(), self.days(shots), operations_ready=True)
        displayed = [day["date"] for day in result["operations"]["days"] if day["displayed"]]
        self.assertEqual(displayed, ["2026-08-31", "2026-09-05"])
        summary = result["operations"]["summary"]
        self.assertEqual((summary["operating_day_count"], summary["report_count"]), (1, 2))
        self.assertEqual(summary["reports_per_operating_day"], 2.0)
        self.assertEqual(summary["injection_reports_per_10k_shots"], 1.0)

    def test_setup_shots_and_their_reports_stay_out_of_the_production_denominator(self):
        shots = {MONDAY: {"1호기": 10_000.0}, MONDAY + timedelta(days=1): {"1호기": 50.0}}
        rows = [quality_row(1, MONDAY), quality_row(2, MONDAY + timedelta(days=1))]
        result = summarize_report(rows, scope(), self.days(shots), operations_ready=True)
        summary = result["operations"]["summary"]
        self.assertEqual((summary["operating_day_count"], summary["shot_count"]), (1, 10_000))
        self.assertEqual(summary["injection_reports_per_10k_shots"], 2.0)
        self.assertEqual(result["operations"]["machines"], [{"machine_number": 1, "shot_count": 10_000,
                         "running_day_count": 1, "report_count": 2, "reports_per_10k_shots": 2.0}])
        # The setup day keeps its own report visible without becoming a production day.
        self.assertEqual([day["date"] for day in result["operations"]["days"] if day["displayed"]], ["2026-08-31", "2026-09-01"])

    def test_days_after_the_newest_stored_report_are_pending_not_zero_defect_days(self):
        shots = {MONDAY + timedelta(days=offset): {"1호기": 10_000.0} for offset in range(4)}
        rows = [quality_row(1, MONDAY), quality_row(2, MONDAY + timedelta(days=1))]
        result = summarize_report(rows, scope(), self.days(shots), operations_ready=True,
                                  reported_through=MONDAY + timedelta(days=1))
        days = result["operations"]["days"]
        self.assertEqual([day["date"] for day in days if day["displayed"]], ["2026-08-31", "2026-09-01"])
        self.assertEqual([day["pending"] for day in days[:3]], [False, False, True])
        summary = result["operations"]["summary"]
        self.assertEqual((summary["operating_day_count"], summary["shot_count"], summary["injection_reports_per_10k_shots"]), (2, 20_000, 1.0))
        self.assertEqual(result["operations"]["machines"][0]["shot_count"], 20_000)
        self.assertEqual(result["operations"]["reported_through"], "2026-09-01")

    def test_unavailable_sources_keep_every_date_and_withhold_rates(self):
        result = summarize_report([quality_row(1, MONDAY)], scope(), self.days(), operations_ready=False)
        self.assertEqual(result["operations"]["status"], "unavailable")
        self.assertTrue(all(day["displayed"] for day in result["operations"]["days"]))
        self.assertIsNone(result["operations"]["summary"]["reports_per_operating_day"])

    def test_shot_rate_counts_injection_reports_only_and_is_withheld_for_other_sections(self):
        shots = {MONDAY: {"1호기": 10_000.0}}
        rows = [quality_row(1, MONDAY), quality_row(2, MONDAY, section="OQC", machine=None)]
        result = summarize_report(rows, scope(), self.days(shots), operations_ready=True)
        self.assertEqual(result["operations"]["summary"]["injection_reports_per_10k_shots"], 1.0)
        self.assertEqual(result["operations"]["machines"], [{"machine_number": 1, "shot_count": 10_000,
                         "running_day_count": 1, "report_count": 1, "reports_per_10k_shots": 1.0}])
        other = summarize_report(rows[1:], scope(section="OQC"), self.days(shots), operations_ready=True)
        self.assertIsNone(other["operations"]["summary"]["injection_reports_per_10k_shots"])
        self.assertEqual(other["operations"]["machines"], [])

    def test_weeks_follow_monday_boundaries_with_their_top_type(self):
        shots = {MONDAY + timedelta(days=offset): {"1호기": 1000.0} for offset in (0, 1, 7)}
        gas = ("gas", {"ko": "가스", "zh": "气痕"})
        rows = [quality_row(1, MONDAY), quality_row(2, MONDAY + timedelta(days=1), types=(gas,)),
                quality_row(3, MONDAY + timedelta(days=1), types=(gas,)), quality_row(4, MONDAY + timedelta(days=7))]
        result = summarize_report(rows, scope(days=10), self.days(shots, last=MONDAY + timedelta(days=9)), operations_ready=True)
        self.assertEqual([(week["week_start"], week["week_end"], week["report_count"], week["operating_day_count"])
                          for week in result["weekly"]], [("2026-08-31", "2026-09-06", 3, 2), ("2026-09-07", "2026-09-09", 1, 1)])
        self.assertEqual(result["weekly"][0]["top_type"]["key"], "gas")
        self.assertEqual(result["weekly"][0]["reports_per_operating_day"], 1.5)

    def test_recurring_requires_two_reports_and_ranks_by_distinct_days(self):
        rows = [quality_row(1, MONDAY), quality_row(2, MONDAY + timedelta(days=2)),
                quality_row(3, MONDAY, part="PART-B"), quality_row(4, MONDAY, part="PART-B"),
                quality_row(5, MONDAY, part="PART-C")]
        recurring = summarize_report(rows, scope(), self.days(), operations_ready=True)["recurring"]
        self.assertEqual([(item["part_no"], item["report_count"], item["day_count"]) for item in recurring],
                         [("PART-A", 2, 2), ("PART-B", 2, 1)])
        self.assertEqual(recurring[0]["first_date"], "2026-08-31")
        self.assertEqual(recurring[0]["sample_report_ids"], [1, 2])

    def test_comparison_uses_previous_operating_days_and_type_changes(self):
        first = MONDAY - timedelta(days=7)
        shots = {first: {"1호기": 100.0}, first + timedelta(days=1): {"1호기": 100.0}, MONDAY: {"1호기": 100.0}}
        previous = {"start_date": first, "end_date": MONDAY - timedelta(days=1), "report_count": 4,
                    "type_pareto": [{"key": "scratch", "label": LABEL, "report_count": 3},
                                    {"key": "burr", "label": {"ko": "버", "zh": "毛边"}, "report_count": 1}]}
        result = summarize_report([quality_row(1, MONDAY)], scope(), self.days(shots, first=first),
                                  operations_ready=True, previous=previous)
        comparison = result["comparison"]
        self.assertEqual((comparison["report_count"], comparison["operating_day_count"], comparison["reports_per_operating_day"]), (4, 2, 2.0))
        self.assertEqual([(item["key"], item["change"]) for item in comparison["types"]], [("scratch", -2), ("burr", -1)])
        self.assertEqual(len(result["operations"]["days"]), 7)


class ReportSourceTests(TestCase):
    def setUp(self):
        for hours, value in ((9, 0), (10, 400), (11, 900)):
            InjectionMonitoringRecord.objects.create(**sample(hours, value))
        ProductionPlan.objects.create(plan_date=MONDAY + timedelta(days=1), plan_type="injection", machine_name="2호기",
                                      part_no="PART-A", planned_quantity=500, sequence=1)
        ProductionPlan.objects.create(plan_date=MONDAY + timedelta(days=2), plan_type="machining", machine_name="A1",
                                      part_no="PART-A", planned_quantity=500, sequence=1)
        # The report after the selected week keeps its later days from being pending entry.
        for day, phenomenon in ((MONDAY, "擦伤"), (MONDAY - timedelta(days=3), "擦伤"), (MONDAY + timedelta(days=10), "擦伤")):
            QualityReport.objects.create(report_dt=datetime.combine(day, datetime.min.time(), tzinfo=SHANGHAI) + timedelta(hours=10),
                                         section="LQC_INJ", model="MODEL-A", part_no="PART-A", phenomenon=phenomenon)

    def test_endpoint_builder_joins_plan_mes_and_previous_period(self):
        result = build_quality_analysis(scope(), include_production_context=True, include_report=True)
        report = result["report"]
        self.assertEqual(report["operations"]["status"], "ready")
        self.assertEqual([day["date"] for day in report["operations"]["days"] if day["operating"]], ["2026-08-31", "2026-09-01"])
        self.assertEqual(report["operations"]["summary"]["shot_count"], 900)
        self.assertEqual(report["comparison"]["report_count"], 1)
        self.assertEqual(report["comparison"]["previous_start"], "2026-08-24")
        self.assertEqual(result["summary"]["report_count"], 1)

    def test_machine_filter_limits_plan_and_mes_evidence(self):
        report = build_quality_analysis(scope(machine_number=2), include_report=True)["report"]
        self.assertEqual([day["date"] for day in report["operations"]["days"] if day["operating"]], ["2026-09-01"])

    def test_source_failure_keeps_the_core_analysis(self):
        with patch("quality.report_insights._load_shots", side_effect=DatabaseError):
            result = build_quality_analysis(scope(), include_report=True)
        self.assertEqual(result["report"]["operations"]["status"], "unavailable")
        self.assertEqual(result["summary"]["report_count"], 1)

    def test_long_ranges_skip_the_comparison(self):
        result = build_quality_analysis(scope(days=120), include_report=True)
        self.assertIsNone(result["report"]["comparison"])


@override_settings(ROOT_URLCONF="quality.test_analysis")
class ReportEndpointTests(TestCase):
    def test_permission_precedes_source_reads_and_a_source_failure_keeps_the_report(self):
        client = APIClient()
        endpoint = "/api/quality/analysis/?start_date=2026-08-31&end_date=2026-08-31&section=LQC_INJ"
        user = get_user_model().objects.create_user(username="synthetic-report-reader")
        UserProfile.objects.filter(user=user).update(can_view_quality=False)
        client.force_authenticate(get_user_model().objects.get(pk=user.pk))
        with patch("quality.report_insights.InjectionMonitoringRecord.objects.filter") as source:
            self.assertEqual(client.get(endpoint).status_code, 403)
            source.assert_not_called()
        UserProfile.objects.filter(user=user).update(can_view_quality=True)
        client.force_authenticate(get_user_model().objects.get(pk=user.pk))
        QualityReport.objects.create(report_dt=datetime.combine(MONDAY, datetime.min.time(), tzinfo=SHANGHAI) + timedelta(hours=10),
                                     section="LQC_INJ", defect_qty=0)
        with patch("quality.report_insights.InjectionMonitoringRecord.objects.filter", side_effect=DatabaseError("synthetic")):
            response = client.get(endpoint)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["summary"]["report_count"], 1)
        self.assertEqual(response.data["summary"]["reported_defect_qty"], 0)
        self.assertEqual(response.data["report"]["operations"]["status"], "unavailable")
        self.assertTrue(all(day["displayed"] for day in response.data["report"]["operations"]["days"]))
