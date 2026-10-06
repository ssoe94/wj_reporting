"""Pure, fail-closed decoding of an explicitly reviewed MES detail contract.

No HTTP, credentials, persistence, default lifecycle codes or write authority.
Tenant is the binding's namespace: the caller must separately bind the vault's
tenant and provider origin. An executor match proves assignment, not permission.
observed_at is caller collection time, not MES update time. Partial/empty records
are useful before a save; only the stage's exact full-value comparison can attest
a saved result. The older fixture-only normalizer is deliberately not reused.
"""
from datetime import datetime, timedelta, timezone
import math

from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown
from .inspection_blacklake_contract import mes_id


_MISSING = object()
_STATES = {'open', 'completed', 'approval_pending', 'cancelled', 'rejected'}
_DETAIL_KEYS = {'reference', 'lifecycle_codes', 'verdict_codes', 'executor_path',
                'label_path', 'check_type', 'source_checks'}
_ITEM_KEYS = {'local_item_id', 'config_row_id', 'write_item_id', 'group', 'seq'}
_MAX_ITEMS = 50
_MAX_GROUPS = 20
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class _Invalid(Exception):
    pass


def _object(value):
    if type(value) is not dict:
        raise _Invalid()
    return value


def _list(value, maximum, *, minimum=0):
    if type(value) is not list or not minimum <= len(value) <= maximum:
        raise _Invalid()
    return value


def _text(value, maximum, *, required=True):
    if type(value) is not str or len(value) > maximum or (required and not value.strip()):
        raise _Invalid()
    return value


def _id(value):
    if type(value) not in (int, str):
        raise _Invalid()
    return str(mes_id(value))


def _seq(value):
    if type(value) is not int or not 1 <= value <= 10000:
        raise _Invalid()
    return value


def _enum(value):
    if type(value) is dict:
        value = value.get('code', _MISSING)
    if type(value) is not int:
        raise _Invalid()
    return value


def _completion_time(value, observed_at):
    if value is None:
        return None
    if type(value) is not int or not 0 <= value <= 253402300799999:
        raise _Invalid()
    completed = _EPOCH + timedelta(milliseconds=value)
    if completed > observed_at:
        raise _Invalid()
    return completed


def _path(value):
    return tuple(_text(key, 128) for key in _list(value, 8, minimum=1))


def _at(data, path):
    for key in path:
        if type(data) is not dict or key not in data:
            return _MISSING
        data = data[key]
    return data


def _scalar(value):
    if type(value) not in (str, int, float, bool, type(None)):
        raise _Invalid()
    if type(value) is str:
        _text(value, 500, required=False)
    if type(value) is float and not math.isfinite(value):
        raise _Invalid()
    return value


def _overlap(first, second):
    return first[:len(second)] == second or second[:len(first)] == first


def _review(binding, contract, observed_at):
    contract = _object(contract)
    if set(contract) != _DETAIL_KEYS:
        raise _Invalid()
    _text(contract['reference'], 500)
    if not isinstance(observed_at, datetime) or observed_at.utcoffset() is None:
        raise _Invalid()
    states = _object(contract['lifecycle_codes'])
    if set(states) != _STATES:
        raise _Invalid()
    by_state = {}
    for state, codes in states.items():
        for code in _list(codes, 20):
            if type(code) is not int or code in by_state:
                raise _Invalid()
            by_state[code] = state
    if not by_state:
        raise _Invalid()
    verdicts = _object(contract['verdict_codes'])
    if (set(verdicts) != {'pass', 'fail'} or any(type(code) is not int for code in verdicts.values())
            or verdicts['pass'] == verdicts['fail']):
        raise _Invalid()
    by_verdict = {code: verdict for verdict, code in verdicts.items()}
    executor_path, label_path = _path(contract['executor_path']), _path(contract['label_path'])
    if _overlap(executor_path, label_path):
        raise _Invalid()
    check_type = contract['check_type']
    from .inspection_integration_trial import standalone, identity as target_identity
    isolated = standalone(binding)
    if (type(check_type) is not int or check_type not in ({6} if isolated else {3, 4, 5})
            or (isolated and label_path != ('code',))):
        raise _Invalid()
    checks = []
    for check in _list(contract['source_checks'], 32, minimum=1):
        check = _object(check)
        if set(check) != {'path', 'equals'}:
            raise _Invalid()
        path, value = _path(check['path']), _scalar(check['equals'])
        if any(_overlap(path, previous) for previous, _ in checks):
            raise _Invalid()
        checks.append((path, value))
    binding_contract = _object(binding.contract)
    identity = target_identity(binding)
    _text(identity['tenant'], 128)
    actor, label = _id(binding_contract['actor_id']), _text(binding.test_label, 500)
    config_keys, record_keys, locals_seen, writes_seen = set(), set(), set(), set()
    for item in _list(binding_contract['items'], _MAX_ITEMS, minimum=1):
        item = _object(item)
        if set(item) != _ITEM_KEYS:
            raise _Invalid()
        local, group = _text(item['local_item_id'], 128), _text(item['group'], 128)
        config_id, write_id, seq = _id(item['config_row_id']), _id(item['write_item_id']), _seq(item['seq'])
        read, write = (group, config_id, seq), (group, write_id, seq)
        if local in locals_seen or read in record_keys or write in writes_seen:
            raise _Invalid()
        locals_seen.add(local)
        writes_seen.add(write)
        config_keys.add((group, config_id))
        record_keys.add(read)
    return (identity, actor, label, by_state, by_verdict, executor_path, label_path,
            check_type, checks, config_keys, record_keys)


