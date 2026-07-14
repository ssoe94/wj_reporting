"""MES-backed raw-material inventory overview.

The service keeps quantities separated by the MES main unit.  Live syncs can
persist a bounded, normalized MES dataset, while normal dashboard reads can
rebuild the overview from the last successful dataset without holding an HTTP
request open during upstream pagination.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
from collections import defaultdict
from datetime import datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.cache import cache

from inventory.mes import (
    _safe_exception_message,
    call_inventory_change_log,
    call_inventory_list,
)
from inventory.services.raw_material_storage import (
    load_change_dataset,
    load_inventory_dataset,
    load_inventory_history,
    load_staging_inventory_rows,
    save_mes_dataset,
)


SHANGHAI = ZoneInfo("Asia/Shanghai")
PAGE_SIZE = 200
MAX_PAGES = 500
DEFAULT_CACHE_SECONDS = 60
BUSINESS_DAY_START_HOUR = 8
SERVICE_LEVEL_Z = Decimal("1.65")
USABLE_QC_STATUSES = {1, 2}  # 合格, 让步合格
RESTRICTED_QC_STATUSES = {3, 4, 5}  # 待检, 不合格, 暂控
INBOUND_ACTIONS = {"in", "receive"}
CONSUMPTION_ACTIONS = {"out"}
TRANSFER_OUT_ACTIONS = {"issue"}
OUTBOUND_ACTIONS = CONSUMPTION_ACTIONS | TRANSFER_OUT_ACTIONS
ADJUSTMENT_ACTIONS = {"amount_adjust", "attr_adjust"}
RISK_ORDER = {
    "critical": 0,
    "watch": 1,
    "healthy": 2,
    "no_usage": 3,
    "unknown": 4,
}

ACTION_LABELS = {
    "in": "입고",
    "out": "출고",
    "receive": "이동 입고",
    "issue": "이동 출고",
    "amount_adjust": "수량 조정",
    "attr_adjust": "속성 조정",
}


def _optional_decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return result if result.is_finite() else None


def _decimal(value: Any) -> Decimal:
    return _optional_decimal(value) or Decimal("0")


def _number(value: Decimal | Any) -> float:
    """Return a finite JSON number while retaining Decimal math internally."""
    result = float(_decimal(value))
    return result if math.isfinite(result) else 0.0


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _unit(amount: Any) -> str:
    if not isinstance(amount, dict):
        return ""
    info = amount.get("unit")
    if isinstance(info, dict):
        return _text(info.get("code") or info.get("name"))
    return _text(info)


def _unknown_unit(material: dict[str, Any], row_id: Any) -> str:
    """Return a non-mergeable display key when MES omits the main unit."""
    identity = _text(
        material.get("id")
        or material.get("code")
        or material.get("name")
        or row_id
        or "unidentified"
    )
    return f"UNKNOWN:{identity}"


def _qc_status_code(row: dict[str, Any]) -> int | None:
    status = row.get("qcStatus")
    if isinstance(status, dict):
        status = status.get("code")
    try:
        return int(status) if status not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _iso_from_ms(value: Any) -> str | None:
    try:
        if value in (None, ""):
            return None
        return datetime.fromtimestamp(int(value) / 1000, tz=SHANGHAI).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _business_date(value: datetime):
    """Return the WJ business date (08:00 through next-day 07:59)."""
    return (value.astimezone(SHANGHAI) - timedelta(hours=BUSINESS_DAY_START_HOUR)).date()


def _safe_upstream_error(exc: Exception) -> str:
    """Keep useful diagnostics without ever returning a MES access token."""
    return _safe_exception_message(exc)[:240]


def _page_payload(response: Any) -> tuple[list[dict[str, Any]], int | None]:
    if not isinstance(response, dict):
        return [], None
    payload = response.get("data")
    if not isinstance(payload, dict):
        payload = response
    rows = payload.get("list")
    rows = rows if isinstance(rows, list) else []
    raw_total = payload.get("total")
    try:
        total = int(raw_total) if raw_total is not None else None
    except (TypeError, ValueError):
        total = None
    return [row for row in rows if isinstance(row, dict)], total


def _cache_seconds() -> int:
    configured = getattr(settings, "RAW_MATERIAL_MES_CACHE_SECONDS", None)
    if configured is None:
        configured = os.getenv("RAW_MATERIAL_MES_CACHE_SECONDS", DEFAULT_CACHE_SECONDS)
    try:
        return max(1, min(int(configured), 600))
    except (TypeError, ValueError):
        return DEFAULT_CACHE_SECONDS


def _cache_key(kind: str, payload: dict[str, Any]) -> str:
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"raw-materials:{kind}:v1:{digest}"


def _fetch_pages(
    fetcher: Callable[..., Any],
    *,
    cache_kind: str,
    filters: dict[str, Any] | None = None,
    cache_key_filters: dict[str, Any] | None = None,
    force_refresh: bool = False,
) -> tuple[list[dict[str, Any]], bool, list[str]]:
    filters = filters or {}
    key = _cache_key(cache_kind, cache_key_filters if cache_key_filters is not None else filters)
    if not force_refresh:
        cached = cache.get(key)
        if isinstance(cached, list):
            return cached, True, []

    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen_pages: set[tuple[Any, ...]] = set()
    seen_record_ids: set[str] = set()
    received_count = 0
    authoritative_total: int | None = None
    page = 1
    while page <= MAX_PAGES:
        response = fetcher(page=page, size=PAGE_SIZE, **filters)
        page_rows, total = _page_payload(response)
        if total is not None and total > 0:
            if authoritative_total is None:
                authoritative_total = total
            elif authoritative_total != total:
                warnings.append(
                    f"MES {cache_kind} total changed during pagination; the dataset is incomplete."
                )
                break
        if not page_rows:
            if (
                authoritative_total is not None
                and received_count < authoritative_total
            ):
                warnings.append(
                    f"MES {cache_kind} pagination ended before its declared total; the dataset is incomplete."
                )
            break

        page_fingerprint = hashlib.sha256(
            json.dumps(page_rows, sort_keys=True, separators=(",", ":"), default=str).encode(
                "utf-8"
            )
        ).hexdigest()
        signature = (
            len(page_rows),
            page_fingerprint,
        )
        if signature in seen_pages:
            warnings.append(
                f"MES {cache_kind} pagination repeated a page; stopped to avoid duplicate data."
            )
            break
        seen_pages.add(signature)
        received_count += len(page_rows)

        duplicate_count = 0
        for row in page_rows:
            row_id = _text(row.get("id"))
            if row_id and row_id in seen_record_ids:
                duplicate_count += 1
                continue
            if row_id:
                seen_record_ids.add(row_id)
            rows.append(row)
        if duplicate_count:
            warnings.append(
                f"MES {cache_kind} pagination returned {duplicate_count} overlapping record(s); duplicates were removed."
            )

        # Some MES deployments report total as 0/missing even when rows exist.
        # Only a positive total is authoritative; otherwise page until short/empty.
        if authoritative_total is not None:
            if received_count > authoritative_total:
                warnings.append(
                    f"MES {cache_kind} returned more rows than its declared total; the dataset is incomplete."
                )
                break
            if received_count == authoritative_total:
                break
        if len(page_rows) < PAGE_SIZE:
            if (
                authoritative_total is not None
                and received_count < authoritative_total
            ):
                warnings.append(
                    f"MES {cache_kind} returned a short page before its declared total; the dataset is incomplete."
                )
            break
        page += 1
    else:
        warnings.append(f"MES {cache_kind} pagination reached the safety limit.")

    # Repeated/safety-limited pagination is usable as a partial response, but it
    # must not become the cached source of truth for subsequent requests.
    if not warnings:
        cache.set(key, rows, timeout=_cache_seconds())
    return rows, False, warnings


def _configured_codes() -> set[str]:
    configured = getattr(settings, "MES_RAW_MATERIAL_WAREHOUSE_CODES", None)
    if configured is None:
        configured = getattr(settings, "RAW_MATERIAL_WAREHOUSE_CODES", None)
    if configured is None:
        configured = os.getenv("MES_RAW_MATERIAL_WAREHOUSE_CODES", "")
    if isinstance(configured, str):
        values = re.split(r"[,;\n]", configured)
    elif isinstance(configured, Iterable):
        values = configured
    else:
        values = []
    return {_text(value).strip() for value in values if _text(value).strip()}


def _configured_ids() -> set[str]:
    configured = getattr(settings, "MES_RAW_MATERIAL_WAREHOUSE_IDS", None)
    if configured is None:
        configured = getattr(settings, "RAW_MATERIAL_WAREHOUSE_IDS", None)
    if configured is None:
        configured = os.getenv("MES_RAW_MATERIAL_WAREHOUSE_IDS", "")
    if isinstance(configured, str):
        values = re.split(r"[,;\n]", configured)
    elif isinstance(configured, Iterable):
        values = configured
    else:
        values = []
    return {_text(value).strip() for value in values if _text(value).strip()}


def _inventory_request_filters(requested_codes: list[str]) -> dict[str, Any]:
    """Use a known raw-material scope to avoid an expensive all-warehouse scan."""
    if requested_codes:
        return {"warehouseCodes": requested_codes}
    configured_ids = sorted(_configured_ids())
    if configured_ids:
        return {
            "warehouseIds": [
                int(value) if value.isdigit() else value for value in configured_ids
            ]
        }
    configured_codes = sorted(_configured_codes())
    return {"warehouseCodes": configured_codes} if configured_codes else {}


def _latest_source_iso(rows: Iterable[dict[str, Any]], *keys: str) -> str | None:
    values = [
        value
        for value in (
            _iso_from_ms(next((row.get(key) for key in keys if row.get(key)), None))
            for row in rows
        )
        if value
    ]
    return max(values) if values else None


def _strong_raw_material_candidate(code: str, name: str, configured: set[str]) -> bool:
    if code in configured:
        return True
    compact_code = re.sub(r"[\s_-]+", "", code).casefold()
    compact_name = re.sub(r"[\s_-]+", "", name).casefold()
    if any(token in compact_name for token in ("原材料", "原料", "원재료", "원료")):
        return True
    return compact_code in {
        "rawmaterial",
        "rawmaterials",
        "rawmaterialwarehouse",
        "rawmaterialswarehouse",
    } or compact_name in {
        "rawmaterial",
        "rawmaterials",
        "rawmaterialwarehouse",
        "rawmaterialswarehouse",
    }


def _warehouse_from_inventory(row: dict[str, Any]) -> dict[str, str]:
    detail = row.get("storageLocationDetail") or {}
    warehouse = detail.get("warehouse") if isinstance(detail, dict) else {}
    warehouse = warehouse if isinstance(warehouse, dict) else {}
    return {
        "id": _text(warehouse.get("id") or row.get("warehouseId")).strip(),
        "code": _text(warehouse.get("code") or row.get("warehouseCode")).strip(),
        "name": _text(warehouse.get("name") or row.get("warehouseName")).strip(),
    }


def _discover_warehouses(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    configured = _configured_codes()
    configured_ids = _configured_ids()
    options: dict[str, dict[str, Any]] = {}
    for row in rows:
        warehouse = _warehouse_from_inventory(row)
        code = warehouse["code"]
        if not code:
            continue
        current = options.get(code)
        if current is None or (not current["id"] and warehouse["id"]):
            options[code] = {
                **warehouse,
                "is_raw_material_candidate": _strong_raw_material_candidate(
                    code, warehouse["name"], configured
                ),
            }
    configured_id = (
        next(iter(configured_ids))
        if len(configured) == 1 and len(configured_ids) == 1
        else ""
    )
    for code in configured:
        options.setdefault(
            code,
            {
                "id": configured_id,
                "code": code,
                "name": code,
                "is_raw_material_candidate": True,
            },
        )
    return sorted(options.values(), key=lambda row: (row["name"], row["code"]))


def with_zero_stock_markers(
    current_rows: Iterable[dict[str, Any]],
    previous_rows: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Carry a zero marker when a previously stocked raw material disappears.

    BlackLake inventory detail omits zero-balance rows.  Without a marker, an
    entirely depleted raw-material warehouse would disappear from selection and
    the dashboard could keep showing the prior positive snapshot.
    """
    current = [row for row in current_rows if isinstance(row, dict)]
    previous = [row for row in previous_rows if isinstance(row, dict)]
    candidate_codes = {
        option["code"]
        for option in _discover_warehouses(current + previous)
        if option["is_raw_material_candidate"]
    }

    def identity(row: dict[str, Any]) -> tuple[str, str, str]:
        material = row.get("material") or {}
        material = material if isinstance(material, dict) else {}
        amount = row.get("amount") or {}
        amount = amount if isinstance(amount, dict) else {}
        unit = _unit(amount) or _unknown_unit(material, row.get("id"))
        material_identity, _unit_key = _material_key(
            material,
            unit,
            fallback=row.get("id"),
        )
        return _warehouse_from_inventory(row)["code"], material_identity, unit

    present = {identity(row) for row in current}
    marker_keys: set[tuple[str, str, str]] = set()
    result = list(current)
    for row in previous:
        key = identity(row)
        if key[0] not in candidate_codes or key in present or key in marker_keys:
            continue
        marker = copy.deepcopy(row)
        amount = marker.get("amount") or {}
        amount = amount if isinstance(amount, dict) else {}
        marker["amount"] = {**amount, "amount": "0"}
        marker["id"] = "zero:" + hashlib.sha256(
            "|".join(key).encode("utf-8")
        ).hexdigest()[:24]
        marker["syntheticZero"] = True
        result.append(marker)
        marker_keys.add(key)
    return result


