"""Synthetic read-only kanban contracts; no MES calls or production settings."""
from datetime import date, datetime, timedelta
from unittest import mock
from zoneinfo import ZoneInfo

from rest_framework.test import APITestCase

from injection.models import UserProfile
from production.models import ProductionExecution, ProductionPlan, ProductionPlanChangeLog
from . import test_inspection_requests as inspection_contracts
from .inspection_kanban import machine_label_number
from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest


SHANGHAI = ZoneInfo('Asia/Shanghai')


class InspectionKanbanContractTests(APITestCase):
    base_url = '/api/quality/inspection-requests/'
    kanban_url = base_url + 'kanban/'
    # Reuse fixture helpers without inheriting or rediscovering the workflow suite.
    make_user = inspection_contracts.InspectionRequestContractTests.make_user
    create_payload = inspection_contracts.InspectionRequestContractTests.create_payload
    post = inspection_contracts.InspectionRequestContractTests.post
    create = inspection_contracts.InspectionRequestContractTests.create

    def setUp(self):
        self.editor = self.make_user('kanban-editor', superuser=True, permissions=('manage',))
        self.viewer = self.make_user('kanban-viewer', superuser=True, edit=False)
        self.client.force_authenticate(self.viewer)
        self.day = date(2026, 9, 30)
        self.start = datetime(2026, 9, 30, 8, tzinfo=SHANGHAI)
        self.now = datetime(2026, 9, 30, 12, tzinfo=SHANGHAI)

    def kanban(self, *, now=None, target_date=None):
        self.client.force_authenticate(self.viewer)
        params = {} if target_date is None else {'date': target_date}
        with mock.patch('quality.inspection_kanban.timezone.now', return_value=now or self.now):
            response = self.client.get(self.kanban_url, params)
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def plan(self, **overrides):
        values = {'plan_date': self.day, 'plan_type': 'injection', 'machine_name': 'imm02',
                  'part_no': 'part-A', 'lot_no': 'lot-A', 'sequence': 1, 'planned_quantity': 100}
        values.update(overrides)
        return ProductionPlan.objects.create(**values)

    def execution(self, **overrides):
        values = {'plan_date': self.day, 'plan_type': 'injection', 'machine_name': 'imm02',
                  'part_no': 'part-A', 'lot_no': 'lot-A', 'sequence': 1, 'status': 'running'}
        values.update(overrides)
        return ProductionExecution.objects.create(**values)

    def request_fixture(self, suffix, *, equipment='imm02', created_at=None, completed=False,
                        checked_at=None, **overrides):
        data = self.create(task_ref='synthetic-task-' + suffix, equipment_ref=equipment, **overrides)
        InspectionRequest.objects.filter(pk=data['id']).update(
            created_at=created_at or self.start,
            mes_completion_status='completed' if completed else 'not_completed',
            mes_checked_at=checked_at,
        )
        return data['id']

    @staticmethod
    def machine(data, number=2):
        return next(row for row in data['machines'] if row['machine_number'] == number)

    @staticmethod
    def request_ids(data):
        return {row['id'] for machine in data['machines'] for row in machine['requests']} | {
            row['id'] for row in data['unmapped_requests']}

    def test_access_requires_active_quality_view_including_profile(self):
        hidden = self.make_user('kanban-hidden', view=False)
        inactive = self.make_user('kanban-inactive', active=False, staff=True, superuser=True)
        missing = self.make_user('kanban-no-profile')
        UserProfile.objects.filter(user=missing).delete()
        for user in (hidden, inactive, missing, None):
            with self.subTest(user=getattr(user, 'username', None)):
                self.client.force_authenticate(user)
                self.assertEqual(self.client.get(self.kanban_url).status_code, 403)
        self.assertEqual(len(self.kanban()['machines']), 17)

    def test_get_never_seeds_mutates_or_calls_mes(self):
        request_id = self.request_fixture('read')
        self.plan()
        self.execution()
        models = (InspectionRequest, InspectionOperation, InspectionAudit, ProductionPlan,
                  ProductionPlanChangeLog, ProductionExecution)
        before = [list(model.objects.order_by('pk').values()) for model in models]
        adapter = inspection_contracts.SyntheticInspectionAdapter()
        with mock.patch('quality.inspection_adapter.get_inspection_adapter', return_value=adapter):
            first = self.kanban()
            second = self.kanban()
        self.assertEqual(adapter.refresh_calls, [])
        self.assertEqual(adapter.save_calls, [])
        self.assertEqual(self.request_ids(first), {request_id})
        self.assertEqual(first, second)
        self.assertEqual(before, [list(model.objects.order_by('pk').values()) for model in models])

    def test_business_date_changes_at_shanghai_eight_and_explicit_day_is_preserved(self):
        before_boundary = datetime(2026, 9, 30, 7, 59, 59, tzinfo=SHANGHAI)
        before = self.kanban(now=before_boundary)
        self.assertEqual(before['business_date'], '2026-09-29')
        self.assertEqual(before['day_start'], '2026-09-29T08:00:00+08:00')
        self.assertEqual(before['day_end'], '2026-09-30T08:00:00+08:00')
        at_boundary = self.kanban(now=self.start)
        self.assertEqual(at_boundary['business_date'], '2026-09-30')
        self.assertEqual(at_boundary['day_end'], '2026-10-01T08:00:00+08:00')
        historical = self.kanban(target_date='2026-09-28')
        self.assertEqual(historical['business_date'], '2026-09-28')
        for machine in historical['machines']:
            self.assertIn('plan_date_not_current', machine['dry_run']['blocking_reasons'])
            self.assertFalse(machine['dry_run']['enabled'])

    def test_date_rejects_invalid_ambiguous_and_overflow_values(self):
        for value in ('', '2026-02-30', '20260930', '2026-9-30', 'September 30',
                      '2026-09-30T08:00:00', '9999-12-31', '0000-01-01', '٢٠٢٦-٠٩-٣٠'):
            with self.subTest(value=value):
                response = self.client.get(self.kanban_url, {'date': value})
                self.assertEqual(response.status_code, 400, response.data)

    def test_labels_are_full_explicit_station_labels_never_opaque_ids_or_substrings(self):
        accepted = {'imm02': 2, 'IMM17': 17, '注塑02': 2, '2号注塑机': 2,
                    '02号机': 2, '7호기': 7, '1300T-7': 7, '#02-650T': 2}
        for label, number in accepted.items():
            with self.subTest(label=label):
                self.assertEqual(machine_label_number(label), number)
        for label in ('MES-resource-imm02', 'task-2号注塑机', '1300T-7-other', 'imm18', 'imm00',
                      '2', '02', 'machine2', '0000000002', 'a8300492cbb4', None, 2):
            with self.subTest(label=label):
                self.assertIsNone(machine_label_number(label))

    def test_unknown_equipment_is_separate_and_mapping_never_authorizes_automation(self):
        mapped = self.request_fixture('display-label', equipment='2号注塑机')
        unknown = self.request_fixture('opaque', equipment='MES-opaque-resource-002')
        self.plan(machine_name='1300T-7')
        unknown_plan = self.plan(machine_name='MES-opaque-resource-007')
        data = self.kanban()
        self.assertEqual([row['machine_number'] for row in data['machines']], list(range(1, 18)))
        self.assertEqual([row['station_id'] for row in data['machines']], [f'imm{x:02d}' for x in range(1, 18)])
        self.assertEqual({row['id'] for row in self.machine(data)['requests']}, {mapped})
        self.assertEqual({row['id'] for row in data['unmapped_requests']}, {unknown})
        self.assertEqual({row['id'] for row in data['unmapped_plans']}, {unknown_plan.id})
        self.assertFalse(data['plan_snapshot']['complete'])
        self.assertFalse(data['plan_snapshot']['work_task_binding_available'])
        self.assertFalse(data['plan_snapshot']['shift_stored'])
        for machine in data['machines']:
            self.assertEqual(machine['mapping_status'], 'label_only_unverified')
            self.assertEqual(machine['plan_status'], 'unknown')
            self.assertFalse(machine['dry_run']['enabled'])
            self.assertIn('machine_resource_mapping_unverified', machine['dry_run']['blocking_reasons'])
            self.assertIn('plan_mapping_or_completeness_unknown', machine['dry_run']['blocking_reasons'])
            self.assertNotEqual(machine['dry_run']['candidate'], 'review_pause')

    def test_pending_from_previous_days_remains_but_future_created_requests_do_not(self):
        old = self.request_fixture('old-pending', created_at=self.start - timedelta(days=10))
        current = self.request_fixture('current-pending')
        self.request_fixture('future-pending', created_at=self.now + timedelta(seconds=1))
        self.request_fixture('future-day-pending', created_at=self.start + timedelta(days=1))
        self.assertEqual(self.request_ids(self.kanban()), {old, current})

    def test_completed_results_use_mes_checked_business_day_instead_of_creation_day(self):
        old_created = self.request_fixture('old-created-completed', created_at=self.start - timedelta(days=3),
                                           completed=True, checked_at=self.start)
        current_completed = self.request_fixture('current-completed', completed=True,
                                                 checked_at=self.now - timedelta(seconds=1))
        self.request_fixture('previous-completion', completed=True,
                             checked_at=self.start - timedelta(microseconds=1))
        missing_check = self.request_fixture('missing-completion-time', completed=True)
        self.request_fixture('future-completion', completed=True,
                             checked_at=self.now + timedelta(seconds=1))
        self.request_fixture('future-created-completed', created_at=self.now + timedelta(seconds=1),
                             completed=True, checked_at=self.start)
        data = self.kanban()
        self.assertEqual(self.request_ids(data), {old_created, current_completed, missing_check})
        self.assertIn('inspection_completion_unverified', self.machine(data)['dry_run']['blocking_reasons'])

    def test_oldest_pending_request_is_not_buried_by_recent_tasks_or_completed_results(self):
        old = self.request_fixture('oldest-open', created_at=self.start - timedelta(days=10))
        self.request_fixture('recent-open')
        self.request_fixture('completed-result', created_at=self.start - timedelta(days=20),
                             completed=True, checked_at=self.start)
        with mock.patch('quality.inspection_kanban.ROW_LIMIT', 1):
            data = self.kanban()
        self.assertEqual(self.request_ids(data), {old})
        self.assertTrue(data['requests_truncated'])

    def test_completed_historical_day_has_inclusive_start_and_exclusive_end(self):
        historical_start = self.start - timedelta(days=1)
        included = self.request_fixture('historic-start', created_at=historical_start - timedelta(days=2),
                                        completed=True, checked_at=historical_start)
        self.request_fixture('historic-end', created_at=historical_start,
                             completed=True, checked_at=self.start)
        self.assertEqual(self.request_ids(self.kanban(target_date='2026-09-29')), {included})

    def test_only_target_day_injection_plans_and_exact_execution_identity_are_attached(self):
        exact_plan = self.plan()
        mismatched_part = self.plan(part_no='part-B', sequence=2)
        mismatched_lot = self.plan(part_no='part-C', lot_no='lot-C', sequence=3)
        mismatched_sequence = self.plan(part_no='part-D', sequence=4)
        mismatched_label = self.plan(machine_name='2号注塑机', part_no='part-E', sequence=5)
        self.plan(plan_date=self.day - timedelta(days=1), part_no='previous-day')
        self.plan(plan_type='machining', part_no='machining-only')
        self.execution()
        self.execution(part_no='another-part', sequence=2)
        self.execution(part_no='part-C', lot_no='another-lot', sequence=3)
        self.execution(part_no='part-D', sequence=99)
        self.execution(part_no='part-E', sequence=5)
        self.execution(plan_date=self.day - timedelta(days=1), part_no='part-B', sequence=2)
        self.execution(plan_type='machining', part_no='part-B', sequence=2)
        data = self.kanban()
        plans = {row['id']: row for row in self.machine(data)['plans']}
        self.assertEqual(set(plans), {exact_plan.id, mismatched_part.id, mismatched_lot.id,
                                    mismatched_sequence.id, mismatched_label.id})
        self.assertEqual(plans[exact_plan.id]['execution_status'], 'running')
        for plan in (mismatched_part, mismatched_lot, mismatched_sequence, mismatched_label):
            self.assertIsNone(plans[plan.id]['execution_status'])

    def test_request_same_station_with_different_part_is_not_inferred_plan_task_binding(self):
        self.plan()
        self.execution(status='paused')
        request_id = self.request_fixture('different-part', part_no='part-unrelated', lot_ref='other-lot')
        data = self.kanban()
        machine = self.machine(data)
        self.assertEqual({row['id'] for row in machine['requests']}, {request_id})
        self.assertEqual(machine['plans'][0]['part_no'], 'part-A')
        self.assertEqual(machine['requests'][0]['part_no'], 'PART-UNRELATED')
        self.assertEqual(machine['requests'][0]['plan_alignment'], {
            'status': 'part_not_listed', 'matching_plan_ids': [], 'task_binding_verified': False})
        self.assertFalse(data['plan_snapshot']['work_task_binding_available'])
        self.assertIn('mes_task_plan_binding_missing', machine['dry_run']['blocking_reasons'])
        self.assertEqual(machine['dry_run']['candidate'], 'review_resume')
        self.assertFalse(machine['dry_run']['enabled'])

    def test_part_and_lot_listing_does_not_verify_mes_task_binding(self):
        exact = self.plan(part_no='PART-A', lot_no='LOT-A')
        self.plan(part_no='PART-A', lot_no='LOT-B', sequence=2)
        self.plan(part_no='PART-B', lot_no='LOT-A', sequence=3)
        self.request_fixture('part-lot-listed', part_no='PART-A', lot_ref='LOT-A')
        machine = self.machine(self.kanban())
        self.assertEqual(machine['requests'][0]['plan_alignment'], {
            'status': 'part_listed', 'matching_plan_ids': [exact.id], 'task_binding_verified': False})
        self.assertIn('mes_task_plan_binding_missing', machine['dry_run']['blocking_reasons'])
        self.assertFalse(machine['dry_run']['enabled'])

    def test_missing_plan_only_proposes_review_and_never_pauses(self):
        self.request_fixture('unplanned')
        machine = self.machine(self.kanban())
        self.assertEqual(machine['plan_status'], 'missing')
        self.assertEqual(machine['dry_run']['candidate'], 'review_pause')
        self.assertEqual(machine['dry_run']['recommendation'], 'review_unplanned_work')
        self.assertFalse(machine['dry_run']['enabled'])
        self.assertIn('automation_not_authorized', machine['dry_run']['blocking_reasons'])
        self.assertIn('inspection_completion_unverified', machine['dry_run']['blocking_reasons'])

    def test_snapshot_version_changes_with_quantity_reorder_delete_and_scoped_change_log(self):
        plan = self.plan()
        versions = [self.kanban()['plan_snapshot']['version']]
        ProductionPlan.objects.filter(pk=plan.pk).update(planned_quantity=200)
        versions.append(self.kanban()['plan_snapshot']['version'])
        ProductionPlan.objects.filter(pk=plan.pk).update(sequence=10)
        versions.append(self.kanban()['plan_snapshot']['version'])
        plan.delete()
        versions.append(self.kanban()['plan_snapshot']['version'])
        change = ProductionPlanChangeLog.objects.create(plan_date=self.day, plan_type='injection',
                                                        action='delete', plan_id=plan.pk)
        data = self.kanban()
        versions.append(data['plan_snapshot']['version'])
        self.assertEqual(len(set(versions)), len(versions))
        self.assertEqual(data['plan_snapshot']['latest_changed_at'], change.created_at.isoformat())
        self.plan(plan_type='machining')
        self.plan(plan_date=self.day - timedelta(days=1))
        ProductionPlanChangeLog.objects.create(plan_date=self.day - timedelta(days=1),
                                               plan_type='injection', action='upload')
        self.assertEqual(self.kanban()['plan_snapshot']['version'], versions[-1])

    def test_truncated_sources_are_unknown_and_do_not_report_complete_or_missing(self):
        for number in range(1, 4):
            self.plan(machine_name=f'imm{number:02d}')
            self.execution(machine_name=f'imm{number:02d}')
            self.request_fixture(str(number), equipment=f'imm{number:02d}')
        with mock.patch('quality.inspection_kanban.ROW_LIMIT', 2):
            data = self.kanban()
        self.assertTrue(data['plans_truncated'])
        self.assertTrue(data['executions_truncated'])
        self.assertTrue(data['requests_truncated'])
        self.assertFalse(data['plan_snapshot']['complete'])
        self.assertEqual(data['counts']['plans_displayed'], 2)
        self.assertEqual(data['counts']['requests_displayed'], 2)
        for machine in data['machines']:
            self.assertEqual(machine['plan_status'], 'unknown')
            self.assertTrue(machine['requests_truncated'])
            self.assertFalse(machine['dry_run']['enabled'])
            self.assertIn('source_truncated', machine['dry_run']['blocking_reasons'])
            self.assertNotEqual(machine['dry_run']['candidate'], 'review_pause')
