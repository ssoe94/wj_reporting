"""Browser logout preserves actor credentials and independent WJ logins."""
from datetime import timedelta
import json

from django.contrib.auth import logout
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

from . import vault
from .connection_views import SESSION_KEY
from .identity import VerifiedUserContext
from .models import MESCredential, MESLoginSession, MESLoginTicket
from .test_connection import CONNECTION_SETTINGS, ConnectionFixture, FRONTEND, MES_USER
from .test_vault import KEY_ONE


@override_settings(**{**CONNECTION_SETTINGS,
    'MES_USER_TOKEN_STORAGE_ENABLED': True,
    'MES_USER_TOKEN_APP_ID': '10000000000000005',
    'MES_USER_TOKEN_TENANT_REFERENCE': 'SYNTHETIC-TENANT',
    'MES_USER_TOKEN_POLICY_REFERENCE': 'SYNTHETIC-LOGOUT-POLICY',
    'MES_USER_TOKEN_EXPIRY_MODE': 'relative_seconds',
    'MES_USER_TOKEN_CONTRACT_REFERENCE': 'SYNTHETIC-REVIEWED-EXPIRY',
    'MES_USER_TOKEN_MAX_AGE_SECONDS': 600,
    'MES_USER_TOKEN_IDLE_SECONDS': 180,
    'MES_USER_TOKEN_CONSENT_SECONDS': 900,
    'MES_USER_TOKEN_SAFETY_SECONDS': 30,
    'MES_USER_TOKEN_KEYS': json.dumps({'fixture-v1': KEY_ONE}),
    'MES_USER_TOKEN_ACTIVE_KEY_ID': 'fixture-v1',
})
class BrowserLogoutScopeTests(ConnectionFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.later = self.obtain(self.user)
        self.other_tokens = self.obtain(self.other)
        for tokens in (self.tokens, self.later, self.other_tokens):
            self.launch(tokens=tokens)
        for actor, tokens, mes_user in (
            (self.user, self.tokens, MES_USER),
            (self.other, self.other_tokens, MES_USER + 1),
        ):
            now = timezone.now()
            vault.store_context(actor.pk, self.login_digest(tokens),
                VerifiedUserContext(mes_user, 'SYNTHETIC-STORED-LOGOUT-TOKEN', 1200),
                request_started_at=now - timedelta(seconds=2),
                received_at=now - timedelta(seconds=1), login_revision=1)
        self.credentials = list(MESCredential.objects.order_by('actor_id').values())
        self.assertTrue(all(row['ciphertext'] for row in self.credentials))
        self.token_count = OutstandingToken.objects.count()

    def assert_only_current_login_ended(self):
        self.assertIsNotNone(MESLoginSession.objects.get(pk=self.login_digest()).revoked_at)
        self.assertFalse(MESLoginTicket.objects.filter(
            login_digest=self.login_digest(), consumed_at__isnull=True).exists())
        for tokens in (self.later, self.other_tokens):
            self.assertIsNone(MESLoginSession.objects.get(pk=self.login_digest(tokens)).revoked_at)
            self.assertTrue(MESLoginTicket.objects.filter(
                login_digest=self.login_digest(tokens), consumed_at__isnull=True).exists())
            RefreshToken(tokens['refresh']).check_blacklist()
        self.assertEqual(list(MESCredential.objects.order_by('actor_id').values()), self.credentials)
        self.assertEqual(OutstandingToken.objects.count(), self.token_count)
        self.assertEqual(self.action('launch').status_code, 401)
        self.assert_no_provider()

    def test_signed_browser_logout_keeps_both_actor_connections_and_other_logins(self):
        response = self.action('logout', {'refresh': self.tokens['refresh']})
        self.assertEqual(response.status_code, 200)
        self.assert_only_current_login_ended()
        self.assertEqual(self.api.post(reverse('token_refresh'),
            {'refresh': self.tokens['refresh']}, content_type='application/json',
            secure=True).status_code, 401)
        self.assertEqual(self.action('launch', tokens=self.later).status_code, 200)
        self.assertEqual(self.action('launch', tokens=self.other_tokens).status_code, 200)

    def test_refresh_only_logout_keeps_connections_and_other_logins(self):
        response = self.api.post(reverse('mes-connection-logout'),
            {'refresh': self.tokens['refresh']}, content_type='application/json',
            secure=True, HTTP_ORIGIN=FRONTEND)
        self.assertEqual(response.status_code, 200)
        self.assert_only_current_login_ended()

    def test_expired_access_matching_refresh_logout_preserves_connections(self):
        access = AccessToken(self.tokens['access'])
        access['exp'] = int((timezone.now() - timedelta(minutes=2)).timestamp())
        response = self.action('logout', {'refresh': self.tokens['refresh']},
            tokens={'access': str(access)})
        self.assertEqual(response.status_code, 200)
        self.assert_only_current_login_ended()

    def test_django_bridge_logout_only_ends_bound_wj_login(self):
        self.browser.force_login(self.user)
        session = self.browser.session
        session[SESSION_KEY] = self.login_digest()
        session.save()
        request = RequestFactory().post('/synthetic/logout/', secure=True)
        request.user = self.user
        request.session = session
        logout(request)
        self.assertIsNone(request.session.session_key)
        self.assert_only_current_login_ended()

    def test_plain_django_logout_does_not_revoke_any_wj_login(self):
        self.browser.force_login(self.user)
        self.browser.logout()
        self.assertFalse(MESLoginSession.objects.filter(revoked_at__isnull=False).exists())
        self.assertFalse(MESLoginTicket.objects.filter(consumed_at__isnull=False).exists())
        self.assertEqual(list(MESCredential.objects.order_by('actor_id').values()), self.credentials)
        self.assert_no_provider()

    def test_unscoped_logout_cannot_become_account_wide_revocation(self):
        vault.revoke_actor(self.user.pk, reason='logout')
        self.assertFalse(MESLoginSession.objects.filter(revoked_at__isnull=False).exists())
        self.assertFalse(MESLoginTicket.objects.filter(consumed_at__isnull=False).exists())
        self.assertEqual(list(MESCredential.objects.order_by('actor_id').values()), self.credentials)
        self.assert_no_provider()

    def test_fresh_password_login_reads_retained_actor_connection_without_writes(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        from unittest.mock import patch
        self.assertEqual(self.action('logout', {'refresh': self.tokens['refresh']}).status_code, 200)
        fresh = self.obtain(self.user)
        digest = self.login_digest(fresh)
        self.assertTrue(MESLoginSession.objects.filter(pk=digest).exists())
        with CaptureQueriesContext(connection) as queries, patch(
                'mes_oauth.vault._open', side_effect=AssertionError('Metadata cannot decrypt.')):
            response = self.status(tokens=fresh)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'connected')
        self.assertTrue(response.json()['can_disconnect'])
        self.assertFalse(response.json()['live_ready'])
        row = MESCredential.objects.get(pk=self.user.pk)
        self.assertEqual(response.json()['expires_at'], min(row.expires_at, row.idle_expires_at).isoformat())
        self.assertFalse(any(query['sql'].lstrip().upper().startswith(
            ('INSERT', 'UPDATE', 'DELETE', 'REPLACE')) for query in queries))
        self.assertTrue(MESLoginSession.objects.filter(pk=digest).exists())
        self.assertEqual(list(MESCredential.objects.order_by('actor_id').values()), self.credentials)
        self.assert_no_provider()

    def test_fresh_other_actor_cannot_see_or_borrow_retained_connection(self):
        MESCredential.objects.filter(pk=self.other.pk).delete()
        fresh = self.obtain(self.other)
        response = self.status(tokens=fresh)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'disconnected')
        self.assertFalse(response.json()['can_disconnect'])
        self.assertIsNone(response.json()['expires_at'])
        self.assertTrue(MESLoginSession.objects.filter(pk=self.login_digest(fresh)).exists())
        self.assert_no_provider()

    def test_revoked_or_authorization_changed_marker_cannot_read_or_disconnect(self):
        for change in ({'revoked_at': timezone.now()}, {'authorization_digest': '0' * 64}):
            with self.subTest(change=tuple(change)):
                fresh = self.obtain(self.user)
                self.launch(tokens=fresh)
                MESLoginSession.objects.filter(pk=self.login_digest(fresh)).update(**change)
                self.assertEqual(self.status(tokens=fresh).status_code, 401)
                self.assertEqual(self.action('disconnect', tokens=fresh).status_code, 401)
                self.assertEqual(list(MESCredential.objects.order_by('actor_id').values()), self.credentials)
        self.assert_no_provider()

    def test_fresh_login_explicit_disconnect_clears_only_its_actor_connection(self):
        fresh = self.obtain(self.user)
        response = self.action('disconnect', tokens=fresh)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'disconnected': True})
        row = MESCredential.objects.get(pk=self.user.pk)
        self.assertEqual(bytes(row.ciphertext), b'')
        self.assertIsNotNone(row.revoked_at)
        self.assertTrue(MESLoginSession.objects.filter(pk=self.login_digest(fresh)).exists())
        self.assertEqual(MESCredential.objects.filter(pk=self.other.pk).values().get(), self.credentials[1])
        self.assertFalse(MESLoginSession.objects.filter(revoked_at__isnull=False).exists())
        self.assert_no_provider()
