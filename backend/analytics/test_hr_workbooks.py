"""Synthetic payroll only: permissions, exact totals, atomicity and roster evidence."""
from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from .hr_service import persist
from .models import HrAccessGrant, HrMonthWorkspace, HrWorkspaceHistory, HrRosterEmployee, HrRosterCodeHistory

BASE = '/api/analytics/hr/'


class HrRosterHistoryTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.hr = User.objects.create_user('synthetic-history-hr')
        self.superuser = User.objects.create_user('synthetic-history-root', is_superuser=True)
        self.staff = User.objects.create_user('synthetic-history-staff', is_staff=True)
        self.inactive = User.objects.create_user('synthetic-history-inactive', is_superuser=True, is_active=False)
        self.grant = HrAccessGrant.objects.create(user=self.hr, enabled=True)
        self.employee = HrRosterEmployee.objects.create(
            code='90001', name='Synthetic History', employment_type='contract',
            department='Synthetic team', first_month='2026-01', last_month='2026-11',
        )
        self.url = BASE + f'roster/2026-11/{self.employee.pk}/'
        self.client = APIClient()
        self.client.force_authenticate(self.hr)

    def history(self, **extra):
        return HrRosterCodeHistory.objects.create(**{
            'employee': self.employee, 'previous_code': '90000', 'new_code': '90001',
            'previous_status': 'active', 'new_status': 'departed',
            'previous_employment_type': 'hourly', 'new_employment_type': 'contract',
            'previous_department': 'Synthetic old team', 'new_department': 'Synthetic team',
            'actor': self.hr, 'actor_label': 'Synthetic reviewer', 'reason': 'Synthetic correction',
        } | extra)

    def test_history_requires_active_hr_access_and_never_caches_errors(self):
        self.history()
        for user in (self.staff, self.inactive):
            self.client.force_authenticate(user)
            response = self.client.get(self.url)
            self.assertEqual(response.status_code, 403)
            self.assertTrue({'private', 'no-store'} <= set(response['Cache-Control'].split(', ')))
            self.assertNotIn('history', response.data)
        self.grant.enabled = False
        self.grant.save()
        self.client.force_authenticate(self.hr)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(self.url).status_code, (401, 403))

    def test_authorized_history_preserves_server_snapshot_and_no_store(self):
        item = self.history()
        for user in (self.hr, self.superuser):
            self.client.force_authenticate(user)
            response = self.client.get(self.url)
            self.assertEqual(response.status_code, 200)
            self.assertTrue({'private', 'no-store'} <= set(response['Cache-Control'].split(', ')))
            self.assertEqual(response['Pragma'], 'no-cache')
            self.assertIn('Authorization', response['Vary'])
            row = response.json()['history'][0]
            self.assertEqual(row['id'], item.pk)
            self.assertEqual(row['actor_label'], 'Synthetic reviewer')
            self.assertEqual(row['reason'], 'Synthetic correction')
            self.assertEqual(row['previous_status'], 'active')
            self.assertEqual(row['new_status'], 'departed')
            self.assertEqual(row['previous_employment_type'], 'hourly')
            self.assertEqual(row['new_employment_type'], 'contract')
            self.assertEqual(row['previous_department'], 'Synthetic old team')
            self.assertEqual(row['new_department'], 'Synthetic team')
            self.assertEqual(row['previous_code'], '90000')
            self.assertEqual(row['new_code'], '90001')
            self.assertIn('T', row['created_at'])
            self.assertNotIn('actor_id', row)
        self.assertEqual(HrRosterCodeHistory.objects.count(), 1)
        self.employee.refresh_from_db()
        self.assertEqual(self.employee.version, 1)

    def test_history_newest_first_limit_twenty_and_stable_timestamp_ties(self):
        latest = timezone.now()
        ids = []
        for index in range(25):
            item = self.history(reason=f'Synthetic event {index}')
            HrRosterCodeHistory.objects.filter(pk=item.pk).update(created_at=latest)
            ids.append(item.pk)
        older = self.history(reason='Synthetic older event with highest id')
        HrRosterCodeHistory.objects.filter(pk=older.pk).update(created_at=latest - timedelta(days=1))
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item['id'] for item in response.data['history']], list(reversed(ids))[:20])

    def test_history_is_scoped_to_employee_and_empty_is_read_only(self):
        other = HrRosterEmployee.objects.create(
            code='90002', name='Synthetic Other', employment_type='hourly',
            first_month='2026-01', last_month='2026-11',
        )
        self.history(employee=other)
        self.assertEqual(self.client.get(self.url).data, {'history': []})
        self.assertEqual(HrRosterCodeHistory.objects.count(), 1)
        self.assertEqual(HrRosterEmployee.objects.count(), 2)

    def test_history_validates_month_and_missing_employee_and_has_no_delete(self):
        for url, status in ((self.url.replace('2026-11', '2026-13'), 400),
                            (BASE + 'roster/2026-11/999999/', 404)):
            response = self.client.get(url)
            self.assertEqual(response.status_code, status)
            self.assertTrue({'private', 'no-store'} <= set(response['Cache-Control'].split(', ')))
        self.assertEqual(self.client.delete(self.url).status_code, 405)
        self.assertTrue(HrRosterEmployee.objects.filter(pk=self.employee.pk).exists())


