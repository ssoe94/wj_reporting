"""Configuration, provenance and snapshot boundaries for read-only vision."""
from dataclasses import asdict
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from field_agent.launcher import Companion, Layout, Process, launched_vision_app, save_layout
from field_agent.ledger import Ledger
from field_agent.local_ui import _status_bytes
from field_agent.runtime import Runtime
from field_agent.vision_sources import load_sources, prepare_sources, save_sources


class VisionRuntimeTests(TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.ledger = Ledger(self.root / "ledger.sqlite3", "SYNTH")
        self.addCleanup(self.ledger.close)

    def test_private_installation_resolves_relative_paths_and_is_opt_in(self):
        path = self.root / "options.json"
        self.assertEqual(load_sources(self.root), {})
        path.write_text(json.dumps({"backcover": {"history": "history.sqlite3", "camera_mode": "test"},
                                    "uv": {"root": "batches"}}))
        parsed = prepare_sources(path)
        self.assertEqual(parsed["backcover"]["history"], str((self.root / "history.sqlite3").resolve()))
        self.assertNotIn("status_enabled", parsed["backcover"])
        save_sources(self.root, parsed)
        self.assertEqual(load_sources(self.root), parsed)
        for bad in ({"backcover": {"history": "history.sqlite3", "status_enabled": 1}},
                    {"uv": {"root": "batches", "mode": "production"}},
                    {"backcover": {"history": "history.sqlite3", "status_url": "other"}}):
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                prepare_sources(path)

    def test_process_status_requires_own_record_and_stable_pid_identity(self):
        program = r"C:\Example\pythonw.exe"
        folder = r"C:\Example\vision"
        save_layout(self.root, Layout(profile="companion_full", companion=Companion("backcover_v49", program, folder)))
        evidence = self.root / "launcher-processes.json"
        process = Process(42, 51, program)
        record = dict(asdict(process), key=r"backcover:c:\example\vision", spawned=False)
        identify = mock.Mock(return_value=process)

        def write():
            evidence.write_text(json.dumps({"backend": record}))

        write()
        self.assertIsNone(launched_vision_app(self.root, identify=identify))
        identify.assert_not_called()
        record["spawned"] = True
        write()
        self.assertEqual(launched_vision_app(self.root, identify=identify), "vision_backcover")
        identify.assert_called_once_with(42)
        identify.return_value = Process(42, 52, program)
        self.assertIsNone(launched_vision_app(self.root, identify=identify))
        identify.return_value = process
        record["key"] = r"backcover:c:\other\vision"
        write()
        self.assertIsNone(launched_vision_app(self.root, identify=identify))

    def test_valid_folder_and_device_evidence_do_not_imply_process_is_running(self):
        with mock.patch("field_agent.runtime.create_collectors", return_value={
            "vision_backcover": mock.Mock(), "vision_uv": mock.Mock()
        }):
            runtime = Runtime(self.ledger, object(), demo=True)
        stamp = "2026-11-16T08:10:00+08:00"
        runtime._vision_status = {
            "vision_backcover": {"state": "running", "coverage": "partial", "last_work_at": stamp,
                                 "mode": "unknown", "devices": [{"app": "vision_backcover", "device": "camera",
                                                                "state": "connected", "last_input_at": stamp}],
                                 "path": "DO-NOT-EXPOSE"},
            "vision_uv": {"state": "running", "coverage": "partial", "mode": "manual"},
        }
        heartbeat = runtime._heartbeat_snapshot()
        self.assertEqual(heartbeat["coverage"], "partial")
        self.assertEqual({item["app"]: item["state"] for item in heartbeat["apps"]},
                         {"barcode": "running", "vision_backcover": "unknown", "vision_uv": "unknown"})
        self.assertIn("camera", [device["device"] for device in heartbeat["devices"]])
        runtime._launched_vision = "vision_uv"
        local = _status_bytes(runtime.snapshot(), "ko")
        self.assertNotIn(b"DO-NOT-EXPOSE", local)
        statuses = {item["app"]: item for item in json.loads(local)["vision"]}
        self.assertEqual(statuses["vision_uv"]["process"], "running")
        self.assertEqual(statuses["vision_backcover"]["last_work_at"], stamp)
        self.assertEqual(statuses["vision_backcover"]["process"], "unknown")
