from datetime import datetime, timedelta
import json

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from production.ai_metrics import SHANGHAI_TZ
from production.models import ProductionPlan
from quality.daily_attention import (
    build_daily_quality_attention,
    build_daily_quality_attention_ai_input,
    quality_attention_evidence_snapshot,
)
from quality.models import QualityReport

from .models import AiJob
from .quality_daily import (
    QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
    QUALITY_DAILY_MODE,
    QUALITY_DAILY_MODEL_ID,
    QUALITY_DAILY_TRIGGER,
    enqueue_daily_quality_summary,
    quality_daily_report_for_page,
    quality_summary_for_overview,
    restore_authoritative_quality_result,
)


class DailyQualitySummaryTests(TestCase):
    def setUp(self):
        cache.clear()

    def _local(self, hour: int, minute: int = 0):
        return SHANGHAI_TZ.localize(datetime(2026, 8, 12, hour, minute))

    def _plan(self, *, machine="850T-1", quantity=1000, updated_at=None):
        plan = ProductionPlan.objects.create(
            plan_date=datetime(2026, 8, 12).date(),
            plan_type="injection",
            machine_name=machine,
            model_name="MODEL-A",
            part_no="ABC123456-X",
            lot_no="LOT-1",
            planned_quantity=quantity,
            sequence=1,
        )
        if updated_at:
            ProductionPlan.objects.filter(pk=plan.pk).update(updated_at=updated_at)
            plan.refresh_from_db()
        return plan

    def test_before_07_does_not_enqueue(self):
        self._plan(updated_at=self._local(6, 0))

        result = enqueue_daily_quality_summary(self._local(6, 59))

        self.assertEqual(result["status"], "before_schedule")
        self.assertFalse(AiJob.objects.exists())

    def test_at_07_enqueues_one_qwen38_bilingual_job_and_is_idempotent(self):
        self._plan(updated_at=self._local(6, 50))

        first = enqueue_daily_quality_summary(self._local(7, 0))
        second = enqueue_daily_quality_summary(self._local(7, 1))

        self.assertEqual(first["status"], "created")
        self.assertEqual(second["status"], "exists")
        self.assertEqual(AiJob.objects.count(), 1)
        job = AiJob.objects.get()
        self.assertEqual(job.job_type, AiJob.JOB_TYPE_QUALITY_IMAGE)
        self.assertEqual(job.scope["mode"], QUALITY_DAILY_MODE)
        self.assertEqual(job.scope["trigger"], QUALITY_DAILY_TRIGGER)
        self.assertEqual(job.scope["model_id"], QUALITY_DAILY_MODEL_ID)
        self.assertEqual(job.scope["language"], "bilingual")
        self.assertEqual(job.input_payload["summary_basis"]["history_coverage"], "all_history")
        self.assertEqual(job.input_payload["summary_basis"]["match_basis"], "part_prefix_9")
        self.assertEqual(
            job.input_payload["report_metrics"]["schema_version"],
            "quality-daily-report.v1",
        )
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload={
                "llm_fallback": False,
                "report": {"schema_version": "quality-daily-report-narrative.v1"},
            },
            completed_at=self._local(7, 1),
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )
        completed_duplicate = enqueue_daily_quality_summary(self._local(7, 2))
        self.assertEqual(completed_duplicate["status"], "exists")
        self.assertEqual(AiJob.objects.count(), 1)

    def test_no_plan_does_not_create_false_empty_summary(self):
        result = enqueue_daily_quality_summary(self._local(7, 30))
        page_report = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report={"coverage": {"matched_report_count": 0}},
        )

        self.assertEqual(result["status"], "no_plan")
        self.assertFalse(AiJob.objects.exists())
        self.assertEqual(page_report["status"], "unavailable")
        self.assertEqual(page_report["reason"], "no_plan")
        self.assertIsNone(page_report["narrative"])

    def test_changed_plan_waits_five_minutes_then_replaces_active_job(self):
        plan = self._plan(updated_at=self._local(6, 30))
        first = enqueue_daily_quality_summary(self._local(7, 0))
        old_hash = first["source_plan_hash"]

        ProductionPlan.objects.filter(pk=plan.pk).update(
            planned_quantity=1400,
            updated_at=self._local(10, 30),
        )
        waiting = enqueue_daily_quality_summary(self._local(10, 34))
        replacement = enqueue_daily_quality_summary(self._local(10, 35))

        self.assertEqual(waiting["status"], "debouncing")
        self.assertEqual(replacement["status"], "created")
        self.assertNotEqual(replacement["source_plan_hash"], old_hash)
        self.assertEqual(AiJob.objects.count(), 2)
        first["job"].refresh_from_db()
        self.assertEqual(first["job"].status, AiJob.STATUS_CANCELLED)
        self.assertEqual(replacement["job"].status, AiJob.STATUS_PENDING)

    def test_changed_quality_evidence_becomes_stale_then_requeues_after_debounce(self):
        self._plan(updated_at=self._local(6, 30))
        report = QualityReport.objects.create(
            report_dt=self._local(6, 0),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-HISTORY",
            judgement="NG",
            phenomenon="白化",
        )
        QualityReport.objects.filter(pk=report.pk).update(updated_at=self._local(6, 30))
        created = enqueue_daily_quality_summary(self._local(7, 0))
        old_hash = created["source_evidence_hash"]
        job = created["job"]
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload={
                "schema_version": "quality-daily-attention-ai.v1",
                "source_plan_hash": job.scope["source_plan_hash"],
                "source_evidence_hash": old_hash,
                "generation_source": "local_llm_rewrite",
                "llm_fallback": False,
                "report": {
                    "schema_version": "quality-daily-report-narrative.v1",
                    "executive_summary": {"ko": "기록 확인", "zh": "确认记录"},
                    "repeated_issues": [],
                    "accelerating_issues": [],
                    "affected_targets": [],
                    "shift_checks": {"ko": [], "zh": []},
                    "caveats": {"ko": [], "zh": []},
                },
                "attention_items": [],
            },
            completed_at=self._local(7, 5),
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

        QualityReport.objects.filter(pk=report.pk).update(
            phenomenon="黑点",
            updated_at=self._local(10, 30),
        )
        # Simulate the bounded five-minute snapshot expiring.
        cache.clear()
        current = build_daily_quality_attention(
            datetime(2026, 8, 12).date(),
            include_images=False,
        )
        stale = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=current["report_metrics"],
            source_plan_hash=current["source_plan_hash"],
            source_evidence_hash=current["source_evidence_hash"],
        )
        waiting = enqueue_daily_quality_summary(self._local(10, 34))
        replacement = enqueue_daily_quality_summary(self._local(10, 35))

        self.assertNotEqual(current["source_evidence_hash"], old_hash)
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["reason"], "evidence_changed")
        self.assertIsNone(stale["narrative"])
        self.assertEqual(waiting["status"], "evidence_debouncing")
        self.assertEqual(replacement["status"], "created")
        self.assertEqual(
            replacement["job"].scope["source_evidence_hash"],
            current["source_evidence_hash"],
        )
        self.assertEqual(
            replacement["job"].input_payload["source_evidence_hash"],
            current["source_evidence_hash"],
        )

    def test_evidence_snapshot_is_cached_and_force_refresh_detects_change(self):
        self._plan()
        report = QualityReport.objects.create(
            report_dt=self._local(6, 0),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-HISTORY",
            judgement="NG",
            phenomenon="白化",
        )
        first = quality_attention_evidence_snapshot(datetime(2026, 8, 12).date())
        QualityReport.objects.filter(pk=report.pk).update(
            phenomenon="黑点",
            updated_at=self._local(10, 30),
        )

        cached = quality_attention_evidence_snapshot(datetime(2026, 8, 12).date())
        refreshed = quality_attention_evidence_snapshot(
            datetime(2026, 8, 12).date(),
            force_refresh=True,
        )

        self.assertEqual(cached["source_evidence_hash"], first["source_evidence_hash"])
        self.assertNotEqual(refreshed["source_evidence_hash"], first["source_evidence_hash"])

    def test_fallback_completion_retries_same_job_after_cooldown(self):
        self._plan(updated_at=self._local(6, 30))
        created = enqueue_daily_quality_summary(self._local(7, 0))
        job = created["job"]
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload={"llm_fallback": True, "llm_fallback_code": "model_unavailable"},
            completed_at=self._local(7, 1),
            updated_at=self._local(7, 1),
        )

        unavailable = quality_summary_for_overview(datetime(2026, 8, 12).date())
        page_unavailable = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=job.input_payload["report_metrics"],
            source_plan_hash=job.scope["source_plan_hash"],
        )
        cooldown = enqueue_daily_quality_summary(self._local(7, 4))
        retried = enqueue_daily_quality_summary(self._local(7, 6))

        self.assertEqual(unavailable["status"], "unavailable")
        self.assertEqual(unavailable["reason"], "llm_fallback")
        self.assertEqual(page_unavailable["status"], "unavailable")
        self.assertEqual(page_unavailable["reason"], "llm_fallback")
        self.assertIsNone(page_unavailable["narrative"])
        self.assertEqual(cooldown["status"], "retry_cooldown")
        self.assertEqual(retried["status"], "retried")
        self.assertEqual(AiJob.objects.count(), 1)
        job.refresh_from_db()
        self.assertEqual(job.status, AiJob.STATUS_PENDING)
        self.assertEqual(job.result_payload, {})

    def test_pre_report_completion_is_retried_after_cooldown(self):
        self._plan(updated_at=self._local(6, 30))
        created = enqueue_daily_quality_summary(self._local(7, 0))
        job = created["job"]
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload={
                "generation_source": "local_llm_rewrite",
                "llm_fallback": False,
                "source_plan_hash": job.scope["source_plan_hash"],
                "source_evidence_hash": job.scope["source_evidence_hash"],
            },
            completed_at=self._local(7, 1),
            updated_at=self._local(7, 1),
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

        page_report = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=job.input_payload["report_metrics"],
            source_plan_hash=job.scope["source_plan_hash"],
        )
        cooldown = enqueue_daily_quality_summary(self._local(7, 4))
        retried = enqueue_daily_quality_summary(self._local(7, 6))

        self.assertEqual(page_report["status"], "unavailable")
        self.assertEqual(page_report["reason"], "not_generated")
        self.assertIsNone(page_report["narrative"])
        self.assertEqual(cooldown["status"], "retry_cooldown")
        self.assertEqual(retried["status"], "retried")
        job.refresh_from_db()
        self.assertEqual(job.status, AiJob.STATUS_PENDING)

    def test_old_prompt_completion_is_retried_after_cooldown(self):
        self._plan(updated_at=self._local(6, 30))
        created = enqueue_daily_quality_summary(self._local(7, 0))
        job = created["job"]
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload={
                "generation_source": "local_llm_rewrite",
                "llm_fallback": False,
                "source_plan_hash": job.scope["source_plan_hash"],
                "source_evidence_hash": job.scope["source_evidence_hash"],
                "report": {"schema_version": "quality-daily-report-narrative.v1"},
            },
            completed_at=self._local(7, 1),
            updated_at=self._local(7, 1),
            prompt_version="quality-daily-attention-gemma-v2",
        )

        page_before_retry = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=job.input_payload["report_metrics"],
            source_plan_hash=job.scope["source_plan_hash"],
            source_evidence_hash=job.scope["source_evidence_hash"],
        )
        overview_before_retry = quality_summary_for_overview(
            datetime(2026, 8, 12).date()
        )
        cooldown = enqueue_daily_quality_summary(self._local(7, 4))
        retried = enqueue_daily_quality_summary(self._local(7, 16))

        self.assertEqual(page_before_retry["status"], "unavailable")
        self.assertEqual(
            page_before_retry["llm_fallback_code"],
            "outdated_prompt_version",
        )
        self.assertEqual(overview_before_retry["status"], "unavailable")
        self.assertEqual(
            overview_before_retry["llm_fallback_code"],
            "outdated_prompt_version",
        )
        self.assertEqual(cooldown["status"], "retry_cooldown")
        self.assertEqual(retried["status"], "retried")
        job.refresh_from_db()
        self.assertEqual(job.status, AiJob.STATUS_PENDING)
        self.assertEqual(job.prompt_version, "")
        self.assertEqual(
            job.scope["selection_contract_version"],
            QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )
        self.assertEqual(
            job.input_payload["selection_contract_version"],
            QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

    def test_all_history_totals_deduplicate_shared_report_across_machines(self):
        self._plan(machine="850T-1")
        self._plan(machine="850T-2")
        report = QualityReport.objects.create(
            report_dt=self._local(7, 0) - timedelta(days=900),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC 123456-OLD",
            judgement="NG",
            phenomenon="게이트 백화",
            disposition="초품 외관 확인",
            action_result="조건 조정",
        )

        source = build_daily_quality_attention(datetime(2026, 8, 12).date(), include_images=False)
        ai_input = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )

        self.assertEqual(source["total_matching_reports"], 1)
        self.assertEqual([item["matching_report_count"] for item in source["items"]], [1, 1])
        self.assertEqual(ai_input["totals"]["matched_report_count"], 1)
        self.assertEqual(len(ai_input["evidence_catalog"]), 1)
        evidence = ai_input["evidence_catalog"][0]
        self.assertEqual(evidence["report_refs"][0]["report_id"], report.id)
        self.assertEqual(evidence["action_results"][0]["count"], 1)
        self.assertTrue(evidence["phenomena"][0]["evidence_key"].startswith("ABC123456:phenomenon:"))

    def test_page_report_metrics_calculate_repeat_trend_and_plan_impact(self):
        self._plan(machine="850T-1")
        self._plan(machine="850T-2")
        for days_ago, phenomenon in (
            (1, "게이트 백화"),
            (2, "게이트 백화"),
            (3, "게이트 백화"),
            (4, "스크래치"),
            (5, "스크래치"),
            (31, "게이트 백화"),
            (32, "기타 현상"),
            (33, "기타 현상"),
            (34, "기타 현상"),
            (35, "기타 현상"),
        ):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=days_ago),
                section="LQC_INJ",
                model="MODEL-A",
                part_no="ABC123456-HISTORY",
                judgement="NG",
                phenomenon=phenomenon,
            )

        source = build_daily_quality_attention(
            datetime(2026, 8, 12).date(),
            include_images=False,
        )
        metrics = source["report_metrics"]
        gate = next(
            row for row in metrics["problem_types"]
            if row.get("canonical_key") == "gas_mark_whitening"
        )
        gate_location = next(
            row for row in metrics["occurrence_locations"]
            if row["label"]["ko"] == "게이트부"
        )
        scratch = next(
            row for row in metrics["problem_types"]
            if row.get("canonical_key") == "scratch_damage"
        )

        self.assertEqual(metrics["coverage"]["matched_report_count"], 10)
        self.assertEqual(gate["evidence_count"], 4)
        self.assertEqual(gate["all_history_denominator"], 10)
        self.assertEqual(gate["trend"]["recent_count"], 3)
        self.assertEqual(gate["trend"]["previous_count"], 1)
        self.assertEqual(gate["trend"]["recent_denominator"], 5)
        self.assertEqual(gate["trend"]["previous_denominator"], 5)
        self.assertEqual(gate["trend"]["recent_share_pct"], 60.0)
        self.assertEqual(gate["trend"]["previous_share_pct"], 20.0)
        self.assertEqual(gate["trend"]["status"], "increase")
        self.assertEqual(gate["impact_scope"]["plan_group_count"], 2)
        self.assertEqual(gate["impact_scope"]["planned_quantity"], 2000)
        self.assertEqual(gate["impact_scope"]["machine_names"], ["850T-1", "850T-2"])
        self.assertEqual(
            {
                (target["machine_name"], target["model_name"], target["part_no"])
                for target in gate["impact_scope"]["plan_targets"]
            },
            {
                ("850T-1", "MODEL-A", "ABC123456-X"),
                ("850T-2", "MODEL-A", "ABC123456-X"),
            },
        )
        self.assertEqual(gate_location["evidence_count"], 4)
        self.assertEqual(scratch["trend"]["status"], "insufficient_data")
        self.assertEqual(scratch["trend"]["reason"], "small_issue_sample")
        serialized = json.dumps(metrics, ensure_ascii=False)
        self.assertNotIn('"report_id"', serialized)
        self.assertNotIn('"report_ids"', serialized)
        self.assertNotIn('"images"', serialized)
        self.assertNotIn('"disposition"', serialized)

    def test_pair_metrics_require_same_report_problem_and_explicit_location(self):
        self._plan()
        target_date = datetime(2026, 8, 12).date()
        phenomena = [
            "게이트 백화",
            "게이트 백화",
            "백화",
            "백화",
            "백화",
            "백화",
            "게이트 미등록특수현상",
        ]
        for index, phenomenon in enumerate(phenomena, start=1):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=index),
                section="LQC_INJ",
                model="MODEL-A",
                part_no=f"ABC123456-P{index}",
                judgement="NG",
                phenomenon=phenomenon,
            )

        ai_input = build_daily_quality_attention_ai_input(
            target_date,
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        metrics = ai_input["report_metrics"]
        whitening = next(
            row for row in metrics["problem_types"]
            if row.get("canonical_key") == "gas_mark_whitening"
        )
        pair = next(
            row for row in metrics["problem_location_pairs"]
            if row["metric_key"] == "pair:gas_mark_whitening:gate"
        )

        # The problem metric includes all six whitening reports, while the
        # pair includes only the two exact source rows that also say gate.
        self.assertEqual(whitening["evidence_count"], 6)
        self.assertEqual(pair["evidence_count"], 2)
        self.assertEqual(pair["all_history_denominator"], 7)
        self.assertEqual(pair["trend"]["recent_count"], 2)
        self.assertEqual(pair["dimension"], "problem_location_pair")
        self.assertEqual(
            pair["classification_basis"],
            "canonical_problem_explicit_location_pair_v1",
        )
        self.assertEqual(pair["pair_basis"], "same_quality_report_id")
        self.assertEqual(pair["problem_canonical_key"], "gas_mark_whitening")
        self.assertEqual(pair["location_canonical_key"], "gate")
        self.assertEqual(pair["problem_label"]["ko"], "가스 자국·백화")
        self.assertEqual(pair["location_label"]["ko"], "게이트부")
        self.assertFalse(any(
            row["metric_key"].startswith("pair:unclassified:")
            for row in metrics["problem_location_pairs"]
        ))

        locations = metrics["occurrence_locations"]
        self.assertEqual(locations[-1]["metric_key"], "location:unknown")
        self.assertEqual(locations[-1]["evidence_count"], 4)
        self.assertTrue(locations[-1]["is_unknown_location"])
        self.assertEqual(locations[-1]["sort_state"], "unknown_last")
        self.assertTrue(all(row["analysis_role"] == "coverage_only" for row in locations))
        self.assertTrue(all(row["ai_candidate"] is False for row in locations))

        page = quality_daily_report_for_page(
            target_date,
            deterministic_report=metrics,
            source_plan_hash=ai_input["source_plan_hash"],
            source_evidence_hash=ai_input["source_evidence_hash"],
        )
        public_pair = page["deterministic"]["problem_location_pairs"][0]
        self.assertNotIn("source_evidence_keys", public_pair)
        self.assertEqual(public_pair["dimension"], "problem_location_pair")

    def test_pair_metrics_fail_closed_for_ambiguous_multi_problem_multi_location(self):
        self._plan()
        QualityReport.objects.create(
            report_dt=self._local(7, 0) - timedelta(days=1),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-AMBIGUOUS",
            judgement="NG",
            phenomenon="상단 플래시 / 하단 스크래치",
        )

        metrics = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )["report_metrics"]

        self.assertEqual(metrics["problem_location_pairs"], [])
        self.assertEqual(metrics["coverage"]["ambiguous_pair_report_count"], 1)
        self.assertEqual(
            metrics["calculation_basis"]["ambiguous_pair_policy"],
            "skip_when_multiple_problems_and_multiple_locations",
        )
        self.assertEqual(
            {row.get("canonical_key") for row in metrics["problem_types"]},
            {"burr_flash", "scratch_damage"},
        )

    def test_page_report_trend_is_fail_closed_when_previous_denominator_is_zero(self):
        self._plan()
        for days_ago in range(1, 6):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=days_ago),
                section="LQC_INJ",
                model="MODEL-A",
                part_no="ABC123456-HISTORY",
                judgement="NG",
                phenomenon="게이트 백화",
            )

        metrics = build_daily_quality_attention(
            datetime(2026, 8, 12).date(),
            include_images=False,
        )["report_metrics"]
        trend = metrics["problem_types"][0]["trend"]

        self.assertEqual(trend["previous_denominator"], 0)
        self.assertEqual(trend["status"], "insufficient_data")
        self.assertEqual(trend["reason"], "zero_window_denominator")

    def test_canonical_taxonomy_merges_aliases_and_uses_one_global_denominator(self):
        self._plan(machine="850T-1")
        ProductionPlan.objects.create(
            plan_date=datetime(2026, 8, 12).date(),
            plan_type="injection",
            machine_name="850T-2",
            model_name="MODEL-B",
            part_no="XYZ987654-X",
            planned_quantity=500,
            sequence=1,
        )
        for index, phenomenon in enumerate(("油污", "脏污", "油渍"), start=1):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=index),
                section="LQC_INJ",
                model="MODEL-A",
                part_no="ABC123456-HISTORY",
                judgement="NG",
                phenomenon=phenomenon,
            )
        QualityReport.objects.create(
            report_dt=self._local(7, 0) - timedelta(days=1),
            section="LQC_INJ",
            model="MODEL-B",
            part_no="XYZ987654-HISTORY",
            judgement="NG",
            phenomenon="스크래치",
        )
        for days_ago, phenomenon in (
            (2, "未收录特殊现象"),
            (3, "另一个未分类现象"),
        ):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=days_ago),
                section="LQC_INJ",
                model="MODEL-B",
                part_no="XYZ987654-HISTORY",
                judgement="NG",
                phenomenon=phenomenon,
            )

        metrics = build_daily_quality_attention(
            datetime(2026, 8, 12).date(),
            include_images=False,
        )["report_metrics"]
        contamination = next(
            row for row in metrics["problem_types"]
            if row.get("canonical_key") == "contamination"
        )
        scratch = next(
            row for row in metrics["problem_types"]
            if row.get("canonical_key") == "scratch_damage"
        )
        unclassified_rows = [
            row for row in metrics["problem_types"]
            if row.get("classification_basis") == "unclassified_recorded_text_hash"
        ]
        self.assertEqual(len(unclassified_rows), 1)
        unclassified = unclassified_rows[0]

        self.assertEqual(contamination["evidence_count"], 3)
        self.assertEqual(contamination["label"]["ko"], "오염·이물")
        self.assertEqual(contamination["classification_basis"], "canonical_alias_v1")
        self.assertEqual(unclassified["evidence_count"], 2)
        self.assertEqual(unclassified["metric_key"], "problem:unclassified")
        self.assertEqual(len(unclassified["source_evidence_keys"]), 2)
        self.assertEqual(contamination["all_history_denominator"], 6)
        self.assertEqual(scratch["all_history_denominator"], 6)
        self.assertEqual(
            contamination["all_history_denominator_basis"],
            "unique_matching_reports_in_current_plan_prefixes",
        )
        self.assertEqual(
            contamination["trend"]["denominator_basis"],
            "unique_matching_reports_in_current_plan_prefixes",
        )

    def test_structured_page_narrative_restores_only_eligible_metric_references(self):
        self._plan()
        for days_ago, phenomenon in (
            (1, "게이트 백화"),
            (2, "게이트 백화"),
            (3, "게이트 백화"),
            (4, "스크래치"),
            (5, "스크래치"),
            (31, "게이트 백화"),
            (32, "기타 현상"),
            (33, "기타 현상"),
            (34, "기타 현상"),
            (35, "기타 현상"),
        ):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=days_ago),
                section="LQC_INJ",
                model="MODEL-A",
                part_no="ABC123456-HISTORY",
                judgement="NG",
                phenomenon=phenomenon,
            )
        input_payload = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        source_item = input_payload["items"][0]
        gate_metric = next(
            row for row in input_payload["report_metrics"]["problem_types"]
            if row.get("canonical_key") == "gas_mark_whitening"
        )
        standalone_location = next(
            row for row in input_payload["report_metrics"]["occurrence_locations"]
            if row.get("metric_key") == "location:gate"
        )
        evidence_key = gate_metric["source_evidence_keys"][0]
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "source_plan_hash": input_payload["source_plan_hash"],
                "source_evidence_hash": input_payload["source_evidence_hash"],
            },
            input_payload=input_payload,
        )

        restored = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 이력을 정리했습니다.", "zh": "已整理历史记录。"},
            "report": {
                "executive_summary": {"ko": "반복 이력을 우선 확인합니다.", "zh": "优先确认重复记录。"},
                "repeated_issues": [
                    {
                        "metric_key": gate_metric["metric_key"],
                        "source_evidence_keys": ["invented-key"],
                        "narrative": {"ko": "반복 기록을 확인합니다.", "zh": "确认重复记录。"},
                    },
                    {
                        "metric_key": "invented-metric",
                        "source_evidence_keys": [evidence_key],
                        "narrative": {"ko": "가짜 분류", "zh": "虚假分类"},
                    },
                    {
                        "metric_key": standalone_location["metric_key"],
                        "source_evidence_keys": standalone_location["source_evidence_keys"],
                        "narrative": {"ko": "위치 단독", "zh": "单独位置"},
                    },
                ],
                "accelerating_issues": [{
                    "metric_key": gate_metric["metric_key"],
                    "source_evidence_keys": [evidence_key],
                    "narrative": {"ko": "최근 변화 이력을 확인합니다.", "zh": "确认近期变化记录。"},
                }],
                "affected_targets": [
                    {
                        "source_key": source_item["source_key"],
                        "source_evidence_keys": [evidence_key, "invented-key"],
                        "headline": {"ko": "계획 대상을 우선 확인", "zh": "优先确认计划对象"},
                    },
                    {
                        "source_key": "invented-source",
                        "source_evidence_keys": [evidence_key],
                        "headline": {"ko": "가짜 대상", "zh": "虚假对象"},
                    },
                ],
                "shift_checks": {"ko": ["기록 현상을 확인하세요."], "zh": ["请确认记录现象。"]},
                "caveats": {"ko": ["과거 이력 기준입니다."], "zh": ["仅依据历史记录。"]},
            },
            "attention_items": [],
        })

        report = restored["report"]
        self.assertEqual(report["repeated_issues"][0]["metric_key"], gate_metric["metric_key"])
        self.assertEqual(report["repeated_issues"][0]["source_evidence_keys"], gate_metric["source_evidence_keys"])
        self.assertEqual(report["accelerating_issues"][0]["metric_key"], gate_metric["metric_key"])
        self.assertEqual(report["affected_targets"][0]["source_evidence_keys"], [evidence_key])
        restored_json = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("invented-metric", restored_json)
        self.assertNotIn("invented-source", restored_json)
        self.assertNotIn("invented-key", restored_json)
        self.assertNotIn("location:gate", restored_json)
        self.assertNotIn('"count"', restored_json)
        self.assertNotIn('"report_id"', restored_json)

        numeric_claim = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 이력을 정리했습니다.", "zh": "已整理历史记录。"},
            "report": {
                "executive_summary": {"ko": "반복 이력 4건을 확인했습니다.", "zh": "确认了四条重复记录。"},
            },
            "attention_items": [],
        })
        self.assertTrue(numeric_claim["llm_fallback"])
        self.assertEqual(numeric_claim["llm_fallback_code"], "server_safety_rejected")

    def test_completion_restores_authoritative_evidence_and_discards_unknown_sources(self):
        self._plan()
        report = QualityReport.objects.create(
            report_dt=self._local(7, 0) - timedelta(days=30),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-R",
            judgement="NG",
            phenomenon="게이트 백화",
        )
        input_payload = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        source_item = input_payload["items"][0]
        phenomenon_key = input_payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"]
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": "2026-08-12",
                "model_id": QUALITY_DAILY_MODEL_ID,
                "source_plan_hash": input_payload["source_plan_hash"],
                "source_evidence_hash": input_payload["source_evidence_hash"],
            },
            input_payload=input_payload,
        )
        worker_result = {
            "source": "local_llm_rewrite",
            "summary": {
                "ko": "과거 품질 이력의 반복 현상을 확인했습니다.",
                "zh": "已确认历史品质记录中的重复现象。",
            },
            "attention_items": [
                {
                    "source_key": source_item["source_key"],
                    "machine_name": "INVENTED",
                    "matching_report_count": 999,
                    "headline": {"ko": "과거 게이트 백화 이력 주의", "zh": "注意历史浇口发白记录"},
                    "checkpoints": {
                        "ko": ["게이트 주변을 확인하세요."],
                        "zh": ["请确认浇口周边。"],
                    },
                    "problem_types": [{
                        "label": {"ko": "외관", "zh": "外观"},
                        "source_evidence_keys": [phenomenon_key, "unknown-key"],
                        "count": 999,
                    }],
                    "locations": [{
                        "label": {"ko": "게이트부", "zh": "浇口部"},
                        "source_report_ids": [report.id],
                    }],
                },
                {"source_key": "unknown|source", "headline": {"ko": "invented", "zh": "invented"}},
            ],
        }

        restored = restore_authoritative_quality_result(job, worker_result)

        self.assertFalse(restored["llm_fallback"])
        self.assertEqual(len(restored["attention_items"]), 1)
        item = restored["attention_items"][0]
        self.assertEqual(item["machine_name"], source_item["machine_name"])
        self.assertEqual(item["matching_report_count"], 1)
        self.assertEqual(item["problem_types"][0]["count"], 1)
        self.assertEqual(item["locations"], [])
        self.assertEqual(
            item["checkpoints"]["ko"],
            ["교대 전 서버가 연결한 과거 문제 현상을 확인하세요."],
        )
        restored_json = json.dumps(restored, ensure_ascii=False)
        self.assertNotIn("게이트 주변을 확인하세요", restored_json)
        self.assertNotIn("과거 게이트 백화 이력 주의", restored_json)

        job.status = AiJob.STATUS_COMPLETED
        job.result_payload = restored
        job.completed_at = timezone.now()
        job.model_name = "gemma-test"
        job.prompt_version = QUALITY_DAILY_EXPECTED_PROMPT_VERSION
        job.save(update_fields=[
            "status",
            "result_payload",
            "completed_at",
            "model_name",
            "prompt_version",
            "updated_at",
        ])
        public = quality_summary_for_overview(datetime(2026, 8, 12).date())
        public_json = json.dumps(public, ensure_ascii=False)
        self.assertEqual(public["status"], "ready")
        self.assertNotIn("model_name", public)
        self.assertEqual(public["model_id"], QUALITY_DAILY_MODEL_ID)
        self.assertNotIn("source_report_ids", public_json)
        self.assertNotIn("evidence_report_ids", public_json)
        self.assertNotIn("disposition", public_json)
        self.assertNotIn("images", public_json)
        self.assertNotIn('"report"', public_json)

        rejected = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {
                "ko": "현재 불량이 발생하고 있습니다.",
                "zh": "当前不良正在发生。",
            },
            "attention_items": [],
        })
        self.assertTrue(rejected["llm_fallback"])
        self.assertEqual(rejected["llm_fallback_code"], "server_safety_rejected")
        self.assertNotIn("현재 불량", rejected["summary"]["ko"])

        root_cause_rejected = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {
                "ko": "온도 때문에 반복되었다고 판단됩니다.",
                "zh": "由于温度导致重复。",
            },
            "attention_items": [],
        })
        self.assertTrue(root_cause_rejected["llm_fallback"])
        self.assertEqual(root_cause_rejected["llm_fallback_code"], "server_safety_rejected")
        self.assertNotIn("때문에", root_cause_rejected["summary"]["ko"])

        action_rejected = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {
                "ko": "과거 이력을 정리했습니다.",
                "zh": "已整理历史记录。",
            },
            "attention_items": [{
                "source_key": source_item["source_key"],
                "headline": {"ko": "과거 이력 확인", "zh": "确认历史记录"},
                "checkpoints": {
                    "ko": ["온도를 조정하고 확인하세요."],
                    "zh": ["请调整温度后确认。"],
                },
            }],
        })
        self.assertTrue(action_rejected["llm_fallback"])
        self.assertEqual(action_rejected["llm_fallback_code"], "server_safety_rejected")

        mixed_claim_rejected = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {
                "ko": "현재 불량 발생이 확인됐지만 과거 이력은 이를 의미하지 않습니다.",
                "zh": "当前确认存在不良，但历史记录不代表这一结论。",
            },
            "attention_items": [],
        })
        self.assertTrue(mixed_claim_rejected["llm_fallback"])
        self.assertEqual(
            mixed_claim_rejected["llm_fallback_code"],
            "server_safety_rejected",
        )

    def test_overview_state_requires_completed_exact_plan_hash(self):
        plan = self._plan()
        plan_state = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status=AiJob.STATUS_COMPLETED,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": "2026-08-12",
                "source_plan_hash": plan_state["source_plan_hash"],
                "source_evidence_hash": plan_state["source_evidence_hash"],
                "model_id": QUALITY_DAILY_MODEL_ID,
            },
            input_payload=plan_state,
            result_payload={
                "schema_version": "quality-daily-attention-ai.v1",
                "business_date": "2026-08-12",
                "source_plan_hash": plan_state["source_plan_hash"],
                "source_evidence_hash": plan_state["source_evidence_hash"],
                "summary": {"ko": "과거 이력 요약", "zh": "历史记录摘要"},
                "attention_items": [],
                "disclaimer": plan_state["disclaimer"],
                "totals": plan_state["totals"],
                "generated_at": timezone.now().isoformat(),
                "generation_source": "local_llm_rewrite",
                "llm_fallback": False,
            },
            completed_at=timezone.now(),
            model_name="gemma-test",
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

        ready = quality_summary_for_overview(datetime(2026, 8, 12).date())
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(
            ready["source_evidence_hash"],
            plan_state["source_evidence_hash"],
        )
        self.assertEqual(
            ready["summary"]["ko"],
            "당일 생산계획과 연결된 과거 품질 이력을 서버 검증 기준으로 정리했습니다.",
        )

        ProductionPlan.objects.filter(pk=plan.pk).update(
            planned_quantity=2000,
            updated_at=timezone.now(),
        )
        stale = quality_summary_for_overview(datetime(2026, 8, 12).date())
        self.assertEqual(stale["status"], "stale")
        self.assertIsNone(stale["summary"])
        self.assertNotEqual(stale["source_plan_hash"], job.scope["source_plan_hash"])

    def test_completed_result_with_mismatched_evidence_hash_is_never_ready(self):
        self._plan()
        input_payload = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status=AiJob.STATUS_COMPLETED,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": "2026-08-12",
                "source_plan_hash": input_payload["source_plan_hash"],
                "source_evidence_hash": input_payload["source_evidence_hash"],
            },
            input_payload=input_payload,
            result_payload={
                "generation_source": "local_llm_rewrite",
                "llm_fallback": False,
                "source_plan_hash": input_payload["source_plan_hash"],
                "source_evidence_hash": "tampered-evidence-hash",
                "report": {
                    "schema_version": "quality-daily-report-narrative.v1",
                },
            },
            completed_at=self._local(7, 10),
        )

        overview = quality_summary_for_overview(datetime(2026, 8, 12).date())
        page = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=input_payload["report_metrics"],
            source_plan_hash=input_payload["source_plan_hash"],
            source_evidence_hash=input_payload["source_evidence_hash"],
        )

        self.assertEqual(overview["status"], "unavailable")
        self.assertEqual(overview["reason"], "llm_fallback")
        self.assertEqual(overview["llm_fallback_code"], "source_hash_mismatch")
        self.assertEqual(page["status"], "unavailable")
        self.assertEqual(page["reason"], "llm_fallback")
        self.assertIsNone(page["narrative"])

    def test_daily_page_report_keeps_metrics_while_gating_narrative_by_plan_hash(self):
        plan = self._plan()
        QualityReport.objects.create(
            report_dt=self._local(7, 0) - timedelta(days=2),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-HISTORY",
            judgement="NG",
            phenomenon="게이트 백화",
        )
        source = build_daily_quality_attention(
            datetime(2026, 8, 12).date(),
            include_images=False,
        )
        input_payload = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": "2026-08-12",
                "source_plan_hash": source["source_plan_hash"],
                "source_evidence_hash": source["source_evidence_hash"],
                "model_id": QUALITY_DAILY_MODEL_ID,
            },
            input_payload=input_payload,
        )

        pending = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=source["report_metrics"],
            source_plan_hash=source["source_plan_hash"],
            source_evidence_hash=source["source_evidence_hash"],
        )
        self.assertEqual(pending["status"], "pending")
        self.assertIsNone(pending["narrative"])
        self.assertEqual(pending["deterministic"]["coverage"]["matched_report_count"], 1)

        source_item = input_payload["items"][0]
        metric_key = input_payload["report_metrics"]["problem_types"][0]["metric_key"]
        phenomenon_key = input_payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"]
        restored = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 반복 이력을 우선 확인하세요.", "zh": "请优先确认历史重复记录。"},
            "report": {
                "executive_summary": {"ko": "과거 이력을 기준으로 확인합니다.", "zh": "依据历史记录进行确认。"},
                "repeated_issues": [{
                    "metric_key": metric_key,
                    "source_evidence_keys": [phenomenon_key],
                    "narrative": {"ko": "반복 현상을 확인합니다.", "zh": "确认重复现象。"},
                }],
                "accelerating_issues": [{
                    "metric_key": metric_key,
                    "source_evidence_keys": [phenomenon_key],
                    "narrative": {"ko": "증가 이력을 확인합니다.", "zh": "确认增加记录。"},
                }],
                "affected_targets": [{
                    "source_key": source_item["source_key"],
                    "source_evidence_keys": [phenomenon_key],
                    "headline": {"ko": "계획 대상을 우선 확인", "zh": "优先确认计划对象"},
                }],
                "shift_checks": {"ko": ["기록 현상을 확인하세요."], "zh": ["请确认记录现象。"]},
                "caveats": {"ko": ["과거 이력 기준입니다."], "zh": ["仅依据历史记录。"]},
            },
            "attention_items": [{
                "source_key": source_item["source_key"],
                "headline": {"ko": "반복 이력 우선 확인", "zh": "优先确认重复记录"},
                "checkpoints": {"ko": ["기록 현상을 확인하세요."], "zh": ["请确认记录现象。"]},
                "problem_types": [],
                "locations": [],
            }],
        })
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload=restored,
            completed_at=self._local(7, 10),
            model_name="gemma-test",
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )
        ready = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=source["report_metrics"],
            source_plan_hash=source["source_plan_hash"],
        )
        self.assertEqual(ready["status"], "ready")
        self.assertTrue(ready["source_revision"])
        self.assertNotIn("source_plan_hash", ready)
        self.assertNotIn("source_evidence_hash", ready)
        self.assertNotIn("model_name", ready)
        self.assertEqual(ready["narrative"]["priorities"][0]["priority_rank"], 1)
        self.assertIn("연결된 전체 과거 품질 기록 1건", ready["narrative"]["summary"]["ko"])
        self.assertIn(
            "2건 이상 반복된 분류 가능 문제 유형은 없습니다",
            ready["narrative"]["executive_summary"]["ko"],
        )
        self.assertEqual(ready["narrative"]["repeated_issues"], [])
        self.assertEqual(ready["narrative"]["accelerating_issues"], [])
        affected = ready["narrative"]["affected_targets"][0]
        self.assertEqual(affected["machine_name"], source_item["machine_name"])
        self.assertEqual(affected["model_names"], source_item["model_names"])
        self.assertTrue(affected["target_ref"])
        self.assertNotIn("problem_types", ready["narrative"]["priorities"][0])
        report_json = json.dumps(ready, ensure_ascii=False)
        self.assertNotIn('"report_id"', report_json)
        self.assertNotIn('"images"', report_json)
        self.assertNotIn("source_evidence_keys", report_json)

        ProductionPlan.objects.filter(pk=plan.pk).update(
            planned_quantity=2000,
            updated_at=self._local(10, 30),
        )
        changed_source = build_daily_quality_attention(
            datetime(2026, 8, 12).date(),
            include_images=False,
        )
        stale = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=changed_source["report_metrics"],
            source_plan_hash=changed_source["source_plan_hash"],
        )
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["reason"], "plan_changed")
        self.assertIsNone(stale["narrative"])
        self.assertEqual(stale["deterministic"]["coverage"]["matched_report_count"], 1)

    def test_daily_page_public_narrative_uses_authoritative_metrics_and_hides_internal_ids(self):
        self._plan()
        target_date = datetime(2026, 8, 12).date()
        previous_dates = [
            datetime(2026, 6, 20, 8, 0),
            datetime(2026, 6, 22, 8, 0),
            datetime(2026, 6, 24, 8, 0),
            datetime(2026, 6, 26, 8, 0),
            datetime(2026, 6, 28, 8, 0),
        ]
        recent_dates = [
            datetime(2026, 7, 20, 8, 0),
            datetime(2026, 7, 22, 8, 0),
            datetime(2026, 7, 24, 8, 0),
            datetime(2026, 7, 26, 8, 0),
            datetime(2026, 7, 28, 8, 0),
        ]
        for index, report_dt in enumerate(previous_dates + recent_dates):
            is_contamination = index == 0 or index >= 5 and index < 9
            QualityReport.objects.create(
                report_dt=SHANGHAI_TZ.localize(report_dt),
                section="LQC_INJ",
                model="MODEL-A",
                part_no=f"ABC123456-H{index}",
                judgement="NG",
                phenomenon="게이트 오염" if is_contamination else "표면 스크래치",
            )

        source = build_daily_quality_attention(target_date, include_images=False)
        input_payload = build_daily_quality_attention_ai_input(
            target_date,
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        contamination = next(
            row
            for row in input_payload["report_metrics"]["problem_types"]
            if row.get("canonical_key") == "contamination"
        )
        scratch = next(
            row
            for row in input_payload["report_metrics"]["problem_types"]
            if row.get("canonical_key") == "scratch_damage"
        )
        gate_pair = next(
            row
            for row in input_payload["report_metrics"]["problem_location_pairs"]
            if row.get("metric_key") == "pair:contamination:gate"
        )
        source_item = input_payload["items"][0]
        contamination_evidence_key = next(
            row["evidence_key"]
            for row in input_payload["evidence_catalog"][0]["phenomena"]
            if "오염" in row["text"]
        )
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": target_date.isoformat(),
                "source_plan_hash": input_payload["source_plan_hash"],
                "source_evidence_hash": input_payload["source_evidence_hash"],
                "model_id": QUALITY_DAILY_MODEL_ID,
            },
            input_payload=input_payload,
        )
        restored = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 이력을 확인합니다.", "zh": "确认历史记录。"},
            "report": {
                "executive_summary": {"ko": "과거 이력을 확인합니다.", "zh": "确认历史记录。"},
                "repeated_issues": [
                    {"metric_key": contamination["metric_key"]},
                    {"metric_key": scratch["metric_key"]},
                    {"metric_key": gate_pair["metric_key"]},
                ],
                "accelerating_issues": [
                    {"metric_key": contamination["metric_key"]},
                ],
                "affected_targets": [{
                    "source_key": source_item["source_key"],
                    "source_evidence_keys": [contamination_evidence_key],
                }],
                "shift_checks": {"ko": ["과거 이력을 확인합니다."], "zh": ["确认历史记录。"]},
                "caveats": {"ko": ["과거 이력입니다."], "zh": ["仅为历史记录。"]},
            },
            "attention_items": [{
                "source_key": source_item["source_key"],
                "headline": {"ko": "과거 이력을 확인합니다.", "zh": "确认历史记录。"},
                "checkpoints": {"ko": ["과거 이력을 확인합니다."], "zh": ["确认历史记录。"]},
                "problem_types": [{
                    "metric_key": gate_pair["metric_key"],
                    "label": gate_pair["label"],
                    "source_evidence_keys": gate_pair["source_evidence_keys"],
                }],
                "locations": [],
            }],
        })
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload=restored,
            completed_at=self._local(7, 10),
            model_name="/Users/operator/.cache/models/private/gemma-model-path",
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

        report = quality_daily_report_for_page(
            target_date,
            deterministic_report=source["report_metrics"],
            source_plan_hash=source["source_plan_hash"],
            source_evidence_hash=source["source_evidence_hash"],
        )

        self.assertEqual(report["status"], "ready")
        summary = report["narrative"]["executive_summary"]
        self.assertIn("연결된 전체 과거 품질 기록 10건", summary["ko"])
        self.assertIn("오늘 우선 확인 리스크는 오염·이물 5건(최근 4/5건)", summary["ko"])
        self.assertIn("스크래치·찍힘 5건", summary["ko"])
        self.assertNotIn("오염·이물 · 게이트부", summary["ko"])
        self.assertEqual(summary["ko"].count("."), 1)
        repeated_text = report["narrative"]["repeated_issues"][0]["narrative"]
        self.assertIn("10건 중 5건(50.0%)", repeated_text["ko"])
        self.assertIn("850T-1 / MODEL-A / ABC123456-X", repeated_text["ko"])
        accelerating_text = report["narrative"]["accelerating_issues"][0]["narrative"]
        self.assertIn("4/5건(80.0%)", accelerating_text["ko"])
        self.assertIn("1/5건(20.0%)", accelerating_text["ko"])
        self.assertIn("3건·60.0%p", accelerating_text["ko"])
        self.assertIn("关联的全部历史品质记录10条中有5条", repeated_text["zh"])
        self.assertIn(
            "최근 증가 이력 오염·이물 5/10건",
            report["narrative"]["priorities"][0]["headline"]["ko"],
        )
        priority = report["narrative"]["priorities"][0]
        self.assertEqual(priority["primary_metric_key"], contamination["metric_key"])
        self.assertEqual(priority["signals"][0]["metric_key"], contamination["metric_key"])
        self.assertEqual(priority["signals"][0]["dimension"], "problem_type")
        self.assertEqual(priority["signals"][0]["evidence_count"], 5)
        self.assertEqual(priority["signals"][0]["denominator"], 10)
        self.assertEqual(priority["signals"][0]["trend"]["status"], "increase")
        self.assertEqual([signal["metric_key"] for signal in priority["signals"]], [
            contamination["metric_key"],
        ])
        priorities = report["narrative"]["priorities"]
        self.assertEqual([row["primary_metric_key"] for row in priorities], [
            contamination["metric_key"],
            scratch["metric_key"],
        ])
        self.assertEqual(len({row["primary_metric_key"] for row in priorities}), 2)
        self.assertFalse(any(
            signal["metric_key"] == gate_pair["metric_key"]
            for row in priorities
            for signal in row["signals"]
        ))
        self.assertFalse(any(
            signal["dimension"] == "location"
            or signal["metric_key"].startswith("location:")
            for signal in priority["signals"]
        ))
        public_json = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("source_plan_hash", public_json)
        self.assertNotIn("source_evidence_hash", public_json)
        self.assertNotIn("source_evidence_keys", public_json)
        self.assertNotIn(source_item["source_key"], public_json)
        self.assertNotIn("private/gemma-model-path", public_json)
        self.assertNotIn("recorded_text", public_json)

        # The overview contract deliberately retains its exact internal-source
        # gates while omitting the detailed page report.
        overview = quality_summary_for_overview(target_date)
        self.assertEqual(overview["status"], "ready")
        self.assertNotIn("model_name", overview)
        self.assertNotIn("private/gemma-model-path", json.dumps(overview))
        self.assertEqual(overview["source_plan_hash"], source["source_plan_hash"])
        self.assertEqual(overview["source_evidence_hash"], source["source_evidence_hash"])
        self.assertTrue(all(
            item.get("locations") == []
            for item in overview["attention_items"]
        ))
        overview_pair = overview["attention_items"][0]["problem_location_pairs"][0]
        self.assertEqual(overview_pair, {
            "label": gate_pair["label"],
            "problem_label": gate_pair["problem_label"],
            "location_label": gate_pair["location_label"],
            "count": 5,
        })
        self.assertEqual(
            overview["attention_items"][0]["problem_types"][0]["label"],
            gate_pair["problem_label"],
        )
        self.assertNotIn("metric_key", overview_pair)
        self.assertNotIn("pair_basis", overview_pair)

    def test_missing_phenomenon_is_forced_to_unclassified_and_unknown_location(self):
        self._plan()
        QualityReport.objects.create(
            report_dt=self._local(7, 0) - timedelta(days=2),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-NO-TEXT",
            judgement="NG",
            phenomenon="",
        )
        input_payload = build_daily_quality_attention_ai_input(
            datetime(2026, 8, 12).date(),
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        item = input_payload["items"][0]
        missing_key = input_payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"]
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "source_plan_hash": input_payload["source_plan_hash"],
                "source_evidence_hash": input_payload["source_evidence_hash"],
            },
            input_payload=input_payload,
        )

        restored = restore_authoritative_quality_result(job, {
            "summary": {"ko": "과거 이력을 확인했습니다.", "zh": "已确认历史记录。"},
            "report": {
                "executive_summary": {
                    "ko": "과거 기록을 확인합니다.",
                    "zh": "确认历史记录。",
                },
                "repeated_issues": [],
                "accelerating_issues": [],
                "affected_targets": [{
                    "source_key": item["source_key"],
                    "source_evidence_keys": [missing_key],
                    "headline": {"ko": "계획 대상 확인", "zh": "确认计划对象"},
                }],
                "shift_checks": {"ko": ["기록을 확인하세요."], "zh": ["请确认记录。"]},
                "caveats": {"ko": ["과거 이력 기준입니다."], "zh": ["仅依据历史记录。"]},
            },
            "attention_items": [{
                "source_key": item["source_key"],
                "headline": {"ko": "과거 이력 확인", "zh": "确认历史记录"},
                "checkpoints": {"ko": ["기록 내용을 확인하세요."], "zh": ["请确认记录内容。"]},
                "problem_types": [{
                    "label": {"ko": "외관", "zh": "外观"},
                    "source_evidence_keys": [missing_key],
                }],
                "locations": [{
                    "label": {"ko": "게이트부", "zh": "浇口部"},
                    "source_evidence_keys": [missing_key],
                }],
            }],
        })

        restored_item = restored["attention_items"][0]
        self.assertTrue(restored["llm_fallback"])
        self.assertEqual(restored["llm_fallback_code"], "unverified_generation_source")
        self.assertEqual(restored_item["problem_types"][0]["label"]["ko"], "유형 미분류")
        self.assertEqual(restored_item["locations"], [])
        self.assertEqual(restored_item["problem_types"][0]["count"], 1)
        self.assertEqual(restored["report"]["affected_targets"], [])

    def test_summary_keeps_unknown_location_and_pairs_out_of_priority_focus(self):
        self._plan()
        target_date = datetime(2026, 8, 12).date()
        for index in range(10):
            if index < 7:
                phenomenon = "오염"
            elif index < 9:
                phenomenon = "모서리 오염"
            else:
                phenomenon = "상단 스크래치"
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=index + 1),
                section="LQC_INJ",
                model="MODEL-A",
                part_no=f"ABC123456-L{index}",
                judgement="NG",
                phenomenon=phenomenon,
            )
        source = build_daily_quality_attention(target_date, include_images=False)
        metrics = source["report_metrics"]

        report = quality_daily_report_for_page(
            target_date,
            deterministic_report=metrics,
            source_plan_hash=source["source_plan_hash"],
            source_evidence_hash=source["source_evidence_hash"],
        )
        # No AI completion yet, so directly exercise the same deterministic
        # server summary through a completed, empty selector result.
        input_payload = build_daily_quality_attention_ai_input(
            target_date,
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": target_date.isoformat(),
                "source_plan_hash": source["source_plan_hash"],
                "source_evidence_hash": source["source_evidence_hash"],
            },
            input_payload=input_payload,
        )
        restored = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 이력", "zh": "历史记录"},
            "report": {
                "executive_summary": {"ko": "과거 이력", "zh": "历史记录"},
                "repeated_issues": [],
                "accelerating_issues": [],
                "affected_targets": [],
                "shift_checks": {"ko": [], "zh": []},
                "caveats": {"ko": [], "zh": []},
            },
            "attention_items": [],
        })
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload=restored,
            completed_at=self._local(7, 10),
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )
        report = quality_daily_report_for_page(
            target_date,
            deterministic_report=metrics,
            source_plan_hash=source["source_plan_hash"],
            source_evidence_hash=source["source_evidence_hash"],
        )

        self.assertEqual(report["status"], "ready")
        summary = report["narrative"]["summary"]
        self.assertIn("오늘 우선 확인 리스크는 오염·이물 9건", summary["ko"])
        self.assertNotIn("오염·이물 · 모서리·테두리", summary["ko"])
        self.assertNotIn("발생 위치 미기록", summary["ko"])
        self.assertNotIn("위치 분석 신뢰", summary["ko"])
        self.assertIn("今日优先确认风险为脏污·异物9条", summary["zh"])
        self.assertNotIn("脏污·异物 · 边缘", summary["zh"])
        self.assertNotIn("发生位置未记录", summary["zh"])
        checks = " ".join(report["narrative"]["shift_checks"]["ko"])
        self.assertNotIn("위치 미기록", checks)
        self.assertNotIn("현재 불량", checks)
        unknown = report["deterministic"]["occurrence_locations"][-1]
        self.assertEqual(unknown["metric_key"], "location:unknown")
        self.assertEqual(unknown["evidence_count"], 7)
        self.assertEqual(unknown["analysis_role"], "coverage_only")
        self.assertTrue(unknown["is_unknown_location"])

    def test_public_priorities_use_three_distinct_risks_and_targets(self):
        target_date = datetime(2026, 8, 12).date()
        for machine, model in (
            ("850T-1", "24G411B-BA.AEUYJVN"),
            ("850T-2", "24G411C-BA.AEUYJVN"),
            ("1200T-17", "34U650A-BA.AEUKMKN"),
        ):
            ProductionPlan.objects.create(
                plan_date=target_date,
                plan_type="injection",
                machine_name=machine,
                model_name=model,
                part_no="ABC123456-X",
                lot_no=f"LOT-{machine}",
                planned_quantity=1000,
                sequence=1,
            )
        for index, phenomenon in enumerate((
            "플래시",
            "플래시",
            "스크래치",
            "스크래치",
            "백화",
            "백화",
        )):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=index + 1),
                section="LQC_INJ",
                model="MODEL-A",
                part_no=f"ABC123456-H{index}",
                judgement="NG",
                phenomenon=phenomenon,
            )

        source = build_daily_quality_attention(target_date, include_images=False)
        input_payload = build_daily_quality_attention_ai_input(
            target_date,
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        metrics_by_canonical = {
            row.get("canonical_key"): row
            for row in input_payload["report_metrics"]["problem_types"]
        }
        selected_metrics = [
            metrics_by_canonical["scratch_damage"],
            metrics_by_canonical["burr_flash"],
            metrics_by_canonical["gas_mark_whitening"],
        ]
        items = input_payload["items"]
        selected_items = [items[2], items[0], items[1]]
        evidence_key = input_payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"]
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": target_date.isoformat(),
                "source_plan_hash": source["source_plan_hash"],
                "source_evidence_hash": source["source_evidence_hash"],
            },
            input_payload=input_payload,
        )
        restored = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 이력", "zh": "历史记录"},
            "report": {
                "executive_summary": {"ko": "과거 이력", "zh": "历史记录"},
                "repeated_issues": [
                    {"metric_key": metric["metric_key"]}
                    for metric in selected_metrics
                ],
                "accelerating_issues": [],
                "affected_targets": [
                    {
                        "source_key": item["source_key"],
                        "source_evidence_keys": [evidence_key],
                    }
                    for item in selected_items
                ],
                "shift_checks": {"ko": [], "zh": []},
                "caveats": {"ko": [], "zh": []},
            },
            "attention_items": [
                {
                    "source_key": item["source_key"],
                    "priority_rank": rank,
                    "problem_types": [],
                    "locations": [],
                }
                for rank, item in enumerate(items, start=1)
            ],
        })
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload=restored,
            completed_at=self._local(7, 10),
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

        report = quality_daily_report_for_page(
            target_date,
            deterministic_report=source["report_metrics"],
            source_plan_hash=source["source_plan_hash"],
            source_evidence_hash=source["source_evidence_hash"],
        )

        priorities = report["narrative"]["priorities"]
        expected_metric_keys = [metric["metric_key"] for metric in selected_metrics]
        self.assertEqual([row["primary_metric_key"] for row in priorities], expected_metric_keys)
        self.assertEqual([row["machine_name"] for row in priorities], [
            item["machine_name"] for item in selected_items
        ])
        self.assertEqual([row["priority_rank"] for row in priorities], [1, 2, 3])
        self.assertTrue(all(
            [signal["metric_key"] for signal in row["signals"]] == [row["primary_metric_key"]]
            for row in priorities
        ))
        summary = report["narrative"]["summary"]["ko"]
        self.assertLess(
            summary.index("스크래치·찍힘"),
            summary.index("버·플래시"),
        )
        self.assertLess(
            summary.index("버·플래시"),
            summary.index("가스 자국·백화"),
        )

    def test_pair_selection_keeps_qwen_risk_order_as_parent_problem(self):
        self._plan()
        target_date = datetime(2026, 8, 12).date()
        for index, phenomenon in enumerate((
            "모서리 스크래치",
            "모서리 스크래치",
            "플래시",
            "플래시",
        )):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=index + 1),
                section="LQC_INJ",
                model="MODEL-A",
                part_no=f"ABC123456-P{index}",
                judgement="NG",
                phenomenon=phenomenon,
            )

        source = build_daily_quality_attention(target_date, include_images=False)
        input_payload = build_daily_quality_attention_ai_input(
            target_date,
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        problem_metrics = {
            row.get("canonical_key"): row
            for row in input_payload["report_metrics"]["problem_types"]
        }
        scratch = problem_metrics["scratch_damage"]
        burr = problem_metrics["burr_flash"]
        scratch_pair = next(
            row
            for row in input_payload["report_metrics"]["problem_location_pairs"]
            if row.get("problem_canonical_key") == "scratch_damage"
        )
        item = input_payload["items"][0]
        evidence_key = input_payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"]
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": target_date.isoformat(),
                "source_plan_hash": source["source_plan_hash"],
                "source_evidence_hash": source["source_evidence_hash"],
            },
            input_payload=input_payload,
        )
        restored = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 이력", "zh": "历史记录"},
            "report": {
                "executive_summary": {"ko": "과거 이력", "zh": "历史记录"},
                "repeated_issues": [
                    {"metric_key": scratch_pair["metric_key"]},
                    {"metric_key": burr["metric_key"]},
                ],
                "accelerating_issues": [],
                "affected_targets": [{
                    "source_key": item["source_key"],
                    "source_evidence_keys": [evidence_key],
                }],
                "shift_checks": {"ko": [], "zh": []},
                "caveats": {"ko": [], "zh": []},
            },
            "attention_items": [{
                "source_key": item["source_key"],
                "priority_rank": 1,
                "problem_types": [],
                "locations": [],
            }],
        })
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload=restored,
            completed_at=self._local(7, 10),
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

        report = quality_daily_report_for_page(
            target_date,
            deterministic_report=source["report_metrics"],
            source_plan_hash=source["source_plan_hash"],
            source_evidence_hash=source["source_evidence_hash"],
        )

        priorities = report["narrative"]["priorities"]
        self.assertEqual(
            [row["primary_metric_key"] for row in priorities],
            [scratch["metric_key"], burr["metric_key"]],
        )
        self.assertTrue(all(
            not row["primary_metric_key"].startswith("pair:")
            for row in priorities
        ))
        summary = report["narrative"]["summary"]["ko"]
        self.assertLess(summary.index("스크래치·찍힘"), summary.index("버·플래시"))

    def test_public_priorities_follow_verified_selector_then_append_fallback_targets(self):
        self._plan(machine="850T-1")
        self._plan(machine="850T-2")
        target_date = datetime(2026, 8, 12).date()
        QualityReport.objects.create(
            report_dt=self._local(7, 0) - timedelta(days=1),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-HISTORY",
            judgement="NG",
            phenomenon="게이트 백화",
        )
        source = build_daily_quality_attention(target_date, include_images=False)
        input_payload = build_daily_quality_attention_ai_input(
            target_date,
            model_id=QUALITY_DAILY_MODEL_ID,
        )
        first_item, selected_item = input_payload["items"]
        evidence_key = input_payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"]
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": target_date.isoformat(),
                "source_plan_hash": source["source_plan_hash"],
                "source_evidence_hash": source["source_evidence_hash"],
            },
            input_payload=input_payload,
        )
        restored = restore_authoritative_quality_result(job, {
            "source": "local_llm_rewrite",
            "summary": {"ko": "과거 이력", "zh": "历史记录"},
            "report": {
                "executive_summary": {"ko": "과거 이력", "zh": "历史记录"},
                "repeated_issues": [],
                "accelerating_issues": [],
                # The selector deliberately ranks machine 2 first and omits
                # machine 1; machine 1 must be appended as deterministic fallback.
                "affected_targets": [{
                    "source_key": selected_item["source_key"],
                    "source_evidence_keys": [evidence_key],
                }],
                "shift_checks": {"ko": [], "zh": []},
                "caveats": {"ko": [], "zh": []},
            },
            "attention_items": [
                {
                    "source_key": first_item["source_key"],
                    "problem_types": [],
                    "locations": [],
                },
                {
                    "source_key": selected_item["source_key"],
                    "problem_types": [],
                    "locations": [],
                },
            ],
        })
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload=restored,
            completed_at=self._local(7, 10),
            prompt_version=QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        )

        report = quality_daily_report_for_page(
            target_date,
            deterministic_report=source["report_metrics"],
            source_plan_hash=source["source_plan_hash"],
            source_evidence_hash=source["source_evidence_hash"],
        )

        priorities = report["narrative"]["priorities"]
        self.assertEqual([row["machine_name"] for row in priorities], ["850T-2", "850T-1"])
        self.assertEqual([row["priority_rank"] for row in priorities], [1, 2])
        self.assertNotEqual(priorities[0]["target_ref"], priorities[1]["target_ref"])
        self.assertIsNone(priorities[0]["primary_metric_key"])
        self.assertEqual(priorities[0]["signals"], [])
        public_json = json.dumps(priorities, ensure_ascii=False)
        self.assertNotIn(selected_item["source_key"], public_json)
        self.assertNotIn("source_evidence_keys", public_json)


