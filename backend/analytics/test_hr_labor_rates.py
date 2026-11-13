"""Synthetic rate/actual-payment persistence and payroll-source integration."""
from copy import deepcopy
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .hr_labor_rules import default_labor_rules
from .hr_labor_service import latest_payroll, estimate_employee_day
from .models import (HrAccessGrant, HrLaborActualPayment, HrLaborActualPaymentHistory,
                     HrRosterEmployee, HrRosterCodeHistory, HrMonthWorkspace, HrLaborStandard)


class LaborRatesApiTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user('synthetic-rates-editor')
        self.grant = HrAccessGrant.objects.create(user=self.user, enabled=True)
        self.staff = User.objects.create_user('synthetic-rates-staff', is_staff=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = '/api/analytics/hr/labor-actual-payments/2026-11/'
        self.standard = '/api/analytics/hr/labor-standards/2026-11/'
        self.employee = HrRosterEmployee.objects.create(code='SYN-A', name='Synthetic A', employment_type='contract',
            first_month='2026-01', last_month='2026-10')

    def payment(self, version=0):
        return {'version': version, 'reason': 'Synthetic invoice approval', 'amounts': {
            'social_insurance': {'total': '600.03', 'contract': '500.02', 'hourly': '100.01'},
            'housing_fund': {'total': '300.00', 'contract': None, 'hourly': None}}, 'evidence_memo': 'SYN-invoice-01.txt'}

    def put_rules(self, rules):
        return self.client.put(self.standard, {'version': 0, 'reason': 'Synthetic rate review', 'rules': rules}, format='json')

    def test_get_is_read_only_actual_and_missing_not_zero(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['measurement'], 'actual')
        self.assertEqual(response.data['version'], 0)
        self.assertIsNone(response.data['amounts']['social_insurance']['total'])
        self.assertFalse(HrLaborActualPayment.objects.exists())
        self.assertTrue({'private', 'no-store'} <= set(response['Cache-Control'].split(', ')))

    def test_actual_permission_denied_inactive_and_revoked(self):
        for user in (self.staff, self.user):
            if user == self.user:
                self.grant.enabled = False
                self.grant.save()
            self.client.force_authenticate(user)
            for response in (self.client.get(self.url), self.client.put(self.url, self.payment(), format='json')):
                self.assertEqual(response.status_code, 403)
                self.assertTrue({'private', 'no-store'} <= set(response['Cache-Control'].split(', ')))
        self.user.is_superuser = True
        self.user.is_active = False
        self.user.save()
        self.assertEqual(self.client.put(self.url, self.payment(), format='json').status_code, 403)
        self.assertFalse(HrLaborActualPayment.objects.exists())

    def test_central_edit_permission_is_used_by_all_labor_writers(self):
        with patch('analytics.hr_permissions.can_edit_hr_labor', return_value=False) as guard:
            self.assertEqual(self.client.get(self.url).status_code, 200)
            for url, data in ((self.url, self.payment()), (self.standard, {}),
                              ('/api/analytics/hr/labor-calendar/2026-11/', {})):
                self.assertEqual(self.client.put(url, data, format='json').status_code, 403)
            self.assertEqual(guard.call_count, 3)

    def test_actual_versions_reason_server_actor_history_and_noop(self):
        first = self.client.put(self.url, self.payment(), format='json')
        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(first.data['measurement'], 'actual')
        self.assertEqual(first.data['version'], 1)
        changed = self.payment(1)
        changed['evidence_memo'] = 'SYN-invoice-correction.txt'
        changed['reason'] = 'Synthetic corrected evidence'
        result = self.client.put(self.url, changed, format='json')
        self.assertEqual(result.status_code, 200, result.data)
        audit = HrLaborActualPaymentHistory.objects.get(version=2)
        self.assertEqual(audit.before['evidence_memo'], 'SYN-invoice-01.txt')
        self.assertEqual(audit.after['evidence_memo'], changed['evidence_memo'])
        self.assertEqual((audit.actor_id, audit.actor_label, audit.reason), (self.user.pk, self.user.username, changed['reason']))
        self.assertEqual([row['version'] for row in result.data['history']], [2, 1])
        self.assertTrue({'private', 'no-store'} <= set(result['Cache-Control'].split(', ')))
        self.assertEqual(self.client.put(self.url, changed, format='json').status_code, 409)
        self.assertEqual(self.client.put(self.url, changed | {'version': 2}, format='json').data['version'], 2)
        self.assertEqual(HrLaborActualPaymentHistory.objects.count(), 2)

    def test_actual_required_reason_no_spoofed_actor_delete_or_wrong_month(self):
        for field in ('version', 'reason'):
            payload = self.payment()
            payload.pop(field)
            self.assertEqual(self.client.put(self.url, payload, format='json').status_code, 400)
        for change in ({'reason': '  '}, {'actor': 18}, {'created_at': '2026-01-01'}, {'measurement': 'estimate'}, {'evidence_memo': '  '}):
            self.assertEqual(self.client.put(self.url, self.payment() | change, format='json').status_code, 400)
        self.assertEqual(self.client.delete(self.url).status_code, 405)
        self.assertEqual(self.client.get(self.url.replace('2026-11', '2026-13')).status_code, 400)
        self.assertFalse(HrLaborActualPayment.objects.exists())

    def test_actual_breakdown_zero_null_and_derived_complete_total(self):
        payload = self.payment()
        payload['amounts']['social_insurance']['total'] = None
        payload['amounts']['housing_fund'] = {'total': '0', 'contract': None, 'hourly': None}
        result = self.client.put(self.url, payload, format='json')
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data['amounts']['social_insurance']['total'], '600.03')
        self.assertEqual(result.data['amounts']['housing_fund']['total'], '0')
        self.assertIsNone(result.data['amounts']['housing_fund']['hourly'])

    def test_actual_partial_breakdown_not_invented_and_invalid_totals_rejected(self):
        for amounts in ({'total': '100', 'contract': '101', 'hourly': None},
                        {'total': '100', 'contract': '20', 'hourly': '30'},
                        {'total': '1.001', 'contract': None, 'hourly': None},
                        {'total': -1, 'contract': None, 'hourly': None},
                        {'total': 1.5, 'contract': None, 'hourly': None},
                        {'total': None, 'contract': '999999999.99', 'hourly': '1'}):
            payload = self.payment()
            payload['amounts']['housing_fund'] = amounts
            self.assertEqual(self.client.put(self.url, payload, format='json').status_code, 400)
        payload = self.payment()
        payload['amounts']['housing_fund'] = {'total': None, 'contract': '100', 'hourly': None}
        result = self.client.put(self.url, payload, format='json')
        self.assertEqual(result.status_code, 200, result.data)
        self.assertIsNone(result.data['amounts']['housing_fund']['total'])

    def test_actual_audit_failure_rolls_back_both_create_and_update(self):
        with patch.object(HrLaborActualPaymentHistory.objects, 'create', side_effect=RuntimeError('Synthetic failure')):
            self.assertEqual(self.client.put(self.url, self.payment(), format='json').status_code, 500)
        self.assertFalse(HrLaborActualPayment.objects.exists())
        self.client.put(self.url, self.payment(), format='json')
        with patch.object(HrLaborActualPaymentHistory.objects, 'create', side_effect=RuntimeError('Synthetic failure')):
            self.assertEqual(self.client.put(self.url, self.payment(1) | {'evidence_memo': 'Synthetic update'}, format='json').status_code, 500)
        self.assertEqual(HrLaborActualPayment.objects.get().version, 1)
        self.assertEqual(HrLaborActualPaymentHistory.objects.count(), 1)

    def test_hourly_overrides_and_employee_bases_reference_roster_and_keep_period_reason(self):
        rules = default_labor_rules()
        rules['hourly_rates']['employee_overrides'] = [{'employee_id': self.employee.pk, 'effective_month': '2026-12', 'amount': '28.50', 'reason': 'Synthetic exception'}]
        rules['contributions']['social_insurance']['base'].update(rule='employee', employee_amounts={str(self.employee.pk): '4000'})
        result = self.put_rules(rules)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data['rules']['hourly_rates']['employee_overrides'], [rules['hourly_rates']['employee_overrides'][0] | {'amount': '28.5'}])

    def test_reject_invalid_exception_identity_dates_duplicate_or_blank_reason(self):
        entry = {'employee_id': self.employee.pk, 'effective_month': '2026-11', 'amount': '28', 'reason': 'Synthetic exception'}
        for overrides in ([entry, entry], [entry | {'employee_id': 999999}], [entry | {'effective_month': '2026-13'}],
                          [entry | {'employee_id': True}], [entry | {'employee_id': 10 ** 50}], [entry | {'reason': ' '}], [entry | {'amount': '-1'}]):
            rules = default_labor_rules()
            rules['hourly_rates']['employee_overrides'] = overrides
            self.assertEqual(self.put_rules(rules).status_code, 400)
        rules = default_labor_rules()
        rules['contributions']['social_insurance']['base']['employee_amounts'] = {'999999': '100'}
        self.assertEqual(self.put_rules(rules).status_code, 400)

    def test_rates_accept_maternity_zero_and_null_but_reject_invalid_bounds_types(self):
        rules = default_labor_rules()
        config = rules['contributions']['social_insurance']
        config['items']['maternity'] = {'employer_rate': '0', 'employee_rate': '0'}
        for changes in ({'lower': '100', 'upper': '99'}, {'rule': 'invented'}, {'lower': '-1'}, {'upper': 1.5}):
            invalid = deepcopy(rules)
            invalid['contributions']['social_insurance']['base'].update(changes)
            self.assertEqual(self.put_rules(invalid).status_code, 400)
        invalid = deepcopy(rules)
        invalid['contributions']['social_insurance']['applies_to']['contract'] = 'false'
        self.assertEqual(self.put_rules(invalid).status_code, 400)
        result = self.put_rules(rules)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data['rules']['contributions']['social_insurance']['items']['maternity']['employer_rate'], '0')
        self.assertIsNone(result.data['rules']['contributions']['social_insurance']['items']['medical']['employer_rate'])


