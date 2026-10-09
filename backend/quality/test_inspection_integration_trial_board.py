"""Synthetic trial partition/provenance contracts; no MES or live database."""
from copy import deepcopy
from datetime import datetime, timedelta
from unittest import mock
from zoneinfo import ZoneInfo

from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from production.models import ProductionExecution, ProductionPlan
from . import test_inspection_requests as inspection_contracts
from .inspection_models import (
    InspectionAudit, InspectionMesBinding, InspectionOperation, InspectionRequest,
)


class IntegrationTrialBoardTests(APITestCase):
    make_user = inspection_contracts.InspectionRequestContractTests.make_user
    url = '/api/quality/inspection-requests/kanban/'

    def setUp(self):
        self.viewer = self.make_user('synthetic-trial-viewer', superuser=True, edit=False)
        self.client.force_authenticate(self.viewer)
        self.now = datetime(2026, 9, 30, 12, tzinfo=ZoneInfo('Asia/Shanghai'))
        self.stamp = self.now - timedelta(minutes=1)

    def fixture(self, suffix, *, source_kind='integration_test', test_only=True,
                binding=True, proof=True, state='completed', provider_judgement='pass',
                local_judgement='fail'):
        request = InspectionRequest.objects.create(
            identity=f'synthetic-trial-{suffix}', source_kind=source_kind,
            work_order_ref='SYNTHETIC-WO', task_ref='SYNTHETIC-PRIVATE-TASK',
            part_no='SYNTHETIC-PART', equipment_ref='imm02', target_quantity='10',
            uom='EA', warehouse_ref='SYNTHETIC-WAREHOUSE', lot_ref='SYNTHETIC-LOT',
            work_started_at=self.stamp, assigned_to_name='SYNTHETIC-PRIVATE-ACTOR',
            status='approved', judgement=local_judgement, sync_status='succeeded',
            mes_completion_status={'completed': 'completed', 'approval_pending': 'approval_pending',
                                   'open': 'not_completed'}[state], mes_checked_at=self.stamp,
            notes='SYNTHETIC-PRIVATE-NOTES', measurements=[{'private': 'SYNTHETIC-MEASUREMENT'}],
        )
        InspectionRequest.objects.filter(pk=request.pk).update(created_at=self.now - timedelta(hours=1))
        target = None
        if binding:
            target = InspectionMesBinding.objects.create(
                request=request, tenant='SYNTHETIC-TENANT', qc_id=f'9100000{suffix:02}',
                work_order_id='920000001', contract={'qc_code': f'SYNTHETIC-QC-{suffix}'},
                reviewed_result_digest='d' * 64, test_only=test_only,
                test_label='SYNTHETIC-INTEGRATION-TRIAL',
                phase='saved' if state == 'open' else 'completed',
                evidence_digest='e' * 64, last_verified_at=self.stamp,
            )
        if proof and target:
            request.mes_snapshot = {'verified_trial': {
                'schema': 'integration-trial-observation.v1', 'identity': {'qc_id': target.qc_id},
                'state': state, 'judgement': provider_judgement,
                'observed_at': self.stamp.isoformat(), 'evidence_digest': target.evidence_digest,
            }, 'private_provider_payload': 'SYNTHETIC-PRIVATE-PAYLOAD'}
            request.save(update_fields=['mes_snapshot'])
        return request, target

    def board(self):
        with mock.patch('quality.inspection_kanban.timezone.now', return_value=self.now):
            response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    @staticmethod
    def production_ids(data):
        return {row['id'] for machine in data['machines'] for row in machine['requests']} | {
            row['id'] for row in data['unmapped_requests']}

    def test_either_trial_marker_excludes_production_counts_and_dry_run(self):
        trials = [self.fixture(1)[0], self.fixture(2, source_kind='local_manual')[0],
                  self.fixture(3, test_only=False)[0]]
        data = self.board()
        self.assertEqual({row['request_id'] for row in data['integration_trials']},
                         {str(row.pk) for row in trials})
        self.assertEqual(self.production_ids(data), set())
        self.assertEqual(data['counts']['requests_displayed'], 0)
        self.assertEqual(data['counts']['unmapped_requests'], 0)
        for machine in data['machines']:
            self.assertEqual(machine['request_count'], 0)
            self.assertEqual(machine['dry_run']['candidate'], 'none')
        self.assertIsNone(next(row for row in data['integration_trials']
                               if row['request_id'] == str(trials[2].pk))['trial_verdict'])

    def test_ordinary_request_without_binding_remains_production(self):
        normal, _ = self.fixture(1, source_kind='local_manual', binding=False)
        trial, _ = self.fixture(2)
        data = self.board()
        self.assertEqual(self.production_ids(data), {normal.pk})
        self.assertEqual(data['counts']['requests_displayed'], 1)
        self.assertEqual([row['request_id'] for row in data['integration_trials']], [str(trial.pk)])

    def test_verdict_uses_verified_provider_result_instead_of_local_judgement(self):
        passed, _ = self.fixture(1, provider_judgement='pass', local_judgement='fail')
        failed, _ = self.fixture(2, provider_judgement='fail', local_judgement='pass')
        trials = {row['request_id']: row for row in self.board()['integration_trials']}
        self.assertEqual(trials[str(passed.pk)]['trial_verdict'], 'pass')
        self.assertEqual(trials[str(failed.pk)]['trial_verdict'], 'fail')
        self.assertEqual(trials[str(passed.pk)]['observed_at'], self.stamp.isoformat())

    def test_local_completed_result_without_verified_proof_has_no_mes_verdict(self):
        self.fixture(1, proof=False, local_judgement='pass')
        trial = self.board()['integration_trials'][0]
        self.assertEqual(trial['phase'], 'completed')
        self.assertIsNone(trial['trial_verdict'])
        self.assertIsNone(trial['observed_at'])

    def test_approval_pending_and_saved_observations_have_no_final_verdict(self):
        pending, _ = self.fixture(1, state='approval_pending')
        saved, _ = self.fixture(2, state='open')
        trials = {row['request_id']: row for row in self.board()['integration_trials']}
        for request in (pending, saved):
            self.assertIsNone(trials[str(request.pk)]['trial_verdict'])
            self.assertEqual(trials[str(request.pk)]['observed_at'], self.stamp.isoformat())
        self.assertEqual(trials[str(saved.pk)]['phase'], 'saved')

    def test_identity_digest_time_schema_and_phase_must_match_verified_binding(self):
        request, binding = self.fixture(1)
        original = deepcopy(request.mes_snapshot)
        cases = [
            ({'identity': {'qc_id': 'SYNTHETIC-OTHER-QC'}}, {}, {}),
            ({'evidence_digest': 'f' * 64}, {}, {}),
            ({'evidence_digest': 'invalid'}, {}, {}),
            ({'observed_at': self.stamp.replace(tzinfo=None).isoformat()}, {}, {}),
            ({'observed_at': (self.now + timedelta(seconds=1)).isoformat()}, {}, {}),
            ({'observed_at': 'invalid'}, {}, {}),
            ({'schema': 'unverified'}, {}, {}),
            ({'unexpected_provider_field': 'SYNTHETIC-PRIVATE'}, {}, {}),
            ({'state': []}, {}, {}),
            ({'judgement': 'unexpected'}, {}, {}),
            ({'judgement': None}, {}, {}),
            ({'judgement': []}, {}, {}),
            ({'judgement': {}}, {}, {}),
            ({'judgement': True}, {}, {}),
            ({}, {'last_verified_at': self.stamp - timedelta(seconds=1)}, {}),
            ({}, {'phase': 'finish_unknown'}, {}),
            ({}, {}, {'sync_status': 'unknown'}),
            ({}, {}, {'mes_completion_status': 'not_completed'}),
        ]
        for proof_changes, binding_changes, request_changes in cases:
            with self.subTest(proof=proof_changes, binding=binding_changes, request=request_changes):
                snapshot = deepcopy(original)
                snapshot['verified_trial'].update(proof_changes)
                InspectionMesBinding.objects.filter(pk=binding.pk).update(
                    **dict({'phase': 'completed', 'last_verified_at': self.stamp}, **binding_changes))
                InspectionRequest.objects.filter(pk=request.pk).update(
                    **dict({'mes_snapshot': snapshot, 'sync_status': 'succeeded',
                            'mes_completion_status': 'completed'}, **request_changes))
                trial = self.board()['integration_trials'][0]
                self.assertIsNone(trial['trial_verdict'])
                self.assertIsNone(trial['observed_at'])

    def test_projection_is_bounded_metadata_and_qc_code_is_contract_only(self):
        request, binding = self.fixture(1)
        expected = {'request_id', 'qc_code', 'test_label', 'phase', 'trial_verdict',
                    'observed_at', 'test_only', 'production_counted'}
        trial = self.board()['integration_trials'][0]
        self.assertEqual(set(trial), expected)
        self.assertEqual(trial['qc_code'], 'SYNTHETIC-QC-1')
        self.assertIs(trial['test_only'], True)
        self.assertIs(trial['production_counted'], False)
        for bad_contract in ({}, {'qc_code': 1}, {'qc_code': ' '}, {'qc_code': 'x' * 129}):
            with self.subTest(contract=bad_contract):
                InspectionMesBinding.objects.filter(pk=binding.pk).update(contract=bad_contract)
                trial = self.board()['integration_trials'][0]
                self.assertIsNone(trial['qc_code'])
                self.assertEqual(set(trial), expected)
        self.assertNotIn(request.task_ref, str(trial))
        self.assertNotIn(request.notes, str(trial))
        self.assertNotIn('SYNTHETIC-PRIVATE-PAYLOAD', str(trial))
        self.assertNotIn('SYNTHETIC-MEASUREMENT', str(trial))

    def test_unbound_trial_displays_no_inferred_identity_or_verdict(self):
        request, _ = self.fixture(1, binding=False)
        self.assertEqual(self.board()['integration_trials'], [{
            'request_id': str(request.pk), 'qc_code': None, 'test_label': '',
            'phase': 'unbound', 'trial_verdict': None, 'observed_at': None,
            'test_only': True, 'production_counted': False,
        }])

    def test_trial_limit_cannot_bury_production_requests(self):
        first, _ = self.fixture(1)
        self.fixture(2)
        normal, _ = self.fixture(3, source_kind='local_manual', binding=False)
        with mock.patch('quality.inspection_kanban.ROW_LIMIT', 1):
            data = self.board()
        self.assertEqual(self.production_ids(data), {normal.pk})
        self.assertFalse(data['requests_truncated'])
        self.assertTrue(data['integration_trials_truncated'])
        self.assertEqual([row['request_id'] for row in data['integration_trials']], [str(first.pk)])

    def test_trial_get_is_repeatable_read_only_and_never_calls_mes(self):
        self.fixture(1)
        models = (InspectionRequest, InspectionMesBinding, InspectionOperation, InspectionAudit,
                  ProductionPlan, ProductionExecution)
        before = [list(model.objects.order_by('pk').values()) for model in models]
        with mock.patch('quality.inspection_adapter.get_inspection_adapter') as adapter:
            with CaptureQueriesContext(connection) as queries:
                first, second = self.board(), self.board()
        adapter.assert_not_called()
        self.assertEqual(first, second)
        self.assertEqual(before, [list(model.objects.order_by('pk').values()) for model in models])
        self.assertTrue(queries)
        self.assertTrue(all(query['sql'].lstrip().upper().startswith('SELECT') for query in queries))
