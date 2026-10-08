"""Synthetic app issuance/cache checks; no external provider calls."""
from concurrent.futures import ThreadPoolExecutor
import json
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from .app_tokens import (ALI, ISSUE_PATH, AppCredentialUnavailable, AppTokenSupplier,
                         app_credential_binding, app_credentials_configured)
from .views import get_provider, reviewed_configuration


@override_settings(MES_USER_OAUTH_ENABLED=True, MES_USER_OAUTH_APP_TOKEN_SOURCE='server',
    MES_USER_OAUTH_PROVIDER_ORIGIN=ALI, MES_USER_OAUTH_APP_KEY='SYNTHETIC-KEY',
    MES_USER_OAUTH_APP_SECRET='SYNTHETIC-SECRET', MES_USER_OAUTH_APP_ACCESS_TOKEN='STATIC-NOT-USED')
class AppTokenTests(SimpleTestCase):
    def setUp(self):
        self.clock = Mock(return_value=1000.0)
        self.response = Mock(status_code=200, history=[])
        self.response.__enter__ = Mock(return_value=self.response)
        self.response.__exit__ = Mock(return_value=False)
        self.session = Mock()
        self.session.__enter__ = Mock(return_value=self.session)
        self.session.__exit__ = Mock(return_value=False)
        self.session.post.return_value = self.response
        self.factory = Mock(return_value=self.session)
        self.supplier = AppTokenSupplier(session_factory=self.factory, clock=self.clock)
        self.body({'appAccessToken': 'SYNTHETIC-APP', 'expire': 7200})

    def body(self, data, *, code=200):
        self.response.iter_content.side_effect = lambda _: iter([
            json.dumps({'code': code, 'data': data}).encode()])

    def test_off_and_invalid_configuration_never_issue_or_fall_back(self):
        for change in ({'MES_USER_OAUTH_ENABLED': False},
                       {'MES_USER_OAUTH_APP_TOKEN_SOURCE': 'unknown'},
                       {'MES_USER_OAUTH_APP_SECRET': ''},
                       {'MES_USER_OAUTH_PROVIDER_ORIGIN': 'https://v3-hw.blacklake.cn'}):
            with self.subTest(fields=list(change)), override_settings(**change):
                with self.assertRaises(AppCredentialUnavailable):
                    self.supplier.get()
        self.factory.assert_not_called()

    def test_configuration_and_start_readiness_do_not_issue(self):
        self.assertTrue(app_credentials_configured())
        with override_settings(MES_USER_OAUTH_CALLBACK_ORIGIN='https://testserver',
                MES_USER_OAUTH_LAUNCH_URL=ALI, MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC'):
            reviewed_configuration()
        self.factory.assert_not_called()

    def test_invalid_control_scope_blocks_before_issuance(self):
        for target in (None, True, 42, '0', '-1', '01', '1.0', '1/other', str(2**63)):
            with self.subTest(target=target), override_settings(MES_USER_OAUTH_CONTROL_QC_ID=target):
                self.assertFalse(app_credentials_configured())
                with self.assertRaises(AppCredentialUnavailable):
                    self.supplier.get()
        self.factory.assert_not_called()

    def test_static_default_does_not_issue(self):
        with override_settings(MES_USER_OAUTH_APP_TOKEN_SOURCE='static'):
            self.assertEqual(self.supplier.get(), 'STATIC-NOT-USED')
        self.factory.assert_not_called()

    def test_expire_bounds_cache_and_exact_header_transport(self):
        self.assertEqual(self.supplier.get(), 'SYNTHETIC-APP')
        self.clock.return_value = 4539.9
        self.assertEqual(self.supplier.get(), 'SYNTHETIC-APP')
        self.assertEqual(self.session.post.call_count, 1)
        self.clock.return_value = 4540
        self.body({'appAccessToken': 'SYNTHETIC-NEW', 'expire': 120})
        self.assertEqual(self.supplier.get(), 'SYNTHETIC-NEW')
        self.assertEqual(self.session.post.call_count, 2)
        self.assertFalse(self.session.trust_env)
        self.session.post.assert_called_with(ALI + ISSUE_PATH,
            json={'appKey': 'SYNTHETIC-KEY', 'appSecret': 'SYNTHETIC-SECRET'},
            headers={'Accept': 'application/json'}, timeout=(3, 10), allow_redirects=False, stream=True)
        self.clock.return_value = 4600
        self.supplier.get()
        self.assertEqual(self.session.post.call_count, 3)

    def test_missing_expire_has_no_expiresin_or_default_fallback(self):
        invalid = [None, True, '7200', 0, 60, -1, 2**63]
        for value in invalid:
            with self.subTest(value=value):
                supplier = AppTokenSupplier(session_factory=self.factory, clock=self.clock)
                self.body({'appAccessToken': 'SYNTHETIC-APP', 'expire': value, 'expiresIn': 7200})
                with self.assertRaises(AppCredentialUnavailable):
                    supplier.get()
        self.body({'appAccessToken': 'SYNTHETIC-APP', 'expiresIn': 7200})
        with self.assertRaises(AppCredentialUnavailable):
            self.supplier.get()

    def test_provider_long_ttl_does_not_extend_local_cache(self):
        for duration in (86401, 1791244800, 2**63 - 1):
            with self.subTest(duration=duration):
                supplier = AppTokenSupplier(session_factory=self.factory, clock=self.clock)
                self.clock.return_value = 1000
                self.body({'appAccessToken': 'SYNTHETIC-APP', 'expire': duration})
                self.session.post.reset_mock()
                self.assertEqual(supplier.get(), 'SYNTHETIC-APP')
                self.assertEqual(supplier.status()['provider_expire_seconds'], duration)
                self.assertEqual(supplier.status()['usable_for_seconds'], 3540)
                self.clock.return_value = 4539.9
                self.assertEqual(supplier.get(), 'SYNTHETIC-APP')
                self.session.post.assert_called_once()
                self.clock.return_value = 4540
                self.assertEqual(supplier.status()['usable_for_seconds'], 0)

    def test_rejected_token_retains_only_bounded_expiry_metadata(self):
        for duration, expected in ((86401, 86401), (2**63 - 1, 2**63 - 1),
                                   (None, None), (True, None), ('7200', None),
                                   (60, None), (2**63, None)):
            with self.subTest(duration=duration):
                supplier = AppTokenSupplier(session_factory=self.factory, clock=self.clock)
                self.body({'appAccessToken': 'SYNTHETIC-SECRET\n', 'expire': duration})
                with self.assertRaises(AppCredentialUnavailable):
                    supplier.get()
                status = supplier.status()
                self.assertEqual(status['provider_expire_seconds'], expected)
                self.assertEqual(status['usable_for_seconds'], 0)
                self.assertIsNone(supplier._token)
                self.assertNotIn('SYNTHETIC', json.dumps(status))

    def test_latency_cannot_extend_provider_lifetime(self):
        self.body({'appAccessToken': 'SYNTHETIC-APP', 'expire': 61})
        self.clock.side_effect = [1000, 1002, 1002]
        with self.assertRaises(AppCredentialUnavailable):
            self.supplier.get()
        self.assertIsNone(self.supplier._token)

    def test_concurrent_calls_share_one_issuance_in_process(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.supplier.get(), range(8)))
        self.assertEqual(results, ['SYNTHETIC-APP'] * 8)
        self.session.post.assert_called_once()

    def test_key_rotation_separates_cache_but_app_renewal_keeps_policy_binding(self):
        original = app_credential_binding()
        self.supplier.get()
        self.clock.return_value = 4540
        self.body({'appAccessToken': 'SYNTHETIC-NEW', 'expire': 7200})
        self.supplier.get()
        self.assertEqual(original, app_credential_binding())
        with override_settings(MES_USER_OAUTH_APP_SECRET='SYNTHETIC-ROTATED'):
            self.assertNotEqual(original, app_credential_binding())
            self.supplier.get()
        self.assertEqual(self.session.post.call_count, 3)

    def test_failure_has_no_retry_no_payload_and_short_cooldown(self):
        self.session.post.side_effect = RuntimeError('SYNTHETIC-SECRET PRIVATE-BODY')
        for _ in range(2):
            with self.assertRaises(AppCredentialUnavailable) as caught:
                self.supplier.get()
            self.assertNotIn('SYNTHETIC', str(caught.exception))
            self.assertNotIn('PRIVATE', repr(caught.exception))
        self.session.post.assert_called_once()
        self.clock.return_value = 1030
        self.session.post.side_effect = None
        self.assertEqual(self.supplier.get(), 'SYNTHETIC-APP')
        self.assertEqual(self.session.post.call_count, 2)

    def test_invalid_http_json_and_token_never_enter_cache(self):
        for raw in (b'{"code":200,"code":200}', b'NaN', b'{}', b'X' * 65537,
                    b'{"code":200,"data":{"appAccessToken":"x\\r\\ny","expire":7200}}'):
            with self.subTest(length=len(raw)):
                self.response.iter_content.side_effect = lambda _, raw=raw: iter([raw])
                with self.assertRaises(AppCredentialUnavailable):
                    AppTokenSupplier(session_factory=self.factory, clock=self.clock).get()
        self.response.status_code = 302
        self.response.iter_content.reset_mock()
        with self.assertRaises(AppCredentialUnavailable):
            self.supplier.get()
        self.response.iter_content.assert_not_called()

    def test_supply_failure_prevents_exchange_client_creation(self):
        self.session.post.side_effect = TimeoutError('SYNTHETIC-SECRET')
        with patch('mes_oauth.callback_app_tokens.AppTokenSupplier', return_value=self.supplier), \
                patch('mes_oauth.views.BlacklakeUserOAuthClient') as client:
            with self.assertRaises(AppCredentialUnavailable):
                get_provider()
        client.assert_not_called()

    def test_supplier_passes_token_unchanged_without_granting_user_authority(self):
        with patch('mes_oauth.callback_app_tokens.AppTokenSupplier', return_value=self.supplier), \
                patch('mes_oauth.views.BlacklakeUserOAuthClient') as client:
            get_provider()
        client.assert_called_once_with(origin=ALI, app_access_token='SYNTHETIC-APP', app_token_header='access_token')
        client.return_value.exchange.assert_not_called()
        client.return_value.userinfo.assert_not_called()

    def test_status_records_returned_duration_without_secret_or_network(self):
        self.assertEqual(self.supplier.status()['http_attempts'], 0)
        self.factory.assert_not_called()
        self.supplier.get()
        status = self.supplier.status()
        self.assertEqual(set(status), {'http_attempts', 'provider_expire_seconds',
                                      'issued_at', 'usable_for_seconds', 'supply_mode', 'credential_source',
                                      'app_token_header'})
        self.assertEqual(status['http_attempts'], 1)
        self.assertEqual(status['provider_expire_seconds'], 7200)
        self.assertEqual(status['usable_for_seconds'], 3540)
        self.assertIsNotNone(status['issued_at'])
        self.assertNotIn('SYNTHETIC', json.dumps(status))

    def test_existing_secrets_require_explicit_source_and_app_binding_without_fallback(self):
        with override_settings(MES_APP_KEY='EXISTING-KEY', MES_APP_SECRET='EXISTING-SECRET',
                MES_USER_OAUTH_APP_KEY='', MES_USER_OAUTH_APP_SECRET=''):
            self.assertFalse(app_credentials_configured())
            with override_settings(MES_USER_OAUTH_APP_CREDENTIAL_SOURCE='existing_mes'):
                self.assertFalse(app_credentials_configured())
                with override_settings(MES_USER_TOKEN_APP_ID='91000000000000009'):
                    self.assertTrue(app_credentials_configured())
                    self.factory.assert_not_called()
                    self.supplier.get()
                    self.assertEqual(self.session.post.call_args.kwargs['json'],
                                     {'appKey':'EXISTING-KEY', 'appSecret':'EXISTING-SECRET'})
                    self.assertEqual(self.supplier.status()['credential_source'], 'existing_mes')
                    with override_settings(MES_APP_SECRET=''):
                        with self.assertRaises(AppCredentialUnavailable):
                            self.supplier.get()
                    self.session.post.assert_called_once()

    @override_settings(MES_USER_OAUTH_APP_TOKEN_HEADER='X-AUTH', MES_USER_OAUTH_CONTROL_QC_ID='9000000000000042')
    def test_one_server_issue_supplies_same_app_token_to_exchange_and_userinfo(self):
        from .identity import verify_user_context, UserContextUnverified
        def user_session(body):
            response=Mock(status_code=200, history=[])
            response.__enter__=Mock(return_value=response)
            response.__exit__=Mock(return_value=False)
            response.iter_content.return_value=[json.dumps(body).encode()]
            session=Mock()
            session.__enter__=Mock(return_value=session)
            session.__exit__=Mock(return_value=False)
            session.post.return_value=response
            return session
        for api_code in (200, 3401):
            with self.subTest(api_code=api_code):
                self.session.post.reset_mock()
                supplier=AppTokenSupplier(session_factory=self.factory, clock=self.clock)
                control=user_session({'code':200,'data':{'id':9000000000000042}})
                exchange=user_session({'code':api_code,'data':{'userAccessToken':'SYNTHETIC-USER','expire':7200}})
                info=user_session({'code':200,'data':{'userId':42}})
                with override_settings(MES_USER_OAUTH_APP_CREDENTIAL_SOURCE='existing_mes',
                        MES_USER_TOKEN_APP_ID='91000000000000009',MES_APP_KEY='EXISTING-KEY',
                        MES_APP_SECRET='EXISTING-SECRET'), \
                        patch('mes_oauth.callback_app_tokens.AppTokenSupplier',return_value=supplier), \
                        patch('mes_oauth.client.requests.Session',side_effect=[control,exchange,info]):
                    provider=get_provider()
                    with self.assertLogs('mes_oauth.diagnostics', level='WARNING'):
                        self.assertIsNone(provider.check_app_read_access(9000000000000042))
                    if api_code==200:
                        context=verify_user_context(42,provider.exchange('SYNTHETIC-CODE'),info_loader=provider.userinfo)
                        self.assertEqual(context.user_id,42)
                        self.assertFalse(context.expiry_verified)
                        info.post.assert_called_once()
                        self.assertEqual(info.post.call_args.kwargs['headers'],
                                         {'X-AUTH':'SYNTHETIC-APP','Accept':'application/json'})
                    else:
                        with self.assertRaises(UserContextUnverified):
                            verify_user_context(42,provider.exchange('SYNTHETIC-CODE'),info_loader=provider.userinfo)
                        info.post.assert_not_called()
                    self.session.post.assert_called_once()
                    control.post.assert_called_once()
                    self.assertEqual(control.post.call_args.kwargs['headers'],
                                     {'X-AUTH':'SYNTHETIC-APP','Accept':'application/json'})
                    exchange.post.assert_called_once()
                    self.assertEqual(exchange.post.call_args.kwargs['headers'],
                                     {'X-AUTH':'SYNTHETIC-APP','Accept':'application/json'})
                    self.assertEqual(provider.diagnostic_snapshot()['exchange_api_code'],api_code)


