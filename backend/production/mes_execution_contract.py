"""Pure, bounded production/manual-inbound requests; no transport or credentials.

Server callers must obtain bindings, enum values and empty-array capabilities
from reviewed MES masters/contracts. These objects do not grant write authority.
The official contracts do not make dispatch's business id a task id, or a report
receipt proof of inventory creation. Readback and durable replay fencing belong
to the coordinator. Quantities stay Decimal through exact JSON serialization.

Primary contracts (public documentation, verified 2026-10-07):
https://v3-ali-openapi.blacklake.cn/static/api-docs-md/<id>.md
1681109889053754, 1686655055663527, 1779878826706456,
1681369551143844, 1745814197015893, 1740034784757833,
1740034662264284.
"""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from types import MappingProxyType
from typing import Mapping
import copy
import json
import re


WORK_ORDER_CREATE = '/med/open/v1/work_order/_doImport'
WORK_ORDER_DISPATCH = '/med/open/v2/work_order/_dispatch'
TASK_START = '/mfg/app/v1/produce_task/_start'
REPORTABLE_MATERIALS = '/mfg/open/v1/progress_report/_list_progress_report_materials'
PROGRESS_REPORT = '/mfg/app/v1/progress_report/_progress_report'
PRODUCTION_INVENTORY_LIST = '/mfg/open/v1/production_inventory/_list'
MANUAL_INBOUND = '/mfg/open/v1/production_inventory/_bulk_to_warehouse'
ACTION_ROUTES = MappingProxyType({
    'work_order_create': WORK_ORDER_CREATE,
    'work_order_dispatch': WORK_ORDER_DISPATCH,
    'task_start': TASK_START,
    'reportable_materials': REPORTABLE_MATERIALS,
    'progress_report': PROGRESS_REPORT,
    'production_inventory_list': PRODUCTION_INVENTORY_LIST,
    'manual_inbound': MANUAL_INBOUND,
})
_MAX_ID = 9_223_372_036_854_775_807
_MAX_AMOUNT = Decimal('1000000000000000')
_WO_ARRAYS = frozenset({
    'inputMaterialControlOpenCOs', 'inputMaterialOpenCOs',
    'outputMaterialOpenCOs', 'processPlanNodeRelationOpenCOs',
    'processPlanOpenCOs', 'workInProgressOpenCOs',
})


class MesExecutionContractError(ValueError):
    """An exact binding or supported contract field is missing/inconsistent."""


def mes_id(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise MesExecutionContractError('MES id requires an exact positive integer.')
    if not re.fullmatch(r'[1-9][0-9]{0,18}', str(value)) or int(value) > _MAX_ID:
        raise MesExecutionContractError('MES id is outside the reviewed integer range.')
    return int(value)


def _integer(value, *, minimum=0, maximum=_MAX_ID):
    if type(value) is not int or not minimum <= value <= maximum:
        raise MesExecutionContractError('Expected a bounded integer, without coercion.')
    return value


def _text(value, *, maximum=255, multiline=False):
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > maximum
            or any(ord(c) < 32 and (not multiline or c not in '\n\t') for c in value)):
        raise MesExecutionContractError('Expected nonempty bounded text without outer whitespace.')
    return value


def _decimal(value, *, precision=10):
    _integer(precision, maximum=10)
    if isinstance(value, bool) or not isinstance(value, (Decimal, int, str)):
        raise MesExecutionContractError('Use an exact decimal, never a float quantity.')
    if isinstance(value, str) and not re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?', value):
        raise MesExecutionContractError('Quantity text must be an unsigned fixed decimal.')
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError):
        raise MesExecutionContractError('Invalid exact quantity.') from None
    if not number.is_finite() or number < 0 or number > _MAX_AMOUNT:
        raise MesExecutionContractError('Quantity is outside the reviewed finite range.')
    digits = number.as_tuple().digits
    trailing_zeroes = 0
    for digit in reversed(digits):
        if digit != 0:
            break
        trailing_zeroes += 1
    if number != 0 and max(0, -number.as_tuple().exponent - trailing_zeroes) > precision:
        raise MesExecutionContractError('Quantity exceeds the verified unit precision; no rounding is allowed.')
    return number


def _decimal_text(value):
    if value == 0:
        return '0'
    rendered = format(value, 'f')
    if '.' in rendered:
        rendered = rendered.rstrip('0').rstrip('.')
    return rendered


