import json
from datetime import date
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from field_agent.ledger import Ledger
from field_agent.weigh.legacy import WeighLegacyCollector
from field_agent.weigh.serials import make_barcode


DAY = "2026-01-02"
NOW = DAY + "T09:30:10.111+08:00"
NEXT = DAY + "T09:31:10.111+08:00"
GEN = "00000000-0000-4000-8000-000000000005"


class WeighLegacyTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.scan_path = root / "scans.sqlite3"
        self.print_path = root / "production.sqlite3"
        self.scans = sqlite3.connect(self.scan_path)
        self.addCleanup(self.scans.close)
        self.scans.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE scan_archive(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT,scanner TEXT,barcode TEXT,
                status TEXT,product_size TEXT,product_group TEXT);
            CREATE TABLE scan_attempts(id INTEGER PRIMARY KEY,job_id TEXT,label_index INTEGER,print_status TEXT,
                print_date TEXT,source TEXT,expected_part_no TEXT,expected_scanner TEXT,part_no TEXT,
                input_device TEXT,label_origin TEXT,duplicate_of INTEGER);
        """)
        with self.scans:
            self.scans.execute("INSERT INTO app_meta VALUES('database_id',?)", (GEN,))
        self.prints = sqlite3.connect(self.print_path)
        self.addCleanup(self.prints.close)
        self.prints.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE jobs(job_id TEXT PRIMARY KEY,created_at TEXT,print_date TEXT,part_no TEXT,quantity INTEGER,
                first_serial INTEGER,last_serial INTEGER,status TEXT);
            CREATE TABLE print_queue(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT UNIQUE,state TEXT,
                group_id TEXT,payload_sha256 TEXT,inspection_json TEXT);
            CREATE TABLE queue_attempts(attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,started_at TEXT,
                finished_at TEXT,outcome TEXT,error_code TEXT);
            CREATE TABLE physical_rows(row_id TEXT PRIMARY KEY,created_at TEXT,state TEXT,quantity INTEGER,
                columns INTEGER,flush_note TEXT);
            CREATE TABLE physical_row_members(row_id TEXT,position INTEGER,job_id TEXT UNIQUE,
                PRIMARY KEY(row_id,position));
            CREATE TABLE physical_row_attempts(attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,row_id TEXT,
                started_at TEXT,finished_at TEXT,outcome TEXT,error_code TEXT);
            CREATE TABLE reconciliations(job_id TEXT PRIMARY KEY,confirmed_at TEXT,confirmed_quantity INTEGER);
        """)
        self.ledger = Ledger(root / "field.sqlite3", "SYNTH-LEGACY-WEIGH")
        self.addCleanup(self.ledger.close)
        self.collector = self.new_collector()

    def new_collector(self):
        instance = WeighLegacyCollector(self.ledger, self.scan_path, self.print_path)
        self.addCleanup(instance.close)
        return instance

    def append_scan(self, code, status="ok", source="serial", device="W", when=NOW):
        with self.scans:
            scan_id = self.scans.execute(
                "INSERT INTO scan_archive(time,scanner,barcode,status,product_size,product_group) "
                "VALUES(?,'A',?,?,'55','50/55')", (when, code, status)
            ).lastrowid
            self.scans.execute(
                "INSERT INTO scan_attempts VALUES(?, 'SYNTH-J1',0,'submitted',?,?,"
                "'SYNTH-PART','ANY','SYNTH-PART',?,'station',NULL)", (scan_id, DAY, source, device)
            )
        return scan_id

    def reserve(self, job_id, q=1, group="SYNTH-GROUP", queued=True):
        with self.prints:
            self.prints.execute("INSERT INTO jobs VALUES(?,?,?,'SYNTH-PART',?,1,?,'prepared')",
                                (job_id, NOW, DAY, q, q))
            if queued:
                inspection = {"quantity": q, "net_g": "21.5", "expected_g": "22.0", "limit_g": "1.1",
                              "rule": "unit_5pct_sqrt_quantity_v1"}
                self.prints.execute("INSERT INTO print_queue(job_id,state,group_id,payload_sha256,inspection_json)"
                                    " VALUES(?,'waiting',?,?,?)", (job_id, group, "a" * 64, json.dumps(inspection)))

    def events(self, kind=None):
        with self.ledger.read() as local:
            rows = [json.loads(row[0]) for row in local.execute("SELECT payload FROM events ORDER BY seq")]
        return [row for row in rows if kind is None or row["type"] == kind]

    def test_scan_incremental_restart_preserves_input_slot_and_origin(self):
        self.append_scan("SYNTH-A")
        self.assertEqual(self.collector.poll(), 1)
        self.assertEqual(self.collector.poll(), 0)
        self.collector.close()
        after = self.new_collector()
        self.append_scan("SYNTH-B", status="wrong_part", source="manual", device="KEYBOARD")
        self.append_scan("SYNTH-C", status="test_scan", source="demo", device="")
        self.assertEqual(after.poll(), 2)
        self.assertEqual(after.poll(), 0)
        a, b, c = self.events()
        self.assertEqual((a["device"], a["detail"]["legacy_slot"], a["mode"], a["detail"]["label_origin"]),
                         ("W", "A", "unknown", "local"))
        self.assertEqual((b["reason"], b["mode"]), ("reread_wrong_part", "manual"))
        self.assertEqual((c["device"], c["mode"]), (None, "test"))

    def test_old_scan_without_attempts_exposes_only_legacy_slot(self):
        self.scans.execute("DROP TABLE scan_attempts")
        with self.scans:
            self.scans.execute("INSERT INTO scan_archive VALUES(1,?,'B','SYNTH','ok','','')", (NOW,))
        self.assertEqual(self.collector.poll(), 1)
        [event] = self.events()
        self.assertIsNone(event["device"])
        self.assertEqual(event["detail"]["legacy_slot"], "B")
        self.assertEqual(event["detail"]["label_origin"], "unknown")

    def test_legacy_reservation_carries_verified_namespace_and_last_serial(self):
        self.reserve("SYNTH-V1", q=2, queued=False)
        self.reserve("SYNTH-MIXED", q=2, queued=False)
        self.reserve("SYNTH-FALSE-CEILING", q=2, queued=False)
        self.reserve("SYNTH-MALFORMED", q=2, queued=False)
        self.reserve("SYNTH-OLD", q=2, queued=False)
        printed = date.fromisoformat(DAY)
        cfg = {"site_code": "X", "vendor_code": "YZ"}
        other = {"site_code": "Y", "vendor_code": "Z0"}
        first, last = [make_barcode("SYNTH-PART", serial, cfg, printed) for serial in (1, 2)]
        with self.prints:
            self.prints.execute("ALTER TABLE jobs ADD COLUMN barcodes_json TEXT")
            for job, codes in (
                ("SYNTH-V1", json.dumps([first, last])),
                ("SYNTH-MIXED", json.dumps([first, make_barcode("SYNTH-PART", 2, other, printed)])),
                ("SYNTH-FALSE-CEILING", json.dumps([first, make_barcode("SYNTH-PART", 3, cfg, printed)])),
                ("SYNTH-MALFORMED", "[" * 600),
            ):
                self.prints.execute("UPDATE jobs SET barcodes_json=? WHERE job_id=?", (codes, job))

        self.assertEqual(self.collector.poll(), 5)
        self.assertEqual(self.collector.poll(), 0)
        rows = {row["ref"]["job_id"]: row for row in self.events("label.reserved")}
        self.assertEqual((rows["SYNTH-V1"]["barcode"], rows["SYNTH-V1"]["serial"]), (last, "0002"))
        self.assertEqual(rows["SYNTH-V1"]["detail"]["last_serial"], 2)
        self.assertEqual(rows["SYNTH-V1"]["mode"], "unknown")
        for job in ("SYNTH-MIXED", "SYNTH-FALSE-CEILING", "SYNTH-MALFORMED", "SYNTH-OLD"):
            with self.subTest(job=job):
                self.assertNotIn("barcode", rows[job])
                self.assertNotIn("serial", rows[job])
                self.assertEqual(rows[job]["detail"]["last_serial"], 2)

    def test_group_inspection_once_attempt_transitions_and_reconciliation(self):
        self.reserve("SYNTH-J1")
        self.reserve("SYNTH-J2")
        self.assertEqual(self.collector.poll(), 3)
        self.assertEqual(len(self.events("weigh.result")), 1)
        self.assertEqual(len(self.events("label.reserved")), 2)
        with self.prints:
            self.prints.execute("INSERT INTO queue_attempts VALUES(1,'SYNTH-J1',?,NULL,'dispatching',NULL)", (NOW,))
        self.assertEqual(self.collector.poll(), 0)
        self.collector.close()
        resumed = self.new_collector()
        with self.prints:
            self.prints.execute("UPDATE queue_attempts SET outcome='not_sent',finished_at=?,error_code='PRECHECK'", (NEXT,))
            self.prints.execute("INSERT INTO queue_attempts VALUES(2,'SYNTH-J1',?,?,'submitted',NULL)", (NOW,NEXT))
        self.assertEqual(resumed.poll(), 2)
        self.assertEqual(resumed.poll(), 0)
        with self.prints:
            self.prints.execute("INSERT INTO reconciliations VALUES('SYNTH-J1',?,1)", (NEXT,))
        self.assertEqual(resumed.poll(), 1)
        outcomes = self.events("label.dispatched")
        self.assertEqual([event["reason"] for event in outcomes], ["print_rejected_unsent", "print_submitted"])
        self.assertTrue(all(event["mode"] == "unknown" for event in self.events()))
        self.assertEqual(self.events("operator.action")[0]["reason"], "operator_reconciled")

    def test_physical_attempt_does_not_double_member_dispatches(self):
        self.reserve("SYNTH-J1")
        self.reserve("SYNTH-J2")
        with self.prints:
            self.prints.execute("INSERT INTO physical_rows VALUES('SYNTH-ROW',?,'waiting',2,3,'operator partial')", (NOW,))
            self.prints.executemany("INSERT INTO physical_row_members VALUES('SYNTH-ROW',?,?)",
                                    [(0, "SYNTH-J1"), (1, "SYNTH-J2")])
            self.prints.executemany("INSERT INTO queue_attempts(job_id,started_at,finished_at,outcome) VALUES(?,?,?,'uncertain')",
                                    [(job, NOW, NEXT) for job in ("SYNTH-J1","SYNTH-J2")])
            self.prints.execute("INSERT INTO physical_row_attempts VALUES(1,'SYNTH-ROW',?,?,'uncertain',NULL)", (NOW,NEXT))
        self.collector.poll()
        [dispatch] = self.events("label.dispatched")
        self.assertEqual(dispatch["detail"]["job_ids"], ["SYNTH-J1", "SYNTH-J2"])
        self.assertEqual(dispatch["detail"]["quantity"], 2)
        [flush] = self.events("queue.partial_flush")
        self.assertEqual(flush["detail"]["columns"], 3)
        self.assertNotIn("operator partial", json.dumps(flush))

    def test_direct_job_final_state_preserves_observation_time_basis(self):
        self.reserve("SYNTH-J1", queued=False)
        self.assertEqual(self.collector.poll(), 1)
        with self.prints:
            self.prints.execute("UPDATE jobs SET status='uncertain' WHERE job_id='SYNTH-J1'")
        self.assertEqual(self.collector.poll(), 1)
        [event] = self.events("label.dispatched")
        self.assertEqual(event["detail"]["time_basis"], "legacy_status_observed")
        self.assertEqual(event["reason"], "print_uncertain")

    def test_scan_truncate_and_new_generation_restart(self):
        self.append_scan("SYNTH-FIRST")
        self.assertEqual(self.collector.poll(), 1)
        with self.scans:
            self.scans.execute("DELETE FROM scan_archive")
        self.assertEqual(self.collector.poll(), 1)
        self.assertEqual(self.collector.poll(), 0)
        with self.scans:
            self.scans.execute("DELETE FROM scan_attempts")
            self.scans.execute("UPDATE sqlite_sequence SET seq=0 WHERE name='scan_archive'")
            self.scans.execute("UPDATE app_meta SET value='00000000-0000-4000-8000-000000000006'")
        self.assertEqual(self.append_scan("SYNTH-NEW"), 1)
        self.assertEqual(self.collector.poll(), 2)
        gap = self.events("operator.action")
        self.assertIn("last_id_regressed", gap[0]["detail"]["causes"])
        self.assertIn("generation_changed", gap[1]["detail"]["causes"])
        self.assertEqual([value["barcode"] for value in self.events("label.reread")], ["SYNTH-FIRST", "SYNTH-NEW"])

    def test_readonly_wal_and_replacement_preserve_history_without_duplicate_events(self):
        self.reserve("SYNTH-J1")
        self.append_scan("SYNTH-FIRST")
        input_files = [source for db in (self.scan_path, self.print_path)
                       for source in (db, db.with_name(db.name + "-wal"))]
        before = [source.read_bytes() for source in input_files]
        self.assertEqual(self.collector.poll(), 3)
        self.assertEqual([source.read_bytes() for source in input_files], before)
        self.collector.close()
        self.prints.close()
        copy = self.print_path.with_suffix(".replacement")
        with sqlite3.connect(self.print_path) as source, sqlite3.connect(copy) as dest:
            source.backup(dest)
        copy.replace(self.print_path)
        self.assertEqual(self.collector.poll(), 1)
        self.assertIn("file_replaced", self.events("operator.action")[0]["detail"]["causes"])
        self.assertEqual(self.collector.poll(), 0)
        self.assertEqual(len(self.events("label.reserved")), 1)

    def test_failed_local_commit_does_not_advance_or_imply_a_source_gap(self):
        self.append_scan("SYNTH-RETRY")
        self.reserve("SYNTH-J1")
        self.collector.poll()
        self.append_scan("SYNTH-NEXT")
        with patch.object(self.ledger, "append", side_effect=sqlite3.OperationalError("synthetic write fault")):
            with self.assertRaises(sqlite3.OperationalError):
                self.collector.poll()
        self.assertEqual(len(self.events()), 3)
        self.assertEqual(self.collector.poll(), 1)
        self.assertEqual(self.collector.poll(), 0)
        self.assertFalse(self.events("operator.action"))
        self.assertEqual([event["barcode"] for event in self.events("label.reread")],
                         ["SYNTH-RETRY", "SYNTH-NEXT"])

    def test_missing_observed_source_emits_gap_once(self):
        self.append_scan("SYNTH-RESTART")
        self.collector.poll()
        self.collector.close()
        self.scans.close()
        self.scan_path.unlink()
        self.assertEqual(self.collector.poll(), 1)
        self.assertEqual(self.collector.poll(), 0)
        self.assertEqual(self.collector.status()["state"], "fault")
        self.assertEqual(self.collector.status()["last_work_at"], NOW)
        self.assertEqual(self.events("operator.action")[0]["detail"]["causes"], ["source_missing"])

    def test_scan_pages_and_pending_poll_do_not_skip_old_updates(self):
        self.reserve("SYNTH-J1")
        self.reserve("SYNTH-J2")
        self.append_scan("SYNTH-FIRST")
        self.append_scan("SYNTH-NEXT")
        with self.prints:
            self.prints.executemany("INSERT INTO queue_attempts(job_id,started_at,outcome) VALUES(?,?,'dispatching')",
                                    [(job, NOW) for job in ("SYNTH-J1", "SYNTH-J2")])
        with patch("field_agent.weigh.legacy.PAGE", 1):
            self.collector.poll()
            self.collector.poll()
            with self.prints:
                self.prints.execute("UPDATE queue_attempts SET outcome='submitted',finished_at=?", (NEXT,))
            self.collector.poll()
            self.collector.poll()
            self.collector.poll()
            self.assertEqual(len(self.events("label.dispatched")), 2)
            self.assertEqual(len(self.events("label.reread")), 2)


if __name__ == "__main__":
    unittest.main()
