from __future__ import annotations

import re
from datetime import timedelta
from itertools import groupby
from typing import Any

from django.db.models import Max, Q

from injection.models import InjectionMonitoringRecord

from .ai_metrics import business_range, elapsed_rate, reference_time_for_business_day, safe_int, safe_rate
from .mes_progress import equipment_sort_order, format_equipment_label, normalize_equipment_key, normalize_part_no
from .models import ProductionMesReportRecord, ProductionPartCavity, ProductionPlan


MACHINE_TONNAGE = {
    1: "850T",
    2: "850T",
    3: "1300T",
    4: "1400T",
    5: "1400T",
    6: "2500T",
    7: "1800T",
    8: "850T",
    9: "850T",
    10: "650T",
    11: "550T",
    12: "550T",
    13: "450T",
    14: "850T",
    15: "650T",
    16: "1050T",
    17: "1200T",
}


def machine_label(machine_number: int) -> str:
    return f"{MACHINE_TONNAGE.get(machine_number, f'{machine_number}T')}-{machine_number}"


def machine_monitoring_name(machine_number: int) -> str:
    return f"{machine_number}호기"


def parse_machine_number(machine_name: str | None) -> int | None:
    if not machine_name:
        return None
    text = str(machine_name)
    match = re.search(r"(\d+)\s*(?:호기|号机)", text)
    if match:
        return int(match.group(1))
    match = re.search(r"-(\d+)\s*$", text)
    if match:
        return int(match.group(1))
    match = re.search(r"^\s*(\d+)\b", text)
    if match:
        return int(match.group(1))
    return None


def sum_positive_monitoring_delta(machine_name: str, field_name: str, start_dt: Any, end_dt: Any) -> int:
    baseline = (
        InjectionMonitoringRecord.objects
        .filter(machine_name=machine_name, timestamp__lt=start_dt)
        .exclude(**{f"{field_name}__isnull": True})
        .order_by("-timestamp")
        .values_list(field_name, flat=True)
        .first()
    )
    values = (
        InjectionMonitoringRecord.objects
        .filter(machine_name=machine_name, timestamp__gte=start_dt, timestamp__lt=end_dt)
        .exclude(**{f"{field_name}__isnull": True})
        .order_by("timestamp")
        .values_list(field_name, flat=True)
    )

    previous = baseline
    total = 0.0
    for value in values:
        if value is None:
            continue
        if previous is None:
            delta = float(value)
        else:
            delta = float(value) - float(previous) if float(value) >= float(previous) else float(value)
        if delta > 0:
            total += delta
        previous = value
    return int(round(total))


def cavity_map_for_plans(plans: list[ProductionPlan]) -> dict[str, int]:
    part_nos = {
        (plan.part_no or "").strip().upper()
        for plan in plans
        if plan.part_no
    }
    return {
        (row["part_no"] or "").strip().upper(): int(row["cavity"] or 1)
        for row in ProductionPartCavity.objects.filter(part_no__in=part_nos).values("part_no", "cavity")
    }


