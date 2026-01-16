from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Tuple

from django.db import transaction
from django.utils import timezone

from inventory.mes import call_inventory_change_log
from inventory.models import (
    FinishedGoodsTransaction,
    FinishedGoodsTransactionSnapshot,
)

FINISHED_WAREHOUSE_NAMES = {'成品仓库'}
FINISHED_WAREHOUSE_CODES = {'Product'}
DEFAULT_PAGE_SIZE = 200
FOUR_PLACES = Decimal("0.0001")

SLOT_TIME_MAP = {
    FinishedGoodsTransactionSnapshot.SLOT_MORNING: time(hour=8, minute=0),
    FinishedGoodsTransactionSnapshot.SLOT_EVENING: time(hour=20, minute=0),
}


@dataclass
class CaptureResult:
    snapshot: FinishedGoodsTransactionSnapshot
    total_records: int
    filtered_records: int
    slot: str
    start: datetime
    end: datetime


def _infer_slot(now: datetime) -> str:
    """Infer slot based on current time if not explicitly provided."""
    current_hour = now.hour
    if current_hour < 12:
        return FinishedGoodsTransactionSnapshot.SLOT_MORNING
    return FinishedGoodsTransactionSnapshot.SLOT_EVENING


def _ensure_aware(dt: datetime, tz) -> datetime:
    """Ensure datetime is timezone aware."""
    if timezone.is_naive(dt):
        return timezone.make_aware(dt, tz)
    return dt.astimezone(tz)


def _to_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return Decimal("0")
        try:
            return Decimal(value)
        except InvalidOperation:
            return Decimal("0")
    return Decimal("0")


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(FOUR_PLACES)


def _ms_to_datetime(timestamp_ms: Optional[int], tz) -> Optional[datetime]:
    if not timestamp_ms:
        return None
    # MES timestamps are in milliseconds
    seconds = timestamp_ms / 1000
    return datetime.fromtimestamp(seconds, tz=timezone.utc).astimezone(tz)


def _normalise_unit(unit_info: Any) -> str:
    if isinstance(unit_info, dict):
        return (
            unit_info.get("code")
            or unit_info.get("name")
            or unit_info.get("unitCode")
            or ""
        )
    if isinstance(unit_info, str):
        return unit_info
    return ""


def _extract_change_amount(amount_info: Dict[str, Any]) -> Tuple[Decimal, str, bool]:
    """
    Extract change amount, unit, and direction flag from MES record structure.
    """
    if not amount_info:
        return Decimal("0"), "", True

    # amount_info structure:
    # {
    #   "amount": {"amount": 10, "unit": {...}},
    #   "direction": true,
    #   ...
    # }
    change_section = amount_info.get("amount") or {}
    quantity = _to_decimal(change_section.get("amount"))
    unit = _normalise_unit(change_section.get("unit"))
    direction = amount_info.get("direction")

    if direction is None:
        # fall back to positive quantity assumption
        direction = True

    return quantity, unit, bool(direction)


def _extract_warehouse(item: Dict[str, Any]) -> Tuple[str, str]:
    """
    Extract warehouse name and code from MES change log record.

    The swagger file exposes only a string, but some environments may include
    structured payloads. Attempt to cover both cases.
    """
    warehouse = item.get("warehouse")
    warehouse_code = item.get("warehouseCode") or ""

    if isinstance(warehouse, dict):
        name = warehouse.get("name") or ""
        code = warehouse.get("code") or warehouse_code
        return name, code

    if warehouse:
        name = str(warehouse)
    else:
        name = ""

    if not warehouse_code:
        # Try storage location detail if available
        storage_detail = item.get("storageLocationDetail") or {}
        if isinstance(storage_detail, dict):
            warehouse_info = storage_detail.get("warehouse") or {}
            if isinstance(warehouse_info, dict):
                warehouse_code = warehouse_info.get("code") or warehouse_code
                name = warehouse_info.get("name") or name

    if not warehouse_code and name in FINISHED_WAREHOUSE_NAMES:
        warehouse_code = next(iter(FINISHED_WAREHOUSE_CODES))

    return name, warehouse_code


