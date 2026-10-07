"""Production admission seam using synthetic identity/lease/sender fixtures."""
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from mes_oauth.session_guard import InspectionSession
from mes_oauth.vault import VaultBlocked
from mes_oauth.test_inspection_credentials import CredentialFixture
from mes_oauth.test_vault import MES_USER, userinfo
from quality.inspection_transport import InspectionUserAccessToken
from .mes_delivery import ProductionDeliveryIntent, ReviewedDeliveryScope, _sha
from .mes_delivery_credentials import ScopedProductionWriter, VerifiedProductionAuthority
from .mes_execution_contract import build_task_start
from .test_mes_delivery import synthetic_login_lock


@override_settings(INSPECTION_PILOT_USER_IDS=[])
class ProductionCredentialAdmissionTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='SYNTHETIC-production-auth', is_superuser=True)
        self.payload = build_task_start(202)
        intent = ProductionDeliveryIntent('SYNTHETIC-tenant', 'SYNTHETIC-WO', 101, 102, 103, 0, Decimal('1'), 104, 105, 106, 107)
        self.scope = ReviewedDeliveryScope(intent, self.user.pk, 108, 'SYNTHETIC-review', 'a' * 64,
            timezone.now() + timedelta(minutes=30), (('task_start', _sha(self.payload)),))
        self.session = InspectionSession(self.user.pk, 'SYNTHETIC-login', timezone.now()+timedelta(hours=1), {})
        self.authority = VerifiedProductionAuthority(self.user.pk, 108, intent.tenant,
            self.scope.verification_reference, 'a' * 64, timezone.now(), frozenset({'task_start'}))
        self.provider = SimpleNamespace(userinfo=Mock())
        self.authority_reader = Mock(return_value=self.authority)
        self.sender = Mock(return_value=SimpleNamespace(status_code=200, history=[], content=b'{"code":200,"needCheck":0,"data":{}}'))
        self.writer = ScopedProductionWriter(self.scope, session=self.session,
            authority_reader=self.authority_reader, identity_provider=self.provider,
            origin='https://v3-ali.blacklake.cn', sender=self.sender)
        self.guard = patch.object(InspectionSession, 'lock', new=synthetic_login_lock)
        self.guard.start(); self.addCleanup(self.guard.stop)
        self.network = patch('socket.socket.connect', side_effect=AssertionError('No MES network allowed.'))
        self.network.start(); self.addCleanup(self.network.stop)

    def synthetic_broker(self, session, **kwargs):
        self.assertIs(session, self.session)
        self.assertIs(kwargs['provider'], self.provider)
        self.assertEqual(kwargs['operation'], 'save')
        self.assertEqual(kwargs['mes_user_id'], 108)
        self.assertTrue(kwargs['policy_check']())
        return kwargs['callback'](InspectionUserAccessToken('SYNTHETIC-LEASE', timezone.now().timestamp()+600, user_id=108))

    def test_explicit_provider_and_production_authority_precede_one_same_user_lease_callback(self):
        with patch('production.mes_delivery_credentials.call_with_user_credential', side_effect=self.synthetic_broker) as broker:
            result = self.writer('task_start', self.payload, self.scope)
        self.assertEqual(result, {'code': 200, 'needCheck': 0, 'data': {}})
        broker.assert_called_once(); self.sender.assert_called_once()
        self.assertTrue(self.writer.dispatched)
        self.assertEqual(self.writer.status_flag, 'acknowledged')
        self.provider.userinfo.assert_not_called()  # Synthetic broker substitutes this existing seam.

    def test_quality_permission_or_same_user_token_alone_cannot_grant_production_authority(self):
        for authority in (True, None, replace(self.authority, allowed_actions=frozenset()),
                replace(self.authority, actor_id=999), replace(self.authority, mes_user_id=999),
                replace(self.authority, actor_id=True),
                replace(self.authority, tenant='SYNTHETIC-other'), replace(self.authority, evidence_digest='b'*64),
                replace(self.authority, observed_at=timezone.now()-timedelta(minutes=10)),
                replace(self.authority, observed_at=timezone.now()+timedelta(minutes=10))):
            with self.subTest(authority=authority), patch('production.mes_delivery_credentials.call_with_user_credential') as broker:
                self.authority_reader.return_value = authority
                with self.assertRaises(PermissionDenied): self.writer('task_start', self.payload, self.scope)
                broker.assert_not_called(); self.sender.assert_not_called()
                self.assertFalse(self.writer.dispatched)

    def test_full_payload_and_scope_instance_are_required_before_credential_broker(self):
        with patch('production.mes_delivery_credentials.call_with_user_credential') as broker:
            for scope, payload in ((replace(self.scope), self.payload), (self.scope, {**self.payload, 'taskId': 999})):
                with self.assertRaises(PermissionDenied): self.writer('task_start', payload, scope)
            broker.assert_not_called()

    def test_fresh_superuser_and_pilot_admission_are_additional_constraints(self):
        with patch('production.mes_delivery_credentials.call_with_user_credential') as broker:
            get_user_model().objects.filter(pk=self.user.pk).update(is_superuser=False)
            with self.assertRaises(PermissionDenied): self.writer('task_start', self.payload, self.scope)
            get_user_model().objects.filter(pk=self.user.pk).update(is_superuser=True)
            self.session.claims['inspection_pilot_scope'] = False
            with self.assertRaises(PermissionDenied): self.writer('task_start', self.payload, self.scope)
            broker.assert_not_called()

    def test_absent_identity_provider_has_no_app_or_legacy_token_fallback(self):
        with self.assertRaises(PermissionDenied):
            ScopedProductionWriter(self.scope, session=self.session, authority_reader=self.authority_reader,
                identity_provider=None, origin='https://v3-ali.blacklake.cn')

    def test_new_admission_failure_does_not_retain_earlier_dispatched_state(self):
        with patch('production.mes_delivery_credentials.call_with_user_credential', side_effect=self.synthetic_broker):
            self.writer('task_start', self.payload, self.scope)
        self.assertTrue(self.writer.dispatched)
        self.authority_reader.return_value = False
        with self.assertRaises(PermissionDenied): self.writer('task_start', self.payload, self.scope)
        self.assertFalse(self.writer.dispatched)
        self.assertFalse(self.writer.consume_readback_allowance())

    def test_broker_rejection_does_not_roll_back_credential_clear_in_outer_guard(self):
        # Use an actual transactional row change at the broker seam, rather than
        # claiming a mock exception proves the enclosing transaction commits.
        def cleared_then_blocked(*args, **kwargs):
            get_user_model().objects.filter(pk=self.user.pk).update(first_name='SYNTHETIC-cleared')
            raise VaultBlocked('inspection_identity_recheck_failed')
        with patch('production.mes_delivery_credentials.call_with_user_credential', side_effect=cleared_then_blocked):
            with self.assertRaises(VaultBlocked): self.writer('task_start', self.payload, self.scope)
        self.user.refresh_from_db()
        self.assertEqual(self.user.first_name, 'SYNTHETIC-cleared')
        self.sender.assert_not_called()


