"""Pure decoder for a reviewed standalone Blacklake whole-task detail.

No tenant, permission or writer lock is inferred from a provider response.
The caller supplies a server-owned binding and immutable configuration review.
Missing result rows are retained as a partial baseline; configuration coverage
is always complete. Whole-save verification belongs to the coordinator.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json

from .inspection_full_snapshot import FullSnapshotError, normalize_observation


CONFIG_FIELDS = (
    'code', 'remark', 'state', 'checkType', 'checkEntityType',
    'checkEntityUnitCount', 'reportPageType', 'sampleProcessMethod', 'qcRange',
    'recordSample', 'recordSummaryCount', 'materialBatchRecordType',
    'inspectionResultOptions', 'reportFormatType',
)
ITEM_FIELDS = (
    'id', 'checkItemId', 'checkItemCode', 'groupName', 'serialNo',
    'executeItemType', 'checkValueType', 'logic', 'base', 'min', 'max',
    'defaultValue', 'defaultMin', 'defaultMax', 'unit', 'recordCheckItemType',
    'requireReportCount', 'scale', 'qcConfigVersionId', 'totalReportCount',
)
NULL_RELATIONS = ('workOrder', 'produceTask', 'equipment', 'inboundOrder',
                  'outboundOrder', 'approvalDetail')
EMPTY_MATERIALS = ('checkMaterials', 'sampleMaterials')


@dataclass(frozen=True, repr=False)
class DetailPin:
    """Path rooted at response.data; number accepts equivalent Decimal scale."""
    path: tuple
    expected: object
    comparison: str = 'exact'


@dataclass(frozen=True, repr=False)
class FullDetailReview:
    qc_code: str
    pins: tuple
    lifecycle_codes: tuple = ((1, 'open'), (2, 'completed'))
    verdict_codes: tuple = ((1, 'pass'), (4, 'fail'))
    confirmation_policy: tuple = ('zero',)


def _require(condition, code):
    if not condition:
        raise FullSnapshotError(code)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def parse_full_detail_json(raw):
    """Bounded exact JSON parse, also usable when creating a reviewed fixture."""
    _require(type(raw) in (str, bytes) and 0 < len(raw) <= 524288, 'detail_json_invalid')
    try:
        return json.loads(raw, object_pairs_hook=_pairs, parse_float=Decimal,
                          parse_constant=lambda _: _require(False, 'detail_nonfinite_number'))
    except FullSnapshotError:
        raise
    except (ValueError, TypeError, RecursionError):
        raise FullSnapshotError('detail_json_invalid') from None


def _id(value):
    _require(type(value) in (str, int), 'detail_identity_invalid')
    result = str(value)
    _require(result.isascii() and result.isdigit() and 0 < int(result) < 2**63
             and str(int(result)) == result, 'detail_identity_invalid')
    return result


def _text(value, limit=128):
    _require(type(value) is str and 0 < len(value) <= limit and bool(value.strip()),
             'detail_text_invalid')
    return value


def _integer(value, minimum=0, maximum=253402300799999):
    _require(type(value) is int and minimum <= value <= maximum, 'detail_integer_invalid')
    return value


def _object(value):
    _require(type(value) is dict, 'detail_object_missing')
    return value


def _list(value, limit):
    _require(type(value) is list and len(value) <= limit, 'detail_collection_invalid')
    return value


def _enum(value):
    if type(value) is dict:
        _require('code' in value, 'detail_enum_missing')
        value = value['code']
    return _integer(value, 0, 10000)


def _canonical(value):
    """Canonical reviewed JSON retaining Decimal scale unless a numeric pin."""
    if type(value) is Decimal:
        _require(value.is_finite(), 'detail_pin_invalid')
        result = format(value, 'f')
        _require(len(result) <= 1024, 'detail_pin_invalid')
        return result
    if type(value) is dict:
        _require(all(type(key) is str for key in value), 'detail_pin_invalid')
        return '{' + ','.join(json.dumps(key) + ':' + _canonical(value[key])
                              for key in sorted(value)) + '}'
    if type(value) is list:
        return '[' + ','.join(_canonical(item) for item in value) + ']'
    _require(type(value) in (str, int, bool, type(None)), 'detail_pin_invalid')
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _path(root, path):
    _require(type(path) is tuple and 0 < len(path) <= 12, 'detail_pin_invalid')
    value = root
    for component in path:
        if type(component) is str and type(value) is dict and component in value:
            value = value[component]
        elif type(component) is int and type(value) is list and 0 <= component < len(value):
            value = value[component]
        else:
            raise FullSnapshotError('detail_pinned_field_missing')
    return value


def _codes(entries, allowed, required):
    _require(type(entries) is tuple and 0 < len(entries) <= len(allowed), 'detail_review_invalid')
    result, names = {}, set()
    for entry in entries:
        _require(type(entry) is tuple and len(entry) == 2, 'detail_review_invalid')
        code, name = entry
        code = _integer(code, 0, 10000)
        _require(name in allowed and code not in result and name not in names,
                 'detail_review_invalid')
        result[code] = name
        names.add(name)
    _require(required <= names, 'detail_review_invalid')
    return result


def _observed_at(value):
    try:
        if type(value) is str:
            value = datetime.fromisoformat(value)
        _require(type(value) is datetime and value.utcoffset() is not None,
                 'invalid_observation_time')
        return value.astimezone(timezone.utc)
    except ValueError:
        raise FullSnapshotError('invalid_observation_time') from None


def _binding(binding):
    contract = _object(binding.contract)
    tenant = _text(binding.tenant)
    target = {'tenant': tenant, 'qc_id': _id(binding.qc_id),
              'snapshot_id': _id(contract.get('snapshot_id')),
              'executor_id': _id(contract.get('actor_id'))}
    mappings = _list(contract.get('items'), 50)
    _require(2 <= len(mappings), 'invalid_mapping_coverage')
    keys, local_ids, writes, rows = set(), set(), set(), {}
    for mapping in mappings:
        mapping = _object(mapping)
        _require(set(mapping) == {'local_item_id', 'config_row_id', 'write_item_id', 'group', 'seq'},
                 'invalid_mapping_coverage')
        row_id, master = _id(mapping['config_row_id']), _id(mapping['write_item_id'])
        group, seq = _text(mapping['group']), _integer(mapping['seq'], 1, 10000)
        local = _text(mapping['local_item_id'], 500)
        key, write = (row_id, group, seq), (master, group, seq)
        _require(key not in keys and write not in writes and local not in local_ids,
                 'invalid_mapping_coverage')
        _require((group, row_id) not in rows or rows[(group, row_id)] == master,
                 'invalid_mapping_coverage')
        keys.add(key); writes.add(write); local_ids.add(local)
        rows[(group, row_id)] = master
    return target, keys, rows


def _configuration(config, expected_rows, expected_keys):
    """Resolve complete config containers; nullable nested group names are valid."""
    row_paths, groups, seen = {}, set(), set()
    for group_index, container in enumerate(_list(config.get('qcConfigCheckItemList'), 50)):
        container = _object(container)
        group = _text(container.get('groupName'))
        _require(group not in groups, 'detail_duplicate_group')
        groups.add(group)
        rows = _list(container.get('checkItemAppDetailVOS'), 50)
        _require(bool(rows), 'detail_configuration_mismatch')
        for index, row in enumerate(rows):
            row = _object(row)
            key = group, _id(row.get('id'))
            _require(key in expected_rows and key not in seen
                     and _id(row.get('checkItemId')) == expected_rows[key],
                     'detail_configuration_mismatch')
            _require('groupName' in row and row['groupName'] in (None, group),
                     'detail_configuration_group_mismatch')
            count = _integer(row.get('totalReportCount'), 1, 50)
            _require({seq for row_id, name, seq in expected_keys
                      if (name, row_id) == key} == set(range(1, count + 1)),
                     'detail_configuration_mismatch')
            seen.add(key)
            row_paths[key] = ('qcConfig', 'qcConfigCheckItemList', group_index,
                              'checkItemAppDetailVOS', index)
    _require(seen == set(expected_rows), 'detail_configuration_mismatch')
    return row_paths, groups


def _config_digest(data, review, row_paths):
    required = {('checkType', 'code'), ('getStatus', 'code')}
    required.update(('qcConfig', field) for field in CONFIG_FIELDS)
    required.update((field,) for field in NULL_RELATIONS + EMPTY_MATERIALS)
    for path in row_paths.values():
        required.update(path + (field,) for field in ITEM_FIELDS)
    _require(type(review.pins) is tuple and len(review.pins) == len(required),
             'detail_pin_coverage_invalid')
    seen, markers = set(), []
    for pin in review.pins:
        _require(type(pin) is DetailPin and type(pin.path) is tuple
                 and pin.path in required and pin.path not in seen
                 and pin.comparison in {'exact', 'number', 'id'}, 'detail_pin_coverage_invalid')
        seen.add(pin.path)
        # Frozen dataclasses alone do not freeze nested expected dictionaries.
        # Detach reviewed JSON before comparing and retaining the marker.
        expected = parse_full_detail_json(_canonical(pin.expected))
        actual = _path(data, pin.path)
        if pin.comparison == 'number':
            _require(pin.path[-1] in {'min', 'max'} and type(actual) in (int, Decimal)
                     and type(expected) in (int, Decimal), 'detail_pin_invalid')
            _require(Decimal(actual).is_finite() and Decimal(expected).is_finite()
                     and Decimal(actual) == Decimal(expected), 'detail_pinned_field_changed')
            marker = expected
        elif pin.comparison == 'id':
            _require(pin.path[-1] in {'id', 'checkItemId', 'qcConfigVersionId'}
                     and _id(actual) == _id(expected), 'detail_pinned_field_changed')
            marker = _id(expected)
        else:
            _require(_canonical(actual) == _canonical(expected), 'detail_pinned_field_changed')
            marker = actual
        if pin.path in {(field,) for field in NULL_RELATIONS}:
            _require(marker is None, 'unsupported_side_effects')
        if pin.path in {(field,) for field in EMPTY_MATERIALS}:
            _require(marker == [], 'unsupported_side_effects')
        markers.append([list(pin.path), marker])
    _require(seen == required, 'detail_pin_coverage_invalid')
    markers.sort(key=lambda marker: _canonical(marker[0]))
    return hashlib.sha256(_canonical(markers).encode()).hexdigest()


def decode_full_detail(raw, *, binding, review, observed_at):
    """Return the exact coordinator observation DTO, preserving raw epoch ms.

    Reviews are server-owned and must pin all immutable standalone fields. A
    partial result is a valid observation, never proof of a successful save.
    Timestamp units are deliberately milliseconds, matching the reviewed API.
    """
    try:
        _require(type(review) is FullDetailReview, 'detail_review_invalid')
        qc_code = _text(review.qc_code)
        states = _codes(review.lifecycle_codes, {'open', 'completed'}, {'open', 'completed'})
        verdicts = _codes(review.verdict_codes, {'pass', 'fail'}, {'pass', 'fail'})
        _require(type(review.confirmation_policy) is tuple and bool(review.confirmation_policy)
                 and len(set(review.confirmation_policy)) == len(review.confirmation_policy)
                 and not set(review.confirmation_policy) - {'zero', 'null', 'missing'},
                 'detail_review_invalid')
        at = _observed_at(observed_at)
        observed_ms = int(at.timestamp() * 1000)
        target, keys, expected_rows = _binding(binding)
        envelope = _object(parse_full_detail_json(raw))
        _require(type(envelope.get('code')) is int and envelope['code'] == 200,
                 'detail_response_not_success')
        if 'needCheck' not in envelope:
            confirmation = 'missing'
        elif envelope['needCheck'] is None:
            confirmation = 'null'
        elif type(envelope['needCheck']) is int and envelope['needCheck'] == 0:
            confirmation = 'zero'
        else:
            raise FullSnapshotError('detail_confirmation_unverified')
        _require(confirmation in review.confirmation_policy, 'detail_confirmation_unverified')
        data = _object(envelope.get('data'))
        config = _object(data.get('qcConfig'))
        _require(_id(data.get('id')) == target['qc_id'] and data.get('code') == qc_code
                 and _id(config.get('snapshotId')) == target['snapshot_id']
                 and _id(_object(data.get('executor')).get('id')) == target['executor_id'],
                 'mes_target_changed')
        row_paths, groups = _configuration(config, expected_rows, keys)
        config_digest = _config_digest(data, review, row_paths)
        state = states.get(_enum(data.get('status')))
        _require(state is not None and {'inspectionResult', 'beginTime', 'endTime'} <= set(data),
                 'detail_task_state_unverified')
        begin = _integer(data['beginTime'], 1)
        _require(begin <= observed_ms, 'detail_source_time_invalid')
        verdict = None if data['inspectionResult'] is None else verdicts.get(_enum(data['inspectionResult']))
        _require(data['inspectionResult'] is None or verdict is not None,
                 'detail_task_verdict_unverified')
        end = data['endTime']
        if state == 'completed':
            _require(verdict is not None and type(end) is int and begin <= end <= observed_ms,
                     'detail_completion_unverified')
        else:
            _require(verdict is None and end is None, 'detail_task_state_unverified')
        records, seen, ids, result_groups = [], set(), set(), set()
        for container in _list(data.get('checkItems'), 50):
            container = _object(container)
            group = _text(container.get('groupName'))
            _require(group in groups and group not in result_groups, 'detail_result_group_mismatch')
            result_groups.add(group)
            for row in _list(container.get('qcTaskCheckItems'), 50):
                row = _object(row)
                key = (_id(row.get('qcConfigCheckItemId')), group, _integer(row.get('seq'), 1, 10000))
                record_id = _id(row.get('id'))
                _require(key in keys and key not in seen and record_id not in ids,
                         'detail_result_coverage_invalid')
                created = _integer(row.get('createdAt'), 1)
                updated = _integer(row.get('updatedAt'), 1)
                _require(begin <= created <= updated <= observed_ms, 'detail_source_time_invalid')
                records.append({'config_row_id': key[0], 'group': group, 'seq': key[2],
                                'value': _text(row.get('result'), 500), 'record_id': record_id,
                                'operator_id': _id(_object(row.get('operator')).get('id')),
                                'created_at': created, 'updated_at': updated})
                seen.add(key); ids.add(record_id)
        return normalize_observation({**target, 'config_digest': config_digest,
            'config_keys': [{'config_row_id': row_id, 'group': group, 'seq': seq}
                            for row_id, group, seq in sorted(keys)],
            'records': records, 'state': state, 'verdict': verdict,
            'end_time': end, 'observed_at': at.isoformat()})
    except FullSnapshotError:
        raise
    except (AttributeError, KeyError, TypeError, ValueError, RecursionError):
        raise FullSnapshotError('detail_invalid') from None
