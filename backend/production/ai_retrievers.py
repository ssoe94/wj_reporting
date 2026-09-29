from __future__ import annotations

import re
from datetime import datetime, timedelta
from itertools import groupby
from typing import Any

from django.db.models import Max, Q, Subquery
from django.utils import timezone

from injection.models import InjectionMonitoringRecord

from .ai_metrics import (
    SHANGHAI_TZ,
    business_range,
    elapsed_rate,
    production_shift_window,
    reference_time_for_business_day,
    safe_int,
    safe_rate,
)
from .machining_reconciliation import build_machining_provision_payload
from .mes_progress import format_equipment_label
from .models import InjectionDowntimeConfirmation, ProductionMesReportRecord, ProductionPartCavity, ProductionPlan
from .counter_utils import calculate_counter_increment, calculate_cumulative_counter_delta
from .cavity import build_cavity_plan_groups, get_cavity_meta_map


MACHINE_TONNAGE = {
    1: "850T",
    2: "850T",
    3: "1300T",
    4: "1400T",
    5: "1400T",
    6: "2500T",
    7: "1800T",
    8: "850T",
    9: "850T",
    10: "650T",
    11: "550T",
    12: "550T",
    13: "450T",
    14: "850T",
    15: "650T",
    16: "1050T",
    17: "1200T",
}

# A mould transition is inferred from observed zero-output samples and a stable
# restart, never from a plan target or an elapsed 30-minute estimate alone.
CHANGEOVER_STOP_MINUTES = 10
CHANGEOVER_MAX_SAMPLE_GAP_MINUTES = 4
CHANGEOVER_STABLE_SAMPLES = 3


