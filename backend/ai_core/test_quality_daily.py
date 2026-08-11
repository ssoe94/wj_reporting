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

    def test_at_07_enqueues_one_gemma_bilingual_job_and_is_idempotent(self):
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
        cooldown = enqueue_daily_quality_summary(self._local(7, 10))
        retried = enqueue_daily_quality_summary(self._local(7, 16))

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
        )

        page_report = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=job.input_payload["report_metrics"],
            source_plan_hash=job.scope["source_plan_hash"],
        )
        cooldown = enqueue_daily_quality_summary(self._local(7, 10))
        retried = enqueue_daily_quality_summary(self._local(7, 16))

        self.assertEqual(page_report["status"], "unavailable")
        self.assertEqual(page_report["reason"], "not_generated")
        self.assertIsNone(page_report["narrative"])
        self.assertEqual(cooldown["status"], "retry_cooldown")
        self.assertEqual(retried["status"], "retried")
        job.refresh_from_db()
        self.assertEqual(job.status, AiJob.STATUS_PENDING)

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
        for days_ago in (2, 3):
            QualityReport.objects.create(
                report_dt=self._local(7, 0) - timedelta(days=days_ago),
                section="LQC_INJ",
                model="MODEL-B",
                part_no="XYZ987654-HISTORY",
                judgement="NG",
                phenomenon="未收录特殊现象",
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
        unclassified = next(
            row for row in metrics["problem_types"]
            if row.get("classification_basis") == "unclassified_recorded_text_hash"
        )

        self.assertEqual(contamination["evidence_count"], 3)
        self.assertEqual(contamination["label"]["ko"], "오염·이물")
        self.assertEqual(contamination["classification_basis"], "canonical_alias_v1")
        self.assertEqual(unclassified["evidence_count"], 2)
        self.assertTrue(unclassified["metric_key"].startswith("problem:unclassified:"))
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
        self.assertEqual(item["locations"][0]["count"], 1)
        self.assertEqual(
            item["checkpoints"]["ko"],
            ["교대 전 서버가 연결한 과거 현상과 위치 기록을 확인하세요."],
        )
        restored_json = json.dumps(restored, ensure_ascii=False)
        self.assertNotIn("게이트 주변을 확인하세요", restored_json)
        self.assertNotIn("과거 게이트 백화 이력 주의", restored_json)

        job.status = AiJob.STATUS_COMPLETED
        job.result_payload = restored
        job.completed_at = timezone.now()
        job.model_name = "gemma-test"
        job.save(update_fields=["status", "result_payload", "completed_at", "model_name", "updated_at"])
        public = quality_summary_for_overview(datetime(2026, 8, 12).date())
        public_json = json.dumps(public, ensure_ascii=False)
        self.assertEqual(public["status"], "ready")
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
        )
        ready = quality_daily_report_for_page(
            datetime(2026, 8, 12).date(),
            deterministic_report=source["report_metrics"],
            source_plan_hash=source["source_plan_hash"],
        )
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(ready["source_evidence_hash"], source["source_evidence_hash"])
        self.assertEqual(ready["narrative"]["priorities"][0]["priority_rank"], 1)
        self.assertEqual(
            ready["narrative"]["summary"]["ko"],
            "당일 생산계획과 연결된 과거 품질 이력을 서버 검증 기준으로 정리했습니다.",
        )
        self.assertEqual(
            ready["narrative"]["executive_summary"]["ko"],
            "당일 생산계획과 연결된 과거 품질 이력을 서버 검증 기준으로 정리했습니다.",
        )
        self.assertEqual(ready["narrative"]["repeated_issues"], [])
        self.assertEqual(ready["narrative"]["accelerating_issues"], [])
        self.assertEqual(ready["narrative"]["affected_targets"][0]["source_key"], source_item["source_key"])
        self.assertNotIn("problem_types", ready["narrative"]["priorities"][0])
        report_json = json.dumps(ready, ensure_ascii=False)
        self.assertNotIn('"report_id"', report_json)
        self.assertNotIn('"images"', report_json)

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
        self.assertEqual(restored_item["locations"][0]["label"]["ko"], "위치 미확인")
        self.assertEqual(restored_item["problem_types"][0]["count"], 1)
        self.assertEqual(restored["report"]["affected_targets"], [])


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
        self.assertEqual(response.data["report"]["status"], "pending")
        self.assertIsNone(response.data["report"]["narrative"])
        self.assertEqual(
            response.data["report"]["source_plan_last_changed_at"],
            response.data["source_plan_last_changed_at"],
        )
        self.assertTrue(response.data["report"]["source_evidence_hash"])
        self.assertEqual(
            response.data["report"]["source_evidence_hash"],
            response.data["source_evidence_hash"],
        )
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
        self.assertNotIn("private-evidence.jpg", report_json)
        self.assertNotIn("민감한 작업자 자유서술", report_json)


@override_settings(AI_WORKER_TOKEN="test-worker-token")
class DailyQualityWorkerQueueTests(APITestCase):
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
