"""Observe the installed notebook barcode database without changing it."""

from collections import namedtuple
from datetime import datetime
from hashlib import sha256
import os
from pathlib import Path
import sqlite3
from uuid import UUID

from . import __version__
from .protocol import SHANGHAI, timestamp


POLL_ROWS = 200
SOURCE_FIELDS = "id, time, scanner, barcode, status, product_size, product_group"
SOURCE_STATE = """
CREATE TABLE IF NOT EXISTS legacy_barcode_sources (
    source_path TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    file_id TEXT NOT NULL,
    database_id TEXT,
    missing INTEGER NOT NULL DEFAULT 0
)
"""
CHECKPOINT_STATE = """
CREATE TABLE IF NOT EXISTS legacy_barcode_checkpoints (
    generation TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL,
    first_id INTEGER,
    last_id INTEGER,
    anchor TEXT,
    last_work_at TEXT
)
"""
Source = namedtuple("Source", "generation file_id database_id missing")
Checkpoint = namedtuple("Checkpoint", "cursor first_id last_id anchor last_work_at")
EMPTY = Checkpoint(0, None, None, None, None)

STATUS_CODES = {
    "ok": ("ok", "scan_match"),
    "duplicate": ("ng", "scan_duplicate"),
    "invalid": ("ng", "scan_invalid"),
    "over21": ("ng", "scan_overlength"),
    "wrong_product_group": ("ng", "scan_wrong_product_group"),
    "wrong_scanner_A": ("ng", "scan_wrong_device"),
    "wrong_scanner_B": ("ng", "scan_wrong_device"),
    "scan_error": ("error", "scan_input_error"),
}
STATUS_ALIASES = {
    "정상": "ok",
    "중복": "duplicate",
    "유효하지 않음": "invalid",
    "오류": "scan_error",
    "에러": "scan_error",
    "생산 제품군 불일치": "wrong_product_group",
    "생산 모델군 불일치": "wrong_product_group",
}


def _status_code(raw):
    code = str(raw or "").strip()
    if code.startswith("유효하지"):
        return "invalid"
    if code.startswith(("붙어서", "바코드 길이 초과", "연속으로 입력된 바코드")):
        return "over21"
    if code.startswith(("잘못된 스캐너", "스캐너 불일치", "스캐너 오류")):
        if "A" in code:
            return "wrong_scanner_A"
        if "B" in code:
            return "wrong_scanner_B"
    return STATUS_ALIASES.get(code, code)


def _text(value, limit, *, bytes_limit=None):
    if not isinstance(value, str) or "\0" in value or len(value) > limit:
        return None
    if bytes_limit is not None and len(value.encode("utf-8")) > bytes_limit:
        return None
    return value


def _legacy_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    if 2 <= parsed.year <= 9998:
        return timestamp(parsed.replace(tzinfo=SHANGHAI))
    return None


def _source_key(generation, row_id=None):
    key = "legacy_barcode:" + generation
    return key if row_id is None else f"{key}:{row_id}"


def _gap_event(generation, causes, *, row_id=None):
    return {
        "type": "operator.action", "app": "barcode", "mode": "unknown",
        "result": "info", "reason": "legacy_source_gap", "occurred_at": timestamp(),
        "ref": {"source_key": _source_key(generation, row_id)},
        "detail": {"action": "observe_source_gap", "causes": causes},
    }


def _scan_event(generation, row):
    row_id, moment, slot, barcode, status, size, group = row
    occurred_at = _legacy_time(moment)
    if occurred_at is None:
        return _gap_event(generation, ["invalid_source_time"], row_id=row_id)
    code = _status_code(status)
    result, reason = STATUS_CODES.get(code, ("info", "source_status_unknown"))
    detail = {"time_basis": "legacy_local"}
    if slot in ("A", "B"):
        detail["legacy_slot"] = slot
    if code in ("wrong_scanner_A", "wrong_scanner_B"):
        detail["expected_device"] = code[-1]
    for key, value in (("product_size", size), ("product_group", group)):
        if _text(value, 64):
            detail[key] = value
    status_raw = _text(status, 128)
    sent_barcode = _text(barcode, 256, bytes_limit=256)
    if status is not None and status_raw is None:
        detail["status_raw_unavailable"] = True
    if barcode is not None and sent_barcode is None:
        detail["barcode_unavailable"] = True
    return {
        "type": "scan.recorded", "app": "barcode", "mode": "unknown",
        "result": result, "reason": reason, "occurred_at": occurred_at,
        "app_version": None, "agent_version": __version__, "config_version": None,
        "barcode": sent_barcode, "device": None, "status_raw": status_raw,
        "ref": {"source_key": _source_key(generation, row_id)},
        "detail": detail,
    }


