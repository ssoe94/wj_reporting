from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.db.models.signals import post_init
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from ai_core.models import AiJob
from ai_core.quality_report_audit import (
    QUALITY_REPORT_AUDIT_MODE,
    QUALITY_REPORT_AUDIT_PROMPT_VERSION,
    QUALITY_REPORT_AUDIT_TRIGGER,
    QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
)
from injection.models import PartSpec
from production.models import ProductionPlan

from .classification_audit import (
    QUALITY_REPORT_AUDIT_BACKLOG_LIMIT,
    _exact_part_consensus,
    approved_quality_report_classifications,
    build_quality_report_audit_input,
    enqueue_quality_report_audit,
    enqueue_stale_quality_report_audits,
    taxonomy_candidates,
)
from . import classification_audit as audit_module
from .daily_attention import build_daily_quality_attention
from .models import QualityReport
from .injection_terminology import INJECTION_TERMINOLOGY_VERSION


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

    def test_gas_mark_and_whitening_are_independent_audit_candidates(self):
        candidates = {
            row["key"]: row
            for row in taxonomy_candidates()
        }

        self.assertNotIn("gas_mark_whitening", candidates)
        self.assertIsNone(candidates["air_mark"]["parent_key"])
        self.assertEqual(candidates["air_mark"]["label"]["zh"], "气印")
        self.assertIsNone(candidates["whitening"]["parent_key"])
        self.assertEqual(candidates["whitening"]["label"]["zh"], "发白·白印")

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

    def test_queue_batches_keep_global_counts_page_order_and_exact_part_consensus(self):
        reports = [
            QualityReport.objects.create(
                report_dt=self.report.report_dt + timedelta(minutes=index + 1),
                section="LQC_INJ",
                model="24G411",
                part_no="OTHER30776399" if index == 3 else "TEST30776301",
                phenomenon="色差",
            )
            for index in range(6)
        ]

        def add_job(report, status, result_payload, *, revision=None):
            current_revision = revision or build_quality_report_audit_input(report)[1]
            return AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                status=status,
                scope={
                    "mode": QUALITY_REPORT_AUDIT_MODE,
                    "trigger": QUALITY_REPORT_AUDIT_TRIGGER,
                    "report_id": report.pk,
                    "source_revision": current_revision,
                },
                result_payload=result_payload,
                input_payload={"large_unused_input": "x" * 16_384},
            )

        def reviewed(color):
            return {
                "available": True,
                "review": {
                    "status": "accepted",
                    "exact_part_no": "TEST30776301",
                    "product_color_key": color,
                },
            }

        add_job(reports[0], AiJob.STATUS_COMPLETED, {
            "available": True, "review_required": False,
        })
        # A newer stale job must not hide the older job for the current revision.
        add_job(reports[0], AiJob.STATUS_FAILED, {}, revision="stale-revision")
        add_job(reports[1], AiJob.STATUS_COMPLETED, reviewed("black"))
        add_job(reports[2], AiJob.STATUS_FAILED, {})
        add_job(reports[3], AiJob.STATUS_PENDING, {})
        # The newest reviewed job belongs to the oldest report, so batch order
        # must not decide a tied colour consensus.
        add_job(self.report, AiJob.STATUS_COMPLETED, reviewed("white"))

        loaded_jobs = []
        loaded_reports = []

        def capture_job(sender, instance, **kwargs):
            loaded_jobs.append(instance.get_deferred_fields())

        def capture_report(sender, instance, **kwargs):
            loaded_reports.append(instance.get_deferred_fields())

        post_init.connect(capture_job, sender=AiJob, weak=False)
        post_init.connect(capture_report, sender=QualityReport, weak=False)
        try:
            with patch.object(audit_module, "QUALITY_REPORT_AUDIT_QUEUE_BATCH_SIZE", 3), \
                    patch.object(audit_module, "_latest_jobs_by_current_revision", wraps=audit_module._latest_jobs_by_current_revision) as batches, \
                    patch.object(audit_module, "_canonical_problem_types", wraps=audit_module._canonical_problem_types) as classify, \
                    patch.object(audit_module, "taxonomy_candidates", wraps=audit_module.taxonomy_candidates) as taxonomy:
                first = self.client.get(reverse("quality-classification-audit"), {
                    "status": "attention", "page": 1, "page_size": 2,
                })
        finally:
            post_init.disconnect(capture_job, sender=AiJob)
            post_init.disconnect(capture_report, sender=QualityReport)

        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(first.data["count"], 4)
        self.assertEqual(first.data["stats"], {
            "total": 7, "with_images": 1, "unprocessed": 2,
            "pending": 1, "failed": 1, "matched": 1, "reviewed": 2,
        })
        self.assertEqual(
            [row["report"]["id"] for row in first.data["results"]],
            [reports[5].pk, reports[4].pk],
        )
        self.assertEqual(first.data["next_page"], 2)
        self.assertIsNone(first.data["previous_page"])
        self.assertEqual(
            first.data["results"][0]["exact_part_consensus"]["color_counts"],
            {"black": 1, "white": 1},
        )
        self.assertEqual(
            first.data["results"][0]["exact_part_consensus"]["dominant_color_key"],
            "white",
        )
        self.assertEqual([len(call.args[0]) for call in batches.call_args_list], [3, 3, 1])
        self.assertEqual(classify.call_count, 2)
        self.assertEqual(taxonomy.call_count, 1)
        self.assertTrue(loaded_jobs)
        self.assertTrue(all("input_payload" in deferred for deferred in loaded_jobs))
        self.assertTrue(loaded_reports)
        self.assertTrue(all("excel_source" in deferred for deferred in loaded_reports))

        second = self.client.get(reverse("quality-classification-audit"), {
            "status": "attention", "page": 2, "page_size": 2,
        })
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(second.data["count"], 4)
        self.assertEqual(
            [row["report"]["id"] for row in second.data["results"]],
            [reports[3].pk, reports[2].pk],
        )
        self.assertEqual(second.data["previous_page"], 1)
        self.assertIsNone(second.data["next_page"])

        searched = self.client.get(reverse("quality-classification-audit"), {
            "status": "attention", "search": "TEST30776301", "page_size": 2,
        })
        self.assertEqual(searched.status_code, 200, searched.data)
        self.assertEqual(searched.data["count"], 3)
        self.assertEqual(searched.data["stats"], first.data["stats"])

        all_reports = self.client.get(reverse("quality-classification-audit"), {
            "status": "all", "page_size": 2,
        })
        self.assertEqual(all_reports.status_code, 200, all_reports.data)
        self.assertEqual(all_reports.data["count"], 7)

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
        AiJob.objects.filter(scope__trigger=QUALITY_REPORT_AUDIT_TRIGGER).update(
            status=AiJob.STATUS_COMPLETED,
        )

        # backlog count + reports + part specs + existing jobs
        with self.assertNumQueries(4):
            result = enqueue_stale_quality_report_audits(limit=5)

        self.assertEqual(result["created_count"], 0)
        self.assertNotIn("skipped_reason", result)

    def test_bulk_audit_enqueue_waits_behind_a_pending_backlog(self):
        reports = [
            QualityReport.objects.create(
                report_dt=timezone.now(),
                section="LQC_INJ",
                model="24G411",
                part_no=f"ACQ30776{500 + index}",
                phenomenon="色差",
            )
            for index in range(QUALITY_REPORT_AUDIT_BACKLOG_LIMIT + 2)
        ]
        for report in reports[:QUALITY_REPORT_AUDIT_BACKLOG_LIMIT]:
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                status=AiJob.STATUS_PENDING if report.pk % 2 else AiJob.STATUS_CLAIMED,
                scope={
                    "mode": QUALITY_REPORT_AUDIT_MODE,
                    "trigger": QUALITY_REPORT_AUDIT_TRIGGER,
                    "report_id": report.pk,
                    "source_revision": "stale-revision",
                    "model_id": "qwen38",
                },
            )

        periodic = enqueue_stale_quality_report_audits(bounded_scan=True)
        bulk = enqueue_stale_quality_report_audits(limit=100)

        self.assertEqual(periodic["created_count"], 0)
        self.assertEqual(periodic["skipped_reason"], "audit_backlog")
        self.assertEqual(periodic["backlog_count"], QUALITY_REPORT_AUDIT_BACKLOG_LIMIT)
        self.assertEqual(bulk["created_count"], 0)
        self.assertEqual(bulk["skipped_reason"], "audit_backlog")

        # Explicit per-report requests (create/update hook, "analyse this
        # report") keep working while the backlog drains.
        explicit = enqueue_stale_quality_report_audits(
            limit=5,
            report_ids=[reports[-1].pk],
        )
        self.assertEqual(explicit["created_count"], 1)
        self.assertNotIn("skipped_reason", explicit)
        _, created = enqueue_quality_report_audit(reports[-2])
        self.assertTrue(created)

        AiJob.objects.filter(scope__source_revision="stale-revision").update(
            status=AiJob.STATUS_COMPLETED,
        )
        drained = enqueue_stale_quality_report_audits(bounded_scan=True)
        self.assertNotIn("skipped_reason", drained)
        self.assertGreater(drained["created_count"], 0)

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


