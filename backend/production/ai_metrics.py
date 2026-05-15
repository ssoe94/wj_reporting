from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any

import pytz
from django.utils import timezone

from .ai_types import ProgressStatus


SHANGHAI_TZ = pytz.timezone("Asia/Shanghai")
DELAY_THRESHOLD_PERCENTAGE_POINT = 5.0


def business_range(target_date: Any) -> tuple[datetime, datetime]:
    start = SHANGHAI_TZ.localize(datetime.combine(target_date, time(8, 0, 0)))
    return start, start + timedelta(days=1)


def clamp_datetime(value: datetime, start: datetime, end: datetime) -> datetime:
    if value < start:
        return start
    if value > end:
        return end
    return value


def reference_time_for_business_day(target_date: Any, latest_data_time: datetime | None) -> datetime:
    start, end = business_range(target_date)
    today = timezone.now().astimezone(SHANGHAI_TZ).date()
    if target_date < today:
        return end
    if target_date > today:
        return start
    if latest_data_time:
        if timezone.is_naive(latest_data_time):
            latest_data_time = pytz.UTC.localize(latest_data_time)
        return clamp_datetime(latest_data_time.astimezone(SHANGHAI_TZ), start, end)
    return clamp_datetime(timezone.now().astimezone(SHANGHAI_TZ), start, end)


def safe_int(value: Any) -> int:
    try:
        return int(round(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def safe_rate(numerator: float | int, denominator: float | int) -> float:
    denominator = float(denominator or 0)
    if denominator <= 0:
        return 0.0
    return round((float(numerator or 0) / denominator) * 100, 1)


def elapsed_rate(target_date: Any, reference_time: datetime | None) -> float:
    start, end = business_range(target_date)
    reference = reference_time_for_business_day(target_date, reference_time)
    total_seconds = (end - start).total_seconds()
    if total_seconds <= 0:
        return 0.0
    return round(((reference - start).total_seconds() / total_seconds) * 100, 1)


def progress_status(progress_rate: float, time_progress_rate: float | None) -> ProgressStatus:
    if time_progress_rate is None:
        return "no_plan"
    if progress_rate < time_progress_rate - DELAY_THRESHOLD_PERCENTAGE_POINT:
        return "behind"
    if progress_rate > time_progress_rate + DELAY_THRESHOLD_PERCENTAGE_POINT:
        return "ahead"
    return "on_track"


def status_severity(*statuses: ProgressStatus) -> str:
    if "behind" in statuses:
        return "warning"
    return "normal"
