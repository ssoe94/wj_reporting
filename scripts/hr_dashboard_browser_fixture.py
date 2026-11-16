"""Synthetic inputs for the dashboard browser modes; loaded after SQLite migration."""
from decimal import Decimal

from analytics.hr_labor_rules import default_labor_rules
from analytics.models import (
    HrDailyWork, HrLaborActualPayment, HrLaborStandard, HrMonthWorkspace,
    HrPersonnelEvent, HrRosterEmployee,
)


def seed_dashboard(mode, actor):
    assert mode in ('legacy', 'rich')
    legacy = mode == 'legacy'
    tree = [
        {'id': 'synthetic-root', 'name': '测试工厂', 'parent_id': None, 'function': ''},
        {'id': 'synthetic-alpha', 'name': '测试甲组', 'parent_id': 'synthetic-root', 'function': ''},
        {'id': 'synthetic-alpha-part', 'name': '测试甲小组', 'parent_id': 'synthetic-alpha', 'function': ''},
        {'id': 'synthetic-beta', 'name': '测试乙组', 'parent_id': 'synthetic-root', 'function': ''},
    ]
    people = [
        ('90001', '测试甲', 'contract', '部\n长', '测试甲组', 'synthetic-alpha-part', '4751.23'),
        ('90002', '测试乙', 'hourly', '测试操作员', '测试甲组', 'synthetic-alpha-part', '5892.14'),
        ('90003', '测试丙', 'contract', '组长', '测试甲组', 'synthetic-alpha', '4430.11'),
        ('90004', '测试丁', 'contract', '测试操作员', '测试乙组', 'synthetic-beta', '4180.36'),
        ('90005', '测试戊', 'hourly', '', '测试无分组', None, '5038.43'),
        ('90006', '测试己', 'hourly', '测试操作员', '测试乙组', 'synthetic-beta', '5100.00'),
    ]
    workspaces = range(9, 11) if legacy else range(5, 11)
    components = dict(base_salary='3480.00', fixed_overtime='100.00', weekday_overtime='1080.00',
                      weekend_overtime='200.00', holiday_overtime='120.00', personal_leave='20.00',
                      sick_leave='0.00', absence='0.00')
    for month in workspaces:
        rows = []
        for code, name, employment, title, department, node, amount in people:
            if (code == '90006' and month == 10) or (code == '90004' and month < 10):
                continue
            row = dict(code=code, name=name, title=title, source_department=department, department_id=node,
                       amount=format(Decimal(amount) - (10 - month) * 23, '.2f'))
            if not legacy:
                row['employment_type'] = 'hourly' if code == '90003' and month < 10 else employment
                if row['employment_type'] == 'contract':
                    row['payroll_components'] = components if code == '90001' else components | {
                        'weekday_overtime': '180.00', 'weekend_overtime': '0.00', 'holiday_overtime': '0.00',
                    }
            rows.append(row)
        HrMonthWorkspace.objects.create(
            month=f'2026-{month:02}', currency='CNY', cost_basis='gross_salary', cost_basis_label='应发工资',
            employees=rows, departments=tree, version=3,
            source={'filename': f'synthetic-dashboard-{month:02}.xlsx', 'row_count': len(rows)}, updated_by=actor,
        )
    if legacy:
        expected = {'code', 'name', 'title', 'amount', 'source_department', 'department_id'}
        assert all(set(row) == expected for workspace in HrMonthWorkspace.objects.all() for row in workspace.employees)
        assert not any(model.objects.exists() for model in (HrRosterEmployee, HrPersonnelEvent, HrDailyWork))
        return

    roster = {}
    for code, name, employment, _, department, _, _ in people:
        roster[code] = HrRosterEmployee.objects.create(
            code=code, name=name, employment_type=employment, department=department,
            first_month='2026-10' if code == '90004' else '2026-05',
            last_month='2026-09' if code == '90006' else '2026-10',
            status='departed' if code == '90006' else 'active',
        )
    rules = default_labor_rules()
    rules['hourly_rates']['company_default'] = {'amount': '27.35', 'confirmed': True}
    rules['department_overtime'] = {'测试甲组': '3', '测试乙组': '1', '测试无分组': '0'}
    rules['department_rest_hours'] = {'测试甲组': '1.5', '测试乙组': '0'}
    for kind, config in rules['contributions'].items():
        config['applies_to'] = {'contract': True, 'hourly': True}
        config['base']['rule'] = 'gross'
        for item in config['items'].values():
            item.update(employer_rate='2.00' if kind == 'social_insurance' else '5.00', employee_rate='0.00')
    HrLaborStandard.objects.create(month='2026-05', rules=rules, updated_by=actor)
    HrLaborActualPayment.objects.create(month='2026-10', payment={'amounts': {
        'social_insurance': {'total': '2100.00', 'contract': None, 'hourly': None},
        'housing_fund': {'total': '780.00', 'contract': None, 'hourly': None},
    }, 'evidence_memo': 'SYNTHETIC invoice'}, updated_by=actor)
    HrDailyWork.objects.create(date='2026-11-06', version=1, status='confirmed', updated_by=actor,
                              overrides={str(roster['90002'].pk): {'weekday_hours': '2.5'}})
