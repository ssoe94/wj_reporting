from copy import deepcopy
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from django.test import SimpleTestCase
from rest_framework.exceptions import ValidationError

from .plan_bom import MATERIAL_LIST
from .plan_master_gaps import read_master_gaps
from .plan_workflow_transport import PlanTransportError


def plan(code='SYNTHETIC-PART', spec='B/C', identity=1, **changes):
    return SimpleNamespace(**{'pk': identity, 'work_uid': UUID(int=identity), 'work_version': 2,
        'plan_date': date(2026, 10, 10), 'plan_type': 'injection', 'part_no': code,
        'part_spec': spec, 'model_name': 'SYNTHETIC-MODEL', 'machine_name': 'SYNTHETIC-IMM',
        'lot_no': 'SYNTHETIC-LOT', **changes})


def master(code='SYNTHETIC-PART', spec=None, category=None, identity=17000000000000001):
    return {'baseInfo': {'id': identity, 'code': code, 'specification': spec}, 'category': category,
        'categoryAllLevel': None, 'creator': {'name': 'must not escape'}}


class Reader:
    def __init__(self, rows=None, response=None):
        self.calls = []
        self.rows = rows
        self.response = response

    def post(self, path, payload):
        self.calls.append((path, deepcopy(payload)))
        if self.response is not None:
            return deepcopy(self.response)
        data = self.rows if self.rows is not None else [master(code, identity=17000000000000001 + int(code[1:]))
            for code in payload['codes']]
        return {'code': 200, 'data': deepcopy(data), 'needCheck': None, 'fieldPermission': None}


