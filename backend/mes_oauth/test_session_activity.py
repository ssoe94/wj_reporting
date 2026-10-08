"""Synthetic WJ activity clocks; no live login, provider, or business writes."""
from datetime import datetime, timedelta, timezone as dt_timezone
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.contrib.auth.hashers import make_password
from django.test import TestCase, override_settings
from django.urls import reverse
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

from injection.models import UserProfile
from . import vault
from .models import MESCredential, MESLoginSession
from .test_connection import ConnectionFixture, CONNECTION_SETTINGS, FRONTEND
from .test_vault import VaultFixture


ACTIVITY = '/api/auth/activity/'


class ActivityFixture(ConnectionFixture):
    def setUp(self):
        self.now = datetime(2026, 10, 6, 12, tzinfo=dt_timezone.utc)
        for target in ('django.utils.timezone.now', 'rest_framework_simplejwt.tokens.aware_utcnow'):
            clock = patch(target, side_effect=lambda: self.now)
            clock.start()
            self.addCleanup(clock.stop)
        fixture = self
        class FrozenJWTDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return fixture.now
        jwt_clock = patch('jwt.api_jwt.datetime', FrozenJWTDatetime)
        jwt_clock.start()
        self.addCleanup(jwt_clock.stop)
        super().setUp()

    def advance(self, **delta):
        self.now += timedelta(**delta)

    def activity(self, tokens=None, data=None):
        tokens = tokens or self.tokens
        return self.api.post(ACTIVITY, {'refresh': tokens['refresh']} if data is None else data,
            content_type='application/json', secure=True,
            HTTP_ORIGIN=FRONTEND, HTTP_AUTHORIZATION='Bearer ' + tokens['access'])

    def refresh(self, tokens=None):
        return self.api.post(reverse('token_refresh'),
            {'refresh': (tokens or self.tokens)['refresh']},
            content_type='application/json', secure=True)

    def login_digest(self, tokens=None):
        # Fixture lookup must remain possible after the JWT has expired.
        sid = AccessToken((tokens or self.tokens)['access'], verify=False)['mes_sid']
        return vault.digest('client-login', sid)

    def row(self, tokens=None):
        return MESLoginSession.objects.get(pk=self.login_digest(tokens))

    def legacy(self, *, marker=True):
        # Direct serializer generation intentionally remains the pre-v2 fixture.
        from config.token_views import ScopedTokenObtainPairSerializer
        refresh = ScopedTokenObtainPairSerializer.get_token(self.user)
        refresh.payload.pop('mes_session_v', None)
        tokens = {'access': str(refresh.access_token), 'refresh': str(refresh)}
        if marker:
            MESLoginSession.objects.create(digest=self.login_digest(tokens), actor_id=self.user.pk,
                authorization_digest=vault.authorization_digest(self.user),
                expires_at=datetime.fromtimestamp(refresh['mes_login_exp'], dt_timezone.utc))
        return tokens


