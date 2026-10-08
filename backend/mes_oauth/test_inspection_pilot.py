"""Explicit ordinary-inspector pilot, with synthetic actors and zero live MES."""
from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import TestCase, override_settings
from django.urls import reverse
from rest_framework.exceptions import PermissionDenied
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from config.token_views import ScopedTokenObtainPairSerializer
from injection.models import UserProfile
from quality import test_inspection_requests as helpers
from quality.inspection_access import is_inspection_pilot
from quality.inspection_mes_stages import TEST_LABEL, stage_action
from quality.inspection_models import InspectionAudit, InspectionMesBinding, InspectionRequest
from quality.inspection_validation import digest
from quality.inspection_workflow import external_action, local_action, result_payload
from quality.test_inspection_mes_stages import StageFixture
from . import vault
from .access import can_verify_identity
from .session_guard import InspectionSession
from .test_connection import ConnectionFixture, CONNECTION_SETTINGS, CODE
from .test_inspection_session import InspectorFixture
from .test_vault import VaultFixture, LOGIN_SID
from .views import CALLBACK


def ordinary_inspector(name):
    user = get_user_model().objects.create_user(username=name,
        password='SYNTHETIC-PILOT-LOCAL-PASSWORD', is_staff=False, is_superuser=False)
    UserProfile.objects.filter(user=user).update(can_view_quality=True, can_edit_quality=False,
        is_admin=False, password_reset_required=False, is_using_temp_password=False)
    user.user_permissions.add(*Permission.objects.filter(content_type__app_label='quality',
        codename__in=['view_inspectionrequest', 'manage_inspectionrequest', 'submit_inspectionrequest']))
    return get_user_model().objects.get(pk=user.pk)


