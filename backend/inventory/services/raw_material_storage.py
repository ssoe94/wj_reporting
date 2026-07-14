"""Durable storage helpers for raw-material MES datasets.

The dashboard aggregation deliberately consumes MES-shaped dictionaries.  This
module stores those dictionaries without leaking database models into the
aggregation layer and can reconstruct the same shape from the existing staging
inventory when no durable MES dataset has been captured yet.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone as datetime_timezone
from decimal import Decimal
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from inventory.models import RawMaterialMESDataset, StagingInventory


SHANGHAI = ZoneInfo("Asia/Shanghai")
_VALID_KINDS = {
    RawMaterialMESDataset.KIND_INVENTORY,
    RawMaterialMESDataset.KIND_INVENTORY_PENDING,
    RawMaterialMESDataset.KIND_CHANGE,
}


@dataclass(frozen=True, slots=True)
class StoredDataset:
    """Immutable metadata plus a detached copy of a stored MES row set."""

    id: int
    kind: str
    capture_type: str
    scope_key: str
    rows: list[dict[str, Any]]
    warehouse_codes: tuple[str, ...]
    warehouse_ids: tuple[str, ...]
    lookback_days: int
    snapshot_date: date | None
    range_start: datetime | None
    range_end: datetime | None
    record_count: int
    source_latest_at: datetime | None
    refreshed_at: datetime

    @property
    def payload(self) -> list[dict[str, Any]]:
        """Alias matching the database field name for callers that prefer it."""
        return self.rows


def _normalise_kind(kind: Any) -> str:
    value = str(kind or "").strip().casefold()
    if value not in _VALID_KINDS:
        allowed = ", ".join(sorted(_VALID_KINDS))
        raise ValueError(f"kind must be one of: {allowed}")
    return value


def _normalise_capture_type(value: Any) -> str:
    normalised = str(value or RawMaterialMESDataset.CAPTURE_DAILY).strip().casefold()
    allowed = {item for item, _label in RawMaterialMESDataset.CAPTURE_CHOICES}
    if normalised not in allowed:
        raise ValueError("capture_type must be daily or manual")
    return normalised


def _normalise_scope_values(values: Iterable[Any] | Any) -> tuple[str, ...]:
    if values is None:
        return ()
    if isinstance(values, (str, int, Decimal)):
        values = (values,)

    normalised: set[str] = set()
    for value in values:
        if value is None or isinstance(value, bool):
            continue
        text = str(value).strip()
        if text:
            normalised.add(text)
    return tuple(sorted(normalised))


def _normalise_lookback(value: Any) -> int:
    try:
        result = int(value or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("lookback_days must be an integer") from exc
    if result < 0:
        raise ValueError("lookback_days must be non-negative")
    return result


def _normalise_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(float(value)):
            raise ValueError("datetime timestamp must be finite")
        seconds = float(value) / 1000 if abs(float(value)) >= 100_000_000_000 else float(value)
        result = datetime.fromtimestamp(seconds, tz=datetime_timezone.utc)
    elif isinstance(value, str):
        result = parse_datetime(value.strip())
        if result is None:
            raise ValueError(f"invalid datetime value: {value!r}")
    else:
        raise TypeError("datetime values must be datetime, ISO text, or epoch seconds/milliseconds")

    if timezone.is_naive(result):
        result = timezone.make_aware(result, SHANGHAI)
    return result


def _normalise_snapshot_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        if timezone.is_naive(value):
            value = timezone.make_aware(value, SHANGHAI)
        return value.astimezone(SHANGHAI).date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        result = parse_date(value.strip())
        if result is not None:
            return result
    raise ValueError("snapshot_date must be a date, datetime, or ISO date string")


def _is_id_key(key: str) -> bool:
    if key.casefold() in {"id", "ids"}:
        return True
    if re.search(r"_ids?$", key, flags=re.IGNORECASE):
        return True
    return bool(re.search(r"(?:Id|Ids|ID|IDs)$", key))


def _json_safe(value: Any, *, id_value: bool = False) -> Any:
    """Return a JSON-safe detached value, stringifying every ID field."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if id_value and isinstance(value, (int, float, Decimal)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("ID values must be finite")
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): _json_safe(item, id_value=_is_id_key(str(key)))
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_json_safe(item, id_value=id_value) for item in value]
    if isinstance(value, (set, frozenset)):
        ordered = sorted(value, key=lambda item: str(item))
        return [_json_safe(item, id_value=id_value) for item in ordered]
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        result = value
        if timezone.is_naive(result):
            result = timezone.make_aware(result, SHANGHAI)
        return result.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("MES payload numbers must be finite")
    if isinstance(value, (int, float)):
        return value
    raise TypeError(f"MES payload contains a non-JSON value: {type(value).__name__}")


def _normalise_rows(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, Mapping):
            raise TypeError("rows must contain mapping objects")
        normalised = _json_safe(row)
        if not isinstance(normalised, dict):  # guarded by the Mapping check above
            raise TypeError("rows must contain mapping objects")
        result.append(normalised)
    return result