class PayrollCarryForwardTests(TestCase):
    def setUp(self):
        self.employee = HrRosterEmployee.objects.create(code='SYN-NEW', name='Synthetic Person', employment_type='contract',
            department='注塑', first_month='2026-01', last_month='2026-10')
        HrRosterCodeHistory.objects.create(employee=self.employee, previous_code='SYN-OLD', new_code='SYN-NEW',
            previous_status='active', new_status='active', previous_employment_type='contract', new_employment_type='contract',
            reason='Synthetic alias', actor_label='Synthetic reviewer')
        self.row = {'code': 'SYN-OLD', 'name': self.employee.name, 'employment_type': 'contract', 'source_department': '注塑',
            'title': 'Part長', 'amount': '5000', 'payroll_components': {'base_salary': '3000', 'fixed_overtime': '250'},
            'source_file': 'SYN-payroll.xlsx', 'source_sheet': 'SYN', 'source_row': 4}
        HrMonthWorkspace.objects.create(month='2026-10', employees=[self.row])

    def test_latest_alias_source_and_monthly_fixed_are_separate_from_daily_actual(self):
        source = latest_payroll(self.employee, '2026-11')
        self.assertEqual(source['fixed_overtime'], '250')
        self.assertEqual(source['month'], '2026-10')
        result = estimate_employee_day(self.employee, '2026-11-12')
        self.assertEqual(result['overtime']['weekday']['amount'], 0)
        self.assertEqual(result['overtime']['fixed']['amount'], 250)
        self.assertEqual(result['overtime']['fixed']['period'], 'month')
        self.assertTrue(result['overtime']['fixed']['carried_forward'])
        self.assertEqual(result['overtime']['fixed']['source_month'], '2026-10')
        self.assertEqual(result['basis']['payroll_source']['workspace_version'], 1)
        self.assertEqual(result['basis']['payroll_source']['source']['source_row'], 4)
        self.assertFalse(HrLaborStandard.objects.exists())

    def test_latest_missing_component_does_not_reuse_older_or_future_amount(self):
        missing = self.row | {'payroll_components': {'base_salary': '3100', 'fixed_overtime': None}}
        HrMonthWorkspace.objects.create(month='2026-11', employees=[missing])
        HrMonthWorkspace.objects.create(month='2026-12', employees=[self.row])
        result = estimate_employee_day(self.employee, '2026-11-12')
        self.assertIsNone(result['overtime']['fixed']['amount'])
        self.assertEqual(result['overtime']['fixed']['source_month'], '2026-11')
        self.assertFalse(result['overtime']['fixed']['carried_forward'])
        self.assertIsNone(latest_payroll(self.employee, '2025-12'))

    def test_name_only_or_ambiguous_alias_rows_cannot_supply_payroll(self):
        workspace = HrMonthWorkspace.objects.get()
        workspace.employees = [self.row | {'code': 'SYN-OTHER'}]
        workspace.save()
        self.assertIsNone(latest_payroll(self.employee, '2026-11'))
        workspace.employees = [self.row, self.row | {'code': 'SYN-NEW'}]
        workspace.save()
        with self.assertRaises(ValueError):
            latest_payroll(self.employee, '2026-11')