@dataclass(frozen=True)
class ExactQuantity:
    amount: Decimal | str | int
    unit_id: int | str
    precision: int

    def __post_init__(self):
        object.__setattr__(self, 'amount', _decimal(self.amount, precision=self.precision))
        object.__setattr__(self, 'unit_id', mes_id(self.unit_id))

    def require_positive(self):
        if self.amount <= 0:
            raise MesExecutionContractError('A write quantity must be positive.')
        return self


@dataclass(frozen=True)
class MesExecutionTarget:
    work_order_id: int | str
    work_order_code: str
    task_id: int | str
    material_id: int | str
    line_id: int | str
    report_process_id: int | str

    def __post_init__(self):
        for field in ('work_order_id', 'task_id', 'material_id', 'line_id', 'report_process_id'):
            object.__setattr__(self, field, mes_id(getattr(self, field)))
        _text(self.work_order_code)


@dataclass(frozen=True)
class ValidatedMesEnums:
    """Server-supplied, previously verified values; no guessed tenant enums."""

    values: Mapping[str, frozenset]

    def __post_init__(self):
        if not isinstance(self.values, Mapping):
            raise MesExecutionContractError('Verified enum values must be a mapping.')
        values = {}
        for field, choices in self.values.items():
            _text(field)
            if not isinstance(choices, (set, frozenset, tuple, list)) or not choices:
                raise MesExecutionContractError('Verified enum choices cannot be empty.')
            if any(type(choice) not in (int, str) for choice in choices):
                raise MesExecutionContractError('Enum values require exact strings or integers.')
            values[field] = frozenset(choices)
        object.__setattr__(self, 'values', MappingProxyType(values))

    def require(self, field, value):
        if type(value) not in (int, str) or value not in self.values.get(field, ()):
            raise MesExecutionContractError('A supplied enum value has no verified contract binding.')
        return value


@dataclass(frozen=True)
class WorkOrderCreateApproval:
    code: str
    external_order_code: str
    material_code: str
    material_version: str
    unit_name: str
    quantity: ExactQuantity
    process_num: str
    process_route_code: str
    verified_empty_arrays: frozenset[str] = frozenset()

    def __post_init__(self):
        for field in ('code', 'external_order_code', 'material_code', 'material_version',
                      'unit_name', 'process_num', 'process_route_code'):
            _text(getattr(self, field))
        if not isinstance(self.quantity, ExactQuantity):
            raise MesExecutionContractError('A bound exact quantity is required.')
        self.quantity.require_positive()
        capabilities = self.verified_empty_arrays
        if not isinstance(capabilities, frozenset) or capabilities - _WO_ARRAYS:
            raise MesExecutionContractError('Empty-array capabilities must name reviewed required arrays.')


@dataclass(frozen=True)
class DispatchApproval:
    work_order_id: int | str
    work_order_code: str
    process_num: str
    task_code: str
    task_identifier: str
    quantity: ExactQuantity
    approved_resources: tuple[tuple[int, str], ...]

    def __post_init__(self):
        object.__setattr__(self, 'work_order_id', mes_id(self.work_order_id))
        for field in ('work_order_code', 'process_num', 'task_code', 'task_identifier'):
            _text(getattr(self, field))
        if not isinstance(self.quantity, ExactQuantity):
            raise MesExecutionContractError('A bound exact dispatch quantity is required.')
        self.quantity.require_positive()
        if not isinstance(self.approved_resources, tuple) or not self.approved_resources:
            raise MesExecutionContractError('Explicit reviewed MES resources are required.')
        resources = []
        for resource in self.approved_resources:
            if not isinstance(resource, tuple) or len(resource) != 2:
                raise MesExecutionContractError('Resources require exact id/code pairs.')
            resources.append((mes_id(resource[0]), _text(resource[1])))
        if len(set(resources)) != len(resources):
            raise MesExecutionContractError('Duplicate resource bindings are not allowed.')
        object.__setattr__(self, 'approved_resources', tuple(resources))


def _schema(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise MesExecutionContractError('Unsupported fields or missing required contract fields.')
    return copy.deepcopy(value)


def _rows(value, *, allow_empty=False, maximum=50):
    if not isinstance(value, list) or len(value) > maximum or (not value and not allow_empty):
        raise MesExecutionContractError('A bounded reviewed row list is required.')
    return value


def _bound_work_order(row, code):
    if row.get('workOrderCode') != code:
        raise MesExecutionContractError('A row belongs to a different work order.')


def _numeric_text(value, *, positive=False):
    if not isinstance(value, str):
        raise MesExecutionContractError('This documented quantity field requires decimal text.')
    number = _decimal(value)
    if positive and number <= 0:
        raise MesExecutionContractError('A denominator/quantity must be positive.')
    return _decimal_text(number)


def _line_number(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,18})', value):
        raise MesExecutionContractError('Line/sequence numbers require unsigned integer text.')
    return value


