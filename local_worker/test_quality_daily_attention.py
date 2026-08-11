from __future__ import annotations

import unittest

try:
    from . import worker as worker_module
    from .job_handlers import quality_daily_attention_summary as handler
    from .worker import LocalModelTarget, handle_job, handler_for_job, run_once
except ImportError:
    import worker as worker_module
    from job_handlers import quality_daily_attention_summary as handler
    from worker import LocalModelTarget, handle_job, handler_for_job, run_once


def quality_job() -> dict:
    return {
        "id": 91,
        "job_type": "quality_image_analysis",
        "scope": {
            "mode": "daily_attention_summary",
            "trigger": "daily_attention",
            "date": "2026-08-12",
            "model_id": "gemma4_26b_a4b",
            "source_plan_hash": "plan-hash",
            "language": "bilingual",
            "plan_stable_since": "2026-08-12T06:30:00+08:00",
        },
        "input_payload": {
            "source": "quality_daily_attention",
            "schema_version": "quality-daily-attention-ai.v1",
            "date": "2026-08-12",
            "language": "bilingual",
            "model_id": "gemma4_26b_a4b",
            "source_plan_hash": "plan-hash",
            "disclaimer": {
                "ko": "과거 품질 이력 기반 요약이며 현재 불량 발생을 의미하지 않습니다.",
                "zh": "本摘要基于历史品质记录，不代表当前正在发生不良。",
            },
            "summary_basis": {
                "match_basis": "part_prefix_9",
                "history_coverage": "all_history",
                "report_section": "all",
            },
            "totals": {
                "plan_group_count": 2,
                "matched_report_count": 2,
                "without_history_count": 1,
            },
            "items": [
                {
                    "source_key": "14|ACQ307763",
                    "evidence_key": "prefix:ACQ307763",
                    "machine_name": "850T-14",
                    "machine_number": 14,
                    "sequence": 1,
                    "part_prefix": "ACQ307763",
                    "part_nos": ["ACQ30776309"],
                    "model_names": ["DEMO-M4414"],
                    "planned_quantity": 1800,
                    "matching_report_count": 2,
                    "latest_report_dt": "2026-07-29",
                },
                {
                    "source_key": "3|ABJ765076",
                    "evidence_key": "prefix:ABJ765076",
                    "machine_name": "650T-3",
                    "machine_number": 3,
                    "sequence": 2,
                    "part_prefix": "ABJ765076",
                    "part_nos": ["ABJ76507601"],
                    "model_names": ["DEMO-P3310"],
                    "planned_quantity": 900,
                    "matching_report_count": 0,
                },
            ],
            "evidence_catalog": [
                {
                    "evidence_key": "prefix:ACQ307763",
                    "part_prefix": "ACQ307763",
                    "match_basis": "part_prefix_9",
                    "matching_report_count": 2,
                    "latest_report_dt": "2026-07-29",
                    "phenomena": [
                        {
                            "evidence_key": "ACQ307763:phenomenon:white",
                            "text": "게이트 주변 백화",
                            "count": 1,
                            "report_ids": ["Q-1"],
                            "latest_report_dt": "2026-07-29",
                            "is_missing_text": False,
                        },
                        {
                            "evidence_key": "ACQ307763:phenomenon:missing",
                            "text": "[NO_PHENOMENON_RECORDED]",
                            "count": 1,
                            "report_ids": ["Q-2"],
                            "latest_report_dt": "2025-12-02",
                            "is_missing_text": True,
                        }
                    ],
                    "dispositions": [
                        {
                            "evidence_key": "ACQ307763:disposition:visual",
                            "text": "초품 외관 확인",
                            "count": 1,
                            "report_ids": ["Q-1"],
                            "latest_report_dt": "2026-07-29",
                        }
                    ],
                    "action_results": [
                        {
                            "evidence_key": "ACQ307763:action:reviewed",
                            "text": "검토 완료",
                            "count": 1,
                            "report_ids": ["Q-1"],
                            "latest_report_dt": "2026-07-29",
                        }
                    ],
                    "report_refs": [
                        {
                            "report_id": "Q-1",
                            "report_dt": "2026-07-29",
                            "part_no": "ACQ30776309",
                            "model": "DEMO-M4414",
                            "judgement": "과거 판정",
                            "phenomenon": "게이트 주변 백화",
                            "disposition": "초품 외관 확인",
                            "action_result": "검토 완료",
                        },
                        {
                            "report_id": "Q-2",
                            "report_dt": "2025-12-02",
                            "part_no": "ACQ30776301",
                            "model": "DEMO-M4414",
                            "judgement": "과거 판정",
                            "phenomenon": "백화",
                        },
                    ],
                },
                {
                    "evidence_key": "prefix:ABJ765076",
                    "part_prefix": "ABJ765076",
                    "match_basis": "part_prefix_9",
                    "matching_report_count": 0,
                    "phenomena": [],
                    "dispositions": [],
                    "action_results": [],
                    "report_refs": [],
                },
            ],
        },
    }


