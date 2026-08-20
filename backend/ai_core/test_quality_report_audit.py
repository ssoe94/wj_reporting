from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from injection.models import PartSpec
from quality.classification_audit import enqueue_quality_report_audit
from quality.models import QualityReport

from .quality_report_audit import (
    QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
    restore_authoritative_quality_report_audit_result,
)


class QualityReportAuditContractTests(TestCase):
    def setUp(self):
        self.report = QualityReport.objects.create(
            report_dt=timezone.now(),
            section="LQC_INJ",
            model="24G411",
            part_no="TEST30776301",
            phenomenon="表面色差需要调整",
            image1="https://res.cloudinary.com/example/image/upload/v123/quality/report.jpg",
        )
        PartSpec.objects.create(
            part_no="TEST30776301",
            model_code="24G411",
            color="BLACK",
            valid_from=(timezone.localdate() - timedelta(days=1)),
        )

    def test_worker_indices_and_visual_colour_are_restored_with_server_identity(self):
        job, created = enqueue_quality_report_audit(self.report)
        self.assertTrue(created)
        candidate_index = next(
            index
            for index, row in enumerate(job.input_payload["taxonomy_candidates"])
            if row["key"] == "color_difference"
        )
        worker_result = {
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
                "confidence": "medium",
                "uncertainty_codes": ["lighting"],
                "part_no": "WORKER-MUST-NOT-CONTROL-THIS",
            }],
            "review_reason_codes": [],
            "part_no": "WORKER-MUST-NOT-CONTROL-THIS",
        }

        restored = restore_authoritative_quality_report_audit_result(job, worker_result)

        self.assertTrue(restored["available"])
        self.assertEqual(restored["report"]["id"], self.report.pk)
        self.assertEqual(restored["report"]["part_no"], "TEST30776301")
        self.assertEqual(
            restored["qwen_classification"]["candidate_selections"][0]["key"],
            "color_difference",
        )
        self.assertEqual(
            restored["product_color_suggestion"]["suggested_color_key"],
            "white",
        )
        self.assertEqual(
            restored["product_color_suggestion"]["match_basis"],
            "exact_quality_report_part_no",
        )
        self.assertEqual(restored["master_color_comparison"]["status"], "mismatch")
        self.assertIn("master_color_mismatch", restored["review_reason_codes"])

    def test_product_colour_abstains_when_images_disagree(self):
        job, _created = enqueue_quality_report_audit(self.report)
        job.input_payload["report"]["image_refs"].append({
            "slot": "image2",
            "url": "https://res.cloudinary.com/example/image/upload/v124/quality/report-2.jpg",
            "immutable_reference": True,
            "reference_sha256": "b" * 64,
        })
        worker_result = {
            "schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
            "source": "local_qwen38_multimodal",
            "llm_fallback": False,
            "llm_attempted": True,
            "model_id": "qwen38",
            "defect_candidate_indices": [],
            "defect_confidence": "low",
            "needs_new_category": True,
            "evidence_basis": ["image"],
            "processed_images": [
                {"slot": "image1", "sha256": "a" * 64},
                {"slot": "image2", "sha256": "b" * 64},
            ],
            "image_observations": [
                {
                    "image_index": 0,
                    "product_visible": True,
                    "body_color_key": "white",
                    "confidence": "medium",
                    "uncertainty_codes": [],
                },
                {
                    "image_index": 1,
                    "product_visible": True,
                    "body_color_key": "black",
                    "confidence": "medium",
                    "uncertainty_codes": ["conflicting_images"],
                },
            ],
            "review_reason_codes": ["visual_color_uncertain"],
        }

        restored = restore_authoritative_quality_report_audit_result(job, worker_result)

        self.assertEqual(
            restored["product_color_suggestion"]["suggested_color_key"],
            "undetermined",
        )
        self.assertEqual(
            restored["product_color_suggestion"]["status"],
            "conflicting_images",
        )
        self.assertIn("visual_color_uncertain", restored["review_reason_codes"])

    def test_malformed_worker_payload_cannot_become_available(self):
        job, _created = enqueue_quality_report_audit(self.report)

        restored = restore_authoritative_quality_report_audit_result(job, {
            "schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
            "source": "local_qwen38_multimodal",
            "llm_fallback": False,
            "llm_attempted": True,
            "model_id": "qwen38",
            "defect_candidate_indices": [],
            "defect_confidence": "high",
            "needs_new_category": False,
            "evidence_basis": ["report_text"] * 100,
            "processed_images": [],
            "image_observations": [],
            "review_reason_codes": [],
        })

        self.assertFalse(restored["available"])
        self.assertEqual(restored["reason"], "invalid_worker_result")

    def test_wrong_model_or_unattempted_payload_cannot_become_available(self):
        job, _created = enqueue_quality_report_audit(self.report)
        worker_result = {
            "schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
            "source": "local_qwen38_multimodal",
            "llm_fallback": False,
            "llm_attempted": False,
            "model_id": "qwen35",
            "defect_candidate_indices": [],
            "defect_confidence": "high",
            "needs_new_category": False,
            "evidence_basis": ["report_text"],
            "processed_images": [],
            "image_observations": [],
            "review_reason_codes": [],
        }

        restored = restore_authoritative_quality_report_audit_result(job, worker_result)

        self.assertFalse(restored["available"])
        self.assertEqual(restored["reason"], "invalid_worker_result")

    def test_non_array_worker_fields_fail_closed_without_raising(self):
        job, _created = enqueue_quality_report_audit(self.report)

        restored = restore_authoritative_quality_report_audit_result(job, {
            "schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
            "source": "local_qwen38_multimodal",
            "llm_fallback": False,
            "llm_attempted": True,
            "model_id": "qwen38",
            "defect_candidate_indices": 1,
            "defect_confidence": "high",
            "needs_new_category": False,
            "evidence_basis": ["report_text"],
            "processed_images": 1,
            "image_observations": 1,
            "review_reason_codes": 1,
        })

        self.assertFalse(restored["available"])

    def test_uncertain_visual_match_still_requires_review(self):
        job, _created = enqueue_quality_report_audit(self.report)
        worker_result = {
            "schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
            "source": "local_qwen38_multimodal",
            "llm_fallback": False,
            "llm_attempted": True,
            "model_id": "qwen38",
            "defect_candidate_indices": [],
            "defect_confidence": "high",
            "needs_new_category": False,
            "evidence_basis": ["report_text", "image"],
            "processed_images": [{"slot": "image1", "sha256": "a" * 64}],
            "image_observations": [{
                "image_index": 0,
                "product_visible": True,
                "body_color_key": "black",
                "confidence": "low",
                "uncertainty_codes": ["glare"],
            }],
            "review_reason_codes": [],
        }

        restored = restore_authoritative_quality_report_audit_result(job, worker_result)

        self.assertEqual(restored["master_color_comparison"]["status"], "match")
        self.assertTrue(restored["review_required"])
        self.assertIn("visual_color_uncertain", restored["review_reason_codes"])

    def test_image_evidence_without_a_processed_image_is_rejected(self):
        job, _created = enqueue_quality_report_audit(self.report)
        restored = restore_authoritative_quality_report_audit_result(job, {
            "schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
            "source": "local_qwen38_multimodal",
            "llm_fallback": False,
            "llm_attempted": True,
            "model_id": "qwen38",
            "defect_candidate_indices": [],
            "defect_confidence": "high",
            "needs_new_category": False,
            "evidence_basis": ["image"],
            "processed_images": [],
            "image_observations": [],
            "review_reason_codes": [],
        })

        self.assertFalse(restored["available"])
