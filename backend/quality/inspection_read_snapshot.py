"""Read-only QC observation boundary. No persistence or default MES dispatch.

Field paths are explicit reviewed input, not guessed tenant response schema.
Synthetic mappings validate local behavior only. They cannot enable the adapter.
"""
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
import logging
import re
from typing import Protocol, TypedDict

from django.conf import settings
from django.utils import timezone
from mes_oauth.session_guard import InspectionSession

from .inspection_blacklake_contract import mes_id

logger = logging.getLogger(__name__)


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


class ReadBatch(TypedDict):
    observations: list[dict]
    equipment_bindings: list[dict]
    task_bindings: list[dict]


class SessionReadBatchReader(Protocol):
    def __call__(self, *, session: InspectionSession, actor_id: int,
                 business_date: date) -> ReadBatch | None:
        """Use this request's existing authenticated lease and reviewed read scope."""
        ...


def _validate_reader_batch(value):
    """Accept the existing normalized fixture contract, never a raw MES body.

    Live provenance/current-work fields require a reviewed decoder extension.
    An arbitrary configured callable cannot silently promote fixture evidence.
    """
    if type(value) is not dict or set(value) != {'observations', 'equipment_bindings', 'task_bindings'}:
        raise ValueError('Unsupported read batch.')
    observation_keys = {'schema_version', 'tenant', 'qc_id', 'identity', 'qc_code', 'work_order_id',
        'production_task_id', 'equipment_id', 'snapshot_id', 'plan_name', 'kind', 'check_type',
        'snapshot_check_type', 'lifecycle', 'judgement', 'production_status', 'source_updated_at',
        'observed_at', 'evidence_kind', 'evidence_reference', 'mapping_reference', 'warnings',
        'items', 'read_only', 'current_state_verified', 'physical_operation_verified', 'receipt_readiness'}
    item_keys = {'ordinal', 'source_item_id', 'label', 'unit', 'minimum', 'maximum',
        'required', 'recorded_value', 'group', 'seq', 'write_mapping_verified'}
    for field, limit in (('observations', 50), ('equipment_bindings', 34), ('task_bindings', 50)):
        if type(value[field]) not in (list, tuple) or len(value[field]) > limit:
            raise ValueError('Unsupported read collection.')
    for row in value['observations']:
        if (type(row) is not dict or set(row) != observation_keys
                or row['schema_version'] != 'mes-read-observation.v1'
                or row['evidence_kind'] not in {'synthetic_contract_fixture', 'sanitized_read_fixture'}
                or row['read_only'] is not True or row['current_state_verified'] is not False
                or row['physical_operation_verified'] is not False or row['receipt_readiness'] != 'not_verified'
                or row['kind'] not in {'first', 'production', 'periodic', 'unknown'}):
            raise ValueError('Unsupported read observation.')
        for key in ('tenant', 'identity', 'evidence_reference', 'mapping_reference'):
            if not _text(row[key]) or not row[key].strip():
                raise ValueError('Invalid read identity.')
        for key in ('qc_id', 'work_order_id', 'production_task_id', 'equipment_id', 'snapshot_id'):
            if row[key] is not None and (type(row[key]) is not str or str(mes_id(row[key])) != row[key]):
                raise ValueError('Invalid read identifier.')
        if (row['qc_id'] is None or row['work_order_id'] is None
                or row['identity'] != f'{row["tenant"]}:qc:{row["qc_id"]}'):
            raise ValueError('Invalid read relation.')
        stamp = datetime.fromisoformat(row['observed_at'])
        if stamp.utcoffset() is None or stamp > timezone.now():
            raise ValueError('Invalid observation time.')
        for key in ('qc_code', 'plan_name', 'source_updated_at'):
            if row[key] is not None and _text(row[key]) is None:
                raise ValueError('Invalid observation text.')
        if (type(row['warnings']) is not list or len(row['warnings']) > 20
                or any(not _text(warning) for warning in row['warnings'])):
            raise ValueError('Invalid observation warnings.')
        for key in ('check_type', 'snapshot_check_type', 'lifecycle', 'judgement', 'production_status'):
            enum = row[key]
            if (type(enum) is not dict or set(enum) != {'code', 'message'}
                    or enum['code'] is not None and type(enum['code']) is not int
                    or enum['message'] is not None and _text(enum['message']) is None):
                raise ValueError('Invalid observation enum.')
        if type(row['items']) is not list or len(row['items']) > 100:
            raise ValueError('Invalid observation items.')
        for item in row['items']:
            if (type(item) is not dict or set(item) != item_keys
                    or item['write_mapping_verified'] is not False):
                raise ValueError('Unsupported observation item.')
            for key in ('label', 'unit', 'group', 'recorded_value'):
                if item[key] is not None and _text(item[key], 500 if key == 'recorded_value' else 256) is None:
                    raise ValueError('Invalid observation item text.')
            if item['source_item_id'] is not None:
                mes_id(item['source_item_id'])
            if (type(item['ordinal']) is not int or not 0 <= item['ordinal'] < 100
                    or item['required'] is not None and type(item['required']) is not bool
                    or item['seq'] is not None and type(item['seq']) is not int
                    or any(item[key] is not None and _quantity(item[key]) is None for key in ('minimum', 'maximum'))):
                raise ValueError('Invalid observation item value.')
    for field, keys in (
        ('equipment_bindings', {'tenant', 'equipment_id', 'station_id', 'reference'}),
        ('task_bindings', {'tenant', 'production_task_id', 'work_order_id', 'equipment_id', 'reference'}),
    ):
        for row in value[field]:
            if type(row) is not dict or set(row) != keys or any(not _text(row[key]) for key in keys):
                raise ValueError('Unsupported read binding.')
    return value


def get_read_batch(*, session: InspectionSession | None = None,
                   actor_id: int | None = None, business_date: date | None = None,
                   reader: SessionReadBatchReader | None = None) -> ReadBatch | None:
    """Keep the live supplier disconnected until its MES contract is reviewed.

    A supplied reader is per request, never a process-wide cached user/session.
    It must validate the current login, lease and provider scope itself; merely
    carrying an InspectionSession does not grant MES access or prove live state.
    Legacy WJ readers still receive their local board without a MES read.
    """
    if (type(session) is not InspectionSession or type(actor_id) is not int
            or actor_id <= 0 or type(session.actor_id) is not int
            or session.actor_id != actor_id or type(business_date) is not date):
        return None
    # This setting is server-owned Python wiring, never a browser value, import
    # path, credential, enabled flag or provider-authorization decision.
    reader = reader if reader is not None else getattr(settings, 'INSPECTION_KANBAN_READ_BATCH_READER', None)
    if not callable(reader):
        return None
    try:
        batch = reader(session=session, actor_id=actor_id, business_date=business_date)
        return _validate_reader_batch(batch) if batch is not None else None
    except Exception:
        # Keep the local board available and never serialize provider errors,
        # URLs, credentials or raw response bodies into this read surface.
        logger.warning('Inspection kanban read unavailable code=read_batch_unavailable')
        return None
