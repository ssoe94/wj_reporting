"""Read-only field projection. No MES imports, inferred task binding or dispatch."""
from datetime import datetime, time, timedelta
from hashlib import sha256
import json
import re
from zoneinfo import ZoneInfo

from django.db.models import Q, Case, When, IntegerField
from django.utils import timezone
from production.models import ProductionPlan, ProductionPlanChangeLog, ProductionExecution
from .inspection_models import InspectionRequest
from .inspection_workflow import serialize
from .inspection_read_snapshot import get_read_batch, project_observations

SHANGHAI = ZoneInfo('Asia/Shanghai')
ROW_LIMIT = 500
TRIAL_SCHEMA = 'integration-trial-observation.v1'
TRIAL_PHASES = {'ready', 'save_pending', 'save_unknown', 'saved', 'finish_pending',
                'finish_unknown', 'completed', 'blocked'}


def _trial_projection(request, *, now):
    """Display server-owned trial metadata; never substitute local judgement."""
    binding = getattr(request, 'mes_binding', None)
    contract = binding.contract if binding and type(binding.contract) is dict else {}
    code = contract.get('qc_code')
    code = code if type(code) is str and code.strip() and len(code) <= 128 else None
    phase = binding.phase if binding and binding.phase in TRIAL_PHASES else 'unbound'
    verdict, observed = None, None
    snapshot = request.mes_snapshot
    proof = snapshot.get('verified_trial') if type(snapshot) is dict else None
    if (binding and binding.test_only is True and request.sync_status == 'succeeded'
            and type(proof) is dict and set(proof) == {
                'schema', 'identity', 'state', 'judgement', 'observed_at', 'evidence_digest'}
            and proof['schema'] == TRIAL_SCHEMA
            and proof['identity'] == {'qc_id': binding.qc_id}
            and type(proof['evidence_digest']) is str
            and re.fullmatch(r'[a-f0-9]{64}', proof['evidence_digest'])
            and proof['evidence_digest'] == binding.evidence_digest):
        state = proof['state']
        expected_phase = {'open': 'saved', 'completed': 'completed', 'approval_pending': 'completed'}
        expected_completion = {'open': 'not_completed', 'completed': 'completed',
                               'approval_pending': 'approval_pending'}
        try:
            stamp = datetime.fromisoformat(proof['observed_at'])
            judgement = proof['judgement']
            valid_judgement = (type(judgement) is str and judgement in {'pass', 'fail'})
            if (stamp.utcoffset() is not None and stamp <= now
                    and stamp == binding.last_verified_at
                    and expected_phase.get(state) == phase
                    and expected_completion.get(state) == request.mes_completion_status
                    and (valid_judgement or (state != 'completed' and judgement is None))):
                observed = stamp.isoformat()
                if state == 'completed':
                    verdict = judgement
        except (TypeError, ValueError):
            pass
    return {'request_id': str(request.pk), 'qc_code': code,
        'test_label': binding.test_label if binding else '', 'phase': phase,
        'trial_verdict': verdict, 'observed_at': observed,
        'test_only': True, 'production_counted': False}


