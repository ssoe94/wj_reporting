"""Dashboard integration checks using only synthetic, disposable HR data."""
from datetime import date
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .hr_labor_rules import default_labor_rules
from .models import (
    HrAccessGrant, HrDailyWork, HrLaborActualPayment, HrLaborCalendar, HrLaborStandard,
    HrMonthWorkspace, HrPersonnelEvent, HrRosterCodeHistory, HrRosterEmployee, HrWorkspaceHistory,
)


TODAY = date(2026, 11, 12)
ROOT = {'id': 'team', 'name': 'Synthetic team', 'parent_id': None}
PART = {'id': 'part', 'name': 'Synthetic part', 'parent_id': 'team'}
BASE = '/api/analytics/hr/dashboard/'


def payroll_row(code, name, *, kind=None, amount='1000.00', dept='part', title='', components=None):
    row = {'code': code, 'name': name, 'title': title, 'amount': amount,
           'source_department': 'Synthetic source', 'department_id': dept}
    if kind:
        row['employment_type'] = kind
    if components is not None:
        row['payroll_components'] = components
    return row


def components(weekday='0', rest='0', holiday='0', **patch):
    return {'base_salary': '3480', 'fixed_overtime': '20',
            'weekday_overtime': weekday, 'weekend_overtime': rest, 'holiday_overtime': holiday,
            'personal_leave': '5', 'sick_leave': '0', 'absence': '0'} | patch


