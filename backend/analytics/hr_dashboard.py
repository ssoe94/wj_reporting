"""Read-only projections over reviewed monthly payroll snapshots."""
from collections import Counter, defaultdict
from decimal import Decimal

from .hr_dashboard_metrics import (
    KINDS, REFERENCE_HOURS, counts, employment, metric, number, payroll_load, precise_dashboard, values_summary,
)
from .hr_identity import code_key, identity, normalize_title


LEADER_RANK = {'部长': 4, 'Part長': 3, '组长': 2, '班长': 1}
MOVE_KEYS = ('hires', 'exits', 'transfers')
OVERTIME_FIELDS = {'weekday_hours': 'weekday', 'rest_hours': 'rest', 'holiday_hours': 'holiday'}


def offset_month(month, delta):
    year, number_month = map(int, month.split('-'))
    year, zero_based = divmod(year * 12 + number_month - 1 + delta, 12)
    return f'{year:04d}-{zero_based + 1:02d}'


def payroll_identity(row, aliases):
    key = (code_key(row['code']), identity(row['name']))
    owner = aliases.get(key)
    return ('roster', owner) if owner is not None else ('payroll', *key)


def history_rows(snapshots, aliases, basis_month, standard_for):
    """Track the earliest observed month; retain detail for only seven months."""
    first_seen = {}
    recent = {}
    earliest = offset_month(basis_month, -6)
    for snapshot in snapshots:
        month = snapshot['month']
        groups = defaultdict(list)
        for row in snapshot['employees']:
            groups[payroll_identity(row, aliases)].append(row)
        for key, rows in groups.items():
            if len(rows) == 1:
                first_seen.setdefault(key, month)
        if month < earliest:
            continue
        standard = standard_for(month)
        people = []
        for index, row in enumerate(snapshot['employees']):
            key = payroll_identity(row, aliases)
            values, load, wages = payroll_load(row, month, standard['rules'], aliases.get((code_key(row['code']), identity(row['name']))),
                                               standard_month=standard['month'], standard_version=standard['version'])
            people.append({'row': row, 'identity': key, 'ambiguous': len(groups[key]) != 1, 'values': values,
                           'load': load, 'wages': wages, 'kind': employment(row), 'key': f'p{index + 1}'})
        recent[month] = (snapshot, people)
    return recent, first_seen


def payroll_movements(current, previous, month):
    prior_month = offset_month(month, -1)
    by_kind = dict.fromkeys(MOVE_KEYS)
    ambiguous = 0
    transfer_unknown = 0
    if current is not None and previous is not None:
        excluded = {person['identity'] for person in [*current, *previous] if person['ambiguous']}
        ambiguous = len(excluded)
        old, new = ({person['identity']: person['kind'] for person in people if person['identity'] not in excluded}
                    for people in (previous, current))
        retained = old.keys() & new.keys()
        known_retained = [key for key in retained if 'unknown' not in (old[key], new[key])]
        transfer_unknown = len(retained) - len(known_retained)
        by_kind = {
            'hires': [new[key] for key in new.keys() - old.keys()],
            'exits': [old[key] for key in old.keys() - new.keys()],
            'transfers': [new[key] for key in known_retained if new[key] != old[key]]
            if known_retained or not transfer_unknown else None,
        }
    formulas = {
        'hires': 'current identities absent from previous payroll (type on arrival)',
        'exits': 'previous identities absent from current payroll (type on departure)',
        'transfers': 'matched identities with changed employment type (destination type)',
    }
    return {key: counts(kinds, month, formulas[key], partial=bool(ambiguous) or key == 'transfers' and bool(transfer_unknown),
                        estimated=True, previous_month=prior_month,
                        missing_months=[key for key, people in ((prior_month, previous), (month, current)) if people is None],
                        ambiguous_identities=ambiguous,
                        unclassified_matches=transfer_unknown if key == 'transfers' else 0)
            for key, kinds in by_kind.items()}


