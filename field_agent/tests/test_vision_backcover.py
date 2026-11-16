"""Synthetic source DB, no installed V49 path, media or network."""

from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from field_agent.ledger import Ledger
from field_agent.vision_backcover import BackcoverCollector, _file_id


AT = "2026-11-16T09:00:00+08:00"
SYNTH_UUID = "1" * 32
SYNTH_DIGEST = "ab" * 32


def history_db(path, *, wal=False):
    connection = sqlite3.connect(path)
    if wal:
        connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE events (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
    connection.commit()
    return connection


def record(serial, **edits):
    data = dict(id="{:032x}".format(serial), recorded_at=AT, session=SYNTH_UUID, cycle_id=serial,
                product_id=SYNTH_UUID + ":" + str(serial), result="OK", reason="occlusion_confirmed",
                source={"kind": "camera"}, profile_sha256=SYNTH_DIGEST)
    data.update(edits)
    return data


def append(source, *records):
    with source:
        source.executemany("INSERT INTO events VALUES (?,?)",
                           [(data["id"], json.dumps(data, ensure_ascii=False)) for data in records])


def payloads(ledger):
    with ledger.read() as conn:
        return [json.loads(row[0]) for row in conn.execute("SELECT payload FROM events ORDER BY seq")]


class BackcoverCollectorTests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "history.sqlite3"
        self.ledger = Ledger(self.root / "ledger.sqlite3", "SYNTH-V49")
        self.addCleanup(self.ledger.close)

    def make_collector(self, **kwargs):
        collector = BackcoverCollector(self.ledger, self.path, **kwargs)
        self.addCleanup(collector.close)
        return collector

    def test_incremental_live_wal_and_no_repeat_after_restart(self):
        with closing(history_db(self.path, wal=True)) as source:
            collector = self.make_collector(camera_mode="production")
            append(source, record(1))
            hashes = {p.name: p.read_bytes() for p in [self.path, self.path.with_name(self.path.name + "-wal")]}
            self.assertEqual(collector.poll(), 1)
            self.assertEqual(collector.poll(), 0)
            identity = _file_id(self.path.stat())
            readonly, offline = collector._source_connection(identity)
            self.assertFalse(offline)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    readonly.execute("DELETE FROM events")
            finally:
                collector.close()
            self.assertEqual({p.name: p.read_bytes() for p in [self.path, self.path.with_name(self.path.name + "-wal")]}, hashes)
            append(source, record(2, result="NG", reason="operation_not_confirmed"))
            self.assertEqual(collector.poll(), 1)
            collector.close()
            reopened = self.make_collector(camera_mode="production")
            self.assertEqual(reopened.poll(), 0)
            self.assertEqual(reopened.status()["mode"], "production")
        self.assertEqual([event["reason"] for event in payloads(self.ledger)],
                         ["occlusion_confirmed", "operation_not_confirmed"])

    def test_closed_wal_snapshot_does_not_create_sqlite_sidecars(self):
        with closing(history_db(self.path, wal=True)) as source:
            append(source, record(1))
        expected = sorted(self.root.iterdir())
        collector = self.make_collector()
        self.assertEqual(collector.poll(), 1)
        self.assertEqual(collector.poll(), 0)
        self.assertEqual(sorted(self.root.iterdir()), expected)
        event = payloads(self.ledger)[0]
        self.assertEqual(event["mode"], "unknown")
        self.assertEqual(event["config_version"], SYNTH_DIGEST)

    def test_page_bound_and_backlog_work_on_unchanged_data_version(self):
        with closing(history_db(self.path)) as source:
            append(source, *(record(number) for number in range(1, 8)))
            collector = self.make_collector()
            with patch("field_agent.vision_backcover.POLL_ROWS", 3):
                self.assertEqual([collector.poll() for _ in range(4)], [3, 3, 1, 0])
        self.assertEqual(len(payloads(self.ledger)), 7)

    def test_missing_source_then_replaced_earlier_rows_dedup_with_diagnostic_gap(self):
        with closing(history_db(self.path)) as source:
            append(source, record(1), record(2))
        collector = self.make_collector()
        self.assertEqual(collector.poll(), 2)
        self.path.rename(self.root / "archived")
        self.assertEqual(collector.poll(), 1)
        self.assertEqual(collector.poll(), 0)
        with closing(history_db(self.path)) as source:
            append(source, record(2), record(3))
        self.assertEqual(collector.poll(), 2)
        events = payloads(self.ledger)
        self.assertEqual([event["detail"]["cause"] for event in events if event["reason"] == "vision_source_gap"],
                         ["source_missing", "file_replaced"])
        self.assertEqual(len([event for event in events if event["type"] == "vision.cycle"]), 3)

    def test_reused_cursor_and_mutated_source_uuid_keep_original_verdict(self):
        collector = self.make_collector()
        with closing(history_db(self.path)) as source:
            append(source, record(1), record(2))
            self.assertEqual(collector.poll(), 2)
            with source:
                source.execute("UPDATE events SET payload=? WHERE rowid=2", (json.dumps(record(2, result="NG")),))
            self.assertEqual(collector.poll(), 2)
            self.assertEqual(collector.poll(), 0)
        events = payloads(self.ledger)
        self.assertEqual([event["detail"]["cause"] for event in events if event["reason"] == "vision_source_gap"],
                         ["cursor_row_changed", "source_record_changed"])
        self.assertEqual([event["result"] for event in events if event["type"] == "vision.cycle"], ["ok", "ok"])

    def test_cycle_conflict_keeps_both_final_rows_and_same_key_without_restart_source(self):
        with closing(history_db(self.path)) as source:
            append(source, record(1), record(2, result="INCOMPLETE", reason="application_restarted",
                                             source=None, cycle_id=1, product_id=SYNTH_UUID + ":1"),
                   record(3, source={"kind": "video", "name": "unused synthetic name"}))
        collector = self.make_collector(camera_mode="production")
        self.assertEqual(collector.poll(), 3)
        events = payloads(self.ledger)
        self.assertEqual([event["mode"] for event in events], ["production", "unknown", "preview"])
        self.assertEqual([event["ref"]["cycle_id"] for event in events], [SYNTH_UUID + ":1", SYNTH_UUID + ":1",
                                                                         SYNTH_UUID + ":3"])
        self.assertEqual(events[1]["detail"]["cause"], "application_restarted")
        self.assertNotIn("unused", json.dumps(events))

    def test_bad_or_nonfinal_history_rows_are_not_final_vision_cycles(self):
        with closing(history_db(self.path)) as source:
            append(source, record(1, result="WORK_RECORDED"), record(2, product_id=SYNTH_UUID + ":9"),
                   record(3, recorded_at="monotonic-only"), record(4, result="RESET"))
        collector = self.make_collector()
        self.assertEqual(collector.poll(), 4)
        events = payloads(self.ledger)
        self.assertEqual([event["reason"] for event in events],
                         ["vision_source_gap", "vision_source_gap", "vision_source_gap", "operator_reset"])
        self.assertIsNone(collector.status()["last_work_at"])

    def test_malformed_sqlite_blob_is_a_bounded_gap_not_a_stuck_cursor(self):
        with closing(history_db(self.path)) as source:
            source.execute("INSERT INTO events VALUES (?,?)", (record(1)["id"], sqlite3.Binary(b"\xff")))
            source.commit()
            append(source, record(2))
        collector = self.make_collector()
        self.assertEqual(collector.poll(), 2)
        self.assertEqual(collector.poll(), 0)
        self.assertEqual([event["reason"] for event in payloads(self.ledger)],
                         ["vision_source_gap", "occlusion_confirmed"])

    def test_evidence_contains_opaque_id_hash_and_never_path_or_bytes(self):
        photo_name = record(1)["id"] + ".jpg"
        photo = self.root / photo_name
        photo.write_bytes(b"SYNTHETIC-IMAGE-LITERAL")
        with closing(history_db(self.path)) as source:
            append(source, record(1, photo=photo_name, diagnostic="../SYNTHETIC-PRIVATE.zip"),
                   record(2, photo=record(2)["id"] + ".jpg"))
        collector = self.make_collector()
        self.assertEqual(collector.poll(), 2)
        events = payloads(self.ledger)
        self.assertEqual(events[0]["evidence"], [
            {"kind": "result_photo", "id": "v49:" + record(1)["id"],
             "sha256": sha256(photo.read_bytes()).hexdigest()},
        ])
        self.assertEqual(events[1]["evidence"], [{"kind": "result_photo", "id": "v49:" + record(2)["id"]}])
        self.assertTrue(all(event["detail"]["evidence_partial"] for event in events))
        published = json.dumps(events)
        self.assertTrue(all(literal not in published for literal in (photo_name, "SYNTHETIC-PRIVATE", "SYNTHETIC-IMAGE",
                                                                    str(self.root))))
        with patch("field_agent.vision_backcover._evidence_files", side_effect=AssertionError("evidence reread")):
            self.assertEqual(collector.poll(), 0)

    def test_evidence_budget_defers_backlog_without_advancing_past_row(self):
        with closing(history_db(self.path)) as source:
            for number in (1, 2):
                item = record(number)
                item["photo"] = item["id"] + ".jpg"
                (self.root / item["photo"]).write_bytes(b"x" * 80)
                append(source, item)
        collector = self.make_collector()
        with patch("field_agent.vision_backcover.EVIDENCE_BYTES_PER_POLL", 100):
            self.assertEqual([collector.poll() for _ in range(3)], [1, 1, 0])
        self.assertTrue(all(event["evidence"][0].get("sha256") for event in payloads(self.ledger)))

    def test_failed_destination_write_retries_source_row_and_cursor_atomically(self):
        with closing(history_db(self.path)) as source:
            append(source, record(1))
        collector = self.make_collector()
        with patch.object(self.ledger, "append", side_effect=OSError("synthetic write failure")):
            with self.assertRaises(OSError):
                collector.poll()
        self.assertEqual(payloads(self.ledger), [])
        self.assertEqual(collector.poll(), 1)
        self.assertEqual(collector.poll(), 0)

    def test_cached_status_poll_is_opt_in_bounded_and_deduplicates_faults(self):
        with closing(history_db(self.path)) as source:
            append(source, record(1))
        healthy = {"display_cache_age_s": 0.1, "display_stale": False, "frame_age": 0.2,
                   "state": "WAIT_EMPTY", "source": {"kind": "camera"}, "session": SYNTH_UUID,
                   "signal_light": {"enabled": True, "connected": True, "last_ack_at": AT}}
        fault = {**healthy, "state": "FAULT", "fault": "camera_disconnected / synthetic internal reason",
                 "display_stale": True, "cycle_id": 4}
        disabled = self.make_collector()
        collector = self.make_collector(camera_mode="production", status_enabled=True)
        with patch("field_agent.vision_backcover._read_status", side_effect=[healthy, fault, fault, None, healthy, fault]) as reader:
            self.assertEqual(disabled.poll(), 1)
            reader.assert_not_called()
            disabled.close()
            # Reopen from the current checkpoint; the deployment has one worker per source.
            collector.close()
            collector = self.make_collector(camera_mode="production", status_enabled=True)
            with patch("field_agent.vision_backcover.monotonic", side_effect=[0, 1, 60, 119, 120, 180, 181, 240, 300]):
                self.assertEqual(collector.poll(), 0)
                self.assertEqual(collector.status()["devices"][0]["state"], "connected")
                self.assertEqual(collector.status()["devices"][1]["state"], "connected")
                self.assertEqual(collector.poll(), 0)
                self.assertEqual(collector.poll(), 1)
                self.assertEqual(collector.status()["devices"][0]["state"], "fault")
                self.assertEqual(collector.poll(), 0)
                self.assertEqual(collector.poll(), 0)
                self.assertEqual(collector.poll(), 0)
                self.assertEqual(collector.status()["devices"][0]["state"], "unknown")
                self.assertEqual(collector.poll(), 0)
                self.assertEqual(collector.poll(), 0)
                self.assertEqual(collector.poll(), 1)
            self.assertEqual(reader.call_count, 6)
        faults = [event for event in payloads(self.ledger) if event["type"] == "device.state"]
        self.assertTrue(all(event["reason"] == "vision_device_fault" for event in faults))
        self.assertNotIn("synthetic internal reason", json.dumps(faults))
        self.assertEqual(collector.status()["state"], "running")