def build_work_order_create(payload, *, approval, enums):
    """Validate one main output with explicit manual entry and no SOP startup.

    Required empty arrays are accepted only when the server supplies a verified
    capability for each array. This does not assert that every MES tenant accepts
    an empty BOM/control/relationship/WIP list. Arbitrary optional write effects,
    custom fields, SOPs and additional output materials are outside this scope.
    """
    if not isinstance(approval, WorkOrderCreateApproval) or not isinstance(enums, ValidatedMesEnums):
        raise MesExecutionContractError('Reviewed work-order bindings and enums are required.')
    required = set(_WO_ARRAYS) | {
        'code', 'externalOrderCode', 'planStartTime', 'planFinishTime',
        'enableSopInt', 'specifiedMaterialInt', 'useBomFlag', 'useProcessRouteFlag', 'status',
    }
    result = _schema(payload, required, {'identifier', 'remark', 'processPlanType'})
    if result['code'] != approval.code or result['externalOrderCode'] != approval.external_order_code:
        raise MesExecutionContractError('Work-order identity differs from the reviewed binding.')
    from datetime import datetime
    try:
        start = datetime.strptime(_text(result['planStartTime']), '%Y-%m-%d %H:%M:%S')
        finish = datetime.strptime(_text(result['planFinishTime']), '%Y-%m-%d %H:%M:%S')
    except ValueError:
        raise MesExecutionContractError('Use documented work-order timestamp text.') from None
    if finish <= start:
        raise MesExecutionContractError('Planned finish must follow planned start.')
    for field, expected in (('enableSopInt', 0), ('specifiedMaterialInt', 1),
                            ('useBomFlag', 1), ('useProcessRouteFlag', 1)):
        if type(result[field]) is not int or result[field] != expected:
            raise MesExecutionContractError('The scoped work order requires explicit BOM/route, no SOP startup.')
    if result['status'] not in ('草稿', '新建'):
        raise MesExecutionContractError('Use the documented explicit initial work-order status.')
    for field in ('identifier', 'remark'):
        if field in result:
            _text(result[field], maximum=1000 if field == 'remark' else 255, multiline=field == 'remark')
    if 'processPlanType' in result and result['processPlanType'] not in ('串行', '并行'):
        raise MesExecutionContractError('Unsupported documented process plan type.')
    for field in _WO_ARRAYS:
        _rows(result[field], allow_empty=field in approval.verified_empty_arrays)
    if len(result['outputMaterialOpenCOs']) != 1:
        raise MesExecutionContractError('Only one explicitly bound main output is supported.')
    output = _schema(result['outputMaterialOpenCOs'][0], {
        'workOrderCode', 'lineSeq', 'mainFlagInt', 'materialCode', 'plannedAmount',
        'unitName', 'version', 'outputProcessCode', 'processRouteCode',
        'autoWarehousingFlag', 'warehousing',
    }, {'materialName', 'remark', 'reportingMethods'})
    _bound_work_order(output, approval.code)
    _line_number(output['lineSeq'])
    if type(output['mainFlagInt']) is not int or output['mainFlagInt'] != 1:
        raise MesExecutionContractError('The single output must be the documented main output.')
    for field, expected in (('materialCode', approval.material_code), ('version', approval.material_version),
                            ('unitName', approval.unit_name), ('outputProcessCode', approval.process_num),
                            ('processRouteCode', approval.process_route_code)):
        if output[field] != expected:
            raise MesExecutionContractError('Output material/process/unit differs from the reviewed binding.')
    if _decimal(output['plannedAmount'], precision=approval.quantity.precision) != approval.quantity.amount:
        raise MesExecutionContractError('Planned output quantity differs from the reviewed amount.')
    output['plannedAmount'] = _numeric_text(output['plannedAmount'], positive=True)
    if output['autoWarehousingFlag'] != '否' or output['warehousing'] != '是':
        raise MesExecutionContractError('Explicit manual warehousing is required; defaults are unsafe.')
    for field in ('materialName', 'remark'):
        if field in output:
            _text(output[field], maximum=1000, multiline=field == 'remark')
    if 'reportingMethods' in output:
        _text(output['reportingMethods'])
        enums.require('outputMaterialOpenCOs.reportingMethods', output['reportingMethods'])
    result['outputMaterialOpenCOs'] = [output]
    processes = []
    process_numbers = set()
    for row in result['processPlanOpenCOs']:
        row = _schema(row, {'workOrderCode', 'code', 'processNum', 'reportFlag'}, {
            'name', 'description', 'planWorkReportQuantityControl', 'productionStatusControl',
            'reportMethods', 'processUnitName', 'workCenterCode', 'processRatio',
        })
        _bound_work_order(row, approval.code)
        _text(row['code'])
        number = _text(row['processNum'])
        if number in process_numbers:
            raise MesExecutionContractError('Duplicate process numbers are not allowed.')
        process_numbers.add(number)
        for field in ('reportFlag', 'planWorkReportQuantityControl', 'productionStatusControl', 'reportMethods'):
            if field in row:
                _text(row[field])
                enums.require('processPlanOpenCOs.' + field, row[field])
        for field in ('name', 'description', 'processUnitName', 'workCenterCode'):
            if field in row:
                _text(row[field], maximum=1000 if field == 'description' else 255, multiline=field == 'description')
        if 'processRatio' in row:
            row['processRatio'] = _numeric_text(row['processRatio'], positive=True)
            if _decimal(row['processRatio'], precision=6) >= Decimal('10000000'):
                raise MesExecutionContractError('Process ratio exceeds its documented range.')
        processes.append(row)
    if approval.process_num not in process_numbers:
        raise MesExecutionContractError('The bound output process is not present in the process plan.')
    result['processPlanOpenCOs'] = processes
    relations = []
    relation_keys = set()
    for row in result['processPlanNodeRelationOpenCOs']:
        row = _schema(row, {'workOrderCode', 'prevProcessNum', 'nextProcessNum'})
        _bound_work_order(row, approval.code)
        pair = (_text(row['prevProcessNum']), _text(row['nextProcessNum']))
        if any(p not in process_numbers for p in pair) or pair[0] == pair[1] or pair in relation_keys:
            raise MesExecutionContractError('Invalid or duplicate process relationship.')
        relation_keys.add(pair)
        relations.append(row)
    result['processPlanNodeRelationOpenCOs'] = relations
    for field in ('inputMaterialOpenCOs', 'inputMaterialControlOpenCOs'):
        normalized = []
        seen = set()
        for row in result[field]:
            if field == 'inputMaterialOpenCOs':
                row = _schema(row, {'workOrderCode', 'seq', 'materialCode', 'materialName', 'version',
                    'unitName', 'specificProcessInputInt', 'splitSopControlInputInt',
                    'subInputAmountDenominator', 'subInputAmountNumerator'}, {'inputProcessNum', 'pickMode', 'remark'})
                if type(row['specificProcessInputInt']) is not int or row['specificProcessInputInt'] not in (0, 1):
                    raise MesExecutionContractError('Use explicit documented process-input control.')
                if type(row['splitSopControlInputInt']) is not int or row['splitSopControlInputInt'] != 0:
                    raise MesExecutionContractError('SOP control splitting is outside this scoped path.')
                if row['specificProcessInputInt'] == 1 and row.get('inputProcessNum') not in process_numbers:
                    raise MesExecutionContractError('The input process must exist in the bound plan.')
                if 'inputProcessNum' in row and row['inputProcessNum'] not in process_numbers:
                    raise MesExecutionContractError('Unknown input process.')
                for key in ('version', 'unitName'):
                    _text(row[key])
                for key in ('subInputAmountDenominator', 'subInputAmountNumerator'):
                    row[key] = _numeric_text(row[key], positive=key.endswith('Denominator'))
                if 'pickMode' in row:
                    _integer(row['pickMode'])
                    enums.require(field + '.pickMode', row['pickMode'])
            else:
                row = _schema(row, {'workOrderCode', 'seq', 'lineSeq', 'materialCode', 'materialName',
                    'inputAmountDenominator', 'inputAmountNumerator', 'inputQcState', 'limit', 'lowerLimit', 'upperLimit'})
                _line_number(row['lineSeq'])
                for key in ('inputAmountDenominator', 'inputAmountNumerator', 'lowerLimit', 'upperLimit'):
                    row[key] = _numeric_text(row[key], positive=key.endswith('Denominator'))
                if _decimal(row['lowerLimit']) > _decimal(row['upperLimit']):
                    raise MesExecutionContractError('Input lower bound exceeds upper bound.')
                for key in ('inputQcState', 'limit'):
                    _text(row[key])
                    enums.require(field + '.' + key, row[key])
            _bound_work_order(row, approval.code)
            _line_number(row['seq'])
            row_key = row['seq'] if field == 'inputMaterialOpenCOs' else (row['seq'], row['lineSeq'])
            if row_key in seen:
                raise MesExecutionContractError('Duplicate input sequence.')
            seen.add(row_key)
            _text(row['materialCode'])
            _text(row['materialName'])
            if 'remark' in row:
                _text(row['remark'], maximum=1000, multiline=True)
            normalized.append(row)
        result[field] = normalized
    inputs_by_sequence = {row['seq']: row for row in result['inputMaterialOpenCOs']}
    control_sums = {}
    for control in result['inputMaterialControlOpenCOs']:
        parent = inputs_by_sequence.get(control['seq'])
        if (parent is None or control['materialCode'] != parent['materialCode']
                or control['materialName'] != parent['materialName']
                or _decimal(control['inputAmountDenominator']) != _decimal(parent['subInputAmountDenominator'])):
            raise MesExecutionContractError('Input controls must match their exact parent material/ratio.')
        control_sums[control['seq']] = control_sums.get(control['seq'], Decimal(0)) + _decimal(control['inputAmountNumerator'])
    for sequence, total in control_sums.items():
        if total != _decimal(inputs_by_sequence[sequence]['subInputAmountNumerator']):
            raise MesExecutionContractError('Input-control numerator sum must equal the parent input ratio.')
    wip = []
    for row in result['workInProgressOpenCOs']:
        row = _schema(row, {'workOrderCode', 'prevProcessNum', 'nextProcessNum',
                            'autoWarehousingFlag', 'warehousingInt'}, {'materialCode', 'materialName', 'feedType', 'feedUnitName'})
        _bound_work_order(row, approval.code)
        if (row['prevProcessNum'], row['nextProcessNum']) not in relation_keys:
            raise MesExecutionContractError('WIP must refer to an existing process relationship.')
        if row['autoWarehousingFlag'] != '否' or type(row['warehousingInt']) is not int or row['warehousingInt'] != 0:
            raise MesExecutionContractError('Automatic/intermediate WIP warehousing is outside this scoped path.')
        enums.require('workInProgressOpenCOs.autoWarehousingFlag', row['autoWarehousingFlag'])
        for key in ('materialCode', 'materialName', 'feedUnitName'):
            if key in row:
                _text(row[key])
        if 'feedType' in row:
            _text(row['feedType'])
            enums.require('workInProgressOpenCOs.feedType', row['feedType'])
        wip.append(row)
    result['workInProgressOpenCOs'] = wip
    encode_exact_json(result)
    return result


