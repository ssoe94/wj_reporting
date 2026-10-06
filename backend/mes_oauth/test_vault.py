"""Synthetic vault boundaries only; no real keys, tokens, provider or network."""
import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from copy import copy
from datetime import datetime, timedelta, timezone as dt_timezone
import io
import json
import logging
from threading import Event
from unittest import skipUnless
from unittest.mock import Mock, call, patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from injection.models import UserProfile
from quality.archive_access import ARCHIVE_SERVICE_GROUP
from . import vault
from .connection_views import ConnectionRecheck, ConnectionStatus
from .continuity import ContinuityBlocked
from .identity import UserContextResponse, VerifiedUserContext
from .models import MESCredential, MESCredentialEvent, MESLoginSession, MESLoginTicket


TOKEN = 'SYNTHETIC-VAULT-USER-TOKEN-NOT-FOR-DEPLOYMENT'
APP_TOKEN = 'SYNTHETIC-VAULT-APP-TOKEN-NOT-FOR-DEPLOYMENT'
MES_USER = 10_000_000_000_000_003
APP_ID = 10_000_000_000_000_005
LOGIN_SID = 'S' * 43
KEY_ONE = base64.urlsafe_b64encode(b'1' * 32).decode('ascii')
KEY_TWO = base64.urlsafe_b64encode(b'2' * 32).decode('ascii')


def userinfo(user_id=MES_USER, *, status=200, code=200, redirected=False):
    return UserContextResponse(status, {'code': code, 'data': {'userId': user_id}}, redirected)


class VaultFixture:
    def setUp(self):
        super().setUp()
        self.instant = datetime(2026, 10, 4, 12, tzinfo=dt_timezone.utc)
        clock = patch('mes_oauth.vault.timezone.now', return_value=self.instant)
        self.clock = clock.start()
        self.addCleanup(clock.stop)
        self.user = get_user_model().objects.create_user(
            username='SYNTHETIC-VAULT-ACTOR', password='SYNTHETIC-LOCAL-PASSWORD',
            is_superuser=True, is_staff=True)
        self.other = get_user_model().objects.create_user(
            username='SYNTHETIC-VAULT-OTHER', password='SYNTHETIC-LOCAL-PASSWORD',
            is_superuser=True, is_staff=True)
        for actor in (self.user, self.other):
            UserProfile.objects.get_or_create(user=actor)
        configuration = override_settings(
            MES_USER_OAUTH_ENABLED=True, MES_USER_SESSION_BRIDGE_ENABLED=True,
            MES_USER_TOKEN_STORAGE_ENABLED=True,
            MES_USER_OAUTH_CALLBACK_ORIGIN='https://testserver',
            MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
            MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-REVIEWED-PAGE',
            MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-NO-NETWORK-REVIEW',
            MES_USER_OAUTH_APP_ACCESS_TOKEN=APP_TOKEN,
            MES_USER_OAUTH_USER_MAP={str(self.user.pk): str(MES_USER), str(self.other.pk): str(MES_USER + 1)},
            MES_USER_TOKEN_APP_ID=str(APP_ID), MES_USER_TOKEN_TENANT_REFERENCE='SYNTHETIC-TENANT',
            MES_USER_TOKEN_POLICY_REFERENCE='SYNTHETIC-VAULT-POLICY',
            MES_USER_TOKEN_EXPIRY_MODE='relative_seconds',
            MES_USER_TOKEN_CONTRACT_REFERENCE='SYNTHETIC-REVIEWED-EXPIRY',
            MES_USER_TOKEN_MAX_AGE_SECONDS=600, MES_USER_TOKEN_IDLE_SECONDS=180,
            MES_USER_TOKEN_CONSENT_SECONDS=900, MES_USER_TOKEN_SAFETY_SECONDS=30,
            MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': KEY_ONE}),
            MES_USER_TOKEN_ACTIVE_KEY_ID='fixture-v1',
            MES_USER_FRONTEND_ORIGIN='https://testserver', DEBUG=False,
            SESSION_COOKIE_SECURE=True, CSRF_COOKIE_SECURE=True,
            SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
            SESSION_COOKIE_DOMAIN=None, CSRF_COOKIE_DOMAIN=None,
            SESSION_ENGINE='django.contrib.sessions.backends.db')
        configuration.enable()
        self.addCleanup(configuration.disable)
        self.login_digest = vault.digest('client-login', LOGIN_SID)
        self.login = self.make_login(self.user, self.login_digest)
        self.provider = Mock(spec=['userinfo', 'exchange', 'refresh', 'fallback'])
        self.provider.userinfo.return_value = userinfo()
        network = patch('requests.sessions.Session.request', side_effect=AssertionError('No live HTTP.'))
        self.network = network.start()
        self.addCleanup(network.stop)
        self.addCleanup(self.network.assert_not_called)

    def make_login(self, actor, login_digest):
        return MESLoginSession.objects.create(digest=login_digest, actor_id=actor.pk,
            authorization_digest=vault.authorization_digest(actor),
            expires_at=self.instant + timedelta(hours=1))

    def store(self, *, context=None, revision=1):
        return vault.store_context(self.user.pk, self.login_digest,
            context if context is not None else VerifiedUserContext(MES_USER, TOKEN, 1200),
            request_started_at=self.instant - timedelta(seconds=2),
            received_at=self.instant - timedelta(seconds=1), login_revision=revision)

    def row(self):
        return MESCredential.objects.get(pk=self.user.pk)

    def assert_wiped(self):
        row = self.row()
        self.assertEqual(bytes(row.ciphertext), b'')
        self.assertIsNotNone(row.revoked_at)

    def assert_no_provider(self):
        self.assertEqual(self.provider.mock_calls, [])


