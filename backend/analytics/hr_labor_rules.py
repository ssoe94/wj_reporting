"""WO-02 deterministic labor estimates; no database or external calendar.

Amounts use Decimal, a local 50-digit context, and ROUND_HALF_UP to 0.01 CNY
only for final amounts. Never round the hourly rate. Each component and the
total are rounded independently from their unrounded values, so the total may
differ by one cent from the sum of displayed components. Contract overtime is
the actual-hours allowance only; it never adds 固定平时加班 implicitly.
Insurance/fund items instead round each side per item before summing; see
contribution_amounts. None means missing/unconfirmed, never an inferred zero.
Floats are rejected.
"""
from calendar import monthrange
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import re


SOCIAL_ITEMS = ('pension', 'medical', 'unemployment', 'work_injury', 'maternity')
EXCLUDED_TITLES = ('Part長', '部长', '财务部长兼办公室主任', '技术生产总经理')

DAY_TYPES = ('workday', 'rest_day', 'public_holiday', 'adjusted_workday')


def default_labor_rules():
    def contribution(items):
        return {'applies_to': {'contract': None, 'hourly': None},
                'base': {'rule': None, 'common_amount': None, 'employee_amounts': {}, 'lower': None, 'upper': None},
                'items': {item: {'employer_rate': None, 'employee_rate': None} for item in items}}
    return {
        'multipliers': {'workday': '1.5', 'rest_day': '2', 'public_holiday': '3'},
        'contract': {'days_per_month': '21.75', 'hours_per_day': '8'},
        'hourly_premium': {'enabled': True, 'confirmed': True},
        'hourly_rates': {'company_default': {'amount': '24.50', 'confirmed': False}, 'employee_overrides': []},
        'department_overtime': {'注塑': '4', '模具': '4', '公务': '4', '品质': '4',
                                '加工': '2.5', '营业': '2.5', '资材': '2.5', '开发': '1',
                                '管理部': None, '总经办': None},
        'weekday_excluded_titles': {'titles': list(EXCLUDED_TITLES), 'confirmed': True},
        'department_hours_include_fixed_overtime': False,
        'contributions': {'social_insurance': contribution(SOCIAL_ITEMS), 'housing_fund': contribution(('housing_fund',))},
    }


def _number(value, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (Decimal, str, int)):
        raise ValueError('Use a nonnegative decimal string, Decimal or integer.')
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError('Invalid decimal.') from error
    if not result.is_finite() or result < 0 or (positive and result == 0):
        raise ValueError('The value must be finite and nonnegative (divisors must be positive).')
    return result


def _money(value):
    return value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def _basis(rules, version, effective_month, *, unit_rate=None, hours=None, multipliers=None, **extra):
    return {'standard_version': version, 'effective_month': effective_month,
            'unit_rate': unit_rate, 'hours': hours,
            'multipliers': multipliers if multipliers is not None else {
                key: _number(value) for key, value in rules['multipliers'].items()}, **extra}


def contract_overtime(base_salary, weekday_hours=0, rest_hours=0, holiday_hours=0, *,
                      rules=None, version=0, effective_month=None, weekday_exempt=False):
    rules = default_labor_rules() if rules is None else rules
    hours = dict(zip(('workday', 'rest_day', 'public_holiday'),
                     map(_number, (weekday_hours, rest_hours, holiday_hours))))
    multipliers = {key: _number(rules['multipliers'][key]) for key in hours}
    with localcontext() as context:
        context.prec = 50
        rate = (_number(base_salary) / _number(rules['contract']['days_per_month'], positive=True)
                / _number(rules['contract']['hours_per_day'], positive=True))
        applied = multipliers | ({'workday': Decimal(0)} if weekday_exempt else {})
        raw = {key: rate * hours[key] * applied[key] for key in hours}
        return {'status': 'ready', 'weekday': _money(raw['workday']),
                'rest_day': _money(raw['rest_day']), 'public_holiday': _money(raw['public_holiday']),
                'total': _money(sum(raw.values())),
                'basis': _basis(rules, version, effective_month, unit_rate=rate, hours=hours,
                                multipliers=applied, base_salary=_number(base_salary),
                                contract=rules['contract'].copy(), weekday_exempt=weekday_exempt)}


