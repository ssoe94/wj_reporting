"""Auditable JIT/CSKD outbound-plan performance from BLACKLAKE MES.

The app-authorized ``outbound_order/_list`` OpenAPI returns outbound-order
headers and their ``items`` material lines.  This module deliberately
aggregates those plan-cohort lines instead of trying to infer targets from
inventory movements.
"""

from __future__ import annotations

import copy
import re
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests
from django.core.cache import cache
from django.utils import timezone

from inventory.mes import (
    MES_BASE_URL,
    MES_ROUTE_BASE,
    _safe_exception_message,
    get_access_token,
)


SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
OUTBOUND_ORDER_LIST_ENDPOINT = (
    f"{MES_ROUTE_BASE}/inventory/open/v1/outbound_order/_list"
)
PAGE_SIZE = 200
MAX_PAGES = 20
CACHE_SECONDS = 5 * 60
CACHE_KEY_PREFIX = "overview-board:outbound-performance:v4"
MAX_PRIORITY_ITEMS = 10
FETCH_AUDIT_KEYS = (
    "upstream_order_total",
    "orders_fetched",
    "raw_item_line_count",
    "pages_fetched",
    "item_shape_warning_count",
    "orders_with_empty_items",
)
AUTH_EXPIRED_BODY_CODES = frozenset({
    "401",
    "40101",
    "401001",
    "3401",
    "400150",
    "TOKEN_EXPIRED",
    "ACCESS_TOKEN_EXPIRED",
    "INVALID_ACCESS_TOKEN",
    "TOKEN_NOT_FOUND",
    "USER-DOMAIN/SSO_TOKEN_FAIL",
})
PERMISSION_DENIED_TOKENS = (
    "permission denied",
    "permission insufficient",
    "forbidden",
    "无权限",
    "没有权限",
    "权限不足",
    "未开通",
    "未授权接口",
    "接口未授权",
)
OUTBOUND_STATUS_LABELS = {
    # Current BLACKLAKE Bound.BizStatus values.
    10: "created",
    20: "issued",
    30: "in_execution",
    40: "completed",
    50: "closed",
    # Compatibility with tenants that still expose the legacy ordinal values.
    0: "created",
    1: "issued",
    2: "in_execution",
    3: "completed",
    4: "closed",
}

PERIOD_KEYS = ("today", "previous_week", "previous_month")
CATEGORY_KEYS = ("JIT", "CSKD")
CSKD_ALIASES = frozenset({"CSKD", "CKD", "CSK", "CSD"})
PIECE_UNITS = frozenset({
    "EA",
    "EACH",
    "PC",
    "PCS",
    "PIECE",
    "PIECES",
    "个",
    "件",
    "只",
})
INCOMPATIBLE_UNIT_TOKENS = frozenset({
    "KG",
    "KGS",
    "KILOGRAM",
    "KILOGRAMS",
    "G",
    "GRAM",
    "GRAMS",
    "T",
    "TON",
    "TONNE",
    "L",
    "LITER",
    "LITRE",
    "ML",
    "M",
    "METER",
    "METRE",
    "M2",
    "M3",
    "BOX",
    "BOXES",
    "CARTON",
    "CARTONS",
    "PALLET",
    "PALLETS",
    "SET",
    "SETS",
    "公斤",
    "千克",
    "克",
    "吨",
    "噸",
    "升",
    "毫升",
    "米",
    "平方米",
    "立方米",
    "箱",
    "盒",
    "托",
    "套",
})
CANCELLED_STATUS_TOKENS = frozenset({
    "CANCEL",
    "CANCELED",
    "CANCELLED",
    "DELETE",
    "DELETED",
    "VOID",
    "VOIDED",
    "WITHDRAW",
    "WITHDRAWN",
    "ABOLISHED",
    "作废",
    "已作废",
    "撤回",
    "已撤回",
    "删除",
    "已删除",
})


