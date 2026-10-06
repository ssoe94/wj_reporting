"""Synthetic inspection credential leases; no real token, provider or network."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import contextmanager
from datetime import timedelta
import io
import json
import logging
from threading import Event
from time import monotonic, sleep
import traceback
from unittest import skipUnless
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework_simplejwt.tokens import AccessToken

from quality.inspection_transport import InspectionUserAccessToken, InspectionWriteAcknowledgement
from . import vault
from .inspection_credentials import call_with_user_credential, CALLBACK, IDENTITY, POLICY, TEMPORARY, UNAVAILABLE
from .models import MESCredential, MESCredentialEvent, MESLoginSession
from .session_guard import InspectionSession
from .test_vault import VaultFixture, TOKEN, APP_TOKEN, MES_USER, LOGIN_SID, KEY_ONE, KEY_TWO, userinfo


class CredentialFixture(VaultFixture):
    def setUp(self):
        super().setUp()
        self.gates = override_settings(MES_INSPECTION_ENABLED=True,
            INSPECTION_PILOT_ENABLED=False, INSPECTION_PILOT_USER_IDS=[])
        self.gates.enable()
        self.addCleanup(self.gates.disable)
        self.policy_check = Mock(return_value=True)
        self.callback = Mock(return_value={'synthetic': True})
        self.store()

    def session(self):
        token = AccessToken.for_user(self.user)
        token['mes_sid'] = LOGIN_SID
        token['mes_login_exp'] = int(self.login.expires_at.timestamp())
        return InspectionSession.from_token(self.user, token)

    def invoke(self, **changes):
        options = dict(mes_user_id=MES_USER, tenant='SYNTHETIC-TENANT',
            contract_reference='SYNTHETIC-SINGLE-INSPECTION-REVIEW',
            policy_check=self.policy_check, operation='read', callback=self.callback, provider=self.provider)
        options.update(changes)
        return call_with_user_credential(options.pop('session', self.session()), **options)

    def assert_blocked(self, reason, **changes):
        with self.assertRaises(vault.VaultBlocked) as caught:
            self.invoke(**changes)
        self.assertEqual(str(caught.exception), reason)
        self.assertNotIn(TOKEN, str(caught.exception))


class InspectionCredentialTests(CredentialFixture, TestCase):
    def test_app_supply_failure_preserves_user_credential_and_never_dispatches(self):
        from .app_tokens import AppCredentialUnavailable
        from .inspection_credentials import APP_CREDENTIAL
        original = bytes(self.row().ciphertext)
        with patch('mes_oauth.inspection_credentials.get_app_access_token',
                   side_effect=AppCredentialUnavailable('app_credential_unavailable')):
            self.assert_blocked(APP_CREDENTIAL, provider=None)
        self.assertEqual(bytes(self.row().ciphertext), original)
        self.assert_no_provider()
        self.callback.assert_not_called()

    def test_each_operation_verifies_same_token_once_then_invokes_one_typed_callback(self):
        for operation in ('read', 'save', 'finish'):
            with self.subTest(operation=operation):
                self.provider.reset_mock()
                self.callback.reset_mock()
                self.policy_check.reset_mock()
                result = self.invoke(operation=operation)
                self.assertEqual(result, {'synthetic': True})
                self.assertEqual(self.policy_check.call_count, 3)
                self.assertEqual(self.provider.userinfo.call_count, 1)
                self.assertTrue(self.provider.userinfo.call_args.args == (TOKEN,))
                self.assertEqual(self.callback.call_count, 1)
                lease = self.callback.call_args.args[0]
                self.assertIs(type(lease), InspectionUserAccessToken)
                self.assertTrue(lease.value == TOKEN)
                self.assertEqual(lease.user_id, MES_USER)
                self.assertEqual(lease.expires_at, self.row().idle_expires_at.timestamp())
                self.assertNotIn(TOKEN, repr(lease))
                for prohibited in ('exchange', 'refresh', 'fallback'):
                    getattr(self.provider, prohibited).assert_not_called()
                event = MESCredentialEvent.objects.latest('id')
                self.assertEqual((event.action, event.reason), (operation, 'inspection_identity_verified'))
        self.assertEqual(vault.policy().reuse.allowed_operations, frozenset({'identity_read'}))

    def test_acknowledgement_is_supported_without_claiming_completion(self):
        self.callback.return_value = InspectionWriteAcknowledgement(1)
        result = self.invoke(operation='save')
        self.assertEqual(result.accepted_stages, 1)
        self.assertFalse(result.completion_confirmed)

    def test_invalid_context_and_unsupported_operations_never_dispatch(self):
        for changes in ({'session': object()}, {'mes_user_id': True}, {'mes_user_id': str(MES_USER)},
                {'mes_user_id': 0}, {'tenant': ''}, {'contract_reference': ''},
                {'operation': 'sync'}, {'operation': 'refresh'}, {'operation': 'exchange'},
                {'callback': None}, {'policy_check': None}):
            with self.subTest(fields=list(changes)):
                self.assert_blocked(POLICY, **changes)
        self.assert_no_provider()
        self.callback.assert_not_called()

    def test_explicit_enabled_gate_is_strict_and_checked_before_network(self):
        for flag in (False, None, 1, 'true'):
            with self.subTest(flag=flag), override_settings(MES_INSPECTION_ENABLED=flag):
                self.assert_blocked(POLICY)
        self.assert_no_provider()
        self.callback.assert_not_called()

    def test_unreviewed_vault_contract_never_dispatches(self):
        with override_settings(MES_USER_TOKEN_EXPIRY_MODE=''):
            self.assert_blocked(UNAVAILABLE)
        self.assert_no_provider()
        self.callback.assert_not_called()

    def test_each_policy_checkpoint_must_return_exact_true(self):
        for point in range(3):
            for rejected in (False, None, 1, 'true'):
                with self.subTest(point=point, rejected=rejected):
                    self.provider.reset_mock()
                    self.policy_check.side_effect = [True] * point + [rejected]
                    self.assert_blocked(POLICY)
                    self.assertEqual(self.provider.userinfo.call_count, int(point > 0))
                    self.callback.assert_not_called()

    def test_policy_exception_text_is_hidden(self):
        self.policy_check.side_effect = RuntimeError(TOKEN)
        self.assert_blocked(POLICY)
        self.assert_no_provider()

    def test_configuration_change_during_identity_check_blocks_callback(self):
        def changed(token):
            self.gates_changed = override_settings(MES_USER_TOKEN_POLICY_REFERENCE='SYNTHETIC-CHANGED')
            self.gates_changed.enable()
            self.addCleanup(self.gates_changed.disable)
            return userinfo()
        self.provider.userinfo.side_effect = changed
        self.assert_blocked(POLICY)
        self.callback.assert_not_called()

    def test_enabled_gate_is_rechecked_after_identity(self):
        def changed(token):
            self.changed = override_settings(MES_INSPECTION_ENABLED=False)
            self.changed.enable()
            self.addCleanup(self.changed.disable)
            return userinfo()
        self.provider.userinfo.side_effect = changed
        self.assert_blocked(POLICY)
        self.callback.assert_not_called()

    def test_tenant_mapping_and_different_login_cannot_borrow_a_credential(self):
        before = bytes(self.row().ciphertext)
        self.assert_blocked(POLICY, tenant='SYNTHETIC-OTHER-TENANT')
        self.assert_blocked(UNAVAILABLE, mes_user_id=MES_USER + 1)
        session = self.session()
        session.login_digest = vault.digest('client-login', 'D' * 43)
        self.assert_blocked(UNAVAILABLE, session=session)
        self.assertTrue(bytes(self.row().ciphertext) == before)
        self.assert_no_provider()
        self.callback.assert_not_called()

    def test_missing_credential_and_revoked_login_never_dispatch(self):
        self.login.revoked_at = self.instant
        self.login.save(update_fields=['revoked_at'])
        self.assert_blocked(UNAVAILABLE)
        self.login.revoked_at = None
        self.login.save(update_fields=['revoked_at'])
        MESCredential.objects.all().delete()
        self.assert_blocked(UNAVAILABLE)
        self.assert_no_provider()

    def test_metadata_expiry_is_checked_before_decrypt_or_network(self):
        self.clock.return_value = self.instant + timedelta(seconds=151)
        with patch('mes_oauth.vault._open') as decrypt:
            self.assert_blocked(UNAVAILABLE)
        decrypt.assert_not_called()
        self.assert_no_provider()

    def test_expiry_during_identity_check_blocks_callback(self):
        def expired(token):
            self.clock.return_value = self.instant + timedelta(seconds=151)
            return userinfo()
        self.provider.userinfo.side_effect = expired
        self.assert_blocked(UNAVAILABLE)
        self.assertEqual(self.provider.userinfo.call_count, 1)
        self.callback.assert_not_called()

    def test_explicit_authentication_rejection_or_different_identity_wipes_without_callback(self):
        cases = [userinfo(MES_USER + 1), userinfo(status=401), userinfo(code=401)]
        for response in cases:
            with self.subTest(response_type=type(response).__name__):
                self.store()
                self.provider.reset_mock()
                self.provider.userinfo.return_value = response
                self.assert_blocked(IDENTITY)
                self.assert_wiped()
                self.assertEqual(self.provider.userinfo.call_count, 1)
        self.callback.assert_not_called()

    def test_unavailable_or_malformed_identity_preserves_credential_without_callback(self):
        cases = [userinfo(str(MES_USER)), userinfo(True), userinfo(status=403),
                 userinfo(status=500), userinfo(code=3401), userinfo(code=True),
                 userinfo(redirected=True), object()]
        for response in cases:
            with self.subTest(response_type=type(response).__name__):
                self.store()
                before = self.row()
                self.provider.reset_mock()
                self.provider.userinfo.return_value = response
                self.assert_blocked(TEMPORARY)
                self.assertEqual(bytes(self.row().ciphertext), bytes(before.ciphertext))
                self.assertEqual(self.row().idle_expires_at, before.idle_expires_at)
                self.assertIsNone(self.row().revoked_at)
                self.assertEqual(self.provider.userinfo.call_count, 1)
        self.callback.assert_not_called()

    def test_decrypt_failure_wipes_before_identity_dispatch(self):
        with override_settings(MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': KEY_TWO})):
            self.assert_blocked(IDENTITY)
        self.assert_wiped()
        self.assert_no_provider()
        self.callback.assert_not_called()

    def test_provider_exception_has_no_secret_in_logs_or_visible_traceback(self):
        before = bytes(self.row().ciphertext)
        self.provider.userinfo.side_effect = RuntimeError(TOKEN + APP_TOKEN)
        captured = io.StringIO()
        handler = logging.StreamHandler(captured)
        logger = logging.getLogger()
        logger.addHandler(handler)
        try:
            try:
                self.invoke()
            except vault.VaultBlocked as error:
                visible = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
            else:
                self.fail('Expected fixed rejection.')
        finally:
            logger.removeHandler(handler)
        self.assertNotIn(TOKEN, visible + captured.getvalue())
        self.assertNotIn(APP_TOKEN, visible + captured.getvalue())
        self.assertEqual(bytes(self.row().ciphertext), before)
        self.callback.assert_not_called()

    def test_callback_failure_is_sanitized_never_retried_and_does_not_extend_idle(self):
        before = self.row()
        self.clock.return_value = self.instant + timedelta(seconds=10)
        self.callback.side_effect = RuntimeError(TOKEN)
        self.assert_blocked(CALLBACK, operation='save')
        self.assertEqual(self.callback.call_count, 1)
        self.assertEqual(self.provider.userinfo.call_count, 1)
        self.assertEqual(self.row().last_used_at, before.last_used_at)
        self.assertTrue(bytes(self.row().ciphertext) == bytes(before.ciphertext))

    def test_session_exit_failure_after_callback_stays_unknown_not_safe_to_retry(self):
        original, calls = InspectionSession.lock, 0
        @contextmanager
        def broken_exit(session, *args, **kwargs):
            nonlocal calls
            calls += 1
            outer = calls == 1
            with original(session, *args, **kwargs) as user:
                yield user
                if outer:
                    raise RuntimeError(TOKEN)
        with patch.object(InspectionSession, 'lock', broken_exit):
            self.assert_blocked(CALLBACK, operation='save')
        self.assertEqual(self.callback.call_count, 1)
        self.assertEqual(self.provider.userinfo.call_count, 1)

    def test_callback_cannot_return_plain_or_nested_credentials(self):
        for result in (TOKEN, {'raw': TOKEN}, {'nested': [TOKEN]}, {TOKEN: True}, object(),
                       {'token': InspectionUserAccessToken(TOKEN, 1.0, user_id=MES_USER)}):
            with self.subTest(result_type=type(result).__name__):
                self.callback.return_value = result
                self.assert_blocked(CALLBACK)

    def test_success_reseals_with_active_key_and_updates_idle_without_extending_absolute(self):
        before = self.row()
        self.clock.return_value = self.instant + timedelta(seconds=10)
        with override_settings(MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': KEY_ONE, 'fixture-v2': KEY_TWO}),
                               MES_USER_TOKEN_ACTIVE_KEY_ID='fixture-v2'):
            self.invoke()
            after = self.row()
            self.assertTrue(vault._open(after) == TOKEN)
        for field in ('verified_at', 'expires_at', 'provider_expires_at', 'consent_expires_at', 'version'):
            self.assertEqual(getattr(after, field), getattr(before, field))
        self.assertEqual(after.last_used_at, self.instant + timedelta(seconds=10))
        self.assertEqual(after.idle_expires_at, self.instant + timedelta(seconds=190))
        self.assertEqual(after.key_id, 'fixture-v2')
        self.assertTrue(bytes(after.ciphertext) != bytes(before.ciphertext))

    def test_actor_deactivation_during_identity_blocks_callback(self):
        def changed(token):
            get_user_model().objects.filter(pk=self.user.pk).update(is_active=False)
            return userinfo()
        self.provider.userinfo.side_effect = changed
        self.assert_blocked(UNAVAILABLE)
        self.callback.assert_not_called()

    def test_default_provider_uses_configured_client_without_exchange_or_fallback(self):
        with patch('mes_oauth.inspection_credentials.BlacklakeUserOAuthClient', return_value=self.provider) as factory:
            self.invoke(provider=None)
        self.assertEqual(factory.call_count, 1)
        self.assertEqual(factory.call_args.kwargs['origin'], 'https://v3-ali.blacklake.cn')
        self.assertTrue(factory.call_args.kwargs['app_access_token'] == APP_TOKEN)
        self.provider.exchange.assert_not_called()
        self.provider.refresh.assert_not_called()
        self.provider.fallback.assert_not_called()


@skipUnless(connection.vendor == 'postgresql', 'Requires isolated PostgreSQL row locks.')
class InspectionCredentialPostgresTests(CredentialFixture, TransactionTestCase):
    def worker(self, callback, started=None, backend_pid=None):
        connections.close_all()
        try:
            if started is not None:
                with connection.cursor() as cursor:
                    cursor.execute('SELECT pg_backend_pid()')
                    backend_pid.append(cursor.fetchone()[0])
                started.set()
            return callback()
        finally:
            connections.close_all()

    def wait_for_database_lock(self, started, backend_pid):
        self.assertTrue(started.wait(5))
        deadline = monotonic() + 3
        while monotonic() < deadline:
            with connection.cursor() as cursor:
                cursor.execute('SELECT cardinality(pg_blocking_pids(%s))', [backend_pid[0]])
                if cursor.fetchone()[0] > 0:
                    return
            sleep(0.01)
        self.fail('Synthetic worker did not enter a PostgreSQL lock wait.')

    def test_identity_failure_wipe_commits_before_fixed_exception(self):
        self.provider.userinfo.return_value = userinfo(status=401)
        self.assert_blocked(IDENTITY)
        self.assertFalse(connection.in_atomic_block)
        self.assert_wiped()

    def test_outer_dispatch_must_catch_failure_and_commit_wipe(self):
        self.provider.userinfo.return_value = userinfo(status=401)
        with transaction.atomic():
            self.assert_blocked(IDENTITY)
        self.assert_wiped()

    def test_logout_waits_for_inflight_userinfo_and_callback_then_blocks_next_call(self):
        entered, release = Event(), Event()
        revoke_started, revoke_pid = Event(), []
        def paused(token):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('Synthetic fixture timed out.')
            return userinfo()
        self.provider.userinfo.side_effect = paused
        with ThreadPoolExecutor(max_workers=2) as pool:
            active = pool.submit(self.worker, self.invoke)
            try:
                self.assertTrue(entered.wait(5))
                revoke = pool.submit(self.worker, lambda: vault.revoke_actor(self.user.pk,
                    login_digest=self.login_digest, reason='logout'), revoke_started, revoke_pid)
                self.wait_for_database_lock(revoke_started, revoke_pid)
                with self.assertRaises(TimeoutError):
                    revoke.result(timeout=0.2)
            finally:
                release.set()
            self.assertEqual(active.result(timeout=5), {'synthetic': True})
            revoke.result(timeout=5)
        self.assertEqual(self.callback.call_count, 1)
        self.assert_wiped()
        self.assert_blocked(UNAVAILABLE)
        self.assertEqual(self.provider.userinfo.call_count, 1)

    def test_logout_lock_wins_and_waiting_broker_never_dispatches(self):
        entered, release = Event(), Event()
        broker_started, broker_pid = Event(), []
        original = vault._clear
        def paused_clear(row, reason):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('Synthetic fixture timed out.')
            return original(row, reason)
        with patch('mes_oauth.vault._clear', side_effect=paused_clear), ThreadPoolExecutor(max_workers=2) as pool:
            revoke = pool.submit(self.worker, lambda: vault.revoke_actor(self.user.pk,
                login_digest=self.login_digest, reason='logout'))
            try:
                self.assertTrue(entered.wait(5))
                blocked = pool.submit(self.worker, lambda: self.assert_blocked(UNAVAILABLE), broker_started, broker_pid)
                self.wait_for_database_lock(broker_started, broker_pid)
                with self.assertRaises(TimeoutError):
                    blocked.result(timeout=0.2)
            finally:
                release.set()
            revoke.result(timeout=5)
            blocked.result(timeout=5)
        self.assert_no_provider()
        self.callback.assert_not_called()
        self.assert_wiped()