def hourly_pay(unit_rate, regular_hours=0, weekday_overtime_hours=0, rest_hours=0, holiday_hours=0, *,
               rules=None, version=0, effective_month=None):
    rules = default_labor_rules() if rules is None else rules
    hours = dict(zip(('regular', 'workday', 'rest_day', 'public_holiday'),
                     map(_number, (regular_hours, weekday_overtime_hours, rest_hours, holiday_hours))))
    premium = rules['hourly_premium']
    multipliers = {key: _number(rules['multipliers'][key]) if premium['enabled'] and key != 'regular'
                   else Decimal(1) for key in hours}
    with localcontext() as context:
        context.prec = 50
        rate = _number(unit_rate)
        raw = {key: rate * hours[key] * multipliers[key] for key in hours}
        return {'status': 'ready' if premium['confirmed'] else 'unconfirmed',
                'regular': _money(raw['regular']), 'weekday': _money(raw['workday']),
                'rest_day': _money(raw['rest_day']), 'public_holiday': _money(raw['public_holiday']),
                'total': _money(sum(raw.values())),
                'basis': _basis(rules, version, effective_month, unit_rate=rate, hours=hours,
                                multipliers=multipliers, hourly_premium=premium.copy())}


def _date(day):
    if isinstance(day, date) and not hasattr(day, 'hour'):
        return day
    if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        raise ValueError('Use an ISO calendar date (YYYY-MM-DD).')
    return date.fromisoformat(day)


def classify_day(day, overrides=None, *, rules=None, version=0, effective_month=None, calendar_version=0):
    rules = default_labor_rules() if rules is None else rules
    value = _date(day)
    key = value.isoformat()
    explicit = (overrides or {}).get(key)
    if explicit is not None and explicit not in DAY_TYPES:
        raise ValueError('Unknown calendar day type.')
    kind = explicit or ('rest_day' if value.weekday() >= 5 else 'workday')
    return {'type': kind, 'status': 'ready',
            'basis': _basis(rules, version, effective_month, calendar_version=calendar_version,
                            date=key, source='override' if explicit else 'weekday_default',
                            applied_multiplier=_number(rules['multipliers']['workday' if kind == 'adjusted_workday' else kind]))}


def month_day_counts(month, overrides=None, *, rules=None, version=0, effective_month=None, calendar_version=0):
    if not isinstance(month, str) or not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', month):
        raise ValueError('Use YYYY-MM.')
    rules = default_labor_rules() if rules is None else rules
    year, number = map(int, month.split('-'))
    counts = dict.fromkeys(DAY_TYPES, 0)
    for day in range(1, monthrange(year, number)[1] + 1):
        counts[classify_day(date(year, number, day), overrides, rules=rules)['type']] += 1
    return {'status': 'ready', 'workdays': counts['workday'] + counts['adjusted_workday'],
            'rest_days': counts['rest_day'], 'public_holidays': counts['public_holiday'],
            'adjusted_workdays': counts['adjusted_workday'],
            'basis': _basis(rules, version, effective_month, calendar_version=calendar_version, month=month)}


def daily_default_overtime(department, title, day, *, rules=None, overrides=None,
                           version=0, effective_month=None, calendar_version=0):
    rules = default_labor_rules() if rules is None else rules
    classified = classify_day(day, overrides, rules=rules, version=version,
                              effective_month=effective_month, calendar_version=calendar_version)
    basis = classified['basis'] | {'department': department, 'title': title,
                                  'include_fixed_overtime': rules['department_hours_include_fixed_overtime']}
    if classified['type'] not in ('workday', 'adjusted_workday'):
        return {'status': 'manual_required', 'hours': None, 'candidate_hours': None, 'basis': basis}
    excluded = rules['weekday_excluded_titles']
    basis['exclusion_confirmed'] = excluded['confirmed']
    if excluded['confirmed'] and title in excluded['titles']:
        return {'status': 'ready', 'hours': Decimal(0), 'candidate_hours': Decimal(0),
                'basis': basis | {'hours': Decimal(0), 'weekday_exempt': True}}
    configured = rules['department_overtime'].get(department)
    if configured is None:
        return {'status': 'missing', 'hours': None, 'candidate_hours': None, 'basis': basis}
    hours = _number(configured)
    if not excluded['confirmed'] or rules['department_hours_include_fixed_overtime'] is None:
        return {'status': 'unconfirmed', 'hours': None, 'candidate_hours': hours,
                'basis': basis | {'candidate_hours': hours}}
    return {'status': 'ready', 'hours': hours, 'candidate_hours': hours, 'basis': basis | {'hours': hours}}