class OutboundPerformanceError(RuntimeError):
    """Raised when MES cannot provide a trustworthy outbound line set."""

    def __init__(
        self,
        message: str,
        *,
        audit: Mapping[str, Any] | None = None,
        warnings: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.audit = _fetch_audit_payload(audit)
        self.warnings = sorted(set(warnings or []))


def _fetch_audit_payload(
    values: Mapping[str, Any] | None = None,
) -> dict[str, int | None]:
    values = values or {}
    return {
        "upstream_order_total": values.get("upstream_order_total"),
        "orders_fetched": int(values.get("orders_fetched") or 0),
        "raw_item_line_count": int(values.get("raw_item_line_count") or 0),
        "pages_fetched": int(values.get("pages_fetched") or 0),
        "item_shape_warning_count": int(
            values.get("item_shape_warning_count") or 0
        ),
        "orders_with_empty_items": int(
            values.get("orders_with_empty_items") or 0
        ),
    }


def _business_datetime(day: date) -> datetime:
    return datetime.combine(day, time(hour=8), tzinfo=SHANGHAI_TZ)


def _period_windows(target_date: date) -> dict[str, tuple[datetime, datetime]]:
    today_start = _business_datetime(target_date)
    current_week_start_date = target_date - timedelta(days=target_date.weekday())
    previous_week_start = _business_datetime(
        current_week_start_date - timedelta(days=7)
    )
    previous_week_end = _business_datetime(current_week_start_date)

    current_month_start = target_date.replace(day=1)
    previous_month_last = current_month_start - timedelta(days=1)
    previous_month_start = _business_datetime(previous_month_last.replace(day=1))
    previous_month_end = _business_datetime(current_month_start)
    return {
        "today": (today_start, today_start + timedelta(days=1)),
        "previous_week": (previous_week_start, previous_week_end),
        "previous_month": (previous_month_start, previous_month_end),
    }


def _empty_metric(*, available: bool) -> dict[str, Any]:
    value: int | None = 0 if available else None
    return {
        "target_qty": value,
        "fulfilled_qty": value,
        "completion_rate": None,
        "order_count": value,
        "line_count": value,
        "unit": "EA",
    }


def _period_payloads(
    windows: Mapping[str, tuple[datetime, datetime]],
    *,
    available: bool,
) -> dict[str, dict[str, Any]]:
    now = timezone.now().astimezone(SHANGHAI_TZ)
    return {
        key: {
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "is_complete": now >= end,
            **{
                category: _empty_metric(available=available)
                for category in CATEGORY_KEYS
            },
        }
        for key, (start, end) in windows.items()
    }


def _empty_detail_metric(*, available: bool) -> dict[str, Any]:
    value: int | None = 0 if available else None
    return {
        "pending_line_count": value,
        "complete_line_count": value,
        "over_line_count": value,
        "zero_fulfilled_line_count": value,
        "remaining_qty": value,
        "over_qty": value,
        "unit": "EA",
        "largest_pending": None,
    }


def _today_detail_summary(*, available: bool) -> dict[str, dict[str, Any]]:
    return {
        category: _empty_detail_metric(available=available)
        for category in CATEGORY_KEYS
    }


def _measurement_basis() -> dict[str, str]:
    return {
        "cohort": (
            "MES outbound-order lines grouped by planTime in Asia/Shanghai "
            "08:00-aligned business periods"
        ),
        "target_qty": "sum of eligible outboundOrder item planAmount",
        "fulfilled_qty": (
            "current cumulative doneAmount on the same planned-outbound cohort; "
            "not an actual dispatch-event-time cohort"
        ),
        "detail_source": (
            "outbound_order/_list items[] material rows only; order headers are used "
            "only for classification, status, warehouse, and planned-time filters"
        ),
        "historical_comparison": (
            "previous_week and previous_month use current cumulative doneAmount "
            "observed at fetch time for each completed planned-time cohort; they "
            "are not historical as-of-period snapshots"
        ),
        "classification": (
            "exact alphanumeric order-code tokens: JIT; CSKD aliases "
            "CSKD/CKD/CSK/CSD; conflicts excluded as defects and unclassified "
            "orders reported separately as expected out-of-scope traffic"
        ),
        "eligible_unit": (
            "piece units only (EA/EACH/PC/PCS/PIECE and Chinese 个/件/只), "
            "normalized to EA"
        ),
        "period_policy": (
            "today is target business date 08:00 to next 08:00; previous_week "
            "and previous_month are prior complete calendar periods with 08:00 boundaries"
        ),
    }


def _unavailable_payload(
    target_date: date,
    *,
    warning: str = "outbound_performance_unavailable",
    audit: Mapping[str, Any] | None = None,
    extra_warnings: list[str] | None = None,
) -> dict[str, Any]:
    windows = _period_windows(target_date)
    warnings = sorted(set([warning, *(extra_warnings or [])]))
    return {
        "status": "unavailable",
        "fetched_at": None,
        "cache_status": "miss",
        "measurement_basis": _measurement_basis(),
        "periods": _period_payloads(windows, available=False),
        "today_detail_summary": _today_detail_summary(available=False),
        "today_priority_items": [],
        "unclassified": {"order_count": None, "line_count": None},
        "accepted_line_count": None,
        "excluded_line_count": None,
        "deduplicated_line_count": None,
        "covered_order_count": None,
        "ignored_outside_period_line_count": None,
        "exclusions_by_reason": {},
        "warnings": warnings,
        **_fetch_audit_payload(audit),
    }


def _error_payload_text(payload: Mapping[str, Any]) -> str:
    values = [
        payload.get("code"),
        payload.get("subCode"),
        payload.get("sub_code"),
        payload.get("message"),
        payload.get("msg"),
    ]
    return " ".join(str(value) for value in values if value not in (None, ""))


def _is_permission_denied_payload(payload: Mapping[str, Any]) -> bool:
    text = _error_payload_text(payload).casefold()
    return any(token.casefold() in text for token in PERMISSION_DENIED_TOKENS)


def _is_auth_expired_payload(payload: Mapping[str, Any]) -> bool:
    """Recognize token expiry without retrying authorization failures."""

    if _is_permission_denied_payload(payload):
        return False
    codes = {
        str(payload.get(key) or "").strip().upper()
        for key in ("code", "subCode", "sub_code")
    }
    if codes.intersection(AUTH_EXPIRED_BODY_CODES):
        return True
    text = _error_payload_text(payload).casefold()
    mentions_token = "token" in text or "令牌" in text
    mentions_expiry = any(
        token in text
        for token in (
            "expired",
            "invalid",
            "过期",
            "已过期",
            "失效",
            "无效",
        )
    )
    return mentions_token and mentions_expiry


def _post_mes(body: Mapping[str, Any]) -> dict[str, Any]:
    try:
        token = get_access_token()
    except Exception as exc:
        raise OutboundPerformanceError(_safe_exception_message(exc)) from None

    response = None
    for refresh in (False, True):
        url = (
            f"{MES_BASE_URL}{OUTBOUND_ORDER_LIST_ENDPOINT}"
            f"?access_token={quote(str(token), safe='')}"
        )
        try:
            response = requests.post(url, json=dict(body), timeout=(5, 15))
            if response.status_code == 401 and not refresh:
                try:
                    token = get_access_token(force_refresh=True)
                except Exception as exc:
                    raise OutboundPerformanceError(
                        _safe_exception_message(exc)
                    ) from None
                continue
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise OutboundPerformanceError(_safe_exception_message(exc)) from None

        if not isinstance(payload, Mapping):
            raise OutboundPerformanceError("MES returned an invalid JSON object")
        if payload.get("code") not in (None, 200, "200"):
            if not refresh and _is_auth_expired_payload(payload):
                try:
                    token = get_access_token(force_refresh=True)
                except Exception as exc:
                    raise OutboundPerformanceError(
                        _safe_exception_message(exc)
                    ) from None
                continue
            message = _safe_exception_message(
                RuntimeError(payload.get("message") or "MES outbound order-list error")
            )
            raise OutboundPerformanceError(message)
        return copy.deepcopy(dict(payload))

    status = response.status_code if response is not None else 502
    raise OutboundPerformanceError(f"MES authentication failed ({status})")


def _page_rows(payload: Mapping[str, Any]) -> tuple[list[dict[str, Any]], int | None]:
    candidates: list[Any] = [payload]
    for _depth in range(4):
        next_candidates: list[Any] = []
        for candidate in candidates:
            if isinstance(candidate, list):
                rows = [dict(row) for row in candidate if isinstance(row, Mapping)]
                if candidate and len(rows) != len(candidate):
                    raise OutboundPerformanceError(
                        "MES outbound order-list contains malformed order rows"
                    )
                return rows, len(candidate)
            if not isinstance(candidate, Mapping):
                continue
            for key in ("list", "rows", "results", "items"):
                rows = candidate.get(key)
                if isinstance(rows, list):
                    total_raw = candidate.get("total", candidate.get("count"))
                    try:
                        total = int(total_raw) if total_raw is not None else None
                    except (TypeError, ValueError):
                        total = None
                    normalized_rows = [
                        dict(row) for row in rows if isinstance(row, Mapping)
                    ]
                    if rows and len(normalized_rows) != len(rows):
                        raise OutboundPerformanceError(
                            "MES outbound order-list contains malformed order rows"
                        )
                    return normalized_rows, total
            for key in ("data", "result", "payload"):
                nested = candidate.get(key)
                if isinstance(nested, (Mapping, list)):
                    next_candidates.append(nested)
        candidates = next_candidates
    raise OutboundPerformanceError("MES outbound order-list response has no list")


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Mapping):
        return any(_has_value(item) for item in value.values())
    if isinstance(value, (list, tuple, set)):
        return any(_has_value(item) for item in value)
    return True