class ApprovedQualityClassificationQueryTests(TestCase):
    def test_only_reviewed_rows_are_loaded_without_audit_input_and_latest_current_wins(self):
        reports = [
            QualityReport.objects.create(
                report_dt=timezone.now(), section="LQC_INJ",
                part_no=f"QUERYTEST{index}", phenomenon="色差",
                image1=f"https://res.cloudinary.com/example/image/upload/v123/report-{index}.jpg",
            )
            for index in range(4)
        ]
        revisions = {
            report.pk: build_quality_report_audit_input(report)[0]["report_source_revision"]
            for report in reports
        }

        def audit(report, review_status, category, *, stale=False):
            return AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                status=AiJob.STATUS_COMPLETED,
                scope={
                    "mode": QUALITY_REPORT_AUDIT_MODE,
                    "trigger": QUALITY_REPORT_AUDIT_TRIGGER,
                    "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
                    "report_id": report.pk,
                },
                input_payload={"large_unused_audit_input": "x" * 32768},
                result_payload={"review": {
                    "status": review_status,
                    "report_source_revision": "stale" if stale else revisions[report.pk],
                    "category_keys": [category],
                    "reviewed_at": timezone.now().isoformat(),
                }},
            )

        accepted = audit(reports[0], "accepted", "color_difference")
        unreviewed = audit(reports[0], "pending", "whitening")
        stale_newer = audit(reports[0], "accepted", "whitening", stale=True)
        older_valid = audit(reports[1], "accepted", "color_difference")
        overridden = audit(reports[1], "overridden", "whitening")
        stale_only = audit(reports[2], "overridden", "color_difference", stale=True)
        unreviewed_only = audit(reports[3], "pending", "whitening")
        missing_review = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status=AiJob.STATUS_COMPLETED,
            scope=dict(unreviewed_only.scope),
            input_payload={"large_unused_audit_input": "x" * 32768},
            result_payload={},
        )

        loaded_jobs = {}

        def capture_loaded_job(sender, instance, **kwargs):
            loaded_jobs[instance.pk] = instance.get_deferred_fields()

        post_init.connect(capture_loaded_job, sender=AiJob, weak=False)
        try:
            with CaptureQueriesContext(connection) as queries:
                classifications, revision_rows = approved_quality_report_classifications(reports)
        finally:
            post_init.disconnect(capture_loaded_job, sender=AiJob)

        self.assertEqual(set(classifications), {reports[0].pk, reports[1].pk})
        self.assertEqual([row["key"] for row in classifications[reports[0].pk]], ["color_difference"])
        self.assertEqual([row["key"] for row in classifications[reports[1].pk]], ["whitening"])
        rows_by_report = {row["report_id"]: row for row in revision_rows}
        self.assertEqual(rows_by_report[reports[0].pk]["job_id"], accepted.pk)
        self.assertEqual(rows_by_report[reports[0].pk]["review_status"], "accepted")
        self.assertEqual(rows_by_report[reports[1].pk]["job_id"], overridden.pk)
        self.assertEqual(rows_by_report[reports[1].pk]["review_status"], "overridden")
        self.assertEqual(set(loaded_jobs), {
            accepted.pk, stale_newer.pk, older_valid.pk, overridden.pk, stale_only.pk,
        })
        for ignored in (unreviewed, unreviewed_only, missing_review):
            self.assertNotIn(ignored.pk, loaded_jobs)
        self.assertTrue(all("input_payload" in deferred for deferred in loaded_jobs.values()))
        audit_queries = [row["sql"] for row in queries if 'FROM "ai_core_aijob"' in row["sql"]]
        self.assertEqual(len(audit_queries), 1)
        projection = audit_queries[0].split(" FROM ", 1)[0]
        self.assertNotIn('"input_payload"', projection)
        self.assertIn('"scope"', projection)
        self.assertIn('"result_payload"', projection)


