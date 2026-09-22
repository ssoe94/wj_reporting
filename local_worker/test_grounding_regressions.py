"""Regression coverage for Korean prose grounding and repair diagnostics.

All quantities below are synthetic fixture values, not production evidence.
The captured job-9980 prose is tested against synthetic rows that register only
the independently verified identifiers and the supplied qualitative statuses.
No model, queue, network, or production service is used by these tests.
"""

import copy
import unittest

try:
    from .worker import LlmGroundingError, build_repair_payload, handle_job, normalize_result, summary_numbers_are_grounded
except ImportError:
    from worker import LlmGroundingError, build_repair_payload, handle_job, normalize_result, summary_numbers_are_grounded


ORIGINAL_9980_SUMMARY = (
    "결론\n"
    "사출 및 가공 공정 모두 시간 진행률 대비 생산 진행률이 낮아 지연 상태입니다.\n\n"
    "판단 근거\n"
    "- 사출 공정의 생산 진행률이 시간 진행률보다 낮게 나타남\n"
    "- 가공 공정의 생산 진행률이 시간 진행률보다 낮게 나타남\n"
    "- 가공 공정의 실적 발생 장비가 일부에 국한됨\n\n"
    "확인할 항목\n"
    "- 550T-12, 850T-2, A라인의 생산 계획 대비 실적 현황 조회\n"
    "- 가공 라인별 실적 발생 여부 점검"
)


def structured_ko(check, conclusion="검증된 생산 데이터 범위를 확인했습니다."):
    return (
        f"결론:\n{conclusion}\n\n"
        "판단 근거:\n- 검증된 생산 데이터 범위의 설명입니다.\n\n"
        f"확인할 항목:\n- {check}"
    )


def structured_zh(check):
    return (
        "结论:\n已核对生产数据范围。\n\n"
        "判断依据:\n- 使用已验证的生产数据。\n\n"
        f"需确认:\n- {check}"
    )


def synthetic_grounding():
    return {
        "facts": {"injection": {"status": "behind"}, "machining": {"status": "behind"}},
        "tables": [{
            "name": "injection_machine_progress",
            "rows": [
                {"machine": "550T-12", "planned_qty": 1},
                {"machine": "850T-2", "planned_qty": 1},
                {"line": "A라인", "planned_qty": 1},
            ],
        }],
    }


