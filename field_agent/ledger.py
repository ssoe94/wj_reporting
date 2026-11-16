"""One SQLite commit for a field application's business rows and event."""

from contextlib import contextmanager
from pathlib import Path
import sqlite3
from uuid import uuid4

from .protocol import MAX_SEQUENCE, STATION_ID, event_bytes, event_time, timestamp


SCHEMA_VERSION = "1"
SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(seq BETWEEN 1 AND 9007199254740991),
    payload TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    app TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    result TEXT NOT NULL
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE outbox (
    batch_id TEXT PRIMARY KEY,
    body BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 200),
    acknowledged_at TEXT,
    CHECK(first_seq <= last_seq)
);
CREATE INDEX outbox_pending ON outbox(first_seq) WHERE acknowledged_at IS NULL;
CREATE TABLE upload_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    staged_seq INTEGER NOT NULL DEFAULT 0,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    last_ack_at TEXT,
    blocked_reason TEXT,
    CHECK(0 <= acked_seq AND acked_seq <= staged_seq)
);
INSERT INTO upload_state(id) VALUES(1);
CREATE TABLE backup_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    business_date TEXT NOT NULL,
    state TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    reason TEXT
);
"""


def _keep_transaction(action, _name, _arg, _database, _source):
    if action in (sqlite3.SQLITE_TRANSACTION, sqlite3.SQLITE_SAVEPOINT):
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


class Ledger:
    def __init__(self, path, station_id):
        if not isinstance(station_id, str) or not STATION_ID.fullmatch(station_id):
            raise ValueError("Invalid station ID")
        self.path = Path(path).resolve()
        self.station_id = station_id
        self.path.parent.mkdir(parents=True, exist_ok=True)
        anchor = self._connect()
        self._anchor = anchor
        try:
            # A live connection avoids closing/checkpointing the WAL per event.
            table = anchor.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
            if table is None:
                tables = anchor.execute("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").fetchone()
                if tables:
                    raise ValueError("Existing database is not a field ledger")
                anchor.execute("PRAGMA journal_mode=WAL")
                metadata = (
                    ("database_id", str(uuid4())), ("station_id", station_id),
                    ("schema_version", SCHEMA_VERSION), ("created_at", timestamp()),
                )
                anchor.executescript("BEGIN IMMEDIATE;\n" + SCHEMA)
                anchor.executemany("INSERT INTO meta(key,value) VALUES(?,?)", metadata)
                anchor.commit()
            metadata = dict(anchor.execute("SELECT key,value FROM meta"))
            if metadata.get("station_id") != station_id:
                raise ValueError("Ledger belongs to a different station")
            if metadata.get("schema_version") != SCHEMA_VERSION or not metadata.get("database_id"):
                raise ValueError("Unsupported field ledger schema")
            anchor.execute("PRAGMA journal_mode=WAL")
            self.database_id = metadata["database_id"]
        except Exception:
            anchor.close()
            raise

    def _connect(self, readonly=False):
        uri = self.path.as_uri() + "?mode=ro" if readonly else str(self.path)
        conn = sqlite3.connect(uri, uri=readonly, timeout=2, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        # REPLACE can otherwise perform a hidden delete without firing triggers.
        conn.execute("PRAGMA recursive_triggers=ON")
        if not readonly:
            conn.execute("PRAGMA synchronous=FULL")
        return conn

    @contextmanager
    def read(self):
        conn = self._connect(readonly=True)
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self):
        """Pass this connection to append() and use execute() for the app rows."""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.set_authorizer(_keep_transaction)
            try:
                yield conn
            finally:
                conn.set_authorizer(lambda *_args: sqlite3.SQLITE_OK)
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def append(self, conn, event):
        if not conn.in_transaction:
            raise RuntimeError("Append events inside ledger.transaction()")
        payload = event_bytes(event).decode("utf-8")
        seq = conn.execute(
            "INSERT INTO events(payload,occurred_at,app,kind,mode,result) VALUES(?,?,?,?,?,?)",
            (payload, timestamp(event_time(event["occurred_at"])), event["app"], event["type"], event["mode"], event["result"]),
        ).lastrowid
        if seq > MAX_SEQUENCE:
            raise OverflowError("Field event sequence exhausted")
        return seq

    def close(self):
        self._anchor.close()
