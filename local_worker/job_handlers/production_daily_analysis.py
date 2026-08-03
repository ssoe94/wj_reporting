from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PROMPT_VERSION = "production-daily-v2"


SYSTEM_PROMPT = """You are a manufacturing production analyst.
Use only the provided data. Do not invent numbers.
The backend already selected and calculated all facts and issues.
Rewrite the draft into a concise, action-oriented production briefing without adding facts.
The summary MUST contain no measurement value or quantity, whether written with digits or words.
This includes counts, output, plan/actual, rates, percentages, dates, times, durations, and thresholds.
Never copy a draft sentence containing a measurement. The deterministic facts already retain all measurements.
Digits are allowed in the summary only when they are part of an exact equipment, line, or Part identifier
copied unchanged from the input. The title may contain the exact supplied date.
When the evidence is primarily numeric, state only a qualitative condition, limitation, or next action.
Your final answer must be valid JSON only, with no markdown.
Required keys: title, summary."""


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _fmt_num(value: Any) -> str:
    return f"{int(round(_num(value))):,}"


def _fmt_rate(value: Any) -> str:
    return f"{_num(value):.1f}".rstrip("0").rstrip(".")


def _language(payload: dict[str, Any]) -> str:
    return "zh" if payload.get("language") == "zh" else "ko"


def build_llm_payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    briefing = payload.get("briefing") or {}
    context_pack = briefing.get("context_pack") or {}
    compact_tables = []
    for table in context_pack.get("tables", []):
        if table.get("name") not in {"injection_machine_progress", "machining_line_progress"}:
            continue
        compact_tables.append({
            "name": table.get("name"),
            "columns": table.get("columns"),
            "rows": (table.get("rows") or [])[:10],
        })

    return {
        "language": payload.get("language") or "ko",
        "date": payload.get("date"),
        "draft_summary": (briefing.get("answer") or "")[:700],
        "severity": briefing.get("severity"),
        "facts": briefing.get("facts") or {},
        "top_risks": briefing.get("top_risks") or [],
        "used_data": briefing.get("used_data") or [],
        "calculation_basis": (briefing.get("calculation_basis") or [])[:5],
        "warnings": context_pack.get("warnings") or [],
        "tables": compact_tables[:2],
        "instruction": (
            "Return concise Korean JSON if language is ko, Chinese JSON if language is zh. "
            "The summary must contain zero measurement values or quantities; do not repeat any count, "
            "rate, percentage, date, time, duration, output, plan, actual, or threshold. "
            "Only exact identifier digits may remain."
        ),
    }


def _issue_from_risk(risk: dict[str, Any], severity: str) -> dict[str, Any]:
    gap_qty = int(_num(risk.get("gap_qty")))
    label = risk.get("label") or "-"
    detail = risk.get("detail") or ""
    return {
        "type": risk.get("type") or "production_risk",
        "fact_id": f"production.{risk.get('process') or 'unknown'}.{label}.gap_to_time_qty",
        "severity": "high" if severity == "critical" else severity,
        "label": label,
        "evidence": [
            f"Gap to time-adjusted expected quantity: {gap_qty:,}",
            f"Detail: {detail or '-'}",
        ],
        "possible_causes": ["Plan/MES mismatch", "Machine stop", "Cycle time delay"],
        "recommended_actions": [
            "Check current machine status",
            "Confirm latest MES data",
            "Review current plan sequence and part allocation",
        ],
    }


def _issue_from_machine_row(row: dict[str, Any]) -> dict[str, Any] | None:
    planned_qty = _num(row.get("planned_qty"))
    actual_qty = _num(row.get("actual_qty"))
    expected_qty = _num(row.get("expected_qty_by_time"))
    gap_qty = _num(row.get("gap_to_time_qty"))
    gap_rate_pp = _num(row.get("gap_to_time_rate_pp"))
    recent_shots = _num(row.get("recent_60m_shots"))
    if planned_qty <= 0 or gap_rate_pp >= -5 or gap_qty >= 0:
        return None

    label = row.get("machine") or row.get("machine_name") or "-"
    evidence = [
        f"Actual / time-adjusted expected: {_fmt_num(actual_qty)} / {_fmt_num(expected_qty)}",
        f"Progress: {_fmt_rate(row.get('progress_rate'))}%",
        f"Gap to time progress: {_fmt_rate(gap_rate_pp)}%p",
    ]
    if gap_qty < 0:
        evidence.append(f"Gap quantity: {int(gap_qty):,}")
    if recent_shots <= 0:
        evidence.append("Recent 60-minute shot count is 0")

    return {
        "type": "machine_delay",
        "fact_id": f"production.injection.{label}.gap_to_time_qty",
        "severity": "high" if gap_qty < 0 and recent_shots <= 0 else "medium",
        "label": label,
        "evidence": evidence,
        "possible_causes": ["Machine stop", "Cycle time delay", "Plan sequence change", "MES collection delay"],
        "recommended_actions": [
            "Confirm whether the machine is currently running",
            "Check current part and cavity setting",
            "Review MES collection freshness",
        ],
    }


def build_dummy_result(job: dict[str, Any], model_name: str = "dummy-local-worker") -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    briefing = payload.get("briefing") or {}
    facts = briefing.get("facts") or {}
    context_pack = briefing.get("context_pack") or {}
    top_risks = briefing.get("top_risks") or []
    severity = briefing.get("severity") or "normal"
    summary = briefing.get("answer") or "No deterministic production briefing was available."
    language = _language(payload)

    top_issues: list[dict[str, Any]] = []
    for risk in top_risks[:5]:
        top_issues.append(_issue_from_risk(risk, severity))

    if len(top_issues) < 5:
        for table in context_pack.get("tables", []):
            if table.get("name") != "injection_machine_progress":
                continue
            for row in table.get("rows", []):
                issue = _issue_from_machine_row(row)
                if issue:
                    top_issues.append(issue)
                if len(top_issues) >= 5:
                    break

    if not top_issues and language == "ko":
        summary = f"{summary}\n\n계획 대비 큰 지연 설비는 현재 계산 기준에서 확인되지 않습니다."
    elif not top_issues:
        summary = f"{summary}\n\n按当前计算基准，未发现明显延迟设备。"

    return {
        "title": "Daily Production AI Analysis",
        "severity": severity,
        "summary": summary,
        "top_issues": top_issues,
        "facts": facts,
        "used_data": briefing.get("used_data") or [],
        "calculation_basis": briefing.get("calculation_basis") or [],
        "data_freshness": briefing.get("data_freshness") or context_pack.get("data_freshness") or {},
        "warnings": briefing.get("warnings") or context_pack.get("warnings") or [],
        "retrieval_trace": briefing.get("retrieval_trace") or context_pack.get("retrieval_trace") or [],
        "model_name": model_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
