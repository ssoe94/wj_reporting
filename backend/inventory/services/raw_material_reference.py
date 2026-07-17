"""Workbook-backed raw-material manufacturer, resin-family, and color reference.

Source: ``材料型号+色号.xlsx`` supplied by WJ.  The source workbook has no
separate color-code/name distinction, so ``color`` preserves its COLOR value
verbatim.  Matching uses the full raw-material model after conservative Unicode
and whitespace normalization; grade fragments are intentionally not guessed.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any


RAW_MATERIAL_REFERENCE_ROWS = (
    ("LGC", "ABS HF350U 18388", "White", "abs"),
    ("LGC", "ABS HF350U 0A736", "White", "abs"),
    ("利佳", "ABS HA641 B9209", "White", "abs"),
    ("会通", "ABS 3070H 011178", "White", "abs"),
    ("利佳", "ABS HA641 B8814", "Gray", "abs"),
    ("LGC", "MABS LD950 08287", "Millk White", "abs"),
    ("LGC", "MABS XG569C 93256", "Black", "abs"),
    ("LGC", "ABS HF350U 92751", "Black", "abs"),
    ("利佳", "ABS HA641 94362", "Black", "abs"),
    ("会通", "ABS 3070H 911368", "Black", "abs"),
    ("利佳", "ABS RH685 B0818", "Black", "abs"),
    ("利佳", "ABS HA641 B9246", "White", "abs"),
    ("利佳", "ABS HA641 8T075", "Gray", "abs"),
    ("LGC", "ABS MRC571A3 8T075", "Gray", "abs"),
    ("LGC", "ABS MRC571A3 8T187", "Purple Gray", "abs"),
    ("利佳", "ABS HA641 B8826", "Purple Gray", "abs"),
    ("LGC", "ABS HP171 8V804", "Purple Gray", "abs"),
    ("LGC", "ABS MRC571A3 92751", "Black", "abs"),
    ("利佳", "ABS HA641 8Q498", "Gray", "abs"),
    ("利佳", "ABS HA641 8Q684", "Gray", "abs"),
    ("LGC", "MABS XG569C 93836", "Violet", "abs"),
    ("LGC", "MABS XG571G 94362", "Black", "abs"),
    ("LGC", "MABS XG571G 8Q498", "Gray", "abs"),
    ("LGC", "MABS XG571G 8Q684-B", "Gray", "abs"),
    ("利佳", "HIPS AH561 9001", "Black", "hips"),
    ("利佳", "HIPS AH561 H9209", "White", "hips"),
    ("金发", "HIPS-5197 KF956（XZ）", "Black", "hips"),
    ("LGC", "PC GP1000M-WK21", "Millk White", "pc"),
    ("LGC", "YGP1000L E5899G", "Dark Gray Transparency", "pc"),
    ("LGC", "PC1201-22-W0990TG", "Transparent", "pc"),
    ("金发", "PC JH820-M10 C9WT-S0050", "Millk White", "pc"),
    ("LG甬兴", "YGP2300 KA02-LGY", "Black", "pc"),
    ("利佳", "PP", "NC", "pp"),
    ("三养", "PP TRILEN9500G40 9377A", "Umber Brown", "pp"),
    ("乐天", "PP-GF40 LGK-1400M（HB）QK2353", "Rocky Black", "pp"),
    ("乐天", "PP-GF40 LGK-1400M（HB）QK2517", "Charcoal Black", "pp"),
    ("利佳", "PCABS HF989 K0455", "Black", "pc_abs"),
    ("会通", "PCABS AIdIoy CA202 BK00834", "Black", "pc_abs"),
    ("利佳", "PCABS HF989 W1561", "White", "pc_abs"),
    ("利佳", "PCABS HF989 K2229", "Purple Gray", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFC K2229", "Purple Gray", "pc_abs"),
    ("会通", "PCABS AIdIoy CA202 H30562", "Purple Gray", "pc_abs"),
    ("利佳", "PCABS HF989 W4506", "White", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFC W4506", "White", "pc_abs"),
    ("利佳", "PCABS HF989 W3831", "White", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFC W3831", "White", "pc_abs"),
    ("LG甬兴", "PCABS GN5000SFA W1561", "White", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFW E5157", "Gray", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFW E5158", "Gray", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFW I0851", "White", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFW W1433", "White", "pc_abs"),
    ("LG甬兴", "PCABS GN5001RFW E3247", "Gray", "pc_abs"),
    ("利佳", "PCABS HF989 CA8838", "Black", "pc_abs"),
    ("三星", "PCABS SRA1000F BR5009", "Umber Brown", "pc_abs"),
    ("三星", "PCABS SRA1000F GR8158", "Essence Graphite", "pc_abs"),
    ("LG甬兴", "ABS HI-121H", "NP", "abs"),
    ("欣阳/海世达", "ABS 粉碎粒子(E57D)", "NP", "abs"),
    ("欣阳/海世达", "ABS 粉碎粒子(E101)", "NP", "abs"),
    ("LGC", "ABS XR474 9001", "Black", "abs"),
    ("LG甬兴", "LUPOX XGP2300G KA02Y（PBT)", "Black", "pbt"),
    ("LG甬兴", "PCABS GP5206FC BE86", "Blue", "pc_abs"),
    ("LG甬兴", "PCABS GP5206FC GK25", "Yellow", "pc_abs"),
    ("利佳", "PCABS+20GF GF974 CA5118", "Yellow", "pc_abs"),
    ("利佳", "PCABS+10GF GF982 CA0853", "Black", "pc_abs"),
    ("基星/海世达", "PCABS+GF20", "杂色", "pc_abs"),
    ("LG甬兴", "PCABS GN5101F K0265", "Black", "pc_abs"),
    ("泰英", "PCABS RK9120GR VO", "Gray", "pc_abs"),
    ("", "PCABS ICS 0301FR", "Gray", "pc_abs"),
    ("金发", "PP-KF07 HSP2BK-W0110", "Black", "pp"),
    ("中宝", "PPAPIT30BK01", "Black", "pp"),
    ("索博特", "塑可丽 ABS-ME KS1040657", "Silver Gray", "abs"),
    ("索博特", "塑可丽 ABS-ME KS8040102", "Purple", "abs"),
    ("索博特", "塑可丽 ABS-ME KS5040238", "Blue", "abs"),
)


def _reference_key(value: Any) -> str:
    normalized = unicodedata.normalize("NFKC", "" if value is None else str(value))
    normalized = normalized.translate(
        str.maketrans({"‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-"})
    )
    normalized = re.sub(
        r"\bPC(?:\s*[-/+]\s*|\s+)ABS\b",
        "PCABS",
        normalized,
        flags=re.I,
    )
    # Preserve the workbook spelling in responses but match the known typo to
    # the corrected MES spelling as one conservative full-model alias.
    normalized = re.sub(r"\bAIdIoy\b", "Alloy", normalized, flags=re.I)
    normalized = re.sub(r"\s*([()/+\-])\s*", r"\1", normalized)
    return re.sub(r"\s+", " ", normalized).strip().casefold()


_REFERENCE_BY_MODEL = {
    _reference_key(model): {
        "manufacturer": manufacturer,
        "material_model": model,
        "color": color,
        "family": family,
    }
    for manufacturer, model, color, family in RAW_MATERIAL_REFERENCE_ROWS
}

if len(_REFERENCE_BY_MODEL) != len(RAW_MATERIAL_REFERENCE_ROWS):
    raise RuntimeError("Raw-material reference contains normalized duplicate models.")


def _without_trailing_parenthetical(value: str) -> str:
    return re.sub(r"\([^()]*\)$", "", value).strip()


_PARENTHETICAL_ALIAS_CANDIDATES: dict[str, list[dict[str, str]]] = {}
for model_key, model_reference in _REFERENCE_BY_MODEL.items():
    base_key = _without_trailing_parenthetical(model_key)
    if base_key != model_key:
        _PARENTHETICAL_ALIAS_CANDIDATES.setdefault(base_key, []).append(
            model_reference
        )
_UNIQUE_PARENTHETICAL_ALIASES = {
    key: references[0]
    for key, references in _PARENTHETICAL_ALIAS_CANDIDATES.items()
    if len(references) == 1
}


def lookup_raw_material_reference(
    *,
    material_name: Any = None,
    material_code: Any = None,
) -> dict[str, str]:
    """Match the complete MES material name first, then its material code."""
    for candidate in (material_name, material_code):
        candidate_key = _reference_key(candidate)
        reference = _REFERENCE_BY_MODEL.get(candidate_key)
        if reference is not None:
            return dict(reference)
        base_key = _without_trailing_parenthetical(candidate_key)
        reference = _REFERENCE_BY_MODEL.get(base_key)
        if reference is None:
            reference = _UNIQUE_PARENTHETICAL_ALIASES.get(base_key)
        if reference is not None:
            return dict(reference)
    return {}


__all__ = [
    "RAW_MATERIAL_REFERENCE_ROWS",
    "lookup_raw_material_reference",
]
