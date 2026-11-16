"""Use synthetic publication markers only; no real camera, photo or source store."""

from hashlib import sha256
import json
from pathlib import Path
import tempfile
from unittest import TestCase, mock

from field_agent.ledger import Ledger
from field_agent.vision_folders import CaptureCollector, UVCollector


DAY = "2026-01-02"


def capture_record(root, identifier, *, pair=None, side=None, source="wj_reporting", branch="production",
                   part="SYNTH-PART", trigger="automatic", time=None, extra=None):
    root = root if root.name == branch else root / branch
    folder = root / DAY / part
    folder.mkdir(parents=True, exist_ok=True)
    value = {
        "schema_version": 1, "capture_id": identifier, "timestamp": time or DAY + "T08:01:02.345+08:00",
        "image_file": identifier + ".png", "sha256": sha256(identifier.encode()).hexdigest(),
        "app_version": "0.2.0", "is_simulated": branch == "demo", "trigger": trigger,
        "product_code": part, "production": {"source": source, "part_no": part},
        "operator": "SYNTH-NOT-WIRE", "lot": "SYNTH-PRIVATE-LOT", "quality_label": "unreviewed",
    }
    if pair is not None:
        value.update(pair_id=pair, capture_side=side, capture_sequence=1 if side == "front" else 2)
    value.update(extra or {})
    # Only file existence is needed for this fixture. The media is neither
    # generated from an image nor loaded by the adapter.
    (folder / value["image_file"]).touch()
    path = folder / (identifier + ".json")
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def uv_record(root, identifier, *, mode="manual", invalid=None, slots=10):
    folder = root / mode / DAY / identifier
    folder.mkdir(parents=True, exist_ok=True)
    products = []
    for item in range(slots):
        alarms = ["point_1"] if item == 1 else []
        products.append({
            "position": item + 1, "barcode": "SYNTH-{}".format(item + 1),
            "point_1_percent": 10.96849321234567, "point_2_percent": 100,
            "alarms": alarms, "passed": not alarms,
        })
    value = {"batch_id": identifier, "recorded_at": DAY + "T08:03:02.124567+08:00",
             "passed": all(item["passed"] for item in products), "products": products,
             "recipe": {"slots": [{} for _ in products], "coverage_percent": 12.0},
             "capture": {"mode": "simulation" if mode == "demo" else "manual"},
             }
    if invalid is not None:
        invalid(value)
    (folder / "uv.png").touch()
    (folder / "barcode.png").touch()
    path = folder / "result.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