def get_injection_summary(target_date: Any) -> dict[str, Any]:
    range_start, range_end = business_range(target_date)
    plan_queryset = (
        ProductionPlan.objects
        .filter(plan_date=target_date, plan_type="injection", planned_quantity__gt=0)
        .order_by("machine_name", "sequence", "id")
    )
    plans = list(plan_queryset)
    cavity_map = cavity_map_for_plans(plans)
    latest_mes_time = (
        InjectionMonitoringRecord.objects
        .filter(timestamp__gte=range_start, timestamp__lt=range_end)
        .filter(Q(capacity__isnull=False) | Q(power_kwh__isnull=False) | Q(oil_temperature__isnull=False))
        .aggregate(latest=Max("timestamp"))
        .get("latest")
    )
    reference_time = reference_time_for_business_day(target_date, latest_mes_time)
    recent_start = max(range_start, reference_time - timedelta(minutes=60))

    def sort_key(plan: ProductionPlan) -> tuple[int, int, int]:
        machine_number = parse_machine_number(plan.machine_name)
        return (machine_number or 999, int(plan.sequence or 0), int(plan.id or 0))

    sorted_plans = sorted(plans, key=sort_key)
    machine_rows = []
    part_rows = []

    for machine_name, grouped in groupby(sorted_plans, key=lambda plan: plan.machine_name):
        machine_plans = list(grouped)
        machine_number = parse_machine_number(machine_name)
        if machine_number is None:
            continue
        monitor_name = machine_monitoring_name(machine_number)
        shot_count = sum_positive_monitoring_delta(monitor_name, "capacity", range_start, reference_time)
        recent_shots = sum_positive_monitoring_delta(monitor_name, "capacity", recent_start, reference_time)
        remaining_shots = shot_count
        planned_qty = 0
        capped_actual_qty = 0
        completed_count = 0
        in_progress_count = 0
        pending_count = 0
        parts = []

        for index, plan in enumerate(machine_plans, start=1):
            part_planned_qty = safe_int(plan.planned_quantity)
            if part_planned_qty <= 0:
                continue
            part_no = (plan.part_no or "").strip().upper()
            cavity = max(1, int(cavity_map.get(part_no, 1) or 1))
            required_shots = part_planned_qty / cavity
            allocated_shots = max(0.0, min(float(remaining_shots), required_shots))
            estimated_qty = min(part_planned_qty, int(round(allocated_shots * cavity)))
            part_progress = safe_rate(estimated_qty, part_planned_qty)
            status = "completed" if part_progress >= 99.9 else "in_progress" if part_progress > 0 else "pending"
            remaining_shots = max(0.0, float(remaining_shots) - allocated_shots)
            planned_qty += part_planned_qty
            capped_actual_qty += estimated_qty
            completed_count += 1 if status == "completed" else 0
            in_progress_count += 1 if status == "in_progress" else 0
            pending_count += 1 if status == "pending" else 0
            part_payload = {
                "sequence": index,
                "machine": machine_label(machine_number),
                "machine_name": machine_name or machine_label(machine_number),
                "machine_number": machine_number,
                "part_no": part_no or "-",
                "model_name": plan.model_name or plan.part_spec or "-",
                "lot_no": plan.lot_no or "-",
                "product_family_code": plan.product_family_code,
                "product_family_name": plan.product_family_name,
                "is_finished_product": bool(plan.is_finished_product),
                "planned_qty": part_planned_qty,
                "estimated_qty": estimated_qty,
                "gap_qty": estimated_qty - part_planned_qty,
                "progress_rate": part_progress,
                "cavity": cavity,
                "status": status,
            }
            parts.append(part_payload)
            part_rows.append(part_payload)

        avg_cavity = (
            sum(max(1, int(cavity_map.get((plan.part_no or "").strip().upper(), 1) or 1)) * safe_int(plan.planned_quantity) for plan in machine_plans)
            / planned_qty
        ) if planned_qty > 0 else 1
        extra_qty = int(round(remaining_shots * avg_cavity)) if remaining_shots > 0 else 0
        actual_qty = capped_actual_qty + extra_qty
        machine_progress = safe_rate(actual_qty, planned_qty)
        machine_rows.append({
            "machine": machine_label(machine_number),
            "machine_name": machine_name or machine_label(machine_number),
            "machine_number": machine_number,
            "planned_qty": planned_qty,
            "actual_qty": actual_qty,
            "gap_qty": actual_qty - planned_qty,
            "progress_rate": machine_progress,
            "shot_count": shot_count,
            "recent_60m_shots": recent_shots,
            "recent_60m_avg_ct_sec": round(3600 / recent_shots, 1) if recent_shots > 0 else None,
            "is_running": recent_shots > 0,
            "completed_count": completed_count,
            "in_progress_count": in_progress_count,
            "pending_count": pending_count,
            "parts": parts,
        })

    total_planned = sum(row["planned_qty"] for row in machine_rows)
    total_actual = sum(row["actual_qty"] for row in machine_rows)
    machine_rows.sort(key=lambda row: row["machine_number"])

    return {
        "process": "injection",
        "range_start": range_start,
        "range_end": range_end,
        "reference_time": reference_time,
        "latest_mes_time": latest_mes_time,
        "time_progress_rate": elapsed_rate(target_date, reference_time),
        "planned_qty": total_planned,
        "actual_qty": total_actual,
        "progress_rate": safe_rate(total_actual, total_planned),
        "gap_qty": total_actual - total_planned,
        "active_equipment_count": sum(1 for row in machine_rows if row["actual_qty"] > 0),
        "running_equipment_count": sum(1 for row in machine_rows if row["is_running"]),
        "total_equipment_count": 17,
        "plan_row_count": plan_queryset.count(),
        "monitoring_row_count": InjectionMonitoringRecord.objects.filter(
            timestamp__gte=range_start,
            timestamp__lt=range_end,
        ).count(),
        "last_plan_updated_at": plan_queryset.order_by("-updated_at").values_list("updated_at", flat=True).first(),
        "machine_rows": machine_rows,
        "part_rows": part_rows,
    }


