"""Explicit synthetic field paths; no claim of verified tenant JSON schema."""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from .inspection_adapter import DisabledInspectionAdapter, get_inspection_adapter
from .inspection_models import InspectionRequest, InspectionOperation
from .inspection_read_snapshot import ReadScope, SnapshotPaths, normalize_detail, project_observations, get_read_batch

NOW = datetime(2026, 10, 3, 2, tzinfo=timezone.utc)
QC = '10000000000000001'
WORK = '10000000000000002'
TASK = '10000000000000003'
EQUIPMENT = '10000000000000004'
PATHS = SnapshotPaths(fields={
    'qc_id': ('id',), 'qc_code': ('code',), 'work_order_id': ('workOrder', 'id'),
    'production_task_id': ('produceTask', 'id'), 'equipment_id': ('equipment', 'id'),
    'snapshot_id': ('qcConfig', 'id'), 'plan_name': ('qcConfig', 'name'),
    'check_type': ('checkType',), 'snapshot_check_type': ('qcConfig', 'checkType'),
    'lifecycle': ('status',), 'judgement': ('qcStatus',),
    'production_status': ('produceTask', 'status'), 'updated_at': ('updatedAt',),
    'items': ('checkItems',),
}, item_fields={name: (name,) for name in ['item_id', 'label', 'unit', 'minimum', 'maximum', 'required', 'recorded_value', 'group', 'seq']},
    reference='synthetic-path-map-v1; not a verified Blacklake tenant schema')


def fixture(qc=QC, check_type=3):
    return {'code': 200, 'data': {'id': int(qc), 'code': 'SYNTHETIC-QC-' + qc,
        'workOrder': {'id': int(WORK)}, 'produceTask': {'id': int(TASK), 'status': {'code': 1, 'message': '执行中'}},
        'equipment': {'id': int(EQUIPMENT), 'name': '17号注塑机'},
        'qcConfig': {'id': int(qc) + 100, 'name': 'SYNTHETIC 巡检', 'checkType': {'code': check_type}},
        'checkType': {'code': check_type, 'message': '首检' if check_type == 3 else '巡检'},
        'status': {'code': 2, 'message': '已结束'}, 'qcStatus': {'code': 2, 'message': '让步合格'},
        'updatedAt': '2001-02-01 00:00:00',
        'checkItems': [{'item_id': 10000000000000101, 'label': 'SYNTHETIC width', 'unit': 'mm',
                       'minimum': Decimal('9.500'), 'maximum': '10.500', 'required': False,
                       'recorded_value': '10.000', 'group': 'A', 'seq': 1}],
        'access_token': 'DO-NOT-PROPAGATE'}}


def normalized(payload=None, **kwargs):
    payload = payload or fixture()
    return normalize_detail(payload, paths=PATHS,
        scope=ReadScope('synthetic-tenant', WORK, str(payload['data']['id'])), observed_at=NOW,
        evidence_kind='synthetic_contract_fixture', evidence_reference='synthetic-fixture-v1', **kwargs)


def batch(rows):
    return {'observations': rows, 'equipment_bindings': [{'tenant': 'synthetic-tenant', 'equipment_id': EQUIPMENT,
        'station_id': 'imm01', 'reference': 'synthetic-equipment-map'}],
        'task_bindings': [{'tenant': 'synthetic-tenant', 'production_task_id': TASK,
        'work_order_id': WORK, 'equipment_id': EQUIPMENT, 'reference': 'synthetic-task-map'}]}


