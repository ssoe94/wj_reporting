"""Deterministic data contract for the 3x3 video-wall overview board.

The board is deliberately assembled from existing, auditable retrievers and
stored snapshots.  It never asks an LLM to calculate or classify production
data, and it does not make a current-quality claim from historical reports.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone as datetime_timezone
from email.utils import parsedate_to_datetime
import gzip
import json
import re
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.core.cache import cache
from django.db import DatabaseError
from django.db.models import Count, Max, Sum
from django.utils import timezone

from ai_core.quality_daily import (
    QUALITY_ATTENTION_AI_SCHEMA_VERSION,
    QUALITY_DAILY_DISCLAIMER,
    QUALITY_DAILY_MODEL_ID,
    quality_summary_for_overview,
)
from injection.models import InjectionMonitoringRecord, MouldDataSnapshot
from injection.mould_snapshots import BOARD_SNAPSHOT_KEY, decorate_board_payload
from inventory.models import DailyInventorySnapshot, FinishedGoodsTransactionSnapshot
from inventory.services.outbound_performance import get_outbound_performance
from quality.daily_attention import build_daily_quality_attention
from quality.models import QualityReport

from .ai_metrics import SHANGHAI_TZ, safe_rate
from .ai_retrievers import get_daily_production_context, get_injection_active_machine_context


SCHEMA_VERSION = "overview-board.v1"
QUALITY_HISTORY_DAYS = 90
QUALITY_ACTIVITY_WINDOW_MINUTES = 60
INJECTION_STALE_AFTER_MINUTES = 10
ENERGY_STALE_AFTER_MINUTES = 20
NANJING_LATITUDE = 32.0603
NANJING_LONGITUDE = 118.7969
WEATHER_API_URL = (
    "https://api.met.no/weatherapi/locationforecast/2.0/compact"
    f"?lat={NANJING_LATITUDE:.4f}&lon={NANJING_LONGITUDE:.4f}"
)
WEATHER_USER_AGENT = "WJReporting/1.0 https://wj-reporting.onrender.com"
WEATHER_FRESH_CACHE_KEY = "overview-board:nanjing-weather:fresh:v1"
WEATHER_STALE_CACHE_KEY = "overview-board:nanjing-weather:stale:v1"
WEATHER_DEFAULT_CACHE_SECONDS = 30 * 60
WEATHER_STALE_CACHE_SECONDS = 6 * 60 * 60


COPY = {
    "ko": {
        "injection": "사출 생산",
        "assembly": "조립 생산",
        "quality_disclaimer": "과거 품질 이력이며 현재 불량 발생을 의미하지 않습니다.",
        "behind_title": "{machine} 생산 진도 지연",
        "behind_detail": "시간 진도보다 {gap:.1f}%p 낮습니다.",
        "assembly_behind_title": "조립 생산 진도 지연",
        "mould_conflict_title": "금형 위치 확인 필요",
        "mould_conflict_detail": "위치 충돌 {count}건이 저장된 금형 스냅샷에 있습니다.",
    },
    "zh": {
        "injection": "注塑生产",
        "assembly": "组装生产",
        "quality_disclaimer": "仅为历史品质记录，不代表当前正在发生不良。",
        "behind_title": "{machine}生产进度滞后",
        "behind_detail": "比时间进度低{gap:.1f}个百分点。",
        "assembly_behind_title": "组装生产进度滞后",
        "mould_conflict_title": "模具位置待确认",
        "mould_conflict_detail": "已保存的模具快照中有{count}项位置冲突。",
    },
}


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _safe_int(value: Any) -> int:
    try:
        return int(round(float(value or 0)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _normalize_part_no(value: Any) -> str:
    """Normalize only case and whitespace for an exact full-part comparison."""
    return re.sub(r"\s+", "", str(value or "").strip().upper())


def _positive_float_counter_delta(values: Iterable[Any], *, baseline: Any = None) -> float:
    """Reset-safe cumulative-counter delta that preserves decimal kWh."""
    previous = float(baseline) if baseline is not None else None
    total = 0.0
    for value in values:
        if value is None:
            continue
        current = float(value)
        if previous is None:
            previous = current
            continue
        delta = _positive_float_counter_increment(previous, current)
        if delta > 0:
            total += delta
        previous = current
    return total


def _positive_float_counter_increment(previous: float, current: float) -> float:
    """Return one reset-safe positive increment between cumulative samples."""
    if current >= previous:
        return current - previous
    return current if previous > 0 and current / previous <= 0.2 else 0.0


def _latest_counter_baselines(
    machine_names: Iterable[str],
    *,
    before: datetime,
    field: str,
) -> dict[str, float]:
    names = sorted({str(name) for name in machine_names if name})
    if not names:
        return {}
    latest_rows = list(
        InjectionMonitoringRecord.objects
        .filter(machine_name__in=names, timestamp__lt=before)
        .exclude(**{f"{field}__isnull": True})
        .filter(**{f"{field}__gte": 0})
        .values("machine_name")
        .annotate(latest=Max("timestamp"))
    )
    latest_by_machine = {
        str(row["machine_name"]): row["latest"]
        for row in latest_rows
        if row.get("latest") is not None
    }
    if not latest_by_machine:
        return {}
    rows = InjectionMonitoringRecord.objects.filter(
        machine_name__in=list(latest_by_machine),
        timestamp__in=list(latest_by_machine.values()),
    ).exclude(**{f"{field}__isnull": True}).filter(
        **{f"{field}__gte": 0},
    ).values("machine_name", "timestamp", field)
    result: dict[str, float] = {}
    for row in rows:
        machine_name = str(row["machine_name"])
        if row["timestamp"] != latest_by_machine.get(machine_name):
            continue
        result[machine_name] = float(row[field])
    return result


def _counter_sample_hour(timestamp: datetime) -> datetime:
    local = timestamp.astimezone(SHANGHAI_TZ)
    hour = local.replace(minute=0, second=0, microsecond=0)
    # Exact-hour cumulative snapshots close the hour that just ended.
    if local == hour:
        return hour - timedelta(hours=1)
    return hour


def _weather_condition_code(symbol_code: Any) -> str:
    symbol = str(symbol_code or "").lower()
    if "thunder" in symbol:
        return "thunder"
    if "snow" in symbol or "sleet" in symbol:
        return "snow"
    if "heavyrain" in symbol:
        return "heavy_rain"
    if "rain" in symbol:
        return "rain"
    if "fog" in symbol:
        return "fog"
    if "partlycloudy" in symbol or "fair" in symbol:
        return "partly_cloudy"
    if "cloudy" in symbol:
        return "cloudy"
    if "clearsky" in symbol:
        return "clear"
    return "unknown"


def _weather_day_phase(symbol_code: Any, *, reference_time: datetime) -> str:
    """Resolve the weather artwork phase without relying on client time."""

    symbol = str(symbol_code or "").lower()
    if symbol.endswith("_day"):
        return "day"
    if symbol.endswith("_night"):
        return "night"

    if timezone.is_naive(reference_time):
        reference_time = timezone.make_aware(reference_time, datetime_timezone.utc)
    local_hour = reference_time.astimezone(SHANGHAI_TZ).hour
    return "day" if 6 <= local_hour < 18 else "night"


def _weather_reference_time(value: Any, *, fallback: datetime) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return fallback
    if timezone.is_naive(parsed):
        return timezone.make_aware(parsed, datetime_timezone.utc)
    return parsed


def _with_weather_day_phase(weather: dict[str, Any], *, fallback: datetime) -> dict[str, Any]:
    if weather.get("day_phase") in {"day", "night"}:
        return weather
    reference_time = _weather_reference_time(weather.get("valid_at"), fallback=fallback)
    return {
        **weather,
        "day_phase": _weather_day_phase(
            weather.get("symbol_code"),
            reference_time=reference_time,
        ),
    }


def _weather_cache_seconds(response: Any, *, now: datetime) -> int:
    expires = response.headers.get("Expires") if getattr(response, "headers", None) else None
    if not expires:
        return WEATHER_DEFAULT_CACHE_SECONDS
    try:
        expires_at = parsedate_to_datetime(expires)
        if timezone.is_naive(expires_at):
            expires_at = timezone.make_aware(expires_at, datetime_timezone.utc)
        seconds = int((expires_at - now.astimezone(expires_at.tzinfo)).total_seconds())
        return max(5 * 60, min(60 * 60, seconds))
    except (TypeError, ValueError, OverflowError):
        return WEATHER_DEFAULT_CACHE_SECONDS


def _fetch_nanjing_weather() -> tuple[dict[str, Any], int]:
    now = timezone.now()
    request = Request(
        WEATHER_API_URL,
        headers={
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
            "User-Agent": WEATHER_USER_AGENT,
        },
    )
    with urlopen(request, timeout=3.0) as response:
        body = response.read()
        if str(response.headers.get("Content-Encoding", "")).lower() == "gzip":
            body = gzip.decompress(body)
        payload = json.loads(body.decode("utf-8"))
        cache_seconds = _weather_cache_seconds(response, now=now)

    properties = payload.get("properties") if isinstance(payload, dict) else None
    timeseries = properties.get("timeseries") if isinstance(properties, dict) else None
    if not isinstance(timeseries, list) or not timeseries:
        raise ValueError("weather_timeseries_missing")

    def distance_from_now(item: Any) -> float:
        if not isinstance(item, dict):
            return float("inf")
        try:
            point_time = datetime.fromisoformat(str(item.get("time", "")).replace("Z", "+00:00"))
            return abs((point_time - now.astimezone(point_time.tzinfo)).total_seconds())
        except (TypeError, ValueError):
            return float("inf")

    point = min(timeseries, key=distance_from_now)
    data = point.get("data") if isinstance(point, dict) else None
    instant = data.get("instant") if isinstance(data, dict) else None
    details = instant.get("details") if isinstance(instant, dict) else None
    if not isinstance(details, dict):
        raise ValueError("weather_instant_details_missing")
    next_hour = data.get("next_1_hours") if isinstance(data, dict) else None
    next_six_hours = data.get("next_6_hours") if isinstance(data, dict) else None
    summary = (
        next_hour.get("summary") if isinstance(next_hour, dict) else None
    ) or (
        next_six_hours.get("summary") if isinstance(next_six_hours, dict) else None
    ) or {}
    symbol_code = summary.get("symbol_code") if isinstance(summary, dict) else None
    valid_at = point.get("time")
    weather = {
        "location": "Nanjing",
        "latitude": NANJING_LATITUDE,
        "longitude": NANJING_LONGITUDE,
        "status": "ok",
        "is_stale": False,
        "temperature_c": details.get("air_temperature"),
        "relative_humidity_percent": details.get("relative_humidity"),
        "wind_speed_mps": details.get("wind_speed"),
        "condition_code": _weather_condition_code(symbol_code),
        "symbol_code": symbol_code,
        "day_phase": _weather_day_phase(
            symbol_code,
            reference_time=_weather_reference_time(valid_at, fallback=now),
        ),
        "valid_at": valid_at,
        "retrieved_at": now.isoformat(),
        "source": "MET Norway",
        "source_url": "https://api.met.no/weatherapi/locationforecast/2.0/compact",
        "attribution": "Weather data: MET Norway",
    }
    return weather, cache_seconds


def _build_weather() -> tuple[dict[str, Any], list[str], dict[str, Any], dict[str, Any]]:
    cached = cache.get(WEATHER_FRESH_CACHE_KEY)
    if isinstance(cached, dict):
        weather = {
            **_with_weather_day_phase(cached, fallback=timezone.now()),
            "cache_status": "fresh",
        }
        source = _source_state(status="ok", latest_at=weather.get("valid_at"), row_count=1, stale=False)
        return weather, [], source, {
            "source": "api.met.no Locationforecast 2.0 compact",
            "status": "cached",
            "rows_returned": 1,
        }
    try:
        weather, cache_seconds = _fetch_nanjing_weather()
        cache.set(WEATHER_FRESH_CACHE_KEY, weather, timeout=cache_seconds)
        cache.set(WEATHER_STALE_CACHE_KEY, weather, timeout=WEATHER_STALE_CACHE_SECONDS)
        source = _source_state(status="ok", latest_at=weather.get("valid_at"), row_count=1, stale=False)
        return {**weather, "cache_status": "refreshed"}, [], source, {
            "source": "api.met.no Locationforecast 2.0 compact",
            "status": "ok",
            "rows_returned": 1,
        }
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        stale = cache.get(WEATHER_STALE_CACHE_KEY)
        if isinstance(stale, dict):
            weather = {
                **_with_weather_day_phase(stale, fallback=timezone.now()),
                "status": "stale",
                "is_stale": True,
                "cache_status": "stale",
            }
            source = _source_state(status="stale", latest_at=weather.get("valid_at"), row_count=1, stale=True)
            return weather, ["weather_data_stale"], source, {
                "source": "api.met.no Locationforecast 2.0 compact",
                "status": "stale",
                "detail": exc.__class__.__name__,
                "rows_returned": 1,
            }
        weather = {
            "location": "Nanjing",
            "status": "unavailable",
            "is_stale": False,
            "temperature_c": None,
            "relative_humidity_percent": None,
            "wind_speed_mps": None,
            "condition_code": "unknown",
            "symbol_code": None,
            "day_phase": _weather_day_phase(
                None,
                reference_time=timezone.now(),
            ),
            "valid_at": None,
            "retrieved_at": timezone.now().isoformat(),
            "source": "MET Norway",
            "source_url": "https://api.met.no/weatherapi/locationforecast/2.0/compact",
            "attribution": "Weather data: MET Norway",
            "cache_status": "miss",
        }
        source = _source_state(status="error", row_count=0, stale=False, detail=exc.__class__.__name__)
        return weather, ["weather_data_unavailable"], source, {
            "source": "api.met.no Locationforecast 2.0 compact",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
        }


def current_shanghai_business_date(now: datetime | None = None) -> date:
    reference = now or timezone.now()
    if timezone.is_naive(reference):
        reference = timezone.make_aware(reference, timezone.get_current_timezone())
    return (reference.astimezone(SHANGHAI_TZ) - timedelta(hours=8)).date()


def current_quality_analysis_date(
    target_date: date,
    now: datetime | None = None,
) -> date:
    """Preview the incoming shift's quality plan from 07:00 to 08:00.

    Production KPIs retain the 08:00 business-day boundary.  Quality attention
    is prepared one hour earlier for shift handover, using the calendar date's
    already-uploaded injection plan.
    """

    reference = now or timezone.now()
    if timezone.is_naive(reference):
        reference = timezone.make_aware(reference, timezone.get_current_timezone())
    local_reference = reference.astimezone(SHANGHAI_TZ)
    if (
        target_date == current_shanghai_business_date(reference)
        and local_reference.hour == 7
    ):
        return local_reference.date()
    return target_date


def _source_state(
    *,
    status: str,
    latest_at: Any = None,
    row_count: int = 0,
    stale: bool = False,
    detail: str | None = None,
) -> dict[str, Any]:
    payload = {
        "status": status,
        "source_latest_at": _iso(latest_at),
        "row_count": int(row_count or 0),
        "stale": bool(stale),
    }
    if detail:
        payload["detail"] = detail
    return payload


def _pace_status(planned_qty: int, completion_vs_time_gap_pp: float) -> str:
    """Classify progress with the same strict five-point rule as attention."""
    if planned_qty <= 0:
        return "no_plan"
    if completion_vs_time_gap_pp < -5:
        return "behind"
    if completion_vs_time_gap_pp > 5:
        return "ahead"
    return "on_track"


def _remaining_business_minutes(range_end: Any, reference_time: Any) -> int | None:
    if not isinstance(range_end, datetime) or not isinstance(reference_time, datetime):
        return None
    try:
        return max(0, int(round((range_end - reference_time).total_seconds() / 60)))
    except (TypeError, ValueError):
        return None


def _process_summary(
    source: dict[str, Any],
    *,
    key: str,
    source_process: str,
    title: str,
    display_semantics: str,
    range_end: datetime | None = None,
    reference_time: datetime | None = None,
) -> dict[str, Any]:
    planned_qty = _safe_int(source.get("planned_qty"))
    actual_qty = _safe_int(source.get("actual_qty"))
    completion_rate = round(float(source.get("progress_rate") or safe_rate(actual_qty, planned_qty)), 1)
    time_progress_rate = round(float(source.get("time_progress_rate") or 0), 1)
    forecast_completion_rate = (
        round(safe_rate(completion_rate, time_progress_rate), 1)
        if planned_qty > 0 and time_progress_rate > 0
        else None
    )
    expected_qty_by_time = _safe_int(planned_qty * time_progress_rate / 100)
    completion_vs_time_gap_pp = round(completion_rate - time_progress_rate, 1)
    gap_to_time_qty = actual_qty - expected_qty_by_time
    remaining_qty = max(0, planned_qty - actual_qty)
    remaining_business_minutes = _remaining_business_minutes(range_end, reference_time)
    required_qty_per_hour = (
        round(remaining_qty / (remaining_business_minutes / 60), 1)
        if planned_qty > 0 and remaining_business_minutes and remaining_business_minutes > 0
        else None
    )
    reporting_mix = None
    if source_process == "machining":
        source_rows = [row for row in (source.get("rows") or []) if isinstance(row, dict)]
        mes_confirmed_qty = sum(_safe_int(row.get("mes_qty")) for row in source_rows)
        manual_open_qty = sum(_safe_int(row.get("manual_open_qty")) for row in source_rows)
        matched_manual_qty = sum(_safe_int(row.get("matched_manual_qty")) for row in source_rows)
        reported_defect_qty = sum(_safe_int(row.get("defect_qty")) for row in source_rows)
        status_counts = Counter(
            str(row.get("status") or "unknown")
            for row in source_rows
        )
        reporting_mix = {
            "effective_actual_qty": actual_qty,
            "mes_confirmed_qty": mes_confirmed_qty,
            "manual_open_qty": manual_open_qty,
            "matched_manual_qty": matched_manual_qty,
            "reported_defect_qty": reported_defect_qty,
            "manual_open_share_percent": (
                round(safe_rate(manual_open_qty, actual_qty), 1)
                if actual_qty > 0 else None
            ),
            "manual_open_row_count": sum(
                1 for row in source_rows if _safe_int(row.get("manual_open_qty")) > 0
            ),
            "status_counts": dict(sorted(status_counts.items())),
            "data_quality_note": "Manual-open quantity is included in effective actual output but is still awaiting MES reconciliation.",
        }
    return {
        "key": key,
        "source_process": source_process,
        "display_semantics": display_semantics,
        "title": title,
        "planned_qty": planned_qty,
        "actual_qty": actual_qty,
        "completion_rate": completion_rate,
        "time_progress_rate": time_progress_rate,
        "forecast_completion_rate": forecast_completion_rate,
        "completion_vs_time_gap_pp": completion_vs_time_gap_pp,
        "expected_qty_by_time": expected_qty_by_time,
        "gap_to_time_qty": gap_to_time_qty,
        # The pace index is intentionally the same linear ratio as the existing
        # end-of-day forecast.  The second name makes the completion-vs-time
        # comparison explicit to wall-board clients without changing v1 fields.
        "pace_index_percent": forecast_completion_rate,
        "pace_status": _pace_status(planned_qty, completion_vs_time_gap_pp),
        "remaining_qty": remaining_qty,
        "remaining_business_minutes": remaining_business_minutes,
        "required_qty_per_hour": required_qty_per_hour,
        "reporting_mix": reporting_mix,
        "active_equipment_count": _safe_int(source.get("active_equipment_count")),
        "running_equipment_count": _safe_int(source.get("running_equipment_count")),
        "total_equipment_count": _safe_int(source.get("total_equipment_count")),
        "plan_row_count": _safe_int(source.get("plan_row_count")),
        "calculation_basis": (
            "MES shot counter × cavity, allocated in production-plan sequence"
            if source_process == "injection"
            else "effective actual = MES-credited quantity (including matched manual reports) + open manual quantity awaiting MES reconciliation"
        ),
        "forecast_calculation_basis": (
            "linear end-of-business-day projection = completion rate / time progress rate × 100"
        ),
        "pace_calculation_basis": (
            "expected quantity by now = planned quantity × elapsed business-day percentage; "
            "behind means completion is more than 5 percentage points below elapsed time"
        ),
    }


def _resolved_current_parts(
    machine_row: dict[str, Any],
    *,
    require_recent_activity: bool = True,
    require_part_number: bool = True,
    allowed_statuses: tuple[str, ...] = ("in_progress",),
) -> list[dict[str, Any]]:
    """Return only parts deterministically resolved as the in-progress plan group.

    The canonical retriever's sequence/cavity allocation is the product
    evidence.  Quality context additionally requires recent counter movement,
    while the equipment feed may retain the assigned in-progress model when
    the machine has no activity in the latest window or its plan has a model
    but no part number.  Completed and pending rows are never promoted to the
    current product in either mode.  Quality keeps requiring an exact part
    number because it must never match history by model name alone.
    """
    if require_recent_activity and (
        not machine_row.get("is_running")
        or _safe_int(machine_row.get("recent_60m_shots")) <= 0
    ):
        return []

    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for part in machine_row.get("parts") or []:
        part_status = str(part.get("status") or "")
        if part_status not in allowed_statuses:
            continue
        normalized = _normalize_part_no(part.get("part_no"))
        model_name = str(part.get("model_name") or "").strip()
        has_part_number = bool(normalized and normalized != "-")
        if require_part_number and not has_part_number:
            continue
        if not has_part_number and (not model_name or model_name == "-"):
            continue
        dedupe_key = f"part:{normalized}" if has_part_number else f"model:{_normalize_part_no(model_name)}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        resolved.append({
            "part_no": str(part.get("part_no") or "-").strip().upper() or "-",
            "normalized_part_no": normalized if has_part_number else "",
            "model_name": model_name or "-",
            "sequence": _safe_int(part.get("sequence")),
            "status": part_status,
            "production_group_id": part.get("production_group_id"),
            "production_group_complete": bool(part.get("production_group_complete", True)),
        })
    return resolved


def _equipment_display_parts(machine_row: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    """Match the injection board's deterministic product display fallback.

    Prefer the cavity/sequence-allocated in-progress group.  If production has
    not started and every item is still pending, show only the earliest pending
    plan group.  This fallback is equipment-display context only: quality
    matching continues to call ``_resolved_current_parts`` with its strict
    in-progress + recent-activity requirements.
    """
    in_progress = _resolved_current_parts(
        machine_row,
        require_recent_activity=False,
        require_part_number=False,
    )
    if in_progress:
        return in_progress, "in_progress"

    pending = _resolved_current_parts(
        machine_row,
        require_recent_activity=False,
        require_part_number=False,
        allowed_statuses=("pending",),
    )
    if not pending:
        return [], None

    first = min(pending, key=lambda part: (part.get("sequence") or 999999))
    group_id = first.get("production_group_id")
    if group_id:
        selected = [part for part in pending if part.get("production_group_id") == group_id]
    else:
        selected = [first]
    return selected, "first_pending"


def _quality_report_groups(
    normalized_parts: set[str],
    *,
    history_start: datetime,
    history_end: datetime,
) -> tuple[dict[str, list[dict[str, Any]]], int, datetime | None]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if not normalized_parts:
        return groups, 0, None

    rows = (
        QualityReport.objects
        .filter(
            section="LQC_INJ",
            report_dt__gte=history_start,
            report_dt__lte=history_end,
        )
        .exclude(part_no="")
        .order_by("-report_dt", "-id")
        .values(
            "id",
            "report_dt",
            "part_no",
            "model",
            "judgement",
            "phenomenon",
            "disposition",
            "action_result",
        )
    )
    evaluated_count = 0
    latest_at = None
    for row in rows.iterator():
        evaluated_count += 1
        normalized = _normalize_part_no(row.get("part_no"))
        if normalized not in normalized_parts:
            continue
        report_at = row.get("report_dt")
        if report_at and (latest_at is None or report_at > latest_at):
            latest_at = report_at
        groups[normalized].append({
            "id": row.get("id"),
            "report_at": _iso(report_at),
            "part_no": row.get("part_no") or "",
            "model_name": row.get("model") or "",
            "judgement": row.get("judgement") or "",
            "phenomenon": row.get("phenomenon") or "",
            "disposition": row.get("disposition") or "",
            "action_result": row.get("action_result") or "",
            "claim_scope": "historical_quality_report_only",
        })
    return groups, evaluated_count, latest_at


def _build_quality_attention(
    injection: dict[str, Any],
    *,
    reference_time: datetime,
    language: str,
) -> tuple[dict[str, Any], list[str], dict[str, Any], dict[str, Any]]:
    warnings: list[str] = []
    resolved_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    unresolved_machines: list[dict[str, Any]] = []

    for machine in injection.get("machine_rows") or []:
        if not machine.get("is_running") or _safe_int(machine.get("recent_60m_shots")) <= 0:
            continue
        parts = _resolved_current_parts(machine)
        if not parts:
            machine_number = _safe_int(machine.get("machine_number"))
            warnings.append(f"quality_current_part_unresolved:{machine_number or 'unknown'}")
            unresolved_machines.append({
                "machine_number": machine_number or None,
                "machine_name": machine.get("machine") or machine.get("machine_name") or "",
                "recent_60m_shots": _safe_int(machine.get("recent_60m_shots")),
                "reason": "recent_activity_without_in_progress_plan_allocation",
            })
            continue
        resolved_rows.append((machine, parts))

    normalized_parts = {
        part["normalized_part_no"]
        for _machine, parts in resolved_rows
        for part in parts
    }
    history_end = reference_time
    history_start = history_end - timedelta(days=QUALITY_HISTORY_DAYS)
    groups, evaluated_count, latest_matched_at = _quality_report_groups(
        normalized_parts,
        history_start=history_start,
        history_end=history_end,
    )

    items: list[dict[str, Any]] = []
    matched_report_ids: set[int] = set()
    for machine, parts in resolved_rows:
        part_items = []
        for part in parts:
            reports = groups.get(part["normalized_part_no"], [])
            matched_report_ids.update(
                report_id
                for report_id in (report.get("id") for report in reports)
                if isinstance(report_id, int)
            )
            top_phenomena = Counter(
                str(report.get("phenomenon") or "").strip()
                for report in reports
                if str(report.get("phenomenon") or "").strip()
            ).most_common(3)
            part_items.append({
                "part_no": part["part_no"],
                "model_name": part["model_name"],
                "sequence": part["sequence"],
                "production_group_id": part["production_group_id"],
                "production_group_complete": part["production_group_complete"],
                "match_type": "exact_normalized_full_part_no",
                "historical_report_count": len(reports),
                "latest_historical_report_at": reports[0]["report_at"] if reports else None,
                "top_phenomena": [
                    {"phenomenon": phenomenon, "report_count": count}
                    for phenomenon, count in top_phenomena
                ],
                "recent_historical_reports": reports[:3],
            })
        items.append({
            "machine_number": _safe_int(machine.get("machine_number")) or None,
            "machine_name": machine.get("machine") or machine.get("machine_name") or "",
            "recent_60m_shots": _safe_int(machine.get("recent_60m_shots")),
            "resolution": {
                "status": "resolved",
                "method": "recent_machine_activity_plus_plan_sequence_cavity_allocation",
                "confidence": "estimated_from_verified_counters_and_plan",
                "activity_window_minutes": QUALITY_ACTIVITY_WINDOW_MINUTES,
            },
            "parts": part_items,
            "historical_report_count": sum(item["historical_report_count"] for item in part_items),
        })

    items.sort(key=lambda item: item.get("machine_number") or 999)
    quality = {
        "scope": "historical_quality_attention_for_resolved_running_injection_parts",
        "history_window_days": QUALITY_HISTORY_DAYS,
        "history_start": _iso(history_start),
        "history_end": _iso(history_end),
        "report_section": "LQC_INJ",
        "part_match_type": "exact_normalized_full_part_no",
        "disclaimer": COPY[language]["quality_disclaimer"],
        "items": items,
        "unresolved_machines": unresolved_machines,
        "resolved_machine_count": len(items),
        # A single historical report may be relevant to the same part running
        # on more than one machine. Count source reports once at summary grain;
        # the per-machine/per-part counts intentionally remain contextual.
        "matched_historical_report_count": len(matched_report_ids),
    }
    source = _source_state(
        status="ok" if normalized_parts else "no_resolved_current_parts",
        latest_at=latest_matched_at,
        row_count=evaluated_count,
        stale=False,
        detail="Only 90-day LQC_INJ rows were evaluated; only exact normalized full-part matches are returned.",
    )
    trace = {
        "source": "quality.QualityReport",
        "status": source["status"],
        "rows_evaluated": evaluated_count,
        "rows_returned": len(matched_report_ids),
        "join": "exact normalized full part_no",
    }
    return quality, warnings, source, trace


def _quality_plan_group_label(values: Any, language: str) -> str:
    rows = [str(value or "").strip() for value in values or [] if str(value or "").strip()]
    if not rows:
        return "-"
    if len(rows) == 1:
        return rows[0]
    suffix = f" 외 {len(rows) - 1}" if language == "ko" else f" 另{len(rows) - 1}"
    return f"{rows[0]}{suffix}"


def _build_daily_plan_quality_items(
    target_date: date,
    *,
    language: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return one compact wall slide per daily-attention plan group."""

    cache_key = f"overview-board:quality-plan-groups:v1:{target_date.isoformat()}:{language}"
    cached = cache.get(cache_key)
    if isinstance(cached, dict) and isinstance(cached.get("items"), list):
        return list(cached["items"]), dict(cached.get("meta") or {})

    source = build_daily_quality_attention(target_date, include_images=False)
    items: list[dict[str, Any]] = []
    for index, row in enumerate(source.get("items") or []):
        if not isinstance(row, dict):
            continue
        phenomena = [
            str(value.get("phenomenon") or "").strip()
            for value in row.get("top_phenomena") or []
            if isinstance(value, dict) and str(value.get("phenomenon") or "").strip()
        ]
        machine_name = str(row.get("machine_name") or "").strip()
        if not machine_name:
            continue
        source_key = str(row.get("source_key") or f"quality-plan-{index}")
        items.append({
            "id": source_key,
            "machine_name": machine_name,
            "machine_number": row.get("machine_number"),
            "model_name": _quality_plan_group_label(row.get("model_names"), language),
            "part_no": _quality_plan_group_label(row.get("part_nos"), language),
            "part_prefix": row.get("part_prefix"),
            "phenomena": phenomena,
            "matching_report_count": _safe_int(row.get("matching_report_count")),
            "latest_report_dt": row.get("latest_report_dt"),
            "match_label": "품번 앞 9자리 · 전체 이력" if language == "ko" else "品号前9位 · 全部历史",
        })
    meta = {
        "business_date": source.get("date") or target_date.isoformat(),
        "history_coverage": source.get("history_window") or "all_history",
        "match_basis": source.get("match_basis") or "part_prefix_9",
        "source_plan_hash": source.get("source_plan_hash"),
        "plan_group_count": _safe_int(source.get("total_plan_count")),
        "matched_report_count": _safe_int(source.get("total_matching_reports")),
    }
    cache.set(cache_key, {"items": items, "meta": meta}, timeout=300)
    return items, meta


