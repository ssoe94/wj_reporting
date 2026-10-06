"""Read-only QC observation boundary. No authentication, persistence or dispatch.

Field paths are explicit reviewed input, not guessed tenant response schema.
Synthetic mappings validate local behavior only. They cannot enable the adapter.
"""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
import re

from .inspection_blacklake_contract import mes_id


@dataclass(frozen=True)
class ReadScope:
    tenant: str
    work_order_id: str
    qc_id: str


@dataclass(frozen=True)
class SnapshotPaths:
    """Paths into detail data, selected after reviewing source evidence.

    Snapshot paths must identify the QC's historical copy, not a current plan.
    No default provider schema is supplied by this module.
    """
    fields: dict
    item_fields: dict
    reference: str


def _at(value, path):
    if not isinstance(path, tuple) or not path or len(path) > 8:
        raise ValueError('Explicit bounded field paths are required.')
    for key in path:
        if not isinstance(key, str) or not key:
            raise ValueError('Field paths contain object keys only.')
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value


def _text(value, limit=256):
    return value if isinstance(value, str) and len(value) <= limit else None


def _id(value):
    return None if value is None else str(mes_id(value))


def _enum(value):
    if type(value) is int:
        return {'code': value, 'message': None}
    if isinstance(value, dict) and type(value.get('code')) is int:
        return {'code': value['code'], 'message': _text(value.get('message'))}
    return {'code': None, 'message': None}


def _quantity(value):
    # Strings preserve source precision; binary floating point is not accepted.
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        return None
    try:
        number = Decimal(value)
        if not number.is_finite() or abs(number) > Decimal('1e15') or number.as_tuple().exponent < -6:
            return None
        return str(value)
    except (ValueError, ArithmeticError):
        return None


def normalize_detail(response, *, paths, scope, observed_at, evidence_kind, evidence_reference):
    """Allowlist selected observations; never carry raw payload/secret fields out."""
    if evidence_kind not in {'synthetic_contract_fixture', 'sanitized_read_fixture'}:
        raise ValueError('Explicit fixture provenance is required.')
    if not _text(scope.tenant) or not _text(evidence_reference) or not _text(paths.reference):
        raise ValueError('Tenant and source references are required.')
    if not isinstance(observed_at, datetime) or observed_at.utcoffset() is None:
        raise ValueError('Use an actual timezone-aware observation time.')
    if not isinstance(response, dict) or type(response.get('code')) is not int or response['code'] != 200 or not isinstance(response.get('data'), dict):
        raise ValueError('A successful detail object is required.')
    if 'needCheck' in response and (type(response['needCheck']) is not int or response['needCheck'] != 0):
        raise ValueError('Unresolved response confirmation.')
    data = response['data']
    def field(name):
        return _at(data, paths.fields[name]) if name in paths.fields else None
    qc, work = _id(field('qc_id')), _id(field('work_order_id'))
    if qc != str(mes_id(scope.qc_id)) or work != str(mes_id(scope.work_order_id)):
        raise ValueError('QC and work order must match the explicit read scope.')
    task_type, snapshot_type = _enum(field('check_type')), _enum(field('snapshot_check_type'))
    warnings = []
    known = {3: 'first', 4: 'production', 5: 'periodic'}
    code = task_type['code']
    kind = known.get(code, 'unknown')
    snapshot_id = _id(field('snapshot_id'))
    if snapshot_id is None:
        warnings.append('snapshot_missing')
    if snapshot_type['code'] is None:
        warnings.append('snapshot_type_unknown')
    elif code != snapshot_type['code']:
        warnings.append('qc_snapshot_type_conflict')
        kind = 'unknown'
    if code not in known:
        warnings.append('qc_type_unknown')
    name = _text(field('plan_name'))
    if name and (('巡检' in name and code == 3) or ('首检' in name and code == 5)):
        warnings.append('plan_name_type_mismatch')
    items = field('items')
    converted = []
    if not isinstance(items, list):
        warnings.append('items_unknown')
    elif len(items) > 100:
        raise ValueError('Snapshot exceeds reviewed item bound.')
    else:
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError('Invalid snapshot item.')
            def item_field(name):
                return _at(item, paths.item_fields[name]) if name in paths.item_fields else None
            required = item_field('required')
            converted.append({'ordinal': index, 'source_item_id': _id(item_field('item_id')),
                'label': _text(item_field('label')), 'unit': _text(item_field('unit')),
                'minimum': _quantity(item_field('minimum')), 'maximum': _quantity(item_field('maximum')),
                'required': required if type(required) is bool else None,
                'recorded_value': _text(item_field('recorded_value'), 500),
                'group': _text(item_field('group')), 'seq': item_field('seq') if type(item_field('seq')) is int else None,
                'write_mapping_verified': False})
    return {'schema_version': 'mes-read-observation.v1', 'tenant': scope.tenant, 'qc_id': qc,
        'identity': f'{scope.tenant}:qc:{qc}', 'qc_code': _text(field('qc_code')),
        'work_order_id': work, 'production_task_id': _id(field('production_task_id')),
        'equipment_id': _id(field('equipment_id')), 'snapshot_id': snapshot_id,
        'plan_name': name, 'kind': kind, 'check_type': task_type, 'snapshot_check_type': snapshot_type,
        'lifecycle': _enum(field('lifecycle')), 'judgement': _enum(field('judgement')),
        'production_status': _enum(field('production_status')),
        'source_updated_at': _text(field('updated_at')), 'observed_at': observed_at.isoformat(),
        'evidence_kind': evidence_kind, 'evidence_reference': evidence_reference,
        'mapping_reference': paths.reference, 'warnings': warnings, 'items': converted,
        'read_only': True, 'current_state_verified': False, 'physical_operation_verified': False,
        'receipt_readiness': 'not_verified'}