class KoreanQuantityAndIdentifierRegressionTests(unittest.TestCase):
    def setUp(self):
        self.grounding = synthetic_grounding()
        self.fallback = {
            "title": "생산 브리핑",
            "answer": "서버에서 검증한 생산 현황입니다.",
            "summary": "서버에서 검증한 생산 현황입니다.",
            "facts": copy.deepcopy(self.grounding["facts"]),
        }

    def normalize(self, summary, grounding=None):
        return normalize_result(
            {"title": "생산 브리핑", "summary": summary},
            self.fallback,
            "synthetic-model",
            self.grounding if grounding is None else grounding,
        )

    def test_original_9980_prose_passes_full_normalization_without_pruning(self):
        self.assertTrue(summary_numbers_are_grounded(ORIGINAL_9980_SUMMARY, self.grounding))
        result = self.normalize(ORIGINAL_9980_SUMMARY)
        expected = ORIGINAL_9980_SUMMARY.replace("결론\n", "결론:\n").replace(
            "판단 근거\n", "판단 근거:\n",
        ).replace("확인할 항목\n", "확인할 항목:\n")
        self.assertEqual(result["summary"], expected)
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertFalse(result.get("llm_numeric_lines_pruned", False))
        self.assertEqual(result["answer"], self.fallback["answer"])
        self.assertEqual(result["facts"], self.fallback["facts"])

    def test_korean_word_fragments_are_not_quantities(self):
        for text in (
            "사출 및 가공 공정 모두 시간 진행률을 확인했습니다.",
            "가공 라인별 실적 발생 여부를 점검합니다.",
            "요청한 시간 구간의 설비 상태를 확인했습니다.",
            "생산 진행률이 시간 경과 비율보다 낮게 나타났습니다.",
        ):
            with self.subTest(text=text):
                self.assertTrue(summary_numbers_are_grounded(text, self.grounding))

    def test_actual_attached_and_standalone_korean_quantities_stay_rejected(self):
        for quantity in (
            "두 시간", "영 대", "공 개", "모두두대", "총두대", "사출은두대",
            "사출기는두 대", "총두 대", "약두 대", "대략두 대", "최소두 대", "최대두 대",
            "사출기는모두두대", "사출기는겨우두대", "사출기는오직두대",
            "사출기는총합두대", "사출기는대략적으로두대",
            "쉰 개", "백여 개", "스물세 개", "수십 회", "백분의 오십",
            "五十多个", "五十余个", "数十次", "百分之五十",
        ):
            with self.subTest(quantity=quantity):
                self.assertFalse(summary_numbers_are_grounded(f"{quantity}입니다.", self.grounding))

    def test_exact_identifier_lists_allow_one_information_lookup_in_both_languages(self):
        for summary in (
            structured_ko("550T-12, 850T-2, A라인의 생산 계획 대비 실적 현황 조회"),
            structured_ko("550T-12 및 850T-2 및 A라인의 실적 현황 조회"),
            structured_ko("550T-12, 850T-2 및 A라인의 실적 현황 조회"),
            structured_zh("查询550T-12、850T-2及A라인的生产记录。"),
            structured_zh("查询550T-12，850T-2和A라인的生产记录。"),
        ):
            with self.subTest(summary=summary):
                result = self.normalize(summary)
                self.assertEqual(result["summary"], summary)
                self.assertFalse(result.get("llm_numeric_lines_pruned", False))

    def test_information_nouns_and_times_do_not_count_as_additional_actions(self):
        for check in (
            "확인 기록을 조회합니다.",
            "점검 이력을 조회합니다.",
            "검토 결과를 확인합니다.",
            "조회 내역을 점검합니다.",
            "MES 수집 시각과 생산 계획을 확인합니다.",
            "MES 수집 일시 및 생산 계획을 확인합니다.",
            "MES 수집 시점과 생산 계획을 확인합니다.",
        ):
            with self.subTest(check=check):
                summary = structured_ko(check)
                result = self.normalize(summary)
                self.assertEqual(result["summary"], summary)
                self.assertFalse(result.get("llm_numeric_lines_pruned", False))
        with self.assertRaises(LlmGroundingError) as raised:
            self.normalize(structured_ko("생산 데이터 확인 및 조회"))
        self.assertEqual(raised.exception.reason_code, "action_format")

    def test_production_report_noun_allows_a_single_information_check(self):
        for check in (
            "가공 A라인의 실적 보고 누락 여부를 확인합니다.",
            "가공 A라인의 실적 보고 누락 여부를 조회합니다.",
        ):
            with self.subTest(check=check):
                summary = structured_ko(check)
                result = self.normalize(summary)
                self.assertEqual(result["summary"], summary)
                self.assertFalse(result.get("llm_numeric_lines_pruned", False))

    def test_report_noun_exception_does_not_allow_sequential_looking_actions(self):
        for check in (
            "화면을 보고 기록을 확인합니다.",
            "생산 현황을 보고 기록을 확인합니다.",
            "실적 보고를 읽고 기록을 확인합니다.",
        ):
            with self.subTest(check=check):
                with self.assertRaises(LlmGroundingError) as raised:
                    self.normalize(structured_ko(check))
                self.assertEqual(raised.exception.reason_code, "action_format")

    def test_unknown_identifier_cannot_borrow_a_verified_prefix_or_list_separator(self):
        for summary in (
            structured_ko("550T-12, 850T-20의 생산 실적 조회"),
            structured_ko("550T-12 및 B라인의 생산 실적 조회"),
            structured_zh("查询550T-12及850T-20的生产记录。"),
            structured_zh("查询550T-12及B라인的生产记录。"),
        ):
            with self.subTest(summary=summary):
                with self.assertRaises(LlmGroundingError):
                    self.normalize(summary)

    def test_verified_list_does_not_expand_question_focus(self):
        grounding = synthetic_grounding()
        grounding["analysis_skill"] = {"focus_identifiers": ["550T-12"], "limitations": []}
        for summary in (
            structured_ko("550T-12, 850T-2의 생산 실적 조회"),
            structured_zh("查询550T-12及850T-2的生产记录。"),
        ):
            with self.subTest(summary=summary):
                with self.assertRaises(LlmGroundingError) as raised:
                    self.normalize(summary, grounding)
                self.assertEqual(raised.exception.reason_code, "scope_or_history")

    def test_identifier_lists_cannot_launder_physical_actions(self):
        for summary in (
            structured_ko("550T-12, 850T-2의 금형 윤활 및 결과 데이터 확인"),
            structured_ko("550T-12, 850T-2 세척 후 상태 확인"),
            structured_ko("550T-12, 850T-2 세\u200b척 후 상태 확인"),
            structured_zh("清洗550T-12及850T-2后确认状态。"),
            structured_zh("清\u200b洗550T-12及850T-2后确认状态。"),
        ):
            with self.subTest(summary=summary):
                with self.assertRaises(LlmGroundingError) as raised:
                    self.normalize(summary)
                self.assertEqual(raised.exception.reason_code, "operational_action")
                self.assertNotIn("\u200b", raised.exception.normalized_summary)

    def test_identifier_lists_do_not_allow_multiple_information_actions(self):
        for summary in (
            structured_ko("550T-12, 850T-2의 생산 데이터 확인 및 이력 조회"),
            structured_ko("550T-12, 850T-2의 생산 데이터 확인, 이력 조회"),
            structured_ko("550T-12, 850T-2의 생산 데이터 확인/이력 조회"),
            structured_ko("550T-12, 850T-2의 상태 확인 → 이력 조회"),
            structured_zh("确认550T-12及850T-2的状态及查询生产记录。"),
        ):
            with self.subTest(summary=summary):
                with self.assertRaises(LlmGroundingError) as raised:
                    self.normalize(summary)
                self.assertEqual(raised.exception.reason_code, "action_format")


