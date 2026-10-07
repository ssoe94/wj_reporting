"""Synthetic whole-result protocol checks; no MES network or credentials."""
from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.db.models import F
from django.test import TestCase
from django.utils import timezone

from .inspection_full_snapshot import (
    ExecutorAuthority, FullSnapshotCoordinator, FullSnapshotError, OWNER,
    fingerprint, remote_fingerprint, validate_source,
)
from .inspection_full_snapshot_source import DjangoCompletedSource
from .inspection_models import InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_role_models import InspectionRoleWorkflow


def synthetic_source(request_id):
    """Two inspectors, separate item/completion recorders, and past actors."""
    recorded = (timezone.now() - timedelta(minutes=2)).isoformat()
    completed = (timezone.now() - timedelta(minutes=1)).isoformat()
    areas = []
    for area, item_id, inspector_id, value, recorder_id in (
        ('appearance', 'A', 101, '10.1', 301),
        ('dimension', 'B', 202, '20.1', 302),
    ):
        inspector = {'id': inspector_id, 'name': f'SYNTHETIC inspector {inspector_id}'}
        areas.append({
            'area': area, 'version': 3, 'status': 'complete', 'assigned': inspector,
            'completion': {
                'inspector': deepcopy(inspector),
                'recorder': {'id': 401, 'name': 'SYNTHETIC completion recorder'},
                'at': completed,
            },
            'judgement': 'pass', 'measurements': [{'item_id': item_id, 'value': value}],
            'evidence': [], 'authorship': {item_id: {
                'inspector_id': inspector_id, 'inspector_name': inspector['name'],
                'recorded_by_id': recorder_id,
                'recorded_by_name': f'SYNTHETIC item recorder {recorder_id}',
                'recorded_at': recorded,
            }},
        })
    return {
        'request_id': request_id, 'request_version': 1, 'config_version': 7,
        'request_status': 'draft', 'workflow_status': 'completed', 'new_role_only': True,
        'quantity_mode': 'not_recorded',
        'quantities': {'inspected': '0', 'accepted': '0', 'rejected': '0'},
        'require_evidence': False, 'evidence': [], 'judgement': 'pass',
        'shift_snapshot': {'id': 15, 'name': 'SYNTHETIC historical shift'},
        'actor_snapshot': {'reviewer_id': 501, 'recorded_name': 'SYNTHETIC historical reviewer'},
        'terminal': {'id': 601, 'name': 'SYNTHETIC shared terminal operator'},
        'items': [{'id': 'A', 'evidence_required': False}, {'id': 'B', 'evidence_required': False}],
        'item_areas': {'A': 'appearance', 'B': 'dimension'}, 'areas': areas,
        'historical_contributors': [{
            'id': 17, 'actor_id': 701, 'actor_name': 'SYNTHETIC earlier contributor',
            'action': 'role_appearance_reopen', 'version': 2, 'at': recorded,
        }],
    }


class FixtureSource:
    def __init__(self, data):
        self.data = deepcopy(data)
        self.captures = 0
        self.on_capture = None

    def capture(self, request):
        self.captures += 1
        if self.on_capture:
            self.on_capture(self.captures)
        result = deepcopy(self.data)
        result['request_version'] = request.version
        return result


