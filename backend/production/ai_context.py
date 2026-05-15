from __future__ import annotations

from typing import Any

from django.utils import timezone

from .ai_metrics import progress_status
from .ai_types import AiContextPack, AiDataFreshness, AiProcessSummary, AiRiskItem, AiUsedData


def iso_or_none(value: Any) -> str | None:
    if not value:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def build_process_summary(process: dict[str, Any], time_progress_rate: float | None) -> AiProcessSummary:
    status = progress_status(float(process.get("progress_rate") or 0), time_progress_rate)
    return AiProcessSummary(
        actual_qty=int(process.get("actual_qty") or 0),
        planned_qty=int(process.get("planned_qty") or 0),
        progress_rate=float(process.get("progress_rate") or 0),
        time_progress_rate=time_progress_rate,
        gap_qty=int(process.get("gap_qty") or 0),
        status=status,
        active_equipment_count=int(process.get("active_equipment_count") or 0),
        running_equipment_count=int(process.get("running_equipment_count") or 0),
        total_equipment_count=int(process.get("total_equipment_count") or 0),
    )


def build_top_risks(context: dict[str, Any], limit: int = 5) -> list[AiRiskItem]:
    risks: list[AiRiskItem] = []

    for row in context["injection"].get("machine_rows", []):
        gap_qty = int(row.get("gap_qty") or 0)
        if gap_qty >= 0:
            continue
        current_parts = [
            part for part in row.get("parts", [])
            if part.get("status") in {"in_progress", "pending"}
        ]
        detail = current_parts[0].get("part_no") if current_parts else ""
        risks.append(AiRiskItem(
            type="machine_gap",
            label=row.get("machine") or row.get("machine_name") or "-",
            gap_qty=gap_qty,
            process="injection",
            detail=detail,
        ))

    line_gaps: dict[str, int] = {}
    line_details: dict[str, str] = {}
    for row in context["machining"].get("rows", []):
        label = row.get("equipment_label") or row.get("equipment_name") or row.get("equipment_key") or "-"
        line_gaps[label] = line_gaps.get(label, 0) + int(row.get("gap_qty") or 0)
        if label not in line_details and row.get("part_no"):
            line_details[label] = row["part_no"]

    for label, gap_qty in line_gaps.items():
        if gap_qty >= 0:
            continue
        risks.append(AiRiskItem(
            type="line_gap",
            label=label,
            gap_qty=gap_qty,
            process="machining",
            detail=line_details.get(label, ""),
        ))

    return sorted(risks, key=lambda item: item.gap_qty)[:limit]


def build_used_data(context: dict[str, Any]) -> list[AiUsedData]:
    business_date = context["business_date"].isoformat()
    return [
        AiUsedData(
            name="ProductionPlan",
            row_count=int(context["injection"].get("plan_row_count") or 0) + int(context["machining"].get("plan_row_count") or 0),
            filters={"plan_date": business_date, "plan_type": ["injection", "machining"]},
        ),
        AiUsedData(
            name="InjectionMonitoringRecord",
            row_count=int(context["injection"].get("monitoring_row_count") or 0),
            filters={
                "timestamp_gte": iso_or_none(context["range_start"]),
                "timestamp_lt": iso_or_none(context["range_end"]),
            },
        ),
        AiUsedData(
            name="ProductionMesReportRecord",
            row_count=int(context["machining"].get("mes_row_count") or 0),
            filters={"business_date": business_date, "plan_type": "machining"},
        ),
    ]