def _fetch_mes_change_logs(
    start_ms: int,
    end_ms: int,
    logger=None,
) -> Tuple[List[Dict[str, Any]], int]:
    """
    Fetch paginated change logs from MES within the provided window.
    Returns the accumulated list and the last reported total value.
    """
    page = 1
    accumulated: List[Dict[str, Any]] = []
    last_total = 0

    while True:
        payload = {
            "dateStart": start_ms,
            "dateEnd": end_ms,
            "page": page,
            "size": DEFAULT_PAGE_SIZE,
        }
        response = call_inventory_change_log(**payload) or {}
        data = response.get("list") or response.get("data", {}).get("list") or []
        total = (
            response.get("total")
            or response.get("data", {}).get("total")
            or 0
        )

        if logger:
            logger.debug(
                "[FinishedGoods] MES change log page=%s fetched=%s total=%s",
                page,
                len(data),
                total,
            )

        if not data:
            break

        accumulated.extend(data)
        last_total = total or last_total

        if len(accumulated) >= last_total:
            break

        if len(data) < DEFAULT_PAGE_SIZE:
            break

        page += 1

    return accumulated, last_total


def capture_finished_goods_transactions(
    *,
    slot: Optional[str] = None,
    target_date: Optional[datetime.date] = None,
    start_dt: Optional[datetime] = None,
    end_dt: Optional[datetime] = None,
    force: bool = True,
    dry_run: bool = False,
    logger=None,
) -> CaptureResult:
    """
    Capture finished-good warehouse in/out transactions from MES and store them
    as an aggregated snapshot.
    """
    tz = timezone.get_default_timezone()
    now = timezone.now().astimezone(tz)

    if start_dt and end_dt:
        start_dt = _ensure_aware(start_dt, tz)
        end_dt = _ensure_aware(end_dt, tz)
        if slot is None:
            slot = _infer_slot(end_dt)
    else:
        slot = slot or _infer_slot(now)
        base_date = target_date or now.date()

        slot_time = SLOT_TIME_MAP.get(slot)
        if not slot_time:
            raise ValueError(f"Unsupported slot value: {slot}")

        # Evening slot scheduled at 20:00 refers to the same-day window (08~20).
        if slot == FinishedGoodsTransactionSnapshot.SLOT_EVENING and now.time() < slot_time and target_date is None:
            base_date = base_date - timedelta(days=1)

        end_dt = _ensure_aware(datetime.combine(base_date, slot_time), tz)
        start_dt = end_dt - timedelta(hours=12)

    if start_dt >= end_dt:
        raise ValueError("start_dt must be earlier than end_dt")

    report_date = end_dt.date()
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)

    raw_records, total_reported = _fetch_mes_change_logs(start_ms, end_ms, logger=logger)

    filtered_records: List[Dict[str, Any]] = []
    for item in raw_records:
        warehouse_name, _ = _extract_warehouse(item)
        if warehouse_name in FINISHED_WAREHOUSE_NAMES:
            filtered_records.append(item)

    aggregation: Dict[str, Dict[str, Any]] = {}
    tzinfo = timezone.get_default_timezone()

    for item in filtered_records:
        material_info = item.get("material") or {}
        material_code = material_info.get("code") or item.get("materialCode")
        if not material_code:
            continue

        warehouse_name, warehouse_code = _extract_warehouse(item)
        specification = (
            item.get("specification")
            or material_info.get("specification")
            or ""
        )
        material_name = material_info.get("name") or ""

        amount_info = item.get("amount") or {}
        quantity, unit_code, is_inbound = _extract_change_amount(amount_info)

        if quantity == 0:
            continue

        created_at = _ms_to_datetime(item.get("createdAt"), tzinfo)

        action_info = item.get("action") or {}
        action_code = action_info.get("action") or action_info.get("code") or ""

        aggregation_entry = aggregation.setdefault(
            material_code,
            {
                "material_code": material_code,
                "material_name": material_name,
                "specification": specification,
                "warehouse_name": warehouse_name,
                "warehouse_code": warehouse_code,
                "unit": unit_code,
                "total_in": Decimal("0"),
                "total_out": Decimal("0"),
                "record_count": 0,
                "last_in_time": None,
                "last_out_time": None,
                "action_breakdown": defaultdict(int),
            },
        )

        if not aggregation_entry["unit"]:
            aggregation_entry["unit"] = unit_code

        aggregation_entry["record_count"] += 1
        aggregation_entry["action_breakdown"][action_code or ("in" if is_inbound else "out")] += 1

        if is_inbound:
            aggregation_entry["total_in"] += quantity
            if created_at:
                current = aggregation_entry["last_in_time"]
                if not current or created_at > current:
                    aggregation_entry["last_in_time"] = created_at
        else:
            aggregation_entry["total_out"] += quantity
            if created_at:
                current = aggregation_entry["last_out_time"]
                if not current or created_at > current:
                    aggregation_entry["last_out_time"] = created_at

    total_in = sum(entry["total_in"] for entry in aggregation.values())
    total_out = sum(entry["total_out"] for entry in aggregation.values())

    if dry_run:
        dummy_snapshot = FinishedGoodsTransactionSnapshot(
            slot=slot,
            report_date=report_date,
            scheduled_at=end_dt,
            range_start=start_dt,
            range_end=end_dt,
            record_count=sum(entry["record_count"] for entry in aggregation.values()),
            total_in=_quantize(total_in),
            total_out=_quantize(total_out),
            net_change=_quantize(total_in - total_out),
        )
        return CaptureResult(
            snapshot=dummy_snapshot,
            total_records=len(raw_records),
            filtered_records=len(filtered_records),
            slot=slot,
            start=start_dt,
            end=end_dt,
        )

    with transaction.atomic():
        snapshot, created = FinishedGoodsTransactionSnapshot.objects.get_or_create(
            slot=slot,
            report_date=report_date,
            defaults={
                "scheduled_at": end_dt,
                "range_start": start_dt,
                "range_end": end_dt,
                "record_count": 0,
                "total_in": Decimal("0"),
                "total_out": Decimal("0"),
                "net_change": Decimal("0"),
                "warehouse_filter": list(FINISHED_WAREHOUSE_NAMES),
                "metadata": {},
            },
        )

        if not created and not force:
            # Skip update if snapshot already exists and force flag is not set
            return CaptureResult(
                snapshot=snapshot,
                total_records=len(raw_records),
                filtered_records=len(filtered_records),
                slot=slot,
                start=start_dt,
                end=end_dt,
            )

        snapshot.scheduled_at = end_dt
        snapshot.range_start = start_dt
        snapshot.range_end = end_dt
        snapshot.record_count = sum(entry["record_count"] for entry in aggregation.values())
        snapshot.total_in = _quantize(total_in)
        snapshot.total_out = _quantize(total_out)
        snapshot.net_change = _quantize(total_in - total_out)
        snapshot.warehouse_filter = list(FINISHED_WAREHOUSE_NAMES)
        snapshot.metadata = {
            "raw_total": len(raw_records),
            "filtered_total": len(filtered_records),
            "mes_reported_total": total_reported,
        }
        snapshot.save()

        snapshot.transactions.all().delete()

        transaction_rows = []
        for entry in aggregation.values():
            transaction_rows.append(
                FinishedGoodsTransaction(
                    snapshot=snapshot,
                    material_code=entry["material_code"],
                    material_name=entry["material_name"],
                    specification=entry["specification"],
                    warehouse_code=entry["warehouse_code"],
                    warehouse_name=entry["warehouse_name"],
                    unit=entry["unit"],
                    total_in=_quantize(entry["total_in"]),
                    total_out=_quantize(entry["total_out"]),
                    net_change=_quantize(entry["total_in"] - entry["total_out"]),
                    record_count=entry["record_count"],
                    last_in_time=entry["last_in_time"],
                    last_out_time=entry["last_out_time"],
                    action_breakdown=dict(entry["action_breakdown"]),
                )
            )

        FinishedGoodsTransaction.objects.bulk_create(transaction_rows, batch_size=500)

    if logger:
        logger.info(
            "[FinishedGoods] Captured snapshot slot=%s date=%s rows=%s raw=%s filtered=%s",
            slot,
            report_date,
            len(transaction_rows),
            len(raw_records),
            len(filtered_records),
        )

    snapshot.refresh_from_db()

    return CaptureResult(
        snapshot=snapshot,
        total_records=len(raw_records),
        filtered_records=len(filtered_records),
        slot=slot,
        start=start_dt,
        end=end_dt,
    )


__all__ = ["capture_finished_goods_transactions", "CaptureResult"]
