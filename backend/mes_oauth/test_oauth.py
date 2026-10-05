"""Synthetic callback/security tests. Never issue a real token or call MES."""
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import io
import json
import logging
import re
import secrets
import sys
import traceback
import requests
from threading import Barrier
from unittest import skipUnless
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.conf import settings
from django.db import connection, connections
from django.http import HttpResponse
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from .client import BlacklakeUserOAuthClient, EXCHANGE, USERINFO
from .models import OAuthAttempt
from .security import OAuthQueryLogFilter, OAuthQueryRedactionMiddleware
from .views import START, CALLBACK, COOKIE, _record_failure_diagnostic
from .identity import UserContextResponse, UserContextUnverified


MES_USER = 10_000_000_000_000_003
CODE = 'SYNTHETIC-AUTHORIZATION-CODE'
TOKEN = 'SYNTHETIC-USER-TOKEN'
APP_TOKEN = 'SYNTHETIC-APP-TOKEN'
ORIGIN = 'https://testserver'
OAUTH_MIDDLEWARE = [
    'mes_oauth.security.OAuthQueryRedactionMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'config.middleware.DisableCSRFMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
]


def envelope(data):
    return UserContextResponse(200, {'code': 200, 'data': data}, False)


def synthetic_session(body, *, status=200, history=()):
    response = Mock(status_code=status, history=list(history))
    response.iter_content.return_value = [body]
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    session = Mock()
    session.post.return_value = response
    session.__enter__ = Mock(return_value=session)
    session.__exit__ = Mock(return_value=False)
    return session


@override_settings(MIDDLEWARE=OAUTH_MIDDLEWARE, MES_USER_OAUTH_ENABLED=True, DEBUG=False,
    MES_USER_OAUTH_CALLBACK_ORIGIN=ORIGIN,
    MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
    MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-REVIEWED-PAGE',
    MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-NO-NETWORK-REVIEW',
    MES_USER_OAUTH_APP_ACCESS_TOKEN=APP_TOKEN,
    CSRF_TRUSTED_ORIGINS=[ORIGIN], SESSION_COOKIE_SECURE=True, CSRF_COOKIE_SECURE=True)
class OAuthCallbackTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='SYNTHETIC-OAUTH', is_superuser=True, is_staff=True)
        self.other = get_user_model().objects.create_user(username='SYNTHETIC-OAUTH-OTHER', is_superuser=True, is_staff=True)
        self.mapping = override_settings(MES_USER_OAUTH_USER_MAP={
            str(self.user.pk): str(MES_USER), str(self.other.pk): str(MES_USER + 1)})
        self.mapping.enable()
        self.addCleanup(self.mapping.disable)
        self.client = Client(enforce_csrf_checks=True)
        self.client.force_login(self.user)
        self.provider = Mock()
        self.provider.exchange.return_value = envelope({'userAccessToken': TOKEN})
        self.provider.userinfo.return_value = envelope({'userId': MES_USER})
        factory_patch = patch('mes_oauth.views.get_provider', return_value=self.provider)
        self.factory = factory_patch.start()
        self.addCleanup(factory_patch.stop)
        network_patch = patch('requests.sessions.Session.request', side_effect=AssertionError('No live HTTP.'))
        self.network = network_patch.start()
        self.addCleanup(network_patch.stop)
        self.addCleanup(self.network.assert_not_called)

    def post(self, path, data=None, **headers):
        csrf = self.client.cookies.get('csrftoken')
        payload = {'csrfmiddlewaretoken': csrf.value if csrf else ''}
        payload.update(data or {})
        return self.client.post(path, payload, secure=True,
                                **{'HTTP_ORIGIN': ORIGIN, **headers})

    def begin(self):
        self.assertEqual(self.client.get(START, secure=True).status_code, 200)
        response = self.post(START)
        self.assertEqual(response.status_code, 200, response.content)
        return OAuthAttempt.objects.latest('created_at')

    def finish(self, code=CODE):
        # A browser fragment is not part of the backend HTTP request URL.
        response = self.client.get(CALLBACK, secure=True)
        self.assertEqual(response.status_code, 200, response.content)
        return self.post(CALLBACK, {'code': code})

    def test_complete_identity_flow_is_single_use_and_never_returns_or_stores_secrets(self):
        row = self.begin()
        cookie = self.client.cookies[COOKIE]
        self.assertTrue(cookie['secure'])
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Lax')
        self.assertEqual(cookie['path'], '/')
        response = self.finish()
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {'identity_verified': True, 'expiry_verified': False, 'live_ready': False})
        self.provider.exchange.assert_called_once_with(CODE)
        self.provider.userinfo.assert_called_once_with(TOKEN)
        row.refresh_from_db()
        self.assertEqual(row.status, 'verified')
        self.assertIsNotNone(row.consumed_at)
        self.assertIsNotNone(row.verified_at)
        self.assertNotIn(CODE, repr(row.__dict__))
        self.assertNotIn(TOKEN, repr(row.__dict__))
        self.assertNotIn(cookie.value, repr(row.__dict__))
        self.assertNotIn(TOKEN.encode(), response.content)
        self.assertEqual(self.post(CALLBACK, {'code': CODE}).status_code, 403)
        self.provider.exchange.assert_called_once()

    def test_get_callback_without_query_only_prepares_fragment_csrf_form(self):
        row = self.begin()
        original = OAuthAttempt.objects.values().get(pk=row.pk)
        response = self.client.get(CALLBACK, secure=True)
        self.assertEqual(response.status_code, 200)
        self.factory.assert_not_called()
        self.assertIs(response.wsgi_request.mes_oauth_query_present, False)
        self.assertEqual(response.wsgi_request.META['QUERY_STRING'], '')
        self.assertEqual(response.wsgi_request.GET, {})
        self.assertNotIn(CODE.encode(), response.content)
        self.assertIn(b'history.replaceState', response.content)
        self.assertIn(b'new URLSearchParams(u.hash.slice(1))', response.content)
        self.assertIn(b"getAll('code')", response.content)
        self.assertIn(b'<button type="submit" disabled>', response.content)
        self.assertIn(b'csrfmiddlewaretoken', response.content)
        self.assertEqual(response['Referrer-Policy'], 'strict-origin')
        self.assertIn(b'<meta name="referrer" content="strict-origin">', response.content)
        self.assertIn('no-store', response['Cache-Control'])
        self.assertIn("frame-ancestors 'none'", response['Content-Security-Policy'])
        self.assertEqual(OAuthAttempt.objects.values().get(pk=row.pk), original)

    def test_direct_callback_query_is_rejected_without_provider_or_attempt_consumption(self):
        row = self.begin()
        original = OAuthAttempt.objects.values().get(pk=row.pk)
        for query in ('code=' + CODE, 'code=' + CODE + '&code=' + CODE,
                      '%63ode=' + CODE, 'code=', 'unexpected=' + CODE, '0'):
            with self.subTest(query_kind=query.split('=', 1)[0]):
                response = self.client.get(CALLBACK + '?' + query, secure=True)
                self.assertEqual(response.status_code, 400)
                self.assertIn(b'oauth_callback_query_rejected', response.content)
                self.assertNotIn(b'<form', response.content)
                self.assertNotIn(CODE.encode(), response.content)
                self.assertIs(response.wsgi_request.mes_oauth_query_present, True)
                self.assertEqual(response.wsgi_request.META['QUERY_STRING'], '')
                self.assertEqual(response.wsgi_request.GET, {})
                self.assertIn('no-store', response['Cache-Control'])
                self.assertEqual(OAuthAttempt.objects.values().get(pk=row.pk), original)
                self.assertEqual(OAuthAttempt.objects.count(), 1)
                self.factory.assert_not_called()
                self.provider.exchange.assert_not_called()
                self.provider.userinfo.assert_not_called()
        # A rejected query must not burn the pending fragment-based flow.
        self.assertEqual(self.client.get(CALLBACK, secure=True).status_code, 200)
        self.assertEqual(OAuthAttempt.objects.values().get(pk=row.pk), original)
        self.factory.assert_not_called()

    def test_disabled_flow_has_no_database_or_provider_side_effect(self):
        with override_settings(MES_USER_OAUTH_ENABLED=False):
            self.assertEqual(self.client.get(START, secure=True).status_code, 403)
            self.assertEqual(self.client.get(CALLBACK + '?code=' + CODE, secure=True).status_code, 403)
        self.assertEqual(OAuthAttempt.objects.count(), 0)
        self.factory.assert_not_called()

    def test_callback_post_with_query_rejects_valid_body_without_consuming_attempt(self):
        row = self.begin()
        original = OAuthAttempt.objects.values().get(pk=row.pk)
        nonce = self.client.cookies[COOKIE].value
        queries = (
            ('code_query', 'code=' + CODE),
            ('unrelated_query', 'unexpected=SYNTHETIC'),
            ('code_and_extra_query', 'code=' + CODE + '&unexpected=SYNTHETIC'),
        )
        for kind, query in queries:
            with self.subTest(query_kind=kind):
                # This helper sends the real fixture CSRF cookie/token, exact
                # reviewed Origin and a valid code in the POST body.
                response = self.post(CALLBACK + '?' + query, {'code': CODE})
                self.assertEqual(response.status_code, 400)
                self.assertIn(b'oauth_callback_query_rejected', response.content)
                request = response.wsgi_request
                self.assertEqual(request.META['HTTP_ORIGIN'], ORIGIN)
                self.assertEqual(request.POST['code'], CODE)
                self.assertTrue(request.POST['csrfmiddlewaretoken'])
                self.assertIs(request.mes_oauth_query_present, True)
                self.assertEqual(request.META['QUERY_STRING'], '')
                self.assertEqual(request.GET, {})
                self.assertNotIn(CODE.encode(), response.content)
                self.assertNotIn(TOKEN.encode(), response.content)
                self.assertIn('no-store', response['Cache-Control'])
                self.assertEqual(OAuthAttempt.objects.values().get(pk=row.pk), original)
                self.assertEqual(OAuthAttempt.objects.count(), 1)
                self.assertEqual(self.client.cookies[COOKIE].value, nonce)
                self.factory.assert_not_called()
                self.provider.exchange.assert_not_called()
                self.provider.userinfo.assert_not_called()
        self.assertEqual(self.client.get(CALLBACK, secure=True).status_code, 200)
        self.assertEqual(OAuthAttempt.objects.values().get(pk=row.pk), original)
        self.factory.assert_not_called()

    def test_backend_session_and_superuser_required_not_bearer_or_frontend_login(self):
        self.client.logout()
        self.assertEqual(self.client.get(START, secure=True, HTTP_AUTHORIZATION='Bearer SYNTHETIC').status_code, 403)
        self.client.force_login(self.user)
        self.user.is_superuser = False
        self.user.save(update_fields=['is_superuser'])
        self.assertEqual(self.client.get(START, secure=True).status_code, 403)
        self.factory.assert_not_called()

    def test_existing_admin_login_supplies_session_without_token_bridge_or_role_changes(self):
        self.user.set_password('SYNTHETIC-LOCAL-ONLY-PASSWORD')
        self.user.save(update_fields=['password'])
        self.client.logout()
        response = self.client.get('/admin/login/?next=' + START, secure=True)
        self.assertEqual(response.status_code, 200)
        response = self.post('/admin/login/?next=' + START, {
            'username': self.user.username, 'password': 'SYNTHETIC-LOCAL-ONLY-PASSWORD', 'next': START})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], START)
        self.assertEqual(self.client.get(START, secure=True).status_code, 200)
        self.assertEqual(self.client.session['_auth_user_id'], str(self.user.pk))
        self.factory.assert_not_called()

    def test_real_local_jwt_does_not_create_backend_session_or_authorize_oauth(self):
        self.user.set_password('SYNTHETIC-LOCAL-ONLY-PASSWORD')
        self.user.save(update_fields=['password'])
        self.client.logout()
        response = self.client.post('/api/token/', {
            'username': self.user.username, 'password': 'SYNTHETIC-LOCAL-ONLY-PASSWORD'}, secure=True)
        self.assertEqual(response.status_code, 200)
        access = response.json()['access']
        self.assertNotIn('_auth_user_id', self.client.session)
        self.assertEqual(self.client.get(START, secure=True,
            HTTP_AUTHORIZATION='Bearer ' + access).status_code, 403)
        self.assertEqual(OAuthAttempt.objects.count(), 0)
        self.factory.assert_not_called()

    def test_account_demotion_or_deactivation_blocks_pending_attempt(self):
        for field in ('is_superuser', 'is_staff', 'is_active'):
            with self.subTest(field=field):
                self.client.force_login(self.user)
                self.begin()
                get_user_model().objects.filter(pk=self.user.pk).update(**{field: False})
                self.assertEqual(self.post(CALLBACK, {'code': CODE}).status_code, 403)
                get_user_model().objects.filter(pk=self.user.pk).update(**{field: True})
        self.factory.assert_not_called()

    def test_application_security_middleware_redacts_early_errors(self):
        response = self.client.post(CALLBACK + '?code=' + CODE, {'code': CODE}, secure=True)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.wsgi_request.META['QUERY_STRING'], '')
        self.assertEqual(response.wsgi_request.sensitive_post_parameters, '__ALL__')
        self.assertNotIn(CODE.encode(), response.content)
        self.assertIn('no-store', response['Cache-Control'])

    def test_referer_query_and_fragment_are_removed_before_get_post_and_csrf_failure(self):
        row = self.begin()
        referer_origin = 'https://v3-ali.blacklake.cn/SYNTHETIC-SSO'
        for suffix in ('?code=' + CODE + '#' + TOKEN, '#' + CODE):
            for method in ('get', 'invalid_post', 'csrf_failure'):
                with self.subTest(suffix_kind='query' if '?' in suffix else 'fragment', method=method):
                    path = CALLBACK + '?code=' + CODE
                    headers = {'HTTP_REFERER': referer_origin + suffix,
                               'RAW_URI': path + '#' + TOKEN,
                               'REQUEST_URI': path + '#' + TOKEN}
                    if method == 'get':
                        response = self.client.get(path, secure=True, **headers)
                        self.assertEqual(response.status_code, 400)
                        self.assertIn(b'oauth_callback_query_rejected', response.content)
                    elif method == 'invalid_post':
                        response = self.post(path, {'code': ''}, **headers)
                        self.assertEqual(response.status_code, 400)
                    else:
                        response = self.client.post(path, {'code': CODE}, secure=True,
                            HTTP_ORIGIN=ORIGIN, **headers)
                        self.assertEqual(response.status_code, 403)
                        self.assertEqual(response.wsgi_request.sensitive_post_parameters, '__ALL__')
                    request = response.wsgi_request
                    self.assertIs(request.mes_oauth_query_present, True)
                    self.assertEqual(request.META['HTTP_REFERER'], referer_origin)
                    self.assertEqual(request.META['RAW_URI'], CALLBACK)
                    self.assertEqual(request.META['REQUEST_URI'], CALLBACK)
                    self.assertEqual(request.META['QUERY_STRING'], '')
                    self.assertEqual(request.GET, {})
                    self.assertNotIn(CODE.encode(), response.content)
                    self.assertNotIn(TOKEN.encode(), response.content)
                    self.assertIn('no-store', response['Cache-Control'])
        row.refresh_from_db()
        self.assertEqual((row.status, row.code_digest, row.consumed_at), ('pending', None, None))
        self.factory.assert_not_called()

    def test_password_profile_and_archive_service_restrictions_apply_to_sessions(self):
        from quality.archive_access import ARCHIVE_SERVICE_GROUP, ARCHIVE_SERVICE_USERNAME
        from injection.models import UserProfile
        for field in ('password_reset_required', 'is_using_temp_password'):
            UserProfile.objects.filter(user=self.user).update(**{field: True})
            self.assertEqual(self.client.get(START, secure=True).status_code, 403)
            UserProfile.objects.filter(user=self.user).update(**{field: False})
        group = Group.objects.create(name=ARCHIVE_SERVICE_GROUP)
        self.user.groups.add(group)
        self.assertEqual(self.client.get(START, secure=True).status_code, 403)
        self.user.groups.remove(group)
        self.user.username = ARCHIVE_SERVICE_USERNAME
        self.user.save(update_fields=['username'])
        self.assertEqual(self.client.get(START, secure=True).status_code, 403)
        self.user.username = 'SYNTHETIC-OAUTH'
        self.user.save(update_fields=['username'])
        UserProfile.objects.filter(user=self.user).delete()
        self.assertEqual(self.client.get(START, secure=True).status_code, 403)
        self.factory.assert_not_called()

    def test_insecure_session_configuration_cannot_activate_oauth(self):
        for changes in ({'DEBUG': True}, {'SESSION_COOKIE_SECURE': False},
                        {'SESSION_COOKIE_HTTPONLY': False}, {'CSRF_COOKIE_SECURE': False},
                        {'SESSION_COOKIE_DOMAIN': '.example.com'},
                        {'CSRF_COOKIE_DOMAIN': '.example.com'},
                        {'SESSION_COOKIE_SAMESITE': 'Strict'},
                        {'SESSION_COOKIE_SAMESITE': 'None'},
                        {'SESSION_ENGINE': 'django.contrib.sessions.backends.signed_cookies'}):
            with self.subTest(fields=list(changes)), override_settings(**changes):
                self.assertEqual(self.client.get(START, secure=True).status_code, 403)
        self.factory.assert_not_called()

    def test_plain_http_cannot_start_or_exchange(self):
        self.assertEqual(self.client.get(START).status_code, 403)
        self.assertEqual(self.client.get(CALLBACK).status_code, 403)
        self.factory.assert_not_called()

    def test_password_change_or_logout_invalidates_pending_binding(self):
        self.begin()
        self.user.set_password('SYNTHETIC-NOT-A-REAL-PASSWORD')
        self.user.save(update_fields=['password'])
        self.assertEqual(self.client.get(CALLBACK, secure=True).status_code, 403)
        self.factory.assert_not_called()

    def test_csrf_cannot_be_bypassed_by_a_bearer_header(self):
        self.begin()
        response = self.client.post(CALLBACK, {'code': CODE}, secure=True,
                                    HTTP_ORIGIN=ORIGIN, HTTP_AUTHORIZATION='Bearer SYNTHETIC')
        self.assertEqual(response.status_code, 403)
        self.assertIn('no-store', response['Cache-Control'])
        self.factory.assert_not_called()

    def test_origin_and_host_must_match_reviewed_backend(self):
        self.begin()
        for origin in ('', 'https://untrusted.example', 'https://wj-reporting.onrender.com'):
            with self.subTest(origin=origin):
                self.assertEqual(self.post(CALLBACK, {'code': CODE}, HTTP_ORIGIN=origin).status_code, 403)
        self.assertEqual(self.client.get(CALLBACK, secure=True, HTTP_HOST='localhost').status_code, 403)
        self.factory.assert_not_called()

    def test_cookie_is_bound_to_session_and_local_actor(self):
        self.begin()
        cookie = self.client.cookies[COOKIE].value
        for user in (self.user, self.other):
            other = Client(enforce_csrf_checks=True)
            other.force_login(user)
            other.cookies[COOKIE] = cookie
            self.assertEqual(other.get(CALLBACK + '?code=' + CODE, secure=True).status_code, 403)
        self.factory.assert_not_called()

    def test_expired_superseded_or_consumed_attempt_cannot_exchange(self):
        for state in ('expired', 'superseded', 'processing', 'verified', 'rejected'):
            with self.subTest(state=state):
                row = self.begin()
                if state == 'expired':
                    row.expires_at = timezone.now() - timedelta(seconds=1)
                    row.save(update_fields=['expires_at'])
                else:
                    row.status = state
                    row.save(update_fields=['status'])
                self.assertEqual(self.post(CALLBACK, {'code': CODE}).status_code, 403)
        self.factory.assert_not_called()

    def test_new_start_supersedes_old_cookie_and_configuration_change_blocks_it(self):
        old = self.begin()
        self.begin()
        old.refresh_from_db()
        self.assertEqual(old.status, 'superseded')
        with override_settings(MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-NEW-REVIEW'):
            self.assertEqual(self.post(CALLBACK, {'code': CODE}).status_code, 403)
        with override_settings(MES_USER_OAUTH_USER_MAP={str(self.user.pk): str(MES_USER + 1)}):
            self.assertEqual(self.post(CALLBACK, {'code': CODE}).status_code, 403)
        self.factory.assert_not_called()

    def test_expected_identity_is_server_owned_and_never_coerced_from_float(self):
        for value in (None, True, MES_USER, float(MES_USER), '0', '-1', '1.0', '9223372036854775808'):
            with self.subTest(value=value), override_settings(MES_USER_OAUTH_USER_MAP={str(self.user.pk): value}):
                self.assertEqual(self.client.get(START, secure=True).status_code, 403)
        self.begin()
        self.assertEqual(self.post(CALLBACK, {'code': CODE, 'expected_user_id': str(MES_USER)}).status_code, 400)
        self.factory.assert_not_called()

    def test_same_code_is_blocked_even_after_a_new_start(self):
        self.begin()
        self.assertEqual(self.finish().status_code, 200)
        self.begin()
        self.assertEqual(self.finish().status_code, 409)
        self.provider.exchange.assert_called_once()
        self.provider.userinfo.assert_called_once()

    def test_mismatched_identity_and_provider_failure_consume_without_retry_or_leak(self):
        cases = ('wrong_identity', 'app_token', 'exception', 'unauthorized', 'redirect')
        for number, case in enumerate(cases):
            with self.subTest(case=case):
                self.provider.reset_mock(side_effect=True)
                self.provider.exchange.return_value = envelope({'userAccessToken': TOKEN})
                self.provider.userinfo.return_value = envelope({'userId': MES_USER})
                if case == 'wrong_identity':
                    self.provider.userinfo.return_value = envelope({'userId': MES_USER + 1})
                elif case == 'app_token':
                    self.provider.exchange.return_value = envelope({'appAccessToken': TOKEN})
                elif case == 'exception':
                    self.provider.exchange.side_effect = RuntimeError(CODE + TOKEN)
                elif case == 'unauthorized':
                    self.provider.exchange.return_value = UserContextResponse(401, {}, False)
                else:
                    self.provider.exchange.return_value = UserContextResponse(200, {}, True)
                row = self.begin()
                response = self.finish(CODE + str(number))
                self.assertEqual(response.status_code, 502)
                self.assertNotIn(CODE.encode(), response.content)
                self.assertNotIn(TOKEN.encode(), response.content)
                row.refresh_from_db()
                self.assertEqual(row.status, 'rejected')
                expected_errors = {
                    'wrong_identity': 'user_identity_mismatch',
                    'app_token': 'user_token_missing',
                    'exception': 'identity_verification_failed',
                    'unauthorized': 'exchange_http_rejected',
                    'redirect': 'exchange_redirect_unverified',
                }
                self.assertEqual(row.error_code, expected_errors[case])
                self.assertIsNotNone(row.consumed_at)
                self.assertEqual(self.post(CALLBACK, {'code': CODE}).status_code, 403)
                self.provider.exchange.assert_called_once()
                if case != 'wrong_identity':
                    self.provider.userinfo.assert_not_called()

    def test_failure_diagnostics_are_allowlisted_private_and_do_not_add_calls(self):
        class UntrustedString(str):
            pass

        cases = [
            ('factory', UserContextUnverified('app_credential_missing'), 'app_credential_missing'),
            ('exchange', UserContextUnverified('exchange_header_invalid'), 'exchange_header_invalid'),
            ('exchange', UserContextUnverified('exchange_response_decode_failed'), 'exchange_response_decode_failed'),
            ('userinfo', UserContextUnverified('userinfo_response_too_large'), 'userinfo_response_too_large'),
            ('userinfo', UserContextUnverified('userinfo_request_failed'), 'userinfo_request_failed'),
            ('exchange', UserContextUnverified('exchange_http_rejected' + TOKEN), 'identity_verification_failed'),
            ('exchange', RuntimeError('exchange_http_rejected'), 'identity_verification_failed'),
            ('exchange', RuntimeError(CODE + TOKEN + APP_TOKEN), 'identity_verification_failed'),
            ('exchange', UserContextUnverified({'secret': TOKEN}), 'identity_verification_failed'),
            ('exchange', UserContextUnverified(UntrustedString('exchange_http_rejected')), 'identity_verification_failed'),
            ('exchange', UserContextUnverified('exchange_http_rejected', TOKEN), 'identity_verification_failed'),
            ('userinfo', UserContextUnverified(TOKEN), 'userinfo_load_failed'),
        ]
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        for name in ('', 'django.request', 'mes_oauth'):
            logger = logging.getLogger(name)
            old_level = logger.level
            logger.setLevel(logging.DEBUG)
            logger.addHandler(handler)
            self.addCleanup(logger.setLevel, old_level)
            self.addCleanup(logger.removeHandler, handler)
        public_response = None
        for number, (stage, error, expected) in enumerate(cases):
            with self.subTest(stage=stage, expected=expected, case=number):
                self.factory.reset_mock(side_effect=True)
                self.provider.reset_mock(side_effect=True)
                self.provider.exchange.return_value = envelope({'userAccessToken': TOKEN})
                self.provider.userinfo.return_value = envelope({'userId': MES_USER})
                error.__cause__ = RuntimeError(CODE + TOKEN + APP_TOKEN)
                target = self.factory if stage == 'factory' else getattr(self.provider, stage)
                target.side_effect = error
                row = self.begin()
                submitted_code = CODE + '-diagnostic-' + str(number)
                response = self.finish(submitted_code)
                self.assertEqual(response.status_code, 502)
                self.assertIn(b'identity_verification_failed', response.content)
                # CSP nonces intentionally change on every response.
                public_body = re.sub(rb'nonce="[A-Za-z0-9_-]+"',
                                     b'nonce="SYNTHETIC-CSP-NONCE"', response.content)
                self.assertIn(b'nonce="SYNTHETIC-CSP-NONCE"', public_body)
                if public_response is None:
                    public_response = public_body
                self.assertEqual(public_body, public_response)
                row.refresh_from_db()
                self.assertEqual(row.error_code, expected)
                self.assertEqual(row.status, 'rejected')
                self.assertIsNotNone(row.consumed_at)
                self.assertIsNone(row.verified_at)
                self.assertEqual(self.post(CALLBACK, {'code': submitted_code}).status_code, 403)
                self.factory.assert_called_once()
                self.assertEqual(self.provider.exchange.call_count, int(stage != 'factory'))
                self.assertEqual(self.provider.userinfo.call_count, int(stage == 'userinfo'))
                for secret in (CODE, TOKEN, APP_TOKEN):
                    self.assertNotIn(secret, repr(OAuthAttempt.objects.values().get(pk=row.pk)))
                    self.assertNotIn(secret.encode(), response.content)
                    self.assertNotIn(secret, output.getvalue())

    def test_real_client_diagnostics_record_http_boundaries_without_secret_or_retry(self):
        exchange_body = json.dumps({'code': 200, 'data': {'userAccessToken': TOKEN}}).encode()
        cases = [
            ('header', 'exchange_header_invalid', 1, 0, None, None, None, None),
            ('exchange_http', 'exchange_http_rejected', 1, 0, 401, None, None, None),
            ('exchange_decode', 'exchange_response_decode_failed', 1, 0, 200, None, None, None),
            ('exchange_api', 'exchange_api_rejected', 1, 0, 200, None, 40101, None),
            ('userinfo_session', 'userinfo_request_failed', 1, 0, 200, None, 200, None),
            ('userinfo_decode', 'userinfo_response_decode_failed', 1, 1, 200, 200, 200, None),
            ('userinfo_http', 'userinfo_http_rejected', 1, 1, 200, 403, 200, None),
            ('userinfo_api', 'userinfo_api_rejected', 1, 1, 200, 200, 200, 40302),
            ('id_type', 'userinfo_user_id_invalid', 1, 1, 200, 200, 200, 200),
            ('id_mismatch', 'user_identity_mismatch', 1, 1, 200, 200, 200, 200),
        ]
        for number, (case, reason, exchange_count, info_count, exchange_status, info_status,
                     exchange_api, info_api) in enumerate(cases):
            with self.subTest(case=case):
                first_body = b'{"code":40101,"data":{}}' if case == 'exchange_api' else exchange_body
                first = synthetic_session(b'{' if case == 'exchange_decode' else first_body,
                                          status=401 if case == 'exchange_http' else 200)
                if case == 'header':
                    first.post.side_effect = requests.exceptions.InvalidHeader(APP_TOKEN)
                observed_id = str(MES_USER) if case == 'id_type' else MES_USER + 1
                info_body = json.dumps({'code': 40302 if case == 'userinfo_api' else 200, 'data': {
                    'userId': observed_id, 'name': 'SYNTHETIC-PRIVATE-PERSON'}}).encode()
                second = synthetic_session(b'{' if case == 'userinfo_decode' else info_body,
                                           status=403 if case == 'userinfo_http' else 200)
                session_factory = Mock(side_effect=[first,
                    RuntimeError(TOKEN) if case == 'userinfo_session' else second])
                provider = BlacklakeUserOAuthClient(origin='https://v3-ali.blacklake.cn',
                    app_access_token=APP_TOKEN, session_factory=session_factory)
                self.factory.return_value = provider
                row = self.begin()
                submitted_code = CODE + '-boundary-' + str(number)
                with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as captured:
                    response = self.finish(submitted_code)
                    self.assertEqual(self.post(CALLBACK, {'code': submitted_code}).status_code, 403)
                self.assertEqual(response.status_code, 502)
                self.assertEqual(len(captured.records), 1)
                record = captured.records[0]
                self.assertIsNone(record.exc_info)
                self.assertIsNone(record.stack_info)
                self.assertFalse(hasattr(record, 'request'))
                prefix, payload = record.getMessage().split(' ', 1)
                self.assertEqual(prefix, 'mes_oauth_identity_failure')
                self.assertEqual(json.loads(payload), {
                    'reason': reason, 'exchange_http_attempts': exchange_count,
                    'userinfo_http_attempts': info_count,
                    'exchange_http_status': exchange_status, 'userinfo_http_status': info_status,
                    'exchange_api_code': exchange_api, 'userinfo_api_code': info_api})
                row.refresh_from_db()
                self.assertEqual(row.error_code, reason)
                self.assertEqual(row.status, 'rejected')
                self.assertEqual(first.post.call_count, exchange_count)
                self.assertEqual(second.post.call_count, info_count)
                for private in (CODE, TOKEN, APP_TOKEN, 'SYNTHETIC-PRIVATE-PERSON', str(MES_USER)):
                    self.assertNotIn(private, ''.join(captured.output))

    def test_official_ali_response_fields_keep_identity_separate_from_expiry(self):
        # Official ALI docs 1708935281595630 / 1708935281595627: one data object,
        # integer IDs/expire, userAccessToken and tokenType strings. All values
        # below are synthetic; the docs do not settle duration versus epoch.
        for number, expiry in enumerate((3600, 1_900_000_000)):
            data = {'userAccessToken': TOKEN, 'tokenType': 'SYNTHETIC-TYPE',
                    'userId': MES_USER, 'expire': expiry}
            sessions = [synthetic_session(json.dumps({'code': 200, 'data': data}).encode())
                        for _ in range(2)]
            provider = BlacklakeUserOAuthClient(origin='https://v3-ali.blacklake.cn',
                app_access_token=APP_TOKEN, session_factory=Mock(side_effect=sessions))
            self.factory.return_value = provider
            row = self.begin()
            with self.assertNoLogs('mes_oauth.diagnostics', level='WARNING'):
                response = self.finish(CODE + '-ali-contract-' + str(number))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {
                'identity_verified': True, 'expiry_verified': False, 'live_ready': False})
            self.assertEqual(sessions[1].post.call_args.kwargs['json'], {'userAccessToken': TOKEN})
            self.assertEqual(provider.diagnostic_snapshot(), {
                'exchange_http_attempts': 1, 'userinfo_http_attempts': 1,
                'exchange_http_status': 200, 'userinfo_http_status': 200,
                'exchange_api_code': 200, 'userinfo_api_code': 200})
            row.refresh_from_db()
            self.assertEqual(row.error_code, '')
            self.assertEqual(row.status, 'verified')

    def test_invalid_duplicate_or_oversized_code_stops_before_exchange(self):
        self.begin()
        for code in ('', ' ', 'SYNTHETIC\nCODE', 'x' * 4097, ['SYNTHETIC-A', 'SYNTHETIC-B']):
            with self.subTest(code_type=type(code).__name__):
                self.assertEqual(self.post(CALLBACK, {'code': code}).status_code, 400)
        self.factory.assert_not_called()

    def test_diagnostic_handler_failure_does_not_replace_public_failure_or_cookie_cleanup(self):
        self.provider.exchange.side_effect = UserContextUnverified('exchange_http_rejected')
        row = self.begin()
        with patch('mes_oauth.views.logging.getLogger') as get_logger:
            get_logger.return_value.warning.side_effect = RuntimeError(CODE + TOKEN)
            response = self.finish()
        self.assertEqual(response.status_code, 502)
        self.assertIn(b'identity_verification_failed', response.content)
        self.assertEqual(response.cookies[COOKIE]['max-age'], 0)
        row.refresh_from_db()
        self.assertEqual(row.error_code, 'exchange_http_rejected')
        self.provider.exchange.assert_called_once()
        self.provider.userinfo.assert_not_called()

    def test_diagnostic_log_revalidates_fixed_fields_and_never_expands_a_snapshot(self):
        provider = BlacklakeUserOAuthClient(origin='https://v3-ali.blacklake.cn', app_access_token=APP_TOKEN)
        tainted = {'reason': TOKEN, 'private': CODE, 'userId': MES_USER,
                   'exchange_http_attempts': True, 'userinfo_http_attempts': 2,
                   'exchange_http_status': '401', 'userinfo_http_status': 999,
                   'exchange_api_code': True, 'userinfo_api_code': MES_USER}
        with patch.object(BlacklakeUserOAuthClient, 'diagnostic_snapshot', return_value=tainted), \
                self.assertLogs('mes_oauth.diagnostics', level='WARNING') as captured:
            _record_failure_diagnostic('exchange_http_rejected', provider)
        self.assertEqual(json.loads(captured.records[0].getMessage().split(' ', 1)[1]), {
            'reason': 'exchange_http_rejected', 'exchange_http_attempts': None,
            'userinfo_http_attempts': None, 'exchange_http_status': None, 'userinfo_http_status': None,
            'exchange_api_code': None, 'userinfo_api_code': None})
        for private in (CODE, TOKEN, str(MES_USER)):
            self.assertNotIn(private, ''.join(captured.output))
        with patch.object(BlacklakeUserOAuthClient, 'diagnostic_snapshot', side_effect=RuntimeError(TOKEN)), \
                self.assertNoLogs('mes_oauth.diagnostics', level='WARNING'):
            _record_failure_diagnostic('exchange_http_rejected', provider)
        unknown = Mock()
        for supplied, expected in ((None, 0), (unknown, None)):
            with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as captured:
                _record_failure_diagnostic(TOKEN, supplied)
            self.assertEqual(json.loads(captured.records[0].getMessage().split(' ', 1)[1]), {
                'reason': 'identity_verification_failed', 'exchange_http_attempts': expected,
                'userinfo_http_attempts': expected, 'exchange_http_status': None,
                'userinfo_http_status': None, 'exchange_api_code': None, 'userinfo_api_code': None})
        unknown.diagnostic_snapshot.assert_not_called()

    def test_interrupted_exchange_stays_consumed_and_cannot_retry(self):
        row = self.begin()
        self.provider.exchange.side_effect = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.finish()
        row.refresh_from_db()
        self.assertEqual(row.status, 'processing')
        self.assertIsNotNone(row.consumed_at)
        self.assertIsNotNone(row.code_digest)
        self.assertEqual(self.post(CALLBACK, {'code': CODE}).status_code, 403)
        self.provider.exchange.assert_called_once()

    def test_malformed_or_missing_configuration_never_starts(self):
        for changes in ({'MES_USER_OAUTH_CALLBACK_ORIGIN': 'http://testserver'},
                        {'MES_USER_OAUTH_CALLBACK_ORIGIN': 'https://testserver:bad'},
                        {'MES_USER_OAUTH_CALLBACK_ORIGIN': None},
                        {'MES_USER_OAUTH_LAUNCH_URL': None},
                        {'MES_USER_OAUTH_LAUNCH_URL': 'https://untrusted.example/'},
                        {'MES_USER_OAUTH_LAUNCH_URL': 'https://v3-ali.blacklake.cn/?code=SYNTHETIC'},
                        {'MES_USER_OAUTH_REVIEW_REFERENCE': ''},
                        {'MES_USER_OAUTH_USER_MAP': 'invalid'},
                        {'MES_USER_OAUTH_USER_MAP': {}}):
            with self.subTest(fields=list(changes)), override_settings(**changes):
                self.assertEqual(self.client.get(START, secure=True).status_code, 403)
        self.assertEqual(OAuthAttempt.objects.count(), 0)

    def test_missing_blank_or_nonstring_app_credential_cannot_create_attempt(self):
        # Seed a valid CSRF token before removing the credential so POST reaches
        # the configuration gate rather than failing only at CSRF middleware.
        self.assertEqual(self.client.get(START, secure=True).status_code, 200)
        for value in (Ellipsis, None, '', ' \t\n', False, 123, {}, []):
            with self.subTest(value_type=type(value).__name__), override_settings(
                    MES_USER_OAUTH_APP_ACCESS_TOKEN=value):
                if value is Ellipsis:
                    del settings.MES_USER_OAUTH_APP_ACCESS_TOKEN
                response = self.client.get(START, secure=True)
                self.assertEqual(response.status_code, 403)
                self.assertIn(b'oauth_start_unavailable', response.content)
                response = self.post(START)
                self.assertEqual(response.status_code, 403)
                self.assertIn(b'oauth_start_unavailable', response.content)
                self.assertEqual(OAuthAttempt.objects.count(), 0)
                self.factory.assert_not_called()

    def test_missing_blank_or_nonstring_app_credential_cannot_consume_pending_code(self):
        row = self.begin()
        original = (row.status, row.code_digest, row.consumed_at, row.verified_at, row.error_code)
        for value in (Ellipsis, None, '', ' \t\n', False, 123, {}, []):
            with self.subTest(value_type=type(value).__name__), override_settings(
                    MES_USER_OAUTH_APP_ACCESS_TOKEN=value):
                if value is Ellipsis:
                    del settings.MES_USER_OAUTH_APP_ACCESS_TOKEN
                response = self.client.get(CALLBACK + '?code=' + CODE, secure=True)
                self.assertEqual(response.status_code, 403)
                self.assertIn(b'oauth_callback_unavailable', response.content)
                response = self.post(CALLBACK, {'code': CODE})
                self.assertEqual(response.status_code, 403)
                self.assertIn(b'oauth_callback_unavailable', response.content)
                row.refresh_from_db()
                self.assertEqual((row.status, row.code_digest, row.consumed_at,
                                  row.verified_at, row.error_code), original)
                self.assertEqual(OAuthAttempt.objects.count(), 1)
                self.factory.assert_not_called()

    def test_logs_remove_callback_query_without_affecting_other_messages(self):
        record = logging.LogRecord('synthetic', 30, '', 1,
            'GET %s HTTP/1.1', ('https://testserver' + CALLBACK + '?code=' + CODE,), None)
        self.assertTrue(OAuthQueryLogFilter().filter(record))
        self.assertNotIn(CODE, record.getMessage())
        self.assertIn('?[redacted]', record.getMessage())
        plain = logging.LogRecord('synthetic', 20, '', 1, 'healthy %s', ('ok',), None)
        OAuthQueryLogFilter().filter(plain)
        self.assertEqual(plain.getMessage(), 'healthy ok')