def build_calculation_basis(language: str) -> list[str]:
    if language == "zh":
        return [
            "基准日按 08:00 ~ 次日 08:00 计算。",
            "注塑实绩按 MES 合模数 x Cavity，并按生产计划顺序分配推定生产量。",
            "注塑/加工完成率按 actual_qty / planned_qty x 100 计算。",
            "时间基准进度按当前数据时间在 24 小时基准日中经过的比例计算。",
            "生产进度比时间基准低 5%p 以上时标记为延迟。",
        ]
    return [
        "기준일은 08:00 ~ 익일 08:00 기준입니다.",
        "사출 실적은 MES 형합수 x Cavity를 생산계획 순서대로 배분해 추정합니다.",
        "사출/가공 완료율은 actual_qty / planned_qty x 100 기준입니다.",
        "시간 기준 진행률은 현재 데이터 시각이 기준일 24시간 중 얼마나 지났는지로 계산합니다.",
        "생산 진행률이 시간 기준보다 5%p 이상 낮으면 지연으로 표시합니다.",
    ]


def build_context_pack(context: dict[str, Any], language: str, question: str = "daily_production_briefing") -> AiContextPack:
    injection_summary = build_process_summary(
        context["injection"],
        float(context["injection"].get("time_progress_rate") or 0),
    )
    machining_summary = build_process_summary(context["machining"], None)
    calculation_basis = build_calculation_basis(language)
    last_plan_updated_at = max(
        filter(None, [
            context["injection"].get("last_plan_updated_at"),
            context["machining"].get("last_plan_updated_at"),
        ]),
        default=None,
    )
    data_freshness = AiDataFreshness(
        last_plan_updated_at=iso_or_none(last_plan_updated_at),
        last_mes_recorded_at=iso_or_none(context["injection"].get("latest_mes_time")),
        last_machining_reported_at=iso_or_none(context["machining"].get("latest_report_time")),
        is_stale=False,
    )
    warnings = []
    if not context["injection"].get("latest_mes_time"):
        warnings.append("injection_mes_data_missing")
    if context["injection"].get("planned_qty", 0) <= 0:
        warnings.append("injection_plan_missing")
    if context["machining"].get("planned_qty", 0) > 0 and context["machining"].get("actual_qty", 0) <= 0:
        warnings.append("machining_actual_missing")

    facts = {
        "injection": injection_summary.to_dict(),
        "machining": machining_summary.to_dict(),
        "generated_at": timezone.now().isoformat(),
    }

    tables = [
        {
            "name": "injection_machine_progress",
            "columns": ["machine", "actual_qty", "planned_qty", "gap_qty", "progress_rate", "recent_60m_shots"],
            "rows": [
                {
                    "machine": row.get("machine"),
                    "actual_qty": row.get("actual_qty"),
                    "planned_qty": row.get("planned_qty"),
                    "gap_qty": row.get("gap_qty"),
                    "progress_rate": row.get("progress_rate"),
                    "recent_60m_shots": row.get("recent_60m_shots"),
                }
                for row in context["injection"].get("machine_rows", [])
            ],
        },
        {
            "name": "machining_line_progress",
            "columns": ["equipment_label", "actual_qty", "planned_qty", "gap_qty", "progress_rate"],
            "rows": [
                {
                    "equipment_label": row.get("equipment_label"),
                    "actual_qty": row.get("actual_qty"),
                    "planned_qty": row.get("planned_qty"),
                    "gap_qty": row.get("gap_qty"),
                    "progress_rate": row.get("progress_rate"),
                }
                for row in context["machining"].get("rows", [])
            ],
        },
    ]

    return AiContextPack(
        question=question,
        language=language,
        scope={
            "business_date": context["business_date"].isoformat(),
            "range_start": iso_or_none(context["range_start"]),
            "range_end": iso_or_none(context["range_end"]),
            "reference_time": iso_or_none(context["reference_time"]),
            "processes": ["injection", "machining"],
        },
        facts=facts,
        tables=tables,
        calculation_basis=calculation_basis,
        data_freshness=data_freshness,
        warnings=warnings,
        retrieval_trace=[
            f"production.plan:date={context['business_date'].isoformat()}",
            f"injection.monitoring:{iso_or_none(context['range_start'])}~{iso_or_none(context['range_end'])}",
            f"production.mes_report:date={context['business_date'].isoformat()},plan_type=machining",
            "production.part_cavity",
        ],
    )