def _empty_summary(inventory_record_count: int = 0) -> dict[str, Any]:
    return {
        "material_count": 0,
        "inventory_record_count": inventory_record_count,
        "reorder_count": 0,
        "recommendation_unavailable_count": 0,
        "critical_count": 0,
        "watch_count": 0,
        "quantities": [],
    }


def _base_response(
    *,
    now: datetime,
    lookback_days: int,
    lead_time_days: int,
    review_period_days: int,
    warnings: list[str],
    sources: dict[str, Any],
) -> dict[str, Any]:
    business_today = _business_date(now)
    start_date = business_today - timedelta(days=lookback_days - 1)
    statistics_end = business_today - timedelta(days=1)
    statistics_start = statistics_end - timedelta(days=lookback_days - 1)
    return {
        "status": "ok",
        "meta": {
            "generated_at": now.isoformat(),
            "data_mode": "live",
            "inventory_capture_type": None,
            "snapshot_synced_at": None,
            "sync_required": False,
            "comparison_available": False,
            "comparison_start_at": None,
            "comparison_end_at": None,
            "comparison_hours": 24,
            "source_latest_at": None,
            "inventory_source_latest_at": None,
            "change_log_source_latest_at": None,
            "timezone": "Asia/Shanghai",
            "lookback_days": lookback_days,
            "lead_time_days": lead_time_days,
            "review_period_days": review_period_days,
            "range_start": start_date.isoformat(),
            "range_end": business_today.isoformat(),
            "statistics_range_start": statistics_start.isoformat(),
            "statistics_range_end": statistics_end.isoformat(),
            "statistics_days": lookback_days,
            "recommendations_available": False,
            "recommendations_complete": False,
            "recommendation_issues": [],
            "assumptions": [
                "Average daily consumption uses the selected number of completed WJ business days and includes zero-consumption days; the active 08:00 business day is shown in the trend but excluded from reorder statistics.",
                "Estimated consumption includes only MES action out. It is an outbound-demand proxy because this API response does not identify whether each outbound was for production.",
                "MES issue is reported separately as transfer-out and is not included in consumption speed or reorder statistics.",
                "Safety stock = 1.65 × daily usage standard deviation × square root of lead time (approximately 95% service level under a normal-demand assumption).",
                "Recommended order = max(target stock - order-available stock, 0), where only MES quality status 1 (accepted) and 2 (concession accepted) are order-available.",
                "Recommendations are planning references only; open purchase orders, supplier lead-time differences, minimum order quantities, pack sizes, and shelf life are not available in these MES endpoints.",
                "Closing stock history is estimated backwards from current MES inventory using the fetched transaction net changes.",
                "Displayed current stock includes every MES quality status; pending, rejected, temporary-control, and unknown-status quantities are excluded from order-available stock.",
                "When MES omits a previously stocked raw material because its balance reached zero, the stored dataset carries an explicitly flagged zero marker so depletion remains visible.",
            ],
            "sources": sources,
            "warnings": warnings,
        },
        "warehouse_options": [],
        "selected_warehouses": [],
        "units": [],
        "summary": _empty_summary(),
        "trend": [],
        "materials": [],
        "recent_transactions": [],
    }