@override_settings(MES_USER_OAUTH_ENABLED=True, MES_USER_OAUTH_APP_TOKEN_SOURCE='server',
    MES_USER_OAUTH_PROVIDER_ORIGIN=ALI, MES_USER_OAUTH_APP_KEY='SYNTHETIC-KEY',
    MES_USER_OAUTH_APP_SECRET='SYNTHETIC-SECRET', MES_USER_OAUTH_APP_ID='91000000000000009',
    MES_USER_TOKEN_APP_ID='')
class CallbackAppTokenTests(SimpleTestCase):
    body = AppTokenTests.body

    def setUp(self):
        from .callback_app_tokens import AppTokenSupplier as CallbackSupplier
        AppTokenTests.setUp(self)
        self.supplier = CallbackSupplier(session_factory=self.factory, clock=self.clock)
        self.body({'appAccessToken': 'SYNTHETIC-APP', 'expire': 604964})

    def test_observed_long_ttl_has_one_budget_and_bounded_local_reuse(self):
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
            self.assertEqual(self.supplier.get(), 'SYNTHETIC-APP')
        self.clock.return_value = 4539.9
        self.assertEqual(self.supplier.get(), 'SYNTHETIC-APP')
        self.clock.return_value = 4540
        with self.assertRaises(AppCredentialUnavailable):
            self.supplier.get()
        self.clock.return_value = 100000
        with self.assertRaises(AppCredentialUnavailable):
            self.supplier.get()
        self.session.post.assert_called_once()
        event = json.loads(logs.output[0].split('mes_oauth_app_supply ', 1)[1])
        self.assertEqual(set(event), {'reason', 'http_attempts', 'http_status', 'api_code',
                                      'provider_expire_seconds', 'issued_at'})
        self.assertEqual(event['reason'], 'app_credential_issued')
        self.assertEqual(event['provider_expire_seconds'], 604964)
        self.assertEqual((event['http_attempts'], event['http_status'], event['api_code']), (1, 200, 200))
        self.assertNotIn('SYNTHETIC', json.dumps(event))

    def test_callback_failure_never_retries_after_business_cooldown(self):
        self.session.post.side_effect = TimeoutError('SYNTHETIC-SECRET PRIVATE-BODY')
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as logs:
            with self.assertRaises(AppCredentialUnavailable):
                self.supplier.get()
        self.clock.return_value = 1031
        with self.assertRaises(AppCredentialUnavailable):
            self.supplier.get()
        self.session.post.assert_called_once()
        self.assertEqual(len(logs.output), 1)
        self.assertNotIn('PRIVATE', logs.output[0])
        self.assertNotIn('SYNTHETIC', logs.output[0])

    def test_callback_key_change_cannot_reset_the_used_budget(self):
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING'):
            self.supplier.get()
        with override_settings(MES_USER_OAUTH_APP_SECRET='SYNTHETIC-ROTATED'):
            with self.assertRaises(AppCredentialUnavailable):
                self.supplier.get()
        self.session.post.assert_called_once()

    def test_deployed_app_id_works_without_vault_configuration_or_business_cache(self):
        with override_settings(MES_USER_OAUTH_APP_CREDENTIAL_SOURCE='existing_mes',
                MES_APP_KEY='EXISTING-KEY', MES_APP_SECRET='EXISTING-SECRET'), \
                patch('mes_oauth.callback_app_tokens.AppTokenSupplier', return_value=self.supplier), \
                patch('mes_oauth.app_tokens._supplier') as business, \
                patch('mes_oauth.views.BlacklakeUserOAuthClient') as client:
            self.assertTrue(app_credentials_configured())
            with self.assertLogs('mes_oauth.diagnostics', level='WARNING'):
                get_provider()
        business.get.assert_not_called()
        self.session.post.assert_called_once()
        self.assertEqual(self.session.post.call_args.kwargs['json'],
                         {'appKey': 'EXISTING-KEY', 'appSecret': 'EXISTING-SECRET'})
        client.assert_called_once_with(origin=ALI, app_access_token='SYNTHETIC-APP',
                                       app_token_header='access_token')

    def test_conflicting_oauth_and_vault_app_ids_stop_before_provider_io(self):
        for source in ('existing_mes', 'dedicated'):
            with self.subTest(source=source), override_settings(
                    MES_USER_OAUTH_APP_CREDENTIAL_SOURCE=source,
                    MES_USER_TOKEN_APP_ID='91000000000000010',
                    MES_APP_KEY='EXISTING-KEY', MES_APP_SECRET='EXISTING-SECRET'):
                self.assertFalse(app_credentials_configured())
                with self.assertRaises(AppCredentialUnavailable):
                    self.supplier.get()
        self.factory.assert_not_called()

    def test_matching_app_id_keeps_the_existing_business_binding(self):
        with override_settings(MES_USER_TOKEN_APP_ID='91000000000000009'):
            current = app_credential_binding()
            with override_settings(MES_USER_OAUTH_APP_ID=''):
                self.assertEqual(app_credential_binding(), current)

    def test_missing_callback_app_id_cannot_issue_from_dedicated_keys(self):
        with override_settings(MES_USER_OAUTH_APP_ID='', MES_USER_TOKEN_APP_ID=''):
            with self.assertRaises(AppCredentialUnavailable):
                self.supplier.get()
        self.factory.assert_not_called()
