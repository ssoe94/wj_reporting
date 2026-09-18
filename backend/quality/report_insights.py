"""Operating-day calendar and production-normalised insights for the quality report.

A date is an operating day when its MES mold-close counters rose by at least
MIN_OPERATING_SHOTS during its production business day (08:00 to next 08:00,
Asia/Shanghai). A handful of shots is machine setup or a test, not production.
The stored injection plan only stands in for a date whose counters were never
observed, so a collection gap is not reported as a holiday. Shots are counter
increments from stored monitoring logs; hourly compacted logs are enough for
daily totals.
Every value is deterministic and read-only; a failed source leaves the core
quality analysis untouched.
"""

from collections import defaultdict
from datetime import datetime, time, timedelta

from django.db import DatabaseError
from django.db.models import Max

from injection.models import InjectionMonitoringRecord, get_monitoring_capacity_factor
from production.counter_utils import calculate_counter_increment
from production.models import ProductionPlan

from .analysis import SHANGHAI
from .models import QualityReport


MAX_MONITORING_ROWS = 400_000
MAX_PLAN_ROWS = 50_000
MAX_ATTRIBUTION_GAP = timedelta(hours=24)
MIN_RUNNING_SHOTS = 10
MIN_OPERATING_SHOTS = 100
MAX_COMPARISON_DAYS = 92
RECURRING_LIMIT = 10
SHOT_UNIT = 10_000


class _SourceLimitExceeded(Exception):
    pass


def _machines(filters):
    selected = filters["machine_number"]
    return [selected] if isinstance(selected, int) else list(range(1, 18))


def _business_start(day):
    return datetime.combine(day, time(8), tzinfo=SHANGHAI)


def _local(value):
    return value.replace(tzinfo=SHANGHAI) if value.tzinfo is None else value.astimezone(SHANGHAI)


def _rate(numerator, denominator, scale=1, digits=2):
    if numerator is None or not denominator:
        return None
    return round(numerator / denominator * scale, digits)


def attribute_shots(rows, first_day, last_day):
    """Split each counter increase over the business days its interval overlaps.

    Returns ({date: {machine_name: shots}}, {observed dates}). An increase across
    a collection gap longer than 24 hours cannot be dated and is left out, but
    the dates that were sampled at all are reported so a gap stays distinct from
    an idle machine.
    """
    shots = defaultdict(lambda: defaultdict(float))
    observed = set()
    previous = {}
    for count, row in enumerate(rows, 1):
        if count > MAX_MONITORING_ROWS:
            raise _SourceLimitExceeded
        capacity = row["capacity"]
        if capacity is None or capacity < 0:
            continue
        key = (row["machine_name"], row["device_code"])
        moment = _local(row["timestamp"])
        sampled = (moment - timedelta(hours=8)).date()
        if first_day <= sampled <= last_day:
            observed.add(sampled)
        before = previous.get(key)
        previous[key] = (moment, capacity)
        if before is None:
            continue
        delta = calculate_counter_increment(before[1], capacity) * get_monitoring_capacity_factor(row["machine_name"])
        span = moment - before[0]
        if delta <= 0 or span <= timedelta(0) or span > MAX_ATTRIBUTION_GAP:
            continue
        cursor = before[0]
        while cursor < moment:
            day = (cursor - timedelta(hours=8)).date()
            segment_end = min(moment, _business_start(day) + timedelta(days=1))
            if first_day <= day <= last_day:
                shots[day][row["machine_name"]] += delta * ((segment_end - cursor) / span)
            cursor = segment_end
    return shots, observed


def _load_shots(machines, first_day, last_day):
    """Return (shots, observed) for the whole span in one projected query.

    The ordering matches the (machine_name, timestamp) index so the source
    streams instead of sorting; each device's own samples stay in ascending
    order within its machine, which is all the attribution needs.
    """
    start, end = _business_start(first_day), _business_start(last_day) + timedelta(days=1)
    rows = InjectionMonitoringRecord.objects.filter(
        machine_name__in=[f"{machine}호기" for machine in machines],
        timestamp__gte=start - MAX_ATTRIBUTION_GAP, timestamp__lte=end, capacity__isnull=False,
    ).order_by("machine_name", "timestamp").values(
        "machine_name", "device_code", "timestamp", "capacity",
    )[:MAX_MONITORING_ROWS + 1].iterator(chunk_size=2000)
    return attribute_shots(rows, first_day, last_day)