def _build_energy(
    *,
    target_date: date,
    range_start: datetime,
    range_end: datetime,
    reference_time: datetime,
) -> tuple[dict[str, Any], list[str], dict[str, Any], dict[str, Any]]:
    warnings: list[str] = []
    counter_end = min(range_end, reference_time + timedelta(microseconds=1))
    trend_end = min(range_end, reference_time).astimezone(SHANGHAI_TZ).replace(
        minute=0,
        second=0,
        microsecond=0,
    )
    trend_display_start = trend_end - timedelta(hours=24)
    trend_calculation_start = trend_display_start - timedelta(hours=23)
    records = list(
        InjectionMonitoringRecord.objects
        .filter(timestamp__gte=trend_calculation_start, timestamp__lt=counter_end)
        .filter(power_kwh__isnull=False)
        .filter(power_kwh__gte=0)
        .order_by("machine_name", "timestamp")
        .values("machine_name", "timestamp", "power_kwh")
    )
    records_by_machine: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in records:
        records_by_machine[str(row["machine_name"])].append(row)

    current_records_by_machine = {
        machine_name: [
            row for row in machine_records
            if range_start <= row["timestamp"] < counter_end
        ]
        for machine_name, machine_records in records_by_machine.items()
    }
    machine_names = sorted(
        machine_name
        for machine_name, machine_records in current_records_by_machine.items()
        if machine_records
    )
    latest_at = max(
        (
            row["timestamp"]
            for machine_records in current_records_by_machine.values()
            for row in machine_records
        ),
        default=None,
    )
    current_power_baselines = _latest_counter_baselines(
        machine_names,
        before=range_start,
        field="power_kwh",
    )
    usage_by_machine = []
    usage_by_machine_name: dict[str, float] = {}
    for machine_name in machine_names:
        values = [row["power_kwh"] for row in current_records_by_machine[machine_name]]
        usage = _positive_float_counter_delta(
            values,
            baseline=current_power_baselines.get(machine_name),
        )
        usage_by_machine_name[machine_name] = float(usage)
        if usage <= 0:
            continue
        usage_by_machine.append({
            "machine_name": machine_name,
            "usage_kwh": round(float(usage), 2),
        })
    usage_by_machine.sort(key=lambda row: row["machine_name"])

    capacity_records = list(
        InjectionMonitoringRecord.objects
        .filter(
            machine_name__in=machine_names,
            timestamp__gte=range_start,
            timestamp__lt=counter_end,
            capacity__isnull=False,
            capacity__gte=0,
        )
        .order_by("machine_name", "timestamp")
        .values("machine_name", "capacity")
    )
    capacity_values_by_machine: dict[str, list[float]] = defaultdict(list)
    for row in capacity_records:
        capacity_values_by_machine[str(row["machine_name"])].append(float(row["capacity"]))
    capacity_baselines = _latest_counter_baselines(
        machine_names,
        before=range_start,
        field="capacity",
    )
    efficiency_machine_count = 0
    efficiency_energy_kwh = 0.0
    total_shots = 0.0
    for machine_name in machine_names:
        capacity_values = capacity_values_by_machine.get(machine_name, [])
        capacity_baseline = capacity_baselines.get(machine_name)
        has_counter_interval = bool(
            (capacity_baseline is not None and capacity_values)
            or len(capacity_values) >= 2
        )
        if not has_counter_interval:
            continue
        efficiency_machine_count += 1
        efficiency_energy_kwh += usage_by_machine_name.get(machine_name, 0.0)
        total_shots += _positive_float_counter_delta(
            capacity_values,
            baseline=capacity_baseline,
        )
    energy_per_1000_shots_kwh = (
        efficiency_energy_kwh / total_shots * 1000
        if total_shots > 0 else None
    )
    if machine_names and efficiency_machine_count < len(machine_names):
        warnings.append("energy_efficiency_coverage_partial")

    trend_machine_names = sorted(records_by_machine)
    trend_power_baselines = _latest_counter_baselines(
        trend_machine_names,
        before=trend_calculation_start,
        field="power_kwh",
    )
    trend_usage: dict[datetime, float] = defaultdict(float)
    trend_coverage: dict[datetime, set[str]] = defaultdict(set)
    for machine_name in trend_machine_names:
        previous = trend_power_baselines.get(machine_name)
        for row in records_by_machine[machine_name]:
            current = float(row["power_kwh"])
            if previous is None:
                previous = current
                continue
            delta = _positive_float_counter_increment(previous, current)
            bucket_start = _counter_sample_hour(row["timestamp"])
            if trend_calculation_start <= bucket_start < trend_end:
                trend_usage[bucket_start] += max(0.0, delta)
                trend_coverage[bucket_start].add(machine_name)
            previous = current

    calculation_buckets = [
        trend_calculation_start + timedelta(hours=index)
        for index in range(47)
    ]
    calculation_values: list[float | None] = [
        round(trend_usage[bucket], 2) if trend_coverage.get(bucket) else None
        for bucket in calculation_buckets
    ]

    def moving_average(index: int, window: int) -> float | None:
        start_index = index - window + 1
        if start_index < 0:
            return None
        values = calculation_values[start_index:index + 1]
        if any(value is None for value in values):
            return None
        return round(sum(float(value) for value in values) / window, 2)

    hourly_trend = []
    for index, bucket in enumerate(calculation_buckets):
        if bucket < trend_display_start:
            continue
        hourly_trend.append({
            "timestamp": bucket.isoformat(),
            "label": bucket.strftime("%H:%M"),
            "usage_kwh": calculation_values[index],
            "ma_8h_kwh": moving_average(index, 8),
            "ma_12h_kwh": moving_average(index, 12),
            "ma_24h_kwh": moving_average(index, 24),
            "coverage_machine_count": len(trend_coverage.get(bucket, set())),
            "is_current_business_day": range_start <= bucket < range_end,
        })

    current_day = current_shanghai_business_date()
    is_stale = bool(
        target_date == current_day
        and (
            latest_at is None
            or timezone.now() - latest_at.astimezone(timezone.get_current_timezone())
            > timedelta(minutes=ENERGY_STALE_AFTER_MINUTES)
        )
    )
    if not machine_names:
        warnings.append("energy_power_data_missing")
    elif is_stale:
        warnings.append("energy_power_data_stale")
    if not any(point["usage_kwh"] is not None for point in hourly_trend):
        warnings.append("energy_hourly_trend_missing")

    energy = {
        "usage_kwh": round(sum(row["usage_kwh"] for row in usage_by_machine), 2),
        "unit": "kWh",
        "metered_machine_count": len(machine_names),
        "machines_with_positive_usage_count": len(usage_by_machine),
        "usage_by_machine": usage_by_machine,
        "total_shots": int(round(total_shots)),
        "energy_per_1000_shots_kwh": (
            round(energy_per_1000_shots_kwh, 2)
            if energy_per_1000_shots_kwh is not None else None
        ),
        "efficiency_metered_machine_count": efficiency_machine_count,
        "efficiency_calculation_basis": "same-window positive power_kwh delta / positive capacity-counter shot delta × 1,000 for machines with both counters",
        "hourly_trend": hourly_trend,
        "trend_window_hours": 24,
        "moving_average_windows_hours": [8, 12, 24],
        "trend_calculation_basis": "completed-hour aggregate reset-safe positive cumulative power_kwh deltas; trailing simple moving averages",
        "calculation_basis": "positive delta of cumulative MES power_kwh counter in the 08:00 business window",
    }
    source = _source_state(
        status="missing" if not machine_names else "stale" if is_stale else "ok",
        latest_at=latest_at,
        row_count=len(records),
        stale=is_stale,
    )
    trace = {
        "source": "injection.InjectionMonitoringRecord.power_kwh",
        "status": source["status"],
        "rows_returned": source["row_count"],
        "calculation": "business-day cumulative usage plus completed-hour 8/12/24 trailing averages and paired-counter kWh per 1,000 shots",
    }
    return energy, warnings, source, trace