def three_month_turnover(trends, month):
    window = trends[-3:]
    result = {}
    for kind in KINDS[:2]:
        exits = [row['movements']['exits'][kind] for row in window]
        headcounts = [row['headcount'][kind] for row in window]
        inputs = exits + headcounts
        available = all(item['value'] is not None for item in inputs)
        denominator = sum(item['value'] for item in headcounts) if available else 0
        numerator = sum(item['value'] for item in exits) if available else None
        result[kind] = metric(
            Decimal(numerator) * 300 / denominator if denominator else None, month,
            'three-month exits / mean of three monthly payroll headcounts × 100',
            estimated=True, partial=any(item['status'] == 'partial' for item in inputs),
            months=[row['month'] for row in window], departures=numerator,
            sum_headcount=denominator if available else None,
        )
    return result


def wages_metrics(people, month):
    if people is None:
        people = []
        observed = False
    else:
        observed = True
    if not observed:
        return {key: metric(None, month, formula) for key, formula in {
            'gross': 'sum(uploaded gross salary)', 'per_person': 'known gross salary / rows with known amount',
            'fixed': 'gross − variable overtime + deductions', 'overtime': 'sum(contract overtime pay)',
            'deductions': 'sum(contract leave and absence deductions)', 'hourly': 'sum(hourly gross salary)',
            'overtime_share': 'contract overtime / total gross salary × 100',
        }.items()}
    gross_values = [person['wages']['gross'] for person in people]
    gross = values_summary(gross_values, month, 'sum(uploaded gross salary)')
    average = values_summary(gross_values, month, 'known gross salary / rows with known amount', average=True)
    unknown = any(person['kind'] == 'unknown' for person in people)
    parts = {}
    for key, formula in (
        ('fixed', 'gross − variable overtime + deductions'), ('overtime', 'sum(contract overtime pay)'),
        ('deductions', 'sum(contract leave and absence deductions)'), ('hourly', 'sum(hourly gross salary)'),
    ):
        kind = 'hourly' if key == 'hourly' else 'contract'
        values = [person['wages'][key] for person in people if person['kind'] in (kind, 'unknown')]
        parts[key] = values_summary(values, month, formula, employment_type=kind)
    known_gross = sum((value for value in gross_values if value is not None), Decimal(0))
    overtime = [person['wages']['overtime'] for person in people if person['kind'] == 'contract']
    share = (sum(overtime, Decimal(0)) / known_gross * 100
             if not unknown and gross['status'] == 'ready' and known_gross and all(value is not None for value in overtime) else None)
    return {'gross': gross, 'per_person': average, **parts,
            'overtime_share': metric(share, month, 'contract overtime / total gross salary × 100')}


def load_summary(people, month):
    contract = [person for person in people if person['kind'] == 'contract']
    hourly = [person for person in people if person['kind'] == 'hourly']
    unknown = sum(person['kind'] == 'unknown' for person in people)
    rest_hours = [person['values']['rest'] for person in contract if person['values']['rest'] is not None]
    resting = sum(value > 0 for value in rest_hours)
    ranked = {}
    for kind, group, field in (('contract', contract, 'total'), ('hourly', hourly, 'excess')):
        ranked[kind] = [person for person in group if person['values'][field] is not None]
        ranked[kind].sort(key=lambda person: (-person['values'][field], code_key(person['row']['code']),
                                              identity(person['row']['name']), person['key']))
    uncertain_rates = sum(person['load']['excess']['status'] == 'partial' for person in hourly)
    hourly_average = values_summary(
        [person['values']['excess'] for person in hourly] + [None] * unknown, month,
        'sum(estimated hours over 174) / hourly employees with an estimate', average=True,
        estimated=True, unconfirmed_rates=uncertain_rates,
    )
    if hourly_average['status'] == 'ready' and uncertain_rates:
        hourly_average['status'] = 'partial'
    summary = {
        'contract_average': values_summary(
            [person['values']['total'] for person in contract] + [None] * unknown, month,
            'sum(estimated overtime hours) / contract employees with an estimate', average=True, estimated=True,
        ),
        'hourly_average': hourly_average,
        'rest_worker_ratio': metric(Decimal(resting) * 100 / len(rest_hours) if rest_hours else None, month,
                                    'contract employees with rest-day pay / contract employees with calculable rest hours × 100',
                                    estimated=True, partial=len(rest_hours) < len(contract) + unknown,
                                    observed=len(rest_hours), rest_workers=resting),
        'maximum': {kind: group[0]['key'] if group else None for kind, group in ranked.items()},
    }
    return summary, ranked


