"""Read-only analysis of the checkpoints already saved by field terminals.

The field writer stores these documents in MouldDataSnapshot, not in the
quality report tables.  Counts describe reported checkpoint segments only;
their MES-derived gross quantity is not an inspection denominator.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
import math
import re
from zoneinfo import ZoneInfo

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from injection.models import MouldDataSnapshot


SCHEMA_VERSION = "field-operations.v1"
SOURCE_SCHEMA = "field-defects.v1"
SHANGHAI = ZoneInfo("Asia/Shanghai")
# The vocabulary written by production.field_kanban.DEFECT_TYPES. Keeping this
# reader independent avoids loading document upload/conversion integrations.
DEFECT_CODES = frozenset({
    "scratch", "black_dot", "eaten_meat", "air_mark", "deform", "short_shot",
    "broken_pillar", "flow_mark", "sink_mark", "whitening", "other",
})


def parse_field_business_date(value: str | None) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("date must use YYYY-MM-DD.")
    try:
        parsed = date.fromisoformat(value)
        if parsed == date.max:
            raise ValueError("date has no following business-day boundary")
        return parsed
    except ValueError as exc:
        raise ValueError("date must use YYYY-MM-DD.") from exc


def parse_field_machine_number(value: str | None) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"(?:[1-9]|1[0-7])", value):
        raise ValueError("machine_number must be an integer from 1 to 17.")
    return int(value)


def _integer(value, *, positive=False) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("invalid_numeric_value")
    if not math.isfinite(value) or value != int(value) or not 0 <= value <= 2**53 - 1:
        raise ValueError("invalid_numeric_value")
    if positive and value < 1:
        raise ValueError("invalid_numeric_value")
    return int(value)


def _event_matches(event_key, trigger, target_date, machine_number) -> bool:
    if not isinstance(event_key, str) or not isinstance(trigger, str):
        return False
    scope = f"{target_date.isoformat()}:{machine_number}"
    if trigger in {"shift_0800", "shift_2000"}:
        return event_key == f"defect:shift:{scope}:{trigger[-4:]}"
    if trigger == "manual":
        return re.fullmatch(rf"manual:{re.escape(scope)}:\d+", event_key) is not None
    if trigger == "part_change":
        return re.fullmatch(rf"defect:part-change:{re.escape(scope)}:\d+:gap", event_key) is not None
    return False


def _validated_checkpoint(row, target_date, machine_number):
    if not isinstance(row, dict):
        raise ValueError("invalid_checkpoint_shape")
    if row.get("business_date") != target_date.isoformat() or _integer(row.get("machine_number")) != machine_number:
        raise ValueError("checkpoint_scope_mismatch")
    if not _event_matches(row.get("event_key"), row.get("trigger"), target_date, machine_number):
        raise ValueError("invalid_checkpoint_event")
    if not isinstance(row.get("part_no"), str) or not row["part_no"].strip():
        raise ValueError("checkpoint_part_missing")

    quantities = {key: _integer(row.get(key)) for key in (
        "segment_shots", "ending_business_day_shots", "gross_piece_qty",
        "defect_piece_qty", "good_piece_qty",
    )}
    cavity = _integer(row.get("cavity"), positive=True)
    if (
        quantities["ending_business_day_shots"] < quantities["segment_shots"]
        or quantities["gross_piece_qty"] != quantities["segment_shots"] * cavity
        or quantities["defect_piece_qty"] > quantities["gross_piece_qty"]
        or quantities["good_piece_qty"] != quantities["gross_piece_qty"] - quantities["defect_piece_qty"]
    ):
        raise ValueError("checkpoint_quantity_mismatch")

    if not isinstance(row.get("items"), list):
        raise ValueError("invalid_defect_items")
    items = defaultdict(int)
    for item in row["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("code"), str) or item["code"] not in DEFECT_CODES:
            raise ValueError("invalid_defect_code")
        items[item["code"]] += _integer(item.get("quantity"))
    if sum(items.values()) != quantities["defect_piece_qty"]:
        raise ValueError("defect_item_total_mismatch")

    completed_at = row.get("completed_at")
    try:
        completed = parse_datetime(completed_at) if isinstance(completed_at, str) else None
    except (ValueError, TypeError):
        completed = None
    if completed is None or timezone.is_naive(completed):
        raise ValueError("checkpoint_completion_time_invalid")
    return {
        "event_key": row["event_key"],
        "trigger": row["trigger"],
        "completed_at": completed,
        "items": dict(items),
        **quantities,
    }


def _totals(checkpoints):
    return {
        "checkpoint_count": len(checkpoints),
        "zero_defect_checkpoint_count": sum(row["defect_piece_qty"] == 0 for row in checkpoints),
        "reported_defect_qty": sum(row["defect_piece_qty"] for row in checkpoints) if checkpoints else None,
        "estimated_gross_qty": sum(row["gross_piece_qty"] for row in checkpoints) if checkpoints else None,
        "derived_good_qty": sum(row["good_piece_qty"] for row in checkpoints) if checkpoints else None,
        "latest_reported_at": max(row["completed_at"] for row in checkpoints).isoformat() if checkpoints else None,
    }


def _exclude_overlapping_segments(checkpoints):
    """Quarantine every event in an overlapping positive-shot interval group.

    The writer creates contiguous segments under a lock. Different event keys
    alone therefore cannot make two claims on the same shot range trustworthy.
    Zero-shot reports remain valid; touching interval boundaries do not overlap.
    """
    intervals = sorted(
        (row["ending_business_day_shots"] - row["segment_shots"],
         row["ending_business_day_shots"], row["event_key"])
        for row in checkpoints if row["segment_shots"] > 0
    )
    excluded = set()
    group = []
    group_end = 0
    for start, end, event_key in intervals:
        if group and start >= group_end:
            if len(group) > 1:
                excluded.update(group)
            group = []
        group.append(event_key)
        group_end = max(group_end, end)
    if len(group) > 1:
        excluded.update(group)
    return [row for row in checkpoints if row["event_key"] not in excluded], len(excluded)


def build_field_operations(target_date: date, machine_number: int | None = None) -> dict:
    if machine_number is not None and (type(machine_number) is not int or not 1 <= machine_number <= 17):
        raise ValueError("machine_number must be an integer from 1 to 17.")
    machine_numbers = [machine_number] if machine_number is not None else list(range(1, 18))
    date_key = target_date.strftime("%Y%m%d")
    snapshot_keys = {f"field-defects-v1-{date_key}-{number:02d}": number for number in machine_numbers}
    documents = list(MouldDataSnapshot.objects.filter(snapshot_key__in=snapshot_keys).only(
        "snapshot_key", "payload", "refreshed_at", "last_error",
    ).order_by("snapshot_key"))
    by_machine = defaultdict(list)
    invalid_machines = set()
    invalid_documents = invalid_checkpoints = duplicate_checkpoints = 0
    exclusions = defaultdict(int)
    warnings = set()

    for document in documents:
        machine_number = snapshot_keys[document.snapshot_key]
        payload = document.payload
        if (
            not isinstance(payload, dict)
            or payload.get("schema_version") != SOURCE_SCHEMA
            or payload.get("business_date") != target_date.isoformat()
            or isinstance(payload.get("machine_number"), bool)
            or payload.get("machine_number") != machine_number
            or not isinstance(payload.get("checkpoints"), list)
        ):
            invalid_documents += 1
            invalid_machines.add(machine_number)
            warnings.add("invalid_field_checkpoint_document")
            continue
        if document.last_error:
            warnings.add("field_checkpoint_source_error")

        events = {}
        conflicts = set()
        for row in payload["checkpoints"]:
            # Do not choose arbitrarily between conflicting copies of an event.
            event_key = row.get("event_key") if isinstance(row, dict) else None
            if isinstance(event_key, str) and event_key in events:
                duplicate_checkpoints += 1
                warnings.add("duplicate_field_checkpoint_event")
                if row != events[event_key]:
                    conflicts.add(event_key)
                continue
            if isinstance(event_key, str):
                events[event_key] = row
            else:
                invalid_checkpoints += 1
                invalid_machines.add(machine_number)
                exclusions["invalid_checkpoint_event"] += 1

        for event_key, row in events.items():
            try:
                if event_key in conflicts:
                    raise ValueError("conflicting_checkpoint_event")
                checked = _validated_checkpoint(row, target_date, machine_number)
            except (ValueError, OverflowError) as exc:
                invalid_checkpoints += 1
                invalid_machines.add(machine_number)
                exclusions[str(exc)] += 1
                continue
            by_machine[machine_number].append(checked)

        by_machine[machine_number], overlapping_count = _exclude_overlapping_segments(by_machine[machine_number])
        if overlapping_count:
            invalid_checkpoints += overlapping_count
            invalid_machines.add(machine_number)
            exclusions["overlapping_checkpoint_segments"] += overlapping_count
            warnings.add("overlapping_field_checkpoint_segments")

    if invalid_checkpoints:
        warnings.add("invalid_field_checkpoint_excluded")
    all_checkpoints = [row for rows in by_machine.values() for row in rows]
    recorded_count = sum(bool(rows) for rows in by_machine.values())
    machines = [{
        "machine_number": number,
        "station_id": f"imm{number:02d}",
        "status": "reported" if by_machine[number] else "invalid" if number in invalid_machines else "no_records",
        **_totals(by_machine[number]),
    } for number in machine_numbers]
    defect_quantities = defaultdict(int)
    defect_checkpoints = defaultdict(int)
    for row in all_checkpoints:
        for code, quantity in row["items"].items():
            if quantity > 0:
                defect_quantities[code] += quantity
                defect_checkpoints[code] += 1

    status = "partial" if warnings else "ok" if all_checkpoints else "no_records"
    if not all_checkpoints:
        warnings.add("no_valid_field_checkpoints")
    if recorded_count < len(machine_numbers):
        warnings.add("field_records_do_not_cover_all_machines")
    summary = {**_totals(all_checkpoints), "recorded_machine_count": recorded_count}
    start = datetime.combine(target_date, time(8), tzinfo=SHANGHAI)
    return {
        "schema_version": SCHEMA_VERSION,
        "business_date": target_date.isoformat(),
        "scope": {"machine_numbers": machine_numbers, "kind": "machine" if len(machine_numbers) == 1 else "fleet"},
        "business_window": {"timezone": "Asia/Shanghai", "start": start.isoformat(), "end": (start + timedelta(days=1)).isoformat()},
        "status": status,
        "summary": summary,
        "machines": machines,
        "defects": [{"code": code, "reported_defect_qty": quantity, "checkpoint_count": defect_checkpoints[code]}
                    for code, quantity in sorted(defect_quantities.items(), key=lambda item: (-item[1], item[0]))],
        "coverage": {
            "total_machine_count": len(machine_numbers),
            "recorded_machine_count": recorded_count,
            "unrecorded_machine_count": len(machine_numbers) - recorded_count,
            "invalid_document_count": invalid_documents,
            "invalid_checkpoint_count": invalid_checkpoints,
            "duplicate_checkpoint_count": duplicate_checkpoints,
            "excluded_by_reason": dict(exclusions),
            "basis": "Selected machines with at least one valid checkpoint; not planned-shift or inspection coverage.",
        },
        "freshness": {
            "generated_at": timezone.now().isoformat(),
            "latest_reported_at": summary["latest_reported_at"],
            "snapshot_updated_at": max(document.refreshed_at for document in documents).isoformat() if documents else None,
            "refresh_policy": "event_driven",
        },
        "used_data": [{
            "source": "injection.MouldDataSnapshot",
            "schema_version": SOURCE_SCHEMA,
            "scope": f"Selected business date, injection machines {','.join(map(str, machine_numbers))}, persisted field defect checkpoints only.",
            "document_count": len(documents),
            "valid_checkpoint_count": len(all_checkpoints),
        }],
        "calculation_basis": [
            "Reported defects = sum of validated, deduplicated checkpoint defect_piece_qty; zero-defect reports are retained.",
            "Conflicting copies of an event and overlapping positive-shot segments are excluded from all quantity totals.",
            "Estimated gross = checkpoint segment_shots × selected plan cavity, as stored when the field report was submitted.",
            "Derived good = estimated gross − reported defects; not inspected good output or the factory defect rate.",
            "Checkpoint segments can span plan changes; cavity allocation and reporting coverage must be reviewed before calculating rates.",
            "No checkpoint means not recorded, not zero defects. Latest input time does not establish live MES freshness.",
        ],
        "warnings": sorted(warnings),
    }
