"""Read existing HR snapshots and standards for the dashboard, without seeding records."""
from datetime import date
from functools import lru_cache

from .hr_dashboard import calculate_dashboard, entered_work
from .hr_forecast_service import _roster_ids, forecast_payload
from .hr_labor_rules import classify_day
from .hr_labor_service import effective_standard
from .models import HrDailyWork, HrLaborActualPayment, HrLaborCalendar, HrMonthWorkspace, HrRosterEmployee


def dashboard_payload(month, today):
    today_month = today.isoformat()[:7]
    payroll = HrMonthWorkspace.objects.filter(
        month__lte=month, currency='CNY', cost_basis='gross_salary', source__isnull=False,
    )
    basis_month = payroll.order_by('-month').values_list('month', flat=True).first()
    snapshots = payroll.filter(month__lte=basis_month).order_by('month').values(
        'month', 'version', 'source', 'departments', 'employees',
    ).iterator() if basis_month else ()
    roster = list(HrRosterEmployee.objects.prefetch_related('code_history'))
    payment = (HrLaborActualPayment.objects.filter(month=basis_month).values('version', 'payment').first()
               if basis_month else None)
    if payment:
        payment = payment['payment'] | {'version': payment['version']}
    standard_for = lru_cache(maxsize=None)(effective_standard)
    calendar = HrLaborCalendar.objects.filter(month=today_month).values_list('days', flat=True).first() or {}
    sheets = HrDailyWork.objects.filter(date__range=(date(today.year, today.month, 1), today)).order_by('date').values(
        'date', 'status', 'overrides',
    )
    current_rules = standard_for(today_month)['rules']
    entered = entered_work(today_month, today, sheets, lambda day: classify_day(day, calendar, rules=current_rules)['type'])
    return calculate_dashboard(
        month, today, snapshots=snapshots, basis_month=basis_month, aliases=_roster_ids(roster),
        standard_for=standard_for, roster_count=len(roster), payment=payment,
        forecast=forecast_payload(today_month, today), entered=entered,
    )
