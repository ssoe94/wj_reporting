"""Synthetic application-stage contract, not a live Blacklake write acceptance."""
from copy import deepcopy
from decimal import Decimal
from datetime import timedelta
import uuid
from unittest.mock import patch
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.test import APITestCase
from . import test_inspection_requests as helpers
from .inspection_mes_stages import TEST_LABEL
from .inspection_models import InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_validation import digest
from .inspection_workflow import result_payload


class StageFixture:
    enabled = True
    def __init__(self):
        self.records = []
        self.label = ''
        self.state = 'open'
        self.inspection_result = None
        self.calls = []
        self.overrides = {}
        self.timeout = ''
    def read(self, binding):
        value = {'identity': {'tenant': binding.tenant, 'qc_id': binding.qc_id, 'work_order_id': binding.work_order_id,
            **{key: str(binding.contract[key]) for key in ('production_task_id', 'equipment_id', 'snapshot_id')}},
            'observed_at': timezone.now(), 'records': deepcopy(self.records), 'test_label': self.label, 'state': self.state,
            'inspectionResult': self.inspection_result}
        value.update(self.overrides)
        return value
    def save(self, binding, records, test_label, operation_id):
        self.calls.append(('save', operation_id, deepcopy(records)))
        lookup = {(str(item['write_item_id']), item['group'], item['seq']): item for item in binding.contract['items']}
        self.records = [{'config_row_id': lookup[(row['checkItemId'], row['groupName'], row['seq'])]['config_row_id'],
            'group': row['groupName'], 'seq': row['seq'], 'value': row['result']} for row in records]
        self.label = test_label
        if self.timeout == 'save': raise TimeoutError('SYNTHETIC sensitive URL')
    def finish_inspection(self, binding, verdict, operation_id):
        self.calls.append(('finish', operation_id, verdict))
        self.state = 'completed'
        self.inspection_result = verdict
        if self.timeout == 'finish': raise TimeoutError('SYNTHETIC sensitive URL')


