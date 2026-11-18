"""Roll a test-only Windows bundle through an isolated station directory."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic, sleep
import unittest
from unittest.mock import patch
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from field_agent.config import _stored_config, configure, station_lock
from field_agent.ledger import Ledger
from field_agent.packaging.build_portable import build_portable
from field_agent.packaging.lifecycle import install, rollback, update, _stop, _uninstall
from field_agent.packaging.selftest import check_station
from field_agent.packaging.windows import _task_xml
from field_agent.protocol import timestamp
from field_agent.uploader import stage_batch


class PortableLifecycleTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(prefix="wj-portable-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.target = self.root / "현장 PC WJField"
        self.data = self.target / "data"
        self.connection = self.root / "연결 정보.json"
        self.connection.write_text(json.dumps({
            "station_id": "SYNTH-PORTABLE", "server": "http://127.0.0.1:1",
            "token": "a" * 32 + "." + "b" * 43,
        }), encoding="utf-8")

    def package(self, version, *, profile="win7"):
        output = self.root / ("보관 " + version + ".zip")
        build_portable(profile=profile, version=version, output=output)
        return output

    def initial(self):
        archive = self.package("v1")
        with ZipFile(archive) as zipped:
            zipped.extractall(self.root / "압축 푼 곳")
        source = self.root / "압축 푼 곳" / "WJField"
        install(source, self.target, "v1", allow_skeleton=True, port=0, shortcuts=False)
        configure(self.data, self.connection)
        with closing(Ledger(self.data / "ledger.sqlite3", "SYNTH-PORTABLE")) as ledger:
            with ledger.transaction() as conn:
                ledger.append(conn, {"app": "barcode", "type": "app.started", "reason": "synthetic",
                                     "mode": "test", "result": "info", "occurred_at": timestamp()})
            stage_batch(ledger)
        for name, contents in (("backup/untouched.sqlite3", b"TEST BACKUP"),
                               ("logs/agent.log", b"TEST LOG"), ("ui-preferences.json", b'{"language":"zh"}')):
            target = self.data / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(contents)

    def contents(self):
        return {path.relative_to(self.data): path.read_bytes() for path in self.data.rglob("*") if path.is_file()}

    def active(self):
        return (self.target / "current.txt").read_text().strip()

    def test_install_update_retention_rollback_and_uninstall_keep_station_bytes(self):
        self.initial()
        before = self.contents()
        self.assertEqual(check_station(self.data, port=0)["staged_pending"], 1)
        for version in ("v2", "v3", "v4"):
            archive = self.package(version)
            self.assertEqual(update(self.target, archive, allow_skeleton=True, port=0), version)
            self.assertEqual(self.active(), version)
            self.assertEqual(self.contents(), before)
        versions = self.target / "versions"
        self.assertEqual({path.name for path in versions.iterdir()}, {"v2", "v3", "v4"})
        unrelated = versions / "local-not-a-release"
        unrelated.mkdir()
        self.assertEqual(rollback(self.target, allow_skeleton=True, port=0), "v3")
        self.assertEqual(rollback(self.target, "v2", allow_skeleton=True, port=0), "v2")
        self.assertEqual(self.contents(), before)
        with patch("field_agent.packaging.windows.shortcuts"), patch("field_agent.packaging.windows.unregister_task"):
            names = _uninstall(self.target, 0)
        for name in names:
            shutil.rmtree(versions / name)
        self.assertTrue(unrelated.exists())
        self.assertFalse((self.target / "current.txt").exists())
        self.assertEqual(self.contents(), before)

    def test_archive_and_internal_hash_failures_keep_pointer_and_data(self):
        self.initial()
        before = self.contents()
        artifact = self.package("v2")
        sidecar = artifact.with_name(artifact.name + ".sha256")
        correct = sidecar.read_bytes()
        sidecar.write_text("0" * 64 + "  " + artifact.name + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            update(self.target, artifact, allow_skeleton=True, port=0)
        sidecar.write_bytes(correct)
        alter = self.root / "다른 파일.zip"
        with ZipFile(artifact) as source, ZipFile(alter, "w") as target:
            for name in source.namelist():
                data = source.read(name)
                if name.endswith("/field_agent/__main__.py"):
                    data += b"\n# changed bytes"
                target.writestr(name, data)
        alter.with_name(alter.name + ".sha256").write_text(
            hashlib.sha256(alter.read_bytes()).hexdigest() + "  " + alter.name + "\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Release SHA-256"):
            update(self.target, alter, allow_skeleton=True, port=0)
        self.assertEqual(self.active(), "v1")
        self.assertEqual(self.contents(), before)

    def test_active_lock_print_job_and_v49_cycle_hold_activation(self):
        self.initial()
        archive = self.package("v2")
        with station_lock(self.data), self.assertRaisesRegex(ValueError, "already in use"):
            update(self.target, archive, allow_skeleton=True, port=0)
        path = self.data / "ledger.sqlite3"
        with closing(Ledger(path, "SYNTH-PORTABLE")) as ledger, ledger.transaction() as conn:
            conn.execute("CREATE TABLE weigh_jobs(state TEXT)")
            conn.execute("INSERT INTO weigh_jobs VALUES('waiting')")
        before = self.contents()
        with self.assertRaisesRegex(ValueError, "self-test failed"):
            update(self.target, archive, allow_skeleton=True, port=0)
        self.assertEqual(self.active(), "v1")
        self.assertEqual(self.contents(), before)
        with closing(Ledger(path, "SYNTH-PORTABLE")) as ledger, ledger.transaction() as conn:
            conn.execute("UPDATE weigh_jobs SET state='submitted'")
        camera_data = self.root / "vision" / "data"
        camera_data.mkdir(parents=True)
        safety = camera_data / "safety.json"
        safety.write_text('{"active":true,"running":true}', encoding="utf-8")
        (self.data / "vision-sources.json").write_text(json.dumps({
            "backcover": {"history": str(camera_data / "history" / "history.sqlite3")},
        }), encoding="utf-8")
        before = self.contents()
        with self.assertRaisesRegex(ValueError, "self-test failed"):
            update(self.target, archive, allow_skeleton=True, port=0)
        self.assertEqual(self.active(), "v1")
        self.assertEqual(self.contents(), before)
        safety.write_text('{"active":false,"running":false}', encoding="utf-8")
        self.assertEqual(update(self.target, archive, allow_skeleton=True, port=0), "v2")

    def test_failed_activation_can_retry_existing_staged_version(self):
        self.initial()
        archive = self.package("v2")
        from field_agent.packaging import lifecycle
        real_write = lifecycle._set_pointer

        def write(target, name, version):
            if name == "current.txt":
                raise OSError("synthetic disk write")
            return real_write(target, name, version)

        before = self.contents()
        with patch.object(lifecycle, "_set_pointer", side_effect=write), self.assertRaises(OSError):
            update(self.target, archive, allow_skeleton=True, port=0)
        self.assertEqual(self.active(), "v1")
        self.assertTrue((self.target / "versions" / "v2").is_dir())
        self.assertEqual(update(self.target, archive, allow_skeleton=True, port=0), "v2")
        self.assertEqual(self.contents(), before)

    def test_rollback_uses_the_target_even_if_active_version_cannot_import(self):
        self.initial()
        archive = self.package("v2")
        update(self.target, archive, allow_skeleton=True, port=0)
        before = self.contents()
        damaged = self.target / "versions" / "v2" / "field_agent" / "__main__.py"
        damaged.unlink()
        self.assertEqual(rollback(self.target, allow_skeleton=True, port=0), "v1")
        self.assertEqual(self.active(), "v1")
        self.assertEqual(self.contents(), before)

    def test_port_and_profile_changes_fail_and_reconfiguration_keeps_token(self):
        self.initial()
        conflicting = self.package("new-profile", profile="win10")
        with self.assertRaisesRegex(ValueError, "profile"):
            update(self.target, conflicting, allow_skeleton=True, port=0)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            with self.assertRaises(OSError):
                check_station(self.data, port=listener.getsockname()[1])
        from field_agent.packaging.lifecycle import main
        token_path = self.data / _stored_config(self.data)["token_file"]
        token_bytes = token_path.read_bytes()
        self.connection.unlink()
        self.assertEqual(main(["--root", str(self.target), "configure", "--language", "ko", "--agent-only"]), 0)
        self.assertEqual(_stored_config(self.data)["token_file"], token_path.name)
        self.assertEqual(token_path.read_bytes(), token_bytes)
        self.assertEqual(self.active(), "v1")

    def test_stop_marker_shuts_down_a_running_agent(self):
        self.initial()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        from field_agent.packaging.windows import _ready
        process = subprocess.Popen([
            sys.executable, "-B", "-m", "field_agent", "run",
            "--data-dir", str(self.data), "--port", str(port),
            "--stop-file", str(self.target / "maintenance.stop"),
        ], cwd=str(Path(__file__).resolve().parents[2]), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = monotonic() + 8
            while not _ready(port, "SYNTH-PORTABLE") and process.poll() is None and monotonic() < deadline:
                sleep(0.05)
            self.assertTrue(_ready(port, "SYNTH-PORTABLE"))
            _stop(self.target)
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertFalse(_ready(port, "SYNTH-PORTABLE"))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    def test_logon_spec_is_interactive_and_restarts_on_failure(self):
        namespace = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
        root = ET.fromstring(_task_xml("S-1-5-21-999", "C:/Windows/System32/wscript.exe",
                                       '"C:/현장 PC/hidden.vbs" supervise', "C:/현장 PC"))
        self.assertEqual(root.attrib["version"], "1.2")
        self.assertEqual(root.findtext("t:Triggers/t:LogonTrigger/t:UserId", namespaces=namespace), "S-1-5-21-999")
        self.assertEqual(root.findtext("t:Principals/t:Principal/t:LogonType", namespaces=namespace), "InteractiveToken")
        self.assertEqual(root.findtext("t:Settings/t:RestartOnFailure/t:Count", namespaces=namespace), "3")
        self.assertEqual(root.findtext("t:Settings/t:ExecutionTimeLimit", namespaces=namespace), "PT0S")
        self.assertEqual(root.findtext("t:Actions/t:Exec/t:WorkingDirectory", namespaces=namespace), "C:/현장 PC")
