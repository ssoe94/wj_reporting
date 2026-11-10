"""The production model is supervised independently, loopback-only, token-free."""
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ModelLauncherTests(unittest.TestCase):
    def test_reuses_verified_runtime_and_strips_worker_token(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            for name in ('env/bin', 'state/runtime-switch-002/omlx'):
                (runtime / name).mkdir(parents=True)
            for name in ('state/serve-verified-runtime.py',
                         'state/runtime-switch-002/omlx/model_settings.json'):
                (runtime / name).touch()
            python = runtime / 'env/bin/python'
            python.write_text('#!/bin/sh\nprintf "token=%s\\n" "${AI_WORKER_TOKEN-unset}"\nprintf "%s\\n" "$@"\n')
            python.chmod(0o700)
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/local_ai/run-model.sh')],
                                    env={**os.environ, 'LOCAL_AI_OMLX_ROOT': directory,
                                         'AI_WORKER_TOKEN': 'test-only'},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            args = result.stdout.splitlines()
            self.assertEqual(args[:3], ['token=unset', '-I', str(runtime / 'state/serve-verified-runtime.py')])
            self.assertIn('--headless', args)
            self.assertEqual(args[args.index('--host') + 1], '127.0.0.1')
            self.assertEqual(args[args.index('--port') + 1], '8082')
            self.assertEqual(args[args.index('--max-concurrent-requests') + 1], '1')
            self.assertNotIn('pip', args)

    def test_missing_runtime_fails_without_installing_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['/bin/bash', str(ROOT / 'scripts/local_ai/run-model.sh')],
                                    env={**os.environ, 'LOCAL_AI_OMLX_ROOT': directory},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 78)
            self.assertIn('runtime file missing', result.stderr)

    def test_model_is_restarted_by_launchd_without_restarting_worker(self):
        config = plistlib.loads((ROOT / 'scripts/local_ai/com.wj.local-ai-model.plist.template').read_bytes())
        self.assertEqual(config['Label'], 'com.wj.local-ai-model')
        self.assertTrue(config['RunAtLoad'])
        self.assertTrue(config['KeepAlive'])
        self.assertGreaterEqual(config['ThrottleInterval'], 30)
        self.assertNotIn('EnvironmentVariables', config)
        self.assertIn('run-model.sh', config['ProgramArguments'][1])

    def test_installer_preserves_registered_model_and_worker_bootstrap_has_no_kill(self):
        installer = (ROOT / 'scripts/local_ai/install-launch-agents.sh').read_text()
        model_start = installer.split('# A separately supervised model', 1)[1].split('render_plist "$script_dir/$worker_label', 1)[0]
        self.assertNotIn('bootout', model_start)
        self.assertNotIn('kickstart -k', model_start)
        self.assertIn('if ! /bin/launchctl print', model_start)
        self.assertIn('/bin/launchctl bootstrap', model_start)
        worker = (ROOT / 'scripts/local_ai/run-worker.sh').read_text()
        self.assertIn('/bin/launchctl kickstart "gui/$(id -u)/com.wj.local-ai-model"', worker)
        self.assertNotIn('kickstart -k', worker)