class InspectionReadSnapshotTests(SimpleTestCase):
    def test_exact_ids_snapshot_type_and_decimals_without_write_identity(self):
        source = fixture()
        original = deepcopy(source)
        row = normalized(source)
        self.assertEqual(row['qc_id'], QC)
        self.assertEqual(row['kind'], 'first')
        self.assertIn('plan_name_type_mismatch', row['warnings'])
        self.assertEqual(row['lifecycle']['code'], 2)
        self.assertEqual(row['judgement']['code'], 2)
        self.assertEqual(row['items'][0]['minimum'], '9.500')
        self.assertIs(row['items'][0]['required'], False)
        self.assertFalse(row['items'][0]['write_mapping_verified'])
        self.assertNotIn('DO-NOT-PROPAGATE', str(row))
        self.assertFalse(row['physical_operation_verified'])
        self.assertFalse(row['current_state_verified'])
        self.assertEqual(row['receipt_readiness'], 'not_verified')
        self.assertEqual(source, original)

    def test_separate_plans_on_same_task_keep_first_and_periodic_qcs(self):
        rows = [normalized(), normalized(fixture('10000000000000011')), normalized(fixture('10000000000000021', 5))]
        result = project_observations(**batch(rows))
        self.assertEqual([row['kind'] for row in result['machines'][1]], ['first', 'first', 'periodic'])
        self.assertEqual(len({row['snapshot_id'] for row in result['machines'][1]}), 3)
        self.assertFalse(result['complete'])
        self.assertEqual(result['machines'][17], [], 'equipment display name is not an identity mapping')

    def test_missing_ambiguous_or_cross_scope_bindings_are_unmapped(self):
        for mutation in ['missing', 'ambiguous', 'wrong-work', 'wrong-equipment', 'wrong-tenant']:
            with self.subTest(mutation=mutation):
                value = batch([normalized()])
                if mutation == 'missing': value['equipment_bindings'] = []
                if mutation == 'ambiguous': value['equipment_bindings'] *= 2
                if mutation == 'wrong-work': value['task_bindings'][0]['work_order_id'] = '9'
                if mutation == 'wrong-equipment': value['task_bindings'][0]['equipment_id'] = '9'
                if mutation == 'wrong-tenant': value['task_bindings'][0]['tenant'] = 'other'
                result = project_observations(**value)
                self.assertEqual(len(result['unmapped']), 1)
                self.assertEqual(result['machines'][1], [])

    def test_repeated_identity_is_preserved_and_flagged_not_silently_replaced(self):
        rows = [normalized(), normalized()]
        rows[1]['judgement'] = {'code': 4, 'message': '不合格'}
        result = project_observations(**batch(rows))['machines'][1]
        self.assertEqual(len(result), 2)
        self.assertEqual(len({row['observation_key'] for row in result}), 2)
        self.assertTrue(all('repeated_qc_identity' in row['warnings'] for row in result))

    def test_conflicting_unknown_and_missing_types_never_come_from_name(self):
        for value, expected in [(5, 'unknown'), (None, 'first'), (True, 'first')]:
            source = fixture()
            source['data']['qcConfig']['checkType'] = value
            row = normalized(source)
            self.assertEqual(row['kind'], expected)
            self.assertTrue(row['warnings'])
        source = fixture()
        source['data']['checkType'] = {'code': 99, 'message': '首检'}
        self.assertEqual(normalized(source)['kind'], 'unknown')
        source['data'].pop('qcConfig')
        self.assertIsNone(normalized(source)['snapshot_id'])

    def test_invalid_envelope_scope_numeric_ids_and_unbounded_items_rejected(self):
        variants = []
        for value in [True, 1.0, '1e16', '001', 2**63]:
            source = fixture()
            source['data']['equipment']['id'] = value
            variants.append(source)
        for key, value in [('code', True), ('needCheck', 1), ('needCheck', False)]:
            source = fixture(); source[key] = value; variants.append(source)
        source = fixture(); source['data']['workOrder']['id'] = 7; variants.append(source)
        source = fixture(); source['data']['checkItems'] *= 101; variants.append(source)
        for source in variants:
            with self.subTest(source=source), self.assertRaises(ValueError): normalized(source)
        with self.assertRaises(ValueError):
            normalize_detail(fixture(), paths=PATHS, scope=ReadScope('synthetic-tenant', WORK, QC),
                observed_at=NOW.replace(tzinfo=None), evidence_kind='synthetic_contract_fixture', evidence_reference='fixture')

    def test_null_and_float_quantity_are_unknown_not_zero_or_limits(self):
        source = fixture()
        source['data']['checkItems'][0].update(minimum=9.5, maximum=None, required='false')
        row = normalized(source)
        self.assertIsNone(row['items'][0]['minimum'])
        self.assertIsNone(row['items'][0]['maximum'])
        self.assertIsNone(row['items'][0]['required'])

    def test_production_provider_and_adapter_remain_disconnected(self):
        self.assertIsNone(get_read_batch())
        self.assertIsInstance(get_inspection_adapter(), DisabledInspectionAdapter)


class InspectionReadProjectionTests(APITestCase):
    def test_authorized_kanban_adds_readonly_evidence_without_local_import_or_mutation(self):
        user = get_user_model().objects.create_user(username='synthetic-read-admin', is_superuser=True)
        self.client.force_authenticate(user)
        with patch('quality.inspection_kanban.get_read_batch', return_value=batch([normalized()])):
            response = self.client.get('/api/quality/inspection-requests/kanban/')
        self.assertEqual(response.status_code, 200)
        row = response.data['machines'][0]['mes_observations'][0]
        self.assertEqual(row['qc_id'], QC)
        self.assertTrue(row['read_only'])
        self.assertEqual(response.data['counts']['requests_displayed'], 0)
        self.assertEqual(response.data['mes_read_snapshot']['displayed'], 1)
        self.assertFalse(InspectionRequest.objects.exists())
        self.assertFalse(InspectionOperation.objects.exists())

    def test_unprivileged_api_never_calls_observation_provider(self):
        user = get_user_model().objects.create_user(username='synthetic-read-staff', is_staff=True)
        self.client.force_authenticate(user)
        with patch('quality.inspection_kanban.get_read_batch') as provider:
            response = self.client.get('/api/quality/inspection-requests/kanban/')
        self.assertEqual(response.status_code, 403)
        provider.assert_not_called()
