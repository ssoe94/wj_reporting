"""Built React -> real isolated Django/vault/decoder -> fabricated MES, in Chrome.

No real MES acceptance: the OAuth exchange/UI is replaced by one synthetic
VerifiedUserContext attached to the actual login response's signed session ID.
All inspection HTTP is the existing fabricated raw-source fixture. Python egress
is blocked by check-mes-oauth.py; Chrome uses intercepted virtual HTTPS, a deny
proxy and its own disposable profile. Existing browser processes are untouched.
"""
import argparse
import base64
from datetime import timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
from threading import Thread
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
FRONT = 'https://wj-reporting.onrender.com'  # Virtual, intercepted origin only.
API = '/api/quality/inspection-requests/'
PASSWORD = 'SYNTHETIC-LOCAL-INSPECTION-PASSWORD'
SCREENSHOTS_DIR = None


def build_case(options, evidence):
    from django.core.cache import cache
    from django.test import Client, override_settings
    from django.utils import timezone
    from injection.models import InjectionMonitoringRecord
    from mes_oauth.session_guard import InspectionSession
    from mes_oauth.test_vault import APP_TOKEN, TOKEN
    from production.ai_metrics import business_range
    from production.models import ProductionPlan
    from quality.inspection_blacklake_contract import ITEM_RECORD, TASK_DETAIL, TASK_FINISH
    from quality.inspection_models import InspectionRequest
    from quality.test_inspection_live_adapter import LiveInspectionAdapterTests
    from rest_framework_simplejwt.tokens import AccessToken

    class BrowserFixtureTests(LiveInspectionAdapterTests):
        def create_payload(self, **overrides):
            return super().create_payload(equipment_ref='imm01', **overrides)

        def store_credential(self):
            # Base setup deliberately does not connect its force-auth token.
            # The single vault store below follows the real browser login.
            pass

        def run_browser(self, mode):
            cache.clear()
            day = (timezone.localtime(timezone.now()) - timedelta(hours=8)).date()
            start, _ = business_range(day)
            plan = ProductionPlan.objects.create(plan_date=day, plan_type='injection', machine_name='850T-1',
                part_no='synthetic-part', lot_no='SYNTHETIC-LOT', planned_quantity=500, sequence=1)
            for at, capacity in ((start - timedelta(minutes=1), 100),
                                 (timezone.now() - timedelta(minutes=2), 110),
                                 (timezone.now() - timedelta(minutes=1), 120)):
                InjectionMonitoringRecord.objects.create(machine_name='1호기', device_code='SYNTHETIC-1',
                    timestamp=at, capacity=capacity)
            client = Client(enforce_csrf_checks=True)
            initial = client.get('/api/production/status/', {'date': day.isoformat()}).json()
            canonical = next(row for row in initial['injection'] if row['machine_number'] == 1)
            scope = canonical['inspection_scope']
            self.assertEqual(scope['current_plan_id'], plan.pk)
            self.contract['board_binding'] = {key: scope[key] for key in
                ('business_date', 'machine_number', 'current_plan_id', 'plan_version')}
            self.contract['board_binding'].update(generation=1, reference='SYNTHETIC-BROWSER-PLAN-REVIEW',
                valid_from=(timezone.now() - timedelta(seconds=1)).isoformat(),
                valid_until=self.contract['expires_at'], stale_after_seconds=120)
            if mode == 'unknown':
                self.write_error = TimeoutError('SYNTHETIC-REMOTE-SAVE-UNCERTAIN')
            configuration = override_settings(MES_INSPECTION_CONTRACT=json.dumps(self.contract),
                MES_USER_FRONTEND_ORIGIN=FRONT, ALLOWED_HOSTS=['testserver', urlsplit(FRONT).netloc],
                CSRF_TRUSTED_ORIGINS=[FRONT])
            allowed_get = {'/api/injection/user/me/', '/api/production/status/',
                '/api/production/plan-summary/', '/api/injection/production-matrix/',
                '/api/injection/board-part-cycle-time/'}
            stages = {API + str(self.binding.request_id) + '/' + action + '/'
                      for action in ('mes-save', 'mes-finish', 'mes-reconcile')}
            observations, logins, connected = [], 0, False
            with configuration, tempfile.TemporaryDirectory(prefix='wj-inspection-live-browser-') as profile:
                process = subprocess.Popen([str(options.node), str(ROOT / 'scripts/check-inspection-live-browser.cjs')],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
                    text=True, cwd=ROOT, env={'PATH': os.defpath, 'LC_ALL': 'C'})
                lines = queue.Queue()
                reader = Thread(target=lambda: [lines.put(line) for line in process.stdout], daemon=True)
                reader.start()
                result = None
                try:
                    process.stdin.write(json.dumps({'type': 'init', 'origin': FRONT, 'mode': mode,
                        'chrome': str(options.chrome), 'playwright': str(options.playwright_root / 'index.js'),
                        'profile': profile, 'dist': str(ROOT / 'frontend/dist'),
                        'screenshotsDir': str(SCREENSHOTS_DIR) if SCREENSHOTS_DIR else None,
                        'username': self.editor.username, 'password': PASSWORD,
                        'requestId': self.binding.request_id, 'actorId': self.editor.pk,
                        'sensitive': [TOKEN, APP_TOKEN]}) + '\n')
                    process.stdin.flush()
                    while True:
                        try:
                            message = json.loads(lines.get(timeout=55))
                        except queue.Empty:
                            self.fail('Owned inspection browser fixture exceeded deadline.')
                        if message.get('type') == 'result':
                            result = message
                            break
                        self.assertEqual(message.get('type'), 'request')
                        parsed = urlsplit(message['url'])
                        self.assertEqual((parsed.scheme, parsed.netloc), ('https', urlsplit(FRONT).netloc))
                        self.assertFalse(parsed.fragment)
                        method = message['method']
                        self.assertTrue((method == 'GET' and (parsed.path in allowed_get or parsed.path.startswith(API)))
                            or (method == 'POST' and (parsed.path == '/api/token/' or parsed.path in stages)),
                            'Unexpected fixture API boundary.')
                        headers = {name.lower(): value for name, value in message['headers'].items()}
                        client.cookies.clear()
                        extra = {'HTTP_HOST': parsed.netloc, 'HTTP_COOKIE': headers.get('cookie', '')}
                        for name in ('origin', 'referer', 'authorization', 'x-csrftoken', 'idempotency-key'):
                            if name in headers:
                                extra['HTTP_' + name.upper().replace('-', '_')] = headers[name]
                        response = client.generic(method, parsed.path + ('?' + parsed.query if parsed.query else ''),
                            data=base64.b64decode(message.get('body', '')),
                            content_type=headers.get('content-type', 'application/octet-stream'), secure=True, **extra)
                        if parsed.path == '/api/token/' and method == 'POST' and response.status_code == 200:
                            self.assertFalse(connected, 'Only one explicit OAuth replacement seam per login fixture.')
                            self.session = InspectionSession.from_token(self.editor, AccessToken(response.json()['access']))
                            LiveInspectionAdapterTests.store_credential(self)
                            connected, logins = True, logins + 1
                        self.assertNotIn(TOKEN.encode(), response.content)
                        self.assertNotIn(APP_TOKEN.encode(), response.content)
                        observation = {'path': parsed.path, 'method': method, 'status': response.status_code}
                        if parsed.path in stages:
                            body = response.json()
                            observation['phase'] = body.get('mes_workflow', body.get('request', {}).get('mes_workflow', {})).get('phase')
                        observations.append(observation)
                        response_headers = dict(response.items())
                        if response.cookies:
                            response_headers['set-cookie'] = '\n'.join(item.OutputString() for item in response.cookies.values())
                        process.stdin.write(json.dumps({'type': 'response', 'id': message['id'],
                            'status': response.status_code, 'headers': response_headers,
                            'body': base64.b64encode(response.content).decode('ascii')}) + '\n')
                        process.stdin.flush()
                    process.wait(timeout=10)
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=8)
                        except subprocess.TimeoutExpired:
                            process.kill(); process.wait(timeout=5)
                    process.stdin.close(); reader.join(timeout=2); process.stdout.close()
                evidence.setdefault('cases', []).append({'mode': mode, **(result or {}), 'api': observations})
                self.assertIsNotNone(result)
                self.assertTrue(result['ok'], 'Browser stage failed: ' + result.get('stage', 'unknown'))
                self.assertEqual(process.returncode, 0)
            self.assertEqual(logins, 1)
            self.assertEqual([path for path, _ in self.writes()],
                             [ITEM_RECORD, TASK_FINISH] if mode == 'complete' else [ITEM_RECORD])
            self.assertEqual(sum(path == TASK_DETAIL for path, _ in self.calls), 4 if mode == 'complete' else 2)
            for action in ('exchange', 'refresh', 'fallback'):
                getattr(self.identity, action).assert_not_called()
            request = InspectionRequest.objects.get(pk=self.binding.request_id)
            self.assertEqual(request.mes_snapshot['verified_stage']['state'], 'completed' if mode == 'complete' else 'open')
            self.assertEqual(request.injection_receipt_readiness, 'not_verified')
            if mode == 'complete':
                public = client.get('/api/production/status/', {'date': day.isoformat()}).json()
                quality = next(row for row in public['injection'] if row['machine_number'] == 1)['inspection_status']
                self.assertFalse(quality['complete'])
                self.assertEqual(quality['first']['status'], 'unknown')
                self.assertEqual(quality['first']['checks'][0]['status'], 'passed')
                self.assertIsNotNone(quality['first']['checks'][0]['checked_at'])
                self.assertNotIn(self.binding.qc_id, json.dumps(public))
            evidence.update(real_mes_acceptance=False, real_provider_requests=0,
                oauth_seam='one_synthetic_verified_context_bound_to_actual_login_sid',
                production_row_mocked=False, frontend_api_mocked=False,
                source_sha256={name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in (
                    'backend/quality/inspection_live_adapter.py', 'backend/quality/inspection_mes_stages.py',
                    'backend/quality/inspection_live_readback.py', 'backend/quality/inspection_board_repository.py')})

        def test_browser_save_finish_and_persisted_public_board(self):
            self.run_browser('complete')

        def test_browser_unknown_write_requires_read_only_reconciliation(self):
            self.run_browser('unknown')

    # Reuse fixture setup/helpers only; do not rerun its unrelated unit tests.
    for name in dir(LiveInspectionAdapterTests):
        if name.startswith('test_'):
            setattr(BrowserFixtureTests, name, None)
    return BrowserFixtureTests


if __name__ == '__main__':
    capture_options = argparse.ArgumentParser(add_help=False)
    capture_options.add_argument('--screenshots-dir', type=Path)
    capture, remaining = capture_options.parse_known_args()
    if capture.screenshots_dir:
        if not capture.screenshots_dir.is_absolute() or not capture.screenshots_dir.is_dir():
            capture_options.error('Screenshots require an existing absolute output directory.')
        SCREENSHOTS_DIR = capture.screenshots_dir
    sys.argv = [sys.argv[0], *remaining]
    spec = importlib.util.spec_from_file_location('inspection_browser_harness', ROOT / 'scripts/check-mes-oauth-browser.py')
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    harness.build_case = build_case
    raise SystemExit(harness.main())
