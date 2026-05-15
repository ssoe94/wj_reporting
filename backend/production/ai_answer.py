from __future__ import annotations

from django.utils import timezone

from .ai_context import build_context_pack, build_top_risks, build_used_data
from .ai_metrics import status_severity
from .ai_retrievers import get_daily_production_context
from .ai_types import AiBriefCache, AiBriefingPayload


def fmt_num(value: int | float) -> str:
    return f"{int(round(float(value or 0))):,}"


def fmt_rate(value: int | float | None) -> str:
    if value is None:
        return "-"
    return f"{float(value):.1f}".rstrip("0").rstrip(".")


def status_text(status: str, language: str) -> str:
    if language == "zh":
        return {
            "behind": "延迟",
            "ahead": "快于时间基准",
            "on_track": "接近时间基准",
            "no_plan": "暂无计划基准",
        }.get(status, status)
    return {
        "behind": "지연",
        "ahead": "시간 기준보다 빠른",
        "on_track": "시간 기준과 유사한",
        "no_plan": "계획 기준 없음",
    }.get(status, status)


def risk_text(top_risks: list, language: str) -> str:
    if not top_risks:
        return "우선 확인 대상은 없습니다." if language == "ko" else "暂无优先确认对象。"
    if language == "zh":
        items = ", ".join(f"{risk.label} {abs(risk.gap_qty):,}个不足" for risk in top_risks[:3])
        return f"优先确认对象为 {items}。"
    items = ", ".join(f"{risk.label} {abs(risk.gap_qty):,}개 부족" for risk in top_risks[:3])
    return f"우선 확인 대상은 {items}입니다."


def build_briefing_answer(context_pack, top_risks: list, language: str) -> str:
    facts = context_pack.facts
    injection = facts["injection"]
    machining = facts["machining"]
    injection_time_rate = injection.get("time_progress_rate")
    injection_gap_to_time = (
        float(injection.get("progress_rate") or 0) - float(injection_time_rate)
        if injection_time_rate is not None
        else None
    )

    if language == "zh":
        first = (
            f"基准日 {context_pack.scope['business_date']} 注塑完成率为 {fmt_rate(injection['progress_rate'])}%"
            f"（{fmt_num(injection['actual_qty'])} / {fmt_num(injection['planned_qty'])}个），"
            f"时间基准为 {fmt_rate(injection_time_rate)}%，当前为{status_text(injection['status'], language)}状态。"
        )
        if injection_gap_to_time is not None:
            first += f" 与时间基准差异为 {fmt_rate(injection_gap_to_time)}%p。"
        second = (
            f"加工完成率为 {fmt_rate(machining['progress_rate'])}%"
            f"（{fmt_num(machining['actual_qty'])} / {fmt_num(machining['planned_qty'])}个），"
            f"有实绩的加工线为 {fmt_num(machining['active_equipment_count'])} 条。"
        )
        third = risk_text(top_risks, language)
        return "\n\n".join([first, second, third])

    first = (
        f"기준일 {context_pack.scope['business_date']} 사출 완료율은 {fmt_rate(injection['progress_rate'])}%"
        f"({fmt_num(injection['actual_qty'])} / {fmt_num(injection['planned_qty'])}개)이며, "
        f"시간 기준 {fmt_rate(injection_time_rate)}% 대비 {status_text(injection['status'], language)} 상태입니다."
    )
    if injection_gap_to_time is not None:
        first += f" 시간 기준과의 차이는 {fmt_rate(injection_gap_to_time)}%p입니다."
    second = (
        f"가공 완료율은 {fmt_rate(machining['progress_rate'])}%"
        f"({fmt_num(machining['actual_qty'])} / {fmt_num(machining['planned_qty'])}개)이고, "
        f"실적 발생 라인은 {fmt_num(machining['active_equipment_count'])}개입니다."
    )
    third = risk_text(top_risks, language)
    return "\n\n".join([first, second, third])


def build_ai_briefing(target_date, language: str = "ko") -> AiBriefingPayload:
    normalized_language = "zh" if language == "zh" else "ko"
    daily_context = get_daily_production_context(target_date)
    context_pack = build_context_pack(daily_context, normalized_language)
    top_risks = build_top_risks(daily_context)
    used_data = build_used_data(daily_context)
    severity = status_severity(
        context_pack.facts["injection"]["status"],
        context_pack.facts["machining"]["status"],
    )
    answer = build_briefing_answer(context_pack, top_risks, normalized_language)

    return AiBriefingPayload(
        answer=answer,
        severity=severity,
        facts={
            "injection": context_pack.facts["injection"],
            "machining": context_pack.facts["machining"],
        },
        top_risks=top_risks,
        used_data=used_data,
        calculation_basis=context_pack.calculation_basis,
        context_pack=context_pack,
        cache=AiBriefCache(hit=False, generated_at=timezone.now().isoformat(), expires_at=None),
    )
