"""Read-time defaults and estimates. A saved sheet holds only explicit cell overrides.

Each save replaces the complete override set. Default cells follow the effective
roster/calendar/standard at read time; the before/after audit preserves the saved
override set and status. GET and preview never create a sheet.
"""
from calendar import monthrange
from collections import defaultdict
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import serializers

from .hr_contract import HrConflict, money
from .hr_daily_contract import HOURS
from .hr_labor_rules import classify_day, daily_default_overtime, employee_day
from .hr_labor_service import effective_standard, lock_labor
from .hr_personnel_events import employee_states_at, event_revision, events_on
from .hr_roster_service import lock_roster
from .hr_service import check_version
from .hr_workbook_service import digest
from .models import HrDailyWork, HrDailyWorkHistory, HrLaborCalendar


WORKDAYS = ('workday', 'adjusted_workday')
OVERTIME_FIELD = {'workday': 'weekday_hours', 'adjusted_workday': 'weekday_hours',
                  'rest_day': 'rest_hours', 'public_holiday': 'holiday_hours'}
PAY_SLOT = {'weekday_hours': 'weekday', 'rest_hours': 'rest_day', 'holiday_hours': 'public_holiday'}
LEAVE_FIELD = {'personal_leave': 'personal_leave_hours', 'sick_leave': 'sick_leave_hours'}
EMPLOYEE_FIELDS = ('id', 'code', 'name', 'employment_type', 'department', 'title')


def _decimal_strings(value):
    if isinstance(value, Decimal):
        return format(value, 'f')
    if isinstance(value, dict):
        return {key: _decimal_strings(child) for key, child in value.items()}
    return value


def default_work(person, day, day_type, **engine):
    """Resolve actual overtime defaults and the titles exempt on workdays."""
    working = day_type in WORKDAYS
    default = daily_default_overtime(person['department'], person['title'], day, **engine)
    work = {field: '0' for field in HOURS}
    work['attendance'] = 'present' if working else 'off'
    if working:
        work['weekday_hours'] = _decimal_strings(default['hours'])
        if person['employment_type'] == 'hourly':
            work['regular_hours'] = engine['rules']['contract']['hours_per_day']
    return work, bool(default['basis'].get('weekday_exempt'))


def _work_values(defaults, overrides, employment, day_type, exempt):
    attendance = overrides.get('attendance', defaults['attendance'])
    base = defaults.copy()
    base['attendance'] = attendance
    if attendance != 'present':
        base.update({field: '0' for field in HOURS})
    allowed = set()
    if attendance in ('present', *LEAVE_FIELD):
        overtime = OVERTIME_FIELD[day_type]
        if overtime != 'weekday_hours' or not exempt:
            allowed.add(overtime)
        if day_type in WORKDAYS and employment == 'hourly':
            allowed.add('regular_hours')
    if attendance in LEAVE_FIELD:
        allowed.add(LEAVE_FIELD[attendance])
    delta = {'attendance': attendance} if attendance != defaults['attendance'] else {}
    for field in HOURS:
        if field in allowed and field in overrides and overrides[field] != base[field]:
            delta[field] = overrides[field]
    return base | delta, delta


def _pay_inputs(person, engine):
    payroll = person['payroll'].copy()
    payroll.update(base_salary=person['base_salary'], fixed_overtime=person['fixed_overtime'])
    event = person['pay_event_id']
    if event and person['employment_type'] == 'contract':
        payroll = {'base_salary': person['base_salary'], 'fixed_overtime': person['fixed_overtime'],
                   'month': person['pay_event_date'][:7], 'source': {'event_id': event}}
    if event and person['hourly_rate'] is not None:
        rules = engine['rules']
        hourly = rules['hourly_rates']
        month = person['pay_event_date'][:7]
        exceptions = [item for item in hourly['employee_overrides']
                      if (item['employee_id'], item['effective_month']) != (person['id'], month)]
        exceptions.append({'employee_id': person['id'], 'effective_month': month,
                           'amount': person['hourly_rate'], 'reason': 'personnel_event'})
        engine = engine | {'rules': rules | {'hourly_rates': hourly | {'employee_overrides': exceptions}}}
    return payroll, engine


