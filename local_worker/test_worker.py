import unittest
from unittest.mock import MagicMock, patch

try:
    from . import llm_client as llm_client_module
    from . import render_client as render_client_module
    from . import worker as worker_module
    from .job_handlers import production_daily_analysis, production_machine_analysis, production_question_analysis
    from .llm_client import LocalLlmClient
    from .render_client import RenderClient
    from .worker import (
        RunOnceReport,
        handle_job,
        handler_for_job,
        normalize_result,
        run_once,
        summary_numbers_are_grounded,
    )
except ImportError:
    import llm_client as llm_client_module
    import render_client as render_client_module
    import worker as worker_module
    from job_handlers import production_daily_analysis, production_machine_analysis, production_question_analysis
    from llm_client import LocalLlmClient
    from render_client import RenderClient
    from worker import (
        RunOnceReport,
        handle_job,
        handler_for_job,
        normalize_result,
        run_once,
        summary_numbers_are_grounded,
    )


class NormalizeResultTests(unittest.TestCase):
    def setUp(self):
        self.fallback = {
            "title": "Deterministic analysis",
            "severity": "warning",
            "summary": "사출 계획 100개 대비 현재 50개입니다.",
            "top_issues": [{"label": "850T-1", "evidence": ["Gap: -20"]}],
            "facts": {"injection": {"planned_qty": 100, "actual_qty": 50}},
            "used_data": [{"name": "ProductionPlan", "row_count": 1}],
            "calculation_basis": ["backend-calculated"],
        }

    def test_llm_can_rewrite_prose_but_not_authoritative_fields(self):
        result = normalize_result(
            {
                "title": "생산 분석",
                "summary": "사출은 계획 대비 부족하여 확인이 필요합니다.",
                "severity": "normal",
                "top_issues": [{"label": "fabricated"}],
            },
            self.fallback,
            "qwen-test",
            self.fallback,
        )

        self.assertEqual(result["summary"], "사출은 계획 대비 부족하여 확인이 필요합니다.")
        self.assertEqual(result["severity"], "warning")
        self.assertEqual(result["top_issues"], self.fallback["top_issues"])
        self.assertEqual(result["facts"], self.fallback["facts"])
        self.assertEqual(result["source"], "local_llm_rewrite")

    def test_llm_cannot_introduce_unverified_number(self):
        with self.assertRaisesRegex(ValueError, "unverified number"):
            normalize_result(
                {"title": "생산 분석", "summary": "확인되지 않은 999개 부족입니다."},
                self.fallback,
                "qwen-test",
                self.fallback,
            )


class ProductionDailyAnalysisTests(unittest.TestCase):
    def test_daily_prompt_keeps_process_summary_tables_when_part_tables_exist(self):
        job = {
            "input_payload": {
                "briefing": {
                    "context_pack": {
                        "tables": [
                            {"name": "injection_machine_progress", "rows": [{"machine": "850T-1"}]},
                            {"name": "injection_part_progress", "rows": [{"part_no": "PART-A"}]},
                            {"name": "machining_line_progress", "rows": [{"equipment_label": "A라인"}]},
                            {"name": "machining_part_progress", "rows": [{"part_no": "PART-B"}]},
                        ],
                    },
                },
            },
        }

        payload = production_daily_analysis.build_llm_payload(job)

        self.assertEqual(
            [table["name"] for table in payload["tables"]],
            ["injection_machine_progress", "machining_line_progress"],
        )


