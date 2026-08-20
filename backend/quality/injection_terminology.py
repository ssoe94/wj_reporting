"""Versioned injection-molding terminology used by quality analytics.

The recorded ``QualityReport.phenomenon`` text remains untouched for audit and
search.  This dictionary is only used to classify that raw text and to provide
consistent Korean/Chinese display labels for deterministic analysis.
"""

from __future__ import annotations

from typing import Final, TypeAlias


LocalizedLabel: TypeAlias = dict[str, str]
TerminologyRule: TypeAlias = tuple[str, LocalizedLabel, tuple[str, ...]]


INJECTION_TERMINOLOGY_VERSION: Final = "injection_industry_terms_v5"

# Keep Chinese public labels aligned with the terms already used to normalize
# operator-entered phenomena in the existing quality-defect report.  These are
# source terms, not translations of the Korean display labels.
DEFECT_REPORT_ZH_TERMS: Final[dict[str, str]] = {
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
}


# ``色差`` is a dimensional colour mismatch, not evidence of a black speck.
# Colour contamination and black specks remain one management group at the
# user's request, while these observed terms preserve what the report actually
# said so cards and Qwen-backed summaries never imply an absent subtype.
COLOR_BLACK_MATERIAL_OBSERVED_TERMS: Final[tuple[TerminologyRule, ...]] = (
    (
        "mixed_color",
        {"ko": "색상 혼입", "zh": DEFECT_REPORT_ZH_TERMS["mixed_color"]},
        (
            "夹色", "夾色", "混色", "杂色", "雜色",
            "이색", "색상혼입", "혼색", "mixedcolor",
        ),
    ),
    (
        "black_dot",
        {"ko": "흑점", "zh": DEFECT_REPORT_ZH_TERMS["black_dot"]},
        (
            "黑点", "黑點", "黑斑", "흑점", "검은점", "blackspot",
        ),
    ),
)

GAS_MARK_WHITENING_OBSERVED_TERMS: Final[tuple[TerminologyRule, ...]] = (
    (
        "air_mark",
        {"ko": "가스 마크", "zh": DEFECT_REPORT_ZH_TERMS["air_mark"]},
        (
            "气印", "氣印", "气纹", "氣紋",
            "가스자국", "가스마크", "gasmark",
        ),
    ),
    (
        "whitening",
        {
            "ko": "백화·백색 자국",
            "zh": (
                f'{DEFECT_REPORT_ZH_TERMS["whitening"]}·'
                f'{DEFECT_REPORT_ZH_TERMS["white_mark"]}'
            ),
        },
        (
            "白印", "白化", "顶白", "頂白", "发白", "發白", "拉白",
            "백화", "백색자국", "흰자국", "whitening",
        ),
    ),
)

INJECTION_DEFECT_OBSERVED_TERMS: Final[
    dict[str, tuple[TerminologyRule, ...]]
] = {
    "color_black_material": COLOR_BLACK_MATERIAL_OBSERVED_TERMS,
    "gas_mark_whitening": GAS_MARK_WHITENING_OBSERVED_TERMS,
}

UNKNOWN_PROBLEM_LABEL: Final[LocalizedLabel] = {
    "ko": "현상 미입력",
    "zh": "未填写现象",
}
UNKNOWN_LOCATION_LABEL: Final[LocalizedLabel] = {
    "ko": "위치 미확인",
    "zh": "位置未确认",
}
UNCLASSIFIED_PROBLEM_LABEL: Final[LocalizedLabel] = {
    "ko": "유형 미분류",
    "zh": "类型未分类",
}


