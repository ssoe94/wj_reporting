"""Framework boundary checks, run by scripts/check-mes-task-reconciliation.py."""
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from django.core.cache import cache
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from .mes_progress import extract_machine_number, normalize_mes_part_no
from .mes_task_reader import normalize_tasks
from .mes_task_reconciliation_service import build_reconciliation, read_snapshot
from .mes_task_reconciliation_views import MesTaskReconciliationView
from .models import ProductionPlan
from .test_mes_task_reconciliation import DAY, NOW, compare, task


class ReconciliationApiTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.factory = APIRequestFactory()

    def request(self, query='', method='get', active=True, authenticated=True):
        request = getattr(self.factory, method)(f'/api/production/mes-task-reconciliation/{query}')
        if authenticated:
            force_authenticate(request, user=SimpleNamespace(is_authenticated=True, is_active=active, is_staff=False))
        return MesTaskReconciliationView.as_view()(request)

    @patch('production.mes_task_reconciliation_views.build_reconciliation')
    def test_authenticated_plan_viewer_can_read(self, build):
        build.return_value = {'machines': []}
        response = self.request('?business_date=2026-10-08')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-store')
        build.assert_called_once_with(date(2026, 10, 8))

    @patch('production.mes_task_reconciliation_views.build_reconciliation')
    def test_anonymous_and_inactive_cannot_read(self, build):
        self.assertIn(self.request(authenticated=False).status_code, (401, 403))
        self.assertEqual(self.request(active=False).status_code, 403)
        build.assert_not_called()

    @patch('production.mes_task_reconciliation_views.build_reconciliation')
    def test_invalid_dates_and_writes_are_rejected_without_reading(self, build):
        for value in ('20261008', '2026-02-30', '', '9999-12-31'):
            self.assertEqual(self.request(f'?business_date={value}').status_code, 400)
        for method in ('post', 'put', 'patch', 'delete'):
            self.assertEqual(self.request(method=method).status_code, 405)
        build.assert_not_called()

    @patch('production.mes_task_reconciliation_service.read_task_pages')
    def test_successful_whitelisted_snapshot_is_cached(self, read):
        read.return_value = ([], True, [])
        self.assertEqual(read_snapshot(), read_snapshot())
        read.assert_called_once()

    @patch('production.mes_task_reconciliation_service.read_task_pages')
    def test_failed_snapshot_can_be_retried(self, read):
        read.return_value = ([], False, ['mes_read_failed'])
        read_snapshot()
        read_snapshot()
        self.assertEqual(read.call_count, 2)

    def test_real_normalizers_use_material_code_and_equipment_name(self):
        rows, complete = normalize_tasks([{
            'taskId': 1, 'taskCode': 'T1', 'taskStatus': 2, 'processCode': 'ZS',
            'mainMaterialCode': ' acq91625802 ', 'mainMaterialName': 'ACQ91625802（MCK71173502）',
            'equipments': [{'name': '17号注塑机', 'code': 'EQP999'}],
        }], normalize_mes_part_no, extract_machine_number)
        self.assertTrue(complete)
        self.assertEqual(rows[0]['machine_number'], 17)
        self.assertEqual(rows[0]['part_no'], 'ACQ91625802')

    def test_documented_list_contract_without_equipment_holds_assignment(self):
        # Public API 1681109889053785: enum code, main-material progress,
        # Amount.unit.id; equipment and inbound amounts are not documented.
        row = {
            'taskId': 123, 'taskCode': 'T123', 'taskStatus': {'code': 2, 'message': '执行中'},
            'processCode': 'ZS', 'workOrderCode': 'WO123',
            'actualStartTime': 1791417600000,
            'progressReportOpenVO': {
                'materialInfo': {'baseInfo': {'code': ' acq91625802 ', 'name': 'ACQ91625802（MCK71173502）'}},
                'plannedAmount': {'amount': 100, 'unit': {'id': 1}},
                'alreadyReportedAmount': {'amount': 120, 'unit': {'id': 1}},
            },
            'executorList': [{'name': 'private-worker'}],
        }
        tasks, complete = normalize_tasks([row], normalize_mes_part_no, extract_machine_number)
        self.assertTrue(complete)
        self.assertEqual(tasks[0]['status'], 2)
        self.assertEqual(tasks[0]['part_no'], 'ACQ91625802')
        self.assertEqual(tasks[0]['planned_quantity'], 100)
        self.assertEqual(tasks[0]['reported_quantity'], 120)
        self.assertEqual(tasks[0]['quantity_unit'], '1')
        self.assertIsNone(tasks[0]['inbound_quantity'])
        self.assertIsNone(tasks[0]['machine_number'])
        result = compare(tasks=tasks)
        self.assertFalse(result['data_freshness']['assignment_complete'])
        self.assertEqual(result['unmapped_tasks'][0]['assessment'], 'unmapped')
        self.assertNotIn('private-worker', str(result))

    def test_documented_units_and_enum_codes_are_validated(self):
        row = {
            'taskId': 123, 'taskCode': 'T123', 'taskStatus': {'code': 2},
            'processCode': 'ZS',
            'progressReportOpenVO': {
                'materialInfo': {'baseInfo': {'code': 'A'}},
                'plannedAmount': {'amount': 100, 'unit': {'id': 1}},
                'alreadyReportedAmount': {'amount': 120, 'unit': {'id': 2}},
            },
        }
        tasks, complete = normalize_tasks([row], normalize_mes_part_no, extract_machine_number)
        self.assertTrue(complete)
        self.assertIsNone(tasks[0]['quantity_unit'])
        for code in (True, '2', 4, None):
            row['taskStatus'] = {'code': code}
            self.assertEqual(normalize_tasks([row], normalize_mes_part_no, extract_machine_number), ([], False))

    def test_malformed_documented_material_cannot_use_conflicting_flat_identity(self):
        row = {
            'taskId': 123, 'taskCode': 'T123', 'taskStatus': {'code': 2}, 'processCode': 'ZS',
            'mainMaterialCode': 'UNVERIFIED-FALLBACK',
            'progressReportOpenVO': {'materialInfo': {'baseInfo': {'code': {'access_token': 'secret'}}}},
        }
        tasks, complete = normalize_tasks([row], normalize_mes_part_no, extract_machine_number)
        self.assertFalse(complete)
        self.assertEqual(tasks[0]['part_no'], '')
        self.assertNotIn('secret', str(tasks))


