"""Real callback/client/vault paths with synthetic HTTP and isolated settings only."""
from datetime import datetime, timedelta, timezone
import json
from unittest.mock import patch

from django.conf import settings
from django.test import Client, TestCase, override_settings

from . import vault
from .client import EXCHANGE, USERINFO
from .models import MESCredential, MESCredentialEvent, OAuthAttempt
from .test_oauth import CODE, ORIGIN, TOKEN, synthetic_session
from .test_vault import APP_ID, APP_TOKEN, KEY_ONE, MES_USER, VaultFixture
from .views import CALLBACK, COOKIE, START


class ExpiryDiagnosticsEndToEndTests(VaultFixture, TestCase):
    def post(self, path, data=None):
        return self.client.post(path, {
            'csrfmiddlewaretoken': self.client.cookies['csrftoken'].value,
            **(data or {}),
        }, secure=True, HTTP_ORIGIN=ORIGIN)

    def run_callback(self, mode, expire):
        """Only HTTP transport is replaced; provider, identity and store stay real."""
        self.started_at = self.instant
        self.received_at = self.instant + timedelta(seconds=1)
        with override_settings(MES_USER_TOKEN_EXPIRY_MODE=mode,
                               MES_USER_OAUTH_APP_TOKEN_SOURCE='static',
                               MES_USER_OAUTH_CONTROL_QC_ID=''):
            self.client = Client(enforce_csrf_checks=True)
            self.client.force_login(self.user)
            session = self.client.session
            session['mes_bridge_only'] = True
            session['mes_login_digest'] = self.login_digest
            session['mes_login_revision'] = self.login.revision
            session.save()
            self.assertEqual(self.client.get(START, secure=True).status_code, 200)
            self.assertEqual(self.post(START).status_code, 200)
            self.assertEqual(self.client.get(CALLBACK, secure=True).status_code, 200)
            exchange = synthetic_session(json.dumps({'code': 200, 'data': {
                'userAccessToken': TOKEN, 'expire': expire,
            }}).encode())
            info = synthetic_session(json.dumps({'code': 200, 'data': {
                'userId': MES_USER,
            }}).encode())

            def receive_info(*args, **kwargs):
                self.clock.return_value = self.received_at
                return info.post.return_value

            info.post.side_effect = receive_info
            # Exhaustion fails a third client session, including any unexpected
            # retry, refresh, app issuance or QC/control request.
            capture = (self.assertLogs('mes_oauth.diagnostics', level='WARNING')
                       if mode == 'conservative_minimum'
                       else self.assertNoLogs('mes_oauth.diagnostics', level='WARNING'))
            with patch('mes_oauth.client.requests.Session', side_effect=[exchange, info]) as transport, \
                    capture as logged:
                response = self.post(CALLBACK, {'code': CODE})
            self.assertEqual(transport.call_count, 2)
            self.assertEqual(exchange.post.call_count, 1)
            self.assertEqual(info.post.call_count, 1)
            self.assertTrue(exchange.post.call_args.args[0].endswith(EXCHANGE))
            self.assertTrue(info.post.call_args.args[0].endswith(USERINFO))
            self.assertEqual(info.post.call_args.kwargs['json'], {'userAccessToken': TOKEN})
            self.assertTrue(settings.MES_USER_TOKEN_STORAGE_ENABLED)
            events = []
            for record in (logged.records if logged is not None else []):
                self.assertEqual(record.msg, 'mes_oauth_identity_failure %s')
                events.append(json.loads(record.getMessage().split(' ', 1)[1]))
            self.assertEqual(response.cookies[COOKIE]['max-age'], 0)
            return response, events

    def assert_no_private_values(self, value):
        serialized = json.dumps(value)
        for private in (TOKEN, CODE, APP_TOKEN, KEY_ONE, self.user.username,
                        str(MES_USER), str(APP_ID), self.login_digest,
                        'SYNTHETIC-TENANT', 'SYNTHETIC-LOCAL-PASSWORD'):
            self.assertNotIn(private, serialized)

    def test_conservative_duration_rejects_with_complete_safe_diagnostic(self):
        response, events = self.run_callback('conservative_minimum', 7200)
        self.assertEqual(response.status_code, 502)
        self.assertIn(b'identity_verification_failed', response.content)
        self.assertNotIn(b'provider_token_expired', response.content)
        self.assertEqual(len(events), 1)
        expected = {
            'reason': 'provider_token_expired',
            'exchange_http_attempts': 1, 'userinfo_http_attempts': 1,
            'exchange_http_status': 200, 'userinfo_http_status': 200,
            'exchange_api_code': 200, 'userinfo_api_code': 200,
            'expiry': {
                'stage': 'credential_storage', 'expire_type': 'integer',
                'expire_seconds': 7200, 'elapsed_bound': 'within_300s',
                'elapsed_ms': 1000, 'relative_expired': False, 'unix_expired': True,
                'applied_mode': 'conservative_minimum',
                'request_started_at': '2026-10-04T12:00:00.000000Z',
                'received_at': '2026-10-04T12:00:01.000000Z',
                'relative_expires_at': '2026-10-04T14:00:00.000000Z',
                'unix_expires_at': '1970-01-01T02:00:00.000000Z',
                'interpretation': 'interpretation_conflict',
            },
        }
        self.assertEqual(events[0], expected)
        self.assert_no_private_values(events)
        self.assert_no_private_values(response.content.decode())
        self.assertFalse(MESCredential.objects.exists())
        self.assertFalse(MESCredentialEvent.objects.exists())
        attempt = OAuthAttempt.objects.latest('created_at')
        self.assertEqual(attempt.status, 'rejected')
        self.assertEqual(attempt.error_code, 'provider_token_expired')

    def assert_encrypted_success(self, response, events, provider_deadline):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(events, [])
        row = MESCredential.objects.get(actor_id=self.user.pk)
        self.assertEqual(row.provider_expires_at, provider_deadline)
        self.assertEqual(row.expires_at, self.received_at + timedelta(seconds=600))
        self.assertNotIn(TOKEN.encode(), bytes(row.ciphertext))
        self.assertEqual(vault._open(row), TOKEN)
        self.assertEqual(response.json(), {
            'identity_verified': True, 'expiry_verified': True,
            'live_ready': False, 'credential_stored': True,
            'expires_at': row.expires_at.isoformat(),
        })
        self.assert_no_private_values(response.json())
        self.assertEqual(OAuthAttempt.objects.latest('created_at').status, 'verified')
        self.assertEqual(MESCredentialEvent.objects.filter(action='connected').count(), 1)

    def test_reviewed_relative_fixture_encrypts_real_storage(self):
        response, events = self.run_callback('relative_seconds', 7200)
        self.assert_encrypted_success(response, events, self.started_at + timedelta(seconds=7200))

    def test_reviewed_unix_fixture_encrypts_real_storage(self):
        deadline = self.instant + timedelta(seconds=7200)
        epoch = int(deadline.timestamp())
        response, events = self.run_callback('unix_seconds', epoch)
        self.assert_encrypted_success(response, events, datetime.fromtimestamp(epoch, timezone.utc))