def _material_seed(
    material: dict[str, Any], unit: str, warehouse: dict[str, str]
) -> dict[str, Any]:
    return {
        "material_id": _text(material.get("id")),
        "material_code": _text(material.get("code")),
        "material_name": _text(material.get("name")),
        "specification": _text(material.get("specification")),
        "unit": unit,
        "current": Decimal("0"),
        "usable_current": Decimal("0"),
        "previous_current": None,
        "previous_usable": None,
        "comparison_current": None,
        "comparison_usable": None,
        "restricted_current": Decimal("0"),
        "unclassified_current": Decimal("0"),
        "inbound": Decimal("0"),
        "outbound": Decimal("0"),
        "consumption": Decimal("0"),
        "transfer_out": Decimal("0"),
        "adjustment": Decimal("0"),
        "daily_consumption": defaultdict(Decimal),
        "warehouse_codes": set(filter(None, [warehouse.get("code")])),
        "warehouse_names": set(filter(None, [warehouse.get("name")])),
        "last_updated": None,
        "recommendation_issues": set(),
    }


def _material_key(
    material: dict[str, Any], unit: str, *, fallback: Any = None
) -> tuple[str, str]:
    identity = _text(
        material.get("id")
        or material.get("code")
        or material.get("name")
        or fallback
        or "unidentified"
    )
    return identity, unit


def _later_iso(current: str | None, candidate: str | None) -> str | None:
    if not candidate:
        return current
    return candidate if not current or candidate > current else current


def _direction_is_in(value: Any, action_code: str) -> bool:
    if value is None:
        return action_code in INBOUND_ACTIONS
    if isinstance(value, str):
        normalised = value.strip().casefold()
        if normalised in {"true", "1", "yes"}:
            return True
        if normalised in {"false", "0", "no"}:
            return False
    return bool(value)