class KoreanRunningNegationRegressionTests(unittest.TestCase):
    def normalize(self, conclusion, states):
        # planned_qty=1 only registers these synthetic exact identifiers in
        # numeric grounding; is_running is the sole state assertion evidence.
        grounding = {
            "tables": [{"rows": [
                {"machine": identifier, "planned_qty": 1, "is_running": state}
                for identifier, state in states.items()
            ]}],
        }
        summary = structured_ko("최신 MES 수집 이력을 조회합니다.", conclusion=conclusion)
        result = normalize_result(
            {"title": "설비 상태", "summary": summary},
            {"title": "설비 상태", "summary": "검증된 설비 상태입니다."},
            "synthetic-model", grounding,
        )
        self.assertEqual(result["summary"], summary)
        self.assertFalse(result.get("llm_numeric_lines_pruned", False))
        return result

    def test_running_negation_is_supported_by_explicit_false_state(self):
        for predicate in ("가동", "운전", "생산"):
            for negation in ("중이 아닙니다.", "중이지 않습니다."):
                with self.subTest(predicate=predicate, negation=negation):
                    self.normalize(
                        f"850T-14는 현재 {predicate} {negation}", {"850T-14": False},
                    )

    def test_running_negation_rejects_true_or_unknown_state(self):
        for predicate in ("가동", "운전", "생산"):
            for negation in ("중이 아닙니다.", "중이지 않습니다."):
                for state in (True, None):
                    with self.subTest(predicate=predicate, negation=negation, state=state):
                        with self.assertRaises(LlmGroundingError) as raised:
                            self.normalize(
                                f"850T-14는 현재 {predicate} {negation}", {"850T-14": state},
                            )
                        self.assertEqual(raised.exception.reason_code, "unsupported_claim")

    def test_affirmative_running_still_requires_explicit_true_state(self):
        for predicate in ("가동", "운전", "생산"):
            conclusion = f"850T-14는 현재 {predicate} 중입니다."
            with self.subTest(predicate=predicate, state=True):
                self.normalize(conclusion, {"850T-14": True})
            for state in (False, None):
                with self.subTest(predicate=predicate, state=state):
                    with self.assertRaises(LlmGroundingError) as raised:
                        self.normalize(conclusion, {"850T-14": state})
                    self.assertEqual(raised.exception.reason_code, "unsupported_claim")

    def test_shared_predicate_requires_every_listed_machine_to_match(self):
        for connector in (", ", " 및 "):
            for expected, predicate in (
                (False, "가동 중이 아닙니다."),
                (False, "운전 중이지 않습니다."),
                (True, "가동 중입니다."),
            ):
                conclusion = f"850T-14{connector}550T-12는 현재 {predicate}"
                for first, second in ((False, False), (False, True), (True, False), (True, True)):
                    with self.subTest(
                        connector=connector, predicate=predicate, states=(first, second),
                    ):
                        states = {"850T-14": first, "550T-12": second}
                        if first is expected and second is expected:
                            self.normalize(conclusion, states)
                        else:
                            with self.assertRaises(LlmGroundingError) as raised:
                                self.normalize(conclusion, states)
                            self.assertEqual(raised.exception.reason_code, "unsupported_claim")

    def test_repair_excerpts_with_nonrunning_evidence_and_report_lookups_pass(self):
        # The supplied job-9989 repair excerpts are assembled into the required
        # sections; this is not represented as the complete captured response.
        summary = (
            "결론:\n사출과 가공 생산 진행률은 시간 기준에 미달합니다.\n\n"
            "판단 근거:\n- 850T-14는 현재 가동 중이 아닙니다.\n\n"
            "확인할 항목:\n"
            "- 850T-14의 생산 보고 이력을 조회합니다.\n"
            "- A라인의 생산 보고 이력을 조회합니다.\n"
            "- B라인의 생산 보고 이력을 조회합니다."
        )
        grounding = {
            "facts": {"injection": {"status": "behind"}, "machining": {"status": "behind"}},
            "tables": [{"rows": [
                {"machine": "850T-14", "planned_qty": 1, "is_running": False},
                {"line": "A라인", "planned_qty": 1},
                {"line": "B라인", "planned_qty": 1},
            ]}],
        }
        result = normalize_result(
            {"title": "생산 브리핑", "summary": summary},
            {"title": "생산 브리핑", "summary": "검증된 생산 현황입니다."},
            "synthetic-model", grounding,
        )
        self.assertEqual(result["summary"], summary)
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertFalse(result.get("llm_numeric_lines_pruned", False))


