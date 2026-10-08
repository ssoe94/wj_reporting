"""Pure, bounded public board projection over already reviewed MES evidence.

No I/O, Django, credentials, provider field assumptions, persistence or writes.
The caller must normalize lifecycle/judgement using a verified provider contract
and supply a separately verified *current* local-plan/task binding. Device code
matching or the production board's shot allocation cannot establish that binding.
Input objects and collections are immutable; output is a fresh JSON-compatible
allowlist without MES/QC identifiers, actors, measurements or raw error messages.
"""
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import re


MAX_OBSERVATIONS = 50
MAX_BINDINGS = 34
KINDS = frozenset({'first', 'periodic', 'production', 'unknown'})
STAGES = frozenset({'waiting', 'in_progress', 'ended', 'unknown'})
RESULTS = frozenset({'passed', 'failed', 'unknown'})
EVIDENCE = frozenset({'live_read', 'sanitized_read_fixture', 'synthetic_contract_fixture'})


@dataclass(frozen=True)
class BoardScope:
    business_date: date
    machine_number: int
    current_plan_id: int | None
    plan_version: str


@dataclass(frozen=True)
class CurrentTaskBinding:
    tenant: str
    machine_number: int
    equipment_id: str
    work_order_id: str
    production_task_id: str
    local_plan_id: int
    business_date: date
    plan_version: str
    generation: int
    current_plan_verified: bool
    evidence_reference: str
    valid_from: datetime
    valid_until: datetime


@dataclass(frozen=True)
class QualityObservation:
    tenant: str
    equipment_id: str
    work_order_id: str
    production_task_id: str
    qc_id: str
    snapshot_id: str | None
    kind: str
    snapshot_kind: str
    stage: str
    judgement: str
    checked_at: datetime | None
    observed_at: datetime
    evidence_kind: str
    enum_contract_reference: str
    plan_name_type_mismatch: bool = False


@dataclass(frozen=True)
class ReadState:
    """Last completed collector attempt for this captured plan/binding scope.

    ``last_attempt_completed_at`` is completion time, whether successful or
    failed. ``last_success_at`` is completion time of the most recent successful
    attempt; it equals completion for status=ok and remains unchanged on error.
    Optional ``last_attempt_started_at`` belongs to that same completed attempt.
    Keep in-flight attempts separate: do not combine a new start with the prior
    attempt's completion/status in this immutable snapshot.
    """
    status: str  # ok/error/unavailable; error text never enters this contract.
    last_attempt_completed_at: datetime | None
    last_success_at: datetime | None
    generation: int
    complete: bool
    stale_after_seconds: int
    # None until the shared collector's supported cadence/rate limit is verified.
    refresh_after_seconds: int | None = None
    # Scope captured when this read batch started, not filled from the new plan
    # after an old request finishes. Fleet collectors supply this per machine.
    plan_version: str | None = None
    binding_generation: int | None = None
    last_attempt_started_at: datetime | None = None


@dataclass(frozen=True)
class PeriodicSchedule:
    binding_generation: int
    policy_reference: str
    next_due_at: datetime
    # This projection accepts only a verified schedule based on the latest check.
    # Task-start, shift/reset or other policy anchors need an explicit extension.
    anchor_checked_at: datetime


def _time(value):
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError('A timezone-aware datetime is required.')
    return value


def _label(value):
    if not isinstance(value, str) or not value or len(value) > 256:
        raise ValueError('A bounded nonempty reference is required.')


def _id(value):
    if not isinstance(value, str) or re.fullmatch(r'[1-9][0-9]{0,31}', value) is None:
        raise ValueError('MES IDs must be exact positive decimal strings.')


def _positive_int(value):
    if type(value) is not int or value <= 0:
        raise ValueError('A positive integer is required.')


def _version(value):
    if not isinstance(value, str) or re.fullmatch(r'[a-f0-9]{64}', value) is None:
        raise ValueError('Use the canonical scoped plan SHA256 version.')


def _iso(value):
    return value.isoformat() if value is not None else None