def _build_inventory(
    *,
    target_date: date,
    range_end: datetime,
) -> tuple[dict[str, Any], list[str], dict[str, Any], dict[str, Any]]:
    warnings: list[str] = []
    latest_snapshot_date = (
        DailyInventorySnapshot.objects
        .filter(snapshot_date__lte=target_date)
        .order_by("-snapshot_date")
        .values_list("snapshot_date", flat=True)
        .first()
    )
    snapshot_rows = DailyInventorySnapshot.objects.none()
    if latest_snapshot_date:
        snapshot_rows = DailyInventorySnapshot.objects.filter(
            snapshot_date=latest_snapshot_date,
            warehouse_name__in=["成品仓库", "半成品仓库"],
        )
    aggregate = snapshot_rows.aggregate(
        sku_count=Count("id"),
        total_quantity=Sum("total_quantity"),
        total_carts=Sum("cart_count"),
        latest_at=Max("created_at"),
    )
    warehouses = list(
        snapshot_rows.values("warehouse_name").annotate(
            sku_count=Count("id"),
            total_quantity=Sum("total_quantity"),
            total_carts=Sum("cart_count"),
        ).order_by("warehouse_name")
    )
    for row in warehouses:
        row["total_quantity"] = float(row.get("total_quantity") or 0)
        row["total_carts"] = _safe_int(row.get("total_carts"))

    shipping_snapshot = (
        FinishedGoodsTransactionSnapshot.objects
        .filter(report_date__lte=target_date, scheduled_at__lte=range_end)
        .order_by("-scheduled_at")
        .first()
    )
    snapshot_is_current = latest_snapshot_date == target_date
    if latest_snapshot_date is None:
        warnings.append("inventory_snapshot_missing")
    elif not snapshot_is_current:
        warnings.append("inventory_snapshot_not_for_business_date")
    if shipping_snapshot is None:
        warnings.append("finished_goods_shipping_snapshot_missing")

    (
        outbound_performance,
        outbound_warnings,
        outbound_source,
        outbound_trace,
    ) = get_outbound_performance(target_date)
    warnings.extend(outbound_warnings)

    inventory = {
        "snapshot_date": _iso(latest_snapshot_date),
        "snapshot_matches_business_date": snapshot_is_current,
        "finished_and_semifinished": {
            "sku_count": _safe_int(aggregate.get("sku_count")),
            "total_quantity": float(aggregate.get("total_quantity") or 0),
            "total_carts": _safe_int(aggregate.get("total_carts")),
            "warehouses": warehouses,
        },
        "shipping": {
            "snapshot_at": _iso(shipping_snapshot.scheduled_at) if shipping_snapshot else None,
            "slot": shipping_snapshot.slot if shipping_snapshot else None,
            "total_in": float(shipping_snapshot.total_in) if shipping_snapshot else 0,
            "total_out": float(shipping_snapshot.total_out) if shipping_snapshot else 0,
            "net_change": float(shipping_snapshot.net_change) if shipping_snapshot else 0,
            "record_count": _safe_int(shipping_snapshot.record_count) if shipping_snapshot else 0,
        },
        "outbound_performance": outbound_performance,
    }
    legacy_source_status = "missing" if latest_snapshot_date is None else "stale" if not snapshot_is_current else "ok"
    legacy_source_latest = max(
        [value for value in [aggregate.get("latest_at"), shipping_snapshot.scheduled_at if shipping_snapshot else None] if value],
        default=None,
    )
    outbound_status = str(outbound_source.get("status") or "error")
    if outbound_status == "error":
        source_status = "error"
    elif outbound_status == "partial" or legacy_source_status in {"missing", "stale"}:
        source_status = "partial"
    else:
        source_status = "ok"
    source_latest = outbound_source.get("source_latest_at") or legacy_source_latest
    source = _source_state(
        status=source_status,
        latest_at=source_latest,
        row_count=(
            _safe_int(aggregate.get("sku_count"))
            + _safe_int(outbound_source.get("row_count"))
        ),
        stale=bool(latest_snapshot_date and not snapshot_is_current),
    )
    source["components"] = {
        "inventory_snapshots": legacy_source_status,
        "outbound_performance": outbound_status,
    }
    trace = {
        "source": (
            "inventory.DailyInventorySnapshot + FinishedGoodsTransactionSnapshot "
            "+ BLACKLAKE outbound_order._list items[]"
        ),
        "status": source_status,
        "rows_returned": source["row_count"],
        "components": [
            {
                "source": "inventory.DailyInventorySnapshot + FinishedGoodsTransactionSnapshot",
                "status": legacy_source_status,
                "rows_returned": _safe_int(aggregate.get("sku_count")),
                "source_latest_at": _iso(legacy_source_latest),
            },
            outbound_trace,
        ],
    }
    return inventory, warnings, source, trace


