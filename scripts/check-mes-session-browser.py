"""Synthetic JWT -> native cross-origin POST -> MES-only session in real Chrome.

Uses loopback HTTPS with a synthetic pinned certificate and Django Client.
No existing browser profile, environment credentials or business rows are used.
The minimal frontend form checks native transport, not React rendering/state.
Only fixed diagnostics, booleans and counts are written to the private log.
The local CONNECT proxy forwards only two fixed hostnames to its own TLS server.
Chrome follows the actual 302 automatically; no driver start-page navigation.
This is not evidence of production DNS, public certificate trust or TLS ingress.
"""
import argparse
import base64
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from http.cookies import SimpleCookie
import io
import json
import logging
import os
from pathlib import Path
import re
import runpy
import selectors
import stat
import subprocess
import sys
import tempfile
import time
import types
from urllib.parse import parse_qs, urlsplit
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://wj-reporting-backend.onrender.com'
FRONTEND = 'https://wj-reporting.onrender.com'
CODE = 'SYNTHETIC-SESSION-BROWSER-CODE'
TOKEN = 'SYNTHETIC-SESSION-BROWSER-USER-TOKEN'
MES_USER = 10_000_000_000_000_013
LAUNCH = '/api/mes-connection/launch/'


def synthetic_certificate(directory):
    """Create a disposable certificate; never consult any existing key store."""
    openssl = Path('/usr/bin/openssl')
    if not openssl.is_file() or not os.access(openssl, os.X_OK):
        raise RuntimeError('Existing system OpenSSL is required; installation is forbidden.')
    directory = Path(directory)
    config = directory / 'synthetic-openssl.cnf'
    certificate = directory / 'synthetic-certificate.pem'
    key = directory / 'synthetic-private-key.pem'
    text = ('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n'
            '[dn]\nCN=SYNTHETIC-LOCAL-BROWSER-ONLY\n[ext]\n'
            'subjectAltName=DNS:' + urlsplit(ORIGIN).hostname + ',DNS:' + urlsplit(FRONTEND).hostname + '\n')
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='ascii') as handle:
        handle.write(text)
    completed = subprocess.run([str(openssl), 'req', '-x509', '-newkey', 'rsa:2048', '-sha256',
        '-nodes', '-keyout', str(key), '-out', str(certificate), '-days', '1', '-config', str(config)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={'PATH': os.defpath, 'LC_ALL': 'C'}, umask=0o077, timeout=15, check=False)
    if completed.returncode:
        raise RuntimeError('Synthetic certificate generation failed.')
    for path in (key, certificate):
        if stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise RuntimeError('Synthetic certificate files must be private.')
    return certificate, key


def build_case(options, evidence, sensitive):
    from django.conf import settings
    from django.contrib.auth import get_user_model
    from django.contrib.sessions.backends.db import SessionStore
    from django.middleware.csrf import _does_token_match
    from django.test import Client, TestCase, override_settings
    from config.token_views import ScopedTokenObtainPairSerializer
    from mes_oauth import vault
    from mes_oauth.connection_views import BRIDGE_PATH, BRIDGE_ONLY, SESSION_KEY
    from mes_oauth.identity import UserContextResponse
    from mes_oauth.models import MESCredential, MESLoginSession, MESLoginTicket, OAuthAttempt
    from mes_oauth.views import CALLBACK, COOKIE, START

    @override_settings(
        MES_USER_OAUTH_ENABLED=True, MES_USER_SESSION_BRIDGE_ENABLED=True,
        MES_USER_TOKEN_STORAGE_ENABLED=False, MES_USER_FRONTEND_ORIGIN=FRONTEND,
        MES_USER_OAUTH_CALLBACK_ORIGIN=ORIGIN,
        MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
        MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-UNVISITED-PAGE',
        MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-SESSION-BROWSER',
        MES_USER_OAUTH_APP_ACCESS_TOKEN='SYNTHETIC-SESSION-APP-TOKEN',
        ALLOWED_HOSTS=[urlsplit(ORIGIN).netloc], CSRF_TRUSTED_ORIGINS=[ORIGIN],
        CORS_ALLOWED_ORIGINS=[FRONTEND], CORS_ALLOW_CREDENTIALS=False,
    )
    class BrowserFixtureTests(TestCase):
        def test_native_ticket_session_and_identity(self):
            evidence['python_stage'] = 'synthetic_accounts'
            user = get_user_model().objects.create_user(
                username='SYNTHETIC-SESSION-OWNER', is_superuser=True, is_staff=True)
            other = get_user_model().objects.create_user(
                username='SYNTHETIC-SESSION-OTHER', is_superuser=True, is_staff=True)
            refresh = ScopedTokenObtainPairSerializer.get_token(user)
            jwt = str(refresh.access_token)
            malformed = refresh.access_token
            malformed['mes_sid'] = 'SYNTHETIC-INVALID-SID'
            malformed_jwt = str(malformed)
            mismatched = ScopedTokenObtainPairSerializer.get_token(other).access_token
            mismatched['mes_sid'] = refresh['mes_sid']
            mismatched_jwt = str(mismatched)
            login_digest = vault.digest('client-login', refresh['mes_sid'])
            sensitive.extend([jwt, malformed_jwt, mismatched_jwt, CODE, TOKEN])
            # Keep this transport fixture synchronized with the actual component
            # without pretending to mount React or exercise its async state.
            component = (ROOT / 'frontend/src/components/MesConnectionDialog.tsx').read_text()
            forms = re.findall(r'<form\b[^>]*>', component)
            self.assertTrue(len(forms) == 1, 'Expected one native MES form.')
            self.assertTrue(all(value in forms[0] for value in (
                'method="post"', 'action={MES_SESSION_SUBMIT_URL}', 'target="_blank"', 'rel="noopener"')),
                'Native MES form contract changed.')
            self.assertTrue('noreferrer' not in forms[0], 'Native form must retain an exact Origin.')
            provider = Mock()
            provider.exchange.return_value = UserContextResponse(
                200, {'code': 200, 'data': {'userAccessToken': TOKEN}}, False)
            provider.userinfo.return_value = UserContextResponse(
                200, {'code': 200, 'data': {'userId': MES_USER}}, False)
            client = Client(enforce_csrf_checks=True)
            observed = []
            evidence['request_diagnostics'] = observed
            evidence['csrf_rejections'] = 0
            manifest = json.loads((ROOT / 'deploy/mes-oauth-relay-headers.json').read_text())
            self.assertTrue(manifest['path'] == '/integrations/blacklake/relay.html')
            relay_html = (ROOT / 'frontend/public/integrations/blacklake/relay.html').read_text()

            class SafeCsrfDiagnostic(logging.Handler):
                def emit(self, record):
                    evidence['csrf_rejections'] += 1

            csrf_logger = logging.getLogger('django.security.csrf')
            diagnostic = SafeCsrfDiagnostic()
            csrf_logger.addHandler(diagnostic)
            self.addCleanup(csrf_logger.removeHandler, diagnostic)
            with override_settings(MES_USER_OAUTH_USER_MAP={str(user.pk): str(MES_USER),
                                                           str(other.pk): str(MES_USER + 1)}), \
                    patch('mes_oauth.views.get_provider', return_value=provider), \
                    tempfile.TemporaryDirectory(prefix='wj-mes-session-browser-') as profile:
                certificate, key = synthetic_certificate(profile)
                process = subprocess.Popen(
                    [str(options.node), str(ROOT / 'scripts/check-mes-session-browser.cjs')],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, cwd=ROOT, env={'PATH': os.defpath, 'LC_ALL': 'C'})
                result = None
                try:
                    process.stdin.write(json.dumps({
                        'type': 'init', 'chrome': str(options.chrome),
                        'playwright': str(options.playwright_root / 'index.js'),
                        'profile': str(Path(profile) / 'chrome-profile'),
                        'certificate': str(certificate), 'certificateKey': str(key),
                        'origin': ORIGIN, 'frontend': FRONTEND,
                        'start': START, 'callback': CALLBACK, 'bridge': BRIDGE_PATH,
                        'launch': LAUNCH, 'jwt': jwt, 'malformedJwt': malformed_jwt,
                        'mismatchedJwt': mismatched_jwt, 'code': CODE, 'token': TOKEN,
                        'nonceCookie': COOKIE, 'sessionCookie': settings.SESSION_COOKIE_NAME,
                        'csrfCookie': settings.CSRF_COOKIE_NAME, 'relayPath': manifest['path'],
                        'relayHeaders': manifest['headers'], 'relayHtml': relay_html,
                    }) + '\n')
                    process.stdin.flush()
                    deadline = time.monotonic() + 55
                    selector = selectors.DefaultSelector()
                    selector.register(process.stdout, selectors.EVENT_READ)
                    self.addCleanup(selector.close)
                    incoming = b''
                    while True:
                        # HTTPS can produce concurrent favicon/CORS requests.
                        # Read raw chunks so TextIO buffering cannot hide an
                        # already-received second line from the selector.
                        while b'\n' not in incoming:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0 or not selector.select(timeout=remaining):
                                self.fail('Owned browser fixture deadline exceeded.')
                            chunk = os.read(process.stdout.fileno(), 65536)
                            if not chunk:
                                break
                            incoming += chunk
                        if b'\n' not in incoming:
                            break
                        line, incoming = incoming.split(b'\n', 1)
                        message = json.loads(line)
                        if message.get('type') == 'result':
                            result = message
                            break
                        self.assertTrue(message.get('type') == 'request', 'Unexpected browser protocol.')
                        parsed = urlsplit(message['url'])
                        self.assertTrue(parsed.scheme == 'https' and parsed.netloc == urlsplit(ORIGIN).netloc,
                                        'Unexpected virtual backend origin.')
                        self.assertFalse(parsed.query or parsed.fragment, 'Backend URL carried query/fragment.')
                        self.assertTrue(parsed.path in (LAUNCH, BRIDGE_PATH, START, CALLBACK, '/admin/'),
                                        'Unexpected backend route.')
                        headers = {name.lower(): value for name, value in message['headers'].items()}
                        body = base64.b64decode(message.get('body', ''))
                        cookie = SimpleCookie()
                        cookie.load(headers.get('cookie', ''))
                        self.assertTrue(not any(value in message['url'] or value in headers.get('referer', '')
                                                for value in sensitive), 'Sensitive URL or Referer.')
                        item = {'route': {LAUNCH: 'launch', BRIDGE_PATH: 'bridge', START: 'start',
                                          CALLBACK: 'callback', '/admin/': 'admin'}[parsed.path],
                                'method': message['method'],
                                'session_cookie': settings.SESSION_COOKIE_NAME in cookie,
                                'origin_frontend': headers.get('origin') == FRONTEND,
                                'origin_backend': headers.get('origin') == ORIGIN,
                                'referer_origin_only': headers.get('referer') in (ORIGIN + '/', FRONTEND + '/')}
                        self.assertTrue(message.get('loopback_tls') is True,
                                        'Every backend request must arrive over fixture TLS.')
                        if parsed.path in (START, CALLBACK) and settings.SESSION_COOKIE_NAME in cookie:
                            session = SessionStore(session_key=cookie[settings.SESSION_COOKIE_NAME].value)
                            item['actor_and_login_bound'] = bool(
                                session.get('_auth_user_id') == str(user.pk)
                                and session.get(SESSION_KEY) == login_digest and session.get(BRIDGE_ONLY) is True
                                and session.get('mes_login_revision') == 1)
                            self.assertTrue(item['actor_and_login_bound'], 'Bridge actor/login binding mismatch.')
                        if message['method'] == 'POST' and parsed.path in (START, CALLBACK):
                            fields = parse_qs(body.decode('ascii'))
                            csrf_values = fields.get('csrfmiddlewaretoken', [])
                            item['csrf_matches_browser_cookie'] = bool(
                                len(csrf_values) == 1 and settings.CSRF_COOKIE_NAME in cookie
                                and _does_token_match(csrf_values[0], cookie[settings.CSRF_COOKIE_NAME].value))
                            self.assertTrue(item['csrf_matches_browser_cookie'], 'Native CSRF mismatch.')
                        if parsed.path == BRIDGE_PATH:
                            fields = parse_qs(body.decode('ascii'))
                            self.assertTrue(set(fields) == {'ticket'} and len(fields['ticket']) == 1,
                                            'Bridge must carry only one body ticket.')
                            self.assertFalse('authorization' in headers, 'Bridge must not carry a JWT.')
                        observed.append(item)
                        # Never inject cookies omitted by the actual browser.
                        client.cookies.clear()
                        extra = {'HTTP_HOST': urlsplit(ORIGIN).netloc,
                                 'HTTP_COOKIE': headers.get('cookie', '')}
                        for name in ('origin', 'referer', 'authorization', 'x-csrftoken',
                                     'access-control-request-method', 'access-control-request-headers'):
                            if name in headers:
                                extra['HTTP_' + name.upper().replace('-', '_')] = headers[name]
                        response = client.generic(message['method'], parsed.path, data=body,
                            content_type=headers.get('content-type', 'application/octet-stream'),
                            secure=True, **extra)
                        item['status'] = response.status_code
                        if parsed.path == LAUNCH and message['method'] == 'POST' and response.status_code == 200:
                            payload = json.loads(response.content)
                            sensitive.append(payload['ticket'])
                            row = MESLoginTicket.objects.get(pk=vault.digest('ticket', payload['ticket']))
                            self.assertTrue(row.actor_id == user.pk and row.login_digest == login_digest,
                                            'Issued ticket must match JWT account/login.')
                            evidence['issued_ticket_actor_and_login_bound'] = True
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
                        process.terminate()  # Only this fixture's owned Node/browser.
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    process.stdin.close()
                    process.stdout.close()
                self.assertTrue(result is not None, 'Browser summary missing.')
                evidence.update(result)
                self.assertTrue(result['ok'], 'Synthetic browser checks failed.')
                self.assertTrue(process.returncode == 0, 'Owned browser process failed.')
            evidence['python_stage'] = 'database_and_provider_assertions'
            self.assertTrue([row['status'] for row in observed
                             if row['route'] == 'launch' and row['method'] == 'POST'] == [403, 200, 403],
                            'Malformed SID / valid account / mismatched account outcomes changed.')
            bridges = [row for row in observed if row['route'] == 'bridge']
            self.assertTrue([row['status'] for row in bridges] == [302, 403], 'Ticket replay outcome changed.')
            self.assertTrue(all(row['origin_frontend'] and row['referer_origin_only'] for row in bridges),
                            'Native ticket form lost exact frontend Origin.')
            native_posts = [row for row in observed if row['route'] in ('start', 'callback') and row['method'] == 'POST']
            self.assertTrue(len(native_posts) == 2 and all(row['status'] == 200 and row['origin_backend']
                and row['referer_origin_only'] and row['csrf_matches_browser_cookie'] for row in native_posts),
                'Native backend form Origin/CSRF contract failed.')
            self.assertTrue(provider.exchange.call_count == 1 and provider.exchange.call_args.args == (CODE,),
                            'Synthetic code exchange count/input mismatch.')
            self.assertTrue(provider.userinfo.call_count == 1 and provider.userinfo.call_args.args == (TOKEN,),
                            'Same-token identity check count/input mismatch.')
            self.assertTrue(MESLoginTicket.objects.count() == 1 and MESLoginSession.objects.count() == 1,
                            'Invalid account/login created extra rows.')
            self.assertTrue(MESLoginTicket.objects.get().consumed_at is not None, 'Ticket not consumed.')
            self.assertTrue(OAuthAttempt.objects.count() == 1 and OAuthAttempt.objects.get().status == 'verified',
                            'Identity attempt not verified.')
            self.assertTrue(MESCredential.objects.count() == 0, 'Identity-only fixture stored a credential.')
            evidence.update(django_requests=len(observed), provider_mock_exchanges=1, provider_mock_userinfo=1,
                actor_and_login_bound=True, identity_only_no_stored_credential=True,
                seeded_browser_cookies=0, csrf_matching_native_posts=2, python_stage='complete')

    return BrowserFixtureTests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--chrome', type=Path, required=True)
    parser.add_argument('--playwright-root', type=Path, required=True)
    parser.add_argument('--log', type=Path, required=True)
    options = parser.parse_args()
    for executable in (options.node, options.chrome):
        if not executable.is_absolute() or not executable.is_file() or not os.access(executable, os.X_OK):
            parser.error('Provide an absolute existing executable; installation is forbidden.')
    if not options.playwright_root.is_absolute() or not (options.playwright_root / 'index.js').is_file():
        parser.error('Provide the absolute existing Playwright package directory.')
    if not options.log.is_absolute():
        parser.error('Use an absolute private log path.')
    fd = os.open(options.log, os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT | os.O_EXCL, 0o600)
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
        os.close(fd)
        parser.error('The log must be a private regular file.')
    evidence = {'started_utc': datetime.now(timezone.utc).isoformat(),
                'automatic_redirect_verified': False, 'driver_navigation_after_302': False}
    sensitive = []
    fixture = types.ModuleType('mes_session_browser_fixture')
    fixture.__file__ = __file__

    def fixture_class(name):
        if name != 'BrowserFixtureTests':
            raise AttributeError(name)
        value = build_case(options, evidence, sensitive)
        setattr(fixture, name, value)
        return value

    fixture.__getattr__ = fixture_class
    sys.modules[fixture.__name__] = fixture
    sys.path.insert(0, str(ROOT / 'scripts'))
    started = time.monotonic()
    captured = io.StringIO()
    result = 1
    try:
        with redirect_stdout(captured), redirect_stderr(captured):
            runner = runpy.run_path(str(ROOT / 'scripts/check-mes-oauth.py'))
            result = runner['main'](['mes_session_browser_fixture.BrowserFixtureTests'])
    except Exception:
        evidence['fixture_exception'] = True
    evidence['diagnostic_error_categories'] = sorted(set(re.findall(
        r'^(AssertionError|TypeError|ValueError|KeyError|RuntimeError|TimeoutError|AttributeError):',
        captured.getvalue(), re.MULTILINE)))
    evidence.update(returncode=result, wall_seconds=round(time.monotonic() - started, 3),
        raw_diagnostics_suppressed=True,
        diagnostic_sensitive_value_detected=any(value in captured.getvalue() for value in sensitive),
        transport='loopback_https_connect_proxy_django_client', real_provider_requests=0,
        production_tls_verified=False, synthetic_certificate_spki_pin=True,
        react_component_mounted=False, os_network_sandbox=False)
    if evidence['diagnostic_sensitive_value_detected']:
        result = 1
        evidence['returncode'] = 1
    evidence['ok'] = result == 0 and evidence.get('ok') is True
    with os.fdopen(fd, 'w', encoding='utf-8') as log:
        json.dump(evidence, log, sort_keys=True, indent=2)
        log.write('\n')
    print(json.dumps({key: value for key, value in evidence.items()
                      if key != 'request_diagnostics'}, sort_keys=True))
    return result


if __name__ == '__main__':
    raise SystemExit(main())
