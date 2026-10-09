"""Explicit exact-draft reconnect through real local JWT/session/budget hooks.

All APP HTTP and USER provider responses are synthetic; the isolated runner
forbids real network and uses a disposable database. No MES create is invoked.
"""
from datetime import timedelta
import json
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from production import mes_create_diagnostic as diagnostic
from production.models import MesCreateDiagnosticPermit
from . import app_tokens, callback_app_tokens, vault
from .connection_views import DIAGNOSTIC_SESSION_KEY
from .models import MESCredential, MESLoginTicket, OAuthAttempt
from .test_connection import CONNECTION_SETTINGS, ConnectionFixture, CODE, envelope
from .test_vault import APP_ID, KEY_ONE
from .views import CALLBACK, START


@override_settings(**{
    **CONNECTION_SETTINGS,
    'MES_USER_TOKEN_STORAGE_ENABLED': True,
    'MES_USER_TOKEN_APP_ID': str(APP_ID),
    'MES_USER_OAUTH_APP_ID': str(APP_ID),
    'MES_USER_TOKEN_TENANT_REFERENCE': 'SYNTHETIC-TENANT',
    'MES_USER_TOKEN_POLICY_REFERENCE': 'SYNTHETIC-VAULT-POLICY',
    'MES_USER_TOKEN_EXPIRY_MODE': 'relative_seconds',
    'MES_USER_TOKEN_CONTRACT_REFERENCE': 'SYNTHETIC-REVIEWED-EXPIRY',
    'MES_USER_TOKEN_MAX_AGE_SECONDS': 600,
    'MES_USER_TOKEN_IDLE_SECONDS': 180,
    'MES_USER_TOKEN_CONSENT_SECONDS': 900,
    'MES_USER_TOKEN_SAFETY_SECONDS': 30,
    'MES_USER_TOKEN_KEYS': json.dumps({'fixture-v1': KEY_ONE}),
    'MES_USER_TOKEN_ACTIVE_KEY_ID': 'fixture-v1',
    'MES_USER_OAUTH_APP_TOKEN_SOURCE': 'server',
    'MES_USER_OAUTH_APP_CREDENTIAL_SOURCE': 'dedicated',
    'MES_USER_OAUTH_APP_KEY': 'SYNTHETIC-KEY',
    'MES_USER_OAUTH_APP_SECRET': 'SYNTHETIC-SECRET',
    'MES_USER_OAUTH_APP_TOKEN_HEADER': 'access_token',
    'MES_USER_OAUTH_CONTROL_QC_ID': '',
    'INSPECTION_PILOT_ENABLED': False,
    'INSPECTION_PILOT_USER_IDS': [],
})
class ExactDiagnosticBridgeTests(ConnectionFixture, TransactionTestCase):
    def setUp(self):
        manager = get_user_model().objects
        create_user = manager.create_user

        def exact_actor(**kwargs):
            if kwargs.get('username') == 'SYNTHETIC-CONNECTION-A':
                kwargs['pk'] = diagnostic.ACTOR_ID
            elif kwargs.get('username') == 'SYNTHETIC-CONNECTION-B':
                kwargs['pk'] = diagnostic.ACTOR_ID + 1
            return create_user(**kwargs)

        with patch.object(manager, 'create_user', side_effect=exact_actor), \
                patch('mes_oauth.test_connection.MES_USER', int(diagnostic.MES_USER_ID)):
            super().setUp()
        self.provider.exchange.return_value = envelope({
            'userAccessToken': 'SYNTHETIC-EXACT-USER', 'expire': 1200,
        })
        self.req = diagnostic.activate_diagnostic(self.user, 'SYNTHETIC-TENANT')
        self.mono = Mock(return_value=1000.0)
        self.business_factory = Mock(side_effect=AssertionError('Business APP issuance forbidden'))
        self.business = app_tokens.AppTokenSupplier(session_factory=self.business_factory, clock=self.mono)
        cache = patch.object(app_tokens, '_supplier', self.business)
        cache.start()
        self.addCleanup(cache.stop)
        self.app_response = Mock(status_code=200, history=[])
        self.app_response.__enter__ = Mock(return_value=self.app_response)
        self.app_response.__exit__ = Mock(return_value=False)
        self.app_response.iter_content.side_effect = lambda _: iter([json.dumps({
            'code': 200, 'data': {'appAccessToken': 'SYNTHETIC-EXACT-APP', 'expire': 120},
        }).encode()])
        self.app_session = Mock()
        self.app_session.__enter__ = Mock(return_value=self.app_session)
        self.app_session.__exit__ = Mock(return_value=False)
        self.app_session.post.return_value = self.app_response
        self.app_factory = Mock(return_value=self.app_session)
        self.suppliers = []
        supplier = patch('mes_oauth.views.AppTokenSupplier', side_effect=self.make_supplier)
        self.supplier_factory = supplier.start()
        self.addCleanup(supplier.stop)

    def make_supplier(self, **kwargs):
        source = callback_app_tokens.AppTokenSupplier(
            session_factory=self.app_factory, clock=self.mono, **kwargs,
        )
        original_offer = source.offer_to_business_cache

        def post_commit_offer(**flags):
            self.assertFalse(connection.in_atomic_block)
            self.assertTrue(MESCredential.objects.filter(pk=self.user.pk).exists())
            self.assertEqual(OAuthAttempt.objects.get(
                diagnostic_request_uid=self.req.uid).status, 'verified')
            self.assertTrue(self.req.events.filter(state='auth_verified').exists())
            return original_offer(**flags)

        source.offer_to_business_cache = Mock(side_effect=post_commit_offer)
        self.suppliers.append(source)
        return source

    def begin_pinned(self):
        response = self.action('launch', {'diagnostic_request_uid': str(self.req.uid)})
        self.assertEqual(response.status_code, 200)
        ticket = MESLoginTicket.objects.get(pk=vault.digest('ticket', response.json()['ticket']))
        self.assertEqual(ticket.diagnostic_request_uid, self.req.uid)
        self.assertEqual(self.bridge(response.json()['ticket']).status_code, 302)
        self.assertEqual(self.browser.session[DIAGNOSTIC_SESSION_KEY], str(self.req.uid))
        self.assertEqual(self.browser.get(START, secure=True).status_code, 200)
        self.assertEqual(self.csrf_post(START).status_code, 200)
        attempt = OAuthAttempt.objects.latest('created_at')
        self.assertEqual(attempt.diagnostic_request_uid, self.req.uid)
        return attempt

    def use_real_supplier(self):
        def get_provider():
            # This is called inside the separate USER transaction. The durable
            # budget already exists and survives that transaction's rollback.
            self.assertTrue(connection.in_atomic_block)
            approval = MesCreateDiagnosticPermit.objects.get(request=self.req)
            self.assertEqual(approval.auth_app_attempt, 1)
            self.assertIsNotNone(approval.auth_claimed_at)
            attempt = OAuthAttempt.objects.get(pk=approval.auth_oauth_attempt)
            self.assertEqual(attempt.status, 'processing')
            self.assertIsNotNone(attempt.consumed_at)
            self.assertTrue(self.req.events.filter(state='auth_reserved').exists())
            self.assertEqual(callback_app_tokens.get_app_access_token(), 'SYNTHETIC-EXACT-APP')
            return self.provider
        self.factory.side_effect = get_provider

    def assert_budget_spent_and_empty(self):
        approval = MesCreateDiagnosticPermit.objects.get(request=self.req)
        self.assertEqual(approval.auth_app_attempt, 1)
        self.assertIsNotNone(approval.auth_claimed_at)
        self.assertIsNotNone(approval.auth_completed_at)
        self.assertFalse(MESCredential.objects.exists())
        self.assertFalse(app_tokens.app_supply_readiness()['available'])
        self.business_factory.assert_not_called()
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('prepared', 0))

    def expire_approval(self):
        record = MesCreateDiagnosticPermit.objects.get(request=self.req)
        end = timezone.now() - timedelta(seconds=1)
        start = end - timedelta(minutes=10)
        record.snapshot = {**record.snapshot, 'approved_at': start.isoformat(), 'expires_at': end.isoformat()}
        record.snapshot_digest = diagnostic.digest(record.snapshot)
        record.approved_at, record.expires_at = start, end
        record.save()

    def test_normal_launch_and_callback_remain_unpinned_with_prepared_exact_row(self):
        attempt = self.begin()
        self.assertIsNone(MESLoginTicket.objects.get().diagnostic_request_uid)
        self.assertNotIn(DIAGNOSTIC_SESSION_KEY, self.browser.session)
        self.assertIsNone(attempt.diagnostic_request_uid)
        response = self.csrf_post(CALLBACK, {'code': CODE})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('business_supply_ready', response.json())
        self.supplier_factory.assert_not_called()
        self.app_factory.assert_not_called()
        self.assertEqual(MesCreateDiagnosticPermit.objects.get(request=self.req).auth_app_attempt, 0)

    def test_explicit_launch_ticket_session_and_start_pin_without_app_io(self):
        self.begin_pinned()
        self.assert_no_provider()
        self.supplier_factory.assert_not_called()
        self.app_factory.assert_not_called()
        self.assertEqual(MesCreateDiagnosticPermit.objects.get(request=self.req).auth_app_attempt, 0)

    def test_wrong_actor_malformed_missing_or_expired_pin_never_creates_ticket(self):
        other_tokens = self.obtain(self.other)
        for value, tokens in ((str(self.req.uid), other_tokens), ('invalid', None),
                              (None, None), (42, None),
                              ('00000000-0000-4000-8000-000000000001', None)):
            with self.subTest(kind=type(value).__name__, other=tokens is not None):
                response = self.action('launch', {'diagnostic_request_uid': value}, tokens=tokens)
                self.assertEqual(response.status_code, 409)
                self.assertFalse(MESLoginTicket.objects.exists())
        self.expire_approval()
        self.assertEqual(self.action('launch', {'diagnostic_request_uid': str(self.req.uid)}).status_code, 409)
        self.assertFalse(MESLoginTicket.objects.exists())
        self.assert_no_provider()

    def test_pinned_ticket_cannot_bridge_after_approval_expiry(self):
        response = self.action('launch', {'diagnostic_request_uid': str(self.req.uid)})
        self.assertEqual(response.status_code, 200)
        self.expire_approval()
        self.assertEqual(self.bridge(response.json()['ticket']).status_code, 403)
        self.assertIsNone(MESLoginTicket.objects.get().consumed_at)
        self.assertFalse(OAuthAttempt.objects.exists())
        self.assert_no_provider()

    def test_callback_success_publishes_only_after_user_store_commit(self):
        attempt = self.begin_pinned()
        self.use_real_supplier()
        response = self.csrf_post(CALLBACK, {'code': CODE})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['credential_stored'])
        self.assertTrue(response.json()['business_supply_ready'])
        self.assertFalse(response.json()['live_ready'])
        self.assertNotIn('SYNTHETIC-EXACT', response.content.decode())
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, 'verified')
        self.assertTrue(MESCredential.objects.filter(pk=self.user.pk, mes_user_id=diagnostic.MES_USER_ID).exists())
        self.assertEqual(app_tokens.get_existing_app_access_token(), 'SYNTHETIC-EXACT-APP')
        self.assertEqual(self.business._deadline, 1060)
        self.app_session.post.assert_called_once()
        self.business_factory.assert_not_called()
        self.suppliers[0].offer_to_business_cache.assert_called_once()
        approval = MesCreateDiagnosticPermit.objects.get(request=self.req)
        self.assertEqual(approval.auth_app_attempt, 1)
        self.assertIsNotNone(approval.auth_completed_at)
        self.assertEqual(self.action('launch', {'diagnostic_request_uid': str(self.req.uid)}).status_code, 409)
        # Successful callback clears its nonce cookie; replay has no attempt.
        self.assertEqual(self.csrf_post(CALLBACK, {'code': CODE}).status_code, 403)
        self.app_session.post.assert_called_once()

    def test_uncertain_app_timeout_never_refunds_budget_or_publishes(self):
        attempt = self.begin_pinned()
        self.use_real_supplier()
        self.app_session.post.side_effect = TimeoutError('SYNTHETIC-PRIVATE')
        response = self.csrf_post(CALLBACK, {'code': CODE})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('SYNTHETIC-PRIVATE', response.content.decode())
        self.assert_budget_spent_and_empty()
        attempt.refresh_from_db()
        self.assertEqual(attempt.status, 'rejected')
        self.suppliers[0].offer_to_business_cache.assert_not_called()
        self.assertEqual(self.action('launch', {'diagnostic_request_uid': str(self.req.uid)}).status_code, 409)
        self.app_session.post.assert_called_once()
        self.provider.exchange.assert_not_called()

    def test_user_identity_mismatch_keeps_spent_app_budget_without_publication(self):
        self.begin_pinned()
        self.use_real_supplier()
        self.provider.userinfo.return_value = envelope({'userId': int(diagnostic.MES_USER_ID) + 1})
        self.assertEqual(self.csrf_post(CALLBACK, {'code': CODE}).status_code, 502)
        self.assert_budget_spent_and_empty()
        self.app_session.post.assert_called_once()
        self.suppliers[0].offer_to_business_cache.assert_not_called()

    def test_failed_user_storage_transaction_cannot_refund_app_or_publish_cache(self):
        self.begin_pinned()
        self.use_real_supplier()
        with patch('mes_oauth.vault.store_context', side_effect=RuntimeError('SYNTHETIC-PRIVATE')):
            self.assertEqual(self.csrf_post(CALLBACK, {'code': CODE}).status_code, 502)
        self.assert_budget_spent_and_empty()
        self.app_session.post.assert_called_once()
        self.suppliers[0].offer_to_business_cache.assert_not_called()

    def test_expired_pinned_callback_has_no_legacy_supplier_fallback(self):
        self.begin_pinned()
        self.expire_approval()
        self.assertEqual(self.csrf_post(CALLBACK, {'code': CODE}).status_code, 502)
        self.factory.assert_not_called()
        self.supplier_factory.assert_not_called()
        self.app_factory.assert_not_called()
        self.assertEqual(MesCreateDiagnosticPermit.objects.get(request=self.req).auth_app_attempt, 0)