def _flatten_order_rows(
    page_rows: list[dict[str, Any]],
    *,
    page_number: int,
) -> tuple[
    list[dict[str, Any]],
    tuple[tuple[str, ...], ...],
    bool,
    list[str],
    dict[str, int],
]:
    """Flatten official order ``items`` while retaining header provenance.

    The official app OpenAPI paginates outbound orders, not material lines.
    Keeping a nested header on every flattened line lets the normalization and
    calculation code continue to use one auditable field-resolution path.
    The legacy flattened-row fallback is intentionally retained for saved test
    fixtures and tenants transitioning from the browser endpoint.
    """

    quantity_keys = {
        "planAmount",
        "plannedAmount",
        "targetAmount",
        "doneAmount",
        "fulfilledAmount",
        "actualAmount",
    }
    is_official_order_page = bool(page_rows) and any(
        "items" in row or not quantity_keys.intersection(row)
        for row in page_rows
    )
    if not is_official_order_page:
        line_page_ids = tuple(
            identity
            for identity in (_row_identity(row) for row in page_rows)
            if identity is not None
        )
        return (
            [dict(row) for row in page_rows],
            line_page_ids,
            False,
            [],
            {
                "orders_on_page": 0,
                "raw_item_line_count": len(page_rows),
                "item_shape_warning_count": 0,
                "orders_with_empty_items": 0,
            },
        )

    lines: list[dict[str, Any]] = []
    order_page_ids: list[tuple[str, ...]] = []
    warnings: list[str] = []
    raw_item_line_count = 0
    item_shape_warning_count = 0
    orders_with_empty_items = 0
    for index, order in enumerate(page_rows):
        order_id = order.get("id")
        order_code = order.get("code")
        if order_id not in (None, ""):
            order_page_ids.append(("order_id", str(order_id)))
        elif order_code not in (None, ""):
            order_page_ids.append(("order_code", str(order_code)))
        else:
            # Page/index is not used for line de-duplication. It only keeps an
            # unidentifiable order visible in the pagination audit.
            order_page_ids.append(
                ("order_page_index", str(page_number), str(index))
            )

        if "items" not in order:
            warnings.append("outbound_order_items_missing")
            item_shape_warning_count += 1
            continue
        raw_items = order.get("items")
        if not isinstance(raw_items, list):
            warnings.append("outbound_order_items_not_list")
            item_shape_warning_count += 1
            continue
        if not raw_items:
            orders_with_empty_items += 1
            continue
        raw_item_line_count += len(raw_items)
        order_header = {
            key: copy.deepcopy(value)
            for key, value in order.items()
            if key != "items"
        }
        for raw_item in raw_items:
            if not isinstance(raw_item, Mapping):
                warnings.append("outbound_order_item_malformed")
                item_shape_warning_count += 1
                continue
            item = copy.deepcopy(dict(raw_item))
            item["outboundOrder"] = copy.deepcopy(order_header)
            for item_key, header_value in (
                ("outboundOrderId", order_id),
                ("outboundOrderCode", order_code),
                ("planTime", order.get("planTime")),
                ("bizType", order.get("bizType")),
                ("bizStatus", order.get("bizStatus")),
                ("wareHouse", order.get("wareHouse")),
            ):
                if not _has_value(item.get(item_key)):
                    item[item_key] = copy.deepcopy(header_value)
            lines.append(item)
    return (
        lines,
        tuple(order_page_ids),
        True,
        warnings,
        {
            "orders_on_page": len(page_rows),
            "raw_item_line_count": raw_item_line_count,
            "item_shape_warning_count": item_shape_warning_count,
            "orders_with_empty_items": orders_with_empty_items,
        },
    )


def _row_identity(row: Mapping[str, Any]) -> tuple[str, ...] | None:
    line_id = row.get("id") or row.get("outboundOrderItemId") or row.get("itemId")
    if line_id not in (None, ""):
        return ("id", str(line_id))
    order = row.get("outboundOrder") if isinstance(row.get("outboundOrder"), Mapping) else {}
    order_id = (
        row.get("outboundOrderId")
        or row.get("orderId")
        or order.get("id")
    )
    line_no = row.get("lineNo") or row.get("lineNumber") or row.get("seqNo")
    if order_id not in (None, "") and line_no not in (None, ""):
        return ("order_line", str(order_id), str(line_no))
    return None


