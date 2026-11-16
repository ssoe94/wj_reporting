"""Bounded, read-only observation of the notebook weighing application's DBs."""

from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
from uuid import UUID

from .. import __version__
from ..protocol import MAX_SEQUENCE, SHANGHAI, timestamp


PAGE = 100
STATUSES = {
    "ok": ("ok", "reread_match"),
    "duplicate": ("ng", "scan_duplicate"),
    "invalid": ("ng", "scan_invalid"),
    "invalid_label_code": ("ng", "label_invalid_code"),
    "unknown_barcode": ("ng", "label_unknown"),
    "wrong_part": ("ng", "reread_wrong_part"),
    "wrong_scanner_A": ("ng", "scan_wrong_device"),
    "wrong_scanner_B": ("ng", "scan_wrong_device"),
    "unprinted": ("ng", "label_not_submitted"),
    "uncertain": ("error", "print_uncertain"),
    "review_required": ("info", "label_review_required"),
    "ledger_error": ("error", "local_record_error"),
    "manual_entry": ("info", "manual_input"),
    "test_scan": ("info", "test_input"),
}
OUTCOMES = {
    "not_sent": ("error", "print_rejected_unsent"),
    "submitted": ("info", "print_submitted"),
    "uncertain": ("error", "print_uncertain"),
}
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS legacy_weigh_sources (
        source TEXT PRIMARY KEY, generation TEXT NOT NULL, file_id TEXT NOT NULL,
        state TEXT NOT NULL, last_work_at TEXT, revision INTEGER NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS legacy_weigh_cursor (
        source TEXT NOT NULL, generation TEXT NOT NULL, stream TEXT NOT NULL,
        cursor INTEGER NOT NULL, fingerprint TEXT, first_id INTEGER, last_id INTEGER,
        PRIMARY KEY(source,generation,stream)
    )""",
    """CREATE TABLE IF NOT EXISTS legacy_weigh_pending (
        source TEXT NOT NULL, generation TEXT NOT NULL, stream TEXT NOT NULL,
        row_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY(source,generation,stream,row_id)
    )""",
    """CREATE TABLE IF NOT EXISTS legacy_weigh_seen (
        source TEXT NOT NULL, source_key TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY(source,source_key,status)
    )""",
)


def _text(value, limit=128):
    if isinstance(value, str) and value and "\0" not in value and len(value.encode("utf-8")) <= limit:
        return value
    return None


def _small_int(value, minimum=1, maximum=MAX_SEQUENCE):
    return value if type(value) is int and minimum <= value <= maximum else None


def _hash(*values):
    return sha256(repr(values).encode("utf-8")).hexdigest()


def _when(value):
    if not isinstance(value, str) or "T" not in value and " " not in value:
        return None
    try:
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if 2 <= value.year <= 9998:
            return timestamp(value if value.tzinfo else value.replace(tzinfo=SHANGHAI))
    except (ValueError, OverflowError):
        return None
    return None


def _event(kind, reason, occurred_at, *, result="info", status_raw=None, source_key=None,
           mode="unknown", refs=None, detail=None, **fields):
    return {
        "app": "weigh_label", "type": kind, "reason": reason, "occurred_at": occurred_at,
        "mode": mode, "result": result, "status_raw": _text(status_raw), "agent_version": __version__,
        "app_version": None, "config_version": None,
        "ref": dict(refs or {}, **({"source_key": source_key} if source_key is not None else {})),
        "detail": {key: value for key, value in (detail or {}).items() if value is not None},
        **fields,
    }


def _gap(stream, causes, source_key=None):
    return _event("operator.action", "legacy_source_gap", timestamp(), source_key=source_key,
                  detail={"action": "observe_source_gap", "stream": stream, "causes": causes})


def _scan(_conn, row, identity):
    when = _when(row["time"])
    if when is None:
        yield _gap("scan_archive", ["invalid_source_time"], identity)
        return
    raw = row["status"]
    result, reason = STATUSES.get(raw, ("info", "source_status_unknown"))
    source = row["input_source"]
    mode = "manual" if source == "manual" or raw == "manual_entry" else "unknown"
    if source == "demo" or raw == "test_scan":
        mode = "test"
    device = row["input_device"]
    expected = row["expected_scanner"]
    origin = {"station": "local", "external": "external"}.get(row["label_origin"], "unknown")
    job_id = _text(row["job_id"])
    detail = {
        "legacy_slot": row["scanner"] if row["scanner"] in ("A", "B") else None,
        "input_source": source if source in ("scanner", "serial", "keyboard", "manual", "demo") else None,
        "label_origin": origin,
        "label_index": _small_int(row["label_index"], 0),
        "expected_device": expected if expected in ("A", "B", "ANY") else None,
        "expected_part_no": _text(row["expected_part_no"], 64),
        "product_size": _text(row["product_size"], 40),
        "product_group": _text(row["product_group"], 64),
        "print_status": _text(row["print_status"], 32),
        "print_date": _text(row["print_date"], 16),
        "duplicate_of": _small_int(row["duplicate_of"]),
    }
    yield _event("label.reread", reason, when, result=result, status_raw=raw,
                 source_key=identity, mode=mode, refs={"job_id": job_id} if job_id else None,
                 detail=detail, barcode=_text(row["barcode"], 256),
                 part_no=_text(row["part_no"]), device=device if device in ("A", "B", "W", "KEYBOARD") else None)


def _grams(value):
    return value if isinstance(value, str) and len(value) <= 32 and re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", value) else None


def _digest(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) else None


def _reservation(_conn, row, identity):
    when = _when(row["created_at"])
    job_id = _text(row["job_id"])
    if not when or not job_id:
        yield _gap("jobs", ["invalid_source_reservation"], identity)
        return
    refs = {"job_id": job_id}
    group = _text(row["group_id"])
    if group:
        refs["cycle_id"] = group
        if isinstance(row["inspection_json"], str) and len(row["inspection_json"]) <= 64 * 1024:
            try:
                inspection = json.loads(row["inspection_json"])
            except (ValueError, RecursionError):
                inspection = None
            if isinstance(inspection, dict):
                measure = {
                    "value": _grams(inspection.get("net_g")), "expected": _grams(inspection.get("expected_g")),
                    "tolerance": _grams(inspection.get("limit_g")),
                }
                quantity = _small_int(inspection.get("quantity"), 1, 5)
                if all(value is not None for value in measure.values()) and quantity:
                    yield _event("weigh.result", "weight_within_limit", when, result="ok",
                                 status_raw="accepted", source_key="weigh:" + _hash(group),
                                 refs={"cycle_id": group}, part_no=_text(row["part_no"]),
                                 measure=dict(measure, unit="g"),
                                 detail={"quantity": quantity, "rule": _text(inspection.get("rule"), 64),
                                         "time_basis": "legacy_reservation"})
    yield _event("label.reserved", "label_reserved", when, status_raw="prepared", source_key=identity,
                 refs=refs, part_no=_text(row["part_no"]),
                 detail={"quantity": _small_int(row["quantity"], 1, 5), "print_date": _text(row["print_date"], 16),
                         "payload_sha256": _digest(row["payload_sha256"]),
                         "first_serial": _small_int(row["first_serial"]), "last_serial": _small_int(row["last_serial"])})


def _direct_job(conn, row, identity):
    # Direct jobs have status snapshots but no attempt/finish time in this schema.
    yield from _reservation(conn, row, identity)
    if row["queued"] is None and row["status"] in ("submitted", "uncertain"):
        job_id = _text(row["job_id"])
        if job_id:
            result, reason = OUTCOMES[row["status"]]
            attempt_id = "direct:" + _hash(job_id)
            yield _event("label.dispatched", reason, timestamp(), result=result, status_raw=row["status"],
                         source_key=attempt_id, refs={"attempt_id": attempt_id, "job_id": job_id},
                         detail={"time_basis": "legacy_status_observed",
                                 "delivery_status": row["status"], "quantity": _small_int(row["quantity"], 1, 5)})


class _SourceReadFailed(Exception):
    pass


def _source_rows(conn, query, params=()):
    try:
        return conn.execute(query, params).fetchall()
    except sqlite3.Error as exc:
        raise _SourceReadFailed from exc


def _source_row(conn, query, params=()):
    return next(iter(_source_rows(conn, query, params)), None)


def _members(conn, row_id):
    return [value[0] for value in _source_rows(
        conn, "SELECT job_id FROM physical_row_members WHERE row_id=? ORDER BY position LIMIT 3", (row_id,))
        if _text(value[0])]


def _attempt(conn, row, identity):
    if row["outcome"] == "dispatching":
        return
    when = _when(row["finished_at"])
    outcome = row["outcome"]
    if when is None:
        yield _gap("print_attempt", ["invalid_source_time"], identity)
        return
    membership = {"job_id": _text(row["job_id"])} if "job_id" in row.keys() else {}
    refs = {"attempt_id": identity}
    detail = {"delivery_status": _text(outcome, 32), "quantity": _small_int(row["quantity"], 1, 5)}
    if membership.get("job_id"):
        refs.update(membership)
    elif "row_id" in row.keys() and _text(row["row_id"]):
        detail["row_id"] = row["row_id"]
        detail["job_ids"] = _members(conn, row["row_id"]) or None
    if "error_code" in row.keys() and isinstance(row["error_code"], str):
        if re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", row["error_code"]):
            detail["error_code"] = row["error_code"]
    result, reason = OUTCOMES.get(outcome, ("info", "source_status_unknown"))
    yield _event("label.dispatched", reason, when, result=result, status_raw=outcome,
                 source_key=identity, refs=refs, detail=detail)


def _partial_flush(conn, row, identity):
    if not row["flush_note"]:
        return
    when = _when(row["created_at"])
    row_id = _text(row["row_id"])
    if not when or not row_id:
        yield _gap("physical_rows", ["invalid_source_flush"], identity)
        return
    yield _event("queue.partial_flush", "partial_flush_approved", when, source_key=identity,
                 detail={"row_id": row_id, "job_ids": _members(conn, row_id) or None,
                         "quantity": _small_int(row["quantity"], 1, 3), "columns": _small_int(row["columns"], 1, 3),
                         "action": "legacy_partial_flush"})


def _operator(_conn, row, identity):
    when, job_id = _when(row["recorded_at"]), _text(row["job_id"])
    if not when or not job_id:
        yield _gap("operator_action", ["invalid_source_action"], identity)
        return
    reason = row["action"]
    yield _event("operator.action", reason, when, source_key=identity, refs={"job_id": job_id},
                 detail={"action": reason, "confirmed_quantity": _small_int(row["confirmed_quantity"], 0, 5)})


@dataclass(frozen=True)
class _Stream:
    table: str
    key: str
    query: str
    anchor: tuple
    project: object
    pending: object = None

    def fingerprint(self, row):
        return _hash(*(row[name] for name in self.anchor)) if row is not None else None


def _scan_stream(conn, tables):
    columns = {row[1] for row in _source_rows(conn, "PRAGMA table_info(scan_attempts)")}
    details = ("input_device", "label_origin", "job_id", "label_index", "expected_scanner",
               "expected_part_no", "part_no", "print_status", "print_date", "duplicate_of", "source")
    names = [("s." + name if name in columns else "NULL") +
             " AS " + ("input_source" if name == "source" else name) for name in details]
    query = ("SELECT a.id AS source_id,a.time,a.scanner,a.barcode,a.status,a.product_size,a.product_group,"
             + ",".join(names) + " FROM scan_archive a")
    if "scan_attempts" in tables:
        query += " LEFT JOIN scan_attempts s ON s.id=a.id"
    return [_Stream("scan_archive", "a.id", query, ("time", "scanner", "barcode", "status"), _scan)]


def _print_streams(conn, tables):
    # Direct jobs use the append rowid to see reservations too; sorted queue
    # attempts use their AUTOINCREMENT PK and pending attempts use equality.
    queue = "print_queue" in tables
    queue_columns = ("q.sequence AS queued,q.group_id,q.payload_sha256,q.inspection_json" if queue else
                     "NULL AS queued,NULL AS group_id,NULL AS payload_sha256,NULL AS inspection_json")
    jobs = ("SELECT a.rowid AS source_id,a.job_id,a.created_at,a.print_date,a.part_no,a.quantity,a.first_serial,"
            "a.last_serial,a.status," + queue_columns + " FROM jobs a"
            + (" LEFT JOIN print_queue q ON q.job_id=a.job_id" if queue else ""))
    yield _Stream("jobs", "a.rowid", jobs, ("job_id", "created_at"), _direct_job,
                  lambda row: row["queued"] is None and row["status"] == "prepared")
    for table, field, job_table in (("queue_attempts", "job_id", "jobs"),
                                     ("physical_row_attempts", "row_id", "physical_rows")):
        needed = {table, job_table} if field == "job_id" else {table, job_table, "physical_row_members"}
        if not needed <= tables:
            continue
        sql = (f"SELECT a.attempt_id AS source_id,a.{field},a.started_at,a.finished_at,a.outcome,a.error_code,"
               f"j.quantity FROM {table} a LEFT JOIN {job_table} j ON j.{field}=a.{field}")
        if table == "queue_attempts" and "physical_row_members" in tables:
            # The source writes one member attempt per label as well as the
            # physical attempt. The latter is the actual unit of transmission.
            sql = sql.replace("j.quantity FROM", "j.quantity,m.row_id AS packed FROM")
            sql += " LEFT JOIN physical_row_members m ON m.job_id=a.job_id"

        def project(source, row, identity):
            if "packed" not in row.keys() or row["packed"] is None:
                yield from _attempt(source, row, identity)

        yield _Stream(table, "a.attempt_id", sql, (field, "started_at"), project,
                      lambda row: row["outcome"] == "dispatching")
    if {"physical_rows", "physical_row_members"} <= tables:
        yield _Stream("physical_rows", "a.rowid",
                      "SELECT a.rowid AS source_id,a.row_id,a.created_at,a.flush_note,a.quantity,a.columns"
                      " FROM physical_rows a", ("row_id", "created_at"), _partial_flush)
    for table, when, action, quantity in (
        ("queue_cancellations", "cancelled_at", "label_cancelled", "NULL"),
        ("reconciliations", "confirmed_at", "operator_reconciled", "a.confirmed_quantity"),
    ):
        if table in tables:
            sql = (f"SELECT a.rowid AS source_id,a.job_id,a.{when} AS recorded_at,'{action}' AS action,"
                   f"{quantity} AS confirmed_quantity FROM {table} a")
            yield _Stream(table, "a.rowid", sql, ("job_id", "recorded_at"), _operator)


def _tables(conn):
    return {row[0] for row in _source_rows(conn, "SELECT name FROM sqlite_master WHERE type='table'")}


def _database_id(conn, tables):
    if "app_meta" in tables:
        row = _source_row(conn, "SELECT value FROM app_meta WHERE key='database_id'")
        if row and isinstance(row[0], str):
            try:
                return str(UUID(row[0]))
            except ValueError:
                pass
    return None


@dataclass
class _Observation:
    changes: list = field(default_factory=list)
    events: list = field(default_factory=list)

    def change(self, query, params):
        self.changes.append((query, params))

    def event(self, event, *, dedupe):
        self.events.append((event, dedupe))


class _Source:
    def __init__(self, ledger, kind, path):
        self.ledger = ledger
        self.kind = kind
        self.path = Path(os.path.abspath(path))
        if self.path.resolve() == ledger.path:
            raise ValueError("Legacy source cannot be the field ledger")
        self.key = _hash(kind, os.path.normcase(str(self.path)))
        self.connection = None
        self.file_id = None
        self.version = None
        self.pending_offsets = {}
        self.pending_version = None
        self.last_work_at = None
        self.state = "unseen"

    def close(self):
        if self.connection is not None:
            self.connection.close()
        self.connection = self.file_id = self.version = None

    def _current(self, local):
        return local.execute("SELECT * FROM legacy_weigh_sources WHERE source=?", (self.key,)).fetchone()

    def _offline(self, state):
        self.close()
        self.state = state
        with self.ledger.read() as local:
            previous = self._current(local)
        if previous is None:
            return 0
        self.last_work_at = previous["last_work_at"]
        if previous["state"] == state:
            return 0
        with self.ledger.transaction() as local:
            if self._current(local) != previous:
                return 0
            self.ledger.append(local, _gap(self.kind, [state]))
            local.execute("UPDATE legacy_weigh_sources SET state=?,revision=revision+1 WHERE source=?", (state, self.key))
        return 1

    def _observe(self, plan, source, stream, row, *, generation, pending):
        identifier = row["source_id"]
        fp = stream.fingerprint(row)
        anchor = (generation, identifier, fp) if self.kind == "scans" else (stream.table, identifier, fp)
        if stream.table in ("jobs", "physical_rows", "queue_cancellations", "reconciliations"):
            # Semantic identity survives a changed internal SQLite rowid.
            anchor = stream.table, fp
        identity = "legacy_weigh:" + _hash(*anchor)
        for event in stream.project(source, row, identity):
            plan.event(event, dedupe=True)
        if stream.pending:
            args = (self.key, generation, stream.table, identifier)
            if stream.pending(row):
                if not pending:
                    plan.change("INSERT OR IGNORE INTO legacy_weigh_pending VALUES(?,?,?,?,?)", args + (fp,))
            elif pending:
                plan.change("DELETE FROM legacy_weigh_pending WHERE source=? AND generation=? AND stream=? AND row_id=?", args)

    def _stream(self, local, source, plan, stream, generation, rebind, pending_after):
        key = (self.key, generation, stream.table)
        prior = local.execute("""SELECT cursor,fingerprint,first_id,last_id FROM legacy_weigh_cursor
            WHERE source=? AND generation=? AND stream=?""", key).fetchone()
        cursor, before, first, last = prior or (0, None, None, None)
        id_column = stream.key.split(".", 1)[1]
        extrema = _source_row(source, f"SELECT (SELECT MIN({id_column}) FROM {stream.table}),"
                              f"(SELECT MAX({id_column}) FROM {stream.table})")
        anchor = _source_row(source, stream.query + f" WHERE {stream.key}=?", (cursor,)) if cursor else None
        observed = stream.fingerprint(anchor)
        causes = []
        if not rebind and cursor:
            if first is not None and (extrema[0] is None or extrema[0] > first):
                causes.append("first_row_missing")
            if last is not None and (extrema[1] is None or extrema[1] < last):
                causes.append("last_id_regressed")
            if before != observed:
                causes.append("cursor_row_missing" if anchor is None else "cursor_row_changed")
        replay = self.kind == "prints" and bool(rebind or causes)
        if replay:
            # UUID jobs and attempt evidence keys deduplicate an indexed replay
            # after a recovered file or a renumbered implicit rowid.
            cursor, observed, pending_after = 0, None, 0
            plan.change("DELETE FROM legacy_weigh_pending WHERE source=? AND generation=? AND stream=?", key)
        if causes:
            plan.event(_gap(stream.table, causes), dedupe=False)
        pending_page = []
        if stream.pending and not replay:
            pending_page = local.execute("""SELECT row_id,fingerprint FROM legacy_weigh_pending
                WHERE source=? AND generation=? AND stream=? AND row_id>? ORDER BY row_id LIMIT ?""",
                                         key + (pending_after, PAGE + 1)).fetchall()
            for row_id, fingerprint in pending_page[:PAGE]:
                row = _source_row(source, stream.query + f" WHERE {stream.key}=?", (row_id,))
                if stream.fingerprint(row) != fingerprint:
                    plan.event(_gap(stream.table, ["pending_row_missing_or_changed"]), dedupe=False)
                    plan.change("DELETE FROM legacy_weigh_pending WHERE source=? AND generation=? AND stream=? AND row_id=?",
                                key + (row_id,))
                    continue
                self._observe(plan, source, stream, row, generation=generation, pending=True)
        rows = _source_rows(source, stream.query + f" WHERE {stream.key}>? ORDER BY {stream.key} LIMIT ?",
                            (cursor, PAGE + 1))
        for row in rows[:PAGE]:
            self._observe(plan, source, stream, row, generation=generation, pending=False)
            cursor, observed = row["source_id"], stream.fingerprint(row)
        value = (cursor, observed, *extrema)
        if prior is None or tuple(prior) != value:
            plan.change("INSERT OR REPLACE INTO legacy_weigh_cursor VALUES(?,?,?,?,?,?,?)", key + value)
        next_pending = pending_page[PAGE - 1]["row_id"] if len(pending_page) > PAGE else 0
        return len(rows) > PAGE, next_pending

    def _open(self, file_id):
        if self.connection is None or self.file_id != file_id:
            self.close()
            try:
                self.connection = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True,
                                                  timeout=0.05, isolation_level=None)
            except sqlite3.Error as exc:
                raise _SourceReadFailed from exc
            self.file_id = file_id
            self.connection.row_factory = sqlite3.Row
            _source_rows(self.connection, "PRAGMA query_only=ON")
            _source_rows(self.connection, "PRAGMA trusted_schema=OFF")
        return self.connection

    def poll(self):
        try:
            stat = self.path.stat()
            file_id = f"{stat.st_dev}:{stat.st_ino}"
        except FileNotFoundError:
            return self._offline("source_missing")
        except OSError:
            return self._offline("source_unreadable")
        try:
            source = self._open(file_id)
            version = _source_row(source, "PRAGMA data_version")[0]
            if version == self.version:
                return 0
            if not any(self.pending_offsets.values()):
                self.pending_version = version
            _source_rows(source, "BEGIN")
            tables = _tables(source)
            needed = "scan_archive" if self.kind == "scans" else "jobs"
            if needed not in tables:
                return self._offline("source_schema_unsupported")
            streams = list(_scan_stream(source, tables) if self.kind == "scans" else _print_streams(source, tables))
            generation = _database_id(source, tables) or self.key
            previous, plan, backlog, offsets = self._snapshot(source, streams, generation, file_id)
            # Release the source DB read lock before FULL-sync local writes.
            source.rollback()
            if os.name == "nt":
                self.close()
            actual = self.path.stat()
            if f"{actual.st_dev}:{actual.st_ino}" != file_id:
                raise _SourceChanged
            count, latest, committed = self._commit(previous, plan, generation, file_id)
            if not committed:
                return 0
            self.state = "ready"
            self.last_work_at = latest
            self.pending_offsets = offsets
            if not backlog and not any(offsets.values()) and version == self.pending_version:
                self.version = version
            return count
        except _SourceChanged:
            return self._offline("source_replaced_during_read")
        except FileNotFoundError:
            return self._offline("source_missing")
        except (OSError, _SourceReadFailed):
            return self._offline("source_snapshot_failed")
        finally:
            if self.connection is not None and self.connection.in_transaction:
                self.connection.rollback()
            if os.name == "nt":
                # Release Windows' file handle promptly to permit replacement.
                self.close()

    def _snapshot(self, source, streams, generation, file_id):
        offsets, backlog = {}, False
        plan = _Observation()
        with self.ledger.read() as local:
            local.execute("BEGIN")
            previous = self._current(local)
            causes = []
            if previous and previous["file_id"] != file_id:
                causes.append("file_replaced")
            if previous and previous["generation"] != generation:
                causes.append("generation_changed")
            if causes:
                plan.event(_gap(self.kind, causes), dedupe=False)
            for stream in streams:
                more, offset = self._stream(local, source, plan, stream, generation, bool(causes),
                                            self.pending_offsets.get(stream.table, 0))
                offsets[stream.table] = offset
                backlog = backlog or more
        return previous, plan, backlog, offsets

    def _commit(self, previous, plan, generation, file_id):
        count = 0
        latest = previous["last_work_at"] if previous else None
        if not (plan.changes or plan.events or previous is None or previous["state"] != "ready"):
            return count, latest, True
        with self.ledger.transaction() as local:
            if self._current(local) != previous:
                return 0, latest, False
            for query, params in plan.changes:
                local.execute(query, params)
            for event, dedupe in plan.events:
                if dedupe:
                    source_key = event["ref"]["source_key"]
                    status = event["status_raw"] or event["reason"]
                    if not local.execute("INSERT OR IGNORE INTO legacy_weigh_seen VALUES(?,?,?)",
                                         (self.key, source_key, status)).rowcount:
                        continue
                self.ledger.append(local, event)
                count += 1
                if event["type"] != "operator.action" and event["detail"].get("time_basis") != "legacy_status_observed":
                    latest = max(latest or "", event["occurred_at"])
            revision = previous["revision"] + 1 if previous else 1
            local.execute("INSERT OR REPLACE INTO legacy_weigh_sources VALUES(?,?,?,?,?,?)",
                          (self.key, generation, file_id, "ready", latest, revision))
        return count, latest, True


class _SourceChanged(Exception):
    pass


class WeighLegacyCollector:
    """Call poll and close on one worker; source changes never rewrite an event."""

    def __init__(self, ledger, scans_path, production_path):
        if Path(scans_path).resolve() == Path(production_path).resolve():
            raise ValueError("Legacy scans and production must be separate databases")
        self.sources = (_Source(ledger, "scans", scans_path), _Source(ledger, "prints", production_path))
        with ledger.transaction() as local:
            for ddl in SCHEMA:
                local.execute(ddl)

    def close(self):
        for source in self.sources:
            source.close()

    def poll(self):
        return sum(source.poll() for source in self.sources)

    def status(self):
        times = [source.last_work_at for source in self.sources if source.last_work_at]
        return {
            "state": "running" if all(source.state == "ready" for source in self.sources) else "fault",
            "coverage": "partial" if times or any(source.state == "ready" for source in self.sources) else "unknown",
            "last_work_at": max(times) if times else None,
        }
