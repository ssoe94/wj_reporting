from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from django.utils.dateparse import parse_date

from .ai_metrics import business_range, safe_int, safe_rate
from .mes_progress import equipment_sort_order, format_equipment_label, normalize_equipment_key, normalize_part_no
from .models import (
    MachiningManualReport,
    MachiningManualReportDefect,
    MachiningManualReportMatch,
    ProductionMesReportRecord,
    ProductionPlan,
    build_plan_identity_hash,
)


def parse_business_date(value: Any) -> date:
    if isinstance(value, date):
        return value
    parsed = parse_date(str(value or ""))
    if parsed:
        return parsed
    return timezone.localdate()


def plan_identity_for_values(plan_date, plan_type, machine_name, part_no, lot_no, sequence) -> str:
    return build_plan_identity_hash(
        plan_date,
        plan_type,
        machine_name,
        normalize_part_no(part_no),
        lot_no,
        sequence,
    )


def plan_identity_for_plan(plan: ProductionPlan) -> str:
    return plan_identity_for_values(
        plan.plan_date,
        plan.plan_type,
        plan.machine_name,
        plan.part_no,
        plan.lot_no,
        plan.sequence,
    )


def get_match_totals() -> tuple[dict[int, int], dict[int, int]]:
    matched_by_manual: dict[int, int] = defaultdict(int)
    matched_by_mes: dict[int, int] = defaultdict(int)
    for row in MachiningManualReportMatch.objects.values("manual_report_id", "mes_report_record_id").annotate(total=Sum("matched_qty")):
        qty = safe_int(row.get("total"))
        matched_by_manual[safe_int(row.get("manual_report_id"))] += qty
        matched_by_mes[safe_int(row.get("mes_report_record_id"))] += qty
    return matched_by_manual, matched_by_mes


def refresh_manual_report_status(report: MachiningManualReport) -> MachiningManualReport:
    if report.status == "cancelled":
        return report

    matched_qty = safe_int(report.matches.aggregate(total=Sum("matched_qty")).get("total"))
    total_qty = safe_int(report.total_reported_qty)
    if matched_qty <= 0:
        next_status = "open"
    elif matched_qty < total_qty:
        next_status = "partial"
    elif matched_qty == total_qty:
        next_status = "matched"
    else:
        next_status = "mismatch"

    if report.status != next_status:
        report.status = next_status
        report.save(update_fields=["status", "updated_at"])
    return report


def build_manual_report_payload(report: MachiningManualReport, matched_by_manual: dict[int, int] | None = None) -> dict[str, Any]:
    matched_qty = safe_int((matched_by_manual or {}).get(report.id))
    if matched_by_manual is None:
        matched_qty = safe_int(report.matches.aggregate(total=Sum("matched_qty")).get("total"))
    total_qty = safe_int(report.total_reported_qty)
    return {
        "id": report.id,
        "business_date": report.business_date.isoformat(),
        "plan_date": report.plan_date.isoformat(),
        "plan_id": report.plan_id,
        "machine_name": report.machine_name,
        "equipment_key": report.equipment_key,
        "part_no": report.part_no,
        "model_name": report.model_name,
        "lot_no": report.lot_no,
        "sequence": report.sequence,
        "planned_qty_at_report": safe_int(report.planned_qty_at_report),
        "good_qty": safe_int(report.good_qty),
        "defect_qty": safe_int(report.defect_qty),
        "total_reported_qty": total_qty,
        "matched_qty": matched_qty,
        "open_qty": max(0, total_qty - matched_qty),
        "reason_code": report.reason_code,
        "note": report.note,
        "status": report.status,
        "credit_business_date": report.credit_business_date.isoformat(),
        "reported_by_name": getattr(report.reported_by, "username", None) if report.reported_by_id else None,
        "reported_at": report.reported_at.isoformat() if report.reported_at else None,
        "updated_at": report.updated_at.isoformat() if report.updated_at else None,
        "defect_items": [
            {
                "id": item.id,
                "defect_category": item.defect_category,
                "defect_type": item.defect_type,
                "quantity": safe_int(item.quantity),
                "note": item.note,
            }
            for item in report.defect_items.all()
        ],
    }


