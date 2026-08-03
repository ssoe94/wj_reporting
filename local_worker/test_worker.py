import unittest

try:
    from .worker import normalize_result
except ImportError:
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


if __name__ == "__main__":
    unittest.main()
