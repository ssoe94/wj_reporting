from __future__ import annotations

import copy
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
            "source_evidence_hash": "evidence-hash",
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
            "source_evidence_hash": "evidence-hash",
            "source_evidence_last_changed_at": "2026-08-11T18:30:00+08:00",
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
                "matched_report_count": 3,
                "without_history_count": 1,
            },
            "report_metrics": {
                "schema_version": "quality-daily-report.v1",
                "as_of_date": "2026-08-12",
                "calculated_at": "2026-08-12T07:00:00+08:00",
                "history_coverage": "all_history",
                "match_basis": "part_prefix_9",
                "trend_policy": {
                    "window_days": 30,
                    "recent_start": "2026-07-14",
                    "recent_end": "2026-08-12",
                    "previous_start": "2026-06-14",
                    "previous_end": "2026-07-13",
                    "min_window_denominator": 5,
                    "min_combined_issue_count": 3,
                    "repeat_min_evidence_count": 2,
                    "increase_rule": "count_and_share_must_both_increase",
                    "zero_denominator_policy": "insufficient_data",
                    "small_sample_policy": "insufficient_data",
                    "window_anchor": "selected_plan_date",
                },
                "coverage": {
                    "plan_group_count": 2,
                    "distinct_prefix_count": 2,
                    "matched_report_count": 3,
                    "without_history_count": 1,
                    "latest_report_dt": "2026-07-29",
                    "model_names": ["DEMO-M4414", "DEMO-P3310"],
                    "part_nos": ["ACQ30776309", "ABJ76507601"],
                    "problem_type_count": 2,
                    "occurrence_location_count": 1,
                },
                "problem_types": [
                    {
                        "metric_key": "problem:abc123def456",
                        "canonical_key": "whitening",
                        "label": {"ko": "게이트 주변 백화", "zh": "浇口周边发白"},
                        "recorded_text": "게이트 주변 백화",
                        "classification_basis": "recorded_phenomenon_exact",
                        "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                        "evidence_count": 2,
                        "repeat_status": "repeated",
                        "latest_report_dt": "2026-07-29",
                        "all_history_denominator": 3,
                        "all_history_denominator_basis": "unique_matching_reports_in_current_plan_prefixes",
                        "all_history_share_pct": 66.7,
                        "trend": {
                            "status": "stable_or_decrease",
                            "reason": "count_or_share_not_increased",
                            "recent_count": 1,
                            "previous_count": 1,
                            "recent_denominator": 2,
                            "previous_denominator": 1,
                            "recent_share_pct": 50.0,
                            "previous_share_pct": 100.0,
                            "share_change_pp": -50.0,
                            "count_change": 0,
                        },
                        "impact_scope": {
                            "machine_names": ["850T-14"],
                            "model_names": ["DEMO-M4414"],
                            "part_nos": ["ACQ30776309"],
                            "part_prefixes": ["ACQ307763"],
                            "plan_group_count": 1,
                            "planned_quantity": 1800,
                        },
                    },
                    {
                        "metric_key": "problem:missing000000",
                        "canonical_key": "missing",
                        "label": {"ko": "유형 미분류", "zh": "类型未分类"},
                        "recorded_text": "",
                        "classification_basis": "recorded_phenomenon_exact",
                        "source_evidence_keys": ["ACQ307763:phenomenon:missing"],
                        "evidence_count": 1,
                        "repeat_status": "single",
                        "latest_report_dt": "2025-12-02",
                        "all_history_denominator": 3,
                        "all_history_denominator_basis": "unique_matching_reports_in_current_plan_prefixes",
                        "all_history_share_pct": 33.3,
                        "trend": {
                            "status": "insufficient_data",
                            "reason": "small_sample",
                            "recent_count": 0,
                            "previous_count": 0,
                            "recent_denominator": 2,
                            "previous_denominator": 1,
                            "recent_share_pct": 0.0,
                            "previous_share_pct": 0.0,
                            "share_change_pp": 0.0,
                            "count_change": 0,
                        },
                        "impact_scope": {
                            "machine_names": ["850T-14"],
                            "model_names": ["DEMO-M4414"],
                            "part_nos": ["ACQ30776309"],
                            "part_prefixes": ["ACQ307763"],
                            "plan_group_count": 1,
                            "planned_quantity": 1800,
                        },
                    },
                ],
                "occurrence_locations": [
                    {
                        "metric_key": "location:gate",
                        "label": {"ko": "게이트", "zh": "浇口"},
                        "classification_basis": "explicit_keyword_v1",
                        "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                        "evidence_count": 2,
                        "repeat_status": "repeated",
                        "latest_report_dt": "2026-07-29",
                        "all_history_denominator": 3,
                        "all_history_denominator_basis": "unique_matching_reports_in_current_plan_prefixes",
                        "all_history_share_pct": 66.7,
                        "trend": {
                            "status": "increase",
                            "reason": "count_and_share_increased",
                            "recent_count": 2,
                            "previous_count": 0,
                            "recent_denominator": 2,
                            "previous_denominator": 1,
                            "recent_share_pct": 100.0,
                            "previous_share_pct": 0.0,
                            "share_change_pp": 100.0,
                            "count_change": 2,
                        },
                        "impact_scope": {
                            "machine_names": ["850T-14"],
                            "model_names": ["DEMO-M4414"],
                            "part_nos": ["ACQ30776309"],
                            "part_prefixes": ["ACQ307763"],
                            "plan_group_count": 1,
                            "planned_quantity": 1800,
                        },
                    }
                ],
                "calculation_basis": {
                    "counts_are_backend_authoritative": True,
                    "report_ids_exposed": False,
                    "images_exposed": False,
                    "raw_disposition_exposed": False,
                    "current_defect_claim_allowed": False,
                    "root_cause_claim_allowed": False,
                    "problem_type_taxonomy": "server_canonical_alias_v1",
                    "unknown_problem_policy": "separate_unclassified_recorded_text_hash",
                    "metric_denominator_basis": "unique_matching_reports_in_current_plan_prefixes",
                    "location_rule": "explicit_recorded_keyword_else_unknown",
                    "location_memberships_may_overlap": True,
                    "trend_is_report_frequency_not_defect_rate": True,
                    "zero_reports_do_not_prove_zero_defects": True,
                },
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
                    "matching_report_count": 3,
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
                    "matching_report_count": 3,
                    "latest_report_dt": "2026-07-29",
                    "phenomena": [
                        {
                            "evidence_key": "ACQ307763:phenomenon:white",
                            "text": "게이트 주변 백화",
                            "count": 2,
                            "report_ids": ["Q-1", "Q-3"],
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
                        {
                            "report_id": "Q-3",
                            "report_dt": "2026-07-20",
                            "part_no": "ACQ30776309",
                            "model": "DEMO-M4414",
                            "judgement": "과거 판정",
                            "phenomenon": "게이트 주변 백화",
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
        "report": {
            "executive_summary": {
                "ko": "반복 기록과 보고 빈도 추세를 중심으로 교대 전 확인이 필요합니다.",
                "zh": "交接班前应重点确认重复记录与报告频次趋势。",
            },
            "repeated_issues": [
                {
                    "metric_key": "problem:abc123def456",
                    "source_evidence_keys": [
                        "ACQ307763:phenomenon:white",
                        "NOT-ALLOWED",
                    ],
                    "narrative": {
                        "ko": "반복 기록된 외관 현상을 우선 확인하세요.",
                        "zh": "请优先确认重复记录的外观现象。",
                    },
                },
                {
                    "metric_key": "problem:missing000000",
                    "source_evidence_keys": ["ACQ307763:phenomenon:missing"],
                    "narrative": {
                        "ko": "단일 기록을 반복 항목으로 잘못 선택했습니다.",
                        "zh": "错误地将单次记录选为重复项目。",
                    },
                },
                {
                    "metric_key": "invented:metric",
                    "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                    "narrative": {
                        "ko": "존재하지 않는 지표입니다.",
                        "zh": "这是不存在的指标。",
                    },
                },
            ],
            "accelerating_issues": [
                {
                    "metric_key": "location:gate",
                    "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                    "narrative": {
                        "ko": "보고 기록 빈도 증가 추세를 교대 전 확인하세요.",
                        "zh": "交接班前请确认报告记录频次上升趋势。",
                    },
                },
                {
                    "metric_key": "problem:abc123def456",
                    "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                    "narrative": {
                        "ko": "안정 추세를 증가 항목으로 잘못 선택했습니다.",
                        "zh": "错误地将稳定趋势选为上升项目。",
                    },
                },
            ],
            "affected_targets": [
                {
                    "source_key": "14|ACQ307763",
                    "source_evidence_keys": [
                        "ACQ307763:phenomenon:white",
                        "ACQ307763:phenomenon:missing",
                        "NOT-ALLOWED",
                    ],
                    "headline": {
                        "ko": "연결된 과거 외관 기록을 우선 확인하세요.",
                        "zh": "请优先确认关联的历史外观记录。",
                    },
                },
                {
                    "source_key": "invented|source",
                    "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                    "headline": {
                        "ko": "존재하지 않는 생산 대상입니다.",
                        "zh": "这是不存在的生产对象。",
                    },
                },
            ],
            "shift_checks": {
                "ko": ["교대 전 기록된 현상과 위치를 확인하세요."],
                "zh": ["交接班前请确认记录的现象与位置。"],
            },
            "caveats": {
                "ko": ["과거 이력만을 기준으로 정리했습니다."],
                "zh": ["仅依据历史记录整理。"],
            },
        },
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
            (lambda job: job["scope"].update(trigger="manual"), "Unsupported quality analysis trigger"),
            (lambda job: job["input_payload"].update(schema_version="unknown"), "unsupported schema_version"),
            (lambda job: job["input_payload"].update(language="ko"), "require bilingual"),
            (lambda job: job["input_payload"].update(source_plan_hash="changed"), "matching source_plan_hash"),
            (lambda job: job["input_payload"].update(source_evidence_hash="changed"), "matching source_evidence_hash"),
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
        self.assertEqual(payload["report_metrics"]["schema_version"], "quality-daily-report.v1")
        self.assertEqual(
            payload["report_metrics"]["occurrence_locations"][0]["trend"]["status"],
            "increase",
        )
        self.assertEqual(
            payload["report_metrics"]["problem_types"][0]["evidence_count"],
            2,
        )
        self.assertEqual(
            payload["report_metrics"]["problem_types"][0]["canonical_key"],
            "whitening",
        )
        self.assertEqual(
            payload["report_metrics"]["trend_policy"]["repeat_min_evidence_count"],
            2,
        )
        self.assertTrue(
            payload["report_metrics"]["calculation_basis"]
            ["trend_is_report_frequency_not_defect_rate"]
        )
        for group_name in ("problem_types", "occurrence_locations"):
            for metric in payload["report_metrics"][group_name]:
                self.assertNotIn("recorded_text", metric)
        self.assertEqual(payload["items"][0]["evidence_key"], "prefix:ACQ307763")
        self.assertEqual(payload["evidence_catalog"][0]["phenomena"][0]["count"], 2)
        self.assertEqual(
            payload["evidence_catalog"][0]["phenomena"][0]["evidence_key"],
            "ACQ307763:phenomenon:white",
        )
        self.assertEqual(payload["evidence_catalog"][0]["action_results"][0]["text"], "검토 완료")
        self.assertNotIn("Q-1", str(payload))
        self.assertNotIn("Q-3", str(payload))
        self.assertNotIn("report_refs", str(payload))
        self.assertEqual(
            grounding["evidence_catalog"][0]["phenomena"][0]["report_ids"],
            ["Q-1", "Q-3"],
        )
        self.assertEqual(
            grounding["evidence_catalog"][0]["report_refs"][0]["disposition"],
            "초품 외관 확인",
        )
        self.assertEqual(grounding["source_plan_hash"], "plan-hash")
        self.assertEqual(grounding["source_evidence_hash"], "evidence-hash")

    def test_deterministic_fallback_is_bilingual_and_marks_unknown_classification(self):
        result = handler.build_dummy_result(quality_job())

        self.assertTrue(result["summary"]["ko"])
        self.assertTrue(result["summary"]["zh"])
        self.assertEqual(result["attention_items"][0]["locations"][0]["label"], handler.UNKNOWN_LOCATION)
        self.assertEqual(result["attention_items"][0]["locations"][0]["count"], 3)
        self.assertEqual(
            result["attention_items"][0]["locations"][0]["source_evidence_keys"],
            ["ACQ307763:phenomenon:white", "ACQ307763:phenomenon:missing"],
        )
        self.assertEqual(len(result["attention_items"]), 1)
        self.assertIn("현재 불량 발생을 의미하지 않습니다", result["disclaimer"]["ko"])
        self.assertNotIn("현재 불량", result["summary"]["ko"])
        self.assertEqual(
            [row["metric_key"] for row in result["report"]["repeated_issues"]],
            ["problem:abc123def456", "location:gate"],
        )
        self.assertEqual(
            [row["metric_key"] for row in result["report"]["accelerating_issues"]],
            ["location:gate"],
        )
        self.assertIn("현재 상태를 뜻하지 않습니다", result["report"]["caveats"]["ko"][0])

    def test_normalizer_discards_unknown_keys_and_recomputes_counts_from_verified_evidence(self):
        job = quality_job()
        payload = handler.build_llm_payload(job)
        grounding = handler.build_grounding_payload(job)
        fallback = handler.build_dummy_result(job)
        candidate = valid_llm_result()
        candidate["source_plan_hash"] = "invented-plan-hash"
        candidate["source_evidence_hash"] = "invented-evidence-hash"

        result = handler.normalize_llm_result(
            candidate,
            fallback,
            "gemma-test",
            payload,
            grounding,
        )

        self.assertEqual([item["source_key"] for item in result["attention_items"]], ["14|ACQ307763"])
        item = result["attention_items"][0]
        self.assertEqual(item["problem_types"][0]["count"], 2)
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
        self.assertEqual(result["source_plan_hash"], "plan-hash")
        self.assertEqual(result["source_evidence_hash"], "evidence-hash")
        report = result["report"]
        self.assertEqual(report["executive_summary"], handler._REPORT_EXECUTIVE_SUMMARY)
        self.assertEqual(report["shift_checks"], handler._REPORT_SHIFT_CHECKS)
        self.assertEqual(
            [row["metric_key"] for row in report["repeated_issues"]],
            ["problem:abc123def456"],
        )
        self.assertEqual(
            report["repeated_issues"][0]["source_evidence_keys"],
            ["ACQ307763:phenomenon:white"],
        )
        self.assertEqual(
            [row["metric_key"] for row in report["accelerating_issues"]],
            ["location:gate"],
        )
        self.assertEqual(
            [row["source_key"] for row in report["affected_targets"]],
            ["14|ACQ307763"],
        )
        self.assertEqual(
            report["affected_targets"][0]["source_evidence_keys"],
            ["ACQ307763:phenomenon:white"],
        )
        self.assertNotIn("invented:metric", str(report))
        self.assertNotIn("invented|source", str(report))
        self.assertIn(
            "비교 자료가 충분하지 않은 추세는 해석하지 않습니다.",
            report["caveats"]["ko"],
        )

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
        self.assertEqual(sum(group["count"] for group in groups), 3)
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
        self.assertEqual(str(payload).count("게이트 주변 백화"), 2)

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
            ["Q-1", "Q-3"],
        )
        self.assertNotIn("Q-1", str(llm_payload))
        self.assertNotIn("Q-3", str(llm_payload))

    def test_valid_gemma_result_uses_one_bounded_call_per_history_group(self):
        class Gemma:
            def __init__(self):
                self.calls = []

            def structured_analysis(self, system_prompt, payload, **kwargs):
                self.calls.append((system_prompt, payload, kwargs))
                if system_prompt == handler.REPORT_SELECTOR_SYSTEM_PROMPT:
                    return {
                        "repeated_metric_keys": [
                            payload["repeated_candidates"][0]["metric_key"],
                        ],
                        "accelerating_metric_keys": [
                            payload["accelerating_candidates"][0]["metric_key"],
                        ],
                        "affected_targets": [{
                            "source_key": payload["affected_target_candidates"][0]["source_key"],
                            "source_evidence_keys": payload["affected_target_candidates"][0]
                            ["source_evidence_keys"],
                        }],
                    }
                return {
                    "source_key": payload["source_key"],
                    "problem_selections": [{
                        "metric_key": payload["problem_candidates"][0]["metric_key"],
                        "source_evidence_keys": payload["problem_candidates"][0]
                        ["source_evidence_keys"],
                    }],
                    "location_selections": [{
                        "metric_key": payload["location_candidates"][0]["metric_key"],
                        "source_evidence_keys": payload["location_candidates"][0]
                        ["source_evidence_keys"],
                    }],
                }

        gemma = Gemma()
        result, prompt_version = handle_job(
            quality_job(),
            use_llm=True,
            llm=gemma,
            model_name="gemma-test",
            fallback_to_deterministic=False,
        )

        self.assertEqual(len(gemma.calls), 2)
        self.assertEqual(prompt_version, handler.PROMPT_VERSION)
        self.assertEqual(
            gemma.calls[0][1]["required_output_schema"],
            handler.MODEL_CHUNK_OUTPUT_SCHEMA,
        )
        self.assertEqual(gemma.calls[0][2]["max_tokens"], handler.MODEL_CHUNK_MAX_TOKENS)
        self.assertNotIn("phenomena", gemma.calls[0][1])
        self.assertEqual(
            gemma.calls[1][1]["required_output_schema"],
            handler.REPORT_SELECTOR_OUTPUT_SCHEMA,
        )
        self.assertEqual(gemma.calls[1][2]["max_tokens"], handler.REPORT_SELECTOR_MAX_TOKENS)
        self.assertEqual(result["source"], "local_llm_rewrite")
        self.assertEqual(result["llm_attempts"], 1)
        self.assertEqual(result["llm_chunk_count"], 2)
        self.assertEqual(
            result["llm_chunk_basis"],
            "planned_target_keys_plus_report_key_selector",
        )
        self.assertEqual(
            result["report"]["accelerating_issues"][0]["metric_key"],
            "location:gate",
        )
        for _system_prompt, payload, _options in gemma.calls:
            self.assertNotIn("report_ids", str(payload))
            self.assertNotIn("report_refs", str(payload))
            self.assertNotIn("Q-1", str(payload))
            self.assertNotIn("narrative", str(payload))
        self.assertEqual(
            set(result),
            {
                "summary",
                "attention_items",
                "report",
                "source_plan_hash",
                "source_evidence_hash",
                "source_evidence_last_changed_at",
                "disclaimer",
                "generated_at",
                "model_name",
                "source",
                "llm_attempted",
                "llm_attempts",
                "llm_chunk_count",
                "llm_chunk_basis",
            },
        )

    def test_key_selector_discards_unknown_and_ineligible_report_selections(self):
        grounding = handler.build_grounding_payload(quality_job())
        selector_payload = handler._report_selector_payload(
            grounding,
            {
                "14|ACQ307763": {
                    "problem_metric_keys": ["problem:abc123def456"],
                    "location_metric_keys": ["location:gate"],
                }
            },
        )

        report = handler._report_from_key_selections(
            {
                "repeated_metric_keys": [
                    "location:gate",
                    "invented:metric",
                    "problem:missing000000",
                ],
                "accelerating_metric_keys": [
                    "location:gate",
                    "problem:abc123def456",
                ],
                "affected_targets": [
                    {
                        "source_key": "14|ACQ307763",
                        "source_evidence_keys": [
                            "ACQ307763:phenomenon:white",
                            "ACQ307763:phenomenon:missing",
                            "invented:evidence",
                        ],
                    },
                    {
                        "source_key": "invented|source",
                        "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                    },
                ],
            },
            grounding,
            selector_payload,
        )

        self.assertEqual(
            [row["metric_key"] for row in report["repeated_issues"]],
            ["location:gate"],
        )
        self.assertEqual(
            [row["metric_key"] for row in report["accelerating_issues"]],
            ["location:gate"],
        )
        self.assertEqual(
            report["affected_targets"][0]["source_evidence_keys"],
            ["ACQ307763:phenomenon:white"],
        )
        self.assertNotIn("invented", str(report))

    def test_model_chunk_normalizer_attaches_only_server_labels_and_keys(self):
        grounding = handler.build_grounding_payload(quality_job())
        metrics = grounding["report_metrics"]
        candidates = handler._metric_selection_candidates(
            metrics,
            "problem_types",
            {"ACQ307763:phenomenon:white"},
        )

        normalized = handler._normalize_metric_key_selections(
            [
                {
                    "metric_key": "problem:abc123def456",
                    "label": {"ko": "조작 라벨", "zh": "伪造标签"},
                    "count": 999,
                    "source_evidence_keys": [
                        "ACQ307763:phenomenon:white",
                        "invented:evidence",
                    ],
                },
                {
                    "metric_key": "invented:metric",
                    "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                },
            ],
            candidates,
            field_name="problem_selections",
        )

        self.assertEqual(normalized, [{
            "metric_key": "problem:abc123def456",
            "label": {"ko": "게이트 주변 백화", "zh": "浇口周边发白"},
            "source_evidence_keys": ["ACQ307763:phenomenon:white"],
        }])
        self.assertNotIn("count", normalized[0])

    def test_key_selectors_require_one_grounded_selection_when_candidates_exist(self):
        grounding = handler.build_grounding_payload(quality_job())
        metrics = grounding["report_metrics"]
        problem_candidates = handler._metric_selection_candidates(
            metrics,
            "problem_types",
            {"ACQ307763:phenomenon:white"},
        )
        with self.assertRaisesRegex(ValueError, "valid metric/evidence key pair"):
            handler._normalize_metric_key_selections(
                [],
                problem_candidates,
                field_name="problem_selections",
            )

        selector_payload = handler._report_selector_payload(grounding, {})
        with self.assertRaisesRegex(ValueError, "valid repeated_candidates key"):
            handler._report_from_key_selections(
                {
                    "repeated_metric_keys": [],
                    "accelerating_metric_keys": ["location:gate"],
                    "affected_targets": [{
                        "source_key": "14|ACQ307763",
                        "source_evidence_keys": ["ACQ307763:phenomenon:white"],
                    }],
                },
                grounding,
                selector_payload,
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

    def test_report_prose_rejects_numbers_current_claims_causes_rates_and_actions(self):
        unsafe_mutations = [
            lambda result: result["report"].update(executive_summary={
                "ko": "과거 기록 세 건을 확인해야 합니다.",
                "zh": "应确认历史记录。",
            }),
            lambda result: result["report"]["repeated_issues"][0].update(narrative={
                "ko": "현재 불량이 발생하고 있습니다.",
                "zh": "请确认历史记录。",
            }),
            lambda result: result["report"]["accelerating_issues"][0].update(narrative={
                "ko": "금형 문제 가능성을 확인하세요.",
                "zh": "请确认报告记录。",
            }),
            lambda result: result["report"]["affected_targets"][0].update(headline={
                "ko": "과거 기록을 확인하세요.",
                "zh": "可能由模具导致，需要确认。",
            }),
            lambda result: result["report"].update(shift_checks={
                "ko": ["온도를 조정하고 확인하세요."],
                "zh": ["请确认历史记录。"],
            }),
            lambda result: result["report"].update(caveats={
                "ko": ["과거 불량률을 참고했습니다."],
                "zh": ["仅依据历史记录。"],
            }),
        ]
        for mutate in unsafe_mutations:
            candidate = copy.deepcopy(valid_llm_result())
            mutate(candidate)
            with self.subTest(candidate=candidate["report"]), self.assertRaisesRegex(
                ValueError,
                "number|current-defect|root-cause|defect-rate|corrective action",
            ):
                handler.normalize_llm_result(
                    candidate,
                    handler.build_dummy_result(quality_job()),
                    "gemma-test",
                    handler.build_llm_payload(quality_job()),
                    handler.build_grounding_payload(quality_job()),
                )

    def test_missing_structured_report_falls_back_deterministically(self):
        class MissingReportGemma:
            def structured_analysis(self, _system_prompt, _payload, **_kwargs):
                result = valid_llm_result()
                result.pop("report")
                return result

        result, _ = handle_job(
            quality_job(),
            use_llm=True,
            llm=MissingReportGemma(),
            model_name="gemma-test",
            fallback_to_deterministic=True,
        )

        self.assertTrue(result["llm_fallback"])
        self.assertEqual(result["llm_fallback_code"], "invalid_response")
        self.assertEqual(result["source"], "local_llm_guarded_fallback")
        self.assertTrue(result["report"]["executive_summary"]["ko"])
        self.assertTrue(result["report"]["executive_summary"]["zh"])

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
        self.assertEqual(result["source_plan_hash"], "plan-hash")
        self.assertEqual(result["source_evidence_hash"], "evidence-hash")


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

        def structured_analysis(self, system_prompt, payload, **_kwargs):
            self.calls += 1
            if system_prompt == handler.REPORT_SELECTOR_SYSTEM_PROMPT:
                return {
                    "repeated_metric_keys": [
                        payload["repeated_candidates"][0]["metric_key"],
                    ],
                    "accelerating_metric_keys": [
                        payload["accelerating_candidates"][0]["metric_key"],
                    ],
                    "affected_targets": [{
                        "source_key": payload["affected_target_candidates"][0]["source_key"],
                        "source_evidence_keys": payload["affected_target_candidates"][0]
                        ["source_evidence_keys"],
                    }],
                }
            return {
                "source_key": payload["source_key"],
                "problem_selections": [{
                    "metric_key": payload["problem_candidates"][0]["metric_key"],
                    "source_evidence_keys": payload["problem_candidates"][0]
                    ["source_evidence_keys"],
                }],
                "location_selections": [{
                    "metric_key": payload["location_candidates"][0]["metric_key"],
                    "source_evidence_keys": payload["location_candidates"][0]
                    ["source_evidence_keys"],
                }],
            }

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
        self.assertEqual(gemma.calls, 2)
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
