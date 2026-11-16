"""Language is a local installation setting, shared by all operator views."""

import concurrent.futures
from contextlib import closing
from http.client import HTTPConnection
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from field_agent.config import LanguagePreferences, configure, load_connection
from field_agent.local_ui import LocalUI


class LanguagePreferencesTests(unittest.TestCase):
    def setUp(self):
        work = TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.data = Path(work.name) / "data"
        self.data.mkdir()
        self.source = Path(work.name) / "synthetic-connection.json"
        self.source.write_text(json.dumps({
            "server": "http://127.0.0.1:49160", "station_id": "SYNTH-LANGUAGE",
            "token": "0" * 32 + "." + "X" * 43,
        }))

    def test_install_language_cli_and_token_refresh_preserving_operator_choice(self):
        result = subprocess.run([
            sys.executable, "-B", "-m", "field_agent", "configure", "--data-dir", str(self.data),
            "--connection", str(self.source), "--language", "zh",
        ], capture_output=True, text=True, check=True)
        self.assertIn("Field connection stored.", result.stdout)
        self.assertEqual(LanguagePreferences(self.data).get(), "zh")
        self.assertEqual(load_connection(self.data).station_id, "SYNTH-LANGUAGE")
        LanguagePreferences(self.data).set("ko")
        configure(self.data, self.source)
        self.assertEqual(LanguagePreferences(self.data).get(), "ko")

    def test_legacy_default_and_setting_file_write_failure(self):
        original = LanguagePreferences(self.data)
        self.assertEqual(original.get(), "ko")
        original.set("zh")
        with patch("field_agent.config._atomic_file", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                original.set("ko")
        self.assertEqual(original.get(), "zh")
        self.assertEqual(LanguagePreferences(self.data).get(), "zh")

    def test_corrupt_optional_display_file_does_not_block_runtime(self):
        file = self.data / "ui-preferences.json"
        file.write_bytes(b"broken")
        preferences = LanguagePreferences(self.data)
        self.assertEqual(preferences.get(), "ko")
        self.assertEqual(file.read_bytes(), b"broken")
        preferences.set("ko")
        self.assertEqual(json.loads(file.read_text()), {"language": "ko"})

    def test_ui_concurrent_updates_share_the_committed_choice(self):
        preferences = LanguagePreferences(self.data)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(preferences.set, ["zh", "ko"] * 5))
        self.assertEqual(preferences.get(), LanguagePreferences(self.data).get())

    def test_loopback_language_action_security_and_preference_across_server_restart(self):
        def request(ui, method, path, body=None, headers=None):
            with closing(HTTPConnection("127.0.0.1", ui.port, timeout=3)) as conn:
                conn.request(method, path, body=body, headers=headers or {})
                result = conn.getresponse()
                return result.status, result.read()

        def mutate(ui, payload, headers):
            headers = {"Content-Type": "application/json", **headers}
            return request(ui, "POST", "/api/language/", payload, headers)[0]

        def start():
            return LocalUI(lambda: {"station_id": "SYNTH-LANGUAGE"}, port=0,
                           language=LanguagePreferences(self.data)).start()

        ui = start()
        try:
            self.assertEqual(json.loads(request(ui, "GET", "/api/status")[1])["language"], "ko")
            origin = "http://127.0.0.1:{}".format(ui.port)
            csrf = {"Origin": origin, "X-WJ-Local": "1"}
            for headers in ({}, {"Origin": origin}, {"X-WJ-Local": "1"},
                            {**csrf, "Origin": "http://127.0.0.1:1"},
                            {**csrf, "Host": "synth.example.invalid"},
                            {**csrf, "Sec-Fetch-Site": "cross-site"}):
                self.assertEqual(mutate(ui, '{"language":"zh"}', headers), 403)
            for invalid in ('{"language":"en"}', '{"language":[]}', '{"language":"zh","server":"other"}',
                            '{"language":"ko","language":"zh"}'):
                self.assertEqual(mutate(ui, invalid, csrf), 400)
            self.assertEqual(mutate(ui, '{"language":"zh"}', csrf), 200)
            self.assertEqual(json.loads(request(ui, "GET", "/api/status")[1])["language"], "zh")
            with closing(HTTPConnection("127.0.0.1", ui.port, timeout=3)) as conn:
                conn.request("GET", "/api/events")
                stream = conn.getresponse()
                first = stream.readline()
                self.assertTrue(first.startswith(b"data: "))
                self.assertEqual(json.loads(first[len(b"data: "):])["language"], "zh")
        finally:
            ui.stop()

        restarted = start()
        try:
            page = request(restarted, "GET", "/")[1].decode()
            self.assertIn('<html lang="zh-Hans">', page)
            self.assertIn('<noscript>请启用 JavaScript 查看状态。</noscript>', page)
            self.assertEqual(json.loads(request(restarted, "GET", "/api/status")[1])["language"], "zh")
        finally:
            restarted.stop()
