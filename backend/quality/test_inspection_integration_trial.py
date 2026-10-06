"""Synthetic standalone trial contracts; no provider traffic or production DB."""
from copy import deepcopy
from decimal import Decimal
import json
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

from django.test import override_settings
from rest_framework.test import APITestCase

from . import test_inspection_requests as helpers
from . import test_inspection_live_adapter as live_helpers
from . import test_inspection_live_readback as read_helpers
from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown
from .inspection_blacklake_contract import PLAN_BY_WORK_ORDER, ROUTE_BASE, TASK_DETAIL, TASK_FINISH, TASK_LIST, ITEM_RECORD
from .inspection_integration_trial import TRIAL_LABEL, creation_payload, identity as target_identity, trial_code
from .inspection_kanban import projection
from .inspection_live_adapter import binding_digest, load_policy
from .inspection_live_readback import decode_live_detail
from .inspection_mes_stages import binding_contract, get_stage_adapter
from .inspection_models import InspectionAudit, InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_pilot_preparation import PilotPreparationBlocked, prepare_pilot
from .inspection_transport import BlacklakeInspectionTransport
from .inspection_validation import digest
from .inspection_workflow import InspectionConflict, external_action, result_payload


class LocalIntegrationTrialTests(APITestCase):
    make_user = helpers.InspectionRequestContractTests.make_user
    url = '/api/quality/inspection-requests/integration-trial/'

    def setUp(self):
        helpers.InspectionRequestContractTests.setUp(self)
        self.payload = {'code': 'WJ-IT-SYNTHETIC-LOCAL', 'inspection_items': [{
            'id': 'dimension', 'label': 'SYNTHETIC', 'kind': 'number', 'unit': 'mm',
            'minimum': '9.5', 'maximum': '10.5', 'required': True, 'evidence_required': False}]}

    def create_trial(self, payload=None, *, user=None, key=None):
        helpers.authenticate_inspection_client(self.client, user or self.editor)
        return self.client.post(self.url, payload or self.payload, format='json',
                                HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))

    def test_local_creation_is_idempotent_blank_production_zero_quantity_and_persistent_code(self):
        key = uuid.uuid4()
        with patch('requests.sessions.Session.request', side_effect=AssertionError('No MES.')) as network:
            first = self.create_trial(key=key)
            second = self.create_trial(key=key)
        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual(second.status_code, 201, second.data)
        self.assertEqual(first.data, second.data)
        network.assert_not_called()
        row = InspectionRequest.objects.get(pk=first.data['id'])
        self.assertEqual(row.source_kind, 'integration_test')
        self.assertEqual(row.inspection_type, 'general')
        self.assertEqual(row.quantity_mode, 'not_recorded')
        self.assertEqual(row.target_quantity, Decimal('0'))
        for field in ('work_order_ref', 'task_ref', 'part_no', 'equipment_ref',
                      'warehouse_ref', 'lot_ref', 'uom'):
            self.assertEqual(getattr(row, field), '')
        self.assertEqual(row.mes_snapshot['integration_trial'], {
            'qc_code': self.payload['code'], 'test_label': TRIAL_LABEL + ' / ' + self.payload['code']})
        self.assertEqual(row.assigned_to_id, self.editor.pk)
        self.assertEqual(row.status, 'draft')
        self.assertEqual(InspectionRequest.objects.count(), 1)
        self.assertEqual(InspectionOperation.objects.count(), 1)
        self.assertEqual(InspectionAudit.objects.filter(action='create_integration_trial').count(), 1)
        self.assertFalse(InspectionMesBinding.objects.exists())

    def test_duplicate_code_and_conflicting_idempotency_payload_never_create_another_row(self):
        key = uuid.uuid4()
        first = self.create_trial(key=key)
        self.assertEqual(first.status_code, 201, first.data)
        conflict = self.create_trial(dict(self.payload, code='WJ-IT-SYNTHETIC-OTHER'), key=key)
        duplicate = self.create_trial()
        self.assertEqual(conflict.status_code, 409, conflict.data)
        self.assertEqual(duplicate.status_code, 409, duplicate.data)
        self.assertEqual(InspectionRequest.objects.count(), 1)
        self.assertEqual(InspectionOperation.objects.count(), 1)

    def test_only_active_authorized_superuser_can_create_and_method_is_post_only(self):
        manager = self.make_user('synthetic-trial-manager', permissions=('manage',))
        self.mes_user_map[str(manager.pk)] = '91000000000000099'
        hidden = self.make_user('synthetic-trial-hidden', view=False, permissions=('manage',))
        for user in (manager, hidden):
            with self.subTest(user=user.username):
                response = self.create_trial(user=user)
                self.assertEqual(response.status_code, 403, response.data)
        inactive = self.make_user('synthetic-trial-inactive', superuser=True, active=False,
                                  permissions=('manage',))
        response = self.create_trial(user=inactive)
        self.assertIn(response.status_code, (401, 403))
        helpers.authenticate_inspection_client(self.client, self.editor)
        self.assertEqual(self.client.get(self.url).status_code, 405)
        self.assertFalse(InspectionRequest.objects.exists())

    def test_local_payload_rejects_production_fields_invalid_code_and_missing_items(self):
        for payload in (dict(self.payload, work_order_ref='SYNTHETIC-WO'),
                        dict(self.payload, target_quantity='1'),
                        dict(self.payload, checkType=6), dict(self.payload, code='PLAN-SYNTHETIC'),
                        dict(self.payload, code='WJ-IT-lowercase'), {'code': self.payload['code']}):
            with self.subTest(payload=payload):
                response = self.create_trial(payload)
                self.assertEqual(response.status_code, 400, response.data)
        self.assertFalse(InspectionRequest.objects.exists())
        self.assertFalse(InspectionOperation.objects.exists())

    def test_official_creation_body_is_exact_three_fields_without_production_identity(self):
        self.assertEqual(creation_payload(config_id='91000000000000005', code=self.payload['code']),
                         {'checkType': 6, 'configId': 91000000000000005, 'code': self.payload['code']})
        for value in ('PLAN-SYNTHETIC', 'WJ-IT-', 'WJ-IT-lowercase', ' WJ-IT-A', True, None):
            with self.subTest(code=value), self.assertRaises(ValueError):
                trial_code(value)
        for value in (None, 0, True, '01'):
            with self.subTest(config=value), self.assertRaises(ValueError):
                creation_payload(config_id=value, code=self.payload['code'])

    def test_legacy_external_refresh_and_sync_are_rejected_before_any_mes_dispatch(self):
        created = self.create_trial()
        self.assertEqual(created.status_code, 201, created.data)
        self.assertFalse(created.data['capabilities']['can_refresh'])
        self.assertFalse(created.data['capabilities']['can_sync'])
        session = helpers.inspection_session(self.editor)
        with patch('quality.inspection_adapter.get_inspection_adapter', return_value=self.adapter):
            for action in ('refresh', 'sync'):
                with self.subTest(action=action), self.assertRaises(InspectionConflict) as blocked:
                    external_action(self.editor, created.data['id'], action, uuid.uuid4(),
                                    {'version': created.data['version']}, session=session)
                self.assertEqual(blocked.exception.detail['code'], 'separate_mes_stages_required')
        self.assertEqual(self.adapter.refresh_calls, [])
        self.assertEqual(self.adapter.save_calls, [])
        self.assertEqual(InspectionOperation.objects.count(), 1)


