"""Deterministic, read-only comparison. Plan membership never proves current production.

This module deliberately has no Django, credential or network dependencies.
Inputs are canonical, whitelisted records prepared by the service boundary.
"""
from collections import Counter
from datetime import datetime, timedelta
from math import isfinite
from zoneinfo import ZoneInfo

from .cavity import build_cavity_plan_groups

SHANGHAI = ZoneInfo('Asia/Shanghai')


def business_date_at(now):
    return (now.astimezone(SHANGHAI) - timedelta(hours=8)).date()


def quantity(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if isfinite(result) and result >= 0 else None
    except (ValueError, TypeError, OverflowError):
        return None


def timestamp(value):
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return datetime.fromtimestamp(value / 1000, SHANGHAI)
        if isinstance(value, str) and value:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return parsed.astimezone(SHANGHAI) if parsed.tzinfo else None
    except (ValueError, TypeError, OverflowError, OSError):
        pass
    return None


def observe_samples(samples):
    """A positive counter delta is evidence of activity, never of a task identity."""
    valid = sorted(
        [(at, count) for row in samples
         if (at := timestamp(row.get('timestamp'))) is not None
         and (count := quantity(row.get('capacity'))) is not None],
        key=lambda item: item[0],
    )
    increases = any(right[0] > left[0] and right[1] > left[1]
                    for left, right in zip(valid, valid[1:]))
    return {
        'state': 'activity_observed' if increases else
                 'no_increase_observed' if len({at for at, _ in valid}) >= 2 else 'insufficient_data',
        'sample_count': len(valid),
        'first_at': valid[0][0].isoformat() if valid else None,
        'last_at': valid[-1][0].isoformat() if valid else None,
    }


def reconcile(*, business_date, plans, tasks, cavity_map, observations, mes_complete,
              queried_at, now, warnings=(), old_days=14, plan_source_complete=True):
    next_date = business_date + timedelta(days=1)
    dates = [business_date.isoformat(), next_date.isoformat()]
    historical = business_date != business_date_at(now)
    result_warnings = list(warnings)
    if historical:
        result_warnings.append('current_snapshot_with_other_date')
    unmapped = [dict(task, assessment='unmapped', reasons=['equipment_unmapped'])
                for task in tasks if task.get('machine_number') not in range(1, 18)]
    if unmapped:
        result_warnings.append('equipment_assignment_incomplete')
    # An unmapped task could belong to any planned machine. Do not assert absence.
    coverage_complete = mes_complete and not unmapped
    machines = []
    for number in range(1, 18):
        machine_plans = [dict(plan) for plan in plans
                         if plan['machine_number'] == number and plan['plan_date'] in dates]
        machine_tasks = [dict(task) for task in tasks if task.get('machine_number') == number]
        today = [plan for plan in machine_plans if plan['plan_date'] == dates[0]]
        tomorrow = [plan for plan in machine_plans if plan['plan_date'] == dates[1]]
        today_parts = {plan['part_no'] for plan in today if plan['part_no']}
        next_parts = {plan['part_no'] for plan in tomorrow if plan['part_no']}
        plans_known = bool(today) and bool(tomorrow) and all(plan['part_no'] for plan in machine_plans)
        task_counts = Counter(task['part_no'] for task in machine_tasks)
        plan_counts = Counter(plan['part_no'] for plan in today)
        for day in dates:
            day_plans = [plan for plan in machine_plans if plan['plan_date'] == day]
            day_plans.sort(key=lambda plan: (plan['sequence'], plan['plan_id']))
            for index, group in enumerate(build_cavity_plan_groups(day_plans, cavity_map)):
                members = group['members']
                for member in members:
                    plan = member['plan']
                    plan['group_id'] = f'{number}:{day}:{index}'
                    plan['parallel_parts'] = [item['part_no'] for item in members] if len(members) > 1 else []
                    plan['group_incomplete'] = len(members) < member['meta']['parts_per_shot']

        for task in machine_tasks:
            part = task['part_no']
            task['plan_relation'] = ('today' if part in today_parts else
                                     'next_date' if part in next_parts else 'outside_plans')
            reasons = []
            if not coverage_complete or not task.get('identity_complete', False):
                assessment = 'unknown'
                reasons.append('mes_incomplete')
            elif not plan_source_complete:
                assessment = 'unknown'
                reasons.append('plan_scope_incomplete')
            elif historical:
                assessment = 'unknown'
                reasons.append('current_snapshot_with_other_date')
            elif not today:
                assessment = 'unknown'
                reasons.append('today_plan_missing')
            elif task_counts[part] > 1 or plan_counts[part] > 1:
                assessment = 'task_link_review'
                reasons.append('multiple_tasks_or_plan_lots')
            elif part in today_parts:
                assessment = 'plan_match' if task['status'] == 2 else 'start_needed'
                reasons.append('today_plan_membership_only')
            elif part in next_parts:
                assessment = 'next_plan_match'
                reasons.append('next_plan_membership_only')
            elif not plans_known:
                assessment = 'unknown'
                reasons.append('plan_scope_incomplete')
            elif task['status'] == 2:
                assessment = 'pause_review'
                reasons.append('running_outside_plans')
            else:
                assessment = 'outside_plan'
                reasons.append('inactive_outside_plans')
            # Age is explicitly opening age, not "last activity" or permission to finish.
            opened = timestamp(task.get('actual_start'))
            if opened and now - opened >= timedelta(days=old_days):
                reasons.append('opened_long_ago')
            planned, reported = task.get('planned_quantity'), task.get('reported_quantity')
            if (task.get('quantity_unit') and planned is not None and planned > 0
                    and reported is not None and reported >= planned):
                reasons.append('reported_quantity_reached')
            if reported == 0:
                reasons.append('no_reported_quantity')
            task.update(assessment=assessment, reasons=reasons)

        for plan in machine_plans:
            matches = [task for task in machine_tasks if task['part_no'] == plan['part_no']]
            plan['matching_task_ids'] = [task['task_id'] for task in matches]
            if not coverage_complete or not plan_source_complete or historical or not plan['part_no']:
                plan['assessment'] = 'unknown'
            elif not matches:
                plan['assessment'] = 'no_open_task'
            elif plan['plan_date'] != dates[0]:
                plan['assessment'] = 'next_plan_match'
            elif task_counts[plan['part_no']] > 1 or plan_counts[plan['part_no']] > 1:
                plan['assessment'] = 'task_link_review'
            elif any(task['status'] == 2 for task in matches):
                plan['assessment'] = 'plan_match'
            else:
                plan['assessment'] = 'start_needed'
        machines.append({
            'machine_number': number, 'plans': machine_plans, 'tasks': machine_tasks,
            'plan_scope': 'present' if plans_known else 'incomplete',
            'observation': observations.get(number, observe_samples([])),
        })
    return {
        'business_date': dates[0], 'next_business_date': dates[1],
        'next_date_basis': 'next_08h_window', 'machines': machines, 'unmapped_tasks': unmapped,
        'data_freshness': {'queried_at': queried_at, 'mes_complete': mes_complete,
                           'plan_complete': plan_source_complete,
                           'assignment_complete': coverage_complete,
                           'snapshot_kind': 'current', 'list_may_lag': True},
        'warnings': list(dict.fromkeys(result_warnings)), 'old_open_days': old_days,
    }
