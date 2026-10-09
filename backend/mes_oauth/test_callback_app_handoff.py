"""Synthetic callback supply handoff; isolated runner forbids provider egress."""
from contextvars import copy_context
from datetime import timedelta
import json
import os
from unittest.mock import Mock, patch

from uuid import UUID

from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from . import app_tokens, callback_app_tokens


@override_settings(
    MES_USER_OAUTH_ENABLED=True, MES_USER_OAUTH_APP_TOKEN_SOURCE='server',
    MES_USER_OAUTH_PROVIDER_ORIGIN=app_tokens.ALI,
    MES_USER_OAUTH_APP_CREDENTIAL_SOURCE='dedicated',
    MES_USER_OAUTH_APP_KEY='SYNTHETIC-KEY', MES_USER_OAUTH_APP_SECRET='SYNTHETIC-SECRET',
    MES_USER_OAUTH_APP_ID='91000000000000009', MES_USER_TOKEN_APP_ID='91000000000000009',
    MES_USER_OAUTH_APP_TOKEN_HEADER='access_token', MES_USER_OAUTH_CONTROL_QC_ID='',
)
class CallbackAppHandoffTests(SimpleTestCase):
    def setUp(self):
        self.clock = Mock(return_value=1000.0)
        self.response = Mock(status_code=200, history=[])
        self.response.__enter__ = Mock(return_value=self.response)
        self.response.__exit__ = Mock(return_value=False)
        self.response.iter_content.side_effect = lambda _: iter([json.dumps({
            'code': 200, 'data': {'appAccessToken': 'SYNTHETIC-APP', 'expire': 120},
        }).encode()])
        self.session = Mock()
        self.session.__enter__ = Mock(return_value=self.session)
        self.session.__exit__ = Mock(return_value=False)
        self.session.post.return_value = self.response
        self.factory = Mock(return_value=self.session)
        self.fence = Mock(return_value=None)
        self.completed = Mock(return_value=None)
        self.source = self.new_source()
        self.destination = app_tokens.AppTokenSupplier(
            session_factory=Mock(side_effect=AssertionError('No business issuance')),
            clock=self.clock,
        )
        destination = patch.object(app_tokens, '_supplier', self.destination)
        destination.start()
        self.addCleanup(destination.stop)

    def new_source(self, *, clock=None, fence=None):
        return callback_app_tokens.AppTokenSupplier(
            session_factory=self.factory, clock=clock or self.clock,
            issuance_fence=self.fence if fence is None else fence,
        )

    def offer(self, source=None, **changes):
        flags = {'identity_verified': True, 'credential_stored': True,
                 'publication_fence': self.completed, **changes}
        return (source or self.source).offer_to_business_cache(**flags)

    def state(self):
        return {name: getattr(self.destination, name) for name in (
            '_binding', '_token', '_deadline', '_retry_after', '_attempts',
            '_provider_seconds', '_issued_at', '_cache_owner_pid',
        )}

    def assert_empty(self):
        self.assertFalse(app_tokens.app_supply_readiness()['available'])
        with self.assertRaises(app_tokens.AppCredentialUnavailable):
            app_tokens.get_existing_app_access_token()
        self.destination._session_factory.assert_not_called()

    def test_post_commit_offer_reuses_one_supply_and_preserves_original_deadline(self):
        self.assertEqual(self.source.get(), 'SYNTHETIC-APP')
        self.clock.return_value = 1020.0
        self.assertTrue(self.offer())
        self.assertEqual(self.destination._deadline, 1060.0)
        self.assertEqual(app_tokens.app_supply_readiness(), {
            'available': True, 'reason': 'cached_supply', 'usable_for_seconds': 40,
        })
        self.assertEqual(app_tokens.get_existing_app_access_token(), 'SYNTHETIC-APP')
        self.fence.assert_called_once()
        self.completed.assert_called_once()
        self.session.post.assert_called_once()
        self.destination._session_factory.assert_not_called()
        before = self.state()
        self.assertFalse(self.offer())
        self.assertEqual(self.state(), before)
        self.clock.return_value = 1060
        self.assert_empty()
        with self.assertRaises(app_tokens.AppCredentialUnavailable):
            self.source.get()
        self.session.post.assert_called_once()

    def test_identity_and_storage_flags_cannot_publish_early_or_truthy_values(self):
        self.source.get()
        for change in ({'identity_verified': False}, {'credential_stored': False},
                       {'identity_verified': 1}, {'credential_stored': 'true'}):
            with self.subTest(change=change):
                self.assertFalse(self.offer(**change))
                self.assert_empty()
        self.completed.assert_not_called()
        self.assertTrue(self.offer())

    def test_unissued_failed_or_legacy_source_never_publishes(self):
        self.assertFalse(self.offer())
        self.assert_empty()
        failed = self.new_source()
        self.session.post.side_effect = TimeoutError('SYNTHETIC-PRIVATE')
        for _ in range(2):
            with self.assertRaises(app_tokens.AppCredentialUnavailable):
                failed.get()
        self.assertFalse(self.offer(failed))
        self.session.post.assert_called_once()
        self.assert_empty()
        self.session.post.side_effect = None
        legacy = callback_app_tokens.AppTokenSupplier(session_factory=self.factory, clock=self.clock)
        legacy.get()
        self.assertFalse(self.offer(legacy))
        self.assert_empty()

    def test_publication_fence_failure_consumes_offer_without_cache_change(self):
        self.source.get()
        self.completed.side_effect = RuntimeError('SYNTHETIC-PRIVATE')
        before = self.state()
        self.assertFalse(self.offer())
        self.assertEqual(self.state(), before)
        self.completed.side_effect = None
        self.assertFalse(self.offer())
        self.assert_empty()
        self.completed.assert_called_once()

    def test_negative_fence_result_rejects_before_io_or_publication(self):
        self.fence.return_value = False
        with self.assertRaises(app_tokens.AppCredentialUnavailable):
            self.source.get()
        self.factory.assert_not_called()
        self.assert_empty()
        fresh = self.new_source(fence=Mock(return_value=None))
        fresh.get()
        self.completed.return_value = False
        self.assertFalse(self.offer(fresh))
        self.assert_empty()

    def test_wrong_current_binding_or_expiry_cannot_replace_existing_cache(self):
        self.source.get()
        before = self.state()
        with override_settings(MES_USER_OAUTH_CONTROL_QC_ID='9000000000000042'):
            self.assertFalse(self.offer())
        self.assertEqual(self.state(), before)
        expired = self.new_source()
        expired.get()
        self.clock.return_value = 1060
        self.assertFalse(self.offer(expired))
        self.assertEqual(self.state(), before)

    def test_worker_and_clock_domains_cannot_transfer_or_read_inherited_cache(self):
        self.source.get()
        self.source._cache_owner_pid = os.getpid() + 1
        self.assertFalse(self.offer())
        self.assert_empty()
        foreign_clock = self.new_source(clock=Mock(return_value=1000.0))
        foreign_clock.get()
        self.assertFalse(self.offer(foreign_clock))
        self.assert_empty()
        own = self.new_source()
        own.get()
        self.assertTrue(self.offer(own))
        before = self.state()
        with patch('mes_oauth.app_tokens.os.getpid', return_value=os.getpid() + 1):
            self.assert_empty()
        self.assertEqual(self.state(), before)

    def test_persistent_fence_can_block_new_object_after_uncertain_issuance(self):
        # Production helper commits this state independently before get().
        spent = {'value': False}
        def persistent_fence():
            if spent['value']:
                raise RuntimeError('fixed_budget_spent')
            spent['value'] = True
        first = self.new_source(fence=persistent_fence)
        self.session.post.side_effect = TimeoutError('SYNTHETIC-PRIVATE')
        with self.assertRaises(app_tokens.AppCredentialUnavailable):
            first.get()
        replacement = self.new_source(fence=persistent_fence)
        for _ in range(2):
            with self.assertRaises(app_tokens.AppCredentialUnavailable):
                replacement.get()
        self.session.post.assert_called_once()
        self.assertEqual(replacement.diagnostic_snapshot()['http_attempts'], 0)
        self.assert_empty()

    def test_metadata_is_pure_and_never_calls_peek_get_or_session(self):
        self.source.get()
        self.assertTrue(self.offer())
        before = self.state()
        with patch.object(self.destination, 'peek_existing', side_effect=AssertionError), \
                patch.object(self.destination, 'get', side_effect=AssertionError):
            metadata = app_tokens.app_supply_readiness()
            self.assertTrue(metadata['available'])
            with override_settings(MES_USER_OAUTH_APP_SECRET='SYNTHETIC-ROTATED'):
                self.assertEqual(app_tokens.app_supply_readiness(), {
                    'available': False, 'reason': 'existing_supply_unavailable',
                    'usable_for_seconds': 0,
                })
            with override_settings(MES_USER_OAUTH_ENABLED=False):
                self.assertEqual(app_tokens.app_supply_readiness()['reason'], 'oauth_disabled')
        self.assertEqual(self.state(), before)
        self.assertEqual(set(metadata), {'available', 'reason', 'usable_for_seconds'})
        self.assertNotIn('SYNTHETIC', json.dumps(metadata))
        self.destination._session_factory.assert_not_called()

    def test_context_pins_exact_supplier_and_restores_legacy_after_failure(self):
        legacy = Mock()
        legacy.get.return_value = 'SYNTHETIC-LEGACY'
        with patch.object(callback_app_tokens, 'AppTokenSupplier', return_value=legacy) as factory:
            with self.assertRaises(RuntimeError):
                with callback_app_tokens.use_callback_app_supplier(self.source):
                    self.assertEqual(callback_app_tokens.get_app_access_token(), 'SYNTHETIC-APP')
                    self.assertEqual(callback_app_tokens.get_app_access_token(), 'SYNTHETIC-APP')
                    factory.assert_not_called()
                    raise RuntimeError('synthetic callback failure')
            self.assertEqual(callback_app_tokens.get_app_access_token(), 'SYNTHETIC-LEGACY')
            factory.assert_called_once()
        self.session.post.assert_called_once()

    def test_nested_contexts_and_independent_context_are_not_global_suppliers(self):
        other = Mock()
        other.get.return_value = 'SYNTHETIC-OTHER'
        clean_context = copy_context()
        with callback_app_tokens.use_callback_app_supplier(self.source):
            with callback_app_tokens.use_callback_app_supplier(other):
                self.assertEqual(callback_app_tokens.get_app_access_token(), 'SYNTHETIC-OTHER')
            self.assertEqual(callback_app_tokens.get_app_access_token(), 'SYNTHETIC-APP')
            legacy = Mock()
            with patch.object(callback_app_tokens, 'AppTokenSupplier', return_value=legacy):
                clean_context.run(callback_app_tokens.get_app_access_token)
                legacy.get.assert_called_once()
        self.session.post.assert_called_once()