def build_dispatch(payload, *, approval, enums):
    if not isinstance(approval, DispatchApproval) or not isinstance(enums, ValidatedMesEnums):
        raise MesExecutionContractError('Reviewed dispatch bindings and enums are required.')
    result = _schema(payload, {'dispatchRequests'})
    _rows(result['dispatchRequests'], maximum=1)
    row = _schema(result['dispatchRequests'][0], {
        'plannedAmount', 'plannedFinishTime', 'plannedStartTime', 'processNum',
        'produceTaskCode', 'remark', 'resourceGroupList', 'taskIdentifier', 'workOrderCode', 'workOrderId',
    })
    for field, expected in (('workOrderCode', approval.work_order_code), ('processNum', approval.process_num),
                            ('produceTaskCode', approval.task_code), ('taskIdentifier', approval.task_identifier)):
        if row[field] != expected:
            raise MesExecutionContractError('Dispatch identity differs from the reviewed binding.')
    row['workOrderId'] = mes_id(row['workOrderId'])
    if row['workOrderId'] != approval.work_order_id:
        raise MesExecutionContractError('Dispatch work-order id differs from the reviewed binding.')
    row['plannedAmount'] = _decimal(row['plannedAmount'], precision=approval.quantity.precision)
    if row['plannedAmount'] != approval.quantity.amount:
        raise MesExecutionContractError('Dispatch amount differs from the reviewed quantity.')
    for field in ('plannedStartTime', 'plannedFinishTime'):
        _integer(row[field], minimum=1)
    if row['plannedFinishTime'] <= row['plannedStartTime']:
        raise MesExecutionContractError('Dispatch planned finish must follow start.')
    _text(row['remark'], maximum=1000, multiline=True)
    selected = []
    line_numbers = set()
    groups = []
    for group in _rows(row['resourceGroupList']):
        group = _schema(group, {'bizOpenCOList', 'bizType', 'groupType', 'lineNo', 'name'}, {'id'})
        _integer(group['lineNo'])
        if group['lineNo'] in line_numbers:
            raise MesExecutionContractError('Duplicate resource-group line numbers.')
        line_numbers.add(group['lineNo'])
        _text(group['name'])
        for key in ('bizType', 'groupType'):
            _integer(group[key])
            enums.require('resourceGroupList.' + key, group[key])
        if 'id' in group:
            group['id'] = mes_id(group['id'])
        resources = []
        for resource in _rows(group['bizOpenCOList']):
            resource = _schema(resource, {'bizCode', 'bizId', 'bizType'})
            resource['bizId'] = mes_id(resource['bizId'])
            _text(resource['bizCode'])
            _integer(resource['bizType'])
            enums.require('bizOpenCOList.bizType', resource['bizType'])
            selected.append((resource['bizId'], resource['bizCode']))
            resources.append(resource)
        group['bizOpenCOList'] = resources
        groups.append(group)
    if len(set(selected)) != len(selected) or set(selected) != set(approval.approved_resources):
        raise MesExecutionContractError('Dispatch resources differ from the exact reviewed set.')
    row['resourceGroupList'] = groups
    result['dispatchRequests'] = [row]
    encode_exact_json(result)
    return result