def _table_exists(conn, table):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone() is not None


def _database_id(conn):
    if not _table_exists(conn, "app_meta"):
        return None
    row = conn.execute("SELECT value FROM app_meta WHERE key = 'database_id'").fetchone()
    if row and isinstance(row[0], str):
        try:
            return str(UUID(row[0]))
        except ValueError:
            pass
    return None


def _file_id(stat):
    return f"{stat.st_dev}:{stat.st_ino}"


def _fingerprint(row):
    return None if row is None else sha256(repr(row).encode("utf-8")).hexdigest()


def _checkpoint(conn, generation):
    row = conn.execute(
        """SELECT cursor, first_id, last_id, anchor, last_work_at
           FROM legacy_barcode_checkpoints WHERE generation = ?""",
        (generation,),
    ).fetchone()
    return Checkpoint(*row) if row else None


def _discontinuities(previous, current, checkpoint, observed):
    causes = []
    if previous:
        if previous.file_id != current.file_id:
            causes.append("file_replaced")
        if previous.database_id != current.database_id:
            causes.append("generation_changed" if current.database_id else "generation_identity_missing")
    if checkpoint.first_id is not None and (
        observed.first_id is None or observed.first_id > checkpoint.first_id
    ):
        causes.append("first_row_missing")
    if checkpoint.last_id is not None and (
        observed.last_id is None or observed.last_id < checkpoint.last_id
    ):
        causes.append("last_id_regressed")
    if checkpoint.cursor and checkpoint.anchor != observed.anchor:
        causes.append("cursor_row_missing" if observed.anchor is None else "cursor_row_changed")
    return causes