def get_machining_summary(target_date: Any) -> dict[str, Any]:
    range_start, range_end = business_range(target_date)
    plan_queryset = ProductionPlan.objects.filter(
        plan_date=target_date,
        plan_type="machining",
        planned_quantity__gt=0,
    )
    mes_queryset = ProductionMesReportRecord.objects.filter(
        business_date=target_date,
        plan_type="machining",
    ).order_by("report_time")

    plan_groups: dict[tuple[str, str], dict[str, Any]] = {}
    for plan in plan_queryset:
        equipment_key = normalize_equipment_key("machining", plan.machine_name)
        part_no = normalize_part_no(plan.part_no)
        if not equipment_key or not part_no:
            continue
        key = (equipment_key, part_no)
        group = plan_groups.setdefault(key, {
            "equipment_key": equipment_key,
            "equipment_name": plan.machine_name,
            "part_no": part_no,
            "model_name": plan.model_name or "",
            "planned_qty": 0,
            "plan_row_count": 0,
        })
        group["planned_qty"] += safe_int(plan.planned_quantity)
        group["plan_row_count"] += 1
        if not group["model_name"] and plan.model_name:
            group["model_name"] = plan.model_name

    mes_groups: dict[tuple[str, str], dict[str, Any]] = {}
    for record in mes_queryset:
        key = (record.equipment_key, record.part_no)
        group = mes_groups.setdefault(key, {
            "equipment_key": record.equipment_key,
            "equipment_name": record.equipment_name,
            "part_no": record.part_no,
            "model_name": record.material_name or "",
            "actual_qty": 0,
            "mes_report_count": 0,
            "latest_report_time": None,
        })
        group["actual_qty"] += safe_int(record.report_qty)
        group["mes_report_count"] += 1
        if record.report_time and (not group["latest_report_time"] or record.report_time > group["latest_report_time"]):
            group["latest_report_time"] = record.report_time

    keys = sorted(
        set(plan_groups.keys()) | set(mes_groups.keys()),
        key=lambda item: (equipment_sort_order("machining", item[0]), item[1]),
    )
    rows = []
    for equipment_key, part_no in keys:
        plan = plan_groups.get((equipment_key, part_no), {})
        mes = mes_groups.get((equipment_key, part_no), {})
        planned_qty = safe_int(plan.get("planned_qty"))
        actual_qty = safe_int(mes.get("actual_qty"))
        equipment_name = plan.get("equipment_name") or mes.get("equipment_name") or equipment_key
        rows.append({
            "equipment_key": equipment_key,
            "equipment_name": equipment_name,
            "equipment_label": format_equipment_label("machining", equipment_name, equipment_key),
            "part_no": part_no,
            "model_name": plan.get("model_name") or mes.get("model_name") or "",
            "planned_qty": planned_qty,
            "actual_qty": actual_qty,
            "gap_qty": actual_qty - planned_qty,
            "progress_rate": safe_rate(actual_qty, planned_qty),
            "latest_report_time": mes.get("latest_report_time"),
        })

    planned_qty = sum(row["planned_qty"] for row in rows)
    actual_qty = sum(row["actual_qty"] for row in rows)
    latest_report_time = mes_queryset.aggregate(latest=Max("report_time")).get("latest")

    return {
        "process": "machining",
        "range_start": range_start,
        "range_end": range_end,
        "planned_qty": planned_qty,
        "actual_qty": actual_qty,
        "progress_rate": safe_rate(actual_qty, planned_qty),
        "gap_qty": actual_qty - planned_qty,
        "active_equipment_count": len({row["equipment_label"] for row in rows if row["actual_qty"] > 0}),
        "running_equipment_count": 0,
        "total_equipment_count": len({row["equipment_label"] for row in rows if row["planned_qty"] > 0}),
        "plan_row_count": plan_queryset.count(),
        "mes_row_count": mes_queryset.count(),
        "last_plan_updated_at": plan_queryset.order_by("-updated_at").values_list("updated_at", flat=True).first(),
        "latest_report_time": latest_report_time,
        "rows": rows,
    }


def get_daily_production_context(target_date: Any) -> dict[str, Any]:
    injection = get_injection_summary(target_date)
    machining = get_machining_summary(target_date)
    return {
        "business_date": target_date,
        "range_start": injection["range_start"],
        "range_end": injection["range_end"],
        "reference_time": injection["reference_time"],
        "injection": injection,
        "machining": machining,
    }
