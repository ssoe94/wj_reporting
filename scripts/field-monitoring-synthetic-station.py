#!/usr/bin/env python3
"""Send synthetic field v1 fixtures to an isolated loopback server."""

import argparse
from datetime import date, datetime, time, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4


CONTRACT = "wj.field.v1"
SHANGHAI = timezone(timedelta(hours=8))
APPS = ("barcode", "weigh_label", "vision_backcover", "vision_capture", "vision_uv")
MAX_BYTES = 512 * 1024


class SyntheticStationError(Exception):
    """Failure whose text is safe to display without request data."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise SyntheticStationError(f"Redirect blocked (HTTP {code}).")


def loopback_url(raw):
    if not isinstance(raw, str) or not raw or any(ord(c) <= 32 or ord(c) == 127 for c in raw):
        raise SyntheticStationError("Use a loopback HTTP or HTTPS server URL.")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
        host = parsed.hostname
        if host == "localhost":
            # Use the literal address to avoid DNS and hosts-file resolution.
            host = "127.0.0.1"
        address = ipaddress.ip_address(host)
    except ValueError:
        raise SyntheticStationError("The server URL must point to loopback.") from None
    if (
        not address.is_loopback
        or parsed.scheme not in ("http", "https")
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") not in ("", "/api")
        or port == 0
    ):
        raise SyntheticStationError("Use an uncredentialed loopback server URL.")
    literal = f"[{address}]" if address.version == 6 else str(address)
    authority = f"{literal}:{port}" if port is not None else literal
    return f"{parsed.scheme}://{authority}"


def read_connection(filename):
    try:
        if filename == "-":
            raw = sys.stdin.buffer.read(8193)
        else:
            with Path(filename).open("rb") as source:
                raw = source.read(8193)
        if len(raw) > 8192:
            raise ValueError
        config = json.loads(raw)
        if not isinstance(config, dict):
            raise ValueError
        station = config.get("station_id")
        token = config.get("token")
        if not isinstance(station, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", station):
            raise ValueError
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{1,256}", token):
            raise ValueError
        return loopback_url(config.get("server")), station, token
    except (OSError, ValueError):
        raise SyntheticStationError(
            "Connection JSON must contain a loopback server, station_id, and device token."
        ) from None


def encode(payload):
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_BYTES:
        raise SyntheticStationError("Synthetic request exceeds the payload limit.")
    return data


def post(opener, server, endpoint, token, body, *, discard_ack=False):
    request = Request(
        f"{server}/api/field/v1/{endpoint}/",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"WJField {token}",
        },
        method="POST",
    )
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                raise SyntheticStationError(f"{endpoint} returned unexpected HTTP {response.status}.")
            if discard_ack:
                return None
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES or response.headers.get_content_type() != "application/json":
                raise SyntheticStationError(f"{endpoint} returned an invalid acknowledgement.")
            ack = json.loads(raw)
            if not isinstance(ack, dict):
                raise SyntheticStationError(f"{endpoint} returned an invalid acknowledgement.")
            return ack
    except HTTPError as error:
        raise SyntheticStationError(f"{endpoint} returned HTTP {error.code}.") from None
    except (OSError, URLError, ValueError):
        raise SyntheticStationError(f"Could not read the loopback {endpoint} acknowledgement.") from None


def require_fields(endpoint, ack, expected):
    if any(type(ack.get(key)) is not type(value) or ack[key] != value for key, value in expected.items()):
        raise SyntheticStationError(f"{endpoint} acknowledgement failed the field contract.")


def make_events(start, suffix):
    events = []

    def add(app, event_type, result, reason, status, *, seconds=0, mode="production", **fields):
        events.append({
            "seq": len(events) + 1,
            "app": app,
            "app_version": "1.0.0",
            "agent_version": "1.0.0",
            "config_version": "synthetic-r1",
            "occurred_at": (start + timedelta(seconds=seconds)).isoformat(),
            "mode": mode,
            "type": event_type,
            "result": result,
            "reason": reason,
            "status_raw": status,
            **fields,
        })

    add("barcode", "scan.recorded", "ok", "scan_match", "ok", seconds=-1,
        barcode="SYNTH-PRIOR-DAY", device="A")
    add("barcode", "scan.recorded", "ok", "scan_match", "ok",
        barcode="SYNTH-CURRENT-DAY", device="A")
    add("barcode", "scan.recorded", "ng", "scan_duplicate", "duplicate", seconds=1,
        barcode="SYNTH-CURRENT-DAY", device="A")
    add("weigh_label", "weigh.result", "ok", "weight_within_limit", "accepted", seconds=2,
        part_no="SYNTH-PART", device="scale", ref={"cycle_id": "SYNTH-WEIGH"},
        measure={"value": "101.2", "unit": "g", "expected": "100.0", "tolerance": "5.0"},
        detail={"quantity": 1, "rule": "unit_5pct_sqrt_quantity_v1"})
    jobs = (("CLOSED", 3), ("OPEN", 5))
    for name, offset in jobs:
        job = f"SYNTH-JOB-{name}-{suffix}"
        label = f"SYNTH-LABEL-{name}-{suffix}"
        add("weigh_label", "label.reserved", "info", "label_reserved", "prepared", seconds=offset,
            barcode=label, ref={"job_id": job}, detail={"quantity": 1, "payload_sha256": "0" * 64})
        add("weigh_label", "label.dispatched", "info", "print_submitted", "submitted", seconds=offset + 1,
            barcode=label, device="printer", ref={"job_id": job, "attempt_id": f"{job}-ATTEMPT"},
            detail={"quantity": 1, "delivery_status": "submitted"})
    add("weigh_label", "label.reread", "ok", "reread_match", "ok", seconds=7,
        barcode=f"SYNTH-LABEL-CLOSED-{suffix}", device="B", ref={"job_id": f"SYNTH-JOB-CLOSED-{suffix}"},
        detail={"label_index": 1, "label_origin": "local"})
    add("vision_backcover", "vision.cycle", "ng", "operation_not_confirmed", "NG", seconds=8,
        device="camera", ref={"cycle_id": "SYNTH-VISION-001"})
    add("vision_capture", "capture.pair", "error", "capture_pair_incomplete", "incomplete", seconds=9,
        device="camera", ref={"pair_id": "SYNTH-PAIR-001"})
    add("vision_uv", "vision.batch", "ng", "uv_batch_fail", "false", seconds=10,
        device="camera", ref={"batch_id": "SYNTH-UV-001"}, detail={"slot_count": 2},
        products=[
            {"position": 1, "barcode": "SYNTH-UV-1", "result": "ok", "reasons": [],
             "point_1_percent": "75.0", "point_2_percent": "81.2"},
            {"position": 2, "barcode": "SYNTH-UV-2", "result": "ng", "reasons": ["point_1"],
             "point_1_percent": "12.1", "point_2_percent": "81.4"},
        ])
    add("barcode", "scan.recorded", "ok", "scan_match", "ok", seconds=11, mode="test",
        barcode="SYNTH-TEST-ONLY", device="A")
    return events


def make_heartbeat(identity, start, now):
    latest = min(now, start + timedelta(seconds=11)).isoformat(timespec="milliseconds")
    return {
        **identity,
        "heartbeat_id": str(uuid4()),
        "session_id": str(uuid4()),
        "heartbeat_seq": 1,
        "started_at": start.isoformat(),
        "client_at": now.isoformat(timespec="milliseconds"),
        "agent_version": "1.0.0",
        "apps": [
            {"app": app, "version": "1.0.0", "mode": "production", "state": "running", "last_work_at": latest}
            for app in APPS
        ],
        "devices": [
            {"app": "weigh_label", "device": "scale", "state": "connected", "last_input_at": latest},
            {"app": "vision_capture", "device": "camera", "state": "disconnected", "last_input_at": latest},
        ],
        "outbox": {
            "pending_count": 0, "oldest_occurred_at": None, "last_ack_at": now.isoformat(timespec="milliseconds"),
            "state": "ready", "last_error_code": None, "coverage": "known",
        },
        "resources": {
            "disk_free_bytes": 4000000000, "ledger_bytes": 102400, "cpu_pct": "0.8", "rss_bytes": 33554432,
        },
    }


def exercise(server, station, token, business_date):
    now = datetime.now(SHANGHAI)
    current_day = (now - timedelta(hours=8)).date()
    day = business_date or current_day
    if day > current_day or day == date.min:
        raise SyntheticStationError("Choose a non-future business date with a preceding day.")
    start = datetime.combine(day, time(8), tzinfo=SHANGHAI)
    identity = {"contract": CONTRACT, "station_id": station, "database_id": str(uuid4())}
    events = make_events(start, identity["database_id"].split("-")[0])
    opener = build_opener(ProxyHandler({}), NoRedirect())

    batch_id = str(uuid4())
    payload = {**identity, "batch_id": batch_id, "events": events}
    expected = {**identity, "batch_id": batch_id, "max_seq": events[-1]["seq"],
                "accepted": len(events), "duplicates": 0}
    body = encode(payload)
    post(opener, server, "ingest", token, body, discard_ack=True)
    replay_ack = post(opener, server, "ingest", token, body)
    require_fields("ingest replay", replay_ack, expected)

    another = str(uuid4())
    duplicate_ack = post(opener, server, "ingest", token, encode({**payload, "batch_id": another}))
    require_fields("ingest duplicate", duplicate_ack,
                   {**expected, "batch_id": another, "accepted": 0, "duplicates": len(events)})

    heartbeat = make_heartbeat(identity, start, datetime.now(SHANGHAI))
    heartbeat_ack = post(opener, server, "heartbeat", token, encode(heartbeat))
    require_fields("heartbeat", heartbeat_ack, {**identity, "heartbeat_id": heartbeat["heartbeat_id"], "current": True})
    try:
        received = datetime.fromisoformat(heartbeat_ack["received_at"].replace("Z", "+00:00"))
        if received.utcoffset() is None:
            raise ValueError
    except (AttributeError, KeyError, ValueError):
        raise SyntheticStationError("Heartbeat acknowledgement is missing server time.") from None

    return {
        "station_id": station,
        "database_id": identity["database_id"],
        "business_date": day.isoformat(),
        "previous_business_date": (day - timedelta(days=1)).isoformat(),
        "accepted": replay_ack["accepted"],
        "replay_ack_valid": True,
        "different_batch_duplicates": duplicate_ack["duplicates"],
        "heartbeat_received_at": heartbeat_ack["received_at"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", default="-", help="Connection JSON file, or - for standard input.")
    parser.add_argument("--server", help="Expected loopback URL. Must match the connection JSON when supplied.")
    parser.add_argument("--business-date", type=date.fromisoformat, help="Asia/Shanghai business date (YYYY-MM-DD).")
    options = parser.parse_args()
    try:
        expected_server = loopback_url(options.server) if options.server else None
        server, station, token = read_connection(options.connection)
        if expected_server and expected_server != server:
            raise SyntheticStationError("--server differs from the connection JSON.")
        print(json.dumps(exercise(server, station, token, options.business_date), indent=2))
        return 0
    except (OverflowError, SyntheticStationError) as error:
        message = str(error) if isinstance(error, SyntheticStationError) else "Business date out of range."
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