class InspectionMesStageTests(APITestCase):
    base_url = helpers.InspectionRequestContractTests.base_url
    make_user = helpers.InspectionRequestContractTests.make_user
    create_payload = helpers.InspectionRequestContractTests.create_payload
    draft_payload = helpers.InspectionRequestContractTests.draft_payload
    post = helpers.InspectionRequestContractTests.post
    create = helpers.InspectionRequestContractTests.create
    draft = helpers.InspectionRequestContractTests.draft
    action = helpers.InspectionRequestContractTests.action
    approved = helpers.InspectionRequestContractTests.approved

    def setUp(self):
        helpers.InspectionRequestContractTests.setUp(self)
        self.stage = StageFixture()
        self.patch = patch('quality.inspection_mes_stages.get_stage_adapter', return_value=self.stage)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.data = self.approved()
        row = InspectionRequest.objects.get(pk=self.data['id'])
        # Synthetic fixture intentionally has no attachment contract.
        row.quantity_mode = 'not_recorded'
        row.inspected_quantity = row.accepted_quantity = row.rejected_quantity = Decimal('0.000')
        row.require_evidence = False; row.evidence = []
        row.inspection_items[0]['evidence_required'] = False
        row.measurements[0]['evidence_url'] = ''; row.save()
        self.binding = InspectionMesBinding.objects.create(request=row, tenant='SYNTHETIC', qc_id='91000000000000001',
            work_order_id='91000000000000002', reviewed_result_digest=digest(result_payload(row)), test_only=True,
            test_label=TEST_LABEL + ' / SYNTHETIC-STAGE-TEST', contract={
                'production_task_id': '91000000000000003', 'equipment_id': '91000000000000004',
                'snapshot_id': '91000000000000005', 'actor_id': '91000000000000006',
                'target_reference': 'SYNTHETIC test-only target', 'mapping_reference': 'SYNTHETIC mapping review',
                'label_reference': 'SYNTHETIC permanent-label contract', 'side_effect_reference': 'SYNTHETIC isolated tenant',
                'items': [{'local_item_id': 'dimension', 'config_row_id': '91000000000000007',
                    'write_item_id': '91000000000000008', 'group': 'SYNTHETIC-GROUP', 'seq': 1}]})

    def test_save_then_explicit_finish_and_fresh_readback(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data['mes_workflow']['phase'], 'saved')
        self.assertEqual(saved.data['mes_completion_status'], 'not_completed')
        self.assertEqual([call[0] for call in self.stage.calls], ['save'])
        self.assertEqual(self.stage.calls[0][2][0]['checkItemId'], '91000000000000008')
        self.assertTrue(saved.data['mes_workflow']['can_finish'])
        finished = self.action(saved.data, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual(finished.data['mes_completion_status'], 'completed')
        self.assertFalse(finished.data['mes_workflow']['can_finish'])
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])
        self.binding.refresh_from_db()
        self.assertEqual(len(self.binding.evidence_digest), 64)
        self.assertEqual(finished.data['injection_receipt_readiness'], 'not_verified')

    def test_finish_before_saved_and_legacy_sync_are_rejected(self):
        self.assertEqual(self.action(self.data, 'mes-finish').status_code, 409)
        self.assertEqual(self.action(self.data, 'sync').status_code, 409)
        self.assertEqual(self.stage.calls, [])

    def test_exact_key_replay_and_new_key_duplicate_never_write_again(self):
        key = uuid.uuid4()
        saved = self.action(self.data, 'mes-save', key=key)
        self.assertEqual(self.action(self.data, 'mes-save', key=key).data, saved.data)
        self.assertEqual(self.action(saved.data, 'mes-save').status_code, 409)
        self.assertEqual(self.action(self.data, 'mes-save', key=key, reason='changed').status_code, 409)
        self.assertEqual(len(self.stage.calls), 1)

    def test_timeout_after_save_reconciles_values_without_resending(self):
        self.stage.timeout = 'save'
        key = uuid.uuid4()
        result = self.action(self.data, 'mes-save', key=key)
        self.assertEqual(result.status_code, 503)
        self.assertNotIn('sensitive', str(result.data))
        unknown = result.data['request']
        self.assertEqual(unknown['mes_workflow']['phase'], 'save_unknown')
        self.assertEqual(self.action(unknown, 'mes-save').status_code, 409)
        resolved = self.action(unknown, 'mes-reconcile')
        self.assertEqual(resolved.status_code, 200, resolved.data)
        self.assertEqual(resolved.data['mes_workflow']['phase'], 'saved')
        replayed = self.action(self.data, 'mes-save', key=key)
        self.assertEqual(replayed.status_code, 200)
        self.assertEqual(replayed.data, resolved.data)
        self.assertEqual(len(self.stage.calls), 1)
        self.assertFalse(InspectionOperation.objects.filter(request_id=self.data['id'], status='unknown').exists())

    def test_missing_or_wrong_permanent_label_prevents_finish(self):
        saved = self.action(self.data, 'mes-save')
        self.stage.label = ''
        denied = self.action(saved.data, 'mes-finish')
        self.assertEqual(denied.status_code, 503)
        self.assertEqual([call[0] for call in self.stage.calls], ['save'])

    def test_readback_value_mismatch_is_unknown_not_saved(self):
        self.stage.overrides['records'] = []
        result = self.action(self.data, 'mes-save')
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.data['request']['mes_workflow']['phase'], 'save_unknown')
        self.assertFalse(result.data['request']['mes_workflow']['can_finish'])

    def test_exact_read_scope_and_freshness_are_required_before_write(self):
        for override in [{'identity': {}}, {'observed_at': timezone.now() - timedelta(hours=1)}]:
            self.stage.overrides = override
            result = self.action(self.data, 'mes-save')
            self.assertEqual(result.status_code, 503)
            self.assertEqual(self.stage.calls, [])
            # Test fixture reset only; production offers no browser rearm path.
            self.binding.phase = 'ready'; self.binding.save()
            self.data = result.data['request']

    def test_completed_historical_target_is_never_written(self):
        self.stage.state = 'completed'
        result = self.action(self.data, 'mes-save')
        self.assertEqual(result.status_code, 503)
        self.assertEqual(self.stage.calls, [])

    def test_unverified_mapping_and_test_target_are_rejected_before_dispatch(self):
        self.binding.test_only = False; self.binding.save()
        self.assertEqual(self.action(self.data, 'mes-save').status_code, 503)
        self.assertEqual(self.stage.calls, [])

    def test_finish_timeout_reconciles_terminal_state_without_replay(self):
        saved = self.action(self.data, 'mes-save')
        self.stage.timeout = 'finish'
        unknown = self.action(saved.data, 'mes-finish')
        self.assertEqual(unknown.status_code, 503)
        self.stage.state = 'open'
        unresolved = self.action(unknown.data['request'], 'mes-reconcile')
        self.assertEqual(unresolved.status_code, 503)
        self.stage.state = 'completed'
        resolved = self.action(unresolved.data['request'], 'mes-reconcile')
        self.assertEqual(resolved.status_code, 200, resolved.data)
        self.assertEqual(resolved.data['mes_completion_status'], 'completed')
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])

    def test_pending_writer_is_not_unlocked_by_a_racing_reconciliation(self):
        InspectionOperation.objects.create(request_id=self.data['id'], scope=f'{self.editor.pk}:{self.data["id"]}:mes-save',
            key=uuid.uuid4(), payload_digest='0' * 64)
        self.binding.phase = 'save_pending'; self.binding.save()
        self.assertEqual(self.action(self.data, 'mes-reconcile').status_code, 409)
        self.assertEqual(self.stage.calls, [])

    def test_wrong_version_and_inactive_user_cannot_dispatch(self):
        self.assertEqual(self.action(self.data, 'mes-save', version=1).status_code, 409)
        self.editor.is_active = False; self.editor.save()
        self.assertEqual(self.action(self.data, 'mes-save').status_code, 403)
        self.assertEqual(self.stage.calls, [])

    def test_same_external_target_cannot_be_bound_twice(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            other = InspectionRequest.objects.get(pk=self.data['id'])
            other.pk = None; other.identity = 'SYNTHETIC-OTHER-TARGET'; other.save()
            self.binding.pk = None; self.binding.request = other
            self.binding.save(force_insert=True)

    def test_terminal_read_requires_exact_inspection_result(self):
        saved = self.action(self.data, 'mes-save')
        self.stage.overrides['inspectionResult'] = 'fail'
        result = self.action(saved.data, 'mes-finish')
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.data['request']['mes_workflow']['phase'], 'finish_unknown')
        current = result.data['request']
        for wrong in [None, '', 'fail', 'concession', 'pending', 1, True]:
            with self.subTest(inspectionResult=wrong):
                self.stage.overrides['inspectionResult'] = wrong
                result = self.action(current, 'mes-reconcile')
                self.assertEqual(result.status_code, 503)
                current = result.data['request']
                self.assertNotEqual(current['mes_completion_status'], 'completed')
        self.stage.overrides = {}
        result = self.action(current, 'mes-reconcile')
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])

    def test_missing_result_cannot_confirm_completion_and_approval_stays_pending(self):
        saved = self.action(self.data, 'mes-save')
        read = self.stage.read
        def missing_result(binding):
            observed = read(binding)
            observed.pop('inspectionResult')
            return observed
        self.stage.read = missing_result
        unknown = self.action(saved.data, 'mes-finish')
        self.assertEqual(unknown.status_code, 503)
        self.stage.read = read
        self.stage.state = 'approval_pending'
        resolved = self.action(unknown.data['request'], 'mes-reconcile')
        self.assertEqual(resolved.status_code, 200)
        self.assertEqual(resolved.data['mes_completion_status'], 'approval_pending')
        self.assertEqual(resolved.data['injection_receipt_readiness'], 'not_verified')
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])

    def test_failed_verdict_cannot_be_reconciled_as_pass(self):
        row = InspectionRequest.objects.get(pk=self.data['id'])
        row.judgement = 'fail'; row.measurements[0]['judgement'] = 'fail'; row.save()
        self.binding.reviewed_result_digest = digest(result_payload(row)); self.binding.save()
        saved = self.action(self.data, 'mes-save')
        self.stage.overrides['inspectionResult'] = 'pass'
        unknown = self.action(saved.data, 'mes-finish')
        self.assertEqual(unknown.status_code, 503)
        self.stage.overrides = {}
        resolved = self.action(unknown.data['request'], 'mes-reconcile')
        self.assertEqual(resolved.status_code, 200)
        self.assertEqual(resolved.data['judgement'], 'fail')

    def test_pending_operation_blocks_finish_even_if_phase_is_saved(self):
        saved = self.action(self.data, 'mes-save')
        InspectionOperation.objects.create(request_id=self.data['id'],
            scope=f'{self.editor.pk}:{self.data["id"]}:mes-finish', key=uuid.uuid4(), payload_digest='0' * 64)
        denied = self.action(saved.data, 'mes-finish')
        self.assertEqual(denied.status_code, 409)
        self.assertEqual([call[0] for call in self.stage.calls], ['save'])

    def test_reviewed_failure_can_reinspect_with_audit_without_closing_case(self):
        from .inspection_models import InspectionNonconformance
        draft = self.draft(self.create(task_ref='SYNTHETIC-REINSPECT'),
            measurements=[{'item_id': 'dimension', 'value': '11', 'judgement': 'fail',
                'evidence_url': 'https://evidence.example/fail.png'}],
            judgement='fail', accepted_quantity='8.000', rejected_quantity='2.000')
        failed = self.action(draft, 'submit').data
        reviewed = self.action(failed, 'review-failure', user=self.reviewer, reason='SYNTHETIC review').data
        self.assertTrue(reviewed['capabilities']['can_reinspect'])
        key = uuid.uuid4()
        child = self.action(reviewed, 'reinspect', user=self.editor, key=key, reason='SYNTHETIC recheck')
        self.assertEqual(child.status_code, 201, child.data)
        self.assertEqual(child.data['parent'], reviewed['id'])
        self.assertEqual(child.data['status'], 'draft')
        self.assertIsNone(child.data['nonconformance'])
        self.assertEqual(self.action(reviewed, 'reinspect', key=key, reason='SYNTHETIC recheck').data, child.data)
        parent = InspectionRequest.objects.get(pk=reviewed['id'])
        self.assertEqual(parent.judgement, 'fail')
        self.assertEqual(parent.status, 'approved')
        self.assertEqual(InspectionNonconformance.objects.get(request=parent).state, 'open')
        self.assertTrue(parent.audit.filter(action='reinspect', actor=self.editor, reason='SYNTHETIC recheck').exists())
        self.assertTrue(InspectionRequest.objects.get(pk=child.data['id']).audit.filter(action='create_reinspection', actor=self.editor).exists())
        self.assertEqual(self.action({'id': parent.pk, 'version': parent.version}, 'reinspect', reason='SYNTHETIC duplicate').status_code, 409)

    def test_stale_read_never_restores_old_phase_over_new_reservation(self):
        saved = self.action(self.data, 'mes-save')
        read = self.stage.read
        def newer_reservation(binding):
            # Simulate a newer server-owned recovery/import update during I/O.
            InspectionMesBinding.objects.filter(pk=binding.pk).update(phase='finish_pending')
            InspectionRequest.objects.filter(pk=self.data['id']).update(version=saved.data['version'] + 2)
            return read(binding)
        self.stage.read = newer_reservation
        result = self.action(saved.data, 'mes-reconcile')
        self.assertEqual(result.status_code, 409)
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.phase, 'finish_pending')
        self.assertEqual([call[0] for call in self.stage.calls], ['save'])

    def test_reviewed_failure_reinspection_blocks_uncertain_mes_and_unauthorized_actor(self):
        row = InspectionRequest.objects.get(pk=self.data['id'])
        row.judgement = 'fail'; row.sync_status = 'unknown'; row.save()
        denied = self.action(self.data, 'reinspect', reason='SYNTHETIC recheck')
        self.assertEqual(denied.status_code, 409)
        row.sync_status = 'not_synced'; row.save()
        operation = InspectionOperation.objects.create(request=row,
            scope=f'{self.editor.pk}:{row.pk}:mes-finish', key=uuid.uuid4(), payload_digest='0' * 64)
        self.assertEqual(self.action(self.data, 'reinspect', reason='SYNTHETIC recheck').status_code, 409)
        operation.status = 'unknown'; operation.save()
        self.assertEqual(self.action(self.data, 'reinspect', reason='SYNTHETIC recheck').status_code, 409)
        operation.status = 'succeeded'; operation.save()
        ordinary = self.make_user('SYNTHETIC-ordinary', permissions=('manage',))
        self.assertEqual(self.action(self.data, 'reinspect', user=ordinary, reason='SYNTHETIC recheck').status_code, 403)
        self.assertEqual(self.action(self.data, 'reinspect', user=self.editor, reason='').status_code, 400)
        self.assertEqual(self.action(self.data, 'reinspect', reason='SYNTHETIC recheck').status_code, 201)

    def test_default_adapter_remains_disabled(self):
        self.patch.stop()
        self.assertEqual(self.action(self.data, 'mes-save').status_code, 503)
        self.assertEqual(self.stage.calls, [])

    def test_required_evidence_cannot_be_silently_omitted(self):
        row = InspectionRequest.objects.get(pk=self.data['id'])
        row.require_evidence = True; row.save()
        self.binding.reviewed_result_digest = digest(result_payload(row)); self.binding.save()
        self.assertEqual(self.action(self.data, 'mes-save').status_code, 503)
        self.assertEqual(self.stage.calls, [])

    def test_recorded_quantities_require_their_own_provider_mapping(self):
        row = InspectionRequest.objects.get(pk=self.data['id'])
        row.quantity_mode = 'recorded'; row.save()
        self.binding.reviewed_result_digest = digest(result_payload(row)); self.binding.save()
        self.assertEqual(self.action(self.data, 'mes-save').status_code, 503)
        self.assertEqual(self.stage.calls, [])

    def test_failed_result_can_be_independently_reviewed_without_closing_defect_followup(self):
        from .inspection_models import InspectionNonconformance
        # Distinct synthetic local request, with a recorded rejected quantity.
        draft = self.draft(self.create(work_order_ref='SYNTHETIC-FAILED-WO', task_ref='SYNTHETIC-FAILED-TASK'),
            measurements=[{'item_id': 'dimension', 'value': '11.0', 'judgement': 'fail', 'evidence_url': 'https://evidence.example/fail.png'}],
            judgement='fail', accepted_quantity='8.000', rejected_quantity='2.000')
        failed = self.action(draft, 'submit')
        self.assertEqual(failed.status_code, 200, failed.data)
        self.assertEqual(failed.data['nonconformance']['state'], 'open')
        self.assertEqual(failed.data['nonconformance']['quantity'], '2.000')
        self.assertEqual(self.action(failed.data, 'review-failure', reason='SYNTHETIC review').status_code, 403)
        reviewed = self.action(failed.data, 'review-failure', user=self.reviewer, reason='SYNTHETIC independent failure confirmation')
        self.assertEqual(reviewed.status_code, 200, reviewed.data)
        self.assertEqual(reviewed.data['status'], 'approved')
        self.assertEqual(reviewed.data['judgement'], 'fail')
        self.assertEqual(reviewed.data['nonconformance']['state'], 'open')
        self.assertFalse(reviewed.data['nonconformance']['can_execute'])
        case = InspectionNonconformance.objects.get(request_id=failed.data['id'])
        original = case.original_result_digest
        InspectionRequest.objects.filter(pk=failed.data['id']).update(mes_completion_status='completed')
        case.refresh_from_db()
        self.assertEqual(case.state, 'open')
        self.assertEqual(case.original_result_digest, original)

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest import skipUnless
from django.db import close_old_connections, connection
from rest_framework.test import APITransactionTestCase, APIClient


