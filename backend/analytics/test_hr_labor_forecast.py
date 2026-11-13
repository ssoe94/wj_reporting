"""Synthetic fixed wages, month projections and private read API tests."""
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest import TestCase as PureTestCase
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .hr_forecast_service import shanghai_today
from .hr_labor_forecast import calculate_month_forecast, extract_fixed_pay, month_dates
from .hr_labor_rules import default_labor_rules
from .models import HrDailyWork, HrLaborCalendar, HrMonthWorkspace, HrRosterEmployee


MONTH = '2026-11'
AS_OF = date(2026, 11, 12)
COLUMNS = {
    'weekday_overtime': '250.00', 'weekend_overtime': '100.00', 'holiday_overtime': '75.00',
    'personal_leave': '20.00', 'sick_leave': '15.00', 'absence': '10.00',
    'base_salary': '3480.00', 'fixed_overtime': '125.00',
}


def person(employee_id=1, *, department='注塑', employment='contract', source='2026-10', components=COLUMNS):
    return {
        'id': employee_id, 'code': f'00{employee_id}', 'name': f'Test employee {employee_id}',
        'active': True, 'department': department, 'visual_department': 'Synthetic team',
        'title': 'Operator', 'employment_type': employment, 'hourly_rate': None,
        'base_salary': '3480.00' if employment == 'contract' else None,
        'fixed_overtime': '125.00' if employment == 'contract' else None,
        'pay_event_id': None, 'pay_event_date': None,
        'payroll': {'month': source, 'workspace_version': 3, 'employment_type': employment,
                    'gross_amount': '4580.00', 'payroll_components': components},
    }


def engine(*, overrides=None, known_rates=True):
    rules = default_labor_rules()
    rules['hourly_rates']['company_default']['confirmed'] = True
    for config in rules['contributions'].values():
        config['applies_to'] = {'contract': True, 'hourly': True}
        config['base'].update(rule='common', common_amount='1000')
        if known_rates:
            for item in config['items'].values():
                item.update(employer_rate='2', employee_rate='1')
    return {'rules': rules, 'overrides': overrides or {}, 'version': 4,
            'effective_month': '2026-10', 'calendar_version': 2}


def run(people, *, month=MONTH, as_of=AS_OF, settings=None, **kwargs):
    by_day = {day.isoformat(): people(day) if callable(people) else people for day in month_dates(month)}
    return calculate_month_forecast(month, as_of, engine=settings or engine(), people_by_day=by_day, **kwargs)


def payroll(month, *rows):
    return {'month': month, 'version': 2, 'rows': list(rows)}


def actual_row(p, gross, components=COLUMNS):
    return {'employee_id': p['id'], 'code': p['code'], 'name': p['name'], 'employment_type': p['employment_type'],
            'amount': gross, 'payroll_components': components}


def payment(month, social, housing, *, contract=None, hourly=None):
    return {'month': month, 'version': 3, 'evidence_memo': 'Synthetic statement',
            'amounts': {'social_insurance': {'total': social, 'contract': contract, 'hourly': hourly},
                        'housing_fund': {'total': housing, 'contract': None, 'hourly': None}}}


