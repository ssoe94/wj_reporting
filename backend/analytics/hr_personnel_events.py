"""Project daily employee state from payroll, roster identity and immutable events."""
from calendar import monthrange
from collections import defaultdict
from datetime import date

from django.db import IntegrityError, transaction
from django.db.models import Max, Q
from rest_framework import serializers
from rest_framework.exceptions import NotFound

from .hr_contract import HrConflict
from .hr_identity import code_key, identity
from .hr_labor_service import payroll_department_paths, payroll_row_basis
from .hr_roster_service import codes_for, lock_roster
from .models import HrMonthWorkspace, HrPersonnelEvent, HrRosterEmployee


def event_revision():
    return HrPersonnelEvent.objects.aggregate(revision=Max('id'))['revision'] or 0


def _payrolls(employees, month, *, prior_only=False):
    """Scan monthly payroll once for the active roster. Match code/alias AND name."""
    pending = defaultdict(set)
    unresolved = set()
    result = {}
    for employee in employees:
        unresolved.add(employee.id)
        for code in (employee.code, *codes_for(employee)):
            pending[code_key(code), employee.normalized_name].add(employee.id)
    if prior_only:
        workspaces = HrMonthWorkspace.objects.filter(month__lt=month, currency='CNY', cost_basis='gross_salary')
    else:
        workspaces = HrMonthWorkspace.objects.filter(month__lte=month)
    for workspace in workspaces.only('month', 'version', 'employees', 'departments').iterator():
        department_names = payroll_department_paths(workspace.departments) if prior_only else {}
        matches = defaultdict(list)
        for row in workspace.employees:
            for employee_id in pending.get((code_key(row['code']), identity(row['name'])), set()) & unresolved:
                matches[employee_id].append(row)
        for employee_id, rows in matches.items():
            if len(rows) != 1:
                result[employee_id] = {'month': workspace.month, 'ambiguous': True}
            else:
                row = rows[0]
                result[employee_id] = payroll_row_basis(workspace, row)
                if prior_only:
                    result[employee_id]['payroll_components'] = row.get('payroll_components') or {}
                    result[employee_id]['visual_department'] = department_names.get(row.get('department_id'), '')
        unresolved.difference_update(matches)
        if not unresolved:
            break
    return result


def _uncancelled(events):
    cancelled = {event.target_id for event in events if event.kind == 'cancel'}
    return [event for event in events if event.kind != 'cancel' and event.id not in cancelled]


def _roster_dates(employee, events):
    if any(event.kind == 'hire' for event in events):
        return None, None
    first = date.fromisoformat(f'{employee.first_month}-01')
    if employee.status != 'departed':
        return first, None
    year, month = map(int, employee.last_month.split('-'))
    return first, date(year, month, monthrange(year, month)[1])


def _active(day, first, last):
    return first is not None and first <= day and (last is None or day <= last)


def _project(employee, events, day, payroll):
    first, last = _roster_dates(employee, events)
    employment_type = payroll.get('employment_type') or employee.employment_type
    state = {
        'id': employee.id, 'code': employee.code, 'name': employee.name,
        'employment_type': employment_type,
        'department': payroll.get('department') or employee.department,
        'title': payroll.get('title', ''),
        'base_salary': payroll.get('base_salary') if employment_type == 'contract' else None,
        'fixed_overtime': payroll.get('fixed_overtime') if employment_type == 'contract' else None,
        'hourly_rate': None, 'pay_event_id': None, 'pay_event_date': None,
    }
    for event in _uncancelled([event for event in events if event.date <= day]):
        changes = event.changes
        if event.kind == 'hire':
            first, last = event.date, None
        elif event.kind == 'terminate':
            last = event.date
        if event.kind in ('hire', 'employment_change'):
            kind = changes['employment_type']
            state['employment_type'] = kind
            newer_payroll = payroll.get('employment_type') == kind and payroll.get('month', '') > event.date.isoformat()[:7]
            state['base_salary'] = (payroll if newer_payroll else changes).get('base_salary')
            state['fixed_overtime'] = (payroll if newer_payroll else changes).get('fixed_overtime')
            state['hourly_rate'] = changes.get('hourly_rate')
            state['pay_event_id'] = None if newer_payroll and kind == 'contract' else event.id
            state['pay_event_date'] = event.date.isoformat() if state['pay_event_id'] else None
        for field in ('department', 'title'):
            if field in changes:
                state[field] = changes[field]
    return {**state, 'active': _active(day, first, last), 'last_work_day': last.isoformat() if last else None,
            'payroll': payroll}


def employee_states_for_days(days, employees=None, *, prior_payroll_only=False):
    """Resolve dates in one month using a single roster, event and payroll load."""
    days = list(days)
    if not days:
        return {}
    month = days[0].isoformat()[:7]
    if any(day.isoformat()[:7] != month for day in days):
        raise ValueError('Project one payroll month at a time.')
    if employees is None:
        employees = HrRosterEmployee.objects.prefetch_related('code_history')
    employees = list(employees)
    if not employees:
        return {day.isoformat(): [] for day in days}
    by_employee = defaultdict(list)
    events = HrPersonnelEvent.objects.filter(Q(date__lte=max(days)) | Q(kind='hire'))
    if len(employees) < 100:
        events = events.filter(employee_id__in=[employee.id for employee in employees])
    for event in events:
        by_employee[event.employee_id].append(event)
    payrolls = _payrolls(employees, month, prior_only=prior_payroll_only)
    return {
        day.isoformat(): [
            _project(employee, by_employee[employee.id], day, payrolls.get(employee.id, {}))
            for employee in employees
        ] for day in days
    }


