"""Synthetic tests of the shared weighing, output and scan ledger."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta

import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from field_agent.ledger import Ledger
from field_agent.protocol import business_day, event_time, timestamp
from field_agent.weigh.app import WeighApp, make_devices
from field_agent.weigh.devices import FakePrinter, FakeScale, FakeScanner
from field_agent.weigh.hardware_io import HardwareError
from field_agent.weigh.label_code import parse_label_code
from field_agent.weigh.reread import reporting_product
from field_agent.weigh.serials import make_barcode
from field_agent.weigh.settings import Settings


NOW = "2026-01-02T08:00:00.000+08:00"
PART = "TST10000001"
OTHER = "TST10000002"


def settings(*, mode="production", columns=1, peel=False, scanner="A", legacy_print_db=None,
             approved_templates=False, unproved_values=False):
    products = []
    for part, name in ((PART, "Synthetic A"), (OTHER, "Synthetic B")):
        products.append({"part_no": part, "name": name, "model": "55", "unit_weight_g": "20",
                         "calibration_g": ["20", "40", "60", "80", "100"], "calibrated_at": NOW,
                         "scanner": scanner, "columns": columns, "peel": peel,
                         "template": {"language": "zpl", "prefix": "^XA", "suffix": "^XZ",
                                      "cells": ["^FO" + str(10 + 150*i) + ",10^FD{barcode}^FS" for i in range(columns)]}})
    if approved_templates:
        for item in products:
            item["templates"] = [{
                "id": "reviewed", "name_ko": "승인 예제", "name_zh": "批准示例",
                "columns": 2,
                "fields": [{"key": "rev", "label_ko": "리비전", "label_zh": "版本", "max_length": 12, "default": "REV-A"}],
                "template": {"language": "zpl", "prefix": "^XA", "suffix": "^XZ", "cells": [
                    "^FO10,10^FD{barcode}^FS^FO10,20^FD{rev}^FS",
                    "^FO50,10^FD{barcode}^FS^FO50,20^FD{rev}^FS",
                ]},
            }]
    return Settings({"mode": mode, "products": products, "site_code": "S", "vendor_code": "YN",
                     "legacy_print_db": str(legacy_print_db) if legacy_print_db else None,
                     "serial_floors": {OTHER: {NOW[:10]: 100}} if unproved_values else {}})


class WeighAppTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.ledger = Ledger(Path(directory.name) / "field.sqlite3", "SYNTH-WEIGH")
        self.addCleanup(self.ledger.close)
        self.clock = 0.0
        self.moment = event_time(NOW)
        self.reset()
        self.app.store.confirm_no_issuance(PART, "Synthetic empty station", "SYNTH-ADMIN")

    def reset(self, config=None, printer=None):
        self.config = config or settings()
        self.printer = printer or FakePrinter()
        self.scale = FakeScale()
        self.scanner = FakeScanner()
        self.notifications = []
        self.app = WeighApp(self.ledger, self.config, (self.scale, self.printer, self.scanner, None),
                            lambda **kw: self.notifications.append(kw), clock=lambda: timestamp(self.moment),
                            tick=lambda: self.clock)

    def segment(self, grams, *, count=14, mode="GS", status="US"):
        for _ in range(count):
            self.clock += .1
            self.moment += timedelta(milliseconds=100)
            self.scale.add_weight(grams, status, mode)
            self.app.feed_scale(self.scale.read())

    def load(self, grams=20):
        self.segment(0)
        self.segment(grams)

    def events(self, kind):
        with self.ledger.read() as conn:
            return [json.loads(row["payload"]) for row in conn.execute(
                "SELECT payload FROM events WHERE kind=? ORDER BY seq", (kind,))]

    def jobs(self):
        with self.ledger.read() as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM weigh_jobs ORDER BY sequence")]

    def queue(self):
        return self.app.snapshot()["queue"]

    def test_exact_pass_reservation_transport_and_linked_reread(self):
        self.load()
        reserved = self.events("label.reserved")
        self.assertEqual(len(reserved), 1)
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.assertEqual(len(self.printer.sent), 1)
        job = self.jobs()[0]
        result = self.app.reread(job["barcode"], "A")
        self.assertEqual((result["status"], result["label_origin"], result["job_id"], result["label_index"]),
                         ("ok", "local", job["job_id"], 0))
        groups = ("weigh.result", "label.reserved", "label.dispatched", "label.reread")
        evidence = [self.events(group)[0] for group in groups]
        self.assertEqual(len({event["config_version"] for event in evidence}), 1)
        self.assertEqual(evidence[2]["detail"]["job_ids"], [job["job_id"]])

    def test_ng_exact_boundary_is_recorded_only_once_per_load(self):
        self.load(21)
        self.segment(21, count=25)
        rows = self.events("weigh.result")
        self.assertEqual([(row["result"], row["reason"]) for row in rows], [("ng", "weight_outside_limit")])
        self.assertEqual(self.jobs(), [])
        self.assertFalse(self.printer.attempts)
        self.segment(2)
        self.segment(20)
        self.assertEqual([row["result"] for row in self.events("weigh.result")], ["ng", "ok"])

    def test_stable_nonempty_requires_rezero_after_gap_mode_or_invalid_frame(self):
        self.segment(20)
        self.assertFalse(self.jobs())
        self.load()
        self.clock += 0.51
        self.segment(20)
        self.segment(20, mode="NT")
        self.app.feed_scale(b"x" * 257 + b"\n")
        self.segment(20, mode="NT")
        self.app.feed_scale(b"ST,NT,+20 g\n", seen_at=self.clock - .51)
        self.assertEqual(len(self.events("weigh.result")), 1)
        self.segment(0, mode="NT")
        self.segment(20, mode="NT")
        self.assertEqual(len(self.events("weigh.result")), 2)

    def test_uncertain_partial_write_never_retries_and_requires_explicit_resume(self):
        self.printer.inject("uncertain")
        self.load()
        self.assertEqual(self.app.dispatch_once(), "uncertain")
        row = self.queue()["uncertain_ids"][0]
        self.assertEqual(self.app.reread(self.jobs()[0]["barcode"], "A")["status"], "uncertain")
        self.clock += 20
        self.assertIsNone(self.app.dispatch_once())
        self.assertEqual(len(self.printer.attempts), 1)
        self.assertRaises(ValueError, self.app.action, "resume", {})
        self.app.action("acknowledge", {"job_id": row, "confirmed_quantity": 0})
        self.assertTrue(self.queue()["paused"])
        self.assertEqual(self.app.reread(self.jobs()[0]["barcode"], "A")["status"], "unprinted")
        self.app.action("resume", {})
        self.load()
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.assertEqual([job["serial"] for job in self.jobs()], [1, 2])
        self.assertEqual([event["reason"] for event in self.events("label.dispatched")],
                         ["print_uncertain", "print_submitted"])

    def test_only_positive_proof_of_unsent_retries_exact_frozen_payload(self):
        self.printer.inject("rejected_unsent")
        self.load()
        barcode = self.jobs()[0]["barcode"]
        self.assertEqual(self.app.dispatch_once(), "not_sent")
        self.assertEqual(self.app.reread(barcode, "A")["status"], "unprinted")
        self.assertIsNone(self.app.dispatch_once())
        self.clock += 2.01
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.assertEqual(len(self.printer.attempts), 2)
        self.assertEqual(self.printer.attempts[0], self.printer.attempts[1])
        self.assertEqual(len(self.events("label.reserved")), 1)

    def test_waiting_jobs_resume_explicitly_after_restart(self):
        self.load()
        self.reset()
        self.assertEqual(self.queue()["pause_reason"], "restart_queue")
        self.assertIsNone(self.app.dispatch_once())
        self.app.action("resume", {})
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.assertEqual(len(self.printer.attempts), 1)

    def test_interrupted_committed_dispatch_recovers_to_uncertain(self):
        self.load()
        row, _ = self.app.store.begin_dispatch()
        self.reset()
        self.assertEqual(self.queue()["uncertain_ids"], [row["row_id"]])
        self.assertIsNone(self.app.dispatch_once())
        self.assertFalse(self.printer.attempts)
        self.assertEqual(self.events("label.dispatched")[0]["detail"]["cause"], "interrupted")

    def test_three_column_tail_waits_for_operator_and_preserves_physical_attempt(self):
        self.reset(settings(columns=3))
        self.load(40)
        self.assertEqual(self.queue()["partial"], 2)
        self.assertIsNone(self.app.dispatch_once())
        self.app.action("flush", {})
        self.assertEqual(self.app.dispatch_once(), "submitted")
        event = self.events("label.dispatched")[0]
        self.assertEqual(event["detail"]["job_ids"], [job["job_id"] for job in self.jobs()])
        self.assertEqual(len(event["detail"]["job_ids"]), 2)
        self.assertEqual(self.events("queue.partial_flush")[0]["detail"]["columns"], 3)
        self.assertEqual(self.printer.sent[0].count(b"^XA"), 1)
        self.assertEqual(self.printer.sent[0].count(b"^XZ"), 1)
        self.assertIn(b"^FO160,10", self.printer.sent[0])

    def test_multicolumn_full_row_spans_cycles_and_tail_is_reported(self):
        self.reset(settings(columns=3))
        self.load(40)
        self.load(40)
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.assertEqual(self.queue()["partial"], 1)
        self.assertIsNone(self.app.dispatch_once())
        self.assertEqual(len(self.printer.sent), 1)

    def test_peel_requires_waiting_then_ready_or_explicit_clear(self):
        self.reset(settings(peel=True), FakePrinter(peel=True))
        self.load(40)
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.printer.set_label_waiting(False)
        self.assertIsNone(self.app.dispatch_once())
        self.assertTrue(self.queue()["peel_wait"])
        self.printer.set_label_waiting(True)
        self.app.dispatch_once()
        self.printer.set_label_waiting(False)
        self.app.dispatch_once()
        self.assertFalse(self.queue()["peel_wait"])
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.printer.set_label_waiting(False)
        self.app.action("peel", {})
        self.assertFalse(self.queue()["peel_wait"])

    def test_partial_reconciliation_requires_per_label_review(self):
        self.reset(settings(columns=3))
        self.printer.inject("uncertain")
        self.load(60)
        self.app.dispatch_once()
        self.app.action("acknowledge", {"job_id": self.queue()["uncertain_ids"][0], "confirmed_quantity": 1})
        self.assertTrue(all(self.app.reread(job["barcode"], "A")["status"] == "review_required" for job in self.jobs()))

    def test_wireless_external_wrong_part_and_cross_lane_duplicate(self):
        local_date = event_time(NOW).date()
        external = make_barcode(PART, 33, self.config.code, local_date)
        wrong = make_barcode(OTHER, 33, self.config.code, local_date)
        seen = self.app.reread(external, "W")
        self.assertEqual((seen["status"], seen["label_origin"], seen["device"]), ("ok", "external", "W"))
        self.assertEqual(self.app.reread(external, "B")["status"], "duplicate")
        self.assertEqual(self.app.reread(wrong, "W")["status"], "wrong_part")
        wire = self.events("label.reread")[0]
        self.assertEqual((wire["device"], wire["detail"]["legacy_slot"]), ("W", "A"))
        self.assertFalse(wire["ref"])

    def test_reused_request_identity_is_strict_but_retry_adds_no_event(self):
        code = make_barcode(PART, 34, self.config.code, event_time(NOW).date())
        first = self.app.reread(code, "W", request_id="same-one", moment=NOW)
        self.assertEqual(self.app.reread(code, "W", request_id="same-one", moment=NOW), first)
        self.assertRaises(ValueError, self.app.reread, code, "B", request_id="same-one", moment=NOW)
        self.assertEqual(len(self.events("label.reread")), 1)

    def test_concurrent_scanners_accept_a_barcode_only_once(self):
        self.load()
        self.app.dispatch_once()
        code = self.jobs()[0]["barcode"]
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: self.app.store.reread(code, "A"), range(16)))
        self.assertEqual(sum(row["status"] == "ok" for row in results), 1)
        self.assertEqual(sum(row["status"] == "duplicate" for row in results), 15)

    def test_manual_keyboard_and_test_evidence_keep_physical_input(self):
        self.load()
        self.app.dispatch_once()
        code = self.jobs()[0]["barcode"]
        self.assertEqual(self.app.reread(code, "KEYBOARD", source="manual")["status"], "manual_entry")
        self.assertEqual(self.app.reread(code, "KEYBOARD", source="demo")["status"], "test_scan")
        self.assertEqual(self.app.reread(code, "KEYBOARD", source="keyboard")["status"], "ok")
        rows = self.events("label.reread")
        self.assertEqual([row["mode"] for row in rows], ["manual", "test", "production"])
        self.assertTrue(all(row["device"] == "KEYBOARD" and row["detail"]["legacy_slot"] == "A" for row in rows))

    def test_source_ledger_error_does_not_turn_into_external(self):
        code = make_barcode(PART, 34, self.config.code, event_time(NOW).date())
        with patch.object(self.app.store, "_lookup", side_effect=sqlite3.DatabaseError("synthetic read failure")):
            result = self.app.reread(code, "A")
        self.assertEqual((result["status"], result["label_origin"]), ("ledger_error", "unknown"))

    def test_resolution_failure_keeps_send_guard_and_restart_never_resends(self):
        self.load()
        with patch.object(self.app.store, "finish", side_effect=sqlite3.OperationalError("failed result commit")):
            self.assertIsNone(self.app.dispatch_once())
        self.assertEqual(len(self.printer.attempts), 1)
        self.assertTrue(self.app.snapshot()["storage_error"])
        self.assertIsNone(self.app.dispatch_once())
        self.reset()
        self.assertIsNone(self.app.dispatch_once())
        self.assertFalse(self.printer.attempts)
        self.assertEqual(self.events("label.dispatched")[0]["reason"], "print_uncertain")

    def test_ledger_write_failure_prevents_reservation_and_print_with_exact_rollback(self):
        original = self.ledger.transaction

        @contextmanager
        def fail_commit():
            with original() as conn:
                yield conn
                raise sqlite3.OperationalError("synthetic full disk at commit")

        with patch.object(self.ledger, "transaction", fail_commit):
            self.load()
        self.assertTrue(self.app.snapshot()["storage_error"])
        self.assertIsNone(self.app.dispatch_once())
        self.assertEqual(self.jobs(), [])
        self.assertEqual(self.events("weigh.result"), [])
        self.assertFalse(self.printer.attempts)
        self.app.action("resume", {})
        self.load()
        self.assertEqual(self.jobs()[0]["serial"], 1)

    def test_serial_floor_preserves_existing_reservations_on_cutover(self):
        path = self.ledger.path.parent / "legacy-synthetic.sqlite3"
        with sqlite3.connect(path) as conn:
            conn.executescript("""CREATE TABLE serials(part_no TEXT, print_date TEXT, last_serial INTEGER);
                CREATE TABLE jobs(part_no TEXT, print_date TEXT, last_serial INTEGER);""")
            conn.execute("INSERT INTO serials VALUES(?,?,?)", (OTHER, NOW[:10], 8))
            conn.execute("INSERT INTO jobs VALUES(?,?,?)", (OTHER, NOW[:10], 60))
        original = path.read_bytes()
        self.reset(settings(legacy_print_db=path))
        self.app.action("product", {"part_no": OTHER})
        self.load()
        self.assertEqual(self.jobs()[0]["serial"], 61)
        self.assertEqual(path.read_bytes(), original)

    def test_cancelled_waiting_labels_never_confirm_or_reuse_serial(self):
        self.load()
        self.reset()  # pending output reopens paused
        old = self.jobs()[0]
        self.app.action("cancel_waiting", {})
        self.assertEqual(self.app.reread(old["barcode"], "A")["status"], "unprinted")
        self.assertIn("label_cancelled", [event["reason"] for event in self.events("operator.action")])
        self.app.action("resume", {})
        self.load()
        self.assertEqual([job["serial"] for job in self.jobs()], [1, 2])

    def test_known_permanent_rejection_remains_paused(self):
        class WrongLanguage:
            def __call__(self, _payload):
                error = HardwareError("LANGUAGE_MISMATCH", "synthetic mismatch")
                error.print_data_sent = False
                raise error

        self.reset(printer=WrongLanguage())
        self.load()
        self.assertEqual(self.app.dispatch_once(), "not_sent")
        self.assertEqual(self.queue()["pause_reason"], "printer_configuration")
        self.clock += 5
        self.assertIsNone(self.app.dispatch_once())
        self.assertEqual(len(self.events("label.dispatched")), 1)

    def test_frozen_payload_and_duplicate_attempt_finish(self):
        self.load()
        row, attempt = self.app.store.begin_dispatch()
        for stmt in ("UPDATE weigh_jobs SET fragments='{}'", "UPDATE weigh_rows SET payload=X'00'"):
            with self.assertRaises(sqlite3.IntegrityError), self.ledger.transaction() as conn:
                conn.execute(stmt)
        self.app.store.finish(row, attempt, "submitted")
        self.app.store.finish(row, attempt, "uncertain")
        self.assertEqual(len(self.events("label.dispatched")), 1)
        self.assertEqual(self.app.store.queue()["submitted"], 1)

    def test_calendar_serial_date_and_0800_workday_are_separate(self):
        self.moment -= timedelta(hours=1)
        self.load()
        first = self.jobs()[0]
        self.assertEqual(first["print_date"], NOW[:10])
        self.assertEqual(business_day(event_time(self.events("weigh.result")[0]["occurred_at"])), "2026-01-01")
        self.moment += timedelta(hours=1)
        self.load()
        self.assertEqual([job["serial"] for job in self.jobs()], [1, 2])

    def test_test_label_cannot_count_as_production_reread(self):
        self.reset(settings(mode="test"))
        self.load()
        self.app.dispatch_once()
        saved = self.jobs()[0]
        self.reset()
        result = self.app.reread(saved["barcode"], "A")
        self.assertEqual(result["status"], "review_required")

    def test_wrong_part_lane_and_duplicate_are_preserved_across_restart(self):
        self.load()
        self.app.dispatch_once()
        code = self.jobs()[0]["barcode"]
        self.app.action("product", {"part_no": OTHER})
        self.assertEqual(self.app.reread(code, "A")["status"], "wrong_part")
        self.app.action("product", {"part_no": PART})
        self.assertEqual(self.app.reread(code, "B")["status"], "wrong_scanner_A")
        self.assertEqual(self.app.reread(code, "A")["status"], "ok")
        self.reset()
        self.assertEqual(self.app.reread(code, "W")["status"], "duplicate")

    def test_raw_invalid_input_stays_in_sqlite_and_wire_omission_is_explicit(self):
        raw = "SYNTH-\0-INVALID"
        self.assertEqual(self.app.reread(raw, "A")["status"], "invalid")
        with self.ledger.read() as conn:
            stored = conn.execute("SELECT raw_barcode FROM weigh_scans").fetchone()[0]
        self.assertEqual(stored, raw)
        event = self.events("label.reread")[0]
        self.assertNotIn("\0", event["barcode"])
        self.assertTrue(event["detail"]["source_value_omitted"])

    def test_scan_confirmation_and_attempt_rollback_together(self):
        code = make_barcode(PART, 32, self.config.code, event_time(NOW).date())
        original = self.ledger.transaction

        @contextmanager
        def failed_scan():
            with original() as conn:
                yield conn
                raise sqlite3.OperationalError("synthetic scan commit fault")

        with patch.object(self.ledger, "transaction", failed_scan):
            self.assertRaises(sqlite3.OperationalError, self.app.store.reread, code, "A", request_id="test-scan")
        with self.ledger.read() as conn:
            self.assertFalse(conn.execute("SELECT 1 FROM weigh_scans").fetchone())
            self.assertFalse(conn.execute("SELECT 1 FROM weigh_confirmations").fetchone())
        self.assertEqual(self.app.store.reread(code, "A", request_id="test-scan")["status"], "ok")

    def test_scale_and_k50l_cannot_own_the_same_serial_port(self):
        self.config.devices.update(scale={"port": "COM5"}, printer={"printer_mode": "tcp"},
                                   signal={"light_mode": "k50l_serial", "light_serial_port": "com5"})
        with self.assertRaisesRegex(ValueError, "different ports"):
            make_devices(self.config)

    def test_unverified_part_blocks_reservation_and_resume(self):
        self.app.action("product", {"part_no": OTHER})
        self.load()
        self.assertEqual(self.queue()["pause_reason"], "serial_floor_required")
        self.assertEqual(self.jobs(), [])
        self.assertEqual(self.app.snapshot()["last_result"]["reservation_blocked"], "serial_floor_required")
        with self.assertRaisesRegex(ValueError, "evidence"):
            self.app.action("resume", {})
        self.assertIsNone(self.app.dispatch_once())
        self.assertEqual(len(self.events("weigh.result")), 1)
        self.assertEqual(self.events("label.reserved"), [])

    def test_admin_confirmation_is_attributable_and_survives_restart(self):
        self.app.action("product", {"part_no": OTHER})
        self.load()
        with self.assertRaises(ValueError):
            self.app.store.confirm_no_issuance(OTHER, "", "SYNTH-ADMIN")
        self.app.store.confirm_no_issuance(OTHER, "Synthetic independent issuer check", "SYNTH-ADMIN")
        proof = [event for event in self.events("operator.action") if event["reason"] == "serial_no_issuance_confirmed"][-1]
        self.assertEqual((proof["part_no"], proof["detail"]["actor"], proof["detail"]["date_code"]),
                         (OTHER, "SYNTH-ADMIN", "612"))
        self.assertEqual(proof["detail"]["reason"], "Synthetic independent issuer check")
        self.reset()
        self.app.action("resume", {})
        self.load()
        self.assertEqual(self.jobs()[0]["serial"], 1)
        self.app.dispatch_once()
        with self.assertRaisesRegex(ValueError, "already"):
            self.app.store.confirm_no_issuance(OTHER, "Synthetic duplicate confirmation", "SYNTH-ADMIN")
        self.load()
        self.assertEqual([row["serial"] for row in self.jobs()], [1, 2])

    def test_configured_missing_or_empty_legacy_source_still_blocks(self):
        path = self.ledger.path.parent / "empty-synthetic.sqlite3"
        self.reset(settings(legacy_print_db=path))
        self.app.action("product", {"part_no": OTHER})
        self.load()
        self.assertEqual(self.queue()["pause_reason"], "serial_source_unavailable")
        self.assertFalse(path.exists())
        with sqlite3.connect(path) as conn:
            conn.executescript("""CREATE TABLE serials(part_no TEXT, print_date TEXT, last_serial INTEGER);
                CREATE TABLE jobs(part_no TEXT, print_date TEXT, last_serial INTEGER);""")
        with self.assertRaisesRegex(ValueError, "evidence"):
            self.app.action("resume", {})

    def test_no_issuance_confirmation_is_date_specific(self):
        self.moment += timedelta(days=1)
        self.load()
        self.assertEqual(self.queue()["pause_reason"], "serial_floor_required")
        self.assertFalse(self.jobs())

    def test_old_config_floor_alone_cannot_authorize_issuance(self):
        self.reset(settings(unproved_values=True))
        self.app.action("product", {"part_no": OTHER})
        self.load()
        self.assertEqual(self.queue()["pause_reason"], "serial_floor_required")
        self.assertFalse(self.jobs())

    def test_same_printed_date_code_in_new_decade_does_not_reissue_old_barcode(self):
        self.load()
        self.app.dispatch_once()
        first = self.jobs()[0]["barcode"]
        self.moment = self.moment.replace(year=self.moment.year + 10)
        self.load()
        self.assertEqual(self.queue()["pause_reason"], "serial_floor_required")
        self.app.store.confirm_no_issuance(PART, "Synthetic new calendar date", "SYNTH-ADMIN")
        self.app.action("resume", {})
        self.load()
        self.assertEqual([row["serial"] for row in self.jobs()], [1, 2])
        self.assertNotEqual(first, self.jobs()[1]["barcode"])

    def test_approved_template_preview_values_and_queue_guard(self):
        self.reset(settings(approved_templates=True))
        self.assertFalse(self.jobs())
        self.assertEqual(len(self.app.snapshot()["labels"]["templates"]), 2)
        with self.assertRaises(ValueError):
            self.app.action("template", {"template_id": "reviewed", "values": {"rev": "^XZ"}})
        with self.assertRaises(ValueError):
            self.app.action("template", {"template_id": "reviewed", "values": {"barcode": "SYNTH"}})
        self.app.action("template", {"template_id": "reviewed", "values": {"rev": "REV-B"}})
        self.assertEqual(self.app.snapshot()["labels"]["preview"]["columns"], 2)
        self.assertIn("REV-B", self.app.snapshot()["labels"]["preview"]["cells"][0]["text"])
        self.assertFalse(self.jobs())
        configured = self.events("config.applied")[-1]["config_version"]
        self.load(40)
        self.assertEqual(self.events("label.reserved")[0]["config_version"], configured)
        with self.assertRaises(ValueError):
            self.app.action("template", {"template_id": "default", "values": {}})
        self.assertEqual(self.app.dispatch_once(), "submitted")
        self.assertIn(b"REV-B", self.printer.sent[0])
        self.reset(settings(approved_templates=True))
        self.assertEqual(self.app.snapshot()["labels"]["values"], {"rev": "REV-B"})

    def test_job_progress_keyboard_and_manual_evidence(self):
        self.reset(settings(columns=2))
        self.load(40)
        first, second = self.jobs()
        self.assertEqual(self.app.snapshot()["jobs"][0]["reserved"], 2)
        self.app.dispatch_once()
        self.assertEqual(self.app.snapshot()["jobs"][0]["unconfirmed"], 2)
        self.app.action("reread", {"barcode": first["barcode"], "request_id": "typing-1", "source": "manual"})
        self.assertEqual(self.app.snapshot()["last_reread"]["status"], "manual_entry")
        payload = {"barcode": first["barcode"], "request_id": "wedge-1", "source": "keyboard"}
        self.app.action("reread", payload)
        self.app.action("reread", payload)
        self.assertEqual(self.app.snapshot()["last_reread"]["device"], "KEYBOARD")
        self.assertEqual(self.app.snapshot()["jobs"][0]["confirmed"], 1)
        self.assertEqual(self.app.snapshot()["jobs"][0]["unconfirmed"], 1)
        self.assertEqual(len(self.events("label.reread")), 2)
        self.app.reread(second["barcode"], "A")
        self.assertEqual(self.app.snapshot()["jobs"][0]["unconfirmed"], 0)

    def test_explicit_pause_then_cancel_stays_paused_until_acknowledged_resume(self):
        self.reset(settings(columns=3))
        self.load(40)
        self.app.action("pause", {})
        self.assertEqual(self.queue()["pause_reason"], "operator_pause")
        self.app.action("cancel_waiting", {})
        self.assertTrue(self.queue()["paused"])
        self.assertEqual(self.app.snapshot()["jobs"][0]["state"], "cancelled")
        self.app.action("resume", {})
        reasons = [item["reason"] for item in self.events("operator.action")]
        self.assertIn("weigh_queue_paused", reasons)
        self.assertEqual(reasons.count("label_cancelled"), 2)
        self.assertIn("weigh_queue_resumed", reasons)
        self.load(20)
        self.assertEqual([row["serial"] for row in self.jobs()], [1, 2, 3])

    def test_pause_stops_future_dispatch_without_rewriting_inflight_attempt(self):
        self.load(40)
        row, attempt = self.app.store.begin_dispatch()
        self.app.action("pause", {})
        self.assertEqual(self.queue()["dispatching"], 1)
        self.assertEqual(self.queue()["pause_reason"], "operator_pause")
        self.app.store.finish(row, attempt, "submitted")
        self.assertTrue(self.app.store.queue()["paused"])
        self.assertEqual(self.app.store.queue()["waiting"], 1)
        self.assertIsNone(self.app.dispatch_once())

    def test_label_parser_preserves_structural_checks_and_report_sizes(self):
        selected = event_time(NOW).date()
        code = make_barcode(PART, 35, self.config.code, selected)
        self.assertEqual(parse_label_code(code, [PART], today=selected, **self.config.code)["serial"], 35)
        for bad, evidence in [(code[:-1] + "I", "serial"), (code[:-4] + "0000", "serial"),
                              (code[:11] + "BAD" + code[14:], "site_vendor")]:
            self.assertEqual(parse_label_code(bad, [PART], today=selected, **self.config.code)["error"], evidence)
        self.assertEqual(reporting_product("85"), ("85", "70/75/86"))
        self.assertEqual(reporting_product("OLED 55 - C7/97"), ("55", "50/55"))