class FixtureAdapter:
    """A synthetic provider with CAS, not an assertion about the live API."""
    enabled = True
    concurrency_mode = 'provider_cas'

    def __init__(self):
        self.remote = {
            'tenant': 'SYNTHETIC-TENANT', 'qc_id': '1001', 'snapshot_id': '1002',
            'executor_id': '501', 'config_digest': fingerprint({'synthetic_config': 7}),
            'config_keys': [
                {'config_row_id': '1101', 'group': 'SYNTHETIC', 'seq': 1},
                {'config_row_id': '1102', 'group': 'SYNTHETIC', 'seq': 1},
            ],
            'records': [], 'state': 'open', 'verdict': None, 'end_time': None,
            'observed_at': timezone.now().isoformat(),
        }
        self.reads = 0
        self.calls = []
        self.on_read = None
        self.before_save = None
        self.after_save = None
        self.after_finish = None
        self.save_timeout = False
        self.finish_timeout = False

    def read(self, binding, authority):
        self.reads += 1
        if self.on_read:
            self.on_read(self.reads)
        result = deepcopy(self.remote)
        result['observed_at'] = timezone.now().isoformat()
        return result

    def _cas(self, expected):
        self.remote['observed_at'] = timezone.now().isoformat()
        if remote_fingerprint(self.remote) != expected:
            raise FullSnapshotError('synthetic_provider_cas_conflict')

    def guarded_save(self, binding, intent, expected, operation_id, authority):
        if self.before_save:
            self.before_save()
        self._cas(expected)
        self.calls.append(('save', operation_id, deepcopy(intent['payload'])))
        now_ms = int(timezone.now().timestamp() * 1000)
        self.remote['records'] = [dict(
            row, record_id=str(1201 + index), operator_id=authority.mes_user_id,
            created_at=now_ms - 10, updated_at=now_ms,
        ) for index, row in enumerate(intent['expected_records'])]
        if self.after_save:
            self.after_save()
        if self.save_timeout:
            raise TimeoutError('synthetic timeout after provider accepted whole save')

    def guarded_finish(self, binding, intent, expected, operation_id, authority):
        self._cas(expected)
        self.calls.append(('finish', operation_id, {'id': int(binding.qc_id), 'verdict': intent['verdict']}))
        self.remote.update(state='completed', verdict=intent['verdict'],
                           end_time=int(timezone.now().timestamp() * 1000))
        if self.after_finish:
            self.after_finish()
        if self.finish_timeout:
            raise TimeoutError('synthetic timeout after provider accepted finish')


class ReservedOnlyCoordinator(FullSnapshotCoordinator):
    """Simulate a worker stopping after reservation and before dispatch claim."""
    def _dispatch(self, actor, request_id, operation_id):
        return self._result(InspectionOperation.objects.get(pk=operation_id))