class DiagnosticCallbackPinPersistenceTests(TestCase):
    """Nullable schema works for existing normal rows and explicit exact pins."""
    def rows(self, *, pin=None):
        from .models import MESLoginTicket, OAuthAttempt
        expires = timezone.now() + timedelta(minutes=5)
        ticket = MESLoginTicket.objects.create(
            digest='1' * 64, actor_id=18, login_digest='2' * 64,
            authorization_digest='3' * 64, expires_at=expires,
            diagnostic_request_uid=pin,
        )
        attempt = OAuthAttempt.objects.create(
            nonce_digest='4' * 64, actor_id=18, session_digest='5' * 64,
            policy_digest='6' * 64, expected_user_id='1733276056994641',
            expires_at=expires, diagnostic_request_uid=pin,
        )
        ticket.refresh_from_db()
        attempt.refresh_from_db()
        return ticket, attempt

    def test_normal_ticket_and_attempt_remain_unpinned(self):
        ticket, attempt = self.rows()
        self.assertIsNone(ticket.diagnostic_request_uid)
        self.assertIsNone(attempt.diagnostic_request_uid)

    def test_only_explicit_uuid_is_persisted_without_relationship_or_payload(self):
        pin = UUID('00000000-0000-4000-8000-000000000001')
        ticket, attempt = self.rows(pin=pin)
        self.assertEqual(ticket.diagnostic_request_uid, pin)
        self.assertEqual(attempt.diagnostic_request_uid, pin)