class QualityAuditScanGoldenTests(TestCase):
    """Freeze complete scan outputs before changing its loading strategy."""

    def setUp(self):
        from datetime import datetime, timezone as datetime_timezone

        self.now = datetime(2026, 11, 18, 8, 0, tzinfo=datetime_timezone.utc)
        self.clock = patch("quality.classification_audit.timezone.now", return_value=self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.actor = get_user_model().objects.create_user(username="SYNTHETIC-audit-owner")
        self.next_report_id = 910000

    def report(self, *, minutes=0):
        self.next_report_id += 1
        return QualityReport.objects.create(
            id=self.next_report_id,
            report_dt=self.now - timedelta(minutes=minutes),
            image1="https://example.invalid/SYNTHETIC-image1.jpg",
            image2="https://example.invalid/SYNTHETIC-image2.jpg",
            section="SYNTHETIC-INJ",
            model="SYNTHETIC-model",
            part_no=f"SYNTHETIC-{self.next_report_id}",
            phenomenon="SYNTHETIC surface color",
            action_result="SYNTHETIC action",
            inspection_qty=100,
            defect_qty=1,
        )

    def payload_and_scope(self, report):
        payload, revision = build_quality_report_audit_input(report)
        scope = {
            "mode": QUALITY_REPORT_AUDIT_MODE,
            "trigger": QUALITY_REPORT_AUDIT_TRIGGER,
            "report_id": report.pk,
            "source_revision": revision,
            "report_source_revision": payload["report_source_revision"],
            "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
            "model_id": "qwen38",
        }
        return payload, scope

    def existing(self, report, *, status=AiJob.STATUS_COMPLETED, result=None,
                 age=timedelta(minutes=6), scope_changes=None, large=False):
        payload, scope = self.payload_and_scope(report)
        scope.update(scope_changes or {})
        if large:
            payload = payload | {"synthetic_padding": "SYNTHETIC-" * 8192}
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status=status,
            scope=scope,
            input_payload=payload,
            result_payload={} if result is None else result,
        )
        AiJob.objects.filter(pk=job.pk).update(updated_at=self.now - age)
        return job

    def assert_scan(self, reports, *, examined, eligible, total=None, **kwargs):
        expected = [self.payload_and_scope(report) for report in reports]
        before = set(AiJob.objects.values_list("id", flat=True))
        result = enqueue_stale_quality_report_audits(created_by=self.actor, **kwargs)
        created = list(AiJob.objects.exclude(pk__in=before).order_by("id"))
        self.assertEqual(result, {
            "created_count": len(reports),
            "created_job_ids": [job.pk for job in created],
            "examined_count": examined,
            "total_report_count": examined if total is None else total,
            "eligible_count": eligible,
            "remaining_count": max(0, eligible - len(reports)),
        })
        self.assertEqual(len(created), len(reports))
        for job, (payload, scope) in zip(created, expected):
            self.assertEqual(job.job_type, AiJob.JOB_TYPE_QUALITY_IMAGE)
            self.assertEqual(job.status, AiJob.STATUS_PENDING)
            self.assertEqual(job.scope, scope)
            self.assertEqual(job.input_payload, payload)
            self.assertEqual(job.created_by_id, self.actor.pk)

    def test_new_report_creates_exact_payload_scope_and_actor(self):
        report = self.report()
        PartSpec.objects.create(
            part_no=report.part_no, model_code="SYNTHETIC-model", color="SYNTHETIC-color",
            cavity=2, valid_from=self.now.date() - timedelta(days=1),
        )
        self.assert_scan([report], examined=1, eligible=1, report_ids=[report.pk])

    def test_latest_completed_available_blocks_older_failure(self):
        report = self.report()
        self.existing(report, status=AiJob.STATUS_FAILED)
        self.existing(report, result={"available": True})
        self.assert_scan([], examined=1, eligible=0, report_ids=[report.pk])

    def test_latest_failure_retries_despite_older_available_result(self):
        report = self.report()
        self.existing(report, result={"available": True})
        self.existing(report, status=AiJob.STATUS_FAILED)
        self.assert_scan([report], examined=1, eligible=1, report_ids=[report.pk])

    def test_status_and_retry_age_contract(self):
        scenarios = [
            (AiJob.STATUS_PENDING, 6, False),
            (AiJob.STATUS_CLAIMED, 6, False),
            (AiJob.STATUS_RUNNING, 6, False),
            (AiJob.STATUS_CANCELLED, 6, False),
            (AiJob.STATUS_FAILED, 6, True),
            (AiJob.STATUS_FAILED, 4, False),
            (AiJob.STATUS_FAILED, 5, True),
            (AiJob.STATUS_COMPLETED, 4, False),
        ]
        for state, age, retry in scenarios:
            with self.subTest(status=state, age_minutes=age):
                report = self.report()
                self.existing(report, status=state, age=timedelta(minutes=age))
                self.assert_scan([report] if retry else [], examined=1,
                                 eligible=int(retry), report_ids=[report.pk])

    def test_available_uses_python_boolean_identity(self):
        scenarios = [
            ("true", {"available": True}, False),
            ("missing", {}, True),
            ("false", {"available": False}, True),
            ("null", {"available": None}, True),
            ("integer", {"available": 1}, True),
            ("string", {"available": "true"}, True),
            ("list", ["SYNTHETIC-result"], True),
        ]
        for label, payload, retry in scenarios:
            with self.subTest(case=label):
                report = self.report()
                self.existing(report, result=payload)
                self.assert_scan([report] if retry else [], examined=1,
                                 eligible=int(retry), report_ids=[report.pk])

    def test_changed_report_revision_does_not_reuse_old_job(self):
        report = self.report()
        self.existing(report, result={"available": True})
        report.phenomenon = "SYNTHETIC revised surface"
        report.save(update_fields=["phenomenon"])
        self.assert_scan([report], examined=1, eligible=1, report_ids=[report.pk])

    def test_cross_report_revision_is_not_a_match(self):
        first, second = self.report(minutes=1), self.report()
        _, second_scope = self.payload_and_scope(second)
        self.existing(first, result={"available": True},
                      scope_changes={"source_revision": second_scope["source_revision"]})
        self.assert_scan([second, first], examined=2, eligible=2,
                         report_ids=[first.pk, second.pk])

    def test_newer_cross_revision_does_not_hide_current_revision_match(self):
        first, second = self.report(minutes=1), self.report()
        self.existing(first, result={"available": True})
        _, second_scope = self.payload_and_scope(second)
        self.existing(first, result={}, status=AiJob.STATUS_FAILED,
                      scope_changes={"source_revision": second_scope["source_revision"]})
        self.assert_scan([second], examined=2, eligible=1,
                         report_ids=[first.pk, second.pk])

    def test_non_integer_report_identity_is_ignored(self):
        for identity in ("string", "boolean", "float"):
            with self.subTest(identity=identity):
                report = self.report()
                value = {"string": str(report.pk), "boolean": True, "float": float(report.pk)}[identity]
                self.existing(report, result={"available": True},
                              scope_changes={"report_id": value})
                self.assert_scan([report], examined=1, eligible=1,
                                 report_ids=[report.pk])

    def test_limit_counts_all_eligible_and_preserves_report_order(self):
        older = self.report(minutes=1)
        first = self.report()
        second = self.report()
        self.assert_scan([second, first], examined=3, eligible=3, limit=2)

    def test_backlog_returns_entire_skip_contract(self):
        report = self.report()
        for i in range(10):
            self.existing(report, status=AiJob.STATUS_PENDING if i % 2 else AiJob.STATUS_CLAIMED)
        self.assertEqual(enqueue_stale_quality_report_audits(bounded_scan=True), {
            "created_count": 0, "created_job_ids": [], "examined_count": 0,
            "total_report_count": None, "eligible_count": 0, "remaining_count": 0,
            "skipped_reason": "audit_backlog", "backlog_count": 10,
            "backlog_limit": QUALITY_REPORT_AUDIT_BACKLOG_LIMIT,
        })

    def test_bounded_scan_selects_each_epoch_minute_page(self):
        reports = [self.report() for _ in range(201)]
        ordered = list(reversed(reports))
        from datetime import datetime, timezone as datetime_timezone

        # Three UTC minutes whose epoch-minute remainder is 0, 1 and 2.
        epoch_minute = int(self.now.timestamp() // 60)
        epoch_minute -= epoch_minute % 3
        for page in range(3):
            with self.subTest(page=page):
                AiJob.objects.all().delete()
                fixed = datetime.fromtimestamp((epoch_minute + page) * 60, datetime_timezone.utc)
                with patch("quality.classification_audit.timezone.now", return_value=fixed):
                    selected = ordered[page * 100:(page + 1) * 100]
                    self.assert_scan(selected[:5], examined=len(selected),
                                     eligible=len(selected), total=201,
                                     bounded_scan=True)

    def test_explicit_and_manual_bulk_paths_return_same_contract(self):
        reports = [self.report(minutes=i) for i in range(3)]
        for kwargs in ({"report_ids": [r.pk for r in reversed(reports)]},
                       {"report_ids": None, "bounded_scan": False}):
            with self.subTest(kwargs=kwargs):
                AiJob.objects.all().delete()
                self.assert_scan(reports[:2], examined=3, eligible=3, limit=2, **kwargs)

    def test_large_existing_json_does_not_change_latest_result(self):
        report = self.report()
        for _ in range(3):
            self.existing(report, status=AiJob.STATUS_FAILED, large=True,
                          result={"synthetic_padding": "SYNTHETIC-" * 8192})
        self.existing(report, large=True, result={
            "available": True, "synthetic_padding": "SYNTHETIC-" * 8192,
        })
        self.assert_scan([], examined=1, eligible=0, report_ids=[report.pk])