def build_task_start(task_id):
    return {'taskId': mes_id(task_id), 'alsoStartSopTaskFlag': False}


def build_progress_report_materials_read(task_id):
    return {'taskId': mes_id(task_id)}


def build_progress_report(target, *, quantity, executor_ids, report_type, allowed_report_types, qc_status, remark):
    if not isinstance(target, MesExecutionTarget) or not isinstance(quantity, ExactQuantity):
        raise MesExecutionContractError('An exact production target and unit-bound quantity are required.')
    quantity.require_positive()
    if (not isinstance(allowed_report_types, (tuple, list, set, frozenset)) or not allowed_report_types
            or any(type(value) is not int for value in allowed_report_types)
            or type(report_type) is not int or report_type not in allowed_report_types):
        raise MesExecutionContractError('The report type must be observed in the selected output contract.')
    if type(qc_status) is not int or qc_status != 1:
        raise MesExecutionContractError('Only explicitly verified qualified output is supported in this path.')
    if not isinstance(executor_ids, (tuple, list)) or not 1 <= len(executor_ids) <= 4:
        raise MesExecutionContractError('An explicit bounded executor set is required.')
    executors = [mes_id(value) for value in executor_ids]
    if len(set(executors)) != len(executors):
        raise MesExecutionContractError('Duplicate executors are not allowed.')
    return {
        'taskId': target.task_id, 'reportType': report_type, 'qcStatus': qc_status,
        'feedAndReportFlag': 0,
        'progressReportMaterial': {'materialId': target.material_id, 'lineId': target.line_id,
                                   'reportProcessId': target.report_process_id},
        'progressReportItems': [{'executorIds': executors, 'progressReportMaterialItems': [{
            'reportUnitId': quantity.unit_id, 'reportAmount': quantity.amount,
            'remark': _text(remark, maximum=1000, multiline=True),
        }]}],
    }