class ScriptedLlm:
    """In-process response/exception sequence; never contacts a runtime."""

    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def structured_analysis(self, system_prompt, payload, **kwargs):
        self.calls.append((system_prompt, payload, kwargs))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)


class RepairDiagnosticRegressionTests(unittest.TestCase):
    def setUp(self):
        # 1/2900/5 are synthetic question-fixture values, not live records.
        self.job = {
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "question", "language": "ko"},
            "input_payload": {
                "source": "production_ai_question",
                "language": "ko",
                "question": "1호기 예상 형합수는?",
                "intent": {"intent": "injection_shot_projection"},
                "deterministic": {
                    "answer": "1호기 종료 예상 형합수는 2,900회입니다.",
                    "facts": {"machine_number": 1, "projected_total_shots": 2900},
                    "used_data": [{"name": "SyntheticMonitoringRecord", "row_count": 5}],
                    "calculation_basis": ["synthetic fixture only"],
                    "warnings": [],
                },
            },
        }
        self.valid = {"title": "생산 추세", "summary": structured_ko("최신 MES 수집 상태를 확인합니다.")}
        self.bad_action = {
            "title": "첫 응답",
            "summary": structured_ko("생산 데이터 확인/이력 조회"),
        }

    def run_job(self, *responses):
        llm = ScriptedLlm(*responses)
        result, _ = handle_job(
            self.job, use_llm=True, llm=llm, model_name="synthetic-model",
            fallback_to_deterministic=True,
        )
        self.assertEqual(len(llm.calls), 2)
        self.assertEqual(result["llm_attempts"], 2)
        authoritative = self.job["input_payload"]["deterministic"]
        self.assertEqual(result["answer"], authoritative["answer"])
        self.assertEqual(result["facts"], authoritative["facts"])
        self.assertEqual(result["used_data"], authoritative["used_data"])
        return result, llm

    def test_repaired_success_carries_precise_first_failure_and_retry_feedback(self):
        result, llm = self.run_job(self.bad_action, self.valid)
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertTrue(result["llm_repaired"])
        self.assertFalse(result.get("llm_fallback", False))
        failures = result["llm_validation_failures"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["attempt"], 1)
        self.assertEqual(failures[0]["reason_code"], "action_format")
        self.assertIn("확인/이력 조회", failures[0]["rejected_text"])
        self.assertEqual(failures[0]["normalized_summary"], self.bad_action["summary"])
        repair = llm.calls[1][1]["input_payload"]
        self.assertEqual(list(repair)[:2], ["language", "instruction"])
        self.assertEqual(list(repair)[-1], "qualitative_draft")
        self.assertEqual(repair["validation_feedback"]["reason_code"], "action_format")
        self.assertIn("one check verb", repair["validation_feedback"]["instruction"])
        self.assertIn("확인/이력", repair["validation_feedback"]["rejected_excerpt"])

    def test_double_rejection_preserves_distinct_raw_candidates_and_failure_details(self):
        final_candidate = {
            "title": "재시도 응답",
            "summary": structured_ko("금형을 세\u200b척한 후 상태 확인"),
        }
        result, _ = self.run_job(self.bad_action, final_candidate)
        self.assertTrue(result["llm_fallback"])
        self.assertEqual(result["llm_fallback_code"], "grounding_rejected")
        self.assertEqual(result["source"], "local_llm_guarded_fallback")
        self.assertTrue(result["llm_initial_grounding_rejected"])
        self.assertEqual(result["llm_review_title"], self.bad_action["title"])
        self.assertEqual(result["llm_review_summary"], self.bad_action["summary"])
        self.assertEqual(result["llm_review_last_title"], final_candidate["title"])
        self.assertEqual(result["llm_review_last_summary"], final_candidate["summary"])
        failures = result["llm_validation_failures"]
        self.assertEqual([(item["attempt"], item["reason_code"]) for item in failures], [
            (1, "action_format"), (2, "operational_action"),
        ])
        self.assertEqual(failures[0]["normalized_summary"], self.bad_action["summary"])
        self.assertNotIn("\u200b", failures[1]["normalized_summary"])
        self.assertIn("세척", failures[1]["rejected_text"])
        self.assertIn("\u200b", result["llm_review_last_summary"])

    def test_final_section_error_has_response_format_classification(self):
        last = {"title": "응답 형식 오류", "summary": "생산 데이터 상태를 확인했습니다."}
        result, _ = self.run_job(self.bad_action, last)
        self.assertEqual(result["llm_fallback_code"], "response_format_rejected")
        self.assertEqual(result["llm_validation_failures"][-1]["reason_code"], "section_format")
        self.assertEqual(result["llm_review_summary"], self.bad_action["summary"])
        self.assertEqual(result["llm_review_last_summary"], last["summary"])

    def test_repair_timeout_does_not_fabricate_a_last_candidate_or_second_rejection(self):
        result, llm = self.run_job(self.bad_action, TimeoutError("synthetic repair timed out"))
        self.assertEqual(result["llm_fallback_code"], "timeout")
        self.assertTrue(result["llm_initial_grounding_rejected"])
        self.assertEqual(result["llm_review_summary"], self.bad_action["summary"])
        self.assertNotIn("llm_review_last_summary", result)
        self.assertNotIn("llm_review_last_title", result)
        self.assertEqual(len(result["llm_validation_failures"]), 1)
        self.assertEqual(result["llm_validation_failures"][0]["attempt"], 1)
        self.assertEqual(
            llm.calls[1][1]["input_payload"]["validation_feedback"]["reason_code"], "action_format",
        )


