"""Synthetic payroll only: permissions, exact totals, atomicity and roster evidence."""
from copy import deepcopy
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .hr_service import persist
from .models import HrAccessGrant, HrMonthWorkspace, HrWorkspaceHistory

BASE = '/api/analytics/hr/'


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
