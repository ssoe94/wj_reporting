"""Deterministic monthly labor forecast from explicit, in-memory inputs."""
from calendar import monthrange
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, localcontext

from .hr_daily_calculation import LEAVE_FIELD, OVERTIME_FIELD, WORKDAYS, _decimal_strings, daily_work_rows
from .hr_labor_rules import _date, _money, _number, classify_day, contribution_amounts

WAGE_KEYS = ('fixed_pay', 'overtime', 'hourly_work')
FUNDS = ('social_insurance', 'housing_fund')
COMPONENTS = WAGE_KEYS + FUNDS
OVERTIME_COLUMNS = ('weekday_overtime', 'weekend_overtime', 'holiday_overtime')
DEDUCTION_COLUMNS = ('personal_leave', 'sick_leave', 'absence')
ZERO = Decimal(0)


def extract_fixed_pay(gross_amount, payroll_components):
    """Recover fixed wages only with evidence for all six variable amounts.

    Payroll deductions are positive magnitudes: add them back to gross.
    The older two-component snapshot cannot establish fixed wages.
    """
    columns = payroll_components or {}
    keys = OVERTIME_COLUMNS + DEDUCTION_COLUMNS
    if gross_amount is None or any(columns.get(key) is None for key in keys):
        return None
    fixed = _number(gross_amount) - sum(_number(columns[key]) for key in OVERTIME_COLUMNS)
    fixed += sum(_number(columns[key]) for key in DEDUCTION_COLUMNS)
    return _money(fixed) if fixed >= 0 else None


def month_dates(month):
    first = _date(f'{month}-01')
    return [first.replace(day=day) for day in range(1, monthrange(first.year, first.month)[1] + 1)]


def _money_text(amount):
    return None if amount is None else format(_money(amount), 'f')


def _ratio(numerator, denominator):
    return None if denominator == 0 else _money_text(numerator * 100 / denominator)


@dataclass
class Amount:
    known: Decimal = ZERO
    complete: bool = True
    available: bool = False

    def add(self, amount, *, known=None):
        self.complete = self.complete and amount is not None
        value = amount if amount is not None else known
        if value is not None:
            self.known += Decimal(value)
            self.available = True

    def merge(self, other):
        self.complete = self.complete and other.complete
        self.known += other.known
        self.available = self.available or other.available

    def metric(self, basis, denominator=None, *, total=False):
        return {
            'amount': _money_text(self.known) if self.complete else None,
            'known_amount': _money_text(self.known),
            'status': 'ready' if self.complete else 'partial_missing' if self.available or total else 'missing',
            'percentage': _ratio(self.known, denominator) if denominator is not None and (self.complete or self.available) else None,
            'basis': basis,
        }


def _amounts(keys=COMPONENTS):
    return {key: Amount() for key in keys}


def _combine(amounts):
    result = Amount()
    for amount in amounts:
        result.merge(amount)
    return result


def _merge_components(target, source):
    for key in COMPONENTS:
        target[key].merge(source[key])


@dataclass
class EmployeeProjection:
    person: dict
    slices: dict = field(default_factory=lambda: defaultdict(_amounts))
    fixed_periods: list = field(default_factory=list)
    fixed_days: dict = field(default_factory=lambda: defaultdict(list))
    variable: dict = field(default_factory=lambda: _amounts(('entered', 'default')))
    variable_details: dict = field(default_factory=dict)
    contributions: dict = field(default_factory=dict)
    active_workdays: int = 0
    leave_slices: set = field(default_factory=set)
    hourly_premium: bool = False

    @property
    def leave(self):
        return bool(self.leave_slices)

    def amounts(self):
        return {key: _combine(costs[key] for costs in self.slices.values()) for key in COMPONENTS}


def _fixed_source(person):
    payroll = person['payroll']
    event_id = person['pay_event_id']
    if event_id is not None:
        components = [person[key] for key in ('base_salary', 'fixed_overtime')]
        known = sum((_number(value) for value in components if value is not None), ZERO)
        return (person['pay_event_date'][:7], None, event_id, None,
                known if any(value is not None for value in components) else None, 'other_fixed_items_not_acquired')
    fixed = extract_fixed_pay(payroll.get('gross_amount'), payroll.get('payroll_components')) if payroll.get('employment_type') == 'contract' else None
    reason = 'fixed_pay_not_acquired' if fixed is None else None
    return payroll.get('month'), payroll.get('workspace_version'), None, fixed, fixed, reason


