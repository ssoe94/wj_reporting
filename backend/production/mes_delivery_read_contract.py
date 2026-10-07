"""Pure exact reads for MES-operated production; no writes or live activation.

Official public contracts verified 2026-10-07 at
https://v3-ali-openapi.blacklake.cn/static/api-docs-md/<id>.md:
1686655055663531,1681109889053785,1686655055663545,1681109889053794,
1681109889053816,1681109889053817,1681109889053811,1693449354592534.
Records describe observed MES state, never net inventory movement or physical
completion. A receipt/report link is documented; report/production-stock direct
causality and change-log receipt/actor/location IDs are not returned here.
"""
from dataclasses import dataclass, field
from decimal import Decimal
from types import MappingProxyType
from typing import Mapping

from .mes_execution_contract import (
    ExactQuantity, MesExecutionContractError, MesExecutionTarget,
    build_production_inventory_read, decode_production_inventory, mes_id,
)


READ_ROUTES = MappingProxyType({
    'work_order_detail': '/med/open/v2/work_order/base/_detail',
    'task_list': '/mfg/open/v1/produce_task/_list',
    'task_detail': '/mfg/open/v2/produce_task/_detail',
    'report_records': '/mfg/open/v1/progress_report/_list',
    'warehouse_inventory': '/inventory/open/v1/material_inventory/_list',
    'inventory_changes': '/inventory/open/v1/material_inventory/_list_change_log',
    'inbound_records': '/inventory/open/v1/inbound_order/_list_operate_record',
    'report_receipts': '/mfg/open/v2/progress_report/_list_inbound_record',
    'production_inventory_list': '/mfg/open/v1/production_inventory/_list',
})


def _error():
    raise MesExecutionContractError('The exact read contract is missing, inconsistent or unverified.')


def _integer(value, *, minimum=0, maximum=2**63 - 1):
    if type(value) is not int or not minimum <= value <= maximum:
        _error()
    return value


def _text(value):
    if type(value) is not str or not 1 <= len(value) <= 255 or value != value.strip() or any(ord(c) < 32 for c in value):
        _error()
    return value


def _object(value):
    if type(value) is not dict:
        _error()
    return value


def _list(value, *, maximum=25):
    if type(value) is not list or len(value) > maximum:
        _error()
    return value


@dataclass(frozen=True)
class DeliveryReadBinding:
    tenant: str
    work_order_code: str
    work_order_id: int | None = None
    task_id: int | None = None
    material_id: int | None = None
    resource_id: int | None = None
    unit_id: int | None = None
    unit_precision: int | None = None
    warehouse_id: int | None = None
    storage_location_id: int | None = None
    actor_id: int | None = None
    window_start_ms: int | None = None
    window_end_ms: int | None = None
    line_id: int | None = None
    report_process_id: int | None = None
    task_code: str | None = None

    def __post_init__(self):
        _text(self.tenant); _text(self.work_order_code)
        for name in self.__dataclass_fields__:
            if name.endswith('_id') and getattr(self, name) is not None:
                object.__setattr__(self, name, mes_id(getattr(self, name)))
        if self.unit_precision is not None:
            _integer(self.unit_precision, maximum=10)
        if self.task_code is not None:
            _text(self.task_code)
        for value in (self.window_start_ms, self.window_end_ms):
            if value is not None: _integer(value, minimum=1)
        if (self.window_start_ms is None) != (self.window_end_ms is None): _error()
        if self.window_start_ms is not None and not 0 < self.window_end_ms - self.window_start_ms <= 86_400_000: _error()


@dataclass(frozen=True)
class ValidatedReadEnums:
    """Explicit server-verified enum meanings; provider messages are ignored."""
    values: Mapping = field(default_factory=dict)

    def __post_init__(self):
        if not isinstance(self.values, Mapping): _error()
        copied = {}
        for key, mapping in self.values.items():
            _text(key)
            if not isinstance(mapping, Mapping): _error()
            copied[key] = MappingProxyType({_integer(code): _text(state) for code, state in mapping.items()})
        object.__setattr__(self, 'values', MappingProxyType(copied))

    def state(self, field_name, code):
        return self.values.get(field_name, {}).get(_integer(code))


@dataclass(frozen=True)
class ReadRecord:
    kind: str
    fields: Mapping

    def __post_init__(self):
        object.__setattr__(self, 'fields', MappingProxyType(dict(self.fields)))


@dataclass(frozen=True)
class ReadPage:
    page: int
    total: int
    records: tuple[ReadRecord, ...]

    @property
    def complete(self):
        return self.page == 1 and self.total == len(self.records)


