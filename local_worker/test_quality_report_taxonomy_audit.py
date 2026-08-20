import unittest
from unittest import mock

try:
    from .job_handlers import quality_report_taxonomy_audit as handler
    from .llm_client import LocalLlmClient
except ImportError:
    from job_handlers import quality_report_taxonomy_audit as handler
    from llm_client import LocalLlmClient


def audit_job():
    return {
        "id": 1,
        "job_type": "quality_image_analysis",
        "scope": {
            "mode": handler.MODE,
            "trigger": handler.TRIGGER,
            "model_id": "qwen38",
        },
        "input_payload": {
            "source": handler.SOURCE,
            "report": {
                "id": 9,
                "report_dt": "2026-08-20T09:00:00+08:00",
                "section": "LQC_INJ",
                "model": "24G411",
                "part_no": "TEST30776301",
                "phenomenon": "表面色差需要调整",
                "disposition": "",
                "action_result": "",
                "image_refs": [{
                    "slot": "image1",
                    "url": "https://res.cloudinary.com/example/image/upload/quality/one.jpg",
                }],
            },
            "part_spec": {"color_raw": "BLACK", "color_key": "black"},
            "deterministic_classification": [{"key": "color_difference"}],
            "taxonomy_candidates": [
                {"key": "color_difference", "parent_key": None, "label": {"ko": "색차", "zh": "色差"}},
                {"key": "black_dot", "parent_key": "color_black_material", "label": {"ko": "흑점", "zh": "黑点"}},
            ],
        },
    }


class QualityReportTaxonomyAuditHandlerTests(unittest.TestCase):
    def test_qwen_receives_verified_local_image_path_and_enum_schema(self):
        class FakeLlm:
            def __init__(self):
                self.kwargs = None
                self.payload = None

            def structured_analysis(self, _system_prompt, payload, **kwargs):
                self.payload = payload
                self.kwargs = kwargs
                return {
                    "defect_candidate_indices": [0],
                    "defect_confidence": "high",
                    "needs_new_category": False,
                    "evidence_basis": ["report_text", "image"],
                    "image_observations": [{
                        "image_index": 0,
                        "product_visible": True,
                        "body_color_key": "white",
                        "confidence": "medium",
                        "uncertainty_codes": ["lighting"],
                    }],
                    "review_reason_codes": ["master_color_mismatch"],
                }

        llm = FakeLlm()
        with (
            mock.patch.object(handler, "_download_image", return_value=(b"jpeg", "a" * 64)),
            mock.patch.object(handler, "_normalize_image"),
        ):
            result = handler.analyze_with_llm(
                audit_job(),
                llm,
                "Qwen3.8-27B-4bit",
                handler.build_dummy_result(audit_job()),
            )

        self.assertEqual(result["defect_candidate_indices"], [0])
        self.assertEqual(result["processed_images"][0]["slot"], "image1")
        self.assertEqual(result["image_observations"][0]["body_color_key"], "white")
        self.assertTrue(llm.kwargs["image_urls"][0].startswith("/"))
        self.assertNotIn("res.cloudinary.com", llm.kwargs["image_urls"][0])
        self.assertNotIn("part_no", llm.payload["report"])
        self.assertNotIn("part_spec_context", llm.payload)
        schema = llm.kwargs["json_schema"]
        self.assertEqual(
            schema["properties"]["image_observations"]["items"]
            ["properties"]["body_color_key"]["enum"],
            list(handler.COLOR_KEYS),
        )

    def test_five_images_are_observed_in_two_bounded_calls(self):
        job = audit_job()
        job["input_payload"]["report"]["image_refs"] = [
            {
                "slot": f"image{index}",
                "url": f"https://res.cloudinary.com/example/image/upload/quality/{index}.jpg",
            }
            for index in range(1, 6)
        ]

        class FakeLlm:
            def __init__(self):
                self.call_count = 0

            def structured_analysis(self, _system_prompt, _payload, **kwargs):
                self.call_count += 1
                image_count = len(kwargs["image_urls"])
                return {
                    "defect_candidate_indices": [0] if self.call_count == 1 else [1],
                    "defect_confidence": "high",
                    "needs_new_category": False,
                    "evidence_basis": ["report_text", "image"],
                    "image_observations": [
                        {
                            "image_index": index,
                            "product_visible": True,
                            "body_color_key": "white",
                            "confidence": "high",
                            "uncertainty_codes": [],
                        }
                        for index in range(image_count)
                    ],
                    "review_reason_codes": [],
                }

        llm = FakeLlm()
        with (
            mock.patch.object(handler, "_download_image", return_value=(b"jpeg", "a" * 64)),
            mock.patch.object(handler, "_normalize_image"),
        ):
            result = handler.analyze_with_llm(
                job,
                llm,
                "Qwen3.8-27B-4bit",
                handler.build_dummy_result(job),
            )

        self.assertEqual(llm.call_count, 2)
        self.assertEqual(len(result["processed_images"]), 5)
        self.assertEqual(
            [row["image_index"] for row in result["image_observations"]],
            [0, 1, 2, 3, 4],
        )
        self.assertEqual(result["defect_candidate_indices"], [0])
        self.assertIn("classification_disagreement", result["review_reason_codes"])

    def test_invalid_candidate_index_is_rejected_after_schema(self):
        with self.assertRaisesRegex(ValueError, "invalid taxonomy candidate"):
            handler._validate_model_result(
                {
                    "defect_candidate_indices": [99],
                    "defect_confidence": "high",
                    "needs_new_category": False,
                    "evidence_basis": ["report_text"],
                    "image_observations": [],
                    "review_reason_codes": [],
                },
                candidate_count=2,
                image_count=0,
            )


class LocalLlmMultimodalContractTests(unittest.TestCase):
    @mock.patch("requests.post")
    def test_client_builds_image_content_blocks_and_json_schema(self, post):
        response = mock.Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": '{"status":"ok"}'},
            }],
        }
        post.return_value = response
        client = LocalLlmClient(
            base_url="http://127.0.0.1:8082/v1",
            model="Qwen3.8-27B-4bit",
        )

        result = client.structured_analysis(
            "system",
            {"task": "audit"},
            image_urls=["/tmp/verified.jpg"],
            json_schema={
                "type": "object",
                "properties": {"status": {"type": "string"}},
                "required": ["status"],
                "additionalProperties": False,
            },
        )

        self.assertEqual(result, {"status": "ok"})
        sent = post.call_args.kwargs["json"]
        user_content = sent["messages"][1]["content"]
        self.assertEqual(user_content[0]["type"], "image_url")
        self.assertEqual(user_content[0]["image_url"]["url"], "/tmp/verified.jpg")
        self.assertEqual(sent["response_format"]["type"], "json_schema")


if __name__ == "__main__":
    unittest.main()