def batch():
    return {
        'classification': {'filename': 'synthetic-reference.xlsx', 'rows': [
            {'name': 'Synthetic A', 'employment_type': 'contract', 'source_department': '注塑', 'source_function': '注塑管理', 'source_row': 2},
            {'name': 'Synthetic B', 'employment_type': 'hourly', 'source_department': '品质', 'source_function': '进出货检验', 'source_row': 3},
        ]},
        'files': [{'id': 'c', 'filename': 'contract.xlsx', 'employment_type': 'contract'}, {'id': 'h', 'filename': 'hourly.xlsx', 'employment_type': 'hourly'}],
        'months': [{'month': f'2026-{month:02}', 'rows': [
            {'code': '00011', 'name': 'Synthetic A', 'amount': '10.10', 'title': '', 'period': f'2026-{month:02}', 'source_department': 'Untrusted payroll label', 'employment_type': 'contract', 'source_file': 'c', 'source_sheet': 'payroll', 'source_row': month + 1, 'original_code': '00011'},
            {'code': '245', 'name': 'Synthetic B', 'amount': '20.20', 'title': '', 'period': f'2026-{month:02}', 'source_department': 'Untrusted payroll label', 'employment_type': 'hourly', 'source_file': 'h', 'source_sheet': 'payroll', 'source_row': month + 1, 'original_code': '245'},
        ]} for month in range(1, 8)],
        'assignment_policy': 'preserve',
    }


class HrWorkbookTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.hr = User.objects.create_user('hr-intake')
        self.staff = User.objects.create_user('staff-intake', is_staff=True)
        self.superuser = User.objects.create_user('root-intake', is_superuser=True)
        self.inactive = User.objects.create_user('inactive-intake', is_superuser=True, is_active=False)
        HrAccessGrant.objects.create(user=self.hr, enabled=True)
        self.client = APIClient()
        self.client.force_authenticate(self.hr)

    def preview(self, data):
        return self.client.post(BASE + 'workbook-preview/', data, format='json')

    def commit(self, data, preview=None):
        if preview is None:
            response = self.preview(data)
            self.assertEqual(response.status_code, 200, response.data)
            preview = response.data
        return {**deepcopy(data), 'preview_token': preview['preview_token'], 'confirmations': [
            {'month': item['month'], 'version': item['version'], 'expected_total': item['total'], 'fingerprint': item['fingerprint']}
            for item in preview['months']
        ]}

    def save(self, data):
        return self.client.post(BASE + 'workbook-import/', data, format='json')

    def test_permissions_and_read_only_reference(self):
        for user in (None, self.staff, self.inactive):
            self.client.force_authenticate(user)
            for response in (self.client.get(BASE + 'classification-reference/'), self.preview(batch()), self.save({})):
                self.assertIn(response.status_code, (401, 403))
                self.assertIn('no-store', response['Cache-Control'])
        for user in (self.hr, self.superuser):
            self.client.force_authenticate(user)
            self.assertIsNone(self.client.get(BASE + 'classification-reference/').data['reference'])
            self.assertEqual(self.preview(batch()).status_code, 200)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_seven_months_persist_exact_money_source_and_reference(self):
        response = self.save(self.commit(batch()))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(HrMonthWorkspace.objects.count(), 7)
        self.assertEqual(HrWorkspaceHistory.objects.count(), 7)
        for workspace in response.data['workspaces']:
            self.assertEqual(workspace['summary']['total'], '30.30')
            self.assertEqual(workspace['employees'][0]['department_id'], 'injection')
            self.assertEqual(workspace['employees'][1]['department_id'], 'quality-oqc')
            self.assertEqual(workspace['employees'][0]['original_code'], '00011')
            self.assertEqual(workspace['source']['files'][0]['filename'], 'contract.xlsx')
        # Upload snapshots never silently replace the company-wide master.
        self.assertIsNone(self.client.get(BASE + 'classification-reference/').data['reference'])
        self.assertEqual(HrWorkspaceHistory.objects.count(), 7)
        again = self.save(self.commit(batch()))
        self.assertEqual(again.status_code, 200)
        self.assertTrue(all(workspace['version'] == 1 for workspace in again.data['workspaces']))
        self.assertEqual(HrWorkspaceHistory.objects.count(), 7)

    def test_partial_replacement_preserves_other_group_and_manual_assignment(self):
        self.save(self.commit(batch()))
        workspace = HrMonthWorkspace.objects.get(month='2026-01')
        workspace.employees[0]['department_id'] = 'development-staff'
        workspace.save()
        data = batch()
        data['months'] = [data['months'][0]]
        data['months'][0]['rows'] = [data['months'][0]['rows'][0]]
        data['months'][0]['rows'][0]['amount'] = '12.34'
        data['files'] = data['files'][:1]
        preview = self.preview(data).data['months'][0]
        self.assertEqual((preview['total'], preview['imported_count'], preview['retained_count']), ('32.54', 1, 1))
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['workspaces'][0]['employees'][0]['department_id'], 'development-staff')
        self.assertEqual(set(response.data['workspaces'][0]['source']['filename'].split(', ')), {'contract.xlsx', 'hourly.xlsx'})
        data['assignment_policy'] = 'reference'
        response = self.save(self.commit(data))
        self.assertEqual(response.data['workspaces'][0]['employees'][0]['department_id'], 'injection')
        self.assertEqual(HrMonthWorkspace.objects.get(month='2026-02').version, 1)

    def test_optional_payroll_components_keep_source_values_and_survive_other_group_import(self):
        data = batch()
        data['months'] = data['months'][:1]
        components = {'base_salary': '3000.25', 'fixed_overtime': '0.00'}
        data['months'][0]['rows'][0]['payroll_components'] = components
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200, response.data)
        employee = response.data['workspaces'][0]['employees'][0]
        self.assertEqual(employee['payroll_components'], components)
        self.assertEqual(employee['period'], '2026-01')
        self.assertEqual(employee['amount'], '10.10')
        self.assertNotIn('payroll_components', response.data['workspaces'][0]['employees'][1])
        hourly = deepcopy(data)
        hourly['months'][0]['rows'] = hourly['months'][0]['rows'][1:]
        hourly['months'][0]['rows'][0]['amount'] = '21.20'
        hourly['files'] = hourly['files'][1:]
        self.assertEqual(self.save(self.commit(hourly)).status_code, 200)
        stored = HrMonthWorkspace.objects.get(month='2026-01')
        self.assertEqual(next(row for row in stored.employees if row['code'] == '00011')['payroll_components'], components)
        missing = batch()
        missing['months'] = missing['months'][1:2]
        missing['months'][0]['rows'][0]['payroll_components'] = {'base_salary': None, 'fixed_overtime': None}
        response = self.save(self.commit(missing))
        self.assertEqual(response.data['workspaces'][0]['employees'][0]['payroll_components'], {'base_salary': None, 'fixed_overtime': None})

    def test_payroll_components_are_strict_and_part_of_reviewed_fingerprint(self):
        for components in (None, {}, {'base_salary': '3000'},
                           {'base_salary': '3000', 'fixed_overtime': '0', 'untrusted': '1'},
                           {'base_salary': '-1', 'fixed_overtime': '0'},
                           {'base_salary': '1.005', 'fixed_overtime': '0'},
                           {'base_salary': True, 'fixed_overtime': '0'}):
            with self.subTest(components=components):
                data = batch()
                data['months'][0]['rows'][0]['payroll_components'] = components
                self.assertEqual(self.preview(data).status_code, 400)
        data = batch()
        data['months'][0]['rows'][1]['payroll_components'] = {'base_salary': None, 'fixed_overtime': None}
        self.assertEqual(self.preview(data).status_code, 400)
        data = batch()
        data['months'][0]['rows'][0]['payroll_components'] = {'base_salary': '3000.00', 'fixed_overtime': '125.50'}
        reviewed = self.commit(data)
        reviewed['months'][0]['rows'][0]['payroll_components']['fixed_overtime'] = '250.00'
        self.assertEqual(self.save(reviewed).status_code, 400)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_unknowns_kept_and_payroll_department_never_guesses_assignment(self):
        data = batch()
        data['classification']['rows'][0]['source_function'] = 'unknown function'
        data['classification']['rows'][1]['name'] = 'Different employee'
        preview = self.preview(data)
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.data['months'][0]['unassigned_count'], 2)
        self.assertEqual(preview.data['months'][0]['total'], '30.30')
        data['classification']['rows'][0]['department_id'] = 'development'
        self.assertEqual(self.preview(data).data['months'][0]['rows'][0]['department_id'], 'development')
        data['classification']['rows'][0]['department_id'] = 'not-a-real-cell'
        self.assertEqual(self.preview(data).status_code, 400)

    def test_explicit_reapply_restores_reference_after_layout_only_edit(self):
        data = batch()
        data['months'] = data['months'][:1]
        original = self.save(self.commit(data)).data['workspaces'][0]
        edited = self.client.patch(BASE + 'workspaces/2026-01/', {
            'version': original['version'], 'departments': original['departments'],
            'assignments': [{'code': row['code'], 'department_id': 'development-staff'} for row in original['employees']],
        }, format='json')
        self.assertEqual(edited.status_code, 200, edited.data)
        self.assertEqual(edited.data['source']['fingerprint'], original['source']['fingerprint'])
        data['assignment_policy'] = 'reference'
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['workspaces'][0]['version'], 3)
        self.assertEqual([row['department_id'] for row in response.data['workspaces'][0]['employees']], ['injection', 'quality-oqc'])

    def test_aliases_keep_management_separate_from_work(self):
        from .hr_workbook_service import resolve_reference
        cases = [('营业', '仓库/物理', 'sales-warehouse'), ('资材', '副材料', 'materials-secondary'), ('模具', '模具/公务管理', 'mold-maintenance'), ('公务', '公务员工', 'maintenance-worker'), ('管理部', '人事总务', 'admin-hr'), ('开发', '开发管理', 'development'), ('开发', '开发', 'development-staff'), ('注塑', '操作工', 'injection-operator'), ('总经办', '总经理', None)]
        for department, function, expected in cases:
            reference = deepcopy(batch()['classification'])
            reference['rows'][0].update(source_department=department, source_function=function)
            self.assertEqual(resolve_reference(reference)['rows'][0]['department_id'], expected)

    def test_one_stale_month_prevents_entire_batch(self):
        data = batch()
        committed = self.commit(data)
        single = deepcopy(data)
        single['months'] = [single['months'][3]]
        self.assertEqual(self.save(self.commit(single)).status_code, 200)
        self.assertEqual(self.save(committed).status_code, 409)
        self.assertEqual(HrMonthWorkspace.objects.count(), 1)
        self.assertEqual(HrWorkspaceHistory.objects.count(), 1)

    def test_failure_during_second_write_rolls_back_first(self):
        calls = 0
        def fail_second(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('synthetic persistence failure')
            return persist(*args, **kwargs)
        data = self.commit(batch())
        with patch('analytics.hr_workbook_service.persist', side_effect=fail_second):
            self.assertEqual(self.save(data).status_code, 500)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)
        self.assertEqual(HrWorkspaceHistory.objects.count(), 0)

    def test_tampered_preview_total_rows_and_confirmation_rejected(self):
        for field in ('total', 'amount', 'fingerprint', 'confirmation'):
            data = self.commit(batch())
            if field == 'total': data['confirmations'][0]['expected_total'] = '0.00'
            if field == 'amount': data['months'][0]['rows'][0]['amount'] = '123.00'
            if field == 'fingerprint': data['preview_token'] = '0' * 64
            if field == 'confirmation': data['confirmations'].pop()
            self.assertEqual(self.save(data).status_code, 400)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_invalid_identity_amount_provenance_and_reference_rejected(self):
        cases = [
            lambda d: d['months'][0]['rows'][0].update(code=''),
            lambda d: d['months'][0]['rows'][1].update(code='11'),
            lambda d: d['months'][1]['rows'][0].update(name='Other person'),
            lambda d: d['months'][0]['rows'][0].update(amount='1.001'),
            lambda d: d['months'][0]['rows'][0].update(amount=None),
            lambda d: d['months'][0]['rows'][0].update(source_file='unknown'),
            lambda d: d['months'][0]['rows'][0].update(period='2026-02'),
            lambda d: d['months'][0]['rows'][0].update(department_id='injection'),
            lambda d: d['classification']['rows'].append(deepcopy(d['classification']['rows'][0])),
            lambda d: d.update(actor='spoofed'),
        ]
        for mutate in cases:
            data = batch(); mutate(data)
            response = self.preview(data)
            self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_reference_code_is_not_allowed_to_match_different_person(self):
        data = batch()
        data['classification']['rows'][0].update(code='245')
        self.assertEqual(self.preview(data).status_code, 400)

    def test_manual_code_correction_keeps_original_and_coordinates(self):
        data = batch()
        data['months'][0]['rows'][0]['original_code'] = ''
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200)
        row = response.data['workspaces'][0]['employees'][0]
        self.assertEqual((row['code'], row['original_code'], row['source_row']), ('00011', '', 2))

    def test_legacy_retained_missing_amount_is_not_zero(self):
        data = batch()
        self.save(self.commit(data))
        workspace = HrMonthWorkspace.objects.get(month='2026-01')
        workspace.employees[1].pop('employment_type')
        workspace.employees[1]['amount'] = None
        workspace.save()
        data['months'] = [data['months'][0]]
        data['months'][0]['rows'] = data['months'][0]['rows'][:1]
        response = self.preview(data)
        self.assertIsNone(response.data['months'][0]['total'])
        self.assertEqual(response.data['months'][0]['known_total'], '10.10')
        self.assertEqual(response.data['months'][0]['missing_cost_count'], 1)
        self.assertEqual(self.save(self.commit(data)).status_code, 200)
        workspace.refresh_from_db()
        workspace.currency = 'KRW'; workspace.save()
        self.assertEqual(self.preview(data).status_code, 400)

    def test_roster_access_version_and_actor(self):
        self.assertEqual(self.save(self.commit(batch())).status_code, 200)
        collection = BASE + 'roster/2026-11/'
        response = self.client.get(collection)
        self.assertIn('private, no-store', response['Cache-Control'])
        employee = response.data['employees'][0]
        self.assertFalse(employee['in_month'])
        self.assertEqual(employee['status'], 'active')
        self.assertEqual(employee['first_month'], '2026-01')
        self.assertEqual(employee['last_month'], '2026-07')
        path = f"{collection}{employee['id']}/"
        self.client.force_authenticate(self.staff)
        self.assertEqual(self.client.get(collection).status_code, 403)
        self.assertEqual(self.client.patch(path, {'version': 1, 'status': 'departed'}, format='json').status_code, 403)
        self.client.force_authenticate(self.hr)
        change = {'version': employee['version'], 'code': '90003', 'reason': 'Synthetic correction'}
        self.assertEqual(self.client.patch(path, change | {'actor': self.staff.pk}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(path, change, format='json').status_code, 200)
        self.assertEqual(self.client.patch(path, change, format='json').status_code, 409)
        history = HrRosterCodeHistory.objects.get()
        self.assertEqual((history.previous_code, history.new_code, history.actor_id), (employee['code'], '90003', self.hr.pk))
        self.assertEqual((history.previous_status, history.new_status), ('active', 'active'))
        self.assertEqual(HrRosterEmployee.objects.get(pk=employee['id']).normalized_code, '90003')
        self.assertTrue(next(item for item in self.client.get(BASE + 'roster/2026-01/').data['employees'] if item['id'] == employee['id'])['in_month'])
        with patch('analytics.hr_roster_service.record_change', side_effect=RuntimeError('synthetic rollback')):
            failed = self.client.patch(path, change | {'version': 2, 'code': '90004'}, format='json')
            self.assertEqual(failed.status_code, 500)
        self.assertEqual(HrRosterEmployee.objects.get(pk=employee['id']).code, '90003')

    def test_roster_status_change_records_before_after_reason_server_actor_and_time(self):
        self.assertEqual(self.save(self.commit(batch())).status_code, 200)
        employee = HrRosterEmployee.objects.get(employment_type='contract')
        path = f'{BASE}roster/2026-11/{employee.pk}/'
        change = {'version': 1, 'status': 'departed', 'reason': 'Synthetic departure confirmation'}
        for forged in ({'actor': self.staff.pk}, {'actor_label': 'forged'}, {'created_at': '2000-01-01T00:00:00Z'}):
            self.assertEqual(self.client.patch(path, change | forged, format='json').status_code, 400)
        before = timezone.now()
        response = self.client.patch(path, change, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        employee.refresh_from_db()
        self.assertEqual((employee.status, employee.version), ('departed', 2))
        history = employee.code_history.get()
        self.assertEqual((history.previous_code, history.new_code), (employee.code, employee.code))
        self.assertEqual((history.previous_status, history.new_status), ('active', 'departed'))
        self.assertEqual((history.reason, history.actor_id, history.actor_label), (change['reason'], self.hr.pk, self.hr.username))
        self.assertLessEqual(before, history.created_at)
        self.assertLessEqual(history.created_at, timezone.now())
        self.assertEqual(self.client.patch(path, change, format='json').status_code, 409)
        payload = next(row for row in response.data['employees'] if row['id'] == employee.pk)
        self.assertEqual(payload['previous_codes'], [])

    def test_roster_status_reason_is_required_and_nonblank(self):
        self.assertEqual(self.save(self.commit(batch())).status_code, 200)
        employee = HrRosterEmployee.objects.get(employment_type='contract')
        for reason in ({}, {'reason': ''}, {'reason': '   '}):
            response = self.client.patch(f'{BASE}roster/2026-11/{employee.pk}/', {
                'version': 1, 'status': 'departed', **reason,
            }, format='json')
            self.assertEqual(response.status_code, 400, response.data)
        employee.refresh_from_db()
        self.assertEqual((employee.status, employee.version), ('active', 1))
        self.assertFalse(employee.code_history.exists())

    def test_roster_status_history_failure_rolls_back_entire_edit(self):
        self.assertEqual(self.save(self.commit(batch())).status_code, 200)
        employee = HrRosterEmployee.objects.get(employment_type='contract')
        with patch.object(HrRosterCodeHistory.objects, 'create', side_effect=RuntimeError('synthetic audit failure')):
            response = self.client.patch(f'{BASE}roster/2026-11/{employee.pk}/', {
                'version': 1, 'status': 'departed', 'code': '90003', 'reason': 'Synthetic combined edit',
            }, format='json')
            self.assertEqual(response.status_code, 500)
        employee.refresh_from_db()
        self.assertEqual((employee.code, employee.normalized_code, employee.status, employee.version), ('00011', '11', 'active', 1))
        self.assertFalse(employee.code_history.exists())

    def test_roster_combined_edit_has_one_complete_history(self):
        self.assertEqual(self.save(self.commit(batch())).status_code, 200)
        employee = HrRosterEmployee.objects.get(employment_type='contract')
        response = self.client.patch(f'{BASE}roster/2026-11/{employee.pk}/', {
            'version': 1, 'status': 'departed', 'code': '00090003', 'reason': 'Synthetic combined edit',
        }, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        employee.refresh_from_db()
        self.assertEqual((employee.code, employee.normalized_code, employee.status), ('00090003', '90003', 'departed'))
        history = employee.code_history.get()
        self.assertEqual((history.previous_code, history.new_code, history.previous_status, history.new_status),
                         ('00011', '00090003', 'active', 'departed'))

    def test_roster_model_computes_normalized_keys_and_database_enforces_identity(self):
        defaults = {'department': '', 'first_month': '2026-01', 'last_month': '2026-01'}
        employee = HrRosterEmployee.objects.create(
            name=' Synthetic E\u0301 ', code='00090001', employment_type='contract',
            normalized_name='spoofed', normalized_code='spoofed', **defaults,
        )
        self.assertEqual((employee.normalized_name, employee.normalized_code), ('SyntheticÉ', '90001'))
        for duplicate in (
            {'name': 'Synthetic\tÉ', 'code': '90002', 'employment_type': 'contract'},
            {'name': 'Synthetic Other', 'code': '90001', 'employment_type': 'hourly'},
        ):
            with self.subTest(duplicate=duplicate), self.assertRaises(IntegrityError), transaction.atomic():
                HrRosterEmployee.objects.create(**duplicate, **defaults)
        # Employment type is part of the person key, but not of the code key.
        HrRosterEmployee.objects.create(name='Synthetic É', code='90002', employment_type='hourly', **defaults)
        employee.name, employee.code = ' Synthetic Updated ', '00090003'
        employee.save(update_fields=['name', 'code'])
        employee.refresh_from_db()
        self.assertEqual((employee.normalized_name, employee.normalized_code), ('SyntheticUpdated', '90003'))

    def test_roster_edit_database_code_conflict_returns_409_and_rolls_back(self):
        self.assertEqual(self.save(self.commit(batch())).status_code, 200)
        employee = HrRosterEmployee.objects.get(employment_type='contract')
        # Model an out-of-date ownership snapshot; the actual DB constraint must win.
        with patch('analytics.hr_roster_service.indexes', return_value=({}, {})):
            response = self.client.patch(f'{BASE}roster/2026-11/{employee.pk}/', {
                'version': 1, 'code': '000245', 'status': 'departed', 'reason': 'Synthetic conflict',
            }, format='json')
        self.assertEqual(response.status_code, 409, response.data)
        employee.refresh_from_db()
        self.assertEqual((employee.code, employee.normalized_code, employee.status, employee.version), ('00011', '11', 'active', 1))
        self.assertFalse(employee.code_history.exists())

    def test_roster_creation_database_conflicts_return_409_and_rollback_months(self):
        for existing in (
            {'name': 'SyntheticA', 'code': '90001', 'employment_type': 'contract'},
            {'name': 'Synthetic Other', 'code': '11', 'employment_type': 'hourly'},
        ):
            with self.subTest(existing=existing):
                employee = HrRosterEmployee.objects.create(**existing, first_month='2025-01', last_month='2025-01')
                # Bypass only the in-memory snapshot, not the write or database error.
                with patch('analytics.hr_roster_service.indexes', return_value=({}, {})):
                    response = self.save(self.commit(batch()))
                self.assertEqual(response.status_code, 409, response.data)
                self.assertEqual(HrRosterEmployee.objects.count(), 1)
                self.assertFalse(HrMonthWorkspace.objects.exists())
                self.assertFalse(HrWorkspaceHistory.objects.exists())
                self.assertFalse(HrRosterCodeHistory.objects.exists())
                employee.delete()

    def test_cross_month_code_change_requires_confirmation_and_keeps_snapshots(self):
        data = batch()
        data['months'][4]['rows'][1]['code'] = '90005'
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(HrRosterEmployee.objects.filter(employment_type='hourly').exists())
        self.assertFalse(HrRosterCodeHistory.objects.exists())
        data['roster_decisions'] = [{
            'name': 'Synthetic B', 'employment_type': 'hourly',
            'code': '90005', 'reason': 'Synthetic source confirmation', 'version': 0,
        }]
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200, response.data)
        employee = HrRosterEmployee.objects.get(employment_type='hourly')
        history = employee.code_history.get()
        self.assertEqual((employee.code, history.previous_code, history.actor_id), ('90005', '245', self.hr.pk))
        self.assertEqual((employee.normalized_name, employee.normalized_code), ('SyntheticB', '90005'))
        self.assertEqual((history.previous_status, history.new_status), ('active', 'active'))
        self.assertEqual(HrMonthWorkspace.objects.get(month='2026-01').employees[1]['code'], '245')
        self.assertEqual(self.preview(data).status_code, 409)

    def test_confirmed_upload_updates_existing_roster_keys_and_same_audit_table(self):
        self.assertEqual(self.save(self.commit(batch())).status_code, 200)
        data = batch()
        data['months'][4]['rows'][1]['code'] = '00090005'
        data['roster_decisions'] = [{
            'name': 'Synthetic B', 'employment_type': 'hourly', 'code': '00090005',
            'reason': 'Synthetic existing employee decision', 'version': 1,
        }]
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200, response.data)
        employee = HrRosterEmployee.objects.get(employment_type='hourly')
        self.assertEqual((employee.code, employee.normalized_code, employee.normalized_name, employee.version),
                         ('00090005', '90005', 'SyntheticB', 2))
        history = employee.code_history.get()
        self.assertEqual((history.previous_code, history.new_code, history.previous_status, history.new_status),
                         ('245', '00090005', 'active', 'active'))
        self.assertEqual((history.actor_id, history.reason), (self.hr.pk, data['roster_decisions'][0]['reason']))


def employment_transition_batch():
    """Synthetic same-code employee changes employment type after September."""
    return {
        'classification': {'filename': 'synthetic-transition-reference.xlsx', 'rows': [{
            'code': '00090001', 'name': 'Synthetic Transition', 'employment_type': 'hourly',
            'source_department': '注塑', 'source_function': '注塑管理', 'source_row': 2,
        }]},
        'files': [
            {'id': 'h', 'filename': 'synthetic-hourly.xlsx', 'employment_type': 'hourly'},
            {'id': 'c', 'filename': 'synthetic-contract.xlsx', 'employment_type': 'contract'},
        ],
        'months': [{'month': f'2026-{month:02}', 'rows': [{
            'code': '90001' if month == 10 else '00090001',
            'name': 'Synthetic\tTransition' if month == 10 else 'Synthetic Transition',
            'amount': '2.40' if month == 10 else '1.20', 'title': '', 'period': f'2026-{month:02}',
            'source_department': 'Synthetic contract team' if month == 10 else 'Synthetic hourly line',
            'employment_type': 'contract' if month == 10 else 'hourly',
            'source_file': 'c' if month == 10 else 'h', 'source_sheet': 'payroll', 'source_row': month + 1,
            'original_code': '90001' if month == 10 else '00090001',
        }]} for month in range(6, 11)],
        'assignment_policy': 'preserve',
    }


class HrRosterEmploymentTransitionTests(TestCase):
    def setUp(self):
        self.hr = get_user_model().objects.create_user('hr-transition')
        HrAccessGrant.objects.create(user=self.hr, enabled=True)
        self.client = APIClient()
        self.client.force_authenticate(self.hr)

    def preview(self, data):
        return self.client.post(BASE + 'workbook-preview/', data, format='json')

    def commit(self, data):
        response = self.preview(data)
        self.assertEqual(response.status_code, 200, response.data)
        preview = response.data
        payload = {**deepcopy(data), 'preview_token': preview['preview_token'], 'confirmations': [
            {'month': month['month'], 'version': month['version'], 'expected_total': month['total'],
             'fingerprint': month['fingerprint']}
            for month in preview['months']
        ]}
        return self.client.post(BASE + 'workbook-import/', payload, format='json')

    def seed_hourly(self):
        data = employment_transition_batch()
        data['months'] = data['months'][:-1]
        response = self.commit(data)
        self.assertEqual(response.status_code, 200, response.data)
        return HrRosterEmployee.objects.get()

    def decision(self, version):
        return {'name': 'Synthetic Transition', 'employment_type': 'contract', 'code': '00090001',
                'reason': 'Synthetic employment transition confirmation', 'version': version}

    def assert_month_presence(self):
        for month in ('2026-06', '2026-10'):
            response = self.client.get(f'{BASE}roster/{month}/')
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(len(response.data['employees']), 1)
            self.assertTrue(response.data['employees'][0]['in_month'])

    def test_unconfirmed_first_upload_keeps_one_hourly_row_and_all_payroll_months(self):
        response = self.commit(employment_transition_batch())
        self.assertEqual(response.status_code, 200, response.data)
        employee = HrRosterEmployee.objects.get()
        self.assertEqual((employee.employment_type, employee.first_month, employee.last_month),
                         ('hourly', '2026-06', '2026-09'))
        self.assertEqual(employee.department, 'Synthetic hourly line')
        self.assertFalse(HrRosterCodeHistory.objects.exists())
        self.assertEqual(HrMonthWorkspace.objects.count(), 5)
        self.assertEqual([month['summary']['total'] for month in response.data['workspaces']],
                         ['1.20', '1.20', '1.20', '1.20', '2.40'])
        self.assertEqual(HrMonthWorkspace.objects.get(month='2026-10').employees[0]['employment_type'], 'contract')
        self.assert_month_presence()

    def test_unconfirmed_existing_employee_stays_unchanged_for_october_and_full_upload(self):
        employee = self.seed_hourly()
        initial = (employee.code, employee.department, employee.version, employee.first_month, employee.last_month)
        for only_october in (True, False):
            with self.subTest(only_october=only_october):
                data = employment_transition_batch()
                if only_october:
                    data['months'] = data['months'][-1:]
                response = self.commit(data)
                self.assertEqual(response.status_code, 200, response.data)
                employee.refresh_from_db()
                self.assertEqual(HrRosterEmployee.objects.count(), 1)
                self.assertEqual(employee.employment_type, 'hourly')
                self.assertEqual((employee.code, employee.department, employee.version, employee.first_month, employee.last_month), initial)
                self.assertFalse(HrRosterCodeHistory.objects.exists())
        self.assert_month_presence()

    def test_confirmed_existing_transition_updates_latest_type_department_and_one_audit(self):
        employee = self.seed_hourly()
        data = employment_transition_batch()
        data['months'].reverse()  # Latest month, never list order, defines the new attributes.
        data['roster_decisions'] = [self.decision(employee.version)]
        before = timezone.now()
        response = self.commit(data)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(HrRosterEmployee.objects.count(), 1)
        employee.refresh_from_db()
        self.assertEqual((employee.employment_type, employee.department, employee.last_month, employee.version),
                         ('contract', 'Synthetic contract team', '2026-10', 2))
        self.assertEqual((employee.normalized_name, employee.normalized_code), ('SyntheticTransition', '90001'))
        history = HrRosterCodeHistory.objects.get()
        self.assertEqual(history.employee_id, employee.pk)
        self.assertEqual((history.previous_employment_type, history.new_employment_type), ('hourly', 'contract'))
        self.assertEqual((history.previous_department, history.new_department),
                         ('Synthetic hourly line', 'Synthetic contract team'))
        self.assertEqual((history.previous_code, history.new_code), ('00090001', '00090001'))
        self.assertEqual((history.reason, history.actor_id, history.actor_label),
                         (data['roster_decisions'][0]['reason'], self.hr.pk, self.hr.username))
        self.assertLessEqual(before, history.created_at)
        self.assertLessEqual(history.created_at, timezone.now())
        self.assert_month_presence()
        self.assertEqual(self.preview(data).status_code, 409)

    def test_confirmed_first_upload_creates_one_employee_and_transition_audit(self):
        data = employment_transition_batch()
        data['roster_decisions'] = [self.decision(0)]
        response = self.commit(data)
        self.assertEqual(response.status_code, 200, response.data)
        employee = HrRosterEmployee.objects.get()
        self.assertEqual((employee.employment_type, employee.department, employee.first_month, employee.last_month),
                         ('contract', 'Synthetic contract team', '2026-06', '2026-10'))
        history = HrRosterCodeHistory.objects.get()
        self.assertEqual((history.previous_employment_type, history.new_employment_type, history.actor_id),
                         ('hourly', 'contract', self.hr.pk))
        self.assertEqual((history.previous_department, history.new_department),
                         ('Synthetic hourly line', 'Synthetic contract team'))

    def test_transition_rejects_different_name_on_same_code(self):
        data = employment_transition_batch()
        data['months'][-1]['rows'][0]['name'] = 'Synthetic Other'
        self.assertEqual(self.preview(data).status_code, 400)
        self.assertFalse(HrRosterEmployee.objects.exists())
        self.seed_hourly()
        data['months'] = data['months'][-1:]
        self.assertEqual(self.preview(data).status_code, 400)
        self.assertEqual(HrRosterEmployee.objects.count(), 1)

    def test_same_name_with_distinct_codes_and_types_stays_two_people(self):
        data = employment_transition_batch()
        hourly = deepcopy(data['months'][0]['rows'][0])
        hourly['period'] = '2026-10'
        contract = data['months'][-1]['rows'][0]
        contract['code'] = contract['original_code'] = '90002'
        data['months'] = [{'month': '2026-10', 'rows': [hourly, contract]}]
        response = self.commit(data)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(HrRosterEmployee.objects.values_list('normalized_code', 'employment_type')),
                         {('90001', 'hourly'), ('90002', 'contract')})
        self.assertFalse(HrRosterCodeHistory.objects.exists())
        roster = self.client.get(BASE + 'roster/2026-10/').data['employees']
        self.assertEqual(len(roster), 2)
        self.assertTrue(all(row['in_month'] for row in roster))

    def test_transition_confirmation_requires_reason_version_and_server_owned_actor(self):
        employee = self.seed_hourly()
        for extra, expected in (({'version': 0}, 409), ({'reason': ''}, 400),
                                ({'actor': self.hr.pk}, 400), ({'created_at': '2000-01-01T00:00:00Z'}, 400)):
            with self.subTest(extra=extra):
                data = employment_transition_batch()
                data['roster_decisions'] = [self.decision(employee.version) | extra]
                self.assertEqual(self.preview(data).status_code, expected)
        employee.refresh_from_db()
        self.assertEqual((employee.employment_type, employee.last_month, employee.version), ('hourly', '2026-09', 1))
        self.assertFalse(HrRosterCodeHistory.objects.exists())

    def test_transition_audit_failure_rolls_back_roster_and_october_payroll(self):
        employee = self.seed_hourly()
        data = employment_transition_batch()
        data['roster_decisions'] = [self.decision(employee.version)]
        with patch.object(HrRosterCodeHistory.objects, 'create', side_effect=RuntimeError('synthetic transition audit failure')):
            response = self.commit(data)
            self.assertEqual(response.status_code, 500)
        employee.refresh_from_db()
        self.assertEqual((employee.employment_type, employee.department, employee.last_month, employee.version),
                         ('hourly', 'Synthetic hourly line', '2026-09', 1))
        self.assertEqual(HrRosterEmployee.objects.count(), 1)
        self.assertFalse(HrMonthWorkspace.objects.filter(month='2026-10').exists())
        self.assertFalse(HrWorkspaceHistory.objects.filter(workspace__month='2026-10').exists())
        self.assertFalse(HrRosterCodeHistory.objects.exists())