def _groups(value, rows_key):
    names = set()
    for group in _list(value, _MAX_GROUPS):
        group = _object(group)
        name = _text(group.get('groupName'), 128)
        if name in names:
            raise _Invalid()
        names.add(name)
        yield name, _list(group.get(rows_key), _MAX_ITEMS)


def decode_live_detail(response, *, binding, detail_contract, observed_at):
    """Return only reviewed stage evidence; all errors have fixed empty args.

    Paths in detail_contract are rooted at response['data']. A missing source
    never equals an explicit null. Successful API code and needCheck absent,
    null or exact zero follow the existing read transport contract. HTTP/auth
    and reviewed, unexpired
    save/finish authority remain the caller/provider's responsibilities.
    """
    try:
        (identity, actor, label, by_state, by_verdict, executor_path, label_path,
         check_type, checks, config_keys, record_keys) = _review(binding, detail_contract, observed_at)
    except Exception:
        raise MesContractUnavailable() from None
    try:
        response = _object(response)
        if type(response.get('code')) is not int or response['code'] != 200:
            raise _Invalid()
        if ('needCheck' in response and response['needCheck'] is not None
                and (type(response['needCheck']) is not int or response['needCheck'] != 0)):
            raise _Invalid()
        data = _object(response.get('data'))
        config = _object(data.get('qcConfig'))
        from .inspection_integration_trial import standalone
        isolated = standalone(binding)
        if isolated:
            if (any(data.get(key, _MISSING) is not None for key in
                    ('workOrder', 'produceTask', 'equipment', 'inboundOrder', 'outboundOrder', 'approvalDetail'))
                    or any(type(data.get(key)) is not list or data[key] != []
                           for key in ('checkMaterials', 'sampleMaterials'))
                    or config.get('code') != binding.contract['config_code']
                    or _enum(config.get('qcRange')) != 1):
                raise _Invalid()
            raw_identity = {'tenant': identity['tenant'], 'qc_id': _id(data.get('id')),
                            'work_order_id': None, 'production_task_id': None, 'equipment_id': None,
                            'snapshot_id': _id(config.get('snapshotId'))}
        else:
            raw_identity = {'tenant': identity['tenant'], 'qc_id': _id(data.get('id')),
                'work_order_id': _id(_at(data, ('workOrder', 'id'))),
                'production_task_id': _id(_at(data, ('produceTask', 'id'))),
                'equipment_id': _id(_at(data, ('equipment', 'id'))),
                'snapshot_id': _id(config.get('snapshotId'))}
        expected_label = binding.contract['qc_code'] if isolated else label
        if (raw_identity != identity or _id(_at(data, executor_path)) != actor
                or type(_at(data, label_path)) is not str or _at(data, label_path) != expected_label):
            raise _Invalid()
        for path, expected in checks:
            actual = _at(data, path)
            if type(actual) is not type(expected) or actual != expected:
                raise _Invalid()
        if _enum(data.get('checkType')) != check_type or _enum(config.get('checkType')) != check_type:
            raise _Invalid()
        # This release supports only the reviewed no-quantity/no-attachment case.
        # Source checks must pin any additional provider-specific requirements.
        if (_enum(config.get('recordSample')) != 2 or _enum(config.get('recordSummaryCount')) != 2
                or _enum(config.get('materialBatchRecordType')) not in ({1} if isolated else {1, 2})
                or _enum(config.get('sampleProcessMethod')) != 1):
            raise _Invalid()
        state = by_state.get(_enum(data.get('status')))
        if state is None or 'inspectionResult' not in data:
            raise _Invalid()
        raw_verdict = data['inspectionResult']
        verdict = None if raw_verdict is None else by_verdict.get(_enum(raw_verdict))
        if ((raw_verdict is not None and verdict is None)
                or (state in {'completed', 'approval_pending'} and verdict is None)):
            raise _Invalid()
        if 'endTime' not in data:
            raise _Invalid()
        completed_at = _completion_time(data['endTime'], observed_at)
        if state in {'completed', 'approval_pending'} and completed_at is None:
            raise _Invalid()
        actual_config = set()
        for group, items in _groups(config.get('qcConfigCheckItemList'), 'checkItemAppDetailVOS'):
            for item in items:
                key = (group, _id(_object(item).get('id')))
                if key in actual_config or len(actual_config) >= _MAX_ITEMS:
                    raise _Invalid()
                actual_config.add(key)
        if actual_config != config_keys:
            raise _Invalid()
        records, actual_records = [], set()
        for group, rows in _groups(data.get('checkItems'), 'qcTaskCheckItems'):
            for row in rows:
                row = _object(row)
                key = (group, _id(row.get('qcConfigCheckItemId')), _seq(row.get('seq')))
                if key not in record_keys or key in actual_records or len(records) >= _MAX_ITEMS:
                    raise _Invalid()
                actual_records.add(key)
                records.append({'config_row_id': key[1], 'group': group, 'seq': key[2],
                                'value': _text(row.get('result'), 500, required=False)})
        return {'identity': raw_identity, 'observed_at': observed_at, 'state': state,
                'inspectionResult': verdict, 'test_label': label, 'records': records,
                'completed_at': completed_at}
    except Exception:
        raise MesOutcomeUnknown() from None