class VaultStorageTests(VaultFixture, TestCase):
    @override_settings(MES_USER_TOKEN_EXPIRY_MODE='conservative_minimum',
                       MES_USER_TOKEN_CONTRACT_REFERENCE='SYNTHETIC-SECONDS-MINIMUM-POLICY')
    def test_conservative_expiry_stores_earliest_deadline_and_blocks_at_existing_safety_boundary(self):
        deadline = self.instant + timedelta(seconds=120)
        expiry = self.store(context=VerifiedUserContext(MES_USER, TOKEN, int(deadline.timestamp())))
        row = self.row()
        self.assertEqual(row.provider_expires_at, deadline)
        self.assertEqual(expiry, deadline)
        self.assertEqual(row.idle_expires_at, deadline)
        self.assertEqual(vault._open(row), TOKEN)
        self.clock.return_value = deadline - timedelta(seconds=30)
        result = vault.decision(self.user, row, self.login_digest, vault.policy())
        self.assertEqual((result.action, result.reason), ('reauthenticate', 'provider_token_expired'))
        self.assert_no_provider()

    @override_settings(MES_USER_TOKEN_EXPIRY_MODE='conservative_minimum',
                       MES_USER_TOKEN_CONTRACT_REFERENCE='SYNTHETIC-SECONDS-MINIMUM-POLICY')
    def test_conservative_past_unix_interpretation_cannot_store_or_replace_credentials(self):
        with self.assertRaisesRegex(ContinuityBlocked, '^provider_token_expired$'):
            self.store()
        self.assertFalse(MESCredential.objects.exists())
        self.assertFalse(MESCredentialEvent.objects.exists())
        deadline = self.instant + timedelta(seconds=120)
        self.store(context=VerifiedUserContext(MES_USER, TOKEN, int(deadline.timestamp())))
        before = self.row()
        with self.assertRaisesRegex(ContinuityBlocked, '^provider_token_expired$'):
            self.store()
        after = self.row()
        self.assertEqual(after.version, before.version)
        self.assertEqual(bytes(after.ciphertext), bytes(before.ciphertext))
        self.assertEqual(after.provider_expires_at, before.provider_expires_at)
        self.assert_no_provider()

    def test_changing_to_conservative_policy_requires_reconnect_before_any_provider_call(self):
        self.store()
        with override_settings(MES_USER_TOKEN_EXPIRY_MODE='conservative_minimum'):
            result = vault.decision(self.user, self.row(), self.login_digest, vault.policy())
        self.assertEqual((result.action, result.reason), ('reauthenticate', 'review_changed'))
        self.assert_no_provider()

    def test_aes_gcm_roundtrip_persists_only_ciphertext_and_bound_metadata(self):
        expiry = self.store()
        row = self.row()
        self.assertEqual(expiry, self.instant + timedelta(seconds=600))
        self.assertEqual(row.provider_expires_at, self.instant + timedelta(seconds=1198))
        self.assertEqual(row.idle_expires_at, self.instant + timedelta(seconds=180))
        self.assertEqual(row.key_id, 'fixture-v1')
        self.assertGreater(len(bytes(row.ciphertext)), len(TOKEN))
        self.assertNotIn(TOKEN.encode(), bytes(row.ciphertext))
        self.assertNotIn(TOKEN, repr(row.__dict__))
        self.assertEqual(vault._open(row), TOKEN)
        self.assert_no_provider()

    def test_same_token_is_resealed_with_a_new_nonce_and_version(self):
        self.store()
        first = self.row()
        self.store()
        second = self.row()
        self.assertNotEqual(bytes(first.ciphertext)[:12], bytes(second.ciphertext)[:12])
        self.assertNotEqual(bytes(first.ciphertext), bytes(second.ciphertext))
        self.assertEqual(second.version, first.version + 1)
        self.assertEqual(vault._open(second), TOKEN)

    def test_bound_metadata_key_identifier_and_cipher_tampering_are_rejected(self):
        self.store()
        original = self.row()
        mutations = {
            'actor_id': self.other.pk, 'mes_user_id': str(MES_USER + 1),
            'app_id': str(APP_ID + 1), 'tenant_reference': 'SYNTHETIC-OTHER-TENANT',
            'login_digest': '0' * 64, 'authorization_digest': '1' * 64,
            'policy_reference': 'SYNTHETIC-OTHER-POLICY', 'key_id': 'fixture-v2',
            'version': original.version + 1,
            **{name: getattr(original, name) + timedelta(seconds=1) for name in (
                'verified_at', 'expires_at', 'provider_expires_at', 'consent_expires_at',
                'last_used_at', 'idle_expires_at')},
        }
        with override_settings(MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': KEY_ONE, 'fixture-v2': KEY_TWO})):
            for field, value in mutations.items():
                with self.subTest(field=field):
                    changed = copy(original)
                    setattr(changed, field, value)
                    with self.assertRaisesRegex(vault.VaultBlocked, '^credential_unreadable$'):
                        vault._open(changed)
        ciphertext = bytes(original.ciphertext)
        for changed_bytes in (ciphertext[:20], bytes([ciphertext[0] ^ 1]) + ciphertext[1:],
                              ciphertext[:-1] + bytes([ciphertext[-1] ^ 1])):
            changed = copy(original)
            changed.ciphertext = changed_bytes
            with self.assertRaisesRegex(vault.VaultBlocked, '^credential_unreadable$'):
                vault._open(changed)
        self.assert_no_provider()

    def test_wrong_decryption_key_wipes_before_any_provider_dispatch(self):
        self.store()
        with override_settings(MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': KEY_TWO})):
            with self.assertRaisesRegex(vault.VaultBlocked, '^provider_recheck_failed$'):
                vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_wiped()
        self.assert_no_provider()

    def test_ciphertext_tampering_is_revoked_before_provider_dispatch(self):
        self.store()
        MESCredential.objects.filter(pk=self.user.pk).update(ciphertext=b'SYNTHETIC-DAMAGED')
        with self.assertRaisesRegex(vault.VaultBlocked, '^provider_recheck_failed$'):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_wiped()
        self.assert_no_provider()

    def test_each_enable_gate_must_be_explicitly_true(self):
        for flag in ('MES_USER_OAUTH_ENABLED', 'MES_USER_SESSION_BRIDGE_ENABLED', 'MES_USER_TOKEN_STORAGE_ENABLED'):
            for value in (False, None, 1, 'true'):
                with self.subTest(flag=flag, value=value), override_settings(**{flag: value}):
                    with self.assertRaisesRegex(vault.VaultBlocked, '^storage_disabled$'):
                        self.store()
                    with self.assertRaisesRegex(vault.VaultBlocked, '^storage_disabled$'):
                        vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assertFalse(MESCredential.objects.exists())
        self.assertFalse(MESCredentialEvent.objects.exists())
        self.assert_no_provider()

    def test_unknown_expiry_policy_and_invalid_key_configuration_fail_before_storage(self):
        cases = [dict(MES_USER_TOKEN_EXPIRY_MODE=''), dict(MES_USER_TOKEN_CONTRACT_REFERENCE=''),
                 dict(MES_USER_TOKEN_POLICY_REFERENCE=''), dict(MES_USER_TOKEN_MAX_AGE_SECONDS=0),
                 dict(MES_USER_TOKEN_KEYS='{}'), dict(MES_USER_TOKEN_ACTIVE_KEY_ID='missing'),
                 dict(MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': 'not-base64'})),
                 dict(MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': base64.b64encode(b'short').decode()}))]
        for changes in cases:
            with self.subTest(fields=list(changes)), override_settings(**changes):
                with self.assertRaises(vault.VaultBlocked):
                    self.store()
        self.assertFalse(MESCredential.objects.exists())
        self.assert_no_provider()

    def test_missing_malformed_or_expired_provider_expiry_never_gets_a_default(self):
        for value in (None, True, '1200', 1200.0, 0, -1, 1):
            with self.subTest(value=value), self.assertRaises((vault.VaultBlocked, ContinuityBlocked)):
                self.store(context=VerifiedUserContext(MES_USER, TOKEN, value))
        self.assertFalse(MESCredential.objects.exists())
        self.assertFalse(MESCredentialEvent.objects.exists())

    def test_context_identity_and_secret_format_are_verified_before_storage(self):
        for context in (object(), VerifiedUserContext(MES_USER + 1, TOKEN, 1200),
                        VerifiedUserContext(MES_USER, '', 1200),
                        VerifiedUserContext(MES_USER, TOKEN + '\n', 1200)):
            with self.subTest(kind=type(context).__name__), self.assertRaises(vault.VaultBlocked):
                self.store(context=context)
        self.assertFalse(MESCredential.objects.exists())

    def test_rotation_changes_key_and_cipher_without_extending_any_lifetime(self):
        self.store()
        original = self.row()
        self.clock.return_value = self.instant + timedelta(seconds=40)
        with override_settings(MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': KEY_ONE, 'fixture-v2': KEY_TWO}),
                               MES_USER_TOKEN_ACTIVE_KEY_ID='fixture-v2'):
            self.assertTrue(vault.rotate_actor_key(self.user.pk))
            rotated = self.row()
            self.assertEqual(vault._open(rotated), TOKEN)
        self.assertEqual(rotated.key_id, 'fixture-v2')
        self.assertEqual(rotated.version, original.version + 1)
        self.assertNotEqual(bytes(rotated.ciphertext), bytes(original.ciphertext))
        for field in ('verified_at', 'last_used_at', 'expires_at', 'provider_expires_at',
                      'consent_expires_at', 'idle_expires_at', 'login_digest', 'authorization_digest', 'policy_reference'):
            self.assertEqual(getattr(rotated, field), getattr(original, field), field)
        self.assert_no_provider()

    def test_expired_rotation_wipes_and_cannot_resurrect_the_credential(self):
        self.store()
        self.clock.return_value = self.row().idle_expires_at
        self.assertFalse(vault.rotate_actor_key(self.user.pk))
        self.assert_wiped()
        self.assertFalse(vault.rotate_actor_key(self.user.pk))
        self.assert_no_provider()


class VaultLifecycleTests(VaultFixture, TestCase):
    def test_recheck_makes_one_same_token_userinfo_read_without_exchange_refresh_or_fallback(self):
        self.store()
        before = self.row()
        self.clock.return_value = self.instant + timedelta(seconds=60)
        result = vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assertEqual(result, {'identity_verified': True, 'live_ready': False})
        self.assertEqual(self.provider.mock_calls, [call.userinfo(TOKEN)])
        after = self.row()
        self.assertEqual(after.last_used_at, self.instant + timedelta(seconds=60))
        self.assertEqual(after.idle_expires_at, self.instant + timedelta(seconds=240))
        self.assertNotEqual(bytes(after.ciphertext), bytes(before.ciphertext))
        self.assertEqual(vault._open(after), TOKEN)
        for field in ('expires_at', 'provider_expires_at', 'consent_expires_at', 'verified_at'):
            self.assertEqual(getattr(after, field), getattr(before, field), field)
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_status_and_recheck_responses_never_return_ciphertext_or_credentials(self):
        self.store()
        claims = {'mes_sid': LOGIN_SID, 'mes_login_exp': int((self.instant + timedelta(hours=1)).timestamp())}
        factory = APIRequestFactory()
        before = self.row()
        status_request = factory.get('/api/mes-connection/', secure=True)
        force_authenticate(status_request, user=self.user, token=claims)
        status = ConnectionStatus.as_view()(status_request)
        status.render()
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.data['status'], 'connected')
        self.assertEqual(set(status.data), {'enabled', 'status', 'reason', 'expires_at', 'can_connect',
                                           'can_disconnect', 'mode', 'live_ready', 'login_hint'})
        self.assertEqual(self.row().last_used_at, before.last_used_at)
        self.assert_no_provider()
        request = factory.post('/api/mes-connection/recheck/', {}, format='json', secure=True,
                               HTTP_ORIGIN='https://testserver')
        force_authenticate(request, user=self.user, token=claims)
        with patch('mes_oauth.views.get_provider', return_value=self.provider):
            response = ConnectionRecheck.as_view()(request)
        response.render()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {'identity_verified': True, 'live_ready': False})
        for body in (status.content, response.content):
            self.assertNotIn(TOKEN.encode(), body)
            self.assertNotIn(APP_TOKEN.encode(), body)
            self.assertNotIn(b'ciphertext', body)
        self.assertEqual(self.provider.mock_calls, [call.userinfo(TOKEN)])

    def test_account_changes_and_password_changes_prevent_reuse(self):
        for field, value in (('is_active', False), ('is_staff', False), ('is_superuser', False),
                             ('username', 'SYNTHETIC-RENAMED'), ('password', 'SYNTHETIC-CHANGED-HASH')):
            original = getattr(self.user, field)
            self.store()
            try:
                get_user_model().objects.filter(pk=self.user.pk).update(**{field: value})
                with self.subTest(field=field), self.assertRaises(vault.VaultBlocked):
                    vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
                self.assert_no_provider()
            finally:
                get_user_model().objects.filter(pk=self.user.pk).update(**{field: original})

    def test_permission_and_archive_group_changes_prevent_reuse(self):
        self.store()
        permission = Permission.objects.order_by('pk').first()
        self.assertIsNotNone(permission)
        self.user.user_permissions.add(permission)
        with self.assertRaises(vault.VaultBlocked):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.user.user_permissions.clear()
        for name in ('SYNTHETIC-CHANGED-GROUP', ARCHIVE_SERVICE_GROUP):
            group = Group.objects.create(name=name)
            self.user.groups.add(group)
            with self.subTest(group=name), self.assertRaises(vault.VaultBlocked):
                vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
            self.user.groups.remove(group)
        self.assert_no_provider()

    def test_password_reset_and_temporary_password_flags_prevent_reuse(self):
        self.store()
        for field in ('password_reset_required', 'is_using_temp_password'):
            try:
                UserProfile.objects.filter(user=self.user).update(**{field: True})
                with self.subTest(field=field), self.assertRaises(vault.VaultBlocked):
                    vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
            finally:
                UserProfile.objects.filter(user=self.user).update(**{field: False})
        self.assert_no_provider()

    def test_other_actor_or_unknown_local_login_cannot_use_the_stored_token(self):
        self.store()
        other_login = vault.digest('client-login', 'N' * 43)
        self.make_login(self.user, other_login)
        for actor_id, login in ((self.other.pk, self.login_digest), (self.other.pk, other_login),
                                (self.user.pk, '0' * 64), (2**62, self.login_digest)):
            with self.subTest(actor=actor_id, login_match=login == self.login_digest), self.assertRaises(vault.VaultBlocked):
                vault.recheck_identity(actor_id, login, self.provider)
        self.assert_no_provider()

    def test_changed_or_ambiguous_mapping_prevents_provider_dispatch(self):
        self.store()
        for mapping in ({}, {str(self.user.pk): str(MES_USER + 5)},
                        {str(self.user.pk): str(MES_USER), str(self.other.pk): str(MES_USER)}):
            with self.subTest(mapping_size=len(mapping)), override_settings(MES_USER_OAUTH_USER_MAP=mapping):
                with self.assertRaises(vault.VaultBlocked):
                    vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_no_provider()

    def test_changed_policy_tenant_app_or_app_credential_requires_reconnection(self):
        for changes in (dict(MES_USER_TOKEN_POLICY_REFERENCE='SYNTHETIC-REVIEW-CHANGED'),
                        dict(MES_USER_TOKEN_TENANT_REFERENCE='SYNTHETIC-TENANT-CHANGED'),
                        dict(MES_USER_TOKEN_APP_ID=str(APP_ID + 1)),
                        dict(MES_USER_OAUTH_APP_ACCESS_TOKEN=APP_TOKEN + '-ROTATED')):
            self.store()
            with self.subTest(fields=list(changes)), override_settings(**changes):
                with self.assertRaisesRegex(vault.VaultBlocked, '^reuse_unavailable$'):
                    vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
            self.assert_wiped()
        self.assert_no_provider()

    def test_login_expiration_and_revocation_prevent_dispatch(self):
        self.store()
        MESLoginSession.objects.filter(pk=self.login_digest).update(expires_at=self.instant)
        with self.assertRaises(vault.VaultBlocked):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        MESLoginSession.objects.filter(pk=self.login_digest).update(
            expires_at=self.instant + timedelta(hours=1), revoked_at=self.instant)
        with self.assertRaises(vault.VaultBlocked):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_no_provider()

    def test_idle_safety_deadline_stops_reuse_and_wipes_ciphertext(self):
        self.store()
        self.clock.return_value = self.instant + timedelta(seconds=150)
        with self.assertRaisesRegex(vault.VaultBlocked, '^reuse_unavailable$'):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_wiped()
        self.assert_no_provider()

    def test_expiry_during_provider_read_does_not_report_success_or_extend_lifetime(self):
        self.store(context=VerifiedUserContext(MES_USER, TOKEN, 100))
        before = self.row()
        def expire_during_read(token):
            self.clock.return_value = self.instant + timedelta(seconds=70)
            return userinfo()
        self.provider.userinfo.side_effect = expire_during_read
        with self.assertRaisesRegex(vault.VaultBlocked, '^provider_recheck_failed$'):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_wiped()
        self.assertEqual(self.row().expires_at, before.expires_at)
        self.assertEqual(self.provider.mock_calls, [call.userinfo(TOKEN)])

    def test_rejected_or_mismatched_provider_read_wipes_without_retry_or_secret_logging(self):
        failures = [userinfo(status=401), userinfo(code=401), userinfo(MES_USER + 1)]
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        logger = logging.getLogger()
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        for failure in failures:
            self.store()
            self.provider.reset_mock()
            self.provider.userinfo.side_effect = failure if isinstance(failure, Exception) else None
            self.provider.userinfo.return_value = failure
            with self.subTest(kind=type(failure).__name__):
                with self.assertRaisesRegex(vault.VaultBlocked, '^provider_recheck_failed$') as raised:
                    vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
                self.assertNotIn(TOKEN, str(raised.exception))
                self.assert_wiped()
                self.assertEqual(self.provider.mock_calls, [call.userinfo(TOKEN)])
        self.assertNotIn(TOKEN, output.getvalue())
        self.assertEqual(set(MESCredentialEvent.objects.values_list('reason', flat=True)),
                         {'identity_verified', 'provider_recheck_failed'})

    def test_unavailable_provider_preserves_credential_and_never_extends_expiry(self):
        failures = [RuntimeError(TOKEN), userinfo(status=403), userinfo(status=500),
                    userinfo(redirected=True), userinfo(code=3401), userinfo(code=403),
                    userinfo(str(MES_USER)), userinfo(True),
                    UserContextResponse(200, {'code': 200, 'data': None}, False)]
        for failure in failures:
            with self.subTest(kind=type(failure).__name__):
                self.store()
                before=self.row()
                self.provider.reset_mock()
                self.provider.userinfo.side_effect = failure if isinstance(failure,Exception) else None
                self.provider.userinfo.return_value = failure
                with self.assertRaisesRegex(vault.VaultBlocked,'^provider_temporarily_unavailable$'):
                    vault.recheck_identity(self.user.pk,self.login_digest,self.provider)
                self.assertEqual(bytes(self.row().ciphertext),bytes(before.ciphertext))
                self.assertEqual(self.row().idle_expires_at,before.idle_expires_at)
                self.assertEqual(self.row().expires_at,before.expires_at)
                self.assertIsNone(self.row().revoked_at)
                self.provider.userinfo.assert_called_once_with(TOKEN)

    def test_recheck_api_distinguishes_service_failure_from_reconnection(self):
        from .app_tokens import AppCredentialUnavailable
        for kind in ('app_supply','server_error','auth_rejected'):
            with self.subTest(kind=kind):
                self.store()
                self.provider.reset_mock()
                self.provider.userinfo.return_value=userinfo(status=401 if kind=='auth_rejected' else 500)
                request=APIRequestFactory().post('/api/mes-connection/recheck/',{},format='json',
                    secure=True,HTTP_ORIGIN='https://testserver')
                claims={'mes_sid':LOGIN_SID,'mes_login_exp':int((self.instant+timedelta(hours=1)).timestamp())}
                force_authenticate(request,user=self.user,token=claims)
                with patch('mes_oauth.views.get_provider',return_value=self.provider,
                        side_effect=AppCredentialUnavailable('app_credential_unavailable') if kind=='app_supply' else None):
                    response=ConnectionRecheck.as_view()(request)
                self.assertEqual(response.status_code,409 if kind=='auth_rejected' else 503)
                self.assertEqual(response.data['detail'],'reconnect_required' if kind=='auth_rejected'
                                 else 'mes_connection_temporarily_unavailable')
                self.assertEqual(bool(self.row().ciphertext),kind!='auth_rejected')
                self.assertNotIn(TOKEN,str(response.data))

    def test_disconnect_wipes_consumes_tickets_and_blocks_late_callback_revision(self):
        self.store()
        ticket = MESLoginTicket.objects.create(digest='f' * 64, actor_id=self.user.pk,
            login_digest=self.login_digest, authorization_digest=self.login.authorization_digest,
            login_revision=1, expires_at=self.instant + timedelta(seconds=60))
        vault.revoke_actor(self.user.pk, login_digest=self.login_digest, revoke_login=False)
        self.assert_wiped()
        self.login.refresh_from_db()
        ticket.refresh_from_db()
        self.assertIsNone(self.login.revoked_at)
        self.assertEqual(self.login.revision, 2)
        self.assertIsNotNone(ticket.consumed_at)
        with self.assertRaisesRegex(vault.VaultBlocked, '^login_unavailable$'):
            self.store(revision=1)
        self.assert_wiped()
        self.store(revision=2)
        self.assertIsNone(self.row().revoked_at)
        self.assert_no_provider()

    def test_logout_revokes_login_and_prevents_reuse_or_late_storage_even_when_disabled(self):
        self.store()
        with override_settings(MES_USER_OAUTH_ENABLED=False, MES_USER_TOKEN_KEYS=''):
            vault.revoke_actor(self.user.pk, login_digest=self.login_digest, reason='logout')
        self.assertEqual(vault._open(self.row()), TOKEN)
        self.login.refresh_from_db()
        self.assertIsNotNone(self.login.revoked_at)
        with self.assertRaises(vault.VaultBlocked):
            self.store()
        with self.assertRaises(vault.VaultBlocked):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        count = MESCredentialEvent.objects.count()
        vault.revoke_actor(self.user.pk, login_digest=self.login_digest, reason='logout')
        self.assertEqual(MESCredentialEvent.objects.count(), count)
        self.assert_no_provider()

    def test_other_login_logout_cannot_wipe_current_login_credential(self):
        self.store()
        other_digest = vault.digest('client-login', 'N' * 43)
        self.make_login(self.user, other_digest)
        vault.revoke_actor(self.user.pk, login_digest=other_digest, reason='logout')
        self.assertIsNone(self.row().revoked_at)
        self.assertEqual(vault._open(self.row()), TOKEN)
        self.login.refresh_from_db()
        self.assertIsNone(self.login.revoked_at)

    def test_purge_is_dry_by_default_and_explicit_application_only_wipes_expired_rows(self):
        self.store()
        self.clock.return_value = self.instant + timedelta(seconds=180)
        before = bytes(self.row().ciphertext)
        count = MESCredentialEvent.objects.count()
        self.assertEqual(vault.purge_expired(), 1)
        self.assertEqual(bytes(self.row().ciphertext), before)
        self.assertEqual(MESCredentialEvent.objects.count(), count)
        self.assertEqual(vault.purge_expired(apply=True), 1)
        self.assert_wiped()
        self.assertEqual(vault.purge_expired(apply=True), 0)
        self.assert_no_provider()

    def test_audit_schema_and_generated_events_have_fixed_metadata_only(self):
        self.store()
        vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        vault.rotate_actor_key(self.user.pk)
        vault.revoke_actor(self.user.pk, reason='disconnected', revoke_login=False)
        self.assertEqual({field.name for field in MESCredentialEvent._meta.fields},
                         {'id', 'actor_id', 'action', 'reason', 'created_at'})
        events = list(MESCredentialEvent.objects.order_by('pk').values('actor_id', 'action', 'reason'))
        self.assertEqual([(row['action'], row['reason']) for row in events], [
            ('connected', 'identity_verified'), ('identity_read', 'identity_verified'),
            ('key_rotated', 'maintenance'), ('revoked', 'disconnected')])
        self.assertTrue(all(row['actor_id'] == self.user.pk for row in events))
        self.assertNotIn(TOKEN, json.dumps(events))
        self.assertNotIn(APP_TOKEN, json.dumps(events))


@skipUnless(connection.vendor == 'postgresql', 'Vault dispatch/revocation locking requires PostgreSQL.')
class VaultConcurrencyTests(VaultFixture, TransactionTestCase):
    def worker(self, operation):
        connections.close_all()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '10000ms'")
                cursor.execute("SET lock_timeout = '5000ms'")
            try:
                return operation()
            except vault.VaultBlocked as error:
                return str(error)
        finally:
            connections.close_all()

    def test_revoke_waits_for_inflight_userinfo_then_no_later_dispatch_occurs(self):
        self.store()
        entered, release, revoking = Event(), Event(), Event()
        def read(token):
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic provider release timed out.')
            return userinfo()
        def revoke():
            revoking.set()
            vault.revoke_actor(self.user.pk, login_digest=self.login_digest, reason='logout')
        self.provider.userinfo.side_effect = read
        with ThreadPoolExecutor(max_workers=2) as pool:
            checking = pool.submit(self.worker, lambda: vault.recheck_identity(
                self.user.pk, self.login_digest, self.provider))
            try:
                self.assertTrue(entered.wait(5))
                revocation = pool.submit(self.worker, revoke)
                self.assertTrue(revoking.wait(5))
                with self.assertRaises(TimeoutError):
                    revocation.result(timeout=0.2)
            finally:
                release.set()
            self.assertEqual(checking.result(timeout=10), {'identity_verified': True, 'live_ready': False})
            self.assertIsNone(revocation.result(timeout=10))
        self.assertEqual(vault._open(self.row()), TOKEN)
        with self.assertRaises(vault.VaultBlocked):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assertEqual(self.provider.mock_calls, [call.userinfo(TOKEN)])

    def test_revoke_lock_wins_before_userinfo_so_waiting_recheck_never_dispatches(self):
        self.store()
        entered, release, checking_started = Event(), Event(), Event()
        def paused_logout():
            with transaction.atomic():
                vault.revoke_actor(self.user.pk, login_digest=self.login_digest, reason='logout')
                entered.set()
                if not release.wait(5):
                    raise AssertionError('Synthetic revocation release timed out.')
        def check():
            checking_started.set()
            return vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        with ThreadPoolExecutor(max_workers=2) as pool:
            revocation = pool.submit(self.worker, paused_logout)
            try:
                self.assertTrue(entered.wait(5))
                checking = pool.submit(self.worker, check)
                self.assertTrue(checking_started.wait(5))
                with self.assertRaises(TimeoutError):
                    checking.result(timeout=0.2)
                self.assert_no_provider()
            finally:
                release.set()
            self.assertIsNone(revocation.result(timeout=10))
            self.assertEqual(checking.result(timeout=10), 'login_unavailable')
        self.assertEqual(vault._open(self.row()), TOKEN)
        self.assert_no_provider()


class ActorCredentialContinuityTests(VaultFixture, TestCase):
    def test_same_actor_new_login_reuses_original_encrypted_provenance_after_logout(self):
        self.store()
        original = self.row()
        next_digest = vault.digest('client-login', 'N' * 43)
        next_login = self.make_login(self.user, next_digest)
        vault.revoke_actor(self.user.pk, login_digest=self.login_digest, reason='logout')
        self.assertEqual(bytes(self.row().ciphertext), bytes(original.ciphertext))
        with self.assertRaisesRegex(vault.VaultBlocked, '^login_unavailable$'):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_no_provider()
        self.assertEqual(vault.recheck_identity(self.user.pk, next_digest, self.provider),
                         {'identity_verified': True, 'live_ready': False})
        row = self.row()
        self.assertEqual(row.login_digest, self.login_digest)
        self.assertEqual(row.verified_at, original.verified_at)
        self.assertEqual(row.expires_at, original.expires_at)
        self.assertEqual(vault._open(row), TOKEN)
        next_login.refresh_from_db()
        self.assertIsNone(next_login.revoked_at)
        self.provider.userinfo.assert_called_once_with(TOKEN)

    def test_unscoped_logout_preserves_all_logins_and_credential(self):
        self.store()
        self.make_login(self.user, vault.digest('client-login', 'N' * 43))
        original = bytes(self.row().ciphertext)
        vault.revoke_actor(self.user.pk, reason='logout')
        self.assertEqual(bytes(self.row().ciphertext), original)
        self.assertFalse(MESLoginSession.objects.filter(revoked_at__isnull=False).exists())
        self.assertEqual(MESLoginSession.objects.filter(actor_id=self.user.pk).count(), 2)
        self.assert_no_provider()

    def test_explicit_disconnect_from_new_login_clears_actor_credential(self):
        self.store()
        next_digest = vault.digest('client-login', 'N' * 43)
        self.make_login(self.user, next_digest)
        vault.revoke_actor(self.user.pk, login_digest=next_digest, revoke_login=False)
        self.assert_wiped()
        with self.assertRaisesRegex(vault.VaultBlocked, '^reuse_unavailable$'):
            vault.recheck_identity(self.user.pk, self.login_digest, self.provider)
        self.assert_no_provider()

    @override_settings(MES_USER_TOKEN_MAX_AGE_SECONDS=86400,
                       MES_USER_TOKEN_IDLE_SECONDS=86400,
                       MES_USER_TOKEN_CONSENT_SECONDS=86400)
    def test_new_login_cannot_extend_24_hour_deadline_or_safety_margin(self):
        self.store(context=VerifiedUserContext(MES_USER, TOKEN, 172800))
        deadline = self.row().expires_at
        self.assertEqual(deadline, self.instant + timedelta(hours=24))
        next_digest = vault.digest('client-login', 'N' * 43)
        self.clock.return_value = deadline - timedelta(seconds=31)
        MESLoginSession.objects.create(digest=next_digest, actor_id=self.user.pk,
            authorization_digest=vault.authorization_digest(self.user),
            expires_at=deadline + timedelta(hours=1))
        vault.recheck_identity(self.user.pk, next_digest, self.provider)
        self.assertEqual(self.row().expires_at, deadline)
        self.clock.return_value = deadline - timedelta(seconds=30)
        with self.assertRaisesRegex(vault.VaultBlocked, '^reuse_unavailable$'):
            vault.recheck_identity(self.user.pk, next_digest, self.provider)
        self.provider.userinfo.assert_called_once_with(TOKEN)


    def test_disconnect_invalidates_other_login_callbacks_without_ending_wj_sessions(self):
        self.store()
        next_login = self.make_login(self.user, vault.digest('client-login', 'N' * 43))
        unrelated = self.make_login(self.other, vault.digest('client-login', 'O' * 43))
        other_token = TOKEN + '-OTHER-ACTOR'
        vault.store_context(self.other.pk, unrelated.pk,
            VerifiedUserContext(MES_USER + 1, other_token, 1200),
            request_started_at=self.instant - timedelta(seconds=2),
            received_at=self.instant - timedelta(seconds=1), login_revision=1)
        other_before = MESCredential.objects.get(pk=self.other.pk)
        tickets = []
        for index, login in enumerate((self.login, next_login, unrelated)):
            tickets.append(MESLoginTicket.objects.create(digest=str(index) * 64,
                actor_id=login.actor_id, login_digest=login.pk,
                authorization_digest=login.authorization_digest, login_revision=1,
                expires_at=self.instant + timedelta(seconds=60)))

        vault.revoke_actor(self.user.pk, login_digest=next_login.pk,
                           reason='disconnected', revoke_login=False)
        self.assert_wiped()
        for login, ticket in zip((self.login, next_login), tickets[:2]):
            login.refresh_from_db()
            ticket.refresh_from_db()
            self.assertEqual(login.revision, 2)
            self.assertIsNone(login.revoked_at)
            self.assertIsNotNone(ticket.consumed_at)
            self.assertEqual(vault._login(self.user, login.pk).pk, login.pk)
            with self.assertRaisesRegex(vault.VaultBlocked, '^login_unavailable$'):
                vault.store_context(self.user.pk, login.pk,
                    VerifiedUserContext(MES_USER, TOKEN, 1200),
                    request_started_at=self.instant - timedelta(seconds=2),
                    received_at=self.instant - timedelta(seconds=1), login_revision=1)
            self.assert_wiped()

        unrelated.refresh_from_db()
        tickets[2].refresh_from_db()
        other_after = MESCredential.objects.get(pk=self.other.pk)
        self.assertEqual(unrelated.revision, 1)
        self.assertIsNone(unrelated.revoked_at)
        self.assertIsNone(tickets[2].consumed_at)
        self.assertEqual(bytes(other_after.ciphertext), bytes(other_before.ciphertext))
        self.assertEqual(vault._open(other_after), other_token)
        # A fresh launch captures the new revision and can reconnect normally.
        self.store(revision=self.login.revision)
        self.assertEqual(vault._open(self.row()), TOKEN)
        self.assertIsNone(self.row().revoked_at)
        self.assert_no_provider()