def _load_plans(machines, first_day, last_day):
    from .production_context import _machine

    wanted = set(machines)
    plans = defaultdict(lambda: {"quantity": 0.0, "machines": set()})
    rows = ProductionPlan.objects.filter(
        plan_type="injection", plan_date__gte=first_day, plan_date__lte=last_day, planned_quantity__gt=0,
    ).values("plan_date", "machine_name", "planned_quantity")[:MAX_PLAN_ROWS + 1].iterator(chunk_size=2000)
    for count, row in enumerate(rows, 1):
        if count > MAX_PLAN_ROWS:
            raise _SourceLimitExceeded
        machine = _machine(row["machine_name"])
        if machine is None or machine not in wanted:
            continue
        plans[row["plan_date"]]["quantity"] += row["planned_quantity"]
        plans[row["plan_date"]]["machines"].add(machine)
    return plans


def build_operating_days(first_day, last_day, machines, *, shots=None, observed=None, plans=None):
    """Pure merge of MES and plan evidence into one row per date."""
    shots, plans = shots or {}, plans or {}
    # Dates carrying shots were necessarily sampled; an explicit set may add the
    # dates that were sampled while every machine stood still.
    observed = set(shots) if observed is None else set(observed)
    days = []
    day = first_day
    while day <= last_day:
        machine_shots = {name: value for name, value in shots.get(day, {}).items() if value >= MIN_RUNNING_SHOTS}
        total = round(sum(machine_shots.values()))
        plan = plans.get(day)
        days.append({
            "date": day.isoformat(),
            "planned_quantity": round(plan["quantity"]) if plan else 0,
            "planned_machine_count": len(plan["machines"]) if plan else 0,
            "shot_count": total,
            "running_machine_count": len(machine_shots),
            "operating": total >= MIN_OPERATING_SHOTS or (day not in observed and bool(plan)),
            "_machine_shots": machine_shots,
        })
        day += timedelta(days=1)
    return days


def _week_start(day):
    return day - timedelta(days=day.weekday())


def _type_counts(rows):
    counts = defaultdict(int)
    labels = {}
    for row in rows:
        for key, label in row.get("types", ()):
            counts[key] += 1
            labels[key] = label
    return counts, labels


def _recurring(rows):
    groups = {}
    for row in rows:
        target = row["part_no"] or row["model_display"]
        if not target:
            continue
        for key, label in row.get("types", ()):
            group = groups.setdefault((row["model_display"], row["part_no"], key), {
                "model_display": row["model_display"], "part_no": row["part_no"], "type_key": key, "type_label": label,
                "report_count": 0, "dates": set(), "sample_report_ids": []})
            group["report_count"] += 1
            group["dates"].add(row["date"])
            if len(group["sample_report_ids"]) < 5:
                group["sample_report_ids"].append(row["id"])
    items = [group for group in groups.values() if group["report_count"] >= 2]
    items.sort(key=lambda group: (-len(group["dates"]), -group["report_count"], group["part_no"], group["type_key"]))
    return [{**{key: value for key, value in group.items() if key != "dates"},
             "day_count": len(group["dates"]), "first_date": min(group["dates"]).isoformat(),
             "last_date": max(group["dates"]).isoformat()} for group in items[:RECURRING_LIMIT]]


