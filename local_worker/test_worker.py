import unittest
from unittest.mock import MagicMock, patch

try:
    from . import llm_client as llm_client_module
    from . import render_client as render_client_module
    from . import worker as worker_module
    from .job_handlers import production_daily_analysis, production_machine_analysis, production_question_analysis
    from .llm_client import LocalLlmClient
    from .render_client import RenderClient
    from .skills.production_analyst import build_skill_payload, insert_verified_metrics, select_analysis_mode
    from .worker import (
        RunOnceReport,
        build_repair_payload,
        handle_job,
        handler_for_job,
        normalize_result,
        run_once,
        summary_is_specific,
        summary_claims_are_safe,
        summary_numbers_are_grounded,
    )
except ImportError:
    import llm_client as llm_client_module
    import render_client as render_client_module
    import worker as worker_module
    from job_handlers import production_daily_analysis, production_machine_analysis, production_question_analysis
    from llm_client import LocalLlmClient
    from render_client import RenderClient
    from skills.production_analyst import build_skill_payload, insert_verified_metrics, select_analysis_mode
    from worker import (
        RunOnceReport,
        build_repair_payload,
        handle_job,
        handler_for_job,
        normalize_result,
        run_once,
        summary_is_specific,
        summary_claims_are_safe,
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

    def test_invalid_numeric_title_is_replaced_without_discarding_safe_summary(self):
        result = normalize_result(
            {
                "title": "1, 9호기 형합 예상치 분석",
                "summary": "현재 추세를 바탕으로 기준일 종료 예상 결과를 확인했습니다.",
            },
            self.fallback,
            "qwen-test",
            self.fallback,
        )

        self.assertEqual(result["title"], "Deterministic analysis")
        self.assertEqual(result["summary"], "현재 추세를 바탕으로 기준일 종료 예상 결과를 확인했습니다.")
        self.assertTrue(result["llm_title_fallback"])
        self.assertEqual(result["source"], "local_llm_rewrite")


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

    def test_korean_modifier_suffix_is_not_misread_as_one_unit(self):
        self.assertTrue(
            summary_numbers_are_grounded(
                "요청한 시간 구간의 설비 상태를 확인했습니다.",
                self.grounding,
            ),
        )

    def test_attached_korean_spelled_quantity_is_rejected(self):
        for summary in [
            "사출기는두 대입니다.",
            "총두 대입니다.",
            "약두 대입니다.",
            "대략두 대입니다.",
            "최소두 대입니다.",
            "최대두 대입니다.",
            "사출기는모두두대입니다.",
            "사출기는겨우두대입니다.",
            "사출기는오직두대입니다.",
            "사출기는총합두대입니다.",
            "사출기는대략적으로두대입니다.",
        ]:
            with self.subTest(summary=summary):
                self.assertFalse(
                    summary_numbers_are_grounded(
                        summary,
                        {"verified_answer": "가동된 사출기는 2대입니다."},
                    ),
                )

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

    def test_exact_server_verified_count_sentence_is_accepted_without_subject_identifier(self):
        grounding = {
            "verified_answer": "최근 측정 구간에 가동된 사출기는 2대입니다.",
        }

        self.assertTrue(
            summary_numbers_are_grounded(
                "최근 측정 구간에 가동된 사출기는 2대입니다.",
                grounding,
            ),
        )
        self.assertFalse(
            summary_numbers_are_grounded(
                "최근 측정 구간에 가동된 사출기는 3대입니다.",
                grounding,
            ),
        )

    def test_question_summary_rejects_raw_status_codes_and_vague_equipment_subjects(self):
        grounding = {
            "verified_tables": [{
                "rows": [
                    {"machine": "850T-1", "is_running": True},
                    {"machine": "650T-10", "is_running": False},
                ],
            }],
        }
        self.assertFalse(summary_is_specific("850T-1은 is_running=true입니다.", grounding))
        self.assertFalse(summary_is_specific("일부 설비는 가동 중입니다.", grounding))
        self.assertTrue(
            summary_is_specific(
                "850T-1은 가동 중이고 650T-10은 기준 시점에 가동하지 않았습니다.",
                grounding,
            ),
        )
        self.assertFalse(summary_is_specific("원료 부족 때문에 가공이 지연됐습니다.", grounding))
        self.assertFalse(summary_is_specific("금형 온도가 불안정한 상태입니다.", grounding))
        self.assertFalse(summary_is_specific("공급사를 교체해야 합니다.", grounding))
        self.assertFalse(summary_is_specific("작업자 교대가 늦어 사출이 지연됐습니다.", grounding))
        self.assertFalse(summary_is_specific("금형 압력이 불안정합니다.", grounding))
        self.assertFalse(summary_is_specific("외주업체에 즉시 연락하세요.", grounding))
        self.assertFalse(summary_is_specific("작업자 숙련도 저하가 생산성 하락을 유발했습니다.", grounding))
        self.assertFalse(summary_is_specific("금형 압력 이상이 관찰됩니다.", grounding))
        self.assertFalse(summary_is_specific("작업자 배치를 바꾸세요.", grounding))
        self.assertTrue(
            summary_is_specific(
                "650T-10의 비가동 사유와 생산 계획을 확인해야 합니다.",
                grounding,
            ),
        )
        self.assertTrue(
            summary_is_specific(
                "금형 압력 데이터가 없어 이상 여부를 확인해야 합니다.",
                grounding,
            ),
        )

    def test_target_trend_requires_history_limit_and_rejects_unrelated_identifiers(self):
        grounding = {
            "analysis_skill": {
                "mode": "trend_assessment",
                "focus_identifiers": ["850T-1", "PART-A", "32인치"],
                "limitations": ["target_level_history_unavailable"],
            },
            "verified_tables": [{
                "rows": [
                    {"machine": "850T-1", "part_no": "PART-A", "model_name": "32인치"},
                    {"machine": "650T-10", "part_no": "PART-B", "model_name": "OTHER"},
                ],
            }],
        }
        self.assertFalse(summary_is_specific("32인치 모델은 현재 지연 추이입니다.", grounding))
        self.assertFalse(
            summary_is_specific(
                "32인치 모델은 대상 이력이 없어 생산 추이를 판단할 수 없습니다. "
                "현재 진행률은 계획 대비 낮은 수준입니다.",
                grounding,
            ),
        )
        self.assertFalse(
            summary_is_specific(
                "32인치 모델은 대상 이력이 없어 생산 추이를 판단할 수 없습니다. "
                "현재 진행률은 계획 대비 적절하거나 미달 상태입니다.",
                grounding,
            ),
        )
        self.assertFalse(
            summary_is_specific(
                "32인치 모델은 대상 이력이 없어 생산 추이를 판단할 수 없습니다. "
                "현재 시간 대비 미달 상태입니다.",
                grounding,
            ),
        )
        self.assertFalse(
            summary_is_specific(
                "32인치 모델은 대상 이력이 없어 생산 추이를 판단할 수 없습니다. "
                "850T-1의 가동 상태를 재확인해야 합니다.",
                grounding,
            ),
        )
        self.assertTrue(
            summary_is_specific(
                "32인치 모델은 대상 이력이 없어 생산 추이를 판단할 수 없습니다. "
                "850T-1의 현재 상태만 확인했습니다.",
                grounding,
            ),
        )
        self.assertTrue(
            summary_is_specific(
                "32인치 모델은 비교 근거가 부족해 생산 추이를 단정할 수 없습니다. "
                "850T-1의 현재 상태만 확인했습니다.",
                grounding,
            ),
        )
        self.assertFalse(
            summary_is_specific(
                "32인치 모델은 대상 이력이 없어 생산 추이를 판단할 수 없습니다. "
                "650T-10도 확인해야 합니다.",
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


class ProductionAnalystSkillTests(unittest.TestCase):
    def test_selects_question_mode_without_asking_qwen_to_calculate(self):
        self.assertEqual(select_analysis_mode("지금 생산이 잘 되고 있나?"), "status_summary")
        self.assertEqual(select_analysis_mode("어떤 모델의 생산 추이가 정체됐어?"), "trend_assessment")
        self.assertEqual(select_analysis_mode("무엇을 먼저 확인해야 해?"), "decision_support")
        self.assertEqual(select_analysis_mode("가공이 왜 늦어지고 있지?"), "decision_support")

    def test_builds_exact_metric_sentences_from_verified_process_facts(self):
        skill = build_skill_payload({
            "language": "ko",
            "question": "지금 생산이 잘 되고 있나?",
            "verified_facts": {
                "injection": {
                    "actual_qty": 5704,
                    "planned_qty": 15561,
                    "progress_rate": 36.7,
                    "time_progress_rate": 41.7,
                    "status": "on_track",
                },
                "machining": {
                    "actual_qty": 820,
                    "planned_qty": 4211,
                    "progress_rate": 19.5,
                    "time_progress_rate": 41.7,
                    "status": "behind",
                },
            },
            "verified_tables": [],
            "historical_snapshots": [],
        })

        self.assertEqual(skill["mode"], "status_summary")
        self.assertIn("사출 실적은 5,704개", skill["verified_evidence_sentences"][0])
        self.assertIn("가공 실적은 820개", skill["verified_evidence_sentences"][1])
        self.assertEqual(skill["verified_status_findings"]["machining"]["status"], "behind")

    def test_skips_process_metric_sentence_when_time_progress_is_missing(self):
        skill = build_skill_payload({
            "language": "ko",
            "question": "지금 생산이 잘 되고 있나?",
            "verified_facts": {
                "injection": {
                    "actual_qty": 5704,
                    "planned_qty": 15561,
                    "progress_rate": 36.7,
                    "status": "on_track",
                },
            },
            "verified_tables": [],
            "historical_snapshots": [],
        })

        self.assertEqual(skill["verified_evidence_sentences"], [])

    def test_target_question_uses_matching_verified_row_and_flags_missing_target_history(self):
        skill = build_skill_payload({
            "language": "ko",
            "question": "32인치 모델 생산 추이가 잘 오르고 있나?",
            "verified_facts": {},
            "verified_tables": [{
                "name": "injection_part_progress",
                "rows": [{
                    "machine": "850T-1",
                    "model_name": "32인치",
                    "part_no": "PART-A",
                    "estimated_qty": 820,
                    "planned_qty": 4211,
                    "progress_rate": 19.5,
                    "status": "in_progress",
                }],
            }],
            "historical_snapshots": [{"facts": {"injection": {"progress_rate": 10.0}}}],
        })

        self.assertEqual(skill["mode"], "trend_assessment")
        self.assertEqual(skill["matched_targets"], [["32인치"]])
        self.assertEqual(skill["focus_identifiers"], ["850T-1", "PART-A", "32인치"])
        self.assertIn("850T-1 / PART-A / 32인치", skill["verified_evidence_sentences"][0])
        self.assertIn("target_level_history_unavailable", skill["limitations"])

    def test_target_history_must_match_the_requested_identifier(self):
        base_payload = {
            "language": "ko",
            "question": "32인치 모델 생산 추이가 잘 오르고 있나?",
            "verified_facts": {},
            "verified_tables": [{
                "name": "injection_part_progress",
                "rows": [{
                    "machine": "850T-1",
                    "model_name": "32인치",
                    "part_no": "PART-A",
                    "estimated_qty": 820,
                    "planned_qty": 4211,
                    "progress_rate": 19.5,
                    "status": "in_progress",
                }],
            }],
        }

        unrelated = build_skill_payload({
            **base_payload,
            "historical_snapshots": [{"rows": [{"model_name": "OTHER", "progress_rate": 20.0}]}],
        })
        matching = build_skill_payload({
            **base_payload,
            "historical_snapshots": [
                {
                    "completed_at": "2026-08-03T09:00:00+08:00",
                    "rows": [{"model_name": "32인치", "progress_rate": 15.0}],
                },
                {
                    "completed_at": "2026-08-03T10:00:00+08:00",
                    "rows": [{"model_name": "32인치", "progress_rate": 20.0}],
                },
            ],
        })
        one_point = build_skill_payload({
            **base_payload,
            "historical_snapshots": [{
                "completed_at": "2026-08-03T10:00:00+08:00",
                "rows": [{"model_name": "32인치", "progress_rate": 20.0}],
            }],
        })

        self.assertIn("target_level_history_unavailable", unrelated["limitations"])
        self.assertIn("target_level_history_unavailable", one_point["limitations"])
        self.assertNotIn("target_level_history_unavailable", matching["limitations"])

    def test_machine_number_alias_matches_canonical_equipment_identifier(self):
        skill = build_skill_payload({
            "language": "ko",
            "question": "1호기 지금 생산 중인가?",
            "verified_facts": {},
            "verified_tables": [{
                "name": "injection_machine_progress",
                "rows": [{
                    "machine": "850T-1",
                    "actual_qty": 928,
                    "planned_qty": 1800,
                    "progress_rate": 51.6,
                    "is_running": True,
                }],
            }],
            "historical_snapshots": [],
        })

        self.assertEqual(skill["matched_targets"], [["850T-1"]])
        self.assertEqual(skill["focus_identifiers"], ["850T-1"])
        self.assertIn("850T-1 실적은", skill["verified_evidence_sentences"][0])

    def test_follow_up_reference_uses_latest_user_target_and_mode(self):
        skill = build_skill_payload({
            "language": "ko",
            "question": "그 모델은?",
            "conversation_history": [
                {"role": "user", "content": "32인치 모델 생산 추이가 잘 오르고 있나?"},
                {"role": "assistant", "content": "대상 이력이 필요합니다."},
            ],
            "verified_facts": {},
            "verified_tables": [{
                "name": "injection_part_progress",
                "rows": [
                    {
                        "machine": "850T-1",
                        "part_no": "PART-A",
                        "model_name": "32인치",
                        "estimated_qty": 820,
                        "planned_qty": 4211,
                        "progress_rate": 19.5,
                        "status": "in_progress",
                    },
                    {
                        "machine": "650T-10",
                        "part_no": "PART-B",
                        "model_name": "OTHER",
                        "estimated_qty": 100,
                        "planned_qty": 500,
                        "progress_rate": 20.0,
                        "status": "pending",
                    },
                ],
            }],
            "historical_snapshots": [],
        })

        self.assertTrue(skill["resolved_reference_from_history"])
        self.assertEqual(skill["mode"], "direct_answer")
        self.assertEqual(skill["matched_targets"], [["32인치"]])
        self.assertEqual(skill["focus_identifiers"], ["850T-1", "PART-A", "32인치"])

    def test_machining_reconciliation_status_is_translated_in_metric_sentence(self):
        skill = build_skill_payload({
            "language": "ko",
            "question": "D LINE의 PART-D 상태는?",
            "verified_facts": {},
            "verified_tables": [{
                "name": "machining_part_progress",
                "rows": [{
                    "equipment_label": "D LINE",
                    "part_no": "PART-D",
                    "actual_qty": 100,
                    "planned_qty": 1047,
                    "progress_rate": 9.6,
                    "status": "manual_mismatch",
                }],
            }],
            "historical_snapshots": [],
        })

        sentence = skill["verified_evidence_sentences"][0]
        self.assertIn("수기 실적 불일치 확인 필요", sentence)
        self.assertNotIn("manual_mismatch", sentence)

    def test_metric_insertion_keeps_exact_verified_sentence_already_used_by_qwen(self):
        sentence = "사출 실적은 5,704개이고 계획은 15,561개이며 완료율은 36.7%입니다."
        summary = (
            "결론: 사출 현황을 확인했습니다.\n\n"
            f"판단 근거:\n- {sentence}\n\n"
            "확인할 항목:\n- 다음 측정값을 비교하세요."
        )

        enriched = insert_verified_metrics(
            summary,
            {"verified_evidence_sentences": [sentence]},
            "ko",
        )

        self.assertEqual(enriched.count(sentence), 1)
        self.assertEqual(enriched, summary)


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
        self.assertEqual(payload["analysis_skill"]["name"], "production-analyst")

    def test_exact_skill_metric_sentence_is_allowed_but_numeric_rewrite_is_rejected(self):
        status_job = {
            "input_payload": {
                "source": "production_ai_question",
                "language": "ko",
                "question": "지금 생산이 잘 되고 있나?",
                "verified_context": {
                    "facts": {
                        "injection": {
                            "actual_qty": 5704,
                            "planned_qty": 15561,
                            "progress_rate": 36.7,
                            "time_progress_rate": 41.7,
                            "status": "on_track",
                        },
                    },
                    "tables": [],
                },
            },
        }
        payload = production_question_analysis.build_llm_payload(status_job)
        grounding = production_question_analysis.build_grounding_payload(status_job)
        exact_sentence = payload["analysis_skill"]["verified_evidence_sentences"][0]

        self.assertTrue(summary_numbers_are_grounded(exact_sentence, grounding))
        self.assertFalse(
            summary_numbers_are_grounded(
                exact_sentence.replace("5,704개", "5,705개"),
                grounding,
            ),
        )

    def test_worker_inserts_verified_metrics_after_qwen_qualitative_answer(self):
        status_job = {
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "question", "language": "ko"},
            "input_payload": {
                "source": "production_ai_question",
                "language": "ko",
                "question": "지금 생산이 잘 되고 있나?",
                "deterministic": {"answer": "검증 데이터 설명"},
                "verified_context": {
                    "facts": {
                        "injection": {
                            "actual_qty": 5704,
                            "planned_qty": 15561,
                            "progress_rate": 36.7,
                            "time_progress_rate": 41.7,
                            "status": "on_track",
                        },
                    },
                    "tables": [],
                },
            },
        }

        class FakeLlm:
            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                return {
                    "title": "생산 판단",
                    "summary": (
                        "결론: 사출은 시간 기준과 유사하게 진행 중입니다.\n\n"
                        "판단 근거:\n- 검증된 공정 상태가 안정 범위입니다.\n\n"
                        "확인할 항목:\n- 현재 추세 유지 여부를 확인하세요."
                    ),
                }

        result, _ = handle_job(
            status_job,
            use_llm=True,
            llm=FakeLlm(),
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertIn("핵심 수치:\n사출 실적은 5,704개", result["summary"])
        self.assertLess(result["summary"].index("핵심 수치:"), result["summary"].index("판단 근거:"))
        self.assertEqual(result["llm_attempts"], 1)

    def test_active_machine_count_keeps_first_qwen_answer_and_prunes_duplicate_numbers(self):
        active_count_job = {
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "question", "date": "2026-08-03", "language": "ko"},
            "input_payload": {
                "source": "production_ai_question",
                "answer_mode": "verified_answer_rewrite",
                "language": "ko",
                "date": "2026-08-03",
                "question": "지난 12시간 동안 가동된 사출기의 수는?",
                "deterministic": {
                    "answer": (
                        "최신 MES 기록까지 최근 12시간 동안 누적 형합값이 증가한 사출기는 "
                        "2대입니다. 대상 설비는 850T-1, 1300T-3입니다."
                    ),
                    "facts": {
                        "metric": "injection_active_machine_count",
                        "lookback_minutes": 720,
                        "active_machine_count": 2,
                        "active_machines": [
                            {"machine": "850T-1", "machine_number": 1, "shot_count": 30},
                            {"machine": "1300T-3", "machine_number": 3, "shot_count": 10},
                        ],
                    },
                },
            },
        }

        class FakeLlm:
            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                return {
                    "title": "가동 사출기 확인",
                    "summary": (
                        "결론: 최신 MES 기록까지 최근 12시간 동안 누적 형합값이 증가한\n"
                        "사출기는 2대입니다. 대상 설비는 850T-1, 1300T-3입니다.\n\n"
                        "판단 근거:\n"
                        "- 최신 MES 기록 기준 최근 12시간 동안 가동된 사출기 대수는 2대입니다.\n"
                        "- shot_count 데이터의 증가 여부를 기준으로 확인했습니다.\n\n"
                        "확인할 항목:\n- 최신 데이터 수집 시점을 함께 확인하세요."
                    ),
                }

        result, _ = handle_job(
            active_count_job,
            use_llm=True,
            llm=FakeLlm(),
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertEqual(result["llm_attempts"], 1)
        self.assertFalse(result.get("llm_repaired", False))
        self.assertTrue(result["llm_numeric_lines_pruned"])
        self.assertIn("결론:\n최신 MES 기록", result["summary"])
        self.assertEqual(result["summary"].count("최근 12시간"), 1)
        self.assertIn("2대", result["summary"])
        self.assertIn("850T-1, 1300T-3", result["summary"])
        self.assertNotIn("핵심 수치:", result["summary"])
        self.assertNotIn("shot_count", result["summary"])
        self.assertIn("형합수 데이터", result["summary"])
        self.assertTrue(result["llm_schema_terms_normalized"])
        self.assertIn("\n\n판단 근거:", result["summary"])

    def test_active_machine_count_rejects_qwen_number_change_before_accepting_repair(self):
        active_count_job = {
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "question", "date": "2026-08-03", "language": "ko"},
            "input_payload": {
                "source": "production_ai_question",
                "answer_mode": "verified_answer_rewrite",
                "language": "ko",
                "date": "2026-08-03",
                "question": "지난 12시간 동안 가동된 사출기의 수는?",
                "deterministic": {
                    "answer": "최근 12시간 동안 가동된 사출기는 2대입니다.",
                    "facts": {"active_machine_count": 2, "lookback_minutes": 720},
                },
            },
        }

        class SequencedLlm:
            def __init__(self):
                self.calls = 0

            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                self.calls += 1
                if self.calls == 1:
                    return {"title": "가동 현황", "summary": "최근 12시간 동안 가동된 사출기는 3대입니다."}
                return {"title": "가동 현황", "summary": "최근 12시간 동안 가동된 사출기는 2대입니다."}

        llm = SequencedLlm()
        result, _ = handle_job(
            active_count_job,
            use_llm=True,
            llm=llm,
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(llm.calls, 2)
        self.assertTrue(result["llm_repaired"])
        self.assertIn("2대", result["summary"])
        self.assertNotIn("3대", result["summary"])

    def test_verified_answer_does_not_bypass_unsupported_causal_claim_guard(self):
        class SequencedLlm:
            def __init__(self):
                self.calls = 0

            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                self.calls += 1
                if self.calls == 1:
                    return {
                        "title": "형합 예상",
                        "summary": (
                            "1호기 종료 예상 형합수는 2,900회입니다.\n\n"
                            "금형 온도 문제의 결과 생산이 늦습니다."
                        ),
                    }
                return {
                    "title": "형합 예상",
                    "summary": "1호기 종료 예상 형합수는 2,900회입니다.",
                }

        llm = SequencedLlm()
        result, _ = handle_job(
            self.job,
            use_llm=True,
            llm=llm,
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(llm.calls, 2)
        self.assertTrue(result["llm_repaired"])
        self.assertNotIn("금형 온도", result["summary"])

        grounding = production_question_analysis.build_grounding_payload(self.job)
        for unsafe_claim in [
            "금형 온도 문제로 생산이 늦습니다.",
            "금형 온도가 생산 속도를 떨어뜨렸습니다.",
            "작업자 실수로 생산이 늦습니다.",
            "작업자 실수가 지연을 만들었습니다.",
            "금형 온도가 낮아서 생산성이 떨어졌습니다.",
            "작업자 오류가 생산 차질을 만들었습니다.",
            "작업자 실수가 지연을 일으켰습니다.",
            "작업자 오류가 생산 차질로 이어졌습니다.",
            "작업자 오류가 생산 차질을 낳았습니다.",
            "작업자 실수에서 생산 지연이 비롯됐습니다.",
        ]:
            with self.subTest(unsafe_claim=unsafe_claim):
                self.assertFalse(summary_claims_are_safe(unsafe_claim, grounding))

        self.assertTrue(
            summary_claims_are_safe(
                "작업자 오류와 생산 차질의 관련 여부를 확인해야 합니다.",
                grounding,
            ),
        )

    def test_missing_active_machine_data_cannot_be_rephrased_as_no_active_machines(self):
        missing_job = {
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "question", "date": "2026-08-03", "language": "ko"},
            "input_payload": {
                "source": "production_ai_question",
                "answer_mode": "verified_answer_rewrite",
                "language": "ko",
                "date": "2026-08-03",
                "question": "지난 12시간 동안 가동된 사출기의 수는?",
                "deterministic": {
                    "answer": "MES 형합 기록이 없어 가동된 사출기 대수를 확인할 수 없습니다.",
                    "facts": {
                        "metric": "injection_active_machine_count",
                        "active_machine_count": None,
                    },
                    "warnings": ["injection_capacity_data_missing"],
                },
            },
        }

        class SequencedLlm:
            def __init__(self):
                self.calls = 0

            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                self.calls += 1
                if self.calls == 1:
                    return {
                        "title": "가동 현황",
                        "summary": (
                            "MES 형합 기록이 없어 가동된 사출기 대수를 확인할 수 없습니다.\n\n"
                            "가동된 사출기는 없습니다."
                        ),
                    }
                return {
                    "title": "가동 현황",
                    "summary": "MES 형합 기록이 없어 가동된 사출기 대수를 확인할 수 없습니다.",
                }

        llm = SequencedLlm()
        result, _ = handle_job(
            missing_job,
            use_llm=True,
            llm=llm,
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(llm.calls, 2)
        self.assertTrue(result["llm_repaired"])
        self.assertIn("확인할 수 없습니다", result["summary"])
        self.assertNotIn("사출기는 없습니다", result["summary"])

        grounding = production_question_analysis.build_grounding_payload(missing_job)
        for false_zero_claim in [
            "가동된 사출기가 한 대도 없습니다.",
            "현재 가동 설비가 없습니다.",
            "가동 중인 사출기는 존재하지 않습니다.",
            "현재 가동 중인 설비가 없습니다.",
            "가동 중인 장비는 존재하지 않습니다.",
            "운전 중인 설비가 없습니다.",
            "가동했던 설비는 한 대도 없습니다.",
        ]:
            with self.subTest(false_zero_claim=false_zero_claim):
                self.assertFalse(summary_claims_are_safe(false_zero_claim, grounding))

    def test_style_only_quality_issue_keeps_first_qwen_answer(self):
        class OneCallLlm:
            def __init__(self):
                self.calls = 0

            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                self.calls += 1
                return {
                    "title": "생산 설명",
                    "summary": "일부 설비는 검증된 생산 흐름에 포함되어 있습니다.",
                }

        llm = OneCallLlm()
        result, _ = handle_job(
            self.job,
            use_llm=True,
            llm=llm,
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(llm.calls, 1)
        self.assertEqual(result["llm_attempts"], 1)
        self.assertFalse(result.get("llm_repaired", False))
        self.assertIn("일부 설비", result["summary"])
        self.assertIn("vague_quantifier", result["llm_quality_warnings"])

    def test_repair_payload_preserves_uppercase_machine_identifier(self):
        self.job["input_payload"]["verified_context"] = {
            "tables": [{
                "name": "injection_machine_progress",
                "rows": [{"machine": "850T-1", "is_running": True}],
            }],
        }
        grounding = production_question_analysis.build_grounding_payload(self.job)

        repair_payload = build_repair_payload(
            self.job,
            {
                "title": "850T-1 상태",
                "summary": "850T-1의 최근 60분 상태를 확인했습니다.",
            },
            grounding,
        )

        self.assertIn("850T-1", repair_payload["qualitative_draft"]["summary"])
        self.assertNotIn("검증 수치T-검증 수치", str(repair_payload))

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

    def test_question_target_row_is_kept_before_table_prompt_limit(self):
        rows = [
            {
                "machine": f"MACHINE-{index}",
                "model_name": f"MODEL-{index}",
                "planned_qty": 100,
                "estimated_qty": 10,
                "status": "pending",
            }
            for index in range(60)
        ]
        rows.append({
            "machine": "850T-1",
            "model_name": "TARGET-MODEL",
            "planned_qty": 500,
            "estimated_qty": 250,
            "status": "in_progress",
        })
        self.job["input_payload"]["question"] = "TARGET-MODEL 지금 생산 중인가?"
        self.job["input_payload"]["verified_context"] = {
            "tables": [{"name": "injection_part_progress", "rows": rows}],
        }

        payload = production_question_analysis.build_llm_payload(self.job)

        self.assertEqual(len(payload["verified_tables"][0]["rows"]), 60)
        self.assertEqual(payload["verified_tables"][0]["rows"][0]["model_name"], "TARGET-MODEL")
        self.assertEqual(payload["analysis_skill"]["matched_targets"], [["TARGET-MODEL"]])

    def test_repair_payload_excludes_rows_outside_question_focus(self):
        self.job["input_payload"]["question"] = "32인치 모델 생산 추이가 잘 오르고 있나?"
        self.job["input_payload"]["verified_context"] = {
            "tables": [{
                "name": "injection_part_progress",
                "rows": [
                    {
                        "machine": "850T-1",
                        "part_no": "PART-A",
                        "model_name": "32인치",
                        "status": "in_progress",
                    },
                    {
                        "machine": "650T-10",
                        "part_no": "PART-B",
                        "model_name": "OTHER",
                        "status": "pending",
                    },
                ],
            }],
            "historical_snapshots": [],
        }
        grounding = production_question_analysis.build_grounding_payload(self.job)

        repair_payload = build_repair_payload(
            self.job,
            {
                "title": "32인치 생산 추이",
                "summary": "850T-1은 계획 대비 적절하거나 미달이고 650T-10도 확인했습니다.",
            },
            grounding,
        )

        serialized = str(repair_payload)
        self.assertIn("850T-1", serialized)
        self.assertIn("PART-A", serialized)
        self.assertNotIn("650T-10", serialized)
        self.assertNotIn("PART-B", serialized)
        self.assertNotIn("적절하거나 미달", serialized)
        self.assertEqual(repair_payload["qualitative_draft"]["summary"], "")

    def test_numbered_reasoning_bullets_are_normalized_before_grounding(self):
        grounding = {
            "analysis_skill": {
                "mode": "trend_assessment",
                "focus_identifiers": ["850T-1", "PART-A", "32인치"],
                "limitations": ["target_level_history_unavailable"],
            },
            "verified_tables": [{
                "name": "injection_part_progress",
                "rows": [{
                    "machine": "850T-1",
                    "part_no": "PART-A",
                    "model_name": "32인치",
                    "status": "in_progress",
                    "estimated_qty": 820,
                    "planned_qty": 4211,
                    "progress_rate": 19.5,
                }],
            }],
        }

        normalized = normalize_result(
            {
                "title": "32인치 생산 현황",
                "summary": (
                    "결론\n32인치 생산 추이는 판단할 수 없습니다.\n\n"
                    "판단 근거\n1. 850T-1에서 PART-A 생산이 진행 중입니다.\n"
                    "2. 대상별 과거 데이터가 없습니다.\n\n"
                    "확인할 항목\n- 대상별 시간 스냅샷을 수집해야 합니다."
                ),
            },
            {"title": "생산 현황", "answer": "검증된 답변"},
            "qwen-test",
            grounding,
        )

        self.assertIn("결론:", normalized["summary"])
        self.assertIn("- 850T-1", normalized["summary"])
        self.assertIn("- 대상별 과거", normalized["summary"])
        self.assertNotIn("1. ", normalized["summary"])

    def test_question_qwen_rewrites_only_prose_and_preserves_verified_result(self):
        class FakeLlm:
            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
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
        self.assertEqual(result["llm_attempts"], 1)
        self.assertEqual(prompt_version, "production-question-v7")

    def test_grounding_rejection_is_repaired_with_qualitative_payload(self):
        class SequencedLlm:
            def __init__(self):
                self.calls = []
                self.responses = iter([
                    {
                        "title": "1호기 생산 추세",
                        "summary": "1호기의 최근 60분 속도를 기준으로 예상 결과를 확인했습니다.",
                    },
                    {
                        "title": "1호기 생산 추세",
                        "summary": "1호기의 최근 측정 추세를 기준으로 예상 결과를 확인했습니다.",
                    },
                ])

            def structured_analysis(self, system_prompt, payload, **kwargs):
                self.calls.append((system_prompt, payload, kwargs))
                return next(self.responses)

        llm = SequencedLlm()
        result, _ = handle_job(
            self.job,
            use_llm=True,
            llm=llm,
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(len(llm.calls), 2)
        self.assertEqual(
            llm.calls[0][2],
            {"enable_thinking": True, "thinking_budget": 384, "timeout_seconds": 100},
        )
        self.assertEqual(llm.calls[1][2], {"timeout_seconds": 45})
        self.assertNotIn("60", str(llm.calls[1][1]))
        self.assertNotIn("2,900", str(llm.calls[1][1]))
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertTrue(result["llm_repaired"])
        self.assertEqual(result["llm_attempts"], 2)
        self.assertEqual(result["facts"]["projected_total_shots"], 2900)

    def test_unverified_question_number_is_removed_from_repair_payload(self):
        self.job["input_payload"]["question"] = "오늘 32인치 모델 생산 중인가?"
        candidate = {
            "title": "생산 상태",
            "summary": "32인치 모델의 생산 여부를 확인했습니다.",
        }
        grounding = production_question_analysis.build_grounding_payload(self.job)

        repair_payload = build_repair_payload(self.job, candidate, grounding)

        self.assertNotIn("32", str(repair_payload))
        self.assertIn("해당 규격", str(repair_payload))

    def test_verified_numeric_model_identifier_can_answer_current_status_directly(self):
        status_job = {
            "job_type": "production_daily_analysis",
            "scope": {"trigger": "question", "date": "2026-08-03", "language": "ko"},
            "input_payload": {
                "source": "production_ai_question",
                "answer_mode": "context_grounded",
                "language": "ko",
                "date": "2026-08-03",
                "question": "오늘 32인치 모델 생산 중인가?",
                "deterministic": {"answer": "데이터 범위를 확인해 주세요.", "facts": {}},
                "verified_context": {
                    "tables": [{
                        "name": "injection_part_progress",
                        "columns": ["machine", "model_name", "status"],
                        "rows": [{
                            "machine": "850T-1",
                            "model_name": "32인치",
                            "status": "in_progress",
                            "planned_qty": 1200,
                        }],
                    }],
                },
            },
        }

        class FakeLlm:
            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                return {
                    "title": "32인치 모델 생산 상태",
                    "summary": "32인치 모델은 현재 생산 진행 중입니다.",
                }

        result, _ = handle_job(
            status_job,
            use_llm=True,
            llm=FakeLlm(),
            model_name="qwen-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(result["summary"], "32인치 모델은 현재 생산 진행 중입니다.")
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertFalse(result.get("llm_fallback", False))

    def test_double_grounding_rejection_preserves_qwen_draft_for_review(self):
        class RejectedLlm:
            def __init__(self):
                self.calls = 0

            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                self.calls += 1
                return {
                    "title": "생산 추세",
                    "summary": "최근 60분 속도를 기준으로 예상 결과를 확인했습니다.",
                }

        llm = RejectedLlm()
        result, _ = handle_job(
            self.job,
            use_llm=True,
            llm=llm,
            model_name="qwen-test",
            fallback_to_deterministic=True,
        )

        self.assertEqual(llm.calls, 2)
        self.assertTrue(result["llm_fallback"])
        self.assertEqual(result["llm_fallback_code"], "grounding_rejected")
        self.assertEqual(result["source"], "local_llm_guarded_fallback")
        self.assertEqual(result["model_name"], "qwen-test")
        self.assertEqual(result["llm_attempts"], 2)
        self.assertEqual(
            result["llm_review_summary"],
            "최근 60분 속도를 기준으로 예상 결과를 확인했습니다.",
        )
        self.assertEqual(result["answer"], "1호기 종료 예상 형합수는 2,900회입니다.")

    def test_repair_connection_failure_keeps_initial_rejection_but_reports_terminal_error(self):
        class RepairConnectionFailureLlm:
            def __init__(self):
                self.calls = 0

            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                self.calls += 1
                if self.calls == 1:
                    return {
                        "title": "생산 추세",
                        "summary": "최근 60분 속도를 기준으로 예상 결과를 확인했습니다.",
                    }
                raise ConnectionError("local model connection failed")

        result, _ = handle_job(
            self.job,
            use_llm=True,
            llm=RepairConnectionFailureLlm(),
            model_name="qwen-test",
            fallback_to_deterministic=True,
        )

        self.assertEqual(result["llm_fallback_code"], "model_unavailable")
        self.assertTrue(result["llm_initial_grounding_rejected"])
        self.assertEqual(result["llm_attempts"], 2)
        self.assertIn("최근 60분", result["llm_review_summary"])


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

    def test_question_request_can_enable_bounded_internal_thinking(self):
        response = self.Response({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": '{"title":"생산 분석","summary":"검증된 답변"}',
                    "reasoning_content": "internal reasoning must not be returned",
                },
            }],
        })
        with patch.object(llm_client_module.requests, "post", return_value=response) as post:
            result = self.client.structured_analysis(
                "system",
                {"question": "status"},
                enable_thinking=True,
                thinking_budget=384,
                timeout_seconds=100,
            )

        request_payload = post.call_args.kwargs["json"]
        self.assertTrue(request_payload["enable_thinking"])
        self.assertEqual(request_payload["thinking_budget"], 384)
        self.assertEqual(post.call_args.kwargs["timeout"], 100)
        self.assertEqual(result["summary"], "검증된 답변")
        self.assertNotIn("reasoning", str(result))

    def test_reasoning_content_is_never_used_as_the_final_answer(self):
        response = self.Response({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": None,
                    "reasoning_content": '{"title":"hidden","summary":"hidden"}',
                    "reasoning": '{"title":"hidden","summary":"hidden"}',
                },
            }],
        })
        with patch.object(llm_client_module.requests, "post", return_value=response):
            with self.assertRaisesRegex(ValueError, "final answer content"):
                self.client.structured_analysis("system", {"question": "status"})

    def test_truncated_thinking_response_is_rejected(self):
        response = self.Response({
            "choices": [{
                "finish_reason": "length",
                "message": {"content": '{"title":"partial"}'},
            }],
        })
        with patch.object(llm_client_module.requests, "post", return_value=response):
            with self.assertRaisesRegex(ValueError, "before the final answer"):
                self.client.structured_analysis("system", {"question": "status"})


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