def _prorate(projection, workdays):
    for (month, version, event_id, amount, known, reason), days in projection.fixed_days.items():
        # Allocate cent differences chronologically so department slices add up
        # to the exact rounded employee-period total.
        previous = ZERO
        for index, (_, department) in enumerate(days, 1):
            cumulative = _money(known * index / workdays) if known is not None and workdays else ZERO
            increment = cumulative - previous
            previous = cumulative
            projection.slices[department, 'contract']['fixed_pay'].add(
                increment if amount is not None and workdays else None,
                known=increment if known is not None and workdays else None,
            )
        projection.fixed_periods.append({
            'source_month': month, 'source_version': version, 'event_id': event_id,
            'first_date': days[0][0], 'last_date': days[-1][0],
            'eligible_workdays': len(days) if workdays else 0, 'month_workdays': workdays,
            'proration_ratio': format(Decimal(len(days)) / workdays, '.8f') if workdays else None,
            'monthly_known_amount': _money_text(known), 'prorated_known_amount': _money_text(previous) if known is not None and workdays else None,
            'missing_reason': reason if workdays else 'no_workdays',
        })


def _record_variable(projection, row, date_key, day_type, source):
    person = projection.person
    component = 'hourly_work' if person['employment_type'] == 'hourly' else 'overtime'
    bucket = projection.slices[person['department'], person['employment_type']][component]
    estimate = row['estimate']
    basis = estimate['basis']
    pay = basis.get('pay') or {}
    hourly = basis.get('hourly_rate') or {}
    multiplier = pay.get('multipliers', {})
    hours = tuple(basis['inputs'][key] for key in ('regular_hours', 'weekday_hours', 'rest_hours', 'holiday_hours'))
    # Group identical pay inputs, keeping date provenance without repeating the
    # full per-day basis object for every employee in the monthly response.
    key = (component, source, person['department'], day_type, pay.get('unit_rate'),
           tuple(sorted(multiplier.items())), hours, basis.get('payroll_source_month'),
           hourly.get('rate_effective_month'), hourly.get('source'), basis.get('pay_event_id'))
    if key not in projection.variable_details:
        projection.variable_details[key] = {'dates': [], 'amount': Amount()}
    recorded = projection.variable_details[key]
    recorded['dates'].append(date_key)
    parts = basis['components'].values()
    amount = Amount()
    for part in parts:
        amount.add(part['amount'])
    for accumulator in (bucket, projection.variable[source], recorded['amount']):
        accumulator.merge(amount)
    if estimate['deduction_status'] == 'unconfirmed':
        projection.leave_slices.add((person['department'], person['employment_type']))
    if component == 'hourly_work':
        multiplier_day = 'workday' if day_type in WORKDAYS else day_type
        overtime_hours = basis['inputs'][OVERTIME_FIELD[day_type]]
        projection.hourly_premium |= (
            Decimal(overtime_hours or '0') > 0 and Decimal(multiplier.get(multiplier_day, '1')) != 1
        )
    return amount


def _variable_basis(projection, component):
    records = []
    for key, value in projection.variable_details.items():
        kind, source, department, day_type, unit_rate, multipliers, hours, source_month, rate_month, rate_source, event_id = key
        if kind != component:
            continue
        basis = {
            'source': source, 'department': department, 'day_type': day_type,
            'dates': value['dates'], 'date_count': len(value['dates']),
            'unit_rate': unit_rate, 'multipliers': dict(multipliers),
            'hours_per_date': dict(zip(('regular', 'weekday', 'weekend', 'holiday'), hours)),
            'source_month': source_month, 'rate_effective_month': rate_month,
            'rate_source': rate_source, 'event_id': event_id,
        }
        records.append(value['amount'].metric(basis))
    return records


