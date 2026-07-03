from __future__ import annotations

import re
from typing import Any


DEFAULT_CAVITY_PATTERN = "1x1"


def normalize_cavity_pattern(value: Any = None, fallback_cavity: Any = None, fallback_parts: Any = None) -> tuple[str, int, int]:
    text = str(value or "").strip().lower()
    text = text.replace(" ", "").replace("*", "x").replace("X", "x").replace("×", "x")
    match = re.match(r"^(\d+)x(\d+)$", text)
    if match:
        parts_per_shot = max(1, int(match.group(1)))
        cavity = max(1, int(match.group(2)))
        return f"{parts_per_shot}x{cavity}", parts_per_shot, cavity

    try:
        cavity = max(1, int(fallback_cavity or 1))
    except (TypeError, ValueError):
        cavity = 1

    try:
        parts_per_shot = max(1, int(fallback_parts or 1))
    except (TypeError, ValueError):
        parts_per_shot = 1

    return f"{parts_per_shot}x{cavity}", parts_per_shot, cavity


def normalize_part_no(value: Any) -> str:
    return str(value or "").strip().upper()


def default_cavity_meta(part_no: Any = "") -> dict[str, Any]:
    key = normalize_part_no(part_no)
    return {
        "cavity": 1,
        "cavity_pattern": DEFAULT_CAVITY_PATTERN,
        "parts_per_shot": 1,
        "cavity_group": key,
        "total_cavity": 1,
    }


def serialize_cavity_meta(row: dict[str, Any] | Any, part_no: Any = None) -> dict[str, Any]:
    getter = row.get if isinstance(row, dict) else lambda key, default=None: getattr(row, key, default)
    key = normalize_part_no(part_no if part_no is not None else getter("part_no", ""))
    raw_pattern = getter("cavity_pattern", None)
    raw_cavity = getter("cavity", 1)
    try:
        numeric_cavity = max(1, int(raw_cavity or 1))
    except (TypeError, ValueError):
        numeric_cavity = 1
    if str(raw_pattern or "").strip().lower().replace(" ", "") == DEFAULT_CAVITY_PATTERN and numeric_cavity != 1:
        raw_pattern = None
    pattern, parts_per_shot, cavity = normalize_cavity_pattern(
        raw_pattern,
        raw_cavity,
        getter("parts_per_shot", 1),
    )
    group = normalize_part_no(getter("cavity_group", "")) or key
    return {
        "cavity": cavity,
        "cavity_pattern": pattern,
        "parts_per_shot": parts_per_shot,
        "cavity_group": group,
        "total_cavity": cavity * parts_per_shot,
    }


def get_cavity_meta_map(model_cls: Any, part_nos: set[str] | list[str] | tuple[str, ...]) -> dict[str, dict[str, Any]]:
    normalized_parts = sorted({normalize_part_no(part_no) for part_no in part_nos if normalize_part_no(part_no)})
    if not normalized_parts:
        return {}

    result: dict[str, dict[str, Any]] = {}
    rows = model_cls.objects.filter(part_no__in=normalized_parts).values(
        "part_no",
        "cavity",
        "cavity_pattern",
        "parts_per_shot",
        "cavity_group",
    )
    for row in rows:
        key = normalize_part_no(row.get("part_no"))
        result[key] = serialize_cavity_meta(row, key)
    return result


def attach_cavity_meta(record: dict[str, Any], cavity_map: dict[str, dict[str, Any]]) -> None:
    part_no = normalize_part_no(record.get("part_no"))
    meta = cavity_map.get(part_no) or default_cavity_meta(part_no)
    record.update(meta)


def plan_value(plan: Any, field: str, default: Any = None) -> Any:
    if isinstance(plan, dict):
        return plan.get(field, default)
    return getattr(plan, field, default)


def get_plan_part_no(plan: Any) -> str:
    return normalize_part_no(plan_value(plan, "part_no", ""))


def get_plan_quantity(plan: Any) -> int:
    try:
        return max(0, int(round(float(plan_value(plan, "planned_quantity", 0) or 0))))
    except (TypeError, ValueError):
        return 0


def build_cavity_plan_groups(plans: list[Any], cavity_map: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    consumed: set[int] = set()
    groups: list[dict[str, Any]] = []

    for index, plan in enumerate(plans):
        if index in consumed:
            continue

        part_no = get_plan_part_no(plan)
        meta = cavity_map.get(part_no) or default_cavity_meta(part_no)
        group_key = normalize_part_no(meta.get("cavity_group")) or part_no
        parts_per_shot = max(1, int(meta.get("parts_per_shot") or 1))

        member_indexes = [index]
        if parts_per_shot > 1 and group_key:
            member_indexes = [
                candidate_index
                for candidate_index, candidate in enumerate(plans)
                if candidate_index not in consumed
                and normalize_part_no((cavity_map.get(get_plan_part_no(candidate)) or default_cavity_meta(get_plan_part_no(candidate))).get("cavity_group")) == group_key
            ]
            if len(member_indexes) <= 1:
                member_indexes = [index]

        members = []
        for member_index in member_indexes:
            member_plan = plans[member_index]
            member_part_no = get_plan_part_no(member_plan)
            member_meta = cavity_map.get(member_part_no) or default_cavity_meta(member_part_no)
            cavity = max(1, int(member_meta.get("cavity") or 1))
            planned_qty = get_plan_quantity(member_plan)
            members.append({
                "index": member_index,
                "plan": member_plan,
                "part_no": member_part_no,
                "cavity": cavity,
                "planned_qty": planned_qty,
                "required_shots": planned_qty / cavity if planned_qty > 0 else 0,
                "meta": member_meta,
            })
            consumed.add(member_index)

        groups.append({
            "group_key": group_key or part_no,
            "members": members,
            "required_shots": max((member["required_shots"] for member in members), default=0),
            "total_cavity": sum(member["cavity"] for member in members),
        })

    return groups


def average_group_shot_yield(plans: list[Any], cavity_map: dict[str, dict[str, Any]]) -> float:
    groups = build_cavity_plan_groups(plans, cavity_map)
    weighted_shots = sum(float(group["required_shots"] or 0) for group in groups)
    if weighted_shots <= 0:
        return 1
    weighted_output = sum(float(group["required_shots"] or 0) * max(1, int(group["total_cavity"] or 1)) for group in groups)
    return weighted_output / weighted_shots
