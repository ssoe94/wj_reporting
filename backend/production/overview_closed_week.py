"""Closed production-day totals for the overview wall's dated carry-over note."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from django.core.cache import cache
from django.db import DatabaseError

from .ai_retrievers import get_daily_production_context


SCHEMA_VERSION = "overview-closed-week.v1"
CACHE_SECONDS = 5 * 60


def _day_metric(source: dict[str, Any] | None, process: str) -> dict[str, Any]:
    if source is None:
        return {"status": "unavailable", "planned_quantity": None, "actual_quantity": None, "completion_rate": None}

    planned = source.get("planned_qty")
    actual = source.get("actual_qty")
    if type(planned) is not int or planned < 0:
        return {"status": "unavailable", "planned_quantity": None, "actual_quantity": None, "completion_rate": None}
    if planned == 0:
        return {"status": "no_plan", "planned_quantity": 0, "actual_quantity": None, "completion_rate": None}

    if process == "injection":
        observed = (
            source.get("capacity_coverage_complete") is True
            and source.get("latest_mes_time") is not None
            and (source.get("monitoring_row_count") or 0) > 0
        )
    else:
        observed = (source.get("mes_row_count") or 0) > 0
    if not observed or type(actual) is not int or actual < 0:
        return {"status": "unavailable", "planned_quantity": planned, "actual_quantity": None, "completion_rate": None}
    return {
        "status": "ok",
        "planned_quantity": planned,
        "actual_quantity": actual,
        "completion_rate": round(actual / planned * 100, 1),
    }


def _week_metric(day_metrics: list[dict[str, Any]], unavailable_days: int) -> dict[str, Any]:
    planned_days = [metric for metric in day_metrics if metric["status"] in {"ok", "unavailable"}]
    covered = [metric for metric in day_metrics if metric["status"] == "ok"]
    if not day_metrics:
        status = "pending"
    elif unavailable_days or len(covered) != len(planned_days):
        status = "partial"
    elif not planned_days:
        status = "no_plan"
    else:
        status = "ok"
    planned = sum(metric["planned_quantity"] for metric in covered)
    actual = sum(metric["actual_quantity"] for metric in covered)
    return {
        "status": status,
        "planned_quantity": planned if status == "ok" else None,
        "actual_quantity": actual if status == "ok" else None,
        "completion_rate": round(actual / planned * 100, 1) if status == "ok" and planned > 0 else None,
        "covered_days": len(covered),
        "planned_days": len(planned_days),
    }


def _build_closed_week_summary(target_date: date) -> dict[str, Any]:
    previous_date = target_date - timedelta(days=1)
    week_start = target_date - timedelta(days=target_date.weekday())
    week_dates = [
        week_start + timedelta(days=offset)
        for offset in range((target_date - week_start).days)
    ]
    daily: dict[date, dict[str, Any]] = {}
    failed_dates: set[date] = set()
    for day in sorted({previous_date, *week_dates}):
        try:
            context = get_daily_production_context(day)
        except DatabaseError:
            context = None
            failed_dates.add(day)
        daily[day] = {
            "injection": _day_metric(context.get("injection") if context else None, "injection"),
            "assembly": _day_metric(context.get("machining") if context else None, "assembly"),
        }

    week_failed = len(failed_dates.intersection(week_dates))
    return {
        "schema_version": SCHEMA_VERSION,
        "business_date": target_date.isoformat(),
        "previous_day": {"business_date": previous_date.isoformat(), **daily[previous_date]},
        "week": {
            "start_date": week_start.isoformat(),
            "end_date": previous_date.isoformat() if week_dates else None,
            "closed_day_count": len(week_dates),
            "unavailable_days": week_failed,
            "injection": _week_metric([daily[day]["injection"] for day in week_dates], week_failed),
            "assembly": _week_metric([daily[day]["assembly"] for day in week_dates], week_failed),
        },
    }


def build_closed_week_summary(target_date: date) -> dict[str, Any]:
    key = f"overview-closed-week:v1:{target_date.isoformat()}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    result = _build_closed_week_summary(target_date)
    cache.set(key, result, CACHE_SECONDS)
    return result