def _scope_key(
    *,
    kind: str,
    capture_type: str,
    warehouse_codes: tuple[str, ...],
    warehouse_ids: tuple[str, ...],
    lookback_days: int,
    snapshot_date: date | None,
    range_end: datetime | None,
) -> str:
    # A change-log window is daily.  Times within the same Shanghai reporting
    # date replace one another, while prior daily windows remain addressable.
    range_end_date = None
    if kind == RawMaterialMESDataset.KIND_CHANGE and range_end is not None:
        range_end_date = range_end.astimezone(SHANGHAI).date().isoformat()
    scope = {
        "version": 3,
        "kind": kind,
        "capture_type": capture_type,
        "warehouse_codes": list(warehouse_codes),
        "warehouse_ids": list(warehouse_ids),
        "lookback_days": lookback_days,
        "snapshot_date": snapshot_date.isoformat() if snapshot_date else None,
        "range_end_date": range_end_date,
    }
    encoded = json.dumps(scope, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _to_stored_dataset(dataset: RawMaterialMESDataset) -> StoredDataset:
    payload = dataset.payload if isinstance(dataset.payload, list) else []
    rows = copy.deepcopy([row for row in payload if isinstance(row, dict)])
    return StoredDataset(
        id=dataset.pk,
        kind=dataset.kind,
        capture_type=dataset.capture_type,
        scope_key=dataset.scope_key,
        rows=rows,
        warehouse_codes=tuple(str(value) for value in dataset.warehouse_codes or []),
        warehouse_ids=tuple(str(value) for value in dataset.warehouse_ids or []),
        lookback_days=dataset.lookback_days,
        snapshot_date=dataset.snapshot_date,
        range_start=dataset.range_start,
        range_end=dataset.range_end,
        record_count=dataset.record_count,
        source_latest_at=dataset.source_latest_at,
        refreshed_at=dataset.refreshed_at,
    )


def save_mes_dataset(
    kind: str,
    rows: Iterable[Mapping[str, Any]],
    warehouse_codes: Iterable[Any] = (),
    warehouse_ids: Iterable[Any] = (),
    lookback_days: int = 0,
    range_start: datetime | str | int | float | None = None,
    range_end: datetime | str | int | float | None = None,
    source_latest_at: datetime | str | int | float | None = None,
    snapshot_date: date | datetime | str | None = None,
    capture_type: str = RawMaterialMESDataset.CAPTURE_DAILY,
) -> StoredDataset:
    """Atomically upsert the last successful payload for a deterministic scope."""
    normalised_kind = _normalise_kind(kind)
    normalised_capture_type = _normalise_capture_type(capture_type)
    codes = _normalise_scope_values(warehouse_codes)
    ids = _normalise_scope_values(warehouse_ids)
    lookback = _normalise_lookback(lookback_days)
    start = _normalise_datetime(range_start)
    end = _normalise_datetime(range_end)
    latest = _normalise_datetime(source_latest_at)
    report_date = _normalise_snapshot_date(snapshot_date)
    if (
        report_date is None
        and normalised_kind == RawMaterialMESDataset.KIND_CHANGE
        and end is not None
    ):
        report_date = end.astimezone(SHANGHAI).date()
    payload = _normalise_rows(rows)
    scope_key = _scope_key(
        kind=normalised_kind,
        capture_type=normalised_capture_type,
        warehouse_codes=codes,
        warehouse_ids=ids,
        lookback_days=lookback,
        snapshot_date=report_date,
        range_end=end,
    )

    with transaction.atomic():
        dataset, _ = RawMaterialMESDataset.objects.update_or_create(
            kind=normalised_kind,
            scope_key=scope_key,
            defaults={
                "capture_type": normalised_capture_type,
                "warehouse_codes": list(codes),
                "warehouse_ids": list(ids),
                "lookback_days": lookback,
                "snapshot_date": report_date,
                "range_start": start,
                "range_end": end,
                "payload": payload,
                "record_count": len(payload),
                "source_latest_at": latest,
            },
        )
    return _to_stored_dataset(dataset)


def load_inventory_dataset() -> StoredDataset | None:
    """Load the newest daily inventory dataset, falling back to an undated one."""
    dataset = (
        RawMaterialMESDataset.objects.filter(
            kind=RawMaterialMESDataset.KIND_INVENTORY,
            snapshot_date__isnull=False,
        )
        .order_by("-snapshot_date", "-refreshed_at", "-pk")
        .first()
    )
    if dataset is None:
        dataset = (
            RawMaterialMESDataset.objects.filter(
                kind=RawMaterialMESDataset.KIND_INVENTORY,
                snapshot_date__isnull=True,
            )
            .order_by("-refreshed_at", "-pk")
            .first()
        )
    return _to_stored_dataset(dataset) if dataset is not None else None


def load_pending_inventory_dataset() -> StoredDataset | None:
    """Load the newest unpromoted inventory payload captured by a sync run."""
    dataset = (
        RawMaterialMESDataset.objects.filter(
            kind=RawMaterialMESDataset.KIND_INVENTORY_PENDING
        )
        .order_by("-refreshed_at", "-pk")
        .first()
    )
    return _to_stored_dataset(dataset) if dataset is not None else None


def load_inventory_history(limit: int = 2) -> list[StoredDataset]:
    """Return the newest distinct daily inventory datasets."""
    try:
        requested_limit = int(limit)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer") from exc
    if requested_limit < 0:
        raise ValueError("limit must be non-negative")
    if requested_limit == 0:
        return []

    results: list[StoredDataset] = []
    seen_dates: set[date] = set()
    queryset = RawMaterialMESDataset.objects.filter(
        kind=RawMaterialMESDataset.KIND_INVENTORY,
        capture_type=RawMaterialMESDataset.CAPTURE_DAILY,
        snapshot_date__isnull=False,
    ).order_by("-snapshot_date", "-refreshed_at", "-pk")
    for dataset in queryset.iterator(chunk_size=max(100, requested_limit * 4)):
        if dataset.snapshot_date in seen_dates:
            continue
        seen_dates.add(dataset.snapshot_date)
        results.append(_to_stored_dataset(dataset))
        if len(results) >= requested_limit:
            break
    return results


def load_change_dataset(
    warehouse_codes: Iterable[Any],
    warehouse_ids: Iterable[Any],
    minimum_lookback_days: int,
    snapshot_date: date | datetime | str | None = None,
    capture_type: str | None = None,
) -> StoredDataset | None:
    """Load the narrowest recent dataset covering the requested warehouses."""
    codes = _normalise_scope_values(warehouse_codes)
    ids = _normalise_scope_values(warehouse_ids)
    minimum_lookback = _normalise_lookback(minimum_lookback_days)
    requested_snapshot_date = _normalise_snapshot_date(snapshot_date)
    requested_capture_type = (
        _normalise_capture_type(capture_type) if capture_type is not None else None
    )
    filters: dict[str, Any] = {
        "kind": RawMaterialMESDataset.KIND_CHANGE,
        "lookback_days__gte": minimum_lookback,
    }
    if requested_snapshot_date is not None:
        filters["snapshot_date"] = requested_snapshot_date
    if requested_capture_type is not None:
        filters["capture_type"] = requested_capture_type
    queryset = (
        RawMaterialMESDataset.objects.filter(**filters)
        .order_by(
            "-snapshot_date",
            "-range_end",
            "lookback_days",
            "-refreshed_at",
            "-pk",
        )
    )
    requested_codes = set(codes)
    requested_ids = set(ids)
    for dataset in queryset.iterator(chunk_size=100):
        dataset_codes = {str(value) for value in dataset.warehouse_codes or []}
        dataset_ids = {str(value) for value in dataset.warehouse_ids or []}
        if not requested_codes.issubset(dataset_codes) or not requested_ids.issubset(
            dataset_ids
        ):
            continue
        return _to_stored_dataset(dataset)
    return None


def _status_value(value: Any) -> str | int | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(text)
    except (TypeError, ValueError):
        return text


def _timestamp_ms(value: datetime | None) -> int | None:
    if value is None:
        return None
    if timezone.is_naive(value):
        value = timezone.make_aware(value, SHANGHAI)
    return int(value.timestamp() * 1000)


def load_staging_inventory_rows() -> tuple[list[dict[str, Any]], datetime | None]:
    """Map existing staging rows into the MES inventory-detail response shape."""
    rows: list[dict[str, Any]] = []
    latest: datetime | None = None
    queryset = StagingInventory.objects.all().order_by("pk")
    for item in queryset.iterator(chunk_size=2000):
        if latest is None or item.updated_at > latest:
            latest = item.updated_at

        qc_status = _status_value(item.qc_status)
        storage_status = _status_value(item.storage_status)
        work_orders = []
        if item.work_order_code:
            work_orders.append({"code": item.work_order_code})
        rows.append(
            {
                "id": str(item.pk),
                "updatedAt": _timestamp_ms(item.updated_at),
                "material": {
                    "id": str(item.material_id),
                    "code": item.material_code,
                    "name": item.material_name,
                    "specification": item.specification,
                    "bizType": item.biz_type,
                },
                "amount": {
                    "amount": format(item.quantity, "f"),
                    "unit": {
                        "code": item.unit,
                        "name": item.unit,
                    },
                },
                "qcStatus": {"code": qc_status} if qc_status is not None else None,
                "storageStatus": (
                    {"code": storage_status} if storage_status is not None else None
                ),
                "storageLocationDetail": {
                    "warehouse": {
                        "code": item.warehouse_code,
                        "name": item.warehouse_name,
                    },
                    "location": {"name": item.location_name},
                },
                "warehouseCode": item.warehouse_code,
                "warehouseName": item.warehouse_name,
                "qrCode": item.qr_code or "",
                "labelCode": item.label_code or "",
                "workOrderSimpleInfos": work_orders,
            }
        )
    return rows, latest


__all__ = [
    "StoredDataset",
    "load_change_dataset",
    "load_inventory_dataset",
    "load_inventory_history",
    "load_pending_inventory_dataset",
    "load_staging_inventory_rows",
    "save_mes_dataset",
]
