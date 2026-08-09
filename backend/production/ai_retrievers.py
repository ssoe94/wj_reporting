from __future__ import annotations

import re
from datetime import timedelta
from itertools import groupby
from typing import Any

from django.db.models import Max, Q
from django.utils import timezone

from injection.models import InjectionMonitoringRecord

from .ai_metrics import SHANGHAI_TZ, business_range, elapsed_rate, reference_time_for_business_day, safe_int, safe_rate
from .machining_reconciliation import build_machining_provision_payload
from .mes_progress import format_equipment_label
from .models import ProductionMesReportRecord, ProductionPartCavity, ProductionPlan
from .counter_utils import calculate_cumulative_counter_delta
from .cavity import average_group_shot_yield, build_cavity_plan_groups, get_cavity_meta_map


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

    return calculate_cumulative_counter_delta(values, baseline=baseline)


def get_injection_active_machine_context(target_date: Any, lookback_minutes: int) -> dict[str, Any]:
    """Return machines whose MES capacity counter increased in the requested window.

    The window ends at the latest capacity sample inside the selected business day.
    It may cross the 08:00 business-day boundary so questions such as "last 12
    hours" keep their literal time range. Counter resets are handled by the same
    positive-delta function used by the production progress retriever.
    """
    try:
        requested_minutes = int(lookback_minutes)
    except (TypeError, ValueError):
        requested_minutes = 60
    # A selected business day anchors the end of the window, but operators may
    # ask about activity across several business-day boundaries. Bound the
    # query to seven days to keep the MES scan predictable.
    window_minutes = max(1, min(requested_minutes, 7 * 24 * 60))

    range_start, range_end = business_range(target_date)
    machine_names = [machine_monitoring_name(number) for number in range(1, 18)]
    latest_mes_time = (
        InjectionMonitoringRecord.objects
        .filter(
            machine_name__in=machine_names,
            timestamp__gte=range_start,
            timestamp__lt=range_end,
            capacity__isnull=False,
        )
        .aggregate(latest=Max("timestamp"))
        .get("latest")
    )
    reference_time = (
        latest_mes_time.astimezone(SHANGHAI_TZ)
        if latest_mes_time
        else reference_time_for_business_day(target_date, None)
    )
    window_start = reference_time - timedelta(minutes=window_minutes)
    counter_end = reference_time + timedelta(microseconds=1)

    rows = []
    if latest_mes_time:
        for machine_number in range(1, 18):
            monitoring_name = machine_monitoring_name(machine_number)
            shot_count = sum_positive_monitoring_delta(
                monitoring_name,
                "capacity",
                window_start,
                counter_end,
            )
            if shot_count <= 0:
                continue
            rows.append({
                "machine_number": machine_number,
                "machine": machine_label(machine_number),
                "machine_name": monitoring_name,
                "shot_count": shot_count,
            })

    current_business_date = (
        timezone.now().astimezone(SHANGHAI_TZ) - timedelta(hours=8)
    ).date()
    is_stale = bool(
        latest_mes_time is None
        or (
            target_date == current_business_date
            and timezone.now() - latest_mes_time.astimezone(timezone.get_current_timezone())
            > timedelta(minutes=10)
        )
    )
    monitoring_row_count = (
        InjectionMonitoringRecord.objects.filter(
            machine_name__in=machine_names,
            timestamp__gte=window_start,
            timestamp__lt=counter_end,
            capacity__isnull=False,
        ).count()
        if latest_mes_time else 0
    )

    return {
        "business_date": target_date,
        "business_range_start": range_start,
        "business_range_end": range_end,
        "window_start": window_start,
        "window_end": reference_time,
        "lookback_minutes": window_minutes,
        "requested_lookback_minutes": requested_minutes,
        "latest_mes_time": latest_mes_time,
        "is_stale": is_stale,
        "rows": rows,
        "monitoring_row_count": monitoring_row_count,
    }