def summarize_report(rows, filters, days, *, operations_ready, previous=None, reported_through=None):
    """Pure aggregation of selected quality rows against the operating calendar.

    Dates after the newest stored quality report are pending entry, not days
    without defects; they are left out of the chart and of every denominator.
    """
    start, end = filters["start_date"], filters["end_date"]
    injection_scope = filters["section"] in (None, "LQC_INJ") and filters["machine_number"] != "unknown"
    by_date = {day["date"]: day for day in days if start.isoformat() <= day["date"] <= end.isoformat()}
    reports, injection_reports = defaultdict(int), defaultdict(int)
    machine_reports = defaultdict(int)
    for row in rows:
        key = row["date"].isoformat()
        reports[key] += 1
        if row["section"] == "LQC_INJ":
            injection_reports[key] += 1
            machine = row.get("resolved_machine", row["machine_number"])
            if machine is not None:
                machine_reports[machine] += 1

    period_days, weeks, machine_shots, machine_days = [], {}, defaultdict(float), defaultdict(int)
    for key, day in by_date.items():
        current = datetime.fromisoformat(key).date()
        entry = {name: value for name, value in day.items() if not name.startswith("_")}
        entry.update(report_count=reports[key], injection_report_count=injection_reports[key])
        entry["pending"] = reported_through is not None and current > reported_through and not reports[key]
        if entry["pending"]:
            entry["operating"] = False
        # A date with recorded reports stays visible even without plan or MES evidence.
        entry["displayed"] = not entry["pending"] and (entry["operating"] or entry["report_count"] > 0 or not operations_ready)
        period_days.append(entry)
        week = weeks.setdefault(_week_start(current), {"dates": [], "rows": []})
        week["dates"].append(current)
        week["rows"].append(entry)
        for name, value in (day["_machine_shots"] if entry["operating"] else {}).items():
            machine_shots[name] += value
            machine_days[name] += 1

    def totals(entries):
        operating = sum(entry["operating"] for entry in entries)
        report_count = sum(entry["report_count"] for entry in entries)
        injection_count = sum(entry["injection_report_count"] for entry in entries)
        # Only production days carry the denominator; setup shots are not output.
        shot_count = sum(entry["shot_count"] for entry in entries if entry["operating"])
        return {
            "calendar_day_count": len(entries), "operating_day_count": operating if operations_ready else None,
            "report_count": report_count, "injection_report_count": injection_count,
            "shot_count": shot_count if operations_ready else None,
            "reports_per_operating_day": _rate(report_count, operating) if operations_ready else None,
            "injection_reports_per_10k_shots": _rate(injection_count, shot_count, SHOT_UNIT)
            if operations_ready and injection_scope else None,
        }

    rows_by_week = defaultdict(list)
    for row in rows:
        rows_by_week[_week_start(row["date"])].append(row)
    weekly = []
    for week_start, week in sorted(weeks.items()):
        counts, labels = _type_counts(rows_by_week[week_start])
        top = min(counts, key=lambda key: (-counts[key], key)) if counts else None
        weekly.append({"week_start": min(week["dates"]).isoformat(), "week_end": max(week["dates"]).isoformat(),
                       **totals(week["rows"]),
                       "top_type": {"key": top, "label": labels[top], "report_count": counts[top]} if top else None})

    machines = []
    for machine in _machines(filters):
        name = f"{machine}호기"
        shot_count = round(machine_shots.get(name, 0))
        if not shot_count and not machine_reports.get(machine):
            continue
        machines.append({"machine_number": machine, "shot_count": shot_count, "running_day_count": machine_days.get(name, 0),
                         "report_count": machine_reports.get(machine, 0),
                         "reports_per_10k_shots": _rate(machine_reports.get(machine, 0), shot_count, SHOT_UNIT)})

    comparison = None
    if previous:
        current_counts, labels = _type_counts(rows)
        previous_days = [{**{name: value for name, value in day.items() if not name.startswith("_")},
                          "report_count": 0, "injection_report_count": 0}
                         for day in days if previous["start_date"].isoformat() <= day["date"] <= previous["end_date"].isoformat()]
        operating = sum(day["operating"] for day in previous_days) if operations_ready else None
        previous_types = {item["key"]: item for item in previous["type_pareto"]}
        types = [{"key": key, "label": labels.get(key) or previous_types[key]["label"],
                  "current_count": current_counts.get(key, 0),
                  "previous_count": previous_types.get(key, {}).get("report_count", 0)}
                 for key in {*current_counts, *previous_types}]
        for item in types:
            item["change"] = item["current_count"] - item["previous_count"]
        types.sort(key=lambda item: (-abs(item["change"]), -item["current_count"], item["key"]))
        comparison = {
            "previous_start": previous["start_date"].isoformat(), "previous_end": previous["end_date"].isoformat(),
            "report_count": previous["report_count"], "operating_day_count": operating,
            "reports_per_operating_day": _rate(previous["report_count"], operating),
            "types": types,
        }

    return {
        "schema_version": "quality-report.v1",
        "operations": {
            "status": "ready" if operations_ready else "unavailable",
            "date_basis": "plan_date_and_mes_business_day_0800",
            "min_running_shots": MIN_RUNNING_SHOTS, "min_operating_shots": MIN_OPERATING_SHOTS, "shot_unit": SHOT_UNIT,
            "injection_scope": injection_scope,
            "reported_through": reported_through.isoformat() if reported_through else None,
            "days": period_days, "summary": totals(period_days), "machines": machines if injection_scope else [],
        },
        "weekly": weekly, "comparison": comparison, "recurring": _recurring(rows),
    }


def build_quality_report(rows, filters, *, previous=None):
    """Two bounded source queries for the whole span, including the comparison period."""
    machines = _machines(filters)
    first_day = previous["start_date"] if previous else filters["start_date"]
    last_day = filters["end_date"]
    try:
        shots, observed = _load_shots(machines, first_day, last_day)
        plans = _load_plans(machines, first_day, last_day)
        ready = True
    except (DatabaseError, _SourceLimitExceeded):
        shots, observed, plans, ready = {}, set(), {}, False
    days = build_operating_days(first_day, last_day, machines, shots=shots, observed=observed, plans=plans)
    try:
        latest = QualityReport.objects.aggregate(latest=Max("report_dt"))["latest"]
    except DatabaseError:
        latest = None
    return summarize_report(rows, filters, days, operations_ready=ready, previous=previous,
                            reported_through=_local(latest).date() if latest else None)