def _fetch_all_lines(
    *,
    start: datetime,
    end: datetime,
) -> tuple[list[dict[str, Any]], list[str], int, dict[str, int | None]]:
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen: set[tuple[str, ...]] = set()
    seen_page_entities: set[tuple[str, ...]] = set()
    expected_total: int | None = None
    reported_total: int | None = None
    duplicate_count = 0
    previous_page_ids: tuple[tuple[str, ...], ...] | None = None
    total_scope = "lines"
    official_order_response_seen = False
    audit = _fetch_audit_payload()

    filters = {
        "planAtFrom": int(start.timestamp() * 1000),
        # The local period check is end-exclusive; keep the upstream query from
        # pulling the next 08:00 boundary when it treats `Till` as inclusive.
        "planAtTill": int(end.timestamp() * 1000) - 1,
        "warehousePrivilege": {"issuePrivilegeFlag": 1},
    }
    for page in range(1, MAX_PAGES + 1):
        payload = _post_mes({**filters, "page": page, "size": PAGE_SIZE})
        audit["pages_fetched"] = int(audit["pages_fetched"] or 0) + 1
        try:
            response_rows, total = _page_rows(payload)
        except OutboundPerformanceError as exc:
            audit["item_shape_warning_count"] = (
                int(audit["item_shape_warning_count"] or 0) + 1
            )
            raise OutboundPerformanceError(
                str(exc),
                audit=audit,
                warnings=["outbound_order_list_shape_invalid"],
            ) from None
        (
            page_rows,
            page_ids,
            official_order_page,
            page_warnings,
            page_audit,
        ) = _flatten_order_rows(response_rows, page_number=page)
        if page == 1 and not response_rows:
            # The production endpoint is the official order API. An empty
            # first page is a valid zero-order response, not a legacy fixture.
            official_order_response_seen = True
            total_scope = "orders"
        warnings.extend(page_warnings)
        audit["raw_item_line_count"] = (
            int(audit["raw_item_line_count"] or 0)
            + page_audit["raw_item_line_count"]
        )
        audit["item_shape_warning_count"] = (
            int(audit["item_shape_warning_count"] or 0)
            + page_audit["item_shape_warning_count"]
        )
        audit["orders_with_empty_items"] = (
            int(audit["orders_with_empty_items"] or 0)
            + page_audit["orders_with_empty_items"]
        )
        if official_order_page:
            official_order_response_seen = True
            total_scope = "orders"
        if total is not None and total > 0:
            if expected_total is None:
                expected_total = total
            elif expected_total != total:
                warnings.append("outbound_upstream_total_changed")
        if total is not None and reported_total is None:
            reported_total = total

        if response_rows and previous_page_ids is not None and page_ids == previous_page_ids:
            warnings.append("outbound_pagination_repeated_page")
            break
        previous_page_ids = page_ids
        seen_page_entities.update(page_ids)
        if official_order_page:
            audit["orders_fetched"] = len(seen_page_entities)

        for row in page_rows:
            identity = _row_identity(row)
            if identity is None:
                # Counting an unidentifiable row could double-count when pages
                # shift while orders are being executed.
                rows.append({**row, "__identity_missing__": True})
                continue
            if identity in seen:
                duplicate_count += 1
                continue
            seen.add(identity)
            rows.append(row)

        if not response_rows:
            break
        if expected_total is not None and len(seen_page_entities) >= expected_total:
            break
        if len(response_rows) < PAGE_SIZE:
            break
        if page == MAX_PAGES:
            warnings.append("outbound_pagination_limit_reached")

    if duplicate_count:
        warnings.append("outbound_duplicate_lines_removed")
    if expected_total is not None and len(seen_page_entities) < expected_total:
        # Repeated/moving pages must never be allowed to satisfy the upstream
        # total: doing so would silently undercount the planned cohort.
        warnings.append(
            "outbound_unique_orders_below_reported_total"
            if total_scope == "orders"
            else "outbound_unique_lines_below_reported_total"
        )
    if official_order_response_seen:
        audit["upstream_order_total"] = reported_total
        if int(audit["orders_fetched"] or 0) > 0 and not rows:
            no_line_warning = "outbound_orders_have_no_usable_item_lines"
            raise OutboundPerformanceError(
                "MES outbound orders returned no usable material item lines",
                audit=audit,
                warnings=[*warnings, no_line_warning],
            )
    return rows, warnings, duplicate_count, audit


def _nested_order(row: Mapping[str, Any]) -> Mapping[str, Any]:
    order = row.get("outboundOrder") or row.get("order")
    return order if isinstance(order, Mapping) else {}


def _first_value(row: Mapping[str, Any], *keys: str) -> tuple[bool, Any]:
    for source in (row, _nested_order(row)):
        for key in keys:
            if key in source and _has_value(source.get(key)):
                return True, source.get(key)
    return False, None


def _order_code(row: Mapping[str, Any]) -> str:
    # Item-list responses can also use a generic `code` for material code.
    # Prefer the unambiguous joined order fields, then the nested header code,
    # and only retain top-level `code` as a compatibility fallback.
    for key in ("outboundOrderCode", "orderCode"):
        if key in row and row.get(key) not in (None, ""):
            return str(row.get(key)).strip()
    order = _nested_order(row)
    for key in ("code", "outboundOrderCode", "orderCode"):
        if key in order and order.get(key) not in (None, ""):
            return str(order.get(key)).strip()
    return str(row.get("code") or "").strip()


