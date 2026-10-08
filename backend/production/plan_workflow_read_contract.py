"""Five bounded reads of the complete WO, independent of a daily report window.

Official docs: 1686655055663531, 3539, 3541, 3542. Creation verification
does not establish net inbound/report totals or task amendment permissions.
"""
from datetime import datetime, timezone
from decimal import Decimal

from .mes_execution_contract import mes_id, MesExecutionContractError, encode_exact_json

READ_ROUTES = {
    'base': '/med/open/v2/work_order/base/_detail',
    'inputs': '/med/open/v2/work_order/input_material/_detail',
    'outputs': '/med/open/v2/work_order/output/_detail',
    'processes': '/med/open/v2/work_order/process_plan/_detail',
}


class PlanReadContractError(MesExecutionContractError):
    pass


def require(good):
    if not good:
        raise PlanReadContractError('Complete reviewed work-order evidence is required.')


def identifier(value):
    require(type(value) in (int, str))
    return str(mes_id(value))


def amount(value):
    require(type(value) in (int, str, Decimal))
    from .plan_workflow import decimal_text
    return Decimal(decimal_text(value))


def epoch(value):
    require(type(value) is int and 0 < value < 4_102_444_800_000)
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def reviewed_binding(review, intent):
    """Exact server-supplied master IDs and literal tenant custom-field encoding.

    Never infer a mold/BOM version field or read/write enum conversion. Values
    are reviewed against this whole setup fingerprint, not supplied by HTTP.
    """
    from .plan_workflow import text, exact_id
    require(isinstance(review, dict))
    setup = intent['setup']
    binding = (review.get('setup_bindings') or {}).get(intent['setup_fingerprint'])
    require(isinstance(binding, dict) and binding.get('mold_code') == setup['mold_code']
            and binding.get('bom_version') == setup['bom_version']
            and binding.get('part_no') == intent['part_no'] and binding.get('machine_name') == intent['machine_name'])
    text(review.get('tenant'), 128)
    for key in ('resource_id', 'output_material_id'):
        exact_id(binding.get(key))
    for key in ('read_manual_warehousing', 'read_no_auto_warehousing'):
        require(type(binding.get(key)) is int)
    require(binding.get('base_clock_covers_children') is True)
    fields = []
    for key in ('mold_field', 'bom_version_field'):
        row = binding.get(key)
        require(isinstance(row, dict) and set(row) == {'fieldCode', 'fieldValue'}
                and isinstance(row['fieldValue'], dict) and bool(row['fieldValue']))
        text(row['fieldCode'])
        fields.append(row)
    require(fields[0]['fieldCode'] != fields[1]['fieldCode'])
    encode_exact_json(fields)
    return binding, fields


def read_request(code, work_order_id=None):
    payload = {'workOrderCode': code, 'warehouseFlag': False}
    if work_order_id:
        payload['workOrderId'] = mes_id(work_order_id)
    return payload


def data(body):
    require(isinstance(body, dict) and type(body.get('code')) is int and body['code'] == 200
            and body.get('needCheck') in (None, 0) and type(body.get('needCheck')) is not bool)
    permissions = body.get('fieldPermission')
    if permissions is not None:
        require(isinstance(permissions, dict) and permissions.get('noAccess') == [])
    return body.get('data')