def _build_moulds() -> tuple[dict[str, Any], list[str], dict[str, Any], dict[str, Any]]:
    warnings: list[str] = []
    snapshot = MouldDataSnapshot.objects.filter(snapshot_key=BOARD_SNAPSHOT_KEY).first()
    if snapshot is None:
        warnings.append("mould_board_snapshot_missing")
        moulds = {
            "total": 0,
            "mounted": 0,
            "stored": 0,
            "maintenance": 0,
            "repair": 0,
            "conflicts": 0,
            "confirmation_required": 0,
        }
        source = _source_state(status="missing")
        return moulds, warnings, source, {
            "source": "injection.MouldDataSnapshot",
            "status": "missing",
            "rows_returned": 0,
        }

    # The mould board stores the public-safe base snapshot, then decorates it at
    # read time with 100k-shot milestones and their confirmation state.  Reuse
    # that exact path here so the overview cannot silently report zero while
    # the dedicated mould board shows inspection-due badges.
    payload = decorate_board_payload(
        snapshot.payload if isinstance(snapshot.payload, dict) else {}
    )
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    mould_rows = payload.get("moulds") if isinstance(payload.get("moulds"), list) else []
    freshness = payload.get("data_freshness") if isinstance(payload.get("data_freshness"), dict) else {}
    stale = bool(freshness.get("stale"))
    if stale:
        warnings.append("mould_board_snapshot_stale")
    if snapshot.last_error:
        warnings.append("mould_board_snapshot_last_refresh_failed")
    moulds = {
        "total": _safe_int(summary.get("total")),
        "mounted": _safe_int(summary.get("mounted")),
        "stored": _safe_int(summary.get("stored")),
        "maintenance": _safe_int(summary.get("maintenance")),
        "repair": _safe_int(summary.get("repair")),
        "offsite": _safe_int(summary.get("offsite")),
        "unknown": _safe_int(summary.get("unknown")),
        "conflicts": _safe_int(summary.get("conflicts")),
        "confirmation_required": sum(1 for row in mould_rows if isinstance(row, dict) and row.get("confirmation_required")),
    }
    latest_at = snapshot.source_latest_at or freshness.get("source_latest_at") or snapshot.refreshed_at
    source = _source_state(
        status="stale" if stale else "ok",
        latest_at=latest_at,
        row_count=len(mould_rows),
        stale=stale,
        detail=snapshot.last_error or None,
    )
    trace = {
        "source": "injection.MouldDataSnapshot",
        "status": source["status"],
        "rows_returned": len(mould_rows),
    }
    return moulds, warnings, source, trace


