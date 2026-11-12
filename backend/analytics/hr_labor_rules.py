"""WO-02 deterministic labor estimates; no database or external calendar.

Amounts use Decimal, a local 50-digit context, and ROUND_HALF_UP to 0.01 CNY
only for final amounts. Never round the hourly rate. Each component and the
total are rounded independently from their unrounded values, so the total may
differ by one cent from the sum of displayed components. Contract overtime is
the actual-hours allowance only; it never adds 固定平时加班 implicitly.
None means missing/unconfirmed, never an inferred zero. Floats are rejected.
"""
from calendar import monthrange
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import re


DAY_TYPES = ('workday', 'rest_day', 'public_holiday', 'adjusted_workday')


def default_labor_rules():
    def contribution():
        return {kind: {'rate_percent': None, 'base': None, 'fixed_amount': None}
                for kind in ('contract', 'hourly')}
    return {
        'multipliers': {'workday': '1.5', 'rest_day': '2', 'public_holiday': '3'},
        'contract': {'days_per_month': '21.75', 'hours_per_day': '8'},
        'hourly_premium': {'enabled': False, 'confirmed': False},
        'department_overtime': {'注塑': '4', '模具': '4', '公务': '4', '品质': '4',
                                '加工': '2.5', '营业': '2.5', '资材': '2.5', '开发': '1',
                                '管理部': None, '总经办': None},
        'weekday_excluded_titles': {'titles': [], 'confirmed': False},
        'department_hours_include_fixed_overtime': None,
        'employer_contributions': {'social_insurance': contribution(), 'housing_fund': contribution()},
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


def employer_contribution(kind, employment_type, gross_amount=None, *, rules=None, version=0, effective_month=None):
    rules = default_labor_rules() if rules is None else rules
    if kind not in ('social_insurance', 'housing_fund') or employment_type not in ('contract', 'hourly'):
        raise ValueError('Unknown contribution or employment type.')
    config = rules['employer_contributions'][kind][employment_type]
    rate = None if config['rate_percent'] is None else _number(config['rate_percent'])
    base = gross_amount if config['base'] == 'gross' else config['fixed_amount'] if config['base'] == 'fixed' else None
    amount_base = None if base is None else _number(base)
    basis = _basis(rules, version, effective_month, unit_rate=rate, contribution=kind,
                   employment_type=employment_type, base_rule=config['base'], base_amount=amount_base,
                   rate_percent=rate, multipliers={'percentage_divisor': Decimal(100)})
    if rate is None or amount_base is None:
        return {'status': 'missing', 'amount': None, 'basis': basis}
    with localcontext() as context:
        context.prec = 50
        return {'status': 'ready', 'amount': _money(amount_base * rate / Decimal(100)), 'basis': basis}
