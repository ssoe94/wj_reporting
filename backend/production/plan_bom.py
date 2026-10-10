"""Read-only, bounded MES BOM proposals for the existing plan approval snapshot.

Only the observed flat, single-process inline-material shape is supported. A BOM
version here identifies the source recipe; it does not promise MES BOM linkage.
"""
from copy import deepcopy
from decimal import Decimal
import hashlib
import json

from rest_framework.exceptions import ValidationError

from .mes_execution_contract import mes_id

BOM_LIST = '/med/open/v2/bom/_list'
BOM_DETAIL = '/med/open/v2/bom/_detail'
ROUTE_DETAIL = '/med/open/v2/process_route/_detail'
MATERIAL_LIST = '/material/open/v2/material/_list_by_codes'
RAW_CATEGORY = 'CAT-011'  # Observed tenant leaf category 原材料, not its ZC parent.
MAX_INPUTS = 20
_VOLATILE = frozenset({'creator', 'operator', 'createdAt', 'updatedAt', 'updateAt', 'queryFieldList'})


class BomReader:
    def __init__(self, actor_id):
        # Lazy import keeps plan_workflow free to import this module.
        from .plan_service_transport import PlanMesServiceTransport
        self.transport = PlanMesServiceTransport(actor_id=actor_id)

    def post(self, path, payload):
        if path not in (BOM_LIST, BOM_DETAIL, ROUTE_DETAIL, MATERIAL_LIST):
            _fail('route')
        return self.transport._post(path, payload, write=False)


def _fail(reason):
    raise ValidationError('mes_bom_' + reason)


def _object(value):
    if not isinstance(value, dict):
        _fail('shape')
    return value


def _id(value):
    if type(value) not in (int, str):
        _fail('identifier')
    try:
        return str(mes_id(value))
    except (ValueError, TypeError):
        _fail('identifier')


def _text(value, optional=False):
    from .plan_workflow import optional_text, text
    return optional_text(value) if optional else text(value)


def _decimal(value, positive=False):
    from .plan_workflow import decimal_text
    result = decimal_text(value)
    if positive and Decimal(result) <= 0:
        _fail('ratio')
    return result


def _enum(value, choices):
    code = _object(value).get('code')
    if type(code) is not int or code not in choices:
        _fail('enum')
    return code


def _empty(value):
    return value is None or isinstance(value, (dict, list)) and not value


def _read(reader, path, payload):
    body = _object(reader.post(path, payload))
    if type(body.get('code')) is not int or body['code'] != 200:
        _fail('response')
    if body.get('needCheck') is not None and (type(body['needCheck']) is not int or body['needCheck'] != 0):
        _fail('confirmation')
    permissions = body.get('fieldPermission')
    if permissions is not None and (not isinstance(permissions, dict) or permissions.get('noAccess', []) != []):
        _fail('field_permission')
    return body.get('data')


def _semantic(value):
    if isinstance(value, dict):
        return {key: _semantic(item) for key, item in value.items() if key not in _VOLATILE}
    if isinstance(value, list):
        return [_semantic(item) for item in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, float):
        _fail('inexact_number')
    return value


