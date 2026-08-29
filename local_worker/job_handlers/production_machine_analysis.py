from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PROMPT_VERSION = "production-machine-v4"


SYSTEM_PROMPT = """You are a manufacturing machine analyst.
Use only the provided data. Do not invent numbers.
The backend already selected and calculated all facts and issues.
Rewrite the draft into a concise, action-oriented machine briefing without adding facts.
Never state or imply a root cause. Convert every hypothesis into a verification check.
Do not describe the machine as currently stopped, delayed, or running unless that exact current state is supplied.
For next actions, use only non-mutating information checks such as 확인, 점검, 검토, or 조회
(确认、检查、审查、查询). Never recommend a physical action, configuration change, or use 검증해야/需要验证.
The summary must use exactly these sections in this order for Korean: 결론, 판단 근거, 확인할 항목.
For Chinese use exactly 结论, 判断依据, 需确认. Put each heading on its own line and separate sections
with blank lines. Use evidence bullets under 판단 근거/判断依据 and one or two single-action information-check
bullets under 확인할 항목/需确认. Do not use any other heading or an unstructured action sentence.
The summary MUST contain no measurement value or quantity, whether written with digits or words.
This includes counts, output, plan/actual, rates, percentages, dates, times, durations, and thresholds.
Never copy a draft sentence containing a measurement. The deterministic facts already retain all measurements.
Digits are allowed in the summary only when they are part of the exact machine, line, or Part identifier
copied unchanged from the input. The title may contain the exact supplied date.
When the evidence is primarily numeric, state only a qualitative condition, limitation, or next action.
Your final answer must be valid JSON only, with no markdown.
Required keys: title, summary."""

INJECTION_LIMITING_WARNINGS = {
    "injection_mes_data_missing",
    "injection_mes_data_stale",
    "injection_capacity_data_missing",
    "injection_capacity_data_stale",
}
MACHINING_LIMITING_WARNINGS = {"machining_actual_missing"}
DATA_LIMITING_WARNINGS = INJECTION_LIMITING_WARNINGS | MACHINING_LIMITING_WARNINGS


def _target_process(payload: dict[str, Any], row: dict[str, Any]) -> str:
    explicit = str(payload.get("process") or "").strip().lower()
    if explicit in {"injection", "machining"}:
        return explicit
    if any(row.get(key) for key in ("equipment_label", "equipment_name", "equipment_key")):
        return "machining"
    if any(row.get(key) for key in ("machine", "machine_name", "machine_number")):
        return "injection"
    return ""


def _target_warnings(
    payload: dict[str, Any],
    context_warnings: list[str],
    process: str,
) -> list[str]:
    relevant = (
        INJECTION_LIMITING_WARNINGS
        if process == "injection"
        else MACHINING_LIMITING_WARNINGS
        if process == "machining"
        else DATA_LIMITING_WARNINGS
    )
    # New server payloads provide this field even when the target has no data
    # limitation. Keeping an explicit empty list authoritative prevents a
    # global injection warning from masking a valid machining target.
    supplied = payload.get("target_data_warnings")
    source = supplied if isinstance(supplied, list) else context_warnings
    return [
        warning
        for warning in source
        if isinstance(warning, str)
        and (warning not in DATA_LIMITING_WARNINGS or warning in relevant)
    ]


def _safe_target_row(row: dict[str, Any], warnings: list[str] | None = None) -> dict[str, Any]:
    if not DATA_LIMITING_WARNINGS.intersection(warnings or []):
        return row
    return {
        key: row[key]
        for key in (
            "machine",
            "machine_name",
            "machine_number",
            "equipment_label",
            "equipment_name",
            "equipment_key",
            "planned_qty",
        )
        if key in row
    }