class ForecastCalculationTests(PureTestCase):
    def test_empty_month_has_missing_components_not_zero_wages(self):
        result = run([])
        self.assertEqual(result['total']['status'], 'missing')
        self.assertEqual(result['employees'], [])
        self.assertTrue(all(item['amount'] is None for item in result['components'].values()))

    def test_fixed_pay_subtracts_overtime_and_adds_positive_deductions(self):
        self.assertEqual(extract_fixed_pay('4580.00', COLUMNS), Decimal('4200.00'))
        self.assertEqual(extract_fixed_pay('4625.00', COLUMNS | dict.fromkeys(('personal_leave', 'sick_leave', 'absence'), '0')), Decimal('4200.00'))
        self.assertIsNone(extract_fixed_pay('4580.00', {'base_salary': '3480', 'fixed_overtime': '125'}))
        self.assertIsNone(extract_fixed_pay('4580.00', COLUMNS | {'absence': None}))
        self.assertIsNone(extract_fixed_pay('1.00', COLUMNS))
        with self.assertRaises(ValueError):
            extract_fixed_pay('4580.00', COLUMNS | {'personal_leave': '-20'})

    def test_proration_for_hire_exit_and_change_with_adjusted_and_holiday_days(self):
        a, b, c = person(1), person(2), person(3)
        hourly = c | {'employment_type': 'hourly', 'base_salary': None, 'fixed_overtime': None}
        override = {'2026-11-07': 'adjusted_workday', '2026-11-18': 'public_holiday'}
        result = run(lambda day: ([a] if day.day >= 16 else []) + ([b] if day.day <= 6 else []) +
                     [c if day.day < 16 else hourly], settings=engine(overrides=override))
        self.assertEqual(result['basis']['workdays'], 21)
        for entry, workdays, expected in zip(result['employees'], (10, 5, 11), ('2000.00', '1000.00', '2200.00'), strict=True):
            self.assertEqual(entry['components']['fixed_pay']['amount'], expected)
            self.assertEqual(entry['basis']['contract_workdays'], workdays)
            self.assertEqual(entry['basis']['fixed_pay_periods'][0]['source_month'], '2026-10')
        self.assertEqual(result['components']['fixed_pay']['amount'], '5200.00')

    def test_event_hire_known_fixed_components_are_partial_and_prorated(self):
        hire = person() | {'pay_event_id': 5, 'pay_event_date': '2026-11-16', 'payroll': {}}
        result = run(lambda day: [hire] if day.day >= 16 else [])
        wages = result['components']['fixed_pay']
        self.assertIsNone(wages['amount'])
        self.assertEqual(wages['known_amount'], '1888.33')
        self.assertEqual(wages['status'], 'partial_missing')
        details = result['employees'][0]['basis']['fixed_pay_periods'][0]
        self.assertEqual(details['missing_reason'], 'other_fixed_items_not_acquired')
        self.assertEqual(details['eligible_workdays'], 11)

    def test_legacy_components_produce_missing_fixed_pay_even_with_basic_salary(self):
        legacy = person(components={'base_salary': '3480', 'fixed_overtime': '125'})
        result = run([legacy])
        self.assertEqual(result['components']['fixed_pay']['status'], 'missing')
        self.assertEqual(result['employees'][0]['basis']['fixed_pay_periods'][0]['missing_reason'], 'fixed_pay_not_acquired')
        self.assertEqual(result['components']['overtime']['amount'], '2520.00')

    def test_entered_cutoff_and_three_sheet_statuses(self):
        sheets = {
            '2026-11-09': {'status': 'estimated', 'overrides': {'1': {'weekday_hours': '1'}}},
            '2026-11-10': {'status': 'draft', 'version': 2, 'overrides': {'1': {'weekday_hours': '1'}}},
            '2026-11-11': {'status': 'confirmed', 'overrides': {'1': {'weekday_hours': '2'}}},
            '2026-11-13': {'status': 'confirmed', 'overrides': {'1': {'weekday_hours': '3'}}},
        }
        result = run([person()], sheets=sheets)
        self.assertEqual(result['days'], {'entered': 2, 'remaining': 18, 'default_elapsed': 10})
        days = {row['date']: row for row in result['daily']}
        self.assertEqual(days['2026-11-09']['known_amount'], '120.00')
        self.assertEqual(days['2026-11-10']['known_amount'], '30.00')
        self.assertEqual(days['2026-11-11']['known_amount'], '60.00')
        self.assertEqual(days['2026-11-13']['known_amount'], '120.00')
        self.assertEqual(days['2026-11-10']['basis']['sheet_version'], 2)
        self.assertEqual(result['basis']['variable_pay']['entered']['amount'], '90.00')
        self.assertEqual(result['basis']['variable_pay']['default']['amount'], '2280.00')
        self.assertEqual(days['2026-11-30']['entered_cumulative_known_amount'], '90.00')

    def test_rest_hours_apply_to_elapsed_and_remaining_default_days(self):
        team = 'Synthetic team'
        p = person(department=team) | {'title': 'Part長'}
        h = person(2, department=team, employment='hourly')
        settings = engine(overrides={'2026-11-15': 'public_holiday', '2026-11-21': 'adjusted_workday'})
        settings['rules']['department_rest_hours'][team] = '1.25'
        settings['rules']['department_overtime'][team] = '0'
        result = run([p, h], settings=settings, sheets={
            '2026-11-08': {'status': 'confirmed', 'overrides': {'1': {'attendance': 'off'}, '2': {'attendance': 'off'}}},
        })
        days = {row['date']: (row['source'], row['amount']) for row in result['daily']}
        self.assertEqual(days['2026-11-07'], ('default', '111.25'))
        self.assertEqual(days['2026-11-08'], ('entered', '0.00'))
        self.assertEqual(days['2026-11-14'], ('default', '111.25'))
        self.assertEqual(days['2026-11-15'], ('default', '0.00'))
        self.assertEqual(days['2026-11-21'], ('default', '196.00'))
        self.assertEqual(result['components']['overtime']['amount'], '300.00')

    def test_funds_use_actual_with_estimates_and_missing_rates_known_denominator(self):
        p = person()
        result = run([p], settings=engine(known_rates=False),
                     actual_payment=payment(MONTH, '111.00', None, contract='100.00'))
        social, housing = (result['components'][fund] for fund in ('social_insurance', 'housing_fund'))
        self.assertEqual(social['amount'], '111.00')
        self.assertEqual(social['actual']['amount'], '111.00')
        self.assertEqual(social['estimate']['status'], 'missing')
        self.assertIsNone(housing['amount'])
        self.assertEqual(result['total']['status'], 'partial_missing')
        self.assertEqual(result['total']['known_amount'], '6831.00')
        self.assertEqual(result['basis']['percentage_denominator'], '6831.00')
        self.assertEqual(result['basis']['percentage_basis'], 'known_amount')
        self.assertEqual(result['components']['fixed_pay']['percentage'], '61.48')
        self.assertEqual(result['employment'][0]['components']['social_insurance']['amount'], '100.00')
        self.assertEqual(result['departments'][0]['components']['social_insurance']['status'], 'missing')

    def test_partial_employer_payment_does_not_replace_company_estimate(self):
        result = run([person()], actual_payment=payment(MONTH, None, None, contract='25'))
        social = result['components']['social_insurance']
        self.assertEqual(social['amount'], '100.00')
        self.assertEqual(social['actual']['known_amount'], '25.00')
        self.assertEqual(social['actual']['status'], 'partial_missing')
        self.assertEqual(result['employment'][0]['components']['social_insurance']['amount'], '25.00')

    def test_department_transfer_allocates_fixed_and_variable_to_each_slice(self):
        a = person()
        b = a | {'department': '加工'}
        result = run(lambda day: [a if day.day <= 15 else b])
        departments = {group['name']: group for group in result['departments']}
        self.assertEqual(departments['注塑']['components']['fixed_pay']['amount'], '2000.00')
        self.assertEqual(departments['加工']['components']['fixed_pay']['amount'], '2200.00')
        self.assertEqual(departments['注塑']['components']['overtime']['amount'], '1200.00')
        self.assertEqual(departments['加工']['components']['overtime']['amount'], '825.00')
        self.assertEqual(departments['加工']['employee_amounts']['1']['total']['amount'], '3145.00')
        self.assertEqual(result['visual_departments'][0]['name'], 'Synthetic team')

    def test_unknown_department_and_leave_leave_money_incomplete(self):
        p = person(department='管理部')
        sheets = {
            '2026-11-10': {'status': 'draft', 'overrides': {'1': {'attendance': 'personal_leave', 'personal_leave_hours': '3'}}},
            '2026-11-11': {'status': 'confirmed', 'overrides': {'1': {'attendance': 'sick_leave', 'sick_leave_hours': '2.5'}}},
        }
        result = run([p], sheets=sheets)
        self.assertEqual(result['components']['overtime']['status'], 'partial_missing')
        self.assertIsNone(result['total']['amount'])
        self.assertEqual(result['deductions'], {'status': 'unconfirmed', 'amount': None, 'missing_hours': [],
                                               'personal_leave_hours': '3', 'sick_leave_hours': '2.5'})

    def test_current_and_previous_differences_rank_and_reason_codes(self):
        c, h = person(1), person(2, employment='hourly')
        current = payroll(MONTH, actual_row(c, '5080.00'), actual_row(h, '5800.00', {}))
        prior = payroll('2026-10', actual_row(c, '4580.00'), actual_row(h, '5700.00', {}))
        result = run([c, h], payroll=current, previous_payroll=prior,
                     actual_payment=payment(MONTH, '250', '60'))
        compare = result['comparison']
        self.assertEqual(compare['components']['fixed_pay'], '-500.00')
        self.assertEqual(compare['components']['overtime'], '2095.00')
        self.assertEqual(compare['components']['social_insurance'], '-50.00')
        # 4,200 fixed + 2,520 overtime + 21 × (8 + 4 × 1.5) × 24.50
        # minus the two gross wages; the same actual payments cancel out.
        self.assertEqual(compare['total_difference'], '3043.00')
        self.assertEqual([row['id'] for row in compare['employees']], [1, 2])
        self.assertEqual(set(compare['reasons']), {'hourly_no_premium', 'variable_fixed_items', 'actual_vs_estimate'})
        self.assertEqual(compare['basis']['comparison_direction'], 'forecast_minus_actual')
        self.assertIsNone(result['previous']['total_difference'])
        self.assertEqual(result['previous']['wage_difference'], '3643.00')

    def test_unconfirmed_deduction_blocks_difference_without_hiding_component_evidence(self):
        p = person()
        sheets = {'2026-11-10': {'status': 'confirmed',
                                'overrides': {'1': {'attendance': 'personal_leave', 'personal_leave_hours': '1'}}}}
        result = run([p], sheets=sheets, payroll=payroll(MONTH, actual_row(p, '4580.00')),
                     actual_payment=payment(MONTH, '100', '20'))
        self.assertIn('deduction_unconfirmed', result['comparison']['reasons'])
        self.assertIsNone(result['comparison']['total_difference'])
        self.assertIsNone(result['comparison']['wage_difference'])
        self.assertEqual(result['comparison']['components']['fixed_pay'], '0.00')
        self.assertEqual(result['comparison']['employees'], [])


