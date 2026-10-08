"""Bounded database-only reader of server-published, verified stage evidence.

No credentials, MES client, network, names, production-plan inference or writes.
The public display scope selects evidence; it never supplies missing provenance.
"""
from datetime import date, datetime, timedelta
import re

from django.db import DatabaseError
from django.db.models import F
from django.utils import timezone

from .inspection_board_status import (
    BoardScope, CurrentTaskBinding, QualityObservation, ReadState,
)
from .inspection_models import InspectionRequest


LIMIT = 50
SCHEMA = 'inspection-stage-observation.v1'
IDENTITY_KEYS = {'tenant', 'qc_id', 'work_order_id', 'production_task_id',
                 'equipment_id', 'snapshot_id'}
PLAN_KEYS = {'business_date', 'machine_number', 'current_plan_id', 'plan_version',
             'generation', 'reference', 'valid_from', 'valid_until', 'stale_after_seconds'}
STAGE_KEYS = {'schema', 'identity', 'state', 'judgement', 'observed_at', 'checked_at',
              'kind', 'evidence_digest', 'policy_fingerprint', 'plan_binding'}


def _hash(value):
    if type(value) is not str or re.fullmatch(r'[a-f0-9]{64}', value) is None:
        raise ValueError('Invalid evidence hash.')
    return value


def _text(value):
    if type(value) is not str or not value.strip() or len(value) > 256:
        raise ValueError('Invalid evidence reference.')
    return value


def _time(value):
    if type(value) is not str or len(value) > 64:
        raise ValueError('Invalid evidence time.')
    result = datetime.fromisoformat(value)
    if result.utcoffset() is None:
        raise ValueError('Evidence time must have an offset.')
    return result


