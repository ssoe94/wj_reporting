import unittest

try:
    from .job_handlers import production_machine_analysis
    from .worker import normalize_result
except ImportError:
    from job_handlers import production_machine_analysis
    from worker import normalize_result


class NormalizeResultTests(unittest.TestCase):
    def setUp(self):
        self.fallback = {
            "title": "Deterministic analysis",
            "severity": "warning",
            "summary": "계획 100개 대비 현재 50개입니다.",
            "top_issues": [{"label": "850T-1", "evidence": ["Gap: -20"]}],
            "facts": {"planned_qty": 100, "actual_qty": 50},
            "used_data": [{"name": "ProductionPlan", "row_count": 1}],
            "calculation_basis": ["backend-calculated"],
        }

    def test_llm_can_rewrite_prose_but_not_authoritative_fields(self):
        result = normalize_result(
            {
                "title": "생산 분석",
                "summary": "현재 50개로 계획 100개를 확인해야 합니다.",
                "severity": "normal",
                "top_issues": [{"label": "fabricated"}],
            },
            self.fallback,
            "qwen-test",
            self.fallback,
        )

        self.assertEqual(result["summary"], "현재 50개로 계획 100개를 확인해야 합니다.")
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


if __name__ == "__main__":
    unittest.main()