def organization(snapshot, people, first_seen, trend_months, history):
    month = snapshot['month']
    definitions = {node['id']: node for node in snapshot['departments']}
    unassigned = '__unassigned__'
    while unassigned in definitions:
        unassigned += '_'
    if any(person['row'].get('department_id') not in definitions for person in people):
        definitions[unassigned] = {'id': unassigned, 'name': '', 'parent_id': None}
    parents = {key: node.get('parent_id') if node.get('parent_id') in definitions else None
               for key, node in definitions.items()}

    def ancestry(key):
        path = [key]
        while parents[path[-1]] is not None and parents[path[-1]] not in path:
            path.append(parents[path[-1]])
        return list(reversed(path))

    # Real workspaces are validated as acyclic. Detach a corrupt historic edge
    # rather than trapping the reader in a loop or dropping its people.
    for key in parents:
        if parents[ancestry(key)[0]] is not None:
            parents[key] = None
    paths = {key: ancestry(key) for key in definitions}
    names = {key: [definitions[item]['name'] for item in path] for key, path in paths.items()}
    direct, inclusive = defaultdict(list), defaultdict(list)
    lookup = {key: {person['identity']: person for person in entries if not person['ambiguous']}
              for key, (_, entries) in history.items()}
    result_people = []
    for person in people:
        row = person['row']
        key = row.get('department_id')
        key = key if key in definitions else unassigned
        direct[key].append(person)
        for ancestor in paths[key]:
            inclusive[ancestor].append(person)
        first = first_seen.get(person['identity']) if not person['ambiguous'] else None
        tenure = (int(month[:4]) - int(first[:4])) * 12 + int(month[5:]) - int(first[5:]) + 1 if first else None
        trend = []
        for point in trend_months:
            past = (person if point == month else lookup.get(point, {}).get(person['identity'])) if not person['ambiguous'] else None
            # Keep unlike quantities out of a person's single time series after a transfer.
            comparable = past and past['kind'] == person['kind']
            load_key = 'excess' if person['kind'] == 'hourly' else 'total'
            trend.append({
                'month': point, 'payroll': metric(past['wages']['gross'] if past else None, point, 'uploaded gross salary'),
                'load': past['load'][load_key] if comparable else metric(None, point, 'comparable employment type only', estimated=True),
            })
        result_people.append({
            'key': person['key'], 'code': row['code'], 'name': row['name'], 'title': row.get('title') or '',
            'employment': person['kind'], 'node_id': key, 'path': names[key],
            'tenure': metric(tenure, month, 'months since first matched payroll, inclusive',
                             estimated=True, first_seen=first, lower_bound=True),
            'payroll': metric(person['wages']['gross'], month, 'uploaded gross salary'),
            'load': person['load'], 'trend': trend,
        })
    nodes = []
    for key, node in definitions.items():
        group = inclusive[key]
        # Include children when a department's leader is recorded in a part.
        ranks = {person['key']: LEADER_RANK.get(normalize_title(person['row'].get('title') or ''), 0) for person in group}
        best = max(ranks.values(), default=0)
        wages = wages_metrics(group, month)
        nodes.append({
            'id': key, 'name': node['name'], 'parent_id': parents[key], 'path': names[key], 'unassigned': key == unassigned,
            'direct': counts((person['kind'] for person in direct[key]), month, 'payroll rows directly assigned to node'),
            'inclusive': counts((person['kind'] for person in group), month, 'payroll rows in node and descendant nodes'),
            'payroll': wages['gross'], 'per_person': wages['per_person'], 'overtime_pay': wages['overtime'],
            'load': load_summary(group, month)[0], 'leaders': [key for key, rank in ranks.items() if best and rank == best] if key != unassigned else [],
        })
    return {'nodes': nodes, 'people': result_people}


