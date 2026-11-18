"""Local checks for data written by apps before it can enter the upload queue."""

import json
import re
from datetime import datetime, timedelta, timezone

CONTRACT = "wj.field.v1"
SHANGHAI = timezone(timedelta(hours=8))
MAX_SEQUENCE = 9007199254740991
MAX_BODY = 512 * 1024
STATION_ID = re.compile(r"[A-Za-z0-9_-]{1,64}", re.ASCII)
APPS = {
    "barcode": {"scan.recorded"},
    "weigh_label": {"weigh.result", "label.reserved", "label.dispatched", "label.reread", "queue.partial_flush"},
    "vision_backcover": {"vision.cycle"},
    "vision_capture": {"capture.pair", "capture.single"},
    "vision_uv": {"vision.batch"},
}
COMMON_TYPES = {
    "app.started", "app.stopped", "device.state", "mode.changed", "config.applied",
    "operator.action", "backup.completed", "backup.failed",
}
MODES = {"production", "test", "demo", "preview", "manual", "unknown"}
RESULTS = {"ok", "ng", "error", "info"}
CODE = re.compile(r"[a-z][a-z0-9_.-]{0,63}", re.ASCII)
ISO_TIME = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)",
    re.ASCII,
)


def now():
    return datetime.now(SHANGHAI)


def timestamp(value=None):
    return (now() if value is None else value.astimezone(SHANGHAI)).isoformat(timespec="milliseconds")


def business_day(value=None):
    local = now() if value is None else value.astimezone(SHANGHAI)
    return (local - timedelta(hours=8)).date().isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _check_tree(value, depth=0, limit=12):
    if depth > limit:
        raise ValueError("Event JSON is nested too deeply")
    if isinstance(value, str):
        if "\0" in value:
            raise ValueError("Event strings cannot contain NUL")
        value.encode("utf-8")
    elif value is None or type(value) is bool:
        return
    elif type(value) is int and -MAX_SEQUENCE <= value <= MAX_SEQUENCE:
        return
    elif isinstance(value, list):
        for item in value:
            _check_tree(item, depth + 1, limit)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Event object keys must be strings")
            _check_tree(key, depth + 1, limit)
            _check_tree(item, depth + 1, limit)
    else:
        raise ValueError("Use JSON values and decimal strings for measurements")

def event_time(moment):
    if not isinstance(moment, str) or not ISO_TIME.fullmatch(moment):
        raise ValueError("Event time must include its offset")
    # Python 3.8 accepts fractional timestamps padded to 3 or 6 digits.
    normalized = re.sub(r"\.(\d{1,2})(?=Z|[+-])", lambda m: "." + m[1].ljust(3, "0"), moment)
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        if not 2 <= parsed.year <= 9998:
            raise ValueError()
        return parsed
    except ValueError as exc:
        raise ValueError("Invalid event time") from exc



def event_bytes(event):
    if not isinstance(event, dict) or "seq" in event:
        raise ValueError("The ledger assigns the event sequence")
    _check_tree(event)
    app, kind = event.get("app"), event.get("type")
    if not isinstance(app, str) or app not in APPS or not isinstance(kind, str) or kind not in APPS[app] | COMMON_TYPES:
        raise ValueError("Unknown event app or type")
    if (not isinstance(event.get("mode"), str) or event["mode"] not in MODES
            or not isinstance(event.get("result"), str) or event["result"] not in RESULTS):
        raise ValueError("Unknown event mode or result")
    reason = event.get("reason")
    if not isinstance(reason, str) or not CODE.fullmatch(reason):
        raise ValueError("Invalid event reason")
    event_time(event.get("occurred_at"))
    for name, limit in (("app_version", 64), ("agent_version", 64), ("config_version", 64),
                        ("status_raw", 128), ("part_no", 128), ("serial", 128), ("device", 64)):
        field = event.get(name)
        if field is not None and (not isinstance(field, str) or len(field) > limit):
            raise ValueError("Invalid event field: " + name)
    barcode = event.get("barcode")
    if barcode is not None and (not isinstance(barcode, str) or len(barcode.encode("utf-8")) > 256):
        raise ValueError("Event barcode exceeds the protocol limit")
    detail = event.get("detail", {})
    if not isinstance(detail, dict) or len(encode(detail)) > 2048:
        raise ValueError("Event detail exceeds the protocol limit")
    _check_tree(detail, limit=4)
    ref = event.get("ref", {})
    if not isinstance(ref, dict) or len(ref) > 8:
        raise ValueError("Invalid event references")
    for key, value in ref.items():
        if not CODE.fullmatch(key) or not isinstance(value, str) or not 1 <= len(value) <= 128:
            raise ValueError("Invalid event reference")
    if kind in APPS[app] and event["mode"] != "unknown" and not ref.get("source_key"):
        for name in ("app_version", "agent_version", "config_version"):
            if not event.get(name):
                raise ValueError("Missing producer version: " + name)
    body = encode(event)
    # Allow the maximum station/sequences plus a JSON envelope around a single event.
    if len(body) > MAX_BODY - 2048:
        raise ValueError("Event cannot fit in a protocol batch")
    return body
