"""Pure, fail-closed assessment of one supplied QC detail fixture.

This helper never reads credentials, calls a transport, uses the ORM or authorizes
execution. Matching reviewed paths describes only the supplied evidence. It does
not establish a live tenant, actor, approval authority or physical side effects.
No provider field paths or acceptable enum values are supplied by default.
Only explicit synthetic or sanitized fixtures are accepted. A raw live response
must not be relabelled as a fixture to pass this boundary.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
import re

from .inspection_blacklake_contract import mes_id
from .inspection_blacklake_snapshot import normalize_blacklake_detail
from .inspection_read_snapshot import ReadScope


TEST_LABEL_PREFIX = '연동 테스트용 가상값 / 非实测，仅用于接口测试 / '
_MISSING = object()
_UNVERIFIED = (
    'tenant', 'actual_actor_authority', 'approval_authority',
    'production_side_effects', 'inventory_side_effects',
)


@dataclass(frozen=True, slots=True)
class PreflightTarget:
    scope: ReadScope
    production_task_id: str
    equipment_id: str
    snapshot_id: str
    check_type: int
    permanent_test_label: str


@dataclass(frozen=True, slots=True)
class PreflightMapping:
    # Paths are relative to response["data"], including an explicit enum code key.
    material_batch_record_type_path: tuple[str, ...]
    sample_process_method_path: tuple[str, ...]
    permanent_test_label_path: tuple[str, ...]
    supported_material_batch_record_types: frozenset[int]
    supported_sample_process_methods: frozenset[int]
    open_lifecycle_codes: frozenset[int]
    reference: str


def _text(value, limit=500):
    return type(value) is str and 0 < len(value) <= limit and bool(value.strip())


def _path(value):
    return (type(value) is tuple and 1 <= len(value) <= 8
            and all(type(key) is str and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', key)
                    for key in value))


def _codes(value):
    return (type(value) is frozenset and 1 <= len(value) <= 32
            and all(type(code) is int and 0 <= code <= 2_147_483_647 for code in value))


def _valid_configuration(target, mapping):
    if type(target) is not PreflightTarget or type(mapping) is not PreflightMapping:
        return False
    scope = target.scope
    if (type(scope) is not ReadScope or set(vars(scope)) != {'tenant', 'work_order_id', 'qc_id'}
            or not _text(scope.tenant, 256) or type(target.check_type) is not int
            or target.check_type not in {3, 4, 5}):
        return False
    for value in (scope.work_order_id, scope.qc_id, target.production_task_id,
                  target.equipment_id, target.snapshot_id):
        if type(value) is not str:
            return False
        mes_id(value)
    label = target.permanent_test_label
    if (not _text(label) or not label.startswith(TEST_LABEL_PREFIX)
            or not label[len(TEST_LABEL_PREFIX):].strip() or not _text(mapping.reference)):
        return False
    paths = (mapping.material_batch_record_type_path, mapping.sample_process_method_path,
             mapping.permanent_test_label_path)
    if not all(_path(path) for path in paths) or len(set(paths)) != len(paths):
        return False
    # One source field cannot be reused as another requirement's evidence.
    if any(left != right and right[:len(left)] == left for left in paths for right in paths):
        return False
    return all(_codes(codes) for codes in (
        mapping.supported_material_batch_record_types,
        mapping.supported_sample_process_methods, mapping.open_lifecycle_codes)) and not (
            mapping.open_lifecycle_codes & {2, 3})  # Documented ended/cancelled states.


def _mapped(data, path):
    for key in path:
        if type(data) is not dict or key not in data:
            return _MISSING
        data = data[key]
    return data


def assess_detail_preflight(response, *, target, mapping, observed_at, evaluated_at,
                            max_age, evidence_kind, evidence_reference):
    """Return fixed status/blocker codes only; never return an execution permit.

    The caller supplies a decoded fixture and reviewed configuration. Extra raw
    fields remain untrusted and are never copied to the result. Fixture provenance
    is explicit; neither matching references nor caller booleans prove authority.
    """
    result = {
        'detail_contract_status': 'blocked',
        'checks': dict.fromkeys(('configuration', 'freshness', 'detail', 'identity',
                                'sample_configuration', 'permanent_source_label'), 'unverified'),
        'blockers': [name + '_unverified' for name in _UNVERIFIED] + ['live_execution_not_enabled'],
        'can_save': False, 'can_finish': False, 'read_only': True,
    }
    result['checks'].update(dict.fromkeys(_UNVERIFIED, 'unverified'))
    contract_blockers = []

    def block(check, code):
        result['checks'][check] = 'blocked'
        contract_blockers.append(code)

    def finish():
        result['blockers'] = contract_blockers + result['blockers']
        if not contract_blockers:
            result['detail_contract_status'] = 'matched'
        return result

    try:
        valid = _valid_configuration(target, mapping)
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        block('configuration', 'configuration_invalid')
        return finish()
    if (type(evidence_kind) is not str
            or evidence_kind not in {'synthetic_contract_fixture', 'sanitized_read_fixture'}
            or not _text(evidence_reference)):
        block('configuration', 'evidence_provenance_invalid')
        return finish()
    result['checks']['configuration'] = 'matched'
    try:
        time_valid = (type(observed_at) is datetime and type(evaluated_at) is datetime
                      and observed_at.utcoffset() is not None and evaluated_at.utcoffset() is not None
                      and type(max_age) is timedelta and max_age > timedelta(0))
        if not time_valid:
            block('freshness', 'observation_time_invalid')
        elif observed_at > evaluated_at:
            block('freshness', 'observation_in_future')
        elif evaluated_at - observed_at > max_age:
            block('freshness', 'observation_expired')
        else:
            result['checks']['freshness'] = 'matched'
    except (ValueError, TypeError, OverflowError):
        block('freshness', 'observation_time_invalid')
    if contract_blockers:
        return finish()
    try:
        if type(response) is not dict:
            raise ValueError()
        detail = normalize_blacklake_detail(response, scope=target.scope,
            observed_at=observed_at, evidence_reference=evidence_reference,
            evidence_kind=evidence_kind)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        block('detail', 'detail_invalid')
        return finish()
    result['checks']['detail'] = 'matched'
    if detail['warnings']:
        block('detail', 'detail_warnings_present')
    expected_identity = {'production_task_id': target.production_task_id,
        'equipment_id': target.equipment_id, 'snapshot_id': target.snapshot_id}
    if (any(detail[name] != expected for name, expected in expected_identity.items())
            or detail['check_type']['code'] != target.check_type
            or detail['snapshot_check_type']['code'] != target.check_type):
        block('identity', 'identity_mismatch')
    else:
        result['checks']['identity'] = 'matched'
    if detail['lifecycle']['code'] not in mapping.open_lifecycle_codes:
        block('detail', 'lifecycle_not_reviewed_open')
    if response['data'].get('endTime') is not None:
        block('detail', 'completion_time_present')
    sample_valid = True
    for name, path, codes in (
        ('material_batch_record_type', mapping.material_batch_record_type_path,
         mapping.supported_material_batch_record_types),
        ('sample_process_method', mapping.sample_process_method_path,
         mapping.supported_sample_process_methods),
    ):
        value = _mapped(response['data'], path)
        if value is _MISSING or value is None:
            block('sample_configuration', name + '_missing')
            sample_valid = False
        elif type(value) is not int or value not in codes:
            block('sample_configuration', name + '_unsupported')
            sample_valid = False
    if sample_valid:
        result['checks']['sample_configuration'] = 'matched'
    label = _mapped(response['data'], mapping.permanent_test_label_path)
    if label is _MISSING or label is None:
        block('permanent_source_label', 'permanent_source_label_missing')
    elif type(label) is not str or label != target.permanent_test_label:
        block('permanent_source_label', 'permanent_source_label_mismatch')
    else:
        result['checks']['permanent_source_label'] = 'matched'
    return finish()
