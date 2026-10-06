"""Synthetic persisted-board acceptance; no provider or production identities."""
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
from datetime import date, datetime, timedelta, timezone
import json
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from .inspection_board_repository import read_persisted_board_source
from .inspection_board_source import read_board_quality_source
from .inspection_board_status import BoardScope, project_machine_quality
from .inspection_models import InspectionMesBinding, InspectionRequest


NOW = datetime(2026, 10, 4, 8, tzinfo=timezone.utc)
SCOPE = BoardScope(date(2026, 10, 4), 2, 70, 'a' * 64)


class InspectionBoardRepositoryTests(TestCase):
    def fixture(self, suffix=1, *, kind='first', state='completed', judgement='pass', test_only=False):
        identity = dict(tenant='SYNTHETIC-BOARD-TENANT', qc_id=str(910000000 + suffix),
            work_order_id='920000001', production_task_id='930000001',
            equipment_id='940000001', snapshot_id=str(950000000 + suffix))
        stage = dict(schema='inspection-stage-observation.v1', identity=identity,
            state=state, judgement=judgement, observed_at=(NOW - timedelta(seconds=3)).isoformat(),
            checked_at=(NOW - timedelta(minutes=2)).isoformat() if state == 'completed' else None,
            kind=kind, evidence_digest='b' * 64, policy_fingerprint='c' * 64,
            plan_binding=dict(business_date=SCOPE.business_date.isoformat(),
                machine_number=SCOPE.machine_number, current_plan_id=SCOPE.current_plan_id,
                plan_version=SCOPE.plan_version, generation=3, reference='SYNTHETIC-reviewed-plan',
                valid_from=(NOW - timedelta(hours=1)).isoformat(),
                valid_until=(NOW + timedelta(hours=1)).isoformat(), stale_after_seconds=120))
        request = InspectionRequest.objects.create(identity=f'SYNTHETIC-{suffix}',
            work_order_ref='SYNTHETIC-WORK', task_ref='SYNTHETIC-TASK', part_no='SYNTHETIC-PART',
            equipment_ref='SYNTHETIC-NOT-A-MACHINE-NAME', target_quantity='1.000', uom='EA',
            warehouse_ref='SYNTHETIC-WAREHOUSE', lot_ref='SYNTHETIC-LOT', work_started_at=NOW,
            assigned_to_name='SYNTHETIC', sync_status='succeeded', mes_snapshot={'verified_stage': stage})
        binding = InspectionMesBinding.objects.create(request=request,
            test_only=test_only,
            tenant=identity['tenant'], qc_id=identity['qc_id'], work_order_id=identity['work_order_id'],
            contract={key: identity[key] for key in ('production_task_id', 'equipment_id', 'snapshot_id')},
            reviewed_result_digest='d' * 64, test_label='SYNTHETIC',
            phase='saved' if state == 'open' else 'completed', evidence_digest=stage['evidence_digest'],
            last_verified_at=datetime.fromisoformat(stage['observed_at']))
        return request, binding, stage

    def source(self, scope=SCOPE, **kwargs):
        return read_persisted_board_source(scope, now=kwargs.pop('now', NOW), **kwargs)

    def project(self, source):
        return project_machine_quality(SCOPE, bindings=source.bindings,
            observations=source.observations, read=source.read, now=NOW)

    def test_verified_completion_is_read_only_redacted_and_never_complete_population(self):
        request, binding, stage = self.fixture()
        with CaptureQueriesContext(connection) as queries, patch(
                'requests.sessions.Session.request', side_effect=AssertionError('network forbidden')):
            source = self.source()
        self.assertIsNotNone(source)
        self.assertEqual(len(queries), 1)
        self.assertTrue(queries[0]['sql'].lstrip().upper().startswith('SELECT'))
        self.assertFalse(source.read.complete)
        with self.assertRaises(FrozenInstanceError):
            source.read.complete = True
        result = self.project(source)
        self.assertEqual(result['first']['checks'][0]['status'], 'passed')
        self.assertEqual(result['first']['status'], 'unknown')
        self.assertFalse(result['complete'])
        encoded = json.dumps(result)
        for private in (*stage['identity'].values(), stage['policy_fingerprint'],
                        stage['evidence_digest'], 'SYNTHETIC-reviewed-plan', 'SYNTHETIC-PART'):
            self.assertNotIn(private, encoded)
        request.refresh_from_db(); binding.refresh_from_db()
        self.assertEqual(request.mes_snapshot, {'verified_stage': stage})
        self.assertEqual(binding.phase, 'completed')

    def test_public_hook_reads_the_repository_without_provider(self):
        self.fixture()
        with patch('quality.inspection_board_repository.timezone.now', return_value=NOW):
            self.assertIsNotNone(read_board_quality_source(SCOPE))

    def test_test_bindings_and_trial_requests_never_publish_production_evidence(self):
        _, trial_binding, _ = self.fixture(test_only=True)
        self.assertIsNone(self.source())
        InspectionMesBinding.objects.filter(pk=trial_binding.pk).update(test_only=False)
        InspectionRequest.objects.filter(pk=trial_binding.request_id).update(source_kind='integration_test')
        self.assertIsNone(self.source())

    def test_trial_evidence_cannot_poison_or_increase_a_verified_production_batch(self):
        self.fixture()
        trial, _, _ = self.fixture(2, test_only=True)
        InspectionRequest.objects.filter(pk=trial.pk).update(
            mes_snapshot={'verified_stage': {'plan_binding': {
                'business_date': SCOPE.business_date.isoformat(),
                'machine_number': SCOPE.machine_number, 'current_plan_id': SCOPE.current_plan_id,
                'plan_version': SCOPE.plan_version}}})
        source = self.source()
        self.assertEqual(len(source.observations), 1)
        self.assertEqual(source.observations[0].qc_id, '910000001')

    def test_empty_absent_and_changed_plan_scopes_have_no_fallback(self):
        self.assertIsNone(self.source())
        self.fixture()
        for scope in (replace(SCOPE, current_plan_id=None), replace(SCOPE, current_plan_id=71),
                replace(SCOPE, machine_number=3), replace(SCOPE, business_date=date(2026, 10, 3)),
                replace(SCOPE, plan_version='e' * 64)):
            with self.subTest(scope=scope):
                self.assertIsNone(self.source(scope))

    def test_legacy_or_client_snapshot_shapes_are_not_stage_evidence(self):
        request, _, _ = self.fixture()
        for snapshot in ({}, {'state': 'completed'}, {'verified_stage': None},
                         {'task_status': 2, 'qc_status': 1, 'receipt_allowed': True}):
            InspectionRequest.objects.filter(pk=request.pk).update(mes_snapshot=snapshot)
            self.assertIsNone(self.source())

    def test_approval_pending_never_publishes_a_pass_or_checked_time(self):
        self.fixture(kind='periodic', state='approval_pending', judgement='pass')
        source = self.source()
        self.assertEqual(source.observations[0].stage, 'in_progress')
        self.assertEqual(source.observations[0].judgement, 'unknown')
        self.assertIsNone(source.observations[0].checked_at)
        result = self.project(source)
        self.assertEqual(result['periodic']['checks'][0]['status'], 'in_progress')
        self.assertIsNone(result['periodic']['last_checked_at'])
        self.assertEqual(result['periodic']['last_result'], 'unknown')

    def test_completed_periodic_keeps_provider_checked_time_separate_from_read_time(self):
        _, _, stage = self.fixture(kind='periodic')
        result = self.project(self.source())
        self.assertEqual(result['periodic']['last_checked_at'], stage['checked_at'])
        self.assertEqual(result['periodic']['last_result'], 'passed')
        self.assertEqual(result['periodic']['status'], 'unknown')
        self.assertIsNone(result['periodic']['next_due_at'])

    def test_failed_or_pending_write_invalidates_retained_prior_snapshot(self):
        request, binding, _ = self.fixture()
        for status in ('unknown', 'not_synced', 'pending'):
            InspectionRequest.objects.filter(pk=request.pk).update(sync_status=status)
            self.assertIsNone(self.source())
        InspectionRequest.objects.filter(pk=request.pk).update(sync_status='succeeded')
        for phase in ('ready', 'saved', 'save_pending', 'finish_pending', 'finish_unknown', 'blocked'):
            InspectionMesBinding.objects.filter(pk=binding.pk).update(phase=phase)
            self.assertIsNone(self.source())

    def test_identity_digest_time_and_missing_binding_mismatch_fail_closed(self):
        request, binding, stage = self.fixture()
        original = dict(tenant=binding.tenant, qc_id=binding.qc_id, work_order_id=binding.work_order_id,
            contract=binding.contract, evidence_digest=binding.evidence_digest,
            last_verified_at=binding.last_verified_at)
        for changes in ({'tenant': 'SYNTHETIC-other'}, {'qc_id': '910999999'},
                {'work_order_id': '920999999'}, {'contract': dict(binding.contract, snapshot_id='950999999')},
                {'evidence_digest': 'e' * 64}, {'last_verified_at': NOW}, {'last_verified_at': None}):
            with self.subTest(changes=changes):
                InspectionMesBinding.objects.filter(pk=binding.pk).update(**changes)
                self.assertIsNone(self.source())
                InspectionMesBinding.objects.filter(pk=binding.pk).update(**original)
        binding.delete()
        self.assertIsNone(self.source())

    def test_malformed_stage_and_incomplete_completion_are_rejected(self):
        request, _, stage = self.fixture()
        for changes in ({'schema': 'other'}, {'kind': 'unknown'}, {'state': 'cancelled'},
                {'judgement': None}, {'checked_at': None}, {'policy_fingerprint': ''},
                {'checked_at': (NOW + timedelta(seconds=1)).isoformat()},
                {'observed_at': NOW.replace(tzinfo=None).isoformat()},
                {'evidence_digest': 'z' * 64}, {'unreviewed': True}):
            with self.subTest(changes=changes):
                value = dict(stage, **changes)
                InspectionRequest.objects.filter(pk=request.pk).update(mes_snapshot={'verified_stage': value})
                self.assertIsNone(self.source())

    def test_expiry_future_reads_and_invalid_policy_bounds_fail_closed(self):
        request, _, stage = self.fixture()
        self.assertIsNone(self.source(now=NOW + timedelta(seconds=121)))
        self.assertIsNone(self.source(now=NOW - timedelta(seconds=4)))
        for changes in ({'valid_until': NOW.isoformat()}, {'valid_from': NOW.isoformat()},
                {'generation': True}, {'stale_after_seconds': 0}, {'stale_after_seconds': 86401},
                {'reference': ''}, {'valid_until': 'invalid'}):
            with self.subTest(changes=changes):
                value = deepcopy(stage); value['plan_binding'].update(changes)
                InspectionRequest.objects.filter(pk=request.pk).update(mes_snapshot={'verified_stage': value})
                self.assertIsNone(self.source())

    def test_distinct_qcs_share_one_exact_binding_but_conflicts_poison_the_batch(self):
        self.fixture()
        request, _, stage = self.fixture(2, kind='periodic')
        source = self.source()
        self.assertEqual(len(source.observations), 2)
        self.assertEqual(len(source.bindings), 1)
        value = deepcopy(stage); value['plan_binding']['generation'] += 1
        InspectionRequest.objects.filter(pk=request.pk).update(mes_snapshot={'verified_stage': value})
        self.assertIsNone(self.source())

    def test_duplicate_claimed_qc_identity_is_not_silently_filtered(self):
        _, _, first = self.fixture()
        request, _, stage = self.fixture(2)
        stage['identity'] = first['identity']
        InspectionRequest.objects.filter(pk=request.pk).update(mes_snapshot={'verified_stage': stage})
        self.assertIsNone(self.source())

    def test_row_bound_is_enforced_in_sql_without_hiding_invalid_candidates(self):
        for suffix in range(1, 52):
            self.fixture(suffix)
        with CaptureQueriesContext(connection) as queries:
            self.assertIsNone(self.source())
        self.assertEqual(len(queries), 1)
        self.assertIn('LIMIT 51', queries[0]['sql'])
