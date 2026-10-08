"""Synthetic inspection contracts; no tenant credentials, MES network or live DB.

The fake adapter uses the normalized application boundary. Its field mapping is
deliberately not evidence that an official Blacklake endpoint supports this flow.
"""
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal
import uuid
from unittest import mock

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.utils import timezone
from rest_framework.test import APITestCase

from config.token_views import ScopedTokenObtainPairSerializer
from injection.models import UserProfile
from mes_oauth.session_guard import InspectionSession
from .inspection_adapter import MesRejected
from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest
from .inspection_validation import digest
from .inspection_workflow import result_payload


def synthetic_token(user):
    """Keep one synthetic signed login family per fixture user instance."""
    if not hasattr(user, '_inspection_test_access_token'):
        user._inspection_test_access_token = ScopedTokenObtainPairSerializer.get_token(user).access_token
    return user._inspection_test_access_token


def authenticate_inspection_client(client, user, *, token=None):
    if user is not None and token is None:
        token = synthetic_token(user)
    client.force_authenticate(user, token=token if user is not None else None)


def inspection_session(user):
    return InspectionSession.from_token(user, synthetic_token(user))


class SyntheticInspectionAdapter:
    """Bounded request projection and conditional write confirmations only."""
    enabled = True

    def __init__(self):
        self.refresh_calls = []
        self.save_calls = []
        self.overrides = {}
        self.result = None
        self.save_mode = 'success'
        self.complete_status = 2
        self.complete_qc_status = 1
        self.tenant_receipt_allowed = True
        self.refresh_error = None
        self.on_save = None

    def capabilities(self):
        return {'enabled': True, 'reason_code': '', 'message': 'synthetic only',
                'can_refresh': True, 'can_sync': True}

    def refresh(self, request, operation):
        self.refresh_calls.append((request.pk, str(operation.key)))
        if self.refresh_error:
            raise self.refresh_error
        snapshot = {field: getattr(request, field) for field in (
            'work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'lot_ref', 'uom', 'warehouse_ref')}
        snapshot.update(target_quantity=str(request.target_quantity), available_quantity='10.000',
                        task_status=1, qc_status=3, work_started=True,
                        receipt_allowed=False, state_version='synthetic-state-1',
                        result_digest='', external_result_id='')
        if self.result:
            snapshot.update(self.result)
        snapshot.update(self.overrides)
        # Raw transport fields must never be persisted or serialized.
        snapshot['access_token'] = 'synthetic-sensitive-token'
        return snapshot

    def save_result(self, request, operation):
        self.save_calls.append((request.pk, str(operation.key), deepcopy(request.mes_snapshot)))
        result = {'result_digest': digest(result_payload(request)), 'external_result_id': 'SYNTHETIC-RESULT-001',
                  'task_status': self.complete_status, 'qc_status': self.complete_qc_status,
                  'state_version': 'synthetic-state-2', 'receipt_allowed': self.tenant_receipt_allowed}
        if self.save_mode in {'success', 'timeout_after_commit', 'partial', 'wrong_digest'}:
            self.result = dict(result)
        if self.save_mode == 'partial':
            self.result['task_status'] = 1
        if self.save_mode == 'wrong_digest':
            self.result['result_digest'] = 'another-result'
        if self.on_save:
            self.on_save(request, operation)
        if self.save_mode == 'rejected':
            raise MesRejected('synthetic-sensitive-token must never be exposed')
        if self.save_mode.startswith('timeout'):
            raise TimeoutError('https://secret.invalid/?token=synthetic-sensitive-token')
        if self.save_mode == 'partial':
            return {'confirmed': False, **result}
        if self.save_mode == 'wrong_digest':
            return {'confirmed': True, **result, 'result_digest': 'another-result'}
        return {'confirmed': True, **result}


class InspectionRequestContractTests(APITestCase):
    base_url = '/api/quality/inspection-requests/'

    def setUp(self):
        self.editor = self.make_user('inspection-editor', superuser=True, permissions=('manage', 'submit'))
        self.reviewer = self.make_user('inspection-reviewer', superuser=True, permissions=('review',))
        self.viewer = self.make_user('inspection-viewer', superuser=True, edit=False)
        self.other_editor = self.make_user('inspection-other-editor', superuser=True, permissions=('manage', 'submit'))
        self.mes_user_map = {str(user.pk): str(91000000000000006 + index)
                            for index, user in enumerate((self.editor, self.reviewer,
                                                          self.viewer, self.other_editor))}
        mapping_settings = self.settings(MES_USER_OAUTH_USER_MAP=self.mes_user_map)
        mapping_settings.enable()
        self.addCleanup(mapping_settings.disable)
        self.adapter = SyntheticInspectionAdapter()
        authenticate_inspection_client(self.client, self.editor)

    def make_user(self, name, *, permissions=(), view=True, edit=True, staff=False, superuser=False, active=True):
        user = get_user_model().objects.create_user(username=name, is_staff=staff, is_superuser=superuser,
                                                    is_active=active)
        UserProfile.objects.filter(user=user).update(can_view_quality=view, can_edit_quality=edit)
        if permissions:
            user.user_permissions.add(*Permission.objects.filter(
                content_type__app_label='quality', codename__in=[f'{p}_inspectionrequest' for p in permissions]))
        return get_user_model().objects.get(pk=user.pk)

    def create_payload(self, **overrides):
        payload = {'work_order_ref': 'SYNTHETIC-WO-001', 'task_ref': 'SYNTHETIC-TASK-001',
                   'part_no': 'synthetic-part', 'equipment_ref': 'SYNTHETIC-MACHINE-001',
                   'inspection_type': 'first', 'target_quantity': '10.000', 'uom': 'EA',
                   'warehouse_ref': 'SYNTHETIC-WAREHOUSE', 'lot_ref': 'SYNTHETIC-LOT',
                   'require_evidence': True, 'quantity_mode': 'recorded',
                   'work_started_at': (timezone.now() - timedelta(minutes=5)).isoformat(),
                   'inspection_items': [{'id': 'dimension', 'label': '치수 / 尺寸', 'kind': 'number',
                                         'unit': 'mm', 'minimum': '9.5', 'maximum': '10.5',
                                         'evidence_required': True, 'required': True}]}
        payload.update(overrides)
        return payload

    def draft_payload(self, version, **overrides):
        payload = {'version': version, 'measurements': [{'item_id': 'dimension', 'value': '10.0',
                    'judgement': 'pass', 'evidence_url': 'https://evidence.example/dimension.png'}],
                   'evidence': [{'label': '검사 기록', 'url': 'https://evidence.example/inspection.pdf'}],
                   'inspected_quantity': '10.000', 'accepted_quantity': '10.000', 'rejected_quantity': '0.000',
                   'judgement': 'pass', 'notes': '합성 자료 / 合成数据'}
        payload.update(overrides)
        return payload

    def post(self, suffix='', data=None, *, user=None, key=None):
        if user:
            authenticate_inspection_client(self.client, user)
        return self.client.post(self.base_url + suffix, data or {}, format='json',
                                HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))

    def create(self, **overrides):
        authenticate_inspection_client(self.client, self.editor)
        response = self.post(data=self.create_payload(**overrides))
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def draft(self, data, **overrides):
        authenticate_inspection_client(self.client, self.editor)
        response = self.client.patch(self.base_url + f'{data["id"]}/',
            self.draft_payload(data['version'], **overrides), format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def action(self, data, action, *, user=None, key=None, version=None, **extra):
        return self.post(f'{data["id"]}/{action}/', {'version': data['version'] if version is None else version, **extra},
                         user=user or self.editor, key=key)

    def approved(self):
        data = self.draft(self.create())
        response = self.action(data, 'submit')
        self.assertEqual(response.status_code, 200, response.data)
        response = self.action(response.data, 'approve', user=self.reviewer)
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def adapter_patch(self):
        return mock.patch('quality.inspection_adapter.get_inspection_adapter', return_value=self.adapter)

    def synced(self):
        response = self.action(self.approved(), 'sync')
        self.assertEqual(response.status_code, 200, response.data)
        return response.data


    def test_read_requires_active_quality_access_and_missing_profile_fails_closed(self):
        hidden = self.make_user('hidden', view=False)
        inactive = self.make_user('inactive', active=False, superuser=True, staff=True)
        missing = self.make_user('missing-profile')
        UserProfile.objects.filter(user=missing).delete()
        for user in (hidden, inactive, missing):
            with self.subTest(user=user.username):
                authenticate_inspection_client(self.client, user)
                self.assertEqual(self.client.get(self.base_url).status_code, 403)
                self.assertEqual(self.client.get(self.base_url + 'capabilities/').status_code, 403)
        authenticate_inspection_client(self.client, None)
        response = self.client.get(self.base_url)
        self.assertIn(response.status_code, (401, 403))
        if response.status_code == 401:
            self.assertTrue(response.has_header('WWW-Authenticate'))

    def test_admin_read_does_not_seed_or_mutate_and_quality_viewer_cannot_write(self):
        data = self.create()
        before = (InspectionRequest.objects.count(), InspectionOperation.objects.count(), InspectionAudit.objects.count())
        authenticate_inspection_client(self.client, self.viewer)
        self.assertEqual(self.client.get(self.base_url).status_code, 200)
        self.assertEqual(self.client.get(self.base_url + f'{data["id"]}/').status_code, 200)
        self.assertEqual(self.client.get(self.base_url + 'capabilities/').status_code, 200)
        self.assertEqual(before, (InspectionRequest.objects.count(), InspectionOperation.objects.count(), InspectionAudit.objects.count()))
        self.viewer = self.make_user('normal-quality-viewer', edit=False)
        authenticate_inspection_client(self.client, self.viewer)
        self.assertEqual(self.post(data=self.create_payload(task_ref='another')).status_code, 403)
        self.assertEqual(self.action(data, 'submit', user=self.viewer).status_code, 403)

    def test_staff_is_not_implicitly_granted_inspection_write_permissions(self):
        staff = self.make_user('staff', staff=True)
        authenticate_inspection_client(self.client, staff)
        self.assertEqual(self.client.get(self.base_url + 'capabilities/').status_code, 403)
        self.assertEqual(self.post(data=self.create_payload()).status_code, 403)

    def test_each_write_requires_dedicated_permission_and_quality_edit(self):
        editor_without_perm = self.make_user('quality-only')
        permission_without_edit = self.make_user('permission-only', edit=False, permissions=('manage', 'submit', 'review'))
        permission_without_view = self.make_user('permission-hidden', view=False, permissions=('manage',))
        for user in (editor_without_perm, permission_without_edit, permission_without_view):
            with self.subTest(user=user.username):
                self.assertEqual(self.post(data=self.create_payload(), user=user).status_code, 403)
        data = self.draft(self.create())
        self.assertEqual(self.action(data, 'submit', user=self.reviewer).status_code, 403)
        self.assertEqual(self.action(data, 'approve', user=self.other_editor).status_code, 409)

    def test_only_assigned_editor_can_edit_and_submit(self):
        data = self.create()
        authenticate_inspection_client(self.client, self.other_editor)
        response = self.client.patch(self.base_url + f'{data["id"]}/', self.draft_payload(data['version']),
                                     format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.action(data, 'submit', user=self.other_editor).status_code, 403)

    def test_no_delete_or_full_update_api(self):
        data = self.create()
        self.assertEqual(self.client.delete(self.base_url + f'{data["id"]}/').status_code, 405)
        self.assertEqual(self.client.put(self.base_url + f'{data["id"]}/', {}, format='json').status_code, 405)
        self.assertTrue(InspectionRequest.objects.filter(pk=data['id']).exists())

    def test_create_requires_bounded_identity_quantity_specification_and_past_start(self):
        changes = [{'task_ref': ''}, {'part_no': ''}, {'equipment_ref': ''}, {'lot_ref': ''},
                   {'warehouse_ref': ''}, {'uom': ''}, {'target_quantity': '0.000'},
                   {'target_quantity': '10.0001'}, {'target_quantity': 'NaN'},
                   {'work_started_at': (timezone.now() + timedelta(days=1)).isoformat()},
                   {'inspection_items': []}, {'inspection_items': [{'id': 'x', 'label': 'x', 'kind': 'number', 'minimum': '3', 'maximum': '2'}]}]
        for change in changes:
            with self.subTest(change=change):
                self.assertEqual(self.post(data=self.create_payload(**change)).status_code, 400)
        self.assertEqual(InspectionRequest.objects.count(), 0)
        self.assertEqual(InspectionAudit.objects.count(), 0)

    def test_create_rejects_server_controlled_fields_and_duplicate_item_ids(self):
        for field in ('status', 'source_kind', 'assigned_to', 'submitted_by', 'created_at', 'mes_snapshot', 'identity'):
            with self.subTest(field=field):
                self.assertEqual(self.post(data=self.create_payload(**{field: 'injected'})).status_code, 400)
        self.assertEqual(self.post(data=self.create_payload(inspection_items=[{'id': 'x', 'label': 'x'}, {'id': 'x', 'label': 'y'}])).status_code, 400)

    def test_idempotency_key_is_required_uuid_v4(self):
        for key in (None, 'bad', uuid.uuid1()):
            headers = {} if key is None else {'HTTP_IDEMPOTENCY_KEY': str(key)}
            response = self.client.post(self.base_url, self.create_payload(), format='json', **headers)
            self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(InspectionOperation.objects.count(), 0)

    def test_create_idempotency_replays_exact_response_and_mismatch_conflicts(self):
        key, payload = uuid.uuid4(), self.create_payload()
        response = self.post(data=payload, key=key)
        repeated = self.post(data=payload, key=key)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(repeated.status_code, 201)
        self.assertEqual(response.data, repeated.data)
        changed = self.post(data={**payload, 'warehouse_ref': 'DIFFERENT'}, key=key)
        self.assertEqual(changed.status_code, 409, changed.data)
        self.assertEqual(str(changed.data['code']), 'idempotency_payload_mismatch')
        self.assertEqual(InspectionRequest.objects.count(), 1)
        self.assertEqual(InspectionAudit.objects.count(), 1)

    def test_duplicate_identity_across_new_key_or_actor_conflicts(self):
        payload = self.create_payload()
        self.assertEqual(self.post(data=payload).status_code, 201)
        for user in (self.editor, self.other_editor):
            response = self.post(data=payload, user=user)
            self.assertEqual(response.status_code, 409, response.data)
            self.assertEqual(str(response.data['code']), 'duplicate_request')
        self.assertEqual(InspectionRequest.objects.count(), 1)

    def test_partial_draft_may_be_incomplete_but_submit_requires_all_items_and_evidence(self):
        data = self.draft(self.create(), measurements=[], evidence=[], inspected_quantity='0.000',
                          accepted_quantity='0.000', rejected_quantity='0.000', judgement='')
        self.assertEqual(data['status'], 'draft')
        self.assertEqual(self.action(data, 'submit').status_code, 400)
        row = InspectionRequest.objects.get(pk=data['id'])
        self.assertEqual(row.status, 'draft')
        self.assertIsNone(row.submitted_at)

    def test_immutable_fields_actor_and_timestamps_cannot_be_patched(self):
        data = self.create()
        for field in ('task_ref', 'work_order_ref', 'part_no', 'equipment_ref', 'inspection_items', 'target_quantity',
                      'uom', 'lot_ref', 'warehouse_ref', 'require_evidence', 'quantity_mode',
                      'judgement_policy',
                      'status', 'sync_status', 'assigned_to', 'submitted_by', 'submitted_at'):
            with self.subTest(field=field):
                response = self.client.patch(self.base_url + f'{data["id"]}/',
                    self.draft_payload(data['version'], **{field: 'injected'}), format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
                self.assertEqual(response.status_code, 400, response.data)
        row = InspectionRequest.objects.get(pk=data['id'])
        self.assertEqual(row.version, 1)
        self.assertEqual(row.part_no, 'SYNTHETIC-PART')

    def test_draft_quantity_conservation_and_known_measurement_items(self):
        data = self.create()
        invalid = [{'inspected_quantity': '11.000', 'accepted_quantity': '11.000'},
                   {'accepted_quantity': '9.000'}, {'rejected_quantity': '-1.000'},
                   {'measurements': [{'item_id': 'unknown', 'value': 'x'}]},
                   {'measurements': [{'item_id': 'dimension', 'value': 'x'}, {'item_id': 'dimension', 'value': 'y'}]}]
        for change in invalid:
            with self.subTest(change=change):
                response = self.client.patch(self.base_url + f'{data["id"]}/', self.draft_payload(data['version'], **change),
                    format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
                self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(InspectionRequest.objects.get(pk=data['id']).version, data['version'])

    def test_evidence_rejects_insecure_credential_or_query_links(self):
        data = self.create()
        for url in ('http://evidence.example/a', 'https://user:password@evidence.example/a',
                    'https://evidence.example/a?token=secret', 'https://evidence.example/a#secret',
                    'https://localhost/a', 'https://127.0.0.1/a', 'javascript:alert(1)', 'https://evidence.example/a b'):
            with self.subTest(url=url):
                response = self.client.patch(self.base_url + f'{data["id"]}/',
                    self.draft_payload(data['version'], evidence=[{'label': 'proof', 'url': url}]),
                    format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
                self.assertEqual(response.status_code, 400, response.data)

    def test_submit_rechecks_numeric_specification_item_evidence_and_judgement(self):
        changes = [
            {'measurements': [{'item_id': 'dimension', 'value': '11', 'judgement': 'pass', 'evidence_url': 'https://evidence.example/a'}]},
            {'measurements': [{'item_id': 'dimension', 'value': 'NaN', 'judgement': 'pass', 'evidence_url': 'https://evidence.example/a'}]},
            {'measurements': [{'item_id': 'dimension', 'value': '10', 'judgement': 'pass'}]},
            {'measurements': [{'item_id': 'dimension', 'value': '10', 'judgement': ''}]},
            {'judgement': 'fail'}, {'accepted_quantity': '9.000', 'rejected_quantity': '1.000'},
            {'evidence': []},
        ]
        for i, change in enumerate(changes):
            with self.subTest(change=change):
                data = self.draft(self.create(task_ref=f'SYNTHETIC-TASK-{i}'), **change)
                self.assertEqual(self.action(data, 'submit').status_code, 400)

    def test_version_conflict_preserves_draft_and_original_key_replays_after_later_change(self):
        data = self.create()
        key, payload = uuid.uuid4(), self.draft_payload(data['version'])
        response = self.client.patch(self.base_url + f'{data["id"]}/', payload, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.action(data, 'submit').status_code, 409)
        repeated = self.client.patch(self.base_url + f'{data["id"]}/', payload, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(repeated.data, response.data)
        altered = self.client.patch(self.base_url + f'{data["id"]}/', {**payload, 'notes': 'changed'}, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(altered.status_code, 409)
        row = InspectionRequest.objects.get(pk=data['id'])
        self.assertEqual(row.notes, payload['notes'])
        self.assertEqual(row.version, 2)
        self.assertEqual(row.audit.count(), 2)

    def test_submit_and_independent_approval_are_separate_and_audited(self):
        data = self.draft(self.create())
        response = self.action(data, 'submit')
        self.assertEqual(response.status_code, 200)
        submitted = response.data
        self.assertEqual(submitted['status'], 'submitted')
        self.assertEqual(submitted['submitted_by'], self.editor.pk)
        self.assertIsNone(submitted['reviewed_at'])
        self.assertEqual(self.action(submitted, 'approve', user=self.editor).status_code, 403)
        approved = self.action(submitted, 'approve', user=self.reviewer)
        self.assertEqual(approved.status_code, 200, approved.data)
        self.assertEqual(approved.data['status'], 'approved')
        self.assertEqual(approved.data['injection_receipt_readiness'], 'not_verified')
        self.assertEqual(approved.data['sync_status'], 'not_synced')
        self.assertEqual(approved.data['reviewed_by'], self.reviewer.pk)
        self.assertEqual([r['action'] for r in approved.data['audit']], ['create', 'draft', 'submit', 'approve'])
        self.assertEqual(approved.data['audit'][-1]['actor_name'], self.reviewer.username)

    def test_superuser_cannot_approve_own_submission(self):
        superuser = self.make_user('superuser', superuser=True, staff=True)
        authenticate_inspection_client(self.client, superuser)
        response = self.post(data=self.create_payload())
        data = response.data
        response = self.client.patch(self.base_url + f'{data["id"]}/', self.draft_payload(data['version']), format='json',
                                     HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        submitted = self.action(response.data, 'submit', user=superuser)
        self.assertEqual(submitted.status_code, 200, submitted.data)
        self.assertEqual(self.action(submitted.data, 'approve', user=superuser).status_code, 403)

    def test_rejection_requires_reason_and_reinspection_is_explicit_single_child(self):
        submitted = self.action(self.draft(self.create()), 'submit').data
        self.assertEqual(self.action(submitted, 'reject', user=self.reviewer).status_code, 400)
        rejected = self.action(submitted, 'reject', user=self.reviewer, reason='재측정 필요').data
        self.assertEqual(rejected['status'], 'rejected')
        self.assertEqual(self.action(rejected, 'reinspect').status_code, 400)
        child = self.action(rejected, 'reinspect', reason='담당자 재검').data
        self.assertEqual(child['parent'], rejected['id'])
        self.assertEqual(child['status'], 'draft')
        self.assertEqual(child['measurements'], [])
        self.assertEqual(child['evidence'], [])
        self.assertEqual(child['task_ref'], rejected['task_ref'])
        parent = InspectionRequest.objects.get(pk=rejected['id'])
        self.assertEqual(parent.status, 'rejected')
        self.assertEqual(self.action({'id': parent.pk, 'version': parent.version}, 'reinspect', reason='duplicate').status_code, 409)

    def test_failed_inspection_cannot_be_approved_or_synced_and_retains_history(self):
        data = self.draft(self.create(), judgement='fail', accepted_quantity='8.000', rejected_quantity='2.000',
            measurements=[{'item_id': 'dimension', 'value': '11', 'judgement': 'fail', 'evidence_url': 'https://evidence.example/a'}])
        failed = self.action(data, 'submit').data
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(self.action(failed, 'approve', user=self.reviewer).status_code, 409)
        self.assertEqual(self.action(failed, 'sync').status_code, 409)
        child = self.action(failed, 'reinspect', reason='다음 샘플 재검').data
        self.assertEqual(child['parent'], failed['id'])
        self.assertEqual(InspectionRequest.objects.get(pk=failed['id']).judgement, 'fail')

    def test_default_disabled_adapter_blocks_mes_and_never_touches_network(self):
        data = self.approved()
        with mock.patch('socket.socket.connect', side_effect=AssertionError('network is forbidden')) as network:
            response = self.action(data, 'sync')
            self.assertEqual(response.status_code, 503, response.data)
            self.assertEqual(response.data['code'], 'mes_contract_unverified')
            blocked = response.data['request']
            self.assertEqual(blocked['sync_status'], 'blocked')
            self.assertFalse(blocked['capabilities']['can_sync'])
            refresh = self.action(blocked, 'refresh', user=self.viewer)
            self.assertEqual(refresh.status_code, 503)
            network.assert_not_called()
        self.assertFalse(self.client.get(self.base_url + 'capabilities/').data['mes']['enabled'])


    def test_uncertain_sync_without_confirmation_remains_blocked_after_refresh(self):
        with self.adapter_patch():
            self.adapter.save_mode = 'timeout_before_commit'
            response = self.action(self.approved(), 'sync')
            refreshed = self.action(response.data['request'], 'refresh', user=self.viewer)
            self.assertEqual(refreshed.status_code, 200)
            self.assertEqual(refreshed.data['sync_status'], 'unknown')
            self.assertEqual(self.action(refreshed.data, 'sync').status_code, 409)
            self.assertEqual(len(self.adapter.save_calls), 1)

    def test_pending_write_from_process_crash_returns_pending_and_reconciles(self):
        with self.adapter_patch():
            data = self.approved()
            row = InspectionRequest.objects.get(pk=data['id'])
            key, payload = uuid.uuid4(), {'version': row.version, 'reason': ''}
            operation = InspectionOperation.objects.create(request=row, scope=f'{self.editor.pk}:{row.pk}:sync', key=key,
                                                          payload_digest=digest(payload))
            row.sync_status = 'pending'
            row.save(update_fields=['sync_status'])
            response = self.action(data, 'sync', key=key)
            self.assertEqual(response.status_code, 202, response.data)
            self.assertEqual(response.data['code'], 'operation_pending')
            self.assertEqual(self.action(data, 'sync').status_code, 409)
            self.adapter.result = {'result_digest': digest(result_payload(row)), 'external_result_id': 'SYNTHETIC-RECOVERED',
                                   'task_status': 2, 'qc_status': 1, 'receipt_allowed': True}
            response = self.action(data, 'refresh', user=self.viewer)
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data['sync_status'], 'succeeded')
            operation.refresh_from_db()
            self.assertEqual(operation.status, 'succeeded')
            self.assertEqual(self.adapter.save_calls, [])

    def test_late_timeout_cannot_replace_concurrent_refresh_confirmation(self):
        with self.adapter_patch():
            data = self.approved()
            self.adapter.save_mode = 'timeout_after_commit'

            def reconcile_during_save(request, operation):
                from .inspection_workflow import external_action
                current = InspectionRequest.objects.get(pk=request.pk)
                result, status = external_action(self.viewer, current.pk, 'refresh', uuid.uuid4(),
                                                {'version': current.version, 'reason': ''},
                                                session=inspection_session(self.viewer))
                self.assertEqual(status, 200, result)

            self.adapter.on_save = reconcile_during_save
            response = self.action(data, 'sync')
            self.assertEqual(response.status_code, 200, response.data)
            row = InspectionRequest.objects.get(pk=data['id'])
            self.assertEqual(row.sync_status, 'succeeded')
            self.assertEqual(row.external_result_id, 'SYNTHETIC-RESULT-001')
            self.assertEqual(row.last_error_code, '')


    def test_invalid_external_confirmation_never_counts_as_success(self):
        with self.adapter_patch():
            self.adapter.save_mode = 'wrong_digest'
            response = self.action(self.approved(), 'sync')
            self.assertEqual(response.status_code, 503, response.data)
            self.assertEqual(response.data['request']['sync_status'], 'unknown')
            self.assertEqual(response.data['request']['external_result_id'], '')

    def test_rejected_mes_write_has_safe_error_and_can_be_retried_explicitly(self):
        with self.adapter_patch():
            self.adapter.save_mode = 'rejected'
            response = self.action(self.approved(), 'sync')
            self.assertEqual(response.status_code, 409, response.data)
            self.assertEqual(response.data['code'], 'mes_rejected')
            self.assertEqual(response.data['request']['sync_status'], 'failed')
            self.assertNotIn('synthetic-sensitive-token', str(response.data))
            self.adapter.save_mode = 'success'
            retried = self.action(response.data['request'], 'sync')
            self.assertEqual(retried.status_code, 200, retried.data)
            self.assertEqual(retried.data['sync_status'], 'succeeded')


    def test_scoped_filters_pagination_and_list_excludes_detail_audit(self):
        data = self.create()
        self.create(task_ref='OTHER-TASK', part_no='OTHER-PART', equipment_ref='OTHER-MACHINE', lot_ref='OTHER-LOT')
        authenticate_inspection_client(self.client, self.viewer)
        response = self.client.get(self.base_url, {'part_no': data['part_no'], 'equipment_ref': data['equipment_ref'], 'status': 'draft', 'page_size': 1000})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['count'], 1)
        self.assertNotIn('audit', response.data['results'][0])
        self.assertNotIn('operations', response.data['results'][0])
        self.assertEqual(self.client.get(self.base_url, {'search': 'OTHER-TASK'}).data['count'], 1)
        self.assertEqual(self.client.get(self.base_url, {'assigned_to': 'not-an-id'}).status_code, 400)
        self.assertEqual(self.client.get(self.base_url, {'created_after': 'not-a-date'}).status_code, 400)

    def test_mutation_actions_reject_unknown_actor_and_state_fields(self):
        data = self.create()
        for field in ('actor', 'submitted_by', 'status', 'reviewed_at', 'receipt_quantity'):
            with self.subTest(field=field):
                response = self.action(data, 'submit', **{field: 'injected'})
                self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(InspectionRequest.objects.get(pk=data['id']).status, 'draft')

    def test_quality_has_no_inventory_receipt_endpoints_permission_or_model_fields(self):
        data = self.create()
        for action in ('prepare-receipt', 'receive'):
            self.assertEqual(self.action(data, action).status_code, 404)
        self.assertFalse(Permission.objects.filter(content_type__app_label='quality',
            codename='receive_inspectionrequest').exists())
        fields = {field.name for field in InspectionRequest._meta.get_fields()}
        self.assertFalse({'receipt_status', 'receipt_preparation', 'receipt_reference'} & fields)
        self.assertNotIn('can_receive', data['capabilities'])
        self.assertNotIn('can_prepare_receipt', data['capabilities'])
        self.assertEqual(data['injection_receipt_readiness'], 'not_verified')

    def test_synthetic_result_finish_saga_confirms_qc_without_claiming_receipt_permission(self):
        with self.adapter_patch():
            response = self.action(self.approved(), 'sync')
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data['sync_status'], 'succeeded')
            self.assertEqual(response.data['mes_completion_status'], 'completed')
            self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')
            self.assertEqual(response.data['external_result_id'], 'SYNTHETIC-RESULT-001')
            self.assertEqual(len(self.adapter.save_calls), 1)
            self.assertEqual(len(self.adapter.refresh_calls), 2)
            self.assertEqual(self.adapter.save_calls[0][2]['state_version'], 'synthetic-state-1')
            row = InspectionRequest.objects.get(pk=response.data['id'])
            self.assertEqual(row.accepted_quantity, Decimal('10.000'))
            self.assertNotIn('access_token', row.mes_snapshot)
            self.assertNotIn('synthetic-sensitive-token', str(response.data))
            duplicate = self.action(response.data, 'sync')
            self.assertEqual(duplicate.status_code, 409, duplicate.data)
            self.assertEqual(str(duplicate.data['code']), 'already_completed')
            self.assertEqual(len(self.adapter.save_calls), 1)

    def test_sync_idempotency_replays_without_second_result_or_finish_write(self):
        with self.adapter_patch():
            data, key = self.approved(), uuid.uuid4()
            first = self.action(data, 'sync', key=key)
            replay = self.action(data, 'sync', key=key)
            self.assertEqual(first.data, replay.data)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(replay.status_code, 200)
            self.assertEqual(len(self.adapter.save_calls), 1)
            mismatch = self.action(data, 'sync', key=key, reason='different')
            self.assertEqual(mismatch.status_code, 409)
            self.assertEqual(str(mismatch.data['code']), 'idempotency_payload_mismatch')

    def test_approval_pending_qc_does_not_establish_injection_receipt_policy(self):
        with self.adapter_patch():
            self.adapter.complete_status = 4
            response = self.action(self.approved(), 'sync')
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data['sync_status'], 'succeeded')
            self.assertEqual(response.data['mes_completion_status'], 'approval_pending')
            self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')
            self.assertEqual(self.action(response.data, 'sync').status_code, 409)

    def test_completed_concession_pending_and_fail_qc_never_mean_injection_ready(self):
        with self.adapter_patch():
            data = self.synced()
            for qc in (2, 3, 4):
                with self.subTest(qc=qc):
                    self.adapter.overrides = {'qc_status': qc}
                    response = self.action(data, 'refresh', user=self.viewer)
                    self.assertEqual(response.status_code, 200, response.data)
                    self.assertEqual(response.data['mes_completion_status'], 'completed')
                    self.assertEqual(response.data['mes_state']['qc_status'], qc)
                    self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')
                    data = response.data

    def test_unverified_tenant_gate_cannot_claim_injection_ready(self):
        with self.adapter_patch():
            self.adapter.tenant_receipt_allowed = False
            response = self.action(self.approved(), 'sync')
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data['mes_completion_status'], 'completed')
            self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')
            self.assertEqual(response.data['mes_state']['receipt_allowed'], False)

    def test_qc_lifecycle_verdict_and_synthetic_flag_cannot_define_receipt_gate(self):
        # The handoff documents a pending periodic QC followed by production
        # reporting and receipt. It disproves a universal pending-QC block,
        # without proving every pending QC is allowed or every pass is sufficient.
        with self.adapter_patch():
            data = self.synced()
            for state in range(6):
                for verdict in (1, 2, 3, 4):
                    for receipt_allowed in (False, True):
                        with self.subTest(state=state, verdict=verdict, receipt_allowed=receipt_allowed):
                            self.adapter.overrides = {'task_status': state, 'qc_status': verdict,
                                                      'receipt_allowed': receipt_allowed}
                            response = self.action(data, 'refresh', user=self.viewer)
                            self.assertEqual(response.status_code, 200, response.data)
                            self.assertEqual(response.data['mes_state']['qc_status'], verdict)
                            self.assertEqual(response.data['mes_state']['receipt_allowed'], receipt_allowed)
                            self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')
                            data = response.data
            self.assertEqual(len(self.adapter.save_calls), 1, 'receipt policy review never writes or re-finishes QC')

    def test_not_completed_cancelled_rejected_and_unstarted_are_not_injection_ready(self):
        with self.adapter_patch():
            data = self.synced()
            states = [(0, 'not_completed'), (1, 'not_completed'), (3, 'cancelled'), (4, 'approval_pending'), (5, 'rejected')]
            for state, expected in states:
                with self.subTest(state=state):
                    self.adapter.overrides = {'task_status': state}
                    response = self.action(data, 'refresh', user=self.viewer)
                    self.assertEqual(response.status_code, 200, response.data)
                    self.assertEqual(response.data['mes_completion_status'], expected)
                    self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')
                    data = response.data
            self.adapter.overrides = {'work_started': False}
            response = self.action(data, 'refresh', user=self.viewer)
            self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')

    def test_sync_refuses_finished_approving_cancelled_rejected_or_unstarted_mes_task(self):
        with self.adapter_patch():
            data = self.approved()
            for changes in ({'task_status': 2}, {'task_status': 3}, {'task_status': 4}, {'task_status': 5}, {'work_started': False}):
                with self.subTest(changes=changes):
                    self.adapter.overrides = changes
                    response = self.action(data, 'sync')
                    self.assertEqual(response.status_code, 409, response.data)
                    self.assertEqual(response.data['code'], 'mes_task_closed')
                    data = response.data['request']
            self.assertEqual(self.adapter.save_calls, [])

    def test_refresh_rechecks_identity_quantity_and_externally_changed_result(self):
        with self.adapter_patch():
            data = self.synced()
            for field in ('work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'lot_ref', 'uom', 'warehouse_ref', 'target_quantity'):
                with self.subTest(field=field):
                    self.adapter.overrides = {field: '11.000' if field == 'target_quantity' else 'DIFFERENT'}
                    response = self.action(data, 'refresh', user=self.viewer)
                    self.assertEqual(response.status_code, 409, response.data)
                    self.assertEqual(response.data['code'], 'mes_quantity_changed' if field == 'target_quantity' else 'mes_identity_changed')
                    self.assertEqual(response.data['request']['injection_receipt_readiness'], 'not_verified')
                    data = response.data['request']
            self.adapter.overrides = {'result_digest': 'externally-changed'}
            response = self.action(data, 'refresh', user=self.viewer)
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data['sync_status'], 'stale')
            self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')

    def test_sync_timeout_after_finish_reconciles_without_resubmitting(self):
        with self.adapter_patch():
            self.adapter.save_mode = 'timeout_after_commit'
            data, key = self.approved(), uuid.uuid4()
            response = self.action(data, 'sync', key=key)
            self.assertEqual(response.status_code, 503, response.data)
            unknown = response.data['request']
            self.assertEqual(unknown['sync_status'], 'unknown')
            self.assertEqual(unknown['mes_completion_status'], 'unknown')
            self.assertEqual(unknown['injection_receipt_readiness'], 'not_verified')
            self.assertEqual(self.action(data, 'sync', key=key).status_code, 503)
            self.assertEqual(self.action(unknown, 'sync').status_code, 409)
            self.assertEqual(len(self.adapter.save_calls), 1)
            reconciled = self.action(unknown, 'refresh', user=self.viewer)
            self.assertEqual(reconciled.status_code, 200, reconciled.data)
            self.assertEqual(reconciled.data['sync_status'], 'succeeded')
            self.assertEqual(reconciled.data['mes_completion_status'], 'completed')
            self.assertEqual(reconciled.data['injection_receipt_readiness'], 'not_verified')
            self.assertEqual(InspectionOperation.objects.get(key=key).status, 'succeeded')
            self.assertEqual(len(self.adapter.save_calls), 1)
            self.assertNotIn('synthetic-sensitive-token', str(response.data))

    def test_saved_items_without_finished_task_remain_unknown_after_refresh(self):
        with self.adapter_patch():
            self.adapter.save_mode = 'partial'
            response = self.action(self.approved(), 'sync')
            self.assertEqual(response.status_code, 503, response.data)
            unknown = response.data['request']
            self.assertEqual(unknown['sync_status'], 'unknown')
            refreshed = self.action(unknown, 'refresh', user=self.viewer)
            self.assertEqual(refreshed.status_code, 200, refreshed.data)
            self.assertEqual(refreshed.data['sync_status'], 'unknown')
            self.assertEqual(refreshed.data['mes_completion_status'], 'not_completed')
            self.assertEqual(refreshed.data['injection_receipt_readiness'], 'not_verified')
            self.assertEqual(self.action(refreshed.data, 'sync').status_code, 409)
            self.assertEqual(len(self.adapter.save_calls), 1)
            self.adapter.result['task_status'] = 4
            settled = self.action(refreshed.data, 'refresh', user=self.viewer)
            self.assertEqual(settled.data['sync_status'], 'succeeded')
            self.assertEqual(settled.data['mes_completion_status'], 'approval_pending')
            self.assertEqual(settled.data['injection_receipt_readiness'], 'not_verified')

    def test_transport_success_without_matching_snapshot_does_not_complete(self):
        with self.adapter_patch():
            self.adapter.save_mode = 'transport_only'
            response = self.action(self.approved(), 'sync')
            self.assertEqual(response.status_code, 503, response.data)
            self.assertEqual(response.data['request']['sync_status'], 'unknown')
            self.assertEqual(response.data['request']['external_result_id'], '')

    def test_malformed_snapshot_and_lost_network_never_leave_stale_ready_indicator(self):
        with self.adapter_patch():
            data = self.synced()
            self.adapter.overrides = {'qc_status': True}
            response = self.action(data, 'refresh', user=self.viewer)
            self.assertEqual(response.status_code, 503, response.data)
            self.assertEqual(response.data['code'], 'mes_outcome_unknown')
            self.assertEqual(response.data['request']['injection_receipt_readiness'], 'not_verified')
            self.assertIsNone(response.data['request']['mes_checked_at'])
            self.adapter.overrides = {}
            self.adapter.refresh_error = TimeoutError('synthetic-sensitive-token')
            response = self.action(response.data['request'], 'refresh', user=self.viewer)
            self.assertEqual(response.status_code, 503, response.data)
            self.assertEqual(response.data['request']['injection_receipt_readiness'], 'not_verified')
            self.assertNotIn('synthetic-sensitive-token', str(response.data))

    def test_partial_sample_quantity_is_local_result_and_never_executes_receipt(self):
        with self.adapter_patch():
            data = self.draft(self.create(), inspected_quantity='3.000', accepted_quantity='3.000')
            data = self.action(data, 'submit').data
            data = self.action(data, 'approve', user=self.reviewer).data
            response = self.action(data, 'sync')
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(response.data['accepted_quantity'], '3.000')
            self.assertEqual(response.data['target_quantity'], '10.000')
            self.assertFalse(hasattr(self.adapter, 'receive'))

    def test_evidence_url_must_be_a_string_and_malformed_body_is_400(self):
        data = self.create()
        for value in (42, True, {}, [], None):
            with self.subTest(value=value):
                response = self.client.patch(self.base_url + f'{data["id"]}/',
                    self.draft_payload(data['version'], evidence=[{'label': 'proof', 'url': value}]),
                    format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
                self.assertEqual(response.status_code, 400, response.data)
        for body in (['unexpected'], 'unexpected', 3, None):
            with self.subTest(body=body):
                response = self.client.post(self.base_url, body, format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
                self.assertEqual(response.status_code, 400, getattr(response, 'data', None))

    def test_invalid_calendar_date_and_non_ascii_numeric_assignee_filter_are_400(self):
        authenticate_inspection_client(self.client, self.viewer)
        for params in ({'created_after': '2026-02-31'}, {'created_before': '2026-13-01'}, {'assigned_to': '²'}):
            with self.subTest(params=params):
                self.assertEqual(self.client.get(self.base_url, params).status_code, 400)

    def test_normalized_snapshot_requires_bounded_typed_state_and_quantity(self):
        with self.adapter_patch():
            data = self.create()
            values = [{'task_status': 6}, {'task_status': True}, {'qc_status': 0}, {'qc_status': '1'},
                      {'work_started': 1}, {'receipt_allowed': 'true'}, {'state_version': ''},
                      {'state_version': 'x' * 129}, {'available_quantity': '-1'}, {'available_quantity': 'NaN'},
                      {'available_quantity': '10.0001'}, {'external_result_id': None}, {'result_digest': 42}]
            for override in values:
                with self.subTest(override=override):
                    self.adapter.overrides = override
                    response = self.action(data, 'refresh', user=self.viewer)
                    self.assertEqual(response.status_code, 503, response.data)
                    self.assertEqual(response.data['code'], 'mes_outcome_unknown')
                    self.assertEqual(response.data['request']['injection_receipt_readiness'], 'not_verified')
                    data = response.data['request']

    def test_another_actor_same_key_cannot_replay_previous_actors_operation(self):
        key = uuid.uuid4()
        payload = self.create_payload()
        original = self.post(data=payload, key=key)
        self.assertEqual(original.status_code, 201)
        # The second actor's UUID is scoped independently and reaches duplicate
        # detection instead of receiving the original actor's success/audit.
        response = self.post(data=payload, user=self.other_editor, key=key)
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(str(response.data['code']), 'duplicate_request')
        self.assertEqual(InspectionOperation.objects.filter(key=key).count(), 1)

    def test_late_refresh_snapshot_cannot_override_newer_qc_failure_observation(self):
        with self.adapter_patch():
            data = self.synced()
            original_refresh = self.adapter.refresh
            nested = False

            def refresh_with_newer_observation(request, operation):
                nonlocal nested
                snapshot = original_refresh(request, operation)
                if not nested:
                    nested = True
                    self.adapter.overrides = {'qc_status': 4, 'state_version': 'synthetic-state-3'}
                    from .inspection_workflow import external_action
                    current = InspectionRequest.objects.get(pk=request.pk)
                    result, status = external_action(self.viewer, current.pk, 'refresh', uuid.uuid4(),
                                                    {'version': current.version, 'reason': ''},
                                                    session=inspection_session(self.viewer))
                    self.assertEqual(status, 200, result)
                    self.assertEqual(result['injection_receipt_readiness'], 'not_verified')
                return snapshot

            self.adapter.refresh = refresh_with_newer_observation
            response = self.action(data, 'refresh', user=self.viewer)
            self.assertIn(response.status_code, (200, 409), response.data)
            row = InspectionRequest.objects.get(pk=data['id'])
            self.assertEqual(row.injection_receipt_readiness, 'not_verified')
            self.assertEqual(row.mes_snapshot['qc_status'], 4)

    def test_optional_items_evidence_and_not_recorded_quantities_follow_local_policy(self):
        data = self.create(require_evidence=False, quantity_mode='not_recorded', inspection_items=[
            {'id': 'dimension', 'label': '선택 치수', 'kind': 'number', 'required': False,
             'minimum': '9.5', 'maximum': '10.5', 'evidence_required': False}])
        data = self.draft(data, measurements=[], evidence=[], inspected_quantity='0.000',
                          accepted_quantity='0.000', rejected_quantity='0.000', judgement='pass')
        submitted = self.action(data, 'submit')
        self.assertEqual(submitted.status_code, 200, submitted.data)
        self.assertEqual(submitted.data['status'], 'submitted')
        self.assertEqual(submitted.data['measurements'], [])
        self.assertEqual(submitted.data['evidence'], [])
        self.assertEqual(submitted.data['inspected_quantity'], '0.000')
        approved = self.action(submitted.data, 'approve', user=self.reviewer)
        self.assertEqual(approved.status_code, 200, approved.data)
        self.assertEqual(approved.data['injection_receipt_readiness'], 'not_verified')

    def test_optional_blank_measurement_may_be_omitted_but_overall_judgement_is_required(self):
        data = self.create(require_evidence=False, quantity_mode='not_recorded', inspection_items=[
            {'id': 'dimension', 'label': '선택 치수', 'kind': 'number', 'required': False}])
        data = self.draft(data, evidence=[], measurements=[{'item_id': 'dimension', 'value': '', 'judgement': ''}],
                          inspected_quantity='0.000', accepted_quantity='0.000', rejected_quantity='0.000', judgement='')
        self.assertEqual(self.action(data, 'submit').status_code, 400)
        data = self.draft(data, evidence=[], measurements=[{'item_id': 'dimension', 'value': '', 'judgement': ''}],
                          inspected_quantity='0.000', accepted_quantity='0.000', rejected_quantity='0.000', judgement='pass')
        self.assertEqual(self.action(data, 'submit').status_code, 200)

    def test_optional_provided_measurement_still_obeys_numeric_spec_and_item_evidence(self):
        data = self.create(require_evidence=False, quantity_mode='not_recorded', inspection_items=[
            {'id': 'dimension', 'label': '선택 치수', 'kind': 'number', 'required': False,
             'minimum': '9.5', 'maximum': '10.5', 'evidence_required': True}])
        for value, judgement, evidence_url in [('11', 'pass', 'https://evidence.example/a'), ('10', 'pass', '')]:
            with self.subTest(value=value, evidence_url=evidence_url):
                data = self.draft(data, evidence=[], measurements=[{'item_id': 'dimension', 'value': value,
                    'judgement': judgement, 'evidence_url': evidence_url}], inspected_quantity='0.000',
                    accepted_quantity='0.000', rejected_quantity='0.000', judgement='pass')
                self.assertEqual(self.action(data, 'submit').status_code, 400)

    def test_not_recorded_policy_does_not_require_rejected_quantity_for_failed_result(self):
        data = self.create(require_evidence=False, quantity_mode='not_recorded', inspection_items=[
            {'id': 'dimension', 'label': '선택 치수', 'kind': 'number', 'required': False,
             'minimum': '9.5', 'maximum': '10.5', 'evidence_required': False}])
        data = self.draft(data, evidence=[], measurements=[{'item_id': 'dimension', 'value': '11', 'judgement': 'fail'}],
                          inspected_quantity='0.000', accepted_quantity='0.000', rejected_quantity='0.000', judgement='fail')
        response = self.action(data, 'submit')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['status'], 'failed')
        child = self.action(response.data, 'reinspect', reason='선택 항목 재확인')
        self.assertEqual(child.status_code, 201, child.data)
        self.assertEqual(child.data['quantity_mode'], 'not_recorded')
        self.assertFalse(child.data['require_evidence'])
        self.assertFalse(child.data['inspection_items'][0]['required'])

    def test_optional_failed_item_overall_pass_requires_explicit_independent_judgement_policy(self):
        for policy, expected in [('strict_items', 400), ('independent', 200)]:
            with self.subTest(policy=policy):
                data = self.create(task_ref=f'SYNTHETIC-{policy}', judgement_policy=policy,
                    require_evidence=False, quantity_mode='not_recorded', inspection_items=[
                    {'id': 'dimension', 'label': '선택 항목', 'kind': 'text', 'required': False}])
                data = self.draft(data, evidence=[], measurements=[
                    {'item_id': 'dimension', 'value': '不合格', 'judgement': 'fail'}],
                    inspected_quantity='0.000', accepted_quantity='0.000', rejected_quantity='0.000', judgement='pass')
                response = self.action(data, 'submit')
                self.assertEqual(response.status_code, expected, response.data)
                if expected == 200:
                    self.assertEqual(response.data['status'], 'submitted')
                    self.assertEqual(response.data['judgement'], 'pass')
                    self.assertEqual(response.data['measurements'][0]['judgement'], 'fail')
                    self.assertEqual(response.data['injection_receipt_readiness'], 'not_verified')

    def test_reinspection_copies_independent_judgement_policy(self):
        data = self.create(judgement_policy='independent', require_evidence=False,
            quantity_mode='not_recorded', inspection_items=[{'id': 'dimension', 'label': '선택 항목', 'required': False}])
        data = self.draft(data, evidence=[], measurements=[], inspected_quantity='0.000',
                          accepted_quantity='0.000', rejected_quantity='0.000', judgement='fail')
        failed = self.action(data, 'submit')
        self.assertEqual(failed.status_code, 200, failed.data)
        child = self.action(failed.data, 'reinspect', reason='별도 종합 판정 재검')
        self.assertEqual(child.status_code, 201, child.data)
        self.assertEqual(child.data['judgement_policy'], 'independent')

    def test_choice_item_options_are_bounded_unique_nonempty_strings(self):
        for options in (None, [], ['合格'], ['合格', '合格'], ['合格', ' '], ['合格', 3],
                        ['合格', {}], ['合格', 'x' * 129], [str(i) for i in range(21)]):
            with self.subTest(options=options):
                response = self.post(data=self.create_payload(inspection_items=[{
                    'id': 'appearance', 'label': '외관', 'kind': 'choice', 'required': True, 'options': options}]))
                self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(InspectionRequest.objects.count(), 0)

    def test_choice_measurement_must_use_configured_option(self):
        data = self.create(require_evidence=False, quantity_mode='not_recorded', inspection_items=[
            {'id': 'dimension', 'label': '외관', 'kind': 'choice', 'required': True,
             'options': ['合格', '不合格']}])
        self.assertEqual(data['inspection_items'][0]['options'], ['合格', '不合格'])
        data = self.draft(data, evidence=[], measurements=[{'item_id': 'dimension', 'value': 'UNCONFIGURED', 'judgement': 'pass'}],
                          inspected_quantity='0.000', accepted_quantity='0.000', rejected_quantity='0.000', judgement='pass')
        self.assertEqual(self.action(data, 'submit').status_code, 400)
        data = self.draft(data, evidence=[], measurements=[{'item_id': 'dimension', 'value': '合格', 'judgement': 'pass'}],
                          inspected_quantity='0.000', accepted_quantity='0.000', rejected_quantity='0.000', judgement='pass')
        response = self.action(data, 'submit')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['measurements'][0]['value'], '合格')

    def test_unknown_judgement_policy_is_not_accepted(self):
        self.assertEqual(self.post(data=self.create_payload(judgement_policy='tenant-guessed')).status_code, 400)

    def failed_group_request(self, lot_ref='SYNTHETIC-FAILED-LOT'):
        data = self.draft(self.create(lot_ref=lot_ref), judgement='fail', accepted_quantity='8.000', rejected_quantity='2.000',
            measurements=[{'item_id': 'dimension', 'value': '11', 'judgement': 'fail', 'evidence_url': 'https://evidence.example/a'}])
        response = self.action(data, 'submit')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['status'], 'failed')
        return response.data

    def test_work_group_counts_actual_draft_failed_and_child_reinspection_records(self):
        draft = self.create(lot_ref='SYNTHETIC-DRAFT-LOT')
        failed = self.failed_group_request()
        child = self.action(failed, 'reinspect', reason='합성 작업 재검')
        self.assertEqual(child.status_code, 201, child.data)
        self.assertEqual(child.data['parent'], failed['id'])
        authenticate_inspection_client(self.client, self.viewer)
        response = self.client.get(self.base_url)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['count'], 3)
        self.assertFalse(response.data['work_groups_truncated'])
        self.assertEqual(len(response.data['work_groups']), 1)
        group = response.data['work_groups'][0]
        self.assertEqual(group['work_order_ref'], draft['work_order_ref'])
        self.assertEqual(group['task_ref'], draft['task_ref'])
        self.assertEqual(group['equipment_ref'], draft['equipment_ref'])
        self.assertEqual(group['source_kind'], 'local_manual')
        self.assertEqual(group['request_count'], 3)
        self.assertEqual(group['open_count'], 3)
        self.assertEqual(group['statuses'], {'draft': 2, 'submitted': 0, 'approved': 0, 'failed': 1, 'rejected': 0})
        self.assertEqual(group['blocking_reasons'], ['draft_not_submitted', 'local_inspection_failed', 'mes_completion_unverified'])
        self.assertEqual(group['latest_request_at'], child.data['created_at'])
        self.assertEqual(len({row['id'] for row in response.data['results']}), 3)

    def test_repeated_work_group_get_does_not_seed_or_duplicate_requests_operations_or_audit(self):
        data = self.create()
        before = (InspectionRequest.objects.count(), InspectionOperation.objects.count(), InspectionAudit.objects.count())
        authenticate_inspection_client(self.client, self.viewer)
        original = self.client.get(self.base_url).data
        for _ in range(3):
            self.assertEqual(self.client.get(self.base_url).data, original)
            self.assertEqual(before, (InspectionRequest.objects.count(), InspectionOperation.objects.count(), InspectionAudit.objects.count()))
        duplicate = self.post(data=self.create_payload(), user=self.editor)
        self.assertEqual(duplicate.status_code, 409, duplicate.data)
        response = self.client.get(self.base_url)
        self.assertEqual(response.data['work_groups'][0]['request_count'], 1)
        self.assertEqual(response.data['work_groups'][0]['task_ref'], data['task_ref'])
        self.assertEqual(before, (InspectionRequest.objects.count(), InspectionOperation.objects.count(), InspectionAudit.objects.count()))

    def test_work_groups_use_work_task_equipment_and_source_identity_not_part_alone(self):
        base = self.create()
        self.create(task_ref='SYNTHETIC-OTHER-TASK')
        self.create(work_order_ref='SYNTHETIC-OTHER-WO')
        self.create(equipment_ref='SYNTHETIC-OTHER-MACHINE')
        other_source = self.create(lot_ref='SYNTHETIC-OTHER-SOURCE-LOT')
        # Synthetic read fixture only; source_kind is server-controlled and the
        # live feature does not ingest or invent MES request identities.
        InspectionRequest.objects.filter(pk=other_source['id']).update(source_kind='synthetic_source')
        response = self.client.get(self.base_url)
        self.assertEqual(response.data['count'], 5)
        self.assertEqual(len(response.data['work_groups']), 5)
        self.assertTrue(all(row['part_no'] == base['part_no'] for row in response.data['results']))
        identities = {(g['work_order_ref'], g['task_ref'], g['equipment_ref'], g['source_kind']) for g in response.data['work_groups']}
        self.assertEqual(len(identities), 5)
        self.assertTrue(all(group['request_count'] == 1 for group in response.data['work_groups']))

    def test_work_group_limit_truncation_and_groups_are_independent_of_record_page(self):
        for number in range(30):
            self.create(task_ref=f'SYNTHETIC-GROUP-{number:02d}')
        at_limit = self.client.get(self.base_url, {'page_size': 1})
        self.assertEqual(at_limit.status_code, 200, at_limit.data)
        self.assertEqual(at_limit.data['count'], 30)
        self.assertEqual(len(at_limit.data['results']), 1)
        self.assertEqual(len(at_limit.data['work_groups']), 30)
        self.assertFalse(at_limit.data['work_groups_truncated'])
        latest = self.create(task_ref='SYNTHETIC-GROUP-30')
        first_page = self.client.get(self.base_url, {'page_size': 1})
        second_page = self.client.get(self.base_url, {'page_size': 1, 'page': 2})
        self.assertEqual(first_page.data['count'], 31)
        self.assertEqual(second_page.data['count'], 31)
        self.assertEqual(len(first_page.data['work_groups']), 30)
        self.assertTrue(first_page.data['work_groups_truncated'])
        self.assertEqual(first_page.data['work_groups'], second_page.data['work_groups'])
        self.assertNotEqual(first_page.data['results'][0]['id'], second_page.data['results'][0]['id'])
        self.assertEqual(first_page.data['work_groups'][0]['task_ref'], latest['task_ref'])
        self.assertEqual(sum(g['request_count'] for g in first_page.data['work_groups']), 30)
        scoped = self.client.get(self.base_url, {'search': 'SYNTHETIC-GROUP-30', 'page_size': 1})
        self.assertEqual(scoped.data['count'], 1)
        self.assertEqual(len(scoped.data['work_groups']), 1)
        self.assertFalse(scoped.data['work_groups_truncated'])

    def test_work_group_counts_and_reasons_follow_search_and_status_query_scope(self):
        self.create(lot_ref='SYNTHETIC-DRAFT-LOT')
        failed = self.failed_group_request()
        child = self.action(failed, 'reinspect', reason='검색 범위 재검').data
        self.create(task_ref='SYNTHETIC-UNRELATED-TASK', lot_ref='SYNTHETIC-UNRELATED-LOT')
        authenticate_inspection_client(self.client, self.viewer)
        failed_only = self.client.get(self.base_url, {'status': 'failed'})
        self.assertEqual(failed_only.data['count'], 1)
        group = failed_only.data['work_groups'][0]
        self.assertEqual(group['request_count'], 1)
        self.assertEqual(group['statuses'], {'draft': 0, 'submitted': 0, 'approved': 0, 'failed': 1, 'rejected': 0})
        self.assertEqual(group['blocking_reasons'], ['local_inspection_failed', 'mes_completion_unverified'])
        searched = self.client.get(self.base_url, {'search': 'SYNTHETIC-FAILED-LOT'})
        self.assertEqual(searched.data['count'], 2)
        self.assertEqual(len(searched.data['work_groups']), 1)
        self.assertEqual(searched.data['work_groups'][0]['request_count'], 2)
        self.assertEqual(searched.data['work_groups'][0]['statuses']['draft'], 1)
        combined = self.client.get(self.base_url, {'search': 'SYNTHETIC-FAILED-LOT', 'status': 'draft'})
        self.assertEqual(combined.data['count'], 1)
        self.assertEqual(combined.data['results'][0]['id'], child['id'])
        self.assertEqual(combined.data['work_groups'][0]['request_count'], 1)
        self.assertEqual(combined.data['work_groups'][0]['blocking_reasons'], ['draft_not_submitted', 'mes_completion_unverified'])

    def test_work_groups_report_local_review_rejection_and_observed_mes_approval_pending_separately(self):
        submitted = self.action(self.draft(self.create(lot_ref='SYNTHETIC-SUBMITTED-LOT')), 'submit').data
        rejected = self.action(self.draft(self.create(lot_ref='SYNTHETIC-REJECTED-LOT')), 'submit').data
        self.assertEqual(self.action(rejected, 'reject', user=self.reviewer, reason='합성 검수 반려').status_code, 200)
        completed = self.action(self.draft(self.create(lot_ref='SYNTHETIC-COMPLETED-LOT')), 'submit').data
        completed = self.action(completed, 'approve', user=self.reviewer).data
        pending = self.action(self.draft(self.create(lot_ref='SYNTHETIC-PENDING-LOT')), 'submit').data
        pending = self.action(pending, 'approve', user=self.reviewer).data
        # Projection fixtures represent stored observations only. They do not
        # assert a live tenant's completion/gate or cause remote transitions.
        InspectionRequest.objects.filter(pk=completed['id']).update(mes_completion_status='completed')
        InspectionRequest.objects.filter(pk=pending['id']).update(mes_completion_status='approval_pending')
        authenticate_inspection_client(self.client, self.viewer)
        response = self.client.get(self.base_url)
        self.assertEqual(response.data['count'], 4)
        group = response.data['work_groups'][0]
        self.assertEqual(group['request_count'], 4)
        self.assertEqual(group['open_count'], 3)
        self.assertEqual(group['statuses'], {'draft': 0, 'submitted': 1, 'approved': 2, 'failed': 0, 'rejected': 1})
        self.assertEqual(group['blocking_reasons'], ['awaiting_local_review', 'local_review_rejected',
                                                   'mes_approval_pending', 'mes_completion_unverified'])
        completed_only = self.client.get(self.base_url, {'mes_completion_status': 'completed'})
        self.assertEqual(completed_only.data['count'], 1)
        self.assertEqual(completed_only.data['work_groups'][0]['open_count'], 0)
        self.assertEqual(completed_only.data['work_groups'][0]['blocking_reasons'], [])
        self.assertEqual(submitted['status'], 'submitted')

    def test_empty_work_group_query_is_empty_and_read_only(self):
        authenticate_inspection_client(self.client, self.viewer)
        response = self.client.get(self.base_url, {'search': 'SYNTHETIC-NO-MATCH'})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['count'], 0)
        self.assertEqual(response.data['results'], [])
        self.assertEqual(response.data['work_groups'], [])
        self.assertFalse(response.data['work_groups_truncated'])
        self.assertEqual(InspectionRequest.objects.count(), 0)
        self.assertEqual(InspectionOperation.objects.count(), 0)
        self.assertEqual(InspectionAudit.objects.count(), 0)
