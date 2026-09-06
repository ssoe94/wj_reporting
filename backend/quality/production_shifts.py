"""Read-only quality reports per observed injection machine shift.

This is a reporting-intensity measure, not a defect rate or a full-shift runtime
equivalent. Each machine occupies at most one count in each 12-hour window.
Unknown or open shifts prevent normalization; neither plans nor rollups fill gaps.
"""

from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, time, timedelta
import math

from django.db import DatabaseError
from django.utils import timezone

from injection.models import InjectionMonitoringRecord

from .analysis import SHANGHAI, recorded_machine_number
from .models import QualityReport


MAX_GAP_MINUTES = 10
MAX_RAW_ROWS = 300_000
MAX_REPORT_ROWS = 50_000
GAP = timedelta(minutes=MAX_GAP_MINUTES)
TIMESTAMP_MARGIN = timedelta(minutes=1)
SHIFT_FIELDS = ("active_shift_count", "no_change_shift_count", "unknown_shift_count", "open_shift_count")
LIMITATIONS = [
    "Each denominator unit is one machine with observed counter activity in one Shanghai 08:00-20:00 or 20:00-next 08:00 shift; it is not 12 hours of verified running time.",
    "The numerator contains only LQC_INJ QualityReport IDs by report_dt in the same 08:00-next 08:00 business window. It can differ from the core quality calendar-day totals.",
    "Excel-import 08:00 report timestamps may be artificial. Reports are assigned only to a business date, never to a day/night shift or an inferred production event.",
    "A rate is shown only when reports are available, all selected machine shifts are classified and closed, and at least one shift has observed activity. It is reports per observed machine shift, not a percentage or defect rate.",
    "Stored capacity timestamps are snapshot labels rather than preserved MES recordTime. Positive evidence requires two observations at least one minute inside the shift; historical timestamp provenance remains incomplete.",
    "Only stored capacity logs are used. Counter decreases, invalid values, ambiguous device identities and incomplete constant-counter coverage remain unknown. Null-capacity rows preserve device identity but do not fill coverage gaps.",
    "Detailed raw logs are compacted after 168 hours. Hourly increases within a shift can prove observed activity; hourly zeroes cannot prove continuous inactivity. Unversioned rollups and saved daily reports are not used to fill the denominator.",
    "Models, parts, plans and multiple positive samples do not create additional machine shifts. Unknown equipment is not assigned to a historical machine from current plans.",
]


class _SourceEvidenceError(Exception):
    pass


def _local(value):
    if not isinstance(value, datetime):
        raise _SourceEvidenceError("invalid_source_timestamp")
    return value.replace(tzinfo=SHANGHAI) if timezone.is_naive(value) else value.astimezone(SHANGHAI)


def _window(day):
    start = datetime.combine(day, time(8), tzinfo=SHANGHAI)
    return start, start + timedelta(days=1)


def _machines(filters):
    selected = filters["machine_number"]
    return [] if selected == "unknown" else [selected] if selected is not None else list(range(1, 18))