def contribution_amounts(kind, employment_type, gross_amount=None, *, employee_id=None,
                         rules=None, version=0, effective_month=None):
    """Monthly estimates; round EACH item/side to 0.01 with ROUND_HALF_UP, THEN sum.

    Missing either side's rate marks that item missing. Totals remain None when
    any item is missing; known subtotals are separate. Explicit non-applicability
    is the only rule that permits zero without entered rates or a base.
    """
    rules = default_labor_rules() if rules is None else rules
    if kind not in ('social_insurance', 'housing_fund') or employment_type not in ('contract', 'hourly'):
        raise ValueError('Unknown contribution or employment type.')
    config = rules['contributions'][kind]
    applies = config['applies_to'][employment_type]
    base = config['base']
    source = (gross_amount if base['rule'] == 'gross' else base['common_amount'] if base['rule'] == 'common'
              else base['employee_amounts'].get(str(employee_id)) if base['rule'] == 'employee' else None)
    raw_base = None if source is None else _number(source)
    lower = None if base['lower'] is None else _number(base['lower'])
    upper = None if base['upper'] is None else _number(base['upper'])
    if lower is not None and upper is not None and lower > upper:
        raise ValueError('Contribution lower bound exceeds upper bound.')
    used_base = raw_base
    if used_base is not None:
        if lower is not None:
            used_base = max(used_base, lower)
        if upper is not None:
            used_base = min(used_base, upper)
    basis = _basis(rules, version, effective_month, contribution=kind, employment_type=employment_type,
                   employee_id=employee_id, applies=applies, base_rule=base['rule'], raw_base=raw_base,
                   base_amount=used_base, lower=lower, upper=upper,
                   multipliers={'percentage_divisor': Decimal(100)})
    items = {}
    with localcontext() as context:
        context.prec = 50
        for name, rates in config['items'].items():
            parsed = {side: None if rate is None else _number(rate) for side, rate in rates.items()}
            if any(rate is not None and rate > 100 for rate in parsed.values()):
                raise ValueError('Percentage must not exceed 100.')
            ready = applies is True and used_base is not None and all(rate is not None for rate in parsed.values())
            amounts = {side: Decimal('0.00') if applies is False else _money(used_base * parsed[f'{side}_rate'] / 100)
                       if ready else None for side in ('employer', 'employee')}
            items[name] = {'status': 'not_applicable' if applies is False else 'ready' if ready else 'missing',
                           **amounts, 'basis': basis | {'rates': parsed}}
        complete = all(item['status'] != 'missing' for item in items.values())
        known = {side: sum((item[side] for item in items.values() if item[side] is not None), Decimal('0.00'))
                 for side in ('employer', 'employee')}
        return {'measurement': 'estimate', 'period': 'month',
                'status': 'not_applicable' if applies is False else 'ready' if complete else 'partial_missing',
                'items': items, 'totals': known if complete else {'employer': None, 'employee': None},
                'known_totals': known, 'basis': basis}


def employer_contribution(kind, employment_type, gross_amount=None, *, employee_id=None,
                          rules=None, version=0, effective_month=None):
    """Employer projection of the complete, itemized monthly calculation."""
    result = contribution_amounts(kind, employment_type, gross_amount, employee_id=employee_id,
                                  rules=rules, version=version, effective_month=effective_month)
    return result | {'amount': result['totals']['employer']}


def resolve_hourly_rate(employee_id, month, *, rules=None, version=0, effective_month=None):
    rules = default_labor_rules() if rules is None else rules
    _date(f'{month}-01')
    rates = rules['hourly_rates']
    eligible = [row for row in rates['employee_overrides']
                if row['employee_id'] == employee_id and row['effective_month'] <= month]
    chosen = max(eligible, key=lambda row: row['effective_month']) if eligible else rates['company_default']
    amount = None if chosen['amount'] is None else _number(chosen['amount'])
    return {'status': 'missing' if amount is None else 'ready' if eligible or chosen['confirmed'] else 'unconfirmed',
            'amount': amount, 'basis': _basis(rules, version, effective_month, unit_rate=amount,
                source='employee_override' if eligible else 'company_default', employee_id=employee_id,
                rate_effective_month=chosen['effective_month'] if eligible else effective_month,
                reason=chosen.get('reason'))}


