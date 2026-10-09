"""Pure decoder for a bounded Blacklake detail shape, exercised with fabricated data.

This module neither reads credentials nor persists, requests or enables anything.
A synthetic fixture proves decoder behavior only, not live relations, write IDs or state.
Unknown source fields are intentionally omitted from the returned allowlist.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import re

from .inspection_blacklake_contract import mes_id


MAX_GROUPS = 20
MAX_ITEMS = 100
MAX_RECORDS = 500
DECODER_VERSION = 'blacklake-detail-read.v1'
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _object(value):
    if not isinstance(value, dict):
        raise ValueError('Expected a source object.')
    return value


def _list(value, limit):
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError('Source collection is missing or exceeds its bound.')
    return value


def _text(value, *, limit=256, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError('Invalid source text.')
    return value


def _id(value, *, required=False):
    if value is None and not required:
        return None
    return str(mes_id(value))


def _integer(value, *, maximum=10000, required=False):
    if value is None and not required:
        return None
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('Invalid bounded integer.')
    return value


def _enum(value):
    if value is None:
        return {'code': None, 'message': None}
    if type(value) is int:
        return {'code': value, 'message': None}
    if isinstance(value, dict) and type(value.get('code')) is int:
        return {'code': value['code'], 'message': _text(value.get('message'))}
    raise ValueError('Invalid source enum; its domains must remain separate.')


def _decimal_source(value):
    """Keep trailing zeroes; never round or convert through binary float."""
    if value is None:
        return None
    if type(value) not in (str, int, Decimal):
        raise ValueError('Exact decimal text, integer or Decimal required.')
    text = format(value, 'f') if isinstance(value, Decimal) else str(value)
    if len(text) > 64 or not re.fullmatch(r'-?[0-9]+(?:\.[0-9]{1,18})?', text):
        raise ValueError('Source decimal exceeds the reviewed precision.')
    try:
        number = Decimal(text)
        if not number.is_finite() or number.copy_abs() > Decimal('1e15'):
            raise ValueError('Source decimal is out of range.')
    except InvalidOperation:
        raise ValueError('Invalid source decimal.') from None
    return text


def _canonical(value):
    if value is None:
        return None
    # Decimal.normalize() may round under the active decimal context. String
    # formatting plus removal of insignificant zeroes does not lose precision.
    text = format(Decimal(value), 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return '0' if Decimal(text) == 0 else text


def _time(value):
    if value is None:
        return {'epoch_ms': None, 'iso_utc': None}
    if type(value) is not int or not 0 <= value <= 253402300799999:
        raise ValueError('Expected bounded integer epoch milliseconds.')
    return {'epoch_ms': value, 'iso_utc': (_EPOCH + timedelta(milliseconds=value)).isoformat()}


def _times(source, names):
    return {name: _time(source.get(name)) for name in names}


def _relation(value, *, required=False):
    if value is None and not required:
        return {'id': None, 'code': None, 'name': None}
    value = _object(value)
    return {'id': _id(value.get('id'), required=required),
            'code': _text(value.get('code')), 'name': _text(value.get('name'))}


def _groups(value, row_key):
    groups = []
    names = set()
    for group in _list(value, MAX_GROUPS):
        group = _object(group)
        name = _text(group.get('groupName'), limit=128, required=True)
        if name in names:
            raise ValueError('Duplicate outer group name.')
        names.add(name)
        groups.append((name, _list(group.get(row_key), MAX_RECORDS)))
    return groups


def normalize_blacklake_detail(response, *, scope, observed_at, evidence_reference,
                              evidence_kind='synthetic_contract_fixture'):
    """Decode a detail-shaped payload using an explicitly supplied ReadScope.

    `scope.tenant` is a caller-selected namespace, not a tenant ID discovered in
    the payload. The response argument is the fixture's `response` object only.
    No result from this function establishes current state or write authority.
    """
    if evidence_kind not in {'sanitized_read_fixture', 'synthetic_contract_fixture'}:
        raise ValueError('Explicit fixture provenance is required.')
    namespace = _text(scope.tenant, required=True)
    evidence_reference = _text(evidence_reference, limit=500, required=True)
    if not isinstance(observed_at, datetime) or observed_at.utcoffset() is None:
        raise ValueError('Use a timezone-aware observation timestamp.')
    response = _object(response)
    if type(response.get('code')) is not int or response['code'] != 200:
        raise ValueError('Successful integer business code required.')
    confirmation = response.get('needCheck')
    if confirmation is not None and (type(confirmation) is not int or confirmation != 0):
        raise ValueError('Unresolved response confirmation.')
    data = _object(response.get('data'))
    qc_id = _id(data.get('id'), required=True)
    work = _relation(data.get('workOrder'), required=True)
    if qc_id != str(mes_id(scope.qc_id)) or work['id'] != str(mes_id(scope.work_order_id)):
        raise ValueError('QC and work order differ from the explicit scope.')
    task = _relation(data.get('produceTask'))
    equipment = _relation(data.get('equipment'))
    config = _object(data.get('qcConfig'))
    snapshot_id = _id(config.get('snapshotId'), required=True)
    check_type, snapshot_type = _enum(data.get('checkType')), _enum(config.get('checkType'))
    warnings = []
    kind = {3: 'first', 4: 'production', 5: 'periodic'}.get(check_type['code'], 'unknown')
    if kind == 'unknown':
        warnings.append('qc_type_unknown')
    if snapshot_type['code'] is None:
        warnings.append('snapshot_type_unknown')
    elif snapshot_type['code'] != check_type['code']:
        warnings.append('qc_snapshot_type_conflict')
        kind = 'unknown'
    name = _text(config.get('name'))
    if name and (('巡检' in name and check_type['code'] == 3) or ('首检' in name and check_type['code'] == 5)):
        warnings.append('plan_name_type_mismatch')

    items, by_relation, config_ids = [], {}, set()
    for group, rows in _groups(config.get('qcConfigCheckItemList'), 'checkItemAppDetailVOS'):
        for row in rows:
            if len(items) >= MAX_ITEMS:
                raise ValueError('Too many config items.')
            row = _object(row)
            config_id = _id(row.get('id'), required=True)
            if config_id in config_ids:
                raise ValueError('Duplicate config row ID.')
            config_ids.add(config_id)
            # Nested groupName is commonly null. A contradictory value must not
            # silently redirect an item into another group.
            nested_group = _text(row.get('groupName'), limit=128)
            if nested_group is not None and nested_group != group:
                raise ValueError('Inner and outer config groups conflict.')
            lower, upper, base = (_decimal_source(row.get(key)) for key in ('min', 'max', 'base'))
            required = _enum(row.get('recordCheckItemType'))
            unit = _relation(row.get('unit'))
            options = [_text(option, limit=500, required=True) for option in _list(row.get('radios', []), 50)]
            item = {'ordinal': len(items), 'source_item_id': config_id,
                'label': _text(row.get('checkItemName')), 'unit': unit['name'],
                'minimum': _canonical(lower), 'maximum': _canonical(upper),
                'required': {1: True, 2: False}.get(required['code']),
                'recorded_value': None, 'group': group, 'seq': None,
                'write_check_item_id': None, 'write_mapping_verified': False,
                'source': {'config_row_id': config_id,
                    'master_check_item_id': _id(row.get('checkItemId'), required=True),
                    'config_version_id': _id(row.get('qcConfigVersionId'), required=True),
                    'serial_no': _integer(row.get('serialNo')), 'outer_group_name': group,
                    'nested_group_name': nested_group, 'unit': unit,
                    'minimum': lower, 'maximum': upper, 'base': base,
                    'logic': _enum(row.get('logic')), 'scale': _integer(row.get('scale'), maximum=18),
                    'execute_item_type': _enum(row.get('executeItemType')),
                    'value_type': _enum(row.get('checkValueType')), 'required_type': required,
                    'options': options,
                    'check_count': _decimal_source(row.get('checkCount')),
                    'task_check_count': _decimal_source(row.get('taskCheckCount')),
                    'total_report_count': _integer(row.get('totalReportCount')),
                    'required_report_count': _integer(row.get('requireReportCount')),
                    'filled_report_count': _integer(row.get('filledReportCount'))},
                'records': []}
            items.append(item)
            by_relation[(group, config_id)] = item

    record_ids, sample_keys = set(), set()
    for group, rows in _groups(data.get('checkItems'), 'qcTaskCheckItems'):
        for row in rows:
            if len(record_ids) >= MAX_RECORDS:
                raise ValueError('Too many recorded samples.')
            row = _object(row)
            record_id = _id(row.get('id'), required=True)
            config_id = _id(row.get('qcConfigCheckItemId'), required=True)
            seq = _integer(row.get('seq'), required=True)
            if seq == 0:
                raise ValueError('Sample sequence must be positive.')
            sample_key = (group, config_id, seq)
            if record_id in record_ids or sample_key in sample_keys:
                raise ValueError('Duplicate record ID or group/config/sample relation.')
            item = by_relation.get((group, config_id))
            if item is None:
                raise ValueError('Record references an unknown config/group relation.')
            record_ids.add(record_id)
            sample_keys.add(sample_key)
            option = row.get('option')
            if option is not None:
                option = [_text(value, limit=500) for value in _list(option, 50)]
            judgment = row.get('singleJudgment')
            if judgment is not None and type(judgment) is not int:
                raise ValueError('Invalid per-sample judgement enum.')
            item['records'].append({'record_id': record_id, 'config_row_id': config_id,
                'outer_group_name': group, 'seq': seq,
                'result': _text(row.get('result'), limit=500),
                'minimum': _decimal_source(row.get('min')), 'maximum': _decimal_source(row.get('max')),
                'option': option, 'single_judgment': judgment,
                'task_check_count': _decimal_source(row.get('taskCheckCount')),
                'timestamps': _times(row, ('createdAt', 'updatedAt')),
                'write_check_item_id': None, 'write_mapping_verified': False})
    for item in items:
        item['records'].sort(key=lambda row: (row['seq'], row['record_id']))
        if len(item['records']) == 1:
            # Do not substitute min/max for a missing result, or flatten multiple
            # samples to the first value. seq is from the sample, never serialNo.
            item['recorded_value'] = item['records'][0]['result']
            item['seq'] = item['records'][0]['seq']

    qc_times = _times(data, ('beginTime', 'endTime', 'createdAt', 'updatedAt'))
    # Production status has no mapping in this bounded read contract.
    # In particular, QC status and equipment activity cannot fill that gap.
    return {'schema_version': 'mes-read-observation.v1', 'tenant': namespace,
        'qc_id': qc_id, 'identity': f'{namespace}:qc:{qc_id}', 'qc_code': _text(data.get('code')),
        'work_order_id': work['id'], 'production_task_id': task['id'], 'equipment_id': equipment['id'],
        'snapshot_id': snapshot_id, 'plan_name': name, 'kind': kind,
        'check_type': check_type, 'snapshot_check_type': snapshot_type,
        'lifecycle': _enum(data.get('status')), 'judgement': _enum(data.get('inspectionResult')),
        'production_status': {'code': None, 'message': None},
        'source_updated_at': qc_times['updatedAt']['iso_utc'], 'observed_at': observed_at.isoformat(),
        'evidence_kind': evidence_kind, 'evidence_reference': evidence_reference,
        'mapping_reference': DECODER_VERSION, 'warnings': warnings, 'items': items,
        'read_only': True, 'current_state_verified': False, 'physical_operation_verified': False,
        'receipt_readiness': 'not_verified',
        'source_metadata': {'decoder_version': DECODER_VERSION,
            'tenant_namespace_source': 'caller_supplied_not_response_verified',
            'work_order': work, 'production_task': task, 'equipment': equipment,
            'qc_timestamps': qc_times,
            'config_timestamps': _times(config, ('createdAt', 'updatedAt')),
            'config_timestamp_semantics': 'source_metadata_not_immutable_snapshot_time',
            'config_code': _text(config.get('code')),
            'source_paths': {'qc_id': 'data.id', 'qc_code': 'data.code',
                'work_order_id': 'data.workOrder.id', 'production_task_id': 'data.produceTask.id',
                'equipment_id': 'data.equipment.id', 'snapshot_id': 'data.qcConfig.snapshotId',
                'lifecycle': 'data.status', 'judgement': 'data.inspectionResult',
                'config_groups': 'data.qcConfig.qcConfigCheckItemList',
                'config_rows': 'checkItemAppDetailVOS', 'record_groups': 'data.checkItems',
                'record_rows': 'qcTaskCheckItems'},
            'record_join': ['outer groupName', 'config row.id = record.qcConfigCheckItemId'],
            'quantity_observations': {key: _decimal_source(data.get(key))
                for key in ('qcSample', 'qcTotal', 'checkCount', 'planCheckCount')},
            'write_mapping_verified': False}}