# One canonical key may intentionally group synonyms or closely related source
# descriptions.  Labels use terms commonly seen on Korean injection-molding
# shop floors while retaining a plain-language clarification where useful.
INJECTION_DEFECT_TERMS: Final[tuple[TerminologyRule, ...]] = (
    (
        "contamination",
        {"ko": "오염·이물", "zh": DEFECT_REPORT_ZH_TERMS["contamination"]},
        (
            "脏污", "油污", "油渍", "油点", "灰尘", "污渍", "擦拭印",
            "异物", "異物",
            "오염", "이물", "기름때", "얼룩", "먼지", "contamination", "stain",
        ),
    ),
    (
        "white_powder_residue",
        {
            "ko": "백색 분말 잔류",
            "zh": DEFECT_REPORT_ZH_TERMS["white_powder_residue"],
        },
        ("白色粉末", "粉末残留", "백색분말", "분말잔류", "powderresidue"),
    ),
    (
        "burr_flash",
        {"ko": "버·플래시", "zh": DEFECT_REPORT_ZH_TERMS["burr_flash"]},
        (
            "毛刺", "毛边", "毛邊", "飞边", "飛邊", "披锋", "披鋒",
            "버", "버발생", "버잔류", "잔버", "게이트버", "미세버",
            "바리", "플래시", "burr", "flash",
        ),
    ),
    (
        "lint_residue",
        {"ko": "섬유·보풀 잔류", "zh": DEFECT_REPORT_ZH_TERMS["lint_residue"]},
        ("毛絮", "보풀", "섬유잔류", "lint"),
    ),
    (
        "scorch_mark",
        {"ko": "번 마크(탄화)", "zh": DEFECT_REPORT_ZH_TERMS["scorch_mark"]},
        (
            "糊斑", "烧焦", "燒焦", "烧痕", "燒痕", "焦痕",
            "탄화", "그을음", "번마크", "burnmark", "scorch",
        ),
    ),
    (
        "gas_mark_whitening",
        {
            "ko": "가스 마크·백화",
            "zh": (
                f'{DEFECT_REPORT_ZH_TERMS["air_mark"]}·'
                f'{DEFECT_REPORT_ZH_TERMS["whitening"]}'
            ),
        },
        tuple(
            alias
            for _key, _label, aliases in GAS_MARK_WHITENING_OBSERVED_TERMS
            for alias in aliases
        ),
    ),
    (
        "sink_mark",
        {"ko": "싱크 마크(수축)", "zh": DEFECT_REPORT_ZH_TERMS["sink_mark"]},
        (
            "缩印", "縮印", "缩影", "縮影", "缩水", "縮水", "缩痕", "縮痕",
            "缩瘪", "縮癟",
            "수축", "싱크", "싱크마크", "sinkmark",
        ),
    ),
    (
        "short_shot",
        {"ko": "미성형(쇼트 샷)", "zh": DEFECT_REPORT_ZH_TERMS["short_shot"]},
        (
            "缺胶", "缺膠", "缺料", "短射", "充填不足", "浇不足", "澆不足",
            "미성형", "미충전", "충진부족", "쇼트", "숏샷", "shortshot",
        ),
    ),
    (
        "gloss",
        {"ko": "광택 불량", "zh": DEFECT_REPORT_ZH_TERMS["gloss"]},
        (
            "发亮", "發亮", "高光", "光泽不良", "光澤不良",
            "광택", "번들거림", "gloss",
        ),
    ),
    (
        "scratch_damage",
        {
            "ko": "스크래치·찍힘",
            "zh": (
                f'{DEFECT_REPORT_ZH_TERMS["scratch"]}·'
                f'{DEFECT_REPORT_ZH_TERMS["impact_damage"]}'
            ),
        },
        (
            "拉伤", "拉傷", "划伤", "劃傷", "擦伤", "擦傷", "削伤", "削傷",
            "磕伤", "磕傷", "碰伤", "碰傷", "夹伤", "夾傷", "损伤", "損傷",
            "压痕", "壓痕",
            "스크래치", "긁힘", "찍힘", "압흔", "scratch", "damage",
        ),
    ),
    (
        "color_difference",
        {
            "ko": "색차",
            "zh": DEFECT_REPORT_ZH_TERMS["color_difference"],
        },
        (
            "表面色差", "色差", "颜色差异", "顏色差異",
            "색차", "컬러차이", "변색", "colordifference",
        ),
    ),
    (
        "color_black_material",
        {
            "ko": "색상 혼입·흑점",
            "zh": (
                f'{DEFECT_REPORT_ZH_TERMS["mixed_color"]}·'
                f'{DEFECT_REPORT_ZH_TERMS["black_dot"]}'
            ),
        },
        tuple(
            alias
            for _key, _label, aliases in COLOR_BLACK_MATERIAL_OBSERVED_TERMS
            for alias in aliases
        ),
    ),
    (
        "silver_streak",
        {"ko": "은선", "zh": DEFECT_REPORT_ZH_TERMS["silver_streak"]},
        (
            "料花", "银纹", "銀紋", "银丝", "銀絲",
            "은선", "은줄", "실버", "실버스트릭", "silverstreak", "splay",
        ),
    ),
    (
        "label_abnormality",
        {"ko": "라벨 불량", "zh": DEFECT_REPORT_ZH_TERMS["label_abnormality"]},
        (
            "标签", "標籤", "标签不良", "標籤不良", "重码", "重碼", "漏贴", "漏貼",
            "라벨", "라벨불량", "중복코드", "누락부착", "label",
        ),
    ),
    (
        "packaging_abnormality",
        {
            "ko": "포장 불량",
            "zh": DEFECT_REPORT_ZH_TERMS["packaging_abnormality"],
        },
        (
            "包装", "包裝", "包装不良", "包裝不良", "包裹", "水渍", "水漬",
            "포장", "포장불량", "수분자국", "packaging",
        ),
    ),
    (
        "deformation",
        {"ko": "휨·변형", "zh": DEFECT_REPORT_ZH_TERMS["deformation"]},
        (
            "变形", "變形", "翘曲", "翹曲", "변형", "휨", "뒤틀림",
            "deformation", "warpage",
        ),
    ),
    (
        "crack",
        {"ko": "크랙(균열)", "zh": DEFECT_REPORT_ZH_TERMS["crack"]},
        (
            "裂纹", "裂紋", "开裂", "開裂", "破裂",
            "균열", "크랙", "깨짐", "crack",
        ),
    ),
    (
        "flow_weld_mark",
        {
            "ko": "플로 마크·웰드 라인",
            "zh": (
                f'{DEFECT_REPORT_ZH_TERMS["flow_mark"]}·'
                f'{DEFECT_REPORT_ZH_TERMS["weld_line"]}'
            ),
        },
        (
            "流痕", "流纹", "流紋", "熔接线", "熔接線", "结合线", "結合線",
            "웰드", "웰드라인", "플로마크", "흐름자국", "flowmark", "weldline",
        ),
    ),
)