class FullSnapshotContractTests(TestCase):
    def setUp(self):
        self.actor = get_user_model().objects.create_user(username='SYNTHETIC-executor')
        self.other_actor = get_user_model().objects.create_user(username='SYNTHETIC-other-executor')
        self.request = InspectionRequest.objects.create(
            identity=fingerprint({'synthetic': 'whole-snapshot'}),
            work_order_ref='SYNTHETIC-WO', task_ref='SYNTHETIC-TASK',
            part_no='SYNTHETIC-PART', equipment_ref='SYNTHETIC-EQUIPMENT',
            target_quantity=0, uom='SYNTHETIC-UOM', warehouse_ref='SYNTHETIC-WAREHOUSE',
            lot_ref='SYNTHETIC-LOT', work_started_at=timezone.now(),
            quantity_mode='not_recorded', judgement='pass', assigned_to_name='',
        )
        self.binding = InspectionMesBinding.objects.create(
            request=self.request, tenant='SYNTHETIC-TENANT', qc_id='1001',
            work_order_id='', reviewed_result_digest='', test_only=True,
            test_label='SYNTHETIC FIXTURE ONLY', contract={
                'snapshot_id': '1002', 'actor_id': '501', 'items': [
                    {'local_item_id': 'A', 'config_row_id': '1101', 'write_item_id': '2101',
                     'group': 'SYNTHETIC', 'seq': 1},
                    {'local_item_id': 'B', 'config_row_id': '1102', 'write_item_id': '2102',
                     'group': 'SYNTHETIC', 'seq': 1},
                ],
            },
        )
        self.source = FixtureSource(synthetic_source(self.request.pk))
        self.source_digest = fingerprint(self.source.data)
        self.adapter = FixtureAdapter()
        self.guard_calls = []
        self.coordinator = self.make_coordinator()

    def guard(self, actor, request, binding, stage):
        # Test-only authorization; the production guard is deliberately injected.
        self.guard_calls.append((actor.pk, stage))
        return ExecutorAuthority(
            actor_id=actor.pk, mes_user_id='501', tenant=binding.tenant,
            qc_id=binding.qc_id, snapshot_id='1002',
            expires_at=timezone.now() + timedelta(minutes=5),
            review_reference='SYNTHETIC reviewed mapping',
            concurrency_reference='SYNTHETIC atomic provider CAS',
            concurrency_mode='provider_cas',
        )

    def make_coordinator(self, cls=FullSnapshotCoordinator):
        return cls(source=self.source, executor_guard=self.guard, adapter=self.adapter)

    def run_stage(self, *, actor=None, coordinator=None, key=None, stage='save', digest=None):
        return (coordinator or self.coordinator).run(
            actor or self.actor, self.request.pk, key or uuid.uuid4(),
            source_digest=digest or self.source_digest, stage=stage,
        )

    def assert_code(self, code, callback):
        with self.assertRaises(FullSnapshotError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_whole_payload_retains_all_distinct_provenance_and_detaches_mutable_source(self):
        result = self.run_stage()
        self.assertEqual(result['status'], 'succeeded')
        op = InspectionOperation.objects.get(pk=result['operation_id'])
        intent = op.response['intent']
        self.assertEqual(intent['owner'], OWNER)
        self.assertEqual(intent['payload'], {'taskId': 1001, 'checkItems': [
            {'checkItemId': 2101, 'groupName': 'SYNTHETIC', 'seq': 1, 'result': '10.1'},
            {'checkItemId': 2102, 'groupName': 'SYNTHETIC', 'seq': 1, 'result': '20.1'},
        ]})
        retained = intent['source']
        self.assertEqual(retained, self.source.data)
        self.assertEqual([row['assigned']['id'] for row in retained['areas']], [101, 202])
        self.assertEqual([row['completion']['recorder']['id'] for row in retained['areas']], [401, 401])
        self.assertEqual([row['authorship'][item]['recorded_by_id']
                          for row, item in zip(retained['areas'], ['A', 'B'])], [301, 302])
        self.assertEqual(retained['terminal']['id'], 601)
        self.assertEqual(retained['historical_contributors'][0]['actor_id'], 701)
        self.assertEqual({row['operator_id'] for row in op.response['readback']['records']}, {'501'})
        self.source.data['areas'][0]['authorship']['A']['recorded_by_name'] = 'changed later'
        op.refresh_from_db()
        self.assertEqual(op.response['intent']['source']['areas'][0]['authorship']['A']['recorded_by_name'],
                         'SYNTHETIC item recorder 301')
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])
        self.assertGreaterEqual(len(self.guard_calls), 3)

    def test_missing_item_author_is_rejected_before_reservation_or_send(self):
        self.source.data['areas'][0]['authorship'] = {}
        self.source_digest = fingerprint(self.source.data)
        self.assert_code('missing_item_provenance', self.run_stage)
        self.assertFalse(InspectionOperation.objects.exists())
        self.assertEqual(self.adapter.calls, [])

    def test_missing_completion_recorder_is_not_invented_from_inspector_or_terminal(self):
        self.source.data['areas'][0]['completion']['recorder'] = {'id': None, 'name': ''}
        self.source_digest = fingerprint(self.source.data)
        self.assert_code('missing_actor_provenance', self.run_stage)
        self.assertEqual(self.adapter.calls, [])

    def test_source_adapter_fails_closed_when_required_provenance_schema_is_absent(self):
        with patch.object(InspectionRoleWorkflow._meta, 'get_fields', return_value=[]):
            self.assert_code('provenance_schema_unavailable',
                             lambda: DjangoCompletedSource.capture(self.request))

    def test_current_baseline_without_completion_recorder_fields_cannot_capture(self):
        fields = {field.name for field in InspectionRoleWorkflow._meta.get_fields()}
        if 'shared_terminal_operator' in fields:
            self.skipTest('UI schema integrated; explicit missing-schema test still applies')
        self.assert_code('provenance_schema_unavailable',
                         lambda: DjangoCompletedSource.capture(self.request))

    def test_incomplete_or_single_inspector_source_cannot_build_a_whole_save(self):
        incomplete = deepcopy(self.source.data)
        incomplete['areas'][1]['status'] = 'draft'
        self.assert_code('areas_not_complete', lambda: validate_source(incomplete))
        same_inspector = deepcopy(self.source.data)
        second = same_inspector['areas'][1]
        second['assigned'] = deepcopy(same_inspector['areas'][0]['assigned'])
        second['completion']['inspector'] = deepcopy(second['assigned'])
        second['authorship']['B'].update(inspector_id=101, inspector_name=second['assigned']['name'])
        self.assert_code('two_inspectors_required', lambda: validate_source(same_inspector))

    def test_unmapped_mes_config_rows_cannot_be_silently_omitted(self):
        self.adapter.remote['config_keys'].append(
            {'config_row_id': '1103', 'group': 'SYNTHETIC', 'seq': 1})
        self.assert_code('unmapped_mes_rows', self.run_stage)
        self.assertEqual(self.adapter.calls, [])

    def test_remote_fingerprint_includes_author_record_id_and_raw_times(self):
        observation = deepcopy(self.adapter.remote)
        observation['records'] = [{
            'config_row_id': '1101', 'group': 'SYNTHETIC', 'seq': 1, 'value': '10.1',
            'record_id': '1201', 'operator_id': '501',
            'created_at': 1700000000000, 'updated_at': 1700000000010,
        }]
        original = remote_fingerprint(observation)
        for field, replacement in (('operator_id', '502'), ('record_id', '1301'),
                                   ('created_at', 1700000000001), ('updated_at', 1700000000011)):
            with self.subTest(field=field):
                changed = deepcopy(observation)
                changed['records'][0][field] = replacement
                self.assertNotEqual(original, remote_fingerprint(changed))
        observation['observed_at'] = timezone.now().isoformat()
        self.assertEqual(original, remote_fingerprint(observation))

    def test_same_value_remote_metadata_changes_prevent_finish(self):
        saved = self.run_stage()
        self.assertEqual(saved['status'], 'succeeded')
        original = deepcopy(self.adapter.remote)
        for field, replacement, code in (
            ('operator_id', '502', 'mes_executor_mismatch'),
            ('record_id', '1301', 'mes_concurrent_change'),
            ('updated_at', original['records'][0]['updated_at'] - 1, 'mes_concurrent_change'),
        ):
            with self.subTest(field=field):
                self.adapter.remote = deepcopy(original)
                self.adapter.remote['records'][0][field] = replacement
                self.assert_code(code, lambda: self.run_stage(stage='finish'))
                self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_durable_pending_replay_and_new_actor_key_never_dispatch_after_restart(self):
        key = uuid.uuid4()
        reserved = self.run_stage(coordinator=self.make_coordinator(ReservedOnlyCoordinator), key=key)
        self.assertEqual(reserved['status'], 'pending')
        restarted = self.make_coordinator()
        self.assertEqual(self.run_stage(coordinator=restarted, key=key), reserved)
        self.assert_code('operation_unresolved', lambda: self.run_stage(coordinator=restarted))
        self.assert_code('operation_unresolved',
                         lambda: self.run_stage(coordinator=restarted, actor=self.other_actor))
        self.assert_code('dispatch_never_claimed', lambda: restarted.reconcile(
            self.actor, self.request.pk, reserved['operation_id']))
        self.assertEqual(InspectionOperation.objects.count(), 1)
        self.assertEqual(self.adapter.calls, [])

    def test_successful_save_replay_and_new_actor_key_do_not_send_a_second_whole_save(self):
        key = uuid.uuid4()
        saved = self.run_stage(key=key)
        self.assertEqual(self.run_stage(coordinator=self.make_coordinator(), key=key), saved)
        self.assert_code('stage_already_reserved', lambda: self.run_stage())
        self.assert_code('stage_already_reserved', lambda: self.run_stage(actor=self.other_actor))
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_timeout_after_accepted_save_is_read_reconciled_without_resend(self):
        key = uuid.uuid4()
        self.adapter.save_timeout = True
        unknown = self.run_stage(key=key)
        self.assertEqual(unknown['status'], 'unknown')
        self.assertEqual(unknown['code'], 'mes_outcome_unknown')
        restarted = self.make_coordinator()
        self.assertEqual(self.run_stage(coordinator=restarted, key=key), unknown)
        self.assert_code('operation_unresolved', lambda: self.run_stage(coordinator=restarted))
        reconciled = restarted.reconcile(self.actor, self.request.pk, unknown['operation_id'])
        self.assertEqual(reconciled['status'], 'succeeded')
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.phase, 'full_saved')
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])
        self.assertEqual(InspectionOperation.objects.count(), 1)

    def test_omitted_row_after_save_is_unknown_and_never_finished_or_resent(self):
        self.adapter.after_save = lambda: self.adapter.remote['records'].pop()
        unknown = self.run_stage()
        self.assertEqual((unknown['status'], unknown['code']), ('unknown', 'whole_readback_mismatch'))
        self.assert_code('whole_readback_mismatch', lambda: self.coordinator.reconcile(
            self.actor, self.request.pk, unknown['operation_id']))
        self.assert_code('operation_unresolved', lambda: self.run_stage(stage='finish'))
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_source_config_version_changed_before_dispatch_blocks_without_write(self):
        def change_on_second_capture(count):
            if count == 2:
                self.source.data['config_version'] += 1
        self.source.on_capture = change_on_second_capture
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('blocked', 'source_changed'))
        self.assertEqual(self.adapter.calls, [])
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.phase, 'full_blocked')

    def test_remote_configuration_changed_before_dispatch_blocks_without_write(self):
        def change_on_second_read(count):
            if count == 2:
                self.adapter.remote['config_digest'] = fingerprint({'synthetic_config': 8})
        self.adapter.on_read = change_on_second_read
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('blocked', 'mes_concurrent_change'))
        self.assertEqual(self.adapter.calls, [])

    def test_source_version_changed_after_send_stays_unknown(self):
        self.adapter.after_save = lambda: InspectionRequest.objects.filter(pk=self.request.pk).update(
            version=F('version') + 1)
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'source_changed'))
        self.assert_code('source_changed', lambda: self.coordinator.reconcile(
            self.actor, self.request.pk, result['operation_id']))
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_source_config_version_changed_after_send_stays_unknown(self):
        self.adapter.after_save = lambda: self.source.data.update(config_version=8)
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'source_changed'))
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_changed_binding_phase_before_dispatch_blocks_without_overwriting_new_owner(self):
        reserved = self.run_stage(coordinator=self.make_coordinator(ReservedOnlyCoordinator))
        InspectionMesBinding.objects.filter(pk=self.binding.pk).update(phase='full_completed')
        result = self.coordinator._dispatch(self.actor, self.request.pk, reserved['operation_id'])
        self.assertEqual((result['status'], result['code']), ('blocked', 'binding_phase_changed'))
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.phase, 'full_completed')
        self.assertEqual(self.adapter.calls, [])

    def test_changed_binding_phase_after_send_preserves_concurrent_owner_state(self):
        def concurrent_owner():
            InspectionMesBinding.objects.filter(pk=self.binding.pk).update(phase='full_completed')
            InspectionRequest.objects.filter(pk=self.request.pk).update(
                sync_status='succeeded', last_error_code='concurrent_owner_record')
        self.adapter.after_save = concurrent_owner
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'binding_phase_changed'))
        self.binding.refresh_from_db()
        self.request.refresh_from_db()
        self.assertEqual(self.binding.phase, 'full_completed')
        self.assertEqual((self.request.sync_status, self.request.last_error_code),
                         ('succeeded', 'concurrent_owner_record'))
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_duplicate_private_dispatch_preserves_existing_claim_without_send(self):
        reserved = self.run_stage(coordinator=self.make_coordinator(ReservedOnlyCoordinator))
        operation = InspectionOperation.objects.get(pk=reserved['operation_id'])
        operation.response.update(state='dispatch_claimed', dispatch_at=timezone.now().isoformat())
        operation.save(update_fields=['response'])
        before = deepcopy(operation.response)
        result = self.make_coordinator()._dispatch(self.actor, self.request.pk, operation.pk)
        operation.refresh_from_db()
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(operation.response, before)
        self.assertEqual(operation.status, 'pending')
        self.assertEqual(self.adapter.calls, [])

    def test_binding_target_changed_before_dispatch_invalidates_reviewed_intent(self):
        reserved = self.run_stage(coordinator=self.make_coordinator(ReservedOnlyCoordinator))
        InspectionMesBinding.objects.filter(pk=self.binding.pk).update(qc_id='1009')
        result = self.coordinator._dispatch(self.actor, self.request.pk, reserved['operation_id'])
        self.assertEqual((result['status'], result['code']), ('blocked', 'binding_changed'))
        self.assertEqual(self.adapter.calls, [])

    def test_binding_test_scope_changed_after_send_cannot_certify_save(self):
        self.adapter.after_save = lambda: InspectionMesBinding.objects.filter(pk=self.binding.pk).update(
            test_only=False)
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'binding_changed'))
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_binding_target_changed_during_unknown_stage_cannot_be_read_reconciled(self):
        self.adapter.save_timeout = True
        unknown = self.run_stage()
        InspectionMesBinding.objects.filter(pk=self.binding.pk).update(qc_id='1009')
        self.assert_code('binding_changed', lambda: self.make_coordinator().reconcile(
            self.actor, self.request.pk, unknown['operation_id']))
        operation = InspectionOperation.objects.get(pk=unknown['operation_id'])
        self.assertEqual(operation.status, 'unknown')
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_provider_cas_prevents_change_in_final_read_to_write_gap(self):
        self.adapter.before_save = lambda: self.adapter.remote.update(
            config_digest=fingerprint({'synthetic_config': 'external concurrent revision'}))
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']),
                         ('unknown', 'synthetic_provider_cas_conflict'))
        self.assertEqual(self.adapter.calls, [])
        self.assertEqual(self.adapter.remote['records'], [])
        self.assert_code('operation_unresolved', lambda: self.run_stage())

    def test_whole_save_then_finish_preserves_result_ids_authors_and_times(self):
        saved = self.run_stage()
        self.assertEqual(saved['status'], 'succeeded')
        records = deepcopy(self.adapter.remote['records'])
        finish_key = uuid.uuid4()
        finished = self.run_stage(stage='finish', key=finish_key)
        self.assertEqual(finished['status'], 'succeeded')
        self.assertEqual(self.adapter.remote['records'], records)
        self.assertEqual([call[0] for call in self.adapter.calls], ['save', 'finish'])
        self.request.refresh_from_db()
        self.assertEqual((self.request.version, self.request.mes_completion_status), (3, 'completed'))
        replay = self.run_stage(coordinator=self.make_coordinator(), stage='finish', key=finish_key)
        self.assertEqual(replay, finished)
        self.assertEqual([call[0] for call in self.adapter.calls], ['save', 'finish'])

    def test_finish_timeout_can_be_read_reconciled_without_finishing_again(self):
        self.run_stage()
        self.adapter.finish_timeout = True
        unknown = self.run_stage(stage='finish')
        self.assertEqual(unknown['status'], 'unknown')
        result = self.make_coordinator().reconcile(self.actor, self.request.pk, unknown['operation_id'])
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual([call[0] for call in self.adapter.calls], ['save', 'finish'])

    def test_default_disabled_adapter_blocks_without_reservation_or_write(self):
        coordinator = FullSnapshotCoordinator(source=self.source, executor_guard=self.guard)
        self.assert_code('remote_concurrency_unverified', lambda: self.run_stage(coordinator=coordinator))
        self.assertFalse(InspectionOperation.objects.exists())
        self.assertEqual(self.adapter.calls, [])

    def test_missing_execution_authority_blocks_without_reservation_or_write(self):
        coordinator = FullSnapshotCoordinator(source=self.source, executor_guard=lambda *args: None,
                                              adapter=self.adapter)
        self.assert_code('executor_authority_mismatch', lambda: self.run_stage(coordinator=coordinator))
        self.assertFalse(InspectionOperation.objects.exists())
        self.assertEqual(self.adapter.calls, [])