def create_manual_report(*, user, payload: dict[str, Any]) -> MachiningManualReport:
    plan_id = payload.get("plan_id")
    plan = None
    if plan_id:
        plan = ProductionPlan.objects.filter(id=plan_id, plan_type="machining").first()
    if not plan:
        plan_date = parse_date(str(payload.get("plan_date") or ""))
        part_no = normalize_part_no(payload.get("part_no"))
        machine_name = (payload.get("machine_name") or "").strip()
        sequence = safe_int(payload.get("sequence"))
        plan = ProductionPlan.objects.filter(
            plan_date=plan_date,
            plan_type="machining",
            machine_name=machine_name,
            part_no=part_no,
            sequence=sequence,
        ).first()
    if not plan:
        raise ValueError("Matching machining production plan row not found.")

    business_date = parse_business_date(payload.get("business_date"))
    good_qty = max(0, safe_int(payload.get("good_qty")))
    defect_qty = max(0, safe_int(payload.get("defect_qty")))
    total_reported_qty = safe_int(payload.get("total_reported_qty")) or good_qty
    equipment_key = normalize_equipment_key("machining", payload.get("machine_name") or plan.machine_name)

    with transaction.atomic():
        report = MachiningManualReport.objects.create(
            business_date=business_date,
            plan_date=plan.plan_date,
            plan=plan,
            plan_identity_hash=plan_identity_for_plan(plan),
            machine_name=(payload.get("machine_name") or plan.machine_name or "").strip(),
            equipment_key=equipment_key,
            part_no=normalize_part_no(payload.get("part_no") or plan.part_no),
            model_name=(payload.get("model_name") or plan.model_name or "").strip(),
            lot_no=(payload.get("lot_no") or plan.lot_no or "").strip() or None,
            sequence=safe_int(payload.get("sequence") if payload.get("sequence") is not None else plan.sequence),
            planned_qty_at_report=safe_int(payload.get("planned_qty_at_report") or plan.planned_quantity),
            good_qty=good_qty,
            defect_qty=defect_qty,
            total_reported_qty=total_reported_qty,
            reason_code=(payload.get("reason_code") or "").strip(),
            note=(payload.get("note") or "").strip(),
            credit_business_date=parse_business_date(payload.get("credit_business_date") or business_date),
            reported_by=user if getattr(user, "is_authenticated", False) else None,
            updated_by=user if getattr(user, "is_authenticated", False) else None,
        )
        for item in payload.get("defect_items") or []:
            quantity = safe_int(item.get("quantity"))
            defect_type = (item.get("defect_type") or "").strip()
            if quantity <= 0 or not defect_type:
                continue
            MachiningManualReportDefect.objects.create(
                manual_report=report,
                defect_category=(item.get("defect_category") or "processing").strip(),
                defect_type=defect_type,
                quantity=quantity,
                note=(item.get("note") or "").strip(),
            )
    return report


def confirm_manual_report_match(*, manual_report_id: int, mes_report_record_ids: list[int], matched_qty: int, user, note: str = "") -> MachiningManualReport:
    report = MachiningManualReport.objects.get(id=manual_report_id, plan_type="machining")
    if report.status == "cancelled":
        raise ValueError("Cancelled manual report cannot be matched.")

    remaining_qty = max(0, safe_int(matched_qty))
    records = list(
        ProductionMesReportRecord.objects
        .filter(id__in=mes_report_record_ids, plan_type="machining")
        .order_by("business_date", "report_time", "id")
    )
    if not records:
        raise ValueError("Matching MES report record not found.")

    with transaction.atomic():
        for record in records:
            if remaining_qty <= 0:
                break
            qty = remaining_qty if len(records) == 1 else min(remaining_qty, max(0, safe_int(record.report_qty)))
            if qty <= 0:
                continue
            MachiningManualReportMatch.objects.update_or_create(
                manual_report=report,
                mes_report_record=record,
                defaults={
                    "matched_qty": qty,
                    "match_confidence": "manual_confirmed",
                    "match_reason": note or "Manual confirmation",
                    "matched_by": user if getattr(user, "is_authenticated", False) else None,
                },
            )
            remaining_qty -= qty
        refresh_manual_report_status(report)
    report.refresh_from_db()
    return report


def reconcile_manual_reports(from_date: date, to_date: date) -> dict[str, int]:
    reports = (
        MachiningManualReport.objects
        .filter(credit_business_date__gte=from_date, credit_business_date__lte=to_date)
        .exclude(status__in=["matched", "cancelled"])
        .order_by("credit_business_date", "id")
    )
    matched_count = 0
    partial_count = 0
    for report in reports:
        matched_total = safe_int(report.matches.aggregate(total=Sum("matched_qty")).get("total"))
        if matched_total >= safe_int(report.total_reported_qty):
            refresh_manual_report_status(report)
            continue

        candidates = (
            ProductionMesReportRecord.objects
            .filter(
                plan_type="machining",
                part_no=report.part_no,
                business_date__gte=report.business_date,
                business_date__lte=to_date,
            )
            .order_by("business_date", "report_time", "id")
        )
        _, matched_by_mes = get_match_totals()
        for record in candidates:
            available_qty = max(0, safe_int(record.report_qty) - safe_int(matched_by_mes.get(record.id)))
            if available_qty <= 0:
                continue
            remaining_qty = max(0, safe_int(report.total_reported_qty) - matched_total)
            if remaining_qty <= 0:
                break
            qty = min(available_qty, remaining_qty)
            MachiningManualReportMatch.objects.update_or_create(
                manual_report=report,
                mes_report_record=record,
                defaults={
                    "matched_qty": qty,
                    "match_confidence": "probable" if qty < safe_int(report.total_reported_qty) else "exact",
                    "match_reason": "Auto matched by part number and business date window",
                    "matched_by": None,
                },
            )
            matched_total += qty
            matched_by_mes[record.id] += qty
        refresh_manual_report_status(report)
        report.refresh_from_db()
        if report.status == "matched":
            matched_count += 1
        elif report.status == "partial":
            partial_count += 1
    return {"matched": matched_count, "partial": partial_count}