def _verified_oee_factor(source: dict[str, Any], name: str) -> dict[str, Any] | None:
    """Accept an OEE factor only when the retriever explicitly verifies it.

    This keeps a future source integration possible without silently treating
    completion, recent activity, or historical quality history as standard OEE
    Availability, Performance, or Quality.
    """
    factors = source.get("oee_factors") if isinstance(source.get("oee_factors"), dict) else {}
    candidate = factors.get(name) if isinstance(factors.get(name), dict) else None
    if not candidate or candidate.get("source_backed") is not True or not candidate.get("source"):
        return None
    try:
        value = float(candidate.get("value_percent"))
    except (TypeError, ValueError, OverflowError):
        return None
    if value < 0 or value > 100:
        return None
    return {
        "value_percent": round(value, 1),
        "status": "verified",
        "source": str(candidate.get("source")),
        "reason": None,
        "calculation_basis": candidate.get("calculation_basis"),
    }


def _build_oee_contract(
    injection: dict[str, Any],
    *,
    operating_rate_percent: float | None,
) -> dict[str, Any]:
    verified = {
        name: _verified_oee_factor(injection, name)
        for name in ("availability", "performance", "quality")
    }
    availability = verified["availability"] or {
        "value_percent": None,
        "status": "proxy_only" if operating_rate_percent is not None else "unavailable",
        "source": "MES capacity-counter movement in the latest 60 minutes" if operating_rate_percent is not None else None,
        "reason": (
            "Recent fleet activity is an operating-rate proxy, not run time divided by planned production time."
            if operating_rate_percent is not None
            else "Verified run time and planned production time are unavailable at a matching equipment-time grain."
        ),
        "proxy_value_percent": operating_rate_percent,
        "proxy_name": "recent_60m_fleet_activity_rate",
    }
    performance = verified["performance"] or {
        "value_percent": None,
        "status": "unavailable",
        "source": None,
        "reason": "Ideal cycle time, total count, and verified run time are not available at one matching current-production grain.",
    }
    quality = verified["quality"] or {
        "value_percent": None,
        "status": "unavailable",
        "source": None,
        "reason": "Verified current good and defect counts are unavailable at the same MES production grain; historical quality reports are excluded.",
    }
    factors = {
        "availability": availability,
        "performance": performance,
        "quality": quality,
    }
    verified_values = [
        factor.get("value_percent")
        for factor in factors.values()
        if factor.get("status") == "verified" and factor.get("value_percent") is not None
    ]
    available_factor_count = len(verified_values)
    oee_percent = None
    if available_factor_count == 3:
        oee_percent = round(
            float(factors["availability"]["value_percent"])
            * float(factors["performance"]["value_percent"])
            * float(factors["quality"]["value_percent"])
            / 10000,
            1,
        )
    return {
        "value_percent": oee_percent,
        "status": "calculated_verified_factors" if oee_percent is not None else "not_calculable_missing_verified_factors",
        "available_factor_count": available_factor_count,
        "required_factor_count": 3,
        "factor_coverage_percent": round(available_factor_count / 3 * 100, 1),
        "factors": factors,
        "calculation_basis": "OEE = Availability × Performance × Quality; calculated only when all three factors are source-backed at a matching grain.",
        "data_quality_note": "The 90-day quality-attention feed is historical context and is never used as the current OEE Quality factor.",
    }


