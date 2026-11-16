import hashlib
from collections import deque
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from field_agent.ledger import Ledger
from field_agent.protocol import MAX_BODY, encode
from field_agent.transport import DeliveryError, Transport, normalize_server_url
from field_agent.uploader import Uploader, acknowledge, stage_batch


FIXTURES = Path(__file__).resolve().parents[2] / "docs" / "field-monitoring" / "fixtures"
STATION = "SYNTH-STATION-01"
TOKEN = "a" * 32 + "." + "b" * 43
START = datetime(2026, 1, 2, 0, 11, tzinfo=timezone.utc)


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def example(occurred_at=None):
    record = fixture("ingest-valid-weigh.json")["events"][0]
    record.pop("seq")
    if occurred_at is not None:
        record["occurred_at"] = occurred_at
    return record


def snapshot():
    fixture_value = fixture("heartbeat-valid.json")
    return {key: fixture_value[key] for key in ("agent_version", "apps", "devices", "resources")}


def acknowledgement(payload):
    return {
        **{key: payload[key] for key in ("contract", "station_id", "database_id", "batch_id")},
        "accepted": len(payload["events"]),
        "duplicates": 0,
        "max_seq": payload["events"][-1]["seq"],
    }


class Clock:
    def __init__(self):
        self.elapsed = 0.0

    def monotonic(self):
        return self.elapsed

    def now(self):
        return START + timedelta(seconds=self.elapsed)


class FakeTransport:
    def __init__(self, *, skew=0):
        self.posts = []
        self.ingest = deque()
        self.heartbeat = deque()
        self.skew = skew

    def requests_for(self, route):
        return [body for sent, body in self.posts if sent == route]

    def post(self, route, body):
        self.posts.append((route, body))
        payload = json.loads(body)
        queued = self.ingest if route == "ingest" else self.heartbeat
        if queued:
            outcome = queued.popleft()
            if isinstance(outcome, DeliveryError):
                raise outcome
            if outcome is not None:
                return outcome
        if route == "ingest":
            return acknowledgement(payload)
        moment = datetime.fromisoformat(payload["client_at"]) - timedelta(seconds=self.skew)
        return {
            **{key: payload[key] for key in ("contract", "station_id", "database_id", "heartbeat_id")},
            "current": True,
            "received_at": moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        }


