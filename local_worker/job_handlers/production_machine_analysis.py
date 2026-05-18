from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PROMPT_VERSION = "production-machine-v1"


SYSTEM_PROMPT = """You are a manufacturing machine analyst.
Use only the provided data. Do not invent numbers.
Your final answer must be valid JSON only, with no markdown.
Required keys: title, severity, summary, top_issues, used_data, calculation_basis, model_name, generated_at."""


def build_llm_payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    context_pack = payload.get("context_pack") or {}
    return {
        "language": payload.get("language") or "ko",
        "date": payload.get("date"),
        "machine": payload.get("machine"),
        "target_row": payload.get("target_row") or {},
        "related_parts": (payload.get("related_parts") or [])[:10],
        "facts": context_pack.get("facts") or {},
        "warnings": context_pack.get("warnings") or [],
        "calculation_basis": context_pack.get("calculation_basis") or [],
        "instruction": "Return concise Korean JSON if language is ko, Chinese JSON if language is zh.",
    }


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _fmt_num(value: Any) -> str:
    return f"{int(round(_num(value))):,}"


def _fmt_rate(value: Any) -> str:
    return f"{_num(value):.1f}".rstrip("0").rstrip(".")


def _severity(row: dict[str, Any]) -> str:
    planned_qty = _num(row.get("planned_qty"))
    gap_qty = _num(row.get("gap_qty"))
    recent_shots = _num(row.get("recent_60m_shots"))
    progress_rate = _num(row.get("progress_rate"))
    if planned_qty > 0 and gap_qty < 0 and recent_shots <= 0:
        return "critical"
    if planned_qty > 0 and (gap_qty < 0 or progress_rate < 80):
        return "warning"
    return "normal"


def _summary(language: str, label: str, row: dict[str, Any]) -> str:
    actual = _fmt_num(row.get("actual_qty"))
    planned = _fmt_num(row.get("planned_qty"))
    progress = _fmt_rate(row.get("progress_rate"))
    gap = _fmt_num(row.get("gap_qty"))
    recent = _fmt_num(row.get("recent_60m_shots"))
    if language == "zh":
        return f"{label} 当前进度为 {progress}%（{actual} / {planned}），计划差异为 {gap}，最近 60 分钟合模数为 {recent}。"
    return f"{label} 현재 진행률은 {progress}%({actual} / {planned})이고, 계획 대비 차이는 {gap}개, 최근 60분 형합수는 {recent}입니다."


def _issues(row: dict[str, Any], severity: str) -> list[dict[str, Any]]:
    issues = []
    label = row.get("machine") or row.get("equipment_label") or row.get("machine_name") or "-"
    planned_qty = _num(row.get("planned_qty"))
    actual_qty = _num(row.get("actual_qty"))
    gap_qty = _num(row.get("gap_qty"))
    recent_shots = _num(row.get("recent_60m_shots"))

    if planned_qty > 0 and gap_qty < 0:
        issues.append({
            "type": "machine_gap",
            "severity": "high" if severity == "critical" else "medium",
            "label": label,
            "evidence": [
                f"Actual / plan: {_fmt_num(actual_qty)} / {_fmt_num(planned_qty)}",
                f"Gap quantity: {int(gap_qty):,}",
                f"Progress: {_fmt_rate(row.get('progress_rate'))}%",
            ],
            "possible_causes": ["Cycle time delay", "Machine stop", "Part changeover", "Plan/MES mismatch"],
            "recommended_actions": [
                "Check current machine running state",
                "Confirm current part number and cavity setting",
                "Review whether another day's order was pulled forward",
            ],
        })

    if planned_qty > 0 and recent_shots <= 0:
        issues.append({
            "type": "recent_idle",
            "severity": "high" if gap_qty < 0 else "medium",
            "label": label,
            "evidence": ["Recent 60-minute shot count is 0"],
            "possible_causes": ["Machine stop", "Break time", "Data collection delay"],
            "recommended_actions": [
                "Check shop-floor machine state",
                "Confirm MES monitoring collection time",
            ],
        })

    return issues


def build_dummy_result(job: dict[str, Any], model_name: str = "dummy-local-worker") -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    scope = job.get("scope") or {}
    row = payload.get("target_row") or {}
    machine = scope.get("machine") or payload.get("machine") or row.get("machine") or row.get("equipment_label") or "-"
    language = "zh" if payload.get("language") == "zh" else "ko"
    severity = _severity(row)
    return {
        "title": "Machine Production AI Analysis",
        "severity": severity,
        "summary": _summary(language, machine, row) if row else f"{machine} analysis context was not found.",
        "top_issues": _issues(row, severity) if row else [],
        "target_machine": row,
        "related_parts": payload.get("related_parts") or [],
        "used_data": [
            {
                "name": "production_machine_analysis_context",
                "row_count": 1 if row else 0,
                "filters": {"date": payload.get("date"), "machine": machine},
            }
        ],
        "calculation_basis": [
            "Machine analysis uses backend-calculated production context.",
            "Injection actual quantity is estimated from MES shot count x cavity allocation.",
        ],
        "model_name": model_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