def valid_llm_result() -> dict:
    return {
        "summary": {
            "ko": "과거 이력에서 반복된 외관 현상을 중심으로 관련 부위를 확인해야 합니다.",
            "zh": "应重点确认历史记录中重复出现的外观现象及相关部位。",
        },
        "attention_items": [
            {
                "source_key": "14|ACQ307763",
                "headline": {
                    "ko": "반복된 백화 이력과 관련 부위를 우선 확인하세요.",
                    "zh": "请优先确认重复记录的发白现象及相关部位。",
                },
                "checkpoints": {
                    "ko": ["게이트 주변 외관을 확인하세요."],
                    "zh": ["请确认浇口周边外观。"],
                },
                "problem_types": [
                    {
                        "label": {"ko": "외관 백화", "zh": "外观发白"},
                        "source_evidence_keys": [
                            "ACQ307763:phenomenon:white",
                            "NOT-ALLOWED",
                        ],
                    },
                    {
                        "label": {"ko": "중복 분류", "zh": "重复分类"},
                        "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                    }
                ],
                "locations": [
                    {
                        "label": {"ko": "게이트 주변", "zh": "浇口周边"},
                        "source_evidence_keys": [
                            "ACQ307763:phenomenon:white",
                            "ACQ307763:phenomenon:missing",
                        ],
                    }
                ],
            },
            {
                "source_key": "invented|source",
                "headline": {"ko": "조작된 항목", "zh": "伪造项目"},
                "checkpoints": {"ko": ["확인하세요."], "zh": ["请确认。"]},
                "problem_types": [],
                "locations": [],
            },
        ],
    }


class QualityDailyAttentionHandlerTests(unittest.TestCase):
    def test_handler_is_registered_for_quality_job_claims(self):
        job = quality_job()

        self.assertIs(handler_for_job(job), handler)
        self.assertIn("quality_image_analysis", worker_module.HANDLERS)

    def test_quality_job_requires_gemma_bilingual_server_contract(self):
        for mutate, message in [
            (lambda job: job["scope"].update(model_id="qwen35"), "require model_id"),
            (lambda job: job["scope"].update(mode="image_review"), "Unsupported quality analysis mode"),
            (lambda job: job["input_payload"].update(schema_version="unknown"), "unsupported schema_version"),
            (lambda job: job["input_payload"].update(language="ko"), "require bilingual"),
            (lambda job: job["input_payload"].update(source_plan_hash="changed"), "matching source_plan_hash"),
        ]:
            job = quality_job()
            mutate(job)
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                handler.validate_job(job)

    def test_llm_payload_preserves_all_history_aggregates_and_safe_actions(self):
        job = quality_job()
        payload = handler.build_llm_payload(job)
        grounding = handler.build_grounding_payload(job)

        self.assertEqual(payload["summary_basis"]["history_coverage"], "all_history")
        self.assertEqual(payload["items"][0]["evidence_key"], "prefix:ACQ307763")
        self.assertEqual(payload["evidence_catalog"][0]["phenomena"][0]["count"], 1)
        self.assertEqual(
            payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"],
            "ACQ307763:phenomenon:white",
        )
        self.assertEqual(payload["evidence_catalog"][0]["action_results"][0]["text"], "검토 완료")
        self.assertNotIn("report_ids", str(payload))
        self.assertNotIn("report_refs", str(payload))
        self.assertEqual(
            grounding["evidence_catalog"][0]["phenomena"][0]["report_ids"],
            ["Q-1"],
        )
        self.assertEqual(
            grounding["evidence_catalog"][0]["report_refs"][0]["disposition"],
            "초품 외관 확인",
        )

    def test_deterministic_fallback_is_bilingual_and_marks_unknown_classification(self):
        result = handler.build_dummy_result(quality_job())

        self.assertTrue(result["summary"]["ko"])
        self.assertTrue(result["summary"]["zh"])
        self.assertEqual(result["attention_items"][0]["locations"][0]["label"], handler.UNKNOWN_LOCATION)
        self.assertEqual(result["attention_items"][0]["locations"][0]["count"], 2)
        self.assertEqual(
            result["attention_items"][0]["locations"][0]["source_evidence_keys"],
            ["ACQ307763:phenomenon:white", "ACQ307763:phenomenon:missing"],
        )
        self.assertEqual(len(result["attention_items"]), 1)
        self.assertIn("현재 불량 발생을 의미하지 않습니다", result["disclaimer"]["ko"])
        self.assertNotIn("현재 불량", result["summary"]["ko"])

    def test_normalizer_discards_unknown_keys_and_recomputes_counts_from_verified_evidence(self):
        job = quality_job()
        payload = handler.build_llm_payload(job)
        grounding = handler.build_grounding_payload(job)
        fallback = handler.build_dummy_result(job)

        result = handler.normalize_llm_result(
            valid_llm_result(),
            fallback,
            "gemma-test",
            payload,
            grounding,
        )

        self.assertEqual([item["source_key"] for item in result["attention_items"]], ["14|ACQ307763"])
        item = result["attention_items"][0]
        self.assertEqual(item["problem_types"][0]["count"], 1)
        self.assertEqual(
            item["problem_types"][0]["source_evidence_keys"],
            ["ACQ307763:phenomenon:white"],
        )
        self.assertEqual(item["problem_types"][1]["label"], handler.UNCLASSIFIED_TYPE)
        self.assertEqual(
            item["problem_types"][1]["source_evidence_keys"],
            ["ACQ307763:phenomenon:missing"],
        )
        self.assertNotIn("중복 분류", [group["label"]["ko"] for group in item["problem_types"]])
        self.assertEqual(item["locations"][1]["label"], handler.UNKNOWN_LOCATION)
        self.assertEqual(
            item["locations"][1]["source_evidence_keys"],
            ["ACQ307763:phenomenon:missing"],
        )
        self.assertNotIn("source_report_ids", str(result))
        self.assertNotIn("Q-1", str(result))

    def test_distinct_keys_with_overlapping_report_ids_cannot_inflate_counts(self):
        job = quality_job()
        job["input_payload"]["evidence_catalog"][0]["phenomena"].append({
            "evidence_key": "ACQ307763:phenomenon:alias",
            "text": "백화 별칭",
            "count": 1,
            "report_ids": ["Q-1"],
            "latest_report_dt": "2026-07-29",
            "is_missing_text": False,
        })
        candidate = valid_llm_result()
        candidate["attention_items"][0]["problem_types"][1] = {
            "label": {"ko": "중복 별칭", "zh": "重复别名"},
            "source_evidence_keys": ["ACQ307763:phenomenon:alias"],
        }
        grounding = handler.build_grounding_payload(job)

        result = handler.normalize_llm_result(
            candidate,
            handler.build_dummy_result(job),
            "gemma-test",
            handler.build_llm_payload(job),
            grounding,
        )

        groups = result["attention_items"][0]["problem_types"]
        self.assertEqual(sum(group["count"] for group in groups), 2)
        self.assertNotIn("중복 별칭", [group["label"]["ko"] for group in groups])
        self.assertNotIn(
            "ACQ307763:phenomenon:alias",
            [key for group in groups for key in group["source_evidence_keys"]],
        )

    def test_evidence_catalog_is_shared_by_multiple_targets_without_prompt_duplication(self):
        job = quality_job()
        shared_target = dict(job["input_payload"]["items"][0])
        shared_target.update({
            "source_key": "15|ACQ307763",
            "machine_name": "850T-15",
            "machine_number": 15,
        })
        job["input_payload"]["items"].append(shared_target)

        payload = handler.build_llm_payload(job)

        self.assertEqual(len(payload["evidence_catalog"]), 2)
        self.assertEqual(
            [item["evidence_key"] for item in payload["items"]].count("prefix:ACQ307763"),
            2,
        )
        self.assertEqual(str(payload).count("게이트 주변 백화"), 1)

    def test_unreleased_inline_v1_input_remains_backward_compatible(self):
        job = quality_job()
        payload = job["input_payload"]
        history = payload.pop("evidence_catalog")[0]
        inline_target = payload["items"][0]
        inline_target.pop("evidence_key")
        for key in ("phenomena", "dispositions", "action_results", "report_refs"):
            inline_target[key] = history[key]

        grounding = handler.build_grounding_payload(job)
        llm_payload = handler.build_llm_payload(job)

        self.assertTrue(grounding["items"][0]["evidence_key"].startswith("legacy-history:"))
        self.assertEqual(len(grounding["evidence_catalog"]), 2)
        self.assertEqual(
            grounding["evidence_catalog"][0]["phenomena"][0]["report_ids"],
            ["Q-1"],
        )
        self.assertNotIn("report_ids", str(llm_payload))

    def test_valid_gemma_result_uses_one_structured_call_and_exact_json_contract(self):
        class Gemma:
            def __init__(self):
                self.calls = []

            def structured_analysis(self, system_prompt, payload, **kwargs):
                self.calls.append((system_prompt, payload, kwargs))
                return valid_llm_result()

        gemma = Gemma()
        result, prompt_version = handle_job(
            quality_job(),
            use_llm=True,
            llm=gemma,
            model_name="gemma-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(len(gemma.calls), 1)
        self.assertEqual(prompt_version, handler.PROMPT_VERSION)
        self.assertEqual(gemma.calls[0][1]["required_output_schema"], handler.REQUIRED_OUTPUT_SCHEMA)
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertEqual(result["llm_attempts"], 1)
        self.assertEqual(
            set(result),
            {
                "summary",
                "attention_items",
                "disclaimer",
                "generated_at",
                "model_name",
                "source",
                "llm_attempted",
                "llm_attempts",
            },
        )

    def test_missing_bilingual_text_falls_back_deterministically(self):
        malformed_summaries = [
            {"ko": "과거 이력을 확인하세요."},
            {"ko": ["과거 이력"], "zh": "请确认历史记录。"},
        ]
        for malformed_summary in malformed_summaries:
            class MalformedGemma:
                def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                    result = valid_llm_result()
                    result["summary"] = malformed_summary
                    return result

            result, _ = handle_job(
                quality_job(),
                use_llm=True,
                llm=MalformedGemma(),
                model_name="gemma-test",
                fallback_to_deterministic=True,
            )

            with self.subTest(malformed_summary=malformed_summary):
                self.assertTrue(result["llm_fallback"])
                self.assertEqual(result["llm_fallback_code"], "invalid_response")
                self.assertTrue(result["summary"]["ko"])
                self.assertTrue(result["summary"]["zh"])

    def test_current_defect_or_root_cause_claim_is_rejected(self):
        unsafe_summaries = [
            {
                "ko": "현재 불량이 발생하고 있어 즉시 조치해야 합니다.",
                "zh": "历史记录中的外观现象需要确认。",
            },
            {
                "ko": "과거 이력의 외관 현상을 확인해야 합니다.",
                "zh": "由于模具问题导致不良，需要立即处理。",
            },
            {
                "ko": "백화가 발생하고 있어 관련 부위를 확인해야 합니다.",
                "zh": "应确认历史记录中的外观现象。",
            },
            {
                "ko": "과거 이력의 외관 현상을 확인해야 합니다.",
                "zh": "需要更换模具并确认外观。",
            },
        ]
        for summary in unsafe_summaries:
            result = valid_llm_result()
            result["summary"] = summary
            with self.subTest(summary=summary), self.assertRaisesRegex(
                ValueError,
                "current-defect|current-occurrence|root-cause|corrective action",
            ):
                handler.normalize_llm_result(
                    result,
                    handler.build_dummy_result(quality_job()),
                    "gemma-test",
                    handler.build_llm_payload(quality_job()),
                    handler.build_grounding_payload(quality_job()),
                )

    def test_wrong_model_cannot_use_deterministic_path_to_bypass_gemma_requirement(self):
        job = quality_job()
        job["scope"]["model_id"] = "qwen35"
        job["input_payload"]["model_id"] = "qwen35"

        with self.assertRaisesRegex(ValueError, "require model_id gemma4_26b_a4b"):
            handle_job(job, False, None, "qwen-test", True)

    def test_llm_disabled_quality_result_is_explicit_retryable_fallback(self):
        result, prompt_version = handle_job(
            quality_job(),
            use_llm=False,
            llm=None,
            model_name="",
            fallback_to_deterministic=True,
        )

        self.assertEqual(prompt_version, handler.PROMPT_VERSION)
        self.assertTrue(result["llm_fallback"])
        self.assertFalse(result["llm_attempted"])
        self.assertEqual(result["llm_attempts"], 0)
        self.assertEqual(result["llm_fallback_code"], "llm_disabled")
        self.assertEqual(result["source"], "local_llm_guarded_fallback")
        self.assertTrue(result["summary"]["ko"])
        self.assertTrue(result["summary"]["zh"])


class QualityDailyAttentionWorkerRoutingTests(unittest.TestCase):
    class Client:
        def __init__(self, job):
            self.job = job
            self.claim_request = None
            self.completed = []
            self.failed = []

        def claim_jobs(self, worker_name, **kwargs):
            self.claim_request = {"worker_name": worker_name, **kwargs}
            return [self.job]

        def start_job(self, _job_id):
            return {}

        def complete_job(self, job_id, **kwargs):
            self.completed.append((job_id, kwargs))
            return {}

        def fail_job(self, job_id, error_message, **_kwargs):
            self.failed.append((job_id, error_message))
            return {}

    class Gemma:
        def __init__(self):
            self.calls = 0

        def is_ready(self, timeout=3):
            return timeout == 3

        def structured_analysis(self, _system_prompt, _payload, **_kwargs):
            self.calls += 1
            return valid_llm_result()

    class Qwen:
        def is_ready(self, timeout=3):
            raise AssertionError("quality summary must not route to Qwen")

        def structured_analysis(self, _system_prompt, _payload, **_kwargs):
            raise AssertionError("quality summary must not route to Qwen")

    class UnavailableGemma:
        def is_ready(self, timeout=3):
            return False

        def structured_analysis(self, _system_prompt, _payload, **_kwargs):
            raise AssertionError("unavailable Gemma must use deterministic fallback")

    def test_claims_quality_type_and_routes_job_to_ready_gemma(self):
        client = self.Client(quality_job())
        gemma = self.Gemma()
        qwen = self.Qwen()
        targets = {
            worker_module.QWEN_MODEL_ID: LocalModelTarget(
                worker_module.QWEN_MODEL_ID,
                qwen,
                "/models/qwen",
            ),
            worker_module.GEMMA_MODEL_ID: LocalModelTarget(
                worker_module.GEMMA_MODEL_ID,
                gemma,
                "/models/gemma",
            ),
        }

        processed = run_once(
            client,
            "quality-worker",
            True,
            qwen,
            "/models/qwen",
            True,
            False,
            model_targets=targets,
        )

        self.assertEqual(processed, 1)
        self.assertIn("quality_image_analysis", client.claim_request["job_types"])
        self.assertEqual(gemma.calls, 1)
        self.assertFalse(client.failed)
        result = client.completed[0][1]["result_payload"]
        self.assertEqual(result["model_id"], worker_module.GEMMA_MODEL_ID)
        self.assertTrue(result["summary"]["ko"])
        self.assertTrue(result["summary"]["zh"])

    def test_unavailable_gemma_completes_quality_job_with_deterministic_fallback(self):
        client = self.Client(quality_job())
        gemma = self.UnavailableGemma()
        targets = {
            worker_module.GEMMA_MODEL_ID: LocalModelTarget(
                worker_module.GEMMA_MODEL_ID,
                gemma,
                "/models/gemma",
            ),
        }

        processed = run_once(
            client,
            "quality-worker",
            True,
            None,
            "",
            True,
            False,
            model_targets=targets,
        )

        self.assertEqual(processed, 1)
        self.assertFalse(client.failed)
        result = client.completed[0][1]["result_payload"]
        self.assertTrue(result["llm_fallback"])
        self.assertEqual(result["llm_fallback_code"], "model_unavailable")
        self.assertEqual(result["source"], "local_llm_guarded_fallback")
        self.assertTrue(result["summary"]["ko"])
        self.assertTrue(result["summary"]["zh"])


if __name__ == "__main__":
    unittest.main()
