"""Durable field event staging and one background loop for uploads and heartbeat."""

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import random
import sqlite3
import threading
import time
from uuid import uuid4

from .protocol import CONTRACT, MAX_BODY, encode, timestamp
from .transport import DeliveryError


MAX_BATCH_EVENTS = 200


@dataclass(frozen=True)
class Batch:
    batch_id: str
    body: bytes
    sha256: str
    first_seq: int
    last_seq: int
    event_count: int

    @classmethod
    def from_row(cls, row):
        return cls(*(row[key] for key in (
            "batch_id", "body", "sha256", "first_seq", "last_seq", "event_count",
        )))


_PENDING = """
    SELECT batch_id, body, sha256, first_seq, last_seq, event_count
    FROM outbox WHERE acknowledged_at IS NULL ORDER BY first_seq LIMIT 1
"""


def _make_batch(ledger, connection, after_seq):
    batch_id = str(uuid4())
    envelope = {
        "contract": CONTRACT,
        "station_id": ledger.station_id,
        "database_id": ledger.database_id,
        "batch_id": batch_id,
    }
    prefix = encode(envelope)[:-1] + b',"events":['
    size = len(prefix) + len(b"]}")
    bodies = []
    first_seq = last_seq = None
    records = connection.execute(
        "SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        (after_seq, MAX_BATCH_EVENTS),
    )
    for row in records:
        try:
            event = json.loads(row["payload"])
            if not isinstance(event, dict) or "seq" in event:
                raise ValueError()
            body = encode({"seq": row["seq"], **event})
        except (ValueError, TypeError, RecursionError):
            raise DeliveryError("local_event_corrupt") from None
        next_size = size + len(body) + bool(bodies)
        if next_size > MAX_BODY:
            if not bodies:
                raise DeliveryError("local_event_too_large")
            break
        size = next_size
        if first_seq is None:
            first_seq = row["seq"]
        last_seq = row["seq"]
        bodies.append(body)
    if not bodies:
        return None
    body = prefix + b",".join(bodies) + b"]}"
    return Batch(batch_id, body, hashlib.sha256(body).hexdigest(), first_seq, last_seq, len(bodies))


def stage_batch(ledger):
    """Prepare immutable source rows outside the write lock, then stage atomically."""
    with ledger.read() as connection:
        state = connection.execute("SELECT staged_seq, blocked_reason FROM upload_state WHERE id = 1").fetchone()
        if state["blocked_reason"]:
            return None
        pending = connection.execute(_PENDING).fetchone()
        if pending is not None:
            return Batch.from_row(pending)
        after_seq = state["staged_seq"]
        batch = _make_batch(ledger, connection, after_seq)
    if batch is None:
        return None

    with ledger.transaction() as connection:
        state = connection.execute("SELECT staged_seq, blocked_reason FROM upload_state WHERE id = 1").fetchone()
        if state["blocked_reason"]:
            return None
        pending = connection.execute(_PENDING).fetchone()
        if pending is not None:
            return Batch.from_row(pending)
        if state["staged_seq"] != after_seq:
            return None  # An already completed concurrent batch will be seen on the next wake.
        connection.execute(
            """INSERT INTO outbox (batch_id, body, sha256, first_seq, last_seq, event_count)
            VALUES (?, ?, ?, ?, ?, ?)""",
            (batch.batch_id, batch.body, batch.sha256, batch.first_seq, batch.last_seq, batch.event_count),
        )
        connection.execute("UPDATE upload_state SET staged_seq = ? WHERE id = 1", (batch.last_seq,))
    return batch


def validate_ack(ack, ledger, batch):
    if not isinstance(ack, dict):
        raise DeliveryError("ack_mismatch")
    identity = {
        "contract": CONTRACT, "station_id": ledger.station_id, "database_id": ledger.database_id,
        "batch_id": batch.batch_id,
    }
    if any(type(ack.get(key)) is not str or ack[key] != value for key, value in identity.items()):
        raise DeliveryError("ack_mismatch")
    accepted, duplicates, last_seq = (ack.get(key) for key in ("accepted", "duplicates", "max_seq"))
    if (any(type(value) is not int for value in (accepted, duplicates, last_seq))
            or accepted < 0 or duplicates < 0 or accepted + duplicates != batch.event_count
            or last_seq != batch.last_seq):
        raise DeliveryError("ack_mismatch")


