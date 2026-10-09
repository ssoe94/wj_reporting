"""Disposable synthetic delivery ledger/evidence tests; no MES or credentials."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from mes_oauth.session_guard import InspectionSession
from quality.inspection_adapter import MesOutcomeUnknown
from quality.inspection_models import InspectionOperation, InspectionRequest
from quality.inspection_workflow import InspectionConflict
from .mes_delivery import (DELIVERY_STAGES, ProductionDeliveryIntent, ReviewedDeliveryScope,
    ProductionDeliveryCoordinator, VerifiedDeliveryEffect, _sha)


@contextmanager
def synthetic_login_lock(session, permission, *, actor_id, **kwargs):
    """Stub only the signed-login/credential seam; real DB and locks remain."""
    with transaction.atomic():
        user = get_user_model().objects.select_for_update().get(pk=actor_id)
        yield user


class SyntheticWriter:
    def __init__(self, *, error=False, allowed=True, status='outcome_unknown', dispatched=True):
        self.calls, self.error, self.allowed = 0, error, allowed
        self.dispatched, self.status_flag = dispatched, status
        self.allowance_calls = 0

    def __call__(self, stage, payload, scope):
        self.calls += 1
        # The durable pending intent must exist before the network seam begins.
        assert InspectionOperation.objects.filter(status='pending', request=None).exists()
        if self.error:
            raise MesOutcomeUnknown()
        return {'code': 200, 'needCheck': 0, 'data': {}}

    def consume_readback_allowance(self):
        self.allowance_calls += 1
        return self.allowed and self.allowance_calls == 1


@override_settings(INSPECTION_PILOT_USER_IDS=[])
class ProductionDeliveryTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='SYNTHETIC-production-owner', is_superuser=True)
        self.intent = ProductionDeliveryIntent(
            'SYNTHETIC-tenant', 'SYNTHETIC-WO-01', 101, 102, 103, 3, Decimal('1.000'), 104, 105, 106, 107)
        self.payloads = {stage: {'SYNTHETIC-stage': stage, 'code': self.intent.work_order_code}
                         for stage in DELIVERY_STAGES if stage not in {'first_qc', 'periodic_qc'}}
        self.scope = self.make_scope(self.user)
        self.coordinator = self.make_coordinator(self.scope)
        self.guard = patch.object(InspectionSession, 'lock', new=synthetic_login_lock)
        self.guard.start(); self.addCleanup(self.guard.stop)
        self.network = patch('socket.socket.connect', side_effect=AssertionError('No MES network allowed.'))
        self.network.start(); self.addCleanup(self.network.stop)
        self.writer = SyntheticWriter()
        self.read_calls = 0

    def make_scope(self, user, intent=None):
        return ReviewedDeliveryScope(intent or self.intent, user.pk, 108,
            'SYNTHETIC-PRODUCTION-REVIEW', 'a' * 64, timezone.now() + timedelta(minutes=30),
            tuple((stage, _sha(payload)) for stage, payload in self.payloads.items()))

    def make_coordinator(self, scope):
        session = InspectionSession(scope.actor_id, 'SYNTHETIC-login', timezone.now() + timedelta(hours=1), {})
        return ProductionDeliveryCoordinator(scope, session=session)

    def proof(self, stage, **changes):
        e = {'work_order_id': 201, 'material_id': 101, 'unit_id': 103}
        if stage != 'work_order_create':
            e.update(task_id=202, resource_id=102)
        if stage in {'work_order_create', 'work_order_dispatch', 'task_start'}:
            e.update(planned_quantity='1.000', automatic_warehousing=False)
        if stage == 'work_order_dispatch': e['dispatch_state'] = 'dispatched'
        if stage == 'task_start': e['task_state'] = 'started'
        if stage in {'first_qc', 'periodic_qc'}:
            e.update(qc_id=203 if stage == 'first_qc' else 204,
                qc_plan_id=106 if stage == 'first_qc' else 107,
                qc_type=3 if stage == 'first_qc' else 5, qc_state='completed', judgement='pass',
                approval_pending=False, nonconformance_open=False, measurement_basis='actual_measurement')
        if stage == 'progress_report':
            e.update(production_inventory_id=205, report_record_ids=[206], report_inventory_link_digest='b' * 64,
                     reported_quantity='1.000', inventory_quantity='1.000', qc_status=1)
        if stage == 'manual_inbound':
            e.update(production_inventory_id=205, warehouse_id=104, storage_location_id=105,
                receipt_quantity='1.000', source_before='1.000', source_after='0',
                destination_before='2.000', destination_after='3.000', receipt_id=207,
                inventory_change_log_id=208, receipt_report_record_ids=[206])
        e.update(changes)
        return VerifiedDeliveryEffect(stage, self.intent.tenant, self.intent.work_order_code,
            timezone.now(), 'c' * 64, e)

    def preflight(self, scope, stage, payload, previous):
        return VerifiedDeliveryEffect(stage, scope.intent.tenant, scope.intent.work_order_code,
            timezone.now(), 'd' * 64,
            {'intent_digest': scope.intent.digest, 'payload_digest': _sha(payload)})

    def read(self, scope, stage, previous):
        self.read_calls += 1
        return self.proof(stage)

    def fresh_qc(self, scope):
        return self.proof('first_qc'), self.proof('periodic_qc')

    def execute(self, stage, **kwargs):
        return self.coordinator.execute(stage, kwargs.pop('key', uuid.uuid4()),
            kwargs.pop('payload', self.payloads[stage]), writer=kwargs.pop('writer', self.writer),
            readback=kwargs.pop('readback', self.read), preflight=kwargs.pop('preflight', self.preflight),
            qc_readback=kwargs.pop('qc_readback', self.fresh_qc), **kwargs)

    def through(self, final):
        for stage in DELIVERY_STAGES:
            if stage in {'first_qc', 'periodic_qc'}:
                result = self.coordinator.observe_qc(stage, uuid.uuid4(), reader=self.read)
            else:
                result = self.execute(stage)
            self.assertEqual(result['status'], 'succeeded', result)
            if stage == final: break

    def test_full_synthetic_flow_verifies_five_writes_two_exact_qcs_and_inbound_trace(self):
        self.through('manual_inbound')
        self.assertEqual(self.writer.calls, 5)
        self.assertEqual(self.read_calls, 7)
        self.assertEqual(InspectionOperation.objects.count(), 7)
        self.assertEqual(InspectionRequest.objects.count(), 0)
        self.assertFalse(InspectionOperation.objects.exclude(request=None).exists())
        row = InspectionOperation.objects.get(scope__endswith=':manual_inbound')
        self.assertEqual(row.response['verified_effect']['receipt_id'], 207)
        self.assertEqual(row.response['intent']['quantity'], '1.000')

    def test_unknown_ack_gets_one_read_and_same_or_new_key_never_resends(self):
        self.writer = SyntheticWriter(error=True)
        key = uuid.uuid4()
        result = self.execute('work_order_create', key=key)
        self.assertEqual(result['status'], 'succeeded')
        self.assertTrue(result['automatic_readback_attempted'])
        self.assertEqual(self.execute('work_order_create', key=key), result)
        with self.assertRaises(InspectionConflict): self.execute('work_order_create')
        self.assertEqual((self.writer.calls, self.read_calls, self.writer.allowance_calls), (1, 1, 1))

    def test_unverified_read_preserves_unknown_intent_and_blocks_new_actor_quantity_key(self):
        self.writer = SyntheticWriter(error=True)
        result = self.execute('work_order_create', readback=lambda *args: self.proof('work_order_create', material_id=999))
        self.assertEqual(result['status'], 'unknown')
        row = InspectionOperation.objects.get()
        self.assertEqual(row.response['intent_digest'], self.intent.digest)
        with self.assertRaises(InspectionConflict): self.execute('work_order_create')
        other = get_user_model().objects.create_user(username='SYNTHETIC-second-owner', is_superuser=True)
        coordinator = self.make_coordinator(self.make_scope(other))
        with self.assertRaises(InspectionConflict): coordinator._reservation('work_order_create', uuid.uuid4(), self.payloads['work_order_create'])
        changed = self.make_coordinator(self.make_scope(self.user, replace(self.intent, quantity=Decimal('2'))))
        with self.assertRaises(InspectionConflict): changed._reservation('work_order_create', uuid.uuid4(), self.payloads['work_order_create'])
        self.assertEqual(self.writer.calls, 1)

    def test_crash_reservation_commits_and_replay_does_not_dispatch(self):
        key = uuid.uuid4()
        row, created = self.coordinator._reservation('work_order_create', key, self.payloads['work_order_create'])
        self.assertTrue(created); self.assertFalse(connection.in_atomic_block)
        self.assertEqual(self.execute('work_order_create', key=key)['status'], 'pending')
        with self.assertRaises(InspectionConflict): self.execute('work_order_create')
        self.assertEqual(self.writer.calls, 0)
        self.assertEqual(self.coordinator.reconcile(row.pk, readback=self.read)['status'], 'succeeded')
        self.assertEqual(self.writer.calls, 0)

    def test_outer_transaction_refused_before_reservation_or_dispatch(self):
        with transaction.atomic(), self.assertRaises(ValueError): self.execute('work_order_create')
        self.assertEqual(InspectionOperation.objects.count(), 0)

    def test_entire_body_digest_is_pinned_including_unexpected_bom_or_qty(self):
        with self.assertRaises(PermissionDenied): self.execute('work_order_create', payload={**self.payloads['work_order_create'], 'inputMaterial': 'SYNTHETIC-unreviewed'})
        self.assertEqual((InspectionOperation.objects.count(), self.writer.calls), (0, 0))

    def test_ack_without_effect_and_wrong_or_stale_or_secret_observations_remain_unknown(self):
        for change in ({'planned_quantity': '2'}, {'automatic_warehousing': True}, {'material_id': True}, {'raw_access_token': 'SYNTHETIC-forbidden'}):
            with self.subTest(change=change):
                InspectionOperation.objects.all().delete()
                result = self.execute('work_order_create', readback=lambda *args: self.proof('work_order_create', **change))
                self.assertEqual(result['status'], 'unknown')
                self.assertNotIn('verified_effect', InspectionOperation.objects.get().response)
        InspectionOperation.objects.all().delete()
        old = replace(self.proof('work_order_create'), observed_at=timezone.now()-timedelta(minutes=10))
        self.assertEqual(self.execute('work_order_create', readback=lambda *args: old)['status'], 'unknown')

    def test_known_provider_rejection_does_not_read_and_preflight_true_does_not_write(self):
        for flag in ('authentication_rejected', 'access_denied', 'provider_rejected'):
            with self.subTest(flag=flag):
                InspectionOperation.objects.all().delete()
                writer = SyntheticWriter(error=True, status=flag)
                self.assertEqual(self.execute('work_order_create', writer=writer)['status'], 'rejected')
                self.assertEqual(writer.allowance_calls, 0)
        self.assertEqual(self.read_calls, 0)
        InspectionOperation.objects.all().delete()
        self.assertEqual(self.execute('work_order_create', preflight=lambda *args: True)['status'], 'rejected')
        self.assertEqual(self.writer.calls, 0)

    def test_provider_confirmation_preserves_unknown_fence_and_does_not_read(self):
        writer = SyntheticWriter(error=True, status='confirmation_required', allowed=False)
        self.assertEqual(self.execute('work_order_create', writer=writer)['status'], 'unknown')
        self.assertEqual(self.read_calls, 0)
        with self.assertRaises(InspectionConflict): self.execute('work_order_create')

    def test_missing_predecessor_or_unrestricted_actor_cannot_write(self):
        with self.assertRaises(InspectionConflict): self.execute('manual_inbound')
        get_user_model().objects.filter(pk=self.user.pk).update(is_superuser=False)
        with self.assertRaises(PermissionDenied): self.execute('work_order_create')
        get_user_model().objects.filter(pk=self.user.pk).update(is_superuser=True)
        self.coordinator.session.claims['inspection_pilot_scope'] = True
        with self.assertRaises(PermissionDenied): self.execute('work_order_create')
        self.assertEqual(self.writer.calls, 0)

    def test_standalone_virtual_approval_pending_qc_cannot_gate_production(self):
        self.through('task_start')
        for change in ({'work_order_id': 999}, {'task_id': 999}, {'qc_type': 6},
                {'measurement_basis': 'non_measured_integration_trial'}, {'approval_pending': True},
                {'nonconformance_open': True}, {'judgement': 'fail'}, {'qc_plan_id': 999}):
            with self.subTest(change=change), self.assertRaises((MesOutcomeUnknown, ValueError)):
                self.coordinator.observe_qc('first_qc', uuid.uuid4(), reader=lambda *args: self.proof('first_qc', **change))
        self.assertEqual(InspectionOperation.objects.count(), 3)

    def test_report_requires_fresh_exact_qc_even_after_qc_was_recorded_pass(self):
        self.through('periodic_qc')
        for qc_reader in (None, lambda *args: (self.proof('first_qc', judgement='fail'), self.proof('periodic_qc')),
                lambda *args: (self.proof('first_qc'), self.proof('periodic_qc', qc_id=999))):
            with self.subTest(qc_reader=qc_reader):
                result = self.execute('progress_report', qc_readback=qc_reader)
                self.assertEqual(result['status'], 'rejected')
        self.assertEqual(self.writer.calls, 3)

    def test_first_qc_cannot_be_relabelled_as_the_periodic_qc(self):
        self.through('first_qc')
        with self.assertRaises(MesOutcomeUnknown):
            self.coordinator.observe_qc('periodic_qc', uuid.uuid4(),
                reader=lambda *args: self.proof('periodic_qc', qc_id=203))

    def test_report_receipt_missing_inventory_link_or_wrong_inventory_is_not_success(self):
        self.through('periodic_qc')
        self.assertEqual(self.execute('progress_report', readback=lambda *args: self.proof('progress_report', report_inventory_link_digest=''))['status'], 'unknown')
        with self.assertRaises(InspectionConflict): self.execute('manual_inbound')

    def test_inbound_requires_receipt_and_log_and_exact_source_location_unit_quantity(self):
        self.through('progress_report')
        row_id = InspectionOperation.objects.latest('id').pk
        for change in ({'production_inventory_id': 999}, {'unit_id': 999}, {'storage_location_id': 999},
                {'source_after': '1'}, {'destination_after': '2'}, {'receipt_id': None},
                {'inventory_change_log_id': None}, {'receipt_report_record_ids': [999]}):
            with self.subTest(change=change):
                InspectionOperation.objects.filter(id__gt=row_id).delete()
                self.assertEqual(self.execute('manual_inbound', readback=lambda *args: self.proof('manual_inbound', **change))['status'], 'unknown')

    def test_receipt_record_ids_require_exact_integers_without_decimal_or_bool_coercion(self):
        self.through('progress_report')
        row_id = InspectionOperation.objects.latest('id').pk
        for records in ([Decimal('206')], [True], ['206'], [206, 206]):
            with self.subTest(records=records):
                InspectionOperation.objects.filter(id__gt=row_id).delete()
                self.assertEqual(self.execute('manual_inbound',
                    readback=lambda *args: self.proof('manual_inbound', receipt_report_record_ids=records))['status'], 'unknown')

    def test_reconcile_of_different_actor_and_changed_scope_is_denied(self):
        result = self.execute('work_order_create', readback=lambda *args: None)
        other = get_user_model().objects.create_user(username='SYNTHETIC-other', is_superuser=True)
        with self.assertRaises(PermissionDenied):
            self.make_coordinator(self.make_scope(other)).reconcile(result['operation_id'], readback=self.read)
        expired = self.make_coordinator(replace(self.scope, expires_at=timezone.now()-timedelta(seconds=1)))
        with self.assertRaises(PermissionDenied): expired.reconcile(result['operation_id'], readback=self.read)