def project_observations(observations, *, equipment_bindings, task_bindings):
    """Map only explicit tenant+equipment+task relations; retain every QC row.

    Binding dictionaries are reviewed local metadata, not provider field names.
    No name/part/LOT matching, inferred identity, database write or deduplication.
    """
    if not isinstance(observations, (list, tuple)) or len(observations) > 50:
        raise ValueError('At most 50 observations in one reviewed batch.')
    machines = {number: [] for number in range(1, 18)}
    unmapped = []
    identities = Counter(row['identity'] for row in observations)
    for index, source in enumerate(observations):
        row = dict(source, warnings=list(source['warnings']), observation_key=f'{source["identity"]}:{index}')
        if identities[row['identity']] > 1:
            row['warnings'].append('repeated_qc_identity')
        equipment = [binding for binding in equipment_bindings if binding.get('tenant') == row['tenant']
                     and binding.get('equipment_id') == row['equipment_id'] and row['equipment_id'] is not None]
        tasks = [binding for binding in task_bindings if binding.get('tenant') == row['tenant']
                 and binding.get('production_task_id') == row['production_task_id'] and row['production_task_id'] is not None]
        station = equipment[0].get('station_id', '') if len(equipment) == 1 else ''
        station_match = re.fullmatch(r'imm(0[1-9]|1[0-7])', station) if isinstance(station, str) else None
        valid = (station_match is not None and bool(_text(equipment[0].get('reference')))
                 and len(tasks) == 1 and bool(_text(tasks[0].get('reference')))
                 and tasks[0].get('equipment_id') == row['equipment_id']
                 and tasks[0].get('work_order_id') == row['work_order_id'])
        row['binding_status'] = 'explicit_fixture_relation' if valid else 'unresolved'
        if valid:
            machines[int(station_match.group(1))].append(row)
        else:
            row['warnings'].append('equipment_task_binding_unresolved')
            unmapped.append(row)
    return {'machines': machines, 'unmapped': unmapped, 'displayed': len(observations),
            'complete': False, 'current_state_verified': False}


def get_read_batch():
    """Production stays disconnected until runtime/schema/scope review is complete."""
    return None