def acknowledge(ledger, batch, ack, received_at):
    validate_ack(ack, ledger, batch)
    moment = timestamp(received_at)
    with ledger.transaction() as connection:
        saved = connection.execute(
            "SELECT sha256, acknowledged_at FROM outbox WHERE batch_id = ?", (batch.batch_id,),
        ).fetchone()
        if saved is None or saved["sha256"] != batch.sha256:
            raise DeliveryError("local_outbox_corrupt")
        if saved["acknowledged_at"] is not None:
            return
        old = connection.execute("SELECT acked_seq FROM upload_state WHERE id = 1").fetchone()["acked_seq"]
        if old >= batch.first_seq:
            raise DeliveryError("local_outbox_corrupt")
        connection.execute(
            "UPDATE outbox SET acknowledged_at = ? WHERE batch_id = ?",
            (moment, batch.batch_id),
        )
        connection.execute(
            "UPDATE upload_state SET acked_seq = ?, last_ack_at = ? WHERE id = 1",
            (batch.last_seq, moment),
        )


def _outbox_state(ledger, previous):
    with ledger.read() as connection:
        state = dict(connection.execute(
            """SELECT acked_seq, last_ack_at, blocked_reason,
                      (SELECT coalesce(max(seq), 0) FROM events) AS tail
               FROM upload_state WHERE id = 1""",
        ).fetchone())
        cursor = state["acked_seq"]
        pending, oldest = 0, None
        if previous is not None and previous["acked_seq"] == cursor:
            cursor, pending, oldest = previous["tail"], previous["pending"], previous["oldest"]
        if state["tail"] > cursor:
            added, first_time = connection.execute(
                "SELECT count(*), min(occurred_at) FROM events WHERE seq > ? AND seq <= ?",
                (cursor, state["tail"]),
            ).fetchone()
            pending += added
            if first_time is not None:
                oldest = first_time if oldest is None else min(oldest, first_time)
        return dict(state, pending=pending, oldest=oldest)


def _heartbeat_offset(ack, request):
    if not isinstance(ack, dict):
        raise DeliveryError("heartbeat_ack_mismatch")
    keys = ("contract", "station_id", "database_id", "heartbeat_id")
    if (any(type(ack.get(key)) is not str or ack[key] != request[key] for key in keys)
            or type(ack.get("current")) is not bool):
        raise DeliveryError("heartbeat_ack_mismatch")
    raw = ack.get("received_at")
    if not isinstance(raw, str) or len(raw) > 40:
        raise DeliveryError("heartbeat_ack_mismatch")
    try:
        received = datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
        if received.utcoffset() is None:
            raise ValueError()
        client = datetime.fromisoformat(request["client_at"])
        return round((client - received).total_seconds())
    except (ValueError, OverflowError):
        raise DeliveryError("heartbeat_ack_mismatch") from None


class _Retry:
    def __init__(self):
        self.failures = 0
        self.until = 0.0
        self.reason = None
        self.blocked = False

    def fail(self, error, now, jitter):
        self.reason = error.code
        if not error.retryable:
            self.blocked = True
            return
        self.failures += 1
        base = min(300, 2 ** min(9, self.failures))
        delay = min(300, base + jitter() * base * 0.2)
        self.until = now + max(delay, error.retry_after)

    def clear(self):
        self.failures = 0
        self.until = 0.0
        self.reason = None
        self.blocked = False


