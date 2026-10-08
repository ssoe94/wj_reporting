"""Actual Chrome + Django Client, virtual HTTPS, synthetic accounts only.

Reuses the existing isolated runner's executable validation, private logs,
disposable SQLite and Python egress guard. No TLS ingress or live acceptance.
"""
import base64
from http.cookies import SimpleCookie
import importlib.util
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://synthetic-activation.invalid'
PAGE = '/accounts/activate/'
ISSUE = '/admin/account_activation/activationgrant/issue/'
PASSWORD = 'SYNTHETIC-P4!cobalt-9728-moon'


def build_case(options, evidence):
    from django.conf import settings
    from django.contrib.auth import get_user_model
    from django.test import Client, TestCase, override_settings
    from account_activation import services
    from account_activation.models import ActivationGrant
    from account_activation.tests import CONFIG

    @override_settings(**{**CONFIG, 'ACCOUNT_ACTIVATION_ORIGIN': ORIGIN,
        'ALLOWED_HOSTS': [urlsplit(ORIGIN).netloc], 'CSRF_TRUSTED_ORIGINS': [ORIGIN]})
    class BrowserFixtureTests(TestCase):
        def test_real_chrome_self_set_and_login(self):
            User = get_user_model()
            admin = User.objects.create_user(username='SYNTHETIC-CHROME-ADMIN', is_staff=True, is_superuser=True)
            target = User.objects.create_user(username='SYNTHETIC-CHROME-OWNER', password=None, is_active=False)
            approval = {str(target.pk): {'username': target.username,
                'policy_digest': services.policy_digest(target), 'reference': 'SYNTHETIC-CHROME-APPROVAL'}}
            login = Client(enforce_csrf_checks=True)
            login.force_login(admin)
            cookies = [{'name': settings.SESSION_COOKIE_NAME,
                'value': login.cookies[settings.SESSION_COOKIE_NAME].value,
                'domain': urlsplit(ORIGIN).netloc, 'path': '/', 'secure': True,
                'httpOnly': True, 'sameSite': 'Lax'}]
            allowed = {ISSUE, PAGE, '/api/token/'} | {
                PAGE + 'assets/' + name for name in ('activate.js', 'issue.js', 'activation.css')}
            client = Client(enforce_csrf_checks=True)
            observed = []
            with override_settings(ACCOUNT_ACTIVATION_APPROVED_TARGETS=approval), \
                    tempfile.TemporaryDirectory(prefix='wj-activation-browser-') as profile:
                process = subprocess.Popen([str(options.node), str(ROOT / 'scripts/check-account-activation-browser.cjs')],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
                    text=True, cwd=ROOT, env={'PATH': os.defpath, 'LC_ALL': 'C'})
                result = None
                try:
                    process.stdin.write(json.dumps({'type': 'init', 'origin': ORIGIN,
                        'chrome': str(options.chrome), 'playwright': str(options.playwright_root / 'index.js'),
                        'profile': profile, 'cookies': cookies, 'target': str(target.pk),
                        'username': target.username, 'password': PASSWORD}) + '\n')
                    process.stdin.flush()
                    deadline = time.monotonic() + 55
                    selector = selectors.DefaultSelector()
                    selector.register(process.stdout, selectors.EVENT_READ)
                    self.addCleanup(selector.close)
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(timeout=remaining):
                            self.fail('Owned activation browser fixture exceeded deadline.')
                        line = process.stdout.readline()
                        if not line:
                            break
                        message = json.loads(line)
                        if message.get('type') == 'result':
                            result = message
                            break
                        self.assertEqual(message.get('type'), 'request')
                        parsed = urlsplit(message['url'])
                        self.assertEqual((parsed.scheme, parsed.netloc), ('https', urlsplit(ORIGIN).netloc))
                        self.assertIn(parsed.path, allowed)
                        self.assertFalse(parsed.query or parsed.fragment)
                        headers = {name.lower(): value for name, value in message['headers'].items()}
                        cookie = SimpleCookie()
                        cookie.load(headers.get('cookie', ''))
                        client.cookies.clear()
                        extra = {'HTTP_HOST': parsed.netloc, 'HTTP_COOKIE': headers.get('cookie', '')}
                        for name in ('origin', 'referer', 'authorization', 'x-csrftoken'):
                            if name in headers:
                                extra['HTTP_' + name.upper().replace('-', '_')] = headers[name]
                        response = client.generic(message['method'], parsed.path,
                            data=base64.b64decode(message.get('body', '')),
                            content_type=headers.get('content-type', 'application/octet-stream'),
                            secure=True, **extra)
                        observed.append({'path': parsed.path, 'method': message['method'],
                            'status': response.status_code, 'session_cookie': settings.SESSION_COOKIE_NAME in cookie,
                            'same_origin': headers.get('origin') == ORIGIN})
                        response_headers = dict(response.items())
                        if response.cookies:
                            response_headers['set-cookie'] = '\n'.join(
                                item.OutputString() for item in response.cookies.values())
                        process.stdin.write(json.dumps({'type': 'response', 'id': message['id'],
                            'status': response.status_code, 'headers': response_headers,
                            'body': base64.b64encode(response.content).decode('ascii')}) + '\n')
                        process.stdin.flush()
                    process.wait(timeout=10)
                finally:
                    if process.poll() is None:
                        process.terminate()  # Only our freshly created fixture process.
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    process.stdin.close()
                    process.stdout.close()
                self.assertIsNotNone(result)
                evidence.update(result)
                self.assertTrue(result['ok'], 'Activation browser stage failed: ' + result.get('stage', 'unknown'))
                self.assertEqual(process.returncode, 0)
            target.refresh_from_db()
            self.assertTrue(target.is_active)
            self.assertTrue(target.check_password(PASSWORD))
            self.assertEqual(ActivationGrant.objects.get().status, 'consumed')
            self.assertEqual(services.policy_digest(target), approval[str(target.pk)]['policy_digest'])
            posts = [item for item in observed if item['method'] == 'POST']
            self.assertEqual([(item['path'], item['status']) for item in posts],
                             [(ISSUE, 200), (PAGE, 200), (PAGE, 400), ('/api/token/', 200)])
            self.assertTrue(posts[0]['session_cookie'])
            self.assertTrue(all(not item['session_cookie'] for item in posts[1:]))
            self.assertTrue(all(item['same_origin'] for item in posts))
            evidence.update(django_requests=len(observed), fixture_grants=1, real_activation=False,
                real_account_login=False, ingress_logging_verified=False,
                actual_chrome_synthetic_activation_and_login=True)
    return BrowserFixtureTests


if __name__ == '__main__':
    spec = importlib.util.spec_from_file_location('activation_browser_harness', ROOT / 'scripts/check-mes-oauth-browser.py')
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    harness.build_case = build_case
    raise SystemExit(harness.main())
