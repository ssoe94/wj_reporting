"""Load real settings with synthetic env, no dotenv, no network or database I/O."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP = r'''
import json, sys, types
from unittest.mock import patch
import decouple
decouple.config = decouple.Config(decouple.RepositoryEmpty())
sys.modules['dotenv'] = types.SimpleNamespace(load_dotenv=lambda *a, **k: None)
sys.path.insert(0, 'backend')
with patch('socket.socket.connect', side_effect=AssertionError('No network.')), \
     patch('socket.create_connection', side_effect=AssertionError('No network.')), \
     patch('socket.getaddrinfo', side_effect=AssertionError('No network.')):
    from config import settings as s
    print(json.dumps([s.SESSION_COOKIE_SECURE, s.CSRF_COOKIE_SECURE,
                      getattr(s, 'SECURE_HSTS_SECONDS', 0)]))
'''


class CookieSettingsTests(unittest.TestCase):
    def load_settings(self, **overrides):
        environment = {'PATH': os.defpath, 'LC_ALL': 'C', 'PYTHONDONTWRITEBYTECODE': '1',
                       'SECRET_KEY': 'synthetic-cookie-settings-only', 'DEBUG': 'False',
                       'DATABASE_URL': 'sqlite:///:memory:', **overrides}
        return subprocess.run([sys.executable, '-B', '-c', BOOTSTRAP], cwd=ROOT,
                              env=environment, capture_output=True, text=True, timeout=20)

    def test_defaults_and_explicit_https_cookies_preserve_hsts_boundary(self):
        cases = [({}, [False, False, 0]),
                 ({'SESSION_COOKIE_SECURE': 'True', 'CSRF_COOKIE_SECURE': 'True'}, [True, True, 0]),
                 ({'SESSION_COOKIE_SECURE': 'True'}, [True, False, 0]),
                 ({'CSRF_COOKIE_SECURE': 'True'}, [False, True, 0]),
                 ({'ENVIRONMENT': 'production'}, [True, True, 31536000]),
                 ({'ENVIRONMENT': 'production', 'SESSION_COOKIE_SECURE': 'False',
                   'CSRF_COOKIE_SECURE': 'False'}, [True, True, 31536000])]
        for environment, expected in cases:
            with self.subTest(environment=environment):
                result = self.load_settings(**environment)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected)

    def test_invalid_cookie_switch_is_rejected(self):
        for name in ('SESSION_COOKIE_SECURE', 'CSRF_COOKIE_SECURE'):
            with self.subTest(setting=name):
                result = self.load_settings(**{name: 'invalid-synthetic-boolean'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('ValueError', result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
