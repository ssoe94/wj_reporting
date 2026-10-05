"""Real headless browser, virtual HTTPS transport, disposable Django fixtures.

No HTTP server, provider, Render connection or TLS verification is involved.
The existing isolated runner supplies SQLite, no .env and Python network guards.
Only a newly launched browser/profile is used. Initial backend login alone is
seeded; every later cookie must come from browser-handled response headers.
"""
import argparse
import base64
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from http.cookies import SimpleCookie
import json
import logging
import os
from pathlib import Path
import runpy
import selectors
import stat
import subprocess
import sys
import tempfile
import time
import types
from urllib.parse import urlsplit
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
CODE = 'SYNTHETIC-BROWSER-CODE'
TOKEN = 'SYNTHETIC-BROWSER-USER-TOKEN'
MES_USER = 10_000_000_000_000_003
ORIGIN = 'https://wj-reporting-backend.onrender.com'
RELAY_ORIGIN = 'https://wj-reporting.onrender.com'
RELAY_COOKIE = 'synthetic_relay_fixture'


def build_case(options, evidence):
    # Loaded lazily, after check-mes-oauth.py configures isolated settings.
    from django.conf import settings
    from django.contrib.auth import get_user_model
    from django.test import Client, TestCase, override_settings
    from mes_oauth.identity import UserContextResponse
    from mes_oauth.models import OAuthAttempt
    from mes_oauth.views import CALLBACK, COOKIE, START

    @override_settings(
        MES_USER_OAUTH_ENABLED=True, MES_USER_OAUTH_CALLBACK_ORIGIN=ORIGIN,
        MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
        MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-UNVISITED-PAGE',
        MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-OFFLINE-BROWSER',
        MES_USER_OAUTH_APP_ACCESS_TOKEN='SYNTHETIC-APP-TOKEN',
        ALLOWED_HOSTS=[urlsplit(ORIGIN).netloc], CSRF_TRUSTED_ORIGINS=[ORIGIN],
    )
    class BrowserFixtureTests(TestCase):
        def test_callback_browser_flow(self):
            user = get_user_model().objects.create_user(
                username='SYNTHETIC-BROWSER-ADMIN', is_superuser=True, is_staff=True)
            login = Client(enforce_csrf_checks=True)
            login.force_login(user)
            bootstrap = [{'name': settings.SESSION_COOKIE_NAME,
                          'value': login.cookies[settings.SESSION_COOKIE_NAME].value,
                          'domain': urlsplit(ORIGIN).netloc, 'path': '/', 'secure': True,
                          'httpOnly': True, 'sameSite': 'Lax'}]
            provider = Mock()
            provider.exchange.return_value = UserContextResponse(
                200, {'code': 200, 'data': {'userAccessToken': TOKEN}}, False)
            provider.userinfo.return_value = UserContextResponse(
                200, {'code': 200, 'data': {'userId': MES_USER}}, False)
            client = Client(enforce_csrf_checks=True)
            observed = []
            evidence['request_diagnostics'] = observed
            evidence['csrf_rejections'] = []
            manifest = json.loads((ROOT / 'deploy/mes-oauth-relay-headers.json').read_text())
            self.assertEqual(manifest['path'], '/integrations/blacklake/relay.html')
            relay_html = (ROOT / 'frontend/public/integrations/blacklake/relay.html').read_text()

            class SafeCsrfDiagnostic(logging.Handler):
                def emit(self, record):
                    reason = record.args[0] if record.args else ''
                    categories = [('Origin checking failed', 'origin_rejected'),
                                  ('Referer checking failed', 'referer_rejected'),
                                  ('CSRF cookie not set', 'cookie_missing'),
                                  ('CSRF token missing', 'token_missing'),
                                  ('CSRF token from', 'token_rejected')]
                    evidence['csrf_rejections'].append(next(
                        (label for prefix, label in categories if str(reason).startswith(prefix)),
                        'other_csrf_rejection'))

            csrf_logger = logging.getLogger('django.security.csrf')
            diagnostic = SafeCsrfDiagnostic()
            csrf_logger.addHandler(diagnostic)
            self.addCleanup(csrf_logger.removeHandler, diagnostic)
            with override_settings(MES_USER_OAUTH_USER_MAP={str(user.pk): str(MES_USER)}), \
                    patch('mes_oauth.views.get_provider', return_value=provider), \
                    tempfile.TemporaryDirectory(prefix='wj-oauth-browser-') as profile:
                process = subprocess.Popen(
                    [str(options.node), str(ROOT / 'scripts/check-mes-oauth-browser.cjs')],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
                    text=True, cwd=ROOT, env={'PATH': os.defpath, 'LC_ALL': 'C'})
                result = None
                try:
                    process.stdin.write(json.dumps({
                        'type': 'init', 'chrome': str(options.chrome),
                        'playwright': str(options.playwright_root / 'index.js'),
                        'profile': profile, 'cookies': bootstrap, 'origin': ORIGIN,
                        'start': START, 'callback': CALLBACK, 'code': CODE, 'token': TOKEN,
                        'nonceCookie': COOKIE, 'sessionCookie': settings.SESSION_COOKIE_NAME,
                        'csrfCookie': settings.CSRF_COOKIE_NAME,
                        'relayOrigin': RELAY_ORIGIN, 'relayPath': manifest['path'],
                        'relayHeaders': manifest['headers'], 'relayHtml': relay_html,
                        'relayCookie': RELAY_COOKIE,
                    }) + '\n')
                    process.stdin.flush()
                    deadline = time.monotonic() + 55
                    selector = selectors.DefaultSelector()
                    selector.register(process.stdout, selectors.EVENT_READ)
                    self.addCleanup(selector.close)
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(timeout=remaining):
                            self.fail('Owned browser fixture exceeded its parent deadline.')
                        line = process.stdout.readline()
                        if not line:
                            break
                        message = json.loads(line)
                        if message.get('type') == 'result':
                            result = message
                            break
                        self.assertEqual(message.get('type'), 'request')
                        parsed = urlsplit(message['url'])
                        self.assertEqual((parsed.scheme, parsed.netloc),
                                         ('https', urlsplit(ORIGIN).netloc))
                        self.assertFalse(parsed.query or parsed.fragment)
                        self.assertNotIn(CODE, message['url'])
                        self.assertNotIn(TOKEN, message['url'])
                        self.assertIn(parsed.path, (START, CALLBACK))
                        headers = {name.lower(): value for name, value in message['headers'].items()}
                        cookie = SimpleCookie()
                        cookie.load(headers.get('cookie', ''))
                        self.assertNotIn(RELAY_COOKIE, cookie)
                        self.assertNotIn(CODE, headers.get('referer', ''))
                        self.assertNotIn(TOKEN, headers.get('referer', ''))
                        observed.append({'path': parsed.path, 'method': message['method'],
                                         'session': settings.SESSION_COOKIE_NAME in cookie,
                                         'nonce': COOKIE in cookie,
                                         'csrf_cookie': settings.CSRF_COOKIE_NAME in cookie,
                                         'origin': ('absent' if 'origin' not in headers else
                                                    'null' if headers['origin'] == 'null' else
                                                    'same_origin' if headers['origin'] == ORIGIN else
                                                    'other'),
                                         'referer': ('absent' if 'referer' not in headers else
                                                     'origin_only' if headers['referer'] == ORIGIN + '/' else
                                                     'other')})
                        # Never let Django's test cookie jar manufacture cookies
                        # omitted by the real browser, including the replay POST.
                        client.cookies.clear()
                        extra = {'HTTP_HOST': urlsplit(ORIGIN).netloc,
                                 'HTTP_COOKIE': headers.get('cookie', '')}
                        for name in ('origin', 'referer', 'authorization', 'x-csrftoken'):
                            if name in headers:
                                extra['HTTP_' + name.upper().replace('-', '_')] = headers[name]
                        response = client.generic(message['method'],
                            parsed.path + ('?' + parsed.query if parsed.query else ''),
                            data=base64.b64decode(message.get('body', '')),
                            content_type=headers.get('content-type', 'application/octet-stream'),
                            secure=True, **extra)
                        observed[-1]['status'] = response.status_code
                        response_headers = dict(response.items())
                        if response.cookies:
                            response_headers['set-cookie'] = '\n'.join(
                                item.OutputString() for item in response.cookies.values())
                        process.stdin.write(json.dumps({
                            'type': 'response', 'id': message['id'], 'status': response.status_code,
                            'headers': response_headers,
                            'body': base64.b64encode(response.content).decode('ascii'),
                        }) + '\n')
                        process.stdin.flush()
                    process.wait(timeout=10)
                finally:
                    if process.poll() is None:
                        process.terminate()  # Only this script's own Node/browser fixture.
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    process.stdin.close()
                    process.stdout.close()
                self.assertIsNotNone(result, 'Browser fixture did not return a summary.')
                evidence.update(result)
                self.assertTrue(result['ok'], 'Browser stage failed: ' + result.get('stage', 'unknown'))
                self.assertEqual(process.returncode, 0)
            self.assertTrue(all(item['session'] for item in observed))
            successful_posts = [item for item in observed
                                if item['method'] == 'POST' and item['status'] == 200]
            self.assertEqual(len(successful_posts), 2)
            self.assertTrue(all(item['origin'] == 'same_origin'
                                and item['referer'] == 'origin_only'
                                for item in successful_posts))
            callback_posts = [item for item in observed
                              if item['path'] == CALLBACK and item['method'] == 'POST']
            self.assertEqual([item['nonce'] for item in callback_posts], [True, False])
            provider.exchange.assert_called_once_with(CODE)
            provider.userinfo.assert_called_once_with(TOKEN)
            self.assertEqual(OAuthAttempt.objects.count(), 1)
            attempt = OAuthAttempt.objects.get()
            self.assertEqual(attempt.status, 'verified')
            self.assertIsNotNone(attempt.consumed_at)
            self.assertNotIn(CODE, repr(attempt.__dict__))
            self.assertNotIn(TOKEN, repr(attempt.__dict__))
            evidence['django_requests'] = len(observed)
            evidence['provider_mock_exchanges'] = provider.exchange.call_count
            evidence['provider_mock_userinfo'] = provider.userinfo.call_count
            evidence['fixture_attempts'] = 1
            evidence['nonce_present_then_absent_on_real_posts'] = True
            evidence['successful_posts_with_exact_origin_and_origin_only_referer'] = 2
            evidence['backend_http_urls_without_query_fragment_or_code'] = True
            evidence['relay_cookie_absent_from_backend_requests'] = True

    return BrowserFixtureTests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--chrome', type=Path, required=True)
    parser.add_argument('--playwright-root', type=Path, required=True)
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('--append-log', action='store_true',
                        help='Preserve and append one diagnostic retry to an existing private log.')
    options = parser.parse_args()
    for executable in (options.node, options.chrome):
        if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
            parser.error('Provide an absolute existing executable; installation is forbidden.')
    if not options.playwright_root.is_absolute() or not (options.playwright_root / 'index.js').is_file():
        parser.error('Provide the absolute existing Playwright package directory.')
    if not options.log.is_absolute():
        parser.error('Use an absolute private log path.')
    flags = os.O_WRONLY | os.O_NOFOLLOW
    flags |= os.O_APPEND if options.append_log else os.O_CREAT | os.O_EXCL
    fd = os.open(options.log, flags, 0o600)
    metadata = os.fstat(fd)
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_uid != os.getuid()):
        os.close(fd)
        parser.error('The log must be a regular private mode-0600 file owned by this user.')
    evidence = {}
    fixture = types.ModuleType('mes_oauth_browser_fixture')
    fixture.__file__ = __file__

    def fixture_class(name):
        if name != 'BrowserFixtureTests':
            raise AttributeError(name)
        value = build_case(options, evidence)
        setattr(fixture, name, value)
        return value

    fixture.__getattr__ = fixture_class
    sys.modules[fixture.__name__] = fixture
    sys.path.insert(0, str(ROOT / 'scripts'))
    started = time.monotonic()
    with os.fdopen(fd, 'w', encoding='utf-8') as log, redirect_stdout(log), redirect_stderr(log):
        print('START', datetime.now(timezone.utc).isoformat(), flush=True)
        runner = runpy.run_path(str(ROOT / 'scripts/check-mes-oauth.py'))
        result = runner['main'](['mes_oauth_browser_fixture.BrowserFixtureTests'])
        evidence.update({'returncode': result, 'wall_seconds': round(time.monotonic() - started, 3),
                         'real_provider_requests': 0, 'transport': 'virtual HTTPS via route/Django Client'})
        print('SUMMARY', json.dumps(evidence, sort_keys=True), flush=True)
    print(json.dumps({key: value for key, value in evidence.items()
                      if key not in ('request_diagnostics', 'csrf_rejections')}, sort_keys=True))
    return result


if __name__ == '__main__':
    raise SystemExit(main())
