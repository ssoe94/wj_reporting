from __future__ import annotations

import re
from typing import Any


PRODUCT_FAMILY_MAP = {
    "B/C": ("BC", "Back cover"),
    "C/A": ("CA", "Cabinet"),
    "G/P": ("GP", "Guide Panel"),
}


def extract_plan_product_context(part_spec: Any) -> dict[str, Any]:
    """Normalize production-plan SPEC text into AI/search-friendly context."""
    if part_spec is None:
        text = ""
    else:
        text = str(part_spec).strip()

    compact = re.sub(r"\s+", "", text).upper()
    is_finished_product = "完" in compact
    family_code = None
    family_name = None

    for marker, (code, name) in PRODUCT_FAMILY_MAP.items():
        if marker in compact:
            family_code = code
            family_name = name
            break

    return {
        "product_family_code": family_code,
        "product_family_name": family_name,
        "is_finished_product": is_finished_product,
    }