class ForecastApiTests(TestCase):
    url = '/api/analytics/hr/labor-forecast/2026-11/'

    def setUp(self):
        users = get_user_model().objects
        self.allowed = users.create(username='forecast-reviewer', is_superuser=True)
        self.denied = users.create(username='forecast-unprivileged')
        self.employee = HrRosterEmployee.objects.create(
            code='001', name='Test employee 1', normalized_code='1', normalized_name='Testemployee1',
            employment_type='contract', department='注塑', first_month='2026-09', last_month='2026-11',
        )
        self.client = APIClient()

    def save_payroll(self, month, amount, components):
        row = actual_row(person(), amount, components) | {'source_department': '注塑', 'title': 'Operator',
                                                             'department_id': 'synthetic'}
        return HrMonthWorkspace.objects.create(month=month, currency='CNY', cost_basis='gross_salary',
                                               employees=[row], departments=[{'id': 'synthetic', 'name': 'Test team'}])

    def test_permission_month_validation_and_no_store(self):
        self.client.force_authenticate(self.denied)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 403)
        self.assertIn('no-store', response['Cache-Control'])
        self.client.force_authenticate(self.allowed)
        self.assertEqual(self.client.get(self.url.replace('2026-11', '2026-13')).status_code, 400)
        self.assertEqual(self.client.post(self.url, {}, format='json').status_code, 405)

    def test_deterministic_reads_use_strictly_prior_payroll_and_fresh_sheet(self):
        self.save_payroll('2026-09', '9000.00', COLUMNS)
        self.save_payroll('2026-10', '4580.00', COLUMNS)
        actual = self.save_payroll(MONTH, '9000.00', COLUMNS | {'base_salary': '9999.00'})
        HrLaborCalendar.objects.create(month=MONTH, days={'2026-11-18': 'public_holiday'})
        self.client.force_authenticate(self.allowed)
        with patch('analytics.hr_views.shanghai_today', return_value=AS_OF):
            response = self.client.get(self.url)
            self.assertEqual(response.status_code, 200)
            first = response.json()
            self.assertEqual(first, self.client.get(self.url).json())
            self.assertIn('private', response['Cache-Control'])
            self.assertIn('no-store', response['Cache-Control'])
            self.assertEqual(first['components']['fixed_pay']['amount'], '4200.00')
            self.assertEqual(first['components']['overtime']['amount'], '2400.00')
            self.assertEqual(first['comparison']['actual']['basis']['gross_payroll']['amount'], '9000.00')
            self.assertEqual(first['visual_departments'][0]['name'], 'Test team')
            self.assertFalse(HrDailyWork.objects.exists())
            HrDailyWork.objects.create(date=AS_OF, status='confirmed', overrides={str(self.employee.id): {'weekday_hours': '2'}})
            second = self.client.get(self.url).json()
            self.assertEqual(second['components']['overtime']['amount'], '2340.00')
            self.assertEqual(second['days']['entered'], 1)
        actual.refresh_from_db()
        self.assertEqual(actual.version, 1)
        self.assertEqual(HrDailyWork.objects.count(), 1)

    def test_visual_departments_keep_identical_leaf_names_under_distinct_parents(self):
        second = HrRosterEmployee.objects.create(
            code='002', name='Test employee 2', employment_type='contract',
            department='加工', first_month='2026-10', last_month='2026-10',
        )
        workspace = self.save_payroll('2026-10', '4580.00', COLUMNS)
        workspace.employees[0]['department_id'] = 'cell-a'
        workspace.employees.append(actual_row(person(), '4580.00') | {
            'code': second.code, 'name': second.name, 'source_department': '加工', 'department_id': 'cell-b',
        })
        workspace.departments = [
            {'id': 'a', 'name': '注塑管理'}, {'id': 'b', 'name': '加工管理'},
            {'id': 'cell-a', 'name': '操作工', 'parent_id': 'a'},
            {'id': 'cell-b', 'name': '操作工', 'parent_id': 'b'},
        ]
        workspace.save()
        self.client.force_authenticate(self.allowed)
        with patch('analytics.hr_views.shanghai_today', return_value=AS_OF):
            groups = self.client.get(self.url).json()['visual_departments']
        self.assertEqual({group['name']: group['headcount'] for group in groups},
                         {'注塑管理 / 操作工': 1, '加工管理 / 操作工': 1})

    def test_shanghai_day_rollover(self):
        with patch('django.utils.timezone.now', return_value=datetime(2026, 11, 11, 16, tzinfo=timezone.utc)):
            self.assertEqual(shanghai_today(), AS_OF)
