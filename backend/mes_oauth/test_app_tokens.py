"""Synthetic issuance evidence/budget tests; all provider sessions are fabricated."""
from concurrent.futures import ThreadPoolExecutor
import json
import traceback
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from .app_tokens import (ALI, ISSUE_PATH, AppCredentialUnavailable, AppTokenSupplier,
                         app_credential_binding, app_credentials_configured)
from .test_oauth import synthetic_session


KEY, SECRET, TOKEN = 'SYNTHETIC-APP-KEY', 'SYNTHETIC-APP-SECRET', 'SYNTHETIC-ISSUED-APP'
APP_ID = '9000000000000001'


@override_settings(MES_USER_OAUTH_ENABLED=True, MES_USER_OAUTH_APP_TOKEN_SOURCE='server',
    MES_USER_OAUTH_PROVIDER_ORIGIN=ALI, MES_USER_OAUTH_APP_ID=APP_ID,
    MES_USER_OAUTH_APP_KEY=KEY, MES_USER_OAUTH_APP_SECRET=SECRET,
    MES_USER_OAUTH_APP_ACCESS_TOKEN='STATIC-NOT-USED')
class AppTokenTests(SimpleTestCase):
    def supplier(self, body=None, *, status=200, history=()):
        body = body if body is not None else {'code': 200, 'data': {'appAccessToken': TOKEN, 'expire': 7200}}
        self.session = synthetic_session(json.dumps(body).encode(), status=status, history=history)
        self.factory = Mock(return_value=self.session)
        self.clock = Mock(return_value=1000.0)
        return AppTokenSupplier(session_factory=self.factory, clock=self.clock)

    def test_configuration_and_static_mode_never_issue(self):
        supplier = self.supplier()
        self.assertTrue(app_credentials_configured())
        self.assertEqual(len(app_credential_binding()), 64)
        with override_settings(MES_USER_OAUTH_APP_TOKEN_SOURCE='static'):
            self.assertEqual(supplier.get(), 'STATIC-NOT-USED')
        self.factory.assert_not_called()

    def test_off_invalid_source_header_app_or_control_blocks_before_network(self):
        changes = [
            {'MES_USER_OAUTH_ENABLED': False}, {'MES_USER_OAUTH_APP_TOKEN_SOURCE': 'unknown'},
            {'MES_USER_OAUTH_PROVIDER_ORIGIN': 'https://v3-hw.blacklake.cn'},
            {'MES_USER_OAUTH_APP_CREDENTIAL_SOURCE': 'unknown'},
            {'MES_USER_OAUTH_APP_TOKEN_HEADER': 'Authorization'},
            {'MES_USER_OAUTH_APP_SECRET': ''},
        ]
        changes += [{'MES_USER_OAUTH_APP_ID': value} for value in ('', True, 42, '01', str(2**63))]
        changes += [{'MES_USER_OAUTH_CONTROL_QC_ID': value} for value in (None, True, 42, '0', '1.0', str(2**63))]
        for change in changes:
            with self.subTest(fields=list(change)), override_settings(**change):
                supplier = self.supplier()
                with self.assertRaises(AppCredentialUnavailable):
                    supplier.get()
                self.factory.assert_not_called()

    def test_existing_server_secrets_require_explicit_source_without_fallback(self):
        supplier = self.supplier()
        with override_settings(MES_APP_KEY=KEY, MES_APP_SECRET=SECRET,
                MES_USER_OAUTH_APP_KEY='', MES_USER_OAUTH_APP_SECRET=''):
            self.assertFalse(app_credentials_configured())
            with override_settings(MES_USER_OAUTH_APP_CREDENTIAL_SOURCE='existing_mes'):
                self.assertTrue(app_credentials_configured())
                with self.assertLogs('mes_oauth.diagnostics', level='WARNING'):
                    self.assertEqual(supplier.get(), TOKEN)
                self.session.post.assert_called_once_with(ALI + ISSUE_PATH,
                    json={'appKey': KEY, 'appSecret': SECRET}, headers={'Accept': 'application/json'},
                    timeout=(3, 10), allow_redirects=False, stream=True)
                self.assertFalse(self.session.trust_env)
                with override_settings(MES_APP_SECRET=''):
                    self.assertFalse(app_credentials_configured())

    def test_expiry_cache_is_bounded_and_never_renews_within_same_attempt(self):
        supplier = self.supplier()
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
            self.assertEqual(supplier.get(), TOKEN)
        self.clock.return_value = 4539.9
        self.assertEqual(supplier.get(), TOKEN)
        self.clock.return_value = 4540
        with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
            supplier.get()
        self.session.post.assert_called_once()
        prefix, payload = logs.records[0].getMessage().split(' ', 1)
        self.assertEqual(prefix, 'mes_oauth_app_supply')
        event = json.loads(payload)
        self.assertEqual(set(event), {'reason', 'http_attempts', 'http_status', 'api_code',
                                     'provider_expire_seconds', 'issued_at'})
        self.assertEqual({k: v for k, v in event.items() if k != 'issued_at'}, {
            'reason': 'app_credential_issued', 'http_attempts': 1, 'http_status': 200,
            'api_code': 200, 'provider_expire_seconds': 7200})
        self.assertRegex(event['issued_at'], r'^\d{4}-\d{2}-\d{2}T.*\+00:00$')
        for private in (KEY, SECRET, TOKEN, APP_ID):
            self.assertNotIn(private, ''.join(logs.output))

    def test_ambiguous_or_missing_expiry_has_no_default_fallback(self):
        for value in (None, True, '7200', 0, 60, -1, 2**63):
            with self.subTest(expire=value):
                supplier = self.supplier({'code': 200, 'data': {
                    'appAccessToken': TOKEN, 'expire': value, 'expiresIn': 7200}})
                with self.assertLogs('mes_oauth.diagnostics', level='WARNING'):
                    with self.assertRaises(AppCredentialUnavailable):
                        supplier.get()
                with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
                    supplier.get()
                self.session.post.assert_called_once()

    def test_documented_long_ttl_keeps_local_lifetime_and_one_issuance_budget(self):
        for duration in (86401, 2**63 - 1):
            with self.subTest(duration=duration):
                supplier = self.supplier({'code': 200, 'data': {
                    'appAccessToken': TOKEN, 'expire': duration}})
                with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
                    self.assertEqual(supplier.get(), TOKEN)
                event = json.loads(logs.records[0].getMessage().split(' ', 1)[1])
                self.assertEqual(event['provider_expire_seconds'], duration)
                self.clock.return_value = 4539.9
                self.assertEqual(supplier.get(), TOKEN)
                self.clock.return_value = 4540
                with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
                    supplier.get()
                self.session.post.assert_called_once()
                for private in (KEY, SECRET, TOKEN):
                    self.assertNotIn(private, ''.join(logs.output))

    def test_rejected_token_preserves_only_bounded_observed_expiry_metadata(self):
        supplier = self.supplier({'code': 200, 'data': {
            'appAccessToken': SECRET + '\r\n', 'expire': 86401}})
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
            with self.assertRaises(AppCredentialUnavailable):
                supplier.get()
        event = json.loads(logs.records[0].getMessage().split(' ', 1)[1])
        self.assertEqual(event['reason'], 'app_credential_unavailable')
        self.assertEqual(event['provider_expire_seconds'], 86401)
        self.assertNotIn(SECRET, ''.join(logs.output))
        with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
            supplier.get()
        self.session.post.assert_called_once()

    def test_failure_budget_survives_elapsed_time_and_never_logs_exception_or_payload(self):
        supplier = self.supplier()
        self.session.post.side_effect = RuntimeError(KEY + SECRET + TOKEN)
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
            try:
                supplier.get()
            except AppCredentialUnavailable:
                rendered = traceback.format_exc()
            else:
                self.fail('Failed issuance was accepted.')
        self.clock.return_value = 999999
        with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
            supplier.get()
        self.session.post.assert_called_once()
        event = json.loads(logs.records[0].getMessage().split(' ', 1)[1])
        self.assertEqual(event['http_attempts'], 1)
        self.assertIsNone(event['http_status'])
        for private in (KEY, SECRET, TOKEN):
            self.assertNotIn(private, rendered + ''.join(logs.output))

    def test_session_construction_failure_spends_budget_with_zero_http_attempts(self):
        factory = Mock(side_effect=RuntimeError(SECRET))
        supplier = AppTokenSupplier(session_factory=factory)
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
            with self.assertRaises(AppCredentialUnavailable):
                supplier.get()
        with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
            supplier.get()
        factory.assert_called_once()
        self.assertEqual(json.loads(logs.records[0].getMessage().split(' ', 1)[1])['http_attempts'], 0)

    def test_concurrent_uses_of_one_supplier_issue_once(self):
        supplier = self.supplier()
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
            with ThreadPoolExecutor(max_workers=4) as executor:
                self.assertEqual(list(executor.map(lambda _: supplier.get(), range(8))), [TOKEN] * 8)
        self.session.post.assert_called_once()
        self.assertEqual(len(logs.records), 1)

    def test_latency_and_configuration_changes_cannot_expand_budget_or_lifetime(self):
        supplier = self.supplier()
        self.clock.side_effect = [1000.0, 5000.0]
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING'):
            with self.assertRaises(AppCredentialUnavailable):
                supplier.get()
        self.clock.side_effect = None
        self.clock.return_value = 6000
        with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
            supplier.get()
        with override_settings(MES_USER_OAUTH_APP_SECRET='ROTATED-SYNTHETIC'):
            with self.assertRaisesMessage(AppCredentialUnavailable, 'changed'):
                supplier.get()
        self.session.post.assert_called_once()

    def test_invalid_http_json_tokens_and_api_codes_do_not_escape(self):
        cases = [
            (b'{}', 401, []), (b'{}', 200, [object()]), (b'{', 200, []),
            (b'{"code":200,"code":200}', 200, []), (b'x' * 65537, 200, []),
        ]
        for code, token in ((True, TOKEN), (3401, TOKEN), (200, ''), (200, 'bad\r\nvalue')):
            cases.append((json.dumps({'code': code, 'message': SECRET,
                'data': {'appAccessToken': token, 'expire': 7200}}).encode(), 200, []))
        for body, status, history in cases:
            with self.subTest(status=status, size=len(body)):
                session = synthetic_session(body, status=status, history=history)
                supplier = AppTokenSupplier(session_factory=Mock(return_value=session))
                with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
                    with self.assertRaises(AppCredentialUnavailable):
                        supplier.get()
                with self.assertRaisesMessage(AppCredentialUnavailable, 'budget_exhausted'):
                    supplier.get()
                session.post.assert_called_once()
                for private in (KEY, SECRET, TOKEN):
                    self.assertNotIn(private, ''.join(logs.output))

    def test_diagnostic_bounds_and_logging_failure_cannot_retry_issuance(self):
        supplier = self.supplier()
        supplier._attempts, supplier._http_status, supplier._api_code = True, SECRET, 2**40
        supplier._provider_seconds, supplier._issued_at = TOKEN, SECRET
        self.assertEqual(supplier.diagnostic_snapshot(), dict.fromkeys([
            'http_attempts', 'http_status', 'api_code', 'provider_expire_seconds', 'issued_at']))
        supplier = self.supplier()
        with patch('mes_oauth.app_tokens.logging.getLogger') as logger:
            logger.return_value.warning.side_effect = RuntimeError(SECRET)
            self.assertEqual(supplier.get(), TOKEN)
            self.assertEqual(supplier.get(), TOKEN)
        self.session.post.assert_called_once()