def _contributions(projection, engine):
    amounts = projection.amounts()
    gross = _combine(amounts[key] for key in WAGE_KEYS)
    person = projection.person
    costs = projection.slices[person['department'], person['employment_type']]
    for fund in FUNDS:
        result = contribution_amounts(
            fund, person['employment_type'], gross.known if gross.complete and not projection.leave else None,
            employee_id=person['id'], rules=engine['rules'], version=engine['version'],
            effective_month=engine['effective_month'],
        )
        complete = result['totals']['employer']
        known = result['known_totals']['employer']
        costs[fund].add(complete, known=known if any(item['employer'] is not None for item in result['items'].values()) else None)
        projection.contributions[fund] = _decimal_strings({
            **result['basis'], 'items': {name: {'amount': item['employer'], 'rates': item['basis']['rates'],
                                                 'status': item['status']} for name, item in result['items'].items()},
            'employment_type_rule': 'last_active_day',
        })


def _payment_amount(payment, fund, scope):
    amounts = (payment or {}).get('amounts', {}).get(fund, {})
    if amounts.get(scope) is not None:
        return Amount(Decimal(amounts[scope]), True, True)
    recorded = [Decimal(amounts[key]) for key in ('contract', 'hourly') if amounts.get(key) is not None]
    if scope == 'total' and recorded:
        return Amount(sum(recorded), False, True)
    return Amount(complete=False)


def _with_payments(estimated, payment, scope):
    actual = {key: _payment_amount(payment, key, scope) for key in FUNDS}
    effective = {key: actual[key] if key in FUNDS and actual[key].complete else estimated[key] for key in COMPONENTS}
    return effective, actual


def _payment_basis(payment, scope):
    return {'measurement': 'actual', 'month': (payment or {}).get('month'),
            'version': (payment or {}).get('version'), 'scope': scope,
            'evidence_memo': (payment or {}).get('evidence_memo', '')}


def _cost_metrics(estimated, basis, *, payment=None, scope='total', unknown_deduction=False, empty=False):
    effective, actual = _with_payments(estimated, payment, scope)
    total = _combine(effective.values())
    if unknown_deduction or empty:
        total.add(None)
    denominator = total.known
    metrics = {}
    for key, amount in effective.items():
        details = basis.get(key, basis)
        if key not in FUNDS:
            metrics[key] = amount.metric(details, denominator)
            continue
        actual_basis = _payment_basis(payment, scope)
        estimate_basis = details | {'measurement': 'estimate'}
        metrics[key] = amount.metric(actual_basis if actual[key].complete else estimate_basis, denominator) | {
            'estimate': estimated[key].metric(estimate_basis),
            'actual': actual[key].metric(actual_basis),
        }
    total_basis = {
        **{key: value for key, value in basis.items() if key not in COMPONENTS},
        'percentage_denominator': _money_text(denominator),
        'percentage_basis': 'total_amount' if total.complete else 'known_amount',
        'deduction_status': 'unconfirmed' if unknown_deduction else 'none',
    }
    return total.metric(total_basis, denominator, total=not empty), metrics


def _groups(projections, dimension, common_basis, payment=None):
    allocations = defaultdict(dict)
    for employee_id, projection in projections.items():
        for (department, kind), costs in projection.slices.items():
            name = {'department': department, 'visual_department': projection.person.get('visual_department', ''),
                    'employment_type': kind}[dimension]
            if employee_id not in allocations[name]:
                allocations[name][employee_id] = (_amounts(), False)
            amounts, leave = allocations[name][employee_id]
            _merge_components(amounts, costs)
            allocations[name][employee_id] = (amounts, leave or (department, kind) in projection.leave_slices)
    grouped = {}
    for name, members in allocations.items():
        amounts = _amounts()
        for costs, _ in members.values():
            _merge_components(amounts, costs)
        grouped[name] = amounts
    allocated_payment = payment if dimension == 'employment_type' else None
    denominator = sum((amount.known for name, costs in grouped.items()
                       for amount in _with_payments(costs, allocated_payment, name)[0].values()), ZERO)
    result = []
    for name, amounts in sorted(grouped.items()):
        members = allocations[name]
        ids = sorted(members)
        basis = common_basis | {'dimension': dimension, 'group': name, 'employee_ids': ids,
                                'payment_allocation': 'by_employment' if allocated_payment else 'estimate_only'}
        total, components = _cost_metrics(amounts, basis, payment=allocated_payment, scope=name,
                                          unknown_deduction=any(leave for _, leave in members.values()))
        employee_amounts = {}
        for employee_id in ids:
            employee_costs, leave = members[employee_id]
            member_basis = common_basis | {'dimension': dimension, 'group': name, 'employee_id': employee_id}
            member_total, member_components = _cost_metrics(employee_costs, member_basis, unknown_deduction=leave)
            employee_amounts[str(employee_id)] = {'total': member_total, 'components': member_components}
        result.append({
            'name': name, 'headcount': len(ids), 'employee_ids': ids, 'employee_amounts': employee_amounts,
            'total': total, 'components': components,
            'per_person': _money_text(Decimal(total['amount']) / len(ids)) if total['amount'] is not None else None,
            'percentage': _ratio(Decimal(total['known_amount']), denominator),
            'basis': basis | {'percentage_denominator': _money_text(denominator),
                              'percentage_basis': 'group_known_amount'},
        })
    return result