class MachineStateListGroundingRegressionTests(unittest.TestCase):
    def normalize_states(
        self, states, assertion="가동", separator=", ", *, conclusion=None,
        identifiers=("850T-1", "550T-12"),
    ):
        grounding = {
            "verified_tables": [{
                "name": "injection_machine_progress",
                "rows": [
                    {"machine_name": identifiers[0], "is_running": states[0], "actual_qty": 12},
                    {"machine_name": identifiers[1], "is_running": states[1], "actual_qty": 10},
                ],
            }],
        }
        summary = structured_ko(
            "MES 기록 조회",
            conclusion=conclusion or f"{identifiers[0]}{separator}{identifiers[1]}는 {assertion} 중입니다.",
        )
        # Quantities here only register the synthetic rows; the assertion
        # names exact identifiers and contains no model-written measurement.
        self.assertTrue(summary_numbers_are_grounded(summary, grounding))
        return normalize_result(
            {"title": "설비 현황", "summary": summary},
            {"title": "설비 현황", "summary": "서버에서 검증한 설비 상태입니다."},
            "synthetic-model",
            grounding,
        ), summary

    def test_identifier_list_cannot_borrow_another_machines_running_state(self):
        for states in ((True, False), (False, True)):
            for assertion in ("가동", "정지"):
                for separator in (", ", " 및 "):
                    with self.subTest(states=states, assertion=assertion, separator=separator):
                        with self.assertRaises(LlmGroundingError) as raised:
                            self.normalize_states(states, assertion, separator)
                        self.assertEqual(raised.exception.reason_code, "unsupported_claim")

    def test_consistent_verified_machine_state_lists_remain_accepted(self):
        for states, assertion in (((True, True), "가동"), ((False, False), "정지")):
            for separator in (", ", " 및 "):
                with self.subTest(states=states, assertion=assertion, separator=separator):
                    result, summary = self.normalize_states(states, assertion, separator)
                    self.assertEqual(result["summary"], summary)
                    self.assertEqual(result["source"], "local_llm_rewrite")
                    self.assertFalse(result.get("llm_numeric_lines_pruned", False))

    def test_distinct_state_predicates_keep_their_own_machine_subjects(self):
        for conclusion in (
            "850T-1은 가동 중이고 650T-10은 기준 시점에 가동하지 않았습니다.",
            "650T-10은 기준 시점에 가동하지 않았고 850T-1은 가동 중입니다.",
        ):
            with self.subTest(conclusion=conclusion):
                result, summary = self.normalize_states(
                    (True, False), conclusion=conclusion,
                    identifiers=("850T-1", "650T-10"),
                )
                self.assertEqual(result["summary"], summary)
                self.assertEqual(result["source"], "local_llm_rewrite")
                self.assertFalse(result.get("llm_numeric_lines_pruned", False))

    def test_later_information_clause_cannot_exempt_a_false_machine_state(self):
        for conclusion in (
            "550T-12는 가동 중이고, MES 데이터는 최신입니다.",
            "850T-1은 정지 중이고, MES 데이터는 최신입니다.",
        ):
            with self.subTest(conclusion=conclusion):
                with self.assertRaises(LlmGroundingError) as raised:
                    self.normalize_states((True, False), conclusion=conclusion)
                self.assertEqual(raised.exception.reason_code, "unsupported_claim")

    def test_chinese_subject_order_preserves_verified_machine_state(self):
        for text in ("850T-1目前正在运行。", "目前850T-1正在运行。"):
            with self.subTest(text=text):
                result, _ = self.normalize_states((True, False), conclusion=text)
                self.assertEqual(result["source"], "local_llm_rewrite")
                with self.assertRaises(LlmGroundingError):
                    self.normalize_states((False, False), conclusion=text)


