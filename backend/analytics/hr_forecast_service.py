"""Read the HR inputs once per month and run the pure forecast."""
from collections import Counter, defaultdict
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from .hr_daily_work import _engine
from .hr_identity import code_key, identity
from .hr_labor_service import payroll_department_paths
from .hr_labor_forecast import calculate_month_forecast, month_dates
from .hr_personnel_events import employee_states_for_days
from .hr_roster_service import codes_for
from .models import HrDailyWork, HrLaborActualPayment, HrMonthWorkspace, HrRosterEmployee


def shanghai_today():
    return timezone.localdate(timezone=ZoneInfo('Asia/Shanghai'))


def _workspace_payload(workspace, ids):
    if not workspace:
        return None
    rows = [row | {'employee_id': ids.get((code_key(row['code']), identity(row['name'])))}
            for row in workspace.employees]
    matches = Counter(row['employee_id'] for row in rows)
    # Both rows still contribute to the uploaded gross total. They cannot each
    # be compared against the same employee's full-month forecast.
    for row in rows:
        if matches[row['employee_id']] > 1:
            row['employee_id'] = None
    return {'month': workspace.month, 'version': workspace.version, 'rows': rows}


def _roster_ids(employees):
    by_identity = defaultdict(set)
    for employee in employees:
        for code in (employee.code, *codes_for(employee)):
            by_identity[code_key(code), employee.normalized_name].add(employee.id)
    return {key: next(iter(values)) for key, values in by_identity.items() if len(values) == 1}


def forecast_payload(month, as_of):
    days = month_dates(month)
    previous_month = (days[0] - timedelta(days=1)).isoformat()[:7]
    workspaces = {row.month: row for row in HrMonthWorkspace.objects.filter(
        month__in=(month, previous_month), currency='CNY', cost_basis='gross_salary',
    )}
    payments = {record.month: record.payment | {'month': record.month, 'version': record.version}
                for record in HrLaborActualPayment.objects.filter(month__in=(month, previous_month))}
    employees = list(HrRosterEmployee.objects.prefetch_related('code_history'))
    ids = _roster_ids(employees)
    current = _workspace_payload(workspaces.get(month), ids)
    visual = {}
    if current:
        names = payroll_department_paths(workspaces[month].departments)
        for row in current['rows']:
            if row['employee_id'] is not None:
                visual[row['employee_id']] = names.get(row.get('department_id'), '')
    people = employee_states_for_days(days, employees, prior_payroll_only=True)
    for group in people.values():
        for person in group:
            person['visual_department'] = visual.get(person['id'], person['payroll'].get('visual_department', ''))
    sheets = {
        record.date.isoformat(): {'status': record.status, 'version': record.version, 'overrides': record.overrides}
        for record in HrDailyWork.objects.filter(date__range=(days[0], min(days[-1], as_of)))
    }
    return calculate_month_forecast(
        month, as_of, engine=_engine(days[0]), people_by_day=people, sheets=sheets,
        actual_payment=payments.get(month), payroll=current,
        previous_payroll=_workspace_payload(workspaces.get(previous_month), ids),
        previous_payment=payments.get(previous_month),
    )