class OAuthQueryRedactionMiddlewareTests(SimpleTestCase):
    def test_downstream_only_receives_query_presence_bool_after_cached_query_redaction(self):
        factory = RequestFactory()
        for query, expected in (('', False), ('code=' + CODE, True), ('code=', True), ('0', True)):
            with self.subTest(query_kind=query.split('=', 1)[0]):
                path = CALLBACK + ('?' + query if query else '')
                request = factory.get(path, secure=True, RAW_URI=path + '#' + TOKEN,
                    REQUEST_URI=path + '#' + TOKEN, HTTP_REFERER=ORIGIN + path + '#' + TOKEN)
                # Cache GET before the middleware: clearing META alone must not
                # leave the previously parsed authorization code available.
                cached_query = request.GET
                if query == 'code=' + CODE:
                    self.assertEqual(cached_query['code'], CODE)
                original_keys = set(request.__dict__)

                def downstream(current):
                    self.assertIs(current, request)
                    self.assertIs(current.mes_oauth_query_present, expected)
                    self.assertEqual(current.META['QUERY_STRING'], '')
                    self.assertEqual(current.GET, {})
                    self.assertEqual(current.META['RAW_URI'], CALLBACK)
                    self.assertEqual(current.META['REQUEST_URI'], CALLBACK)
                    self.assertEqual(current.META['HTTP_REFERER'], ORIGIN + CALLBACK)
                    self.assertNotIn(CODE, repr(current.META))
                    self.assertNotIn(TOKEN, repr(current.META))
                    added_attributes = {key: value for key, value in current.__dict__.items()
                                        if key not in original_keys}
                    self.assertNotIn(CODE, repr(added_attributes))
                    self.assertNotIn(TOKEN, repr(added_attributes))
                    return HttpResponse('SYNTHETIC downstream response')

                handler = Mock(side_effect=downstream)
                response = OAuthQueryRedactionMiddleware(handler)(request)
                handler.assert_called_once_with(request)
                self.assertEqual(response.status_code, 200)
                self.assertIn('no-store', response['Cache-Control'])


