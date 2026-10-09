"""Synthetic non-bridge callback races; no token issuance or external network."""
from concurrent.futures import ThreadPoolExecutor
from unittest import skipUnless
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model, logout
from django.contrib.auth.hashers import make_password
from django.contrib.sessions.backends.db import SessionStore
from django.db import connection, connections
from django.test import Client, RequestFactory, TestCase, TransactionTestCase, override_settings

from injection.models import UserProfile
from . import vault
from .models import MESCredential, MESLoginSession, OAuthAttempt
from .views import CALLBACK, START


ORIGIN = 'https://testserver'
CODE = 'SYNTHETIC-CACHED-SESSION-CODE'
MES_USER = 10_000_000_000_000_007


SESSION_SETTINGS = dict(
    MIDDLEWARE=[
        'mes_oauth.security.OAuthQueryRedactionMiddleware',
        'django.contrib.sessions.middleware.SessionMiddleware',
        'config.middleware.DisableCSRFMiddleware',
        'django.middleware.csrf.CsrfViewMiddleware',
        'django.contrib.auth.middleware.AuthenticationMiddleware',
    ],
    MES_USER_OAUTH_ENABLED=True, MES_USER_SESSION_BRIDGE_ENABLED=False,
    MES_USER_TOKEN_STORAGE_ENABLED=False, DEBUG=False,
    MES_USER_OAUTH_CALLBACK_ORIGIN=ORIGIN,
    MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
    MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-REVIEWED-PAGE',
    MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-SESSION-REVIEW',
    MES_USER_OAUTH_APP_ACCESS_TOKEN='SYNTHETIC-UNUSED-APP-TOKEN',
    SESSION_ENGINE='django.contrib.sessions.backends.db',
    SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_DOMAIN=None,
    CSRF_COOKIE_SECURE=True, CSRF_COOKIE_DOMAIN=None,
    CSRF_TRUSTED_ORIGINS=[ORIGIN],
)


@override_settings(**SESSION_SETTINGS)
class CachedSessionRevocationTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username='SYNTHETIC-SESSION-ACTOR', password='SYNTHETIC-ORIGINAL-PASSWORD',
            is_superuser=True, is_staff=True)
        UserProfile.objects.get_or_create(user=self.user)
        mapping = override_settings(MES_USER_OAUTH_USER_MAP={str(self.user.pk): str(MES_USER)})
        mapping.enable()
        self.addCleanup(mapping.disable)
        self.client = Client(enforce_csrf_checks=True)
        self.client.force_login(self.user)
        self.session_key = self.client.session.session_key
        self.provider = Mock(spec=['exchange', 'userinfo', 'refresh'])
        factory = patch('mes_oauth.views.get_provider', return_value=self.provider)
        self.factory = factory.start()
        self.addCleanup(factory.stop)
        network = patch('requests.sessions.Session.request', side_effect=AssertionError('No live HTTP.'))
        self.network = network.start()
        self.addCleanup(network.stop)
        self.addCleanup(self.network.assert_not_called)

    def post(self, path, data=None):
        return self.client.post(path, {
            'csrfmiddlewaretoken': self.client.cookies['csrftoken'].value,
            **(data or {}),
        }, secure=True, HTTP_ORIGIN=ORIGIN)

    def begin(self):
        self.assertEqual(self.client.get(START, secure=True).status_code, 200)
        self.assertEqual(self.post(START).status_code, 200)
        self.assertEqual(self.client.get(CALLBACK, secure=True).status_code, 200)
        self.assertNotIn('mes_bridge_only', self.client.session)
        self.assertFalse(MESLoginSession.objects.exists())
        return OAuthAttempt.objects.get()

    def assert_callback_refused_before_provider(self, attempt, response):
        self.assertEqual(response.status_code, 502)
        self.assertIn(b'identity_verification_failed', response.content)
        self.assertNotIn(CODE.encode(), response.content)
        self.factory.assert_not_called()
        self.assertEqual(self.provider.mock_calls, [])
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, 'rejected')
        self.assertEqual(attempt.error_code, 'identity_verification_failed')
        self.assertIsNotNone(attempt.consumed_at)
        self.assertIsNone(attempt.verified_at)
        self.assertFalse(MESCredential.objects.exists())

    def test_logout_after_cached_session_check_stops_before_provider_construction(self):
        attempt = self.begin()
        original_lock = vault._lock_user
        observed = {}

        def logout_between_reservation_and_dispatch(actor_id):
            # This point is reached only after the callback's initial policy
            # accepted the cached request and the one-use code was reserved.
            observed['phase'] = OAuthAttempt.objects.get(pk=attempt.pk).status
            other_request = RequestFactory().post('/synthetic/logout/', secure=True)
            other_request.session = SessionStore(session_key=self.session_key)
            other_request.user = get_user_model().objects.get(pk=actor_id)
            logout(other_request)
            observed['session_deleted'] = not SessionStore().exists(self.session_key)
            return original_lock(actor_id)

        with patch('mes_oauth.vault._lock_user', side_effect=logout_between_reservation_and_dispatch) as locked:
            response = self.post(CALLBACK, {'code': CODE})
        locked.assert_called_once_with(self.user.pk)
        self.assertEqual(observed, {'phase': 'processing', 'session_deleted': True})
        self.assert_callback_refused_before_provider(attempt, response)
        # This deterministic injection shares the callback transaction: its
        # simulated logout is rolled back on refusal. Separate-connection
        # PostgreSQL tests below verify committed logout stays effective.

    def test_password_change_after_cached_session_check_stops_before_provider_construction(self):
        attempt = self.begin()
        original_hash = SessionStore(session_key=self.session_key).load()['_auth_user_hash']
        original_lock = vault._lock_user
        observed = {}

        def change_password_between_reservation_and_dispatch(actor_id):
            observed['phase'] = OAuthAttempt.objects.get(pk=attempt.pk).status
            # Deliberately bypass signals: the fresh session/auth-hash check,
            # independently of a credential revocation hook, must reject this.
            get_user_model().objects.filter(pk=actor_id).update(
                password=make_password('SYNTHETIC-REPLACEMENT-PASSWORD'))
            current = original_lock(actor_id)
            observed['old_hash_persisted'] = SessionStore(session_key=self.session_key).load()['_auth_user_hash'] == original_hash
            observed['password_changed'] = current.get_session_auth_hash() != original_hash
            return current

        with patch('mes_oauth.vault._lock_user', side_effect=change_password_between_reservation_and_dispatch) as locked:
            response = self.post(CALLBACK, {'code': CODE})
        locked.assert_called_once_with(self.user.pk)
        self.assertEqual(observed, {'phase': 'processing', 'old_hash_persisted': True, 'password_changed': True})
        self.assert_callback_refused_before_provider(attempt, response)


