"""Real signed pilot admission and area authority, using disposable fixtures only."""
from copy import deepcopy
from datetime import timedelta
import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from config.authentication import ScopedJWTAuthentication
from injection.models import UserProfile
from mes_oauth.models import MESLoginSession
from mes_oauth.pilot_scope import PILOT_SCOPE_CLAIM
from . import test_inspection_requests as request_fixtures
from . import test_inspection_roles as role_fixtures
from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest, InspectionNonconformance
from .inspection_role_models import InspectionAreaResult, InspectionShiftSetting, InspectionRoleWorkflow
from .inspection_views import InspectionRequestViewSet
from .inspection_workflow import local_action


class InspectionRoleSecurityTests(role_fixtures.RoleFixtures, APITestCase):
    base = '/api/quality/inspection-requests/'

    def setUp(self):
        super().setUp()
        # The role fixture's first inspector becomes an ordinary pilot. Its
        # existing synthetic assignment remains, with only current test grants.
        self.appearance.is_staff = self.appearance.is_superuser = False
        self.appearance.set_password('SYNTHETIC-role-pilot-password')
        self.appearance.save(update_fields=['is_staff', 'is_superuser', 'password'])
        UserProfile.objects.filter(user=self.appearance).update(
            can_view_quality=True, can_edit_quality=True, is_admin=False,
            password_reset_required=False, is_using_temp_password=False)
        self.appearance.user_permissions.set(Permission.objects.filter(
            content_type__app_label='quality', codename__in=[
                'view_inspectionrequest', 'manage_inspectionrequest', 'submit_inspectionrequest']))
        self.appearance = get_user_model().objects.get(pk=self.appearance.pk)
        pilot_settings = override_settings(INSPECTION_PILOT_ENABLED=True,
            INSPECTION_PILOT_USER_IDS=[self.appearance.pk])
        pilot_settings.enable()
        self.addCleanup(pilot_settings.disable)
        authentication = patch.object(InspectionRequestViewSet, 'authentication_classes',
                                      [ScopedJWTAuthentication])
        authentication.start()
        self.addCleanup(authentication.stop)
        # A read/write test accidentally crossing the MES boundary must fail.
        for target in ('quality.inspection_mes_stages.get_stage_adapter',
                       'mes_oauth.inspection_credentials.call_with_user_credential'):
            boundary = patch(target, side_effect=AssertionError('Synthetic role test contacted MES boundary.'))
            boundary.start()
            self.addCleanup(boundary.stop)
        self.use_signed_login(self.appearance)

    def use_signed_login(self, user):
        token = request_fixtures.synthetic_token(user)
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(token))
        return token

    def post(self, suffix, payload, *, key=None):
        return self.client.post(self.base + suffix, payload, format='json',
                                HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))

    def area_post(self, action, payload, *, area='appearance', key=None, request_id=None):
        return self.post(f'{request_id or self.request.pk}/{action}/',
                         dict(payload, area=area), key=key)

    def state(self):
        request = self.request_now()
        areas = list(InspectionAreaResult.objects.filter(workflow=self.workflow).order_by('area').values(
            'area', 'assigned_to_id', 'version', 'status', 'judgement', 'measurements',
            'evidence', 'completed_by_id', 'completed_at'))
        return deepcopy((request.version, request.status, request.judgement,
            request.measurements, request.evidence, areas, InspectionAudit.objects.count(),
            InspectionOperation.objects.count(), InspectionShiftSetting.objects.count()))

    def unrelated_request(self):
        return InspectionRequest.objects.create(identity=str(uuid.uuid4()),
            work_order_ref='SYNTHETIC-UNASSIGNED-WO', task_ref='SYNTHETIC-UNASSIGNED-TASK',
            part_no='SYNTHETIC-UNASSIGNED-PART', equipment_ref='SYNTHETIC-UNASSIGNED-MACHINE',
            target_quantity='10', uom='EA', warehouse_ref='SYNTHETIC-UNASSIGNED-WAREHOUSE',
            lot_ref='SYNTHETIC-UNASSIGNED-LOT', work_started_at=timezone.now() - timedelta(minutes=5),
            assigned_to=self.outsider, assigned_to_name=self.outsider.username,
            quantity_mode='not_recorded', inspection_items=deepcopy(self.request.inspection_items))

    def saved_attempt(self):
        payload = self.payload('appearance', measurements=[self.measure('appearance')])
        key = uuid.uuid4()
        response = self.area_post('area-save', payload, key=key)
        self.assertEqual(response.status_code, 200, response.data)
        session = request_fixtures.inspection_session(self.appearance)
        login = MESLoginSession.objects.get(pk=session.login_digest)
        self.assertEqual(login.actor_id, self.appearance.pk)
        return payload, key, login

    def assert_denied_replay_without_mutation(self, payload, key):
        before = self.state()
        with patch('quality.inspection_roles.area_save') as handler:
            response = self.area_post('area-save', payload, key=key)
        self.assertIn(response.status_code, (401, 403), response.data)
        handler.assert_not_called()
        self.assertEqual(self.state(), before)

    def test_signed_restricted_pilot_saves_completes_and_reopens_own_area(self):
        token = request_fixtures.synthetic_token(self.appearance)
        self.assertIs(token[PILOT_SCOPE_CLAIM], True)
        self.assertFalse(self.appearance.is_superuser or self.appearance.is_staff)
        response = self.area_post('area-save', self.payload('appearance',
            measurements=[self.measure('appearance')]))
        self.assertEqual(response.status_code, 200, response.data)
        response = self.area_post('area-complete', self.payload('appearance', judgement='pass'))
        self.assertEqual(response.status_code, 200, response.data)
        area = InspectionAreaResult.objects.get(workflow=self.workflow, area='appearance')
        self.assertEqual((area.status, area.completed_by_id), ('complete', self.appearance.pk))
        other = InspectionAreaResult.objects.get(workflow=self.workflow, area='dimension')
        self.assertEqual((other.status, other.measurements), ('draft', []))
        response = self.area_post('area-reopen', self.payload('appearance',
            reason='SYNTHETIC explicit own-area correction'))
        self.assertEqual(response.status_code, 200, response.data)
        area.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual((area.status, area.judgement, area.completed_by_id), ('draft', '', None))
        self.assertEqual(area.measurements, [self.measure('appearance')])
        self.assertEqual((other.status, other.measurements), ('draft', []))

    def test_pilot_list_and_detail_show_current_assigned_requests_only(self):
        unrelated = self.unrelated_request()
        before = self.state()
        response = self.client.get(self.base)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual([row['id'] for row in response.data['results']], [self.request.pk])
        self.assertEqual(self.client.get(self.base + f'{self.request.pk}/').status_code, 200)
        self.assertEqual(self.client.get(self.base + f'{unrelated.pk}/').status_code, 404)
        self.assertEqual(self.state(), before)

    def test_other_area_and_foreign_item_are_denied_without_writes(self):
        before = self.state()
        for action in ('area-save', 'area-complete', 'area-reopen'):
            with self.subTest(action=action):
                response = self.area_post(action, self.payload('dimension',
                    reason='SYNTHETIC cannot act for colleague'), area='dimension')
                self.assertEqual(response.status_code, 403, response.data)
        response = self.area_post('area-save', self.payload('appearance',
            measurements=[self.measure('dimension')]))
        self.assertEqual(response.status_code, 403, response.data)
        self.assertEqual(self.state(), before)

    def test_unassigned_request_area_mutations_are_hidden(self):
        unrelated = self.unrelated_request()
        before = self.state()
        for action in ('area-save', 'area-complete', 'area-reopen'):
            with self.subTest(action=action):
                response = self.area_post(action, self.payload('appearance'), request_id=unrelated.pk)
                self.assertEqual(response.status_code, 404, response.data)
        self.assertEqual(self.state(), before)
        unrelated.refresh_from_db()
        self.assertEqual((unrelated.version, unrelated.measurements), (1, []))

    def test_pilot_cannot_configure_shifts_assignments_or_replace_whole_draft(self):
        before = self.state()
        self.assertEqual(self.client.get(self.base + 'role-settings/').status_code, 403)
        self.assertEqual(self.post('role-settings/', self.shift_payload(code='SYNTHETIC-DENIED')).status_code, 403)
        response = self.client.patch(self.base + f'role-settings/{self.shift_id}/',
            {'version': 1, 'label': 'SYNTHETIC denied change', 'reason': 'SYNTHETIC'}, format='json',
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 403, response.data)
        response = self.post(f'{self.request.pk}/role-configure/', {
            'config_version': self.workflow.config_version, 'shift_setting_id': self.shift_id,
            'shift_version': 1, 'shift_date': '2026-10-07',
            'item_areas': {'look': 'appearance', 'size': 'dimension', 'size-optional': 'dimension'},
            'reason': 'SYNTHETIC denied reassignment'})
        self.assertEqual(response.status_code, 403, response.data)
        response = self.client.patch(self.base + f'{self.request.pk}/', {
            'version': self.request_now().version, 'measurements': [self.measure('appearance')],
            'evidence': [], 'inspected_quantity': '0', 'accepted_quantity': '0',
            'rejected_quantity': '0', 'judgement': 'pass', 'notes': 'SYNTHETIC whole draft denied'},
            format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(str(response.data['code']), 'area_actions_required')
        self.assertEqual(self.state(), before)

    def test_revoked_login_cannot_replay_cached_area_success(self):
        payload, key, login = self.saved_attempt()
        MESLoginSession.objects.filter(pk=login.pk).update(revoked_at=timezone.now())
        self.assert_denied_replay_without_mutation(payload, key)

    def test_expired_idle_deadline_cannot_replay_cached_area_success(self):
        payload, key, login = self.saved_attempt()
        now = timezone.now()
        self.assertGreater(login.expires_at, now)
        MESLoginSession.objects.filter(pk=login.pk).update(session_version=2,
            last_activity_at=now - timedelta(hours=2), idle_expires_at=now - timedelta(hours=1))
        self.assert_denied_replay_without_mutation(payload, key)

    def test_revoked_permission_cannot_replay_cached_area_success(self):
        payload, key, _ = self.saved_attempt()
        self.appearance.user_permissions.remove(Permission.objects.get(
            content_type__app_label='quality', codename='manage_inspectionrequest'))
        self.assert_denied_replay_without_mutation(payload, key)

    def test_changed_current_assignment_cannot_replay_cached_area_success(self):
        payload, key, _ = self.saved_attempt()
        InspectionAreaResult.objects.filter(workflow=self.workflow, area='appearance').update(
            assigned_to=self.outsider)
        before = self.state()
        response = self.area_post('area-save', payload, key=key)
        self.assertEqual(response.status_code, 404, response.data)
        self.assertEqual(self.state(), before)

    def submitted_by_separate_owner(self, *, failed=False):
        self.complete('appearance')
        if failed:
            self.action(role_fixtures.area_complete, 'dimension', self.payload('dimension',
                measurements=[self.measure('dimension', value='12', judgement='fail')], judgement='fail'))
        else:
            self.complete('dimension')
        current = self.request_now()
        local_action(self.admin, current.pk, 'submit', uuid.uuid4(),
            {'version': current.version, 'reason': ''},
            session=request_fixtures.inspection_session(self.admin))
        self.use_signed_login(self.dimension)

    def test_contributing_superuser_cannot_approve_or_reject_own_area_results(self):
        self.submitted_by_separate_owner()
        current = self.request_now()
        response = self.client.get(self.base + f'{current.pk}/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(response.data['capabilities']['can_review'])
        before = self.state()
        for action in ('approve', 'reject'):
            with self.subTest(action=action):
                response = self.post(f'{current.pk}/{action}/', {
                    'version': current.version, 'reason': 'SYNTHETIC cannot review own area'})
                self.assertEqual(response.status_code, 403, response.data)
        self.assertEqual(self.state(), before)

    def test_contributing_superuser_cannot_review_failed_own_area(self):
        self.submitted_by_separate_owner(failed=True)
        current = self.request_now()
        self.assertEqual(current.status, 'failed')
        response = self.client.get(self.base + f'{current.pk}/')
        self.assertFalse(response.data['capabilities']['can_review_failure'])
        before = self.state()
        response = self.post(f'{current.pk}/review-failure/', {
            'version': current.version, 'reason': 'SYNTHETIC cannot review own failed area'})
        self.assertEqual(response.status_code, 403, response.data)
        self.assertEqual(self.state(), before)

    def test_reviewed_role_failure_reinspection_preserves_parent_and_requires_new_assignment(self):
        response = self.area_post('area-complete', self.payload('appearance',
            measurements=[self.measure('appearance')], judgement='pass'))
        self.assertEqual(response.status_code, 200, response.data)
        self.use_signed_login(self.dimension)
        response = self.area_post('area-complete', self.payload('dimension',
            measurements=[self.measure('dimension', value='12', judgement='fail')], judgement='fail'),
            area='dimension')
        self.assertEqual(response.status_code, 200, response.data)
        self.use_signed_login(self.admin)
        response = self.post(f'{self.request.pk}/submit/', {
            'version': self.request_now().version, 'reason': ''})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['status'], 'failed')
        self.use_signed_login(self.outsider)
        response = self.post(f'{self.request.pk}/review-failure/', {
            'version': self.request_now().version, 'reason': 'SYNTHETIC independent failure review'})
        self.assertEqual(response.status_code, 200, response.data)
        parent = self.request_now()
        self.assertEqual((parent.status, parent.judgement), ('approved', 'fail'))
        parent_fields = ('measurements', 'evidence', 'judgement', 'status', 'submitted_by_id',
                         'reviewed_by_id', 'sync_status', 'mes_completion_status')
        parent_evidence = deepcopy({name: getattr(parent, name) for name in parent_fields})
        parent_areas = self.state()[5]
        self.workflow.refresh_from_db()
        parent_snapshots = deepcopy((self.workflow.shift_snapshot, self.workflow.actor_snapshot,
                                     self.workflow.item_areas, self.workflow.config_version))
        parent_version = parent.version
        self.use_signed_login(self.admin)
        response = self.post(f'{parent.pk}/reinspect/', {
            'version': parent_version, 'reason': 'SYNTHETIC explicit role reinspection'})
        self.assertEqual(response.status_code, 201, response.data)
        child = InspectionRequest.objects.get(pk=response.data['id'])
        self.assertEqual((child.parent_id, child.assigned_to_id, child.status), (parent.pk, self.admin.pk, 'draft'))
        self.assertEqual((child.measurements, child.evidence, child.judgement), ([], [], ''))
        workflow = InspectionRoleWorkflow.objects.get(request=child)
        self.assertEqual((workflow.status, workflow.config_version, workflow.shift_setting_id), ('unconfigured', 1, None))
        self.assertEqual((workflow.shift_snapshot, workflow.actor_snapshot, workflow.item_areas), ({}, {}, {}))
        areas = list(InspectionAreaResult.objects.filter(workflow=workflow).order_by('area'))
        self.assertEqual([area.area for area in areas], ['appearance', 'dimension'])
        for area in areas:
            self.assertEqual((area.assigned_to_id, area.completed_by_id), (None, None))
            self.assertEqual((area.measurements, area.evidence, area.judgement, area.status), ([], [], '', 'draft'))
        self.assertTrue(response.data['role_workflow']['can_configure'])
        self.assertFalse(response.data['role_workflow']['configured'])
        self.assertFalse(response.data['capabilities']['can_edit'])
        self.assertFalse(response.data['capabilities']['can_submit'])
        parent.refresh_from_db()
        self.workflow.refresh_from_db()
        self.assertEqual({name: getattr(parent, name) for name in parent_fields}, parent_evidence)
        self.assertEqual(parent.version, parent_version + 1)
        self.assertEqual(self.state()[5], parent_areas)
        self.assertEqual((self.workflow.shift_snapshot, self.workflow.actor_snapshot,
                          self.workflow.item_areas, self.workflow.config_version), parent_snapshots)
        self.assertEqual(InspectionNonconformance.objects.get(request=parent).state, 'open')
        self.assertFalse(InspectionNonconformance.objects.filter(request=child).exists())