def _actual_wages(payroll):
    amounts = _amounts(WAGE_KEYS)
    gross = Amount()
    deductions = Amount()
    rows = payroll['rows']
    for row in rows:
        amount = row.get('amount')
        gross.add(amount)
        if row.get('employment_type') == 'contract':
            columns = row.get('payroll_components') or {}
            amounts['fixed_pay'].add(extract_fixed_pay(amount, columns))
            for key in OVERTIME_COLUMNS:
                amounts['overtime'].add(columns.get(key))
            for key in DEDUCTION_COLUMNS:
                deductions.add(columns.get(key))
        elif row.get('employment_type') == 'hourly':
            amounts['hourly_work'].add(amount)
        else:
            for key in WAGE_KEYS:
                amounts[key].add(None)
            deductions.add(None)
    return amounts, gross, deductions


def _difference(estimated, actual):
    if estimated is None or actual is None:
        return None
    return _money_text(Decimal(estimated) - Decimal(actual))


def _compare(payroll, payment, total, components, projections, *, current, unknown_deduction):
    if payroll is None or not payroll['rows']:
        return None
    wages, gross, deductions = _actual_wages(payroll)
    basis = {'source_month': payroll['month'], 'workspace_version': payroll['version'],
             'comparison_direction': 'forecast_minus_actual',
             'actual_total_basis': 'gross_payroll_plus_actual_employer_payments',
             'fund_component_basis': 'estimate_minus_actual' if current else 'effective_forecast_minus_actual'}
    contributions = {key: _payment_amount(payment, key, 'total') for key in FUNDS}
    actual_total = _combine((gross, *contributions.values()))
    wage_values = [components[key]['amount'] for key in WAGE_KEYS]
    forecast_wages = _money_text(sum(map(Decimal, wage_values))) if not unknown_deduction and None not in wage_values else None
    actual = {key: amount.metric(basis) for key, amount in wages.items()}
    actual.update({key: value.metric(_payment_basis(payment, 'total')) for key, value in contributions.items()})
    differences = {key: _difference(
        components[key]['estimate']['amount'] if current and key in FUNDS else components[key]['amount'],
        actual[key]['amount'],
    ) for key in COMPONENTS}
    reasons = []
    if current and unknown_deduction:
        reasons.append('deduction_unconfirmed')
    if current and differences['fixed_pay'] not in (None, '0.00'):
        reasons.append('variable_fixed_items')
    if current and any(differences[key] not in (None, '0.00') for key in FUNDS):
        reasons.append('actual_vs_estimate')
    employees = []
    unmatched = 0
    uncomparable = 0
    if current:
        for row in payroll['rows']:
            projection = projections.get(row.get('employee_id'))
            if projection is None:
                unmatched += 1
                continue
            wage = _combine(projection.amounts()[key] for key in WAGE_KEYS)
            forecast = _money_text(wage.known) if wage.complete and not projection.leave else None
            actual_wage = row.get('amount')
            difference = _difference(forecast, actual_wage)
            if difference is None:
                uncomparable += 1
                continue
            if row.get('employment_type') == 'hourly' and projection.hourly_premium and Decimal(difference) != 0:
                if 'hourly_no_premium' not in reasons:
                    reasons.append('hourly_no_premium')
            if Decimal(difference) != 0:
                employees.append({
                    'id': projection.person['id'], 'code': row['code'], 'name': row['name'],
                    'forecast': forecast, 'actual': _money_text(Decimal(actual_wage)), 'difference': difference,
                    'basis': basis | {'comparison_scope': 'employee_gross_payroll'},
                })
    employees.sort(key=lambda row: (-abs(Decimal(row['difference'])), row['code'], row['id']))
    return {
        'month': payroll['month'],
        'actual': {'total': actual_total.metric(basis, total=True), 'components': actual,
                   'basis': basis | {'deductions': deductions.metric(basis), 'gross_payroll': gross.metric(basis)}},
        'total_difference': _difference(total['amount'], _money_text(actual_total.known) if actual_total.complete else None),
        'wage_difference': _difference(forecast_wages, _money_text(gross.known) if gross.complete else None),
        'components': differences, 'employees': employees[:10], 'reasons': reasons,
        'basis': basis | {'unmatched_rows': unmatched, 'uncomparable_rows': uncomparable, 'employee_limit': 10},
    }