class UploaderTests(unittest.TestCase):
    def setUp(self):
        self.dir = TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.ledger = Ledger(Path(self.dir.name) / "ledger.sqlite3", STATION)
        self.addCleanup(self.ledger.close)
        self.transport = FakeTransport()
        self.clock = Clock()

    def uploader(self, *, transport=None):
        return Uploader(
            self.ledger, self.transport if transport is None else transport, snapshot,
            monotonic=self.clock.monotonic, now=self.clock.now, jitter=lambda: 0.0,
        )

    def append(self, event=None):
        with self.ledger.transaction() as db:
            return self.ledger.append(db, event or example())

    def state(self):
        with self.ledger.read() as db:
            return dict(db.execute("SELECT * FROM upload_state").fetchone())

    def test_outbox_and_cursor_rollback_together(self):
        self.append()
        with self.ledger.transaction() as db:
            db.execute(
                """CREATE TRIGGER simulate_stage_failure BEFORE UPDATE OF staged_seq ON upload_state
                BEGIN SELECT raise(abort, 'test write failed'); END"""
            )
        with self.assertRaises(sqlite3.DatabaseError):
            stage_batch(self.ledger)
        self.assertEqual(self.state()["staged_seq"], 0)
        with self.ledger.read() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM outbox").fetchone()[0], 0)
        with self.ledger.transaction() as db:
            db.execute("DROP TRIGGER simulate_stage_failure")
        batch = stage_batch(self.ledger)
        self.assertEqual(self.state()["staged_seq"], 1)
        self.assertEqual(json.loads(batch.body)["events"][0]["seq"], 1)
        self.assertEqual(hashlib.sha256(batch.body).hexdigest(), batch.sha256)

    def test_batches_respect_wire_count_and_byte_limits(self):
        for field, size, expected in (("chars", 65000, 2), ("small", 1, 200)):
            with self.subTest(field=field):
                event = {**example(), field: "測" * size}
                n = 3 if field == "chars" else 202
                with self.ledger.transaction() as db:
                    for _ in range(n):
                        self.ledger.append(db, event)
                batch = stage_batch(self.ledger)
                self.assertLessEqual(len(batch.body), MAX_BODY)
                self.assertEqual(len(json.loads(batch.body)["events"]), expected)
                self.assertEqual(batch.event_count, expected)
                acknowledge(self.ledger, batch, acknowledgement(json.loads(batch.body)), START)
                tail = stage_batch(self.ledger)
                self.assertEqual(tail.event_count, n - expected)
                self.assertEqual(tail.first_seq, batch.last_seq + 1)
                acknowledge(self.ledger, tail, acknowledgement(json.loads(tail.body)), START)

    def test_first_unstageable_event_is_reported_without_skipping_it(self):
        with self.ledger.transaction() as db:
            db.execute(
                "INSERT INTO events(payload,occurred_at,app,kind,mode,result) VALUES (?,?,?,?,?,?)",
                (json.dumps({"too_large": "x" * MAX_BODY}), "2026-01-02T08:10:00+08:00",
                 "barcode", "scan.recorded", "test", "ok"),
            )
        self.append()
        uploader = self.uploader()
        uploader.step()
        self.assertEqual(self.state()["staged_seq"], 0)
        self.assertEqual(self.state()["blocked_reason"], "local_event_too_large")
        self.assertEqual(uploader.status()["pending_count"], 2)
        self.assertEqual(self.transport.requests_for("ingest"), [])

    def test_restart_replays_exact_bytes_and_advances_only_after_ack(self):
        self.append()
        self.transport.ingest.append(DeliveryError("network_error", retryable=True))
        first = self.uploader()
        first.step()
        before = self.transport.requests_for("ingest")[0]
        self.assertEqual(self.state()["acked_seq"], 0)
        self.clock.elapsed = 1.0
        first.step()
        self.assertEqual(len(self.transport.requests_for("ingest")), 1)
        self.append()
        # Re-open SQLite the way a new agent instance does after a crash.
        restarted_ledger = Ledger(self.ledger.path, STATION)
        self.addCleanup(restarted_ledger.close)
        self.ledger = restarted_ledger
        restarted = self.uploader()
        self.assertEqual(restarted.step(), 0.0)
        self.assertEqual(self.transport.requests_for("ingest")[1], before)
        self.assertEqual(self.state()["acked_seq"], 1)
        restarted.step()
        self.assertEqual(self.state()["acked_seq"], 2)
        self.assertEqual(restarted.status()["pending_count"], 0)

    def test_ack_fields_and_types_are_checked_with_the_same_pending_batch(self):
        self.append()
        batch = stage_batch(self.ledger)
        ack = acknowledgement(json.loads(batch.body))
        for key, value in (
            ("contract", "other"), ("station_id", "SYNTH-WRONG"), ("database_id", str(uuid4())),
            ("batch_id", str(uuid4())), ("accepted", True), ("duplicates", -1),
            ("max_seq", 2), ("duplicates", 1), ("max_seq", 1.0),
        ):
            with self.subTest(key=key, value=value), self.assertRaises(DeliveryError):
                acknowledge(self.ledger, batch, {**ack, key: value}, START)
        self.assertEqual(self.state()["acked_seq"], 0)
        acknowledge(self.ledger, batch, {**ack, "accepted": 0, "duplicates": 1}, START)
        self.assertEqual(self.state()["acked_seq"], 1)

    def test_bad_ack_blocks_upload_persistently_but_heartbeat_reports_it(self):
        self.append()
        self.transport.ingest.append({"accepted": 1})
        uploader = self.uploader()
        uploader.step()
        self.assertEqual(uploader.status()["state"], "blocked")
        self.assertEqual(self.state()["blocked_reason"], "ack_mismatch")
        self.assertEqual(self.state()["acked_seq"], 0)
        self.assertEqual(len(self.transport.requests_for("heartbeat")), 1)
        self.clock.elapsed = 5
        uploader.step()
        self.assertEqual(json.loads(self.transport.requests_for("heartbeat")[-1])["outbox"]["state"], "blocked")
        self.uploader().step()
        self.assertEqual(len(self.transport.requests_for("ingest")), 1)

    def test_failed_block_write_still_prevents_spin_and_further_send(self):
        self.append()
        with self.ledger.transaction() as db:
            db.execute(
                """CREATE TRIGGER simulate_block_failure BEFORE UPDATE OF blocked_reason ON upload_state
                BEGIN SELECT raise(abort, 'test write failed'); END"""
            )
        self.transport.ingest.append(DeliveryError("http_400"))
        uploader = self.uploader()
        self.assertGreater(uploader.step(), 0)
        self.assertIsNone(self.state()["blocked_reason"])
        self.assertEqual(uploader.status()["state"], "blocked")
        self.clock.elapsed = 100
        uploader.step()
        self.assertEqual(len(self.transport.requests_for("ingest")), 1)

    def test_tampered_batch_is_blocked_before_sending(self):
        self.append()
        batch = stage_batch(self.ledger)
        with self.ledger.transaction() as db:
            db.execute("UPDATE outbox SET body = ? WHERE batch_id = ?", (b"{}", batch.batch_id))
        self.uploader().step()
        self.assertEqual(self.state()["blocked_reason"], "local_outbox_corrupt")
        self.assertEqual(self.transport.requests_for("ingest"), [])

    def test_429_retry_after_and_5xx_backoff_limit(self):
        self.append()
        self.transport.ingest.extend(
            [DeliveryError("http_429", retryable=True, retry_after=7)] +
            [DeliveryError("http_503", retryable=True)] * 9
        )
        uploader = self.uploader()
        deadline = 0
        for attempt, delay in enumerate((7, 4, 8, 16, 32, 64, 128, 256, 300, 300), start=1):
            self.clock.elapsed = deadline
            uploader.step()
            self.assertEqual(len(self.transport.requests_for("ingest")), attempt)
            self.clock.elapsed = deadline + delay - 0.01
            uploader.step()
            self.assertEqual(len(self.transport.requests_for("ingest")), attempt)
            self.assertEqual(uploader.status()["state"], "backoff")
            deadline += delay
        self.clock.elapsed = deadline
        uploader.step()
        self.assertEqual(len(set(self.transport.requests_for("ingest"))), 1)
        self.assertEqual(uploader.status()["state"], "ready")
        self.assertEqual(self.state()["acked_seq"], 1)

    def test_heartbeat_resends_latest_snapshot_only_and_tracks_clock(self):
        changes = snapshot()
        changes["apps"][0]["mode"] = "demo"
        self.transport.skew = 420
        self.transport.heartbeat.extend([DeliveryError("network_error", retryable=True)] * 2)
        uploader = Uploader(
            self.ledger, self.transport, lambda: changes, monotonic=self.clock.monotonic,
            now=self.clock.now, jitter=lambda: 0.0,
        )
        uploader.step()
        self.assertIsNone(uploader.clock_offset_seconds)
        self.clock.elapsed = 2
        uploader.step()
        self.clock.elapsed = 3
        changes["apps"][0]["mode"] = "test"
        uploader.wake(state_changed=True)
        uploader.step()
        self.assertEqual(len(self.transport.requests_for("heartbeat")), 2)
        self.clock.elapsed = 6
        uploader.step()
        payloads = [json.loads(body) for body in self.transport.requests_for("heartbeat")]
        self.assertEqual([row["heartbeat_seq"] for row in payloads], [1, 2, 3])
        self.assertEqual(len({row["heartbeat_id"] for row in payloads}), 3)
        self.assertEqual(len({row["session_id"] for row in payloads}), 1)
        self.assertEqual(payloads[-1]["apps"][0]["mode"], "test")
        self.assertEqual(uploader.clock_offset_seconds, 420)
        self.assertIsNone(uploader.heartbeat_error)
        self.clock.elapsed = 65
        uploader.step()
        self.assertEqual(len(self.transport.requests_for("heartbeat")), 3)
        self.clock.elapsed = 66
        uploader.step()
        self.assertEqual(len(self.transport.requests_for("heartbeat")), 4)
        self.clock.elapsed = 67
        uploader.wake(state_changed=True)
        self.clock.elapsed = 68
        uploader.wake(state_changed=True)
        self.clock.elapsed = 69
        uploader.step()
        self.assertEqual(len(self.transport.requests_for("heartbeat")), 4)
        self.clock.elapsed = 70
        uploader.step()
        self.assertEqual(len(self.transport.requests_for("heartbeat")), 5)