def build_llm_payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    context_pack = payload.get("context_pack") or {}
    row = payload.get("target_row") or {}
    process = _target_process(payload, row)
    warnings = _target_warnings(payload, context_pack.get("warnings") or [], process)
    data_limited = bool(DATA_LIMITING_WARNINGS.intersection(warnings))
    return {
        "language": payload.get("language") or "ko",
        "date": payload.get("date"),
        "machine": payload.get("machine"),
        "process": process,
        "target_row": _safe_target_row(row, warnings),
        "related_parts": [] if data_limited else (payload.get("related_parts") or [])[:10],
        "facts": context_pack.get("facts") or {},
        "warnings": warnings,
        "calculation_basis": context_pack.get("calculation_basis") or [],
        "instruction": (
            "Return concise Korean JSON if language is ko, Chinese JSON if language is zh. "
            "The summary must contain zero measurement values or quantities; do not repeat any count, "
            "rate, percentage, date, time, duration, output, plan, actual, or threshold. "
            "Only exact identifier digits may remain."
            " Use exactly the three required sections and put each evidence/check item in its own bullet."
        ),
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


def _severity(
    row: dict[str, Any],
    warnings: list[str] | None = None,
    process: str = "",
) -> str:
    if DATA_LIMITING_WARNINGS.intersection(warnings or []):
        return "warning"
    planned_qty = _num(row.get("planned_qty"))
    gap_qty = _num(row.get("gap_qty"))
    recent_shots = _num(row.get("recent_60m_shots"))
    progress_rate = _num(row.get("progress_rate"))
    if process == "injection" and planned_qty > 0 and gap_qty < 0 and recent_shots <= 0:
        return "critical"
    if planned_qty > 0 and (gap_qty < 0 or progress_rate < 80):
        return "warning"
    return "normal"


def _summary(
    language: str,
    label: str,
    row: dict[str, Any],
    warnings: list[str] | None = None,
    process: str = "",
) -> str:
    data_limited = DATA_LIMITING_WARNINGS.intersection(warnings or [])
    if data_limited:
        if process == "machining":
            if language == "zh":
                return f"{label} 缺少已确认的加工实绩，当前无法可靠评估生产进度。请确认最新加工实绩后重新评估。"
            return f"{label}의 확인된 가공 실적이 없어 현재 생산 진도를 신뢰성 있게 평가할 수 없습니다. 최신 가공 실적을 확인한 뒤 다시 평가해 주세요."
        if language == "zh":
            return f"{label} 的 MES 合模数据缺失或更新延迟，当前无法可靠评估生产进度和运行状态。请确认最新采集时间后重新评估。"
        return f"{label}의 MES 형합 데이터가 없거나 갱신이 지연되어 현재 생산 진도와 가동 상태를 신뢰성 있게 평가할 수 없습니다. 최신 수집 시각을 확인한 뒤 다시 평가해 주세요."
    actual = _fmt_num(row.get("actual_qty"))
    planned = _fmt_num(row.get("planned_qty"))
    progress = _fmt_rate(row.get("progress_rate"))
    gap = _fmt_num(row.get("gap_qty"))
    recent = _fmt_num(row.get("recent_60m_shots"))
    if language == "zh":
        if process == "machining":
            return f"{label} 当前进度为 {progress}%（{actual} / {planned}），计划差异为 {gap}。"
        return f"{label} 当前进度为 {progress}%（{actual} / {planned}），计划差异为 {gap}，最近 60 分钟合模数为 {recent}。"
    if process == "machining":
        return f"{label} 현재 진행률은 {progress}%({actual} / {planned})이고, 계획 대비 차이는 {gap}개입니다."
    return f"{label} 현재 진행률은 {progress}%({actual} / {planned})이고, 계획 대비 차이는 {gap}개, 최근 60분 형합수는 {recent}입니다."


def _issues(
    row: dict[str, Any],
    severity: str,
    warnings: list[str] | None = None,
    process: str = "",
) -> list[dict[str, Any]]:
    issues = []
    label = row.get("machine") or row.get("equipment_label") or row.get("machine_name") or "-"
    planned_qty = _num(row.get("planned_qty"))
    actual_qty = _num(row.get("actual_qty"))
    gap_qty = _num(row.get("gap_qty"))
    recent_shots = _num(row.get("recent_60m_shots"))
    data_limited = DATA_LIMITING_WARNINGS.intersection(warnings or [])

    if planned_qty > 0 and gap_qty < 0 and not data_limited:
        issues.append({
            "type": "machine_gap",
            "severity": "high" if severity == "critical" else "medium",
            "label": label,
            "evidence": [
                f"Actual / plan: {_fmt_num(actual_qty)} / {_fmt_num(planned_qty)}",
                f"Gap quantity: {int(gap_qty):,}",
                f"Progress: {_fmt_rate(row.get('progress_rate'))}%",
            ],
            "possible_causes": [],
            "recommended_actions": [
                "Check current machine running state",
                "Confirm current part number and cavity setting",
                "Review whether another day's order was pulled forward",
            ],
        })

    if process == "injection" and planned_qty > 0 and recent_shots <= 0 and not data_limited:
        issues.append({
            "type": "recent_no_shots",
            "severity": "high" if gap_qty < 0 else "medium",
            "label": label,
            "evidence": ["Recent 60-minute shot count is 0"],
            "possible_causes": [],
            "recommended_actions": [
                "Check shop-floor machine state",
                "Confirm MES monitoring collection time",
            ],
        })

    if data_limited:
        issues.append({
            "type": "data_freshness_check",
            "severity": "medium",
            "label": label,
            "evidence": [f"Data warning: {warning}" for warning in sorted(data_limited)],
            "possible_causes": [],
            "recommended_actions": [
                "Confirm the latest MES collection timestamp",
                "Re-evaluate machine progress after data refresh",
            ],
        })

    return issues


def build_dummy_result(job: dict[str, Any], model_name: str = "dummy-local-worker") -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    scope = job.get("scope") or {}
    context_pack = payload.get("context_pack") or {}
    row = payload.get("target_row") or {}
    machine = scope.get("machine") or payload.get("machine") or row.get("machine") or row.get("equipment_label") or "-"
    language = "zh" if payload.get("language") == "zh" else "ko"
    process = _target_process(payload, row)
    warnings = _target_warnings(payload, context_pack.get("warnings") or [], process)
    data_limited = bool(DATA_LIMITING_WARNINGS.intersection(warnings))
    severity = _severity(row, warnings, process)
    return {
        "title": "Machine Production AI Analysis",
        "severity": severity,
        "summary": _summary(language, machine, row, warnings, process) if row else f"{machine} analysis context was not found.",
        "top_issues": _issues(row, severity, warnings, process) if row else [],
        "target_machine": _safe_target_row(row, warnings),
        "related_parts": [] if data_limited else payload.get("related_parts") or [],
        "used_data": [
            {
                "name": "production_machine_analysis_context",
                "row_count": 1 if row else 0,
                "filters": {"date": payload.get("date"), "machine": machine},
            }
        ],
        "calculation_basis": (
            [
                "Machine analysis uses backend-calculated production context.",
                "Machining actual quantity uses the verified machining report supplied by the backend.",
            ]
            if process == "machining"
            else [
                "Machine analysis uses backend-calculated production context.",
                "Injection actual quantity is estimated from MES shot count x cavity allocation.",
            ]
        ),
        "data_freshness": context_pack.get("data_freshness") or {},
        "warnings": warnings,
        "retrieval_trace": context_pack.get("retrieval_trace") or [],
        "model_name": model_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