def build_production_inventory_read(target, *, page=1, size=25):
    if not isinstance(target, MesExecutionTarget):
        raise MesExecutionContractError('An exact production target is required.')
    _integer(page, minimum=1, maximum=2)
    _integer(size, minimum=1, maximum=25)
    return {'taskId': target.task_id, 'lineId': target.line_id, 'materialId': target.material_id,
            'amountFilterFlag': False, 'page': page, 'size': size}


def build_manual_inbound(target, *, production_inventory_id, quantity, available_quantity,
                         storage_location_id, approved_storage_location_id, qc_status, remark):
    if (not isinstance(target, MesExecutionTarget) or not isinstance(quantity, ExactQuantity)
            or not isinstance(available_quantity, ExactQuantity)):
        raise MesExecutionContractError('Exact production/inventory/unit bindings are required.')
    quantity.require_positive()
    if (quantity.unit_id != available_quantity.unit_id or quantity.precision != available_quantity.precision
            or quantity.amount > available_quantity.amount):
        raise MesExecutionContractError('Inbound unit/precision/amount differs from verified available stock.')
    location = mes_id(storage_location_id)
    if location != mes_id(approved_storage_location_id):
        raise MesExecutionContractError('Inbound location differs from the reviewed exact storage location.')
    if type(qc_status) is not int or qc_status != 1:
        raise MesExecutionContractError('Pending, concession or failed stock cannot enter this qualified-only path.')
    return {'taskId': target.task_id, 'storageLocationId': location,
            'remark': _text(remark, maximum=1000, multiline=True),
            'productionInventoryMaterialList': [{
                'productionInventoryId': mes_id(production_inventory_id),
                'lineId': target.line_id, 'materialId': target.material_id, 'qcStatus': qc_status,
                'warehouseIntoAmount': quantity.amount, 'warehouseIntoUnitId': quantity.unit_id,
            }]}


