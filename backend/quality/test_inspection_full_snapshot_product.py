"""Real integrated WJ rows with a synthetic MES provider; no live credentials."""
from copy import deepcopy
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch
import uuid

from django.db import transaction
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient
from mes_oauth.session_guard import InspectionSession

from . import test_inspection_full_snapshot as provider_fixtures
from .inspection_full_snapshot import (
    ExecutorAuthority, FullSnapshotCoordinator, FullSnapshotError, OWNER,
    binding_fingerprint, fingerprint, validate_source,
)
from .inspection_full_snapshot_connection import ReviewedFullSnapshotConnection
from .inspection_full_snapshot_product import (
    FullSnapshotProductConnection, ProductExecutorGuard, _approved, load_connection, product_summary,
)
from .inspection_full_snapshot_source import DjangoCompletedSource
from .inspection_models import InspectionAudit, InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_role_models import InspectionAreaResult
from .inspection_roles import area_complete
from .inspection_validation import digest
from .inspection_workflow import local_action, lock_scope, result_payload
from .test_inspection_requests import authenticate_inspection_client, inspection_session
from .test_inspection_roles import RoleFixtures


class FullSnapshotProductSourceTests(RoleFixtures, TestCase):
    def setUp(self):
        super().setUp()
        self.configure(shared_terminal=True)
        self.adapter = provider_fixtures.FixtureAdapter()
        self.adapter.remote['config_keys'].append(
            {'config_row_id': '1103', 'group': 'SYNTHETIC', 'seq': 1})

    def completed_areas(self, *, include_optional=True, dimension_fail=False):
        self.action(area_complete, 'appearance', self.payload('appearance',
            inspector_id=self.appearance.pk, measurements=[self.measure('appearance')], judgement='pass'),
            user=self.admin)
        measurements = [self.measure('dimension', value='12' if dimension_fail else '10',
                                     judgement='fail' if dimension_fail else 'pass')]
        if include_optional:
            measurements.append({'item_id': 'size-optional', 'value': 'SYNTHETIC optional reading',
                                 'judgement': 'pass'})
        self.action(area_complete, 'dimension', self.payload('dimension',
            inspector_id=self.dimension.pk, measurements=measurements,
            judgement='fail' if dimension_fail else 'pass'), user=self.admin)

    def approve(self, judgement='pass'):
        submitted, _ = local_action(self.admin, self.request.pk, 'submit', uuid.uuid4(), {
            'version': self.request_now().version, 'judgement': judgement,
            'reason': 'SYNTHETIC explicit final decision',
        }, session=inspection_session(self.admin))
        action = 'review-failure' if judgement == 'fail' else 'approve'
        reviewed, _ = local_action(self.outsider, self.request.pk, action, uuid.uuid4(), {
            'version': submitted['version'], 'reason': 'SYNTHETIC independent review',
        }, session=inspection_session(self.outsider))
        self.assertEqual(reviewed['status'], 'approved')
        return self.request_now()

    def capture(self):
        with transaction.atomic():
            lock_scope(f'inspection:{self.request.pk}')
            request = InspectionRequest.objects.select_for_update().get(pk=self.request.pk)
            return DjangoCompletedSource.capture(request)

    def bind(self):
        request = self.request_now()
        return InspectionMesBinding.objects.create(
            request=request, tenant='SYNTHETIC-TENANT', qc_id='1001', work_order_id='',
            test_only=True, test_label='SYNTHETIC PRODUCT FIXTURE ONLY',
            reviewed_result_digest=digest(result_payload(request)), contract={
                'snapshot_id': '1002', 'actor_id': '501', 'context': 'standalone_test',
                'items': [{'local_item_id': item, 'config_row_id': str(1101 + index),
                           'write_item_id': str(2101 + index), 'group': 'SYNTHETIC', 'seq': 1}
                          for index, item in enumerate(('look', 'size', 'size-optional'))],
            },
        )

    def guard(self, actor, request, binding, stage):
        # Existing credential/session behavior is separately integration-tested.
        # This server-authority fixture supplies no credential or issuer.
        return ExecutorAuthority(actor_id=actor.pk, mes_user_id='501', tenant=binding.tenant,
            qc_id=binding.qc_id, snapshot_id='1002', expires_at=timezone.now() + timedelta(minutes=5),
            review_reference='SYNTHETIC-reviewed-product', concurrency_reference='SYNTHETIC-provider-CAS',
            concurrency_mode='provider_cas')

    def coordinator(self):
        return FullSnapshotCoordinator(source=DjangoCompletedSource, executor_guard=self.guard,
                                       adapter=self.adapter)

    def assert_code(self, code, callback):
        with self.assertRaises(FullSnapshotError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def assert_no_mes_operation(self):
        self.assertFalse(InspectionOperation.objects.filter(response__owner=OWNER).exists())
        self.assertEqual(self.adapter.calls, [])

    def test_real_completed_source_keeps_terminal_item_completion_and_historical_actors(self):
        self.completed_areas()
        source, values = validate_source(self.capture())
        self.assertEqual(values, {'look': 'OK', 'size': '10', 'size-optional': 'SYNTHETIC optional reading'})
        self.assertEqual(source['terminal'], {'id': self.admin.pk, 'name': self.admin.username})
        for area in source['areas']:
            inspector = self.appearance if area['area'] == 'appearance' else self.dimension
            self.assertEqual(area['completion']['inspector']['id'], inspector.pk)
            self.assertEqual(area['completion']['recorder']['id'], self.admin.pk)
            self.assertEqual({author['inspector_id'] for author in area['authorship'].values()}, {inspector.pk})
            self.assertEqual({author['recorded_by_id'] for author in area['authorship'].values()}, {self.admin.pk})
        self.assertEqual({row['actor_id'] for row in source['historical_contributors']}, {self.admin.pk})
        self.appearance.first_name = 'SYNTHETIC changed current display name'
        self.appearance.save(update_fields=['first_name'])
        recaptured = self.capture()
        self.assertEqual(recaptured['areas'], source['areas'])
        self.assertEqual(recaptured['actor_snapshot'], source['actor_snapshot'])

    def test_actual_independent_final_approval_is_retained_in_the_whole_saved_intent(self):
        self.completed_areas()
        request = self.approve()
        binding = self.bind()
        source = self.capture()
        self.assertEqual(source['approval']['submitter']['id'], self.admin.pk)
        self.assertEqual(source['approval']['reviewer']['id'], self.outsider.pk)
        self.assertEqual(source['approval']['submitted_at'], request.submitted_at.isoformat())
        self.assertEqual(source['approval']['reviewed_at'], request.reviewed_at.isoformat())
        self.assertEqual(source['approval']['result_digest'], binding.reviewed_result_digest)
        source_digest = fingerprint(source)
        key = uuid.uuid4()
        saved = self.coordinator().run(self.admin, request.pk, key, source_digest=source_digest)
        self.assertEqual(saved['status'], 'succeeded')
        operation = InspectionOperation.objects.get(pk=saved['operation_id'])
        self.assertEqual(operation.response['intent']['source'], source)
        request.refresh_from_db()
        self.assertEqual(request.mes_checked_at, datetime.fromisoformat(operation.response['readback']['observed_at']))
        self.assertEqual(len(operation.response['intent']['payload']['checkItems']), 3)
        self.assertEqual([row['result'] for row in operation.response['intent']['payload']['checkItems']],
                         ['OK', '10', 'SYNTHETIC optional reading'])
        self.assertEqual(self.coordinator().run(self.admin, request.pk, key, source_digest=source_digest), saved)
        self.assert_code('stage_already_reserved', lambda: self.coordinator().run(
            self.admin, request.pk, uuid.uuid4(), source_digest=source_digest))
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])
        finished = self.coordinator().run(self.admin, request.pk, uuid.uuid4(),
                                          source_digest=source_digest, stage='finish')
        self.assertEqual(finished['status'], 'succeeded')
        self.assertEqual([call[0] for call in self.adapter.calls], ['save', 'finish'])
        request.refresh_from_db()
        self.assertEqual(request.mes_completion_status, 'completed')
        finished_operation = InspectionOperation.objects.get(pk=finished['operation_id'])
        self.assertEqual(request.mes_checked_at,
                         datetime.fromisoformat(finished_operation.response['readback']['observed_at']))

    def test_optional_but_configured_item_cannot_be_omitted_from_provider_whole_snapshot(self):
        self.completed_areas(include_optional=False)
        self.approve()
        self.bind()
        source = self.capture()
        self.assert_code('missing_item_provenance', lambda: self.coordinator().run(
            self.admin, self.request.pk, uuid.uuid4(), source_digest=fingerprint(source)))
        self.assert_no_mes_operation()

    def test_real_missing_completion_recorder_cannot_be_inferred_from_terminal(self):
        self.completed_areas()
        self.approve()
        self.bind()
        InspectionAreaResult.objects.filter(workflow=self.workflow, area='appearance').update(
            completed_recorded_by=None, completed_recorded_by_name='')
        source = self.capture()
        self.assert_code('missing_actor_provenance', lambda: self.coordinator().run(
            self.admin, self.request.pk, uuid.uuid4(), source_digest=fingerprint(source)))
        self.assert_no_mes_operation()

    def test_independent_final_fail_preserves_passing_measurements_and_sends_fail_verdict(self):
        self.completed_areas()
        self.approve('fail')
        self.bind()
        source = self.capture()
        self.assertTrue(all(area['judgement'] == 'pass' for area in source['areas']))
        self.assertEqual(validate_source(source)[0]['judgement'], 'fail')
        source_digest = fingerprint(source)
        saved = self.coordinator().run(self.admin, self.request.pk, uuid.uuid4(), source_digest=source_digest)
        self.assertEqual(saved['status'], 'succeeded')
        finished = self.coordinator().run(self.admin, self.request.pk, uuid.uuid4(),
                                          source_digest=source_digest, stage='finish')
        self.assertEqual(finished['status'], 'succeeded')
        self.assertEqual(self.adapter.remote['verdict'], 'fail')

    def test_independently_approved_concession_has_no_reviewed_provider_verdict(self):
        self.completed_areas(dimension_fail=True)
        self.approve('concession')
        self.bind()
        source = self.capture()
        self.assertEqual(source['judgement'], 'concession')
        self.assert_code('invalid_judgement', lambda: self.coordinator().run(
            self.admin, self.request.pk, uuid.uuid4(), source_digest=fingerprint(source)))
        self.assert_no_mes_operation()

    def test_historical_recorder_cannot_become_final_reviewer_after_completion(self):
        self.completed_areas()
        self.approve()
        self.bind()
        InspectionAudit.objects.create(request=self.request, actor=self.outsider,
            actor_name=self.outsider.username, action='role_appearance_save',
            version=self.request_now().version, status='draft')
        source = self.capture()
        self.assert_code('independent_reviewer_required', lambda: self.coordinator().run(
            self.admin, self.request.pk, uuid.uuid4(), source_digest=fingerprint(source)))
        self.assert_no_mes_operation()

    def reviewed_product_policy(self, binding, source):
        return ReviewedFullSnapshotConnection(
            request_id=self.request.pk, actor_id=self.admin.pk, reviewer_actor_id=self.outsider.pk,
            tenant=binding.tenant, mes_user_id=501, qc_id=binding.qc_id,
            qc_code='SYNTHETIC QC', snapshot_id='1002', binding_digest=binding_fingerprint(binding),
            source_digest=fingerprint(source), source_request_version=source['request_version'],
            expires_at=timezone.now() + timedelta(minutes=5), review_reference='SYNTHETIC-product-review',
            detail_review=SimpleNamespace(qc_code='SYNTHETIC QC'), write_authorized=True,
            concurrency_mode='provider_cas', concurrency_reference='SYNTHETIC-product-provider-CAS',
            residual_remote_race=False,
        )

    def test_current_display_name_changes_preserve_historical_final_approval_actor_snapshots(self):
        self.completed_areas()
        self.approve()
        source = self.capture()
        self.admin.first_name = 'SYNTHETIC renamed terminal operator'
        self.admin.save(update_fields=['first_name'])
        self.outsider.first_name = 'SYNTHETIC renamed reviewer'
        self.outsider.save(update_fields=['first_name'])
        self.assertEqual(self.capture()['approval'], source['approval'])

    def test_altered_current_review_reason_invalidates_persisted_approval_proof(self):
        self.completed_areas()
        self.approve()
        InspectionRequest.objects.filter(pk=self.request.pk).update(review_reason='SYNTHETIC changed review')
        self.assert_code('independent_approval_changed', self.capture)
        self.assert_no_mes_operation()

    def test_binding_reviewed_digest_must_match_actual_independent_approved_result(self):
        self.completed_areas()
        request = self.approve()
        binding = self.bind()
        source = self.capture()
        binding.reviewed_result_digest = '0' * 64
        binding.save(update_fields=['reviewed_result_digest'])
        policy = self.reviewed_product_policy(binding, source)
        self.assert_code('independent_approval_changed', lambda: _approved(request, binding, policy))
        self.assert_no_mes_operation()

    def test_default_empty_registry_exposes_blocked_summary_and_route_without_any_credential_call(self):
        self.completed_areas()
        self.approve()
        self.bind()
        client = APIClient()
        authenticate_inspection_client(client, self.admin)
        with override_settings(INSPECTION_FULL_SNAPSHOT_CONNECTIONS={}), \
             patch('mes_oauth.app_tokens.get_app_access_token', side_effect=AssertionError('issuance forbidden')), \
             patch('mes_oauth.app_tokens.get_existing_app_access_token', side_effect=AssertionError('lease forbidden')), \
             patch('mes_oauth.inspection_credentials.call_with_user_credential', side_effect=AssertionError('lease forbidden')):
            summary = product_summary(self.request_now(), self.admin)
            self.assertFalse(summary['enabled'])
            self.assertFalse(summary['can_save'])
            self.assertEqual(summary['blocked_reason'], 'whole_connection_review_required')
            response = client.post(f'/api/quality/inspection-requests/{self.request.pk}/mes-full-save/',
                {'source_digest': fingerprint(self.capture())}, format='json',
                HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 503, response.data)
        self.assertEqual(response.data['code'], 'whole_connection_review_required')
        self.assert_no_mes_operation()

    def test_registered_product_routes_save_all_items_then_finish_and_replay_without_resend(self):
        self.completed_areas()
        self.approve()
        binding = self.bind()
        source = self.capture()
        policy = self.reviewed_product_policy(binding, source)
        connection = FullSnapshotProductConnection(policy, atomic_writer=lambda *args: None)
        client = APIClient()
        authenticate_inspection_client(client, self.admin)

        def synthetic_coordinator(user, request_id, session):
            reviewed = load_connection(request_id)
            self.assertIs(reviewed, connection)
            self.assertEqual(user.pk, policy.actor_id)
            with transaction.atomic():
                lock_scope(f'inspection:{request_id}')
                current = InspectionRequest.objects.select_for_update().get(pk=request_id)
                target = InspectionMesBinding.objects.select_for_update().get(request=current)
                _approved(current, target, reviewed.policy)
            return self.coordinator()

        payload = {'source_digest': policy.source_digest}
        key = str(uuid.uuid4())
        route = f'/api/quality/inspection-requests/{self.request.pk}/mes-full-save/'
        with override_settings(INSPECTION_FULL_SNAPSHOT_CONNECTIONS={self.request.pk: connection},
                               MES_USER_OAUTH_USER_MAP={str(self.admin.pk): '501'}), \
             patch('quality.inspection_full_snapshot_product.get_coordinator', side_effect=synthetic_coordinator):
            before = product_summary(self.request_now(), self.admin)
            self.assertTrue(before['can_save'], before)
            self.assertFalse(before['can_finish'])
            saved = client.post(route, payload, format='json', HTTP_IDEMPOTENCY_KEY=key)
            self.assertEqual(saved.status_code, 200, saved.data)
            self.assertEqual(saved.data['whole_snapshot_operation']['status'], 'succeeded')
            replay = client.post(route, payload, format='json', HTTP_IDEMPOTENCY_KEY=key)
            self.assertEqual(replay.status_code, 200, replay.data)
            self.assertEqual([call[0] for call in self.adapter.calls], ['save'])
            ready = product_summary(self.request_now(), self.admin)
            self.assertFalse(ready['can_save'])
            self.assertTrue(ready['can_finish'], ready)
            finished = client.post(f'/api/quality/inspection-requests/{self.request.pk}/mes-full-finish/',
                payload, format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
            self.assertEqual(finished.status_code, 200, finished.data)
            self.assertEqual(finished.data['whole_snapshot_operation']['status'], 'succeeded')
            self.assertEqual([call[0] for call in self.adapter.calls], ['save', 'finish'])
            self.assertEqual(finished.data['mes_completion_status'], 'completed')

    def test_replacing_connection_with_same_policy_and_revoked_writer_blocks_reserved_dispatch(self):
        self.completed_areas()
        request = self.approve()
        binding = self.bind()
        source = self.capture()
        policy = self.reviewed_product_policy(binding, source)
        connection = FullSnapshotProductConnection(policy, atomic_writer=lambda *args: None)
        registry = {request.pk: connection}
        session = InspectionSession(self.admin.pk, 'f' * 64,
            timezone.now() + timedelta(minutes=5), {}, version=2)
        guard = ProductExecutorGuard(connection, session)

        def guarded_authority(actor, current, target, stage):
            # Run the actual product/current-policy checks; the existing
            # credential broker tests cover credential issuance/admission.
            guard._check_policy(actor, current, target, stage)
            return self.guard(actor, current, target, stage)

        def revoke_hook_after_initial_read(count):
            if count == 1:
                registry[request.pk] = FullSnapshotProductConnection(policy, atomic_writer=None)
        self.adapter.on_read = revoke_hook_after_initial_read
        coordinator = FullSnapshotCoordinator(source=DjangoCompletedSource,
            executor_guard=guarded_authority, adapter=self.adapter)
        with override_settings(INSPECTION_FULL_SNAPSHOT_CONNECTIONS=registry,
                MES_USER_OAUTH_PROVIDER_ORIGIN=policy.origin,
                MES_USER_OAUTH_APP_TOKEN_HEADER=policy.app_token_header):
            result = coordinator.run(self.admin, request.pk, uuid.uuid4(), source_digest=policy.source_digest)
        self.assertIs(registry[request.pk].policy, policy)
        self.assertIsNone(registry[request.pk].atomic_writer)
        self.assertEqual((result['status'], result['code']), ('blocked', 'whole_connection_review_changed'))
        self.assertEqual(self.adapter.calls, [])
        self.assertEqual(InspectionOperation.objects.get(pk=result['operation_id']).status, 'blocked')

    def test_recomputed_aggregate_audit_binding_and_policy_cannot_cover_discrepant_area_measurements(self):
        self.completed_areas()
        request = self.approve()
        binding = self.bind()
        candidate_source = self.capture()
        altered_aggregate = deepcopy(request.measurements)
        next(row for row in altered_aggregate if row['item_id'] == 'size')['value'] = '10.2'
        request.measurements = altered_aggregate
        request.save(update_fields=['measurements'])
        changed_digest = digest(result_payload(request))
        InspectionAudit.objects.filter(request=request, action__in=['submit', 'approve']).update(
            result_digest=changed_digest)
        binding.reviewed_result_digest = changed_digest
        binding.save(update_fields=['reviewed_result_digest'])
        candidate_source['approval']['result_digest'] = changed_digest
        candidate_source['approval']['submit_audit']['result_digest'] = changed_digest
        candidate_source['approval']['review_audit']['result_digest'] = changed_digest
        policy = self.reviewed_product_policy(binding, candidate_source)
        self.assertTrue(policy.matches(request, binding))
        self.assertEqual(InspectionAreaResult.objects.get(workflow=self.workflow, area='dimension')
                         .measurements[0]['value'], '10')
        self.assert_code('independent_approval_changed', lambda: _approved(request, binding, policy))
        self.assert_code('independent_approval_changed', lambda: self.coordinator().run(
            self.admin, request.pk, uuid.uuid4(), source_digest=policy.source_digest))
        self.assert_no_mes_operation()

    def route_status_case(self, *, timeout):
        self.completed_areas()
        self.approve()
        binding = self.bind()
        source = self.capture()
        policy = self.reviewed_product_policy(binding, source)
        connection = FullSnapshotProductConnection(policy, atomic_writer=lambda *args: None)
        if timeout:
            self.adapter.save_timeout = True
        else:
            def concurrent_revision(count):
                if count == 2:
                    self.adapter.remote['config_digest'] = fingerprint({'synthetic_config': 8})
            self.adapter.on_read = concurrent_revision
        client = APIClient()
        authenticate_inspection_client(client, self.admin)
        key = str(uuid.uuid4())
        route = f'/api/quality/inspection-requests/{self.request.pk}/mes-full-save/'
        payload = {'source_digest': policy.source_digest}
        coordinator = self.coordinator()
        with override_settings(INSPECTION_FULL_SNAPSHOT_CONNECTIONS={self.request.pk: connection},
                               MES_USER_OAUTH_USER_MAP={str(self.admin.pk): '501'}), \
             patch('quality.inspection_full_snapshot_product.get_coordinator', return_value=coordinator):
            first = client.post(route, payload, format='json', HTTP_IDEMPOTENCY_KEY=key)
            replay = client.post(route, payload, format='json', HTTP_IDEMPOTENCY_KEY=key)
            retry = client.post(route, payload, format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(replay.status_code, first.status_code)
        self.assertEqual(replay.data['whole_snapshot_operation'], first.data['whole_snapshot_operation'])
        self.assertEqual(retry.status_code, 409, retry.data)
        self.assertEqual(InspectionOperation.objects.filter(response__owner=OWNER).count(), 1)
        return first

    def test_blocked_route_returns_conflict_and_replays_same_durable_ledger_without_dispatch(self):
        response = self.route_status_case(timeout=False)
        self.assertEqual(response.status_code, 409, response.data)
        receipt = response.data['whole_snapshot_operation']
        self.assertEqual((receipt['status'], response.data['code']), ('blocked', 'mes_concurrent_change'))
        operation = InspectionOperation.objects.get(pk=receipt['operation_id'])
        self.assertEqual(operation.status, 'blocked')
        self.assertEqual(operation.response['state'], 'blocked')
        self.assertEqual(self.adapter.calls, [])

    def test_unknown_route_returns_unavailable_and_replays_same_durable_ledger_without_resend(self):
        response = self.route_status_case(timeout=True)
        self.assertEqual(response.status_code, 503, response.data)
        receipt = response.data['whole_snapshot_operation']
        self.assertEqual((receipt['status'], response.data['code']), ('unknown', 'mes_outcome_unknown'))
        operation = InspectionOperation.objects.get(pk=receipt['operation_id'])
        self.assertEqual(operation.status, 'unknown')
        self.assertEqual(operation.response['state'], 'unknown')
        self.assertEqual([call[0] for call in self.adapter.calls], ['save'])

    def test_actual_whole_save_finish_projects_verified_trial_without_production_count(self):
        from .inspection_kanban import _trial_projection, projection
        self.completed_areas()
        self.approve()
        binding = self.bind()
        binding.contract['qc_code'] = 'SYNTHETIC WHOLE QC'
        binding.save(update_fields=['contract'])
        source_digest = fingerprint(self.capture())
        saved = self.coordinator().run(self.admin, self.request.pk, uuid.uuid4(), source_digest=source_digest)
        self.assertEqual(saved['status'], 'succeeded')
        request = InspectionRequest.objects.select_related('mes_binding').get(pk=self.request.pk)
        saved_readback = InspectionOperation.objects.get(pk=saved['operation_id']).response['readback']
        self.assertEqual(request.mes_binding.phase, 'full_saved')
        saved_trial = _trial_projection(request, now=timezone.now())
        self.assertEqual(saved_trial['phase'], 'saved')
        self.assertIsNone(saved_trial['trial_verdict'])
        self.assertEqual(saved_trial['observed_at'], saved_readback['observed_at'])
        self.assertTrue(saved_trial['test_only'])
        self.assertFalse(saved_trial['production_counted'])

        finished = self.coordinator().run(self.admin, self.request.pk, uuid.uuid4(),
                                          source_digest=source_digest, stage='finish')
        self.assertEqual(finished['status'], 'succeeded')
        request = InspectionRequest.objects.select_related('mes_binding').get(pk=self.request.pk)
        readback = InspectionOperation.objects.get(pk=finished['operation_id']).response['readback']
        self.assertEqual(request.mes_binding.phase, 'full_completed')
        observed = datetime.fromisoformat(readback['observed_at'])
        self.assertEqual(request.mes_checked_at, observed)
        self.assertEqual(request.mes_binding.last_verified_at, observed)
        self.assertEqual(request.mes_snapshot['verified_trial']['observed_at'], readback['observed_at'])
        trial = _trial_projection(request, now=timezone.now())
        self.assertEqual((trial['phase'], trial['trial_verdict']), ('completed', 'pass'))
        self.assertEqual(trial['observed_at'], readback['observed_at'])
        self.assertEqual(trial['qc_code'], 'SYNTHETIC WHOLE QC')
        self.assertTrue(trial['test_only'])
        self.assertFalse(trial['production_counted'])

        with patch('quality.inspection_kanban.get_read_batch', return_value=None):
            board = projection(self.admin, now=timezone.now())
        self.assertEqual(board['integration_trials'], [trial])
        self.assertEqual(board['counts']['requests_displayed'], 0)
        self.assertEqual(board['unmapped_requests'], [])
        self.assertTrue(all(machine['request_count'] == 0 for machine in board['machines']))
