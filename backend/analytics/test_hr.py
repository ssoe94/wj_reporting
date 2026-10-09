from copy import deepcopy
from decimal import Decimal
from unittest.mock import patch, MagicMock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .hr_contract import ImportSerializer, LayoutSerializer, summarize
from .hr_permissions import can_access_hr
from .hr_service import lock_month
from .models import HrAccessGrant, HrAccessHistory, HrMonthWorkspace, HrWorkspaceHistory

BASE = '/api/analytics/hr/'
MONTH = '2026-10'
ROWS = [
    {'code': '001', 'name': '가상 직원 A', 'title': '담당', 'amount': '100.10'},
    {'code': '002', 'name': '가상 직원 B', 'title': '', 'amount': '200.20'},
    {'code': '003', 'name': '가상 직원 C', 'title': '', 'amount': '0.30'},
]
DEPARTMENTS = [
    {'id': 'root', 'name': '생산', 'parent_id': None, 'function': '총괄'},
    {'id': 'child', 'name': '사출', 'parent_id': 'root', 'function': '성형'},
]


def import_data(version=0):
    return {'version': version, 'rows': deepcopy(ROWS), 'currency': 'CNY', 'cost_basis': 'employer_total', 'cost_basis_label': '', 'source_filename': 'synthetic.csv', 'expected_total': '300.60'}


class HrApiTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.superuser = User.objects.create_user('root', is_superuser=True)
        self.hr = User.objects.create_user('hr')
        self.staff = User.objects.create_user('staff', is_staff=True)
        self.normal = User.objects.create_user('normal')
        self.inactive = User.objects.create_user('inactive', is_active=False, is_superuser=True)
        HrAccessGrant.objects.create(user=self.hr, enabled=True)
        self.client = APIClient()
        self.client.force_authenticate(self.hr)

    def url(self, month=MONTH):
        return BASE + f'workspaces/{month}/'

    def upload(self, data=None, month=MONTH):
        return self.client.post(self.url(month) + 'import/', data or import_data(), format='json')

    def layout(self, version=1, assignments=None, departments=None, month=MONTH):
        return self.client.patch(self.url(month), {
            'version': version, 'departments': deepcopy(DEPARTMENTS) if departments is None else departments,
            'assignments': assignments if assignments is not None else [{'code': '001', 'department_id': 'root'}, {'code': '002', 'department_id': 'child'}, {'code': '003', 'department_id': None}],
        }, format='json')

    def test_every_salary_endpoint_denies_staff_normal_anonymous_inactive(self):
        for user in [self.staff, self.normal, None, self.inactive]:
            self.client.force_authenticate(user)
            requests = [
                self.client.get(BASE + 'workspaces/'), self.client.get(self.url()),
                self.client.post(BASE + 'import-preview/', {}, format='json'), self.upload(),
                self.layout(), self.client.get(BASE + 'access/'),
                self.client.patch(BASE + f'access/{self.normal.pk}/', {'granted': True}, format='json'),
            ]
            for response in requests:
                self.assertIn(response.status_code, [401, 403])
                self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_hr_can_work_but_cannot_manage_grants(self):
        self.assertEqual(self.upload().status_code, 200)
        self.assertEqual(self.client.get(BASE + 'access/').status_code, 403)
        self.assertEqual(self.client.patch(BASE + f'access/{self.normal.pk}/', {'granted': True}, format='json').status_code, 403)
        self.assertFalse(can_access_hr(self.normal))

    def test_get_never_seeds_and_validates_month(self):
        response = self.client.get(self.url())
        self.assertEqual(response.data['version'], 0)
        self.assertEqual(response.data['summary']['total'], '0.00')
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)
        for month in ['2026-13', '2026-1', 'bad']:
            self.assertEqual(self.client.get(self.url(month)).status_code, 400)

    def test_preview_decimal_total_no_storage(self):
        data = import_data()
        data.pop('version'); data.pop('expected_total')
        response = self.client.post(BASE + 'import-preview/', data, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['total'], '300.60')
        self.assertEqual(response.data['rows'][0]['code'], '001')
        self.assertEqual(len(response.data['fingerprint']), 64)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_import_layout_rollup_and_unassigned_reconcile(self):
        self.assertEqual(self.upload().status_code, 200)
        response = self.layout()
        self.assertEqual(response.status_code, 200)
        summary = response.data['summary']
        self.assertEqual(summary['total'], '300.60')
        self.assertEqual(summary['assigned_total'], '300.30')
        self.assertEqual(summary['unassigned_total'], '0.30')
        by_id = {item['id']: item for item in summary['departments']}
        self.assertEqual(by_id['root']['direct_total'], '100.10')
        self.assertEqual(by_id['root']['total'], '300.30')
        self.assertEqual(by_id['root']['headcount'], 2)
        self.assertEqual(by_id['child']['direct_total'], '200.20')
        self.assertEqual(sum(Decimal(item['direct_total']) for item in by_id.values()) + Decimal(summary['unassigned_total']), Decimal(summary['total']))
        self.assertEqual(response.data['history'][0]['actor'], 'hr')

    def test_repeated_import_is_idempotent_and_preserves_assignment(self):
        self.upload(); self.layout()
        response = self.upload(import_data(2))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['version'], 2)
        self.assertEqual(HrWorkspaceHistory.objects.count(), 2)
        self.assertEqual(response.data['employees'][0]['department_id'], 'root')

    def test_replacement_matches_code_removes_old_and_keeps_months_separate(self):
        self.upload(); self.layout()
        data = import_data(2)
        data['rows'] = [{'code': '002', 'name': '가상 직원 B', 'title': '', 'amount': '12.34'}, {'code': '004', 'name': '가상 직원 D', 'title': '', 'amount': '1.01'}]
        data['expected_total'] = '13.35'
        response = self.upload(data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['employees'][0]['department_id'], 'child')
        self.assertIsNone(response.data['employees'][1]['department_id'])
        self.assertEqual(response.data['source']['total'], '13.35')
        self.assertEqual(self.upload(month='2026-09').status_code, 200)
        self.assertEqual(self.client.get(self.url()).data['summary']['total'], '13.35')
        self.assertEqual(self.client.get(self.url('2026-09')).data['summary']['total'], '300.60')

    def test_currency_and_basis_change_are_explicit_replacement(self):
        self.upload()
        data = import_data(1); data['currency'] = 'KRW'; data['cost_basis'] = 'gross_salary'
        response = self.upload(data)
        self.assertEqual(response.data['currency'], 'KRW')
        self.assertEqual(response.data['version'], 2)

    def test_stale_version_does_not_overwrite_or_audit(self):
        self.upload(); self.layout()
        self.assertEqual(self.layout(1).status_code, 409)
        self.assertEqual(self.upload(import_data(1)).status_code, 409)
        self.assertEqual(HrMonthWorkspace.objects.get().version, 2)
        self.assertEqual(HrWorkspaceHistory.objects.count(), 2)

    def test_no_client_actor_or_money_mutation_via_layout(self):
        self.upload()
        for field in ['actor', 'updated_at', 'employees', 'source', 'currency']:
            data = {'version': 1, 'departments': [], 'assignments': [{'code': row['code'], 'department_id': None} for row in ROWS], field: 'fake'}
            self.assertEqual(self.client.patch(self.url(), data, format='json').status_code, 400)
        self.assertEqual(HrMonthWorkspace.objects.get().version, 1)

    def test_layout_before_upload_and_invalid_layouts(self):
        self.assertEqual(self.layout(0, assignments=[]).status_code, 200)
        self.assertEqual(self.upload(import_data(1)).status_code, 200)
        invalids = [
            [{'code': '001', 'department_id': 'root'}],
            [{'code': row['code'], 'department_id': 'missing'} for row in ROWS],
            [{'code': '001', 'department_id': None}] * 3,
        ]
        for assignments in invalids:
            self.assertEqual(self.layout(2, assignments=assignments).status_code, 400)
        cycle = deepcopy(DEPARTMENTS); cycle[0]['parent_id'] = 'child'
        self.assertEqual(self.layout(2, departments=cycle).status_code, 400)
        self.assertEqual(self.layout(2, departments=[DEPARTMENTS[1]]).status_code, 400)
        self.assertEqual(self.layout(2, departments=[DEPARTMENTS[0]] * 2).status_code, 400)

    def test_preview_total_mismatch_and_malformed_amount_rejected(self):
        data = import_data(); data['expected_total'] = '300.61'
        self.assertEqual(self.upload(data).status_code, 400)
        for amount in ['-1', 'NaN', '1.234', 'Infinity', '1e3', '', True, 1.23]:
            data = import_data(); data['rows'][0]['amount'] = amount
            self.assertEqual(self.upload(data).status_code, 400)
        data = import_data(); data['rows'][1]['code'] = '001'
        self.assertEqual(self.upload(data).status_code, 400)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_audit_failure_rolls_back_salary_and_layout(self):
        with patch('analytics.hr_service.HrWorkspaceHistory.objects.create', side_effect=RuntimeError('synthetic audit failure')):
            with self.assertRaises(RuntimeError):
                self.upload()
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)
        self.upload()
        with patch('analytics.hr_service.HrWorkspaceHistory.objects.create', side_effect=RuntimeError('synthetic audit failure')):
            with self.assertRaises(RuntimeError):
                self.layout()
        self.assertEqual(HrMonthWorkspace.objects.get().version, 1)
        self.assertEqual(HrMonthWorkspace.objects.get().departments, [])

    def test_grant_revoke_is_superuser_only_and_audited(self):
        self.client.force_authenticate(self.superuser)
        url = BASE + f'access/{self.normal.pk}/'
        self.assertEqual(self.client.patch(url, {'granted': True}, format='json').status_code, 200)
        self.assertTrue(can_access_hr(self.normal))
        self.client.patch(url, {'granted': True}, format='json')
        self.assertEqual(HrAccessHistory.objects.count(), 1)
        self.assertEqual(self.client.patch(url, {'granted': False}, format='json').status_code, 200)
        self.assertFalse(can_access_hr(self.normal))
        self.assertEqual(HrAccessHistory.objects.count(), 2)
        self.client.force_authenticate(self.normal)
        self.assertEqual(self.client.get(self.url()).status_code, 403)

    def test_bad_grants_and_delete_unsupported(self):
        self.client.force_authenticate(self.superuser)
        for user, data in [(self.inactive, {'granted': True}), (self.hr, {'granted': 'true'}), (self.hr, {'granted': True, 'actor': 'fake'}), (self.superuser, {'granted': False})]:
            self.assertEqual(self.client.patch(BASE + f'access/{user.pk}/', data, format='json').status_code, 400)
        self.assertEqual(self.client.delete(self.url()).status_code, 405)

    def test_revoked_hr_denied_immediately(self):
        HrAccessGrant.objects.filter(user=self.hr).update(enabled=False)
        self.assertEqual(self.client.get(self.url()).status_code, 403)
        self.assertEqual(self.upload().status_code, 403)

    def test_inactive_grantee_denied(self):
        self.hr.is_active = False; self.hr.save()
        self.assertFalse(can_access_hr(self.hr))
        self.assertEqual(self.client.get(self.url()).status_code, 403)

    def test_existing_admin_profile_does_not_grant_hr_and_identity_is_readonly(self):
        from injection.models import UserProfile
        from injection.serializers import UserSerializer, UserProfileSerializer
        profile, _ = UserProfile.objects.get_or_create(user=self.normal)
        profile.is_admin = True; profile.save()
        self.assertFalse(UserSerializer(self.normal).data['can_access_hr'])
        self.assertTrue(UserSerializer(self.hr).data['can_access_hr'])
        self.assertTrue(UserSerializer(self.superuser).data['can_access_hr'])
        serializer = UserSerializer(self.normal, data={'can_access_hr': True, 'is_superuser': True}, partial=True)
        self.assertTrue(serializer.is_valid())
        self.assertNotIn('can_access_hr', serializer.validated_data)
        self.assertNotIn('is_superuser', serializer.validated_data)
        profile_serializer = UserProfileSerializer(profile, data={'can_access_hr': True}, partial=True)
        self.assertTrue(profile_serializer.is_valid())
        self.assertNotIn('can_access_hr', profile_serializer.validated_data)

    def test_maximum_valid_unicode_import_fits_envelope(self):
        data = import_data()
        data['rows'] = [{'code': f'{index:064}', 'name': '名' * 100, 'title': '岗' * 100, 'amount': '999999999.99'} for index in range(5000)]
        data['expected_total'] = '4999999999950.00'
        response = self.upload(data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['summary']['total'], '4999999999950.00')
        self.assertEqual(response.data['summary']['employee_count'], 5000)

    def test_response_history_does_not_overtake_its_workspace_version(self):
        from .hr_service import workspace_payload
        self.upload()
        older_workspace = HrMonthWorkspace.objects.get()
        self.layout()
        response = workspace_payload(older_workspace)
        self.assertEqual(response['version'], 1)
        self.assertEqual([entry['version'] for entry in response['history']], [1])

    def test_explicit_classification_import_keeps_source_department_and_month(self):
        data = import_data(); data.update(month=MONTH, apply_classification=True, cost_basis='gross_salary')
        data['rows'][0].update(period=MONTH, source_department='原始品质', department_id='quality-cs')
        data['rows'][1].update(period=MONTH, source_department='原始营业', department_id='sales-cs')
        data['rows'][2].update(period=MONTH, source_department='原始注塑', department_id=None)
        response = self.upload(data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['employees'][0]['source_department'], '原始品质')
        self.assertEqual(response.data['employees'][0]['department_id'], 'quality-cs')
        by_id = {entry['id']: entry for entry in response.data['summary']['departments']}
        self.assertEqual(by_id['quality']['total'], '100.10')
        self.assertEqual(by_id['sales']['total'], '200.20')
        self.assertEqual(response.data['company_structure']['organization']['nodes'][0]['name'], '李泓九')

    def test_missing_cost_never_becomes_zero_in_total_rate_or_hierarchy(self):
        data = import_data(); data.update(month=MONTH, apply_classification=True, allow_missing_cost=True)
        data['rows'][0].update(amount=None, period=MONTH, department_id='injection-operator')
        data['rows'][1].update(period=MONTH, department_id='injection-operator')
        data['rows'][2].update(period=MONTH, department_id=None)
        data['expected_total'] = None
        response = self.upload(data)
        self.assertEqual(response.status_code, 200)
        summary = response.data['summary']
        self.assertIsNone(summary['total']); self.assertIsNone(summary['assigned_total'])
        self.assertEqual(summary['known_total'], '200.50'); self.assertEqual(summary['missing_cost_count'], 1)
        self.assertEqual(summary['employee_count'], 3); self.assertFalse(summary['cost_complete'])
        by_id = {entry['id']: entry for entry in summary['departments']}
        self.assertIsNone(by_id['injection-operator']['direct_total'])
        self.assertIsNone(by_id['injection']['total']); self.assertIsNone(by_id['injection']['share'])
        self.assertEqual(by_id['injection']['known_total'], '200.20')
        self.assertEqual(by_id['injection']['headcount'], 2)
        self.assertIsNone(response.data['source']['total'])

    def test_all_missing_roster_requires_explicit_flag_and_stays_unknown(self):
        data = import_data(); data['rows'] = [{**row, 'amount': None} for row in data['rows']]; data['expected_total'] = None
        self.assertEqual(self.upload(data).status_code, 400)
        data['allow_missing_cost'] = True
        response = self.upload(data)
        self.assertEqual(response.status_code, 200); self.assertIsNone(response.data['summary']['total'])
        self.assertEqual(response.data['summary']['known_cost_count'], 0)
        self.assertEqual(response.data['summary']['missing_cost_count'], 3)

    def test_period_path_and_unknown_classification_rejected_before_mutation(self):
        data = import_data(); data.update(month='2026-09'); data['rows'][0]['period'] = '2026-09'
        self.assertEqual(self.upload(data).status_code, 400)
        data['month'] = MONTH
        self.assertEqual(self.upload(data).status_code, 400)
        data = import_data(); data.update(apply_classification=True)
        for row in data['rows']: row['department_id'] = 'invalid-function'
        self.assertEqual(self.upload(data).status_code, 400)
        data.pop('apply_classification')
        self.assertEqual(self.upload(data).status_code, 400)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)

    def test_same_file_explicit_reapply_restores_file_classification_after_manual_move(self):
        data = import_data(); data.update(apply_classification=True)
        for row in data['rows']: row['department_id'] = 'quality-cs'
        self.assertEqual(self.upload(data).status_code, 200)
        current = self.client.get(self.url()).data
        changed = self.layout(version=1, departments=current['departments'], assignments=[{'code':row['code'],'department_id':'sales-cs'} for row in ROWS])
        self.assertEqual(changed.status_code, 200)
        data['version'] = 2
        response = self.upload(data)
        self.assertEqual(response.status_code, 200); self.assertEqual(response.data['version'], 3)
        self.assertEqual({row['department_id'] for row in response.data['employees']}, {'quality-cs'})