class OAuthLogRedactionTests(SimpleTestCase):
    def formatted_output(self, record):
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        handler.setFormatter(logging.Formatter('%(levelname)s %(message)s'))
        handler.addFilter(OAuthQueryLogFilter())
        try:
            handler.handle(record)
            return output.getvalue()
        finally:
            handler.close()

    def test_handler_redacts_callback_queries_in_chained_exceptions(self):
        try:
            try:
                raise ValueError('SYNTHETIC INNER ' + ORIGIN + CALLBACK + '?code=' + CODE + '-INNER')
            except ValueError as cause:
                raise RuntimeError('SYNTHETIC OUTER ' + ORIGIN + CALLBACK + '?code=' + CODE + '-OUTER') from cause
        except RuntimeError:
            record = logging.LogRecord('synthetic.oauth', logging.ERROR, __file__, 1,
                'callback failed: %s', (ORIGIN + CALLBACK + '?code=' + CODE + '-MESSAGE',), sys.exc_info())
        output = self.formatted_output(record)
        self.assertNotIn(CODE, output)
        self.assertIn('ValueError: SYNTHETIC INNER', output)
        self.assertIn('RuntimeError: SYNTHETIC OUTER', output)
        self.assertIn('Traceback (most recent call last)', output)
        self.assertIn('direct cause', output)
        self.assertGreaterEqual(output.count('?[redacted]'), 3)

    def test_handler_redacts_cached_exception_and_stack_text(self):
        record = logging.LogRecord('synthetic.oauth', logging.ERROR, __file__, 1,
            'SYNTHETIC cached failure', (), None)
        record.exc_text = ('Traceback (most recent call last):\nSYNTHETIC cached frame\n'
                           'RuntimeError: ' + ORIGIN + CALLBACK + '?code=' + CODE + '-CACHED')
        record.stack_info = ('Stack (most recent call last):\nSYNTHETIC stack frame\n'
                             + ORIGIN + CALLBACK + '?code=' + CODE + '-STACK')
        output = self.formatted_output(record)
        self.assertNotIn(CODE, output)
        self.assertIn('SYNTHETIC cached frame', output)
        self.assertIn('SYNTHETIC stack frame', output)
        self.assertEqual(output.count('?[redacted]'), 2)

    def test_handler_preserves_unrelated_exception_traceback(self):
        try:
            raise LookupError('SYNTHETIC unrelated failure remains diagnosable')
        except LookupError:
            record = logging.LogRecord('synthetic.oauth', logging.ERROR, __file__, 1,
                'ordinary failure %s', ('SYNTHETIC context',), sys.exc_info())
        expected = logging.Formatter('%(levelname)s %(message)s').format(record) + '\n'
        self.assertEqual(self.formatted_output(record), expected)


