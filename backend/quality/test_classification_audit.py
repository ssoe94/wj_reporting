from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from ai_core.models import AiJob
from ai_core.quality_report_audit import (
    QUALITY_REPORT_AUDIT_PROMPT_VERSION,
    QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
)
from injection.models import PartSpec
from production.models import ProductionPlan

from .classification_audit import (
    _exact_part_consensus,
    build_quality_report_audit_input,
    enqueue_stale_quality_report_audits,
)
from .daily_attention import build_daily_quality_attention
from .models import QualityReport


@override_settings(AI_WORKER_TOKEN="test-worker-token")
class QualityClassificationAuditApiTests(APITestCase):
    def setUp(self):
        self.editor = get_user_model().objects.create_user(
            username="quality-audit-editor",
            password="test-password",
        )
        profile = self.editor.profile
        profile.can_view_quality = True
        profile.can_edit_quality = True
        profile.can_edit_injection = True
        profile.save(update_fields=[
            "can_view_quality", "can_edit_quality", "can_edit_injection",
        ])
        self.report = QualityReport.objects.create(
            report_dt=timezone.now(),
            section="LQC_INJ",
            model="24G411",
            part_no="TEST30776301",
            phenomenon="表面色差需要调整",
            image1="https://res.cloudinary.com/example/image/upload/v123/quality/white.jpg",
        )
        PartSpec.objects.create(
            part_no="TEST30776301",
            model_code="24G411",
            color="BLACK",
            cavity=2,
            valid_from=timezone.localdate() - timedelta(days=1),
        )
        self.client.force_authenticate(self.editor)

    def _enqueue_and_complete(self):
        enqueue = self.client.post(
            reverse("quality-classification-audit"),
            {"report_ids": [self.report.pk], "limit": 1},
            format="json",
        )
        self.assertEqual(enqueue.status_code, 202, enqueue.data)
        job = AiJob.objects.get(pk=enqueue.data["created_job_ids"][0])
        candidate_index = next(
            index
            for index, row in enumerate(job.input_payload["taxonomy_candidates"])
            if row["key"] == "color_difference"
        )
        job.status = AiJob.STATUS_RUNNING
        job.claimed_by = "test-worker"
        job.claimed_at = timezone.now()
        job.save(update_fields=["status", "claimed_by", "claimed_at", "updated_at"])
        self.client.force_authenticate(user=None)
        complete = self.client.post(
            f"/api/ai/jobs/{job.pk}/complete/",
            {
                "result_payload": {
                    "schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
                    "source": "local_qwen38_multimodal",
                    "llm_fallback": False,
                    "llm_attempted": True,
                    "model_id": "qwen38",
                    "defect_candidate_indices": [candidate_index],
                    "defect_confidence": "high",
                    "needs_new_category": False,
                    "evidence_basis": ["report_text", "image"],
                    "processed_images": [{"slot": "image1", "sha256": "a" * 64}],
                    "image_observations": [{
                        "image_index": 0,
                        "product_visible": True,
                        "body_color_key": "white",
                        "confidence": "high",
                        "uncertainty_codes": [],
                    }],
                    "review_reason_codes": [],
                },
                "model_name": "Qwen3.8-27B-4bit",
                "prompt_version": QUALITY_REPORT_AUDIT_PROMPT_VERSION,
                "worker_name": "test-worker",
                "claim_timestamp": job.claimed_at.isoformat(),
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )
        self.assertEqual(complete.status_code, 200, complete.data)
        self.client.force_authenticate(self.editor)
        return job

    def test_exact_part_photo_colour_is_reviewed_before_versioned_master_write(self):
        job = self._enqueue_and_complete()

        queue = self.client.get(
            reverse("quality-classification-audit"),
            {"report_id": self.report.pk, "status": "all"},
        )
        self.assertEqual(queue.status_code, 200, queue.data)
        case = queue.data["results"][0]
        self.assertEqual(case["result"]["report"]["part_no"], "TEST30776301")
        self.assertEqual(
            case["result"]["product_color_suggestion"]["suggested_color_key"],
            "white",
        )
        self.assertEqual(case["result"]["master_color_comparison"]["status"], "mismatch")

        review = self.client.post(
            reverse("quality-classification-audit-review", args=[job.pk]),
            {
                "action": "accepted",
                "category_keys": ["color_difference"],
                "product_color_key": "white",
                "note": "제품 본체가 백색임을 사진으로 확인",
            },
            format="json",
        )
        self.assertEqual(review.status_code, 200, review.data)
        self.assertEqual(review.data["review"]["exact_part_no"], "TEST30776301")

        apply = self.client.post(
            reverse("quality-classification-audit-apply-color", args=[job.pk]),
            {
                "color_key": "white",
                "valid_from": timezone.localdate().isoformat(),
                "confirmation": "CONFIRM_EXACT_PART_COLOR",
            },
            format="json",
        )
        self.assertEqual(apply.status_code, 201, apply.data)
        self.assertEqual(apply.data["part_spec"]["part_no"], "TEST30776301")
        self.assertEqual(apply.data["part_spec"]["color"], "WHITE")
        self.assertEqual(
            PartSpec.objects.filter(part_no="TEST30776301").count(),
            2,
        )

    def test_queue_search_finds_dictionary_and_photo_colour_terms(self):
        self._enqueue_and_complete()

        by_defect = self.client.get(
            reverse("quality-classification-audit"),
            {"status": "all", "search": "색차"},
        )
        by_colour = self.client.get(
            reverse("quality-classification-audit"),
            {"status": "all", "search": "백색"},
        )

        self.assertEqual(by_defect.status_code, 200, by_defect.data)
        self.assertEqual(by_colour.status_code, 200, by_colour.data)
        self.assertEqual(by_defect.data["count"], 1)
        self.assertEqual(by_colour.data["count"], 1)

    def test_category_only_review_keeps_unresolved_colour_in_attention_queue(self):
        job = self._enqueue_and_complete()
        review = self.client.post(
            reverse("quality-classification-audit-review", args=[job.pk]),
            {
                "action": "accepted",
                "category_keys": ["color_difference"],
                "product_color_key": None,
            },
            format="json",
        )
        self.assertEqual(review.status_code, 200, review.data)
        self.assertIn(
            "master_color_mismatch",
            review.data["review"]["unresolved_reason_codes"],
        )
        job.refresh_from_db()
        self.assertTrue(job.result_payload["review_required"])

        queue = self.client.get(
            reverse("quality-classification-audit"),
            {"report_id": self.report.pk, "status": "attention"},
        )
        self.assertEqual(queue.status_code, 200, queue.data)
        self.assertEqual(queue.data["count"], 1)
        self.assertEqual(queue.data["results"][0]["queue_status"], "needs_review")

    def test_human_override_is_searchable_and_undetermined_colour_abstains(self):
        job = self._enqueue_and_complete()
        review = self.client.post(
            reverse("quality-classification-audit-review", args=[job.pk]),
            {
                "action": "overridden",
                "category_keys": ["black_dot"],
                "product_color_key": "undetermined",
            },
            format="json",
        )
        self.assertEqual(review.status_code, 200, review.data)

        by_human_category = self.client.get(
            reverse("quality-classification-audit"),
            {"status": "all", "search": "흑점"},
        )
        self.assertEqual(by_human_category.status_code, 200, by_human_category.data)
        self.assertEqual(by_human_category.data["count"], 1)
        self.assertIsNone(
            by_human_category.data["results"][0]["exact_part_consensus"]
        )

    def test_verified_full_part_colours_never_cross_between_similar_numbers(self):
        gray_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status=AiJob.STATUS_COMPLETED,
            result_payload={
                "available": True,
                "review": {
                    "status": "accepted",
                    "exact_part_no": "ACQ30776301",
                    "product_color_key": "gray",
                },
            },
        )
        white_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status=AiJob.STATUS_COMPLETED,
            result_payload={
                "available": True,
                "review": {
                    "status": "accepted",
                    "exact_part_no": "ACQ30726701",
                    "product_color_key": "white",
                },
            },
        )

        consensus = _exact_part_consensus({1: gray_job, 2: white_job})

        self.assertEqual(consensus["ACQ30776301"]["dominant_color_key"], "gray")
        self.assertEqual(consensus["ACQ30726701"]["dominant_color_key"], "white")
        self.assertEqual(set(consensus), {"ACQ30776301", "ACQ30726701"})

    def test_worker_claim_accepts_only_the_explicit_report_audit_mode(self):
        enqueue = self.client.post(
            reverse("quality-classification-audit"),
            {"report_ids": [self.report.pk], "limit": 1},
            format="json",
        )
        job_id = enqueue.data["created_job_ids"][0]
        AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope={"mode": "untrusted_mode", "trigger": "quality_report_scan"},
            input_payload={},
        )
        self.client.force_authenticate(user=None)

        incapable = self.client.post(
            "/api/ai/jobs/claim/",
            {
                "worker_name": "old-worker",
                "worker_version": "production-ai-worker-v2",
                "limit": 2,
                "job_types": [AiJob.JOB_TYPE_QUALITY_IMAGE],
                "available_model_ids": [],
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )
        self.assertEqual(incapable.status_code, 200, incapable.data)
        self.assertEqual(incapable.data["jobs"], [])

        response = self.client.post(
            "/api/ai/jobs/claim/",
            {
                "worker_name": "test-worker",
                "worker_version": "production-ai-worker-v2",
                "limit": 2,
                "job_types": [AiJob.JOB_TYPE_QUALITY_IMAGE],
                "available_model_ids": ["qwen38"],
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual([row["id"] for row in response.data["jobs"]], [job_id])
        self.assertEqual(response.data["jobs"][0]["scope"]["model_id"], "qwen38")

    def test_claimed_audit_starts_with_serialized_claim_timestamp(self):
        enqueue = self.client.post(
            reverse("quality-classification-audit"),
            {"report_ids": [self.report.pk], "limit": 1},
            format="json",
        )
        job = AiJob.objects.get(pk=enqueue.data["created_job_ids"][0])
        job.status = AiJob.STATUS_CLAIMED
        job.claimed_by = "test-worker"
        job.claimed_at = timezone.now()
        job.save(update_fields=["status", "claimed_by", "claimed_at", "updated_at"])
        self.client.force_authenticate(user=None)

        response = self.client.post(
            f"/api/ai/jobs/{job.pk}/start/",
            {
                "worker_name": "test-worker",
                "claim_timestamp": job.claimed_at.isoformat(),
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["status"], AiJob.STATUS_RUNNING)

    def test_backdated_colour_version_clones_only_the_effective_spec(self):
        PartSpec.objects.create(
            part_no="TEST30776301",
            model_code="FUTURE-MODEL",
            color="BLACK",
            cavity=99,
            valid_from=timezone.localdate() + timedelta(days=10),
        )
        job = self._enqueue_and_complete()
        review = self.client.post(
            reverse("quality-classification-audit-review", args=[job.pk]),
            {
                "action": "accepted",
                "category_keys": ["color_difference"],
                "product_color_key": "white",
            },
            format="json",
        )
        self.assertEqual(review.status_code, 200, review.data)

        apply = self.client.post(
            reverse("quality-classification-audit-apply-color", args=[job.pk]),
            {
                "color_key": "white",
                "valid_from": timezone.localdate().isoformat(),
                "confirmation": "CONFIRM_EXACT_PART_COLOR",
            },
            format="json",
        )

        self.assertEqual(apply.status_code, 201, apply.data)
        created = PartSpec.objects.get(pk=apply.data["part_spec"]["id"])
        self.assertEqual(created.model_code, "24G411")
        self.assertEqual(created.cavity, 2)

    def test_review_rejects_a_changed_report_revision(self):
        job = self._enqueue_and_complete()
        self.report.phenomenon = "黑点"
        self.report.save(update_fields=["phenomenon", "updated_at"])

        response = self.client.post(
            reverse("quality-classification-audit-review", args=[job.pk]),
            {
                "action": "accepted",
                "category_keys": ["color_difference"],
                "product_color_key": "white",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data["code"], "stale_revision")

    def test_stale_worker_claim_cannot_complete_a_reclaimed_audit(self):
        enqueue = self.client.post(
            reverse("quality-classification-audit"),
            {"report_ids": [self.report.pk], "limit": 1},
            format="json",
        )
        job = AiJob.objects.get(pk=enqueue.data["created_job_ids"][0])
        old_claimed_at = timezone.now() - timedelta(minutes=10)
        job.status = AiJob.STATUS_RUNNING
        job.claimed_by = "replacement-worker"
        job.claimed_at = timezone.now()
        job.save(update_fields=["status", "claimed_by", "claimed_at", "updated_at"])
        self.client.force_authenticate(user=None)

        response = self.client.post(
            f"/api/ai/jobs/{job.pk}/complete/",
            {
                "result_payload": {},
                "model_name": "Qwen3.8-27B-4bit",
                "prompt_version": QUALITY_REPORT_AUDIT_PROMPT_VERSION,
                "worker_name": "old-worker",
                "claim_timestamp": old_claimed_at.isoformat(),
            },
            format="json",
            HTTP_X_AI_WORKER_TOKEN="test-worker-token",
        )

        self.assertEqual(response.status_code, 403, response.data)
        job.refresh_from_db()
        self.assertEqual(job.status, AiJob.STATUS_RUNNING)
        self.assertEqual(job.claimed_by, "replacement-worker")

    def test_same_prefix_different_suffix_is_not_used_as_an_exact_colour_match(self):
        related = QualityReport.objects.create(
            report_dt=timezone.now(),
            section="LQC_INJ",
            model="24G411",
            part_no="ACQ30776399",
            phenomenon="흑점",
        )
        payload, _revision = build_quality_report_audit_input(related)

        self.assertEqual(payload["part_spec"]["match_basis"], "no_exact_part_spec")
        self.assertIsNone(payload["part_spec"]["color_key"])

    def test_steady_state_periodic_scan_uses_bounded_queries(self):
        for index in range(8):
            QualityReport.objects.create(
                report_dt=timezone.now(),
                section="LQC_INJ",
                model="24G411",
                part_no=f"ACQ30776{400 + index}",
                phenomenon="色差",
            )
        enqueue_stale_quality_report_audits(limit=50)

        with self.assertNumQueries(3):
            result = enqueue_stale_quality_report_audits(limit=5)

        self.assertEqual(result["created_count"], 0)

    def test_viewer_can_read_queue_but_cannot_enqueue_or_write_master_colour(self):
        viewer = get_user_model().objects.create_user(username="audit-viewer")
        viewer.profile.can_view_quality = True
        viewer.profile.can_edit_quality = False
        viewer.profile.can_edit_injection = False
        viewer.profile.save(update_fields=[
            "can_view_quality", "can_edit_quality", "can_edit_injection",
        ])
        self.client.force_authenticate(viewer)

        self.assertEqual(
            self.client.get(reverse("quality-classification-audit")).status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/injection/parts/").status_code, 200)
        self.assertEqual(
            self.client.post(
                reverse("quality-classification-audit"),
                {"report_ids": [self.report.pk], "limit": 1},
                format="json",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                reverse("quality-classification-audit-apply-color", args=[999]),
                {
                    "color_key": "white",
                    "valid_from": timezone.localdate().isoformat(),
                    "confirmation": "CONFIRM_EXACT_PART_COLOR",
                },
                format="json",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/injection/parts/",
                {
                    "part_no": "UNAUTHORIZED",
                    "model_code": "TEST",
                    "valid_from": timezone.localdate().isoformat(),
                },
                format="json",
            ).status_code,
            403,
        )

    def test_assembly_editor_keeps_existing_part_spec_create_workflow(self):
        assembly_editor = get_user_model().objects.create_user(
            username="assembly-part-editor"
        )
        assembly_editor.profile.can_edit_assembly = True
        assembly_editor.profile.can_edit_injection = False
        assembly_editor.profile.save(update_fields=[
            "can_edit_assembly", "can_edit_injection",
        ])
        self.client.force_authenticate(assembly_editor)

        response = self.client.post(
            "/api/injection/parts/",
            {
                "part_no": "ASSEMBLY-NEW-PART",
                "model_code": "ASSEMBLY-MODEL",
                "valid_from": timezone.localdate().isoformat(),
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201, response.data)

    def test_only_a_human_reviewed_current_revision_overrides_daily_classification(self):
        ProductionPlan.objects.create(
            plan_date=timezone.localdate(),
            plan_type="injection",
            machine_name="850T-9",
            model_name="24G411",
            part_no="TEST30776301",
            lot_no="LOT-1",
            planned_quantity=100,
            sequence=1,
        )
        before = build_daily_quality_attention(timezone.localdate(), include_images=False)
        before_hash = before["source_evidence_hash"]
        self.assertIn(
            "color_difference",
            {row.get("canonical_key") for row in before["report_metrics"]["problem_types"]},
        )
        job = self._enqueue_and_complete()

        review = self.client.post(
            reverse("quality-classification-audit-review", args=[job.pk]),
            {
                "action": "overridden",
                "category_keys": ["black_dot"],
                "product_color_key": "white",
                "note": "원문과 사진을 함께 재검토",
            },
            format="json",
        )
        self.assertEqual(review.status_code, 200, review.data)
        cache.clear()

        after = build_daily_quality_attention(timezone.localdate(), include_images=False)
        problem_types = {
            row.get("canonical_key"): row
            for row in after["report_metrics"]["problem_types"]
        }
        self.assertNotIn("color_difference", problem_types)
        self.assertEqual(
            [
                row["canonical_key"]
                for row in problem_types["color_black_material"]["observed_terms"]
            ],
            ["black_dot"],
        )
        self.assertNotEqual(before_hash, after["source_evidence_hash"])