def _classify_order(code: str) -> tuple[str | None, str | None]:
    tokens = set(re.findall(r"[A-Z0-9]+", code.upper()))
    is_jit = "JIT" in tokens
    cskd_tokens = sorted(tokens.intersection(CSKD_ALIASES))
    if is_jit and cskd_tokens:
        return None, "classification_conflict"
    if is_jit:
        return "JIT", None
    if cskd_tokens:
        return "CSKD", None
    return None, "classification_unclassified"


def _enum_scalar(value: Any) -> Any:
    if isinstance(value, Mapping):
        for key in ("value", "code", "id", "name", "label"):
            if key in value and value.get(key) not in (None, ""):
                return value.get(key)
    return value


def _sales_type(value: Any) -> bool | None:
    value = _enum_scalar(value)
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return int(value) == 1
    normalized = re.sub(r"[\s_-]+", "", str(value).strip().upper())
    if normalized in {"1", "SALE", "SALES", "SALESOUTBOUND", "销售", "销售出库"}:
        return True
    return False


def _finished_goods_warehouse(value: Any) -> bool | None:
    if value in (None, ""):
        return None
    if isinstance(value, Mapping):
        candidates = [value.get("code"), value.get("name"), value.get("label")]
    else:
        candidates = [value]
    candidates = [str(candidate).strip() for candidate in candidates if candidate not in (None, "")]
    if not candidates:
        return None
    for candidate in candidates:
        normalized = re.sub(r"[\s/_-]+", "", candidate).upper()
        if normalized in {"PRODUCT", "成品仓库", "PRODUCT成品仓库"}:
            return True
    return False


def _is_cancelled(value: Any) -> bool:
    value = _enum_scalar(value)
    if value in (None, "") or isinstance(value, (int, float)):
        # BLACKLAKE numeric status 4 means closed, not cancelled, and must be
        # retained because it contains the final doneAmount.
        return False
    normalized = re.sub(r"[\s_-]+", "", str(value).strip().upper())
    return normalized in {
        re.sub(r"[\s_-]+", "", token.upper())
        for token in CANCELLED_STATUS_TOKENS
    }


def _parse_datetime(value: Any) -> datetime | None:
    value = _enum_scalar(value)
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float, Decimal)):
        numeric = float(value)
        if abs(numeric) > 100_000_000_000:
            numeric /= 1000
        try:
            return datetime.fromtimestamp(numeric, tz=SHANGHAI_TZ)
        except (OSError, OverflowError, ValueError):
            return None
    else:
        text = str(value).strip()
        if re.fullmatch(r"-?\d+(?:\.\d+)?", text):
            return _parse_datetime(float(text))
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
            for pattern in ("%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M", "%Y/%m/%d", "%Y-%m-%d"):
                try:
                    parsed = datetime.strptime(text, pattern)
                    break
                except ValueError:
                    continue
            if parsed is None:
                return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=SHANGHAI_TZ)
    return parsed.astimezone(SHANGHAI_TZ)


def _decimal(value: Any, *, depth: int = 0) -> Decimal | None:
    if depth > 4 or value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, (int, float)):
        try:
            result = Decimal(str(value))
        except InvalidOperation:
            return None
        return result if result.is_finite() else None
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return None
        try:
            result = Decimal(text)
        except InvalidOperation:
            return None
        return result if result.is_finite() else None
    if isinstance(value, Mapping):
        for key in ("amount", "value", "quantity", "qty", "amountDisplay"):
            if key in value:
                parsed = _decimal(value.get(key), depth=depth + 1)
                if parsed is not None:
                    return parsed
    return None


def _unit_evidence(value: Any) -> list[str]:
    if isinstance(value, Mapping):
        evidence: list[str] = []
        for key in ("code", "name", "unitCode", "label", "value"):
            candidate = value.get(key)
            if candidate not in (None, "") and not isinstance(candidate, Mapping):
                evidence.append(str(candidate).strip())
        return evidence
    candidate = str(value or "").strip()
    return [candidate] if candidate else []


def _normalized_unit_token(value: str) -> str:
    return re.sub(r"[\s._/-]+", "", value).upper()


def _quantity_unit(row: Mapping[str, Any], plan_value: Any, done_value: Any) -> tuple[str | None, str | None]:
    _present, row_unit = _first_value(row, "unit", "unitInfo", "baseUnit")
    candidates = _unit_evidence(row_unit)
    for quantity in (plan_value, done_value):
        if isinstance(quantity, Mapping):
            candidates.extend(_unit_evidence(quantity.get("unit")))
    material = _material_mapping(row)
    candidates.extend(_unit_evidence(material.get("unit")))
    base_info = material.get("baseInfo")
    if isinstance(base_info, Mapping):
        candidates.extend(_unit_evidence(base_info.get("unit")))
    normalized = {
        _normalized_unit_token(candidate)
        for candidate in candidates
        if candidate
    }
    if not normalized:
        return None, "unit_missing"
    piece_tokens = {_normalized_unit_token(item) for item in PIECE_UNITS}
    incompatible_tokens = {
        _normalized_unit_token(item) for item in INCOMPATIBLE_UNIT_TOKENS
    }
    accepted = normalized.intersection(piece_tokens)
    incompatible = normalized.intersection(incompatible_tokens)
    if accepted and incompatible:
        return None, "unit_mixed_or_incompatible"
    # BLACKLAKE unit codes can be opaque tenant identifiers while `name`
    # carries the auditable piece unit (for example code=U-17, name=个). An
    # opaque code must not invalidate a recognized piece name.
    if accepted:
        return "EA", None
    if incompatible:
        return None, "unit_not_piece"
    return None, "unit_not_piece"


def _period_memberships(
    timestamp: datetime,
    windows: Mapping[str, tuple[datetime, datetime]],
) -> list[str]:
    return [
        key
        for key, (start, end) in windows.items()
        if start <= timestamp < end
    ]


def _json_number(value: Decimal) -> int | float:
    integral = value.to_integral_value()
    if value == integral:
        return int(integral)
    return round(float(value), 4)