@skipUnless(connection.vendor == 'postgresql', 'PostgreSQL locking is required')
class InspectionMesStageConcurrencyTests(APITransactionTestCase):
    base_url = InspectionMesStageTests.base_url
    make_user = InspectionMesStageTests.make_user
    create_payload = InspectionMesStageTests.create_payload
    draft_payload = InspectionMesStageTests.draft_payload
    post = InspectionMesStageTests.post
    create = InspectionMesStageTests.create
    draft = InspectionMesStageTests.draft
    action = InspectionMesStageTests.action
    approved = InspectionMesStageTests.approved
    setUp = InspectionMesStageTests.setUp

    def test_reservation_blocks_duplicate_finish_and_racing_reconciliation(self):
        entered, release = Event(), Event()
        save = self.stage.save
        def delayed(*args):
            entered.set()
            if not release.wait(5): raise TimeoutError('SYNTHETIC test barrier')
            return save(*args)
        self.stage.save = delayed
        key = uuid.uuid4()
        def writer():
            close_old_connections()
            try:
                client = APIClient(); client.force_authenticate(self.editor)
                return client.post(self.base_url + f'{self.data["id"]}/mes-save/', {'version': self.data['version']},
                    format='json', HTTP_IDEMPOTENCY_KEY=str(key))
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(writer)
            try:
                self.assertTrue(entered.wait(5))
                pending = self.action(self.data, 'mes-save', key=key)
                self.assertEqual(pending.status_code, 202)
                current = self.client.get(self.base_url + f'{self.data["id"]}/').data
                self.assertEqual(self.action(current, 'mes-save').status_code, 409)
                self.assertEqual(self.action(current, 'mes-finish').status_code, 409)
                self.assertEqual(self.action(current, 'mes-reconcile').status_code, 409)
            finally:
                release.set()
            self.assertEqual(future.result(timeout=5).status_code, 200)
        self.assertEqual([call[0] for call in self.stage.calls], ['save'])

    def test_reconcile_first_blocks_new_finish_key_until_read_settles(self):
        saved = self.action(self.data, 'mes-save').data
        entered, release = Event(), Event()
        read = self.stage.read
        def delayed(binding):
            entered.set()
            if not release.wait(5): raise TimeoutError('SYNTHETIC read barrier')
            return read(binding)
        self.stage.read = delayed
        def reader():
            close_old_connections()
            try:
                client = APIClient(); client.force_authenticate(self.editor)
                return client.post(self.base_url + f'{saved["id"]}/mes-reconcile/', {'version': saved['version']},
                    format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(reader)
            try:
                self.assertTrue(entered.wait(5))
                current = self.client.get(self.base_url + f'{saved["id"]}/').data
                # A distinct key must not bypass the in-flight read reservation.
                self.assertEqual(self.action(current, 'mes-finish', key=uuid.uuid4()).status_code, 409)
                self.assertEqual([call[0] for call in self.stage.calls], ['save'])
            finally:
                release.set()
            result = future.result(timeout=5)
            self.assertEqual(result.status_code, 200, result.data)
        self.stage.read = read
        finished = self.action(result.data, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual(self.action(finished.data, 'mes-finish', key=uuid.uuid4()).status_code, 409)
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])
