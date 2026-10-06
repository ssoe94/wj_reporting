"""Synthetic JWT/session-bridge regressions; never contact a provider."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from copy import copy
from datetime import timedelta
import json
from threading import Event
from unittest import skipUnless
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser, Group, Permission
from django.db import connection, connections, transaction
from django.test import Client, RequestFactory, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

from . import vault
from .connection_views import (
    BRIDGE_ONLY, SESSION_KEY, ineligible_account_reason, login_claims,
    secure_request, secure_request_reason,
)
from .identity import UserContextResponse
from .models import MESCredential, MESLoginSession, MESLoginTicket, OAuthAttempt
from .views import CALLBACK, COOKIE, START


BACKEND = 'https://testserver'
FRONTEND = 'https://synthetic-frontend.example'
MES_USER = 10_000_000_000_000_003
PASSWORD = 'SYNTHETIC-LOCAL-TEST-PASSWORD'
CODE = 'SYNTHETIC-CONNECTION-CODE'
PROVIDER_TOKEN = 'SYNTHETIC-CONNECTION-USER-TOKEN'
MIDDLEWARE = [
    'mes_oauth.security.OAuthQueryRedactionMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'config.middleware.DisableCSRFMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'mes_oauth.connection_views.BridgeRestrictionMiddleware',
]


def envelope(data):
    return UserContextResponse(200, {'code': 200, 'data': data}, False)


CONNECTION_SETTINGS = dict(
    MIDDLEWARE=MIDDLEWARE, DEBUG=False, ALLOWED_HOSTS=['testserver'],
    MES_USER_OAUTH_ENABLED=True, MES_USER_SESSION_BRIDGE_ENABLED=True,
    MES_USER_TOKEN_STORAGE_ENABLED=False, MES_USER_FRONTEND_ORIGIN=FRONTEND,
    MES_USER_OAUTH_CALLBACK_ORIGIN=BACKEND,
    MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
    MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-REVIEWED-PAGE',
    MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-NO-NETWORK-REVIEW',
    MES_USER_OAUTH_APP_ACCESS_TOKEN='SYNTHETIC-APP-TOKEN',
    SESSION_ENGINE='django.contrib.sessions.backends.db',
    SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_DOMAIN=None,
    CSRF_COOKIE_SECURE=True, CSRF_COOKIE_DOMAIN=None,
    CSRF_TRUSTED_ORIGINS=[BACKEND],
)


class ConnectionFixture:
    def setUp(self):
        super().setUp()
        User = get_user_model()
        self.user = User.objects.create_user(
            username='SYNTHETIC-CONNECTION-A', password=PASSWORD,
            is_staff=True, is_superuser=True)
        self.other = User.objects.create_user(
            username='SYNTHETIC-CONNECTION-B', password=PASSWORD,
            is_staff=True, is_superuser=True)
        self.mapping = override_settings(MES_USER_OAUTH_USER_MAP={
            str(self.user.pk): str(MES_USER), str(self.other.pk): str(MES_USER + 1)})
        self.mapping.enable()
        self.addCleanup(self.mapping.disable)
        self.api = Client(enforce_csrf_checks=True)
        self.browser = Client(enforce_csrf_checks=True)
        self.tokens = self.obtain(self.user)
        self.provider = Mock()
        self.provider.exchange.return_value = envelope({'userAccessToken': PROVIDER_TOKEN})
        self.provider.userinfo.return_value = envelope({'userId': MES_USER})
        provider_patch = patch('mes_oauth.views.get_provider', return_value=self.provider)
        self.factory = provider_patch.start()
        self.addCleanup(provider_patch.stop)
        network_patch = patch('requests.sessions.Session.request',
                              side_effect=AssertionError('Synthetic test forbids live HTTP.'))
        self.network = network_patch.start()
        self.addCleanup(network_patch.stop)
        self.addCleanup(self.network.assert_not_called)

    def obtain(self, user):
        response = self.api.post(reverse('token_obtain_pair'),
            {'username': user.username, 'password': PASSWORD},
            content_type='application/json', secure=True)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def action(self, name, data=None, *, tokens=None, origin=FRONTEND, secure=True):
        headers = {'HTTP_AUTHORIZATION': 'Bearer ' + (tokens or self.tokens)['access']}
        if origin is not None:
            headers['HTTP_ORIGIN'] = origin
        return self.api.post(reverse('mes-connection-' + name),
            {} if data is None else data, content_type='application/json',
            secure=secure, **headers)

    def status(self, *, tokens=None, secure=True):
        return self.api.get(reverse('mes-connection-status'), secure=secure,
            HTTP_AUTHORIZATION='Bearer ' + (tokens or self.tokens)['access'])

    def launch(self, *, tokens=None):
        response = self.action('launch', tokens=tokens)
        self.assertEqual(response.status_code, 200)
        return response.json()['ticket']

    def bridge(self, ticket, *, browser=None, origin=FRONTEND, secure=True, path=None):
        headers = {'HTTP_ORIGIN': origin} if origin is not None else {}
        return (browser or self.browser).post(path or reverse('mes-oauth-session'),
            {'ticket': ticket}, secure=secure, **headers)

    def connect(self, *, tokens=None, browser=None):
        response = self.bridge(self.launch(tokens=tokens), browser=browser)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], START)

    def csrf_post(self, path, data=None, *, browser=None):
        browser = browser or self.browser
        cookie = browser.cookies.get('csrftoken')
        payload = {'csrfmiddlewaretoken': cookie.value if cookie else ''}
        payload.update(data or {})
        return browser.post(path, payload, secure=True, HTTP_ORIGIN=BACKEND)

    def begin(self):
        self.connect()
        self.assertEqual(self.browser.get(START, secure=True).status_code, 200)
        self.assertEqual(self.csrf_post(START).status_code, 200)
        return OAuthAttempt.objects.latest('created_at')

    def login_digest(self, tokens=None):
        return vault.digest('client-login', AccessToken((tokens or self.tokens)['access'])['mes_sid'])

    def assert_no_provider(self):
        self.factory.assert_not_called()
        self.provider.exchange.assert_not_called()
        self.provider.userinfo.assert_not_called()


@override_settings(**CONNECTION_SETTINGS)
class ConnectionBridgeTests(ConnectionFixture, TestCase):
    def test_status_is_metadata_only_and_does_not_create_a_login(self):
        before = [model.objects.count() for model in
                  (MESLoginSession, MESLoginTicket, MESCredential, OAuthAttempt)]
        with patch('mes_oauth.vault._open', side_effect=AssertionError('No credential read.')):
            response = self.status()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'disconnected')
        self.assertTrue(response.json()['can_connect'])
        self.assertFalse(response.json()['live_ready'])
        self.assertIn('no-store', response['Cache-Control'])
        self.assertEqual(before, [model.objects.count() for model in
                         (MESLoginSession, MESLoginTicket, MESCredential, OAuthAttempt)])
        self.assert_no_provider()

    def test_each_feature_flag_off_prevents_ticket_and_session_creation(self):
        for setting in ('MES_USER_OAUTH_ENABLED', 'MES_USER_SESSION_BRIDGE_ENABLED'):
            with self.subTest(setting=setting), override_settings(**{setting: False}):
                response = self.status()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['status'], 'disabled')
                self.assertFalse(response.json()['can_connect'])
                self.assertEqual(self.action('launch').status_code, 403)
                self.assertEqual(self.bridge('A' * 43).status_code, 403)
        self.assertEqual(MESLoginSession.objects.count(), 0)
        self.assertEqual(MESLoginTicket.objects.count(), 0)
        self.assert_no_provider()

    def test_launch_requires_exact_frontend_origin_and_https(self):
        for origin in (None, 'null', BACKEND, FRONTEND + '/', FRONTEND + '.evil', 'http://synthetic-frontend.example'):
            with self.subTest(origin=origin):
                self.assertEqual(self.action('launch', origin=origin).status_code, 403)
        self.assertEqual(self.action('launch', secure=False).status_code, 403)
        self.assertEqual(MESLoginTicket.objects.count(), 0)
        self.assert_no_provider()

    def test_insecure_session_configuration_blocks_connection(self):
        for option, value in (
            ('DEBUG', True), ('SESSION_COOKIE_SECURE', False),
            ('SESSION_COOKIE_HTTPONLY', False), ('CSRF_COOKIE_SECURE', False),
            ('SESSION_COOKIE_SAMESITE', 'None'), ('SESSION_COOKIE_DOMAIN', '.example'),
            ('CSRF_COOKIE_DOMAIN', '.example'),
            ('SESSION_ENGINE', 'django.contrib.sessions.backends.signed_cookies'),
        ):
            with self.subTest(option=option), override_settings(**{option: value}):
                self.assertEqual(self.action('launch').status_code, 403)
        self.assertEqual(MESLoginTicket.objects.count(), 0)

    def test_jwt_required_even_when_django_user_is_logged_in(self):
        browser = Client(enforce_csrf_checks=True)
        browser.force_login(self.user)
        self.assertEqual(browser.get(reverse('mes-connection-status'), secure=True).status_code, 401)
        self.assertEqual(browser.post(reverse('mes-connection-launch'), {},
            content_type='application/json', secure=True, HTTP_ORIGIN=FRONTEND).status_code, 401)
        self.assertEqual(MESLoginTicket.objects.count(), 0)

    def test_role_and_unique_string_mapping_are_required(self):
        for field in ('is_staff', 'is_superuser'):
            get_user_model().objects.filter(pk=self.user.pk).update(**{field: False})
            with self.subTest(field=field):
                self.assertEqual(self.action('launch').status_code, 403)
            get_user_model().objects.filter(pk=self.user.pk).update(**{field: True})
        for mapping in ({}, {str(self.user.pk): MES_USER},
                        {str(self.user.pk): str(MES_USER), str(self.other.pk): str(MES_USER)}):
            with self.subTest(mapping_kind=len(mapping)), override_settings(MES_USER_OAUTH_USER_MAP=mapping):
                self.assertEqual(self.action('launch').status_code, 403)
        self.assertEqual(MESLoginTicket.objects.count(), 0)

    def test_launch_body_cannot_supply_an_actor_or_token(self):
        for payload in ({'actor_id': self.other.pk}, {'token': 'SYNTHETIC'}, {'code': CODE}):
            self.assertEqual(self.action('launch', payload).status_code, 403)
        self.assertEqual(MESLoginTicket.objects.count(), 0)

    def test_ticket_is_body_only_60_seconds_and_only_digest_is_persisted(self):
        before = timezone.now()
        response = self.action('launch')
        after = timezone.now()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(set(data), {'ticket', 'expires_in', 'submit_url'})
        self.assertEqual(data['expires_in'], 60)
        self.assertRegex(data['ticket'], r'^[A-Za-z0-9_-]{43}$')
        self.assertEqual(data['submit_url'], BACKEND + reverse('mes-oauth-session'))
        self.assertFalse(urlsplit(data['submit_url']).query)
        self.assertFalse(urlsplit(data['submit_url']).fragment)
        row = MESLoginTicket.objects.get()
        self.assertEqual(row.pk, vault.digest('ticket', data['ticket']))
        self.assertEqual(row.actor_id, self.user.pk)
        self.assertEqual(row.login_digest, self.login_digest())
        self.assertGreaterEqual(row.expires_at, before + timedelta(seconds=60))
        self.assertLessEqual(row.expires_at, after + timedelta(seconds=60))
        persisted = repr(list(MESLoginSession.objects.values())) + repr(list(MESLoginTicket.objects.values()))
        for raw in (data['ticket'], self.tokens['access'], self.tokens['refresh'], CODE):
            self.assertNotIn(raw, persisted)
            self.assertNotIn(raw, data['submit_url'])
        self.assert_no_provider()

    def test_native_post_consumes_ticket_once_and_session_contains_no_jwt(self):
        ticket = self.launch()
        self.assertEqual(self.bridge(ticket).status_code, 302)
        row = MESLoginTicket.objects.get()
        self.assertIsNotNone(row.consumed_at)
        session = self.browser.session
        self.assertEqual(session['_auth_user_id'], str(self.user.pk))
        self.assertTrue(session[BRIDGE_ONLY])
        self.assertEqual(session[SESSION_KEY], self.login_digest())
        self.assertEqual(session['mes_login_revision'], row.login_revision)
        persisted = repr(dict(session.items()))
        for raw in (ticket, self.tokens['access'], self.tokens['refresh']):
            self.assertNotIn(raw, persisted)
        self.assertEqual(self.bridge(ticket, browser=Client(enforce_csrf_checks=True)).status_code, 403)
        self.assert_no_provider()

    def test_new_launch_invalidates_previous_unconsumed_ticket(self):
        first, second = self.launch(), self.launch()
        self.assertNotEqual(first, second)
        self.assertEqual(self.bridge(first).status_code, 403)
        self.assertEqual(self.bridge(second).status_code, 302)

    def test_bridge_rejects_get_query_duplicate_and_extra_fields(self):
        ticket = self.launch()
        path = reverse('mes-oauth-session')
        self.assertEqual(self.browser.get(path, secure=True).status_code, 405)
        self.assertEqual(self.bridge(ticket, path=path + '?ticket=' + ticket).status_code, 403)
        for data in ({'ticket': [ticket, ticket]}, {'ticket': ticket, 'actor_id': self.other.pk},
                     {'ticket': ticket, 'access': self.tokens['access']}):
            self.assertEqual(self.browser.post(path, data, secure=True, HTTP_ORIGIN=FRONTEND).status_code, 403)
        self.assertIsNone(MESLoginTicket.objects.get().consumed_at)
        self.assertEqual(self.bridge(ticket).status_code, 302)

    def test_bridge_requires_exact_origin_and_https_without_burning_valid_ticket(self):
        ticket = self.launch()
        for origin in (None, 'null', BACKEND, FRONTEND + '/', FRONTEND + '.evil'):
            self.assertEqual(self.bridge(ticket, origin=origin).status_code, 403)
        self.assertEqual(self.bridge(ticket, secure=False).status_code, 403)
        self.assertIsNone(MESLoginTicket.objects.get().consumed_at)
        self.assertEqual(self.bridge(ticket).status_code, 302)

    def test_expired_ticket_and_login_are_rejected(self):
        ticket = self.launch()
        MESLoginTicket.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.bridge(ticket).status_code, 403)
        ticket = self.launch()
        MESLoginSession.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assertEqual(self.action('launch').status_code, 401)

    def test_ticket_wrong_actor_cannot_use_another_actors_login(self):
        ticket = self.launch()
        MESLoginTicket.objects.update(actor_id=self.other.pk)
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assertNotIn('_auth_user_id', self.browser.session)

    def test_password_change_revokes_previously_issued_ticket_and_old_jwt(self):
        ticket = self.launch()
        self.user.set_password('SYNTHETIC-CHANGED-PASSWORD')
        self.user.save(update_fields=['password'])
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)

    def test_role_change_revokes_ticket_and_restoring_role_does_not_revive_it(self):
        ticket = self.launch()
        self.user.is_superuser = False
        self.user.save(update_fields=['is_superuser'])
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.user.is_superuser = True
        self.user.save(update_fields=['is_superuser'])
        self.assertEqual(self.action('launch').status_code, 401)
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)

    def test_password_reset_and_group_changes_revoke_bridge_tickets(self):
        ticket = self.launch()
        self.user.profile.password_reset_required = True
        self.user.profile.save(update_fields=['password_reset_required'])
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assertEqual(self.action('launch').status_code, 401)
        other_tokens = self.obtain(self.other)
        other_ticket = self.launch(tokens=other_tokens)
        self.other.groups.add(Group.objects.create(name='SYNTHETIC-NEW-GROUP'))
        self.assertEqual(self.bridge(other_ticket).status_code, 403)

    def test_refresh_preserves_mes_login_identity_and_fresh_login_changes_it(self):
        ticket = self.launch()
        original = AccessToken(self.tokens['access'])
        refreshed = self.api.post(reverse('token_refresh'),
            {'refresh': self.tokens['refresh']}, content_type='application/json', secure=True)
        self.assertEqual(refreshed.status_code, 200)
        rotated = refreshed.json()
        for encoded in (rotated['access'], rotated['refresh']):
            decoded = AccessToken(encoded) if encoded == rotated['access'] else RefreshToken(encoded)
            self.assertEqual(decoded['mes_sid'], original['mes_sid'])
            self.assertEqual(decoded['mes_login_exp'], original['mes_login_exp'])
        self.assertEqual(self.action('launch', tokens=rotated).status_code, 200)
        self.assertEqual(MESLoginSession.objects.count(), 1)
        self.assertEqual(self.bridge(ticket).status_code, 403)  # Replacement launch supersedes it.
        new_tokens = self.obtain(self.user)
        self.assertNotEqual(AccessToken(new_tokens['access'])['mes_sid'], original['mes_sid'])

    def test_legacy_or_malformed_mes_claims_cannot_start_connection(self):
        for mutation in ({'mes_sid': None}, {'mes_sid': 'short'}, {'mes_login_exp': True},
                         {'mes_login_exp': int((timezone.now() - timedelta(seconds=1)).timestamp())},
                         {'mes_login_exp': int((timezone.now() + timedelta(days=40)).timestamp())}):
            token = AccessToken(self.tokens['access'])
            for key, value in mutation.items():
                if value is None:
                    del token[key]
                else:
                    token[key] = value
            self.assertEqual(self.action('launch', tokens={'access': str(token)}).status_code, 401)
        self.assertEqual(MESLoginTicket.objects.count(), 0)

    def test_bridge_cookie_cannot_open_admin_api_or_other_application_routes(self):
        self.connect()
        for path in ('/admin/', '/admin/login/', '/api/mes-connection/', '/', '/integrations/blacklake-other/'):
            with self.subTest(path=path):
                self.assertEqual(self.browser.get(path, secure=True).status_code, 403)
        self.assertEqual(self.browser.get(START, secure=True).status_code, 200)
        self.assertEqual(self.browser.get('/admin/', secure=True,
            HTTP_AUTHORIZATION='Bearer ' + self.tokens['access']).status_code, 403)
        self.assert_no_provider()

    def test_login_403_then_bridge_then_explicit_csrf_start_sequence(self):
        self.assertEqual(self.browser.get(START, secure=True).status_code, 403)
        self.assertEqual(self.browser.get(START, secure=True,
            HTTP_AUTHORIZATION='Bearer ' + self.tokens['access']).status_code, 403)
        self.connect()
        self.assertEqual(self.browser.post(START, {}, secure=True, HTTP_ORIGIN=BACKEND).status_code, 403)
        page = self.browser.get(START, secure=True)
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page['Referrer-Policy'], 'strict-origin')
        self.assertEqual(OAuthAttempt.objects.count(), 0)
        self.assertEqual(self.csrf_post(START).status_code, 200)
        self.assertEqual(OAuthAttempt.objects.count(), 1)
        self.assert_no_provider()

    def test_bridge_callback_get_and_post_preserve_identity_only_contract(self):
        row = self.begin()
        response = self.browser.get(CALLBACK, secure=True)
        self.assertEqual(response.status_code, 200)
        self.assert_no_provider()
        response = self.csrf_post(CALLBACK, {'code': CODE})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'identity_verified': True, 'expiry_verified': False, 'live_ready': False})
        self.provider.exchange.assert_called_once_with(CODE)
        self.provider.userinfo.assert_called_once_with(PROVIDER_TOKEN)
        row.refresh_from_db()
        self.assertEqual(row.status, 'verified')
        self.assertEqual(MESCredential.objects.count(), 0)
        for raw in (CODE, PROVIDER_TOKEN, self.tokens['access'], self.tokens['refresh']):
            self.assertNotIn(raw.encode(), response.content)
            self.assertNotIn(raw, repr(row.__dict__))

    def test_account_switch_replaces_browser_actor_and_rejects_old_callback(self):
        row = self.begin()
        previous_cookie = self.browser.cookies[COOKIE].value
        previous_session = self.browser.session.session_key
        self.connect(tokens=self.obtain(self.other))
        self.assertEqual(self.browser.session['_auth_user_id'], str(self.other.pk))
        self.assertNotEqual(self.browser.session.session_key, previous_session)
        self.browser.cookies[COOKIE] = previous_cookie
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 403)
        self.assertEqual(self.csrf_post(CALLBACK, {'code': CODE}).status_code, 403)
        row.refresh_from_db()
        self.assertEqual(row.status, 'pending')
        self.assert_no_provider()

    def test_disconnect_increments_revision_and_rejects_late_callback_and_ticket(self):
        row = self.begin()
        ticket = self.launch()
        previous = MESLoginSession.objects.get().revision
        response = self.action('disconnect')
        self.assertEqual(response.status_code, 200)
        login = MESLoginSession.objects.get()
        self.assertEqual(login.revision, previous + 1)
        self.assertIsNone(login.revoked_at)
        self.assertEqual(self.bridge(ticket, browser=Client(enforce_csrf_checks=True)).status_code, 403)
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 403)
        self.assertEqual(self.csrf_post(CALLBACK, {'code': CODE}).status_code, 403)
        row.refresh_from_db()
        self.assertEqual(row.status, 'pending')
        self.assertEqual(self.browser.get(START, secure=True).status_code, 403)
        self.assert_no_provider()
        # An explicit new bridge is allowed at the new revision.
        self.connect(browser=Client(enforce_csrf_checks=True))

    def test_disconnect_requires_origin_and_rejects_an_injected_actor(self):
        self.launch()
        previous = MESLoginSession.objects.get().revision
        self.assertEqual(self.action('disconnect', origin='null').status_code, 403)
        self.assertEqual(self.action('disconnect', {'actor_id': self.other.pk}).status_code, 403)
        self.assertEqual(MESLoginSession.objects.get().revision, previous)

    def test_disconnect_during_identity_read_prevents_stale_callback_success(self):
        row = self.begin()

        def disconnect_before_provider_returns(_token):
            self.assertEqual(self.action('disconnect').status_code, 200)
            return envelope({'userId': MES_USER})

        self.provider.userinfo.side_effect = disconnect_before_provider_returns
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 200)
        response = self.csrf_post(CALLBACK, {'code': CODE})
        self.assertIn(response.status_code, (403, 409, 502))
        row.refresh_from_db()
        self.assertNotEqual(row.status, 'verified')
        self.assertEqual(MESCredential.objects.count(), 0)

    def test_logout_revokes_mes_session_ticket_and_refresh_and_prevents_replay(self):
        row = self.begin()
        ticket = self.launch()
        response = self.action('logout', {'refresh': self.tokens['refresh']})
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)
        self.assertEqual(self.bridge(ticket, browser=Client(enforce_csrf_checks=True)).status_code, 403)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 403)
        refreshed = self.api.post(reverse('token_refresh'),
            {'refresh': self.tokens['refresh']}, content_type='application/json', secure=True)
        self.assertEqual(refreshed.status_code, 401)
        # Repeated local logout is safe, and cannot recreate the revoked login.
        self.assertEqual(self.action('logout', {'refresh': self.tokens['refresh']}).status_code, 200)
        self.assertEqual(MESLoginSession.objects.count(), 1)
        row.refresh_from_db()
        self.assertEqual(row.status, 'pending')
        self.assert_no_provider()

    def test_logout_before_first_mes_launch_prevents_remaining_access_replay(self):
        self.assertEqual(MESLoginSession.objects.count(), 0)
        response = self.action('logout', {'refresh': self.tokens['refresh']})
        self.assertEqual(response.status_code, 200)
        # The access JWT remains cryptographically valid after refresh logout.
        # It must not establish its first MES login after logout was acknowledged.
        self.assertEqual(self.action('launch').status_code, 401)
        self.assertEqual(MESLoginTicket.objects.count(), 0)
        self.assert_no_provider()

    def test_logout_cannot_mix_different_actors_or_different_login_refresh_tokens(self):
        self.launch()
        other = self.obtain(self.other)
        later = self.obtain(self.user)
        for tokens in (other, later):
            self.assertEqual(self.action('logout', {'refresh': tokens['refresh']}).status_code, 401)
            self.assertIsNone(MESLoginSession.objects.get().revoked_at)

    def test_logout_can_revoke_after_password_change_without_restoring_access(self):
        self.launch()
        self.user.set_password('SYNTHETIC-CHANGED-PASSWORD')
        self.user.save(update_fields=['password'])
        self.assertEqual(self.action('logout', {'refresh': self.tokens['refresh']}).status_code, 200)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)

    def expired_access(self, tokens=None):
        token = AccessToken((tokens or self.tokens)['access'])
        token['exp'] = int((timezone.now() - timedelta(minutes=2)).timestamp())
        return str(token)

    def refresh_logout(self, refresh, *, access=None, origin=FRONTEND):
        headers = {'HTTP_ORIGIN': origin}
        if access is not None:
            headers['HTTP_AUTHORIZATION'] = 'Bearer ' + access
        return self.api.post(reverse('mes-connection-logout'), {'refresh': refresh},
            content_type='application/json', secure=True, **headers)

    def test_expired_access_with_matching_valid_refresh_can_only_revoke(self):
        ticket = self.launch()
        before_tokens = OutstandingToken.objects.count()
        response = self.refresh_logout(self.tokens['refresh'], access=self.expired_access())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'disconnected': True})
        self.assertEqual(OutstandingToken.objects.count(), before_tokens)
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assert_no_provider()

    def test_refresh_only_logout_before_first_launch_leaves_revocation_tombstone(self):
        before_tokens = OutstandingToken.objects.count()
        self.assertEqual(MESLoginSession.objects.count(), 0)
        response = self.refresh_logout(self.tokens['refresh'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'disconnected': True})
        self.assertEqual(OutstandingToken.objects.count(), before_tokens)
        row = MESLoginSession.objects.get(pk=self.login_digest())
        self.assertEqual(row.actor_id, self.user.pk)
        self.assertIsNotNone(row.revoked_at)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assertEqual(MESLoginTicket.objects.count(), 0)
        # A consumed proof may be rejected or acknowledged idempotently; it
        # must never recreate a usable login or mint another access/refresh pair.
        retry = self.refresh_logout(self.tokens['refresh'])
        self.assertIn(retry.status_code, (200, 401))
        self.assertNotIn('access', retry.json())
        self.assertNotIn('refresh', retry.json())
        self.assertEqual(OutstandingToken.objects.count(), before_tokens)
        self.assertEqual(MESLoginSession.objects.count(), 1)
        row.refresh_from_db()
        self.assertIsNotNone(row.revoked_at)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assert_no_provider()

    def test_expired_access_and_refresh_only_proof_cannot_mix_actor_or_login(self):
        self.launch()
        other = self.obtain(self.other)
        self.launch(tokens=other)
        later = self.obtain(self.user)
        self.launch(tokens=later)
        for tokens in (other, later):
            with self.subTest(different_actor=tokens is other):
                response = self.refresh_logout(tokens['refresh'], access=self.expired_access())
                self.assertEqual(response.status_code, 401)
                self.assertEqual(MESLoginSession.objects.filter(revoked_at__isnull=False).count(), 0)
                self.assertEqual(MESLoginTicket.objects.filter(consumed_at__isnull=False).count(), 0)
        self.assertEqual(MESLoginSession.objects.count(), 3)
        self.assert_no_provider()

    def test_invalid_or_expired_both_proofs_cannot_create_or_revoke_a_login(self):
        self.launch()
        refresh = RefreshToken(self.tokens['refresh'])
        refresh['exp'] = int((timezone.now() - timedelta(minutes=2)).timestamp())
        expired_refresh = str(refresh)
        for access, refresh_value in (
            ('SYNTHETIC-NOT-A-JWT', 'SYNTHETIC-NOT-A-REFRESH'),
            (self.expired_access(), expired_refresh),
            (self.expired_access(), 'SYNTHETIC-NOT-A-REFRESH'),
            (None, expired_refresh), (None, 'SYNTHETIC-NOT-A-REFRESH'),
        ):
            response = self.refresh_logout(refresh_value, access=access)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json(), {'detail': 'logout_unconfirmed'})
            self.assertEqual(MESLoginSession.objects.count(), 1)
            self.assertIsNone(MESLoginSession.objects.get().revoked_at)
            self.assertIsNone(MESLoginTicket.objects.get().consumed_at)
        self.assert_no_provider()

    def test_refresh_only_logout_requires_exact_origin_and_does_not_grant_api_access(self):
        ticket = self.launch()
        response = self.refresh_logout(self.tokens['refresh'], origin='null')
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(MESLoginSession.objects.get().revoked_at)
        self.assertEqual(self.action('launch', tokens={'access': self.tokens['refresh']}).status_code, 401)
        self.assertIsNone(MESLoginTicket.objects.get().consumed_at)
        self.assertEqual(self.bridge(ticket).status_code, 302)
        self.assert_no_provider()

    def test_expired_access_refresh_logout_still_revokes_after_account_demotion(self):
        ticket = self.launch()
        # A bulk update bypasses model signals, making this exercise logout's
        # revocation proof directly instead of relying on prior signal cleanup.
        get_user_model().objects.filter(pk=self.user.pk).update(is_superuser=False)
        self.assertIsNone(MESLoginSession.objects.get().revoked_at)
        response = self.refresh_logout(self.tokens['refresh'], access=self.expired_access())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'disconnected': True})
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assert_no_provider()

    def test_recheck_disabled_storage_cannot_dispatch_provider_io(self):
        self.launch()
        self.assertEqual(self.action('recheck').status_code, 409)
        self.provider.exchange.assert_not_called()
        self.provider.userinfo.assert_not_called()


@override_settings(**CONNECTION_SETTINGS)
class ConnectionStatusGateTests(ConnectionFixture, TestCase):
    """Fixed diagnostics never change admission or read stored credentials."""

    def setUp(self):
        super().setUp()
        self.metadata_models = (MESLoginSession, MESLoginTicket, MESCredential, OAuthAttempt)
        self.metadata_counts = [model.objects.count() for model in self.metadata_models]
        decrypt_patch = patch('mes_oauth.vault._open',
                              side_effect=AssertionError('Status must not decrypt credentials.'))
        self.decrypt = decrypt_patch.start()
        self.addCleanup(decrypt_patch.stop)
        self.addCleanup(self.decrypt.assert_not_called)
        self.addCleanup(self.assert_metadata_unchanged)
        self.addCleanup(self.assert_no_provider)

    def assert_metadata_unchanged(self):
        self.assertEqual(self.metadata_counts,
                         [model.objects.count() for model in self.metadata_models])

    def assert_blocked(self, response, reason):
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual((data['status'], data['reason']), ('blocked', reason))
        self.assertFalse(data['can_connect'])
        self.assertFalse(data['can_disconnect'])
        self.assertFalse(data['live_ready'])
        self.assertIsNone(data['expires_at'])
        self.assertIn('no-store', response['Cache-Control'])

    @override_settings(SECURE_PROXY_SSL_HEADER=None)
    def test_security_diagnostics_preserve_all_existing_gate_conditions(self):
        cases = (
            ({}, False, 'http_scheme_untrusted'),
            ({'DEBUG': True}, True, 'debug_enabled'),
            ({'SESSION_COOKIE_SECURE': False}, True, 'insecure_session_cookie'),
            ({'CSRF_COOKIE_SECURE': False}, True, 'insecure_csrf_cookie'),
            ({'SESSION_COOKIE_HTTPONLY': False}, True, 'session_cookie_httponly_required'),
            ({'SESSION_COOKIE_SAMESITE': 'None'}, True, 'session_cookie_samesite_invalid'),
            ({'SESSION_COOKIE_DOMAIN': '.synthetic.example'}, True, 'session_cookie_domain_invalid'),
            ({'CSRF_COOKIE_DOMAIN': '.synthetic.example'}, True, 'csrf_cookie_domain_invalid'),
            ({'SESSION_ENGINE': 'django.contrib.sessions.backends.signed_cookies'},
             True, 'session_backend_invalid'),
            ({}, True, None),
        )
        for overrides, https, reason in cases:
            with self.subTest(reason=reason), override_settings(**overrides):
                request = RequestFactory().get('/', secure=https)
                original = (request.is_secure() and not settings.DEBUG
                            and settings.SESSION_COOKIE_SECURE and settings.CSRF_COOKIE_SECURE
                            and settings.SESSION_COOKIE_HTTPONLY
                            and settings.SESSION_COOKIE_SAMESITE == 'Lax'
                            and settings.SESSION_COOKIE_DOMAIN is None
                            and settings.CSRF_COOKIE_DOMAIN is None
                            and settings.SESSION_ENGINE == 'django.contrib.sessions.backends.db')
                self.assertEqual(secure_request(request), bool(original))
                self.assertEqual(secure_request_reason(request), reason)
                response = self.status(secure=https)
                if reason is None:
                    self.assertEqual(response.json()['status'], 'disconnected')
                    self.assertTrue(response.json()['can_connect'])
                else:
                    self.assert_blocked(response, reason)
                    self.assertEqual(self.action('launch', secure=https).status_code, 403)
        with override_settings(DEBUG=True, SESSION_COOKIE_SECURE=False):
            self.assert_blocked(self.status(secure=False), 'http_scheme_untrusted')
            self.assert_blocked(self.status(), 'debug_enabled')

    def test_forwarded_https_requires_explicit_trust_or_wsgi_https(self):
        headers = {'HTTP_AUTHORIZATION': 'Bearer ' + self.tokens['access'],
                   'HTTP_X_FORWARDED_PROTO': 'https'}
        path = reverse('mes-connection-status')
        with override_settings(SECURE_PROXY_SSL_HEADER=None):
            self.assert_blocked(self.api.get(path, secure=False, **headers), 'http_scheme_untrusted')
            # Gunicorn may already supply wsgi.url_scheme=https; Django accepts that.
            response = self.api.get(path, secure=True, **headers)
            self.assertEqual(response.json()['status'], 'disconnected')
            self.assertTrue(response.json()['can_connect'])
        with override_settings(SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO', 'https')):
            response = self.api.get(path, secure=False, **headers)
            self.assertEqual(response.json()['status'], 'disconnected')
            self.assertTrue(response.json()['can_connect'])
            for scheme in ('http', 'http, https'):
                headers['HTTP_X_FORWARDED_PROTO'] = scheme
                self.assert_blocked(self.api.get(path, secure=True, **headers), 'http_scheme_untrusted')

    def test_staff_and_role_failures_remain_blocked_with_distinct_reasons(self):
        for staff, superuser, reason in (
            (False, True, 'admin_staff_required'),
            (True, False, 'account_role_required'),
        ):
            with self.subTest(reason=reason):
                get_user_model().objects.filter(pk=self.user.pk).update(
                    is_staff=staff, is_superuser=superuser)
                self.assert_blocked(self.status(), reason)
                self.assertEqual(self.action('launch').status_code, 403)

    def test_approved_nonstaff_inspector_remains_connectable(self):
        user = get_user_model().objects.create_user(
            username='SYNTHETIC-CONNECTION-PILOT', password=PASSWORD)
        profile = user.profile
        profile.can_view_quality, profile.is_admin = True, False
        profile.save(update_fields=['can_view_quality', 'is_admin'])
        user.user_permissions.add(Permission.objects.get(
            content_type__app_label='quality', codename='view_inspectionrequest'))
        with override_settings(INSPECTION_PILOT_ENABLED=True, INSPECTION_PILOT_USER_IDS=[user.pk],
                MES_USER_OAUTH_USER_MAP={str(user.pk): str(MES_USER + 2)}):
            tokens = self.obtain(user)
            response = self.status(tokens=tokens)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['status'], 'disconnected')
            self.assertTrue(response.json()['can_connect'])
            self.assertTrue(vault.eligible(get_user_model().objects.get(pk=user.pk)))
            with override_settings(INSPECTION_PILOT_ENABLED=False):
                self.assert_blocked(self.status(tokens=tokens), 'account_role_required')

    def test_missing_profile_diagnostic_keeps_jwt_rejection(self):
        self.user.profile.delete()
        user = get_user_model().objects.get(pk=self.user.pk)
        self.assertFalse(vault.eligible(user))
        self.assertEqual(ineligible_account_reason(user), 'user_profile_required')
        self.assertEqual(self.status().status_code, 403)

    def test_password_change_diagnostic_keeps_jwt_rejection(self):
        for field in ('password_reset_required', 'is_using_temp_password'):
            with self.subTest(field=field):
                profile = get_user_model().objects.get(pk=self.user.pk).profile
                profile.password_reset_required = field == 'password_reset_required'
                profile.is_using_temp_password = field == 'is_using_temp_password'
                profile.save(update_fields=['password_reset_required', 'is_using_temp_password'])
                user = get_user_model().objects.get(pk=self.user.pk)
                self.assertFalse(vault.eligible(user))
                self.assertEqual(ineligible_account_reason(user), 'password_change_required')
                self.assertEqual(self.status().status_code, 403)

    def test_inactive_and_archive_diagnostics_keep_authentication_rejection(self):
        self.assertEqual(ineligible_account_reason(AnonymousUser()), 'account_unavailable')
        get_user_model().objects.filter(pk=self.user.pk).update(is_active=False)
        user = get_user_model().objects.get(pk=self.user.pk)
        self.assertEqual(ineligible_account_reason(user), 'account_inactive')
        self.assertEqual(self.status().status_code, 401)
        get_user_model().objects.filter(pk=self.user.pk).update(is_active=True)
        self.user.groups.add(Group.objects.create(name='quality_media_archive_service'))
        user = get_user_model().objects.get(pk=self.user.pk)
        self.assertFalse(vault.eligible(user))
        self.assertEqual(ineligible_account_reason(user), 'restricted_identity')
        self.assertEqual(self.status().status_code, 403)

    def test_reviewed_configuration_failures_use_only_fixed_reasons(self):
        cases = (
            ({'MES_USER_OAUTH_CALLBACK_ORIGIN': 'http://synthetic-callback.example'},
             'callback_origin_unverified'),
            ({'MES_USER_OAUTH_PROVIDER_ORIGIN': 'https://synthetic-provider.example'},
             'provider_origin_unverified'),
            ({'MES_USER_OAUTH_APP_ACCESS_TOKEN': ''}, 'app_credential_missing'),
            ({'MES_USER_OAUTH_REVIEW_REFERENCE': ''}, 'oauth_configuration_unreviewed'),
            ({'MES_USER_OAUTH_CALLBACK_ORIGIN': 'https://synthetic.example:invalid'},
             'connection_configuration_unreviewed'),
        )
        for overrides, reason in cases:
            with self.subTest(reason=reason), override_settings(**overrides):
                self.assert_blocked(self.status(), reason)
                self.assertEqual(self.action('launch').status_code, 403)

    def test_unknown_exception_reasons_never_reach_status_response(self):
        from .views import OAuthBlocked
        private = 'SYNTHETIC-PRIVATE-CONFIGURATION-CONTENT'
        for error in (OAuthBlocked(private), ValueError(private)):
            with self.subTest(error_type=type(error).__name__), \
                    patch('mes_oauth.views.reviewed_configuration', side_effect=error):
                response = self.status()
                self.assert_blocked(response, 'connection_configuration_unreviewed')
                self.assertNotIn(private.encode(), response.content)
        with patch('mes_oauth.vault.expected_user', side_effect=vault.VaultBlocked(private)):
            response = self.status()
            self.assert_blocked(response, 'connection_unavailable')
            self.assertNotIn(private.encode(), response.content)

    def test_login_claims_keep_existing_validation_and_fixed_reason(self):
        now = timezone.now()
        valid = {'mes_sid': 'S' * 43, 'mes_login_exp': int((now + timedelta(hours=1)).timestamp())}
        self.assertEqual(login_claims(valid)[0], vault.digest('client-login', 'S' * 43))
        for mutation in ({'mes_sid': None}, {'mes_sid': 'short'}, {'mes_login_exp': True},
                         {'mes_login_exp': int((now - timedelta(seconds=1)).timestamp())},
                         {'mes_login_exp': int((now + timedelta(days=40)).timestamp())},
                         {'mes_login_exp': 10**100}):
            with self.subTest(fields=tuple(mutation)):
                with self.assertRaisesRegex(vault.VaultBlocked, '^new_login_required$'):
                    login_claims({**valid, **mutation})
        legacy = AccessToken.for_user(self.user)
        self.assert_blocked(self.status(tokens={'access': str(legacy)}), 'new_login_required')


@override_settings(**CONNECTION_SETTINGS)
class ConnectionLoginHintTests(ConnectionFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.factory_number = '99000000000000000001'  # Synthetic, never a live factory.
        self.hints = {
            str(self.user.pk): {'mes_user_id': str(MES_USER), 'account_name': 'SYNTHETIC-MES-ACCOUNT-A'},
            str(self.other.pk): {'mes_user_id': str(MES_USER + 1), 'account_name': 'SYNTHETIC-MES-ACCOUNT-B'},
        }
        self.hint_settings = override_settings(MES_USER_OAUTH_LOGIN_FACTORY_NUMBER=self.factory_number,
            MES_USER_OAUTH_LOGIN_HINTS=json.dumps(self.hints),
            INSPECTION_PILOT_ENABLED=False, INSPECTION_PILOT_USER_IDS=[])
        self.hint_settings.enable()
        self.addCleanup(self.hint_settings.disable)

    def test_current_actor_hint_is_read_only_metadata_without_prefill_or_token_access(self):
        models = (MESLoginSession, MESLoginTicket, MESCredential, OAuthAttempt)
        before = [model.objects.count() for model in models]
        with patch('mes_oauth.vault._open', side_effect=AssertionError('No credential read.')):
            response = self.api.get(reverse('mes-connection-status'), {
                'factory_number': '1', 'account_name': 'SYNTHETIC-OVERRIDE', 'actor_id': self.other.pk},
                secure=True, HTTP_AUTHORIZATION='Bearer ' + self.tokens['access'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['login_hint'], {
            'factory_number': self.factory_number, 'account_name': 'SYNTHETIC-MES-ACCOUNT-A',
            'prefill_supported': False})
        self.assertFalse(response.json()['live_ready'])
        self.assertNotIn(str(MES_USER).encode(), response.content)
        self.assertEqual(before, [model.objects.count() for model in models])
        self.assert_no_provider()

    def test_switching_wj_actor_never_returns_the_other_accounts_hint(self):
        other_tokens = self.obtain(self.other)
        for actor, tokens, other_actor in ((self.user, self.tokens, self.other),
                                          (self.other, other_tokens, self.user)):
            with self.subTest(actor=actor.pk):
                response = self.status(tokens=tokens)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['login_hint']['account_name'],
                                 self.hints[str(actor.pk)]['account_name'])
                self.assertNotIn(self.hints[str(other_actor.pk)]['account_name'].encode(), response.content)
        self.assert_no_provider()

    def test_malformed_factory_number_yields_no_hint(self):
        for value in (None, True, 1, '', '1 2', '-1', '1\n', 'SYNTHETIC', '9' * 21):
            with self.subTest(value_type=type(value).__name__), \
                    override_settings(MES_USER_OAUTH_LOGIN_FACTORY_NUMBER=value):
                response = self.status()
                self.assertEqual(response.status_code, 200)
                self.assertIsNone(response.json()['login_hint'])
                self.assertNotIn(b'SYNTHETIC-MES-ACCOUNT', response.content)
        self.assert_no_provider()

    def test_malformed_account_id_or_configuration_yields_no_hint(self):
        invalid_items = [None, {}, {'account_name': 'SYNTHETIC-MES-ACCOUNT-A'},
            *({'mes_user_id': value, 'account_name': 'SYNTHETIC-MES-ACCOUNT-A'}
              for value in (None, True, MES_USER, str(MES_USER + 1), '0' + str(MES_USER))),
            *({'mes_user_id': str(MES_USER), 'account_name': value}
              for value in (None, True, '', 'with space', '<script>', 'name\n', 'A' * 81)),
            {**self.hints[str(self.user.pk)], 'extra': 'SYNTHETIC-UNEXPECTED'}]
        invalid_configs = [None, 'null', 'bad-json', '[]', {},
            {str(self.other.pk): self.hints[str(self.other.pk)]}]
        invalid_configs += [{str(self.user.pk): item} for item in invalid_items]
        for raw in invalid_configs:
            with self.subTest(config_type=type(raw).__name__), override_settings(MES_USER_OAUTH_LOGIN_HINTS=raw):
                response = self.status()
                self.assertEqual(response.status_code, 200)
                self.assertIsNone(response.json()['login_hint'])
                self.assertNotIn(self.factory_number.encode(), response.content)
                self.assertNotIn(b'SYNTHETIC-MES-ACCOUNT', response.content)
        self.assert_no_provider()

    def test_hint_does_not_grant_launch_when_feature_is_disabled_or_actor_is_ineligible(self):
        with override_settings(MES_USER_SESSION_BRIDGE_ENABLED=False):
            response = self.status()
            self.assertIsNotNone(response.json()['login_hint'])
            self.assertFalse(response.json()['can_connect'])
            self.assertEqual(self.action('launch').status_code, 403)
        get_user_model().objects.filter(pk=self.user.pk).update(is_staff=False, is_superuser=False)
        response = self.status()
        self.assertIsNone(response.json()['login_hint'])
        self.assertFalse(response.json()['can_connect'])
        self.assertEqual(self.action('launch').status_code, 403)
        self.assertEqual(MESLoginTicket.objects.count(), 0)
        self.assert_no_provider()

    def test_valid_hint_cannot_replace_missing_numeric_mapping_or_authentication(self):
        with override_settings(MES_USER_OAUTH_USER_MAP={}):
            self.assertIsNone(self.status().json()['login_hint'])
            self.assertEqual(self.action('launch').status_code, 403)
        anonymous = Client().get(reverse('mes-connection-status'), secure=True)
        self.assertEqual(anonymous.status_code, 401)
        self.assertNotIn(b'SYNTHETIC-MES-ACCOUNT', anonymous.content)
        self.assertEqual(self.action('launch', {'account_name': 'SYNTHETIC-MES-ACCOUNT-A',
            'factory_number': self.factory_number}).status_code, 403)
        self.assertEqual(MESLoginTicket.objects.count(), 0)
        self.assert_no_provider()

    def test_valid_hint_cannot_override_actual_provider_user_identity(self):
        self.assertIsNotNone(self.status().json()['login_hint'])
        attempt = self.begin()
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 200)
        self.provider.userinfo.return_value = envelope({'userId': MES_USER + 1})
        response = self.csrf_post(CALLBACK, {'code': CODE})
        self.assertEqual(response.status_code, 502)
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, 'rejected')
        self.assertEqual(MESCredential.objects.count(), 0)
        self.assertEqual(self.provider.userinfo.call_count, 1)


@skipUnless(connection.vendor == 'postgresql', 'Callback dispatch/revocation locking requires PostgreSQL.')
@override_settings(**CONNECTION_SETTINGS)
class ConnectionCallbackConcurrencyTests(ConnectionFixture, TransactionTestCase):
    def worker(self, operation):
        connections.close_all()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '10000ms'")
                cursor.execute("SET lock_timeout = '5000ms'")
            return operation()
        finally:
            connections.close_all()

    def callback_client(self):
        browser = Client(enforce_csrf_checks=True)
        browser.cookies = copy(self.browser.cookies)
        return browser

    def test_logout_lock_wins_before_callback_dispatch_so_exchange_stays_zero(self):
        row = self.begin()
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 200)
        browser = self.callback_client()
        logout_locked, release_logout, callback_waiting = Event(), Event(), Event()
        original_revoke, original_lock = vault.revoke_actor, vault._lock_user

        def held_logout(*args, **kwargs):
            # Hold the same PostgreSQL user row that the real revocation uses.
            # Callback policy can still read the committed pre-revocation state.
            with transaction.atomic():
                original_lock(self.user.pk)
                logout_locked.set()
                if not release_logout.wait(5):
                    raise AssertionError('Synthetic logout release timed out.')
                return original_revoke(*args, **kwargs)

        def observed_callback_lock(actor_id):
            callback_waiting.set()
            return original_lock(actor_id)

        with patch('mes_oauth.vault.revoke_actor', side_effect=held_logout), \
                patch('mes_oauth.vault._lock_user', side_effect=observed_callback_lock), \
                ThreadPoolExecutor(max_workers=2) as pool:
            logout = pool.submit(self.worker, lambda: self.action('logout', {'refresh': self.tokens['refresh']}))
            try:
                self.assertTrue(logout_locked.wait(5))
                callback = pool.submit(self.worker, lambda: self.csrf_post(CALLBACK, {'code': CODE}, browser=browser))
                self.assertTrue(callback_waiting.wait(5))
                with self.assertRaises(TimeoutError):
                    callback.result(timeout=0.2)
                self.assert_no_provider()
            finally:
                release_logout.set()
            self.assertEqual(logout.result(timeout=10).status_code, 200)
            self.assertIn(callback.result(timeout=10).status_code, (403, 502))
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)
        row.refresh_from_db()
        self.assertEqual(row.status, 'rejected')
        self.assert_no_provider()

    def test_inflight_callback_holds_logout_through_userinfo_then_blocks_later_dispatch(self):
        row = self.begin()
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 200)
        browser = self.callback_client()
        exchange_entered, release_exchange = Event(), Event()
        info_entered, release_info, logout_entered = Event(), Event(), Event()
        original_revoke = vault.revoke_actor

        def exchange(code):
            exchange_entered.set()
            if not release_exchange.wait(5):
                raise AssertionError('Synthetic exchange release timed out.')
            return envelope({'userAccessToken': PROVIDER_TOKEN})

        def userinfo(token):
            info_entered.set()
            if not release_info.wait(5):
                raise AssertionError('Synthetic userinfo release timed out.')
            return envelope({'userId': MES_USER})

        def observed_logout(*args, **kwargs):
            logout_entered.set()
            return original_revoke(*args, **kwargs)

        self.provider.exchange.side_effect = exchange
        self.provider.userinfo.side_effect = userinfo
        with patch('mes_oauth.vault.revoke_actor', side_effect=observed_logout), \
                ThreadPoolExecutor(max_workers=2) as pool:
            callback = pool.submit(self.worker, lambda: self.csrf_post(CALLBACK, {'code': CODE}, browser=browser))
            try:
                self.assertTrue(exchange_entered.wait(5))
                logout = pool.submit(self.worker, lambda: self.action('logout', {'refresh': self.tokens['refresh']}))
                self.assertTrue(logout_entered.wait(5))
                with self.assertRaises(TimeoutError):
                    logout.result(timeout=0.2)
                release_exchange.set()
                self.assertTrue(info_entered.wait(5))
                with self.assertRaises(TimeoutError):
                    logout.result(timeout=0.2)
            finally:
                release_exchange.set()
                release_info.set()
            response = callback.result(timeout=10)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {'identity_verified': True, 'expiry_verified': False, 'live_ready': False})
            self.assertEqual(logout.result(timeout=10).status_code, 200)
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)
        row.refresh_from_db()
        self.assertEqual(row.status, 'verified')  # Accepted before logout obtained its lock.
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 403)
        self.assertEqual(self.csrf_post(CALLBACK, {'code': CODE}).status_code, 403)
        self.assertEqual(self.action('launch').status_code, 401)
        self.provider.exchange.assert_called_once_with(CODE)
        self.provider.userinfo.assert_called_once_with(PROVIDER_TOKEN)
