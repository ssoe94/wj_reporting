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

        uri = "data:image/jpeg;base64,U1lOVEhFVElDLWltYWdl"
        result = client.structured_analysis(
            "system",
            {"task": "audit"},
            image_urls=[uri],
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
        self.assertEqual(user_content[0]["image_url"]["url"], uri)
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


class ReviewReasonValidationTests(unittest.TestCase):
    def test_duplicate_known_codes_preserve_every_distinct_reason_once(self):
        candidate = _result([])
        candidate["evidence_basis"] = ["report_text"]
        candidate["review_reason_codes"] = ["low_confidence", "no_usable_image", "low_confidence"]
        result = handler._validate_model_result(candidate, candidate_count=2, image_count=0)
        self.assertEqual(result["review_reason_codes"], ["low_confidence", "no_usable_image"])
        self.assertEqual(candidate["review_reason_codes"], ["low_confidence", "no_usable_image", "low_confidence"])

    def test_unknown_missing_and_unbounded_review_reasons_still_fail(self):
        for codes, reason in [
            (["invented_reason"], "unsupported code"),
            (None, "expected an array"),
            ("low_confidence", "expected an array"),
            (["low_confidence"] * 9, "too many codes"),
        ]:
            with self.subTest(codes=codes):
                candidate = _result([])
                candidate["evidence_basis"] = ["report_text"]
                candidate["review_reason_codes"] = codes
                with self.assertRaisesRegex(ValueError, reason):
                    handler._validate_model_result(candidate, candidate_count=2, image_count=0)


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


class LocalLlmRequestGoldenTests(unittest.TestCase):
    """Freeze the existing non-image and pre-encoded request contracts."""

    def check_request(self, mode, images):
        import json

        schema = {
            "type": "object",
            "properties": {"SYNTHETIC-result": {"type": "string"}},
            "required": ["SYNTHETIC-result"],
            "additionalProperties": False,
        }
        payload = {"task": "SYNTHETIC-audit"}
        text = json.dumps(payload, ensure_ascii=False, default=str)
        content = text if not images else [
            {"type": "image_url", "image_url": {"url": images[0]}},
            {"type": "text", "text": text},
        ]
        expected = {
            "model": "SYNTHETIC-model",
            "temperature": 0.1,
            "max_tokens": 1200,
            "messages": [
                {"role": "system", "content": "SYNTHETIC-system"},
                {"role": "user", "content": content},
            ],
            "enable_thinking": False,
        }
        options = {}
        if mode == "schema":
            options["json_schema"] = schema
            expected["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "bounded_analysis", "strict": True, "schema": schema},
            }
        elif mode == "object":
            options["json_object"] = True
            expected["response_format"] = {"type": "json_object"}
        response = mock.Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "choices": [{"finish_reason": "stop",
                         "message": {"content": '{"SYNTHETIC-result":"SYNTHETIC-value"}'}}],
        }
        client = LocalLlmClient("http://127.0.0.1:8082/v1", "SYNTHETIC-model", timeout=240)
        with mock.patch("requests.post", return_value=response) as post:
            result = client.structured_analysis(
                "SYNTHETIC-system", payload, image_urls=images, **options,
            )
        self.assertEqual(result, {"SYNTHETIC-result": "SYNTHETIC-value"})
        self.assertEqual(post.call_count, 1)
        self.assertEqual(post.call_args.args, ("http://127.0.0.1:8082/v1/chat/completions",))
        self.assertEqual(post.call_args.kwargs["json"], expected)
        self.assertEqual(
            post.call_args.kwargs["timeout"],
            client.call_timeout_seconds(
                4 + len(text) // 4, 1200, image_count=len(images or []),
            ),
        )

    def test_complete_text_only_payload_in_all_response_modes(self):
        for mode in ("schema", "object", "plain"):
            with self.subTest(mode=mode):
                self.check_request(mode, None)

    def test_existing_data_uri_is_byte_for_byte_unchanged(self):
        import base64

        uri = "data:image/png;base64," + base64.b64encode(b"SYNTHETIC-image-bytes").decode("ascii")
        for mode in ("schema", "object", "plain"):
            with self.subTest(mode=mode):
                self.check_request(mode, [uri])


class LocalLlmImageEncodingTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path

        self.temporary = tempfile.TemporaryDirectory(prefix="SYNTHETIC-images-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.client = LocalLlmClient("http://127.0.0.1:8082/v1", "SYNTHETIC-model", timeout=240)

    def image(self, name, format="JPEG"):
        from PIL import Image

        path = self.root / name
        Image.new("RGB", (8, 8), color=(255, 255, 255)).save(path, format=format)
        return path

    def response(self, status=200, body=None, reason=None):
        import json
        import requests

        result = requests.Response()
        result.status_code = status
        result.reason = reason or "SYNTHETIC-response"
        result.url = "http://127.0.0.1:8082/v1/chat/completions"
        result.encoding = "utf-8"
        result._content = (body if body is not None else json.dumps({
            "choices": [{"finish_reason": "stop", "message": {"content": '{"SYNTHETIC-result":true}'}}],
        })).encode()
        result.request = requests.Request("POST", result.url).prepare()
        return result

    def call(self, images):
        return self.client.structured_analysis(
            "SYNTHETIC-system", {"SYNTHETIC-task": "SYNTHETIC-audit"}, image_urls=images,
        )

    def test_magic_bytes_order_file_uri_and_trailing_text(self):
        import base64
        import json

        jpeg = self.image("SYNTHETIC-wrong.png")
        png = self.image("SYNTHETIC spaced.jpg", "PNG")
        webp = self.image("SYNTHETIC-wrong.bin", "WEBP")
        encoded = "data:image/png;base64," + base64.b64encode(b"SYNTHETIC").decode()
        with mock.patch("requests.post", return_value=self.response()) as post:
            self.call([str(jpeg), png.as_uri(), str(webp), encoded])
        sent = post.call_args.kwargs["json"]["messages"][1]["content"]
        expected = [
            "data:image/jpeg;base64," + base64.b64encode(jpeg.read_bytes()).decode(),
            "data:image/png;base64," + base64.b64encode(png.read_bytes()).decode(),
            "data:image/webp;base64," + base64.b64encode(webp.read_bytes()).decode(),
            encoded,
        ]
        self.assertEqual(sent[:-1], [{"type": "image_url", "image_url": {"url": uri}} for uri in expected])
        self.assertEqual(sent[-1], {"type": "text", "text": json.dumps(
            {"SYNTHETIC-task": "SYNTHETIC-audit"}, ensure_ascii=False,
        )})
        self.assertEqual(post.call_args.kwargs["timeout"], self.client.call_timeout_seconds(
            len("SYNTHETIC-system") // 4
            + len(sent[-1]["text"]) // 4, 1200, image_count=4,
        ))

    def test_invalid_images_fail_before_post_and_hide_full_paths(self):
        valid = self.image("SYNTHETIC-valid.jpg")
        unsupported = self.root / "SYNTHETIC-document.jpg"
        unsupported.write_bytes(b"SYNTHETIC-not-an-image")
        empty = self.root / "SYNTHETIC-empty.jpg"
        empty.touch()
        for invalid in (
            "http://example.invalid/SYNTHETIC.jpg",
            "https://example.invalid/SYNTHETIC.jpg",
            str(self.root / "SYNTHETIC-missing.jpg"), str(self.root),
            str(unsupported), str(empty), "SYNTHETIC-relative.jpg",
            "file://example.invalid/SYNTHETIC.jpg",
            valid.as_uri() + "?SYNTHETIC=1", valid.as_uri() + "#SYNTHETIC",
        ):
            with self.subTest(input_kind=invalid.split(":")[0]), mock.patch("requests.post") as post:
                with self.assertRaises(ValueError) as caught:
                    self.call([str(valid), invalid])
                post.assert_not_called()
                self.assertNotIn(str(self.root), str(caught.exception))

    def test_unreadable_file_has_no_path_in_displayed_exception_chain(self):
        valid = self.image("SYNTHETIC-unreadable.jpg")
        with mock.patch("pathlib.Path.open", side_effect=PermissionError(str(valid))), \
                mock.patch("requests.post") as post:
            with self.assertRaises(ValueError) as caught:
                self.call([str(valid)])
        post.assert_not_called()
        self.assertNotIn(str(valid), str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_per_image_and_request_raw_byte_limits_include_boundaries(self):
        from .llm_client import MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES

        first = self.root / "SYNTHETIC-first.jpg"
        second = self.root / "SYNTHETIC-second.jpg"
        first.write_bytes(b"\xff\xd8\xff" + b"\0" * (MAX_IMAGE_BYTES - 3))
        second.write_bytes(first.read_bytes())
        self.assertEqual(first.stat().st_size + second.stat().st_size, MAX_TOTAL_IMAGE_BYTES)
        with mock.patch("requests.post", return_value=self.response()) as post:
            self.call([str(first), str(second)])
            self.assertEqual(post.call_count, 1)
        third = self.image("SYNTHETIC-third.jpg")
        with mock.patch("requests.post") as post:
            with self.assertRaisesRegex(ValueError, "16 MiB"):
                self.call([str(first), str(second), str(third)])
            post.assert_not_called()
        with first.open("ab") as target:
            target.write(b"x")
        with mock.patch("requests.post") as post:
            with self.assertRaisesRegex(ValueError, "8 MiB"):
                self.call([str(first)])
            post.assert_not_called()

    def test_existing_data_uri_counts_toward_total_without_reencoding(self):
        import base64
        from .llm_client import MAX_IMAGE_BYTES

        raw = b"SYNTHETIC-" + b"x" * (MAX_IMAGE_BYTES - len(b"SYNTHETIC-"))
        uri = "data:image/png;base64," + base64.b64encode(raw).decode()
        valid = self.image("SYNTHETIC-tiny.jpg")
        with mock.patch("requests.post") as post:
            with self.assertRaisesRegex(ValueError, "16 MiB"):
                self.call([uri, uri, str(valid)])
            post.assert_not_called()
        too_large = "data:image/png;base64," + base64.b64encode(raw + b"x").decode()
        with mock.patch("requests.post") as post:
            with self.assertRaisesRegex(ValueError, "8 MiB"):
                self.call([too_large])
            post.assert_not_called()

    def test_4xx_detail_preserves_legacy_classifier_and_exception_objects(self):
        import requests
        from .worker import classify_llm_error

        for status, reason, body in (
            (400, "Bad Request", "SYNTHETIC timeout\nconnection rejected " + "SYNTHETIC detail " * 50),
            (408, "Request Timeout", "SYNTHETIC connection rejected"),
            (429, "Too Many Requests", "SYNTHETIC TIMEOUT CONNECTION"),
        ):
            with self.subTest(status=status):
                response = self.response(status, body=body, reason=reason)
                try:
                    response.raise_for_status()
                except requests.HTTPError as original:
                    before = classify_llm_error(original)
                    with mock.patch.object(response, "raise_for_status", side_effect=original), \
                            mock.patch("requests.post", return_value=response):
                        with self.assertRaises(requests.HTTPError) as caught:
                            self.call(None)
                    self.assertIs(caught.exception, original)
                    self.assertIs(caught.exception.response, response)
                    self.assertIs(caught.exception.request, response.request)
                    self.assertEqual(classify_llm_error(caught.exception), before)
                    detail = str(caught.exception).split("; response: ", 1)[1]
                    normalized = " ".join(body.split())
                    self.assertEqual(detail, normalized[:300])
                    self.assertLessEqual(len(detail), 300)

    def test_4xx_detail_redacts_encoded_image_and_absolute_paths(self):
        import base64
        import requests

        encoded = base64.b64encode(b"SYNTHETIC-image-contents").decode()
        uri = "data:image/jpeg;base64," + encoded
        path = self.root / "SYNTHETIC-private.jpg"
        body = f"SYNTHETIC rejection {uri} file={path} timeout connection"
        with mock.patch("requests.post", return_value=self.response(400, body=body)):
            with self.assertRaises(requests.HTTPError) as caught:
                self.call([uri])
        text = str(caught.exception)
        self.assertIn("SYNTHETIC rejection", text)
        self.assertNotIn(uri, text)
        self.assertNotIn(encoded, text)
        self.assertNotIn(str(self.root), text)

    def test_server_and_transport_errors_keep_original_behavior(self):
        import requests
        from .worker import classify_llm_error

        response = self.response(500, body="SYNTHETIC timeout in body", reason="Internal Server Error")
        with mock.patch("requests.post", return_value=response):
            with self.assertRaises(requests.HTTPError) as caught:
                self.call(None)
        self.assertNotIn("; response:", str(caught.exception))
        self.assertEqual(classify_llm_error(caught.exception), "model_unavailable")
        failure = requests.Timeout("SYNTHETIC timeout")
        with mock.patch("requests.post", side_effect=failure):
            with self.assertRaises(requests.Timeout) as caught:
                self.call(None)
        self.assertIs(caught.exception, failure)

    def test_handler_posts_data_uri_and_preserves_complete_result_contract(self):
        from hashlib import sha256

        path = self.image("SYNTHETIC-source.jpg")
        raw = path.read_bytes()
        job = audit_job()
        job["input_payload"]["report"].update(
            part_no="SYNTHETIC-PART", model="SYNTHETIC-MODEL",
            phenomenon="SYNTHETIC defect", disposition="SYNTHETIC disposition",
            action_result="SYNTHETIC action",
            image_refs=[{"slot": "image1", "url": "https://res.cloudinary.com/SYNTHETIC.jpg"}],
        )
        model_result = _result([_observation(0)])
        fake = mock.Mock()
        fake.structured_analysis.return_value = model_result
        with mock.patch.object(handler, "_download_image", return_value=(raw, sha256(raw).hexdigest())):
            expected = handler.analyze_with_llm(job, fake, "SYNTHETIC-model", handler.build_dummy_result(job))
        import json
        body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(model_result)}}]})
        with mock.patch.object(handler, "_download_image", return_value=(raw, sha256(raw).hexdigest())), \
                mock.patch("requests.post", return_value=self.response(body=body)) as post:
            actual = handler.analyze_with_llm(
                job, self.client, "SYNTHETIC-model", handler.build_dummy_result(job),
            )
        self.assertEqual(actual, expected)
        blocks = post.call_args.kwargs["json"]["messages"][1]["content"]
        self.assertTrue(blocks[0]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(blocks[-1]["type"], "text")
