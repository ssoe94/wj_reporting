"""Synthetic IDs with the observed ALI BOM/route/material response shapes."""
from copy import deepcopy
from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework.exceptions import ValidationError

from .plan_bom import (BOM_DETAIL, BOM_LIST, MATERIAL_LIST, ROUTE_DETAIL,
                       read_bom, resolve_inputs, validate_source)
from .plan_workflow import WorkflowConflict

PART = 'SYNTHETIC-PART'


def enum(code):
    return {'code': code, 'message': 'synthetic'}


def material(identity, code, *, category='CAT-052', unit_id=1, unit_name='个'):
    return {'baseInfo': {'id': identity, 'code': code, 'name': code, 'enableFlag': enum(1)},
        'category': {'code': category, 'name': 'synthetic category'} if category else None,
        'categoryAllLevel': {'code': 'ZC', 'name': '资材'},
        'unitList': [{'id': unit_id, 'name': unit_name, 'enableFlag': enum(1)}]}


def input_row(identity, material_id, code, seq, numerator, *, raw=False):
    return {'id': identity, 'seq': seq, 'materialId': material_id,
        'material': material(material_id, code, category='CAT-011' if raw else 'CAT-052',
                             unit_id=2 if raw else 1, unit_name='KG' if raw else '个'),
        'unitId': 2 if raw else 1, 'unitName': 'KG' if raw else '个',
        'inputAmountNumerator': numerator, 'inputAmountDenominator': '1', 'version': None,
        'lossRate': '0.0000', 'relatedBomId': None, 'specificProcessInput': enum(1),
        'splitProcessInput': enum(0), 'splitSopControlInput': enum(0),
        'inputProcessId': 201, 'inputProcessRouteNodeSimpleVO': {'id': 201, 'processNum': '10'},
        'bomInputMaterialLines': None, 'alternativePlanDetailVO': None,
        'bomFeedingControls': [{'id': identity + 1000, 'lineSeq': 10,
            'inputAmountNumerator': numerator, 'inputAmountDenominator': '1',
            'inputBoundType': enum(1), 'inputMaterialControl': enum(1 if raw else 0),
            'backFlush': enum(1), 'feedType': enum(0), 'inputQcState': [enum(1), enum(2)]}]}


class FixtureReader:
    def __init__(self):
        self.calls = []
        self.bom = {'id': 100, 'materialId': 10, 'material': material(10, PART),
            'version': '1.0', 'status': enum(1), 'defaultVersion': enum(1), 'virtual': enum(0),
            'unitId': 1, 'unitName': '个', 'processRouteId': 200, 'productRate': '100.0000',
            'processRouteSimpleVO': {'id': 200, 'code': 'SYNTHETIC-ROUTE'},
            'workReportProcessId': 201, 'workReportProcessRouteNodeSimpleVO': {'id': 201, 'processNum': '10'},
            'bomInputMaterials': [input_row(101, 11, 'HARDWARE-A', 20, '3'),
                input_row(102, 12, 'HARDWARE-B', 30, '1'), input_row(103, 13, 'RESIN-L', 40, '0.429', raw=True)],
            'bomOutputMaterials': [], 'creator': {'name': 'not public'}, 'updatedAt': 1000}
        self.page = {'list': [{key: deepcopy(self.bom[key]) for key in
            ('id', 'materialId', 'material', 'version', 'status', 'defaultVersion')}], 'page': 1, 'total': 1}
        self.route = {'id': 200, 'code': 'SYNTHETIC-ROUTE', 'materialId': 10,
            'status': enum(1), 'enableSop': enum(0), 'unitId': 1, 'relations': [],
            'processes': [{'id': 201, 'processId': 300, 'processCode': 'ZS', 'processNum': '10',
                'reportFlag': enum(1), 'processRatio': '1', 'processUnitId': 1}]}
        self.materials = [material(14, 'RESIN', category='CAT-011', unit_id=2, unit_name='KG')]

    def post(self, path, payload):
        self.calls.append((path, deepcopy(payload)))
        data = {BOM_LIST: self.page, BOM_DETAIL: self.bom, ROUTE_DETAIL: self.route,
                MATERIAL_LIST: self.materials}[path]
        return {'code': 200, 'data': deepcopy(data), 'needCheck': None, 'fieldPermission': None}


def submitted(source, replacement=None):
    return [{'source_row_id': row['source_row_id'],
             'material_code': replacement if row['replaceable'] and replacement else row['material_code']}
            for row in source['inputs']]