def _same_part_identity(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Exact Part No./model/cavity identity, including a LOT rollover."""
    def identity(group: dict[str, Any]) -> tuple[tuple[str, str, int], ...]:
        return tuple(sorted(
            (
                str(member["part_no"] or "").strip().upper(),
                str(member["plan"].model_name or "").strip().upper(),
                int(member["cavity"]),
            )
            for member in group["members"]
        ))

    return identity(left) == identity(right)


def _same_running_product(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Carry shots by plan sequence for a matching model and cavity pattern.

    A different Part No. still needs a field/office identity check; MES shots
    alone cannot verify which physical Part No. was produced.
    """
    if _same_part_identity(left, right):
        return True

    def model_identity(group: dict[str, Any]) -> tuple[tuple[str, int], ...] | None:
        members = [
            (str(member["plan"].model_name or "").strip().upper(), int(member["cavity"]))
            for member in group["members"]
        ]
        return tuple(sorted(members)) if members and all(model for model, _ in members) else None

    left_identity = model_identity(left)
    return left_identity is not None and left_identity == model_identity(right)


def _group_plan_id(group: dict[str, Any] | None) -> int | None:
    if not group:
        return None
    return int(group["members"][0]["plan"].id)


def _confirmed_changeover_boundaries(
    confirmations: list[InjectionDowntimeConfirmation],
    groups: list[dict[str, Any]],
    range_start: datetime,
    range_end: datetime,
) -> dict[int, tuple[datetime, datetime]]:
    """Use a field-corrected production start only for adjacent plan groups."""
    plan_group_index = {
        int(member["plan"].id): index
        for index, group in enumerate(groups)
        for member in group["members"]
    }
    boundaries: dict[int, tuple[datetime, datetime]] = {}
    for confirmation in confirmations:
        evidence = confirmation.evidence if isinstance(confirmation.evidence, dict) else {}
        if evidence.get("transition_start_source") != "field_confirmation":
            continue
        try:
            from_index = plan_group_index[int(evidence.get("from_plan_id"))]
            to_index = plan_group_index[int(evidence.get("to_plan_id"))]
            stop_at = datetime.fromisoformat(str(evidence.get("transition_stopped_at")))
            start_at = datetime.fromisoformat(str(evidence.get("transition_start_at")))
        except (KeyError, TypeError, ValueError):
            continue
        if (
            start_at.tzinfo is None
            or stop_at.tzinfo is None
            or to_index != from_index + 1
            or _same_part_identity(groups[from_index], groups[to_index])
            or not (range_start <= stop_at < start_at < range_end)
        ):
            continue
        boundaries[from_index] = (stop_at, start_at)
    return boundaries


def _allocate_injection_shots_by_runs(
    groups: list[dict[str, Any]],
    samples: list[tuple[datetime, float]],
    baseline: float | None,
    confirmed_boundaries: dict[int, tuple[datetime, datetime]],
) -> tuple[list[int], int, dict[str, Any]]:
    """Allocate observed counter deltas without inventing a part at plan cap.

    A short/sparse restart remains setup output until three consecutive,
    comparably sized positive samples establish the next run. A change below
    the plan target remains uncertain without an independent field boundary.
    """
    allocations = [0] * len(groups)
    group_index = 0
    unattributed_shots = 0
    transition = {
        "phase": "running",
        "from_plan_id": _group_plan_id(groups[0]) if groups else None,
        "to_plan_id": _group_plan_id(groups[1]) if len(groups) > 1 else None,
        "current_plan_id": _group_plan_id(groups[0]) if groups else None,
        "stopped_at": None,
        "estimated_start_at": None,
        "confirmed_start_at": None,
        "confirmation_status": "pending",
        "setup_shots": 0,
    }
    if not groups:
        return allocations, unattributed_shots, transition

    def allocate_running(shots: int) -> None:
        nonlocal group_index
        remaining = shots
        while remaining > 0:
            next_index = group_index + 1
            if next_index >= len(groups) or not _same_running_product(groups[group_index], groups[next_index]):
                allocations[group_index] += remaining
                return
            capacity = max(0, int(groups[group_index]["required_shots"]) - allocations[group_index])
            if capacity == 0:
                group_index = next_index
                continue
            take = min(remaining, capacity)
            allocations[group_index] += take
            remaining -= take

    previous_capacity = baseline
    previous_sample_at: datetime | None = None
    last_positive_at: datetime | None = None
    first_zero_at: datetime | None = None
    pending_stop_at: datetime | None = None
    stable_window: list[tuple[datetime, float, int]] = []
    raw_total = 0.0
    for sample_at, capacity in samples:
        raw_delta = max(0.0, calculate_counter_increment(previous_capacity, capacity))
        previous_capacity = capacity
        old_rounded_total = round(raw_total)
        raw_total += raw_delta
        shots = round(raw_total) - old_rounded_total
        sample_gap_minutes = (
            (sample_at - previous_sample_at).total_seconds() / 60
            if previous_sample_at else None
        )
        is_covered = sample_gap_minutes is not None and 0 < sample_gap_minutes <= CHANGEOVER_MAX_SAMPLE_GAP_MINUTES
        previous_sample_at = sample_at

        manual_boundary = confirmed_boundaries.get(group_index)
        if manual_boundary and sample_at >= manual_boundary[0]:
            stop_at, start_at = manual_boundary
            transition.update({
                "phase": "changeover" if sample_at < start_at else "new_running",
                "from_plan_id": _group_plan_id(groups[group_index]),
                "to_plan_id": _group_plan_id(groups[group_index + 1]),
                "stopped_at": stop_at.astimezone(SHANGHAI_TZ).isoformat(),
                "estimated_start_at": None,
                "confirmed_start_at": start_at.astimezone(SHANGHAI_TZ).isoformat(),
                "confirmation_status": "confirmed",
            })
            if sample_at < start_at:
                unattributed_shots += shots
                transition["setup_shots"] += shots
                continue
            group_index += 1
            pending_stop_at = None
            stable_window.clear()
            first_zero_at = None

        if pending_stop_at is not None:
            if raw_delta <= 0:
                stable_window.clear()
                continue
            unattributed_shots += shots
            transition["setup_shots"] += shots
            if not is_covered:
                # A catch-up delta after a collector gap has no trustworthy
                # production time and cannot be part of the restart window.
                stable_window.clear()
                continue
            stable_window.append((sample_at, raw_delta, shots))
            stable_window = stable_window[-CHANGEOVER_STABLE_SAMPLES:]
            if len(stable_window) < CHANGEOVER_STABLE_SAMPLES:
                continue
            values = [item[1] for item in stable_window]
            average = sum(values) / len(values)
            if max(values) - min(values) > max(1.0, average * 0.35):
                continue
            stable_shots = sum(item[2] for item in stable_window)
            unattributed_shots -= stable_shots
            transition["setup_shots"] -= stable_shots
            group_index += 1
            transition["phase"] = "new_running"
            transition["estimated_start_at"] = stable_window[0][0].astimezone(SHANGHAI_TZ).isoformat()
            allocate_running(stable_shots)
            pending_stop_at = None
            stable_window.clear()
            first_zero_at = None
            last_positive_at = sample_at
            continue

        if raw_delta > 0:
            allocate_running(shots)
            last_positive_at = sample_at
            first_zero_at = None
            continue

        if last_positive_at is None or not is_covered:
            first_zero_at = None
            continue
        if first_zero_at is None:
            first_zero_at = sample_at
        # The first zero must itself be observed close to the last positive
        # sample; an unobserved collector gap is not evidence of a stop.
        if (sample_at - first_zero_at).total_seconds() < CHANGEOVER_STOP_MINUTES * 60:
            continue
        next_index = group_index + 1
        if (
            next_index >= len(groups)
            or _same_running_product(groups[group_index], groups[next_index])
            or allocations[group_index] < int(groups[group_index]["required_shots"])
        ):
            continue
        pending_stop_at = first_zero_at
        transition = {
            "phase": "changeover",
            "from_plan_id": _group_plan_id(groups[group_index]),
            "to_plan_id": _group_plan_id(groups[next_index]),
            "stopped_at": first_zero_at.astimezone(SHANGHAI_TZ).isoformat(),
            "estimated_start_at": None,
            "confirmed_start_at": None,
            "confirmation_status": "pending",
            "setup_shots": 0,
        }

    if transition["phase"] == "running":
        transition["from_plan_id"] = _group_plan_id(groups[group_index])
        transition["to_plan_id"] = _group_plan_id(groups[group_index + 1]) if group_index + 1 < len(groups) else None
    transition["current_plan_id"] = _group_plan_id(groups[group_index])
    return allocations, unattributed_shots, transition


def machine_label(machine_number: int) -> str:
    return f"{MACHINE_TONNAGE.get(machine_number, f'{machine_number}T')}-{machine_number}"


def machine_monitoring_name(machine_number: int) -> str:
    return f"{machine_number}호기"


def parse_machine_number(machine_name: str | None) -> int | None:
    if not machine_name:
        return None
    text = str(machine_name)
    match = re.search(r"(\d+)\s*(?:호기|号机)", text)
    if match:
        return int(match.group(1))
    match = re.search(r"-(\d+)\s*$", text)
    if match:
        return int(match.group(1))
    match = re.search(r"^\s*(\d+)\b", text)
    if match:
        return int(match.group(1))
    return None


def sum_positive_monitoring_delta(machine_name: str, field_name: str, start_dt: Any, end_dt: Any) -> int:
    baseline = (
        InjectionMonitoringRecord.objects
        .filter(machine_name=machine_name, timestamp__lt=start_dt)
        .exclude(**{f"{field_name}__isnull": True})
        .order_by("-timestamp")
        .values_list(field_name, flat=True)
        .first()
    )
    values = (
        InjectionMonitoringRecord.objects
        .filter(machine_name=machine_name, timestamp__gte=start_dt, timestamp__lt=end_dt)
        .exclude(**{f"{field_name}__isnull": True})
        .order_by("timestamp")
        .values_list(field_name, flat=True)
    )

    return calculate_cumulative_counter_delta(values, baseline=baseline)


def get_injection_active_machine_context(target_date: Any, lookback_minutes: int) -> dict[str, Any]:
    """Return machines whose MES capacity counter increased in the requested window.

    The window ends at the latest capacity sample inside the selected business day.
    It may cross the 08:00 business-day boundary so questions such as "last 12
    hours" keep their literal time range. Counter resets are handled by the same
    positive-delta function used by the production progress retriever.
    """
    try:
        requested_minutes = int(lookback_minutes)
    except (TypeError, ValueError):
        requested_minutes = 60
    # A selected business day anchors the end of the window, but operators may
    # ask about activity across several business-day boundaries. Bound the
    # query to seven days to keep the MES scan predictable.
    window_minutes = max(1, min(requested_minutes, 7 * 24 * 60))

    range_start, range_end = business_range(target_date)
    machine_names = [machine_monitoring_name(number) for number in range(1, 18)]
    latest_mes_time = (
        InjectionMonitoringRecord.objects
        .filter(
            machine_name__in=machine_names,
            timestamp__gte=range_start,
            timestamp__lt=range_end,
            capacity__isnull=False,
        )
        .aggregate(latest=Max("timestamp"))
        .get("latest")
    )
    reference_time = (
        latest_mes_time.astimezone(SHANGHAI_TZ)
        if latest_mes_time
        else reference_time_for_business_day(target_date, None)
    )
    window_start = reference_time - timedelta(minutes=window_minutes)
    counter_end = reference_time + timedelta(microseconds=1)

    rows = []
    if latest_mes_time:
        for machine_number in range(1, 18):
            monitoring_name = machine_monitoring_name(machine_number)
            shot_count = sum_positive_monitoring_delta(
                monitoring_name,
                "capacity",
                window_start,
                counter_end,
            )
            if shot_count <= 0:
                continue
            rows.append({
                "machine_number": machine_number,
                "machine": machine_label(machine_number),
                "machine_name": monitoring_name,
                "shot_count": shot_count,
            })

    current_business_date = (
        timezone.now().astimezone(SHANGHAI_TZ) - timedelta(hours=8)
    ).date()
    is_stale = bool(
        latest_mes_time is None
        or (
            target_date == current_business_date
            and timezone.now() - latest_mes_time.astimezone(timezone.get_current_timezone())
            > timedelta(minutes=10)
        )
    )
    monitoring_row_count = (
        InjectionMonitoringRecord.objects.filter(
            machine_name__in=machine_names,
            timestamp__gte=window_start,
            timestamp__lt=counter_end,
            capacity__isnull=False,
        ).count()
        if latest_mes_time else 0
    )

    return {
        "business_date": target_date,
        "business_range_start": range_start,
        "business_range_end": range_end,
        "window_start": window_start,
        "window_end": reference_time,
        "lookback_minutes": window_minutes,
        "requested_lookback_minutes": requested_minutes,
        "latest_mes_time": latest_mes_time,
        "is_stale": is_stale,
        "rows": rows,
        "monitoring_row_count": monitoring_row_count,
    }


def get_injection_machine_shot_context(
    target_date: Any,
    machine_numbers: list[int],
    *,
    as_of: Any | None = None,
) -> dict[str, Any]:
    """Retrieve reset-safe shot trends for explicitly requested machines.

    Unlike the plan progress retriever, this does not require a production plan,
    so an operator can inspect any of the 17 injection machines.
    """
    normalized_numbers = []
    for value in machine_numbers:
        try:
            machine_number = int(value)
        except (TypeError, ValueError):
            continue
        if 1 <= machine_number <= 17 and machine_number not in normalized_numbers:
            normalized_numbers.append(machine_number)

    range_start, range_end = business_range(target_date)
    rows = []
    machine_names = [machine_monitoring_name(number) for number in normalized_numbers]
    monitoring_queryset = InjectionMonitoringRecord.objects.filter(
        machine_name__in=machine_names,
        timestamp__gte=range_start,
        timestamp__lt=range_end,
        capacity__isnull=False,
    )
    current_business_date = (
        timezone.now().astimezone(SHANGHAI_TZ) - timedelta(hours=8)
    ).date()
    shift_window = production_shift_window(target_date, as_of)
    shift_counter_end = min(
        shift_window["end"],
        shift_window["reference_time"] + timedelta(microseconds=1),
    )

    for machine_number in normalized_numbers:
        monitoring_name = machine_monitoring_name(machine_number)
        latest_sample = (
            monitoring_queryset
            .filter(machine_name=monitoring_name)
            .order_by("-timestamp")
            .values("timestamp", "capacity")
            .first()
        )
        latest_mes_time = latest_sample.get("timestamp") if latest_sample else None
        if not latest_mes_time:
            rows.append({
                "machine_number": machine_number,
                "machine": machine_label(machine_number),
                "machine_name": monitoring_name,
                "shot_count": 0,
                "recent_60m_shots": 0,
                "recent_window_start": None,
                "reference_time": None,
                "latest_mes_time": None,
                "latest_capacity": None,
                "shift_shots": 0,
                "shift_code": shift_window["code"],
                "shift_start": shift_window["start"],
                "shift_end": shift_window["end"],
                "is_stale": True,
                "warning": "injection_capacity_data_missing",
            })
            continue

        reference_time = reference_time_for_business_day(target_date, latest_mes_time)
        recent_start = max(range_start, reference_time - timedelta(minutes=60))
        # The delta helper uses an exclusive end. Include a record that lands
        # exactly on the selected reference timestamp without crossing the
        # 08:00 business-day boundary.
        counter_end = min(range_end, reference_time + timedelta(microseconds=1))
        shot_count = sum_positive_monitoring_delta(
            monitoring_name,
            "capacity",
            range_start,
            counter_end,
        )
        recent_shots = sum_positive_monitoring_delta(
            monitoring_name,
            "capacity",
            recent_start,
            counter_end,
        )
        shift_shots = sum_positive_monitoring_delta(
            monitoring_name,
            "capacity",
            shift_window["start"],
            shift_counter_end,
        )
        recent_sample_count = InjectionMonitoringRecord.objects.filter(
            machine_name=monitoring_name,
            timestamp__gte=recent_start,
            timestamp__lt=counter_end,
            capacity__isnull=False,
        ).count()
        recent_has_baseline = InjectionMonitoringRecord.objects.filter(
            machine_name=monitoring_name,
            timestamp__lt=recent_start,
            capacity__isnull=False,
        ).exists()
        trend_window_available = recent_sample_count >= (1 if recent_has_baseline else 2)
        is_stale = bool(
            target_date == current_business_date
            and timezone.now() - latest_mes_time.astimezone(timezone.get_current_timezone()) > timedelta(minutes=10)
        )
        rows.append({
            "machine_number": machine_number,
            "machine": machine_label(machine_number),
            "machine_name": monitoring_name,
            "shot_count": shot_count,
            "recent_60m_shots": recent_shots,
            "recent_window_start": recent_start if trend_window_available else None,
            "recent_sample_count": recent_sample_count,
            "reference_time": reference_time,
            "latest_mes_time": latest_mes_time,
            # Raw device counter is display-only because it may reset. All
            # production arithmetic continues to use reset-safe deltas above.
            "latest_capacity": safe_int(latest_sample.get("capacity")) if latest_sample else None,
            "shift_shots": shift_shots,
            "shift_code": shift_window["code"],
            "shift_start": shift_window["start"],
            "shift_end": shift_window["end"],
            "is_stale": is_stale,
            "warning": (
                "injection_recent_trend_window_missing"
                if not trend_window_available else
                "injection_capacity_data_stale" if is_stale else None
            ),
        })

    return {
        "business_date": target_date,
        "range_start": range_start,
        "range_end": range_end,
        "rows": rows,
        "monitoring_row_count": monitoring_queryset.count(),
    }


def cavity_map_for_plans(plans: list[ProductionPlan]) -> dict[str, dict[str, Any]]:
    part_nos = {
        (plan.part_no or "").strip().upper()
        for plan in plans
        if plan.part_no
    }
    return get_cavity_meta_map(ProductionPartCavity, part_nos)


def _injection_counter_windows(machine_names, range_start, recent_start, counter_end):
    """Read each machine's capacity samples once for both production windows.

    Scalar indexed lookups select only the latest baseline IDs; no historical
    payload is hydrated. Keep the existing counter reducer and window bounds.
    """
    names = sorted(set(machine_names))
    if not names:
        return {}
    baseline_filter = Q(pk__in=[])
    for name in names:
        latest = (InjectionMonitoringRecord.objects
                  .filter(machine_name=name, timestamp__lt=range_start, capacity__isnull=False)
                  .order_by("-timestamp").values("pk")[:1])
        baseline_filter |= Q(pk=Subquery(latest))
    baselines = dict(InjectionMonitoringRecord.objects.filter(baseline_filter)
                     .values_list("machine_name", "capacity"))
    samples = {name: [] for name in names}
    for name, timestamp, capacity in (InjectionMonitoringRecord.objects
            .filter(machine_name__in=names, timestamp__gte=range_start,
                    timestamp__lt=counter_end, capacity__isnull=False)
            .order_by("timestamp").values_list("machine_name", "timestamp", "capacity")):
        samples[name].append((timestamp, capacity))
    result = {}
    for name, rows in samples.items():
        baseline = baselines.get(name)
        recent_baseline = baseline
        recent_values = []
        for timestamp, capacity in rows:
            if timestamp < recent_start:
                recent_baseline = capacity
            else:
                recent_values.append(capacity)
        result[name] = {
            "shots": calculate_cumulative_counter_delta((value for _, value in rows), baseline=baseline),
            "recent_shots": calculate_cumulative_counter_delta(recent_values, baseline=recent_baseline),
            "latest": rows[-1][0] if rows else None,
            "samples": rows,
            "baseline": baseline,
        }
    return result


def get_injection_summary(
    target_date: Any,
    *,
    machine_numbers: list[int] | None = None,
) -> dict[str, Any]:
    range_start, range_end = business_range(target_date)
    plan_queryset = (
        ProductionPlan.objects
        .filter(plan_date=target_date, plan_type="injection", planned_quantity__gt=0)
        .order_by("machine_name", "sequence", "id")
    )
    plans = list(plan_queryset)
    requested_machine_numbers = (
        {int(number) for number in machine_numbers}
        if machine_numbers is not None else None
    )
    if requested_machine_numbers is not None:
        plans = [
            plan for plan in plans
            if parse_machine_number(plan.machine_name) in requested_machine_numbers
        ]
    cavity_map = cavity_map_for_plans(plans)
    latest_mes_time = (
        InjectionMonitoringRecord.objects
        .filter(timestamp__gte=range_start, timestamp__lt=range_end)
        # Production output is derived only from the cumulative capacity
        # counter. Power or temperature telemetry must not make a missing
        # production counter look like a verified zero-output sample.
        .filter(capacity__isnull=False)
        .aggregate(latest=Max("timestamp"))
        .get("latest")
    )
    reference_time = reference_time_for_business_day(target_date, latest_mes_time)
    time_progress_rate = elapsed_rate(target_date, reference_time)
    recent_start = max(range_start, reference_time - timedelta(minutes=60))
    # Counter queries use an exclusive end. Include the latest sample when the
    # selected business day is still in progress, without crossing 08:00.
    counter_end = min(range_end, reference_time + timedelta(microseconds=1))
    now = timezone.now()
    current_business_date = (now.astimezone(SHANGHAI_TZ) - timedelta(hours=8)).date()

    def sort_key(plan: ProductionPlan) -> tuple[int, int, int]:
        machine_number = parse_machine_number(plan.machine_name)
        return (machine_number or 999, int(plan.sequence or 0), int(plan.id or 0))

    sorted_plans = sorted(plans, key=sort_key)
    counter_windows = _injection_counter_windows(
        [machine_monitoring_name(number) for plan in sorted_plans
         if (number := parse_machine_number(plan.machine_name)) is not None],
        range_start, recent_start, counter_end,
    )
    changeover_confirmations: dict[int, list[InjectionDowntimeConfirmation]] = {}
    for confirmation in InjectionDowntimeConfirmation.objects.filter(
        business_date=target_date,
        resolution="confirmed",
        reason_code__in=["mold_change", "core_change"],
    ).order_by("detected_start", "id"):
        number = parse_machine_number(confirmation.machine_key)
        if number is not None:
            changeover_confirmations.setdefault(number, []).append(confirmation)
    machine_rows = []
    part_rows = []

    for machine_name, grouped in groupby(sorted_plans, key=lambda plan: plan.machine_name):
        machine_plans = list(grouped)
        machine_number = parse_machine_number(machine_name)
        if machine_number is None:
            continue
        monitor_name = machine_monitoring_name(machine_number)
        machine_counters = counter_windows[monitor_name]
        machine_latest_capacity_time = machine_counters["latest"]
        machine_capacity_is_stale = bool(
            target_date == current_business_date
            and (
                not machine_latest_capacity_time
                or now - machine_latest_capacity_time.astimezone(now.tzinfo) > timedelta(minutes=10)
            )
        )
        machine_data_warning = (
            "injection_capacity_data_missing"
            if not machine_latest_capacity_time else
            "injection_capacity_data_stale"
            if machine_capacity_is_stale else None
        )
        shot_count = machine_counters["shots"]
        recent_shots = machine_counters["recent_shots"]
        plan_groups = build_cavity_plan_groups(machine_plans, cavity_map)
        confirmed_boundaries = _confirmed_changeover_boundaries(
            changeover_confirmations.get(machine_number, []),
            plan_groups,
            range_start,
            range_end,
        )
        group_allocations, unattributed_shots, transition = _allocate_injection_shots_by_runs(
            plan_groups,
            machine_counters["samples"],
            machine_counters["baseline"],
            confirmed_boundaries,
        )
        # The counter reducer is the canonical total. Prefix rounding in the
        # allocation helper must reconcile with that same reset-safe total.
        assert shot_count == sum(group_allocations) + unattributed_shots
        planned_qty = 0
        attributed_actual_qty = 0
        completed_count = 0
        in_progress_count = 0
        pending_count = 0
        parts = []

        sequence = 1
        for group_index, plan_group in enumerate(plan_groups, start=1):
            allocated_shots = group_allocations[group_index - 1]
            expected_group_size = max(
                (
                    max(1, int((member.get("meta") or {}).get("parts_per_shot") or 1))
                    for member in plan_group["members"]
                ),
                default=1,
            )
            production_group_id = f'{plan_group["group_key"]}:{group_index}'
            production_group_complete = len(plan_group["members"]) == expected_group_size

            for member in plan_group["members"]:
                plan = member["plan"]
                part_planned_qty = safe_int(plan.planned_quantity)
                if part_planned_qty <= 0:
                    continue
                part_no = (plan.part_no or "").strip().upper()
                cavity = max(1, int(member["cavity"] or 1))
                meta = member.get("meta") or {}
                estimated_qty = int(round(allocated_shots * cavity))
                part_progress = safe_rate(estimated_qty, part_planned_qty)
                is_current_group = plan_group["members"][0]["plan"].id == transition["current_plan_id"]
                status = (
                    "in_progress" if is_current_group and allocated_shots > 0
                    else "completed" if part_progress >= 99.9
                    else "in_progress" if part_progress > 0
                    else "pending"
                )
                planned_qty += part_planned_qty
                attributed_actual_qty += estimated_qty
                completed_count += 1 if status == "completed" else 0
                in_progress_count += 1 if status == "in_progress" else 0
                pending_count += 1 if status == "pending" else 0
                part_payload = {
                    "plan_id": plan.id,
                    "sequence": sequence,
                    "machine": machine_label(machine_number),
                    "machine_name": machine_name or machine_label(machine_number),
                    "machine_number": machine_number,
                    "part_no": part_no or "-",
                    "model_name": plan.model_name or plan.part_spec or "-",
                    "lot_no": plan.lot_no or "-",
                    "product_family_code": plan.product_family_code,
                    "product_family_name": plan.product_family_name,
                    "is_finished_product": bool(plan.is_finished_product),
                    "planned_qty": part_planned_qty,
                    "allocated_shots": int(round(allocated_shots)),
                    "estimated_qty": estimated_qty,
                    "gap_qty": estimated_qty - part_planned_qty,
                    "progress_rate": part_progress,
                    "cavity": cavity,
                    "cavity_pattern": meta.get("cavity_pattern"),
                    "parts_per_shot": meta.get("parts_per_shot", 1),
                    "cavity_group": meta.get("cavity_group"),
                    "total_cavity": meta.get("total_cavity", cavity),
                    "production_group_id": production_group_id,
                    "production_group_complete": production_group_complete,
                    "status": status,
                }
                sequence += 1
                parts.append(part_payload)
                part_rows.append(part_payload)

        actual_qty = attributed_actual_qty
        machine_progress = safe_rate(actual_qty, planned_qty)
        expected_qty_by_time = safe_int(planned_qty * time_progress_rate / 100)
        machine_rows.append({
            "machine": machine_label(machine_number),
            "machine_name": machine_name or machine_label(machine_number),
            "machine_number": machine_number,
            "planned_qty": planned_qty,
            "actual_qty": actual_qty,
            "gap_qty": actual_qty - planned_qty,
            "expected_qty_by_time": expected_qty_by_time,
            "gap_to_time_qty": actual_qty - expected_qty_by_time,
            "gap_to_time_rate_pp": round(machine_progress - time_progress_rate, 1),
            "progress_rate": machine_progress,
            "shot_count": shot_count,
            "unattributed_shots": unattributed_shots,
            "transition": transition,
            "recent_60m_shots": recent_shots,
            "recent_60m_avg_ct_sec": round(3600 / recent_shots, 1) if recent_shots > 0 else None,
            "is_running": recent_shots > 0 and transition["phase"] != "changeover",
            "latest_capacity_time": machine_latest_capacity_time,
            "capacity_data_available": machine_data_warning is None,
            "data_warning": machine_data_warning,
            "completed_count": completed_count,
            "in_progress_count": in_progress_count,
            "pending_count": pending_count,
            "parts": parts,
        })

    total_planned = sum(row["planned_qty"] for row in machine_rows)
    total_actual = sum(row["actual_qty"] for row in machine_rows)
    machine_rows.sort(key=lambda row: row["machine_number"])

    return {
        "process": "injection",
        "range_start": range_start,
        "range_end": range_end,
        "reference_time": reference_time,
        "latest_mes_time": latest_mes_time,
        "time_progress_rate": time_progress_rate,
        "planned_qty": total_planned,
        "actual_qty": total_actual,
        "progress_rate": safe_rate(total_actual, total_planned),
        "gap_qty": total_actual - total_planned,
        "active_equipment_count": sum(1 for row in machine_rows if row["actual_qty"] > 0),
        "running_equipment_count": sum(1 for row in machine_rows if row["is_running"]),
        "total_equipment_count": 17,
        "plan_row_count": len(plans),
        "monitoring_row_count": InjectionMonitoringRecord.objects.filter(
            timestamp__gte=range_start,
            timestamp__lt=range_end,
            capacity__isnull=False,
        ).count(),
        "capacity_coverage_complete": all(
            not row.get("data_warning")
            for row in machine_rows
        ),
        "last_plan_updated_at": max(
            (plan.updated_at for plan in plans if plan.updated_at is not None),
            default=None,
        ),
        "machine_rows": machine_rows,
        "part_rows": part_rows,
    }


def get_machining_summary(target_date: Any) -> dict[str, Any]:
    range_start, range_end = business_range(target_date)
    provision = build_machining_provision_payload(target_date, days=1)
    plan_queryset = ProductionPlan.objects.filter(plan_date=target_date, plan_type="machining", planned_quantity__gt=0)
    mes_queryset = ProductionMesReportRecord.objects.filter(
        business_date=target_date,
        plan_type="machining",
    ).order_by("report_time")

    rows = []
    for row in provision.get("rows", []):
        planned_qty = safe_int(row.get("planned_qty"))
        actual_qty = safe_int(row.get("effective_actual_qty"))
        equipment_key = row.get("equipment_key") or ""
        equipment_name = row.get("machine_name") or equipment_key
        rows.append({
            "equipment_key": equipment_key,
            "equipment_name": equipment_name,
            "equipment_label": row.get("equipment_label") or format_equipment_label("machining", equipment_name, equipment_key),
            "part_no": row.get("part_no") or "",
            "model_name": row.get("model_name") or "",
            "planned_qty": planned_qty,
            "actual_qty": actual_qty,
            "gap_qty": actual_qty - planned_qty,
            "progress_rate": safe_rate(actual_qty, planned_qty),
            "latest_report_time": None,
            "mes_qty": safe_int(row.get("mes_qty")),
            "manual_open_qty": safe_int(row.get("manual_open_qty")),
            "matched_manual_qty": safe_int(row.get("matched_manual_qty")),
            "defect_qty": safe_int(row.get("defect_qty")),
            "status": row.get("status"),
        })

    planned_qty = sum(row["planned_qty"] for row in rows)
    actual_qty = sum(row["actual_qty"] for row in rows)
    latest_report_time = mes_queryset.aggregate(latest=Max("report_time")).get("latest")

    return {
        "process": "machining",
        "range_start": range_start,
        "range_end": range_end,
        "planned_qty": planned_qty,
        "actual_qty": actual_qty,
        "progress_rate": safe_rate(actual_qty, planned_qty),
        "gap_qty": actual_qty - planned_qty,
        "active_equipment_count": len({row["equipment_label"] for row in rows if row["actual_qty"] > 0}),
        "running_equipment_count": 0,
        "total_equipment_count": len({row["equipment_label"] for row in rows if row["planned_qty"] > 0}),
        "plan_row_count": plan_queryset.count(),
        "mes_row_count": mes_queryset.count(),
        "last_plan_updated_at": plan_queryset.order_by("-updated_at").values_list("updated_at", flat=True).first(),
        "latest_report_time": latest_report_time,
        "rows": rows,
    }


def get_daily_production_context(target_date: Any) -> dict[str, Any]:
    injection = get_injection_summary(target_date)
    machining = get_machining_summary(target_date)
    time_progress_rate = float(injection.get("time_progress_rate") or 0)
    machining["time_progress_rate"] = time_progress_rate
    for row in machining.get("rows", []):
        expected_qty_by_time = safe_int(row.get("planned_qty", 0) * time_progress_rate / 100)
        row["expected_qty_by_time"] = expected_qty_by_time
        row["gap_to_time_qty"] = safe_int(row.get("actual_qty")) - expected_qty_by_time
        row["gap_to_time_rate_pp"] = round(float(row.get("progress_rate") or 0) - time_progress_rate, 1)
    return {
        "business_date": target_date,
        "range_start": injection["range_start"],
        "range_end": injection["range_end"],
        "reference_time": injection["reference_time"],
        "injection": injection,
        "machining": machining,
    }