def calculate_month_forecast(month, as_of, *, engine, people_by_day, sheets=None,
                             actual_payment=None, payroll=None, previous_payroll=None, previous_payment=None):
    """Calculate a month without database, clock, filesystem or network reads.

    Supply ISO date keys in people_by_day with task 006 projected personnel
    (including prior payroll evidence), and sheets with status and overrides.
    Supply optional payroll dictionaries with month, version and rows, and
    payment dictionaries with month, version, amounts and evidence_memo.
    Values are decimal strings; leave deductions remain unknown.
    """
    with localcontext() as context:
        context.prec = 50
        return _calculate(month, _date(as_of), engine, people_by_day, sheets or {},
                          actual_payment, payroll, previous_payroll, previous_payment)


def _calculate(month, as_of, engine, people_by_day, sheets, payment, payroll, previous_payroll, previous_payment):
    dates = month_dates(month)
    types = {day: classify_day(day, **engine)['type'] for day in dates}
    workdays = sum(kind in WORKDAYS for kind in types.values())
    common_basis = {'standard_version': engine['version'], 'standard_month': engine['effective_month'],
                    'calendar_version': engine['calendar_version'], 'workdays': workdays, 'dates': len(dates),
                    'month': month, 'as_of': as_of.isoformat()}
    projections = {}
    daily = []
    cumulative = _amounts(('entered', 'default'))
    variable_components = {key: _amounts(('entered', 'default')) for key in ('overtime', 'hourly_work')}
    leave_hours = dict.fromkeys(('personal_leave_hours', 'sick_leave_hours'), ZERO)
    leave = False
    missing_leave_hours = set()
    entered = 0
    remaining = 0
    for day in dates:
        key = day.isoformat()
        record = sheets.get(key, {})
        entered_day = day <= as_of and record.get('status') in ('draft', 'confirmed')
        source = 'entered' if entered_day else 'default'
        entered += entered_day
        remaining += day > as_of
        people = [person for person in people_by_day.get(key, ()) if person['active']]
        rows, _ = daily_work_rows(day, engine, people, types[day], record.get('overrides', {}) if entered_day else {})
        day_total = Amount()
        for person, row in zip(people, rows, strict=True):
            if person['id'] not in projections:
                projections[person['id']] = EmployeeProjection(person)
            projection = projections[person['id']]
            projection.person = person
            if types[day] in WORKDAYS:
                projection.active_workdays += 1
            if person['employment_type'] == 'contract' and (types[day] in WORKDAYS or not workdays):
                projection.fixed_days[_fixed_source(person)].append((key, person['department']))
            variable_amount = _record_variable(projection, row, key, types[day], source)
            day_total.merge(variable_amount)
            component = 'hourly_work' if person['employment_type'] == 'hourly' else 'overtime'
            variable_components[component][source].merge(variable_amount)
            leave |= row['estimate']['deduction_status'] == 'unconfirmed'
            leave_field = LEAVE_FIELD.get(row['work']['attendance'])
            if leave_field is not None:
                hours = row['work'][leave_field]
                if hours is None:
                    missing_leave_hours.add(leave_field)
                else:
                    leave_hours[leave_field] += Decimal(hours)
        cumulative[source].merge(day_total)
        total_to_date = _combine(cumulative.values())
        basis = common_basis | {'date': key, 'day_type': types[day], 'source': source,
                                'sheet_version': record.get('version') if entered_day else None,
                                'sheet_status': record.get('status') if entered_day else None,
                                'scope': 'variable_pay', 'employee_count': len(people)}
        daily.append({'date': key, 'source': source, **day_total.metric(basis),
                      'cumulative_known_amount': _money_text(total_to_date.known),
                      'entered_cumulative_known_amount': _money_text(cumulative['entered'].known),
                      'default_cumulative_known_amount': _money_text(cumulative['default'].known)})

    estimated = _amounts()
    employees = []
    for employee_id, projection in sorted(projections.items()):
        _prorate(projection, workdays)
        _contributions(projection, engine)
        amounts = projection.amounts()
        _merge_components(estimated, amounts)
        person = projection.person
        fixed_periods = projection.fixed_periods
        basis = common_basis | {
            'source_month': fixed_periods[-1]['source_month'] if fixed_periods else person['payroll'].get('month'),
            'active_workdays': projection.active_workdays,
            'contract_workdays': sum(period['eligible_workdays'] for period in fixed_periods) if workdays else 0,
            'month_workdays': workdays, 'fixed_pay_periods': fixed_periods,
            'variable_pay': {source: value.metric(common_basis | {'source': source}) for source, value in projection.variable.items()},
        }
        detail = {
            'fixed_pay': common_basis | {'periods': fixed_periods},
            **{name: common_basis | {'periods': _variable_basis(projection, name)} for name in ('overtime', 'hourly_work')},
            **projection.contributions,
        }
        total, metrics = _cost_metrics(amounts, basis | detail, unknown_deduction=projection.leave)
        employees.append({**{key: person[key] for key in ('id', 'code', 'name', 'department', 'employment_type')},
                          'total': total, 'components': metrics, 'basis': basis})
    basis = common_basis | {
        'comparison_direction': 'forecast_minus_actual',
        'source_months': sorted({period['source_month'] for projection in projections.values()
                                 for period in projection.fixed_periods if period['source_month']}),
        'variable_pay': {source: value.metric(common_basis | {'source': source}) for source, value in cumulative.items()},
        'variable_components': {key: {source: value.metric(common_basis | {'source': source})
                                      for source, value in values.items()} for key, values in variable_components.items()},
    }
    if not projections:
        for amount in estimated.values():
            amount.add(None)
    empty = not projections and not any(_payment_amount(payment, fund, 'total').available for fund in FUNDS)
    total, metrics = _cost_metrics(estimated, basis, payment=payment, unknown_deduction=leave, empty=empty)
    return {
        'month': month, 'as_of': as_of.isoformat(), 'currency': 'CNY',
        'basis': basis | {'percentage_denominator': total['basis']['percentage_denominator'],
                          'percentage_basis': total['basis']['percentage_basis']},
        'days': {'entered': entered, 'remaining': remaining, 'default_elapsed': len(dates) - entered - remaining},
        'total': total, 'components': metrics, 'employees': employees, 'daily': daily,
        'departments': _groups(projections, 'department', common_basis),
        'visual_departments': _groups(projections, 'visual_department', common_basis),
        'employment': _groups(projections, 'employment_type', common_basis, payment),
        'comparison': _compare(payroll, payment, total, metrics, projections, current=True, unknown_deduction=leave),
        'previous': _compare(previous_payroll, previous_payment, total, metrics, projections, current=False, unknown_deduction=leave),
        'deductions': {'status': 'unconfirmed' if leave else 'none', 'amount': None,
                       'missing_hours': sorted(missing_leave_hours),
                       **{key: format(value, 'f') for key, value in leave_hours.items()}},
        'payroll': {'uploaded': bool(payroll and payroll['rows']), 'version': payroll['version'] if payroll else None},
    }
