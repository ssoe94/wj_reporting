from __future__ import annotations

from django.utils import timezone

from .ai_context import build_context_pack, build_top_risks, build_used_data
from .ai_metrics import project_end_of_business_day_shots, status_severity
from .ai_retrievers import (
    get_daily_production_context,
    get_injection_active_machine_context,
    get_injection_machine_shot_context,
)
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
            "data_unavailable": "数据不足，无法评估",
        }.get(status, status)
    return {
        "behind": "지연",
        "ahead": "시간 기준보다 빠른",
        "on_track": "시간 기준과 유사한",
        "no_plan": "계획 기준 없음",
        "data_unavailable": "데이터 부족으로 평가 불가",
    }.get(status, status)


def risk_text(top_risks: list, language: str, warnings: list[str] | None = None) -> str:
    if not top_risks:
        data_limited = {
            "injection_mes_data_missing",
            "injection_mes_data_stale",
            "injection_capacity_coverage_incomplete",
            "injection_plan_missing",
            "machining_plan_missing",
            "machining_actual_missing",
        }
        if data_limited.intersection(warnings or []):
            return (
                "일부 공정의 계획 또는 실적 데이터가 부족해 전체 우선 확인 대상을 완전히 평가할 수 없습니다."
                if language == "ko" else
                "由于部分工序的计划或实绩数据不足，暂时无法完整评估全部优先确认对象。"
            )
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
    warning_codes = set(context_pack.warnings)
    injection_data_unavailable = bool(
        warning_codes.intersection({
            "injection_mes_data_missing",
            "injection_mes_data_stale",
            "injection_capacity_coverage_incomplete",
        })
    )
    machining_data_unavailable = "machining_actual_missing" in warning_codes
    injection_time_rate = injection.get("time_progress_rate")
    machining_time_rate = machining.get("time_progress_rate")
    injection_gap_to_time = (
        float(injection.get("progress_rate") or 0) - float(injection_time_rate)
        if injection.get("planned_qty", 0) > 0 and injection_time_rate is not None
        else None
    )

    if language == "zh":
        if injection.get("planned_qty", 0) <= 0:
            first = f"基准日 {context_pack.scope['business_date']} 暂无注塑计划，无法评估完成率和时间进度。"
        elif injection_data_unavailable:
            first = (
                f"基准日 {context_pack.scope['business_date']} 的注塑 MES 合模数据缺失或更新延迟，"
                "当前无法可靠评估完成率和时间进度。请先确认最新合模数据。"
            )
        else:
            first = (
                f"基准日 {context_pack.scope['business_date']} 注塑完成率为 {fmt_rate(injection['progress_rate'])}%"
                f"（{fmt_num(injection['actual_qty'])} / {fmt_num(injection['planned_qty'])}个），"
                f"时间基准为 {fmt_rate(injection_time_rate)}%，当前为{status_text(injection['status'], language)}状态。"
            )
        if injection_gap_to_time is not None:
            first += f" 与时间基准差异为 {fmt_rate(injection_gap_to_time)}%p。"
        if machining.get("planned_qty", 0) <= 0:
            second = "暂无加工计划，无法评估完成率和时间进度。"
        elif machining_data_unavailable:
            second = "暂无可验证的加工实绩，当前无法可靠评估完成率和时间进度。请先确认加工实绩登记。"
        else:
            second = (
                f"加工完成率为 {fmt_rate(machining['progress_rate'])}%"
                f"（{fmt_num(machining['actual_qty'])} / {fmt_num(machining['planned_qty'])}个），"
                f"时间基准为 {fmt_rate(machining_time_rate)}%，当前为{status_text(machining['status'], language)}状态，"
                f"有实绩的加工线为 {fmt_num(machining['active_equipment_count'])} 条。"
            )
        third = risk_text(top_risks, language, context_pack.warnings)
        return "\n\n".join([first, second, third])

    if injection.get("planned_qty", 0) <= 0:
        first = f"기준일 {context_pack.scope['business_date']} 사출 계획이 없어 완료율과 시간 진도를 평가할 수 없습니다."
    elif injection_data_unavailable:
        first = (
            f"기준일 {context_pack.scope['business_date']} 사출 MES 형합 데이터가 없거나 갱신이 지연되어 "
            "현재 완료율과 시간 진도를 신뢰성 있게 평가할 수 없습니다. 최신 형합 데이터를 먼저 확인해 주세요."
        )
    else:
        first = (
            f"기준일 {context_pack.scope['business_date']} 사출 완료율은 {fmt_rate(injection['progress_rate'])}%"
            f"({fmt_num(injection['actual_qty'])} / {fmt_num(injection['planned_qty'])}개)이며, "
            f"시간 기준 {fmt_rate(injection_time_rate)}% 대비 {status_text(injection['status'], language)} 상태입니다."
        )
    if injection_gap_to_time is not None:
        first += f" 시간 기준과의 차이는 {fmt_rate(injection_gap_to_time)}%p입니다."
    if machining.get("planned_qty", 0) <= 0:
        second = "가공 계획이 없어 완료율과 시간 진도를 평가할 수 없습니다."
    elif machining_data_unavailable:
        second = "검증 가능한 가공 실적이 없어 현재 완료율과 시간 진도를 신뢰성 있게 평가할 수 없습니다. 가공 실적 등록 상태를 먼저 확인해 주세요."
    else:
        second = (
            f"가공 완료율은 {fmt_rate(machining['progress_rate'])}%"
            f"({fmt_num(machining['actual_qty'])} / {fmt_num(machining['planned_qty'])}개)이고, "
            f"시간 기준 {fmt_rate(machining_time_rate)}% 대비 {status_text(machining['status'], language)} 상태이며, "
            f"실적 발생 라인은 {fmt_num(machining['active_equipment_count'])}개입니다."
        )
    third = risk_text(top_risks, language, context_pack.warnings)
    return "\n\n".join([first, second, third])