class _ScriptedHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.requests.append((self.path, self.headers.get("Authorization"), body))
        status, headers, content = self.server.responses.popleft()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, *args):
        return


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _ScriptedHandler)
        self.server.responses = deque()
        self.server.requests = []
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02})
        self.thread.start()
        self.addCleanup(self._stop)
        self.url = "http://127.0.0.1:{}".format(self.server.server_port)
        self.transport = Transport(self.url, TOKEN, now=lambda: START)

    def _stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_shared_wire_examples_keep_ack_or_error_semantics(self):
        shared = fixture("manifest.json")["cases"]
        for case in shared:
            with self.subTest(case=case["name"]):
                route, expected = case["endpoint"], case["expected"]
                request = (FIXTURES / case["file"]).read_bytes()
                payload = json.loads(request)
                response = expected.get("ack", {"code": expected.get("code")})
                if route == "heartbeat" and expected["status"] == 200:
                    response = {**response, "received_at": START.isoformat()}
                self.server.responses.append((expected["status"], {}, encode(response)))
                if expected["status"] != 200:
                    with self.assertRaises(DeliveryError) as exc:
                        self.transport.post(route, request)
                    self.assertEqual(exc.exception.code, expected["code"])
                    self.assertFalse(exc.exception.retryable)
                else:
                    self.assertEqual(self.transport.post(route, request), response)
                    self.assertEqual(response["station_id"], payload["station_id"])
                self.assertEqual(
                    self.server.requests[-1],
                    ("/api/field/v1/{}/".format(route), "WJField " + TOKEN, request),
                )

    def test_ignores_environment_proxy_and_refuses_redirect(self):
        dest = self.url + "/capture"
        self.server.responses.append((307, {"Location": dest}, b""))
        with patch.dict("os.environ", {"http_proxy": self.url, "no_proxy": ""}):
            with self.assertRaises(DeliveryError) as exc:
                self.transport.post("ingest", b"{}")
        self.assertEqual(exc.exception.code, "redirect_refused")
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0][0], "/api/field/v1/ingest/")

    def test_temporary_http_response_and_both_retry_after_formats(self):
        header_date = format_datetime(START + timedelta(seconds=45), usegmt=True)
        for status, header, delay in ((408, None, 0), (425, None, 0), (429, "17", 17), (503, header_date, 45)):
            with self.subTest(status=status):
                headers = {"Retry-After": header} if header is not None else {}
                self.server.responses.append((status, headers, b""))
                with self.assertRaises(DeliveryError) as exc:
                    self.transport.post("ingest", b"{}")
                self.assertTrue(exc.exception.retryable)
                self.assertEqual(exc.exception.retry_after, delay)

    def test_ack_size_and_ambiguous_json_are_bounded(self):
        for body, kind in (
            (b"x" * (MAX_BODY + 1), "response_too_large"),
            (b'{"accepted":1,"accepted":0}', "invalid_ack"), (b'{"accepted":NaN}', "invalid_ack"),
        ):
            with self.subTest(kind=kind):
                self.server.responses.append((200, {}, body))
                with self.assertRaises(DeliveryError) as exc:
                    self.transport.post("ingest", b"{}")
                self.assertEqual(exc.exception.code, kind)

    def test_remote_plain_http_and_userinfo_are_refused(self):
        self.assertEqual(normalize_server_url("http://localhost:9876/api"), "http://127.0.0.1:9876")
        self.assertEqual(normalize_server_url("https://example.invalid/api/"), "https://example.invalid")
        for value in (
            "http://example.invalid", "http://0.0.0.0", "http://127.0.0.1@elsewhere.invalid",
            "https://credential@example.invalid", "https://example.invalid?token=secret",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_server_url(value)
