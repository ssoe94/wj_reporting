from django.test import SimpleTestCase

from quality.daily_attention import (
    _canonical_problem_types,
    _explicit_occurrence_locations,
)
from quality.injection_terminology import (
    DEFECT_REPORT_ZH_TERMS,
    INJECTION_DEFECT_TERMS,
    INJECTION_LOCATION_TERMS,
    INJECTION_TERMINOLOGY_VERSION,
)


class InjectionTerminologyTests(SimpleTestCase):
    def test_dictionary_has_unique_keys_and_bilingual_display_labels(self):
        for rules in (INJECTION_DEFECT_TERMS, INJECTION_LOCATION_TERMS):
            keys = [key for key, _label, _aliases in rules]
            self.assertEqual(len(keys), len(set(keys)))
            for key, label, aliases in rules:
                self.assertTrue(key)
                self.assertTrue(label["ko"].strip())
                self.assertTrue(label["zh"].strip())
                self.assertTrue(aliases)

        self.assertEqual(INJECTION_TERMINOLOGY_VERSION, "injection_industry_terms_v6")

    def test_dictionary_uses_injection_industry_terms_for_public_labels(self):
        labels = {
            key: label
            for key, label, _aliases in INJECTION_DEFECT_TERMS
        }
        locations = {
            key: label
            for key, label, _aliases in INJECTION_LOCATION_TERMS
        }

        self.assertEqual(labels["burr_flash"]["ko"], "버·플래시")
        self.assertEqual(labels["sink_mark"]["ko"], "싱크 마크(수축)")
        self.assertEqual(labels["short_shot"]["ko"], "미성형(쇼트 샷)")
        self.assertEqual(labels["air_mark"]["ko"], "가스 마크")
        self.assertEqual(labels["whitening"]["ko"], "백화·백색 자국")
        self.assertEqual(labels["color_difference"]["ko"], "색차")
        self.assertEqual(labels["color_black_material"]["ko"], "색상 혼입·흑점")
        self.assertEqual(labels["silver_streak"]["ko"], "은선")
        self.assertEqual(labels["label_abnormality"]["ko"], "라벨 불량")
        self.assertEqual(labels["flow_weld_mark"]["ko"], "플로 마크·웰드 라인")
        self.assertEqual(locations["edge"]["ko"], "모서리·테두리")

    def test_chinese_labels_reuse_existing_defect_report_terms(self):
        labels = {
            key: label
            for key, label, _aliases in INJECTION_DEFECT_TERMS
        }

        self.assertEqual(labels["contamination"]["zh"], "脏污")
        self.assertEqual(labels["white_powder_residue"]["zh"], "白色粉末残留")
        self.assertEqual(labels["burr_flash"]["zh"], "毛刺未去除")
        self.assertEqual(labels["lint_residue"]["zh"], "毛絮残留")
        self.assertEqual(labels["scorch_mark"]["zh"], "糊斑")
        self.assertEqual(labels["air_mark"]["zh"], "气印")
        self.assertEqual(labels["whitening"]["zh"], "发白·白印")
        self.assertEqual(labels["sink_mark"]["zh"], "缩印")
        self.assertEqual(labels["short_shot"]["zh"], "缺胶")
        self.assertEqual(labels["gloss"]["zh"], "发亮")
        self.assertEqual(labels["scratch_damage"]["zh"], "擦伤·碰伤")
        self.assertEqual(labels["color_difference"]["zh"], "色差")
        self.assertEqual(labels["color_black_material"]["zh"], "夹色·黑点")
        self.assertEqual(labels["silver_streak"]["zh"], "料花")
        self.assertEqual(labels["label_abnormality"]["zh"], "标签异常")
        self.assertEqual(labels["packaging_abnormality"]["zh"], "包装异常")
        self.assertEqual(labels["deformation"]["zh"], "变形")
        self.assertEqual(labels["crack"]["zh"], "裂纹")
        self.assertEqual(labels["flow_weld_mark"]["zh"], "流痕·熔接线")
        self.assertEqual(
            DEFECT_REPORT_ZH_TERMS,
            {
                "contamination": "脏污",
                "white_powder_residue": "白色粉末残留",
                "burr_flash": "毛刺未去除",
                "lint_residue": "毛絮残留",
                "scorch_mark": "糊斑",
                "scratch": "擦伤",
                "impact_damage": "碰伤",
                "color_difference": "色差",
                "black_dot": "黑点",
                "air_mark": "气印",
                "white_mark": "白印",
                "deformation": "变形",
                "short_shot": "缺胶",
                "silver_streak": "料花",
                "sink_mark": "缩印",
                "whitening": "发白",
                "gloss": "发亮",
                "mixed_color": "夹色",
                "label_abnormality": "标签异常",
                "packaging_abnormality": "包装异常",
                "crack": "裂纹",
                "flow_mark": "流痕",
                "weld_line": "熔接线",
            },
        )

    def test_legacy_defect_report_terms_are_not_left_unclassified(self):
        cases = (
            ("侧面发白", "whitening"),
            ("顶部拉白", "whitening"),
            ("表面气印", "air_mark"),
            ("底部缩瘪", "sink_mark"),
            ("浇不足", "short_shot"),
            ("边角碰伤", "scratch_damage"),
            ("表面异物", "contamination"),
            ("表面色差", "color_difference"),
        )
        for raw, expected_key in cases:
            with self.subTest(raw=raw):
                self.assertEqual(
                    [row["key"] for row in _canonical_problem_types(raw)],
                    [expected_key],
                )

    def test_explicit_chinese_negatives_do_not_create_false_defects(self):
        for raw in (
            "无异物", "无气印", "不发白", "无碰伤", "未发现黑点",
            "未发现明显色差",
        ):
            with self.subTest(raw=raw):
                self.assertEqual(
                    [row["key"] for row in _canonical_problem_types(raw)],
                    ["unclassified"],
                )

        self.assertEqual(
            [row["key"] for row in _canonical_problem_types("毛刺未去除")],
            ["burr_flash"],
        )

    def test_aliases_are_classified_with_dictionary_labels(self):
        cases = (
            ("分型面飞边", "burr_flash", "버·플래시"),
            ("원료 수분으로 은줄 발생", "silver_streak", "은선"),
            ("제품 표면 은선", "silver_streak", "은선"),
            ("标签重码", "label_abnormality", "라벨 불량"),
            ("웰드라인", "flow_weld_mark", "플로 마크·웰드 라인"),
        )
        for raw, expected_key, expected_label in cases:
            with self.subTest(raw=raw):
                classified = _canonical_problem_types(raw)
                self.assertEqual(classified[0]["key"], expected_key)
                self.assertEqual(classified[0]["label"]["ko"], expected_label)
                self.assertEqual(
                    classified[0]["classification_basis"],
                    "canonical_alias_v1",
                )

        edge = _explicit_occurrence_locations("제품 모서리 흑점")
        self.assertEqual(edge, [{
            "key": "edge",
            "label": {"ko": "모서리·테두리", "zh": "边缘"},
        }])

    def test_color_difference_black_spot_and_silver_streak_are_separate_categories(self):
        classified = _canonical_problem_types("색차와 색상 혼입, 흑점, 은줄 동시 발생")
        self.assertEqual(
            [row["key"] for row in classified],
            ["color_difference", "color_black_material", "silver_streak"],
        )
        self.assertEqual(
            [row["label"]["ko"] for row in classified],
            ["색차", "색상 혼입·흑점", "은선"],
        )
        self.assertEqual(
            [row["key"] for row in classified[1]["observed_terms"]],
            ["mixed_color", "black_dot"],
        )

    def test_color_management_group_preserves_the_observed_leaf(self):
        mixed = _canonical_problem_types("표면 夹色")
        black_dot = _canonical_problem_types("모서리 黑点")

        self.assertEqual([row["key"] for row in mixed], ["color_black_material"])
        self.assertEqual(
            [row["key"] for row in mixed[0]["observed_terms"]],
            ["mixed_color"],
        )
        self.assertEqual([row["key"] for row in black_dot], ["color_black_material"])
        self.assertEqual(
            [row["key"] for row in black_dot[0]["observed_terms"]],
            ["black_dot"],
        )

    def test_white_mark_and_air_mark_are_independent_problem_types(self):
        classified = _canonical_problem_types(
            "1.侧面白印擦不掉\n2.表面气印\n3.表面色差需要调整"
        )

        self.assertEqual(
            [row["key"] for row in classified],
            ["air_mark", "whitening", "color_difference"],
        )
        self.assertEqual(
            [row["label"]["zh"] for row in classified],
            ["气印", "发白·白印", "色差"],
        )
        self.assertTrue(all("observed_terms" not in row for row in classified))

    def test_short_burr_alias_does_not_match_silver_or_cover(self):
        self.assertEqual(
            [row["key"] for row in _canonical_problem_types("실버 스트릭")],
            ["silver_streak"],
        )
        self.assertEqual(
            [row["key"] for row in _canonical_problem_types("커버 스크래치")],
            ["scratch_damage"],
        )
        self.assertEqual(
            [row["key"] for row in _canonical_problem_types("버 발생")],
            ["burr_flash"],
        )
        for raw in ("버발생", "게이트버", "미세버"):
            with self.subTest(raw=raw):
                self.assertEqual(
                    [row["key"] for row in _canonical_problem_types(raw)],
                    ["burr_flash"],
                )