class VisionFolderTests(TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.capture_root = self.root / "captures"
        self.uv_root = self.root / "batch_results"
        self.ledger = Ledger(self.root / "agent.sqlite3", "SYNTH-FOLDERS")
        self.addCleanup(self.ledger.close)

    def work(self, collector, rounds=10):
        self.addCleanup(collector.close)
        return sum(collector.poll() for _ in range(rounds))

    def events(self, kind=None):
        with self.ledger.read() as conn:
            events = [json.loads(row["payload"]) for row in conn.execute("SELECT payload FROM events ORDER BY seq")]
        return [event for event in events if kind is None or event["type"] == kind]

    def test_capture_requires_two_sides_then_survives_restart_and_ignores_uncommitted(self):
        front = capture_record(self.capture_root, "first", pair="pair1", side="front")
        old = front.read_bytes()
        (front.parent / "no-sidecar.png").touch()
        (front.parent / ".capture-ignore.tmp").write_text("temporary", encoding="utf-8")
        collector = CaptureCollector(self.ledger, self.capture_root, auto_mode="production")
        self.assertEqual(self.work(collector), 0)
        self.assertEqual(self.events(), [])
        before = collector.metadata_bytes_read
        self.assertEqual(self.work(collector), 0)
        self.assertEqual(collector.metadata_bytes_read, before)
        collector.close()
        back = capture_record(self.capture_root, "second", pair="pair1", side="back",
                              time=DAY + "T08:01:05.000+08:00")
        with mock.patch("field_agent.vision_folders.os.open", wraps=__import__("os").open) as tracked:
            resumed = CaptureCollector(self.ledger, self.capture_root, auto_mode="production")
            self.assertEqual(self.work(resumed), 1)
            opened = [str(call.args[0]) for call in tracked.call_args_list]
            self.assertTrue(opened and all(path.endswith(".json") for path in opened))
        self.assertEqual(front.read_bytes(), old)
        self.assertTrue(back.exists())
        event, = self.events()
        self.assertEqual((event["mode"], event["reason"], event["ref"]["pair_id"]),
                         ("production", "capture_pair_saved", "pair1"))
        self.assertEqual(event["occurred_at"], DAY + "T08:01:05.000+08:00")
        self.assertEqual([entry["id"] for entry in event["evidence"]], ["first", "second"])
        self.assertEqual(event["evidence"][0]["sha256"], sha256(b"first").hexdigest())
        self.assertNotIn("SYNTH-PRIVATE-LOT", json.dumps(event))
        self.assertNotIn("SYNTH-NOT-WIRE", json.dumps(event))
        self.assertEqual(self.work(resumed), 0)
        self.assertEqual(resumed.status()["last_work_at"], event["occurred_at"])
        self.assertEqual(resumed.status()["state"], "running")
        self.assertEqual(resumed.status()["mode"], "production")
        resumed.close()
        self.assertEqual(CaptureCollector(self.ledger, self.capture_root).status()["mode"], "production")

    def test_capture_auto_and_manual_modes_and_conflicting_committed_faces(self):
        capture_record(self.capture_root, "manual", trigger="manual", source="manual")
        capture_record(self.capture_root, "demo", trigger="manual", branch="demo")
        capture_record(self.capture_root, "autoA", pair="incomplete", side="front")
        capture_record(self.capture_root, "autoB", pair="incomplete", side="front")
        capture_record(self.capture_root, "autoC", pair="unknown", side="back")
        capture_record(self.capture_root, "autoD", pair="unknown", side="front")
        capture_record(self.capture_root, "autoE", pair="manualpair", side="front", source="manual")
        capture_record(self.capture_root, "autoF", pair="manualpair", side="back", source="manual")
        observer = CaptureCollector(self.ledger, self.capture_root)
        self.assertEqual(self.work(observer, rounds=20), 5)
        modes = {row["mode"] for row in self.events("capture.single")}
        self.assertEqual(modes, {"manual", "demo"})
        pairs = {row["ref"]["pair_id"]: row for row in self.events("capture.pair")}
        self.assertEqual(pairs["unknown"]["mode"], "unknown")
        self.assertEqual(pairs["manualpair"]["mode"], "manual")
        self.assertEqual(pairs["incomplete"]["reason"], "capture_pair_incomplete")
        self.assertEqual(pairs["incomplete"]["detail"]["cause"], "duplicate_capture_side")
        capture_record(self.capture_root, "late", pair="incomplete", side="back")
        self.assertEqual(self.work(observer), 1)
        self.assertEqual(len(self.events("capture.pair")), 3)
        self.assertEqual(self.events()[-1]["reason"], "vision_source_gap")

    def test_capture_provenance_conflict_cannot_be_a_complete_capture(self):
        capture_record(self.capture_root, "front", pair="p", side="front")
        capture_record(self.capture_root, "back", pair="p", side="back", extra={"lot": "SYNTH-OTHER"})
        observer = CaptureCollector(self.ledger, self.capture_root)
        self.assertEqual(self.work(observer), 1)
        result, = self.events("capture.pair")
        self.assertEqual(result["detail"]["cause"], "capture_provenance_conflict")
        self.assertEqual(result["result"], "error")

    def test_capture_never_walks_reparse_or_linked_paths_and_detects_lost_records(self):
        first = capture_record(self.capture_root, "kept", trigger="manual")
        outside = self.root / "other"
        foreign = capture_record(outside, "foreign", trigger="manual")
        first.with_name("foreign.json").symlink_to(foreign)
        (self.capture_root / "production" / DAY / "JUNCTION").symlink_to(foreign.parent, target_is_directory=True)
        observer = CaptureCollector(self.ledger, self.capture_root / "production")
        self.assertEqual(self.work(observer), 1)
        first.unlink()
        self.assertEqual(self.work(observer), 1)
        self.assertEqual(self.events()[-1]["detail"]["causes"], ["source_entries_removed"])
        self.assertEqual(len(self.events("capture.single")), 1)
        self.assertEqual(self.work(observer), 0)

    def test_uv_ignores_pending_directory_and_counts_only_final_batches(self):
        staged_path = uv_record(self.uv_root, ".pending-not-final")
        manual_path = uv_record(self.uv_root, "manual-final")
        uv_record(self.uv_root, "demo-final", mode="demo")
        with mock.patch("field_agent.vision_folders.os.open", wraps=__import__("os").open) as tracked:
            observer = UVCollector(self.ledger, self.uv_root)
            self.assertEqual(self.work(observer, rounds=20), 2)
            opened = [str(call.args[0]) for call in tracked.call_args_list]
            self.assertTrue(opened and all(path.endswith("result.json") for path in opened))
        before = observer.metadata_bytes_read
        self.assertEqual(self.work(observer, rounds=20), 0)
        self.assertEqual(observer.metadata_bytes_read, before)
        batches = {event["mode"]: event for event in self.events("vision.batch")}
        self.assertEqual(set(batches), {"manual", "demo"})
        manual = batches["manual"]
        self.assertEqual(manual["occurred_at"], DAY + "T08:03:02.124+08:00")
        self.assertEqual(manual["detail"]["slot_count"], 10)
        self.assertEqual([item["position"] for item in manual["products"]], list(range(1,11)))
        self.assertEqual(manual["products"][1]["reasons"], ["point_1"])
        self.assertEqual(manual["products"][0]["point_2_percent"], "100")
        self.assertIsInstance(manual["products"][0]["point_1_percent"], str)
        self.assertEqual(manual["evidence"], [{"kind": "uv_result_manifest", "id": "manual-final",
                                              "sha256": sha256(manual_path.read_bytes()).hexdigest()}])
        self.assertTrue(staged_path.exists())
        observer.close()
        uv_record(self.uv_root, "recheck")
        resumed = UVCollector(self.ledger, self.uv_root)
        self.assertEqual(self.work(resumed), 1)
        self.assertEqual(len(self.events("vision.batch")), 3)

    def test_uv_rejects_bad_slot_set_and_source_rewrite_without_synthetic_ng(self):
        observer = UVCollector(self.ledger, self.uv_root)
        uv_record(self.uv_root, "bad", invalid=lambda data: data["products"].pop())
        good = uv_record(self.uv_root, "trusted")
        self.assertEqual(self.work(observer), 2)
        self.assertEqual(len(self.events("vision.batch")), 1)
        self.assertEqual(len(self.events("operator.action")), 1)
        rewritten = json.loads(good.read_text())
        rewritten["recipe"]["coverage_percent"] = 13.0
        good.write_text(json.dumps(rewritten), encoding="utf-8")
        # The newest manifest anchor detects in-place changes without a
        # directory modification or a full historical read.
        self.assertEqual(self.work(observer), 1)
        self.assertEqual(len(self.events("vision.batch")), 1)
        self.assertEqual(self.events()[-1]["detail"]["causes"], ["source_id_changed"])

    def test_capture_pages_are_bounded_and_new_earlier_id_is_not_lost(self):
        for index in range(5):
            capture_record(self.capture_root, "man-{}".format(index), trigger="manual")
        observer = CaptureCollector(self.ledger, self.capture_root)
        with mock.patch("field_agent.vision_folders._ENTRY_LIMIT", 2), mock.patch(
            "field_agent.vision_folders._DOCUMENT_LIMIT", 1,
        ):
            for _ in range(24):
                before = len(self.events())
                self.assertLessEqual(observer.poll(), 1)
                self.assertLessEqual(len(self.events()) - before, 1)
        self.assertEqual(len(self.events("capture.single")), 5)
        captured_bytes = observer.metadata_bytes_read
        capture_record(self.capture_root, "earlier", trigger="manual")
        self.assertEqual(self.work(observer), 1)
        self.assertEqual(len(self.events("capture.single")), 6)
        self.assertLess(observer.metadata_bytes_read - captured_bytes, 1024)
