import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from field_agent.config import configure, load_connection, station_lock


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.data = root / "station-data"
        self.input = root / "import.json"
        self.station = "SYNTH-CONFIG"
        self.server = "http://127.0.0.1:9876"
        self.token = "1" * 32 + "." + "a" * 43

    def _write(self, **changes):
        connection = {"server": self.server, "station_id": self.station, "token": self.token}
        self.input.write_text(json.dumps({**connection, **changes}), encoding="utf-8")

    def test_connection_keeps_token_separate_and_rotation_preserves_binding(self):
        self._write()
        configure(self.data, self.input)
        body = json.loads((self.data / "connection.json").read_text())
        stored = self.data / body["token_file"]
        self.assertNotIn(self.token, json.dumps(body))
        self.assertNotIn(self.token, repr(load_connection(self.data)))
        self.assertEqual(stored.read_text(), self.token)
        if os.name != "nt":
            self.assertEqual(stored.stat().st_mode & 0o077, 0)
        replacement = "2" * 32 + "." + "b" * 43
        self._write(token=replacement)
        configure(self.data, self.input)
        self.assertEqual(load_connection(self.data).token, replacement)
        self.assertFalse(stored.exists())

        self._write(station_id="SYNTH-DIFFERENT")
        with self.assertRaisesRegex(ValueError, "different data directory"):
            configure(self.data, self.input)
        self._write(server="https://example.invalid")
        with self.assertRaisesRegex(ValueError, "different data directory"):
            configure(self.data, self.input)
        self.assertEqual(load_connection(self.data).token, replacement)

    def test_invalid_config_does_not_create_connection_or_leak_input(self):
        # The invalid input is never echoed by the install command.
        self._write(server="http://example.invalid")
        result = subprocess.run(
            [sys.executable, "-B", "-m", "field_agent", "configure", "--data-dir", str(self.data),
             "--connection", str(self.input)], capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(self.token, result.stdout + result.stderr)
        self.assertFalse((self.data / "connection.json").exists())

    def test_non_owner_cannot_configure_active_data_directory(self):
        self._write()
        with station_lock(self.data):
            with self.assertRaisesRegex(ValueError, "already in use"):
                configure(self.data, self.input)
        configure(self.data, self.input)
