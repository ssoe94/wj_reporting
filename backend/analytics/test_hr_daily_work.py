"""Synthetic personnel-event timelines, daily estimates and private API writes."""
from datetime import date
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from . import hr_daily_work
from .hr_labor_rules import default_labor_rules
from .hr_personnel_events import employee_states_at
from .models import (
    HrAccessGrant, HrDailyWork, HrDailyWorkHistory, HrLaborCalendar,
    HrLaborStandard, HrMonthWorkspace, HrPersonnelEvent, HrRosterEmployee,
)


class DailyWorkTests(TestCase):
    def setUp(self):
        self.actor = get_user_model().objects.create_user('synthetic-daily-hr')
        HrAccessGrant.objects.create(user=self.actor, enabled=True)
        self.client = APIClient()
        self.client.force_authenticate(self.actor)
        self.day = '2026-11-12'

    def url(self, day=None, suffix=''):
        return f'/api/analytics/hr/daily-work/{day or self.day}/{suffix}'

    def read(self, day=None):
        response = self.client.get(self.url(day))
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def event(self, kind, day=None, expected=201, **data):
        sheet = self.read(day)
        payload = {'revision': sheet['event_revision'], 'kind': kind, 'reason': 'Synthetic reason', **data}
        response = self.client.post(self.url(day, 'events/'), payload, format='json')
        self.assertEqual(response.status_code, expected, response.data)
        return response.data

    def hire(self, day='2026-11-01', *, code='SYN-A', name='Synthetic A', **fields):
        data = {'code': code, 'name': name, 'department': '注塑', 'title': 'Synthetic operator',
                'employment_type': 'contract', **fields}
        if data['employment_type'] == 'contract':
            data = {'base_salary': '3480.00', 'fixed_overtime': '150.00', **data}
        sheet = self.event('hire', day, changes=data)
        return next(row['employee']['id'] for row in sheet['rows'] if row['employee']['code'] == code)

    def body(self, sheet, employee=None, **work):
        return {'version': sheet['version'], 'context': sheet['context'],
                'rows': [{'employee_id': employee, 'work': work}] if employee else []}

    def preview(self, sheet, employee=None, **work):
        response = self.client.post(self.url(sheet['date'], 'preview/'), self.body(sheet, employee, **work), format='json')
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def row(self, sheet, employee):
        return next(row for row in sheet['rows'] if row['employee']['id'] == employee)

    def test_hire_does_not_count_before_effective_day_even_in_same_month(self):
        employee = self.hire('2026-11-18')
        self.assertTrue(HrRosterEmployee.objects.filter(pk=employee).exists())
        self.assertFalse(employee_states_at(date(2026, 11, 17))[0]['active'])
        self.assertEqual(self.read('2026-11-17')['summary']['headcount'], 0)
        self.assertEqual(self.read('2026-11-18')['summary']['headcount'], 1)
        event = HrPersonnelEvent.objects.get()
        self.assertEqual(event.before, {'active': False})
        self.assertTrue(event.after['active'])
        self.assertEqual((event.actor_id, event.actor_label), (self.actor.pk, self.actor.username))

    def test_transfer_title_and_employment_apply_in_order_and_terminate_is_inclusive(self):
        employee = self.hire()
        self.event('transfer', employee_id=employee, changes={'department': '加工'})
        self.event('title_change', '2026-11-13', employee_id=employee, changes={'title': 'Part長'})
        self.event('employment_change', '2026-11-14', employee_id=employee,
                   changes={'employment_type': 'hourly', 'hourly_rate': '26'})
        self.event('terminate', '2026-11-17', employee_id=employee)
        self.assertEqual(self.row(self.read('2026-11-11'), employee)['employee']['department'], '注塑')
        self.assertEqual(self.row(self.read(), employee)['employee']['department'], '加工')
        self.assertEqual(self.row(self.read('2026-11-13'), employee)['work']['weekday_hours'], '0')
        self.assertEqual(self.read('2026-11-17')['summary']['hourly'], 1)
        self.assertEqual(self.read('2026-11-18')['summary']['headcount'], 0)
        event = HrPersonnelEvent.objects.get(kind='terminate')
        self.assertEqual(event.after['last_work_day'], '2026-11-17')

    def test_cancellation_replays_remaining_changes_and_is_audited(self):
        employee = self.hire()
        moved = self.event('transfer', employee_id=employee, changes={'department': '加工'})
        target = moved['events'][0]['id']
        self.event('title_change', '2026-11-13', employee_id=employee, changes={'title': '部长'})
        result = self.event('cancel', target_id=target)
        self.assertTrue(result['events'][0]['cancelled'])
        self.assertEqual(result['events'][1]['target_id'], target)
        person = self.row(self.read('2026-11-13'), employee)['employee']
        self.assertEqual((person['department'], person['title']), ('注塑', '部长'))
        cancellation = HrPersonnelEvent.objects.get(target_id=target)
        self.assertEqual((cancellation.before['department'], cancellation.after['department']), ('加工', '注塑'))
        self.assertEqual(cancellation.actor_id, self.actor.id)
        self.event('cancel', target_id=target, expected=409)

    def test_cancelling_hire_with_dependent_event_rolls_back_and_clean_hire_can_be_corrected(self):
        employee = self.hire()
        hire_id = HrPersonnelEvent.objects.get().pk
        moved = self.event('transfer', employee_id=employee, changes={'department': '加工'})
        self.event('cancel', '2026-11-01', target_id=hire_id, expected=409)
        self.assertEqual(HrPersonnelEvent.objects.count(), 2)
        self.event('cancel', target_id=moved['events'][0]['id'])
        self.event('cancel', '2026-11-01', target_id=hire_id)
        self.assertEqual(self.read()['summary']['headcount'], 0)
        self.assertEqual(self.hire('2026-11-14'), employee)
        self.assertEqual(self.read()['summary']['headcount'], 0)

    def test_imported_roster_uses_effective_payroll_department_title_and_no_future_row(self):
        employee = HrRosterEmployee.objects.create(code='SYN-R', name='Synthetic roster', employment_type='contract',
            department='模具', first_month='2026-10', last_month='2026-12')
        for month, department, title in [('2026-10', '加工', 'Synthetic operator'), ('2026-12', '模具', 'Part長')]:
            HrMonthWorkspace.objects.create(month=month, employees=[{
                'code': employee.code, 'name': employee.name, 'employment_type': 'contract',
                'source_department': department, 'title': title, 'payroll_components': {'base_salary': '3480'},
            }])
        row = self.row(self.read(), employee.pk)
        self.assertEqual(row['employee']['department'], '加工')
        self.assertEqual(row['work']['weekday_hours'], '2.5')
        self.assertEqual(row['estimate']['amount'], '75.00')
        self.assertEqual(row['estimate']['basis']['payroll_source_month'], '2026-10')

    def test_defaults_missing_exempt_rest_holiday_and_adjusted(self):
        employee = self.hire()
        exempt = self.hire(code='SYN-B', name='Synthetic B', title='Part長', department='管理部')
        unknown = self.hire(code='SYN-C', name='Synthetic C', department='管理部')
        HrLaborCalendar.objects.create(month='2026-11', days={
            '2026-11-14': 'adjusted_workday', '2026-11-16': 'public_holiday'})
        regular = self.read()
        self.assertEqual(self.row(regular, employee)['work']['weekday_hours'], '4')
        self.assertEqual(self.row(regular, exempt)['work']['weekday_hours'], '0')
        self.assertIsNone(self.row(regular, unknown)['work']['weekday_hours'])
        self.assertEqual(regular['summary']['status'], 'partial_missing')
        self.assertTrue(regular['summary']['overtime_partial'])
        self.assertEqual(regular['summary']['known_amount'], '120.00')
        self.assertEqual(self.read('2026-11-14')['day_type'], 'adjusted_workday')
        for value, kind in [('2026-11-15', 'rest_day'), ('2026-11-16', 'public_holiday')]:
            sheet = self.read(value)
            self.assertEqual(sheet['day_type'], kind)
            self.assertEqual(self.row(sheet, employee)['work']['attendance'], 'off')
            self.assertEqual(sheet['summary']['amount'], '0.00')
        self.assertFalse(HrDailyWork.objects.exists())

    def test_contract_overtime_only_and_holiday_multipliers(self):
        employee = self.hire()
        HrLaborCalendar.objects.create(month='2026-11', days={'2026-11-16': 'public_holiday'})
        for day, field, expected in [
            (self.day, 'weekday_hours', '60.00'),
            ('2026-11-15', 'rest_hours', '80.00'),
            ('2026-11-16', 'holiday_hours', '120.00'),
        ]:
            with self.subTest(day=day):
                sheet = self.preview(self.read(day), employee, attendance='present', **{field: '2'})
                row = self.row(sheet, employee)
                self.assertEqual(row['estimate']['amount'], expected)
                self.assertEqual(row['estimate']['basis']['components'][field]['amount'], expected)
                self.assertEqual(sheet['departments'][0]['amount'], expected)
        self.assertFalse(HrDailyWork.objects.exists())

    def test_hourly_exception_and_regular_weekday_rest_pay(self):
        employee = self.hire(employment_type='hourly', hourly_rate='30')
        weekday = self.preview(self.read(), employee, regular_hours='8', weekday_hours='2')
        row = self.row(weekday, employee)
        self.assertEqual(row['estimate']['amount'], '330.00')
        self.assertEqual(row['estimate']['basis']['hourly_rate']['unit_rate'], '30.00')
        rest = self.preview(self.read('2026-11-15'), employee, attendance='present', rest_hours='2')
        self.assertEqual(rest['summary']['amount'], '120.00')
        rules = default_labor_rules()
        rules['hourly_rates']['employee_overrides'] = [{
            'employee_id': employee, 'effective_month': '2026-12', 'amount': '35', 'reason': 'Synthetic rule'}]
        HrLaborStandard.objects.create(month='2026-11', rules=rules)
        updated = self.preview(self.read('2026-12-01'), employee, regular_hours='8', weekday_hours='2')
        self.assertEqual(updated['summary']['amount'], '385.00')

    def test_unconfirmed_hourly_and_leave_do_not_become_complete_zero(self):
        employee = self.hire(employment_type='hourly')
        self.assertIsNone(self.read()['summary']['amount'])
        for attendance, field in [('personal_leave', 'personal_leave_hours'), ('sick_leave', 'sick_leave_hours')]:
            preview = self.preview(self.read(), employee, attendance=attendance, **{field: '3.5'})
            row = self.row(preview, employee)
            self.assertEqual(row['work'][field], '3.5')
            self.assertEqual(row['estimate']['deduction_status'], 'unconfirmed')
            self.assertIsNone(row['estimate']['amount'])
            self.assertEqual(preview['summary']['leave'], 1)

    def test_preview_and_save_same_calculation_and_sparse_history(self):
        employee = self.hire()
        sheet = self.read()
        inputs = {'weekday_hours': '2', 'rest_hours': '6'}
        preview = self.preview(sheet, employee, **inputs)
        self.assertFalse(HrDailyWork.objects.exists())
        draft = self.client.put(self.url(), self.body(sheet, employee, **inputs) | {'status': 'draft'}, format='json')
        self.assertEqual(draft.status_code, 200, draft.data)
        self.assertEqual(draft.data['summary'], preview['summary'])
        self.assertEqual(draft.data['rows'], preview['rows'])
        record = HrDailyWork.objects.get()
        self.assertEqual(record.overrides, {str(employee): {'weekday_hours': '2'}})
        self.assertEqual(draft.data['rows'][0]['modified'], ['weekday_hours'])
        confirmed = self.client.put(self.url(), self.body(draft.data, employee, weekday_hours='2') |
                                    {'status': 'confirmed', 'reason': 'Synthetic check'}, format='json')
        self.assertEqual(confirmed.status_code, 200, confirmed.data)
        self.assertEqual((confirmed.data['version'], confirmed.data['status']), (2, 'confirmed'))
        history = HrDailyWorkHistory.objects.get(version=2)
        self.assertEqual((history.actor_id, history.reason), (self.actor.id, 'Synthetic check'))
        self.assertEqual((history.before['status'], history.after['status']), ('draft', 'confirmed'))
        self.assertEqual(self.read()['days'][11]['status'], 'confirmed')

    def test_conflicts_for_stale_version_context_and_event_revision(self):
        employee = self.hire()
        sheet = self.read()
        request = self.body(sheet, employee, weekday_hours='2')
        self.event('transfer', employee_id=employee, changes={'department': '加工'})
        response = self.client.post(self.url(suffix='preview/'), request, format='json')
        self.assertEqual(response.status_code, 409)
        self.assertIn('no-store', response['Cache-Control'])
        response = self.client.post(self.url(suffix='events/'), {
            'revision': sheet['event_revision'], 'kind': 'terminate', 'employee_id': employee,
            'reason': 'Synthetic stale event'}, format='json')
        self.assertEqual(response.status_code, 409)
        current = self.read()
        request = self.body(current, employee, weekday_hours='1') | {'status': 'draft'}
        self.assertEqual(self.client.put(self.url(), request, format='json').status_code, 200)
        self.assertEqual(self.client.put(self.url(), request, format='json').status_code, 409)
        self.assertEqual(HrDailyWorkHistory.objects.count(), 1)

    def test_permissions_no_store_and_central_edit_gate(self):
        denied = get_user_model().objects.create_user('synthetic-non-hr', is_staff=True)
        self.client.force_authenticate(denied)
        for method, url in [('get', self.url()), ('put', self.url()), ('post', self.url(suffix='preview/')),
                            ('post', self.url(suffix='events/'))]:
            response = getattr(self.client, method)(url)
            self.assertEqual(response.status_code, 403)
            self.assertTrue({'private', 'no-store'} <= set(response['Cache-Control'].split(', ')))
        self.client.force_authenticate(self.actor)
        with patch('analytics.hr_permissions.can_edit_hr_labor', return_value=False):
            sheet = self.read()
            self.assertFalse(sheet['can_edit'])
            self.assertFalse(self.preview(sheet)['can_edit'])
            self.assertEqual(self.client.put(self.url(), {}, format='json').status_code, 403)
            self.assertEqual(self.client.post(self.url(suffix='events/'), {}, format='json').status_code, 403)
        self.assertTrue({'private', 'no-store'} <= set(self.client.get(self.url())['Cache-Control'].split(', ')))

    def test_validation_rejects_bad_date_oversized_day_and_unaudited_actions(self):
        employee = self.hire(employment_type='hourly', hourly_rate='25')
        sheet = self.read()
        too_long = self.body(sheet, employee, regular_hours='23', weekday_hours='2')
        self.assertEqual(self.client.post(self.url(suffix='preview/'), too_long, format='json').status_code, 400)
        self.assertEqual(self.client.get(self.url('2026-02-30')).status_code, 400)
        self.assertEqual(self.client.put(self.url(), self.body(sheet) | {'status': 'confirmed', 'reason': '  '},
                                         format='json').status_code, 400)
        self.assertEqual(self.client.post(self.url(suffix='events/'), {
            'revision': sheet['event_revision'], 'kind': 'terminate', 'employee_id': employee, 'reason': '',
        }, format='json').status_code, 400)
        self.assertEqual(self.client.delete(self.url(suffix='events/')).status_code, 405)
        self.assertEqual(self.client.delete(self.url()).status_code, 405)
        self.assertFalse(HrDailyWork.objects.exists())

    def test_normalized_duplicate_code_is_rejected_without_extra_employee(self):
        self.hire(code='000905')
        self.event('hire', expected=409, changes={'code': '905', 'name': 'Synthetic duplicate',
            'department': '注塑', 'title': 'Synthetic operator', 'employment_type': 'hourly'})
        self.assertEqual(HrRosterEmployee.objects.count(), 1)

    def test_audit_error_rolls_back_sheet_and_hire(self):
        sheet = self.read()
        with patch.object(HrDailyWorkHistory.objects, 'create', side_effect=RuntimeError('synthetic')):
            response = self.client.put(self.url(), self.body(sheet) | {'status': 'draft'}, format='json')
        self.assertEqual(response.status_code, 500)
        self.assertFalse(HrDailyWork.objects.exists())
        with patch.object(HrPersonnelEvent.objects, 'create', side_effect=RuntimeError('synthetic')):
            response = self.client.post(self.url(suffix='events/'), {
                'revision': 0, 'kind': 'hire', 'reason': 'Synthetic rollback',
                'changes': {'code': 'SYN-A', 'name': 'Synthetic A', 'department': '注塑',
                            'title': 'Synthetic operator', 'employment_type': 'hourly'},
            }, format='json')
        self.assertEqual(response.status_code, 500)
        self.assertFalse(HrRosterEmployee.objects.exists())

    def test_save_lock_order_precedes_context_read(self):
        sheet = self.read()
        calls = Mock()
        with (patch('analytics.hr_daily_work.lock_roster', calls.roster),
              patch('analytics.hr_daily_work.lock_labor', calls.labor),
              patch.object(hr_daily_work, '_context', wraps=hr_daily_work._context) as context):
            calls.attach_mock(context, 'context')
            response = self.client.put(self.url(), self.body(sheet) | {'status': 'draft'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([call[0] for call in calls.mock_calls], ['roster', 'labor', 'labor', 'context'])
        self.assertEqual([calls.mock_calls[index].args for index in (1, 2)], [('standard',), ('calendar',)])
