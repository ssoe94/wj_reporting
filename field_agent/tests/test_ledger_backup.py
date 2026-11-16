"""Run on a disposable SQLite directory with no network or third-party libraries."""

import ast
from collections import namedtuple
from datetime import datetime, timedelta
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Event
import unittest

from field_agent.backup import Backup, restore_snapshot, verify_snapshot
from field_agent.devices import FakeBarcodeApp
from field_agent.ledger import Ledger, disk_full_error
from field_agent.protocol import SHANGHAI, timestamp
from field_agent.uploader import stage_batch


class SavedWorkTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ledger = Ledger(self.root / "ledger.sqlite3", "SYNTH-PC")
        self.addCleanup(self.ledger.close)
        self.app = FakeBarcodeApp(self.ledger, "0.1.0")
        self.at = datetime(2026, 1, 2, 8, 10, tzinfo=SHANGHAI)

    def _record(self, name=b"SYNTH-A\r\n"):
        return self.app.record(name, timestamp(self.at))

    def test_wal_ledger_identity_and_append_only(self):
        seq = self._record()
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(dict(conn.execute("SELECT key,value FROM meta"))["database_id"], self.ledger.database_id)
        with self.ledger.transaction() as conn:
            for sql in (
                "UPDATE events SET result='ng' WHERE seq=?",
                "DELETE FROM events WHERE seq=?",
                "INSERT OR REPLACE INTO events SELECT * FROM events WHERE seq=?",
            ):
                with self.assertRaisesRegex(sqlite3.IntegrityError, "append-only"):
                    conn.execute(sql, (seq,))
        self.assertGreater(self._record(), seq)
        with self.assertRaisesRegex(ValueError, "different station"):
            Ledger(self.ledger.path, "SYNTH-OTHER")

    def test_event_failure_rolls_back_work_and_fault_recovery(self):
        with self.ledger.transaction() as conn:
            conn.execute("""CREATE TRIGGER unit_failure BEFORE INSERT ON events
                BEGIN SELECT RAISE(ABORT, 'forced'); END""")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "forced"):
            self._record()
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM demo_scans").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 0)
        with self.ledger.transaction() as conn:
            conn.execute("DROP TRIGGER unit_failure")
        self.assertEqual(self._record(), 1)

    def test_app_cannot_commit_a_partial_unit_through_transaction_connection(self):
        with self.assertRaises(sqlite3.DatabaseError):
            with self.ledger.transaction() as conn:
                conn.execute("INSERT INTO demo_scans(barcode,recorded_at) VALUES('SYNTH-A','now')")
                conn.commit()
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM demo_scans").fetchone()[0], 0)

    def test_scheduled_snapshot_preserves_batch_and_restarts_without_repeating_audit(self):
        self._record()
        batch = stage_batch(self.ledger)
        self._record(b"SYNTH-B\n")
        folder = self.root / "backup"
        backup = Backup(self.ledger, folder, idle_seconds=10, min_free_bytes=0, wall_clock=lambda: self.at)
        self.assertFalse(backup.due(9.9, Event()))
        self.assertTrue(backup.due(10, Event()))
        self.assertEqual(backup.status()["state"], "completed")
        snapshot = folder / "2026-01-02.sqlite3"
        info = verify_snapshot(snapshot)
        self.assertEqual(info, {"station_id": "SYNTH-PC", "database_id": self.ledger.database_id,
                                "max_seq": 2, "staged_seq": 1, "acked_seq": 0, "staged_pending": 1})
        restored = self.root / "restore.sqlite3"
        self.assertEqual(restore_snapshot(snapshot, restored), info)
        with self.assertRaises(FileExistsError):
            restore_snapshot(snapshot, restored)
        sibling = Ledger(restored, "SYNTH-PC")
        try:
            self.assertEqual(stage_batch(sibling), batch)
            self.assertEqual(FakeBarcodeApp(sibling, "0.1.0").record(b"SYNTH-C\n", timestamp(self.at)), 3)
        finally:
            sibling.close()
        reopened = Backup(self.ledger, folder, idle_seconds=0, min_free_bytes=0, wall_clock=lambda: self.at)
        self.assertFalse(reopened.due(999, Event()))
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute("SELECT kind FROM events WHERE seq=3").fetchone()[0], "backup.completed")

    def test_disk_full_can_be_classified_on_older_python(self):
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute("PRAGMA page_size=512")
            conn.execute("CREATE TABLE entry (value BLOB)")
            conn.execute("PRAGMA max_page_count=2")
            with self.assertRaises(sqlite3.OperationalError) as error:
                conn.execute("INSERT INTO entry VALUES(zeroblob(8192))")
            self.assertTrue(disk_full_error(error.exception))
            self.assertFalse(disk_full_error(sqlite3.OperationalError("database is locked")))
        finally:
            conn.close()

    def test_disk_low_skips_without_creating_backup_then_retention_limits_only_own(self):
        folder = self.root / "backup"
        mode = namedtuple("Disk", "free")
        capacity = [0]
        backup = Backup(self.ledger, folder, keep=2, min_free_bytes=1, idle_seconds=0,
                        disk_usage=lambda _: mode(capacity[0]), wall_clock=lambda: self.at)
        self.assertTrue(backup.due(10, Event()))
        self.assertEqual(backup.status()["reason"], "disk_low")
        self.assertFalse(list(folder.iterdir()))
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute("SELECT kind FROM events WHERE seq=1").fetchone()[0], "backup.failed")
        capacity[0] = 2 ** 30
        backup.retry_after = 0
        foreign = folder / "2025-12-25.sqlite3"
        foreign.write_text("outside this ledger")
        for _ in range(3):
            self.assertTrue(backup.due(10, Event()))
            self.at += timedelta(days=1)
        self.assertEqual({p.name for p in folder.iterdir()},
                         {"2025-12-25.sqlite3", "2026-01-03.sqlite3", "2026-01-04.sqlite3"})

    def test_restore_rejects_live_wal_and_bad_snapshot_without_publish(self):
        self._record()
        path = self.root / "restore.sqlite3"
        with self.assertRaisesRegex(ValueError, "standalone"):
            restore_snapshot(self.ledger.path, path)
        self.assertFalse(path.exists())
        corruption = self.root / "corrupt.sqlite3"
        corruption.write_bytes(b"not a SQLite file")
        with self.assertRaises(sqlite3.DatabaseError):
            restore_snapshot(corruption, path)
        self.assertFalse(path.exists())

    def test_backup_quick_check_rejects_inconsistent_artifact(self):
        backup = Backup(self.ledger, self.root / "backup", idle_seconds=0, min_free_bytes=0, wall_clock=lambda: self.at)
        artifact = backup.directory / "2026-01-02.sqlite3"
        artifact.write_bytes(b"unreadable")
        self.assertTrue(backup.due(1, Event()))
        self.assertEqual(backup.status()["state"], "failed")
        with self.ledger.read() as conn:
            self.assertEqual(conn.execute("SELECT kind FROM events").fetchone()[0], "backup.failed")


class Python38CompatibilityTests(unittest.TestCase):
    def test_all_python_sources_use_python38_grammar(self):
        root = Path(__file__).resolve().parents[1]
        for path in root.rglob("*.py"):
            with self.subTest(path=path.relative_to(root)):
                ast.parse(path.read_text(encoding="utf-8"), feature_version=(3, 8))
