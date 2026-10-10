from copy import deepcopy
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import PlanMaterialApproval, PlanMesRequest
from .plan_bom import read_bom, resolve_inputs
from .test_plan_bom import FixtureReader, PART, submitted
from .test_plan_workflow import new_plan


class PlanBomViewTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='synthetic-bom-admin', is_staff=True, is_superuser=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.plan = new_plan(part=PART, quantity=1920, actor=self.user)
        self.reader = FixtureReader()
        self.source = read_bom(PART, self.user.pk, reader=self.reader)
        self.scope = {'start': '2026-10-08', 'end': '2026-10-08', 'plan_type': 'injection'}
        self.url = '/api/production/plan-workflow/'

    def approval(self, **changes):
        return {**self.scope, 'action': 'approve', 'plan_id': self.plan.pk,
            'uid': str(self.plan.work_uid), 'version': self.plan.work_version,
            'bom_hash': self.source['hash'], 'bom_version': self.source['version'],
            'inputs': submitted(self.source, 'RESIN'), 'resource_code': 'SYNTHETIC-IMM9',
            'mold_code': '', 'reason': 'synthetic verified replacement', **changes}

    def post(self, data):
        with patch('production.plan_workflow_views.read_bom', return_value=deepcopy(self.source)), \
                patch('production.plan_workflow_views.resolve_inputs', side_effect=lambda source, rows, actor:
                    resolve_inputs(source, rows, actor, reader=self.reader)):
            return self.client.post(self.url, data, format='json')

    def test_get_is_scoped_and_read_only(self):
        with patch('production.plan_workflow_views.read_bom', return_value=self.source) as read:
            response = self.client.get(self.url, {**self.scope, 'action': 'bom', 'plan_id': self.plan.pk})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.data['inputs']), 3)
            read.assert_called_once_with(PART, self.user.pk)
            self.assertEqual(self.client.get(self.url, {**self.scope, 'action': 'bom',
                'plan_id': self.plan.pk + 999}).status_code, 400)
        self.assertFalse(PlanMaterialApproval.objects.exists())
        self.assertFalse(PlanMesRequest.objects.exists())

    def test_complete_bom_approval_needs_no_inventory_and_ignores_client_setup(self):
        result = self.post(self.approval(process_code='BAD', route_code='BAD', output_version='BAD'))
        self.assertEqual(result.status_code, 201, result.data)
        approval = PlanMaterialApproval.objects.get()
        self.assertEqual(approval.actor_id, self.user.pk)
        saved = approval.snapshot
        self.assertEqual(saved['bom_source'], self.source)
        self.assertEqual(saved['process_code'], 'ZS')
        self.assertEqual(saved['route_code'], 'SYNTHETIC-ROUTE')
        self.assertEqual(saved['output_version'], '')
        self.assertEqual([row['material_code'] for row in saved['inputs']], ['HARDWARE-A', 'HARDWARE-B', 'RESIN'])
        self.assertEqual([row['required_quantity'] for row in saved['inputs']], ['5760.0', '1920.0', '823.6800'])
        # The real prepare path consumes the full approved source and all rows.
        groups = self.client.get(self.url, self.scope).data['preview']
        result = self.client.post(self.url, {**self.scope, 'action': 'prepare', 'keys': [groups[0]['key']]}, format='json')
        self.assertEqual(result.status_code, 200, result.data)
        payload = PlanMesRequest.objects.get().contract['payload']
        self.assertEqual([row['seq'] for row in payload['inputMaterialOpenV2COs']], ['20', '30', '40'])
        self.assertEqual(payload['useBomFlag'], 0)
        self.assertEqual(payload['productionDepartmentCode'], 'ZS')

    def test_missing_or_changed_source_or_missing_fixed_row_does_not_approve(self):
        for changes, status in [({'bom_hash': None}, 400), ({'bom_hash': 'stale'}, 409),
                                 ({'inputs': submitted(self.source)[1:]}, 400),
                                 ({'inputs': [{**submitted(self.source)[0], 'material_code': 'RESIN'},
                                              *submitted(self.source)[1:]]}, 400)]:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(self.approval(**changes)).status_code, status)
        self.assertFalse(PlanMaterialApproval.objects.exists())

    def test_plan_change_during_provider_read_cannot_approve_new_version(self):
        def read(*args):
            type(self.plan).objects.filter(pk=self.plan.pk).update(work_version=2)
            return self.source
        with patch('production.plan_workflow_views.read_bom', side_effect=read), \
                patch('production.plan_workflow_views.resolve_inputs', return_value=self.source['inputs']):
            response = self.client.post(self.url, self.approval(), format='json')
        self.assertEqual(response.status_code, 409)
        self.assertFalse(PlanMaterialApproval.objects.exists())

    def test_viewer_cannot_approve_or_make_unauthorized_provider_calls(self):
        viewer = get_user_model().objects.create_user(username='synthetic-bom-viewer')
        self.client.force_authenticate(viewer)
        with patch('production.plan_workflow_views.read_bom') as read:
            self.assertEqual(self.client.post(self.url, self.approval(), format='json').status_code, 403)
            read.assert_not_called()

    def test_injection_plan_rejects_machining_bom_before_resolving_or_saving_inputs(self):
        self.reader.route['processes'][0]['processCode'] = 'JG'
        self.source = read_bom(PART, self.user.pk, reader=self.reader)
        with patch('production.plan_workflow_views.read_bom', return_value=self.source) as read, \
                patch('production.plan_workflow_views.resolve_inputs') as resolve:
            fetched = self.client.get(self.url, {**self.scope, 'action': 'bom', 'plan_id': self.plan.pk})
            approved = self.client.post(self.url, self.approval(), format='json')
            for response in (fetched, approved):
                self.assertEqual(response.status_code, 400, response.data)
                self.assertEqual(str(response.data[0]), 'mes_bom_process_mismatch')
            self.assertEqual(read.call_count, 2)
            resolve.assert_not_called()
        self.assertFalse(PlanMaterialApproval.objects.exists())
        self.assertFalse(PlanMesRequest.objects.exists())

    def test_client_actor_fields_cannot_change_provider_or_approval_identity(self):
        spoofed = get_user_model().objects.create_user(username='synthetic-spoofed-actor')
        submitted_actor = {'actor': spoofed.pk, 'actor_id': spoofed.pk,
            'actor_name': spoofed.username, 'approved_at': '2000-01-01T00:00:00Z',
            'created_at': '2000-01-01T00:00:00Z'}
        with patch('production.plan_workflow_views.read_bom', return_value=deepcopy(self.source)) as read, \
                patch('production.plan_workflow_views.resolve_inputs', side_effect=lambda source, rows, actor:
                    resolve_inputs(source, rows, actor, reader=self.reader)) as resolve:
            response = self.client.post(self.url, self.approval(**submitted_actor), format='json')
        self.assertEqual(response.status_code, 201, response.data)
        read.assert_called_once_with(PART, self.user.pk)
        self.assertEqual(resolve.call_args.args[2], self.user.pk)
        approval = PlanMaterialApproval.objects.get()
        self.assertEqual(approval.actor_id, self.user.pk)
        self.assertNotEqual(approval.created_at.year, 2000)
        self.assertTrue(set(submitted_actor).isdisjoint(approval.snapshot))