@dataclass(frozen=True)
class ReadEvidence:
    status: str
    reason: str
    records: tuple[ReadRecord, ...] = ()


def _need(binding, *names):
    if type(binding) is not DeliveryReadBinding: _error()
    for name in names:
        if getattr(binding, name) is None: _error()


def _window(binding):
    _need(binding, 'window_start_ms', 'window_end_ms')
    return binding.window_start_ms, binding.window_end_ms


def _paging(page, size):
    return {'page': _integer(page, minimum=1, maximum=2), 'size': _integer(size, minimum=1, maximum=25)}


def build_work_order_detail_read(binding):
    _need(binding)
    body = {'workOrderCode': binding.work_order_code, 'warehouseFlag': False}
    if binding.work_order_id is not None: body['workOrderId'] = binding.work_order_id
    return body


def build_task_list_read(binding, *, page=1, size=25):
    _need(binding, 'work_order_id')
    body = {'workOrderIdList': [binding.work_order_id], **_paging(page, size)}
    for field_name, key in (('task_id', 'taskIdList'), ('material_id', 'materialIdList'), ('resource_id', 'equipmentIdList')):
        if getattr(binding, field_name) is not None: body[key] = [getattr(binding, field_name)]
    return body


def build_task_detail_read(binding):
    _need(binding, 'task_id')
    return {'taskId': binding.task_id}


def _ids(values):
    if type(values) not in (tuple, list) or not 1 <= len(values) <= 25: _error()
    ids = tuple(mes_id(value) for value in values)
    if len(set(ids)) != len(ids): _error()
    return ids


def _task_ids(binding, task_ids):
    ids = _ids(task_ids) if task_ids else ((binding.task_id,) if binding.task_id is not None else ())
    if not ids or (binding.task_id is not None and ids != (binding.task_id,)): _error()
    return ids


def build_report_records_read(binding, *, report_ids=(), task_ids=(), page=1, size=25):
    _need(binding, 'work_order_id')
    start, end = _window(binding)
    body = {'workOrderIdList': [binding.work_order_id], 'taskIds': list(_task_ids(binding, task_ids)),
            'reportTimeFrom': start, 'reportTimeTo': end, **_paging(page, size)}
    if binding.material_id is not None: body['reportMaterialIdList'] = [binding.material_id]
    if report_ids: body['progressReportRecordIds'] = list(_ids(report_ids))
    return body


def build_warehouse_inventory_read(binding, *, page=1, size=25):
    _need(binding, 'work_order_id', 'material_id', 'warehouse_id', 'storage_location_id')
    return {'workOrderIds': [binding.work_order_id], 'materialIds': [binding.material_id],
            'warehouseIds': [binding.warehouse_id], 'storageLocationIds': [binding.storage_location_id], **_paging(page, size)}


def build_inventory_changes_read(binding, *, page=1, size=25):
    _need(binding, 'material_id', 'warehouse_id', 'storage_location_id', 'actor_id')
    start, end = _window(binding)
    return {'dateStart': start, 'dateEnd': end, 'action': 'in', 'direction': True,
            'materialIds': [binding.material_id], 'warehouseIds': [binding.warehouse_id],
            'storageLocationIds': [binding.storage_location_id], 'operatorId': binding.actor_id, **_paging(page, size)}


def build_report_receipts_read(binding, report_ids):
    # IDs must originate from a prior WO/task-scoped report query; this route
    # accepts only report IDs and returns no task or work-order identifiers.
    _need(binding, 'work_order_id')
    return {'ids': list(_ids(report_ids))}


def build_inbound_records_read(binding, receipt_ids, *, page=1, size=25):
    _need(binding, 'material_id', 'warehouse_id', 'storage_location_id')
    body = {'inboundOrderOperateRecordIds': list(_ids(receipt_ids)), 'materialId': [binding.material_id],
            'warehouseIds': [binding.warehouse_id], 'locationId': [binding.storage_location_id], **_paging(page, size)}
    return body


def _data(response, expected=dict):
    value = _object(response)
    if (type(value.get('code')) is not int or value['code'] != 200
            or type(value.get('needCheck')) is not int or value['needCheck'] != 0
            or type(value.get('data')) is not expected): _error()
    return value['data']


def _page(response, page, size):
    _paging(page, size)
    data = _data(response)
    total = _integer(data.get('total'))
    rows = _list(data.get('list'), maximum=size)
    if data.get('page') != page or type(data.get('page')) is not int or (page - 1) * size + len(rows) > total: _error()
    return rows, total