def _hash(bom, route):
    # Include controls and all other source fields, even ones not sent inline.
    encoded = json.dumps(_semantic({'bom': bom, 'route': route}), sort_keys=True,
                         ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _material(value, expected_id=None, expected_code=None):
    material = _object(value)
    base = _object(material.get('baseInfo'))
    identity, code = _id(base.get('id')), _text(base.get('code'))
    if expected_id is not None and identity != expected_id or expected_code is not None and code != expected_code:
        _fail('material_identity')
    if _enum(base.get('enableFlag'), (0, 1)) != 1:
        _fail('material_disabled')
    return material, base, identity, code


def _category(material):
    category = material.get('category')
    if category is None:
        return '', ''
    category = _object(category)
    return _text(category.get('code')), _text(category.get('name'))


def _unit(material, unit_id, unit_name):
    units = material.get('unitList')
    if not isinstance(units, list):
        _fail('material_unit')
    matching = [unit for unit in units if isinstance(unit, dict)
                and _id(unit.get('id')) == unit_id and unit.get('name') == unit_name]
    if len(matching) != 1 or _enum(matching[0].get('enableFlag'), (1,)) != 1:
        _fail('material_unit')


def _simple_controls(row):
    controls = row.get('bomFeedingControls')
    if controls is None:
        return
    if not isinstance(controls, list) or len(controls) > 1:
        _fail('complex_control')
    for control in controls:
        control = _object(control)
        if (_enum(control.get('inputBoundType'), (1,)) != 1
                or any(not _empty(control.get(key)) for key in (
                    'inputSopControlCode', 'inputSopControlDTO', 'inputUpperLimit', 'inputLowerLimit',
                    'inputUpperLimitRatio', 'inputLowerLimitRatio', 'singleFeedMaterialAmount'))):
            _fail('complex_control')
        for key in ('inputMaterialControl', 'backFlush'):
            _enum(control.get(key), (0, 1))
        _enum(control.get('feedType'), (0,))
        states = control.get('inputQcState')
        if not isinstance(states, list) or not states:
            _fail('complex_control')
        if len({_enum(item, (1, 2, 3, 4)) for item in states}) != len(states):
            _fail('complex_control')
        for key in ('inputAmountNumerator', 'inputAmountDenominator'):
            if Decimal(_decimal(control.get(key), positive=True)) != Decimal(_decimal(row.get(key), positive=True)):
                _fail('complex_control')


def read_bom(part_no, actor_id, *, reader=None):
    """Fetch a complete, unique enabled default BOM; return no raw provider data."""
    if type(actor_id) is not int or actor_id < 1:
        _fail('actor')
    part_no = _text(part_no)
    reader = reader if reader is not None else BomReader(actor_id)
    page = _object(_read(reader, BOM_LIST, {'materialCode': part_no, 'page': 1, 'size': 100}))
    rows, total = page.get('list'), page.get('total')
    if (type(page.get('page')) is not int or page['page'] != 1 or type(total) is not int
            or not 1 <= total <= 100 or not isinstance(rows, list) or len(rows) != total):
        _fail('list_incomplete')
    candidates, seen = [], set()
    for item in rows:
        item = _object(item)
        identity = _id(item.get('id'))
        if identity in seen:
            _fail('list_duplicate')
        seen.add(identity)
        _material(item.get('material'), _id(item.get('materialId')), part_no)
        _text(item.get('version'))
        active = _enum(item.get('status'), (0, 1))
        default = _enum(item.get('defaultVersion'), (0, 1))
        if active == default == 1:
            candidates.append(item)
    if len(candidates) != 1:
        _fail('default_ambiguous')
    selected = candidates[0]
    bom = _object(_read(reader, BOM_DETAIL, {'id': mes_id(selected['id'])}))
    if (_id(bom.get('id')) != _id(selected['id']) or _text(bom.get('version')) != selected['version']
            or _id(bom.get('materialId')) != _id(selected['materialId'])
            or _enum(bom.get('status'), (1,)) != 1 or _enum(bom.get('defaultVersion'), (1,)) != 1):
        _fail('detail_changed')
    _material(bom.get('material'), _id(bom['materialId']), part_no)
    if Decimal(_decimal(bom.get('productRate'))) != Decimal('100'):
        _fail('product_rate_unsupported')
    if _enum(bom.get('virtual'), (0,)) != 0 or bom.get('bomOutputMaterials') != []:
        _fail('complex_output')
    route_ref = _object(bom.get('processRouteSimpleVO'))
    route_id, route_code = _id(bom.get('processRouteId')), _text(route_ref.get('code'))
    if _id(route_ref.get('id')) != route_id:
        _fail('route_identity')
    route = _object(_read(reader, ROUTE_DETAIL, {'id': mes_id(route_id)}))
    if (_id(route.get('id')) != route_id or route.get('code') != route_code
            or _enum(route.get('status'), (1,)) != 1 or _enum(route.get('enableSop'), (0,)) != 0):
        _fail('route_identity')
    if _id(route.get('materialId')) != _id(bom['materialId']):
        _fail('route_material')
    processes = route.get('processes')
    if not isinstance(processes, list) or len(processes) != 1 or not _empty(route.get('relations')):
        _fail('multiple_processes')
    process = _object(processes[0])
    node_id, process_num = _id(process.get('id')), _text(process.get('processNum'))
    process_code = _text(process.get('processCode'))
    _id(process.get('processId'))
    if _enum(process.get('reportFlag'), (1,)) != 1 or Decimal(_decimal(process.get('processRatio'), True)) != 1:
        _fail('complex_process')
    output_unit, output_name = _id(bom.get('unitId')), _text(bom.get('unitName'))
    if _id(route.get('unitId')) != output_unit or _id(process.get('processUnitId')) != output_unit:
        _fail('process_unit')
    output_node = _object(bom.get('workReportProcessRouteNodeSimpleVO'))
    if (_id(bom.get('workReportProcessId')) != node_id or _id(output_node.get('id')) != node_id
            or output_node.get('processNum') != process_num):
        _fail('output_process')
    source_rows = bom.get('bomInputMaterials')
    if not isinstance(source_rows, list) or not 1 <= len(source_rows) <= MAX_INPUTS:
        _fail('input_count')
    inputs, row_ids, material_ids, material_codes, sequences = [], set(), set(), set(), set()
    for row in source_rows:
        row = _object(row)
        row_id, material_id = _id(row.get('id')), _id(row.get('materialId'))
        material, base, _, material_code = _material(row.get('material'), material_id)
        seq = row.get('seq')
        if type(seq) is not int or seq < 0 or row_id in row_ids or material_id in material_ids or material_code in material_codes or seq in sequences:
            _fail('duplicate_input')
        row_ids.add(row_id)
        material_ids.add(material_id)
        material_codes.add(material_code)
        sequences.add(seq)
        if (Decimal(_decimal(row.get('lossRate'))) != 0
                or _enum(row.get('specificProcessInput'), (1,)) != 1
                or _enum(row.get('splitProcessInput'), (0,)) != 0
                or _enum(row.get('splitSopControlInput'), (0,)) != 0
                or any(not _empty(row.get(key)) for key in ('relatedBomId', 'alternativePlanDetailVO',
                    'bomInputMaterialLines', 'weighingScheme'))):
            _fail('complex_input')
        input_node = _object(row.get('inputProcessRouteNodeSimpleVO'))
        if (_id(row.get('inputProcessId')) != node_id or _id(input_node.get('id')) != node_id
                or input_node.get('processNum') != process_num):
            _fail('input_process')
        _simple_controls(row)
        category_code, category_name = _category(material)
        unit_id, unit_name = _id(row.get('unitId')), _text(row.get('unitName'))
        _unit(material, unit_id, unit_name)
        inputs.append({'source_row_id': row_id, 'seq': seq, 'material_id': material_id,
            'material_code': material_code, 'material_name': _text(base.get('name')),
            'material_version': _text(row.get('version'), optional=True),
            'unit_id': unit_id, 'unit_name': unit_name,
            'numerator': _decimal(row.get('inputAmountNumerator'), True),
            'denominator': _decimal(row.get('inputAmountDenominator'), True),
            'category_code': category_code, 'category_name': category_name,
            'replaceable': category_code == RAW_CATEGORY})
    inputs.sort(key=lambda item: (item['seq'], item['source_row_id']))
    return {'id': _id(bom['id']), 'part_no': part_no, 'version': _text(bom['version']),
        'material_id': _id(bom['materialId']), 'hash': _hash(bom, route), 'inputs': inputs,
        'setup': {'bom_version': _text(bom['version']), 'process_code': process_code,
            'process_num': process_num, 'route_code': route_code, 'output_unit_id': output_unit,
            'output_unit_name': output_name, 'output_version': ''}}


def resolve_inputs(source, submitted_inputs, actor_id, *, reader=None):
    """Apply code-only overrides to trusted read_bom output, never client ratios."""
    if type(actor_id) is not int or actor_id < 1:
        _fail('actor')
    original = _object(source).get('inputs')
    if not isinstance(original, list) or not 1 <= len(original) <= MAX_INPUTS:
        _fail('source')
    if not isinstance(submitted_inputs, list) or len(submitted_inputs) != len(original):
        _fail('input_set')
    indexed = {row['source_row_id']: row for row in original}
    submitted, changes = {}, set()
    for item in submitted_inputs:
        item = _object(item)
        if set(item) != {'source_row_id', 'material_code'} or type(item.get('source_row_id')) is not str:
            _fail('input_fields')
        row_id, code = _id(item['source_row_id']), _text(item['material_code'])
        if row_id not in indexed or row_id in submitted:
            _fail('input_set')
        row = indexed[row_id]
        if code != row['material_code']:
            if row['replaceable'] is not True or row['category_code'] != RAW_CATEGORY:
                _fail('fixed_input_changed')
            changes.add(code)
        submitted[row_id] = code
    materials = {}
    if changes:
        reader = reader if reader is not None else BomReader(actor_id)
        data = _read(reader, MATERIAL_LIST, {'codes': sorted(changes), 'queryFieldList': [1, 4]})
        if not isinstance(data, list) or len(data) != len(changes):
            _fail('replacement_incomplete')
        for item in data:
            material, base, identity, code = _material(item)
            if code not in changes or code in materials or _category(material)[0] != RAW_CATEGORY:
                _fail('replacement_category')
            materials[code] = (material, base, identity)
    result = deepcopy(original)
    for row in result:
        code = submitted[row['source_row_id']]
        if code == row['material_code']:
            continue
        material, base, identity = materials[code]
        _unit(material, row['unit_id'], row['unit_name'])
        category_code, category_name = _category(material)
        row.update(material_id=identity, material_code=code, material_name=_text(base.get('name')),
            material_version=_text(material.get('version'), optional=True),
            category_code=category_code, category_name=category_name)
    if len({row['material_id'] for row in result}) != len(result) or len({row['material_code'] for row in result}) != len(result):
        _fail('duplicate_input')
    return result


def validate_source(source, actor_id, *, reader=None):
    """Re-read before use; a changed recipe needs a new human confirmation."""
    from .plan_workflow import WorkflowConflict
    source = _object(source)
    fresh = read_bom(source.get('part_no'), actor_id, reader=reader)
    if any(fresh[key] != source.get(key) for key in ('id', 'version', 'material_id', 'hash')):
        raise WorkflowConflict('mes_bom_changed')
    return fresh