def employee_day(employee, day, *, payroll=None, regular_hours=None, overtime_hours=None,
                 rules=None, overrides=None, version=0, effective_month=None, calendar_version=0):
    """Split one day's pay and monthly reference components without double counting.

    Contract base salary, fixed OT, and contributions are MONTHLY references,
    never summed into daily pay. Only hourly regular pay and actual OT are daily.
    Payroll is the latest imported employee row at/before this month, supplied by
    the read-only service; missing components stay missing (no older-value search).
    """
    rules = default_labor_rules() if rules is None else rules
    kind = employee['employment_type']
    if kind not in ('contract', 'hourly'):
        raise ValueError('Unknown employment type.')
    month = _date(day).isoformat()[:7]
    payroll = payroll or {}
    source_month = payroll.get('month')
    if source_month is not None and source_month > month:
        raise ValueError('Future payroll cannot seed an earlier estimate.')
    classified = classify_day(day, overrides, rules=rules, version=version,
                              effective_month=effective_month, calendar_version=calendar_version)
    workday = classified['type'] in ('workday', 'adjusted_workday')
    excluded = rules['weekday_excluded_titles']
    exempt = excluded['confirmed'] and employee.get('title', '') in excluded['titles']
    defaults = daily_default_overtime(employee.get('department', ''), employee.get('title', ''), day,
        rules=rules, overrides=overrides, version=version, effective_month=effective_month, calendar_version=calendar_version)
    hours = _number(overtime_hours) if overtime_hours is not None else defaults['hours']
    if workday and exempt:
        hours = Decimal(0)
    regular = _number(regular_hours) if regular_hours is not None else _number(rules['contract']['hours_per_day']) if workday else Decimal(0)
    if not workday and regular != 0:
        raise ValueError('Rest/public holiday hours belong in overtime_hours, not regular_hours.')
    basis = classified['basis'] | {'employee_id': employee['id'], 'employment_type': kind,
        'title': employee.get('title', ''), 'weekday_exempt': exempt, 'payroll_source_month': source_month,
        'regular_hours': regular, 'overtime_hours': hours, 'default_overtime': defaults['basis'],
        'payroll_source': {'month': source_month, 'workspace_version': payroll.get('workspace_version'),
                           'source': payroll.get('source')}}
    def monthly(value, component):
        return {'status': 'missing' if value is None else 'ready', 'period': 'month',
                'amount': None if value is None else _money(_number(value)), 'component': component,
                'source_month': source_month, 'carried_forward': source_month is not None and source_month < month}
    base_salary = payroll.get('base_salary')
    slot = 'weekday' if workday else classified['type']
    actual = {key: {'period': 'day', 'status': 'ready', 'amount': Decimal('0.00')}
              for key in ('weekday', 'rest_day', 'public_holiday')}
    with localcontext() as context:
        context.prec = 50
        fixed = monthly(payroll.get('fixed_overtime'), 'fixed_overtime')
        category_hours = {key: (hours or 0) if slot == key else 0 for key in actual}
        if kind == 'hourly':
            rate = resolve_hourly_rate(employee['id'], month, rules=rules, version=version, effective_month=effective_month)
            basis['hourly_rate'] = rate['basis']
            pay = hourly_pay(rate['amount'], regular, category_hours['weekday'],
                category_hours['rest_day'], category_hours['public_holiday'],
                rules=rules, version=version, effective_month=effective_month) if rate['amount'] is not None else None
            state = 'missing' if pay is None else 'ready' if pay['status'] == rate['status'] == 'ready' else 'unconfirmed'
            salary = {'period': 'day', 'status': state, 'amount': pay['regular'] if pay else None, 'component': 'hourly_regular'}
            actual[slot] = {'period': 'day', 'status': state if hours is not None else defaults['status'],
                            'amount': pay[slot] if pay and hours is not None else None}
        else:
            salary = monthly(base_salary, 'base_salary')
            pay = contract_overtime(base_salary, category_hours['weekday'],
                category_hours['rest_day'], category_hours['public_holiday'],
                rules=rules, version=version, effective_month=effective_month, weekday_exempt=exempt) if base_salary is not None else None
            known_zero = hours == 0
            actual[slot] = {'period': 'day', 'status': 'ready' if known_zero or pay and hours is not None else 'missing' if pay is None else defaults['status'],
                            'amount': Decimal('0.00') if known_zero else pay[slot] if pay and hours is not None else None}
        basis['pay'] = pay['basis'] if pay else None
        contributions = {fund: contribution_amounts(fund, kind, payroll.get('gross_amount'), employee_id=employee['id'],
            rules=rules, version=version, effective_month=effective_month) for fund in ('social_insurance', 'housing_fund')}
        return {'measurement': 'estimate', 'date': _date(day).isoformat(), 'salary': salary,
                'overtime': {'fixed': fixed, **actual}, 'contributions': contributions, 'basis': basis}
