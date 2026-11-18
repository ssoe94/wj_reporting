import csv
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from field_agent.barcode_app import BarcodeApp
from field_agent.ledger import Ledger
from field_agent.tests.test_barcode_logic import CONFIG


CODE_A = "TST10000011SYNXYZ00DE"
CODE_B = "TST10000012SYNXYZ007U"
CODE_ANY = "TST30000032SYNXYZ00DE"
ASSIGNMENTS = {"A": "usb:26f1:d001:location:SYNTH-A", "B": "usb:26f1:d001:location:SYNTH-B"}


class BarcodeAppTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.path = root / "config.json"
        self.path.write_text(json.dumps(dict(CONFIG, production_group="50/55", assignments=ASSIGNMENTS)))
        self.ledger = Ledger(root / "ledger.sqlite3", "SYNTH-BARCODE")
        self.addCleanup(self.ledger.close)
        self.time = "2026-01-02T08:00:00+08:00"
        self.updates = []
        self.app = self.open_app()
        self.app.action("mode", {"mode": "production"})

    def open_app(self):
        return BarcodeApp(self.ledger, self.path, lambda **update: self.updates.append(update), lambda: self.time)

    def events(self, kind):
        with self.ledger.read() as conn:
            return [json.loads(row["payload"]) for row in conn.execute(
                "SELECT payload FROM events WHERE kind=? ORDER BY seq", (kind,))]

    def scan(self, lane, code):
        return self.app.receive(lane, code, identity=self.app.scanner_assignments()[lane])

    def counters(self, lane):
        return self.app.snapshot([])["lanes"][lane]["counts"]

    def test_duplicate_scope_and_reset_keep_exact_decisions(self):
        self.assertEqual(self.scan("A", CODE_A).status, "ok")
        self.assertEqual(self.scan("A", CODE_A).status, "duplicate")
        self.assertEqual(self.scan("B", CODE_A).status, "wrong_scanner_A")
        self.assertEqual(self.scan("B", CODE_B).status, "ok")
        self.app.action("reset", {})
        self.assertEqual(self.counters("A"), {"ok": 0, "duplicate": 0, "error": 0})
        self.assertEqual(self.scan("A", CODE_A).status, "ok")
        self.assertEqual(self.scan("A", CODE_A).status, "duplicate")
        self.assertEqual(self.scan("B", CODE_A).status, "wrong_scanner_A")
        self.assertEqual(self.counters("A"), {"ok": 1, "duplicate": 1, "error": 0})
        self.assertEqual(self.counters("B"), {"ok": 0, "duplicate": 0, "error": 1})
        scans = self.events("scan.recorded")
        self.assertEqual([ev["detail"].get("seen_before_reset") for ev in scans], [None] * 4 + [True, None, None])
        self.assertEqual(self.events("operator.action")[0]["detail"]["action"], "reset")
        self.assertTrue(all(len(ev["config_version"]) == 64 for ev in scans))
        self.app = self.open_app()
        self.assertEqual(self.scan("A", CODE_A).status, "duplicate")
        self.assertEqual(self.counters("A")["duplicate"], 2)

    def test_test_mode_is_recorded_and_does_not_change_production_duplicates(self):
        self.app.action("mode", {"mode": "test"})
        self.assertEqual(self.scan("A", CODE_A).status, "ok")
        self.app = self.open_app()
        self.assertEqual(self.app.snapshot([])["mode"], "test")
        self.app.action("mode", {"mode": "production"})
        self.assertEqual(self.scan("A", CODE_A).status, "ok")
        self.assertEqual([ev["mode"] for ev in self.events("mode.changed")], ["production", "test", "production"])
        self.assertEqual([ev["mode"] for ev in self.events("scan.recorded")], ["test", "production"])

    def test_config_changes_and_any_scanner_scope(self):
        original = self.app.config_version
        self.app.action("config", {"production_group": "70/75/86"})
        self.assertNotEqual(self.app.config_version, original)
        self.assertEqual(self.scan("B", CODE_ANY).status, "ok")
        self.assertEqual(self.scan("A", CODE_ANY).status, "duplicate")
        self.assertEqual(self.scan("A", CODE_A).status, "wrong_product_group")
        self.assertEqual(self.scan("B", CODE_ANY + "Z").status, "over21")
        scans = self.events("scan.recorded")
        self.assertEqual(scans[-1]["reason"], "scan_overlength")
        self.assertEqual(scans[0]["detail"]["expected_device"], "ANY")
        swapped = {"A": ASSIGNMENTS["B"], "B": ASSIGNMENTS["A"]}
        self.app.action("config", {"assignments": swapped})
        self.assertIsNone(self.app.receive("A", CODE_ANY, identity=ASSIGNMENTS["A"]))
        self.app.device_status("A", "connected", "COM1", identity=ASSIGNMENTS["A"])
        self.assertFalse(self.app.snapshot([])["lanes"]["A"]["connected"])
        self.assertEqual(len(self.events("config.applied")), 3)
        self.assertEqual(self.events("scan.recorded"), scans)

    def test_commit_failure_does_not_inflate_counts_or_reset_scope(self):
        self.app.device_status("A", "connected", "COM5", identity=ASSIGNMENTS["A"])
        self.assertIsNone(self.app.health()[1][0]["last_input_at"])
        original = self.ledger.transaction

        @contextmanager
        def failed_commit():
            with original() as conn:
                yield conn
                raise sqlite3.OperationalError("synthetic commit fault")

        with patch.object(self.ledger, "transaction", failed_commit):
            self.assertIsNone(self.scan("A", CODE_A))
            with self.assertRaises(RuntimeError):
                self.app.action("reset", {})
        state = self.app.snapshot([])
        self.assertEqual(state["reset_id"], 0)
        self.assertTrue(state["storage_error"])
        self.assertEqual(state["lanes"]["A"]["last_input_at"], self.time)
        self.assertEqual(self.counters("A")["ok"], 0)
        self.assertFalse(self.events("scan.recorded"))
        self.app.frame_error("A", "decode", identity=ASSIGNMENTS["A"])
        self.assertTrue(self.app.snapshot([])["storage_error"])
        self.assertEqual(self.scan("A", CODE_A).status, "ok")
        self.assertFalse(self.app.snapshot([])["storage_error"])
        self.assertEqual(self.app.health()[2], "partial")

    def test_shift_counter_boundary_csv_and_append_only(self):
        self.time = "2026-01-02T07:59:59+08:00"
        self.assertEqual(self.scan("A", CODE_A).status, "ok")
        self.time = "2026-01-02T08:00:00+08:00"
        self.assertEqual(self.counters("A")["ok"], 0)
        self.assertEqual(self.scan("A", CODE_A).status, "duplicate")
        self.assertEqual(self.scan("B", "=SYNTH").status, "invalid")
        text = b"".join(self.app.csv("zh")).decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text)))
        self.assertEqual(rows[0], ["Time", "Scanner", "Barcode", "Size", "ProductGroup", "Status", "StatusText"])
        self.assertEqual(rows[1][4:], ["50/55", "ok", "正常"])
        self.assertEqual(rows[2][5:], ["duplicate", "重复"])
        self.assertEqual(rows[3][2], "'=SYNTH")
        with self.assertRaises(sqlite3.IntegrityError), self.ledger.transaction() as conn:
            conn.execute("DELETE FROM barcode_decisions")
        self.app.action("reset", {})
        text = b"".join(self.app.csv("ko")).decode("utf-8-sig")
        self.assertEqual(len(text.splitlines()), 1)

    def test_replaced_rule_file_does_not_reclassify_past_events(self):
        self.assertEqual(self.scan("A", CODE_A).status, "ok")
        scans = self.events("scan.recorded")
        rules = dict(CONFIG, production_group="50/55", assignments=ASSIGNMENTS)
        rules["part_rules"] = [part for part in CONFIG["part_rules"] if part["part_no"] not in CODE_A]
        self.path.write_text(json.dumps(rules))
        self.app = self.open_app()
        self.assertEqual(self.events("scan.recorded"), scans)
        self.assertEqual(self.scan("A", CODE_A).status, "invalid")
        self.assertNotEqual(self.app.config_version, scans[0]["config_version"])