def build_machining_provision_payload(business_date: Any, days: int = 3) -> dict[str, Any]:
    business_day = parse_business_date(business_date)
    days = min(7, max(1, safe_int(days) or 3))
    plan_date_from = business_day
    plan_date_to = business_day + timedelta(days=days - 1)
    range_start, range_end = business_range(business_day)

    plans = list(
        ProductionPlan.objects
        .filter(
            plan_type="machining",
            plan_date__gte=plan_date_from,
            plan_date__lte=plan_date_to,
            planned_quantity__gt=0,
        )
        .order_by("plan_date", "machine_name", "sequence", "id")
    )
    last_plan_hash_by_part: dict[str, str] = {}
    for plan in plans:
        if plan.part_no:
            last_plan_hash_by_part[normalize_part_no(plan.part_no)] = plan_identity_for_plan(plan)

    matched_by_manual, matched_by_mes = get_match_totals()
    manual_reports = list(
        MachiningManualReport.objects
        .select_related("plan", "reported_by")
        .prefetch_related("defect_items")
        .filter(
            credit_business_date=business_day,
            plan_type="machining",
            plan_date__gte=plan_date_from,
            plan_date__lte=plan_date_to,
        )
        .exclude(status="cancelled")
        .order_by("plan_date", "machine_name", "sequence", "id")
    )
    manual_by_hash: dict[str, list[MachiningManualReport]] = defaultdict(list)
    for report in manual_reports:
        manual_by_hash[report.plan_identity_hash].append(report)

    mes_records = list(
        ProductionMesReportRecord.objects
        .filter(business_date=business_day, plan_type="machining")
        .order_by("report_time", "id")
    )
    mes_qty_by_part: dict[str, int] = defaultdict(int)
    mes_meta_by_part: dict[str, dict[str, Any]] = {}
    for record in mes_records:
        unmatched_qty = max(0, safe_int(record.report_qty) - safe_int(matched_by_mes.get(record.id)))
        if unmatched_qty <= 0:
            continue
        part_no = normalize_part_no(record.part_no)
        mes_qty_by_part[part_no] += unmatched_qty
        mes_meta_by_part.setdefault(part_no, {
            "id": record.id,
            "equipment_key": record.equipment_key,
            "equipment_name": record.equipment_name,
            "part_no": part_no,
            "material_name": record.material_name,
            "report_time": record.report_time,
        })

    rows: list[dict[str, Any]] = []
    consumed_mes_qty_by_part: dict[str, int] = defaultdict(int)
    for plan in plans:
        part_no = normalize_part_no(plan.part_no)
        equipment_key = normalize_equipment_key("machining", plan.machine_name)
        plan_hash = plan_identity_for_plan(plan)
        plan_manual_reports = manual_by_hash.get(plan_hash, [])
        matched_manual_qty = sum(safe_int(matched_by_manual.get(report.id)) for report in plan_manual_reports)
        manual_total_qty = sum(safe_int(report.total_reported_qty) for report in plan_manual_reports)
        manual_open_qty = sum(max(0, safe_int(report.total_reported_qty) - safe_int(matched_by_manual.get(report.id))) for report in plan_manual_reports)
        manual_defect_qty = sum(safe_int(report.defect_qty) for report in plan_manual_reports)

        planned_qty = safe_int(plan.planned_quantity)
        direct_mes_qty = 0
        remaining_mes_qty = max(0, safe_int(mes_qty_by_part.get(part_no)) - consumed_mes_qty_by_part[part_no])
        if remaining_mes_qty > 0:
            allocation_limit = remaining_mes_qty if last_plan_hash_by_part.get(part_no) == plan_hash else planned_qty
            direct_mes_qty = min(remaining_mes_qty, max(0, allocation_limit))
            consumed_mes_qty_by_part[part_no] += direct_mes_qty

        effective_actual_qty = direct_mes_qty + matched_manual_qty + manual_open_qty
        if direct_mes_qty > 0:
            row_status = "mes_reported"
        elif manual_open_qty > 0 and matched_manual_qty > 0:
            row_status = "manual_partial"
        elif manual_open_qty > 0:
            row_status = "manual_open"
        elif matched_manual_qty > 0:
            row_status = "manual_matched"
        else:
            row_status = "needs_review"
        if any(report.status == "mismatch" for report in plan_manual_reports):
            row_status = "manual_mismatch"

        rows.append({
            "business_date": business_day.isoformat(),
            "plan_date": plan.plan_date.isoformat(),
            "day_offset": (plan.plan_date - business_day).days,
            "plan_id": plan.id,
            "plan_identity_hash": plan_hash,
            "machine_name": plan.machine_name,
            "equipment_key": equipment_key,
            "equipment_label": format_equipment_label("machining", plan.machine_name, equipment_key),
            "part_no": part_no,
            "model_name": plan.model_name or "",
            "lot_no": plan.lot_no,
            "sequence": safe_int(plan.sequence),
            "planned_qty": planned_qty,
            "mes_qty": direct_mes_qty + matched_manual_qty,
            "direct_mes_qty": direct_mes_qty,
            "matched_manual_qty": matched_manual_qty,
            "manual_qty": manual_total_qty,
            "manual_open_qty": manual_open_qty,
            "effective_actual_qty": effective_actual_qty,
            "gap_qty": effective_actual_qty - planned_qty,
            "achievement_rate": safe_rate(effective_actual_qty, planned_qty),
            "status": row_status,
            "defect_qty": manual_defect_qty,
            "manual_reports": [
                build_manual_report_payload(report, matched_by_manual)
                for report in plan_manual_reports
            ],
        })

    planned_parts = {normalize_part_no(plan.part_no) for plan in plans if plan.part_no}
    for part_no, mes_qty in mes_qty_by_part.items():
        remaining_qty = safe_int(mes_qty) - consumed_mes_qty_by_part[part_no]
        if remaining_qty <= 0 or part_no in planned_parts:
            continue
        first_item = mes_meta_by_part.get(part_no) or {}
        equipment_key = first_item.get("equipment_key") or ""
        equipment_name = first_item.get("equipment_name") or equipment_key
        rows.append({
            "business_date": business_day.isoformat(),
            "plan_date": None,
            "day_offset": None,
            "plan_id": None,
            "plan_identity_hash": "",
            "machine_name": equipment_name,
            "equipment_key": equipment_key,
            "equipment_label": format_equipment_label("machining", equipment_name, equipment_key),
            "part_no": part_no,
            "model_name": first_item.get("material_name") or "",
            "lot_no": None,
            "sequence": -1,
            "planned_qty": 0,
            "mes_qty": remaining_qty,
            "direct_mes_qty": remaining_qty,
            "matched_manual_qty": 0,
            "manual_qty": 0,
            "manual_open_qty": 0,
            "effective_actual_qty": remaining_qty,
            "gap_qty": remaining_qty,
            "achievement_rate": None,
            "status": "unplanned_mes",
            "defect_qty": 0,
            "manual_reports": [],
        })

    rows.sort(key=lambda row: (
        row.get("day_offset") if row.get("day_offset") is not None else 99,
        equipment_sort_order("machining", row.get("equipment_key") or ""),
        safe_int(row.get("sequence")),
        row.get("part_no") or "",
    ))

    total_planned = sum(safe_int(row["planned_qty"]) for row in rows)
    total_mes = sum(safe_int(row["mes_qty"]) for row in rows)
    total_manual_open = sum(safe_int(row["manual_open_qty"]) for row in rows)
    total_effective = sum(safe_int(row["effective_actual_qty"]) for row in rows)
    return {
        "business_date": business_day.isoformat(),
        "range": {
            "plan_date_from": plan_date_from.isoformat(),
            "plan_date_to": plan_date_to.isoformat(),
            "range_start": range_start.isoformat(),
            "range_end": range_end.isoformat(),
        },
        "summary": {
            "total_planned": total_planned,
            "mes_qty": total_mes,
            "manual_open_qty": total_manual_open,
            "manual_matched_qty": sum(safe_int(row["matched_manual_qty"]) for row in rows),
            "effective_actual_qty": total_effective,
            "gap_qty": total_effective - total_planned,
            "achievement_rate": safe_rate(total_effective, total_planned),
            "open_manual_count": sum(1 for report in manual_reports if report.status in {"open", "partial"}),
            "mismatch_count": sum(1 for report in manual_reports if report.status == "mismatch"),
            "advance_qty": sum(
                safe_int(row["effective_actual_qty"])
                for row in rows
                if row.get("day_offset") is not None and safe_int(row.get("day_offset")) > 0
            ),
        },
        "rows": rows,
    }