def encode_exact_json(payload):
    """UTF-8 JSON with exact decimal number tokens, no float/string substitution."""
    def encode(value):
        if isinstance(value, Decimal):
            return _decimal_text(_decimal(value))
        if isinstance(value, dict):
            if any(type(key) is not str for key in value):
                raise MesExecutionContractError('JSON object keys must be exact strings.')
            return '{' + ','.join(json.dumps(key, ensure_ascii=False) + ':' + encode(item)
                                  for key, item in value.items()) + '}'
        if isinstance(value, (list, tuple)):
            return '[' + ','.join(encode(item) for item in value) + ']'
        if type(value) not in (str, int, bool, type(None)):
            raise MesExecutionContractError('Unsupported JSON type; floats are forbidden.')
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    encoded = encode(payload).encode('utf-8')
    if len(encoded) > 512_000:
        raise MesExecutionContractError('Contract payload exceeds the reviewed bound.')
    return encoded


def parse_json_exact(raw):
    if not isinstance(raw, (str, bytes)) or len(raw) > 512_000:
        raise MesExecutionContractError('Expected bounded JSON text/bytes.')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise MesExecutionContractError('Duplicate JSON fields are ambiguous.')
            result[key] = value
        return result
    def constant(_):
        raise MesExecutionContractError('Non-finite JSON numbers are forbidden.')
    try:
        return json.loads(raw, parse_float=Decimal, parse_constant=constant, object_pairs_hook=pairs)
    except (ValueError, UnicodeError, RecursionError, InvalidOperation):
        raise MesExecutionContractError('Invalid exact JSON response.') from None


def _ack_data(response):
    if (not isinstance(response, dict) or type(response.get('code')) is not int
            or response['code'] != 200 or type(response.get('needCheck')) is not int
            or response['needCheck'] != 0 or not isinstance(response.get('data'), dict)):
        raise MesExecutionContractError('MES acknowledgement is unverified; require scoped readback, never resend.')
    return response['data']


@dataclass(frozen=True)
class WorkOrderCreateReceipt:
    work_order_id: int


@dataclass(frozen=True)
class DispatchBusinessReceipt:
    business_id: int


@dataclass(frozen=True)
class ProgressReportReceipt:
    message_trace_id: int
    progress_report_record_ids: tuple[int, ...]
    query_inventory_result: bool


def decode_work_order_create_receipt(response):
    return WorkOrderCreateReceipt(mes_id(_ack_data(response).get('workOrderId')))


def decode_dispatch_business_receipt(response):
    return DispatchBusinessReceipt(mes_id(_ack_data(response).get('id')))


def decode_progress_report_receipt(response):
    data = _ack_data(response)
    records = [mes_id(value) for value in _rows(data.get('progressReportRecordIds'))]
    if len(set(records)) != len(records) or type(data.get('queryInventoryResult')) is not bool:
        raise MesExecutionContractError('Ambiguous report receipt.')
    return ProgressReportReceipt(mes_id(data.get('messageTraceId')), tuple(records), data['queryInventoryResult'])


@dataclass(frozen=True)
class ReportableOutputObservation:
    material_id: int
    line_id: int
    report_process_id: int
    unit_id: int
    unit_precision: int
    report_types: tuple[int, ...]