def _machine_pace_payload(row: dict[str, Any], *, time_progress_rate: float) -> dict[str, Any]:
    planned_qty = _safe_int(row.get("planned_qty"))
    actual_qty = _safe_int(row.get("actual_qty"))
    completion_rate = round(float(row.get("progress_rate") or safe_rate(actual_qty, planned_qty)), 1)
    expected_qty_by_time = _safe_int(planned_qty * time_progress_rate / 100)
    gap_pp = round(completion_rate - time_progress_rate, 1)
    return {
        "planned_qty": planned_qty,
        "actual_qty": actual_qty,
        "completion_rate": completion_rate,
        "time_progress_rate": round(time_progress_rate, 1),
        "expected_qty_by_time": expected_qty_by_time,
        "gap_to_time_qty": actual_qty - expected_qty_by_time,
        "gap_to_time_rate_pp": gap_pp,
        "pace_index_percent": round(safe_rate(completion_rate, time_progress_rate), 1) if planned_qty > 0 and time_progress_rate > 0 else None,
        "pace_status": _pace_status(planned_qty, gap_pp),
        "remaining_qty": max(0, planned_qty - actual_qty),
    }


def _machine_production_state(
    *,
    is_running: bool,
    has_plan: bool,
    actual_qty: int,
    planned_qty: int,
    resolved_part_count: int,
) -> tuple[str, str]:
    """Return an explicit state without guessing a current product.

    A positive recent capacity-counter delta proves recent machine activity,
    but a product is considered current only when the deterministic
    plan-sequence/cavity allocation has an in-progress row.  In particular, a
    completed plan is never presented as the product still on the machine.
    """
    if is_running and resolved_part_count > 0:
        return "running_resolved", "recent_activity_and_in_progress_plan_allocation"
    if is_running and has_plan:
        return "running_part_unresolved", "recent_activity_without_in_progress_plan_allocation"
    if is_running:
        return "running_without_plan", "recent_activity_without_production_plan"
    if has_plan and actual_qty >= planned_qty:
        return "plan_completed", "planned_quantity_reached_without_recent_activity"
    if has_plan and actual_qty > 0:
        return "planned_stopped", "partial_plan_output_without_recent_activity"
    return "planned_waiting", "production_plan_without_recent_activity"


def _current_part_resolution(
    *,
    production_state: str,
    resolved_part_count: int,
    display_basis: str | None = None,
) -> dict[str, Any]:
    if display_basis == "first_pending" and resolved_part_count > 0:
        return {
            "status": "planned",
            "method": "first_pending_plan_group_same_as_injection_board",
            "reason": "no_in_progress_group; showing earliest pending plan group",
            "resolved_part_count": resolved_part_count,
        }
    if production_state == "running_resolved":
        return {
            "status": "resolved",
            "method": "recent_machine_activity_plus_plan_sequence_cavity_allocation",
            "reason": None,
            "resolved_part_count": resolved_part_count,
        }
    if resolved_part_count > 0:
        return {
            "status": "resolved",
            "method": "in_progress_plan_sequence_cavity_allocation",
            "reason": "assigned_in_progress_plan_segment_without_recent_machine_activity",
            "resolved_part_count": resolved_part_count,
        }
    if production_state == "running_without_plan":
        return {
            "status": "unresolved",
            "method": None,
            "reason": "production_plan_missing_for_recently_active_machine",
            "resolved_part_count": 0,
        }
    if production_state == "running_part_unresolved":
        return {
            "status": "unresolved",
            "method": None,
            "reason": "no_in_progress_part_after_plan_sequence_cavity_allocation",
            "resolved_part_count": 0,
        }
    return {
        "status": "not_applicable",
        "method": None,
        "reason": "no_recent_machine_activity",
        "resolved_part_count": 0,
    }


def _recent_activity_average_ct(
    activity: dict[str, Any],
    *,
    shot_count: int,
) -> float | None:
    if shot_count <= 0:
        return None
    window_start = activity.get("window_start")
    window_end = activity.get("window_end")
    if isinstance(window_start, datetime) and isinstance(window_end, datetime):
        seconds = max(0.0, (window_end - window_start).total_seconds())
    else:
        seconds = max(0, _safe_int(activity.get("lookback_minutes") or 60)) * 60
    return round(seconds / shot_count, 1) if seconds > 0 else None


def _build_equipment(
    injection: dict[str, Any],
    assembly: dict[str, Any],
    *,
    injection_activity: dict[str, Any],
) -> dict[str, Any]:
    injection_time_progress = round(float(injection.get("time_progress_rate") or 0), 1)
    active_rows = injection_activity.get("rows") if isinstance(injection_activity.get("rows"), list) else []
    active_by_machine_number = {
        _safe_int(row.get("machine_number")): row
        for row in active_rows
        if isinstance(row, dict) and _safe_int(row.get("machine_number")) > 0
    }
    activity_source_latest_at = injection_activity.get("latest_mes_time")
    activity_source_status = (
        "missing" if activity_source_latest_at is None
        else "stale" if injection_activity.get("is_stale")
        else "ok"
    )
    activity_window_minutes = _safe_int(injection_activity.get("lookback_minutes") or 60)
    injection_rows = []
    for row in injection.get("machine_rows") or []:
        machine_number = _safe_int(row.get("machine_number")) or None
        activity_row = active_by_machine_number.get(machine_number or 0)
        # Keep the canonical daily retriever's activity signal as a fallback;
        # the dedicated activity query additionally catches machines that have
        # recent counter movement but no production plan.
        is_running = bool(activity_row) or bool(row.get("is_running"))
        # A stopped/paused machine can still have a deterministic assigned model: the
        # canonical sequence/cavity allocation marks that plan segment as
        # in_progress.  Do not require a shot in the last hour for the equipment
        # label; the separate machine state continues to show it as stopped.
        # Quality keeps the stricter recent-activity requirement.
        resolved, display_basis = _equipment_display_parts(row)
        pace = _machine_pace_payload(row, time_progress_rate=injection_time_progress)
        has_plan = pace["planned_qty"] > 0
        production_state, state_reason = _machine_production_state(
            is_running=is_running,
            has_plan=has_plan,
            actual_qty=pace["actual_qty"],
            planned_qty=pace["planned_qty"],
            resolved_part_count=len(resolved),
        )
        if display_basis == "first_pending":
            state_reason = (
                "recent_activity_plus_first_pending_plan_group"
                if is_running
                else "first_pending_plan_group_without_recent_activity"
            )
        recent_shots = _safe_int(
            activity_row.get("shot_count") if activity_row else row.get("recent_60m_shots")
        )
        recent_avg_ct = row.get("recent_60m_avg_ct_sec")
        if recent_avg_ct is None and activity_row:
            recent_avg_ct = _recent_activity_average_ct(
                injection_activity,
                shot_count=recent_shots,
            )
        injection_rows.append({
            "machine_number": machine_number,
            "machine_name": row.get("machine") or row.get("machine_name") or "",
            "monitoring_name": row.get("machine_name") or "",
            "has_plan": has_plan,
            "is_running": is_running,
            "production_state": production_state,
            "state_reason": state_reason,
            "recent_60m_shots": recent_shots,
            "recent_60m_avg_ct_sec": round(float(recent_avg_ct), 1) if recent_avg_ct is not None else None,
            "source_status": activity_source_status,
            "source_latest_at": _iso(activity_source_latest_at),
            "activity_window_minutes": activity_window_minutes,
            **pace,
            "current_parts": [
                {"part_no": part["part_no"], "model_name": part["model_name"]}
                for part in resolved
            ],
            "resolved_current_part_count": len(resolved),
            "current_part_resolution": _current_part_resolution(
                production_state=production_state,
                resolved_part_count=len(resolved),
                display_basis=display_basis,
            ),
        })

    # The plan summary contains only planned machines. Add recent active
    # machines missing from it so the wall does not silently hide unplanned
    # production. Quantity remains zero because shots cannot be converted to
    # pieces without a resolved part/cavity; the UI receives an explicit state
    # instead of an invented current product.
    planned_machine_numbers = {
        _safe_int(row.get("machine_number"))
        for row in injection_rows
        if _safe_int(row.get("machine_number")) > 0
    }
    for machine_number, activity_row in active_by_machine_number.items():
        if machine_number in planned_machine_numbers:
            continue
        pace = _machine_pace_payload({}, time_progress_rate=injection_time_progress)
        recent_shots = _safe_int(activity_row.get("shot_count"))
        production_state, state_reason = _machine_production_state(
            is_running=True,
            has_plan=False,
            actual_qty=0,
            planned_qty=0,
            resolved_part_count=0,
        )
        injection_rows.append({
            "machine_number": machine_number,
            "machine_name": activity_row.get("machine") or activity_row.get("machine_name") or "",
            "monitoring_name": activity_row.get("machine_name") or "",
            "has_plan": False,
            "is_running": True,
            "production_state": production_state,
            "state_reason": state_reason,
            "recent_60m_shots": recent_shots,
            "recent_60m_avg_ct_sec": _recent_activity_average_ct(
                injection_activity,
                shot_count=recent_shots,
            ),
            "source_status": activity_source_status,
            "source_latest_at": _iso(activity_source_latest_at),
            "activity_window_minutes": activity_window_minutes,
            **pace,
            "current_parts": [],
            "resolved_current_part_count": 0,
            "current_part_resolution": _current_part_resolution(
                production_state=production_state,
                resolved_part_count=0,
            ),
        })

    state_order = {
        "running_resolved": 0,
        "running_part_unresolved": 1,
        "running_without_plan": 2,
        "planned_stopped": 3,
        "planned_waiting": 4,
        "plan_completed": 5,
    }
    injection_rows.sort(key=lambda row: (
        state_order.get(str(row.get("production_state")), 99),
        row.get("machine_number") or 999,
    ))

    assembly_groups: dict[str, dict[str, Any]] = {}
    for row in assembly.get("rows") or []:
        key = row.get("equipment_key") or row.get("equipment_label") or row.get("equipment_name") or "-"
        group = assembly_groups.setdefault(key, {
            "equipment_key": key,
            "equipment_name": row.get("equipment_label") or row.get("equipment_name") or key,
            "planned_qty": 0,
            "actual_qty": 0,
        })
        group["planned_qty"] += _safe_int(row.get("planned_qty"))
        group["actual_qty"] += _safe_int(row.get("actual_qty"))
    assembly_rows = []
    assembly_time_progress = round(float(assembly.get("time_progress_rate") or 0), 1)
    for row in assembly_groups.values():
        assembly_rows.append({
            **row,
            **_machine_pace_payload(row, time_progress_rate=assembly_time_progress),
        })
    assembly_rows.sort(key=lambda row: row["equipment_name"])

    active_machine_numbers = {
        _safe_int(row.get("machine_number"))
        for row in active_rows
        if _safe_int(row.get("machine_number")) > 0
    }
    planned_rows = [row for row in injection_rows if row["planned_qty"] > 0]
    planned_machine_numbers = {
        _safe_int(row.get("machine_number"))
        for row in planned_rows
        if _safe_int(row.get("machine_number")) > 0
    }
    total_equipment_count = _safe_int(injection.get("total_equipment_count"))
    running_equipment_count = len(active_machine_numbers)
    planned_equipment_count = len(planned_machine_numbers)
    scheduled_running_count = len(active_machine_numbers & planned_machine_numbers)
    stopped_planned_count = len(planned_machine_numbers - active_machine_numbers)
    unplanned_active_count = len(active_machine_numbers - planned_machine_numbers)
    activity_source_stale = bool(injection_activity.get("is_stale"))
    activity_metrics_available = bool(
        injection_activity.get("latest_mes_time") is not None
        and not activity_source_stale
    )
    operating_rate_percent = (
        round(safe_rate(running_equipment_count, total_equipment_count), 1)
        if total_equipment_count > 0 and activity_metrics_available else None
    )
    scheduled_operating_rate_percent = (
        round(safe_rate(scheduled_running_count, planned_equipment_count), 1)
        if planned_equipment_count > 0 and activity_metrics_available else None
    )

    pace_counts = Counter(row["pace_status"] for row in planned_rows)
    bottleneck = min(
        planned_rows,
        key=lambda row: (float(row.get("gap_to_time_rate_pp") or 0), row.get("machine_number") or 999),
        default=None,
    )
    bottleneck_payload = None
    if bottleneck:
        bottleneck_payload = {
            "machine_number": bottleneck.get("machine_number"),
            "machine_name": bottleneck.get("machine_name"),
            "completion_rate": bottleneck.get("completion_rate"),
            "time_progress_rate": bottleneck.get("time_progress_rate"),
            "gap_to_time_rate_pp": bottleneck.get("gap_to_time_rate_pp"),
            "gap_to_time_qty": bottleneck.get("gap_to_time_qty"),
            "pace_status": bottleneck.get("pace_status"),
            "current_parts": bottleneck.get("current_parts") or [],
        }

    injection_summary = {
        "scope": "injection_only",
        "activity_window_minutes": 60,
        "total_equipment_count": total_equipment_count,
        "planned_equipment_count": planned_equipment_count,
        "running_equipment_count": running_equipment_count,
        "scheduled_running_equipment_count": scheduled_running_count,
        "stopped_planned_equipment_count": stopped_planned_count,
        "unplanned_active_equipment_count": unplanned_active_count,
        "operating_rate_percent": operating_rate_percent,
        "operating_rate_definition": "machines with a positive MES capacity-counter delta in the latest 60 minutes / all registered injection machines × 100",
        "scheduled_operating_rate_percent": scheduled_operating_rate_percent,
        "scheduled_operating_rate_definition": "planned injection machines with a positive MES capacity-counter delta in the latest 60 minutes / planned injection machines × 100",
        "activity_source_latest_at": _iso(injection_activity.get("latest_mes_time")),
        "activity_source_stale": activity_source_stale,
        "activity_metrics_available": activity_metrics_available,
        "pace_counts": {
            "ahead": int(pace_counts.get("ahead", 0)),
            "on_track": int(pace_counts.get("on_track", 0)),
            "behind": int(pace_counts.get("behind", 0)),
            "no_plan": int(pace_counts.get("no_plan", 0)),
        },
        "bottleneck_machine": bottleneck_payload,
        "oee": _build_oee_contract(
            injection,
            operating_rate_percent=operating_rate_percent,
        ),
    }
    return {
        "injection": injection_rows,
        # Kept for additive v1 compatibility. The overview wall now treats the
        # equipment-state module as injection-only and may ignore this list.
        "assembly": assembly_rows,
        "injection_summary": injection_summary,
    }