class PlanBomTests(SimpleTestCase):
    def test_unverified_product_yield_is_never_treated_as_100_percent(self):
        for value in (None, '99', '101', 100.0):
            with self.subTest(value=value):
                reader = FixtureReader()
                reader.bom['productRate'] = value
                with self.assertRaises(ValidationError):
                    read_bom(PART, 1, reader=reader)

    def test_complete_recipe_has_third_raw_row_without_any_inventory_lookup(self):
        reader = FixtureReader()
        source = read_bom(PART, 1, reader=reader)
        self.assertEqual([row['source_row_id'] for row in source['inputs']], ['101', '102', '103'])
        self.assertEqual([row['replaceable'] for row in source['inputs']], [False, False, True])
        self.assertEqual([row['material_version'] for row in source['inputs']], ['', '', ''])
        self.assertEqual(source['setup'], {'bom_version': '1.0', 'process_code': 'ZS',
            'process_num': '10', 'route_code': 'SYNTHETIC-ROUTE', 'output_unit_id': '1',
            'output_unit_name': '个', 'output_version': ''})
        self.assertEqual(reader.calls, [(BOM_LIST, {'materialCode': PART, 'page': 1, 'size': 100}),
            (BOM_DETAIL, {'id': 100}), (ROUTE_DETAIL, {'id': 200})])
        self.assertNotIn('creator', source)
        self.assertNotIn('bomFeedingControls', source['inputs'][0])
        self.assertEqual([row['feeding_control'] for row in source['inputs']], [
            {'lineSeq': '10', 'inputAmountNumerator': numerator, 'feedFlag': mandatory,
             'backFlush': 1, 'inputQcState': '[1,2]', 'limit': 1}
            for numerator, mandatory in [('3', 0), ('1', 0), ('0.429', 1)]])

    def test_only_third_resin_changes_and_whole_fixed_rows_ratios_and_source_remain(self):
        reader = FixtureReader()
        source = read_bom(PART, 1, reader=reader)
        before = deepcopy(source)
        result = resolve_inputs(source, submitted(source, 'RESIN'), 1, reader=reader)
        self.assertEqual(result[:2], source['inputs'][:2])
        self.assertEqual(result[2]['material_id'], '14')
        self.assertEqual(result[2]['material_code'], 'RESIN')
        for key in ('source_row_id', 'seq', 'numerator', 'denominator', 'unit_id', 'unit_name',
                    'replaceable', 'feeding_control'):
            self.assertEqual(result[2][key], source['inputs'][2][key])
        self.assertEqual(result[2]['material_version'], '')
        self.assertEqual(source, before)
        self.assertEqual(reader.calls[-1], (MATERIAL_LIST, {'codes': ['RESIN'], 'queryFieldList': [1, 4]}))

    def test_no_override_needs_no_material_call_or_stock_presence(self):
        source = read_bom(PART, 1, reader=FixtureReader())
        with patch('production.plan_bom.BomReader', side_effect=AssertionError('No network')):
            self.assertEqual(resolve_inputs(source, submitted(source), 1), source['inputs'])

    def test_client_cannot_omit_add_duplicate_or_modify_fixed_rows_or_other_fields(self):
        source = read_bom(PART, 1, reader=FixtureReader())
        valid = submitted(source)
        bad = [valid[:-1], valid + [valid[0]], [valid[0], valid[0], valid[2]],
            [{**valid[0], 'material_code': 'OTHER'}, *valid[1:]],
            [{**valid[0], 'numerator': '0.1'}, *valid[1:]],
            [{**valid[0], 'replaceable': True}, *valid[1:]],
            [{**valid[0], 'feeding_control': {'backFlush': 0}}, *valid[1:]],
            [{**valid[0], 'source_row_id': 101}, *valid[1:]]]
        for rows in bad:
            with self.subTest(rows=rows), self.assertRaises(ValidationError):
                resolve_inputs(source, rows, 1, reader=FixtureReader())

    def test_unknown_leaf_and_common_parent_never_grant_raw_override(self):
        reader = FixtureReader()
        reader.bom['bomInputMaterials'][2]['material']['category'] = None
        source = read_bom(PART, 1, reader=reader)
        self.assertFalse(any(row['replaceable'] for row in source['inputs']))
        rows = submitted(source); rows[2]['material_code'] = 'RESIN'
        with self.assertRaises(ValidationError):
            resolve_inputs(source, rows, 1, reader=reader)

    def test_replacement_requires_exact_returned_code_unique_enabled_raw_and_matching_unit(self):
        source = read_bom(PART, 1, reader=FixtureReader())
        for change in ('category', 'disabled', 'unit_id', 'unit_name', 'unit_disabled', 'missing', 'duplicate', 'wrong_code'):
            reader = FixtureReader()
            if change == 'category': reader.materials[0]['category']['code'] = 'CAT-052'
            if change == 'disabled': reader.materials[0]['baseInfo']['enableFlag'] = enum(0)
            if change == 'unit_id': reader.materials[0]['unitList'][0]['id'] = 99
            if change == 'unit_name': reader.materials[0]['unitList'][0]['name'] = 'G'
            if change == 'unit_disabled': reader.materials[0]['unitList'][0]['enableFlag'] = enum(0)
            if change == 'missing': reader.materials = []
            if change == 'duplicate': reader.materials *= 2
            if change == 'wrong_code': reader.materials[0]['baseInfo']['code'] = 'UNREQUESTED'
            with self.subTest(change=change), self.assertRaises(ValidationError):
                resolve_inputs(source, submitted(source, 'RESIN'), 1, reader=reader)

    def test_incomplete_ambiguous_or_wrong_material_list_never_loads_detail(self):
        for change in ('truncated', 'page', 'multiple_default', 'no_default', 'wrong_part', 'duplicate_id', 'bool_total'):
            reader = FixtureReader()
            if change == 'truncated': reader.page['total'] = 2
            if change == 'page': reader.page['page'] = 2
            if change in ('multiple_default', 'duplicate_id'):
                reader.page['list'].append(deepcopy(reader.page['list'][0])); reader.page['total'] = 2
                if change == 'multiple_default': reader.page['list'][1]['id'] = 999
            if change == 'no_default': reader.page['list'][0]['defaultVersion'] = enum(0)
            if change == 'wrong_part': reader.page['list'][0]['material']['baseInfo']['code'] = 'OTHER'
            if change == 'bool_total': reader.page['total'] = True
            with self.subTest(change=change), self.assertRaises(ValidationError):
                read_bom(PART, 1, reader=reader)
            self.assertEqual(len(reader.calls), 1)

    def test_detail_route_input_identity_and_unsupported_recipe_features_fail_closed(self):
        for change in ('detail_version', 'route_id', 'process_count', 'process_unit', 'input_process',
                       'output', 'virtual', 'loss', 'split', 'sop_split', 'related_bom', 'alternative',
                       'subrows', 'duplicate_code', 'duplicate_id', 'zero_ratio', 'float_ratio', 'input_count',
                       'source_unit', 'source_unit_disabled'):
            reader = FixtureReader(); row = reader.bom['bomInputMaterials'][0]
            if change == 'detail_version': reader.bom['version'] = '2.0'
            if change == 'route_id': reader.route['id'] = 999
            if change == 'process_count': reader.route['processes'] *= 2
            if change == 'process_unit': reader.route['processes'][0]['processUnitId'] = 2
            if change == 'input_process': row['inputProcessId'] = 300  # Definition ID is not route node ID.
            if change == 'output': reader.bom['bomOutputMaterials'] = [{'id': 999}]
            if change == 'virtual': reader.bom['virtual'] = enum(1)
            if change == 'loss': row['lossRate'] = '0.01'
            if change == 'split': row['splitProcessInput'] = enum(1)
            if change == 'sop_split': row['splitSopControlInput'] = enum(1)
            if change == 'related_bom': row['relatedBomId'] = 900
            if change == 'alternative': row['alternativePlanDetailVO'] = {'id': 900}
            if change == 'subrows': row['bomInputMaterialLines'] = [{'id': 900}]
            if change == 'duplicate_code': row['material']['baseInfo']['code'] = 'HARDWARE-B'
            if change == 'duplicate_id': row['id'] = 102
            if change == 'zero_ratio': row['inputAmountNumerator'] = '0'
            if change == 'float_ratio': row['inputAmountNumerator'] = 0.5
            if change == 'input_count': reader.bom['bomInputMaterials'] = []
            if change == 'source_unit': row['unitName'] = 'KG'
            if change == 'source_unit_disabled': row['material']['unitList'][0]['enableFlag'] = enum(0)
            with self.subTest(change=change), self.assertRaises(ValidationError):
                read_bom(PART, 1, reader=reader)

    def test_complex_control_rejected_and_supported_control_change_changes_hash(self):
        reader = FixtureReader()
        initial = read_bom(PART, 1, reader=reader)
        reader.bom['bomInputMaterials'][0]['bomFeedingControls'][0]['backFlush'] = enum(0)
        changed = read_bom(PART, 1, reader=reader)
        self.assertNotEqual(initial['hash'], changed['hash'])
        self.assertEqual(initial['inputs'][0]['feeding_control']['backFlush'], 1)
        self.assertEqual(changed['inputs'][0]['feeding_control']['backFlush'], 0)
        self.assertEqual(initial['inputs'][1:], changed['inputs'][1:])
        for change in ('multiple', 'bound', 'upper', 'sop', 'different_ratio'):
            reader = FixtureReader(); row = reader.bom['bomInputMaterials'][0]
            control = row['bomFeedingControls'][0]
            if change == 'multiple': row['bomFeedingControls'] *= 2
            if change == 'bound': control['inputBoundType'] = enum(2)
            if change == 'upper': control['inputUpperLimit'] = '10'
            if change == 'sop': control['inputSopControlCode'] = 'CONTROL'
            if change == 'different_ratio': control['inputAmountNumerator'] = '99'
            with self.subTest(change=change), self.assertRaises(ValidationError):
                read_bom(PART, 1, reader=reader)

    def test_missing_unknown_or_inexact_controls_never_fall_back_to_master_defaults(self):
        for change in ('missing', 'null', 'empty', 'multiple', 'line_missing', 'line_zero',
                       'line_bool', 'line_text', 'mandatory_missing', 'mandatory_unknown',
                       'backflush_missing', 'backflush_bool', 'feed_type_unknown',
                       'qc_missing', 'qc_empty', 'qc_duplicate', 'qc_unknown',
                       'bound_missing', 'bound_unknown', 'denominator_missing', 'denominator_two'):
            reader = FixtureReader()
            row = reader.bom['bomInputMaterials'][0]
            control = row['bomFeedingControls'][0]
            if change == 'missing': del row['bomFeedingControls']
            if change == 'null': row['bomFeedingControls'] = None
            if change == 'empty': row['bomFeedingControls'] = []
            if change == 'multiple': row['bomFeedingControls'] *= 2
            if change == 'line_missing': del control['lineSeq']
            if change == 'line_zero': control['lineSeq'] = 0
            if change == 'line_bool': control['lineSeq'] = True
            if change == 'line_text': control['lineSeq'] = '10'
            if change == 'mandatory_missing': del control['inputMaterialControl']
            if change == 'mandatory_unknown': control['inputMaterialControl'] = enum(2)
            if change == 'backflush_missing': del control['backFlush']
            if change == 'backflush_bool': control['backFlush'] = enum(True)
            if change == 'feed_type_unknown': control['feedType'] = enum(1)
            if change == 'qc_missing': del control['inputQcState']
            if change == 'qc_empty': control['inputQcState'] = []
            if change == 'qc_duplicate': control['inputQcState'] = [enum(1), enum(1)]
            if change == 'qc_unknown': control['inputQcState'] = [enum(99)]
            if change == 'bound_missing': del control['inputBoundType']
            if change == 'bound_unknown': control['inputBoundType'] = enum(99)
            if change == 'denominator_missing': del control['inputAmountDenominator']
            if change == 'denominator_two':
                # Even matching parent/control ratios cannot be represented by
                # the documented control-write DTO when denominator is not 1.
                row['inputAmountDenominator'] = control['inputAmountDenominator'] = '2'
            with self.subTest(change=change), self.assertRaises(ValidationError):
                read_bom(PART, 1, reader=reader)

    def test_source_hash_ignores_query_metadata_but_detects_recipe_and_route_changes(self):
        reader = FixtureReader(); source = read_bom(PART, 1, reader=reader)
        reader.bom.update(updatedAt=2000, creator={'name': 'another person'})
        reader.bom['material']['queryFieldList'] = [1, 4]
        self.assertEqual(read_bom(PART, 1, reader=reader)['hash'], source['hash'])
        self.assertEqual(validate_source(source, 1, reader=reader)['hash'], source['hash'])
        reader.route['processes'][0]['processCode'] = 'JG'
        with self.assertRaises(WorkflowConflict):
            validate_source(source, 1, reader=reader)

    def test_read_envelope_and_actor_are_not_relaxed_by_injected_reader(self):
        reader = FixtureReader()
        for actor in (True, 0, '1'):
            with self.subTest(actor=actor), self.assertRaises(ValidationError):
                read_bom(PART, actor, reader=reader)
        for response in ({'code': 3500060}, {'code': 200, 'needCheck': True},
                         {'code': 200, 'needCheck': 1}, {'code': 200, 'fieldPermission': {'noAccess': ['id']}}):
            with patch.object(reader, 'post', return_value=response), self.assertRaises(ValidationError):
                read_bom(PART, 1, reader=reader)