def _bounded_text(value: Any, *, limit: int = 160) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, Mapping):
        for key in ("name", "label", "value", "code", "id"):
            candidate = value.get(key)
            if candidate not in (None, "") and not isinstance(candidate, Mapping):
                return str(candidate).strip()[:limit]
        return ""
    return str(value).strip()[:limit]


def _material_mapping(row: Mapping[str, Any]) -> Mapping[str, Any]:
    material = row.get("material") or row.get("materialInfo")
    return material if isinstance(material, Mapping) else {}


def _material_sources(row: Mapping[str, Any]) -> tuple[Mapping[str, Any], ...]:
    material = _material_mapping(row)
    base_info = material.get("baseInfo")
    if isinstance(base_info, Mapping):
        return base_info, material
    return (material,)


def _material_text(
    row: Mapping[str, Any],
    *row_keys: str,
    material_keys: tuple[str, ...],
) -> str:
    for key in row_keys:
        if key in row and row.get(key) not in (None, ""):
            return _bounded_text(row.get(key))
    for material in _material_sources(row):
        for key in material_keys:
            if key in material and material.get(key) not in (None, ""):
                return _bounded_text(material.get(key))
    return ""


def _material_id(row: Mapping[str, Any]) -> str | None:
    if row.get("materialId") not in (None, ""):
        return _bounded_text(row.get("materialId"), limit=80)
    for material in _material_sources(row):
        if material.get("id") not in (None, ""):
            return _bounded_text(material.get("id"), limit=80)
    return None


def _order_id(row: Mapping[str, Any]) -> str | None:
    order = _nested_order(row)
    value = row.get("outboundOrderId") or row.get("orderId") or order.get("id")
    if value in (None, ""):
        return None
    return _bounded_text(value, limit=80)


def _status_label(value: Any) -> str | None:
    value = _enum_scalar(value)
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        numeric = int(value)
        if float(value) == numeric and numeric in OUTBOUND_STATUS_LABELS:
            return OUTBOUND_STATUS_LABELS[numeric]
    text = _bounded_text(value, limit=80)
    if re.fullmatch(r"\d+", text):
        numeric = int(text)
        if numeric in OUTBOUND_STATUS_LABELS:
            return OUTBOUND_STATUS_LABELS[numeric]
    normalized = re.sub(r"[\s_-]+", "", text).upper()
    aliases = {
        "CREATE": "created",
        "CREATED": "created",
        "新建": "created",
        "ISSUE": "issued",
        "ISSUED": "issued",
        "下发": "issued",
        "INEXECUTION": "in_execution",
        "EXECUTING": "in_execution",
        "执行中": "in_execution",
        "COMPLETE": "completed",
        "COMPLETED": "completed",
        "已完成": "completed",
        "CLOSE": "closed",
        "CLOSED": "closed",
        "已关闭": "closed",
    }
    return aliases.get(normalized)


def _build_today_detail_item(
    row: Mapping[str, Any],
    *,
    category: str,
    code: str,
    plan_time: datetime,
    status: Any,
    plan_amount: Decimal,
    done_amount: Decimal,
) -> dict[str, Any]:
    remaining = max(plan_amount - done_amount, Decimal("0"))
    variance = done_amount - plan_amount
    if variance > 0:
        fulfillment_state = "over"
    elif remaining > 0:
        fulfillment_state = "pending"
    else:
        fulfillment_state = "complete"

    return {
        "category": category,
        "outbound_order_id": _order_id(row),
        "outbound_order_code": code[:160],
        "plan_time": plan_time.isoformat(),
        "status": _status_label(status),
        "material_id": _material_id(row),
        "material_code": _material_text(
            row,
            "materialCode",
            material_keys=("code", "materialCode"),
        ),
        "material_name": _material_text(
            row,
            "materialName",
            material_keys=("name", "materialName"),
        ),
        "specification": _material_text(
            row,
            "specification",
            "materialSpecification",
            "materialSpec",
            material_keys=("specification", "spec", "materialSpecification"),
        ),
        "target_qty": _json_number(plan_amount),
        "fulfilled_qty": _json_number(done_amount),
        "remaining_qty": _json_number(remaining),
        "variance_qty": _json_number(variance),
        "completion_rate": (
            round(float(done_amount / plan_amount * 100), 1)
            if plan_amount > 0
            else None
        ),
        "unit": "EA",
        "fulfillment_state": fulfillment_state,
    }


def _priority_sort_key(item: Mapping[str, Any]) -> tuple[Any, ...]:
    state = str(item.get("fulfillment_state") or "complete")
    state_rank = {"pending": 0, "over": 1, "complete": 2}.get(state, 3)
    if state == "pending":
        completion_rate = item.get("completion_rate")
        secondary = float(completion_rate) if completion_rate is not None else 0.0
        magnitude = float(item.get("remaining_qty") or 0)
    elif state == "over":
        secondary = 0.0
        magnitude = float(item.get("variance_qty") or 0)
    else:
        secondary = 0.0
        magnitude = float(item.get("target_qty") or 0)
    return (
        state_rank,
        str(item.get("plan_time") or ""),
        secondary,
        -magnitude,
        str(item.get("outbound_order_code") or ""),
        str(item.get("material_code") or ""),
    )


def _largest_pending_sort_key(item: Mapping[str, Any]) -> tuple[Any, ...]:
    return (
        -float(item.get("remaining_qty") or 0),
        str(item.get("plan_time") or ""),
        str(item.get("outbound_order_code") or ""),
        str(item.get("material_code") or ""),
    )