def _validate(scope, bindings, observations, read, now, schedule):
    _time(now)
    if type(scope.business_date) is not date or type(scope.machine_number) is not int or not 1 <= scope.machine_number <= 17:
        raise ValueError('A business date and machine 1 through 17 are required.')
    _version(scope.plan_version)
    if scope.current_plan_id is not None:
        _positive_int(scope.current_plan_id)
    if type(bindings) is not tuple or len(bindings) > MAX_BINDINGS or type(observations) is not tuple or len(observations) > MAX_OBSERVATIONS:
        raise ValueError('Use immutable bounded collections.')
    if read.status not in {'ok', 'error', 'unavailable'} or type(read.complete) is not bool:
        raise ValueError('Invalid read state.')
    if type(read.generation) is not int or read.generation < 0:
        raise ValueError('Invalid read generation.')
    if type(read.stale_after_seconds) is not int or not 1 <= read.stale_after_seconds <= 86400:
        raise ValueError('A bounded caller-defined freshness policy is required.')
    if read.refresh_after_seconds is not None and (type(read.refresh_after_seconds) is not int or not 1 <= read.refresh_after_seconds <= 86400):
        raise ValueError('Invalid verified refresh cadence.')
    if read.plan_version is not None:
        _version(read.plan_version)
    if read.binding_generation is not None and (type(read.binding_generation) is not int or read.binding_generation < 0):
        raise ValueError('Invalid read binding generation.')
    for stamp in (read.last_attempt_started_at, read.last_attempt_completed_at, read.last_success_at):
        if stamp is not None and _time(stamp) > now:
            raise ValueError('Read timestamps cannot be in the future.')
    if read.last_attempt_started_at is not None and (read.last_attempt_completed_at is None or read.last_attempt_started_at > read.last_attempt_completed_at):
        raise ValueError('Attempt start must precede its completion.')
    if read.last_success_at is not None and (read.last_attempt_completed_at is None or read.last_success_at > read.last_attempt_completed_at):
        raise ValueError('Last success cannot follow the latest attempt completion.')
    if read.status in {'ok', 'error'} and read.last_attempt_completed_at is None:
        raise ValueError('A completed attempt is required for ok/error status.')
    if read.status == 'ok' and read.last_success_at != read.last_attempt_completed_at:
        raise ValueError('The latest successful attempt must share its completion timestamp.')
    for binding in bindings:
        _label(binding.tenant)
        _label(binding.evidence_reference)
        _version(binding.plan_version)
        _positive_int(binding.local_plan_id)
        if type(binding.business_date) is not date or type(binding.machine_number) is not int or not 1 <= binding.machine_number <= 17:
            raise ValueError('Invalid binding scope.')
        if type(binding.current_plan_verified) is not bool or type(binding.generation) is not int or binding.generation < 0:
            raise ValueError('Invalid binding verification.')
        if _time(binding.valid_from) >= _time(binding.valid_until):
            raise ValueError('Binding validity must be bounded.')
        for identifier in (binding.equipment_id, binding.work_order_id, binding.production_task_id):
            _id(identifier)
    for item in observations:
        _label(item.tenant)
        _label(item.enum_contract_reference)
        for identifier in (item.equipment_id, item.work_order_id, item.production_task_id, item.qc_id):
            _id(identifier)
        if item.snapshot_id is not None:
            _id(item.snapshot_id)
        if item.kind not in KINDS or item.snapshot_kind not in KINDS or item.stage not in STAGES or item.judgement not in RESULTS or item.evidence_kind not in EVIDENCE or type(item.plan_name_type_mismatch) is not bool:
            raise ValueError('Unreviewed semantic value.')
        if _time(item.observed_at) > now or (item.checked_at is not None and _time(item.checked_at) > item.observed_at):
            raise ValueError('Invalid observation chronology.')
    if schedule is not None:
        _label(schedule.policy_reference)
        _time(schedule.next_due_at)
        _time(schedule.anchor_checked_at)
        if type(schedule.binding_generation) is not int or schedule.binding_generation < 0 or schedule.next_due_at <= schedule.anchor_checked_at:
            raise ValueError('Invalid schedule evidence.')


def _check(item, duplicates):
    warnings = []
    valid = item.snapshot_id is not None and item.kind == item.snapshot_kind and item.kind != 'unknown'
    if not valid:
        warnings.append('snapshot_type_unverified')
    if (item.tenant, item.qc_id) in duplicates:
        valid = False
        warnings.append('duplicate_qc_evidence')
    if item.plan_name_type_mismatch:
        warnings.append('plan_name_type_mismatch')
    status = 'unknown'
    if valid and item.stage in {'waiting', 'in_progress'}:
        status = item.stage
    elif valid and item.stage == 'ended' and item.checked_at is not None:
        status = item.judgement
    # Each QC remains a separate redacted entry; no upstream identity is exposed.
    return {'kind': item.kind if valid else 'unknown', 'status': status,
            'checked_at': _iso(item.checked_at) if valid and item.stage == 'ended' else None,
            'warnings': warnings}


def _aggregate(checks, complete):
    states = [item['status'] for item in checks]
    if 'failed' in states:
        return 'failed'
    if not complete or not states or 'unknown' in states:
        return 'unknown'
    if 'in_progress' in states:
        return 'in_progress'
    if 'waiting' in states:
        return 'waiting'
    return 'passed'