class OAuthClientTests(TestCase):
    def provider_fixture(self, body, *, status=200, history=()):
        session = synthetic_session(body, status=status, history=history)
        return (BlacklakeUserOAuthClient(origin='https://v3-ali.blacklake.cn',
            app_access_token='SYNTHETIC-APP', session_factory=lambda: session), session)

    def test_exchange_and_userinfo_use_explicit_scoped_requests_without_redirect_or_retry(self):
        client, session = self.provider_fixture(json.dumps({'code': 200, 'data': {}}).encode())
        client.exchange(CODE)
        client.userinfo(TOKEN)
        self.assertEqual(session.post.call_count, 2)
        calls = session.post.call_args_list
        self.assertEqual(calls[0].args[0],
            'https://v3-ali.blacklake.cn/api/openapi/domain/web/v1/route/openapi/open/v1/access_token/_get_user_token')
        self.assertEqual(calls[0].kwargs['json'], {'code': CODE, 'grantType': 'authorization_code'})
        self.assertEqual(calls[1].args[0],
            'https://v3-ali.blacklake.cn/api/openapi/domain/web/v1/route/openapi/open/v1/access_token/_get_user_info')
        self.assertEqual(calls[1].kwargs['json'], {'userAccessToken': TOKEN})
        for call in calls:
            self.assertFalse(call.kwargs['allow_redirects'])
            self.assertEqual(call.kwargs['timeout'], (3, 10))
            self.assertEqual(call.kwargs['headers']['access_token'], 'SYNTHETIC-APP')
            prepared = requests.Request('POST', call.args[0],
                headers=call.kwargs['headers'], json=call.kwargs['json']).prepare()
            self.assertEqual(prepared.headers['Content-Type'], 'application/json')
            self.assertEqual(json.loads(prepared.body), call.kwargs['json'])
        self.assertIs(session.trust_env, False)
        self.assertEqual(client.diagnostic_snapshot(), {
            'exchange_http_attempts': 1, 'userinfo_http_attempts': 1,
            'exchange_http_status': 200, 'userinfo_http_status': 200,
            'exchange_api_code': 200, 'userinfo_api_code': 200})

    def test_configured_header_value_is_forwarded_without_inventing_or_stripping_prefix(self):
        # These fixtures prove preservation, not provider acceptance of any
        # particular prefix. The public endpoint docs only call this "token".
        for credential in ('SYNTHETIC-APP', 'appToken SYNTHETIC-APP', 'Bearer SYNTHETIC-APP'):
            session = synthetic_session(b'{}')
            client = BlacklakeUserOAuthClient(origin='https://v3-ali.blacklake.cn',
                app_access_token=credential, session_factory=lambda: session)
            client.exchange(CODE)
            call = session.post.call_args
            self.assertEqual(call.kwargs['headers']['access_token'], credential)
            self.assertNotIn('Authorization', call.kwargs['headers'])
            session.post.assert_called_once()

    def test_each_client_phase_cannot_send_twice_or_call_another_endpoint(self):
        client, session = self.provider_fixture(b'{}')
        for stage, value in (('exchange', CODE), ('userinfo', TOKEN)):
            getattr(client, stage)(value)
            with self.assertRaisesRegex(UserContextUnverified, '^' + stage + '_attempt_already_used$'):
                getattr(client, stage)(value)
        self.assertEqual(session.post.call_count, 2)
        with self.assertRaisesRegex(UserContextUnverified, '^oauth_endpoint_invalid$'):
            client._post('/SYNTHETIC-UNREVIEWED-ENDPOINT', {})
        self.assertEqual(session.post.call_count, 2)

    def test_session_creation_failure_does_not_invent_an_http_attempt(self):
        factory = Mock(side_effect=RuntimeError(APP_TOKEN))
        client = BlacklakeUserOAuthClient(origin='https://v3-ali.blacklake.cn',
            app_access_token=APP_TOKEN, session_factory=factory)
        with self.assertRaisesRegex(UserContextUnverified, '^exchange_request_failed$'):
            client.exchange(CODE)
        self.assertEqual(client.diagnostic_snapshot(), {
            'exchange_http_attempts': 0, 'userinfo_http_attempts': 0,
            'exchange_http_status': None, 'userinfo_http_status': None,
            'exchange_api_code': None, 'userinfo_api_code': None})

    def test_snapshot_rejects_non_integer_and_out_of_range_metadata(self):
        client, _ = self.provider_fixture(b'{}')
        for count in (False, True, -1, 2, '1', TOKEN):
            client._http_attempts['exchange'] = count
            self.assertIsNone(client.diagnostic_snapshot()['exchange_http_attempts'])
        for status in (True, '200', 200.0, 99, 600, TOKEN):
            client._http_statuses['exchange'] = status
            self.assertIsNone(client.diagnostic_snapshot()['exchange_http_status'])
        for status in (100, 599):
            client._http_statuses['exchange'] = status
            self.assertEqual(client.diagnostic_snapshot()['exchange_http_status'], status)

    def test_api_code_metadata_is_int32_and_non_200_bodies_are_never_read(self):
        for code in (-2_147_483_648, 2_147_483_647, 40101):
            client, session = self.provider_fixture(json.dumps({'code': code}).encode())
            client.exchange(CODE)
            self.assertEqual(client.diagnostic_snapshot()['exchange_api_code'], code)
            session.post.assert_called_once()
        for code in (True, '200', 200.0, -2_147_483_649, 2_147_483_648, MES_USER, TOKEN):
            client, _ = self.provider_fixture(json.dumps({'code': code}).encode())
            client.exchange(CODE)
            self.assertIsNone(client.diagnostic_snapshot()['exchange_api_code'])
        client, session = self.provider_fixture(b'{"code":40101}', status=401)
        client.exchange(CODE)
        session.post.return_value.iter_content.assert_not_called()
        self.assertIsNone(client.diagnostic_snapshot()['exchange_api_code'])

    def test_http_denial_and_redirect_do_not_parse_or_follow_response(self):
        for status, history in ((401, ()), (403, ()), (302, ()), (200, ('SYNTHETIC',))):
            client, session = self.provider_fixture(b'SYNTHETIC-PRIVATE', status=status, history=history)
            result = client.exchange(CODE)
            self.assertEqual(result.body, {})
            session.post.assert_called_once()
            session.post.return_value.iter_content.assert_not_called()

    def test_malformed_duplicate_large_responses_and_exceptions_are_sanitized(self):
        for stage, value in (('exchange', CODE), ('userinfo', TOKEN)):
            for body, reason in ((b'{', 'response_decode_failed'),
                                 (b'{"code":200,"code":200}', 'response_decode_failed'),
                                 (b'{"x":NaN}', 'response_decode_failed'),
                                 (b'\xff', 'response_decode_failed'),
                                 (b'x' * 65537, 'response_too_large')):
                client, session = self.provider_fixture(body)
                with self.assertRaisesRegex(UserContextUnverified, '^' + stage + '_' + reason + '$'):
                    try:
                        getattr(client, stage)(value)
                    except UserContextUnverified as error:
                        rendered = ''.join(traceback.format_exception(error))
                        raise
                session.post.assert_called_once()
                for secret in (CODE, TOKEN, APP_TOKEN):
                    self.assertNotIn(secret, rendered)
            for error, reason in ((RuntimeError(CODE + TOKEN), 'request_failed'),
                                  (requests.exceptions.Timeout(TOKEN), 'request_failed'),
                                  (requests.exceptions.InvalidHeader(APP_TOKEN), 'header_invalid'),
                                  (UserContextUnverified(TOKEN), 'request_failed')):
                client, session = self.provider_fixture(b'')
                session.post.side_effect = error
                with self.assertRaisesRegex(UserContextUnverified, '^' + stage + '_' + reason + '$'):
                    try:
                        getattr(client, stage)(value)
                    except UserContextUnverified as error:
                        rendered = ''.join(traceback.format_exception(error))
                        raise
                session.post.assert_called_once()
                for secret in (CODE, TOKEN, APP_TOKEN):
                    self.assertNotIn(secret, rendered)

    def test_no_origin_or_app_credential_fallback(self):
        factory = Mock()
        for origin, token in (('https://untrusted.example', 'SYNTHETIC'),
                              ('https://v3-ali.blacklake.cn', ''),
                              ('https://v3-ali.blacklake.cn', None)):
            with self.assertRaises(UserContextUnverified):
                BlacklakeUserOAuthClient(origin=origin, app_access_token=token, session_factory=factory)
        factory.assert_not_called()