class InspectorPilotTests(InspectorFixture, APITestCase):
    def setUp(self):
        super().setUp()
        self.pilot = ordinary_inspector('SYNTHETIC-PILOT-A')
        self.other_pilot = ordinary_inspector('SYNTHETIC-PILOT-B')
        self.mes_user_map.update({str(self.pilot.pk): '92000000000000001',
                                  str(self.other_pilot.pk): '92000000000000002'})
        configuration = self.settings(INSPECTION_PILOT_ENABLED=True,
            INSPECTION_PILOT_USER_IDS=[self.pilot.pk, self.other_pilot.pk],
            MES_USER_OAUTH_USER_MAP=self.mes_user_map)
        configuration.enable()
        self.addCleanup(configuration.disable)

    def pilot_client(self, user=None):
        user = user or self.pilot
        client = APIClient()
        helpers.authenticate_inspection_client(client, user)
        return client

    def pilot_create(self, **changes):
        response = self.pilot_client().post(self.base_url, self.create_payload(**changes),
            format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 201)
        return response.data

    def pilot_approved(self):
        data = self.pilot_create()
        client = self.pilot_client()
        drafted = client.patch(self.base_url + f'{data["id"]}/', self.draft_payload(data['version']),
            format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(drafted.status_code, 200)
        submitted = client.post(self.base_url + f'{data["id"]}/submit/',
            {'version': drafted.data['version']}, format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(submitted.status_code, 200)
        self.assertEqual(submitted.data['submitted_by'], self.pilot.pk)
        reviewed = self.action(submitted.data, 'approve', user=self.reviewer)
        self.assertEqual(reviewed.status_code, 200)
        # Capabilities belong to the authenticated reader, not the reviewer who
        # returned the approval response on a different login.
        current = self.pilot_client().get(self.base_url + f'{data["id"]}/')
        self.assertEqual(current.status_code, 200)
        return current.data

    def binding(self, data):
        row = InspectionRequest.objects.get(pk=data['id'])
        row.quantity_mode = 'not_recorded'
        row.inspected_quantity = row.accepted_quantity = row.rejected_quantity = Decimal('0.000')
        row.require_evidence = False
        row.evidence = []
        row.inspection_items[0]['evidence_required'] = False
        row.measurements[0]['evidence_url'] = ''
        row.save()
        return InspectionMesBinding.objects.create(request=row, tenant='SYNTHETIC',
            qc_id='93000000000000001', work_order_id='93000000000000002',
            reviewed_result_digest=digest(result_payload(row)), test_only=True,
            test_label=TEST_LABEL + ' / SYNTHETIC-PILOT', contract={
                'production_task_id': '93000000000000003', 'equipment_id': '93000000000000004',
                'snapshot_id': '93000000000000005', 'actor_id': self.mes_user_map[str(self.pilot.pk)],
                'target_reference': 'SYNTHETIC', 'mapping_reference': 'SYNTHETIC',
                'label_reference': 'SYNTHETIC', 'side_effect_reference': 'SYNTHETIC',
                'items': [{'local_item_id': 'dimension', 'config_row_id': '93000000000000007',
                           'write_item_id': '93000000000000008', 'group': 'SYNTHETIC', 'seq': 1}]})

    def dispatch(self, data, action):
        return stage_action(self.pilot, data['id'], action, uuid.uuid4(), {'version': data['version']},
                            session=helpers.inspection_session(self.pilot))

    def test_default_off_and_unlisted_ordinary_users_are_denied(self):
        for values in ({'INSPECTION_PILOT_ENABLED': False}, {'INSPECTION_PILOT_USER_IDS': []}):
            with self.settings(**values):
                self.assertFalse(is_inspection_pilot(self.pilot))
                self.assertFalse(can_verify_identity(self.pilot))
                self.assertEqual(self.pilot_client().get(self.base_url).status_code, 403)

    def test_malformed_allowlist_never_admits_an_ordinary_inspector(self):
        for values in ('not-json', {}, [True], [0], [-1], [str(self.pilot.pk)],
                       [self.pilot.pk, self.pilot.pk], [2**63], list(range(1, 22))):
            with self.subTest(kind=type(values).__name__), self.settings(INSPECTION_PILOT_USER_IDS=values):
                self.assertFalse(is_inspection_pilot(self.pilot))

    def test_account_profile_and_view_permission_are_all_required(self):
        cases = [('user', 'is_active', False), ('user', 'is_staff', True),
                 ('profile', 'is_admin', True), ('profile', 'can_view_quality', False),
                 ('profile', 'password_reset_required', True), ('profile', 'is_using_temp_password', True)]
        for kind, field, value in cases:
            model = get_user_model() if kind == 'user' else UserProfile
            lookup = {'pk': self.pilot.pk} if kind == 'user' else {'user_id': self.pilot.pk}
            original = model.objects.get(**lookup)
            before = getattr(original, field)
            model.objects.filter(**lookup).update(**{field: value})
            self.assertFalse(is_inspection_pilot(get_user_model().objects.get(pk=self.pilot.pk)))
            model.objects.filter(**lookup).update(**{field: before})
        self.pilot.user_permissions.remove(Permission.objects.get(content_type__app_label='quality',
                                                                  codename='view_inspectionrequest'))
        self.assertFalse(is_inspection_pilot(get_user_model().objects.get(pk=self.pilot.pk)))

    def test_unusable_password_placeholder_and_missing_profile_cannot_enter(self):
        self.pilot.set_unusable_password()
        self.pilot.save(update_fields=['password'])
        self.assertFalse(is_inspection_pilot(get_user_model().objects.get(pk=self.pilot.pk)))
        UserProfile.objects.filter(user=self.other_pilot).delete()
        self.assertFalse(is_inspection_pilot(get_user_model().objects.get(pk=self.other_pilot.pk)))

    def test_capabilities_require_individual_permissions_without_broad_quality_edit(self):
        client = self.pilot_client()
        response = client.get(self.base_url + 'capabilities/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual({key: response.data[key] for key in
            ('can_view', 'can_manage', 'can_submit', 'can_review', 'access_scope', 'can_view_kanban')},
            dict(can_view=True, can_manage=True, can_submit=True, can_review=False,
                 access_scope='assigned_only', can_view_kanban=False))
        self.assertFalse(self.pilot.profile.can_edit_quality)
        self.assertFalse(self.pilot.is_staff)
        self.assertFalse(self.pilot.is_superuser)
        self.pilot.user_permissions.remove(Permission.objects.get(content_type__app_label='quality',
                                                                  codename='manage_inspectionrequest'))
        user = get_user_model().objects.get(pk=self.pilot.pk)
        self.assertEqual(self.pilot_client(user).post(self.base_url, self.create_payload(),
            format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4())).status_code, 403)

    def test_own_rows_only_and_other_actor_actions_are_hidden_and_denied(self):
        own = self.pilot_create()
        other = self.create(work_order_ref='SYNTHETIC-OTHER-WO', task_ref='SYNTHETIC-OTHER-TASK')
        client = self.pilot_client()
        result = client.get(self.base_url)
        self.assertEqual([row['id'] for row in result.data['results']], [own['id']])
        self.assertEqual(result.data['count'], 1)
        self.assertEqual(client.get(self.base_url + f'{other["id"]}/').status_code, 404)
        self.assertEqual(client.get(self.base_url + 'kanban/').status_code, 403)
        for action in ('submit', 'approve', 'sync', 'mes-save', 'mes-finish', 'mes-reconcile', 'reinspect'):
            response = client.post(self.base_url + f'{other["id"]}/{action}/',
                {'version': other['version']}, format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
            self.assertEqual(response.status_code, 404)
        with self.assertRaises(PermissionDenied):
            local_action(self.pilot, other['id'], 'draft', uuid.uuid4(), {'version': other['version']},
                         session=helpers.inspection_session(self.pilot))

    def test_pilot_cannot_review_even_if_review_permission_is_accidentally_granted(self):
        data = self.pilot_create()
        self.pilot.user_permissions.add(Permission.objects.get(content_type__app_label='quality',
                                                               codename='review_inspectionrequest'))
        self.pilot = get_user_model().objects.get(pk=self.pilot.pk)
        client = self.pilot_client()
        self.assertFalse(client.get(self.base_url + 'capabilities/').data['can_review'])
        self.assertEqual(client.post(self.base_url + f'{data["id"]}/approve/', {'version': data['version']},
            format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4())).status_code, 403)

    def test_configured_pilot_cannot_fall_back_to_admin_flow_after_role_change(self):
        get_user_model().objects.filter(pk=self.pilot.pk).update(is_superuser=True, is_staff=True)
        user = get_user_model().objects.get(pk=self.pilot.pk)
        self.assertFalse(is_inspection_pilot(user))
        self.assertFalse(can_verify_identity(user))
        self.assertEqual(self.pilot_client(user).get(self.base_url).status_code, 403)

    def test_signed_pilot_marker_still_prevents_admin_fallback_after_list_removal(self):
        token = ScopedTokenObtainPairSerializer.get_token(self.pilot).access_token
        get_user_model().objects.filter(pk=self.pilot.pk).update(is_superuser=True, is_staff=True)
        user = get_user_model().objects.get(pk=self.pilot.pk)
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(token))
        with self.settings(INSPECTION_PILOT_USER_IDS=[]):
            self.assertEqual(client.get(self.base_url).status_code, 403)
            session = InspectionSession.from_token(user, token)
            with self.assertRaises(PermissionDenied):
                with session.lock('manage', actor_id=user.pk):
                    pass

    def test_server_classified_older_token_keeps_scope_across_first_lock_window(self):
        token = ScopedTokenObtainPairSerializer.get_token(self.pilot).access_token
        del token['inspection_pilot_scope']  # Older family predating enrollment.
        self.pilot._inspection_pilot_scope = True  # Authentication classification.
        get_user_model().objects.filter(pk=self.pilot.pk).update(is_superuser=True, is_staff=True)
        with self.settings(INSPECTION_PILOT_USER_IDS=[]):
            session = InspectionSession.from_token(self.pilot, token)
            with self.assertRaises(PermissionDenied):
                with session.lock('manage', actor_id=self.pilot.pk):
                    pass

    def test_own_save_and_explicit_finish_keep_actor_and_independent_admin_review(self):
        data = self.pilot_approved()
        self.binding(data)
        stage = StageFixture()
        with patch('quality.inspection_mes_stages.get_stage_adapter', return_value=stage):
            saved, status = self.dispatch(data, 'mes-save')
            self.assertEqual(status, 200)
            self.assertEqual(saved['mes_workflow']['phase'], 'saved')
            self.assertTrue(saved['mes_workflow']['can_finish'])
            finished, status = self.dispatch(saved, 'mes-finish')
            self.assertEqual(status, 200)
        self.assertEqual(finished['mes_completion_status'], 'completed')
        self.assertEqual(finished['submitted_by'], self.pilot.pk)
        self.assertEqual(finished['reviewed_by'], self.reviewer.pk)
        self.assertEqual([call[0] for call in stage.calls], ['save', 'finish'])
        self.assertEqual(InspectionAudit.objects.latest('id').actor_id, self.pilot.pk)

    def test_allowlist_removal_between_reservation_and_dispatch_blocks_without_write(self):
        data = self.pilot_approved()
        self.binding(data)
        original = InspectionSession.lock
        stage, entered = StageFixture(), 0

        @contextmanager
        def interrupted(session, *args, **kwargs):
            nonlocal entered
            entered += 1
            if entered == 2:
                with self.settings(INSPECTION_PILOT_USER_IDS=[]):
                    with original(session, *args, **kwargs) as actor:
                        yield actor
            else:
                with original(session, *args, **kwargs) as actor:
                    yield actor

        with patch('quality.inspection_mes_stages.get_stage_adapter', return_value=stage), \
                patch.object(InspectionSession, 'lock', interrupted):
            _, status = self.dispatch(data, 'mes-save')
        self.assertEqual(status, 403)
        self.assertEqual(stage.calls, [])

    def test_reassignment_before_dispatch_blocks_original_actor(self):
        data = self.pilot_approved()
        self.binding(data)
        original = InspectionSession.lock
        stage, entered = StageFixture(), 0

        @contextmanager
        def reassigned(session, *args, **kwargs):
            nonlocal entered
            entered += 1
            if entered == 2:
                InspectionRequest.objects.filter(pk=data['id']).update(assigned_to=self.other_pilot)
            with original(session, *args, **kwargs) as actor:
                yield actor

        with patch('quality.inspection_mes_stages.get_stage_adapter', return_value=stage), \
                patch.object(InspectionSession, 'lock', reassigned):
            _, status = self.dispatch(data, 'mes-save')
        self.assertEqual(status, 403)
        self.assertEqual(stage.calls, [])
        self.assertEqual(InspectionAudit.objects.latest('id').actor_id, self.pilot.pk)

    def test_pilot_admission_does_not_enable_actual_mes_stage_adapter(self):
        data = self.pilot_approved()
        self.binding(data)
        response, status = self.dispatch(data, 'mes-save')
        self.assertEqual(status, 503)
        self.assertEqual(response['code'], 'mes_contract_unverified')
        self.assertEqual(InspectionRequest.objects.get(pk=data['id']).operations.filter(
            scope__endswith=':mes-save').count(), 0)

    def test_pilot_cannot_use_legacy_combined_save_and_finish(self):
        data = self.pilot_approved()
        self.assertFalse(data['capabilities']['can_sync'])
        with self.assertRaises(PermissionDenied):
            external_action(self.pilot, data['id'], 'sync', uuid.uuid4(), {'version': data['version']},
                            session=helpers.inspection_session(self.pilot))
        self.assertEqual(self.adapter.save_calls, [])

    def test_reinspection_replay_rechecks_child_current_assignment(self):
        data = self.pilot_create()
        InspectionRequest.objects.filter(pk=data['id']).update(status='failed', judgement='fail')
        client, key = self.pilot_client(), uuid.uuid4()
        url = self.base_url + f'{data["id"]}/reinspect/'
        payload = {'version': data['version'], 'reason': 'SYNTHETIC independent reinspection'}
        child = client.post(url, payload, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(child.status_code, 201)
        InspectionRequest.objects.filter(pk=child.data['id']).update(assigned_to=self.other_pilot)
        self.assertEqual(client.get(self.base_url + f'{child.data["id"]}/').status_code, 404)
        replay = client.post(url, payload, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(replay.status_code, 403)
        self.assertEqual(InspectionRequest.objects.count(), 2)

    def test_create_replay_rechecks_current_assignment(self):
        client, key = self.pilot_client(), uuid.uuid4()
        payload = self.create_payload()
        created = client.post(self.base_url, payload, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(created.status_code, 201)
        InspectionRequest.objects.filter(pk=created.data['id']).update(assigned_to=self.other_pilot)
        replay = client.post(self.base_url, payload, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(replay.status_code, 403)
        self.assertEqual(InspectionRequest.objects.count(), 1)

    def test_superuser_flow_remains_available_with_pilot_off(self):
        with self.settings(INSPECTION_PILOT_ENABLED=False):
            self.assertEqual(self.client.get(self.base_url + 'capabilities/').status_code, 200)
            self.assertEqual(self.client.get(self.base_url + 'capabilities/').data['access_scope'], 'all')


@override_settings(**CONNECTION_SETTINGS)
class InspectorPilotOAuthTests(ConnectionFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.user.is_staff = self.user.is_superuser = False
        self.user.save(update_fields=['is_staff', 'is_superuser'])
        UserProfile.objects.filter(user=self.user).update(can_view_quality=True, can_edit_quality=False, is_admin=False)
        self.user.user_permissions.add(*Permission.objects.filter(content_type__app_label='quality',
            codename__in=['view_inspectionrequest', 'manage_inspectionrequest', 'submit_inspectionrequest']))
        self.user = get_user_model().objects.get(pk=self.user.pk)
        configuration = self.settings(INSPECTION_PILOT_ENABLED=True, INSPECTION_PILOT_USER_IDS=[self.user.pk])
        configuration.enable()
        self.addCleanup(configuration.disable)
        self.tokens = self.obtain(self.user)

    def test_ordinary_pilot_uses_existing_csrf_bridge_identity_contract_without_admin_access(self):
        self.begin()
        self.assertEqual(self.browser.get(CALLBACK, secure=True).status_code, 200)
        response = self.csrf_post(CALLBACK, {'code': CODE})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['identity_verified'])
        self.assertFalse(response.json()['live_ready'])
        self.assertEqual(self.browser.get('/admin/', secure=True).status_code, 403)
        self.provider.exchange.assert_called_once_with(CODE)
        self.provider.userinfo.assert_called_once()
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_staff)
        self.assertFalse(self.user.is_superuser)

    def test_pilot_off_or_mapping_missing_prevents_ticket_and_provider_use(self):
        for values in ({'INSPECTION_PILOT_ENABLED': False}, {'MES_USER_OAUTH_USER_MAP': {}}):
            with self.settings(**values):
                self.assertEqual(self.action('launch').status_code, 403)
        self.assert_no_provider()

    def test_deactivated_pilot_cannot_consume_previously_created_ticket(self):
        ticket = self.launch()
        get_user_model().objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.bridge(ticket).status_code, 403)
        self.assert_no_provider()

    def test_launch_keeps_scope_when_role_and_list_change_before_user_lock(self):
        original = vault._lock_user
        removed = self.settings(INSPECTION_PILOT_USER_IDS=[])
        self.addCleanup(removed.disable)

        def changed(actor_id):
            removed.enable()
            get_user_model().objects.filter(pk=actor_id).update(is_staff=True, is_superuser=True)
            return original(actor_id)

        with patch('mes_oauth.vault._lock_user', side_effect=changed):
            self.assertEqual(self.action('launch').status_code, 403)
        self.assert_no_provider()


class InspectorPilotCredentialScopeTests(VaultFixture, TestCase):
    def test_recheck_rejects_signed_pilot_admin_before_provider_factory(self):
        self.store()
        token = AccessToken.for_user(self.user)
        token['inspection_pilot_scope'] = True
        token['mes_sid'] = LOGIN_SID
        token['mes_login_exp'] = int(self.login.expires_at.timestamp())
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(token))
        with self.settings(INSPECTION_PILOT_ENABLED=False, INSPECTION_PILOT_USER_IDS=[]), \
                patch('mes_oauth.views.get_provider') as factory:
            response = client.post(reverse('mes-connection-recheck'), {}, format='json',
                                   secure=True, HTTP_ORIGIN='https://testserver')
        self.assertEqual(response.status_code, 409)
        factory.assert_not_called()
        self.assert_no_provider()

    def test_scoped_marker_survives_vault_fresh_user_lookup(self):
        self.store()
        with self.settings(INSPECTION_PILOT_ENABLED=False, INSPECTION_PILOT_USER_IDS=[]):
            with self.assertRaises(vault.VaultBlocked):
                vault.recheck_identity(self.user.pk, self.login_digest, self.provider, pilot_scoped=True)
        self.assert_no_provider()
