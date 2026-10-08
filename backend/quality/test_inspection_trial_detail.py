"""Synthetic verified-trial detail contracts; no MES or production database."""
from copy import deepcopy
from datetime import datetime, timedelta
import json
from unittest import mock
from zoneinfo import ZoneInfo

from rest_framework.test import APITestCase

from . import test_inspection_integration_trial_board as board_contracts
from .inspection_models import InspectionMesBinding, InspectionRequest
from .inspection_workflow import serialize


class IntegrationTrialDetailTests(APITestCase):
    make_user = board_contracts.IntegrationTrialBoardTests.make_user
    fixture = board_contracts.IntegrationTrialBoardTests.fixture

    def setUp(self):
        self.viewer = self.make_user('synthetic-trial-detail', superuser=True, edit=False)
        self.client.force_authenticate(self.viewer)
        self.now = datetime(2026, 9, 30, 12, tzinfo=ZoneInfo('Asia/Shanghai'))
        self.stamp = self.now - timedelta(minutes=1)

    def detail(self, request):
        with mock.patch('quality.inspection_workflow.timezone.now', return_value=self.now):
            response = self.client.get(f'/api/quality/inspection-requests/{request.pk}/')
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_completed_detail_uses_verified_provider_verdict_not_local_judgement(self):
        for suffix, provider, local in ((1, 'pass', 'fail'), (2, 'fail', 'pass')):
            with self.subTest(provider=provider):
                request, _ = self.fixture(suffix, provider_judgement=provider, local_judgement=local)
                data = self.detail(request)
                self.assertEqual(data['mes_trial_observation'], {
                    'verdict': provider, 'observed_at': self.stamp.isoformat(),
                })
                self.assertIsNone(data['mes_state']['qc_status'])
                self.assertNotIn('SYNTHETIC-PRIVATE', json.dumps(data['mes_trial_observation']))

    def test_approval_pending_exposes_observation_without_final_verdict(self):
        request, _ = self.fixture(1, state='approval_pending', provider_judgement='pass')
        data = self.detail(request)
        self.assertEqual(data['mes_completion_status'], 'approval_pending')
        self.assertEqual(data['mes_trial_observation'], {
            'verdict': None, 'observed_at': self.stamp.isoformat(),
        })

    def test_unverified_and_unbound_trials_never_use_local_pass(self):
        for suffix, options in ((1, {'proof': False}), (2, {'binding': False})):
            with self.subTest(options=options):
                request, _ = self.fixture(suffix, local_judgement='pass', **options)
                self.assertEqual(self.detail(request)['mes_trial_observation'], {
                    'verdict': None, 'observed_at': None,
                })

    def test_mismatched_proof_time_identity_digest_and_status_fail_closed(self):
        request, binding = self.fixture(1, local_judgement='pass')
        original = deepcopy(request.mes_snapshot)
        cases = [
            ({'identity': {'qc_id': 'SYNTHETIC-OTHER-QC'}}, {}, {}),
            ({'evidence_digest': 'f' * 64}, {}, {}),
            ({'observed_at': (self.now + timedelta(seconds=1)).isoformat()}, {}, {}),
            ({'schema': 'unverified'}, {}, {}),
            ({'judgement': True}, {}, {}),
            ({}, {'last_verified_at': self.stamp - timedelta(seconds=1)}, {}),
            ({}, {'phase': 'finish_unknown'}, {}),
            ({}, {}, {'sync_status': 'unknown'}),
            ({}, {}, {'mes_completion_status': 'approval_pending'}),
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
                self.assertEqual(self.detail(request)['mes_trial_observation'], {
                    'verdict': None, 'observed_at': None,
                })

    def test_ordinary_production_quality_projection_remains_unchanged(self):
        request, _ = self.fixture(1, source_kind='local_manual', test_only=False)
        state = {'task_status': 2, 'qc_status': 1, 'state_version': 'synthetic-v1',
                 'receipt_allowed': False}
        request.mes_snapshot = {**request.mes_snapshot, **state}
        request.save(update_fields=['mes_snapshot'])
        data = self.detail(request)
        self.assertIsNone(data['mes_trial_observation'])
        self.assertEqual(data['mes_state'], state)

    def test_existing_test_binding_is_trial_and_list_projection_is_unchanged(self):
        request, _ = self.fixture(1, source_kind='local_manual')
        self.assertEqual(self.detail(request)['mes_trial_observation']['verdict'], 'pass')
        self.assertNotIn('mes_trial_observation', serialize(request, self.viewer, detail=False))