def entered_work(month, today, records, classify):
    """Sum only stored overrides on saved dates; projected hours never enter."""
    amounts = dict.fromkeys(OVERTIME_FIELDS.values(), Decimal(0))
    observed = Counter()
    missing = Counter()
    entered = set()
    slot_for_day = {'workday': 'weekday_hours', 'adjusted_workday': 'weekday_hours',
                    'rest_day': 'rest_hours', 'public_holiday': 'holiday_hours'}
    for record in records:
        if record['status'] not in ('draft', 'confirmed') or record['date'] > today:
            continue
        entered.add(record['date'])
        field = slot_for_day[classify(record['date'])]
        slot = OVERTIME_FIELDS[field]
        for work in record['overrides'].values():
            if field not in work or work.get('attendance') in ('off', 'absent'):
                continue
            value = number(work[field])
            if value is None:
                missing[slot] += 1
            else:
                amounts[slot] += value
                observed[slot] += 1
    elapsed_saved = sum(day < today for day in entered)
    return {
        'days': metric(len(entered), month, 'dates through today with saved draft or confirmed sheets'),
        'missing_days': metric(today.day - 1 - elapsed_saved, month, 'calendar dates before today − dates with saved sheets'),
        **{slot: metric(value if observed[slot] else None, month, 'sum of explicit saved hour overrides only',
                        partial=bool(missing[slot]), observed=observed[slot]) for slot, value in amounts.items()},
    }


def actual_cost(wages, month, payment):
    payment = payment or {}
    components = {}
    for key in ('social_insurance', 'housing_fund'):
        amounts = payment.get('amounts', {}).get(key, {})
        total = number(amounts.get('total'))
        parts = [number(amounts.get(kind)) for kind in KINDS[:2] if amounts.get(kind) is not None]
        subtotal = sum((value for value in parts if value is not None), Decimal(0)) if parts else None
        components[key] = metric(total if total is not None else subtotal, month, 'recorded employer payment',
                                 partial=total is None and len(parts) == 1, version=payment.get('version'))
    # No payroll upload means there is no basis-month actual cost.
    combined = [wages['gross'], *components.values()]
    total = (sum((Decimal(item['value']) for item in combined if item['value'] is not None), Decimal(0))
             if month and any(item['value'] is not None for item in combined) else None)
    return {key: wages[key] for key in ('gross', 'fixed', 'overtime', 'hourly', 'deductions')} | components | {
        'total': metric(total, month, 'gross salary + recorded employer insurance + recorded employer housing fund',
                        partial=any(item['status'] != 'ready' for item in combined)),
    }


def _flow_link(step, month):
    page = 'work' if step in ('daily', 'forecast', 'standards') else 'personnel'
    return f'/hr/{page}?step={step}&month={month}'