class Uploader:
    """One owner calls step/run. Device threads only notify it after commit."""

    def __init__(self, ledger, transport, snapshot, *, interval=60, debounce=2, idle_interval=1,
                 monotonic=time.monotonic, now=None, jitter=random.random):
        if interval <= 0 or debounce <= 0 or idle_interval <= 0:
            raise ValueError("Uploader intervals must be positive.")
        self.ledger = ledger
        self.transport = transport
        self._snapshot = snapshot
        self._interval = interval
        self._debounce = debounce
        self._idle = idle_interval
        self._monotonic = monotonic
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._jitter = jitter
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self._status = {
            "pending_count": None, "oldest_occurred_at": None, "last_ack_at": None,
            "state": "blocked" if transport is None else "ready",
            "last_error_code": "connection_not_configured" if transport is None else None,
            "coverage": "unknown",
        }
        self._clock_offset = None
        self._heartbeat_failure = None
        self._send_retry = _Retry()
        self._heartbeat_retry = _Retry()
        self._session_id = str(uuid4())
        self._started_at = timestamp(self._now())
        self._heartbeat_seq = 0
        self._heartbeat_due = self._monotonic()
        self._dirty_at = None
        self._previous_outbox = None

    def wake(self, state_changed=False):
        if state_changed:
            with self._lock:
                self._dirty_at = self._monotonic() + self._debounce
        self._wake.set()

    def status(self):
        with self._lock:
            return self._status.copy()

    @property
    def clock_offset_seconds(self):
        with self._lock:
            return self._clock_offset

    @property
    def heartbeat_error(self):
        with self._lock:
            return self._heartbeat_failure

    def _publish(self, row, snapshot):
        blocked = row["blocked_reason"] if row is not None else None
        if blocked or self._send_retry.blocked or self.transport is None:
            state = "blocked"
        elif snapshot.get("storage_pressure", False):
            state = "storage_pressure"
        elif self._send_retry.reason:
            state = "backoff"
        else:
            state = "ready"
        status = {
            "pending_count": row["pending"] if row is not None else None,
            "oldest_occurred_at": row["oldest"] if row is not None else None,
            "last_ack_at": row["last_ack_at"] if row is not None else None,
            "state": state,
            "last_error_code": (
                blocked or self._send_retry.reason
                or ("connection_not_configured" if self.transport is None else None)
            ),
            "coverage": snapshot.get("coverage", "known") if row is not None else "unknown",
        }
        with self._lock:
            previous = self._status
            self._status = status
            if any(previous[key] != status[key] for key in ("state", "last_error_code", "coverage")):
                self._dirty_at = self._monotonic() + self._debounce

    def _refresh(self, snapshot):
        try:
            row = _outbox_state(self.ledger, self._previous_outbox)
        except sqlite3.Error:
            self._send_retry.fail(DeliveryError("local_storage_error", retryable=True), self._monotonic(), self._jitter)
            row = None
        self._previous_outbox = row
        self._publish(row, snapshot)
        return row

    def _send_heartbeat(self, snapshot):
        with self._lock:
            sent_dirty = self._dirty_at
        self._heartbeat_seq += 1
        payload = {
            "contract": CONTRACT,
            "station_id": self.ledger.station_id,
            "database_id": self.ledger.database_id,
            "heartbeat_id": str(uuid4()),
            "session_id": self._session_id,
            "heartbeat_seq": self._heartbeat_seq,
            "started_at": self._started_at,
            "client_at": timestamp(self._now()),
            "agent_version": snapshot["agent_version"],
            "apps": snapshot["apps"],
            "devices": snapshot["devices"],
            "resources": snapshot["resources"],
            "outbox": self.status(),
        }
        try:
            ack = self.transport.post("heartbeat", encode(payload))
            offset = _heartbeat_offset(ack, payload)
        except DeliveryError as error:
            self._heartbeat_retry.fail(error, self._monotonic(), self._jitter)
            with self._lock:
                self._heartbeat_failure = error.code
        else:
            self._heartbeat_due = self._monotonic() + self._interval
            self._heartbeat_retry.clear()
            with self._lock:
                self._clock_offset = offset
                self._heartbeat_failure = None
                if self._dirty_at == sent_dirty:
                    self._dirty_at = None

    def _send_one(self):
        try:
            batch = stage_batch(self.ledger)
            if batch is None:
                return False
            if hashlib.sha256(batch.body).hexdigest() != batch.sha256:
                raise DeliveryError("local_outbox_corrupt")
            ack = self.transport.post("ingest", batch.body)
            acknowledge(self.ledger, batch, ack, self._now())
        except DeliveryError as error:
            self._send_retry.fail(error, self._monotonic(), self._jitter)
            if self._send_retry.blocked:
                try:
                    with self.ledger.transaction() as connection:
                        connection.execute("UPDATE upload_state SET blocked_reason = ? WHERE id = 1", (error.code,))
                except sqlite3.Error:
                    # Keep the block in memory even when disk writes are unavailable.
                    pass
            return False
        except sqlite3.Error:
            self._send_retry.fail(DeliveryError("local_storage_error", retryable=True), self._monotonic(), self._jitter)
            return False
        self._send_retry.clear()
        return True

    def step(self):
        """Run one pass. Return a bounded Event wait, in monotonic seconds."""
        snapshot = self._snapshot()
        row = self._refresh(snapshot)
        if self.transport is None:
            return self._idle

        now = self._monotonic()
        with self._lock:
            dirty_at = self._dirty_at
        heartbeat_due = min(self._heartbeat_due, dirty_at) if dirty_at is not None else self._heartbeat_due
        heartbeat_due = max(heartbeat_due, self._heartbeat_retry.until)
        if not self._heartbeat_retry.blocked and now >= heartbeat_due:
            self._send_heartbeat(snapshot)

        can_send = (row is not None and row["pending"] and not row["blocked_reason"]
                    and not self._send_retry.blocked and self._monotonic() >= self._send_retry.until)
        if can_send:
            sent = self._send_one()
            row = self._refresh(snapshot)
            if sent and row is not None and row["pending"]:
                return 0.0

        wait = self._idle
        now = self._monotonic()
        if not self._heartbeat_retry.blocked:
            with self._lock:
                dirty_at = self._dirty_at
            due = min(self._heartbeat_due, dirty_at) if dirty_at is not None else self._heartbeat_due
            wait = min(wait, max(0.0, max(due, self._heartbeat_retry.until) - now))
        if (row is not None and row["pending"] and not row["blocked_reason"]
                and self._send_retry.reason and not self._send_retry.blocked):
            wait = min(wait, max(0.0, self._send_retry.until - now))
        return wait

    def run(self, stop):
        while not stop.is_set():
            self._wake.clear()
            delay = self.step()
            if not stop.is_set():
                self._wake.wait(delay)