class DailyQualityPageEndpointTests(APITestCase):
    def test_authenticated_endpoint_attaches_deterministic_pending_report(self):
        target_date = datetime(2026, 8, 12).date()
        user = get_user_model().objects.create_user(
            username="quality-report-user",
            password="test-password",
        )
        self.client.force_authenticate(user=user)
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type="injection",
            machine_name="850T-1",
            model_name="MODEL-A",
            part_no="ABC123456-X",
            lot_no="LOT-1",
            planned_quantity=1000,
            sequence=1,
        )
        QualityReport.objects.create(
            report_dt=SHANGHAI_TZ.localize(datetime(2026, 8, 10, 7, 0)),
            section="LQC_INJ",
            model="MODEL-A",
            part_no="ABC123456-HISTORY",
            judgement="NG",
            phenomenon="게이트 백화",
            disposition="민감한 작업자 자유서술",
            image1="https://example.invalid/private-evidence.jpg",
        )
        source = build_daily_quality_attention(target_date, include_images=False)
        AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": target_date.isoformat(),
                "source_plan_hash": source["source_plan_hash"],
                "source_evidence_hash": source["source_evidence_hash"],
                "model_id": QUALITY_DAILY_MODEL_ID,
            },
        )

        response = self.client.get(
            "/api/quality/daily-attention/",
            {"date": target_date.isoformat()},
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("source_plan_hash", response.data)
        self.assertNotIn("source_evidence_hash", response.data)
        self.assertEqual(response.data["report"]["status"], "pending")
        self.assertIsNone(response.data["report"]["narrative"])
        self.assertEqual(
            response.data["report"]["source_plan_last_changed_at"],
            response.data["source_plan_last_changed_at"],
        )
        self.assertTrue(response.data["report"]["source_revision"])
        self.assertNotIn("source_plan_hash", response.data["report"])
        self.assertNotIn("source_evidence_hash", response.data["report"])
        self.assertNotIn("model_name", response.data["report"])
        self.assertEqual(
            response.data["report"]["source_evidence_last_changed_at"],
            response.data["source_evidence_last_changed_at"],
        )
        self.assertTrue(response.data["report"]["deterministic"]["calculated_at"])
        self.assertEqual(
            response.data["report"]["deterministic"]["coverage"]["matched_report_count"],
            1,
        )
        report_json = json.dumps(response.data["report"], ensure_ascii=False)
        self.assertNotIn('"report_id"', report_json)
        self.assertNotIn("source_evidence_keys", report_json)
        self.assertNotIn("recorded_text", report_json)
        self.assertNotIn("private-evidence.jpg", report_json)
        self.assertNotIn("민감한 작업자 자유서술", report_json)


@override_settings(AI_WORKER_TOKEN="test-worker-token")
class DailyQualityWorkerQueueTests(APITestCase):
    def _claim_one(self):
        return self.client.post(
            "/api/ai/jobs/claim/",
            {
                "worker_name": "mac-studio-test",
                "worker_version": "production-ai-worker-v2",
                "limit": 1,
                "job_types": [
                    AiJob.JOB_TYPE_PRODUCTION_DAILY,
                    AiJob.JOB_TYPE_QUALITY_IMAGE,
                ],
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )

    def test_today_quality_jobs_are_claimed_first_with_fifo(self):
        local_today = timezone.now().astimezone(SHANGHAI_TZ).date()
        yesterday_quality = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": (local_today - timedelta(days=1)).isoformat(),
                "model_id": "gemma4_26b_a4b",
            },
        )
        first_today = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": local_today.isoformat(),
                "model_id": QUALITY_DAILY_MODEL_ID,
                "source_plan_hash": "today-first",
            },
        )
        second_today = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": local_today.isoformat(),
                "model_id": QUALITY_DAILY_MODEL_ID,
                "source_plan_hash": "today-second",
            },
        )

        first_response = self._claim_one()
        second_response = self._claim_one()
        third_response = self._claim_one()

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(first_response.data["jobs"][0]["id"], first_today.id)
        self.assertEqual(second_response.data["jobs"][0]["id"], second_today.id)
        self.assertEqual(third_response.data["jobs"][0]["id"], yesterday_quality.id)

    def test_daily_quality_job_is_claimed_before_hourly_analysis(self):
        legacy_quality = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={"mode": "legacy_image_analysis", "trigger": "manual"},
        )
        manual_daily_mode = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={"mode": QUALITY_DAILY_MODE, "trigger": "manual"},
        )
        hourly = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={"trigger": "hourly", "date": "2026-08-12"},
        )
        quality = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={
                "mode": QUALITY_DAILY_MODE,
                "trigger": QUALITY_DAILY_TRIGGER,
                "date": "2026-08-12",
                "model_id": QUALITY_DAILY_MODEL_ID,
                "source_plan_hash": "hash",
            },
        )

        response = self.client.post(
            "/api/ai/jobs/claim/",
            {
                "worker_name": "mac-studio-test",
                "worker_version": "production-ai-worker-v2",
                "limit": 1,
                "job_types": [
                    AiJob.JOB_TYPE_PRODUCTION_DAILY,
                    AiJob.JOB_TYPE_QUALITY_IMAGE,
                ],
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["jobs"][0]["id"], quality.id)
        hourly.refresh_from_db()
        legacy_quality.refresh_from_db()
        manual_daily_mode.refresh_from_db()
        self.assertEqual(hourly.status, AiJob.STATUS_PENDING)
        self.assertEqual(legacy_quality.status, AiJob.STATUS_PENDING)
        self.assertEqual(manual_daily_mode.status, AiJob.STATUS_PENDING)

        legacy_only = self.client.post(
            "/api/ai/jobs/claim/",
            {
                "worker_name": "mac-studio-test",
                "worker_version": "production-ai-worker-v2",
                "limit": 1,
                "job_types": [AiJob.JOB_TYPE_QUALITY_IMAGE],
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )
        self.assertEqual(legacy_only.status_code, 200)
        self.assertEqual(legacy_only.data["jobs"], [])