INJECTION_LOCATION_TERMS: Final[tuple[TerminologyRule, ...]] = (
    (
        "gate",
        {"ko": "게이트부", "zh": "浇口部"},
        ("게이트", "gate", "浇口", "澆口", "进胶", "進膠"),
    ),
    (
        "hole",
        {"ko": "홀부", "zh": "孔位"},
        ("홀", "구멍", "hole", "孔位", "孔部", "孔边", "孔邊"),
    ),
    (
        "edge",
        {"ko": "모서리·테두리", "zh": "边缘"},
        ("모서리", "테두리", "가장자리", "에지", "edge", "边缘", "邊緣", "边角", "邊角"),
    ),
    (
        "corner",
        {"ko": "코너부", "zh": "角部"},
        ("코너", "corner", "角部", "角位", "角落"),
    ),
    (
        "surface",
        {"ko": "표면", "zh": "表面"},
        ("표면", "surface", "表面"),
    ),
    (
        "inside",
        {"ko": "내측", "zh": "内侧"},
        ("내측", "안쪽", "inner", "内侧", "內側", "内部", "內部"),
    ),
    (
        "outside",
        {"ko": "외측", "zh": "外侧"},
        ("외측", "바깥", "outer", "外侧", "外側"),
    ),
    (
        "top",
        {"ko": "상단", "zh": "顶部"},
        ("상단", "윗면", "top", "顶部", "頂部", "上部"),
    ),
    (
        "bottom",
        {"ko": "하단", "zh": "底部"},
        ("하단", "아랫면", "bottom", "底部", "下部"),
    ),
    (
        "side",
        {"ko": "측면", "zh": "侧面"},
        ("측면", "side", "侧面", "側面"),
    ),
    (
        "boss",
        {"ko": "보스부", "zh": "柱位"},
        ("보스", "boss", "柱位", "螺丝柱", "螺絲柱"),
    ),
    (
        "rib",
        {"ko": "리브부", "zh": "筋位"},
        ("리브", "rib", "筋位"),
    ),
    (
        "parting_line",
        {"ko": "파팅 라인", "zh": "分型线"},
        ("파팅", "parting", "分型线", "分型線"),
    ),
)