def dashboard_insights(org, prior, turnover, load, month):
    def item(code, value, step, label=None, kind='warning'):
        return {'code': code, 'kind': kind, 'metric': value,
                'link': _flow_link(step, month), **({'label': label} if label is not None else {})}

    nodes = [node for node in org['nodes'] if not node['unassigned']]
    roots = [node for node in nodes if node['parent_id'] is None]
    parts = [node for node in nodes if node['parent_id'] is not None]
    insights = []
    if prior is not None:
        previous, previous_people = prior
        old_nodes = {node['id']: node for node in previous['departments']}
        previous_counts = Counter()
        for person in previous_people:
            key = person['row'].get('department_id')
            seen = set()
            while key in old_nodes and key not in seen:
                seen.add(key)
                parent = old_nodes[key].get('parent_id')
                if parent is None:
                    previous_counts[key] += 1
                    break
                key = parent
        changes = [(root['inclusive']['total']['value'] - previous_counts[root['id']], root['name'], root['id']) for root in roots]
        current_ids = {root['id'] for root in roots}
        changes.extend((-previous_counts[key], node['name'], key) for key, node in old_nodes.items()
                       if node.get('parent_id') is None and key not in current_ids)
        if changes:
            delta, name, _ = min(changes, key=lambda change: (-abs(change[0]), change[1], change[2]))
            if abs(delta) >= 2:
                insights.append(item('department_change', metric(
                    delta, month, 'department current inclusive headcount − previous inclusive headcount',
                    previous_month=previous['month'], threshold_people=2), 'assign', name))
    if turnover['hourly']['value'] is not None and Decimal(turnover['hourly']['value']) > 0:
        insights.append(item('hourly_turnover', turnover['hourly'], 'roster', kind='info'))

    def best(nodes, field, minimum):
        eligible = [node for node in nodes if node['load'][field]['value'] is not None and
                    Decimal(node['load'][field]['value']) >= minimum]
        return min(eligible, key=lambda node: (-Decimal(node['load'][field]['value']), node['id']), default=None)

    busiest = best(parts, 'contract_average', Decimal('.01'))
    if busiest:
        insights.append(item('highest_load', busiest['load']['contract_average'], 'cost', ' / '.join(busiest['path'])))
    rest = best(roots, 'rest_worker_ratio', 50)
    if rest:
        insights.append(item('high_rest_share', rest['load']['rest_worker_ratio'], 'cost', rest['name']))
    if load['above_reference']['value']:
        insights.append(item('above_reference', load['above_reference'], 'cost'))
    unassigned = next((node for node in org['nodes'] if node['unassigned']), None)
    if unassigned:
        insights.append(item('unassigned', unassigned['inclusive']['total'], 'assign'))
    return insights[:8]


def dashboard_needs(history, reference_month, today_month, roster_count, rules, missing_days):
    def item(code, value, month, step, formula, kind='warning', *, partial=False):
        return {'code': code, 'kind': kind, 'month': month, 'metric': metric(value, month, formula, partial=partial),
                'link': _flow_link(step, month)}

    result = []
    for month, (_, people) in sorted(history.items(), reverse=True):
        if reference_month and month < offset_month(reference_month, -5):
            continue
        rows = sum(person['wages']['reupload'] or
                   (person['kind'] == 'unknown' and not person['row'].get('payroll_components'))
                   for person in people)
        if rows:
            result.append(item('reupload_components', rows, month, 'upload', 'payroll rows without required components'))
    if reference_month:
        unclassified = sum(person['kind'] == 'unknown' for person in history[reference_month][1])
        if unclassified:
            result.append(item('employment_unknown', unclassified, reference_month, 'upload', 'payroll rows without recorded employment type'))
    if not roster_count:
        result.append(item('roster_empty', 0, reference_month or today_month, 'upload', 'count(HrRosterEmployee)'))
    for fund, config in rules['contributions'].items():
        if all(applies is False for applies in config['applies_to'].values()):
            continue
        missing = sum(rate is None for sides in config['items'].values() for rate in sides.values())
        if missing:
            result.append(item(f'{fund}_rates', missing, today_month, 'standards', 'count(unentered employer or employee rates)'))
    rate = rules['hourly_rates']['company_default']
    if rate['amount'] is None or not rate['confirmed']:
        result.append(item('hourly_rate_unconfirmed', number(rate['amount']), today_month, 'standards',
                           'company hourly rate requires confirmation', partial=True))
    configured = rules.get('department_rest_hours', {})
    departments = set(rules['department_overtime'])
    if reference_month:
        departments.update(person['row'].get('source_department') for person in history[reference_month][1]
                           if person['row'].get('source_department'))
    unconfigured = sum(configured.get(department) is None for department in departments)
    if unconfigured or not any(value is not None for value in configured.values()):
        result.append(item('rest_hours_unconfigured', unconfigured, today_month, 'standards', 'departments without a rest-day average', 'info'))
    result.append(item('deduction_formula', None, today_month, 'daily', 'leave and absence deduction formula pending', 'info'))
    if missing_days['value']:
        result.append({'code': 'missing_daily_sheets', 'kind': 'warning', 'month': today_month,
                       'metric': missing_days, 'link': _flow_link('daily', today_month)})
    return result