def estimate_daily_work(person, day, day_type, work, **engine):
    """Only actual overtime and hourly regular pay belong to this day's estimate."""
    payroll, engine = _pay_inputs(person, engine)
    overtime = OVERTIME_FIELD[day_type]
    hours = work[overtime]
    regular = work['regular_hours']
    calculation = employee_day(person, day, payroll=payroll, regular_hours=regular or '0',
                               overtime_hours=hours or '0', **engine)
    components = [(overtime, calculation['overtime'][PAY_SLOT[overtime]])]
    if person['employment_type'] == 'hourly':
        components.append(('regular_hours', calculation['salary']))
    deduction = 'unconfirmed' if work['attendance'] in LEAVE_FIELD else 'none'
    details = {}
    known = Decimal(0)
    partial = deduction == 'unconfirmed'
    for field, component in components:
        if work[field] is None:
            state, amount = 'missing', None
        elif Decimal(work[field]) == 0:
            state, amount = 'ready', Decimal(0)
        else:
            state, amount = component['status'], component['amount']
        if state == 'ready':
            known += amount
        else:
            partial = True
        details[field] = {'status': state, 'amount': money(amount) if state == 'ready' else None}
    basis = _decimal_strings(calculation['basis'])
    basis.update(inputs=work, components=details, pay_event_id=person['pay_event_id'],
                 payroll_ambiguous=bool(payroll.get('ambiguous')), deduction_status=deduction)
    return {'status': 'partial_missing' if partial else 'ready', 'amount': None if partial else money(known),
            'known_amount': money(known), 'deduction_status': deduction, 'basis': basis}


def _engine(day):
    month = day.isoformat()[:7]
    standard = effective_standard(month)
    calendar = HrLaborCalendar.objects.filter(pk=month).first()
    return {'rules': standard['rules'], 'version': standard['version'], 'effective_month': standard['month'],
            'overrides': calendar.days if calendar else {}, 'calendar_version': calendar.version if calendar else 0}


def _context(day):
    engine = _engine(day)
    people = [person for person in employee_states_at(day) if person['active']]
    day_type = classify_day(day, engine['overrides'], rules=engine['rules'])['type']
    signature = digest({'engine': engine, 'people': people, 'date': day.isoformat()})
    return engine, people, day_type, signature


def _summary(rows):
    attendance = [row['work']['attendance'] for row in rows]
    overtime_fields = ('weekday_hours', 'rest_hours', 'holiday_hours')
    overtime = [row['work'][field] for row in rows for field in overtime_fields]
    contract = sum(row['employee']['employment_type'] == 'contract' for row in rows)
    known = sum((Decimal(row['estimate']['known_amount']) for row in rows), Decimal(0))
    partial = any(row['estimate']['status'] != 'ready' for row in rows)
    return {
        'headcount': len(rows), 'contract': contract, 'hourly': len(rows) - contract,
        'present': attendance.count('present'), 'absent': attendance.count('absent'),
        'leave': sum(attendance.count(kind) for kind in LEAVE_FIELD), 'off': attendance.count('off'),
        'overtime_hours': format(sum((Decimal(hours) for hours in overtime if hours is not None), Decimal(0)), 'f'),
        'overtime_partial': any(hours is None for hours in overtime),
        'status': 'partial_missing' if partial else 'ready', 'amount': None if partial else money(known),
        'known_amount': money(known),
        'basis': {'employee_ids': [row['employee']['id'] for row in rows],
                  'partial_employee_ids': [row['employee']['id'] for row in rows if row['estimate']['status'] != 'ready']},
    }


def _rows(day, snapshot, overrides, *, submitted=False):
    engine, people, day_type, _ = snapshot
    active = {str(person['id']) for person in people}
    if submitted and set(overrides) - active:
        raise HrConflict('적용일의 재직 직원이 바뀌었습니다. 최신 인원을 확인해 주세요.')
    rows = []
    normalized = {}
    for person in people:
        key = str(person['id'])
        defaults, exempt = default_work(person, day, day_type, **engine)
        work, delta = _work_values(defaults, overrides.get(key, {}), person['employment_type'], day_type, exempt)
        if submitted and sum(Decimal(work[field] or '0') for field in HOURS) > 24:
            raise serializers.ValidationError({'rows': '직원별 근무·휴가 시간의 합은 24시간 이하여야 합니다.'})
        if delta:
            normalized[key] = delta
        estimate = estimate_daily_work(person, day, day_type, work, **engine)
        estimate['basis']['weekday_exempt'] = exempt
        rows.append({'employee': {key: person[key] for key in EMPLOYEE_FIELDS}, 'defaults': defaults,
                     'work': work, 'modified': list(delta), 'estimate': estimate})
    return rows, normalized