def project_machine_quality(scope, *, bindings, observations, read, now, schedule=None):
    """Return a public summary; it never grants editing, production or MES rights.

    Caller must invalidate older read generations and must not reuse the result
    after a plan-version change. Collection completeness means this exact task's
    expected QC population, not merely successful receipt of one QC detail.
    """
    _validate(scope, bindings, observations, read, now, schedule)
    result = {'schema_version': 'injection-quality-status.v1',
        'machine_number': scope.machine_number, 'business_date': scope.business_date.isoformat(),
        'current_plan_id': scope.current_plan_id, 'plan_version': scope.plan_version,
        'binding_generation': None, 'read_generation': read.generation,
        'binding_status': 'unresolved', 'availability': read.status,
        'freshness': 'unavailable', 'fresh_until': None,
        'last_attempt_started_at': _iso(read.last_attempt_started_at),
        'last_attempt_completed_at': _iso(read.last_attempt_completed_at),
        'last_success_at': _iso(read.last_success_at), 'observed_at': None,
        'refresh_after_seconds': read.refresh_after_seconds, 'complete': False,
        'first': {'status': 'unknown', 'last_known_status': 'unknown', 'checks': []},
        'periodic': {'status': 'unknown', 'last_known_status': 'unknown', 'checks': [],
            'last_checked_at': None, 'last_result': 'unknown',
            'next_due_at': None, 'schedule_status': 'unverified'},
        'other_checks': [], 'warnings': []}
    candidates = [b for b in bindings if b.machine_number == scope.machine_number
        and b.local_plan_id == scope.current_plan_id and b.business_date == scope.business_date
        and b.plan_version == scope.plan_version and b.current_plan_verified
        and b.valid_from <= now < b.valid_until]
    if len(candidates) != 1:
        result['warnings'].append('current_task_binding_unresolved')
        return result
    binding = candidates[0]
    result.update(binding_status='verified', binding_generation=binding.generation)
    if read.plan_version != scope.plan_version or read.binding_generation != binding.generation:
        result['warnings'].append('read_scope_mismatch')
        return result
    selected = tuple(item for item in observations if
        (item.tenant, item.equipment_id, item.work_order_id, item.production_task_id) ==
        (binding.tenant, binding.equipment_id, binding.work_order_id, binding.production_task_id))
    # A conflicting copy assigned to another task must also quarantine the QC.
    # Filtering first would hide cross-scope identity corruption.
    identities = Counter((item.tenant, item.qc_id) for item in observations)
    duplicates = {(item.tenant, item.qc_id) for item in selected
                  if identities[(item.tenant, item.qc_id)] > 1}
    # Old fixture evidence is never promoted by a recent successful fetch time.
    live = bool(selected) and all(item.evidence_kind == 'live_read' for item in selected)
    observed_at = min((item.observed_at for item in selected), default=None)
    fresh = (read.status == 'ok' and read.last_success_at is not None and live
        and observed_at is not None and now - min(read.last_success_at, observed_at)
        <= timedelta(seconds=read.stale_after_seconds))
    if live and observed_at is not None and read.last_success_at is not None:
        result['fresh_until'] = _iso(min(binding.valid_until,
            min(read.last_success_at, observed_at) + timedelta(seconds=read.stale_after_seconds)))
    complete = read.complete and not duplicates and live and all(
        item.snapshot_id is not None and item.kind == item.snapshot_kind and item.kind != 'unknown'
        for item in selected)
    result.update(observed_at=_iso(observed_at), complete=complete,
        freshness='fresh' if fresh else 'fixture' if selected and not live else 'stale' if selected else 'unavailable')
    if duplicates:
        result['warnings'].append('duplicate_qc_evidence')
    checks = [_check(item, duplicates) for item in sorted(selected,
        key=lambda item: (item.kind, item.checked_at or item.observed_at, item.qc_id, item.snapshot_id or ''))]
    for kind in ('first', 'periodic'):
        group = [item for item in checks if item['kind'] == kind]
        known = _aggregate(group, complete)
        result[kind].update(checks=group, last_known_status=known,
                            status=known if fresh else 'unknown')
    result['other_checks'] = [item for item in checks if item['kind'] not in {'first', 'periodic'}]
    completed = [item for item in result['periodic']['checks'] if item['checked_at'] is not None]
    latest = max((datetime.fromisoformat(item['checked_at']) for item in completed), default=None)
    if latest is not None:
        latest_results = {item['status'] for item in completed if datetime.fromisoformat(item['checked_at']) == latest}
        result['periodic'].update(last_checked_at=_iso(latest),
            last_result=next(iter(latest_results)) if len(latest_results) == 1 else 'unknown')
    periodic = result['periodic']
    pending = [item['status'] for item in periodic['checks'] if item['checked_at'] is None]
    periodic_known = ('unknown' if not complete or 'unknown' in pending else
        'in_progress' if 'in_progress' in pending else 'waiting' if 'waiting' in pending else periodic['last_result'])
    # Two periodic QC snapshots may be repetitions of one plan OR independent
    # required plans. The reviewed input has no series identity yet. A new pass
    # must not erase another plan's failure, nor establish one global deadline.
    if len(periodic['checks']) > 1:
        periodic_known = 'unknown'
        result['warnings'].append('periodic_series_unresolved')
    periodic.update(last_known_status=periodic_known, status=periodic_known if fresh else 'unknown')
    if schedule is not None and len(periodic['checks']) == 1 and schedule.binding_generation == binding.generation and latest == schedule.anchor_checked_at:
        result['periodic']['next_due_at'] = _iso(schedule.next_due_at)
        result['periodic']['schedule_status'] = ('overdue' if now > schedule.next_due_at else 'scheduled') if fresh and complete else 'unknown'
    return result
