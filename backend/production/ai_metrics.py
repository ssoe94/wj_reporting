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


def production_shift_window(
    target_date: Any,
    reference_time: datetime | None = None,
) -> dict[str, Any]:
    """Return the 12-hour production shift containing the Shanghai reference time.

    A production business day contains a day shift from 08:00 to 20:00 and a
    night shift from 20:00 to the following 08:00. The reference is clamped to
    the selected business day so historical and future snapshots stay bounded.
    """
    business_start, business_end = business_range(target_date)
    reference = reference_time or timezone.now()
    if timezone.is_naive(reference):
        reference = SHANGHAI_TZ.localize(reference)
    else:
        reference = reference.astimezone(SHANGHAI_TZ)
    reference = clamp_datetime(reference, business_start, business_end)

    night_start = business_start + timedelta(hours=12)
    if reference >= night_start:
        shift_code = "night"
        shift_start = night_start
        shift_end = business_end
    else:
        shift_code = "day"
        shift_start = business_start
        shift_end = night_start

    return {
        "code": shift_code,
        "start": shift_start,
        "end": shift_end,
        "reference_time": reference,
    }


def clamp_datetime(value: datetime, start: datetime, end: datetime) -> datetime:
    if value < start:
        return start
    if value > end:
        return end
    return value


def reference_time_for_business_day(target_date: Any, latest_data_time: datetime | None) -> datetime:
    start, end = business_range(target_date)
    local_now = timezone.now().astimezone(SHANGHAI_TZ)
    current_business_date = (local_now - timedelta(hours=8)).date()
    if target_date < current_business_date:
        return end
    if target_date > current_business_date:
        return start
    if latest_data_time:
        if timezone.is_naive(latest_data_time):
            latest_data_time = pytz.UTC.localize(latest_data_time)
        return clamp_datetime(latest_data_time.astimezone(SHANGHAI_TZ), start, end)
    return clamp_datetime(local_now, start, end)


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


def project_end_of_business_day_shots(
    observed_shots: int | float,
    recent_shots: int | float,
    recent_window_start: datetime | None,
    reference_time: datetime | None,
    business_end: datetime | None,
) -> dict[str, Any]:
    """Project end-of-day shots from an already retrieved recent trend.

    The function deliberately accepts only verified numeric inputs and times.
    It does not query data and does not infer a trend when the observation
    window is missing or empty.
    """
    base = {
        "observed_shots": safe_int(observed_shots),
        "recent_shots": safe_int(recent_shots),
        "recent_window_minutes": None,
        "shots_per_hour": None,
        "remaining_hours": None,
        "projected_additional_shots": None,
        "projected_total_shots": None,
        "warning": None,
    }
    if not recent_window_start or not reference_time or not business_end:
        base["warning"] = "projection_data_missing"
        return base

    window_seconds = (reference_time - recent_window_start).total_seconds()
    if window_seconds <= 0:
        base["warning"] = "projection_window_missing"
        return base

    window_hours = window_seconds / 3600
    remaining_hours = max(0.0, (business_end - reference_time).total_seconds() / 3600)
    shots_per_hour = float(recent_shots or 0) / window_hours
    projected_additional = safe_int(shots_per_hour * remaining_hours)

    base.update({
        "recent_window_minutes": round(window_seconds / 60, 1),
        "shots_per_hour": round(shots_per_hour, 1),
        "remaining_hours": round(remaining_hours, 2),
        "projected_additional_shots": projected_additional,
        "projected_total_shots": safe_int(observed_shots) + projected_additional,
    })
    return base


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
