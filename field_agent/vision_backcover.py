"""Observe finalized V49 history and, optionally, the cached local display status."""

from collections import namedtuple
from datetime import timedelta
from hashlib import sha256
import http.client
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
from time import monotonic

from . import __version__
from .protocol import MAX_SEQUENCE, event_time, now, timestamp
from .weigh.legacy import open_readonly


APP = "vision_backcover"
POLL_ROWS = 32
MAX_PAYLOAD = 64 * 1024
MAX_EVIDENCE_FILE = 8 * 1024 * 1024
EVIDENCE_BYTES_PER_POLL = 16 * 1024 * 1024
STATUS_INTERVAL = 60
STATUS_PORT = 8724
MAX_STATUS = 512 * 1024
STATUS_AGE = 1.5
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,96}", re.ASCII)
VERSION = re.compile(r"[A-Za-z0-9_.-]{1,64}", re.ASCII)
DIGEST = re.compile(r"[0-9a-fA-F]{64}", re.ASCII)
MEDIA_ID = re.compile(r"[0-9a-fA-F]{32}", re.ASCII)
DEVICE_NAMES = ("camera", "signal_light")
CYCLE_RESULTS = {
    "OK": ("ok", "occlusion_confirmed"),
    "NG": ("ng", "operation_not_confirmed"),
    "INCOMPLETE": ("error", "vision_incomplete"),
}
OTHER_RESULTS = {
    "RECOVERY": ("operator.action", "vision_recovery"),
    "RESET": ("operator.action", "operator_reset"),
    "CAMERA_SETTING": ("config.applied", "config_applied"),
    "BENCH_EXPOSURE_SETUP": ("config.applied", "bench_setup"),
}
CAMERA_CAUSES = {
    "camera_adjustment_during_product", "camera_control_response_mismatch", "camera_controls_timeout",
    "camera_disconnected", "camera_driver_stop_timeout", "camera_restore_failed",
    "camera_transport_error_after_exposure_recovery", "stale_frame", "auto_exposure_failed",
}
OTHER_CAUSES = {
    "application_restarted", "inspection_stopped", "invalid_frame_timestamp", "frame_time_discontinuity",
    "stale_product_zone_observation", "exit_confirmation_timeout", "product_returned_before_empty_confirmation",
    "product_returned_before_zone_departure_confirmation", "lighting_lost_product_boundary",
    "brightness_changed_during_product", "video_ended_mid_product", "signal_light_disconnected",
    "safety_journal_unreadable", "history_write_failed", "device_fault",
}
Checkpoint = namedtuple("Checkpoint", "file_id cursor anchor first high_water outage last_work_at mode")
EMPTY = Checkpoint(None, 0, None, None, None, None, None, "unknown")

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS backcover_checkpoints (
        source_path TEXT PRIMARY KEY, file_id TEXT, cursor INTEGER NOT NULL, anchor TEXT, first INTEGER,
        high_water INTEGER, outage TEXT, last_work_at TEXT, mode TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS backcover_seen (
        source_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(source_id, fingerprint)
    )""",
    """CREATE TABLE IF NOT EXISTS backcover_status_fault (
        source_path TEXT PRIMARY KEY, fault TEXT
    )""",
)

# Row IDs and indexed bounds can be reread cheaply on source generation changes.
_COLUMNS = f"""rowid, CASE WHEN length(CAST(id AS BLOB))<=128 THEN id END,
    CASE WHEN length(CAST(payload AS BLOB))<={MAX_PAYLOAD} THEN payload END"""


def _hash(value):
    return sha256(value).hexdigest()


def _file_id(info):
    return "{}:{}".format(info.st_dev, info.st_ino)


def _file_signature(info):
    return (_file_id(info), info.st_size, info.st_mtime_ns)


def _text(value, pattern):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def _time(value):
    try:
        return timestamp(event_time(value))
    except (ValueError, OverflowError):
        return None


def _unique_keys(pairs):
    data = {}
    for key, value in pairs:
        if key in data:
            raise ValueError("Duplicate V49 evidence key")
        data[key] = value
    return data


def _json(raw):
    try:
        return json.loads(raw, object_pairs_hook=_unique_keys)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return None


def _recorded_id(value):
    # The source emits a UUID in both the SQLite key and document; keep these
    # identifiers distinct from its cycle, which can span two stored rows.
    return _text(value, IDENTIFIER)


def _source_kind(data):
    source = data.get("source")
    if isinstance(source, dict) and source.get("kind") in ("camera", "video"):
        return source["kind"]
    return "unknown"


def _cause(value):
    if not isinstance(value, str):
        return "unknown"
    candidate = value.split(" / ", 1)[0]
    return candidate if candidate in CAMERA_CAUSES or candidate in OTHER_CAUSES else "unknown"


def _cycle_id(data):
    session = _text(data.get("session"), IDENTIFIER)
    cycle = data.get("cycle_id")
    composed = ("{}:{}".format(session, cycle)
                if session and type(cycle) is int and 0 <= cycle <= MAX_SEQUENCE else None)
    stored = data.get("product_id")
    if stored is None:
        return composed
    # A supplied product_id remains useful on older recoveries with no
    # separate session/cycle fields, but never join inconsistent evidence.
    if not isinstance(stored, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,96}:[0-9]{1,16}", stored):
        return None
    prefix, number = stored.split(":")
    if prefix == "None" or int(number) > MAX_SEQUENCE or str(int(number)) != number:
        return None
    if data.get("session") is not None and session != prefix:
        return None
    if cycle is not None and (type(cycle) is not int or cycle != int(number)):
        return None
    return stored


def _gap(source_key, cause):
    return {
        "app": APP, "type": "operator.action", "mode": "unknown", "result": "info",
        "reason": "vision_source_gap", "occurred_at": timestamp(),
        "ref": {"source_key": source_key},
        "detail": {"action": "observe_source_gap", "cause": cause},
    }


class _EvidenceBudget(Exception):
    pass


class _SourceChanged(Exception):
    pass


def _evidence_files(directory, data, remaining):
    artifacts = []
    partial = False
    size = 0
    for key, kind, suffix in (("photo", "result_photo", ".jpg"), ("diagnostic", "diagnostic_archive", ".zip")):
        item = data.get(key)
        if item is None:
            continue
        opaque = _text(item[:-len(suffix)], MEDIA_ID) if isinstance(item, str) and item.endswith(suffix) else None
        if not opaque:
            partial = True
            continue
        path = directory / item
        record = {"kind": kind, "id": "v49:" + opaque}
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_EVIDENCE_FILE:
                info = None
        except OSError:
            info = None
        if info:
            size += info.st_size
        artifacts.append((path, record, info))
    if size > remaining:
        raise _EvidenceBudget()
    for path, record, before in artifacts:
        if before is None:
            partial = True
            continue
        try:
            digest = sha256()
            with path.open("rb") as image:
                if _file_signature(os.fstat(image.fileno())) != _file_signature(before):
                    raise OSError("V49 evidence was replaced")
                left = before.st_size
                while left:
                    block = image.read(min(left, 64 * 1024))
                    if not block:
                        raise OSError("V49 evidence was truncated")
                    digest.update(block)
                    left -= len(block)
                if _file_signature(path.lstat()) != _file_signature(before):
                    raise OSError("V49 evidence changed")
            record["sha256"] = digest.hexdigest()
        except OSError:
            partial = True
    return [record for _path, record, _info in artifacts], partial, size


def _read_status():
    """Read the installed V49 cache only. http.client never follows redirects."""
    connection = http.client.HTTPConnection("127.0.0.1", STATUS_PORT, timeout=0.5)
    try:
        connection.request("GET", "/api/status", headers={"Accept": "application/json", "Connection": "close"})
        with connection.getresponse() as response:
            if response.status != 200 or response.headers.get_content_type() != "application/json":
                return None
            raw = response.read(MAX_STATUS + 1)
        return _json(raw) if len(raw) <= MAX_STATUS else None
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def _seconds(value):
    return value if type(value) in (int, float) and 0 <= value <= STATUS_AGE and math.isfinite(value) else None


class BackcoverCollector:
    """Collect the V49 DB from one worker thread; call poll about every 5–10 sec."""

    def __init__(self, ledger, history_path, *, camera_mode="unknown", status_enabled=False):
        if camera_mode not in ("production", "test", "unknown"):
            raise ValueError("Invalid V49 camera mode")
        if type(status_enabled) is not bool:
            raise ValueError("Invalid V49 status option")
        self.ledger = ledger
        self.path = Path(history_path).resolve()
        if self.path == ledger.path or (self.path.is_file() and self.path.samefile(ledger.path)):
            raise ValueError("V49 history must differ from the field ledger")
        self.camera_mode = camera_mode
        self.status_enabled = status_enabled
        self._key = _hash(os.fsencode(os.path.normcase(str(self.path))))
        self._source_key = "v49-db:" + self._key
        self._connection = None
        self._source_file = None
        self._data_version = None
        self._next_status = 0
        self._devices = []
        with self.ledger.transaction() as local:
            for statement in _SCHEMA:
                local.execute(statement)
            self._checkpoint = self._read_checkpoint(local)

    def _read_checkpoint(self, local):
        row = local.execute(
            "SELECT file_id,cursor,anchor,first,high_water,outage,last_work_at,mode "
            "FROM backcover_checkpoints WHERE source_path=?", (self._key,),
        ).fetchone()
        return Checkpoint(*row) if row is not None else EMPTY

    def _save_checkpoint(self, local, value):
        local.execute(
            "INSERT OR REPLACE INTO backcover_checkpoints VALUES (?,?,?,?,?,?,?,?,?)",
            (self._key, *value),
        )

    def status(self):
        state = self._checkpoint
        return {
            "coverage": "partial" if state.file_id is not None else "unknown",
            "state": "fault" if state.outage else "running" if state.file_id is not None else "unknown",
            "last_work_at": state.last_work_at, "mode": state.mode,
            "devices": [dict(device) for device in self._devices],
        }

    def close(self):
        if self._connection is not None:
            self._connection.close()
        self._connection = self._source_file = self._data_version = None

    def _outage(self, cause):
        self.close()
        before = self._checkpoint
        if before.outage == cause:
            return 0
        after = before._replace(outage=cause)
        with self.ledger.transaction() as local:
            seq = self.ledger.append(local, _gap(self._source_key, cause))
            self._save_checkpoint(local, after)
        self._checkpoint = after
        return int(bool(seq))

    def _sidecars(self):
        return tuple(self.path.with_name(self.path.name + suffix).exists() for suffix in ("-wal", "-shm"))

    def _source_connection(self, identity):
        if self._connection is not None and self._source_file == identity:
            return self._connection, False
        self.close()
        with self.path.open("rb") as stream:
            header = stream.read(20)
        if header[:16] != b"SQLite format 3\0":
            raise sqlite3.DatabaseError("Invalid V49 SQLite header")
        sidecars = self._sidecars()
        wal = header[18:20] == b"\x02\x02"
        if wal and sidecars == (False, False):
            # SQLite's ordinary readonly WAL connections otherwise create
            # empty -wal/-shm beside a checkpointed, closed producer DB.
            connection = sqlite3.connect(self.path.as_uri() + "?mode=ro&immutable=1",
                                         uri=True, timeout=0.05, isolation_level=None)
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            return connection, True
        if wal and sidecars != (True, True):
            raise _SourceChanged()
        self._connection = open_readonly(self.path)
        self._source_file = identity
        return self._connection, False

    def _bounds(self, source, before, identity):
        first, high_water = source.execute(
            "SELECT (SELECT MIN(rowid) FROM events), (SELECT MAX(rowid) FROM events)"
        ).fetchone()
        if first is not None and first < 1:
            raise sqlite3.DatabaseError("Unexpected V49 rowid")
        causes = []
        if before.file_id is not None:
            if identity != before.file_id:
                causes.append("file_replaced")
            else:
                if before.first is not None and (first is None or first > before.first):
                    causes.append("first_row_missing")
                if before.high_water is not None and (high_water is None or high_water < before.high_water):
                    causes.append("last_row_regressed")
                if before.cursor:
                    row = source.execute("SELECT " + _COLUMNS + " FROM events WHERE rowid=?", (before.cursor,)).fetchone()
                    if row is None or self._anchor(row) != before.anchor:
                        causes.append("cursor_row_changed")
        cursor = 0 if causes else before.cursor
        state = before._replace(file_id=identity, cursor=cursor, anchor=None if causes else before.anchor,
                                first=first, high_water=high_water, outage=None)
        page = source.execute("SELECT " + _COLUMNS + " FROM events WHERE rowid>? ORDER BY rowid LIMIT ?",
                              (cursor, POLL_ROWS + 1)).fetchall()
        return state, causes, page

    @staticmethod
    def _anchor(row):
        return _hash(repr(tuple(row)).encode("utf-8", errors="surrogatepass"))

    def _polled_rows(self):
        try:
            original = self.path.stat()
            if not stat.S_ISREG(original.st_mode):
                return self._outage("source_unreadable")
        except FileNotFoundError:
            return self._outage("source_missing")
        except OSError:
            return self._outage("source_unreadable")

        before = self._checkpoint
        identity = _file_id(original)
        source = None
        offline = False
        try:
            source, offline = self._source_connection(identity)
            version = source.execute("PRAGMA data_version").fetchone()[0]
            if not offline and version == self._data_version:
                return 0
            source.execute("BEGIN")
            try:
                state, causes, page = self._bounds(source, before, identity)
            finally:
                source.rollback()
            latest = self.path.stat()
            if (_file_id(latest) != identity or (offline and (
                    _file_signature(latest) != _file_signature(original) or any(self._sidecars())))):
                raise _SourceChanged()
        except FileNotFoundError:
            return self._outage("source_missing")
        except _SourceChanged:
            self.close()
            return 0
        except (OSError, sqlite3.Error, UnicodeError):
            return self._outage("source_unreadable")
        finally:
            if source is not None and offline:
                source.close()
            if os.name == "nt":
                # Release Win32's file handle promptly during source maintenance.
                self.close()

        count, drained = self._record_page(before, state, causes, page)
        if not offline and self._connection is not None and drained:
            self._data_version = version
        return count

    def _record_page(self, before, state, causes, page):
        events = [_gap(self._source_key, cause) for cause in causes]
        seen = []
        pending = page[:POLL_ROWS]
        budget = EVIDENCE_BYTES_PER_POLL
        with self.ledger.read() as local:
            for row in pending:
                rowid, raw_id, raw = row
                source_id = _recorded_id(raw_id)
                if source_id is None:
                    source_id = self._key + ":" + str(rowid)
                fingerprint = _hash(repr(raw).encode("utf-8", errors="surrogatepass"))
                exact, observed = local.execute(
                    "SELECT EXISTS(SELECT 1 FROM backcover_seen WHERE source_id=? AND fingerprint=?), "
                    "EXISTS(SELECT 1 FROM backcover_seen WHERE source_id=?)",
                    (source_id, fingerprint, source_id),
                ).fetchone()
                if not exact:
                    if observed:
                        event = _gap("v49:" + source_id, "source_record_changed")
                    else:
                        try:
                            event, used = self._row_event(_recorded_id(raw_id), raw, budget)
                        except _EvidenceBudget:
                            break
                        budget -= used
                        if event is None:
                            event = _gap("v49:" + source_id, "source_record_invalid")
                    seen.append((source_id, fingerprint))
                    events.append(event)
                    if event["type"] == "vision.cycle" and (
                            state.last_work_at is None or state.last_work_at <= event["occurred_at"]):
                        state = state._replace(last_work_at=event["occurred_at"], mode=event["mode"])
                state = state._replace(cursor=rowid, anchor=self._anchor(row))

        if events or state != before:
            with self.ledger.transaction() as local:
                if before != self._read_checkpoint(local):
                    raise RuntimeError("V49 history requires one collector per source")
                for event in events:
                    self.ledger.append(local, event)
                local.executemany("INSERT INTO backcover_seen VALUES (?,?)", seen)
                self._save_checkpoint(local, state)
            self._checkpoint = state
        last = not page or state.cursor == page[-1][0]
        return len(events), last

    def _row_event(self, source_id, raw, budget):
        if source_id is None:
            return None, 0
        data = _json(raw) if isinstance(raw, str) else None
        if not isinstance(data, dict) or data.get("id") != source_id:
            return None, 0
        when = _time(data.get("recorded_at"))
        if when is None:
            return None, 0
        outcome = data.get("result")
        if not isinstance(outcome, str):
            return None, 0
        kind = _source_kind(data)
        mode = self._mode(kind)
        version = _text(data.get("algorithm_revision"), VERSION)
        profile = _text(data.get("profile_sha256"), DIGEST)
        ref = {"source_key": "v49:" + source_id}
        detail = {"source_kind": kind}
        if outcome in CYCLE_RESULTS:
            cycle = _cycle_id(data)
            if cycle is None:
                return None, 0
            ref["cycle_id"] = cycle
            event_type = "vision.cycle"
            result, reason = CYCLE_RESULTS[outcome]
            if outcome == "INCOMPLETE":
                detail["cause"] = _cause(data.get("reason"))
            if type(data.get("work_recorded")) is bool:
                detail["work_recorded"] = data["work_recorded"]
        elif outcome in OTHER_RESULTS:
            result = "info"
            event_type, reason = OTHER_RESULTS[outcome]
        else:
            return None, 0
        evidence, partial, used = _evidence_files(self.path.parent, data, budget)
        if partial:
            detail["evidence_partial"] = True
        event = {
            "app": APP, "type": event_type, "mode": mode, "result": result, "reason": reason,
            "status_raw": outcome, "occurred_at": when, "agent_version": __version__, "app_version": version,
            "config_version": profile.lower() if profile else None, "ref": ref, "detail": detail,
        }
        if evidence:
            event["evidence"] = evidence
        return event, used

    def _mode(self, kind):
        if kind == "video":
            return "preview"
        return self.camera_mode if kind == "camera" else "unknown"

    def _polled_status(self):
        point = monotonic()
        if not self.status_enabled or point < self._next_status:
            return 0
        self._next_status = point + STATUS_INTERVAL
        data = _read_status()
        device_states = {name: {"app": APP, "device": name, "state": "unknown", "last_input_at": None}
                         for name in DEVICE_NAMES}
        if not isinstance(data, dict) or _seconds(data.get("display_cache_age_s")) is None:
            self._devices = list(device_states.values())
            return 0

        kind = _source_kind(data)
        observed_at = now()
        is_fault = data.get("state") == "FAULT"
        stale = data.get("display_stale") is not False
        cause = _cause(data.get("fault"))
        camera = device_states["camera"]
        age = _seconds(data.get("frame_age"))
        if kind == "camera":
            if is_fault and cause in CAMERA_CAUSES:
                camera["state"] = "fault"
            elif not stale and age is not None:
                camera.update(state="connected", last_input_at=timestamp(observed_at - timedelta(seconds=age)))
        signal = data.get("signal_light")
        if isinstance(signal, dict) and signal.get("enabled") is True:
            light = device_states["signal_light"]
            if is_fault and cause == "signal_light_disconnected" or signal.get("error"):
                light["state"] = "fault"
            elif signal.get("connected") is True:
                light["state"] = "connected"
            elif signal.get("connected") is False:
                light["state"] = "disconnected"
            light["last_input_at"] = _time(signal.get("last_ack_at"))
        self._devices = list(device_states.values())
        if stale and not is_fault:
            return 0
        session = _text(data.get("session"), IDENTIFIER)
        cycle = data.get("cycle_id")
        if type(cycle) is not int or not 0 <= cycle <= MAX_SEQUENCE:
            cycle = None
        key = _hash(repr((session, kind, cause, cycle)).encode()) if is_fault else None
        with self.ledger.read() as local:
            previous = local.execute("SELECT fault FROM backcover_status_fault WHERE source_path=?", (self._key,)).fetchone()
        if key == (previous[0] if previous else None):
            return 0
        with self.ledger.transaction() as local:
            local.execute("INSERT OR REPLACE INTO backcover_status_fault VALUES (?,?)", (self._key, key))
            if key is None:
                return 0
            is_camera = cause in CAMERA_CAUSES
            is_signal = cause == "signal_light_disconnected"
            reason = "vision_device_fault" if is_camera or is_signal or cause == "device_fault" else "vision_runtime_fault"
            event = {
                "app": APP, "type": "device.state", "mode": self._mode(kind), "result": "error", "reason": reason,
                "status_raw": "FAULT", "occurred_at": timestamp(observed_at), "ref": {"source_key": self._source_key},
                "detail": {"cause": cause, "source_kind": kind},
            }
            if is_camera or is_signal:
                event["device"] = "camera" if is_camera else "signal_light"
            self.ledger.append(local, event)
        return 1

    def poll(self):
        return self._polled_rows() + self._polled_status()