def _build_attention(
    injection: dict[str, Any],
    assembly: dict[str, Any],
    moulds: dict[str, Any],
    *,
    language: str,
) -> list[dict[str, Any]]:
    copy = COPY[language]
    rows: list[dict[str, Any]] = []
    for machine in injection.get("machine_rows") or []:
        gap = float(machine.get("gap_to_time_rate_pp") or 0)
        if gap >= -5:
            continue
        machine_name = machine.get("machine") or machine.get("machine_name") or "-"
        rows.append({
            "type": "production_behind_time_progress",
            "severity": "warning",
            "process": "injection",
            "equipment": machine_name,
            "gap_to_time_rate_pp": round(gap, 1),
            "title": copy["behind_title"].format(machine=machine_name),
            "detail": copy["behind_detail"].format(gap=abs(gap)),
        })

    assembly_planned = _safe_int(assembly.get("planned_qty"))
    assembly_progress = float(assembly.get("progress_rate") or 0)
    time_progress = float(assembly.get("time_progress_rate") or 0)
    if assembly_planned > 0 and assembly_progress < time_progress - 5:
        gap = round(assembly_progress - time_progress, 1)
        rows.append({
            "type": "production_behind_time_progress",
            "severity": "warning",
            "process": "assembly",
            "equipment": None,
            "gap_to_time_rate_pp": gap,
            "title": copy["assembly_behind_title"],
            "detail": copy["behind_detail"].format(gap=abs(gap)),
        })

    conflicts = _safe_int(moulds.get("conflicts"))
    if conflicts > 0:
        rows.append({
            "type": "mould_location_conflict",
            "severity": "warning",
            "process": "mould",
            "equipment": None,
            "count": conflicts,
            "title": copy["mould_conflict_title"],
            "detail": copy["mould_conflict_detail"].format(count=conflicts),
        })

    rows.sort(
        key=lambda row: (
            0 if row["type"] == "production_behind_time_progress" else 1,
            float(row.get("gap_to_time_rate_pp") or 0),
        )
    )
    for index, row in enumerate(rows, start=1):
        row["rank"] = index
    return rows[:10]