class TrustedProseRepairIdentifierRegressionTests(unittest.TestCase):
    def test_server_answer_only_identifiers_survive_repair_in_both_languages(self):
        identifiers = ("650T-10", "850T-1", "550T-12", "450T-13")
        for language in ("ko", "zh"):
            with self.subTest(language=language):
                unit = "개" if language == "ko" else "件"
                grounding = {
                    "verified_facts": {"metric": "recent_production"},
                    "verified_answer": ", ".join(
                        f"{identifier} {quantity}{unit}"
                        for identifier, quantity in zip(identifiers, (12, 15, 18, 21))
                    ),
                }
                checks = "\n- ".join(
                    f"{identifier}의 최근 생산 이력을 확인하세요."
                    if language == "ko" else f"查询{identifier}的最近生产记录。"
                    for identifier in identifiers
                )
                summary = structured_ko(checks) if language == "ko" else structured_zh(checks)
                # This job shape deliberately has no verified_tables: exact
                # machine names exist only in the server's trusted answer.
                self.assertTrue(summary_numbers_are_grounded(summary, grounding))
                repair = build_repair_payload(
                    {"input_payload": {"language": language}},
                    {"title": "Production", "summary": summary},
                    grounding,
                )
                self.assertEqual(
                    {value.casefold() for value in repair["allowed_exact_identifiers"]},
                    {value.casefold() for value in identifiers},
                )
                for identifier in identifiers:
                    self.assertIn(identifier, repair["qualitative_draft"]["summary"])
                self.assertNotIn("검증 수치", repair["qualitative_draft"]["summary"])
                self.assertNotIn("已验证数值", repair["qualitative_draft"]["summary"])

    def test_question_and_history_prose_cannot_supply_repair_identifiers(self):
        repair = build_repair_payload(
            {"input_payload": {"language": "ko", "question": "999T-99의 상태는?"}},
            {"summary": "999T-99, 888T-88, 650T-10의 이력 확인"},
            {
                "verified_answer": "650T-10 12개",
                "question": "999T-99의 상태는?",
                "conversation_history": [{"summary": "888T-88 18개", "content": "888T-88의 기록"}],
            },
        )
        self.assertEqual(
            {value.casefold() for value in repair["allowed_exact_identifiers"]},
            {"650t-10"},
        )

    def test_corrupted_identifier_placeholders_are_rejected_in_both_languages(self):
        for summary in (
            structured_ko("검증 수치T-검증 수치의 최근 생산 이력을 확인하세요."),
            structured_zh("查询已验证数值T-已验证数值的最近生产记录。"),
        ):
            with self.subTest(summary=summary):
                with self.assertRaises(LlmGroundingError) as raised:
                    normalize_result(
                        {"title": "Production", "summary": summary},
                        {"summary": "서버에서 검증한 생산 현황입니다."},
                        "synthetic-model",
                        {"verified_answer": "650T-10 12개"},
                    )
                self.assertEqual(raised.exception.reason_code, "invalid_identifier")


if __name__ == "__main__":
    unittest.main()
