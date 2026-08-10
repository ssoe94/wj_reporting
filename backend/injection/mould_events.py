"""Pure helpers for deriving mould position events from BLACKLAKE records.

The BLACKLAKE mould resource exposes the current location, while its operation
log and the WJ replacement records expose auditable change timestamps.  This
module deliberately does not make network or database calls so the rules stay
deterministic and easy to test.

``updatedAt`` on the parent mould resource is a generic record modification
time.  Callers may pass it as ``record_updated_at`` for provenance, but it is
never considered an event timestamp or a fallback for ``last_changed_at``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any


MACHINE_LOCATION_CODES = frozenset(
    {
        "#1-850T",
        "#2-850T",
        "#3-1300T",
        "#4-1400T",
        "#5-1400T",
        "#6-2500T",
        "#7-1300T",
        "#8-850T",
        "#9-850T",
        "#10-650T",
        "#11-550T",
        "#12-550T",
        "#13-450T",
        "#14-850T",
        "#15-650T",
        "#16-1050T",
        "#17-1200T",
    }
)

# WJ storage cells currently use either a zone/row/slot label (``C9-18``) or
# a zone/ordinal label (``A-1``).  Matching is intentionally strict: a value
# outside these known grammars remains unknown until it is explicitly mapped.
_STORAGE_LOCATION_RE = re.compile(r"^(?:[ABCS]\d+-\d+|[ABCS]-\d+)$")

_LOCATION_VALUE_KEYS = (
    "code",
    "locationCode",
    "location_code",
    "name",
    "locationName",
    "location_name",
    "value",
)
_FROM_LOCATION_KEYS = (
    "fieldValueFrom",
    "fromLocation",
    "from_location",
    "previousLocation",
    "previous_location",
    "oldLocation",
    "old_location",
    "sourceLocation",
    "source_location",
)
_TO_LOCATION_KEYS = (
    "fieldValueTo",
    "toLocation",
    "to_location",
    "currentLocation",
    "current_location",
    "newLocation",
    "new_location",
    "destinationLocation",
    "destination_location",
    "location",
)
_LOCATION_FIELD_NAMES = frozenset(
    {
        "location",
        "locationcode",
        "locationname",
        "区域",
        "当前区域",
        "位置",
        "当前位置",
        "模具位置",
    }
)

_MIN_TIMESTAMP_MS = 946_684_800_000  # 2000-01-01T00:00:00Z
_MAX_TIMESTAMP_MS = 4_102_444_800_000  # 2100-01-01T00:00:00Z
_SOURCE_PRIORITY = {"replacement_record": 1, "operation_log": 2}


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _clean_location_text(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (str, int)):
        text = str(value).strip()
        return text or None
    return None


def _location_candidates(value: Any) -> list[str]:
    if value is None:
        return []

    if isinstance(value, Mapping):
        if "locations" in value:
            nested = _location_candidates(value.get("locations"))
            if nested:
                return nested

        candidates: list[str] = []
        for key in _LOCATION_VALUE_KEYS:
            cleaned = _clean_location_text(value.get(key))
            if cleaned:
                candidates.append(cleaned)
        return _unique(candidates)

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        ranked: list[tuple[int, int, list[str]]] = []
        for index, item in enumerate(value):
            level = 0
            if isinstance(item, Mapping):
                try:
                    level = int(item.get("level") or 0)
                except (TypeError, ValueError):
                    level = 0
            candidates = _location_candidates(item)
            if candidates:
                ranked.append((level, index, candidates))
        if not ranked:
            return []
        # ``locations`` is a hierarchy, not a history.  Prefer the deepest
        # item and use input order only as a deterministic tie breaker.
        return max(ranked, key=lambda item: (item[0], item[1]))[2]

    cleaned = _clean_location_text(value)
    return [cleaned] if cleaned else []


def normalize_location(value: Any) -> str | None:
    """Return the best location label from a scalar, mapping, or hierarchy."""

    candidates = _location_candidates(value)
    for candidate in candidates:
        if classify_location(candidate) != "unknown":
            return candidate
    return candidates[0] if candidates else None


def classify_location(value: Any) -> str:
    """Classify a location using the exact WJ machine and storage rules."""

    candidates = _location_candidates(value)
    for candidate in candidates:
        if candidate in MACHINE_LOCATION_CODES:
            return "machine"
    for candidate in candidates:
        if _STORAGE_LOCATION_RE.fullmatch(candidate):
            return "storage"
    return "unknown"


def _validated_timestamp(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value.isdigit():
            return None
    try:
        timestamp = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if _MIN_TIMESTAMP_MS <= timestamp < _MAX_TIMESTAMP_MS:
        return timestamp
    return None


def _first_value(record: Mapping[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        if key in record:
            return record.get(key)
    return None


def _normalised_field_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\s_-]+", "", value).casefold()


def _is_location_field(change: Mapping[str, Any]) -> bool:
    field_name = change.get("fieldName")
    if field_name is None:
        return True
    return _normalised_field_name(field_name) in _LOCATION_FIELD_NAMES


def _iter_detail_changes(record: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    detail_fields = record.get("detailFields")
    if isinstance(detail_fields, Sequence) and not isinstance(
        detail_fields, (str, bytes, bytearray)
    ):
        for change in detail_fields:
            if isinstance(change, Mapping) and _is_location_field(change):
                yield change
    else:
        yield record

    sub_objects = record.get("subObjectList")
    if isinstance(sub_objects, Sequence) and not isinstance(
        sub_objects, (str, bytes, bytearray)
    ):
        for group in sub_objects:
            if isinstance(group, Mapping):
                yield from _iter_detail_changes(group)
            elif isinstance(group, Sequence) and not isinstance(
                group, (str, bytes, bytearray)
            ):
                for sub_record in group:
                    if isinstance(sub_record, Mapping):
                        yield from _iter_detail_changes(sub_record)


def _source_identifier(record: Mapping[str, Any], source: str, index: int) -> str:
    keys = ("logId", "id", "recordId", "record_id")
    value = _first_value(record, keys)
    if value is None:
        return f"{source}:{index}"
    return str(value)


def _transition_quality(
    from_kind: str,
    to_kind: str,
    *,
    warnings: list[str],
) -> str:
    if from_kind != "unknown" and to_kind != "unknown" and not warnings:
        return "verified"
    return "partial"


def _build_transition(
    *,
    record: Mapping[str, Any],
    change: Mapping[str, Any],
    source: str,
    timestamp_key: str,
    source_id: str,
) -> tuple[dict[str, Any] | None, list[str]]:
    warnings: list[str] = []
    occurred_at = _validated_timestamp(record.get(timestamp_key))
    if occurred_at is None:
        return None, [f"invalid_{source}_timestamp:{source_id}"]

    raw_from = _first_value(change, _FROM_LOCATION_KEYS)
    raw_to = _first_value(change, _TO_LOCATION_KEYS)
    from_location = normalize_location(raw_from)
    to_location = normalize_location(raw_to)

    if from_location is None and to_location is None:
        return None, [f"missing_location_values:{source_id}"]
    if from_location == to_location:
        return None, [f"same_location_ignored:{source_id}"]

    from_kind = classify_location(from_location)
    to_kind = classify_location(to_location)
    if from_kind == "unknown":
        warnings.append(f"unknown_from_location:{source_id}")
    if to_kind == "unknown":
        warnings.append(f"unknown_to_location:{source_id}")

    return (
        {
            "occurred_at": occurred_at,
            "source": source,
            "source_id": source_id,
            "from_location": from_location,
            "to_location": to_location,
            "from_kind": from_kind,
            "to_kind": to_kind,
            "quality": _transition_quality(from_kind, to_kind, warnings=warnings),
            "warnings": list(warnings),
        },
        warnings,
    )


def _collect_transitions(
    records: Iterable[Mapping[str, Any]],
    *,
    source: str,
    timestamp_key: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    transitions: list[dict[str, Any]] = []
    warnings: list[str] = []

    for index, record in enumerate(records):
        if not isinstance(record, Mapping):
            warnings.append(f"invalid_{source}_record:{index}")
            continue
        source_id = _source_identifier(record, source, index)
        found_change = False
        for change in _iter_detail_changes(record):
            found_change = True
            transition, transition_warnings = _build_transition(
                record=record,
                change=change,
                source=source,
                timestamp_key=timestamp_key,
                source_id=source_id,
            )
            warnings.extend(transition_warnings)
            if transition is not None:
                transitions.append(transition)
        if not found_change:
            warnings.append(f"missing_location_values:{source_id}")

    return transitions, warnings


def _expand_transition(transition: Mapping[str, Any]) -> list[dict[str, Any]]:
    from_kind = transition["from_kind"]
    to_kind = transition["to_kind"]
    base = {
        "occurred_at": transition["occurred_at"],
        "source": transition["source"],
        "source_id": transition["source_id"],
        "from_location": transition["from_location"],
        "to_location": transition["to_location"],
        "quality": transition["quality"],
        "warnings": list(transition["warnings"]),
    }

    if from_kind == "machine" and to_kind == "machine":
        return [{**base, "type": "unmount"}, {**base, "type": "mount"}]
    if to_kind == "machine" and from_kind != "machine":
        return [{**base, "type": "mount"}]
    if from_kind == "machine" and to_kind != "machine":
        return [{**base, "type": "unmount"}]
    return [{**base, "type": "move"}]


def _quality_for_result(
    *,
    transitions: Sequence[Mapping[str, Any]],
    current_state: str,
    warnings: Sequence[str],
) -> str:
    if not transitions and current_state == "unknown":
        return "unknown"
    if warnings or any(item["quality"] != "verified" for item in transitions):
        return "partial"
    return "verified"


def normalize_position_history(
    operation_logs: Iterable[Mapping[str, Any]] = (),
    replacement_records: Iterable[Mapping[str, Any]] = (),
    *,
    current_location: Any = None,
    record_updated_at: Any = None,
) -> dict[str, Any]:
    """Normalize auditable BLACKLAKE position changes into mount events.

    ``last_changed_at`` is selected only from validated location transitions:
    operation-log ``loggedAt`` or replacement-record ``createdAt``.  A supplied
    parent ``record_updated_at`` is retained separately and never participates
    in event ordering or fallback.
    """

    log_transitions, log_warnings = _collect_transitions(
        operation_logs,
        source="operation_log",
        timestamp_key="loggedAt",
    )
    replacement_transitions, replacement_warnings = _collect_transitions(
        replacement_records,
        source="replacement_record",
        timestamp_key="createdAt",
    )
    transitions = log_transitions + replacement_transitions
    transitions.sort(
        key=lambda item: (
            item["occurred_at"],
            _SOURCE_PRIORITY[item["source"]],
            item["source_id"],
        )
    )

    events: list[dict[str, Any]] = []
    for transition in transitions:
        events.extend(_expand_transition(transition))

    warnings = log_warnings + replacement_warnings
    normalized_current = normalize_location(current_location)
    if current_location is not None:
        current_kind = classify_location(current_location)
        if current_kind == "unknown":
            warnings.append("current_location_unknown")
    elif transitions:
        normalized_current = transitions[-1]["to_location"]
        current_kind = transitions[-1]["to_kind"]
    else:
        current_kind = "unknown"

    if current_kind == "machine":
        current_state = "mounted"
    elif current_kind == "storage":
        current_state = "stored"
    else:
        current_state = "unknown"

    if transitions and normalized_current is not None:
        latest_to = transitions[-1]["to_location"]
        if latest_to != normalized_current:
            warnings.append("history_current_location_mismatch")

    if not transitions:
        warnings.append("missing_position_history")

    normalized_record_updated_at = _validated_timestamp(record_updated_at)
    if record_updated_at is not None and normalized_record_updated_at is None:
        warnings.append("invalid_record_updated_at")

    last_transition = transitions[-1] if transitions else None
    warnings = _unique(warnings)
    return {
        "events": events,
        "current_state": current_state,
        "current_location": normalized_current,
        "last_changed_at": (
            last_transition["occurred_at"] if last_transition is not None else None
        ),
        "last_changed_source": (
            last_transition["source"] if last_transition is not None else None
        ),
        "record_updated_at": normalized_record_updated_at,
        "quality": _quality_for_result(
            transitions=transitions,
            current_state=current_state,
            warnings=warnings,
        ),
        "warnings": warnings,
    }


__all__ = [
    "MACHINE_LOCATION_CODES",
    "classify_location",
    "normalize_location",
    "normalize_position_history",
]