def _detail_payload(
    items: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    summary = _today_detail_summary(available=True)
    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_category[str(item["category"])].append(item)

    for category in CATEGORY_KEYS:
        category_items = by_category[category]
        pending = [
            item for item in category_items
            if item["fulfillment_state"] == "pending"
        ]
        complete = [
            item for item in category_items
            if item["fulfillment_state"] == "complete"
        ]
        over = [
            item for item in category_items
            if item["fulfillment_state"] == "over"
        ]
        pending.sort(key=_largest_pending_sort_key)
        summary[category] = {
            "pending_line_count": len(pending),
            "complete_line_count": len(complete),
            "over_line_count": len(over),
            "zero_fulfilled_line_count": sum(
                1 for item in category_items if item["fulfilled_qty"] == 0
            ),
            "remaining_qty": _json_number(sum(
                (Decimal(str(item["remaining_qty"])) for item in category_items),
                Decimal("0"),
            )),
            "over_qty": _json_number(sum(
                (
                    max(Decimal(str(item["variance_qty"])), Decimal("0"))
                    for item in category_items
                ),
                Decimal("0"),
            )),
            "unit": "EA",
            "largest_pending": copy.deepcopy(pending[0]) if pending else None,
        }

    ordered = sorted(items, key=_priority_sort_key)
    # Reserve one slot for each present shipping stream so a busy JIT cohort
    # cannot completely hide CSKD (or vice versa) on the wallboard.
    priority_items: list[dict[str, Any]] = []
    selected: set[int] = set()
    for category in CATEGORY_KEYS:
        first = next((item for item in ordered if item["category"] == category), None)
        if first is not None:
            priority_items.append(first)
            selected.add(id(first))
    priority_items.extend(
        item for item in ordered
        if id(item) not in selected
    )
    priority_items = priority_items[:MAX_PRIORITY_ITEMS]
    return summary, copy.deepcopy(priority_items)


def _aggregate(
    rows: list[dict[str, Any]],
    *,
    windows: Mapping[str, tuple[datetime, datetime]],
    fetch_warnings: list[str],
    duplicate_count: int,
    fetch_audit: Mapping[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    quantities: dict[tuple[str, str], dict[str, Decimal]] = defaultdict(
        lambda: {"target": Decimal("0"), "fulfilled": Decimal("0")}
    )
    line_counts: Counter[tuple[str, str]] = Counter()
    order_keys: dict[tuple[str, str], set[str]] = defaultdict(set)
    exclusions: Counter[str] = Counter()
    accepted_lines = 0
    ignored_outside_period_lines = 0
    today_detail_items: list[dict[str, Any]] = []
    unclassified_lines = 0
    unclassified_order_keys: set[str] = set()

    for row in rows:
        _time_present, plan_time_value = _first_value(
            row,
            "planTime",
            "planAt",
            "plannedAt",
            "plannedOutboundTime",
        )
        plan_time = _parse_datetime(plan_time_value)
        if plan_time is None:
            exclusions["plan_time_missing_or_invalid"] += 1
            continue
        memberships = _period_memberships(plan_time, windows)
        if not memberships:
            # A single bounded query spans from the previous month through
            # today, so it can legitimately contain dates in gaps between the
            # three requested comparison cohorts. They are out of scope, not a
            # data-quality failure.
            ignored_outside_period_lines += 1
            continue

        if row.get("__identity_missing__"):
            exclusions["identity_missing"] += 1
            continue

        code = _order_code(row)
        category, classification_error = _classify_order(code)
        if classification_error == "classification_unclassified":
            order = _nested_order(row)
            order_id = row.get("outboundOrderId") or row.get("orderId") or order.get("id")
            unclassified_lines += 1
            unclassified_order_keys.add(str(order_id or code))
            continue
        if classification_error:
            exclusions[classification_error] += 1
            continue

        biz_present, biz_type = _first_value(row, "bizType", "businessType")
        sales_type = _sales_type(biz_type) if biz_present else None
        if sales_type is None:
            exclusions["business_type_missing"] += 1
            continue
        if sales_type is False:
            exclusions["non_sales_business_type"] += 1
            continue

        warehouse_present, warehouse = _first_value(row, "wareHouse", "warehouse")
        finished_goods_warehouse = (
            _finished_goods_warehouse(warehouse) if warehouse_present else None
        )
        if finished_goods_warehouse is None:
            exclusions["warehouse_missing"] += 1
            continue
        if finished_goods_warehouse is False:
            exclusions["non_finished_goods_warehouse"] += 1
            continue

        status_present, status = _first_value(row, "bizStatus", "status")
        if not status_present:
            exclusions["status_missing"] += 1
            continue
        if _is_cancelled(status):
            exclusions["cancelled_or_deleted"] += 1
            continue
        if _status_label(status) is None:
            exclusions["status_unknown"] += 1
            continue

        _plan_present, plan_value = _first_value(
            row, "planAmount", "plannedAmount", "targetAmount"
        )
        _done_present, done_value = _first_value(
            row, "doneAmount", "fulfilledAmount", "actualAmount"
        )
        plan_amount = _decimal(plan_value)
        done_amount = _decimal(done_value)
        if plan_amount is None or done_amount is None:
            exclusions["quantity_missing_or_invalid"] += 1
            continue
        if plan_amount < 0 or done_amount < 0:
            exclusions["quantity_negative"] += 1
            continue

        unit, unit_error = _quantity_unit(row, plan_value, done_value)
        if unit_error:
            exclusions[unit_error] += 1
            continue

        order = _nested_order(row)
        order_id = row.get("outboundOrderId") or row.get("orderId") or order.get("id")
        order_key = str(order_id or code)
        accepted_lines += 1
        if "today" in memberships:
            today_detail_items.append(_build_today_detail_item(
                row,
                category=category,
                code=code,
                plan_time=plan_time,
                status=status if status_present else None,
                plan_amount=plan_amount,
                done_amount=done_amount,
            ))
        for period in memberships:
            key = (period, category)
            quantities[key]["target"] += plan_amount
            quantities[key]["fulfilled"] += done_amount
            line_counts[key] += 1
            order_keys[key].add(order_key)

    warnings = list(fetch_warnings)
    if exclusions:
        warnings.extend(f"outbound_excluded_{reason}" for reason in exclusions)
    warnings = sorted(set(warnings))
    fetched_at = timezone.now().isoformat()
    periods = _period_payloads(windows, available=True)
    for period in PERIOD_KEYS:
        for category in CATEGORY_KEYS:
            key = (period, category)
            target = quantities[key]["target"]
            fulfilled = quantities[key]["fulfilled"]
            periods[period][category] = {
                "target_qty": _json_number(target),
                "fulfilled_qty": _json_number(fulfilled),
                "completion_rate": (
                    round(float(fulfilled / target * 100), 1) if target > 0 else None
                ),
                "order_count": len(order_keys[key]),
                "line_count": line_counts[key],
                "unit": "EA",
            }

    today_detail_summary, today_priority_items = _detail_payload(today_detail_items)

    payload = {
        "status": "partial" if warnings else "ok",
        "fetched_at": fetched_at,
        "cache_status": "miss",
        "measurement_basis": _measurement_basis(),
        "periods": periods,
        "today_detail_summary": today_detail_summary,
        "today_priority_items": today_priority_items,
        "unclassified": {
            "order_count": len(unclassified_order_keys),
            "line_count": unclassified_lines,
        },
        "accepted_line_count": accepted_lines,
        "excluded_line_count": sum(exclusions.values()),
        "deduplicated_line_count": duplicate_count,
        "covered_order_count": len({
            order_key
            for keys in order_keys.values()
            for order_key in keys
        }),
        "ignored_outside_period_line_count": ignored_outside_period_lines,
        "exclusions_by_reason": dict(sorted(exclusions.items())),
        "warnings": warnings,
        **_fetch_audit_payload(fetch_audit),
    }
    return payload, warnings


def get_outbound_performance(
    target_date: date,
    *,
    force_refresh: bool = False,
) -> tuple[dict[str, Any], list[str], dict[str, Any], dict[str, Any]]:
    """Return dashboard payload, warnings, freshness state, and trace.

    Successful and partial responses are cached for five minutes.  Upstream
    errors return explicit unavailable/null metrics and are never represented
    as a valid zero-activity period.
    """

    cache_key = f"{CACHE_KEY_PREFIX}:{target_date.isoformat()}"
    if not force_refresh:
        cached = cache.get(cache_key)
        if isinstance(cached, Mapping):
            payload = copy.deepcopy(dict(cached))
            payload["cache_status"] = "hit"
            warnings = list(payload.get("warnings") or [])
            cached_status = str(payload.get("status") or "unavailable")
            source_status = "error" if cached_status == "unavailable" else cached_status
            source = {
                "status": source_status,
                "source_latest_at": payload.get("fetched_at"),
                "row_count": int(payload.get("accepted_line_count") or 0),
                "stale": False,
            }
            if cached_status == "unavailable":
                source["detail"] = "cached_upstream_unavailable"
            trace = {
                "source": "BLACKLAKE inventory outbound_order._list items[]",
                "status": source_status,
                "rows_returned": int(payload.get("accepted_line_count") or 0),
                "rows_unclassified": int(
                    (payload.get("unclassified") or {}).get("line_count") or 0
                ),
                "cache_status": "hit",
                "calculation": "planTime cohort; sum planAmount and current doneAmount",
                **{
                    key: payload.get(key)
                    for key in FETCH_AUDIT_KEYS
                },
            }
            if cached_status == "unavailable":
                trace["detail"] = "cached_upstream_unavailable"
            return payload, warnings, source, trace

    windows = _period_windows(target_date)
    query_start = min(start for start, _end in windows.values())
    query_end = max(end for _start, end in windows.values())
    try:
        rows, fetch_warnings, duplicate_count, fetch_audit = _fetch_all_lines(
            start=query_start,
            end=query_end,
        )
        payload, warnings = _aggregate(
            rows,
            windows=windows,
            fetch_warnings=fetch_warnings,
            duplicate_count=duplicate_count,
            fetch_audit=fetch_audit,
        )
        cache.set(cache_key, copy.deepcopy(payload), timeout=CACHE_SECONDS)
        source = {
            "status": payload["status"],
            "source_latest_at": payload["fetched_at"],
            "row_count": payload["accepted_line_count"],
            "stale": False,
        }
        trace = {
            "source": "BLACKLAKE inventory outbound_order._list items[]",
            "status": payload["status"],
            "rows_returned": payload["accepted_line_count"],
            "rows_excluded": payload["excluded_line_count"],
            "rows_unclassified": payload["unclassified"]["line_count"],
            "rows_deduplicated": payload["deduplicated_line_count"],
            "cache_status": "miss",
            "query_start": query_start.isoformat(),
            "query_end": query_end.isoformat(),
            "calculation": "planTime cohort; sum planAmount and current doneAmount",
            **{
                key: payload.get(key)
                for key in FETCH_AUDIT_KEYS
            },
        }
        return payload, warnings, source, trace
    except Exception as exc:
        error_audit = (
            exc.audit
            if isinstance(exc, OutboundPerformanceError)
            else None
        )
        error_warnings = (
            exc.warnings
            if isinstance(exc, OutboundPerformanceError)
            else None
        )
        payload = _unavailable_payload(
            target_date,
            audit=error_audit,
            extra_warnings=error_warnings,
        )
        # A wall display refreshes frequently. Cache the explicit unavailable
        # result so a credential or MES outage cannot trigger a blocking token
        # and API request on every refresh. Null metrics preserve fail-closed
        # semantics; the cache-hit path above still reports source status error.
        cache.set(cache_key, copy.deepcopy(payload), timeout=CACHE_SECONDS)
        source = {
            "status": "error",
            "source_latest_at": None,
            "row_count": 0,
            "stale": False,
            "detail": exc.__class__.__name__,
        }
        trace = {
            "source": "BLACKLAKE inventory outbound_order._list items[]",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
            "cache_status": "miss",
            "query_start": query_start.isoformat(),
            "query_end": query_end.isoformat(),
            **{
                key: payload.get(key)
                for key in FETCH_AUDIT_KEYS
            },
        }
        return payload, list(payload["warnings"]), source, trace