def _match(binding, name, value):
    observed = mes_id(value)
    if getattr(binding, name) is not None and observed != getattr(binding, name): _error()
    return observed


def _work_order(binding, row, *, detail=False):
    id_key, code_key = ('relatedWorkOrderId', 'relatedWorkOrderCode') if detail else ('workOrderId', 'workOrderCode')
    if row.get(code_key) != binding.work_order_code: _error()
    return _match(binding, 'work_order_id', row.get(id_key))


class _AmountUnavailable(Exception):
    pass


def _amount(binding, node, *, allow_text=False):
    if type(node) is not dict or 'amount' not in node: raise _AmountUnavailable()
    if node['amount'] is None: raise _AmountUnavailable()
    if type(node['amount']) not in ((str, int, Decimal) if allow_text else (int, Decimal)): _error()
    unit = node.get('unit') or {}
    if type(unit) is not dict: _error()
    unit_id = node.get('unitId', unit.get('id'))
    if unit_id is None: raise _AmountUnavailable()
    unit_id = _match(binding, 'unit_id', unit_id)
    if unit.get('id') is not None and mes_id(unit['id']) != unit_id: _error()
    precision = unit.get('precisionFigure', binding.unit_precision)
    if precision is None: raise _AmountUnavailable()
    if binding.unit_precision is not None and precision != binding.unit_precision: _error()
    return ExactQuantity(node['amount'], unit_id, _integer(precision, maximum=10))


def _optional_amount(binding, node, *, allow_text=False):
    try: return _amount(binding, node, allow_text=allow_text)
    except _AmountUnavailable: return None


def _status(row, key, enums, enum_field):
    code = _integer(_object(row.get(key)).get('code'))
    return {'status_code': code, 'state': enums.state(enum_field, code)}


def decode_work_order_detail(response, binding, *, enums=None):
    _need(binding)
    row = _data(response)
    if row.get('code') != binding.work_order_code: _error()
    fields = {'work_order_id': _match(binding, 'work_order_id', row.get('id')), 'work_order_code': binding.work_order_code,
              **_status(row, 'status', enums or ValidatedReadEnums(), 'work_order_status')}
    if row.get('resource') is not None: fields['resource_id'] = _match(binding, 'resource_id', _object(row['resource']).get('id'))
    for source, name in (('createdAt', 'created_at_ms'), ('updatedAt', 'updated_at_ms'),
                         ('actualStartTime', 'actual_start_ms'), ('actualEndTime', 'actual_end_ms'),
                         ('plannedStartTime', 'planned_start_ms'), ('plannedFinishTime', 'planned_finish_ms')):
        if row.get(source) is not None: fields[name] = _integer(row[source])
    return ReadRecord('work_order', fields)


def decode_task_list(response, binding, *, enums=None, page=1, size=25):
    _need(binding, 'work_order_id')
    rows, total = _page(response, page, size)
    result, seen = [], set()
    for row in rows:
        row = _object(row)
        fields = {'work_order_id': _work_order(binding, row), 'work_order_code': binding.work_order_code,
                  'task_id': _match(binding, 'task_id', row.get('taskId')), 'task_code': _text(row.get('taskCode')),
                  **_status(row, 'taskStatus', enums or ValidatedReadEnums(), 'task_status')}
        if binding.task_code is not None and fields['task_code'] != binding.task_code: _error()
        if fields['task_id'] in seen: _error()
        seen.add(fields['task_id'])
        progress = row.get('progressReportOpenVO')
        if progress is not None:
            progress = _object(progress)
            material = _object(progress['materialInfo']).get('baseInfo') if progress.get('materialInfo') is not None else None
            if material is not None and _object(material).get('id') is not None:
                fields['material_id'] = _match(binding, 'material_id', material['id'])
            if progress.get('lineId') is not None: fields['line_id'] = _match(binding, 'line_id', progress['lineId'])
            fields['planned_quantity'] = _optional_amount(binding, progress.get('plannedAmount'))
            flag = progress.get('autoWarehousingFlag')
            if flag is not None and type(flag) is not bool: _error()
            fields['automatic_warehousing'] = flag
        result.append(ReadRecord('task', fields))
    return ReadPage(page, total, tuple(result))


