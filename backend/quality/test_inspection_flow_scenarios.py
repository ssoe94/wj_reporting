"""Synthetic QC sequences; never evidence of live production/MES acceptance.

QC stages must leave ProductionExecution unchanged. Additional scenarios drive
its existing local upsert separately; no MES production task or disposition is
executed, and synthetic QC observations never become live read evidence.
"""
from dataclasses import replace
from datetime import datetime, timedelta, timezone as datetime_timezone
import uuid
from unittest.mock import patch

from django.utils import timezone
from rest_framework.test import APITestCase

from production.models import ProductionExecution, ProductionPlan
from . import test_inspection_requests as request_helpers
from . import test_inspection_mes_stages as stage_helpers
from .inspection_mes_stages import TEST_LABEL
from .inspection_board_status import (
    BoardScope, CurrentTaskBinding, PeriodicSchedule, QualityObservation,
    ReadState, project_machine_quality,
)
from .inspection_kanban import business_date
from .inspection_models import (
    InspectionMesBinding, InspectionNonconformance, InspectionOperation,
    InspectionRequest,
)
from .inspection_validation import digest
from .inspection_workflow import result_payload


class InspectionFlowScenarioTests(APITestCase):
    base_url = request_helpers.InspectionRequestContractTests.base_url
    make_user = request_helpers.InspectionRequestContractTests.make_user
    create_payload = request_helpers.InspectionRequestContractTests.create_payload
    draft_payload = request_helpers.InspectionRequestContractTests.draft_payload
    post = request_helpers.InspectionRequestContractTests.post
    create = request_helpers.InspectionRequestContractTests.create
    draft = request_helpers.InspectionRequestContractTests.draft
    action = request_helpers.InspectionRequestContractTests.action

    def setUp(self):
        request_helpers.InspectionRequestContractTests.setUp(self)
        self.stage = stage_helpers.StageFixture()
        adapter_patch = patch('quality.inspection_mes_stages.get_stage_adapter',
                              side_effect=lambda *, user=None, session=None: self.stage)
        adapter_patch.start()
        self.addCleanup(adapter_patch.stop)
        network_patch = patch('requests.sessions.Session.request',
                              side_effect=AssertionError('Fixture must not use HTTP.'))
        self.network = network_patch.start()
        self.addCleanup(network_patch.stop)
        self.addCleanup(self.network.assert_not_called)

    def _reviewed(self, verdict, task_ref, *, child=None, **create_overrides):
        data = child or self.create(
            task_ref=task_ref, quantity_mode='not_recorded', require_evidence=False,
            inspection_items=[{
                'id': 'dimension', 'label': 'SYNTHETIC dimension', 'kind': 'number',
                'unit': 'mm', 'minimum': '9.5', 'maximum': '10.5',
                'required': True, 'evidence_required': False,
            }],
            **create_overrides,
        )
        data = self.draft(
            data, judgement=verdict, inspected_quantity='0.000',
            accepted_quantity='0.000', rejected_quantity='0.000', evidence=[],
            measurements=[{'item_id': 'dimension', 'value': '11.0' if verdict == 'fail' else '10.0',
                           'judgement': verdict, 'evidence_url': ''}],
        )
        submitted = self.action(data, 'submit')
        self.assertEqual(submitted.status_code, 200, submitted.data)
        self.assertEqual(submitted.data['status'], 'failed' if verdict == 'fail' else 'submitted')
        reviewed = self.action(
            submitted.data, 'review-failure' if verdict == 'fail' else 'approve',
            user=self.reviewer, reason='SYNTHETIC independent review',
        )
        self.assertEqual(reviewed.status_code, 200, reviewed.data)
        self.assertNotEqual(reviewed.data['submitted_by'], reviewed.data['reviewed_by'])
        self.assertEqual(reviewed.data['judgement'], verdict)
        return reviewed.data

    def _bind(self, data, index):
        row = InspectionRequest.objects.get(pk=data['id'])
        return InspectionMesBinding.objects.create(
            request=row, tenant='SYNTHETIC-FLOW', qc_id=f'9100000000000{index:04d}',
            work_order_id='91000000000000002', test_only=True,
            reviewed_result_digest=digest(result_payload(row)),
            test_label=TEST_LABEL + ' / SYNTHETIC-FLOW',
            contract={
                'production_task_id': '91000000000000003', 'equipment_id': '91000000000000004',
                'snapshot_id': f'9200000000000{index:04d}', 'actor_id': self.mes_user_map[str(self.editor.pk)],
                'target_reference': 'SYNTHETIC fixture target',
                'mapping_reference': 'SYNTHETIC fixture mapping',
                'label_reference': 'SYNTHETIC fixture label',
                'side_effect_reference': 'SYNTHETIC no-network fixture',
                'items': [{'local_item_id': 'dimension', 'config_row_id': '91000000000000007',
                           'write_item_id': '91000000000000008', 'group': 'SYNTHETIC-GROUP', 'seq': 1}],
            },
        )

    def _production(self, data, index, status):
        row = InspectionRequest.objects.get(pk=data['id'])
        identity = {
            'plan_date': timezone.localdate(row.work_started_at), 'plan_type': 'injection',
            'machine_name': row.equipment_ref, 'part_no': row.part_no,
            'lot_no': row.lot_ref, 'sequence': index,
        }
        plan = ProductionPlan.objects.create(**identity, planned_quantity=10)
        execution = ProductionExecution.objects.create(
            **identity, status=status, actual_qty=3, defect_qty=1, idle_time=2,
            start_datetime=timezone.now() - timedelta(minutes=5), end_datetime=None,
            updated_by=self.editor, note='SYNTHETIC local production remains independent',
        )
        return (
            ProductionPlan.objects.values().get(pk=plan.pk),
            ProductionExecution.objects.values().get(pk=execution.pk),
        )

    def _assert_boundary(self, production, case, data):
        plan, execution = production
        self.assertEqual(ProductionPlan.objects.values().get(pk=plan['id']), plan)
        self.assertEqual(ProductionExecution.objects.values().get(pk=execution['id']), execution)
        self.assertEqual(data['injection_receipt_readiness'], 'not_verified')
        if case is not None:
            self.assertEqual(InspectionNonconformance.objects.values().get(pk=case['id']), case)
            self.assertEqual(case['state'], 'open')
            # Stage mapping supports not_recorded only: unknown quantity is not zero.
            self.assertIsNone(case['quantity'])

    def test_qc_terminal_states_preserve_production_and_unresolved_nonconformance(self):
        for index, (verdict, terminal, production_state) in enumerate([
            ('pass', 'completed', 'running'),
            ('fail', 'completed', 'paused'),
            ('fail', 'approval_pending', 'running'),
        ], start=1):
            with self.subTest(verdict=verdict, terminal=terminal, production_state=production_state):
                self.stage = stage_helpers.StageFixture()
                reviewed = self._reviewed(verdict, f'SYNTHETIC-FLOW-{index}')
                self._bind(reviewed, index)
                production = self._production(reviewed, index, production_state)
                case = InspectionNonconformance.objects.filter(request_id=reviewed['id']).values().first()
                self.assertEqual(case is not None, verdict == 'fail')
                saved = self.action(reviewed, 'mes-save')
                self.assertEqual(saved.status_code, 200, saved.data)
                self.assertEqual(saved.data['mes_workflow']['phase'], 'saved')
                self.assertEqual(saved.data['mes_completion_status'], 'not_completed')
                self._assert_boundary(production, case, saved.data)
                # The provider mock changes state during finish, never on its pre-read.
                finish = self.stage.finish_inspection
                def finish_in_terminal_state(binding, result, operation_id):
                    finish(binding, result, operation_id)
                    self.stage.state = terminal
                self.stage.finish_inspection = finish_in_terminal_state
                completed = self.action(saved.data, 'mes-finish')
                self.assertEqual(completed.status_code, 200, completed.data)
                self.assertEqual(completed.data['mes_completion_status'], terminal)
                self.assertEqual(completed.data['judgement'], verdict)
                self.assertFalse(completed.data['mes_workflow']['can_finish'])
                self._assert_boundary(production, case, completed.data)
                self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])
                if verdict == 'fail':
                    self.assertFalse(completed.data['nonconformance']['can_execute'])

    def test_failed_parent_timeout_reconcile_and_passing_child_preserve_lineage_and_locks(self):
        reviewed = self._reviewed('fail', 'SYNTHETIC-FLOW-REINSPECTION')
        self._bind(reviewed, 1)
        production = self._production(reviewed, 1, 'paused')
        case = InspectionNonconformance.objects.values().get(request_id=reviewed['id'])
        parent_result = result_payload(InspectionRequest.objects.get(pk=reviewed['id']))
        saved = self.action(reviewed, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self._assert_boundary(production, case, saved.data)

        finish_key = uuid.uuid4()
        self.stage.timeout = 'finish'
        unknown = self.action(saved.data, 'mes-finish', key=finish_key)
        self.assertEqual(unknown.status_code, 503, unknown.data)
        current = unknown.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'finish_unknown')
        self.assertFalse(current['capabilities']['can_reinspect'])
        self.assertEqual(self.action(current, 'reinspect', reason='SYNTHETIC too early').status_code, 409)
        self.assertEqual(self.action(current, 'mes-finish').status_code, 409)
        self.assertEqual(self.action(saved.data, 'mes-finish', key=finish_key).status_code, 503)
        self.assertEqual(InspectionRequest.objects.filter(parent_id=reviewed['id']).count(), 0)
        self._assert_boundary(production, case, current)

        self.stage.state = 'open'
        unresolved = self.action(current, 'mes-reconcile')
        self.assertEqual(unresolved.status_code, 503, unresolved.data)
        current = unresolved.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'finish_unknown')
        self.assertEqual(self.action(current, 'reinspect', reason='SYNTHETIC still uncertain').status_code, 409)
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])

        self.stage.state = 'completed'
        resolved = self.action(current, 'mes-reconcile')
        self.assertEqual(resolved.status_code, 200, resolved.data)
        self.assertEqual(resolved.data['mes_completion_status'], 'completed')
        self.assertTrue(resolved.data['capabilities']['can_reinspect'])
        self._assert_boundary(production, case, resolved.data)
        replayed_finish = self.action(saved.data, 'mes-finish', key=finish_key)
        self.assertEqual(replayed_finish.status_code, 200, replayed_finish.data)
        self.assertEqual(replayed_finish.data, resolved.data)
        parent_stage = self.stage
        self.assertEqual([call[0] for call in parent_stage.calls], ['save', 'finish'])
        finish_operation = InspectionOperation.objects.get(request_id=reviewed['id'], key=finish_key)
        self.assertEqual(finish_operation.status, 'succeeded')

        child_key = uuid.uuid4()
        child = self.action(resolved.data, 'reinspect', key=child_key, reason='SYNTHETIC settled reinspection')
        self.assertEqual(child.status_code, 201, child.data)
        self.assertEqual(child.data['parent'], reviewed['id'])
        self.assertIsNone(child.data['nonconformance'])
        replayed_child = self.action(resolved.data, 'reinspect', key=child_key,
                                    reason='SYNTHETIC settled reinspection')
        self.assertEqual(replayed_child.status_code, 201, replayed_child.data)
        self.assertEqual(replayed_child.data, child.data)
        parent = InspectionRequest.objects.get(pk=reviewed['id'])
        self.assertEqual(self.action({'id': parent.pk, 'version': parent.version}, 'reinspect',
                                    reason='SYNTHETIC duplicate child').status_code, 409)
        self.assertEqual(InspectionRequest.objects.filter(parent=parent).count(), 1)

        self.stage = stage_helpers.StageFixture()
        child_reviewed = self._reviewed('pass', 'unused-existing-child', child=child.data)
        self._bind(child_reviewed, 2)
        child_saved = self.action(child_reviewed, 'mes-save')
        self.assertEqual(child_saved.status_code, 200, child_saved.data)
        child_finish_key = uuid.uuid4()
        child_finished = self.action(child_saved.data, 'mes-finish', key=child_finish_key)
        self.assertEqual(child_finished.status_code, 200, child_finished.data)
        self.assertEqual(child_finished.data['mes_completion_status'], 'completed')
        self.assertEqual(child_finished.data['judgement'], 'pass')
        self.assertIsNone(child_finished.data['nonconformance'])
        self._assert_boundary(production, case, child_finished.data)
        replayed_child_finish = self.action(child_saved.data, 'mes-finish', key=child_finish_key)
        self.assertEqual(replayed_child_finish.status_code, 200, replayed_child_finish.data)
        self.assertEqual(replayed_child_finish.data, child_finished.data)
        self.assertEqual(self.action(child_finished.data, 'mes-finish').status_code, 409)
        # A replay of the parent's old operation cannot write through the child's adapter.
        replayed_parent_finish = self.action(saved.data, 'mes-finish', key=finish_key)
        self.assertEqual(replayed_parent_finish.status_code, 200, replayed_parent_finish.data)
        self.assertEqual(replayed_parent_finish.data, resolved.data)
        self.assertEqual([call[0] for call in parent_stage.calls], ['save', 'finish'])
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])
        self.assertEqual(len({call[1] for call in parent_stage.calls + self.stage.calls}), 4)
        parent.refresh_from_db()
        self.assertEqual(parent.status, 'approved')
        self.assertEqual(parent.judgement, 'fail')
        self.assertEqual(result_payload(parent), parent_result)
        self.assertEqual(digest(parent_result), case['original_result_digest'])
        self.assertEqual(InspectionNonconformance.objects.filter(request=parent).count(), 1)
        self.assertEqual(InspectionRequest.objects.filter(parent=parent).count(), 1)
        self.assertTrue(parent.audit.filter(action='reinspect', actor=self.editor).exists())
        self.assertTrue(InspectionRequest.objects.get(pk=child.data['id']).audit.filter(
            action='create_reinspection', actor=self.editor).exists())

    def _local_plan(self, now):
        # A local plan fixture is not a created MES work order or production task.
        self.production_actor = self.make_user('synthetic-production-operator', staff=True)
        return ProductionPlan.objects.create(
            plan_date=business_date(now), plan_type='injection', machine_name='imm02',
            part_no='SYNTHETIC-PART', lot_no='SYNTHETIC-LOT', sequence=1, planned_quantity=10,
        )

    def _upsert_production(self, plan, **changes):
        request_helpers.authenticate_inspection_client(self.client, self.production_actor)
        body = {
            'plan_date': plan.plan_date.isoformat(), 'plan_type': plan.plan_type,
            'machine_name': plan.machine_name, 'part_no': plan.part_no, 'lot_no': plan.lot_no,
            'sequence': plan.sequence, 'planned_quantity': plan.planned_quantity,
        }
        body.update(changes)
        response = self.client.post('/api/production/executions/upsert/', body, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def _kanban_machine(self, plan):
        request_helpers.authenticate_inspection_client(self.client, self.editor)
        response = self.client.get(self.base_url + 'kanban/', {'date': plan.plan_date.isoformat()})
        self.assertEqual(response.status_code, 200, response.data)
        machine = next(row for row in response.data['machines'] if row['machine_number'] == 2)
        return response.data, machine

    def _complete_fixture_qc(self, verdict, task_ref, plan, index, *, kind='first'):
        self.stage = stage_helpers.StageFixture()
        reviewed = self._reviewed(
            verdict, task_ref, equipment_ref=plan.machine_name, part_no=plan.part_no,
            lot_ref=plan.lot_no, inspection_type=kind,
        )
        binding = self._bind(reviewed, index)
        saved = self.action(reviewed, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        finished = self.action(saved.data, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual(finished.data['mes_completion_status'], 'completed')
        self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])
        return finished.data, binding

    def _board_fixture(self, data, binding, kind, observed_at):
        row = InspectionRequest.objects.get(pk=data['id'])
        # This normalization is test data construction, not a runtime provider.
        self.assertEqual(row.mes_completion_status, 'completed')
        return QualityObservation(
            tenant=binding.tenant, equipment_id=binding.contract['equipment_id'],
            work_order_id=binding.work_order_id,
            production_task_id=binding.contract['production_task_id'],
            qc_id=binding.qc_id, snapshot_id=binding.contract['snapshot_id'],
            kind=kind, snapshot_kind=kind, stage='ended',
            judgement='passed' if row.judgement == 'pass' else 'failed',
            checked_at=row.mes_checked_at, observed_at=observed_at,
            evidence_kind='synthetic_contract_fixture', enum_contract_reference='SYNTHETIC normalized enum',
        )

    def test_local_start_first_periodic_time_check_and_local_completion_keep_source_boundaries(self):
        started_at = datetime(2026, 10, 3, 2, tzinfo=datetime_timezone.utc)
        with patch('django.utils.timezone.now', return_value=started_at) as clock:
            plan = self._local_plan(started_at)
            started = self._upsert_production(
                plan, status='running', actual_qty=0, start_datetime=started_at.isoformat(),
            )
            self.assertEqual(started['status'], 'running')
            initial_execution = ProductionExecution.objects.values().get(pk=started['id'])
            clock.return_value = started_at + timedelta(minutes=1)
            first, first_binding = self._complete_fixture_qc('pass', 'SYNTHETIC-TASK-FLOW', plan, 1)
            clock.return_value = started_at + timedelta(minutes=2)
            periodic, periodic_binding = self._complete_fixture_qc(
                'pass', 'SYNTHETIC-TASK-FLOW', plan, 2, kind='process',
            )
            self.assertEqual(ProductionExecution.objects.values().get(pk=started['id']), initial_execution)
            checked_at = InspectionRequest.objects.get(pk=periodic['id']).mes_checked_at
            clock.return_value = checked_at + timedelta(seconds=1)
            kanban, machine = self._kanban_machine(plan)
            self.assertEqual(machine['plans'][0]['execution_status'], 'running')
            self.assertEqual(machine['requests'], [])
            self.assertEqual(machine['request_count'], 0)
            self.assertEqual(kanban['counts']['requests_displayed'], 0)
            self.assertEqual({row['request_id'] for row in kanban['integration_trials']},
                             {str(first['id']), str(periodic['id'])})
            for trial in kanban['integration_trials']:
                self.assertIs(trial['test_only'], True)
                self.assertIs(trial['production_counted'], False)
                self.assertEqual(trial['phase'], 'completed')
                self.assertEqual(trial['trial_verdict'], 'pass')
                self.assertIsNotNone(trial['observed_at'])
            self.assertFalse(kanban['mes_read_snapshot']['current_state_verified'])
            self.assertFalse(machine['dry_run']['enabled'])

            version = kanban['plan_snapshot']['version']
            scope = BoardScope(plan.plan_date, 2, plan.pk, version)
            bound = CurrentTaskBinding(
                first_binding.tenant, 2, first_binding.contract['equipment_id'], first_binding.work_order_id,
                first_binding.contract['production_task_id'], plan.pk, plan.plan_date, version, 1, True,
                'SYNTHETIC independently supplied binding', started_at, started_at + timedelta(hours=1),
            )
            observed_at = clock.return_value
            observations = (
                self._board_fixture(first, first_binding, 'first', observed_at),
                self._board_fixture(periodic, periodic_binding, 'periodic', observed_at),
            )
            read = ReadState('ok', observed_at, observed_at, 1, True, 120, None, version, 1)
            schedule = PeriodicSchedule(1, 'SYNTHETIC last-check-plus-60s policy',
                                        checked_at + timedelta(seconds=60), checked_at)
            def project(at, *, items=observations, read_state=read, target_scope=scope,
                        current_binding=bound, due=schedule):
                return project_machine_quality(
                    target_scope, bindings=(current_binding,), observations=items,
                    read=read_state, now=at, schedule=due,
                )

            # Honest application-fixture provenance cannot assert a live due state.
            fixture_board = project(observed_at)
            self.assertEqual(fixture_board['freshness'], 'fixture')
            self.assertEqual(fixture_board['periodic']['schedule_status'], 'unknown')
            self.assertEqual(fixture_board['first']['status'], 'unknown')
            self.assertFalse(fixture_board['complete'])
            # Separately exercise the upstream read contract that the reducer accepts.
            # These flags are simulated inputs only; no collector/provider is installed.
            read_contract = tuple(replace(row, evidence_kind='live_read') for row in observations)
            self.assertEqual(project(schedule.next_due_at, items=read_contract)['periodic']['schedule_status'], 'scheduled')
            overdue_at = schedule.next_due_at + timedelta(seconds=1)
            self.assertEqual(project(overdue_at, items=read_contract)['periodic']['schedule_status'], 'overdue')
            self.assertEqual(project(observed_at + timedelta(seconds=121), items=read_contract)['periodic']['schedule_status'], 'unknown')
            self.assertEqual(project(overdue_at, items=read_contract,
                due=replace(schedule, anchor_checked_at=started_at))['periodic']['schedule_status'], 'unverified')

            # Pause/resume is only the existing local upsert; it neither starts MES
            # machinery nor authorizes timer resets or new first-inspection creation.
            clock.return_value = overdue_at
            self._upsert_production(plan, status='paused')
            _, paused_machine = self._kanban_machine(plan)
            self.assertEqual(paused_machine['dry_run']['candidate'], 'review_resume')
            self.assertFalse(paused_machine['dry_run']['enabled'])
            self.assertEqual(paused_machine['dry_run']['requires_new_first_inspection_on_resume'], 'tenant_policy_unverified')
            resumed = self._upsert_production(plan, status='running')
            self.assertEqual(resumed['status'], 'running')
            self.assertEqual(InspectionRequest.objects.count(), 2)
            self.assertEqual(project(overdue_at, items=read_contract)['periodic']['schedule_status'], 'overdue')

            # An actual local plan revision invalidates the old read/binding scope.
            plan.planned_quantity = 12
            plan.save(update_fields=['planned_quantity', 'updated_at'])
            changed, _ = self._kanban_machine(plan)
            changed_version = changed['plan_snapshot']['version']
            self.assertNotEqual(changed_version, version)
            new_scope = replace(scope, plan_version=changed_version)
            old_binding_result = project(overdue_at, items=read_contract, target_scope=new_scope)
            self.assertEqual(old_binding_result['binding_status'], 'unresolved')
            self.assertEqual(old_binding_result['first']['checks'], [])
            changed_binding = replace(bound, plan_version=changed_version, generation=2)
            old_read_result = project(overdue_at, items=read_contract, target_scope=new_scope,
                                     current_binding=changed_binding)
            self.assertIn('read_scope_mismatch', old_read_result['warnings'])
            self.assertIsNone(old_read_result['periodic']['next_due_at'])

            before_completion = {row.pk: result_payload(row) for row in InspectionRequest.objects.all()}
            clock.return_value = overdue_at + timedelta(minutes=1)
            completed = self._upsert_production(
                plan, status='completed', actual_qty=12, end_datetime=clock.return_value.isoformat(),
            )
            self.assertEqual(completed['id'], started['id'])
            self.assertEqual(completed['status'], 'completed')
            self.assertIsNotNone(completed['end_datetime'])
            _, completed_machine = self._kanban_machine(plan)
            self.assertEqual(completed_machine['plans'][0]['execution_status'], 'completed')
            self.assertEqual({row.pk: result_payload(row) for row in InspectionRequest.objects.all()}, before_completion)
            self.assertEqual(InspectionRequest.objects.count(), 2)
            self.assertEqual(InspectionNonconformance.objects.count(), 0)
            self.assertEqual(completed_machine['requests'], [])
            for record in InspectionRequest.objects.filter(pk__in=[first['id'], periodic['id']]):
                self.assertEqual(record.injection_receipt_readiness, 'not_verified')
            self.assertFalse(completed_machine['dry_run']['enabled'])

            # A normal unbound production request remains on the same machine;
            # trial exclusion must not remove all requests for its plan.
            normal = self.create(task_ref='SYNTHETIC-ORDINARY-PRODUCTION',
                equipment_ref=plan.machine_name, part_no=plan.part_no, lot_ref=plan.lot_no)
            clock.return_value += timedelta(seconds=1)
            separated, production_machine = self._kanban_machine(plan)
            self.assertEqual([row['id'] for row in production_machine['requests']], [normal['id']])
            self.assertEqual(production_machine['request_count'], 1)
            self.assertEqual(separated['counts']['requests_displayed'], 1)
            production = production_machine['requests'][0]
            self.assertEqual(production['plan_alignment']['status'], 'part_listed')
            self.assertFalse(production['plan_alignment']['task_binding_verified'])
            self.assertEqual({row['request_id'] for row in separated['integration_trials']},
                             {str(first['id']), str(periodic['id'])})

    def test_local_completion_currently_has_no_gate_for_open_case_or_draft_reinspection(self):
        """Characterize the missing gate; acceptance here is not safe MES completion."""
        started_at = datetime(2026, 10, 3, 2, tzinfo=datetime_timezone.utc)
        with patch('django.utils.timezone.now', return_value=started_at) as clock:
            plan = self._local_plan(started_at)
            self._upsert_production(plan, status='running', start_datetime=started_at.isoformat(), actual_qty=0)
            clock.return_value = started_at + timedelta(minutes=1)
            failed, _ = self._complete_fixture_qc('fail', 'SYNTHETIC-TASK-MISSING-GATE', plan, 1)
            child = self.action(failed, 'reinspect', reason='SYNTHETIC unfinished reinspection')
            self.assertEqual(child.status_code, 201, child.data)
            self.assertEqual(child.data['status'], 'draft')
            self.assertEqual(child.data['mes_completion_status'], 'not_completed')
            case = InspectionNonconformance.objects.values().get(request_id=failed['id'])
            clock.return_value = started_at + timedelta(minutes=2)
            _, before_machine = self._kanban_machine(plan)
            self.assertIn('inspection_completion_unverified', before_machine['dry_run']['blocking_reasons'])
            requests_before = list(InspectionRequest.objects.order_by('pk').values())
            operations_before = list(InspectionOperation.objects.order_by('pk').values())
            completed = self._upsert_production(
                plan, status='completed', actual_qty=3, defect_qty=1,
                end_datetime=clock.return_value.isoformat(),
            )
            # Explicit local status currently wins even below the plan quantity.
            self.assertEqual(completed['status'], 'completed')
            self.assertEqual(completed['actual_qty'], 3)
            self.assertEqual(list(InspectionRequest.objects.order_by('pk').values()), requests_before)
            self.assertEqual(list(InspectionOperation.objects.order_by('pk').values()), operations_before)
            self.assertEqual(InspectionNonconformance.objects.values().get(pk=case['id']), case)
            self.assertEqual(case['state'], 'open')
            _, after_machine = self._kanban_machine(plan)
            self.assertEqual(after_machine['plans'][0]['execution_status'], 'completed')
            self.assertIn('inspection_completion_unverified', after_machine['dry_run']['blocking_reasons'])
            self.assertFalse(after_machine['dry_run']['enabled'])
            self.assertEqual([call[0] for call in self.stage.calls], ['save', 'finish'])