def machine_label_number(value):
    """Display association only: never interpret an opaque MES resource ID."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    patterns = (
        r'(?:imm|注塑)0?([1-9]|1[0-7])',
        r'0?([1-9]|1[0-7])(?:号注塑机|号机|号|호기)',
        r'\d{3,4}T-0?([1-9]|1[0-7])',
        r'#0?([1-9]|1[0-7])-\d{3,4}T',
    )
    for pattern in patterns:
        match = re.fullmatch(pattern, value, flags=re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def business_date(now=None):
    return ((now or timezone.now()).astimezone(SHANGHAI) - timedelta(hours=8)).date()


def projection(user, target_date=None, *, now=None):
    now = now or timezone.now()
    target_date = target_date or business_date(now)
    start = datetime.combine(target_date, time(8), tzinfo=SHANGHAI)
    end = start + timedelta(days=1)
    plans = list(ProductionPlan.objects.filter(plan_date=target_date, plan_type='injection')
                 .order_by('machine_name', 'sequence', 'id')[:ROW_LIMIT + 1])
    executions = list(ProductionExecution.objects.filter(plan_date=target_date, plan_type='injection')
                      .order_by('id')[:ROW_LIMIT + 1])
    as_of = min(now, end)
    # A completion observed today may belong to a request created days ago.
    # Unknown completion evidence stays in the backlog. Never expose future
    # requests as work already available or let new arrivals bury overdue ones.
    scoped_requests = InspectionRequest.objects.filter(created_at__lt=as_of).filter(
        ~Q(mes_completion_status='completed') | Q(mes_checked_at__isnull=True)
        | Q(mes_checked_at__gte=start, mes_checked_at__lt=as_of)
    )
    trial_scope = Q(source_kind='integration_test') | Q(mes_binding__test_only=True)
    trials = list(scoped_requests.filter(trial_scope).select_related('mes_binding')
                  .order_by('created_at', 'id')[:ROW_LIMIT + 1])
    trials_truncated = len(trials) > ROW_LIMIT
    requests = list(scoped_requests.exclude(trial_scope).select_related('reinspection').annotate(
        completion_order=Case(When(mes_completion_status='completed', mes_checked_at__isnull=False,
                                   then=1), default=0, output_field=IntegerField())
    ).order_by('completion_order', 'created_at', 'id')[:ROW_LIMIT + 1])
    latest_change = ProductionPlanChangeLog.objects.filter(plan_date=target_date, plan_type='injection').order_by('-created_at', '-id').first()
    plans_truncated, executions_truncated, requests_truncated = (len(rows) > ROW_LIMIT for rows in (plans, executions, requests))
    plans, executions, requests = (rows[:ROW_LIMIT] for rows in (plans, executions, requests))
    version_input = [[row.id, row.machine_name, row.part_no, row.lot_no, row.sequence,
                      str(row.planned_quantity), row.updated_at.isoformat()] for row in plans]
    # Whole scoped dataset + delete/upload change identity; never just a mutable plan ID.
    version = sha256(json.dumps({'date': target_date.isoformat(), 'plans': version_input,
        'change': latest_change.id if latest_change else None, 'truncated': plans_truncated},
        ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    latest_at = max([row.updated_at for row in plans] + ([latest_change.created_at] if latest_change else []), default=None)
    execution_map = {(row.machine_name, row.part_no or '', row.lot_no or '', row.sequence): row for row in executions}
    machines = {number: {'machine_number': number, 'station_id': f'imm{number:02d}',
        'mapping_status': 'label_only_unverified', 'plans': [], 'requests': [],
        'request_count': 0, 'requests_truncated': requests_truncated} for number in range(1, 18)}
    unmapped_plans, unmapped_requests = [], []
    for row in plans:
        execution = execution_map.get((row.machine_name, row.part_no or '', row.lot_no or '', row.sequence))
        plan = {'id': row.id, 'machine_name': row.machine_name, 'part_no': row.part_no or '',
                'lot_no': row.lot_no or '', 'sequence': row.sequence,
                'planned_quantity': str(row.planned_quantity), 'updated_at': row.updated_at.isoformat(),
                'execution_status': execution.status if execution else None}
        number = machine_label_number(row.machine_name)
        (machines[number]['plans'] if number else unmapped_plans).append(plan)
    for row in requests:
        item = serialize(row, user, detail=False)
        number = machine_label_number(row.equipment_ref)
        machine_plans = machines[number]['plans'] if number else []
        matching = [plan['id'] for plan in machine_plans
                    if plan['part_no'] == row.part_no and plan['lot_no'] == row.lot_ref]
        item['plan_alignment'] = {
            'status': ('unknown' if not number or plans_truncated or unmapped_plans
                       else 'part_listed' if matching else 'part_not_listed'),
            'matching_plan_ids': matching, 'task_binding_verified': False,
        }
        (machines[number]['requests'] if number else unmapped_requests).append(item)
    # Separate read-only evidence: never import it into editable WJ requests or
    # use it to release uncertain write/reconciliation locks.
    batch = get_read_batch()
    mes = project_observations(**batch) if batch is not None else None
    for number, machine in machines.items():
        machine['mes_observations'] = mes['machines'][number] if mes else []
    for machine in machines.values():
        machine['request_count'] = len(machine['requests'])
        status = 'present' if machine['plans'] else 'missing'
        if plans_truncated or unmapped_plans:
            status = 'unknown'
        machine['plan_status'] = status
        running_local = any(row['execution_status'] == 'running' for row in machine['plans'])
        paused_local = any(row['execution_status'] == 'paused' for row in machine['plans'])
        observed = any(row['mes_completion_status'] != 'completed' or not row['mes_checked_at']
                       for row in machine['requests']) or running_local or paused_local
        candidate = ('review_pause' if observed and status == 'missing' else
                     'review_resume' if paused_local and status == 'present' else
                     'review_alignment' if observed else 'none')
        reasons = ['automation_not_authorized', 'mes_task_plan_binding_missing',
                   'mes_state_unverified', 'machine_resource_mapping_unverified',
                   'plan_freshness_unverified', 'debounce_and_manual_override_policy_unconfirmed',
                   'resume_first_inspection_policy_unconfirmed']
        if target_date != business_date(now):
            reasons.append('plan_date_not_current')
        if status == 'missing':
            reasons.append('plan_missing')
        elif status == 'unknown':
            reasons.append('plan_mapping_or_completeness_unknown')
        if executions_truncated or requests_truncated:
            reasons.append('source_truncated')
        if any(row['mes_completion_status'] != 'completed' or not row['mes_checked_at']
               for row in machine['requests']):
            reasons.append('inspection_completion_unverified')
        if any(row['plan_alignment']['status'] == 'part_not_listed' for row in machine['requests']):
            reasons.append('request_not_in_plan')
        machine['dry_run'] = {'enabled': False, 'mode': 'dry_run', 'candidate': candidate,
            'recommendation': 'review_unplanned_work' if candidate == 'review_pause' else
                'verify_task_plan_binding' if observed else 'no_work_observed',
            'blocking_reasons': reasons, 'plan_version': version,
            'requires_new_first_inspection_on_resume': 'tenant_policy_unverified'}
    return {'schema_version': 'inspection-kanban.v1', 'business_date': target_date.isoformat(),
        'day_start': start.isoformat(), 'day_end': end.isoformat(), 'generated_at': now.isoformat(),
        'plan_snapshot': {'source': 'ProductionPlan', 'version': version,
            'latest_changed_at': latest_at.isoformat() if latest_at else None,
            'shift_stored': False, 'work_task_binding_available': False, 'freshness_verified': False,
            'complete': not plans_truncated and not unmapped_plans},
        'mes_read_snapshot': {'availability': 'fixture_observations' if mes else 'unavailable',
            'displayed': mes['displayed'] if mes else 0, 'complete': False,
            'current_state_verified': False},
        'mes_unmapped_observations': mes['unmapped'] if mes else [],
        'machines': list(machines.values()), 'unmapped_requests': unmapped_requests,
        'integration_trials': [_trial_projection(row, now=now) for row in trials[:ROW_LIMIT]],
        'integration_trials_truncated': trials_truncated,
        'unmapped_plans': unmapped_plans, 'requests_truncated': requests_truncated,
        'plans_truncated': plans_truncated, 'executions_truncated': executions_truncated,
        'counts': {'requests_displayed': len(requests), 'plans_displayed': len(plans),
            'unmapped_requests': len(unmapped_requests), 'unmapped_plans': len(unmapped_plans)}}
