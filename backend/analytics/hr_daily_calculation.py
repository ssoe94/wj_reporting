"""Pure defaults and daily work estimates shared by sheets and forecasts."""
from decimal import Decimal

from .hr_labor_rules import _money, daily_default_overtime, employee_day


HOURS = ('regular_hours', 'weekday_hours', 'rest_hours', 'holiday_hours',
         'personal_leave_hours', 'sick_leave_hours')
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
                               overtime_hours=hours or '0', include_contributions=False, **engine)
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
        details[field] = {'status': state, 'amount': format(_money(amount), 'f') if state == 'ready' else None}
    basis = _decimal_strings(calculation['basis'])
    basis.update(inputs=work, components=details, pay_event_id=person['pay_event_id'],
                 payroll_ambiguous=bool(payroll.get('ambiguous')), deduction_status=deduction)
    return {'status': 'partial_missing' if partial else 'ready', 'amount': None if partial else format(_money(known), 'f'),
            'known_amount': format(_money(known), 'f'), 'deduction_status': deduction, 'basis': basis}


def daily_work_rows(day, engine, people, day_type, overrides):
    rows = []
    normalized = {}
    for person in people:
        key = str(person['id'])
        defaults, exempt = default_work(person, day, day_type, **engine)
        work, delta = _work_values(defaults, overrides.get(key, {}), person['employment_type'], day_type, exempt)
        if delta:
            normalized[key] = delta
        estimate = estimate_daily_work(person, day, day_type, work, **engine)
        estimate['basis']['weekday_exempt'] = exempt
        rows.append({'employee': {key: person[key] for key in EMPLOYEE_FIELDS}, 'defaults': defaults,
                     'work': work, 'modified': list(delta), 'estimate': estimate})
    return rows, normalized
