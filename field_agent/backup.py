"""Daily verified SQLite snapshots, off the app's commit thread."""

from contextlib import closing
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
from tempfile import NamedTemporaryFile
from time import monotonic

from . import __version__
from .ledger import SCHEMA_VERSION
from .protocol import CONTRACT, business_day, now, timestamp


SNAPSHOT = re.compile(r"\d{4}-\d{2}-\d{2}\.sqlite3")
DEFAULT_MIN_FREE = 256 * 1024 * 1024


def _open_snapshot(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Expected a local snapshot file")
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _checked_metadata(conn, cancelled=lambda: False):
    if conn.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
        raise ValueError("Use a standalone backup snapshot, not the live ledger")
    conn.set_progress_handler(lambda: int(cancelled()), 1000)
    if [row[0] for row in conn.execute("PRAGMA quick_check")] != ["ok"]:
        raise ValueError("SQLite quick_check failed")
    meta = dict(conn.execute("SELECT key,value FROM meta"))
    if meta.get("schema_version") != SCHEMA_VERSION or not {"database_id", "station_id"} <= meta.keys():
        raise ValueError("Incompatible backup metadata")
    return meta


def _verify_pending(conn, meta, state, max_seq):
    staged, acked = state["staged_seq"], state["acked_seq"]
    if not 0 <= acked <= staged <= max_seq:
        raise ValueError("Inconsistent upload cursor")
    previous = acked
    pending = 0
    for row in conn.execute("SELECT * FROM outbox WHERE acknowledged_at IS NULL ORDER BY first_seq"):
        body = row["body"]
        if hashlib.sha256(body).hexdigest() != row["sha256"]:
            raise ValueError("Pending batch checksum mismatch")
        payload = json.loads(body)
        expected = {
            "batch_id": row["batch_id"], "database_id": meta["database_id"],
            "station_id": meta["station_id"], "contract": CONTRACT,
        }
        if any(payload.get(field) != value for field, value in expected.items()):
            raise ValueError("Pending batch identity mismatch")
        events = payload["events"]
        records = conn.execute(
            "SELECT seq,payload FROM events WHERE seq>? AND seq<=? ORDER BY seq",
            (previous, row["last_seq"]),
        ).fetchall()
        local = [{**json.loads(record["payload"]), "seq": record["seq"]} for record in records]
        if (not local or len(local) != row["event_count"]
                or local[0]["seq"] != row["first_seq"] or local[-1]["seq"] != row["last_seq"]
                or local != events):
            raise ValueError("Pending batch sequence or event mismatch")
        previous = row["last_seq"]
        pending += len(local)
    if previous != staged:
        raise ValueError("Missing staged batch")
    return pending


def verify_snapshot(path):
    """Check same-generation recovery metadata. Does not infer remote freshness."""
    with closing(_open_snapshot(path)) as conn:
        meta = _checked_metadata(conn)
        max_seq = conn.execute("SELECT COALESCE(MAX(seq),0) FROM events").fetchone()[0]
        sqlite_seq = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='events'").fetchone()
        if (0 if sqlite_seq is None else sqlite_seq[0]) != max_seq:
            raise ValueError("Inconsistent SQLite sequence")
        state = conn.execute("SELECT * FROM upload_state WHERE id=1").fetchone()
        pending = _verify_pending(conn, meta, state, max_seq)
        return {
            "station_id": meta["station_id"], "database_id": meta["database_id"], "max_seq": max_seq,
            "staged_seq": state["staged_seq"], "acked_seq": state["acked_seq"], "staged_pending": pending,
        }


def restore_snapshot(source, destination):
    """Restore a verified image to a new path. Caller confirms generation evidence."""
    source_info = verify_snapshot(source)
    destination = Path(destination)
    if destination.exists() or destination.is_symlink() or any(
        Path(str(destination) + suffix).exists() for suffix in ("-wal", "-shm")
    ):
        raise FileExistsError("Restore must use a fresh ledger path")
    with NamedTemporaryFile(prefix=".restore-", dir=destination.parent, delete=False) as handle:
        stage = Path(handle.name)
    try:
        shutil.copyfile(source, stage)
        info = verify_snapshot(stage)
        if info != source_info:
            raise ValueError("Backup changed while restoring")
        with stage.open("r+b") as handle:
            os.fsync(handle.fileno())
        # Publish without overwriting a file created between check and publish.
        os.link(stage, destination)
        return info
    finally:
        stage.unlink(missing_ok=True)


class Backup:
    def __init__(self, ledger, directory, *, keep=30, min_free_bytes=DEFAULT_MIN_FREE,
                 idle_seconds=60, disk_usage=shutil.disk_usage, wall_clock=now, transition=None):
        if keep < 1 or min_free_bytes < 0 or idle_seconds < 0:
            raise ValueError("Invalid backup configuration")
        self.ledger = ledger
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.keep = keep
        self.min_free_bytes = min_free_bytes
        self.idle_seconds = idle_seconds
        self.disk_usage = disk_usage
        self.wall_clock = wall_clock
        self.transition = transition
        self.retry_after = 0
        with ledger.read() as conn:
            saved = conn.execute("SELECT business_date,state,finished_at,reason FROM backup_state WHERE id=1").fetchone()
        self._status = dict(saved) if saved is not None else {
            "business_date": None, "state": "waiting", "finished_at": None, "reason": None,
        }

    def status(self):
        return dict(self._status)

    def _prune(self):
        snapshots = []
        for path in self.directory.iterdir():
            if not SNAPSHOT.fullmatch(path.name) or path.is_symlink() or not path.is_file():
                continue
            try:
                date.fromisoformat(path.stem)
            except ValueError:
                continue
            snapshots.append(path)
        # Keep newest business dates only. Touch only backup files created by this tool.
        def same_ledger(path):
            try:
                with closing(_open_snapshot(path)) as conn:
                    meta = dict(conn.execute("SELECT key,value FROM meta"))
                return (meta.get("station_id") == self.ledger.station_id
                        and meta.get("database_id") == self.ledger.database_id)
            except (sqlite3.Error, OSError, ValueError):
                return False

        owned = sorted((path for path in snapshots if same_ledger(path)), reverse=True)
        for path in owned[self.keep:]:
            path.unlink()

    def _validate_image(self, path, cancelled):
        with closing(_open_snapshot(path)) as conn:
            meta = _checked_metadata(conn, cancelled)
        if (meta["station_id"], meta["database_id"]) != (self.ledger.station_id, self.ledger.database_id):
            raise ValueError("Backup identity mismatch")

    def _image(self, final, halt):
        if final.exists():
            # Recover a crash after publish and before the audit event.
            self._validate_image(final, halt.is_set)
            return
        with NamedTemporaryFile(prefix=".backup-", dir=self.directory, delete=False) as handle:
            stage = Path(handle.name)
        try:
            deadline = monotonic() + 300

            def progress(_status, _remaining, _total):
                if halt.is_set() or monotonic() > deadline:
                    raise InterruptedError()

            with self.ledger.read() as source, closing(sqlite3.connect(str(stage))) as dest:
                source.backup(dest, pages=64, progress=progress, sleep=0.025)
                dest.execute("PRAGMA journal_mode=DELETE")
            self._validate_image(stage, halt.is_set)
            if halt.is_set():
                return
            with stage.open("r+b") as handle:
                os.fsync(handle.fileno())
            os.replace(stage, final)
        finally:
            stage.unlink(missing_ok=True)

    def _record(self, day, state, reason, app):
        moment = timestamp(self.wall_clock())
        previous = self._status
        # Record a failed condition once per day and reason. Retry with backoff.
        if (previous["business_date"], previous["state"], previous["reason"]) == (day, state, reason):
            return
        status = {"business_date": day, "state": state, "finished_at": moment, "reason": reason}
        completed = state == "completed"
        detail = {"backup_id": day, "state": state}
        if reason:
            detail["cause"] = reason
        try:
            with self.ledger.transaction() as conn:
                self.ledger.append(conn, {
                    "app": app, "agent_version": __version__, "occurred_at": moment,
                    "mode": "test", "type": "backup.completed" if completed else "backup.failed",
                    "result": "info" if completed else "error",
                    "reason": "backup_verified" if completed else "backup_failed",
                    "detail": detail,
                })
                conn.execute("INSERT OR REPLACE INTO backup_state VALUES(1,?,?,?,?)",
                             (day, state, moment, reason))
        except sqlite3.Error:
            # Without a commit the audit cannot claim that it was recorded.
            status["state"] = "failed"
            status["reason"] = "backup_audit_unavailable"
        self._status = status
        if self.transition:
            self.transition()

    def due(self, idle_for, halt, app="barcode"):
        if halt.is_set() or idle_for < self.idle_seconds or monotonic() < self.retry_after:
            return False
        day = business_day(self.wall_clock())
        if self._status["business_date"] == day and self._status["state"] == "completed":
            return False
        final = self.directory / (day + ".sqlite3")
        state, reason = "completed", None
        try:
            # Reserve room for the snapshot in addition to the configured free margin.
            wal = Path(str(self.ledger.path) + "-wal")
            image_size = self.ledger.path.stat().st_size
            try:
                image_size += wal.stat().st_size
            except FileNotFoundError:
                pass
            required = self.min_free_bytes + (0 if final.is_file() else image_size)
            if self.disk_usage(self.directory).free < required:
                state, reason = "skipped", "disk_low"
            else:
                self._image(final, halt)
                if halt.is_set():
                    return False
                self._prune()
        except (OSError, sqlite3.Error, ValueError):
            if halt.is_set():
                return False
            state, reason = "failed", "backup_io_failed"
        self._record(day, state, reason, app)
        self.retry_after = 0 if self._status["state"] == "completed" else monotonic() + 300
        return True