def decode_task_detail(response, binding, *, enums=None):
    _need(binding, 'task_id', 'work_order_id')
    row = _data(response)
    equipment_ids = tuple(mes_id(_object(item).get('id')) for item in _list(row.get('equipments')))
    if len(set(equipment_ids)) != len(equipment_ids) or (binding.resource_id is not None and binding.resource_id not in equipment_ids): _error()
    fields = {'work_order_id': _work_order(binding, row, detail=True), 'work_order_code': binding.work_order_code,
        'task_id': _match(binding, 'task_id', row.get('taskId')), 'task_code': _text(row.get('taskCode')),
        'material_id': _match(binding, 'material_id', _object(row.get('workOrderMainOutputMaterial')).get('id')),
        'resource_ids': equipment_ids, **_status(row, 'taskStatus', enums or ValidatedReadEnums(), 'task_status')}
    if binding.task_code is not None and fields['task_code'] != binding.task_code: _error()
    return ReadRecord('task_detail', fields)


def decode_report_records(response, binding, *, report_ids=(), task_ids=(), page=1, size=25):
    _need(binding, 'work_order_id')
    tasks = set(_task_ids(binding, task_ids))
    start, end = _window(binding)
    rows, total = _page(response, page, size)
    selected = set(_ids(report_ids)) if report_ids else None
    result, seen = [], set()
    for row in rows:
        row = _object(row)
        report_id = mes_id(row.get('reportRecordId'))
        detail_id = mes_id(row.get('id'))
        if detail_id in seen or (selected is not None and report_id not in selected): _error()
        seen.add(detail_id)
        task_id = mes_id(row.get('taskId'))
        if task_id not in tasks: _error()
        material = _object(_object(row.get('materialInfo')).get('baseInfo'))
        timestamp = _integer(row.get('reportTime'), minimum=1)
        if not start <= timestamp < end: _error()
        number = row.get('reportBaseAmountDisplay') if row.get('reportBaseAmountDisplay') is not None else row.get('reportBaseAmount')
        fields = {'work_order_id': _work_order(binding, row), 'task_id': task_id,
            'report_record_id': report_id, 'report_detail_id': detail_id,
            'material_id': _match(binding, 'material_id', material.get('id')),
            'line_id': _match(binding, 'line_id', row.get('lineId')), 'reported_at_ms': timestamp,
            'quantity': _optional_amount(binding, number),
            'actor_id': mes_id(_object(row.get('reporter')).get('id')),
            'qc_status': _integer(_object(row.get('qcStatus')).get('code'), minimum=1, maximum=4)}
        if row.get('reportBaseAmountDisplay') is not None:
            number = _object(number)
            if number.get('unitId') is not None: fields['unit_id'] = _match(binding, 'unit_id', number['unitId'])
            if number.get('unitName') is not None: fields['unit_name'] = _text(number['unitName'])
        result.append(ReadRecord('report', fields))
    return ReadPage(page, total, tuple(result))


def decode_warehouse_inventory(response, binding, *, page=1, size=25):
    build_warehouse_inventory_read(binding, page=page, size=size)
    rows, total = _page(response, page, size)
    result, seen = [], set()
    for row in rows:
        row = _object(row)
        inventory_id = mes_id(row.get('id'))
        if inventory_id in seen: _error()
        seen.add(inventory_id)
        related = _list(row.get('workOrderSimpleInfos'))
        if not any(item.get('id') == binding.work_order_id and item.get('code') == binding.work_order_code for item in related if type(item) is dict): _error()
        location = _object(row.get('storageLocationDetail'))
        fields = {'inventory_id': inventory_id, 'material_id': _match(binding, 'material_id', _object(row.get('material')).get('id')),
            'storage_location_id': _match(binding, 'storage_location_id', row.get('storageLocationId')),
            'warehouse_id': _match(binding, 'warehouse_id', _object(location.get('warehouse')).get('id')),
            'quantity': _optional_amount(binding, row.get('amount')),
            'qc_status': _integer(_object(row.get('qcStatus')).get('code'), minimum=1, maximum=4)}
        if mes_id(_object(location.get('location')).get('id')) != fields['storage_location_id']: _error()
        result.append(ReadRecord('warehouse_inventory', fields))
    return ReadPage(page, total, tuple(result))


def decode_inventory_changes(response, binding, *, page=1, size=25):
    build_inventory_changes_read(binding, page=page, size=size)
    rows, total = _page(response, page, size)
    start, end = _window(binding)
    result = []
    for row in rows:
        row = _object(row)
        timestamp = _integer(row.get('createdAt'), minimum=1)
        amount = _object(row.get('amount'))
        action = _object(row.get('action')).get('action')
        if not start <= timestamp < end or action != 'in' or amount.get('direction') is not True: _error()
        result.append(ReadRecord('inventory_change', {'change_log_id': mes_id(row.get('id')),
            'material_id': _match(binding, 'material_id', _object(row.get('material')).get('id')),
            'created_at_ms': timestamp, 'quantity': _optional_amount(binding, amount.get('amount')),
            'after_quantity': _optional_amount(binding, amount.get('afterAmount'))}))
    return ReadEvidence('insufficient', 'change_log_actor_location_receipt_ids_not_returned', tuple(result))