class GroundingValidationTests(unittest.TestCase):
    def setUp(self):
        self.grounding = {
            "date": "2026-08-03",
            "verified_answer": (
                "1호기 차이는 -20개입니다.\n\n"
                "1호기 예상 형합수는 2900회입니다.\n\n"
                "1호기 진행률은 5.0%입니다.\n\n"
                "9호기 예상 형합수는 1360회입니다.\n\n"
                "1호기 계획은 100개이고 실적은 50개입니다."
            ),
            "verified_facts": {
                "machines": [
                    {
                        "machine_number": 1,
                        "machine": "1호기",
                        "gap_qty": -20,
                        "projected_total_shots": 2900,
                        "progress_rate": 5.0,
                    },
                    {
                        "machine_number": 9,
                        "machine": "9호기",
                        "gap_qty": -10,
                        "projected_total_shots": 1360,
                    },
                ],
            },
            "historical_snapshots": [
                {
                    "job_id": 999,
                    "completed_at": "2026-08-03T10:00:00+08:00",
                    "facts": {},
                },
            ],
        }

    def test_sign_flip_is_rejected(self):
        self.assertFalse(summary_numbers_are_grounded("1호기 차이는 20개입니다.", self.grounding))
        self.assertTrue(summary_numbers_are_grounded("1호기 차이는 -20개입니다.", self.grounding))

    def test_values_cannot_be_swapped_between_machine_rows(self):
        self.assertFalse(summary_numbers_are_grounded("1호기 예상 형합수는 1,360회입니다.", self.grounding))
        self.assertFalse(summary_numbers_are_grounded("9호기 예상 형합수는 2,900회입니다.", self.grounding))

    def test_comma_and_trailing_decimal_are_normalized(self):
        self.assertTrue(summary_numbers_are_grounded("1호기 예상 형합수는 2,900회입니다.", self.grounding))
        self.assertTrue(summary_numbers_are_grounded("1호기 진행률은 5%입니다.", self.grounding))

    def test_metadata_numbers_are_not_grounding_values(self):
        self.assertFalse(summary_numbers_are_grounded("1호기 예상 형합수는 999회입니다.", self.grounding))
        self.assertFalse(summary_numbers_are_grounded("1호기 예상 형합수는 2026회입니다.", self.grounding))

    def test_unverified_date_is_rejected_but_exact_date_is_allowed(self):
        self.assertTrue(summary_numbers_are_grounded("2026-08-03 기준 1호기 상태를 확인해야 합니다.", self.grounding))
        self.assertFalse(summary_numbers_are_grounded("2099-01-01 기준 1호기 상태를 확인해야 합니다.", self.grounding))

    def test_korean_and_chinese_spelled_quantities_are_rejected(self):
        summaries = [
            "1호기 예상 형합수는 구천구백구십구 회입니다.",
            "1호기 예상 형합수는 쉰 개입니다.",
            "1호기 예상 형합수는 백여 개입니다.",
            "1호기 예상 형합수는 스물세 개입니다.",
            "1호기 예상 형합수는 수십 회입니다.",
            "1호기 진행률은 백분의 오십입니다.",
            "1号机预计合模九千九百九十九次。",
            "1号机预计合模五十余个。",
            "1号机预计合模五十多个。",
            "1号机预计合模数十次。",
            "1号机进度为百分之五十。",
        ]
        for summary in summaries:
            with self.subTest(summary=summary):
                self.assertFalse(summary_numbers_are_grounded(summary, self.grounding))

    def test_exact_digit_identifiers_remain_allowed(self):
        grounding = {
            "verified_facts": {
                "machines": [{"machine": "850T-1", "actual_qty": 50}],
            },
        }
        self.assertTrue(summary_numbers_are_grounded("850T-1 설비 상태를 확인해야 합니다.", grounding))

    def test_valid_value_with_same_exact_subject_is_accepted(self):
        self.assertTrue(summary_numbers_are_grounded("9호기 예상 형합수는 1,360회입니다.", self.grounding))

    def test_values_cannot_be_swapped_between_fields_in_same_row(self):
        self.assertTrue(summary_numbers_are_grounded("1호기 계획은 100개이고 실적은 50개입니다.", self.grounding))
        self.assertFalse(summary_numbers_are_grounded("1호기 계획은 50개이고 실적은 100개입니다.", self.grounding))

    def test_multi_subject_trusted_prose_does_not_enable_swaps(self):
        grounding = {
            "verified_answer": "1호기 예상 형합수는 2,900회이고 9호기 예상 형합수는 1,360회입니다.",
        }
        self.assertFalse(
            summary_numbers_are_grounded(
                "1호기 예상 형합수는 1,360회이고 9호기 예상 형합수는 2,900회입니다.",
                grounding,
            ),
        )


class ProductionMachineAnalysisTests(unittest.TestCase):
    def test_deterministic_result_preserves_context_metadata(self):
        job = {
            "scope": {"machine": "850T-1"},
            "input_payload": {
                "language": "ko",
                "date": "2026-08-03",
                "target_row": {
                    "machine": "850T-1",
                    "planned_qty": 100,
                    "actual_qty": 50,
                    "gap_qty": -50,
                    "progress_rate": 50,
                    "recent_60m_shots": 0,
                },
                "context_pack": {
                    "data_freshness": {"status": "fresh"},
                    "warnings": ["sample warning"],
                    "retrieval_trace": [{"source": "production_context"}],
                },
            },
        }

        result = production_machine_analysis.build_dummy_result(job)

        self.assertEqual(result["data_freshness"], {"status": "fresh"})
        self.assertEqual(result["warnings"], ["sample warning"])
        self.assertEqual(result["retrieval_trace"], [{"source": "production_context"}])
        self.assertEqual(result["target_machine"]["machine"], "850T-1")


class ProductionQuestionAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.job = {
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "question", "date": "2026-08-03", "language": "ko"},
            "input_payload": {
                "source": "production_ai_question",
                "language": "ko",
                "date": "2026-08-03",
                "question": "1호기 예상 형합수는?",
                "intent": {"intent": "injection_shot_projection"},
                "deterministic": {
                    "answer": "1호기 종료 예상 형합수는 2,900회입니다.",
                    "facts": {"machine_number": 1, "projected_total_shots": 2900},
                    "used_data": [{"name": "InjectionMonitoringRecord", "row_count": 5}],
                    "calculation_basis": ["최근 60분 속도를 익일 08:00까지 선형 적용"],
                    "data_freshness": {"reference_time": "2026-08-03T12:00:00+08:00"},
                    "warnings": ["정지와 교체는 반영하지 않음"],
                    "retrieval_trace": [{"source": "injection_monitoring"}],
                },
            },
        }

    def test_question_job_uses_dedicated_handler(self):
        self.assertIs(handler_for_job(self.job), production_question_analysis)

    def test_deterministic_question_result_preserves_authoritative_fields(self):
        result = production_question_analysis.build_dummy_result(self.job)

        self.assertEqual(result["answer"], "1호기 종료 예상 형합수는 2,900회입니다.")
        self.assertEqual(result["facts"]["projected_total_shots"], 2900)
        self.assertEqual(result["warnings"], ["정지와 교체는 반영하지 않음"])

    def test_question_llm_payload_contains_only_verified_context(self):
        payload = production_question_analysis.build_llm_payload(self.job)

        self.assertEqual(payload["verified_answer"], "1호기 종료 예상 형합수는 2,900회입니다.")
        self.assertEqual(payload["verified_facts"]["projected_total_shots"], 2900)

    def test_question_grounding_excludes_user_authored_numbers(self):
        self.job["input_payload"]["question"] = "999호기는 어때?"
        self.job["input_payload"]["conversation_history"] = [
            {"role": "user", "content": "이전에는 888개라고 했어"},
        ]

        grounding = production_question_analysis.build_grounding_payload(self.job)

        self.assertNotIn("question", grounding)
        self.assertNotIn("conversation_history", grounding)
        self.assertNotIn("999", str(grounding))
        self.assertNotIn("888", str(grounding))

    def test_question_qwen_rewrites_only_prose_and_preserves_verified_result(self):
        class FakeLlm:
            def structured_analysis(self, _system_prompt, _payload):
                return {
                    "title": "검증된 생산 추세 설명",
                    "summary": "1호기 종료 예상 형합수는 2,900회입니다.",
                }

        result, prompt_version = handle_job(
            self.job,
            use_llm=True,
            llm=FakeLlm(),
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(result["answer"], "1호기 종료 예상 형합수는 2,900회입니다.")
        self.assertEqual(result["facts"]["projected_total_shots"], 2900)
        self.assertEqual(result["summary"], "1호기 종료 예상 형합수는 2,900회입니다.")
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertEqual(prompt_version, "production-question-v2")


class LocalLlmReadinessTests(unittest.TestCase):
    class Response:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    def setUp(self):
        self.client = LocalLlmClient(
            "http://127.0.0.1:8080/v1",
            "/private/models/Qwen3.5-35B-A3B-4bit",
        )

    def test_ready_requires_configured_model_or_basename(self):
        for model_id in [
            "/private/models/Qwen3.5-35B-A3B-4bit",
            "Qwen3.5-35B-A3B-4bit",
            "/another/location/Qwen3.5-35B-A3B-4bit",
        ]:
            with self.subTest(model_id=model_id), patch.object(
                llm_client_module.requests,
                "get",
                return_value=self.Response({"data": [{"id": model_id}]}),
            ):
                self.assertTrue(self.client.is_ready())

    def test_ready_rejects_empty_or_different_model_list(self):
        for payload in [
            {"data": []},
            {"data": [{"id": "another-model"}]},
            {"data": "not-a-list"},
        ]:
            with self.subTest(payload=payload), patch.object(
                llm_client_module.requests,
                "get",
                return_value=self.Response(payload),
            ):
                self.assertFalse(self.client.is_ready())


class RenderClientCompatibilityTests(unittest.TestCase):
    def test_claim_request_sends_current_worker_version(self):
        response = MagicMock()
        response.json.return_value = {"jobs": []}
        session = MagicMock()
        session.post.return_value = response

        with patch.object(render_client_module.requests, "Session", return_value=session):
            client = RenderClient("https://backend.example/api", "worker-token")
            self.assertEqual(client.claim_jobs("mac-studio"), [])

        request = session.post.call_args
        self.assertEqual(request.kwargs["json"]["worker_version"], worker_module.WORKER_VERSION)
        response.raise_for_status.assert_called_once_with()


class WorkerRunReportingTests(unittest.TestCase):
    @staticmethod
    def daily_job():
        return {
            "id": 7,
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "hourly", "language": "ko"},
            "input_payload": {"briefing": {}},
        }

    class Client:
        def __init__(self, job=None, *, enqueue_error=None, complete_error=None):
            self.job = job
            self.enqueue_error = enqueue_error
            self.complete_error = complete_error
            self.completed = []
            self.failed = []
            self.heartbeats = []
            self.claim_requests = []

        def enqueue_periodic_jobs(self):
            if self.enqueue_error:
                raise self.enqueue_error
            return {}

        def claim_jobs(self, worker_name, **kwargs):
            self.claim_requests.append({"worker_name": worker_name, **kwargs})
            return [self.job] if self.job else []

        def start_job(self, _job_id):
            return {}

        def complete_job(self, job_id, **payload):
            if self.complete_error:
                raise self.complete_error
            self.completed.append((job_id, payload))
            return {}

        def fail_job(self, job_id, error_message, **_payload):
            self.failed.append((job_id, error_message))
            return {}

        def send_heartbeat(self, _worker_name, **payload):
            self.heartbeats.append(payload)
            return {}

    def test_enqueue_failure_is_reported_without_blocking_claim(self):
        client = self.Client(self.daily_job(), enqueue_error=RuntimeError("enqueue unavailable"))
        report = RunOnceReport()

        processed = run_once(client, "worker", False, None, "model", True, True, report=report)

        self.assertEqual(processed, 1)
        self.assertTrue(report.had_failure)
        self.assertIn("enqueue unavailable", report.summary())
        self.assertEqual(len(client.completed), 1)

    def test_claim_includes_current_worker_version(self):
        client = self.Client()

        run_once(client, "worker", False, None, "model", True, False)

        self.assertEqual(client.claim_requests[0]["worker_version"], worker_module.WORKER_VERSION)

    def test_complete_failure_marks_job_failed_and_is_reported(self):
        client = self.Client(self.daily_job(), complete_error=RuntimeError("complete unavailable"))
        report = RunOnceReport()

        run_once(client, "worker", False, None, "model", True, False, report=report)

        self.assertTrue(report.had_failure)
        self.assertIn("complete unavailable", report.summary())
        self.assertEqual(client.failed[0][0], 7)

    def test_llm_fallback_error_is_reported_but_job_completes(self):
        class FailingLlm:
            def structured_analysis(self, _system_prompt, _payload):
                raise RuntimeError("local generation failed")

        client = self.Client(self.daily_job())
        report = RunOnceReport()

        run_once(client, "worker", True, FailingLlm(), "model", True, False, report=report)

        self.assertFalse(report.had_failure)
        self.assertIn("local generation failed", report.summary())
        self.assertTrue(client.completed[0][1]["result_payload"]["llm_fallback"])

    def test_once_returns_nonzero_when_job_fails(self):
        client = self.Client(self.daily_job(), complete_error=RuntimeError("complete unavailable"))
        with (
            patch.object(worker_module, "RenderClient", return_value=client),
            patch.object(
                worker_module.argparse.ArgumentParser,
                "parse_args",
                return_value=worker_module.argparse.Namespace(once=True, check_llm=False),
            ),
            patch.dict(
                worker_module.os.environ,
                {
                    "AI_WORKER_TOKEN": "test-token",
                    "AI_WORKER_USE_LLM": "false",
                    "AI_WORKER_ENQUEUE_PERIODIC": "false",
                },
                clear=False,
            ),
        ):
            self.assertEqual(worker_module.main(), 1)


if __name__ == "__main__":
    unittest.main()
