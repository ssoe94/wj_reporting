from datetime import datetime, timedelta
import json

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from production.ai_metrics import SHANGHAI_TZ
from production.models import ProductionPlan
from quality.daily_attention import (
    build_daily_quality_attention,
    build_daily_quality_attention_ai_input,
)
from quality.models import QualityReport

from .models import AiJob
from .quality_daily import (
    QUALITY_DAILY_MODE,
    QUALITY_DAILY_MODEL_ID,
    QUALITY_DAILY_TRIGGER,
    enqueue_daily_quality_summary,
    quality_summary_for_overview,
    restore_authoritative_quality_result,
)


class DailyQualitySummaryTests(TestCase):
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
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_COMPLETED,
            result_payload={"llm_fallback": False},
            completed_at=self._local(7, 1),
        )
        completed_duplicate = enqueue_daily_quality_summary(self._local(7, 2))
        self.assertEqual(completed_duplicate["status"], "exists")
        self.assertEqual(AiJob.objects.count(), 1)

    def test_no_plan_does_not_create_false_empty_summary(self):
        result = enqueue_daily_quality_summary(self._local(7, 30))

        self.assertEqual(result["status"], "no_plan")
        self.assertFalse(AiJob.objects.exists())

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
        cooldown = enqueue_daily_quality_summary(self._local(7, 10))
        retried = enqueue_daily_quality_summary(self._local(7, 16))

        self.assertEqual(unavailable["status"], "unavailable")
        self.assertEqual(unavailable["reason"], "llm_fallback")
        self.assertEqual(cooldown["status"], "retry_cooldown")
        self.assertEqual(retried["status"], "retried")
        self.assertEqual(AiJob.objects.count(), 1)
        job.refresh_from_db()
        self.assertEqual(job.status, AiJob.STATUS_PENDING)
        self.assertEqual(job.result_payload, {})

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
        self.assertEqual(item["checkpoints"]["ko"], ["게이트 주변을 확인하세요."])

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
                "model_id": QUALITY_DAILY_MODEL_ID,
            },
            input_payload=plan_state,
            result_payload={
                "schema_version": "quality-daily-attention-ai.v1",
                "business_date": "2026-08-12",
                "source_plan_hash": plan_state["source_plan_hash"],
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
        self.assertEqual(ready["summary"]["ko"], "과거 이력 요약")

        ProductionPlan.objects.filter(pk=plan.pk).update(
            planned_quantity=2000,
            updated_at=timezone.now(),
        )
        stale = quality_summary_for_overview(datetime(2026, 8, 12).date())
        self.assertEqual(stale["status"], "stale")
        self.assertIsNone(stale["summary"])
        self.assertNotEqual(stale["source_plan_hash"], job.scope["source_plan_hash"])

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
            scope={"mode": QUALITY_DAILY_MODE, "trigger": QUALITY_DAILY_TRIGGER},
            input_payload=input_payload,
        )

        restored = restore_authoritative_quality_result(job, {
            "summary": {"ko": "과거 이력을 확인했습니다.", "zh": "已确认历史记录。"},
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


@override_settings(AI_WORKER_TOKEN="test-worker-token")
class DailyQualityWorkerQueueTests(APITestCase):
    def test_daily_quality_job_is_claimed_before_hourly_analysis(self):
        legacy_quality = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={"mode": "legacy_image_analysis", "trigger": "manual"},
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
        self.assertEqual(hourly.status, AiJob.STATUS_PENDING)
        self.assertEqual(legacy_quality.status, AiJob.STATUS_PENDING)

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
