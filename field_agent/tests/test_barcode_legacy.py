"""Read-only collection from disposable notebook-format databases."""

import json
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from field_agent.barcode_legacy import LegacyBarcodeCollector
from field_agent.ledger import Ledger


GENERATION_A = "00000000-0000-4000-8000-000000000001"
GENERATION_B = "00000000-0000-4000-8000-000000000002"
AT = "2026-01-02 08:03:02"


class LegacyBarcodeTests(unittest.TestCase):
    def setUp(self):
        workspace = TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.root = Path(workspace.name)
        self.source = self.root / "synthetic legacy.db"
        self.ledger = Ledger(self.root / "field.sqlite3", "SYNTH-PC")
        self.addCleanup(self.ledger.close)
        self.collector = self.new_collector()

    def new_collector(self):
        collector = LegacyBarcodeCollector(self.ledger, self.source)
        self.addCleanup(collector.close)
        return collector

    def _db(self, path, generation, *, mode="delete"):
        writer = sqlite3.connect(path)
        self.addCleanup(writer.close)
        writer.execute("PRAGMA journal_mode=" + mode)
        writer.executescript("""
            CREATE TABLE barcodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT, scanner TEXT, barcode TEXT, status TEXT, product_size TEXT, product_group TEXT
            );
            CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        if generation:
            writer.execute("INSERT INTO app_meta VALUES ('database_id', ?)", (generation,))
        writer.commit()
        return writer

    def _append(self, writer, barcode, *, status="ok", moment=AT):
        with writer:
            return writer.execute(
                "INSERT INTO barcodes(time,scanner,barcode,status,product_size,product_group) VALUES (?, 'B', ?, ?, '75', 'SYNTH-G')",
                (moment, barcode, status),
            ).lastrowid

    def _events(self):
        with self.ledger.read() as conn:
            return [json.loads(payload) for payload, in conn.execute("SELECT payload FROM events ORDER BY seq")]

    def test_live_wal_incremental_bounded_poll_and_restart(self):
        writer = self._db(self.source, GENERATION_A, mode="wal")
        self._append(writer, "SYNTH-1", status="정상")
        self._append(writer, "SYNTH-2", status="스캐너 불일치 A")
        self._append(writer, "SYNTH-3", status="new synthetic source status")
        wal = self.source.with_name(self.source.name + "-wal")
        original_bytes = self.source.read_bytes(), wal.read_bytes()
        with patch("field_agent.barcode_legacy.POLL_ROWS", 2):
            self.assertEqual(self.collector.poll(), 2)
            self.assertEqual(self.collector.status(), {
                "state": "running", "coverage": "partial", "last_work_at": "2026-01-02T08:03:02.000+08:00",
            })
            self.assertEqual(self.collector.poll(), 1)
            self.assertEqual(self.collector.poll(), 0)
        self.assertEqual((self.source.read_bytes(), wal.read_bytes()), original_bytes)
        first, second, third = self._events()
        self.assertEqual(first["occurred_at"], "2026-01-02T08:03:02.000+08:00")
        self.assertEqual(first["detail"]["time_basis"], "legacy_local")
        self.assertTrue(all(event["mode"] == "unknown" for event in (first, second, third)))
        self.assertEqual(first["status_raw"], "정상")
        self.assertEqual(first["reason"], "scan_match")
        self.assertEqual(first["ref"]["source_key"], f"legacy_barcode:{GENERATION_A}:1")
        self.assertEqual(second["reason"], "scan_wrong_device")
        self.assertEqual(second["detail"]["expected_device"], "A")
        self.assertEqual(second["detail"]["legacy_slot"], "B")
        self.assertIsNone(second["device"])
        self.assertEqual(third["reason"], "source_status_unknown")

        self.collector.close()
        self._append(writer, "SYNTH-4", status="duplicate")
        restarted = self.new_collector()
        self.assertEqual(restarted.poll(), 1)
        self.assertEqual(restarted.poll(), 0)
        self.assertEqual(restarted.status()["last_work_at"], first["occurred_at"])
        self.assertEqual(self._events()[-1]["reason"], "scan_duplicate")

    def test_delete_then_insert_above_highwater_records_gap_and_keeps_prior_events(self):
        writer = self._db(self.source, GENERATION_A)
        self.assertEqual(self._append(writer, "SYNTH-OLD"), 1)
        self.assertEqual(self.collector.poll(), 1)
        with writer:
            writer.execute("DELETE FROM barcodes")
        self.assertEqual(self._append(writer, "SYNTH-NEXT"), 2)
        self.assertEqual(self.collector.poll(), 2)
        first, gap, latest = self._events()
        self.assertEqual(first["barcode"], "SYNTH-OLD")
        self.assertEqual(gap["reason"], "legacy_source_gap")
        self.assertIn("cursor_row_missing", gap["detail"]["causes"])
        self.assertEqual(latest["barcode"], "SYNTH-NEXT")
        self.assertEqual(self.collector.poll(), 0)

    def test_same_generation_restore_keeps_cursor_and_refuses_to_reimport_ids(self):
        writer = self._db(self.source, GENERATION_A)
        self._append(writer, "SYNTH-UNCHANGED")
        self._append(writer, "SYNTH-OLD")
        self.assertEqual(self.collector.poll(), 2)
        writer.close()
        replacement = self.root / "restored.db"
        writer = self._db(replacement, GENERATION_A)
        self._append(writer, "SYNTH-UNCHANGED")
        writer.close()
        os.replace(replacement, self.source)

        self.assertEqual(self.collector.poll(), 1)
        gap = self._events()[-1]
        self.assertIn("file_replaced", gap["detail"]["causes"])
        self.assertIn("last_id_regressed", gap["detail"]["causes"])
        writer = sqlite3.connect(self.source)
        self.addCleanup(writer.close)
        self.assertEqual(self._append(writer, "SYNTH-REUSED-ID"), 2)
        self.assertEqual(self._append(writer, "SYNTH-NEXT-ID"), 3)
        self.assertEqual(self.collector.poll(), 2)
        self.assertEqual(self._events()[-1]["barcode"], "SYNTH-NEXT-ID")
        self.assertNotIn("SYNTH-REUSED-ID", [event.get("barcode") for event in self._events()])

    def test_new_generation_reuses_source_ids_and_returning_generation_resumes(self):
        old = self._db(self.source, GENERATION_A)
        self._append(old, "SYNTH-A")
        self.assertEqual(self.collector.poll(), 1)
        old.close()
        stored_old = self.root / "previous.db"
        replacement = self.root / "replacement.db"
        new = self._db(replacement, GENERATION_B)
        self.assertEqual(self._append(new, "SYNTH-B"), 1)
        new.close()

        os.replace(self.source, stored_old)
        self.assertEqual(self.collector.poll(), 1)
        self.assertEqual(self.collector.poll(), 0)
        self.assertIn("source_missing", self._events()[-1]["detail"]["causes"])
        self.assertEqual(self.collector.status()["state"], "fault")
        os.replace(replacement, self.source)
        self.assertEqual(self.collector.poll(), 2)
        first, _, gap, latest = self._events()
        self.assertIn("generation_changed", gap["detail"]["causes"])
        self.assertNotEqual(first["ref"]["source_key"], latest["ref"]["source_key"])
        self.assertEqual(latest["barcode"], "SYNTH-B")

        os.replace(stored_old, self.source)
        self.assertEqual(self.collector.poll(), 1)
        self.assertEqual(self._events()[-1]["reason"], "legacy_source_gap")
        self.assertEqual(len([event for event in self._events() if event["type"] == "scan.recorded"]), 2)

    def test_mutable_source_status_and_metadata_changes_do_not_replace_observations(self):
        writer = self._db(self.source, GENERATION_A)
        self._append(writer, "SYNTH-BARCODE", status="wrong_product_group")
        self.assertEqual(self.collector.poll(), 1)
        with writer:
            writer.execute("UPDATE barcodes SET status='ok', product_size='55'")
        self.assertEqual(self.collector.poll(), 1)
        before, gap = self._events()
        self.assertEqual(before["reason"], "scan_wrong_product_group")
        self.assertEqual(gap["detail"]["causes"], ["cursor_row_changed"])
        self.assertEqual(self.collector.poll(), 0)

    def test_invalid_timestamp_records_only_observed_gap_and_keeps_following_rows(self):
        writer = self._db(self.source, GENERATION_A)
        self._append(writer, "SYNTH-1", moment="2026-01-02T08:03:02-05:00")
        self._append(writer, "SYNTH-2")
        self.assertEqual(self.collector.poll(), 2)
        gap, scan = self._events()
        self.assertEqual(gap["detail"]["causes"], ["invalid_source_time"])
        self.assertEqual(gap["ref"]["source_key"], f"legacy_barcode:{GENERATION_A}:1")
        self.assertNotIn("barcode", gap)
        self.assertEqual(scan["barcode"], "SYNTH-2")
        self.assertEqual(self.collector.poll(), 0)

    def test_append_error_rolls_back_batch_cursor_and_allows_same_rows_on_retry(self):
        writer = self._db(self.source, GENERATION_A)
        self._append(writer, "SYNTH-1")
        self._append(writer, "SYNTH-2")
        original = self.ledger.append
        calls = [0]

        def reject_second(conn, event):
            calls[0] += 1
            if calls[0] == 2:
                raise sqlite3.IntegrityError("synthetic failure")
            return original(conn, event)

        with self.assertRaisesRegex(sqlite3.IntegrityError, "synthetic failure"):
            with patch.object(self.ledger, "append", side_effect=reject_second):
                self.collector.poll()
        self.assertEqual(self._events(), [])
        self.assertEqual(self.collector.poll(), 2)
        self.assertEqual(self.collector.poll(), 0)

    def test_source_bytes_unchanged_and_closed_between_windows_snapshots(self):
        writer = self._db(self.source, GENERATION_A)
        self._append(writer, "SYNTH-BARCODE")
        writer.close()
        initial_bytes = self.source.read_bytes()
        self.collector._keep_open = False
        self.assertEqual(self.collector.poll(), 1)
        self.assertIsNone(self.collector._connection)
        self.assertEqual(self.collector.poll(), 0)
        self.assertIsNone(self.collector._connection)
        self.assertEqual(self.source.read_bytes(), initial_bytes)