class StandaloneReadbackTests(unittest.TestCase):
    record = read_helpers.LiveReadbackTests.record
    unknown = read_helpers.LiveReadbackTests.unknown
    unavailable = read_helpers.LiveReadbackTests.unavailable

    def setUp(self):
        read_helpers.LiveReadbackTests.setUp(self)
        self.binding.work_order_id = ''
        self.binding.test_only = True
        self.binding.request = SimpleNamespace(source_kind='integration_test', inspection_type='general',
            quantity_mode='not_recorded', target_quantity=Decimal('0'), **{field: '' for field in
            ('work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'warehouse_ref', 'lot_ref', 'uom')})
        self.binding.contract.pop('production_task_id')
        self.binding.contract.pop('equipment_id')
        self.binding.contract.update(context='standalone_test', qc_code='WJ-IT-SYNTHETIC-QC',
                                     config_code='WJ-IT-SYNTHETIC-CONFIG')
        self.binding.request.identity = digest({'source_kind': 'integration_test',
                                               'code': self.binding.contract['qc_code']})
        self.binding.request.mes_snapshot = {'integration_trial': {'qc_code': self.binding.contract['qc_code']}}
        self.binding.test_label = TRIAL_LABEL + ' / ' + self.binding.contract['qc_code']
        self.contract.update(check_type=6, label_path=['code'])
        data = self.raw['data']
        data.update(code=self.binding.contract['qc_code'], checkType={'code': 6},
                    checkMaterials=[], sampleMaterials=[], **{field: None for field in
                    ('workOrder', 'produceTask', 'equipment', 'inboundOrder', 'outboundOrder', 'approvalDetail')})
        data['qcConfig'].update(checkType=6, code=self.binding.contract['config_code'], qcRange={'code': 1})

    def decode(self):
        return decode_live_detail(self.raw, binding=self.binding, detail_contract=self.contract,
                                  observed_at=read_helpers.NOW)

    def test_explicit_null_relations_empty_materials_and_exact_trial_codes_are_valid(self):
        observed = self.decode()
        self.assertEqual(observed['identity'], {'tenant': 'SYNTHETIC-TENANT',
            'qc_id': self.binding.qc_id, 'work_order_id': None, 'production_task_id': None,
            'equipment_id': None, 'snapshot_id': self.binding.contract['snapshot_id']})
        self.assertEqual(observed['state'], 'open')
        self.assertEqual(observed['test_label'], self.binding.test_label)
        self.assertEqual(observed['records'], [])

    def test_completed_and_approval_pending_keep_distinct_normalized_states(self):
        self.record(value='10.0')
        self.raw['data']['inspectionResult'] = {'code': 801}
        self.raw['data']['endTime'] = int(read_helpers.NOW.timestamp()) * 1000
        for state, code in (('completed', 703), ('approval_pending', 704)):
            with self.subTest(state=state):
                self.raw['data']['status'] = {'code': code}
                observed = self.decode()
                self.assertEqual(observed['state'], state)
                self.assertEqual(observed['inspectionResult'], 'pass')

    def test_any_production_inbound_outbound_or_approval_relation_or_missing_null_is_unknown(self):
        for field in ('workOrder', 'produceTask', 'equipment', 'inboundOrder', 'outboundOrder', 'approvalDetail'):
            original = deepcopy(self.raw)
            for value in ({'id': 91000000000000999}, {}, [], 0):
                with self.subTest(field=field, value=value):
                    self.raw['data'][field] = value
                    self.unknown()
            self.raw = deepcopy(original)
            del self.raw['data'][field]
            self.unknown()
            self.raw = original

    def test_material_arrays_must_be_present_empty_lists(self):
        for field in ('checkMaterials', 'sampleMaterials'):
            original = deepcopy(self.raw)
            for value in (None, {}, [{'id': 91000000000000999}]):
                with self.subTest(field=field, value=value):
                    self.raw['data'][field] = value
                    self.unknown()
            self.raw = deepcopy(original)
            del self.raw['data'][field]
            self.unknown()
            self.raw = original

    def test_type_range_exact_qc_and_config_code_changes_are_unknown(self):
        for root, field, value in (('data', 'code', 'WJ-IT-SYNTHETIC-OTHER'),
                                  ('config', 'code', 'WJ-IT-SYNTHETIC-OTHER'),
                                  ('data', 'checkType', 3), ('config', 'checkType', 3),
                                  ('config', 'qcRange', 2), ('config', 'qcRange', True),
                                  ('config', 'materialBatchRecordType', 2)):
            original = deepcopy(self.raw)
            with self.subTest(root=root, field=field, value=value):
                target = self.raw['data'] if root == 'data' else self.raw['data']['qcConfig']
                target[field] = value
                self.unknown()
            self.raw = original

    def test_standalone_binding_requires_trial_prefix_blank_production_and_code_label_path(self):
        for field, value in (('qc_code', 'PLAN-SYNTHETIC'), ('config_code', 'PLAN-SYNTHETIC')):
            original = deepcopy(self.binding.contract)
            self.binding.contract[field] = value
            self.unavailable()
            self.binding.contract = original
        self.contract['label_path'] = ['permanentLabel']
        self.unavailable()
        self.contract['label_path'] = ['code']
        self.binding.work_order_id = '91000000000000002'
        self.unavailable()


class StandaloneCoordinatorTests(APITestCase):
    # Reuse only helpers, never inherit/re-discover the existing workflow suite.
    base_url = live_helpers.LiveInspectionAdapterTests.base_url
    make_user = live_helpers.LiveInspectionAdapterTests.make_user
    create_payload = live_helpers.LiveInspectionAdapterTests.create_payload
    draft_payload = live_helpers.LiveInspectionAdapterTests.draft_payload
    post = live_helpers.LiveInspectionAdapterTests.post
    create = live_helpers.LiveInspectionAdapterTests.create
    draft = live_helpers.LiveInspectionAdapterTests.draft
    action = live_helpers.LiveInspectionAdapterTests.action
    approved = live_helpers.LiveInspectionAdapterTests.approved
    store_credential = live_helpers.LiveInspectionAdapterTests.store_credential
    send = live_helpers.LiveInspectionAdapterTests.send
    apply_write = live_helpers.LiveInspectionAdapterTests.apply_write
    set_records = live_helpers.LiveInspectionAdapterTests.set_records
    writes = live_helpers.LiveInspectionAdapterTests.writes
    assert_private = live_helpers.LiveInspectionAdapterTests.assert_private
    _pilot_manifest = live_helpers.LiveInspectionAdapterTests._pilot_manifest

    def setUp(self):
        live_helpers.LiveInspectionAdapterTests.setUp(self)

    def configure_vault(self):
        row = self.binding.request
        row.source_kind, row.inspection_type, row.quantity_mode = 'integration_test', 'general', 'not_recorded'
        row.target_quantity = Decimal('0')
        for field in ('work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'warehouse_ref', 'lot_ref', 'uom'):
            setattr(row, field, '')
        code = 'WJ-IT-SYNTHETIC-COORDINATOR'
        row.identity = digest({'source_kind': 'integration_test', 'code': code})
        row.notes = TRIAL_LABEL + ' / ' + code
        row.mes_snapshot = {'integration_trial': {'qc_code': code, 'test_label': row.notes}}
        row.save()
        self.binding.work_order_id = ''
        self.binding.contract.pop('production_task_id')
        self.binding.contract.pop('equipment_id')
        self.binding.contract.update(context='standalone_test', qc_code=code, config_code='WJ-IT-SYNTHETIC-CONFIG')
        self.binding.test_label = row.notes
        self.binding.reviewed_result_digest = digest(result_payload(row))
        self.binding.save()
        live_helpers.LiveInspectionAdapterTests.configure_vault(self)

    def raw_detail(self):
        return {'code': 200, 'needCheck': 0, 'data': {
            'id': int(self.binding.qc_id), 'code': self.binding.contract['qc_code'],
            **{field: None for field in ('workOrder', 'produceTask', 'equipment', 'inboundOrder',
                                        'outboundOrder', 'approvalDetail')},
            'checkMaterials': [], 'sampleMaterials': [], 'executor': {'id': self.mes_user},
            'checkType': {'code': 6}, 'status': {'code': 1}, 'inspectionResult': None, 'endTime': None,
            'qcConfig': {'snapshotId': int(self.binding.contract['snapshot_id']),
                'code': self.binding.contract['config_code'], 'qcRange': {'code': 1}, 'checkType': {'code': 6},
                'recordSample': {'code': 2}, 'recordSummaryCount': {'code': 2},
                'materialBatchRecordType': {'code': 1}, 'sampleProcessMethod': {'code': 1},
                'qcConfigCheckItemList': [{'groupName': 'SYNTHETIC-GROUP',
                    'checkItemAppDetailVOS': [{'id': 91000000000000007}]}]}, 'checkItems': []}}

    def reviewed_contract(self):
        value = live_helpers.LiveInspectionAdapterTests.reviewed_contract(self)
        value['standalone_test_reference'] = 'SYNTHETIC-STANDALONE-REVIEW'
        value['detail_contract'].update(check_type=6, label_path=['code'])
        return value

    def test_reviewed_real_coordinator_saves_verifies_finishes_verifies_trial_without_production_projection(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data['mes_workflow']['phase'], 'saved')
        self.assertEqual([route for route, _ in self.calls], [TASK_DETAIL, ITEM_RECORD, TASK_DETAIL])
        row = InspectionRequest.objects.get(pk=self.binding.request_id)
        self.assertEqual(row.mes_snapshot['verified_trial']['state'], 'open')
        finished = self.action(saved.data, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual([route for route, _ in self.calls],
                         [TASK_DETAIL, ITEM_RECORD, TASK_DETAIL, TASK_DETAIL, TASK_FINISH, TASK_DETAIL])
        row.refresh_from_db()
        self.binding.refresh_from_db()
        proof = row.mes_snapshot['verified_trial']
        self.assertEqual(proof, {'schema': 'integration-trial-observation.v1',
            'identity': {'qc_id': self.binding.qc_id}, 'state': 'completed', 'judgement': 'pass',
            'observed_at': self.binding.last_verified_at.isoformat(), 'evidence_digest': self.binding.evidence_digest})
        self.assertNotIn('verified_stage', row.mes_snapshot)
        board = projection(self.editor)
        self.assertEqual(board['counts']['requests_displayed'], 0)
        self.assertTrue(all(machine['requests'] == [] for machine in board['machines']))
        self.assertEqual(board['integration_trials'][0]['trial_verdict'], 'pass')
        self.assertEqual(board['integration_trials'][0]['qc_code'], self.binding.contract['qc_code'])
        self.assertIs(board['integration_trials'][0]['production_counted'], False)
        self.assertEqual(self.identity.userinfo.call_count, 6)
        self.assert_private(finished)

    def test_standalone_policy_requires_explicit_reference_type6_code_label_and_blank_workorder(self):
        self.assertTrue(load_policy().matches(self.binding))
        self.assertTrue(get_stage_adapter(user=self.editor, session=self.session).enabled)
        bad_policies = []
        missing = deepcopy(self.contract)
        missing.pop('standalone_test_reference')
        bad_policies.append(missing)
        for changes in ({'work_order_id': '91000000000000002'}, {'board_binding': {}},
                        {'standalone_test_reference': ''}):
            bad_policies.append(dict(self.contract, **changes))
        for changes in ({'check_type': 3}, {'label_path': ['remark']}):
            value = deepcopy(self.contract)
            value['detail_contract'].update(changes)
            bad_policies.append(value)
        for value in bad_policies:
            with self.subTest(policy=value), override_settings(MES_INSPECTION_CONTRACT=json.dumps(value)):
                self.assertFalse(get_stage_adapter(user=self.editor, session=self.session).enabled)
        with override_settings(MES_INSPECTION_ENABLED=False):
            self.assertFalse(get_stage_adapter(user=self.editor, session=self.session).enabled)
        self.assertEqual(self.calls, [])
        self.identity.userinfo.assert_not_called()

    def test_target_guard_rejects_production_references_quantity_and_changed_local_code(self):
        self.assertEqual(binding_contract(self.binding, self.binding.request), [{
            'checkItemId': '91000000000000008', 'groupName': 'SYNTHETIC-GROUP', 'seq': 1, 'result': '10.0'}])
        row = self.binding.request
        for field, value in [(field, 'SYNTHETIC-PRODUCTION') for field in
                             ('work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'warehouse_ref', 'lot_ref', 'uom')] + [
                                 ('target_quantity', Decimal('1')), ('quantity_mode', 'recorded'),
                                 ('source_kind', 'local_manual'), ('inspection_type', 'first'),
                                 ('identity', 'SYNTHETIC-OTHER-IDENTITY'), ('mes_snapshot', {})]:
            original = getattr(row, field)
            with self.subTest(field=field):
                setattr(row, field, value)
                with self.assertRaises(MesContractUnavailable):
                    binding_contract(self.binding, row)
                if field == 'source_kind':
                    with self.assertRaises(ValueError):
                        target_identity(self.binding)
            setattr(row, field, original)
        for field, value in (('work_order_id', '91000000000000002'), ('test_only', False),
                             ('test_label', TRIAL_LABEL + ' / WJ-IT-OTHER')):
            original = getattr(self.binding, field)
            with self.subTest(binding=field):
                setattr(self.binding, field, value)
                with self.assertRaises(MesContractUnavailable):
                    binding_contract(self.binding, row)
            setattr(self.binding, field, original)

    def test_mismatched_value_readback_cannot_create_verified_trial_or_enable_finish(self):
        def wrong_value(index):
            if index == 2:
                self.set_records('9.9')
        self.on_detail = wrong_value
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 503, saved.data)
        current = saved.data['request']
        row = InspectionRequest.objects.get(pk=self.binding.request_id)
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.phase, 'save_unknown')
        self.assertIsNone(self.binding.last_verified_at)
        self.assertNotIn('verified_trial', row.mes_snapshot)
        self.assertIsNone(projection(self.editor)['integration_trials'][0]['trial_verdict'])
        finished = self.action(current, 'mes-finish')
        self.assertEqual(finished.status_code, 409, finished.data)
        self.assertEqual([route for route, _ in self.writes()], [ITEM_RECORD])

    def test_approval_pending_verified_readback_never_publishes_final_trial_pass(self):
        def approval_pending(index):
            if index == 4:
                self.source['data']['status'] = {'code': 4}
        self.on_detail = approval_pending
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        finished = self.action(saved.data, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual(finished.data['mes_completion_status'], 'approval_pending')
        row = InspectionRequest.objects.get(pk=self.binding.request_id)
        self.binding.refresh_from_db()
        proof = row.mes_snapshot['verified_trial']
        self.assertEqual(proof['state'], 'approval_pending')
        self.assertEqual(proof['evidence_digest'], self.binding.evidence_digest)
        self.assertEqual(proof['observed_at'], self.binding.last_verified_at.isoformat())
        trial = projection(self.editor)['integration_trials'][0]
        self.assertIsNone(trial['trial_verdict'])
        self.assertEqual(trial['observed_at'], proof['observed_at'])

    def test_trial_request_cannot_be_reinterpreted_as_a_production_binding_or_manifest(self):
        manifest = self._pilot_manifest(single=True)
        candidate = manifest['binding']
        candidate['work_order_id'] = '91000000000000002'
        for field in ('context', 'qc_code', 'config_code'):
            candidate['contract'].pop(field)
        candidate['contract'].update(production_task_id='91000000000000003', equipment_id='91000000000000004')
        row = InspectionRequest.objects.get(pk=manifest['request_id'])
        attempted = InspectionMesBinding(request=row, test_only=True, **candidate)
        with self.assertRaises(ValueError):
            target_identity(attempted)
        with self.assertRaises(MesContractUnavailable):
            binding_contract(attempted, row)
        provider = manifest['provider_contract']
        provider.pop('standalone_test_reference')
        provider.update(work_order_id=candidate['work_order_id'], binding_digest=binding_digest(attempted))
        provider['detail_contract'].update(check_type=3, label_path=['remark'])
        with override_settings(MES_INSPECTION_ENABLED=False):
            with self.assertRaises(PilotPreparationBlocked):
                prepare_pilot(manifest, apply=True, allow_single_actor_test=True)
        row.refresh_from_db()
        self.assertEqual(row.status, 'submitted')
        self.assertIsNone(row.reviewed_by_id)
        self.assertFalse(InspectionMesBinding.objects.exists())
        self.assertFalse(InspectionAudit.objects.filter(action='prepare_single_actor_test').exists())
        self.assertEqual(self.calls, [])

    def test_standalone_transport_cannot_read_production_list_or_plan(self):
        sender = unittest.mock.Mock()
        provider = unittest.mock.Mock()
        transport = BlacklakeInspectionTransport(None, qc_task_id=self.binding.qc_id,
            standalone_test=True, token_provider=provider, sender=sender)
        for route, body in (
                (ROUTE_BASE + PLAN_BY_WORK_ORDER, {'workOrderId': 91000000000000002, 'checkType': 3}),
                (ROUTE_BASE + TASK_LIST, {'workOrderIds': [91000000000000002], 'checkType': 3, 'page': 1, 'size': 25})):
            with self.subTest(route=route), self.assertRaisesRegex(
                    ValueError, r'^Standalone trials only read their exact QC detail\.$'):
                transport.post_json(route, json.dumps(body))
        sender.assert_not_called()
        provider.assert_not_called()

    def test_single_actor_preparation_is_explicit_then_same_reviewed_user_can_save_finish(self):
        manifest = self._pilot_manifest(single=True)
        with override_settings(MES_INSPECTION_ENABLED=False):
            with self.assertRaises(PilotPreparationBlocked):
                prepare_pilot(manifest, apply=True)
            preview = prepare_pilot(manifest, apply=False, allow_single_actor_test=True)
            self.assertTrue(preview['dry_run'])
            self.assertFalse(InspectionMesBinding.objects.exists())
            applied = prepare_pilot(manifest, apply=True, allow_single_actor_test=True)
        self.assertTrue(applied['prepared'])
        self.binding = InspectionMesBinding.objects.get(request_id=manifest['request_id'])
        row = self.binding.request
        self.assertEqual(row.reviewed_by_id, self.editor.pk)
        self.assertEqual(row.submitted_by_id, self.editor.pk)
        self.assertEqual(row.review_reason, 'single_actor_test:SYNTHETIC-OWNER-SINGLE-QC')
        self.data['version'] = row.version
        with override_settings(MES_INSPECTION_CONTRACT=json.dumps(manifest['provider_contract'])):
            saved = self.action(self.data, 'mes-save')
            self.assertEqual(saved.status_code, 200, saved.data)
            finished = self.action(saved.data, 'mes-finish')
            self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual(finished.data['mes_completion_status'], 'completed')
        self.assert_private(finished)