class ReconciliationPersistenceTests(TestCase):
    def setUp(self):
        for day in ('2026-10-08', '2026-10-09', '2026-10-10'):
            ProductionPlan.objects.create(plan_date=day, plan_type='injection', machine_name='1호기',
                                          part_no='A', planned_quantity=100, sequence=1)
        ProductionPlan.objects.create(plan_date='2026-10-08', plan_type='machining', machine_name='1호기',
                                      part_no='MACHINING', planned_quantity=100, sequence=1)

    @patch('production.mes_task_reconciliation_service.timezone.now', return_value=NOW)
    @patch('production.mes_task_reconciliation_service.read_observations', return_value={})
    @patch('production.mes_task_reconciliation_service.read_snapshot')
    def test_plan_edits_are_not_hidden_by_cached_mes_snapshot(self, snapshot, _observations, _now):
        snapshot.return_value = {'tasks': [task()], 'complete': True, 'warnings': [], 'queried_at': NOW.isoformat()}
        first = build_reconciliation(DAY)['machines'][0]
        self.assertEqual(len(first['plans']), 2)
        self.assertEqual(first['tasks'][0]['assessment'], 'plan_match')
        ProductionPlan.objects.filter(plan_type='injection').update(part_no='B')
        second = build_reconciliation(DAY)['machines'][0]
        self.assertEqual(second['tasks'][0]['assessment'], 'pause_review')
        self.assertEqual({row['part_no'] for row in second['plans']}, {'B'})
        self.assertEqual(ProductionPlan.objects.count(), 4)

    @patch('production.mes_task_reconciliation_service.timezone.now', return_value=NOW)
    @patch('production.mes_task_reconciliation_service.read_observations', side_effect=RuntimeError('private source failure'))
    @patch('production.mes_task_reconciliation_service.read_snapshot')
    def test_observation_failure_does_not_invent_a_stop_or_leak_errors(self, snapshot, _observations, _now):
        snapshot.return_value = {'tasks': [task()], 'complete': True, 'warnings': [], 'queried_at': NOW.isoformat()}
        result = build_reconciliation(DAY)
        self.assertEqual(result['machines'][0]['observation']['state'], 'unavailable')
        self.assertEqual(result['machines'][0]['tasks'][0]['assessment'], 'plan_match')
        self.assertIn('observation_read_failed', result['warnings'])
        self.assertNotIn('private source failure', str(result))