def decode_reportable_output(response, *, target, quantity):
    """Require one exact manual-warehousing output; nullable keys block writes."""
    if not isinstance(target, MesExecutionTarget) or not isinstance(quantity, ExactQuantity):
        raise MesExecutionContractError('Exact target and quantity bindings are required.')
    candidates = []
    for row in _rows(_ack_data(response).get('outputMaterials'), allow_empty=True):
        if not isinstance(row, dict) or not isinstance(row.get('progressReportKey'), dict):
            raise MesExecutionContractError('Malformed reportable output row.')
        key = row['progressReportKey']
        if mes_id(key.get('materialId')) != target.material_id:
            continue
        if mes_id(key.get('lineId')) != target.line_id or mes_id(key.get('reportProcessId')) != target.report_process_id:
            continue
        candidates.append(row)
    if len(candidates) != 1:
        raise MesExecutionContractError('The exact reportable output is missing or ambiguous.')
    row = candidates[0]
    if (row.get('autoWarehousingFlag') is not False or row.get('warehousingFlag') is not True
            or row.get('virtualMaterialFlag') is not False or row.get('mainFlag') is not True):
        raise MesExecutionContractError('The actual output does not verify the approved manual-inbound mode.')
    unit = row.get('outputMaterialUnit')
    if (not isinstance(unit, dict) or not isinstance(unit.get('enableFlag'), dict)
            or type(unit['enableFlag'].get('code')) is not int or unit['enableFlag']['code'] != 1):
        raise MesExecutionContractError('An enabled actual report unit is required.')
    precision_enabled = unit.get('enablePrecision')
    if not isinstance(precision_enabled, dict) or type(precision_enabled.get('code')) is not int or precision_enabled['code'] not in (0, 1):
        raise MesExecutionContractError('The actual unit precision policy is missing.')
    precision = _integer(unit.get('precisionFigure'), maximum=10)
    if mes_id(unit.get('id')) != quantity.unit_id or precision != quantity.precision:
        raise MesExecutionContractError('Actual report unit/precision differs from the approved exact quantity.')
    report_types = []
    for item in _rows(row.get('reportType')):
        if not isinstance(item, dict):
            raise MesExecutionContractError('Report types must carry documented integer codes.')
        report_types.append(_integer(item.get('code')))
    if len(set(report_types)) != len(report_types):
        raise MesExecutionContractError('Duplicate report type codes.')
    return ReportableOutputObservation(target.material_id, target.line_id, target.report_process_id,
                                      quantity.unit_id, precision, tuple(report_types))


@dataclass(frozen=True)
class ProductionInventoryObservation:
    production_inventory_id: int
    line_id: int
    material_id: int
    quantity: ExactQuantity
    qc_status: int


@dataclass(frozen=True)
class ProductionInventoryPage:
    page: int
    total: int
    rows: tuple[ProductionInventoryObservation, ...]


def decode_production_inventory(response, *, target, quantity, expected_page=1, size=25):
    """Normalize exact stock from a target-bound request, with no display fallback.

    The documented response has no taskId. The caller must retain the verified
    task-scoped read request; this decoder does not invent a returned task match.
    Zero balances remain visible for pre/post comparisons.
    """
    if not isinstance(target, MesExecutionTarget) or not isinstance(quantity, ExactQuantity):
        raise MesExecutionContractError('Exact target/unit bindings are required.')
    _integer(expected_page, minimum=1, maximum=2)
    _integer(size, minimum=1, maximum=25)
    data = _ack_data(response)
    page = _integer(data.get('page'), minimum=1)
    total = _integer(data.get('total'))
    rows = _rows(data.get('list'), allow_empty=True, maximum=size)
    if page != expected_page or len(rows) > total or (page - 1) * size + len(rows) > total:
        raise MesExecutionContractError('Inventory pagination does not match the exact read request.')
    normalized = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('materialVO'), dict):
            raise MesExecutionContractError('Missing inventory material identity.')
        base = row['materialVO'].get('baseInfo')
        amount = row.get('amount')
        status = row.get('qcStatus')
        if not isinstance(base, dict) or not isinstance(amount, dict) or not isinstance(status, dict):
            raise MesExecutionContractError('Incomplete inventory identity/quantity/status.')
        material_id, line_id = mes_id(base.get('id')), mes_id(row.get('lineId'))
        if material_id != target.material_id or line_id != target.line_id or row.get('virtualMaterialFlag') is not False:
            raise MesExecutionContractError('An inventory row is outside the exact approved material/line.')
        stock = ExactQuantity(amount.get('amount'), amount.get('unitId'), quantity.precision)
        if stock.unit_id != quantity.unit_id:
            raise MesExecutionContractError('Inventory quantity uses a different unit id.')
        qc_status = _integer(status.get('code'), minimum=1, maximum=4)
        inventory_id = mes_id(row.get('id'))
        if inventory_id in seen:
            raise MesExecutionContractError('Duplicate inventory rows are ambiguous.')
        seen.add(inventory_id)
        normalized.append(ProductionInventoryObservation(inventory_id, line_id, material_id, stock, qc_status))
    return ProductionInventoryPage(page, total, tuple(normalized))
