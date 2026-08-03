from __future__ import annotations

from django.utils import timezone

from .ai_context import build_context_pack, build_top_risks, build_used_data
from .ai_metrics import project_end_of_business_day_shots, status_severity
from .ai_retrievers import get_daily_production_context, get_injection_machine_shot_context
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
    machining_time_rate = machining.get("time_progress_rate")
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
            f"时间基准为 {fmt_rate(machining_time_rate)}%，当前为{status_text(machining['status'], language)}状态，"
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
        f"시간 기준 {fmt_rate(machining_time_rate)}% 대비 {status_text(machining['status'], language)} 상태이며, "
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


def build_injection_shot_projection(
    target_date,
    machine_numbers: list[int],
    language: str = "ko",
) -> dict:
    """Build a deterministic end-of-business-day shot projection."""
    normalized_language = "zh" if language == "zh" else "ko"
    context = get_injection_machine_shot_context(target_date, machine_numbers)
    warnings = []
    facts = []

    if not context["rows"]:
        warnings.append("projection_machine_required")

    for row in context["rows"]:
        projection = project_end_of_business_day_shots(
            observed_shots=row.get("shot_count") or 0,
            recent_shots=row.get("recent_60m_shots") or 0,
            recent_window_start=row.get("recent_window_start"),
            reference_time=row.get("reference_time"),
            business_end=context.get("range_end"),
        )
        machine_number = int(row["machine_number"])
        for warning in [row.get("warning"), projection.get("warning")]:
            if warning:
                warning_code = f"machine_{machine_number}_{warning}"
                if warning_code not in warnings:
                    warnings.append(warning_code)

        facts.append({
            "machine_number": machine_number,
            "machine": row.get("machine"),
            "machine_name": row.get("machine_name"),
            "observed_shots": projection["observed_shots"],
            "recent_60m_shots": projection["recent_shots"],
            "recent_sample_count": int(row.get("recent_sample_count") or 0),
            "recent_window_minutes": projection["recent_window_minutes"],
            "shots_per_hour": projection["shots_per_hour"],
            "remaining_hours": projection["remaining_hours"],
            "projected_additional_shots": projection["projected_additional_shots"],
            "projected_total_shots": projection["projected_total_shots"],
            "reference_time": row["reference_time"].isoformat() if row.get("reference_time") else None,
            "latest_mes_recorded_at": row["latest_mes_time"].isoformat() if row.get("latest_mes_time") else None,
            "is_stale": bool(row.get("is_stale")),
            "projection_warning": projection.get("warning"),
        })

    answer_parts = []
    for fact in facts:
        machine = fact.get("machine") or fact.get("machine_name") or "-"
        projected_total = fact.get("projected_total_shots")
        if projected_total is None:
            if normalized_language == "zh":
                answer_parts.append(f"{machine} 因缺少有效的合模数据或趋势区间，无法计算结束时预计合模数。")
            else:
                answer_parts.append(f"{machine}는 유효한 형합 데이터 또는 추세 구간이 없어 종료 예상 형합수를 계산할 수 없습니다.")
            continue

        observed = int(fact.get("observed_shots") or 0)
        recent = int(fact.get("recent_60m_shots") or 0)
        hourly_rate = float(fact.get("shots_per_hour") or 0)
        window_minutes = float(fact.get("recent_window_minutes") or 0)
        if normalized_language == "zh":
            answer_parts.append(
                f"{machine} 当前累计合模 {observed:,} 次，最近 {fmt_rate(window_minutes)} 分钟 "
                f"合模 {recent:,} 次（每小时约 {fmt_rate(hourly_rate)} 次）。"
                f"若当前趋势持续，基准日结束时预计合模 {int(projected_total):,} 次。"
            )
        else:
            answer_parts.append(
                f"{machine}는 현재 누적 형합 {observed:,}회, 최근 {fmt_rate(window_minutes)}분 "
                f"형합 {recent:,}회(시간당 약 {fmt_rate(hourly_rate)}회)입니다. "
                f"현재 추세가 유지되면 기준일 종료 예상 형합수는 {int(projected_total):,}회입니다."
            )

    if not answer_parts:
        answer = (
            "预计合模数需要指定 1 至 17 号注塑机。"
            if normalized_language == "zh"
            else "종료 예상 형합수를 계산하려면 1~17호기 중 대상 설비를 지정해 주세요."
        )
    else:
        answer = "\n\n".join(answer_parts)

    latest_mes_time = max(
        (row.get("latest_mes_time") for row in context["rows"] if row.get("latest_mes_time")),
        default=None,
    )
    calculation_basis = (
        [
            "基准日按 Asia/Shanghai 08:00 至次日 08:00 计算。",
            "当前累计合模数使用 MES 累计计数器的正向增量合计，并识别计数器归零。",
            "趋势采用最近最多 60 分钟的合模数，并按剩余基准日时间线性外推。",
            "预计值仅在当前趋势持续的假设下成立，不是生产计划或保证值。",
        ]
        if normalized_language == "zh"
        else [
            "기준일은 Asia/Shanghai 08:00부터 익일 08:00까지입니다.",
            "현재 누적 형합수는 MES 누적 카운터의 양의 증가분을 합산하며 카운터 초기화를 반영합니다.",
            "추세는 최근 최대 60분 형합수를 사용해 기준일 잔여 시간에 선형 외삽합니다.",
            "예상값은 현재 추세 유지 가정이며 생산계획이나 보장 수량이 아닙니다.",
        ]
    )
    return {
        "answer": answer,
        "facts": {
            "metric": "injection_shot_projection",
            "business_date": target_date.isoformat(),
            "range_start": context["range_start"].isoformat(),
            "range_end": context["range_end"].isoformat(),
            "machines": facts,
        },
        "used_data": [{
            "name": "InjectionMonitoringRecord",
            "row_count": int(context.get("monitoring_row_count") or 0),
            "filters": {
                "machine_numbers": [fact["machine_number"] for fact in facts],
                "timestamp_gte": context["range_start"].isoformat(),
                "timestamp_lt": context["range_end"].isoformat(),
                "field": "capacity",
            },
        }],
        "calculation_basis": calculation_basis,
        "data_freshness": {
            "last_mes_recorded_at": latest_mes_time.isoformat() if latest_mes_time else None,
            "is_stale": any(fact["is_stale"] for fact in facts) if facts else True,
        },
        "warnings": warnings,
        "retrieval_trace": [
            f"injection.monitoring:machines={','.join(str(fact['machine_number']) for fact in facts)}",
            f"injection.monitoring:{context['range_start'].isoformat()}~{context['range_end'].isoformat()}",
            "injection.capacity_delta:reset_safe",
            "production.metric:linear_recent_shot_projection",
        ],
    }