def build_raw_material_overview(
    *,
    warehouse_codes: Iterable[str] | None = None,
    lookback_days: int = 30,
    lead_time_days: int = 14,
    review_period_days: int = 7,
    now: datetime | None = None,
    force_refresh: bool = False,
    prefer_stored: bool = False,
    persist: bool = False,
    persist_inventory: bool = True,
    inventory_rows_override: Iterable[dict[str, Any]] | None = None,
    change_rows_output: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the response contract consumed by the raw-material dashboard."""
    now = now or datetime.now(tz=SHANGHAI)
    now = now.astimezone(SHANGHAI)
    warnings: list[str] = []
    global_recommendation_issues: set[str] = set()
    sources: dict[str, Any] = {
        "inventory_detail": {"status": "error", "cached": False, "record_count": 0},
        "inventory_change_log": {"status": "skipped", "cached": False, "record_count": 0},
    }
    response = _base_response(
        now=now,
        lookback_days=lookback_days,
        lead_time_days=lead_time_days,
        review_period_days=review_period_days,
        warnings=warnings,
        sources=sources,
    )

    requested: list[str] = []
    for value in warehouse_codes or []:
        code = _text(value).strip()
        if code and code not in requested:
            requested.append(code)

    if inventory_rows_override is not None:
        inventory_rows = [row for row in inventory_rows_override if isinstance(row, dict)]
        response["meta"]["data_mode"] = "daily_sync"
        sources["inventory_detail"] = {
            "status": "ok",
            "cached": False,
            "record_count": len(inventory_rows),
        }
        if persist and persist_inventory and inventory_rows:
            latest = _latest_source_iso(inventory_rows, "updatedAt", "createdAt")
            try:
                stored = save_mes_dataset(
                    kind="inventory",
                    rows=inventory_rows,
                    warehouse_codes=requested or sorted(_configured_codes()),
                    warehouse_ids=sorted(_configured_ids()),
                    snapshot_date=_business_date(now),
                    source_latest_at=datetime.fromisoformat(latest) if latest else None,
                )
                response["meta"]["snapshot_synced_at"] = stored.refreshed_at.isoformat()
            except Exception:
                warnings.append("Daily inventory was loaded but could not be saved for dashboard reads.")
                response["status"] = "partial"
    elif prefer_stored:
        stored_inventory = None
        try:
            stored_inventory = load_inventory_dataset()
        except Exception:
            warnings.append("Stored MES inventory could not be read.")
        if stored_inventory is not None:
            inventory_rows = stored_inventory.rows
            refreshed_at = stored_inventory.refreshed_at.isoformat()
            response["meta"]["data_mode"] = "stored"
            response["meta"]["inventory_capture_type"] = stored_inventory.capture_type
            response["meta"]["snapshot_synced_at"] = refreshed_at
            sources["inventory_detail"] = {
                "status": "stored",
                "cached": False,
                "record_count": len(inventory_rows),
                "refreshed_at": refreshed_at,
            }
        else:
            try:
                inventory_rows, staging_latest = load_staging_inventory_rows()
            except Exception:
                inventory_rows, staging_latest = [], None
                warnings.append("Stored staging inventory could not be read.")
            if inventory_rows:
                latest_text = (
                    staging_latest.isoformat()
                    if isinstance(staging_latest, datetime)
                    else _text(staging_latest) or None
                )
                response["meta"]["data_mode"] = "staging"
                response["meta"]["snapshot_synced_at"] = latest_text
                response["status"] = "partial"
                warnings.append(
                    "Showing the last stored inventory snapshot; movement history requires a raw-material MES sync."
                )
                global_recommendation_issues.add("inventory_change_log_not_synced")
                sources["inventory_detail"] = {
                    "status": "staging",
                    "cached": False,
                    "record_count": len(inventory_rows),
                    "refreshed_at": latest_text,
                }
            else:
                response["status"] = "sync_required"
                response["meta"]["data_mode"] = "none"
                response["meta"]["sync_required"] = True
                warnings.append("No stored raw-material MES dataset is available. Start MES sync.")
                inventory_rows = []
                sources["inventory_detail"] = {
                    "status": "missing",
                    "cached": False,
                    "record_count": 0,
                }
    else:
        inventory_filters = _inventory_request_filters(requested)
        try:
            inventory_rows, inventory_cached, page_warnings = _fetch_pages(
                call_inventory_list,
                cache_kind="inventory-detail",
                filters=inventory_filters,
                force_refresh=force_refresh,
            )
            warnings.extend(page_warnings)
            if page_warnings:
                response["status"] = "partial"
                global_recommendation_issues.add("inventory_pagination_incomplete")
            sources["inventory_detail"] = {
                "status": "partial" if page_warnings else "ok",
                "cached": inventory_cached,
                "record_count": len(inventory_rows),
            }
            if persist and persist_inventory and inventory_rows and not page_warnings:
                latest = _latest_source_iso(inventory_rows, "updatedAt", "createdAt")
                try:
                    stored = save_mes_dataset(
                        kind="inventory",
                        rows=inventory_rows,
                        warehouse_codes=requested or sorted(_configured_codes()),
                        warehouse_ids=sorted(_configured_ids()),
                        snapshot_date=_business_date(now),
                        source_latest_at=datetime.fromisoformat(latest) if latest else None,
                    )
                    response["meta"]["snapshot_synced_at"] = stored.refreshed_at.isoformat()
                except Exception:
                    warnings.append("Live inventory was loaded but could not be saved for fast dashboard reads.")
                    response["status"] = "partial"
        except Exception as exc:  # upstream failure must keep the response contract intact
            inventory_rows = []
            warnings.append(f"MES inventory detail unavailable: {_safe_upstream_error(exc)}")
            response["status"] = "partial"
            global_recommendation_issues.add("inventory_detail_unavailable")

    options = _discover_warehouses(inventory_rows)
    response["warehouse_options"] = options
    option_by_code = {row["code"]: row for row in options}
    if requested:
        unknown = [code for code in requested if code not in option_by_code]
        if unknown:
            warnings.append("Unknown warehouse code(s): " + ", ".join(unknown))
        selected = [option_by_code[code] for code in requested if code in option_by_code]
    else:
        selected = [row for row in options if row["is_raw_material_candidate"]]

    response["selected_warehouses"] = selected
    if not selected:
        # A failed inventory source is partial; a successful but ambiguous discovery
        # asks the user to select explicitly and never guesses a generic warehouse.
        if sources["inventory_detail"]["status"] in {"ok", "stored", "staging"}:
            response["status"] = "selection_required"
        response["meta"]["sync_required"] = response["status"] == "sync_required"
        return response

    selected_codes = {row["code"] for row in selected}
    selected_names = {row["name"] for row in selected if row["name"]}
    selected_ids = [row["id"] for row in selected if row["id"]]
    if len(selected_ids) != len(selected):
        warnings.append("One or more selected warehouses have no MES ID; transaction coverage may be incomplete.")
        response["status"] = "partial"
        global_recommendation_issues.add("warehouse_id_missing")
    invalid_selected_ids = [value for value in selected_ids if not value.isdigit()]
    if invalid_selected_ids:
        warnings.append(
            "One or more selected warehouses have a non-numeric MES ID; those warehouses were excluded from transaction retrieval."
        )
        response["status"] = "partial"
        global_recommendation_issues.add("warehouse_id_invalid")
        selected_ids = [value for value in selected_ids if value.isdigit()]

    selected_inventory = [
        row for row in inventory_rows if _warehouse_from_inventory(row)["code"] in selected_codes
    ]
    materials: dict[tuple[str, str], dict[str, Any]] = {}
    unknown_qc_statuses: set[str] = set()
    missing_unit_record_count = 0
    invalid_inventory_quantity_count = 0
    for row in selected_inventory:
        material = row.get("material") or {}
        material = material if isinstance(material, dict) else {}
        amount = row.get("amount") or {}
        amount = amount if isinstance(amount, dict) else {}
        unit = _unit(amount)
        unit_missing = not unit
        if unit_missing:
            missing_unit_record_count += 1
            unit = _unknown_unit(material, row.get("id"))
        warehouse = _warehouse_from_inventory(row)
        key = _material_key(material, unit, fallback=row.get("id"))
        entry = materials.setdefault(key, _material_seed(material, unit, warehouse))
        if unit_missing:
            entry["recommendation_issues"].add("main_unit_missing")
        current_amount = _optional_decimal(amount.get("amount"))
        if current_amount is None:
            invalid_inventory_quantity_count += 1
            entry["recommendation_issues"].add("inventory_quantity_invalid")
            entry["last_updated"] = _later_iso(
                entry["last_updated"],
                _iso_from_ms(row.get("updatedAt") or row.get("createdAt")),
            )
            continue
        entry["current"] += current_amount
        qc_status = _qc_status_code(row)
        if qc_status in USABLE_QC_STATUSES:
            entry["usable_current"] += current_amount
        elif qc_status in RESTRICTED_QC_STATUSES:
            entry["restricted_current"] += current_amount
        else:
            entry["unclassified_current"] += current_amount
            unknown_qc_statuses.add("missing" if qc_status is None else str(qc_status))
            entry["recommendation_issues"].add("quality_status_unclassified")
        entry["warehouse_codes"].add(warehouse["code"])
        entry["warehouse_names"].add(warehouse["name"])
        entry["last_updated"] = _later_iso(
            entry["last_updated"], _iso_from_ms(row.get("updatedAt") or row.get("createdAt"))
        )

    # The daily report compares two durable 08:00 snapshots.  It never infers
    # this value from movement rows because those rows may be batch/location
    # scoped rather than the warehouse-wide stock balance.
    inventory_history = []
    if prefer_stored or persist:
        try:
            inventory_history = load_inventory_history(limit=2)
        except Exception:
            warnings.append("Stored inventory history could not be read; the 24-hour comparison is unavailable.")
    if len(inventory_history) >= 2:
        current_snapshot, previous_snapshot = inventory_history[:2]
        current_date = current_snapshot.snapshot_date
        previous_date = previous_snapshot.snapshot_date
        if (
            current_date is not None
            and previous_date is not None
            and current_date - previous_date == timedelta(days=1)
        ):
            comparison_start = datetime.combine(
                previous_date,
                time(hour=BUSINESS_DAY_START_HOUR),
                tzinfo=SHANGHAI,
            )
            comparison_end = datetime.combine(
                current_date,
                time(hour=BUSINESS_DAY_START_HOUR),
                tzinfo=SHANGHAI,
            )
            response["meta"]["comparison_available"] = True
            response["meta"]["comparison_start_at"] = comparison_start.isoformat()
            response["meta"]["comparison_end_at"] = comparison_end.isoformat()
            for snapshot, quantity_field, usable_field in (
                (
                    current_snapshot,
                    "comparison_current",
                    "comparison_usable",
                ),
                (previous_snapshot, "previous_current", "previous_usable"),
            ):
                for row in snapshot.rows:
                    warehouse = _warehouse_from_inventory(row)
                    if warehouse["code"] not in selected_codes:
                        continue
                    material = row.get("material") or {}
                    material = material if isinstance(material, dict) else {}
                    amount = row.get("amount") or {}
                    amount = amount if isinstance(amount, dict) else {}
                    quantity = _optional_decimal(amount.get("amount"))
                    if quantity is None:
                        continue
                    unit = _unit(amount) or _unknown_unit(material, row.get("id"))
                    key = _material_key(material, unit, fallback=row.get("id"))
                    entry = materials.setdefault(
                        key, _material_seed(material, unit, warehouse)
                    )
                    if entry[quantity_field] is None:
                        entry[quantity_field] = Decimal("0")
                        entry[usable_field] = Decimal("0")
                    entry[quantity_field] += quantity
                    if _qc_status_code(row) in USABLE_QC_STATUSES:
                        entry[usable_field] += quantity
                    entry["warehouse_codes"].add(warehouse["code"])
                    entry["warehouse_names"].add(warehouse["name"])
            for entry in materials.values():
                if entry["previous_current"] is None:
                    entry["previous_current"] = Decimal("0")
                    entry["previous_usable"] = Decimal("0")
                if entry["comparison_current"] is None:
                    entry["comparison_current"] = Decimal("0")
                    entry["comparison_usable"] = Decimal("0")
        else:
            warnings.append(
                "The two latest stored inventory snapshots are not consecutive 08:00 business days; "
                "an exact 24-hour comparison was not calculated."
            )
    elif prefer_stored or persist:
        warnings.append(
            "The 24-hour comparison will be available after two consecutive 08:00 inventory snapshots."
        )

    if unknown_qc_statuses:
        warnings.append(
            "MES inventory contains missing or unrecognised quality status code(s); "
            "those quantities were excluded from order-available stock: "
            + ", ".join(sorted(unknown_qc_statuses))
        )
        response["status"] = "partial"
    business_today = _business_date(now)
    start_date = business_today - timedelta(days=lookback_days - 1)
    statistics_end = business_today - timedelta(days=1)
    statistics_start = statistics_end - timedelta(days=lookback_days - 1)
    start_dt = datetime.combine(
        statistics_start,
        time(hour=BUSINESS_DAY_START_HOUR),
        tzinfo=SHANGHAI,
    )
    filters = {
        "dateStart": int(start_dt.timestamp() * 1000),
        "dateEnd": int(now.timestamp() * 1000),
        "warehouseIds": [
            int(value) if value.isdigit() else value for value in sorted(selected_ids)
        ],
    }
    if not selected_ids:
        change_rows = []
        sources["inventory_change_log"] = {
            "status": "skipped",
            "cached": False,
            "record_count": 0,
        }
        warnings.append(
            "MES inventory change log was not requested because no selected warehouse had a MES ID."
        )
        global_recommendation_issues.add("warehouse_id_missing")
    elif prefer_stored:
        stored_change = None
        try:
            stored_change = load_change_dataset(
                sorted(selected_codes),
                sorted(selected_ids),
                lookback_days,
                snapshot_date=(
                    stored_inventory.snapshot_date if stored_inventory else None
                ),
                capture_type=(
                    stored_inventory.capture_type if stored_inventory else None
                ),
            )
        except Exception:
            warnings.append("Stored MES inventory movements could not be read.")
        if stored_change is None:
            change_rows = []
            sources["inventory_change_log"] = {
                "status": "missing",
                "cached": False,
                "record_count": 0,
            }
            warnings.append(
                "No stored MES movement dataset covers the selected warehouse and analysis period. "
                "Run the daily or manual MES update."
            )
            response["status"] = "partial"
            global_recommendation_issues.add("inventory_change_log_not_synced")
        else:
            change_rows = stored_change.rows
            refreshed_at = stored_change.refreshed_at.isoformat()
            sources["inventory_change_log"] = {
                "status": "stored",
                "cached": False,
                "record_count": len(change_rows),
                "refreshed_at": refreshed_at,
            }
            current_synced = response["meta"].get("snapshot_synced_at")
            if not current_synced or refreshed_at > current_synced:
                response["meta"]["snapshot_synced_at"] = refreshed_at
    else:
        try:
            change_rows, changes_cached, page_warnings = _fetch_pages(
                call_inventory_change_log,
                cache_kind="inventory-change-log",
                filters=filters,
                cache_key_filters={
                    "dateStart": filters["dateStart"],
                    "warehouseIds": filters["warehouseIds"],
                },
                force_refresh=force_refresh,
            )
            warnings.extend(page_warnings)
            if page_warnings:
                response["status"] = "partial"
                global_recommendation_issues.add("change_log_pagination_incomplete")
            sources["inventory_change_log"] = {
                "status": "partial" if page_warnings else "ok",
                "cached": changes_cached,
                "record_count": len(change_rows),
            }
            if persist and not page_warnings:
                latest = _latest_source_iso(change_rows, "createdAt")
                try:
                    stored = save_mes_dataset(
                        kind="change",
                        rows=change_rows,
                        warehouse_codes=sorted(selected_codes),
                        warehouse_ids=sorted(selected_ids),
                        lookback_days=lookback_days,
                        range_start=start_dt,
                        range_end=now,
                        source_latest_at=(
                            datetime.fromisoformat(latest) if latest else None
                        ),
                        snapshot_date=_business_date(now),
                    )
                    refreshed_at = stored.refreshed_at.isoformat()
                    current_synced = response["meta"].get("snapshot_synced_at")
                    if not current_synced or refreshed_at > current_synced:
                        response["meta"]["snapshot_synced_at"] = refreshed_at
                except Exception:
                    warnings.append(
                        "MES movements were loaded but could not be saved for dashboard reads."
                    )
                    response["status"] = "partial"
        except Exception as exc:
            change_rows = []
            sources["inventory_change_log"] = {
                "status": "error",
                "cached": False,
                "record_count": 0,
            }
            warnings.append(
                f"MES inventory change log unavailable: {_safe_upstream_error(exc)}"
            )
            response["status"] = "partial"
            global_recommendation_issues.add("inventory_change_log_unavailable")

    if change_rows_output is not None:
        change_rows_output.clear()
        change_rows_output.extend(change_rows)

    warehouse_code_by_name = {row["name"]: row["code"] for row in selected if row["name"]}
    trend_values: dict[str, dict[str, dict[str, Decimal]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(Decimal))
    )
    recent: list[dict[str, Any]] = []
    unknown_actions: set[str] = set()
    direction_conflicts: set[str] = set()
    invalid_timestamp_count = 0
    invalid_change_quantity_count = 0
    outside_range_timestamp_count = 0
    unattributed_warehouse_count = 0

    for row in change_rows:
        warehouse_raw = row.get("warehouse")
        if isinstance(warehouse_raw, dict):
            warehouse_name = _text(warehouse_raw.get("name"))
            warehouse_code = _text(warehouse_raw.get("code"))
        else:
            warehouse_name = _text(warehouse_raw)
            warehouse_code = warehouse_code_by_name.get(warehouse_name, "")
        if warehouse_code and warehouse_code not in selected_codes:
            continue
        if not warehouse_code and warehouse_name and warehouse_name not in selected_names:
            continue
        if not warehouse_code and not warehouse_name:
            # An unfiltered fallback response cannot be attributed safely.
            unattributed_warehouse_count += 1
            continue

        material = row.get("material") or {}
        material = material if isinstance(material, dict) else {}
        amount_info = row.get("amount") or {}
        amount_info = amount_info if isinstance(amount_info, dict) else {}
        changed = amount_info.get("amount") or {}
        changed = changed if isinstance(changed, dict) else {}
        after = amount_info.get("afterAmount") or {}
        after = after if isinstance(after, dict) else {}
        action_info = row.get("action") or {}
        if isinstance(action_info, dict):
            action_code = _text(
                action_info.get("action") or action_info.get("code")
            ).casefold()
            action_label = _text(
                action_info.get("desc") or action_info.get("message")
            )
        else:
            action_code = _text(action_info).casefold()
            action_label = ""
        parsed_quantity = _optional_decimal(changed.get("amount"))
        if parsed_quantity is None:
            if action_code == "attr_adjust":
                # Attribute-only changes have no stock quantity in this API and
                # must not make consumption/reorder statistics look incomplete.
                continue
            invalid_change_quantity_count += 1
            continue
        quantity = abs(parsed_quantity)
        unit = _unit(changed) or _unit(after)
        unit_missing = not unit
        if unit_missing:
            missing_unit_record_count += 1
            unit = _unknown_unit(material, row.get("id"))
        direction_in = _direction_is_in(amount_info.get("direction"), action_code)
        action_label = action_label or ACTION_LABELS.get(action_code, action_code)
        created_at = _iso_from_ms(row.get("createdAt"))
        if not created_at:
            invalid_timestamp_count += 1
            continue
        created_dt = datetime.fromisoformat(created_at)
        if created_dt < start_dt or created_dt > now:
            outside_range_timestamp_count += 1
            continue
        day_date = _business_date(created_dt)
        day = day_date.isoformat()
        in_trend_window = start_date <= day_date <= business_today
        in_statistics_window = statistics_start <= day_date <= statistics_end

        warehouse = {"code": warehouse_code, "name": warehouse_name}
        key = _material_key(material, unit, fallback=row.get("id"))
        transaction_material = dict(material)
        transaction_material.setdefault("specification", row.get("specification"))
        entry = materials.setdefault(
            key, _material_seed(transaction_material, unit, warehouse)
        )
        if unit_missing:
            entry["recommendation_issues"].add("main_unit_missing")
        entry["warehouse_codes"].add(warehouse_code)
        entry["warehouse_names"].add(warehouse_name)
        entry["last_updated"] = _later_iso(entry["last_updated"], created_at)

        day_metrics = trend_values[day][unit]
        if action_code in ADJUSTMENT_ACTIONS:
            signed = quantity if direction_in else -quantity
            if in_trend_window:
                entry["adjustment"] += signed
                day_metrics["adjustment"] += signed
        elif direction_in:
            if in_trend_window:
                entry["inbound"] += quantity
                day_metrics["inbound"] += quantity
            if action_code in OUTBOUND_ACTIONS:
                direction_conflicts.add(action_code)
                entry["recommendation_issues"].add("action_direction_conflict")
        else:
            if in_trend_window:
                entry["outbound"] += quantity
                day_metrics["outbound"] += quantity
            if action_code in TRANSFER_OUT_ACTIONS:
                if in_trend_window:
                    entry["transfer_out"] += quantity
                    day_metrics["transfer_out"] += quantity
            elif action_code in CONSUMPTION_ACTIONS:
                if in_trend_window:
                    entry["consumption"] += quantity
                    day_metrics["consumption"] += quantity
                if in_statistics_window:
                    entry["daily_consumption"][day] += quantity
            elif action_code in INBOUND_ACTIONS:
                direction_conflicts.add(action_code)
                entry["recommendation_issues"].add("action_direction_conflict")

        if action_code not in INBOUND_ACTIONS | OUTBOUND_ACTIONS | ADJUSTMENT_ACTIONS:
            unknown_actions.add(action_code or "(empty)")
            entry["recommendation_issues"].add("action_unclassified")

        biz_attr = row.get("bizAttr") or {}
        biz_attr = biz_attr if isinstance(biz_attr, dict) else {}
        if in_trend_window:
            recent.append(
                {
                    "id": _text(row.get("id")),
                    "created_at": created_at,
                    "action_code": action_code,
                    "action_label": action_label,
                    "direction": "in" if direction_in else "out",
                    "quantity": _number(quantity),
                    "unit": unit,
                    "after_quantity": _number(after.get("amount")),
                    "material_id": _text(material.get("id")),
                    "material_code": _text(material.get("code")),
                    "material_name": _text(material.get("name")),
                    "specification": _text(
                        row.get("specification") or material.get("specification")
                    ),
                    "warehouse_name": warehouse_name,
                    "storage_location": _text(row.get("storageLocation")),
                    "batch_no": _text(row.get("batchNo")),
                    "operator": _text(row.get("operator")),
                    "supplier_name": _text(biz_attr.get("supplierName")),
                    "is_consumption": action_code in CONSUMPTION_ACTIONS
                    and not direction_in,
                    "is_transfer_out": action_code in TRANSFER_OUT_ACTIONS
                    and not direction_in,
                }
            )

    if unknown_actions:
        warnings.append(
            "Unclassified MES action(s) were excluded from consumption/recommendations: "
            + ", ".join(sorted(unknown_actions))
        )
        response["status"] = "partial"
    if direction_conflicts:
        warnings.append(
            "MES action/direction conflict detected; physical in/out followed the direction flag: "
            + ", ".join(sorted(direction_conflicts))
        )
        response["status"] = "partial"
    if invalid_timestamp_count:
        warnings.append(
            f"Skipped {invalid_timestamp_count} MES change log row(s) with a missing or invalid timestamp."
        )
        response["status"] = "partial"
        global_recommendation_issues.add("change_timestamp_invalid")
    if invalid_inventory_quantity_count:
        warnings.append(
            f"Skipped {invalid_inventory_quantity_count} MES inventory record(s) with a missing, invalid, or non-finite quantity."
        )
        response["status"] = "partial"
    if invalid_change_quantity_count:
        warnings.append(
            f"Skipped {invalid_change_quantity_count} MES change log row(s) with a missing, invalid, or non-finite quantity."
        )
        response["status"] = "partial"
        global_recommendation_issues.add("change_quantity_invalid")
    if outside_range_timestamp_count:
        warnings.append(
            f"Skipped {outside_range_timestamp_count} MES change log row(s) outside the requested timestamp range."
        )
        response["status"] = "partial"
        global_recommendation_issues.add("change_timestamp_outside_range")
    if unattributed_warehouse_count:
        warnings.append(
            f"Skipped {unattributed_warehouse_count} MES change log row(s) without an attributable warehouse."
        )
        response["status"] = "partial"
        global_recommendation_issues.add("change_warehouse_unattributed")
    if missing_unit_record_count:
        warnings.append(
            f"MES returned {missing_unit_record_count} inventory/change record(s) without a main unit; "
            "each affected material was isolated under an UNKNOWN unit and excluded from reliable recommendations."
        )
        response["status"] = "partial"
    if invalid_inventory_quantity_count and sources["inventory_detail"]["status"] == "ok":
        sources["inventory_detail"]["status"] = "partial"
    if response["status"] == "partial" and sources["inventory_change_log"]["status"] == "ok":
        if (
            invalid_timestamp_count
            or invalid_change_quantity_count
            or outside_range_timestamp_count
            or unattributed_warehouse_count
        ):
            sources["inventory_change_log"]["status"] = "partial"

    if response["meta"]["comparison_available"]:
        for entry in materials.values():
            if entry["previous_current"] is None:
                entry["previous_current"] = Decimal("0")
                entry["previous_usable"] = Decimal("0")
            if entry["comparison_current"] is None:
                entry["comparison_current"] = Decimal("0")
                entry["comparison_usable"] = Decimal("0")

    dates = [(start_date + timedelta(days=offset)).isoformat() for offset in range(lookback_days)]
    statistics_dates = [
        (statistics_start + timedelta(days=offset)).isoformat()
        for offset in range(lookback_days)
    ]
    material_rows: list[dict[str, Any]] = []
    for entry in materials.values():
        recommendation_issues = sorted(
            global_recommendation_issues | entry["recommendation_issues"]
        )
        recommendation_available = not recommendation_issues
        daily = [
            entry["daily_consumption"].get(day, Decimal("0"))
            for day in statistics_dates
        ]
        average = sum(daily, Decimal("0")) / Decimal(lookback_days)
        variance = sum(((value - average) ** 2 for value in daily), Decimal("0")) / Decimal(
            lookback_days
        )
        stddev = variance.sqrt() if variance else Decimal("0")
        safety = SERVICE_LEVEL_Z * stddev * Decimal(lead_time_days).sqrt()
        reorder_point = average * Decimal(lead_time_days) + safety
        target = average * Decimal(lead_time_days + review_period_days) + safety
        calculated_recommended = max(target - entry["usable_current"], Decimal("0"))
        recommended = calculated_recommended if recommendation_available else Decimal("0")
        if average <= 0:
            risk = "critical" if entry["usable_current"] < 0 else "no_usage"
            cover = None
        else:
            cover = entry["usable_current"] / average
            risk = "critical" if entry["usable_current"] <= reorder_point else (
                "watch" if entry["usable_current"] < target else "healthy"
            )
        if not recommendation_available:
            risk = "unknown"
        material_rows.append(
            {
                "material_id": entry["material_id"],
                "material_code": entry["material_code"],
                "material_name": entry["material_name"],
                "specification": entry["specification"],
                "unit": entry["unit"],
                "current_quantity": _number(entry["current"]),
                "usable_quantity": _number(entry["usable_current"]),
                "previous_quantity": (
                    _number(entry["previous_current"])
                    if entry["previous_current"] is not None
                    else None
                ),
                "comparison_current_quantity": (
                    _number(entry["comparison_current"])
                    if entry["comparison_current"] is not None
                    else None
                ),
                "quantity_change_24h": (
                    _number(entry["comparison_current"] - entry["previous_current"])
                    if (
                        entry["comparison_current"] is not None
                        and entry["previous_current"] is not None
                    )
                    else None
                ),
                "previous_usable_quantity": (
                    _number(entry["previous_usable"])
                    if entry["previous_usable"] is not None
                    else None
                ),
                "comparison_current_usable_quantity": (
                    _number(entry["comparison_usable"])
                    if entry["comparison_usable"] is not None
                    else None
                ),
                "usable_change_24h": (
                    _number(entry["comparison_usable"] - entry["previous_usable"])
                    if (
                        entry["comparison_usable"] is not None
                        and entry["previous_usable"] is not None
                    )
                    else None
                ),
                "restricted_quantity": _number(entry["restricted_current"]),
                "unclassified_quantity": _number(entry["unclassified_current"]),
                "inbound_quantity": _number(entry["inbound"]),
                "outbound_quantity": _number(entry["outbound"]),
                "consumption_quantity": _number(entry["consumption"]),
                "transfer_out_quantity": _number(entry["transfer_out"]),
                "adjustment_quantity": _number(entry["adjustment"]),
                "avg_daily_consumption": _number(average),
                "usage_stddev": _number(stddev),
                "safety_stock": _number(safety),
                "reorder_point": _number(reorder_point),
                "target_stock": _number(target),
                "recommended_order": _number(recommended),
                "recommendation_available": recommendation_available,
                "recommendation_status": (
                    "available" if recommendation_available else "insufficient_data"
                ),
                "recommendation_issues": recommendation_issues,
                "days_of_cover": _number(cover) if cover is not None else None,
                "risk": risk,
                "warehouse_codes": sorted(filter(None, entry["warehouse_codes"])),
                "warehouse_names": sorted(filter(None, entry["warehouse_names"])),
                "last_updated": entry["last_updated"],
            }
        )
    material_rows.sort(
        key=lambda row: (
            RISK_ORDER[row["risk"]],
            -row["recommended_order"],
            row["material_code"],
            row["unit"],
        )
    )

    units = sorted({entry["unit"] for entry in materials.values()})
    quantity_rows = []
    for unit in units:
        entries = [entry for entry in materials.values() if entry["unit"] == unit]
        matching_material_rows = [row for row in material_rows if row["unit"] == unit]
        quantity_rows.append(
            {
                "unit": unit,
                "current": _number(sum((entry["current"] for entry in entries), Decimal("0"))),
                "usable": _number(sum((entry["usable_current"] for entry in entries), Decimal("0"))),
                "previous_current": (
                    _number(
                        sum(
                            (entry["previous_current"] for entry in entries),
                            Decimal("0"),
                        )
                    )
                    if response["meta"]["comparison_available"]
                    else None
                ),
                "comparison_current": (
                    _number(
                        sum(
                            (entry["comparison_current"] for entry in entries),
                            Decimal("0"),
                        )
                    )
                    if response["meta"]["comparison_available"]
                    else None
                ),
                "change_24h": (
                    _number(
                        sum(
                            (
                                entry["comparison_current"]
                                - entry["previous_current"]
                                for entry in entries
                            ),
                            Decimal("0"),
                        )
                    )
                    if response["meta"]["comparison_available"]
                    else None
                ),
                "restricted": _number(sum((entry["restricted_current"] for entry in entries), Decimal("0"))),
                "unclassified": _number(sum((entry["unclassified_current"] for entry in entries), Decimal("0"))),
                "inbound": _number(sum((entry["inbound"] for entry in entries), Decimal("0"))),
                "outbound": _number(sum((entry["outbound"] for entry in entries), Decimal("0"))),
                "consumption": _number(sum((entry["consumption"] for entry in entries), Decimal("0"))),
                "transfer_out": _number(sum((entry["transfer_out"] for entry in entries), Decimal("0"))),
                "adjustment": _number(sum((entry["adjustment"] for entry in entries), Decimal("0"))),
                "recommended_order": sum(row["recommended_order"] for row in matching_material_rows),
                "recommendation_unavailable_count": sum(
                    not row["recommendation_available"] for row in matching_material_rows
                ),
            }
        )

    current_by_unit = {
        unit: sum(
            (entry["current"] for entry in materials.values() if entry["unit"] == unit),
            Decimal("0"),
        )
        for unit in units
    }
    closing_by_date: dict[str, dict[str, Decimal]] = defaultdict(dict)
    running = dict(current_by_unit)
    for day in reversed(dates):
        for unit in units:
            closing_by_date[day][unit] = running[unit]
            metrics = trend_values[day][unit]
            net = metrics["inbound"] - metrics["outbound"] + metrics["adjustment"]
            running[unit] -= net

    trend = []
    for day in dates:
        values = []
        for unit in units:
            metrics = trend_values[day][unit]
            net = metrics["inbound"] - metrics["outbound"] + metrics["adjustment"]
            values.append(
                {
                    "unit": unit,
                    "inbound": _number(metrics["inbound"]),
                    "outbound": _number(metrics["outbound"]),
                    "consumption": _number(metrics["consumption"]),
                    "transfer_out": _number(metrics["transfer_out"]),
                    "adjustment": _number(metrics["adjustment"]),
                    "net_change": _number(net),
                    "estimated_closing_stock": _number(closing_by_date[day][unit]),
                }
            )
        trend.append({"date": day, "values": values})

    recent.sort(key=lambda row: row["created_at"] or "", reverse=True)
    recommendations_available = any(
        row["recommendation_available"] for row in material_rows
    )
    recommendations_complete = bool(material_rows) and all(
        row["recommendation_available"] for row in material_rows
    )
    response["meta"]["recommendations_available"] = recommendations_available
    response["meta"]["recommendations_complete"] = recommendations_complete
    response["meta"]["recommendation_issues"] = sorted(global_recommendation_issues)
    response["units"] = units
    response["summary"] = {
        "material_count": len(material_rows),
        "inventory_record_count": len(selected_inventory),
        "reorder_count": sum(
            row["recommendation_available"] and row["recommended_order"] > 0
            for row in material_rows
        ),
        "recommendation_unavailable_count": sum(
            not row["recommendation_available"] for row in material_rows
        ),
        "critical_count": sum(row["risk"] == "critical" for row in material_rows),
        "watch_count": sum(row["risk"] == "watch" for row in material_rows),
        "quantities": quantity_rows,
    }
    response["trend"] = trend
    response["materials"] = material_rows
    response["recent_transactions"] = recent[:100]
    inventory_source_times = [
        value
        for value in (
            _iso_from_ms(row.get("updatedAt") or row.get("createdAt"))
            for row in selected_inventory
        )
        if value
    ]
    change_log_source_times = [row["created_at"] for row in recent if row["created_at"]]
    inventory_source_latest_at = (
        max(inventory_source_times) if inventory_source_times else None
    )
    response["meta"]["inventory_source_latest_at"] = inventory_source_latest_at
    response["meta"]["change_log_source_latest_at"] = (
        max(change_log_source_times) if change_log_source_times else None
    )
    # Preserve the original field for older clients, but define it specifically
    # as the inventory-detail freshness so a recent movement cannot make stale
    # current-stock data appear fresh.
    response["meta"]["source_latest_at"] = inventory_source_latest_at
    return response


__all__ = ["build_raw_material_overview", "with_zero_stock_markers"]
