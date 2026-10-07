"""Area API boundaries, using disposable accounts and no MES transport."""
import uuid
from unittest.mock import patch

from rest_framework.test import APITestCase

from .inspection_models import InspectionRequest
from .inspection_role_models import InspectionShiftSetting, InspectionRoleWorkflow, InspectionAreaResult
from . import test_inspection_requests as fixture_helpers
from .test_inspection_requests import authenticate_inspection_client


class InspectionRoleApiTests(APITestCase):
    make_user = fixture_helpers.InspectionRequestContractTests.make_user
    create_payload = fixture_helpers.InspectionRequestContractTests.create_payload
    draft_payload = fixture_helpers.InspectionRequestContractTests.draft_payload
    base = '/api/quality/inspection-requests/'

    def setUp(self):
        self.owner = self.make_user('SYNTHETIC-role-owner', superuser=True)
        self.other = self.make_user('SYNTHETIC-role-other', superuser=True)
        authenticate_inspection_client(self.client, self.owner)

    def post(self, suffix, payload, key=None):
        return self.client.post(self.base + suffix, payload, format='json',
                                HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()))

    def create(self, *, roles=True):
        payload = self.create_payload(role_workflow=roles)
        if roles:
            payload['inspection_items'].append({'id': 'look', 'label': 'SYNTHETIC appearance',
                'kind': 'choice', 'options': ['OK', 'NG'], 'unit': '', 'required': True, 'evidence_required': False})
        response = self.post('', payload)
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def summary_payload(self, request):
        return {'version': request['version'], 'inspected_quantity': '1.000',
                'accepted_quantity': '1.000', 'rejected_quantity': '0.000',
                'notes': 'SYNTHETIC shared quantity summary'}

    def test_empty_settings_get_has_no_seed_or_account_grants(self):
        response = self.client.get(self.base + 'role-settings/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['settings'], [])
        self.assertEqual(InspectionShiftSetting.objects.count(), 0)
        self.assertEqual(InspectionRoleWorkflow.objects.count(), 0)
        self.assertEqual(InspectionAreaResult.objects.count(), 0)
        self.assertTrue(self.client.get(self.base + 'capabilities/').data['can_manage_role_settings'])

    def test_single_item_role_request_is_rejected_without_orphan_records(self):
        response = self.post('', self.create_payload(role_workflow=True))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(InspectionRequest.objects.count(), 0)
        self.assertEqual(InspectionRoleWorkflow.objects.count(), 0)
        self.assertEqual(InspectionAreaResult.objects.count(), 0)

    def test_only_new_explicit_opt_in_creates_unconfigured_roles(self):
        data = self.create()
        self.assertEqual(data['role_workflow']['status'], 'unconfigured')
        self.assertFalse(data['role_workflow']['configured'])
        self.assertFalse(data['capabilities']['can_edit'])
        self.assertFalse(data['capabilities']['can_submit'])
        self.assertFalse(data['mes_workflow']['can_save'])
        self.assertEqual(InspectionShiftSetting.objects.count(), 0)

    def test_existing_completed_request_stays_legacy_and_has_no_role_backfill(self):
        data = self.create(roles=False)
        InspectionRequest.objects.filter(pk=data['id']).update(
            status='approved', judgement='pass', mes_completion_status='completed')
        response = self.client.get(self.base + f'{data["id"]}/')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data['role_workflow'])
        self.assertEqual(response.data['mes_completion_status'], 'completed')
        self.assertEqual(InspectionRoleWorkflow.objects.count(), 0)

    def test_role_whole_draft_and_premature_submit_cannot_replace_results(self):
        data = self.create()
        response = self.client.patch(self.base + f'{data["id"]}/',
            self.draft_payload(data['version']), format='json',
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(str(response.data['code']), 'area_actions_required')
        response = self.post(f'{data["id"]}/submit/', {'version': data['version']})
        self.assertEqual(response.status_code, 409)
        stored = InspectionRequest.objects.get(pk=data['id'])
        self.assertEqual(stored.measurements, [])
        self.assertEqual(stored.judgement, '')
        self.assertEqual(stored.version, data['version'])

    def test_every_role_mes_route_denies_before_adapter_or_credential_construction(self):
        data = self.create()
        with patch('quality.inspection_mes_stages.get_stage_adapter') as stage, \
             patch('mes_oauth.inspection_credentials.call_with_user_credential') as credential:
            for action in ('mes-save', 'mes-finish', 'mes-reconcile', 'refresh', 'sync'):
                with self.subTest(action=action):
                    response = self.post(f'{data["id"]}/{action}/', {'version': data['version']})
                    self.assertEqual(response.status_code, 409, response.data)
                    self.assertEqual(str(response.data['code']), 'mes_partial_multi_executor_contract_unverified')
            stage.assert_not_called()
            credential.assert_not_called()
        self.assertEqual(InspectionRequest.objects.get(pk=data['id']).version, data['version'])

    def test_shared_summary_is_cas_protected_and_never_accepts_area_results(self):
        data = self.create()
        key = str(uuid.uuid4())
        payload = self.summary_payload(data)
        saved = self.post(f'{data["id"]}/role-results/', payload, key)
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data['measurements'], [])
        self.assertEqual(saved.data['judgement'], '')
        self.assertEqual(saved.data['version'], data['version'] + 1)
        replay = self.post(f'{data["id"]}/role-results/', payload, key)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.data, saved.data)
        stale = self.post(f'{data["id"]}/role-results/', payload)
        self.assertEqual(stale.status_code, 409)
        invalid = self.post(f'{data["id"]}/role-results/',
                            dict(payload, version=saved.data['version'], measurements=[]))
        self.assertEqual(invalid.status_code, 400)

    def test_superuser_does_not_impersonate_the_request_owner_for_shared_summary(self):
        data = self.create()
        authenticate_inspection_client(self.client, self.other)
        response = self.post(f'{data["id"]}/role-results/', self.summary_payload(data))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(InspectionRequest.objects.get(pk=data['id']).version, data['version'])

    def test_legacy_request_cannot_be_converted_by_configuration_endpoint(self):
        data = self.create(roles=False)
        response = self.post(f'{data["id"]}/role-configure/',
            {'config_version': 1, 'shift_setting_id': 1, 'shift_version': 1,
             'shift_date': '2026-01-02', 'item_areas': {}, 'reason': 'SYNTHETIC'})
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(InspectionRoleWorkflow.objects.count(), 0)

    def test_settings_route_rejects_staff_without_existing_admin_authority(self):
        staff = self.make_user('SYNTHETIC-role-staff', staff=True,
                               permissions=('manage', 'submit', 'review'))
        authenticate_inspection_client(self.client, staff)
        self.assertEqual(self.client.get(self.base + 'role-settings/').status_code, 403)
        self.assertEqual(self.post('role-settings/', {'code': 'SYNTHETIC', 'label': 'SYNTHETIC'}).status_code, 403)
        self.assertEqual(InspectionShiftSetting.objects.count(), 0)