@override_settings(**CONNECTION_SETTINGS)
class SessionActivityTests(ActivityFixture, TestCase):
    def test_real_password_login_creates_v2_and_activity_rotates_only_same_family(self):
        first = self.row()
        self.assertEqual(AccessToken(self.tokens['access'])['mes_session_v'], 2)
        self.assertEqual(first.session_version, 2)
        self.assertEqual(first.last_activity_at, self.now)
        self.assertEqual(first.idle_expires_at, self.now + timedelta(hours=24))
        self.advance(minutes=10)
        response = self.activity()
        self.assertEqual(response.status_code, 200)
        rotated = response.json()
        self.assertIn('no-store', response['Cache-Control'])
        self.assertEqual(response['Referrer-Policy'], 'no-referrer')
        self.assertEqual(self.login_digest(rotated), self.login_digest())
        old, new = RefreshToken(self.tokens['refresh'], verify=False), RefreshToken(rotated['refresh'])
        self.assertEqual(old['mes_login_exp'], new['mes_login_exp'])
        self.assertNotEqual(old['jti'], new['jti'])
        with self.assertRaises(Exception):
            RefreshToken(self.tokens['refresh'])
        row = self.row()
        self.assertEqual(row.expires_at, first.expires_at)
        self.assertEqual(row.last_activity_at, self.now)
        self.assertEqual(row.idle_expires_at, self.now + timedelta(hours=24))
        self.assertEqual(new['exp'], int(row.idle_expires_at.timestamp()))
        outstanding = OutstandingToken.objects.get(jti=new['jti'])
        self.assertEqual(outstanding.expires_at, row.idle_expires_at)
        self.assertEqual(outstanding.token, rotated['refresh'])
        self.assertEqual(datetime.fromisoformat(rotated['session_idle_expires_at']), row.idle_expires_at)
        self.assertEqual(datetime.fromisoformat(rotated['session_last_activity_at']), row.last_activity_at)
        self.assert_no_provider()

    def test_poll_and_refresh_for_25_hours_never_extend_idle_deadline(self):
        before = self.row()
        tokens = self.tokens
        for _ in range(23):
            self.advance(hours=1)
            refreshed = self.refresh(tokens)
            self.assertEqual(refreshed.status_code, 200)
            tokens = refreshed.json()
            self.assertEqual(self.status(tokens=tokens).status_code, 200)
            row = self.row(tokens)
            self.assertEqual((row.last_activity_at, row.idle_expires_at),
                             (before.last_activity_at, before.idle_expires_at))
            self.assertLessEqual(RefreshToken(tokens['refresh'])['exp'], int(before.idle_expires_at.timestamp()))
        self.advance(hours=2)
        self.assertEqual(self.refresh(tokens).status_code, 401)
        self.assertEqual(self.status(tokens=tokens).status_code, 401)
        self.assertEqual(self.activity(tokens).status_code, 401)
        self.assertEqual(self.row().idle_expires_at, before.idle_expires_at)
        self.assert_no_provider()

    def test_active_v2_survives_original_seven_day_anchor_without_mutating_it(self):
        anchor = self.row().expires_at
        tokens = self.tokens
        for _ in range(8):
            self.advance(hours=23)
            refreshed = self.refresh(tokens)
            self.assertEqual(refreshed.status_code, 200)
            response = self.activity(refreshed.json())
            self.assertEqual(response.status_code, 200)
            tokens = response.json()
        self.assertGreater(self.now, anchor)
        self.assertEqual(self.status(tokens=tokens).status_code, 200)
        self.assertEqual(self.row(tokens).expires_at, anchor)
        self.assertEqual(AccessToken(tokens['access'])['mes_login_exp'], int(anchor.timestamp()))
        self.assert_no_provider()

    def test_legacy_upgrade_preserves_sid_and_anchor_and_requires_existing_live_marker(self):
        tokens = self.legacy()
        anchor = self.row(tokens).expires_at
        self.assertIsNone(self.row(tokens).session_version)
        self.assertIsNone(self.row(tokens).idle_expires_at)
        response = self.activity(tokens)
        self.assertEqual(response.status_code, 200)
        rotated = response.json()
        self.assertEqual(self.login_digest(rotated), self.login_digest(tokens))
        self.assertEqual(AccessToken(rotated['access'])['mes_session_v'], 2)
        self.assertEqual(self.row(rotated).session_version, 2)
        self.assertEqual(self.row(rotated).expires_at, anchor)
        self.assertEqual(self.row(rotated).idle_expires_at, self.now + timedelta(hours=24))

    def test_missing_revoked_and_partial_clock_markers_cannot_upgrade_or_resurrect(self):
        for kind in ('missing', 'revoked', 'last_only', 'idle_only'):
            with self.subTest(kind=kind):
                tokens = self.legacy(marker=kind != 'missing')
                if kind == 'revoked':
                    MESLoginSession.objects.filter(pk=self.login_digest(tokens)).update(revoked_at=self.now)
                elif kind == 'last_only':
                    MESLoginSession.objects.filter(pk=self.login_digest(tokens)).update(last_activity_at=self.now)
                elif kind == 'idle_only':
                    MESLoginSession.objects.filter(pk=self.login_digest(tokens)).update(
                        idle_expires_at=self.now + timedelta(hours=24))
                self.assertEqual(self.activity(tokens).status_code, 401)
                if kind == 'missing':
                    self.assertFalse(MESLoginSession.objects.filter(pk=self.login_digest(tokens)).exists())
        self.assert_no_provider()

    def test_refresh_actor_sid_anchor_and_blacklist_proofs_must_all_match(self):
        other_pc = self.obtain(self.user)
        other_actor = self.obtain(self.other)
        changed_anchor = RefreshToken(self.tokens['refresh'])
        changed_anchor['mes_login_exp'] += 60
        for refresh in (other_pc['refresh'], other_actor['refresh'], str(changed_anchor)):
            self.assertEqual(self.activity(data={'refresh': refresh}).status_code, 401)
        RefreshToken(self.tokens['refresh']).blacklist()
        self.assertEqual(self.activity().status_code, 401)
        self.assertEqual(self.row().last_activity_at, self.now)
        self.assert_no_provider()

    def test_activity_renews_only_current_pc_and_actor(self):
        other_pc, other_actor = self.obtain(self.user), self.obtain(self.other)
        rows = {self.login_digest(tokens): self.row(tokens).idle_expires_at
                for tokens in (other_pc, other_actor)}
        self.advance(minutes=10)
        self.assertEqual(self.activity().status_code, 200)
        for tokens in (other_pc, other_actor):
            self.assertEqual(self.row(tokens).idle_expires_at, rows[self.login_digest(tokens)])
            self.assertIsNone(self.row(tokens).revoked_at)
        self.assertEqual(self.row().idle_expires_at, self.now + timedelta(hours=24))

    def test_activity_preserves_mes_ciphertext_provider_86400_and_consent(self):
        now = self.now
        MESCredential.objects.create(actor_id=self.user.pk, mes_user_id='10000000000000003',
            app_id='10000000000000005', tenant_reference='SYNTHETIC',
            login_digest=self.login_digest(), authorization_digest=vault.authorization_digest(self.user),
            policy_reference='SYNTHETIC', key_id='synthetic-key', ciphertext=b'SYNTHETIC-CIPHERTEXT',
            verified_at=now, last_used_at=now, expires_at=now + timedelta(seconds=86400),
            provider_expires_at=now + timedelta(seconds=86400), idle_expires_at=now + timedelta(hours=1),
            consent_expires_at=now + timedelta(days=2))
        before = MESCredential.objects.values().get()
        self.advance(minutes=10)
        self.assertEqual(self.activity().status_code, 200)
        self.assertEqual(MESCredential.objects.values().get(), before)
        self.assert_no_provider()

    def test_password_profile_and_authority_changes_are_rechecked(self):
        for kind in ('password', 'profile', 'group'):
            tokens = self.obtain(self.user)
            with self.subTest(kind=kind):
                if kind == 'password':
                    get_user_model().objects.filter(pk=self.user.pk).update(password=make_password('CHANGED'))
                elif kind == 'profile':
                    UserProfile.objects.filter(user=self.user).update(password_reset_required=True)
                else:
                    group = Group.objects.create(name='SYNTHETIC-ACTIVITY-GROUP')
                    self.user.groups.add(group)
                self.assertEqual(self.activity(tokens).status_code, 401)
                get_user_model().objects.filter(pk=self.user.pk).update(password=self.user.password)
                UserProfile.objects.filter(user=self.user).update(password_reset_required=False)
        self.assert_no_provider()

    def test_activity_does_not_accept_expired_access_extra_fields_or_get(self):
        for data in ({}, {'refresh': self.tokens['refresh'], 'actor_id': self.user.pk},
                     {'refresh': self.tokens['refresh'], 'last_activity_at': self.now.isoformat()}):
            self.assertEqual(self.activity(data=data).status_code, 400)
        self.assertEqual(self.api.get(ACTIVITY, secure=True,
            HTTP_AUTHORIZATION='Bearer ' + self.tokens['access']).status_code, 405)
        before = self.row().idle_expires_at
        self.advance(hours=1)
        self.assertEqual(self.activity().status_code, 401)
        self.assertEqual(self.row().idle_expires_at, before)

    def test_v2_missing_marker_and_expired_idle_cannot_recreate_family(self):
        for kind in ('missing', 'expired'):
            tokens = self.obtain(self.user)
            digest = self.login_digest(tokens)
            if kind == 'missing':
                MESLoginSession.objects.filter(pk=digest).delete()
            else:
                MESLoginSession.objects.filter(pk=digest).update(
                    last_activity_at=self.now - timedelta(hours=25),
                    idle_expires_at=self.now - timedelta(hours=1))
            with self.subTest(kind=kind):
                self.assertEqual(self.status(tokens=tokens).status_code, 401)
                self.assertEqual(self.action('launch', tokens=tokens).status_code, 401)
                self.assertEqual(self.refresh(tokens).status_code, 401)
                self.assertEqual(self.activity(tokens).status_code, 401)
                if kind == 'missing':
                    self.assertFalse(MESLoginSession.objects.filter(pk=digest).exists())
        self.assert_no_provider()

    def test_logout_past_original_anchor_keeps_tombstone_and_cannot_be_revived(self):
        tokens = self.tokens
        for _ in range(8):
            self.advance(hours=23)
            refreshed = self.refresh(tokens)
            self.assertEqual(refreshed.status_code, 200)
            active = self.activity(refreshed.json())
            self.assertEqual(active.status_code, 200)
            tokens = active.json()
        response = self.action('logout', {'refresh': tokens['refresh']}, tokens=tokens)
        self.assertEqual(response.status_code, 200)
        revoked = self.row(tokens)
        self.assertIsNotNone(revoked.revoked_at)
        self.assertLess(revoked.expires_at, self.now)
        self.assertEqual(self.activity(tokens).status_code, 401)
        self.assertEqual(self.refresh(tokens).status_code, 401)
        self.assertEqual(self.action('launch', tokens=tokens).status_code, 401)
        self.assertEqual(self.row(tokens).revoked_at, revoked.revoked_at)


    def test_corrupt_v2_provenance_cannot_fall_back_to_legacy_admission(self):
        for updates in ({'last_activity_at': None, 'idle_expires_at': None},
                        {'session_version': None}, {'session_version': 3}):
            tokens = self.obtain(self.user)
            MESLoginSession.objects.filter(pk=self.login_digest(tokens)).update(**updates)
            with self.subTest(updates=updates):
                self.assertEqual(self.status(tokens=tokens).status_code, 401)
                self.assertEqual(self.refresh(tokens).status_code, 401)
                self.assertEqual(self.activity(tokens).status_code, 401)
        for version in (None, True, 3, '2'):
            access = AccessToken(self.tokens['access'])
            refresh = RefreshToken(self.tokens['refresh'])
            access['mes_session_v'] = refresh['mes_session_v'] = version
            tokens = {'access': str(access), 'refresh': str(refresh)}
            with self.subTest(signed_version=version):
                self.assertEqual(self.status(tokens=tokens).status_code, 401)
                self.assertEqual(self.activity(tokens).status_code, 401)
        self.assert_no_provider()

    def test_lost_v2_clocks_block_pending_bridge_and_oauth_callback(self):
        from .views import CALLBACK
        attempt = self.begin()
        ticket = self.launch()
        MESLoginSession.objects.filter(pk=self.login_digest()).update(
            last_activity_at=None, idle_expires_at=None)
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assertEqual(self.csrf_post(CALLBACK, {'code': 'SYNTHETIC-PENDING-CODE'}).status_code, 403)
        attempt.refresh_from_db()
        self.assertNotEqual(attempt.status, 'verified')
        self.assertFalse(MESCredential.objects.exists())
        self.assert_no_provider()

    def test_legacy_activity_persists_pilot_scope_after_allowlist_removal(self):
        from .pilot_scope import PILOT_SCOPE_CLAIM
        tokens = self.legacy()
        self.assertNotIn(PILOT_SCOPE_CLAIM, AccessToken(tokens['access']))
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.user.pk]):
            response = self.activity(tokens)
        self.assertEqual(response.status_code, 200)
        rotated = response.json()
        self.assertTrue(AccessToken(rotated['access'])[PILOT_SCOPE_CLAIM])
        self.assertTrue(RefreshToken(rotated['refresh'])[PILOT_SCOPE_CLAIM])
        with override_settings(INSPECTION_PILOT_USER_IDS=[]):
            response = self.api.get('/api/quality/inspection-requests/kanban/', secure=True,
                HTTP_AUTHORIZATION='Bearer ' + rotated['access'])
        self.assertEqual(response.status_code, 403)
        self.assert_no_provider()


class SessionActivityVaultProvenanceTests(VaultFixture, TestCase):
    def test_digest_only_vault_storage_rejects_lost_or_mixed_v2_clocks(self):
        for version, activity, idle in (
            (2, None, None), (None, self.instant, self.instant + timedelta(hours=24)),
            (3, self.instant, self.instant + timedelta(hours=24)),
            (2, self.instant, None),
        ):
            MESLoginSession.objects.filter(pk=self.login_digest).update(
                session_version=version, last_activity_at=activity, idle_expires_at=idle)
            with self.subTest(version=version, activity=activity, idle=idle):
                with self.assertRaisesRegex(vault.VaultBlocked, '^login_unavailable$'):
                    vault._login(self.user, self.login_digest)
                with self.assertRaisesRegex(vault.VaultBlocked, '^login_unavailable$'):
                    self.store()
            self.assertFalse(MESCredential.objects.exists())
        self.assert_no_provider()