class HrContractTests(TestCase):
    def test_generated_frontend_catalog_matches_backend_source(self):
        from pathlib import Path
        from .hr_company_structure import frontend_catalog_source, COMPANY_DEPARTMENTS
        root = Path(__file__).resolve().parents[2]
        self.assertEqual((root / 'frontend/src/domains/hr/company-catalog.ts').read_text(), frontend_catalog_source())
        self.assertEqual(len({node['id'] for node in COMPANY_DEPARTMENTS}), len(COMPANY_DEPARTMENTS))
        self.assertNotIn('李泓九', frontend_catalog_source())
        self.assertNotIn('曹娅娟', frontend_catalog_source())

    def test_fixed_function_cells_cannot_move_to_a_different_cost_group(self):
        from copy import deepcopy
        from .hr_company_structure import COMPANY_DEPARTMENTS
        changed = deepcopy(COMPANY_DEPARTMENTS)
        next(node for node in changed if node['id'] == 'quality-cs')['parent_id'] = 'sales'
        self.assertFalse(LayoutSerializer(data={'version':0,'departments':changed,'assignments':[]}).is_valid())

    def test_bounds_and_depth(self):
        data = import_data(); data.pop('version'); data.pop('expected_total')
        data['rows'] = [ROWS[0]] * 5001
        self.assertFalse(ImportSerializer(data=data).is_valid())
        data['rows'] = deepcopy(ROWS); data['cost_basis'] = 'custom'
        self.assertFalse(ImportSerializer(data=data).is_valid())
        deep = [{'id': str(index), 'name': str(index), 'parent_id': str(index - 1) if index else None, 'function': ''} for index in range(9)]
        self.assertFalse(LayoutSerializer(data={'version': 0, 'departments': deep, 'assignments': []}).is_valid())

    def test_zero_cost_no_division_and_no_doublecount(self):
        summary = summarize(DEPARTMENTS, [{'code': 'zero', 'amount': '0.00', 'department_id': 'child'}])
        self.assertEqual(summary['total'], '0.00')
        self.assertEqual(summary['departments'][0]['share'], '0.00')

    def test_postgres_lock_precedes_workspace_snapshot(self):
        cursor = MagicMock()
        with patch('analytics.hr_service.connection') as connection, patch('analytics.hr_service.HrMonthWorkspace.objects.select_for_update') as query:
            connection.vendor = 'postgresql'
            connection.cursor.return_value.__enter__.return_value = cursor
            query.return_value.filter.return_value.first.return_value = None
            lock_month(MONTH)
            cursor.execute.assert_called_once()
            self.assertIn('pg_advisory_xact_lock', cursor.execute.call_args.args[0])
            self.assertIsInstance(cursor.execute.call_args.args[1][0], int)