def verify_creation(intent, contract, responses, *, expected_id=''):
    """Exact snapshot comparison; returns only creation evidence, never totals."""
    setup, payload, binding = intent['setup'], contract['payload'], contract['readback_binding']
    before, after = data(responses['base']), data(responses['base_after'])
    require(isinstance(before, dict) and isinstance(after, dict))
    work_id = identifier(before.get('id'))
    require(not expected_id or work_id == expected_id)
    # updatedAt brackets independent reads. Missing clocks or any changed base
    # object fail closed rather than mixing concurrent provider snapshots.
    require(before == after and type(before.get('updatedAt')) is int and before['updatedAt'] > 0)
    require(before.get('code') == payload['code'] and before.get('identifier') == payload['identifier']
            and before.get('externalOrderCode') == payload['externalOrderCode']
            and epoch(before.get('plannedStartTime')) == epoch(payload['planStartTime'])
            and epoch(before.get('plannedFinishTime')) == epoch(payload['planFinishTime'])
            and type(before.get('specifiedMaterial')) is int and before['specifiedMaterial'] == 1
            and type((before.get('status') or {}).get('code')) is int
            and before['status']['code'] == payload['status'])
    resource = before.get('resource') or {}
    require(identifier(resource.get('id')) == binding['resource_id']
            and resource.get('code') == setup['resource_code'])
    actual_fields = before.get('customFields')
    require(isinstance(actual_fields, list))
    for expected in payload['customFields']:
        found = [row for row in actual_fields if isinstance(row, dict) and row.get('fieldCode') == expected['fieldCode']]
        require(len(found) == 1 and found[0].get('fieldValue') == expected['fieldValue'])
    inputs = data(responses['inputs'])
    require(isinstance(inputs, list) and len(inputs) == len(setup['inputs']) <= 20)
    found_ids = set()
    for row in inputs:
        require(isinstance(row, dict))
        material = (row.get('material') or {}).get('baseInfo') or {}
        row_id = identifier(row.get('materialId'))
        require(row_id not in found_ids and identifier(material.get('id')) == row_id)
        found_ids.add(row_id)
        expected = next((v for v in setup['inputs'] if v['material_id'] == row_id), None)
        require(expected is not None)
        require(material.get('code') == expected['material_code'] and row.get('version') == expected['material_version']
                and identifier(row.get('unitId')) == expected['unit_id'] and row.get('unitName') == expected['unit_name']
                and amount(row.get('inputAmountNumerator')) == amount(expected['numerator'])
                and amount(row.get('inputAmountDenominator')) == amount(expected['denominator'])
                and row.get('inputProcessNum') == setup['process_num']
                and type(row.get('specificProcessInput')) is int and row['specificProcessInput'] == 1
                and type(row.get('splitSopControlInput')) is int and row['splitSopControlInput'] == 0
                and amount(row.get('lossRate')) == 0 and not row.get('workOrderAlternativePlan'))
    outputs = data(responses['outputs'])
    require(isinstance(outputs, list) and len(outputs) == 1 and isinstance(outputs[0], dict))
    output = outputs[0]
    material = (output.get('material') or {}).get('baseInfo') or {}
    require(identifier(output.get('materialId')) == binding['output_material_id']
            and identifier(material.get('id')) == binding['output_material_id'] and material.get('code') == intent['part_no']
            and type(output.get('main')) is int and output['main'] == 1 and output.get('version') == setup['output_version']
            and identifier(output.get('unitId')) == setup['output_unit_id'] and output.get('unitName') == setup['output_unit_name'])
    planned = output.get('plannedAmount') or {}
    require(amount(planned.get('amount')) == amount(intent['quantity'])
            and identifier(planned.get('unitId')) == setup['output_unit_id'] and planned.get('unitName') == setup['output_unit_name']
            and (output.get('outputProcessSimpleVO') or {}).get('processNum') == setup['process_num']
            and output.get('processRouteCode') == setup['route_code'])
    for field, key in [('autoWarehousingFlag', 'read_no_auto_warehousing'), ('warehousing', 'read_manual_warehousing')]:
        require(type(output.get(field)) is int and output[field] == binding[key])
    processes = data(responses['processes'])
    require(isinstance(processes, dict) and type(processes.get('enableSop')) is int and processes['enableSop'] == 0
            and (processes.get('originalProcessRoute') or {}).get('code') == setup['route_code']
            and processes.get('relations') == [])
    rows = processes.get('processes')
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict))
    require(rows[0].get('processCode') == setup['process_code'] and rows[0].get('processNum') == setup['process_num']
            and type(rows[0].get('reportFlag')) is int and rows[0]['reportFlag'] == payload['processPlanOpenCOs'][0]['reportFlag'])
    started = before.get('actualStartTime')
    return {'complete': True, 'scope': 'creation_snapshot', 'work_order_id': work_id,
            'work_order_code': payload['code'], 'quantity': intent['quantity'],
            'planned_start': intent['planned_start'], 'planned_end': intent['planned_end'],
            'setup_fingerprint': intent['setup_fingerprint'],
            'actual_started_at': epoch(started) if started is not None else None}
