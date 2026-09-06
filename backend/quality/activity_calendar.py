"""Conservative display hints from continuous raw injection capacity logs.

Constant observed counters are not a holiday calendar or proof of zero defects.
This module neither changes quality quantities nor supplements raw gaps with
unversioned rollups. The optional source can fail without failing quality data.
"""

from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, time, timedelta
import math

from django.db import DatabaseError
from django.utils import timezone

from injection.models import InjectionMonitoringRecord

from .analysis import SHANGHAI


MAX_GAP_MINUTES = 10
MAX_RAW_ROWS = 300_000
GAP = timedelta(minutes=MAX_GAP_MINUTES)


class _SourceRowLimitExceeded(Exception):
    pass


def _valid_capacity(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _machine_day(samples, timestamps, start, end):
    """Inspect one device stream, including the nearest boundary observations."""
    # Keep null-capacity rows for device identity checks, but never use them to
    # fill a gap in capacity coverage. Limit per-day work to its boundary window.
    window_start = start - GAP if start.toordinal() > 1 else start
    raw_window = samples[bisect_left(timestamps, window_start):bisect_right(timestamps, end + GAP)]
    samples = [sample for sample in raw_window if sample[2] is not None]
    timestamps = [sample[0] for sample in samples]
    inside_start, inside_end = bisect_left(timestamps, start), bisect_left(timestamps, end)
    observed = any(_valid_capacity(sample[2]) for sample in samples[inside_start:inside_end])

    def result(status, reason):
        return {"status": status, "reason": reason, "observed": observed}

    if not samples:
        return result("unknown", "no_capacity_observations")
    before = bisect_right(timestamps, start) - 1
    after = bisect_left(timestamps, end)
    # Include every device at the selected boundary time. Choosing just one of
    # two devices with the same machine label would falsely resolve ambiguity.
    left = bisect_left(timestamps, timestamps[before]) if before >= 0 else 0
    right = bisect_right(timestamps, timestamps[after]) if after < len(samples) else len(samples)
    window = samples[left:right]
    if not window:
        return result("unknown", "no_capacity_observations")
    devices = {sample[1] for sample in raw_window if window[0][0] <= sample[0] <= window[-1][0]}
    if not all(devices):
        return result("unknown", "missing_device_identity")
    if len(devices) != 1:
        return result("unknown", "ambiguous_device_identity")
    if any(not _valid_capacity(sample[2]) for sample in window):
        return result("unknown", "invalid_capacity")
    pairs = list(zip(window, window[1:]))
    if any(second[2] < first[2] for first, second in pairs):
        return result("unknown", "counter_decreased")
    # Boundary-straddling movement cannot be assigned to this calendar date.
    # A rise between two observations wholly inside it proves some activity,
    # even if other portions of the day are not continuously observed.
    if any(second[2] > first[2] and start <= first[0] < second[0] <= end for first, second in pairs):
        return result("activity", "capacity_increased")
    if any(second[2] != first[2] for first, second in pairs):
        return result("unknown", "boundary_counter_change")
    if before < 0 or after >= len(samples) or start - timestamps[before] > GAP or timestamps[after] - end > GAP:
        return result("unknown", "boundary_not_observed")
    if any(second[0] - first[0] > GAP for first, second in pairs):
        return result("unknown", "observation_gap")
    return result("no_change", "continuous_constant_capacity")


def build_activity_calendar(quality_result, filters, *, now=None):
    now = now or timezone.now()
    if timezone.is_naive(now):
        now = now.replace(tzinfo=SHANGHAI)
    today = now.astimezone(SHANGHAI).date()
    selected_machine = filters["machine_number"]
    machines = [] if selected_machine == "unknown" else [selected_machine] if selected_machine is not None else list(range(1, 18))
    days = []
    target = filters["start_date"]
    while target <= filters["end_date"]:
        days.append({"date": target.isoformat(), "status": "unknown", "reason": "no_capacity_observations",
                     "can_collapse": False, "observed_machine_count": 0})
        target += timedelta(days=1)
    payload = {
        "schema_version": "quality-activity.v1", "status": "ready",
        "source": "InjectionMonitoringRecord", "timezone": "Asia/Shanghai", "date_basis": "calendar_day",
        "policy": "continuous_constant_capacity_v1", "max_gap_minutes": MAX_GAP_MINUTES,
        "expected_machine_count": len(machines), "days": days,
    }

    def unavailable(status, reason):
        payload["status"] = status
        for day in days:
            day.update(status="unknown", reason=reason, can_collapse=False, observed_machine_count=0)
        return payload

    if filters["section"] not in (None, "LQC_INJ"):
        return unavailable("not_applicable", "unsupported_section")
    if not machines:
        return unavailable("not_applicable", "unsupported_machine")
    if filters["start_date"] >= today:
        return unavailable("ready", "current_day_incomplete")

    start = datetime.combine(filters["start_date"], time.min, tzinfo=SHANGHAI)
    end = datetime.combine(filters["end_date"] + timedelta(days=1), time.min, tzinfo=SHANGHAI)
    source_start = start - GAP if start.toordinal() > 1 else start
    series = defaultdict(list)
    try:
        rows = InjectionMonitoringRecord.objects.filter(
            machine_name__in=[f"{machine}호기" for machine in machines],
            timestamp__gte=source_start, timestamp__lte=end + GAP,
        ).order_by("machine_name", "timestamp", "device_code").values(
            "machine_name", "device_code", "timestamp", "capacity",
        )[:MAX_RAW_ROWS + 1].iterator(chunk_size=2000)
        for count, row in enumerate(rows, 1):
            if count > MAX_RAW_ROWS:
                raise _SourceRowLimitExceeded
            # Retain all device identities; null values do not count as capacity
            # observations in the per-day coverage check.
            series[row["machine_name"]].append((row["timestamp"], row["device_code"], row["capacity"]))
    except _SourceRowLimitExceeded:
        return unavailable("unavailable", "source_row_limit_exceeded")
    except DatabaseError:
        return unavailable("unavailable", "source_query_failed")

    times = {name: [sample[0] for sample in samples] for name, samples in series.items()}
    quality_days = {row["date"]: row for row in quality_result.get("trend", [])}
    ambiguous_reasons = {"counter_decreased", "invalid_capacity", "missing_device_identity", "ambiguous_device_identity"}
    for day in days:
        target_start = datetime.combine(datetime.fromisoformat(day["date"]).date(), time.min, tzinfo=SHANGHAI)
        target_end = target_start + timedelta(days=1)
        if target_start.date() >= today:
            day["reason"] = "current_day_incomplete"
            continue
        checks = [_machine_day(series.get(f"{machine}호기", []), times.get(f"{machine}호기", []), target_start, target_end)
                  for machine in machines]
        day["observed_machine_count"] = sum(check["observed"] for check in checks)
        ambiguous = next((check for check in checks if check["reason"] in ambiguous_reasons), None)
        active = next((check for check in checks if check["status"] == "activity"), None)
        incomplete = next((check for check in checks if check["status"] != "no_change"), None)
        if ambiguous:
            day.update(status="unknown", reason=ambiguous["reason"])
        elif active:
            day.update(status="activity", reason=active["reason"])
        elif incomplete:
            day.update(status="unknown", reason=incomplete["reason"])
        else:
            day.update(status="no_change", reason="continuous_constant_capacity")
            quality_day = quality_days.get(day["date"])
            if quality_day is None:
                day["reason"] = "quality_day_unavailable"
            elif quality_day.get("report_count") != 0 or quality_day.get("reported_defect_qty") is not None:
                day["reason"] = "quality_records_present"
            else:
                day["can_collapse"] = True
    return payload