class LegacyBarcodeCollector:
    """Call poll and close from one worker thread, with a 5–10 second poll period."""

    def __init__(self, ledger, path):
        self.ledger = ledger
        self.path = Path(os.path.abspath(path))
        if self.path.resolve() == ledger.path:
            raise ValueError("The legacy source must differ from the field ledger")
        self._source_path = sha256(os.fsencode(os.path.normcase(self.path))).hexdigest()
        # Keeping SQLite's Win32 handle between polls prevents the old program's
        # Path.unlink() reset. Its read snapshots must release the handle promptly.
        self._keep_open = os.name != "nt"
        self._connection = None
        self._connected_file = None
        self._version = None
        self._status = {"coverage": "unknown", "state": "running", "last_work_at": None}
        with self.ledger.transaction() as conn:
            conn.execute(SOURCE_STATE)
            conn.execute(CHECKPOINT_STATE)

    def status(self):
        return dict(self._status)

    def close(self):
        if self._connection is not None:
            self._connection.close()
        self._connection = None
        self._connected_file = None
        self._version = None

    def _source(self, conn):
        row = conn.execute(
            "SELECT generation, file_id, database_id, missing FROM legacy_barcode_sources WHERE source_path = ?",
            (self._source_path,),
        ).fetchone()
        return Source(*row) if row else None

    def _mark_missing(self):
        self.close()
        with self.ledger.read() as conn:
            previous = self._source(conn)
            checkpoint = _checkpoint(conn, previous.generation) if previous else None
        self._status = {
            "coverage": "partial" if previous else "unknown", "state": "fault",
            "last_work_at": checkpoint.last_work_at if checkpoint else None,
        }
        if previous is None or previous.missing:
            return 0
        with self.ledger.transaction() as conn:
            if previous != self._source(conn):
                return 0
            self.ledger.append(conn, _gap_event(previous.generation, ["source_missing"]))
            conn.execute(
                "UPDATE legacy_barcode_sources SET missing = 1 WHERE source_path = ?",
                (self._source_path,),
            )
        return 1

    def _unreadable(self):
        self.close()
        self._status = {**self._status, "state": "fault"}
        return 0

    def _open(self, file_id):
        if self._connected_file != file_id:
            self.close()
            self._connection = sqlite3.connect(
                self.path.as_uri() + "?mode=ro", uri=True, timeout=0.05, isolation_level=None,
            )
            self._connected_file = file_id
            self._connection.execute("PRAGMA query_only=ON")
        return self._connection

    def _snapshot(self, source, local, previous, file_id):
        database_id = _database_id(source)
        generation = database_id or (previous.generation if previous else self._source_path)
        current = Source(generation, file_id, database_id, 0)
        saved = _checkpoint(local, generation)
        inherited = None
        if saved is None and previous and previous.generation == self._source_path:
            # Identification added to an older database does not prove that its
            # row IDs restarted. Carry over the previous observation boundary.
            inherited = _checkpoint(local, previous.generation)
        checkpoint = saved or inherited or EMPTY
        first, last = source.execute(
            "SELECT (SELECT MIN(id) FROM barcodes), (SELECT MAX(id) FROM barcodes)"
        ).fetchone()
        before = source.execute(
            f"SELECT {SOURCE_FIELDS} FROM barcodes WHERE id = ?", (checkpoint.cursor,),
        ).fetchone() if checkpoint.cursor else None
        observed = Checkpoint(checkpoint.cursor, first, last, _fingerprint(before), checkpoint.last_work_at)
        rows = source.execute(
            f"SELECT {SOURCE_FIELDS} FROM barcodes WHERE id > ? ORDER BY id LIMIT ?",
            (checkpoint.cursor, POLL_ROWS + 1),
        ).fetchall()
        return current, saved, inherited, observed, rows

    def poll(self):
        """Append a bounded snapshot and advance its checkpoint in one local commit."""
        try:
            file_id = _file_id(self.path.stat())
        except FileNotFoundError:
            return self._mark_missing()
        except OSError:
            return self._unreadable()

        try:
            source = self._open(file_id)
            version = source.execute("PRAGMA data_version").fetchone()[0]
            if version == self._version:
                return 0
            with self.ledger.read() as local:
                previous = self._source(local)
                source.execute("BEGIN")
                try:
                    snapshot = self._snapshot(source, local, previous, file_id)
                finally:
                    source.rollback()
            if _file_id(self.path.stat()) != file_id:
                self.close()
                return 0
        except FileNotFoundError:
            return self._mark_missing()
        except (OSError, sqlite3.Error):
            return self._unreadable()
        finally:
            if not self._keep_open:
                self.close()

        current, saved, inherited, observed, rows = snapshot
        checkpoint = saved or inherited or EMPTY
        causes = _discontinuities(previous, current, checkpoint, observed)
        events = [_gap_event(current.generation, causes)] if causes else []
        for row in rows[:POLL_ROWS]:
            event = _scan_event(current.generation, row)
            events.append(event)
            observed = observed._replace(cursor=row[0], anchor=_fingerprint(row))
            if event["type"] == "scan.recorded":
                observed = observed._replace(last_work_at=event["occurred_at"])
        if events or current != previous or observed != saved:
            with self.ledger.transaction() as conn:
                if self._source(conn) != previous or _checkpoint(conn, current.generation) != saved:
                    return 0
                if inherited is not None and _checkpoint(conn, previous.generation) != inherited:
                    return 0
                for event in events:
                    self.ledger.append(conn, event)
                conn.execute(
                    """INSERT OR REPLACE INTO legacy_barcode_checkpoints
                       (generation, cursor, first_id, last_id, anchor, last_work_at) VALUES (?, ?, ?, ?, ?, ?)""",
                    (current.generation, *observed),
                )
                conn.execute(
                    """INSERT OR REPLACE INTO legacy_barcode_sources
                       (source_path, generation, file_id, database_id, missing) VALUES (?, ?, ?, ?, ?)""",
                    (self._source_path, *current),
                )
        if self._keep_open and len(rows) <= POLL_ROWS:
            self._version = version
        self._status = {"coverage": "partial", "state": "running", "last_work_at": observed.last_work_at}
        return len(events)
