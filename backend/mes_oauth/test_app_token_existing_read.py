"""Existing APP supply reads use only synthetic memory; never issue credentials."""
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from .app_tokens import (
    ALI, AppCredentialUnavailable, AppTokenSupplier, app_credential_binding,
    get_existing_app_access_token,
)


@override_settings(
    MES_USER_OAUTH_ENABLED=True,
    MES_USER_OAUTH_APP_TOKEN_SOURCE='server',
    MES_USER_OAUTH_PROVIDER_ORIGIN=ALI,
    MES_USER_OAUTH_APP_CREDENTIAL_SOURCE='dedicated',
    MES_USER_OAUTH_APP_KEY='SYNTHETIC-KEY',
    MES_USER_OAUTH_APP_SECRET='SYNTHETIC-SECRET',
    MES_USER_OAUTH_APP_ACCESS_TOKEN='SYNTHETIC-STATIC',
    MES_USER_OAUTH_APP_ID='91000000000000009',
    MES_USER_TOKEN_APP_ID='91000000000000009',
    MES_USER_OAUTH_APP_TOKEN_HEADER='access_token',
    MES_USER_OAUTH_CONTROL_QC_ID='',
)
class ExistingAppTokenReadTests(SimpleTestCase):
    def setUp(self):
        self.clock = Mock(return_value=1000.0)
        self.factory = Mock(side_effect=AssertionError('APP reads cannot create a session.'))
        self.supplier = AppTokenSupplier(session_factory=self.factory, clock=self.clock)
        issue = patch.object(self.supplier, '_issue', side_effect=
            AssertionError('APP reads cannot issue a credential.'))
        self.issue = issue.start()
        self.addCleanup(issue.stop)
        network = patch('socket.socket.connect', side_effect=
            AssertionError('APP reads cannot access a provider.'))
        self.network = network.start()
        self.addCleanup(network.stop)

    def cache_existing(self):
        # Model an already populated process cache, without exercising issuance.
        self.supplier._binding = app_credential_binding()
        self.supplier._token = 'SYNTHETIC-CACHED-APP'
        self.supplier._deadline = 1060.0
        self.supplier._retry_after = 1100.0
        self.supplier._attempts = 7
        self.supplier._provider_seconds = 7200
        self.supplier._issued_at = '2026-10-07T00:00:00+00:00'

    def state(self):
        return {name: getattr(self.supplier, name) for name in (
            '_binding', '_token', '_deadline', '_retry_after', '_attempts',
            '_provider_seconds', '_issued_at',
        )}

    def assert_read_only(self, before):
        self.assertEqual(self.state(), before)
        self.issue.assert_not_called()
        self.factory.assert_not_called()
        self.network.assert_not_called()

    def unavailable(self, reason='app_credential_existing_supply_unavailable'):
        before = self.state()
        with self.assertRaises(AppCredentialUnavailable) as caught:
            self.supplier.peek_existing()
        self.assertEqual(caught.exception.args, (reason,))
        self.assertNotIn('SYNTHETIC', str(caught.exception))
        self.assert_read_only(before)

    def test_static_supply_returns_unchanged_token_without_touching_existing_cache(self):
        self.cache_existing()
        before = self.state()
        with override_settings(MES_USER_OAUTH_APP_TOKEN_SOURCE='static'):
            self.assertEqual(self.supplier.peek_existing(), 'SYNTHETIC-STATIC')
        self.assert_read_only(before)
        self.clock.assert_not_called()

    def test_same_binding_usable_cache_is_read_without_deadline_or_cooldown_renewal(self):
        self.cache_existing()
        before = self.state()
        for now in (1000.0, 1059.999):
            with self.subTest(now=now):
                self.clock.return_value = now
                self.assertEqual(self.supplier.peek_existing(), 'SYNTHETIC-CACHED-APP')
                self.assert_read_only(before)

    def test_public_existing_supply_helper_never_calls_issuing_get(self):
        self.cache_existing()
        before = self.state()
        with patch('mes_oauth.app_tokens._supplier', self.supplier), \
                patch.object(self.supplier, 'get', side_effect=
                    AssertionError('Existing reads must not enter issuing get.')) as get:
            self.assertEqual(get_existing_app_access_token(), 'SYNTHETIC-CACHED-APP')
            self.clock.return_value = 1060.0
            with self.assertRaises(AppCredentialUnavailable) as caught:
                get_existing_app_access_token()
            self.assertEqual(caught.exception.args, ('app_credential_existing_supply_unavailable',))
            get.assert_not_called()
        self.assert_read_only(before)

    def test_empty_cache_never_uses_configured_static_fallback_or_issues(self):
        self.unavailable()
        self.cache_existing()
        self.supplier._token = None
        self.unavailable()

    def test_deadline_equality_and_expired_cache_are_fixed_failures_without_cache_mutation(self):
        self.cache_existing()
        for now in (1060.0, 1061.0):
            with self.subTest(now=now):
                self.clock.return_value = now
                self.unavailable()

    def test_changed_app_key_identity_header_or_target_cannot_reuse_or_replace_cache(self):
        self.cache_existing()
        for change in (
            {'MES_USER_OAUTH_APP_SECRET': 'SYNTHETIC-ROTATED'},
            {'MES_USER_OAUTH_APP_ID': '91000000000000011',
             'MES_USER_TOKEN_APP_ID': '91000000000000011'},
            {'MES_USER_OAUTH_APP_TOKEN_HEADER': 'X-AUTH'},
            {'MES_USER_OAUTH_CONTROL_QC_ID': '9000000000000042'},
        ):
            with self.subTest(fields=list(change)), override_settings(**change):
                self.unavailable()
        self.assertEqual(self.supplier.peek_existing(), 'SYNTHETIC-CACHED-APP')

    def test_oauth_off_or_nonboolean_enablement_rejects_both_static_and_cached_supply(self):
        self.cache_existing()
        for mode in ('server', 'static'):
            for enabled in (False, None, 1, 'true'):
                with self.subTest(mode=mode, enabled=enabled), override_settings(
                        MES_USER_OAUTH_APP_TOKEN_SOURCE=mode, MES_USER_OAUTH_ENABLED=enabled):
                    self.unavailable('oauth_disabled')
        self.clock.assert_not_called()

    def test_invalid_current_configuration_is_fixed_failure_without_cache_or_network_effects(self):
        self.cache_existing()
        for change in (
            {'MES_USER_OAUTH_APP_TOKEN_SOURCE': 'unknown'},
            {'MES_USER_OAUTH_APP_SECRET': ''},
            {'MES_USER_OAUTH_PROVIDER_ORIGIN': 'https://v3-hw.blacklake.cn'},
            {'MES_USER_OAUTH_APP_TOKEN_HEADER': 'SYNTHETIC-INVALID-HEADER'},
            {'MES_USER_OAUTH_CONTROL_QC_ID': True},
            {'MES_USER_OAUTH_APP_TOKEN_SOURCE': 'static', 'MES_USER_OAUTH_APP_ACCESS_TOKEN': ''},
        ):
            with self.subTest(fields=list(change)), override_settings(**change):
                self.unavailable('app_credential_unconfigured')
