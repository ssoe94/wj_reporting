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

            def structured_analysis(self, system_prompt, payload, **kwargs):
                self.system_prompt = system_prompt
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
        # Prefix-cache order: static taxonomy in the system prompt, per-report text last.
        self.assertIn("taxonomy_candidates", llm.system_prompt)
        self.assertIn('"candidate_index": 0', llm.system_prompt)
        self.assertIn("색차", llm.system_prompt)
        self.assertNotIn("taxonomy_candidates", llm.payload)
        self.assertEqual(list(llm.payload.keys())[-1], "report")
        self.assertEqual(llm.payload["image_count"], 1)
        self.assertNotIn("Qwen", llm.system_prompt)
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


def _observation(index, color="white", confidence="medium", codes=("lighting",), visible=True):
    return {
        "image_index": index,
        "product_visible": visible,
        "body_color_key": color,
        "confidence": confidence,
        "uncertainty_codes": list(codes),
    }


def _result(observations):
    return {
        "defect_candidate_indices": [0],
        "defect_confidence": "high",
        "needs_new_category": False,
        "evidence_basis": ["report_text", "image"],
        "image_observations": observations,
        "review_reason_codes": [],
    }


class DuplicateObservationReconciliationTests(unittest.TestCase):
    SAME = "a" * 64
    OTHER = "b" * 64

    def test_identical_duplicate_is_rehomed_onto_the_byte_identical_image(self):
        result = handler.reconcile_duplicate_observations(
            _result([_observation(0), _observation(0)]),
            [self.SAME, self.SAME],
        )
        self.assertEqual([row["image_index"] for row in result["image_observations"]], [0, 1])
        validated = handler._validate_model_result(result, candidate_count=2, image_count=2)
        self.assertEqual(validated["image_observations"][1]["body_color_key"], "white")

    def test_three_copies_with_two_identical_images_still_reject_the_extra(self):
        result = handler.reconcile_duplicate_observations(
            _result([_observation(0), _observation(0), _observation(0)]),
            [self.SAME, self.SAME, self.OTHER],
        )
        indices = sorted(row["image_index"] for row in result["image_observations"])
        self.assertEqual(indices, [0, 0, 1])
        with self.assertRaisesRegex(ValueError, "duplicate image observations"):
            handler._validate_model_result(result, candidate_count=2, image_count=3)

    def test_conflicting_duplicates_for_identical_images_are_still_rejected(self):
        result = handler.reconcile_duplicate_observations(
            _result([_observation(0, color="white"), _observation(0, color="black")]),
            [self.SAME, self.SAME],
        )
        self.assertEqual([row["image_index"] for row in result["image_observations"]], [0, 0])
        with self.assertRaisesRegex(ValueError, "duplicate image observations"):
            handler._validate_model_result(result, candidate_count=2, image_count=2)

    def test_duplicates_for_different_images_are_still_rejected(self):
        result = handler.reconcile_duplicate_observations(
            _result([_observation(0), _observation(0)]),
            [self.SAME, self.OTHER],
        )
        with self.assertRaisesRegex(ValueError, "duplicate image observations"):
            handler._validate_model_result(result, candidate_count=2, image_count=2)

    def test_missing_observation_for_identical_image_is_copied(self):
        result = handler.reconcile_duplicate_observations(
            _result([_observation(0), _observation(2, color="black")]),
            [self.SAME, self.SAME, self.OTHER],
        )
        validated = handler._validate_model_result(result, candidate_count=2, image_count=3)
        rows = validated["image_observations"]
        self.assertEqual([row["image_index"] for row in rows], [0, 1, 2])
        self.assertEqual(rows[1]["body_color_key"], "white")
        self.assertEqual(rows[2]["body_color_key"], "black")

    def test_missing_observation_for_a_different_image_is_still_rejected(self):
        result = handler.reconcile_duplicate_observations(
            _result([_observation(0)]),
            [self.SAME, self.OTHER],
        )
        with self.assertRaisesRegex(ValueError, "one observation for every processed image"):
            handler._validate_model_result(result, candidate_count=2, image_count=2)

    def test_valid_results_and_malformed_shapes_pass_through_unchanged(self):
        valid = _result([_observation(0), _observation(1)])
        self.assertEqual(handler.reconcile_duplicate_observations(valid, [self.SAME, self.SAME]), valid)
        malformed = _result([{"image_index": "0"}, {"image_index": "0"}])
        self.assertEqual(handler.reconcile_duplicate_observations(malformed, [self.SAME, self.SAME]), malformed)
        self.assertEqual(handler.reconcile_duplicate_observations("nope", [self.SAME]), "nope")

    def test_analyze_with_llm_accepts_duplicate_observations_for_identical_photos(self):
        job = audit_job()
        job["input_payload"]["report"]["image_refs"] = [
            {"slot": "image1", "url": "https://res.cloudinary.com/example/image/upload/quality/one.jpg"},
            {"slot": "image2", "url": "https://res.cloudinary.com/example/image/upload/quality/one-copy.jpg"},
        ]

        class FakeLlm:
            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                return _result([_observation(0), _observation(0)])

        with (
            mock.patch.object(handler, "_download_image", return_value=(b"jpeg", "a" * 64)),
            mock.patch.object(handler, "_normalize_image"),
        ):
            result = handler.analyze_with_llm(job, FakeLlm(), "Qwen3.8-27B-4bit", handler.build_dummy_result(job))

        self.assertEqual([row["image_index"] for row in result["image_observations"]], [0, 1])
        self.assertEqual(result["source"], "local_qwen38_multimodal")
        self.assertFalse(result["llm_fallback"])

    def test_error_strings_use_neutral_model_wording(self):
        with self.assertRaisesRegex(ValueError, "^AI model result is not an object"):
            handler._validate_model_result("nope", candidate_count=1, image_count=0)
        self.assertNotIn("Qwen", handler.SYSTEM_PROMPT)
        self.assertIn("never reuse an image_index", handler.SYSTEM_PROMPT)
        self.assertIn("identical copies", handler.SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
