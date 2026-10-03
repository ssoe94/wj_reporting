"""Add bounded quality fields to an already-built canonical production row.

No queries, provider response decoding, machine-name matching or live reads.
The production allocator's current plan is only a display scope; the quality
provider must independently verify that plan's current MES binding.
"""
from datetime import date, datetime
from hashlib import sha256
import json
import math

from quality import inspection_board_source
from quality.inspection_board_status import BoardScope, ReadState, project_machine_quality


PLAN_FIELDS = ('plan_id', 'sequence', 'part_no', 'lot_no', 'planned_qty', 'cavity',
    'cavity_pattern', 'parts_per_shot', 'cavity_group', 'total_cavity',
    'production_group_id', 'production_group_complete')


def _scope(target_date, row, plan_updated_at):
    number = row.get('machine_number')
    if type(target_date) is not date or type(number) is not int or not 1 <= number <= 17:
        raise ValueError('An exact canonical date and machine number are required.')
    parts = row.get('parts', [])
    if not isinstance(parts, (list, tuple)) or len(parts) > 500:
        raise ValueError('Invalid canonical plan rows.')
    if plan_updated_at is not None and (not isinstance(plan_updated_at, datetime) or plan_updated_at.utcoffset() is None):
        raise ValueError('Invalid canonical plan revision time.')
    canonical = []
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError('Invalid canonical plan row.')
        record = {}
        for field in PLAN_FIELDS:
            value = part.get(field)
            if value is not None and not isinstance(value, (str, int, float, bool)):
                raise ValueError('Invalid canonical plan field.')
            if isinstance(value, str) and len(value) > 512:
                raise ValueError('Canonical plan field exceeds bound.')
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError('Invalid canonical plan number.')
            record[field] = value
        canonical.append(record)
    plan_ids = [part['plan_id'] for part in canonical]
    transition = row.get('transition')
    current = transition.get('current_plan_id') if isinstance(transition, dict) else None
    # No in-progress/pending/name/part fallback for the quality connection.
    if type(current) is not int or current <= 0 or plan_ids.count(current) != 1:
        current = None
    revision = plan_updated_at.isoformat() if plan_updated_at is not None else None
    version = sha256(json.dumps({'schema': 'board-plan-scope.v1',
        'business_date': target_date.isoformat(), 'machine_number': number,
        'current_plan_id': current, 'plan_updated_at': revision, 'plans': canonical},
        sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    return BoardScope(target_date, number, current, version), revision


def build_inspection_board_fields(target_date, row, *, plan_updated_at, now):
    try:
        scope, revision = _scope(target_date, row, plan_updated_at)
    except Exception:
        # These optional bounds are stricter than the production response. A
        # valid legacy row must still render if no safe quality scope can be
        # built; neither a fabricated identity nor an old result may escape.
        return {'inspection_scope': None, 'inspection_status': None}
    # No observations exist in this branch, so this one-second validation value
    # never supplies a live freshness budget or a polling cadence.
    unavailable = ReadState('unavailable', None, None, 0, False, 1,
        plan_version=scope.plan_version)
    fallback = lambda: project_machine_quality(scope, bindings=(), observations=(),
        read=unavailable, now=now)
    try:
        source = inspection_board_source.read_board_quality_source(scope)
        status = fallback() if source is None else project_machine_quality(scope,
            bindings=source.bindings, observations=source.observations, read=source.read,
            schedule=source.schedule, now=now)
    except Exception:
        # A broken optional projection must not hide production metrics. No raw
        # provider error/ref/reference is exposed through this public endpoint.
        status = fallback()
        status['availability'] = 'error'
        status['warnings'].append('quality_projection_unavailable')
    return {'inspection_scope': {'business_date': target_date.isoformat(),
        'machine_number': scope.machine_number, 'current_plan_id': scope.current_plan_id,
        'plan_version': scope.plan_version, 'plan_updated_at': revision},
        'inspection_status': status}