class PlanMasterGapTests(SimpleTestCase):
    def test_dedupes_parts_preserves_saved_sources_and_keeps_exact_mes_ids(self):
        reader = Reader([master()])
        plans = [plan(), plan(spec=' B/C ', identity=2, model_name='ANOTHER-MODEL', lot_no='LOT-2')]
        result = read_master_gaps(plans, 9, reader)
        row = result['rows'][0]
        self.assertEqual(reader.calls, [(MATERIAL_LIST, {'codes': ['SYNTHETIC-PART'], 'queryFieldList': [1, 4]})])
        self.assertEqual(row['source_specs'], ['B/C'])
        self.assertFalse(row['source_spec_conflict'])
        self.assertEqual(row['spec_state'], 'blank_candidate')
        self.assertEqual(row['spec_candidate'], 'B/C')
        self.assertEqual(row['category_state'], 'decision_required')
        self.assertIsNone(row['category_candidate'])
        self.assertEqual(row['mes']['material_id'], '17000000000000001')
        self.assertEqual(row['sources'][1]['part_spec'], ' B/C ')
        self.assertEqual(row['sources'][1]['model_name'], 'ANOTHER-MODEL')
        self.assertEqual(row['sources'][1]['uid'], str(UUID(int=2)))
        self.assertNotIn('creator', row['mes'])
        self.assertNotIn('excel_row', row['sources'][0])
        self.assertTrue(result['checked_at'])

    def test_conflicting_specs_never_choose_one_and_model_is_not_a_spec_fallback(self):
        row = read_master_gaps([plan(spec='B/C'), plan(spec='B/C完', identity=2)], 1, Reader([master()]))['rows'][0]
        self.assertTrue(row['source_spec_conflict'])
        self.assertEqual(row['source_specs'], ['B/C', 'B/C完'])
        self.assertEqual(row['spec_state'], 'source_conflict')
        self.assertIsNone(row['spec_candidate'])
        row = read_master_gaps([plan(spec=None)], 1, Reader([master()]))['rows'][0]
        self.assertEqual(row['spec_state'], 'source_missing')
        self.assertIsNone(row['spec_candidate'])

    def test_preserves_existing_spec_and_category_even_when_they_differ_from_confirmed_values(self):
        category = {'code': 'EXISTING', 'name': 'Existing classification', 'private': 'ignored'}
        provider = master('ACQ30854202', ' Existing SPEC ', category)
        before = deepcopy(provider)
        row = read_master_gaps([plan('ACQ30854202')], 1, Reader([provider]))['rows'][0]
        self.assertEqual(row['mes']['specification'], ' Existing SPEC ')
        self.assertEqual(row['mes']['category'], {'code': 'EXISTING', 'name': 'Existing classification'})
        self.assertEqual((row['spec_state'], row['category_state']), ('existing', 'existing'))
        self.assertIsNone(row['spec_candidate'])
        self.assertIsNone(row['category_candidate'])
        self.assertEqual(row['confirmed_category']['code'], 'CAT-000')
        self.assertEqual(provider, before)

    def test_only_four_exact_user_confirmed_parts_have_category_candidates(self):
        expected = {'ACQ30776301': 'CAT-010', 'ACQ30854202': 'CAT-000',
            'ACQ30854207': 'CAT-010', 'MAM66002511': 'CAT-137'}
        for code, category in expected.items():
            with self.subTest(code=code):
                row = read_master_gaps([plan(code)], 1, Reader([master(code)]))['rows'][0]
                self.assertEqual(row['category_state'], 'blank_confirmed')
                self.assertEqual(row['category_candidate']['code'], category)
        for code, spec in [('OTHER-BC', 'B/C完'), ('OTHER-BASE', 'BASE'), ('ACQ308542020', 'B/C')]:
            with self.subTest(code=code):
                row = read_master_gaps([plan(code, spec)], 1, Reader([master(code)]))['rows'][0]
                self.assertEqual(row['category_state'], 'decision_required')
                self.assertIsNone(row['category_candidate'])
                self.assertIsNone(row['confirmed_category'])

    def test_missing_rows_duplicate_codes_and_unrequested_codes_never_become_blanks(self):
        cases = [([], 'material_not_returned'), ([master(), master()], 'duplicate_material_code'),
            ([master('OTHER')], 'unexpected_material_code')]
        for materials, issue in cases:
            with self.subTest(issue=issue):
                row = read_master_gaps([plan()], 1, Reader(materials))['rows'][0]
                self.assertEqual((row['status'], row['issue']), ('unknown', issue))
                self.assertIsNone(row['mes'])
                self.assertIsNone(row['spec_candidate'])
                self.assertIsNone(row['category_candidate'])

    def test_partial_fields_bad_identity_or_contradictory_category_are_unknown(self):
        for change in ('spec_missing', 'category_missing', 'spec_number', 'category_empty', 'id_float', 'hierarchy_only'):
            item = master()
            if change == 'spec_missing': del item['baseInfo']['specification']
            if change == 'category_missing': del item['category']
            if change == 'spec_number': item['baseInfo']['specification'] = 12
            if change == 'category_empty': item['category'] = {}
            if change == 'id_float': item['baseInfo']['id'] = 17000000000000001.0
            if change == 'hierarchy_only': item['categoryAllLevel'] = {'code': 'CP', 'name': '成品'}
            with self.subTest(change=change):
                row = read_master_gaps([plan()], 1, Reader([item]))['rows'][0]
                self.assertEqual(row['status'], 'unknown')
                self.assertIsNone(row['spec_candidate'])
                self.assertIsNone(row['category_candidate'])

    def test_duplicate_material_identity_invalidates_batch_but_missing_row_keeps_present_row_known(self):
        plans = [plan('A'), plan('B', identity=2)]
        rows = read_master_gaps(plans, 1, Reader([master('A'), master('B')]))['rows']
        self.assertEqual([row['issue'] for row in rows], ['duplicate_material_id'] * 2)
        rows = read_master_gaps(plans, 1, Reader([master('A')]))['rows']
        self.assertEqual([row['status'] for row in rows], ['ok', 'unknown'])

    def test_uses_batches_of_100_and_rejects_over_500_before_any_reader_or_network(self):
        plans = [plan(f'P{i:03}', identity=i + 1) for i in range(500)]
        reader = Reader()
        rows = read_master_gaps(plans, 1, reader)['rows']
        self.assertEqual(len(rows), 500)
        self.assertEqual([len(call[1]['codes']) for call in reader.calls], [100] * 5)
        self.assertTrue(all(call[0] == MATERIAL_LIST and call[1]['queryFieldList'] == [1, 4] for call in reader.calls))
        with patch('production.plan_master_gaps.BomReader') as factory, self.assertRaises(ValidationError):
            read_master_gaps(plans + [plan('P500', identity=501)], 1)
        factory.assert_not_called()

    def test_injected_reader_does_not_bypass_actor_or_saved_injection_scope_validation(self):
        reader = Reader([master()])
        for actor in (True, 0, '1'):
            with self.subTest(actor=actor), self.assertRaises(ValidationError):
                read_master_gaps([plan()], actor, reader)
        for invalid in (plan(plan_type='machining'), plan(pk=None)):
            with self.assertRaises(ValidationError): read_master_gaps([invalid], 1, reader)
        self.assertEqual(reader.calls, [])
        with patch('production.plan_master_gaps.BomReader') as factory:
            self.assertEqual(read_master_gaps([], 1)['rows'], [])
            row = read_master_gaps([plan(code='')], 1)['rows'][0]
        factory.assert_not_called()
        self.assertEqual((row['status'], row['issue']), ('unknown', 'plan_part_missing'))

    def test_permission_envelope_and_transport_errors_propagate_instead_of_returning_candidates(self):
        for response in ({'code': 3500060, 'data': []}, {'code': 200, 'data': [], 'needCheck': 1},
                         {'code': 200, 'data': [], 'fieldPermission': {'noAccess': ['specification']}},
                         {'code': 200, 'data': None}):
            with self.subTest(response=response), self.assertRaises(ValidationError):
                read_master_gaps([plan()], 1, Reader(response=response))
        with patch.object(Reader, 'post', side_effect=PlanTransportError('provider_unavailable')):
            with self.assertRaises(PlanTransportError): read_master_gaps([plan()], 1, Reader())

    def test_default_reader_receives_authenticated_actor_and_only_material_read_route(self):
        reader = Reader([master()])
        with patch('production.plan_master_gaps.BomReader', return_value=reader) as factory:
            read_master_gaps([plan()], 23)
        factory.assert_called_once_with(23)
        self.assertEqual([path for path, _ in reader.calls], [MATERIAL_LIST])