@precise_dashboard
def calculate_dashboard(month, today, *, snapshots, basis_month, aliases, standard_for,
                        roster_count, payment, forecast, entered):
    anchor = basis_month or month
    history, first_seen = history_rows(snapshots, aliases, anchor, standard_for)
    trend_months = [offset_month(anchor, delta) for delta in range(-5, 1)]
    trends = []
    for point in trend_months:
        _, people = history.get(point, (None, None))
        _, previous = history.get(offset_month(point, -1), (None, None))
        wages = wages_metrics(people, point)
        trends.append({
            'month': point,
            'headcount': counts(None if people is None else (person['kind'] for person in people), point, 'count(rows in uploaded payroll)'),
            'movements': payroll_movements(people, previous, point),
            **{key: wages[key] for key in ('gross', 'per_person', 'overtime_share')},
        })
    reference, people = history.get(anchor, (None, None))
    turnover = three_month_turnover(trends, anchor)
    organization_data = (organization(reference, people, first_seen, trend_months, history)
                         if reference else {'nodes': [], 'people': []})
    summary, ranked = load_summary(people or [], basis_month)
    qualifying = ranked['contract']
    eligible = sum(person['kind'] in ('contract', 'unknown') for person in people or [])
    above = sum(person['values']['total'] > REFERENCE_HOURS for person in qualifying)
    load = {
        'contract_average': summary['contract_average'], 'hourly_average': summary['hourly_average'],
        'above_reference': metric(above if qualifying or reference and not eligible else None, basis_month,
                                  'count(contract employees with estimated overtime > 36 hours)',
                                  estimated=True, partial=len(qualifying) < eligible, observed=len(qualifying), eligible=eligible),
        'reference_hours': metric(REFERENCE_HOURS, basis_month, 'PRC Labor Law Article 41 monthly reference'),
        'entered': entered, 'rankings': {kind: [person['key'] for person in group[:10]] for kind, group in ranked.items()},
    }
    today_month = today.isoformat()[:7]
    total = forecast['total']
    forecast_basis = {'source_months': forecast['basis']['source_months'], 'as_of': forecast['as_of']}
    source = None
    if reference:
        source_data = reference['source']
        source = {
            'month': basis_month, 'version': reference['version'], 'filename': source_data.get('filename'),
            'row_count': len(people),
            'basis': {'month': basis_month, 'formula': 'latest uploaded CNY gross payroll <= requested month',
                      'estimated': False, 'version': reference['version']},
        }
    return {
        'month': month, 'today': today.isoformat(), 'source': source,
        'headcount': trends[-1]['headcount'], 'movements': trends[-1]['movements'], 'turnover': turnover,
        'organization': organization_data, 'load': load, 'trends': trends,
        'cost': {
            'actual': actual_cost(wages_metrics(people, basis_month), basis_month, payment),
            'forecast': {
                'month': today_month, 'status': total['status'],
                'total': metric(total['amount'], today_month, 'existing monthly labor forecast', estimated=True, **forecast_basis),
                'known_amount': metric(total['known_amount'] if total['status'] != 'missing' else None, today_month,
                                       'known subtotal of existing monthly labor forecast', estimated=True,
                                       partial=total['status'] == 'partial_missing', **forecast_basis),
            },
        },
        'insights': dashboard_insights(organization_data, history.get(offset_month(anchor, -1)), turnover, load, anchor),
        'needs': dashboard_needs(history, basis_month, today_month, roster_count, standard_for(today_month)['rules'], entered['missing_days']),
    }