@skipUnless(connection.vendor == 'postgresql', 'Committed cross-request revocation requires PostgreSQL.')
@override_settings(**SESSION_SETTINGS)
class CommittedSessionRevocationTests(TransactionTestCase):
    setUp = CachedSessionRevocationTests.setUp
    post = CachedSessionRevocationTests.post
    begin = CachedSessionRevocationTests.begin
    assert_callback_refused_before_provider = CachedSessionRevocationTests.assert_callback_refused_before_provider

    def separate_connection(self, operation):
        def run():
            connections.close_all()
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SET statement_timeout = '10000ms'")
                    cursor.execute("SET lock_timeout = '5000ms'")
                return operation()
            finally:
                connections.close_all()
        # Completion is the barrier: the independent change commits after the
        # initial callback check/reservation and before its user-row lock.
        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(run).result(timeout=10)

    def test_committed_logout_after_initial_check_prevents_dispatch_and_stays_deleted(self):
        attempt = self.begin()
        original_lock = vault._lock_user
        observed = {}

        def committed_logout():
            phase = OAuthAttempt.objects.get(pk=attempt.pk).status
            request = RequestFactory().post('/synthetic/logout/', secure=True)
            request.session = SessionStore(session_key=self.session_key)
            request.user = get_user_model().objects.get(pk=self.user.pk)
            logout(request)
            return {'phase': phase, 'session_deleted': not SessionStore().exists(self.session_key)}

        def change_then_lock(actor_id):
            observed.update(self.separate_connection(committed_logout))
            return original_lock(actor_id)

        with patch('mes_oauth.vault._lock_user', side_effect=change_then_lock) as locked:
            response = self.post(CALLBACK, {'code': CODE})
        locked.assert_called_once_with(self.user.pk)
        self.assertEqual(observed, {'phase': 'processing', 'session_deleted': True})
        self.assert_callback_refused_before_provider(attempt, response)
        self.assertFalse(SessionStore().exists(self.session_key))

    def test_committed_password_change_after_initial_check_prevents_dispatch(self):
        attempt = self.begin()
        original_hash = SessionStore(session_key=self.session_key).load()['_auth_user_hash']
        original_lock = vault._lock_user
        observed = {}

        def committed_change():
            phase = OAuthAttempt.objects.get(pk=attempt.pk).status
            get_user_model().objects.filter(pk=self.user.pk).update(
                password=make_password('SYNTHETIC-COMMITTED-REPLACEMENT'))
            current = get_user_model().objects.get(pk=self.user.pk)
            return {'phase': phase, 'password_changed': current.get_session_auth_hash() != original_hash,
                    'old_hash_persisted': SessionStore(session_key=self.session_key).load()['_auth_user_hash'] == original_hash}

        def change_then_lock(actor_id):
            observed.update(self.separate_connection(committed_change))
            return original_lock(actor_id)

        with patch('mes_oauth.vault._lock_user', side_effect=change_then_lock) as locked:
            response = self.post(CALLBACK, {'code': CODE})
        locked.assert_called_once_with(self.user.pk)
        self.assertEqual(observed, {'phase': 'processing', 'password_changed': True, 'old_hash_persisted': True})
        self.assert_callback_refused_before_provider(attempt, response)
        current = get_user_model().objects.get(pk=self.user.pk)
        self.assertNotEqual(current.get_session_auth_hash(), original_hash)
        self.assertEqual(SessionStore(session_key=self.session_key).load()['_auth_user_hash'], original_hash)