def _valid_capacity(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _classify_shift(samples, timestamps, start, end):
    raw = samples[bisect_left(timestamps, start - GAP):bisect_right(timestamps, end + GAP)]
    capacity = [sample for sample in raw if sample[2] is not None]
    if not capacity:
        return "unknown", "no_capacity_observations"
    times = [sample[0] for sample in capacity]
    before, after = bisect_right(times, start) - 1, bisect_left(times, end)
    left = bisect_left(times, times[before]) if before >= 0 else 0
    right = bisect_right(times, times[after]) if after < len(times) else len(times)
    observed = capacity[left:right]
    identity_start, identity_end = min(start, observed[0][0]), max(end, observed[-1][0])
    devices = {sample[1].strip() if isinstance(sample[1], str) else ""
               for sample in raw if identity_start <= sample[0] <= identity_end}
    if not all(devices):
        return "unknown", "missing_device_identity"
    if len(devices) != 1:
        return "unknown", "ambiguous_device_identity"
    if any(not _valid_capacity(sample[2]) for sample in observed):
        return "unknown", "invalid_capacity"
    pairs = list(zip(observed, observed[1:]))
    if any(second[2] < first[2] for first, second in pairs):
        return "unknown", "counter_decreased"
    if any(second[0] == first[0] and second[2] != first[2] for first, second in pairs):
        return "unknown", "conflicting_timestamp"
    if any(second[2] > first[2] and start + TIMESTAMP_MARGIN <= first[0] < second[0] <= end - TIMESTAMP_MARGIN
           for first, second in pairs):
        return "active", "capacity_increased_within_shift"
    if any(second[2] != first[2] for first, second in pairs):
        return "unknown", "boundary_counter_change"
    if before < 0 or after >= len(times) or start - times[before] > GAP or times[after] - end > GAP:
        return "unknown", "boundary_not_observed"
    if any(second[0] - first[0] > GAP for first, second in pairs):
        return "unknown", "observation_gap"
    return "no_change", "continuous_constant_capacity"


def _report_counts(rows, filters, days):
    counts = {day: 0 for day in days}
    seen = set()
    selected = filters["machine_number"]
    for index, row in enumerate(rows, 1):
        if index > MAX_REPORT_ROWS:
            raise _SourceEvidenceError("report_source_row_limit_exceeded")
        if row["section"] != "LQC_INJ":
            continue
        report_day = (_local(row["report_dt"]) - timedelta(hours=8)).date().isoformat()
        if report_day not in counts:
            continue
        location = row.get("source_import_row__occurrence_location")
        if location is None:
            location = row.get("excel_source__occurrence_location")
        if selected is not None and recorded_machine_number(location) != selected:
            continue
        report_id = row["id"]
        if not isinstance(report_id, int) or isinstance(report_id, bool) or report_id <= 0:
            raise _SourceEvidenceError("invalid_report_identity")
        if report_id not in seen:
            counts[report_day] += 1
            seen.add(report_id)
    return counts


def _monitoring_series(rows, machines, now):
    names = {f"{machine}호기" for machine in machines}
    series = defaultdict(list)
    for index, row in enumerate(rows, 1):
        if index > MAX_RAW_ROWS:
            raise _SourceEvidenceError("monitoring_source_row_limit_exceeded")
        if row["machine_name"] not in names:
            continue
        timestamp = _local(row["timestamp"])
        if timestamp <= now:
            series[row["machine_name"]].append((timestamp, row["device_code"], row["capacity"]))
    for samples in series.values():
        samples.sort(key=lambda sample: (sample[0], str(sample[1])))
    return series


def _rate(row):
    if row["report_count"] is None or row["unknown_shift_count"] or row["open_shift_count"] or not row["active_shift_count"]:
        return None
    return round(row["report_count"] / row["active_shift_count"], 4)


def aggregate_production_shifts(monitoring_rows, report_rows, filters, *, now=None,
                                monitoring_error=None, report_error=None):
    """Aggregate supplied row iterables without querying models or changing data."""
    now = _local(now or timezone.now())
    machines = _machines(filters)
    days = []
    target = filters["start_date"]
    while target <= filters["end_date"]:
        days.append({"date": target.isoformat(), "report_count": None,
                     **{key: 0 for key in SHIFT_FIELDS}, "reports_per_shift": None, "reason": ""})
        target += timedelta(days=1)
    supported = filters["section"] in (None, "LQC_INJ") and bool(machines)
    if not supported:
        monitoring_error = report_error = "unsupported_machine" if not machines else "unsupported_section"
    counts, series = {}, {}
    if supported and report_error is None:
        try:
            counts = _report_counts(report_rows, filters, [day["date"] for day in days])
        except DatabaseError:
            report_error = "report_source_query_failed"
        except _SourceEvidenceError as exc:
            report_error = str(exc)
    if supported and monitoring_error is None:
        try:
            series = _monitoring_series(monitoring_rows, machines, now)
        except DatabaseError:
            monitoring_error = "monitoring_source_query_failed"
        except _SourceEvidenceError as exc:
            monitoring_error = str(exc)
    times = {name: [sample[0] for sample in samples] for name, samples in series.items()}
    for day in days:
        day["report_count"] = counts.get(day["date"]) if report_error is None else None
        start, end = _window(datetime.fromisoformat(day["date"]).date())
        unknown_reasons = []
        for shift_start, shift_end in ((start, start + timedelta(hours=12)), (start + timedelta(hours=12), end)):
            for machine in machines:
                if shift_end > now:
                    status, reason = "open", "shift_incomplete"
                elif monitoring_error:
                    status, reason = "unknown", monitoring_error
                else:
                    name = f"{machine}호기"
                    status, reason = _classify_shift(series.get(name, []), times.get(name, []), shift_start, shift_end)
                day[f"{status}_shift_count"] += 1
                if status == "unknown":
                    unknown_reasons.append(reason)
        day["reason"] = (report_error or monitoring_error or ("shift_incomplete" if day["open_shift_count"] else None)
                         or next(iter(unknown_reasons), None)
                         or ("no_observed_active_shifts" if not day["active_shift_count"] else "complete"))
        day["reports_per_shift"] = _rate(day) if supported else None
    summary = {"report_count": sum(day["report_count"] for day in days) if all(day["report_count"] is not None for day in days) else None,
               **{key: sum(day[key] for day in days) for key in SHIFT_FIELDS}}
    summary["reports_per_shift"] = _rate(summary) if supported else None
    return {
        "schema_version": "quality-shifts.v1", "status": "not_applicable" if not supported else "unavailable" if report_error or monitoring_error else "ready",
        "timezone": "Asia/Shanghai", "date_basis": "production_business_day",
        "source": "InjectionMonitoringRecord", "report_source": "QualityReport:LQC_INJ",
        "source_status": {"reports": "unavailable" if report_error else "ready", "monitoring": "unavailable" if monitoring_error else "ready"},
        "policy": "observed_machine_shift_v1", "max_gap_minutes": MAX_GAP_MINUTES,
        "expected_machine_count": len(machines), "days": days, "summary": summary,
        "limitations": [*LIMITATIONS, *[error for error in (report_error, monitoring_error) if error]],
    }


def build_production_shifts(filters, *, now=None):
    """Two bounded projected queries; no MES calls, per-day queries or writes."""
    now = _local(now or timezone.now())
    machines = _machines(filters)
    if filters["section"] not in (None, "LQC_INJ") or not machines:
        return aggregate_production_shifts([], [], filters, now=now)
    start, _ = _window(filters["start_date"])
    _, end = _window(filters["end_date"])
    monitoring_rows = report_rows = ()
    monitoring_error = report_error = None
    try:
        monitoring_rows = InjectionMonitoringRecord.objects.filter(
            machine_name__in=[f"{machine}호기" for machine in machines],
            timestamp__gte=start - GAP, timestamp__lte=min(end + GAP, now),
        ).order_by("machine_name", "timestamp", "device_code").values(
            "machine_name", "device_code", "timestamp", "capacity",
        )[:MAX_RAW_ROWS + 1].iterator(chunk_size=2000)
    except DatabaseError:
        monitoring_error = "monitoring_source_query_failed"
    try:
        report_rows = QualityReport.objects.filter(
            section="LQC_INJ", report_dt__gte=start, report_dt__lt=end,
        ).order_by("report_dt", "id").values(
            "id", "report_dt", "section", "source_import_row__occurrence_location", "excel_source__occurrence_location",
        )[:MAX_REPORT_ROWS + 1].iterator(chunk_size=1000)
    except DatabaseError:
        report_error = "report_source_query_failed"
    return aggregate_production_shifts(monitoring_rows, report_rows, filters, now=now,
                                       monitoring_error=monitoring_error, report_error=report_error)