def _production_source_states(
    *,
    target_date: date,
    injection: dict[str, Any],
    assembly: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    warnings: list[str] = []
    injection_latest = injection.get("latest_mes_time")
    is_current = target_date == current_shanghai_business_date()
    injection_stale = bool(
        is_current
        and (
            injection_latest is None
            or timezone.now() - injection_latest.astimezone(timezone.get_current_timezone())
            > timedelta(minutes=INJECTION_STALE_AFTER_MINUTES)
        )
    )
    if _safe_int(injection.get("plan_row_count")) <= 0:
        warnings.append("injection_plan_missing")
    if injection_latest is None:
        warnings.append("injection_mes_data_missing")
    elif injection_stale:
        warnings.append("injection_mes_data_stale")

    assembly_latest = assembly.get("latest_report_time") or assembly.get("last_plan_updated_at")
    if _safe_int(assembly.get("plan_row_count")) <= 0:
        warnings.append("assembly_plan_missing")
    if _safe_int(assembly.get("mes_row_count")) <= 0:
        warnings.append("assembly_mes_data_missing")

    injection_source = _source_state(
        status="missing" if injection_latest is None else "stale" if injection_stale else "ok",
        latest_at=injection_latest or injection.get("last_plan_updated_at"),
        row_count=_safe_int(injection.get("monitoring_row_count")),
        stale=injection_stale,
    )
    assembly_source = _source_state(
        status="missing" if _safe_int(assembly.get("plan_row_count")) <= 0 else "ok",
        latest_at=assembly_latest,
        row_count=_safe_int(assembly.get("mes_row_count")),
        stale=False,
    )
    return injection_source, assembly_source, warnings


def _fallback_context(target_date: date) -> dict[str, Any]:
    start = SHANGHAI_TZ.localize(datetime.combine(target_date, datetime.min.time()).replace(hour=8))
    end = start + timedelta(days=1)
    now = timezone.now().astimezone(SHANGHAI_TZ)
    reference = min(max(now, start), end)
    empty_process = {
        "planned_qty": 0,
        "actual_qty": 0,
        "progress_rate": 0,
        "time_progress_rate": 0,
        "active_equipment_count": 0,
        "running_equipment_count": 0,
        "total_equipment_count": 0,
        "plan_row_count": 0,
    }
    return {
        "business_date": target_date,
        "range_start": start,
        "range_end": end,
        "reference_time": reference,
        "injection": {**empty_process, "machine_rows": [], "part_rows": [], "monitoring_row_count": 0},
        "machining": {**empty_process, "rows": [], "mes_row_count": 0},
    }


def build_overview_board_snapshot(target_date: date, *, language: str = "ko") -> dict[str, Any]:
    language = "zh" if language == "zh" else "ko"
    warnings: list[str] = []
    traces: list[dict[str, Any]] = []
    try:
        context = get_daily_production_context(target_date)
        traces.append({
            "source": "production.ai_retrievers.get_daily_production_context",
            "status": "ok",
            "rows_returned": (
                len(context.get("injection", {}).get("machine_rows") or [])
                + len(context.get("machining", {}).get("rows") or [])
            ),
        })
    except DatabaseError as exc:
        context = _fallback_context(target_date)
        warnings.append("production_context_unavailable")
        traces.append({
            "source": "production.ai_retrievers.get_daily_production_context",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
        })

    injection = context.get("injection") or {}
    assembly = context.get("machining") or {}
    try:
        injection_activity = get_injection_active_machine_context(
            target_date,
            QUALITY_ACTIVITY_WINDOW_MINUTES,
        )
        traces.append({
            "source": "production.ai_retrievers.get_injection_active_machine_context",
            "status": "stale" if injection_activity.get("is_stale") else "ok",
            "rows_returned": len(injection_activity.get("rows") or []),
            "lookback_minutes": QUALITY_ACTIVITY_WINDOW_MINUTES,
        })
    except DatabaseError as exc:
        injection_activity = {
            "rows": [],
            "latest_mes_time": None,
            "is_stale": True,
            "lookback_minutes": QUALITY_ACTIVITY_WINDOW_MINUTES,
        }
        warnings.append("injection_activity_context_unavailable")
        traces.append({
            "source": "production.ai_retrievers.get_injection_active_machine_context",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
            "lookback_minutes": QUALITY_ACTIVITY_WINDOW_MINUTES,
        })

    reference_time = context.get("reference_time") or context["range_start"]
    # UI semantics are assembly/conveyor even though the existing deterministic
    # plan/reconciliation source is still stored under plan_type="machining".
    processes = {
        "injection": _process_summary(
            injection,
            key="injection",
            source_process="injection",
            title=COPY[language]["injection"],
            display_semantics="injection_press",
            range_end=context.get("range_end"),
            reference_time=reference_time,
        ),
        "assembly": _process_summary(
            assembly,
            key="assembly",
            source_process="machining",
            title=COPY[language]["assembly"],
            display_semantics="assembly_conveyor",
            range_end=context.get("range_end"),
            reference_time=reference_time,
        ),
    }
    injection_source, assembly_source, production_warnings = _production_source_states(
        target_date=target_date,
        injection=injection,
        assembly=assembly,
    )
    warnings.extend(production_warnings)

    quality_target_date = current_quality_analysis_date(target_date)
    try:
        quality, quality_warnings, quality_source, quality_trace = _build_quality_attention(
            injection,
            reference_time=reference_time,
            language=language,
        )
    except DatabaseError as exc:
        quality = {
            "scope": "historical_quality_attention_for_resolved_running_injection_parts",
            "history_window_days": QUALITY_HISTORY_DAYS,
            "report_section": "LQC_INJ",
            "part_match_type": "exact_normalized_full_part_no",
            "disclaimer": COPY[language]["quality_disclaimer"],
            "items": [],
            "unresolved_machines": [],
            "resolved_machine_count": 0,
            "matched_historical_report_count": 0,
        }
        quality_warnings = ["quality_history_unavailable"]
        quality_source = _source_state(status="error", detail=exc.__class__.__name__)
        quality_trace = {
            "source": "quality.QualityReport",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
        }
    warnings.extend(quality_warnings)
    traces.append(quality_trace)
    try:
        plan_quality_items, plan_quality_meta = _build_daily_plan_quality_items(
            quality_target_date,
            language=language,
        )
        quality["plan_items"] = plan_quality_items
        quality["business_date"] = plan_quality_meta.get("business_date")
        quality["history_coverage"] = plan_quality_meta.get("history_coverage")
        quality["plan_group_count"] = plan_quality_meta.get("plan_group_count")
        quality["plan_matched_report_count"] = plan_quality_meta.get("matched_report_count")
        traces.append({
            "source": "quality.daily_attention.build_daily_quality_attention",
            "status": "ok",
            "rows_returned": len(plan_quality_items),
            "business_date": quality["business_date"],
            "join": plan_quality_meta.get("match_basis"),
        })
    except DatabaseError as exc:
        quality["plan_items"] = []
        quality["business_date"] = quality_target_date.isoformat()
        quality["history_coverage"] = "all_history"
        warnings.append("quality_daily_plan_groups_unavailable")
        traces.append({
            "source": "quality.daily_attention.build_daily_quality_attention",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
        })
    try:
        quality["ai_summary"] = quality_summary_for_overview(quality_target_date)
    except DatabaseError:
        # Local AI is optional wall context; deterministic quality history must
        # remain available even when the AI job table cannot be read.
        quality["ai_summary"] = {
            "status": "unavailable",
            "business_date": quality_target_date.isoformat(),
            "source_plan_hash": None,
            "source_evidence_hash": None,
            "source_evidence_last_changed_at": None,
            "generated_at": None,
            "completed_at": None,
            "model_id": QUALITY_DAILY_MODEL_ID,
            "model_name": "",
            "schema_version": QUALITY_ATTENTION_AI_SCHEMA_VERSION,
            "summary": None,
            "disclaimer": dict(QUALITY_DAILY_DISCLAIMER),
            "totals": None,
            "match_basis": "part_prefix_9",
            "history_coverage": "all_history",
            "attention_items": [],
            "reason": "ai_job_store_unavailable",
            "generation_source": None,
            "llm_fallback": False,
            "llm_fallback_code": "",
        }

    try:
        energy, energy_warnings, energy_source, energy_trace = _build_energy(
            target_date=target_date,
            range_start=context["range_start"],
            range_end=context["range_end"],
            reference_time=reference_time,
        )
    except DatabaseError as exc:
        energy = {
            "usage_kwh": 0,
            "unit": "kWh",
            "metered_machine_count": 0,
            "machines_with_positive_usage_count": 0,
            "usage_by_machine": [],
            "total_shots": 0,
            "energy_per_1000_shots_kwh": None,
            "efficiency_metered_machine_count": 0,
            "efficiency_calculation_basis": "same-window positive power_kwh delta / positive capacity-counter shot delta × 1,000 for machines with both counters",
            "hourly_trend": [],
            "trend_window_hours": 24,
            "moving_average_windows_hours": [8, 12, 24],
            "trend_calculation_basis": "completed-hour aggregate reset-safe positive cumulative power_kwh deltas; trailing simple moving averages",
            "calculation_basis": "positive delta of cumulative MES power_kwh counter in the 08:00 business window",
        }
        energy_warnings = ["energy_power_data_unavailable"]
        energy_source = _source_state(status="error", detail=exc.__class__.__name__)
        energy_trace = {
            "source": "injection.InjectionMonitoringRecord.power_kwh",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
        }
    warnings.extend(energy_warnings)
    traces.append(energy_trace)

    try:
        inventory, inventory_warnings, inventory_source, inventory_trace = _build_inventory(
            target_date=target_date,
            range_end=context["range_end"],
        )
    except DatabaseError as exc:
        (
            outbound_performance,
            outbound_fallback_warnings,
            outbound_fallback_source,
            outbound_fallback_trace,
        ) = get_outbound_performance(target_date)
        inventory = {
            "snapshot_date": None,
            "snapshot_matches_business_date": False,
            "finished_and_semifinished": {"sku_count": 0, "total_quantity": 0, "total_carts": 0, "warehouses": []},
            "shipping": {"snapshot_at": None, "slot": None, "total_in": 0, "total_out": 0, "net_change": 0, "record_count": 0},
            "outbound_performance": outbound_performance,
        }
        inventory_warnings = [
            "inventory_snapshot_unavailable",
            *outbound_fallback_warnings,
        ]
        inventory_source = _source_state(status="error", detail=exc.__class__.__name__)
        inventory_source["components"] = {
            "inventory_snapshots": "error",
            "outbound_performance": outbound_fallback_source.get("status") or "error",
        }
        inventory_trace = {
            "source": "inventory snapshots + BLACKLAKE outbound_order._list items[]",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": _safe_int(outbound_fallback_source.get("row_count")),
            "components": [
                {
                    "source": "inventory snapshots",
                    "status": "error",
                    "detail": exc.__class__.__name__,
                    "rows_returned": 0,
                },
                outbound_fallback_trace,
            ],
        }
    warnings.extend(inventory_warnings)
    traces.append(inventory_trace)

    try:
        moulds, mould_warnings, mould_source, mould_trace = _build_moulds()
    except DatabaseError as exc:
        moulds = {
            "total": 0,
            "mounted": 0,
            "stored": 0,
            "maintenance": 0,
            "repair": 0,
            "conflicts": 0,
            "confirmation_required": 0,
        }
        mould_warnings = ["mould_board_snapshot_unavailable"]
        mould_source = _source_state(status="error", detail=exc.__class__.__name__)
        mould_trace = {
            "source": "injection.MouldDataSnapshot",
            "status": "error",
            "detail": exc.__class__.__name__,
            "rows_returned": 0,
        }
    warnings.extend(mould_warnings)
    traces.append(mould_trace)

    # Weather is optional wall context. Its failure must never change the
    # deterministic production operating status.
    operational_warnings = list(warnings)
    weather, weather_warnings, weather_source, weather_trace = _build_weather()
    warnings.extend(weather_warnings)
    traces.append(weather_trace)

    warnings = sorted(set(warnings))
    attention = _build_attention(injection, assembly, moulds, language=language)
    source_states = {
        "injection_production": injection_source,
        "assembly_production": assembly_source,
        "quality_history": quality_source,
        "energy": energy_source,
        "inventory": inventory_source,
        "moulds": mould_source,
        "weather": weather_source,
    }
    core_source_states = {
        key: source for key, source in source_states.items() if key != "weather"
    }
    source_errors = any(source["status"] in {"error", "missing"} for source in core_source_states.values())
    overall_status = "attention" if attention else "partial" if source_errors or operational_warnings else "normal"

    return {
        "schema_version": SCHEMA_VERSION,
        "language": language,
        "business_date": target_date.isoformat(),
        "generated_at": timezone.now().isoformat(),
        "business_window": {
            "timezone": "Asia/Shanghai",
            "start": _iso(context.get("range_start")),
            "end": _iso(context.get("range_end")),
            "reference_time": _iso(reference_time),
        },
        "overall_status": overall_status,
        "processes": processes,
        "equipment": _build_equipment(
            injection,
            assembly,
            injection_activity=injection_activity,
        ),
        "attention": attention,
        "quality": quality,
        "energy": energy,
        "weather": weather,
        "inventory": inventory,
        "moulds": moulds,
        "freshness": {
            "generated_at": timezone.now().isoformat(),
            "sources": source_states,
        },
        "warnings": warnings,
        "retrieval_trace": traces,
    }