@skipUnless(connection.vendor == 'postgresql', 'OAuth concurrent consumption requires PostgreSQL.')
@override_settings(MIDDLEWARE=OAUTH_MIDDLEWARE, MES_USER_OAUTH_ENABLED=True, DEBUG=False,
    MES_USER_OAUTH_CALLBACK_ORIGIN=ORIGIN,
    MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
    MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-REVIEWED-PAGE',
    MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-NO-NETWORK-REVIEW',
    MES_USER_OAUTH_APP_ACCESS_TOKEN=APP_TOKEN,
    CSRF_TRUSTED_ORIGINS=[ORIGIN], SESSION_COOKIE_SECURE=True, CSRF_COOKIE_SECURE=True)
class OAuthConcurrencyTests(TransactionTestCase):
    setUp = OAuthCallbackTests.setUp
    post = OAuthCallbackTests.post
    begin = OAuthCallbackTests.begin

    def concurrent_callbacks(self, cookie_sets):
        barrier = Barrier(2)
        def call(cookies):
            connections.close_all()
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SET statement_timeout = '10000ms'")
                    cursor.execute("SET lock_timeout = '5000ms'")
                client = Client(enforce_csrf_checks=True)
                client.cookies = deepcopy(cookies)
                barrier.wait(timeout=10)
                return client.post(CALLBACK,
                    {'code': CODE, 'csrfmiddlewaretoken': cookies['csrftoken'].value},
                    secure=True, HTTP_ORIGIN=ORIGIN).status_code
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(call, cookies) for cookies in cookie_sets]
            return [future.result(timeout=20) for future in futures]

    def test_concurrent_callbacks_exchange_a_single_attempt_once(self):
        self.begin()
        statuses = self.concurrent_callbacks([self.client.cookies, self.client.cookies])
        self.assertEqual(statuses.count(200), 1)
        self.assertIn(next(status for status in statuses if status != 200), (403, 409))
        self.provider.exchange.assert_called_once_with(CODE)
        self.provider.userinfo.assert_called_once_with(TOKEN)
        self.assertEqual(OAuthAttempt.objects.filter(status='verified').count(), 1)

    def test_concurrent_distinct_attempts_cannot_exchange_the_same_code_twice(self):
        from .views import _digest
        first = self.begin()
        nonce = secrets.token_urlsafe(32)
        # Represent two concurrently issued pending attempts; the global code
        # constraint must still prevent reuse, independently of start policy.
        OAuthAttempt.objects.create(nonce_digest=_digest(nonce),
            actor_id=self.user.pk, session_digest=first.session_digest,
            policy_digest=first.policy_digest, expected_user_id=first.expected_user_id,
            expires_at=first.expires_at)
        second_cookies = deepcopy(self.client.cookies)
        second_cookies[COOKIE] = nonce
        self.assertEqual(sorted(self.concurrent_callbacks([self.client.cookies, second_cookies])), [200, 409])
        self.provider.exchange.assert_called_once_with(CODE)
        self.provider.userinfo.assert_called_once_with(TOKEN)
        self.assertEqual(OAuthAttempt.objects.filter(status='verified').count(), 1)