def _date_strip(day, engine, current_status):
    length = monthrange(day.year, day.month)[1]
    statuses = dict(HrDailyWork.objects.filter(date__range=(day.replace(day=1), day.replace(day=length)))
                    .values_list('date', 'status'))
    statuses[day] = current_status
    dates = (day.replace(day=index) for index in range(1, length + 1))
    return [{'date': value.isoformat(),
             'day_type': classify_day(value, engine['overrides'], rules=engine['rules'])['type'],
             'status': statuses.get(value, 'estimated')} for value in dates]


def _payload(day, record, snapshot, rows, *, can_edit, status=None):
    engine, _, day_type, signature = snapshot
    status = status or (record.status if record else 'estimated')
    groups = defaultdict(list)
    for row in rows:
        groups[row['employee']['department']].append(row)
    return {
        'date': day.isoformat(), 'day_type': day_type, 'version': record.version if record else 0,
        'status': status, 'context': signature, 'can_edit': can_edit, 'event_revision': event_revision(),
        'rows': rows, 'summary': _summary(rows),
        'departments': [_summary(members) | {'department': department}
                        for department, members in sorted(groups.items())],
        'days': _date_strip(day, engine, status), 'events': events_on(day),
        'history': list(record.history.order_by('-version').values(
            'version', 'before', 'after', 'reason', 'actor_label', 'created_at')[:20]) if record else [],
    }


def daily_work_payload(day, *, can_edit):
    record = HrDailyWork.objects.filter(pk=day).first()
    snapshot = _context(day)
    rows, _ = _rows(day, snapshot, record.overrides if record else {})
    return _payload(day, record, snapshot, rows, can_edit=can_edit)


def _submitted_rows(day, record, data):
    check_version(record, data['version'])
    snapshot = _context(day)
    if snapshot[3] != data['context']:
        raise HrConflict('인원·급여·근무 기준이 바뀌었습니다. 최신 자료를 확인해 주세요.')
    submitted = {str(row['employee_id']): row['work'] for row in data['rows']}
    rows, normalized = _rows(day, snapshot, submitted, submitted=True)
    return snapshot, rows, normalized


def preview_daily_work(day, data, *, can_edit):
    record = HrDailyWork.objects.filter(pk=day).first()
    snapshot, rows, _ = _submitted_rows(day, record, data)
    return _payload(day, record, snapshot, rows, can_edit=can_edit, status='draft')


@transaction.atomic
def save_daily_work(day, data, actor):
    # All personnel/roster writers share the first lock. Lock rate and calendar
    # collections before taking their versions so confirmation sees one basis.
    lock_roster()
    lock_labor('standard')
    lock_labor('calendar')
    record = HrDailyWork.objects.select_for_update().filter(pk=day).first()
    snapshot, rows, overrides = _submitted_rows(day, record, data)
    before = {'status': record.status, 'overrides': record.overrides} if record else {'status': 'estimated', 'overrides': {}}
    after = {'status': data['status'], 'overrides': overrides}
    if record and before == after:
        return _payload(day, record, snapshot, rows, can_edit=True)
    if record is None:
        try:
            with transaction.atomic():
                record = HrDailyWork.objects.create(date=day, updated_by=actor, **after)
        except IntegrityError as error:
            raise HrConflict() from error
    else:
        updated = HrDailyWork.objects.filter(pk=day, version=record.version).update(
            **after, version=record.version + 1, updated_by=actor, updated_at=timezone.now())
        if updated != 1:
            raise HrConflict()
        record.refresh_from_db()
    HrDailyWorkHistory.objects.create(
        workday=record, version=record.version, before=before, after=after,
        reason=data['reason'], actor=actor, actor_label=(actor.get_full_name() or actor.username)[:200],
    )
    return _payload(day, record, snapshot, rows, can_edit=True)