def get_injection_machine_shot_context(target_date: Any, machine_numbers: list[int]) -> dict[str, Any]:
    """Retrieve reset-safe shot trends for explicitly requested machines.

    Unlike the plan progress retriever, this does not require a production plan,
    so an operator can inspect any of the 17 injection machines.
    """
    normalized_numbers = []
    for value in machine_numbers:
        try:
            machine_number = int(value)
        except (TypeError, ValueError):
            continue
        if 1 <= machine_number <= 17 and machine_number not in normalized_numbers:
            normalized_numbers.append(machine_number)

    range_start, range_end = business_range(target_date)
    rows = []
    machine_names = [machine_monitoring_name(number) for number in normalized_numbers]
    monitoring_queryset = InjectionMonitoringRecord.objects.filter(
        machine_name__in=machine_names,
        timestamp__gte=range_start,
        timestamp__lt=range_end,
        capacity__isnull=False,
    )
    current_business_date = (
        timezone.now().astimezone(SHANGHAI_TZ) - timedelta(hours=8)
    ).date()

    for machine_number in normalized_numbers:
        monitoring_name = machine_monitoring_name(machine_number)
        latest_mes_time = (
            monitoring_queryset
            .filter(machine_name=monitoring_name)
            .order_by("-timestamp")
            .values_list("timestamp", flat=True)
            .first()
        )
        if not latest_mes_time:
            rows.append({
                "machine_number": machine_number,
                "machine": machine_label(machine_number),
                "machine_name": monitoring_name,
                "shot_count": 0,
                "recent_60m_shots": 0,
                "recent_window_start": None,
                "reference_time": None,
                "latest_mes_time": None,
                "is_stale": True,
                "warning": "injection_capacity_data_missing",
            })
            continue

        reference_time = reference_time_for_business_day(target_date, latest_mes_time)
        recent_start = max(range_start, reference_time - timedelta(minutes=60))
        # The delta helper uses an exclusive end. Include a record that lands
        # exactly on the selected reference timestamp without crossing the
        # 08:00 business-day boundary.
        counter_end = min(range_end, reference_time + timedelta(microseconds=1))
        shot_count = sum_positive_monitoring_delta(
            monitoring_name,
            "capacity",
            range_start,
            counter_end,
        )
        recent_shots = sum_positive_monitoring_delta(
            monitoring_name,
            "capacity",
            recent_start,
            counter_end,
        )
        recent_sample_count = InjectionMonitoringRecord.objects.filter(
            machine_name=monitoring_name,
            timestamp__gte=recent_start,
            timestamp__lt=counter_end,
            capacity__isnull=False,
        ).count()
        recent_has_baseline = InjectionMonitoringRecord.objects.filter(
            machine_name=monitoring_name,
            timestamp__lt=recent_start,
            capacity__isnull=False,
        ).exists()
        trend_window_available = recent_sample_count >= (1 if recent_has_baseline else 2)
        is_stale = bool(
            target_date == current_business_date
            and timezone.now() - latest_mes_time.astimezone(timezone.get_current_timezone()) > timedelta(minutes=10)
        )
        rows.append({
            "machine_number": machine_number,
            "machine": machine_label(machine_number),
            "machine_name": monitoring_name,
            "shot_count": shot_count,
            "recent_60m_shots": recent_shots,
            "recent_window_start": recent_start if trend_window_available else None,
            "recent_sample_count": recent_sample_count,
            "reference_time": reference_time,
            "latest_mes_time": latest_mes_time,
            "is_stale": is_stale,
            "warning": (
                "injection_recent_trend_window_missing"
                if not trend_window_available else
                "injection_capacity_data_stale" if is_stale else None
            ),
        })

    return {
        "business_date": target_date,
        "range_start": range_start,
        "range_end": range_end,
        "rows": rows,
        "monitoring_row_count": monitoring_queryset.count(),
    }