class ProductionRealBrokerRejectionTests(CredentialFixture, TransactionTestCase):
    def test_identity_rejection_wipes_real_synthetic_vault_row_through_writer_guard(self):
        payload = build_task_start(202)
        intent = ProductionDeliveryIntent('SYNTHETIC-TENANT', 'SYNTHETIC-WO',
            101, 102, 103, 0, Decimal('1'), 104, 105, 106, 107)
        scope = ReviewedDeliveryScope(intent, self.user.pk, MES_USER, 'SYNTHETIC-review', 'a'*64,
            self.instant+timedelta(minutes=30), (('task_start', _sha(payload)),))
        authority = VerifiedProductionAuthority(self.user.pk, MES_USER, intent.tenant,
            scope.verification_reference, 'a'*64, self.instant, frozenset({'task_start'}))
        sender = Mock()
        writer = ScopedProductionWriter(scope, session=self.session(),
            authority_reader=lambda reviewed: authority, identity_provider=self.provider,
            origin='https://v3-ali.blacklake.cn', sender=sender)
        self.provider.userinfo.return_value = userinfo(MES_USER+1)
        with self.assertRaises(VaultBlocked): writer('task_start', payload, scope)
        self.assert_wiped()
        self.assertEqual(self.provider.userinfo.call_count, 1)
        sender.assert_not_called()
        self.assertFalse(writer.dispatched)
        for prohibited in ('exchange', 'refresh', 'fallback'):
            getattr(self.provider, prohibited).assert_not_called()