def employee_states_at(day, employees=None):
    """Calculate date-specific states on read. Imported roster dates have month precision."""
    return employee_states_for_days([day], employees)[day.isoformat()]


def _check_timeline(employee):
    """Reject backdated changes or cancellations that strand an existing event."""
    events = list(employee.personnel_events.all())
    first, last = _roster_dates(employee, events)
    terminated = False
    for event in _uncancelled(events):
        if event.kind == 'hire':
            if first is not None:
                raise HrConflict('입사 이력이 중복됩니다.')
            first, last = event.date, None
        elif not _active(event.date, first, last):
            raise HrConflict('이 변경으로 다른 인원 이벤트의 적용일에 재직 상태가 성립하지 않습니다.')
        elif event.kind == 'terminate':
            if terminated:
                raise HrConflict('퇴사 이력이 중복됩니다.')
            last = event.date
            terminated = True


def _new_hire(day, changes):
    code, name = code_key(changes['code']), identity(changes['name'])
    if not code or not name:
        raise serializers.ValidationError({'changes': '유효한 사번과 이름을 입력해 주세요.'})
    for employee in HrRosterEmployee.objects.prefetch_related('code_history'):
        if code not in {code_key(value) for value in (employee.code, *codes_for(employee))}:
            continue
        events = list(employee.personnel_events.all())
        if (employee.normalized_code == code and employee.normalized_name == name
                and employee.employment_type == changes['employment_type']
                and any(event.kind == 'hire' for event in events) and not _uncancelled(events)):
            return employee
        raise HrConflict('이미 등록된 사번입니다. 현재 또는 이전 사번을 확인해 주세요.')
    return HrRosterEmployee.objects.create(
        code=changes['code'], name=changes['name'], employment_type=changes['employment_type'],
        department=changes['department'], first_month=day.isoformat()[:7], last_month=day.isoformat()[:7],
    )


def _audit_state(day, employee):
    return {key: value for key, value in employee_states_at(day, [employee])[0].items()
            if key not in ('payroll', 'pay_event_id', 'pay_event_date')}


@transaction.atomic
def append_personnel_event(day, data, actor):
    lock_roster()
    if data['revision'] != event_revision():
        raise HrConflict('인원 변동 기록이 바뀌었습니다. 최신 기록을 확인해 주세요.')
    kind, changes = data['kind'], data['changes']
    target = None
    try:
        if kind == 'hire':
            employee = _new_hire(day, changes)
            before = {'active': False}
        elif kind == 'cancel':
            target = HrPersonnelEvent.objects.select_related('employee').filter(pk=data['target_id'], date=day).first()
            if not target or target.kind == 'cancel':
                raise serializers.ValidationError({'target_id': '이 날짜에서 취소할 수 있는 이벤트를 선택해 주세요.'})
            if HrPersonnelEvent.objects.filter(target=target).exists():
                raise HrConflict('이미 취소된 이벤트입니다.')
            employee = target.employee
            before = _audit_state(day, employee)
        else:
            employee = HrRosterEmployee.objects.filter(pk=data['employee_id']).first()
            if employee is None:
                raise NotFound('직원 명부에서 해당 직원을 찾을 수 없습니다.')
            before = _audit_state(day, employee)
            if not before['active']:
                raise serializers.ValidationError({'employee_id': '적용일에 재직 중인 직원을 선택해 주세요.'})
            if changes and all(before.get(key) == value for key, value in changes.items()):
                raise serializers.ValidationError({'changes': '변경할 값을 입력해 주세요.'})
        event = HrPersonnelEvent.objects.create(
            employee=employee, date=day, kind=kind, target=target, changes=changes, before=before,
            reason=data['reason'], actor=actor, actor_label=(actor.get_full_name() or actor.username)[:200],
        )
    except IntegrityError as error:
        raise HrConflict('명부 사번, 직원 정보 또는 취소 기록이 중복됩니다.') from error
    _check_timeline(employee)
    event.after = _audit_state(day, employee)
    event.save(update_fields=['after'])
    return event


def events_on(day):
    events = list(HrPersonnelEvent.objects.filter(date=day).select_related('employee'))
    cancelled = {event.target_id for event in events if event.kind == 'cancel'}
    return [{
        'id': event.id, 'date': event.date.isoformat(), 'kind': event.kind,
        'employee': {'id': event.employee_id, 'code': event.employee.code, 'name': event.employee.name},
        'before': event.before, 'after': event.after, 'reason': event.reason, 'actor_label': event.actor_label,
        'created_at': event.created_at.isoformat(), 'cancelled': event.id in cancelled, 'target_id': event.target_id,
    } for event in events]
