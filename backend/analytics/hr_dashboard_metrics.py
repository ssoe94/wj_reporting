"""Pure metric and payroll-row calculations for the HR dashboard."""
from collections import Counter
from decimal import Decimal, InvalidOperation, localcontext
from functools import wraps

from .hr_labor_forecast import extract_fixed_pay
from .hr_labor_rules import _money, resolve_hourly_rate


KINDS = ('contract', 'hourly', 'unknown')
OVERTIME = {'weekday': 'weekday_overtime', 'rest': 'weekend_overtime', 'holiday': 'holiday_overtime'}
DEDUCTIONS = ('personal_leave', 'sick_leave', 'absence')
REFERENCE_HOURS = 36


def metric(value, month, formula, *, estimated=False, partial=False, **basis):
    if isinstance(value, Decimal):
        value = format(_money(value), 'f')
    return {'value': value, 'status': 'missing' if value is None else 'partial' if partial else 'ready',
            'basis': {'month': month, 'formula': formula, 'estimated': estimated, **basis}}


def number(value):
    # Old payroll JSON contains decimal strings or null. Never infer missing amounts.
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        return None
    try:
        result = Decimal(value)
    except InvalidOperation:
        return None
    return result if result.is_finite() and result >= 0 else None


def employment(row):
    value = row.get('employment_type')
    return value if value in ('contract', 'hourly') else 'unknown'


def counts(kinds, month, formula, *, partial=False, **basis):
    items = None if kinds is None else Counter(kinds)
    unknown = items is not None and items['unknown'] > 0
    only_unknown = unknown and not (items['contract'] or items['hourly'])
    return {
        'total': metric(None if items is None else sum(items.values()), month, formula, partial=partial, **basis),
        **{kind: metric(None if items is None or only_unknown and kind != 'unknown' else items[kind], month, formula,
                        partial=partial or (unknown and kind != 'unknown'), employment_type=kind, **basis)
           for kind in KINDS},
    }


def values_summary(values, month, formula, *, average=False, estimated=False, **basis):
    values = list(values)
    available = [value for value in values if value is not None]
    amount = sum(available, Decimal(0))
    value = amount / len(available) if available and average else amount if available or not values and not average else None
    return metric(value, month, formula, estimated=estimated, partial=len(available) < len(values),
                  observed=len(available), eligible=len(values), **basis)


def payroll_load(row, month, rules, employee_id=None, *, standard_month=None, standard_version=0):
    """Return unrounded values for aggregation, with per-field measurement bases."""
    kind = employment(row)
    values = dict.fromkeys(('weekday', 'rest', 'holiday', 'total', 'worked', 'excess', 'rate'))
    formulas = dict.fromkeys(values, 'not_applicable')
    facts = dict.fromkeys(values, {})
    components = row.get('payroll_components') or {}
    premiums = {slot: number(components.get(key)) for slot, key in OVERTIME.items()}
    deductions = [number(components.get(key)) for key in DEDUCTIONS]
    complete = all(value is not None for value in (*premiums.values(), *deductions))
    amount = number(row.get('amount'))
    fixed = deduction_amount = overtime_pay = None
    if kind == 'contract':
        base = number(components.get('base_salary'))
        for slot, factor in zip(OVERTIME, ('1.5', '2', '3'), strict=True):
            formulas[slot] = 'overtime_pay / (base_salary / 21.75 / 8 × multiplier)'
            facts[slot] = {'multiplier': factor}
            if complete and base:
                values[slot] = premiums[slot] * 174 / (base * Decimal(factor))
        formulas['total'] = 'weekday + rest + public_holiday hours'
        if complete:
            overtime_pay = sum(premiums.values(), Decimal(0))
            deduction_amount = sum(deductions, Decimal(0))
            if amount is not None:
                fixed = extract_fixed_pay(amount, components)
            if base:
                # A shared denominator avoids classifying exact 36-hour totals
                # from separately rounded repeating decimals.
                numerator = 4 * premiums['weekday'] + 3 * premiums['rest'] + 2 * premiums['holiday']
                values['total'] = numerator * 174 / (6 * base)
                facts['total'] = {'above_reference': values['total'] > REFERENCE_HOURS}
        for slot in (*OVERTIME, 'total'):
            if values[slot] is None:
                facts[slot] = facts[slot] | {'reason': 'reupload_components' if not complete or base is None else 'base_salary_zero'}
    elif kind == 'hourly':
        rate = resolve_hourly_rate(employee_id, month, rules=rules, version=standard_version, effective_month=standard_month)
        values['rate'] = rate['amount']
        formulas.update(rate='effective employee override or company hourly rate',
                        worked='gross_salary / hourly_rate', excess='max(gross_salary / hourly_rate − 174, 0)')
        facts['rate'] = {'rate_source': rate['basis']['source'], 'standard_month': standard_month,
                         'standard_version': standard_version, 'confirmed': rate['status'] == 'ready'}
        facts['worked'] = facts['excess'] = {'confirmed_rate': rate['status'] == 'ready',
                                              'standard_hours': 174, 'includes_premiums_if_present': True}
        if amount is not None and values['rate']:
            values['worked'] = amount / values['rate']
            values['excess'] = max(values['worked'] - Decimal(174), Decimal(0))
    data = {key: metric(value, month, formulas[key], estimated=key != 'rate',
                        partial=kind == 'hourly' and key in ('rate', 'worked', 'excess') and
                        not facts['rate']['confirmed'], **facts[key]) for key, value in values.items()}
    return values, data, {'gross': amount, 'fixed': fixed, 'overtime': overtime_pay,
                          'deductions': deduction_amount, 'hourly': amount if kind == 'hourly' else None,
                          'reupload': kind == 'contract' and (not complete or number(components.get('base_salary')) is None)}


def precise_dashboard(function):
    """Use a local precision context for unrounded sums and ratios."""
    @wraps(function)
    def calculate(*args, **kwargs):
        with localcontext() as context:
            context.prec = 50
            return function(*args, **kwargs)
    return calculate
