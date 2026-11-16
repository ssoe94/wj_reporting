"""Launcher regression: model outages must reach Python heartbeat handling."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class WorkerLauncherTests(unittest.TestCase):
    def run_launcher(self, directory, *, model_url="http://127.0.0.1:8082/v1",
                     autostart="true", manager_exit=0, manager_exists=True):
        directory = Path(directory)
        repository = Path(__file__).resolve().parents[1]
        worker_python = directory / "fake-python"
        worker_python.write_text(
            '#!/bin/sh\ntouch "$WORKER_STARTED"\n'
            'printf "worker-started unbuffered=%s %s\\n" "$PYTHONUNBUFFERED" "$*"\n'
        )
        worker_python.chmod(0o700)
        runtime_repo = directory / "runtime"
        (runtime_repo / "config").mkdir(parents=True)
        (runtime_repo / "pyproject.toml").write_text("")
        (runtime_repo / "config/worker.toml").write_text("")
        uv = directory / "fake-uv"
        if manager_exists:
            uv.write_text(
                '#!/bin/sh\n'
                'printf "%s\\n" "$@" > "$MANAGER_CAPTURE"\n'
                'printf "token=%s\\n" "${AI_WORKER_TOKEN-unset}" >> "$MANAGER_CAPTURE"\n'
                '# Waiting for the worker proves the manager was backgrounded.\n'
                'for attempt in 1 2 3 4 5 6 7 8 9 10; do\n'
                '  if [ -f "$WORKER_STARTED" ]; then exit "$MANAGER_EXIT"; fi\n'
                '  sleep 0.05\n'
                'done\nexit 98\n'
            )
            uv.chmod(0o700)
        capture = directory / "manager-args"
        environment = {
            **os.environ, "WORKER_PYTHON": str(worker_python),
            "AI_WORKER_TOKEN": "test-only-no-network-token", "AI_WORKER_USE_LLM": "true",
            "LOCAL_LLM_BASE_URL": model_url, "AI_WORKER_AUTOSTART_RUNTIME": autostart,
            "LOCAL_AI_RUNTIME_REPO": str(runtime_repo), "LOCAL_AI_UV_BIN": str(uv),
            "MANAGER_CAPTURE": str(capture), "MANAGER_EXIT": str(manager_exit),
            "WORKER_STARTED": str(directory / "worker-started"),
        }
        result = subprocess.run(
            ["/bin/bash", str(repository / "scripts/local_ai/run-worker.sh"), "--once"],
            capture_output=True, text=True, timeout=10, env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("worker-started unbuffered=1", result.stdout)
        self.assertIn("local_worker/worker.py --once", result.stdout)
        return result, capture, runtime_repo

    def test_launcher_starts_worker_even_when_custom_model_endpoint_is_unavailable(self):
        for model_url in ["http://127.0.0.1:1/v1", "https://example.invalid/v1"]:
            with self.subTest(model_url=model_url), tempfile.TemporaryDirectory() as directory:
                result, capture, _ = self.run_launcher(directory, model_url=model_url)
                self.assertFalse(capture.exists())
                self.assertEqual(result.stderr, "")

    def test_owned_runtime_start_is_backgrounded_and_never_receives_worker_token(self):
        with tempfile.TemporaryDirectory() as directory:
            result, capture, runtime_repo = self.run_launcher(directory)
            self.assertEqual(capture.read_text().splitlines(), [
                "run", "--no-sync", "--directory", str(runtime_repo), "local-coder", "start", "token=unset",
            ])
            self.assertEqual(result.stderr, "")

    def test_failed_start_keeps_worker_running_and_reports_short_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            result, capture, _ = self.run_launcher(directory, manager_exit=1)
            self.assertTrue(capture.exists())
            self.assertIn("runtime start failed; worker heartbeats continue", result.stderr)

    def test_opt_out_does_not_start_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            result, capture, _ = self.run_launcher(directory, autostart="false")
            self.assertFalse(capture.exists())
            self.assertEqual(result.stderr, "")

    def test_missing_manager_does_not_block_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            result, capture, _ = self.run_launcher(directory, manager_exists=False)
            self.assertFalse(capture.exists())
            self.assertIn("runtime manager unavailable; worker heartbeats continue", result.stderr)


if __name__ == "__main__":
    unittest.main()