def _integer(value, minimum=0, maximum=2**63 - 1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('Invalid evidence integer.')
    return value


def _scope_valid(scope):
    return (type(scope) is BoardScope and type(scope.business_date) is date
            and type(scope.machine_number) is int and 1 <= scope.machine_number <= 17
            and type(scope.current_plan_id) is int and scope.current_plan_id > 0
            and type(scope.plan_version) is str
            and re.fullmatch(r'[a-f0-9]{64}', scope.plan_version) is not None)


def _decode(record, scope, now):
    stage = record['stage']
    if (type(stage) is not dict or set(stage) != STAGE_KEYS or stage['schema'] != SCHEMA
            or record['sync_status'] != 'succeeded'
            or record['source_kind'] == 'integration_test'
            or record['mes_binding__test_only'] is not False
            or record['mes_binding__request_id'] != record['pk']):
        raise ValueError('Unverified stage record.')
    identity, plan = stage['identity'], stage['plan_binding']
    if type(identity) is not dict or set(identity) != IDENTITY_KEYS:
        raise ValueError('Invalid stage identity.')
    _text(identity['tenant'])
    for key in IDENTITY_KEYS - {'tenant'}:
        if type(identity[key]) is not str or re.fullmatch(r'[1-9][0-9]{0,18}', identity[key]) is None:
            raise ValueError('Invalid stage identity.')
    contract = record['mes_binding__contract']
    if type(contract) is not dict or any(identity[key] != record['mes_binding__' + key]
            for key in ('tenant', 'qc_id', 'work_order_id')) or any(
            identity[key] != contract.get(key) for key in ('production_task_id', 'equipment_id', 'snapshot_id')):
        raise ValueError('Stage binding changed.')
    if (type(plan) is not dict or set(plan) != PLAN_KEYS
            or plan['business_date'] != scope.business_date.isoformat()
            or _integer(plan['machine_number'], 1, 17) != scope.machine_number
            or _integer(plan['current_plan_id'], 1) != scope.current_plan_id
            or _hash(plan['plan_version']) != scope.plan_version):
        raise ValueError('Stage plan scope changed.')
    generation = _integer(plan['generation'])
    stale_after = _integer(plan['stale_after_seconds'], 1, 86400)
    reference = _text(plan['reference'])
    start, end, observed = (_time(plan['valid_from']), _time(plan['valid_until']),
                            _time(stage['observed_at']))
    if not start <= observed <= now < end or now - observed > timedelta(seconds=stale_after):
        raise ValueError('Stage evidence expired.')
    if (_hash(stage['evidence_digest']) != record['mes_binding__evidence_digest']
            or observed != record['mes_binding__last_verified_at']):
        raise ValueError('Stage verification changed.')
    policy = _hash(stage['policy_fingerprint'])
    state, judgement, kind = stage['state'], stage['judgement'], stage['kind']
    expected_phase = {'open': 'saved', 'completed': 'completed', 'approval_pending': 'completed'}
    if (state not in expected_phase or record['mes_binding__phase'] != expected_phase[state]
            or kind not in {'first', 'periodic', 'production'}
            or judgement not in {None, 'pass', 'fail'}):
        raise ValueError('Invalid stage result.')
    checked = _time(stage['checked_at']) if stage['checked_at'] is not None else None
    if checked is not None and checked > observed:
        raise ValueError('Invalid completion chronology.')
    if state == 'completed' and (checked is None or judgement is None):
        raise ValueError('Completion evidence is missing.')
    binding = CurrentTaskBinding(identity['tenant'], scope.machine_number,
        identity['equipment_id'], identity['work_order_id'], identity['production_task_id'],
        scope.current_plan_id, scope.business_date, plan['plan_version'], generation,
        True, reference, start, end)
    observation = QualityObservation(identity['tenant'], identity['equipment_id'],
        identity['work_order_id'], identity['production_task_id'], identity['qc_id'],
        identity['snapshot_id'], kind, kind, 'ended' if state == 'completed' else 'in_progress',
        {'pass': 'passed', 'fail': 'failed'}[judgement] if state == 'completed' else 'unknown',
        checked if state == 'completed' else None, observed, 'live_read', policy)
    return binding, observation, stale_after


def read_persisted_board_source(scope, *, now=None):
    """Return only an exact, fresh immutable batch, or no publishable evidence.

    One SELECT captures request state and its related binding together. All
    selected records must validate, including unsuccessful/unknown writes; those
    records must not disappear behind a success-only filter. No row is changed.
    """
    if not _scope_valid(scope):
        return None
    now = timezone.now() if now is None else now
    if not isinstance(now, datetime) or now.utcoffset() is None:
        return None
    try:
        records = list(InspectionRequest.objects.filter(
            mes_binding__test_only=False,
            mes_snapshot__verified_stage__plan_binding__business_date=scope.business_date.isoformat(),
            mes_snapshot__verified_stage__plan_binding__machine_number=scope.machine_number,
            mes_snapshot__verified_stage__plan_binding__current_plan_id=scope.current_plan_id,
            mes_snapshot__verified_stage__plan_binding__plan_version=scope.plan_version,
        ).exclude(source_kind='integration_test').order_by('pk').values('pk', 'source_kind',
            'sync_status', 'mes_binding__test_only', 'mes_binding__request_id',
            'mes_binding__tenant', 'mes_binding__qc_id', 'mes_binding__work_order_id',
            'mes_binding__contract', 'mes_binding__phase', 'mes_binding__evidence_digest',
            'mes_binding__last_verified_at', stage=F('mes_snapshot__verified_stage'))[:LIMIT + 1])
        if not records or len(records) > LIMIT:
            return None
        decoded = [_decode(record, scope, now) for record in records]
        binding = decoded[0][0]
        observations = tuple(row[1] for row in decoded)
        # One current local plan cannot silently select between conflicting MES
        # tasks or policy generations. Multiple distinct QC observations remain.
        if (any(row[0] != binding for row in decoded)
                or len({(row.tenant, row.qc_id) for row in observations}) != len(observations)):
            return None
        latest = max(row.observed_at for row in observations)
        read = ReadState('ok', latest, latest, binding.generation, False,
            min(row[2] for row in decoded), plan_version=binding.plan_version,
            binding_generation=binding.generation)
        from .inspection_board_source import BoardQualitySource
        return BoardQualitySource((binding,), observations, read)
    except (DatabaseError, ValueError, TypeError, KeyError, OverflowError):
        return None
