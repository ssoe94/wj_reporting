"""Synthetic credential/transport integration, never real HTTP or token issuance."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch
import json
import uuid

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import TestCase, override_settings
from django.utils import timezone

from mes_oauth.models import MESCredentialEvent
from mes_oauth.session_guard import InspectionSession
from mes_oauth.vault import VaultBlocked

from . import test_inspection_full_snapshot as source_fixtures
from . import test_inspection_full_snapshot_readback as detail_fixtures
from .inspection_full_snapshot import (
    CredentialGuardFailure, FullSnapshotCoordinator, FullSnapshotError,
    binding_fingerprint, fingerprint,
)
from .inspection_full_snapshot_authority import CurrentExecutorGuard, ReuseOnlyIdentityProvider
from .inspection_full_snapshot_connection import BlacklakeFullSnapshotAdapter, ReviewedFullSnapshotConnection
from .inspection_full_snapshot_source import DjangoCompletedSource
from .inspection_models import InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_role_models import InspectionRoleWorkflow
from .inspection_transport import InspectionUserAccessToken


@override_settings(MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
                   MES_USER_OAUTH_APP_TOKEN_HEADER='access_token')
class FullSnapshotConnectionTests(TestCase):
    def setUp(self):
        self.actor = get_user_model().objects.create_user(
            username='SYNTHETIC-connection-executor', is_superuser=True, is_staff=True)
        self.reviewer = get_user_model().objects.create_user(
            username='SYNTHETIC-independent-reviewer', is_superuser=True, is_staff=True)
        self.request = InspectionRequest.objects.create(
            identity=fingerprint({'synthetic': 'connection'}),
            work_order_ref='SYNTHETIC-WO', task_ref='SYNTHETIC-TASK',
            part_no='SYNTHETIC-PART', equipment_ref='SYNTHETIC-EQUIPMENT',
            target_quantity=0, uom='SYNTHETIC-UOM', warehouse_ref='SYNTHETIC-WAREHOUSE',
            lot_ref='SYNTHETIC-LOT', work_started_at=timezone.now(),
            assigned_to=self.actor, assigned_to_name='SYNTHETIC executor',
            quantity_mode='not_recorded', judgement='pass',
        )
        dto = detail_fixtures.FullDetailDecoderTests()
        dto.setUp()
        self.envelope, self.detail_review = deepcopy(dto.envelope), dto.review
        self.envelope['data']['checkItems'][0]['qcTaskCheckItems'][0]['result'] = '10.1'
        self.binding = InspectionMesBinding.objects.create(
            request=self.request, tenant='SYNTHETIC-TENANT', qc_id='31', work_order_id='',
            test_only=True, test_label='SYNTHETIC ONLY', reviewed_result_digest='',
            contract={**deepcopy(dto.binding.contract), 'context': 'standalone_test'},
        )
        self.source = source_fixtures.FixtureSource(source_fixtures.synthetic_source(self.request.pk))
        self.policy = ReviewedFullSnapshotConnection(
            request_id=self.request.pk, actor_id=self.actor.pk, reviewer_actor_id=self.reviewer.pk,
            tenant=self.binding.tenant, mes_user_id=101, qc_id='31', qc_code='SYNTHETIC QC',
            snapshot_id='32', binding_digest=binding_fingerprint(self.binding),
            source_digest=fingerprint(self.source.data), source_request_version=1,
            expires_at=timezone.now() + timedelta(minutes=5), review_reference='SYNTHETIC-review',
            detail_review=self.detail_review, write_authorized=True,
            concurrency_mode='reviewed_single_writer_trial', concurrency_reference='SYNTHETIC-single-writer',
            operational_conditions_reference='SYNTHETIC-conditions', residual_remote_race=True,
        )
        self.session = InspectionSession(
            actor_id=self.actor.pk, login_digest='f' * 64,
            expires_at=timezone.now() + timedelta(minutes=10), claims={}, version=2,
            effective_expires_at=timezone.now() + timedelta(minutes=10),
        )
        self.lease = InspectionUserAccessToken('SYNTHETIC-USER-CREDENTIAL',
                    (timezone.now() + timedelta(minutes=5)).timestamp(), user_id=101)
        self.identity_provider = Mock(name='synthetic_reuse_identity_provider')
        self.calls, self.broker_calls, self.lock_events = [], [], []
        self.actor_lock_depth = 0
        self.detail_calls = 0
        self.before_detail = None
        self.broker_failure = None
        self.original_capture = DjangoCompletedSource.capture
        source_patch = patch.object(DjangoCompletedSource, 'capture', side_effect=self.source.capture)
        source_patch.start()
        self.addCleanup(source_patch.stop)
        contributor_patch = patch('quality.inspection_roles.is_area_contributor',
                                  return_value=False, create=True)
        self.contributor_mock = contributor_patch.start()
        self.addCleanup(contributor_patch.stop)

        @contextmanager
        def synthetic_session_lock(session, permission, *, actor_id, mes_actor=None, require_mapping=False):
            self.assertEqual((actor_id, mes_actor, require_mapping), (self.actor.pk, 101, True))
            self.lock_events.append('actor')
            with transaction.atomic():
                current = get_user_model().objects.select_for_update().get(pk=actor_id)
                self.actor_lock_depth += 1
                try:
                    yield current
                finally:
                    self.actor_lock_depth -= 1
        session_patch = patch.object(InspectionSession, 'lock', synthetic_session_lock)
        session_patch.start()
        self.addCleanup(session_patch.stop)

    def broker(self, session, *, mes_user_id, tenant, contract_reference,
               policy_check, operation, callback, provider):
        self.broker_calls.append(operation)
        self.assertIs(session, self.session)
        self.assertEqual((mes_user_id, tenant, contract_reference),
                         (101, self.binding.tenant, 'SYNTHETIC-review'))
        self.assertIs(provider, self.identity_provider)
        failure, result = None, None
        with session.lock('view' if operation == 'read' else 'submit',
                          actor_id=self.actor.pk, mes_actor=101, require_mapping=True):
            self.assertTrue(policy_check())
            try:
                if self.broker_failure:
                    self.broker_failure()
                result = callback(self.lease)
            except VaultBlocked as error:
                # Mirror the real broker's cleanup commit before fixed rejection.
                failure = error
        if failure is not None:
            raise failure
        return result

    def sender(self, url, *, params, data, headers, timeout, allow_redirects):
        self.assertEqual(params, {'access_token': self.lease.value})
        self.assertFalse(allow_redirects)
        body = json.loads(data)
        endpoint = url.rsplit('/', 1)[-1]
        self.calls.append((endpoint, deepcopy(body)))
        if endpoint == '_detail':
            self.assertEqual(body, {'id': 31})
            self.detail_calls += 1
            if self.before_detail:
                self.before_detail(self.detail_calls)
            response = self.envelope
        elif endpoint == '_update_task_check_item':
            self.assertEqual(body['taskId'], 31)
            self.assertEqual({row['checkItemId'] for row in body['checkItems']}, {501, 502})
            now_ms = int(timezone.now().timestamp() * 1000)
            rows = [{'id': 1501 + index, 'qcConfigCheckItemId': 401 + index,
                     'seq': row['seq'], 'result': row['result'], 'operator': {'id': 101},
                     'createdAt': now_ms, 'updatedAt': now_ms}
                    for index, row in enumerate(body['checkItems'])]
            self.envelope['data']['checkItems'] = [{'groupName': 'SYNTHETIC group', 'qcTaskCheckItems': rows}]
            response = {'code': 200, 'needCheck': 0, 'data': True}
        elif endpoint == '_finish':
            self.assertEqual(body, {'id': 31, 'status': 1})
            self.envelope['data'].update(status={'code': 2}, inspectionResult={'code': 1},
                                         endTime=int(timezone.now().timestamp() * 1000))
            response = {'code': 200, 'needCheck': 0}
        else:
            self.fail('Unexpected synthetic endpoint')
        return SimpleNamespace(status_code=200, content=json.dumps(response).encode())

    def connection(self, policy=None):
        policy = policy or self.policy
        guard = CurrentExecutorGuard(policy, self.session, credential_call=self.broker,
                                     provider=self.identity_provider)
        adapter = BlacklakeFullSnapshotAdapter(policy, session=self.session, sender=self.sender,
                    credential_call=self.broker, identity_provider=self.identity_provider)
        return guard, adapter, FullSnapshotCoordinator(source=self.source, executor_guard=guard, adapter=adapter)

    def run_stage(self, coordinator=None, stage='save'):
        return (coordinator or self.connection()[2]).run(
            self.actor, self.request.pk, uuid.uuid4(), source_digest=self.policy.source_digest, stage=stage)

    def assert_code(self, code, callback):
        with self.assertRaises(FullSnapshotError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def writes(self):
        return [entry for entry in self.calls if entry[0] != '_detail']

    def test_reuse_only_identity_provider_reads_existing_cache_once_without_issuance(self):
        provider = ReuseOnlyIdentityProvider(self.policy)
        with patch('quality.inspection_full_snapshot_authority.get_existing_app_access_token',
                   return_value='SYNTHETIC-CACHED-APP') as existing, \
             patch('mes_oauth.app_tokens.get_app_access_token', side_effect=AssertionError('issuance forbidden')) as issue, \
             patch('quality.inspection_full_snapshot_authority.BlacklakeUserOAuthClient') as client:
            client.return_value.userinfo.return_value = {'id': 101}
            self.assertEqual(provider.userinfo(self.lease.value), {'id': 101})
            existing.assert_called_once_with()
            issue.assert_not_called()
            client.assert_called_once_with(origin=self.policy.origin,
                app_access_token='SYNTHETIC-CACHED-APP', app_token_header='access_token')
            client.return_value.userinfo.assert_called_once_with(self.lease.value)

    def test_cache_miss_never_issues_retries_or_constructs_identity_client(self):
        provider = ReuseOnlyIdentityProvider(self.policy)
        with patch('quality.inspection_full_snapshot_authority.get_existing_app_access_token',
                   side_effect=VaultBlocked()), \
             patch('mes_oauth.app_tokens.get_app_access_token', side_effect=AssertionError('issuance forbidden')) as issue, \
             patch('quality.inspection_full_snapshot_authority.BlacklakeUserOAuthClient') as client:
            with self.assertRaises(VaultBlocked):
                provider.userinfo(self.lease.value)
            issue.assert_not_called()
            client.assert_not_called()

    def test_policy_binds_target_scope_expiry_and_reviewed_binding_exactly(self):
        self.assertTrue(self.policy.matches(self.request, self.binding))
        for field, changed in (('qc_id', '39'), ('tenant', 'SYNTHETIC-OTHER'),
                               ('test_only', False), ('work_order_id', '88')):
            with self.subTest(field=field):
                altered = deepcopy(self.binding)
                setattr(altered, field, changed)
                self.assertFalse(self.policy.matches(self.request, altered))
        self.assertFalse(replace(self.policy, expires_at=timezone.now() - timedelta(seconds=1)).matches(
            self.request, self.binding))

    def test_real_guard_normalizes_only_reserved_request_version_and_keeps_all_provenance(self):
        guard, _, _ = self.connection()
        before = guard(self.actor, self.request, self.binding, 'save')
        self.request.version = 2
        self.request.save(update_fields=['version'])
        after = guard(self.actor, self.request, self.binding, 'save')
        self.assertEqual(before.mes_user_id, after.mes_user_id)
        self.assertEqual(after.mes_user_id, '101')
        self.assertEqual(after.concurrency_mode, 'reviewed_single_writer_trial')
        self.assertTrue(after.residual_remote_race)
        self.source.data['areas'][0]['authorship']['A']['recorded_by_name'] = 'changed historical recorder'
        self.assert_code('source_changed', lambda: guard(self.actor, self.request, self.binding, 'save'))

    def test_assigned_completion_item_and_historical_contributors_cannot_review(self):
        original = deepcopy(self.source.data)
        for contribution in ('assigned', 'completion_recorder', 'item_recorder', 'history'):
            with self.subTest(contribution=contribution):
                self.source.data = deepcopy(original)
                area = self.source.data['areas'][0]
                if contribution == 'assigned':
                    area['assigned']['id'] = self.reviewer.pk
                    area['completion']['inspector']['id'] = self.reviewer.pk
                    area['authorship']['A']['inspector_id'] = self.reviewer.pk
                elif contribution == 'completion_recorder':
                    area['completion']['recorder']['id'] = self.reviewer.pk
                elif contribution == 'item_recorder':
                    area['authorship']['A']['recorded_by_id'] = self.reviewer.pk
                else:
                    self.source.data['historical_contributors'][0]['actor_id'] = self.reviewer.pk
                policy = replace(self.policy, source_digest=fingerprint(self.source.data))
                guard = self.connection(policy)[0]
                self.assert_code('independent_reviewer_required',
                                 lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.assertEqual(self.broker_calls, [])

    def test_ui_historical_contributor_check_remains_a_separate_reviewer_gate(self):
        self.contributor_mock.return_value = True
        guard = self.connection()[0]
        self.assert_code('independent_reviewer_required',
                         lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.assertEqual(self.broker_calls, [])

    def test_missing_required_provenance_schema_blocks_real_guard(self):
        guard = self.connection()[0]
        with patch.object(DjangoCompletedSource, 'capture', side_effect=self.original_capture), \
             patch.object(InspectionRoleWorkflow._meta, 'get_fields', return_value=[]):
            self.assert_code('provenance_schema_unavailable',
                             lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.assertEqual(self.broker_calls, [])

    def test_default_policy_has_no_write_approval_but_can_read_with_current_credential(self):
        policy = replace(self.policy, write_authorized=False, concurrency_mode='unverified',
                         concurrency_reference='', operational_conditions_reference='')
        guard, adapter, _ = self.connection(policy)
        self.assertFalse(adapter.enabled)
        authority = guard(self.actor, self.request, self.binding, 'read')
        observation = adapter.read(self.binding, authority)
        self.assertEqual(observation['qc_id'], '31')
        self.assertEqual(len(observation['records']), 2)
        self.assert_code('executor_write_not_authorized',
                         lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.assertEqual(self.writes(), [])

    def test_wrong_or_expired_user_lease_blocks_before_any_http(self):
        guard = self.connection()[0]
        self.lease = InspectionUserAccessToken('SYNTHETIC-WRONG',
            (timezone.now() + timedelta(minutes=5)).timestamp(), user_id=102)
        self.assert_code('executor_identity_mismatch',
                         lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.lease = InspectionUserAccessToken('SYNTHETIC-EXPIRED',
            (timezone.now() - timedelta(seconds=1)).timestamp(), user_id=101)
        self.assert_code('executor_credential_expired',
                         lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.assertEqual(self.calls, [])

    def test_connection_read_independently_checks_lease_executor(self):
        guard, adapter, _ = self.connection()
        authority = guard(self.actor, self.request, self.binding, 'read')
        self.lease = InspectionUserAccessToken('SYNTHETIC-WRONG',
            (timezone.now() + timedelta(minutes=5)).timestamp(), user_id=102)
        self.assert_code('mes_executor_mismatch', lambda: adapter.read(self.binding, authority))
        self.assertEqual(self.calls, [])

    def test_single_writer_trial_uses_whole_payload_and_one_executor_through_finish(self):
        _, adapter, coordinator = self.connection()
        self.assertTrue(adapter.enabled)
        self.assertIsNone(adapter.atomic_writer)
        saved = self.run_stage(coordinator)
        self.assertEqual(saved['status'], 'succeeded')
        finished = self.run_stage(coordinator, 'finish')
        self.assertEqual(finished['status'], 'succeeded')
        writes = self.writes()
        self.assertEqual([entry[0] for entry in writes], ['_update_task_check_item', '_finish'])
        self.assertEqual([row['result'] for row in writes[0][1]['checkItems']], ['10.1', '20.1'])
        self.assertTrue(all(body == {'id': 31} for endpoint, body in self.calls if endpoint == '_detail'))
        op = InspectionOperation.objects.get(pk=saved['operation_id'])
        self.assertEqual(op.response['intent']['source']['terminal']['id'], 601)
        self.assertEqual(op.response['intent']['source']['historical_contributors'][0]['actor_id'], 701)

    def test_trial_requires_explicit_residual_race_and_operating_conditions(self):
        for policy, code in ((replace(self.policy, residual_remote_race=False), 'remote_concurrency_unverified'),
                             (replace(self.policy, operational_conditions_reference=''), 'executor_policy_invalid')):
            with self.subTest(policy=policy.concurrency_mode):
                guard, adapter, _ = self.connection(policy)
                self.assertFalse(adapter.enabled)
                self.assert_code(code,
                    lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.assertEqual(self.calls, [])

    def test_trial_cannot_admit_production_or_work_order_scope(self):
        self.binding.work_order_id = '88'
        self.binding.save(update_fields=['work_order_id'])
        policy = replace(self.policy, binding_digest=binding_fingerprint(self.binding))
        guard = self.connection(policy)[0]
        self.assert_code('remote_concurrency_unverified',
                         lambda: guard(self.actor, self.request, self.binding, 'save'))
        self.assertEqual(self.calls, [])

    def test_same_value_remote_metadata_change_at_last_detail_stops_before_wire_save(self):
        def race(count):
            if count == 3:
                self.envelope['data']['checkItems'][0]['qcTaskCheckItems'][0]['updatedAt'] += 1
        self.before_detail = race
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'mes_concurrent_change'))
        self.assertEqual(self.writes(), [])

    def test_pinned_configuration_change_at_last_detail_stops_before_wire_save(self):
        def race(count):
            if count == 3:
                row = self.envelope['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]
                row['min'] = 9.1
        self.before_detail = race
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'detail_pinned_field_changed'))
        self.assertEqual(self.writes(), [])

    def test_wj_source_changed_in_credential_callback_stops_before_wire_save(self):
        def mutate_before_callback():
            if self.broker_calls[-1] == 'save' and self.detail_calls >= 2:
                self.source.data['config_version'] += 1
        self.broker_failure = mutate_before_callback
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'source_changed'))
        self.assertEqual(self.writes(), [])

    def test_credential_rejection_cleanup_survives_outer_actor_and_request_transaction(self):
        def reject():
            MESCredentialEvent.objects.create(actor_id=self.actor.pk, action='synthetic_wipe', reason='synthetic_rejection')
            raise VaultBlocked()
        self.broker_failure = reject
        coordinator = self.connection()[2]
        with self.assertRaises(CredentialGuardFailure):
            self.run_stage(coordinator)
        self.assertTrue(MESCredentialEvent.objects.filter(
            actor_id=self.actor.pk, action='synthetic_wipe').exists())
        self.assertFalse(InspectionOperation.objects.exists())
        self.assertEqual(self.calls, [])

    def test_actor_lock_precedes_common_request_lock_at_each_coordinator_boundary(self):
        from .inspection_workflow import lock_scope
        def observe(scope):
            self.lock_events.append('request')
            self.assertGreater(self.actor_lock_depth, 0)
            return lock_scope(scope)
        with patch('quality.inspection_workflow.lock_scope', side_effect=observe):
            result = self.run_stage()
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(self.lock_events[0], 'actor')
        for index, event in enumerate(self.lock_events):
            if event == 'request':
                self.assertIn('actor', self.lock_events[:index])