def build_ai_briefing(target_date, language: str = "ko") -> AiBriefingPayload:
    normalized_language = "zh" if language == "zh" else "ko"
    daily_context = get_daily_production_context(target_date)
    context_pack = build_context_pack(daily_context, normalized_language)
    top_risks = build_top_risks(daily_context, warnings=context_pack.warnings)
    used_data = build_used_data(daily_context)
    severity = status_severity(
        context_pack.facts["injection"]["status"],
        context_pack.facts["machining"]["status"],
    )
    if severity == "normal" and context_pack.warnings:
        severity = "warning"
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


def build_injection_active_machine_count(
    target_date,
    lookback_minutes: int,
    language: str = "ko",
) -> dict:
    """Build a deterministic count of machines active in a requested MES window."""
    normalized_language = "zh" if language == "zh" else "ko"
    context = get_injection_active_machine_context(target_date, lookback_minutes)
    has_mes_evidence = context["latest_mes_time"] is not None
    active_machines = context["rows"] if has_mes_evidence else []
    active_machine_count = len(active_machines) if has_mes_evidence else None
    window_minutes = int(context["lookback_minutes"])
    hours = window_minutes / 60
    duration_label = (
        f"{int(hours)}시간" if hours.is_integer() else f"{fmt_rate(window_minutes)}분"
    )
    if normalized_language == "zh":
        duration_label = (
            f"{int(hours)}小时"
            if hours.is_integer()
            else f"{fmt_rate(window_minutes)}分钟"
        )

    machine_labels = ", ".join(row["machine"] for row in active_machines) or "-"
    window_start = context["window_start"].isoformat()
    window_end = context["window_end"].isoformat()
    if normalized_language == "zh" and not has_mes_evidence:
        answer = "所选基准日没有可用的 MES 合模记录，因此无法确认指定时间区间内运行过的注塑机数量。"
        calculation_basis = [
            "没有 MES 合模记录时，不把缺失数据解释为零台运行设备。",
            "本地 LLM 只说明已验证的结果，不计算设备数量。",
        ]
    elif normalized_language == "zh":
        answer = (
            f"截至最新 MES 记录的最近 {duration_label}，按累计合模计数增加判断，"
            f"运行过的注塑机为 {active_machine_count} 台。设备为 {machine_labels}。"
        )
        calculation_basis = [
            "运行设备定义为指定时间窗口内 MES 累计合模计数出现正向增加的注塑机。",
            "累计计数按正向增量合计，并识别计数器归零。",
            "时间窗口以所选基准日内最新 MES 记录为结束时点，允许跨越 08:00 业务日边界。",
            "本地 LLM 只说明已验证的结果，不计算设备数量。",
        ]
    elif not has_mes_evidence:
        answer = (
            "선택한 기준일에 사용할 수 있는 MES 형합 기록이 없어 지정 시간 구간에 "
            "가동된 사출기 대수를 확인할 수 없습니다."
        )
        calculation_basis = [
            "MES 형합 기록이 없으면 데이터 부재를 가동 설비 0대로 해석하지 않습니다.",
            "로컬 LLM은 검증된 결과를 설명만 하며 설비 대수를 계산하지 않습니다.",
        ]
    else:
        answer = (
            f"최신 MES 기록까지 최근 {duration_label} 동안 누적 형합값이 증가한 사출기는 "
            f"{active_machine_count}대입니다. 대상 설비는 {machine_labels}입니다."
        )
        calculation_basis = [
            "가동 설비는 지정 시간 구간에 MES 누적 형합값의 양의 증가가 확인된 사출기로 정의합니다.",
            "누적 카운터는 양의 증가분을 합산하고 카운터 초기화를 반영합니다.",
            "시간 구간은 선택한 기준일 안의 최신 MES 기록을 종료 시점으로 하며 08:00 업무일 경계를 넘을 수 있습니다.",
            "로컬 LLM은 검증된 결과를 설명만 하며 설비 대수를 계산하지 않습니다.",
        ]

    if has_mes_evidence and context["is_stale"]:
        answer += (
            " 但 MES 数据处于更新延迟状态，结果可能与当前状态不同。"
            if normalized_language == "zh"
            else " 다만 MES 데이터가 갱신 지연 상태이므로 결과가 현재 상태와 다를 수 있습니다."
        )
    if context["requested_lookback_minutes"] != window_minutes:
        answer += (
            " 查询区间已限制为系统支持的最近 168 小时。"
            if normalized_language == "zh"
            else " 조회 구간은 시스템이 지원하는 최근 168시간으로 제한했습니다."
        )

    warnings = []
    if context["latest_mes_time"] is None:
        warnings.append("injection_capacity_data_missing")
    elif context["is_stale"]:
        warnings.append("injection_capacity_data_stale")
    if context["requested_lookback_minutes"] != window_minutes:
        warnings.append("injection_activity_window_clamped")

    return {
        "answer": answer,
        "facts": {
            "metric": "injection_active_machine_count",
            "business_date": target_date.isoformat(),
            "lookback_minutes": window_minutes,
            "window_start": window_start,
            "window_end": window_end,
            "active_machine_count": active_machine_count,
            "active_machines": active_machines,
            "activity_definition": "positive_mes_capacity_delta",
        },
        "used_data": [{
            "name": "InjectionMonitoringRecord",
            "row_count": int(context["monitoring_row_count"]),
            "filters": {
                "timestamp_gte": window_start,
                "timestamp_lte": window_end,
                "field": "capacity",
                "machine_numbers": list(range(1, 18)),
            },
        }],
        "calculation_basis": calculation_basis,
        "data_freshness": {
            "last_mes_recorded_at": (
                context["latest_mes_time"].isoformat()
                if context["latest_mes_time"] else None
            ),
            "is_stale": context["is_stale"],
        },
        "warnings": warnings,
        "retrieval_trace": [
            f"injection.monitoring:{window_start}~{window_end}",
            "injection.capacity_delta:reset_safe",
            "production.metric:active_machine_count",
        ],
    }