def cavity_map_for_plans(plans: list[ProductionPlan]) -> dict[str, dict[str, Any]]:
    part_nos = {
        (plan.part_no or "").strip().upper()
        for plan in plans
        if plan.part_no
    }
    return get_cavity_meta_map(ProductionPartCavity, part_nos)


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
    time_progress_rate = elapsed_rate(target_date, reference_time)
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

        sequence = 1
        for group_index, plan_group in enumerate(build_cavity_plan_groups(machine_plans, cavity_map), start=1):
            allocated_shots = max(0.0, min(float(remaining_shots), float(plan_group["required_shots"] or 0)))
            remaining_shots = max(0.0, float(remaining_shots) - allocated_shots)
            expected_group_size = max(
                (
                    max(1, int((member.get("meta") or {}).get("parts_per_shot") or 1))
                    for member in plan_group["members"]
                ),
                default=1,
            )
            production_group_id = f'{plan_group["group_key"]}:{group_index}'
            production_group_complete = len(plan_group["members"]) == expected_group_size

            for member in plan_group["members"]:
                plan = member["plan"]
                part_planned_qty = safe_int(plan.planned_quantity)
                if part_planned_qty <= 0:
                    continue
                part_no = (plan.part_no or "").strip().upper()
                cavity = max(1, int(member["cavity"] or 1))
                meta = member.get("meta") or {}
                estimated_qty = min(part_planned_qty, int(round(allocated_shots * cavity)))
                part_progress = safe_rate(estimated_qty, part_planned_qty)
                status = "completed" if part_progress >= 99.9 else "in_progress" if part_progress > 0 else "pending"
                planned_qty += part_planned_qty
                capped_actual_qty += estimated_qty
                completed_count += 1 if status == "completed" else 0
                in_progress_count += 1 if status == "in_progress" else 0
                pending_count += 1 if status == "pending" else 0
                part_payload = {
                    "sequence": sequence,
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
                    "cavity_pattern": meta.get("cavity_pattern"),
                    "parts_per_shot": meta.get("parts_per_shot", 1),
                    "cavity_group": meta.get("cavity_group"),
                    "total_cavity": meta.get("total_cavity", cavity),
                    "production_group_id": production_group_id,
                    "production_group_complete": production_group_complete,
                    "status": status,
                }
                sequence += 1
                parts.append(part_payload)
                part_rows.append(part_payload)

        avg_cavity = average_group_shot_yield(machine_plans, cavity_map) if planned_qty > 0 else 1
        extra_qty = int(round(remaining_shots * avg_cavity)) if remaining_shots > 0 else 0
        actual_qty = capped_actual_qty + extra_qty
        machine_progress = safe_rate(actual_qty, planned_qty)
        expected_qty_by_time = safe_int(planned_qty * time_progress_rate / 100)
        machine_rows.append({
            "machine": machine_label(machine_number),
            "machine_name": machine_name or machine_label(machine_number),
            "machine_number": machine_number,
            "planned_qty": planned_qty,
            "actual_qty": actual_qty,
            "gap_qty": actual_qty - planned_qty,
            "expected_qty_by_time": expected_qty_by_time,
            "gap_to_time_qty": actual_qty - expected_qty_by_time,
            "gap_to_time_rate_pp": round(machine_progress - time_progress_rate, 1),
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
        "time_progress_rate": time_progress_rate,
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
    provision = build_machining_provision_payload(target_date, days=1)
    plan_queryset = ProductionPlan.objects.filter(plan_date=target_date, plan_type="machining", planned_quantity__gt=0)
    mes_queryset = ProductionMesReportRecord.objects.filter(
        business_date=target_date,
        plan_type="machining",
    ).order_by("report_time")

    rows = []
    for row in provision.get("rows", []):
        planned_qty = safe_int(row.get("planned_qty"))
        actual_qty = safe_int(row.get("effective_actual_qty"))
        equipment_key = row.get("equipment_key") or ""
        equipment_name = row.get("machine_name") or equipment_key
        rows.append({
            "equipment_key": equipment_key,
            "equipment_name": equipment_name,
            "equipment_label": row.get("equipment_label") or format_equipment_label("machining", equipment_name, equipment_key),
            "part_no": row.get("part_no") or "",
            "model_name": row.get("model_name") or "",
            "planned_qty": planned_qty,
            "actual_qty": actual_qty,
            "gap_qty": actual_qty - planned_qty,
            "progress_rate": safe_rate(actual_qty, planned_qty),
            "latest_report_time": None,
            "mes_qty": safe_int(row.get("mes_qty")),
            "manual_open_qty": safe_int(row.get("manual_open_qty")),
            "matched_manual_qty": safe_int(row.get("matched_manual_qty")),
            "defect_qty": safe_int(row.get("defect_qty")),
            "status": row.get("status"),
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
    time_progress_rate = float(injection.get("time_progress_rate") or 0)
    machining["time_progress_rate"] = time_progress_rate
    for row in machining.get("rows", []):
        expected_qty_by_time = safe_int(row.get("planned_qty", 0) * time_progress_rate / 100)
        row["expected_qty_by_time"] = expected_qty_by_time
        row["gap_to_time_qty"] = safe_int(row.get("actual_qty")) - expected_qty_by_time
        row["gap_to_time_rate_pp"] = round(float(row.get("progress_rate") or 0) - time_progress_rate, 1)
    return {
        "business_date": target_date,
        "range_start": injection["range_start"],
        "range_end": injection["range_end"],
        "reference_time": injection["reference_time"],
        "injection": injection,
        "machining": machining,
    }
