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
from .hr_daily_calculation import HOURS, LEAVE_FIELD, daily_work_rows
from .hr_labor_rules import classify_day
from .hr_labor_service import effective_standard, lock_labor
from .hr_personnel_events import employee_states_at, event_revision, events_on
from .hr_roster_service import lock_roster
from .hr_service import check_version
from .hr_workbook_service import digest
from .models import HrDailyWork, HrDailyWorkHistory, HrLaborCalendar


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
    if submitted and set(overrides) - {str(person['id']) for person in people}:
        raise HrConflict('적용일의 재직 직원이 바뀌었습니다. 최신 인원을 확인해 주세요.')
    rows, normalized = daily_work_rows(day, engine, people, day_type, overrides)
    if submitted and any(sum(Decimal(row['work'][key] or '0') for key in HOURS) > 24 for row in rows):
        raise serializers.ValidationError({'rows': '직원별 근무·휴가 시간의 합은 24시간 이하여야 합니다.'})
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