class HrDashboardTests(TestCase):
    def setUp(self):
        self.actor = get_user_model().objects.create_user('synthetic-dashboard-hr')
        self.denied = get_user_model().objects.create_user('synthetic-dashboard-denied', is_staff=True)
        HrAccessGrant.objects.create(user=self.actor, enabled=True)
        self.client = APIClient()
        self.client.force_authenticate(self.actor)
        clock = patch('analytics.hr_views.shanghai_today', return_value=TODAY)
        clock.start()
        self.addCleanup(clock.stop)

    def snapshot(self, month, rows, *, departments=None, **overrides):
        return HrMonthWorkspace.objects.create(**({
            'month': month, 'employees': rows, 'departments': [ROOT, PART] if departments is None else departments,
            'currency': 'CNY', 'cost_basis': 'gross_salary', 'source': {'filename': f'synthetic-{month}.xlsx'},
            'version': 4,
        } | overrides))

    def roster(self, code, name, kind):
        return HrRosterEmployee.objects.create(code=code, name=name, employment_type=kind,
                                               first_month='2026-07', last_month='2026-10')

    def read(self, month='2026-11'):
        response = self.client.get(f'{BASE}{month}/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assert_private(response)
        return response.data

    def assert_private(self, response):
        self.assertLessEqual({'private', 'no-store'}, set(response['Cache-Control'].split(', ')))

    def test_authorization_and_no_mutation_methods(self):
        self.client.force_authenticate(self.denied)
        response = self.client.get(f'{BASE}2026-11/')
        self.assertEqual(response.status_code, 403)
        self.assert_private(response)
        self.client.force_authenticate(self.actor)
        self.assertEqual(self.client.post(f'{BASE}2026-11/', {}, format='json').status_code, 405)
        self.assertEqual(self.client.get(f'{BASE}2026-13/').status_code, 400)

    def test_production_day_one_legacy_payroll_and_empty_new_tables(self):
        one = payroll_row('SYN-A', 'Synthetic Alpha', title='部\n长', amount='3200.00')
        two = payroll_row('SYN-B', 'Synthetic Beta', amount='800.25', dept=None)
        self.assertEqual(set(one), {'code', 'name', 'title', 'amount', 'source_department', 'department_id'})
        self.snapshot('2026-09', [one])
        stored = self.snapshot('2026-10', [one, two])
        result = self.read()
        self.assertEqual(result, self.read())
        self.assertEqual(result['today'], TODAY.isoformat())
        source = result['source']
        self.assertEqual((source['month'], source['version'], source['filename'], source['row_count']),
                         ('2026-10', 4, 'synthetic-2026-10.xlsx', 2))
        self.assertEqual(result['headcount']['total']['value'], 2)
        self.assertEqual(result['headcount']['unknown']['value'], 2)
        self.assertIsNone(result['headcount']['hourly']['value'])
        self.assertEqual(result['movements']['hires']['total']['value'], 1)
        self.assertIsNone(result['movements']['transfers']['total']['value'])
        self.assertEqual(result['cost']['actual']['gross']['value'], '4000.25')
        self.assertEqual(result['cost']['actual']['total']['status'], 'partial')
        self.assertIsNone(result['cost']['actual']['overtime']['value'])
        self.assertIsNone(result['load']['contract_average']['value'])
        self.assertIsNone(result['cost']['forecast']['total']['value'])
        self.assertEqual(result['load']['entered']['missing_days']['value'], 11)
        self.assertIsNone(result['load']['entered']['weekday']['value'])
        self.assertEqual(len(result['organization']['nodes']), 3)
        notices = {(item['code'], item['month']): item for item in result['needs']}
        self.assertIn(('reupload_components', '2026-10'), notices)
        self.assertIn(('roster_empty', '2026-10'), notices)
        self.assertIn(('employment_unknown', '2026-10'), notices)
        self.assertEqual(notices['hourly_rate_unconfirmed', '2026-11']['metric']['value'], '24.50')
        for model in (HrRosterEmployee, HrRosterCodeHistory, HrPersonnelEvent, HrDailyWork, HrLaborStandard,
                      HrLaborActualPayment, HrLaborCalendar, HrWorkspaceHistory):
            self.assertFalse(model.objects.exists(), model.__name__)
        stored.refresh_from_db()
        self.assertEqual(stored.employees, [one, two])

    def test_latest_eligible_upload_and_empty_month(self):
        row = payroll_row('SYN-A', 'Synthetic Alpha')
        self.snapshot('2026-07', [row])
        self.snapshot('2026-08', [row], currency='USD')
        self.snapshot('2026-09', [row], cost_basis='employer_total')
        self.snapshot('2026-10', [], source=None)
        self.snapshot('2026-12', [row])
        self.assertEqual(self.read()['source']['month'], '2026-07')
        self.assertEqual(self.read('2026-12')['source']['month'], '2026-12')
        missing = self.read('2026-06')
        self.assertIsNone(missing['source'])
        self.assertIsNone(missing['headcount']['total']['value'])
        self.assertEqual(missing['organization'], {'nodes': [], 'people': []})
        self.assertIsNone(missing['movements']['hires']['total']['value'])

    def test_movement_consecutive_months_confirmed_alias_and_tenure(self):
        old = payroll_row('0007', 'Synth etic A', kind='contract', components=components())
        active_hourly = payroll_row('SYN-X', 'Synthetic X', kind='hourly')
        former_hourly = payroll_row('SYN-Y', 'Synthetic Y', kind='hourly')
        for month in ('2026-07', '2026-08'):
            self.snapshot(month, [old, active_hourly, former_hourly])
        self.snapshot('2026-09', [old, active_hourly])
        renamed = payroll_row('90007', 'Synthetic A', kind='hourly')
        new = payroll_row('SYN-B', 'Synthetic B', kind='contract', components=components(), dept='team')
        unassigned = payroll_row('SYN-C', 'Synthetic C', kind='contract', components=components(), dept=None)
        self.snapshot('2026-10', [renamed, new, unassigned])
        roster = self.roster('90007', 'Synthetic A', 'hourly')
        HrRosterCodeHistory.objects.create(employee=roster, previous_code='7', new_code='90007',
            previous_status='active', new_status='active', previous_employment_type='contract',
            new_employment_type='hourly', reason='Synthetic alias approval')

        data = self.read()
        self.assertEqual([data['movements'][key]['total']['value'] for key in ('hires', 'exits', 'transfers')], [2, 1, 1])
        self.assertEqual(data['movements']['transfers']['hourly']['value'], 1)
        self.assertEqual(data['turnover']['hourly']['value'], '150.00')
        self.assertEqual(data['turnover']['contract']['value'], '0.00')
        self.assertEqual(data['turnover']['hourly']['basis']['months'], ['2026-08', '2026-09', '2026-10'])
        person = data['organization']['people'][0]
        self.assertEqual(person['tenure']['value'], 4)
        self.assertTrue(person['tenure']['basis']['lower_bound'])
        self.assertEqual(person['trend'][-2]['payroll']['value'], '1000.00')
        self.assertIsNone(person['trend'][-2]['load']['value'], 'Different employment measurements cannot be joined.')
        self.assertIsNone(data['trends'][2]['movements']['hires']['total']['value'], 'July has no consecutive June upload.')

    def test_load_tree_cost_reference_and_insight_priority(self):
        employee = self.roster('SYN-H', 'Synthetic hourly', 'hourly')
        rules = default_labor_rules()
        rules['hourly_rates']['employee_overrides'] = [{
            'employee_id': employee.pk, 'effective_month': '2026-10', 'amount': '40', 'reason': 'Synthetic exception',
        }]
        HrLaborStandard.objects.create(month='2026-10', rules=rules)
        for month in ('2026-07', '2026-08', '2026-09'):
            self.snapshot(month, [payroll_row('SYN-Q', 'Synthetic former hourly', kind='hourly')])
        leader = payroll_row('SYN-A', 'Synthetic contract A', kind='contract', amount='5300.00', title='部\n　长',
                             components=components('900', '400', '120'))
        boundary = payroll_row('SYN-B', 'Synthetic contract B', kind='contract', title='Part長', amount='5000',
                               components=components('1080'), dept='team')
        near = payroll_row('SYN-C', 'Synthetic contract C', kind='contract', amount='5000',
                           components=components('1080.01'), dept='part')
        hourly = payroll_row('SYN-H', 'Synthetic hourly', kind='hourly', amount='7600', dept='part')
        missing = payroll_row('SYN-M', 'Synthetic incomplete', kind='contract', dept=None,
                              components=components(absence=None))
        self.snapshot('2026-10', [leader, boundary, near, hourly, missing])
        HrLaborActualPayment.objects.create(month='2026-10', payment={'amounts': {
            'social_insurance': {'total': '30.01'}, 'housing_fund': {'total': '10.02'},
        }})
        data = self.read()
        people = {row['code']: row for row in data['organization']['people']}
        nodes = {node['id']: node for node in data['organization']['nodes']}
        self.assertEqual(nodes['team']['direct']['contract']['value'], 1)
        self.assertEqual(nodes['team']['inclusive']['contract']['value'], 3)
        self.assertEqual(nodes['part']['inclusive']['hourly']['value'], 1)
        self.assertEqual(nodes['part']['leaders'], [people['SYN-A']['key']])
        self.assertEqual(nodes['team']['leaders'], [people['SYN-A']['key']])
        self.assertEqual(people['SYN-A']['path'], ['Synthetic team', 'Synthetic part'])
        self.assertTrue(nodes[people['SYN-M']['node_id']]['unassigned'])
        self.assertEqual([people['SYN-A']['load'][slot]['value'] for slot in ('weekday', 'rest', 'holiday', 'total')],
                         ['30.00', '10.00', '2.00', '42.00'])
        self.assertEqual(people['SYN-B']['load']['total']['value'], '36.00')
        self.assertFalse(people['SYN-B']['load']['total']['basis']['above_reference'])
        self.assertEqual(people['SYN-C']['load']['total']['value'], '36.00')
        self.assertTrue(people['SYN-C']['load']['total']['basis']['above_reference'])
        self.assertIsNone(people['SYN-M']['load']['total']['value'])
        self.assertEqual(people['SYN-M']['load']['total']['basis']['reason'], 'reupload_components')
        self.assertEqual([people['SYN-H']['load'][key]['value'] for key in ('rate', 'worked', 'excess')],
                         ['40.00', '190.00', '16.00'])
        self.assertEqual(data['load']['rankings']['contract'], [people[code]['key'] for code in ('SYN-A', 'SYN-C', 'SYN-B')])
        self.assertEqual(data['load']['above_reference']['value'], 2)
        self.assertEqual(data['load']['above_reference']['status'], 'partial')
        self.assertEqual(nodes['part']['load']['rest_worker_ratio']['value'], '50.00')
        self.assertEqual(data['cost']['actual']['total']['value'], '23940.03')
        self.assertEqual(data['cost']['actual']['fixed']['value'], '11734.99')
        self.assertEqual(data['cost']['actual']['overtime']['value'], '3580.01')
        self.assertEqual(data['cost']['actual']['hourly']['value'], '7600.00')
        self.assertIsNone(data['trends'][-1]['overtime_share']['value'])
        self.assertEqual([item['code'] for item in data['insights']],
                         ['department_change', 'hourly_turnover', 'highest_load', 'above_reference', 'unassigned'])
        self.assertLessEqual(len(data['insights']), 8)
        self.assertTrue(all({'month', 'formula', 'estimated'} <= set(item['metric']['basis']) for item in data['insights']))

    def test_entered_hours_include_only_saved_overrides_and_past_missing_days(self):
        HrLaborCalendar.objects.create(month='2026-11', days={'2026-11-12': 'public_holiday'})
        self.snapshot('2026-10', [payroll_row('SYN-A', 'Synthetic Alpha')])
        for day, status, values in (
            (8, 'confirmed', {'rest_hours': '2.5'}),
            (10, 'draft', {'weekday_hours': '1.25'}),
            (11, 'estimated', {'weekday_hours': '23'}),
            (12, 'confirmed', {'holiday_hours': '3'}),
            (13, 'confirmed', {'weekday_hours': '22'}),
        ):
            HrDailyWork.objects.create(date=date(2026, 11, day), status=status, overrides={'1': values})
        data = self.read()['load']['entered']
        self.assertEqual({key: item['value'] for key, item in data.items()},
                         {'days': 3, 'missing_days': 9, 'weekday': '1.25', 'rest': '2.50', 'holiday': '3.00'})