def _receipt(binding, row, *, direct, report_ids):
    location = _object(row.get('storageLocation'))
    reported = _ids(row.get('reportRecordIds'))
    amount = _object(row['amount']).get('amount') if row.get('amount') is not None else None
    fields = {'receipt_id': mes_id(row.get('inboundOrderRecordId' if direct else 'inboundOrderOperateId')),
        'inventory_id': mes_id(row.get('inventoryElementId' if direct else 'inboundInventoryElementId')),
        'report_record_ids': reported,
        'material_id': _match(binding, 'material_id', row.get('materialId') if direct else _object(row.get('material')).get('id')),
        'storage_location_id': _match(binding, 'storage_location_id', _object(location.get('storage')).get('id')),
        'warehouse_id': _match(binding, 'warehouse_id', _object(location.get('warehouse')).get('id')),
        'actor_id': mes_id(_object(row.get('operator')).get('id')), 'operated_at_ms': _integer(row.get('operateTime'), minimum=1),
        'quantity': _optional_amount(binding, amount, allow_text=True),
        'execute_type': _integer(_object(row['executeType']).get('code'), minimum=1, maximum=4) if row.get('executeType') is not None else None,
        'qc_status': _integer(_object(row.get('qcStatus')).get('code'), minimum=1, maximum=99)}
    if not set(reported) & set(report_ids): _error()
    return ReadRecord('receipt', fields)


def decode_report_receipts(response, binding, report_ids):
    build_report_receipts_read(binding, report_ids)
    requested = set(_ids(report_ids))
    rows = _list(_data(response, list), maximum=50)
    result, seen, covered = [], set(), set()
    for row in rows:
        row = _object(row)
        report_id = mes_id(row.get('progressReportId'))
        if report_id not in requested: _error()
        if row.get('inboundRecord') is None: continue
        record = _receipt(binding, _object(row['inboundRecord']), direct=True, report_ids=requested)
        if report_id not in record.fields['report_record_ids']: _error()
        key = (report_id, record.fields['receipt_id'])
        if key in seen: _error()
        seen.add(key); covered.add(report_id); result.append(record)
    reason = 'report_linked_receipt_observed' if covered == requested else 'receipt_not_observed_for_every_report'
    return ReadEvidence('observed' if covered == requested else 'insufficient', reason, tuple(result))


def decode_inbound_records(response, binding, receipt_ids, *, report_ids, page=1, size=25):
    build_inbound_records_read(binding, receipt_ids, page=page, size=size)
    rows, total = _page(response, page, size)
    expected = set(_ids(receipt_ids))
    result, seen = [], set()
    for row in rows:
        record = _receipt(binding, _object(row), direct=False, report_ids=_ids(report_ids))
        receipt_id = record.fields['receipt_id']
        if receipt_id not in expected or receipt_id in seen: _error()
        seen.add(receipt_id); result.append(record)
    return ReadPage(page, total, tuple(result))


def report_inventory_causality(report_records, production_inventory):
    """Matching totals/new stock are observations, not a documented direct link."""
    return ReadEvidence('insufficient', 'report_to_production_inventory_direct_link_not_documented')


def build_production_inventory_status_read(binding, *, page=1, size=25):
    _need(binding, 'work_order_id', 'task_id', 'material_id', 'line_id', 'report_process_id')
    target = MesExecutionTarget(binding.work_order_id, binding.work_order_code, binding.task_id,
                                binding.material_id, binding.line_id, binding.report_process_id)
    return build_production_inventory_read(target, page=page, size=size)


def decode_production_inventory_status(response, binding, *, page=1, size=25):
    build_production_inventory_status_read(binding, page=page, size=size)
    _need(binding, 'unit_id', 'unit_precision')
    target = MesExecutionTarget(binding.work_order_id, binding.work_order_code, binding.task_id,
                                binding.material_id, binding.line_id, binding.report_process_id)
    return decode_production_inventory(response, target=target,
        quantity=ExactQuantity(0, binding.unit_id, binding.unit_precision), expected_page=page, size=size)
