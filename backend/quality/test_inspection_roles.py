"""Disposable fixtures for independent WJ area input; never contact MES."""
from copy import deepcopy
from contextlib import contextmanager
from datetime import timedelta
from threading import Barrier, Event, Thread
from queue import Queue
from time import monotonic, sleep
from unittest import mock, skipUnless
import uuid

from django.contrib.auth import get_user_model
from django.db import connection, connections
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError
from mes_oauth.session_guard import LoginRejected

from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest
from .inspection_role_models import InspectionShiftSetting, InspectionRoleWorkflow, InspectionAreaResult
from .inspection_roles import (area_save, area_complete, area_reopen, configure_role_workflow,
    initialize_role_workflow, role_summary, settings_list, settings_create, settings_update)
from .inspection_workflow import InspectionConflict
from .test_inspection_requests import inspection_session


class RoleFixtures:
    def setUp(self):
        self.admin = get_user_model().objects.create_user(username='SYNTHETIC-role-admin', is_superuser=True)
        self.appearance = get_user_model().objects.create_user(username='SYNTHETIC-role-appearance', is_superuser=True)
        self.dimension = get_user_model().objects.create_user(username='SYNTHETIC-role-dimension', is_superuser=True)
        self.outsider = get_user_model().objects.create_user(username='SYNTHETIC-role-outsider', is_superuser=True)
        self.request = InspectionRequest.objects.create(identity=str(uuid.uuid4()),
            work_order_ref='SYNTHETIC-WO', task_ref='SYNTHETIC-TASK', part_no='SYNTHETIC-PART',
            equipment_ref='SYNTHETIC-MACHINE', inspection_type='first', target_quantity='10',
            uom='EA', warehouse_ref='SYNTHETIC-WAREHOUSE', lot_ref='SYNTHETIC-LOT',
            work_started_at=timezone.now() - timedelta(minutes=5), assigned_to=self.admin,
            assigned_to_name=self.admin.username, quantity_mode='not_recorded', inspection_items=[
                {'id': 'look', 'label': 'SYNTHETIC appearance', 'kind': 'choice', 'unit': '',
                 'options': ['OK', 'NG'], 'required': True, 'evidence_required': False},
                {'id': 'size', 'label': 'SYNTHETIC dimension', 'kind': 'number', 'unit': 'mm',
                 'minimum': '9', 'maximum': '11', 'required': True, 'evidence_required': False},
                {'id': 'size-optional', 'label': 'SYNTHETIC optional', 'kind': 'text', 'unit': '',
                 'required': False, 'evidence_required': False}])
        self.workflow = initialize_role_workflow(self.request)
        response, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(), session=inspection_session(self.admin))
        self.shift_id = response['setting']['id']
        self.configure()

    def shift_payload(self, **changes):
        value = {'code': 'SYNTHETIC-DAY', 'label': 'SYNTHETIC shift', 'timezone': 'Asia/Shanghai',
            'start_time': '08:00', 'end_time': '20:00', 'appearance_assignee': self.appearance.pk,
            'dimension_assignee': self.dimension.pk, 'active': True,
            'effective_from_local': '2026-10-01T' + (changes.get('start_time') or '08:00')[:5]}
        value.update(changes)
        return value

    def configure(self, **changes):
        self.workflow.refresh_from_db()
        payload = {'config_version': self.workflow.config_version, 'shift_setting_id': self.shift_id, 'shift_date': '2026-10-07',
            'shift_version': 1, 'item_areas': {'look': 'appearance', 'size': 'dimension', 'size-optional': 'dimension'},
            'reason': 'SYNTHETIC explicit role configuration'}
        payload.update(changes)
        return configure_role_workflow(self.admin, self.request.pk, uuid.uuid4(), payload,
                                       session=inspection_session(self.admin))

    def payload(self, area, **changes):
        self.workflow.refresh_from_db()
        row = InspectionAreaResult.objects.get(workflow=self.workflow, area=area)
        value = {'area_version': row.version, 'config_version': self.workflow.config_version}
        value.update(changes)
        return value

    def measure(self, area, **changes):
        entry = {'item_id': 'look', 'value': 'OK', 'judgement': 'pass'} if area == 'appearance' else {
            'item_id': 'size', 'value': '10', 'judgement': 'pass'}
        entry.update(changes)
        return entry

    def action(self, func, area, payload=None, *, user=None, key=None):
        user = user or (self.appearance if area == 'appearance' else self.dimension)
        return func(user, self.request.pk, area, key or uuid.uuid4(), payload or self.payload(area),
                    session=inspection_session(user))

    def complete(self, area, **changes):
        return self.action(area_complete, area, self.payload(area, measurements=[self.measure(area)], judgement='pass', **changes))

    def request_now(self):
        self.request.refresh_from_db()
        return self.request


class InspectionRoleTests(RoleFixtures, TestCase):
    def test_read_does_not_initialize_or_write(self):
        legacy = InspectionRequest.objects.get(pk=self.request.pk)
        legacy.pk = None
        legacy.identity = str(uuid.uuid4())
        legacy.save()
        before = (InspectionOperation.objects.count(), InspectionAudit.objects.count(), InspectionRoleWorkflow.objects.count())
        self.assertIsNone(role_summary(legacy, self.admin))
        self.assertTrue(settings_list(self.admin)['can_configure'])
        self.assertEqual(before, (InspectionOperation.objects.count(), InspectionAudit.objects.count(), InspectionRoleWorkflow.objects.count()))

    def test_draft_shift_does_not_guess_times_or_actors(self):
        before_permissions = list(self.dimension.user_permissions.values_list('id', flat=True))
        data, code = settings_create(self.admin, uuid.uuid4(), {'code': 'SYNTHETIC-UNSET', 'label': 'Unset'}, session=inspection_session(self.admin))
        self.assertEqual(code, 201)
        self.assertFalse(data['setting']['active'])
        self.assertIsNone(data['setting']['start_time'])
        self.assertIsNone(data['setting']['appearance_assignee'])
        self.assertIsNone(data['setting']['effective_from'])
        self.assertEqual(before_permissions, list(self.dimension.user_permissions.values_list('id', flat=True)))

    def test_activation_requires_times_and_distinct_actors(self):
        for changes in ({'start_time': None}, {'appearance_assignee': None}, {'dimension_assignee': self.appearance.pk}, {'end_time': '08:00'}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-INVALID', **changes), session=inspection_session(self.admin))

    def test_candidate_does_not_include_inactive_or_ungranted_account(self):
        get_user_model().objects.create_user(username='SYNTHETIC-inactive', is_superuser=True, is_active=False)
        get_user_model().objects.create_user(username='SYNTHETIC-ungranted', is_superuser=False)
        names = {entry['username'] for entry in settings_list(self.admin)['candidates']}
        self.assertNotIn('SYNTHETIC-inactive', names)
        self.assertNotIn('SYNTHETIC-ungranted', names)

    def test_candidate_name_account_and_mes_mapping_are_identification_only(self):
        get_user_model().objects.filter(pk=self.appearance.pk).update(first_name='SYNTHETIC', last_name='Inspector')
        with self.settings(MES_USER_OAUTH_USER_MAP={str(self.appearance.pk): '91000000000000011'}), mock.patch(
                'mes_oauth.vault._keys', side_effect=AssertionError('Credential access forbidden')):
            candidate = next(entry for entry in settings_list(self.admin)['candidates'] if entry['id'] == self.appearance.pk)
        self.assertEqual(candidate['name'], 'SYNTHETIC Inspector')
        self.assertEqual(candidate['username'], self.appearance.username)
        self.assertEqual(candidate['mes_user_id'], '91000000000000011')
        self.assertFalse(role_summary(self.request, self.appearance)['mes']['wj_actor_is_mes_executor'])
        unmapped = next(entry for entry in settings_list(self.admin)['candidates'] if entry['id'] == self.appearance.pk)
        self.assertIsNone(unmapped['mes_user_id'])

    def test_named_actor_assignment_and_completion_snapshots_survive_name_and_setting_changes(self):
        get_user_model().objects.filter(pk=self.appearance.pk).update(first_name='SYNTHETIC', last_name='Inspector')
        self.configure()
        self.workflow.refresh_from_db()
        original = deepcopy(self.workflow.actor_snapshot)
        self.assertEqual(original['appearance'], {'id': self.appearance.pk,
            'name': 'SYNTHETIC Inspector', 'username': self.appearance.username})
        area = InspectionAreaResult.objects.get(workflow=self.workflow, area='appearance')
        self.assertEqual(area.assigned_to_name, 'SYNTHETIC Inspector')
        self.complete('appearance')
        area.refresh_from_db()
        self.assertEqual(area.completed_by_id, self.appearance.pk)
        self.assertEqual(area.completed_by_name, 'SYNTHETIC Inspector')
        get_user_model().objects.filter(pk=self.appearance.pk).update(first_name='Changed', last_name='Name')
        settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 1,
            'label': 'SYNTHETIC future label', 'reason': 'SYNTHETIC snapshot preservation'},
            session=inspection_session(self.admin))
        self.workflow.refresh_from_db()
        area.refresh_from_db()
        self.assertEqual(self.workflow.actor_snapshot, original)
        self.assertEqual(area.assigned_to_name, 'SYNTHETIC Inspector')
        self.assertEqual(area.completed_by_name, 'SYNTHETIC Inspector')
        audit = InspectionAudit.objects.get(request=self.request, action='role_appearance_complete')
        self.assertEqual(audit.actor_id, self.appearance.pk)
        self.assertEqual(audit.actor_name, self.appearance.username)

    def test_settings_require_admin_and_current_login(self):
        ordinary = get_user_model().objects.create_user(username='SYNTHETIC-no-role')
        with self.assertRaises(PermissionDenied):
            settings_create(ordinary, uuid.uuid4(), {'code': 'x', 'label': 'x'}, session=inspection_session(ordinary))
        with self.assertRaises(PermissionDenied):
            settings_create(self.admin, uuid.uuid4(), {'code': 'x', 'label': 'x'}, session=None)

    def test_shift_overlap_and_adjacent_overnight(self):
        with self.assertRaises(InspectionConflict):
            settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-OVERLAP', start_time='19:00', end_time='07:00'), session=inspection_session(self.admin))
        data, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-NIGHT', start_time='20:00', end_time='08:00'), session=inspection_session(self.admin))
        self.assertTrue(data['setting']['active'])

    def test_setting_cas_idempotency_and_snapshot_preservation(self):
        key = uuid.uuid4()
        payload = {'version': 1, 'label': 'SYNTHETIC revised', 'reason': 'Future setting only'}
        first = settings_update(self.admin, self.shift_id, key, payload, session=inspection_session(self.admin))
        self.assertEqual(first, settings_update(self.admin, self.shift_id, key, payload, session=inspection_session(self.admin)))
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.shift_snapshot['version'], 1)
        self.assertEqual(self.workflow.shift_snapshot['label'], 'SYNTHETIC shift')
        with self.assertRaises(InspectionConflict):
            settings_update(self.admin, self.shift_id, uuid.uuid4(), payload, session=inspection_session(self.admin))
        with self.assertRaises(InspectionConflict):
            settings_update(self.admin, self.shift_id, key, payload | {'label': 'Different'}, session=inspection_session(self.admin))

    def test_unknown_actor_and_timezone_fields_rejected(self):
        with self.assertRaises(ValidationError):
            settings_create(self.admin, uuid.uuid4(), {'code': 'SYNTHETIC-x', 'label': 'x', 'actor_id': self.admin.pk}, session=inspection_session(self.admin))
        with self.assertRaises(ValidationError):
            settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-x', timezone='UTC'), session=inspection_session(self.admin))
        with self.assertRaises(ValidationError):
            settings_update(self.admin, self.shift_id, uuid.uuid4(), [], session=inspection_session(self.admin))

    def test_mapping_requires_all_items_and_both_areas(self):
        with self.assertRaises(ValidationError):
            self.configure(item_areas={'look': 'appearance'})
        with self.assertRaises(ValidationError):
            self.configure(item_areas={'look': 'appearance', 'size': 'appearance', 'size-optional': 'appearance'})

    def test_completed_legacy_cannot_initialize(self):
        self.request.mes_completion_status = 'completed'
        self.request.version = 12
        with self.assertRaises(InspectionConflict):
            initialize_role_workflow(self.request)

    def test_initialize_rejects_single_item_without_orphan_workflow(self):
        single = deepcopy(self.request)
        single.pk = None
        single.identity = str(uuid.uuid4())
        single.inspection_items = single.inspection_items[:1]
        single.version = 1
        single.save()
        with self.assertRaises(ValidationError):
            initialize_role_workflow(single)
        self.assertFalse(InspectionRoleWorkflow.objects.filter(request=single).exists())

    def test_admin_cannot_impersonate_area_owner(self):
        with self.assertRaises(PermissionDenied):
            self.action(area_save, 'appearance', self.payload('appearance', measurements=[self.measure('appearance')]), user=self.admin)

    def test_cannot_save_other_area_item(self):
        with self.assertRaises(PermissionDenied):
            self.action(area_save, 'appearance', self.payload('appearance', measurements=[self.measure('dimension')]))
        self.assertEqual(self.request_now().measurements, [])

    def test_distinct_area_versions_preserve_other_results(self):
        appearance_payload = self.payload('appearance', measurements=[self.measure('appearance')])
        dimension_payload = self.payload('dimension', measurements=[self.measure('dimension')])
        self.action(area_save, 'appearance', appearance_payload)
        self.action(area_save, 'dimension', dimension_payload)
        self.assertEqual({entry['item_id'] for entry in self.request_now().measurements}, {'look', 'size'})
        self.assertEqual(self.request.judgement, '')

    def test_patch_keeps_own_optional_item(self):
        self.action(area_save, 'dimension', self.payload('dimension', measurements=[self.measure('dimension'), {'item_id': 'size-optional', 'value': 'checked', 'judgement': 'pass'}]))
        self.action(area_save, 'dimension', self.payload('dimension', measurements=[self.measure('dimension', value='10.1')]))
        self.assertEqual(len(self.request_now().measurements), 2)

    def test_stale_same_area_and_config_fail_without_overwrite(self):
        payload = self.payload('appearance', measurements=[self.measure('appearance')])
        self.action(area_save, 'appearance', payload)
        with self.assertRaises(InspectionConflict):
            self.action(area_save, 'appearance', payload)
        with self.assertRaises(InspectionConflict):
            self.action(area_save, 'appearance', self.payload('appearance', config_version=1))
        self.assertEqual(self.request_now().measurements, [self.measure('appearance')])

    def test_completed_both_pass_required_for_aggregate_pass(self):
        first, _ = self.complete('appearance')
        self.assertEqual(first['judgement'], '')
        self.assertFalse(first['role_workflow']['can_submit'])
        second, _ = self.complete('dimension')
        self.assertEqual(second['judgement'], 'pass')
        self.assertEqual(second['role_workflow']['status'], 'completed')
        self.assertTrue(role_summary(self.request_now(), self.admin)['can_submit'])
        self.assertFalse(second['role_workflow']['mes']['can_save'])
        row = InspectionAreaResult.objects.get(workflow=self.workflow, area='dimension')
        self.assertEqual(row.completed_by_id, self.dimension.pk)

    def test_fail_propagates_and_cannot_be_changed_to_pass(self):
        self.action(area_complete, 'dimension', self.payload('dimension', measurements=[self.measure('dimension', value='12', judgement='fail')], judgement='fail'))
        self.assertEqual(self.request_now().judgement, 'fail')
        self.complete('appearance')
        self.assertEqual(self.request_now().judgement, 'fail')

    def test_complete_requires_values_valid_choices_numeric_bounds(self):
        for area, changes in [('appearance', {'measurements': []}), ('appearance', {'value': 'unsupported'}),
                              ('dimension', {'value': 'NaN'}), ('dimension', {'value': '12'})]:
            with self.subTest(area=area, changes=changes), self.assertRaises(ValidationError):
                measurements = changes.get('measurements', [self.measure(area, **changes)])
                self.action(area_complete, area, self.payload(area, measurements=measurements, judgement='pass'))

    def test_complete_requires_own_evidence(self):
        self.request.require_evidence = True
        self.request.save(update_fields=['require_evidence'])
        with self.assertRaises(ValidationError):
            self.complete('appearance')
        self.complete('appearance', evidence=[{'label': 'SYNTHETIC', 'url': 'https://evidence.example/appearance.png'}])
        with self.assertRaises(ValidationError):
            self.complete('dimension')

    def test_reopen_clears_pass_and_preserves_other_area(self):
        self.complete('appearance')
        self.complete('dimension')
        with self.assertRaises(InspectionConflict):
            self.action(area_save, 'appearance', self.payload('appearance', measurements=[self.measure('appearance')]))
        with self.assertRaises(ValidationError):
            self.action(area_reopen, 'appearance', self.payload('appearance'))
        response, _ = self.action(area_reopen, 'appearance', self.payload('appearance', reason='SYNTHETIC correction'))
        self.assertEqual(response['judgement'], '')
        self.assertEqual(InspectionAreaResult.objects.get(workflow=self.workflow, area='dimension').status, 'complete')

    def test_populated_assignment_cannot_change(self):
        self.action(area_save, 'appearance', self.payload('appearance', measurements=[self.measure('appearance')]))
        with self.assertRaises(InspectionConflict):
            self.configure()

    def test_idempotent_save_has_one_audit_and_version_increment(self):
        payload, key = self.payload('appearance', measurements=[self.measure('appearance')]), uuid.uuid4()
        first = self.action(area_save, 'appearance', payload, key=key)
        before = (self.request_now().version, InspectionAudit.objects.count(), InspectionOperation.objects.count())
        self.assertEqual(first, self.action(area_save, 'appearance', payload, key=key))
        self.assertEqual(before, (self.request_now().version, InspectionAudit.objects.count(), InspectionOperation.objects.count()))
        with self.assertRaises(InspectionConflict):
            self.action(area_save, 'appearance', payload | {'judgement': 'pass'}, key=key)

    def test_pending_or_mes_completed_cannot_change(self):
        pending = InspectionOperation.objects.create(request=self.request, scope='SYNTHETIC:mes-save',
            key=uuid.uuid4(), payload_digest='SYNTHETIC', status='unknown')
        with self.assertRaises(InspectionConflict):
            self.action(area_save, 'appearance', self.payload('appearance'))
        pending.status = 'succeeded'
        pending.save()
        self.request.mes_completion_status = 'completed'
        self.request.save(update_fields=['mes_completion_status'])
        with self.assertRaises(InspectionConflict):
            self.action(area_save, 'appearance', self.payload('appearance'))

    def test_actor_revoke_blocks_replay(self):
        payload, key = self.payload('appearance', measurements=[self.measure('appearance')]), uuid.uuid4()
        self.action(area_save, 'appearance', payload, key=key)
        get_user_model().objects.filter(pk=self.appearance.pk).update(is_active=False)
        with self.assertRaises(LoginRejected):
            self.action(area_save, 'appearance', payload, key=key)

    def test_explicit_shift_date_is_required_and_snapshotted(self):
        with self.assertRaises(ValidationError):
            self.configure(shift_date=None)
        with self.assertRaises(ValidationError):
            self.configure(shift_date='9999-12-31')
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.shift_snapshot['shift_date'], '2026-10-07')
        self.assertEqual(self.workflow.shift_snapshot['window_start'], '2026-10-07T08:00:00+08:00')
        self.assertEqual(self.workflow.shift_snapshot['basis'], 'explicit_declaration')
        self.assertEqual(self.workflow.shift_snapshot['effective_from'], '2026-10-01T00:00:00+00:00')

    def test_effective_period_parses_strict_local_minutes_to_utc(self):
        response, _ = settings_update(self.admin, self.shift_id, uuid.uuid4(), {
            'version': 1, 'effective_from_local': '2026-10-07T08:00',
            'effective_until_local': '2026-10-07T20:00', 'reason': 'SYNTHETIC one shift'}, session=inspection_session(self.admin))
        self.assertEqual(response['setting']['effective_from'], '2026-10-07T00:00:00+00:00')
        self.assertEqual(response['setting']['effective_until'], '2026-10-07T12:00:00+00:00')
        self.assertEqual(response['setting']['effective_from_local'], '2026-10-07T08:00')
        self.assertEqual(response['setting']['effective_until_local'], '2026-10-07T20:00')
        for value in ('2026-10-07', '2026-10-07T08:00Z', '2026-10-07T08:00:00', True, '9999-12-31T08:00'):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                settings_create(self.admin, uuid.uuid4(), {'code': 'SYNTHETIC-invalid-effective', 'label': 'Invalid',
                    'effective_from_local': value}, session=inspection_session(self.admin))

    def test_activation_effective_start_and_end_use_shift_boundaries(self):
        cases = [{'effective_from_local': None}, {'effective_from_local': '2026-10-01T08:01'},
                 {'effective_until_local': '2026-09-30T20:00'}, {'effective_until_local': '2026-10-01T08:00'},
                 {'effective_until_local': '2026-10-02T09:00'}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-invalid-effective', **changes),
                                session=inspection_session(self.admin))

    def test_future_handover_accepts_half_open_boundary_and_rejects_overlap(self):
        settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 1,
            'effective_until_local': '2026-10-08T08:00', 'reason': 'SYNTHETIC handover'}, session=inspection_session(self.admin))
        response, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-DAY-NEXT',
            effective_from_local='2026-10-08T08:00'), session=inspection_session(self.admin))
        self.assertTrue(response['setting']['active'])
        with self.assertRaises(InspectionConflict):
            settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-DAY-DUP',
                effective_from_local='2026-10-07T08:00', effective_until_local='2026-10-07T20:00'),
                session=inspection_session(self.admin))

    def test_day_night_boundaries_and_next_day_window(self):
        response, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-NIGHT',
            start_time='20:00', end_time='08:00', effective_from_local='2026-10-07T20:00',
            effective_until_local='2026-10-08T08:00'), session=inspection_session(self.admin))
        self.configure(shift_setting_id=response['setting']['id'])
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.shift_snapshot['window_start'], '2026-10-07T20:00:00+08:00')
        self.assertEqual(self.workflow.shift_snapshot['window_end'], '2026-10-08T08:00:00+08:00')
        with self.assertRaises(ValidationError):
            self.configure(shift_setting_id=response['setting']['id'], shift_date='2026-10-08')

    def test_effective_overlap_without_actual_clock_overlap_is_allowed_and_failure_rolls_back(self):
        settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 1,
            'effective_until_local': '2026-10-02T08:00', 'reason': 'SYNTHETIC final DAY'}, session=inspection_session(self.admin))
        response, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-CUSTOM-NIGHT',
            start_time='22:00', end_time='10:00', effective_from_local='2026-10-01T22:00',
            effective_until_local='2026-10-02T10:00'), session=inspection_session(self.admin))
        self.assertTrue(response['setting']['active'])
        before = (InspectionOperation.objects.count(), InspectionAudit.objects.count(),
                  list(InspectionShiftSetting.objects.order_by('id').values()))
        # Extending DAY now introduces an actual 08:00-10:00 overlap on Oct 2.
        with self.assertRaises(InspectionConflict):
            settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 2,
                'effective_until_local': '2026-10-02T20:00', 'label': 'Must rollback',
                'reason': 'SYNTHETIC rejected extension'}, session=inspection_session(self.admin))
        self.assertEqual(before, (InspectionOperation.objects.count(), InspectionAudit.objects.count(),
                                 list(InspectionShiftSetting.objects.order_by('id').values())))

    def test_custom_midnight_window_and_touching_night_handover(self):
        first, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-CUSTOM-23',
            start_time='23:00', end_time='01:00', effective_from_local='2026-10-07T23:00',
            effective_until_local='2026-10-08T23:00'), session=inspection_session(self.admin))
        self.configure(shift_setting_id=first['setting']['id'])
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.shift_snapshot['window_end'], '2026-10-08T01:00:00+08:00')
        next_period, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-CUSTOM-23-NEXT',
            start_time='23:00', end_time='01:00', effective_from_local='2026-10-08T23:00'),
            session=inspection_session(self.admin))
        self.assertTrue(next_period['setting']['active'])
        self.configure(shift_setting_id=next_period['setting']['id'], shift_date='2026-10-08')
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.shift_snapshot['window_end'], '2026-10-09T01:00:00+08:00')

    def test_inactive_draft_can_preserve_until_only_and_unaligned_period(self):
        response, _ = settings_create(self.admin, uuid.uuid4(), {'code': 'SYNTHETIC-DRAFT-PERIOD', 'label': 'Draft',
            'effective_until_local': '2026-10-07T09:15'}, session=inspection_session(self.admin))
        self.assertFalse(response['setting']['active'])
        self.assertIsNone(response['setting']['effective_from'])
        self.assertEqual(response['setting']['effective_until_local'], '2026-10-07T09:15')

    def test_whole_declared_shift_must_fit_validity_period(self):
        settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 1,
            'effective_from_local': '2026-10-07T08:00', 'effective_until_local': '2026-10-07T20:00',
            'reason': 'SYNTHETIC one DAY'}, session=inspection_session(self.admin))
        self.configure(shift_version=2)
        for outside in ('2026-10-06', '2026-10-08'):
            with self.subTest(outside=outside), self.assertRaises(ValidationError):
                self.configure(shift_version=2, shift_date=outside)

    def test_configured_completed_snapshot_is_not_recomputed_from_future_setting(self):
        self.complete('appearance')
        self.complete('dimension')
        self.workflow.refresh_from_db()
        original = deepcopy(self.workflow.shift_snapshot)
        settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 1,
            'effective_from_local': '2026-11-01T08:00', 'label': 'Future DAY',
            'reason': 'SYNTHETIC future setting'}, session=inspection_session(self.admin))
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.shift_snapshot, original)
        self.assertEqual(self.request_now().judgement, 'pass')

    def test_unknown_existing_effective_period_blocks_new_activation_without_backfill(self):
        InspectionShiftSetting.objects.filter(pk=self.shift_id).update(effective_from=None)
        with self.assertRaises(InspectionConflict):
            settings_create(self.admin, uuid.uuid4(), self.shift_payload(code='SYNTHETIC-NEXT', start_time='20:00', end_time='08:00'),
                            session=inspection_session(self.admin))
        self.assertIsNone(InspectionShiftSetting.objects.get(pk=self.shift_id).effective_from)

    def test_legacy_cannot_opt_in_through_configuration(self):
        legacy = deepcopy(self.request)
        legacy.pk = None
        legacy.identity = str(uuid.uuid4())
        legacy.save()
        with self.assertRaises(InspectionConflict):
            configure_role_workflow(self.admin, legacy.pk, uuid.uuid4(), {
                'config_version': 1, 'shift_setting_id': self.shift_id, 'shift_version': 1,
                'shift_date': '2026-10-07', 'item_areas': {'look': 'appearance', 'size': 'dimension', 'size-optional': 'dimension'},
                'reason': 'Cannot convert history'}, session=inspection_session(self.admin))
        self.assertFalse(InspectionRoleWorkflow.objects.filter(request=legacy).exists())

    def test_origin_quantity_version_does_not_stale_independent_area(self):
        payload = self.payload('dimension', measurements=[self.measure('dimension')])
        InspectionRequest.objects.filter(pk=self.request.pk).update(version=self.request.version + 4)
        response, _ = self.action(area_save, 'dimension', payload)
        self.assertEqual(response['measurements'], [self.measure('dimension')])

    def test_declared_fail_cannot_misrepresent_passing_own_items(self):
        with self.assertRaises(ValidationError):
            self.action(area_complete, 'appearance', self.payload('appearance', measurements=[self.measure('appearance')], judgement='fail'))

    def test_evidence_unknown_measurement_and_forged_actor_rejected(self):
        with self.assertRaises(ValidationError):
            self.action(area_save, 'appearance', self.payload('appearance', measurements=[self.measure('appearance', actor_id=self.admin.pk)]))
        with self.assertRaises(ValidationError):
            self.action(area_save, 'appearance', self.payload('appearance', actor_id=self.admin.pk))
        with self.assertRaises(ValidationError):
            self.action(area_save, 'appearance', self.payload('appearance', measurements=[self.measure('appearance', evidence_url='https://evidence.example/a?secret=x')]))


class InspectionSharedTerminalTests(RoleFixtures, TestCase):
    def setUp(self):
        super().setUp()
        self.configure(shared_terminal=True)

    def terminal_action(self, func, area, **changes):
        inspector = self.appearance if area == 'appearance' else self.dimension
        payload = {'inspector_id': inspector.pk}
        payload.update(changes)
        return self.action(func, area, self.payload(area, **payload), user=self.admin)

    def test_one_current_login_records_two_distinct_inspectors_and_independent_area_results(self):
        dimension_payload = self.payload('dimension', inspector_id=self.dimension.pk,
            measurements=[self.measure('dimension')], judgement='pass')
        self.terminal_action(area_complete, 'appearance', measurements=[self.measure('appearance')], judgement='pass')
        self.assertEqual(self.request_now().judgement, '')
        response, _ = self.action(area_complete, 'dimension', dimension_payload, user=self.admin)
        self.assertEqual(response['judgement'], 'pass')
        self.assertEqual(response['role_workflow']['status'], 'completed')
        self.assertEqual(response['role_workflow']['shared_terminal'], {'enabled': True,
            'operator_id': self.admin.pk, 'operator_name': self.admin.username, 'can_operate': True})
        for name, inspector in [('appearance', self.appearance), ('dimension', self.dimension)]:
            area = InspectionAreaResult.objects.get(workflow=self.workflow, area=name)
            self.assertEqual(area.completed_by_id, inspector.pk)
            self.assertEqual(area.completed_recorded_by_id, self.admin.pk)
            self.assertEqual(area.completed_recorded_by_name, self.admin.username)
            item_id = 'look' if name == 'appearance' else 'size'
            attribution = area.item_authorship[item_id]
            self.assertEqual(attribution['inspector_id'], inspector.pk)
            self.assertEqual(attribution['recorded_by_id'], self.admin.pk)
            self.assertTrue(attribution['recorded_at'])
            audit = InspectionAudit.objects.get(request=self.request, action=f'role_{name}_complete')
            self.assertEqual(audit.actor_id, self.admin.pk)
        self.assertFalse(response['role_workflow']['mes']['can_save'])
        self.assertFalse(response['mes_workflow']['can_finish'])

    def test_terminal_requires_explicit_exact_assignee_and_server_owned_attribution(self):
        for inspector_id in (None, self.dimension.pk, self.outsider.pk):
            with self.subTest(inspector_id=inspector_id), self.assertRaises((PermissionDenied, ValidationError)):
                payload = self.payload('appearance', measurements=[self.measure('appearance')])
                if inspector_id is not None:
                    payload['inspector_id'] = inspector_id
                self.action(area_save, 'appearance', payload, user=self.admin)
        for field, value in [('item_authorship', {}), ('completed_recorded_by', self.outsider.pk),
                             ('actor_id', self.appearance.pk), ('inspector_id', True)]:
            with self.subTest(field=field), self.assertRaises(ValidationError):
                self.terminal_action(area_save, 'appearance', **{field: value})
        self.assertEqual(self.request_now().measurements, [])
        self.assertEqual(InspectionAreaResult.objects.get(workflow=self.workflow, area='appearance').item_authorship, {})

    def test_terminal_authority_is_specific_to_explicit_configurator(self):
        self.assertFalse(role_summary(self.request, self.outsider)['shared_terminal']['can_operate'])
        with self.assertRaises(PermissionDenied):
            self.action(area_save, 'appearance', self.payload('appearance', inspector_id=self.appearance.pk), user=self.outsider)
        self.configure(shared_terminal=False)
        with self.assertRaises(PermissionDenied):
            self.terminal_action(area_save, 'appearance')
        self.assertFalse(role_summary(self.request, self.admin)['shared_terminal']['enabled'])

    def test_terminal_opt_in_is_typed_server_owned_and_immutable_after_input(self):
        for changes in ({'shared_terminal': 'true'}, {'shared_terminal_operator': self.outsider.pk}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.configure(**changes)
        self.configure()
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.shared_terminal_operator_id, self.admin.pk)
        self.terminal_action(area_save, 'appearance', measurements=[self.measure('appearance')])
        with self.assertRaises(InspectionConflict):
            self.configure(shared_terminal=False)

    def test_terminal_replay_rechecks_selected_inspector_current_eligibility(self):
        payload = self.payload('appearance', inspector_id=self.appearance.pk, measurements=[self.measure('appearance')])
        key = uuid.uuid4()
        first = self.action(area_save, 'appearance', payload, user=self.admin, key=key)
        before = InspectionAudit.objects.count(), InspectionOperation.objects.count(), self.request_now().version
        self.assertEqual(first, self.action(area_save, 'appearance', payload, user=self.admin, key=key))
        get_user_model().objects.filter(pk=self.appearance.pk).update(is_active=False)
        with self.assertRaises(PermissionDenied):
            self.action(area_save, 'appearance', payload, user=self.admin, key=key)
        self.assertEqual(before, (InspectionAudit.objects.count(), InspectionOperation.objects.count(), self.request_now().version))

    def test_partial_item_save_preserves_previous_attribution_and_other_area(self):
        self.action(area_save, 'dimension', self.payload('dimension', measurements=[self.measure('dimension')]))
        before = deepcopy(InspectionAreaResult.objects.get(workflow=self.workflow, area='dimension').item_authorship['size'])
        self.terminal_action(area_save, 'dimension', measurements=[{'item_id': 'size-optional', 'value': 'SYNTHETIC', 'judgement': 'pass'}])
        area = InspectionAreaResult.objects.get(workflow=self.workflow, area='dimension')
        self.assertEqual(area.item_authorship['size'], before)
        self.assertEqual(area.item_authorship['size-optional']['recorded_by_id'], self.admin.pk)
        self.assertEqual({entry['item_id'] for entry in area.measurements}, {'size', 'size-optional'})
        with self.assertRaises(PermissionDenied):
            self.terminal_action(area_save, 'appearance', measurements=[self.measure('dimension')])
        area.refresh_from_db()
        self.assertEqual(area.item_authorship['size'], before)

    def test_reopen_clears_completion_recorders_but_preserves_item_evidence(self):
        self.terminal_action(area_complete, 'appearance', measurements=[self.measure('appearance')], judgement='pass')
        area = InspectionAreaResult.objects.get(workflow=self.workflow, area='appearance')
        attribution = deepcopy(area.item_authorship)
        self.terminal_action(area_reopen, 'appearance', reason='SYNTHETIC inspector correction')
        area.refresh_from_db()
        self.assertEqual((area.completed_by_id, area.completed_recorded_by_id, area.completed_recorded_by_name), (None, None, ''))
        self.assertEqual(area.item_authorship, attribution)
        self.assertEqual(self.request_now().judgement, '')


@skipUnless(connection.vendor == 'postgresql', 'Requires disposable PostgreSQL for real concurrency.')
class InspectionRolePostgresTests(RoleFixtures, TransactionTestCase):
    def concurrent(self, callbacks):
        barrier, outcomes = Barrier(len(callbacks)), Queue()
        def run(callback):
            connections.close_all()
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SET statement_timeout='10000ms'")
                    cursor.execute("SET lock_timeout='5000ms'")
                barrier.wait(timeout=10)
                outcomes.put(('result', callback()))
            except Exception as error:
                outcomes.put(('error', error))
            finally:
                connections.close_all()
        threads = [Thread(target=run, args=(callback,), daemon=True) for callback in callbacks]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
            self.assertFalse(thread.is_alive())
        return [outcomes.get(timeout=1) for _ in callbacks]

    def callback(self, area, payload, actor):
        token_user = actor
        session = inspection_session(token_user)
        actor_id, request_id = actor.pk, self.request.pk
        def call():
            user = get_user_model().objects.get(pk=actor_id)
            return area_save(user, request_id, area, uuid.uuid4(), deepcopy(payload), session=session)
        return call

    def test_independent_area_concurrency_both_commit(self):
        results = self.concurrent([
            self.callback('appearance', self.payload('appearance', measurements=[self.measure('appearance')]), self.appearance),
            self.callback('dimension', self.payload('dimension', measurements=[self.measure('dimension')]), self.dimension)])
        self.assertEqual([kind for kind, _ in results], ['result', 'result'], results)
        self.assertEqual({entry['item_id'] for entry in self.request_now().measurements}, {'look', 'size'})

    def test_same_area_concurrency_one_stale_conflict(self):
        payload = self.payload('appearance', measurements=[self.measure('appearance')])
        callback = self.callback('appearance', payload, self.appearance)
        results = self.concurrent([callback, callback])
        self.assertEqual(sorted(kind for kind, _ in results), ['error', 'result'], results)
        self.assertTrue(any(isinstance(value, InspectionConflict) for kind, value in results if kind == 'error'))

    def test_same_terminal_independent_area_concurrency_preserves_both_authors(self):
        self.configure(shared_terminal=True)
        results = self.concurrent([
            self.callback('appearance', self.payload('appearance', inspector_id=self.appearance.pk,
                measurements=[self.measure('appearance')]), self.admin),
            self.callback('dimension', self.payload('dimension', inspector_id=self.dimension.pk,
                measurements=[self.measure('dimension')]), self.admin)])
        self.assertEqual([kind for kind, _ in results], ['result', 'result'], results)
        self.assertEqual({entry['item_id'] for entry in self.request_now().measurements}, {'look', 'size'})
        for area, inspector in [('appearance', self.appearance), ('dimension', self.dimension)]:
            row = InspectionAreaResult.objects.get(workflow=self.workflow, area=area)
            attribution = next(iter(row.item_authorship.values()))
            self.assertEqual((attribution['inspector_id'], attribution['recorded_by_id']), (inspector.pk, self.admin.pk))

    def test_terminal_and_direct_author_same_area_have_one_stale_conflict_without_deadlock(self):
        self.configure(shared_terminal=True)
        payload = self.payload('appearance', measurements=[self.measure('appearance')])
        results = self.concurrent([
            self.callback('appearance', dict(payload, inspector_id=self.appearance.pk), self.admin),
            self.callback('appearance', payload, self.appearance)])
        self.assertEqual(sorted(kind for kind, _ in results), ['error', 'result'], results)
        self.assertTrue(any(isinstance(value, InspectionConflict) for kind, value in results if kind == 'error'), results)
        row = InspectionAreaResult.objects.get(workflow=self.workflow, area='appearance')
        self.assertEqual(row.item_authorship['look']['inspector_id'], self.appearance.pk)
        self.assertIn(row.item_authorship['look']['recorded_by_id'], [self.admin.pk, self.appearance.pk])

    def test_terminal_prelocks_allow_concurrent_assignment_fk_checks_to_finish(self):
        # A later-created terminal operator must first prelock the older
        # inspector. Concurrent configuration holds that operator's user lock
        # and swaps assignments, requiring a new FK check on the older user.
        self.admin, self.outsider = self.outsider, self.admin
        self.assertGreater(self.admin.pk, self.appearance.pk)
        self.configure(shared_terminal=True)
        settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 1,
            'active': False, 'reason': 'SYNTHETIC future reassignment'}, session=inspection_session(self.admin))
        next_shift, _ = settings_create(self.admin, uuid.uuid4(), self.shift_payload(
            code='SYNTHETIC-SWAPPED', appearance_assignee=self.dimension.pk,
            dimension_assignee=self.appearance.pk), session=inspection_session(self.admin))
        self.workflow.refresh_from_db()
        configuration = {'config_version': self.workflow.config_version,
            'shift_setting_id': next_shift['setting']['id'], 'shift_version': 1,
            'shift_date': '2026-10-07', 'item_areas': deepcopy(self.workflow.item_areas),
            'shared_terminal': True, 'reason': 'SYNTHETIC concurrent swapped assignment'}
        terminal_payload = self.payload('appearance', inspector_id=self.appearance.pk,
            measurements=[self.measure('appearance')])
        operator_id, request_id = self.admin.pk, self.request.pk
        operator_locked, terminal_pid = Event(), Queue()
        configuration_session = inspection_session(self.admin)
        terminal_session = inspection_session(self.admin)

        class ConfigurationSession:
            @contextmanager
            def lock(self, permission, *, actor_id):
                with configuration_session.lock(permission, actor_id=actor_id) as current:
                    with connection.cursor() as cursor:
                        cursor.execute('SELECT pg_backend_pid()')
                        config_pid = cursor.fetchone()[0]
                    operator_locked.set()
                    waiting_pid = terminal_pid.get(timeout=5)
                    deadline = monotonic() + 5
                    while True:
                        with connection.cursor() as cursor:
                            cursor.execute('SELECT pg_blocking_pids(%s)', [waiting_pid])
                            blockers = cursor.fetchone()[0]
                        if config_pid in blockers:
                            break
                        if monotonic() >= deadline:
                            raise AssertionError('Terminal did not reach its blocked operator prelock.')
                        sleep(0.01)
                    yield current

        def configure():
            actor = get_user_model().objects.get(pk=operator_id)
            return configure_role_workflow(actor, request_id, uuid.uuid4(), configuration,
                session=ConfigurationSession())

        def save():
            if not operator_locked.wait(timeout=5):
                raise AssertionError('Configuration did not hold its operator lock.')
            actor = get_user_model().objects.get(pk=operator_id)
            with connection.cursor() as cursor:
                cursor.execute('SELECT pg_backend_pid()')
                terminal_pid.put(cursor.fetchone()[0])
            return area_save(actor, request_id, 'appearance', uuid.uuid4(), terminal_payload,
                session=terminal_session)

        results = self.concurrent([configure, save])
        self.assertEqual(sorted(kind for kind, _ in results), ['error', 'result'], results)
        self.assertTrue(any(isinstance(value, (InspectionConflict, PermissionDenied))
            for kind, value in results if kind == 'error'), results)
        self.assertEqual(self.request_now().measurements, [])
        self.assertEqual(InspectionAreaResult.objects.get(workflow=self.workflow,
            area='dimension').assigned_to_id, self.appearance.pk)

    def activation_callbacks(self, periods):
        settings_update(self.admin, self.shift_id, uuid.uuid4(), {'version': 1, 'active': False,
            'reason': 'SYNTHETIC isolated activation test'}, session=inspection_session(self.admin))
        callbacks = []
        for index, (start, end) in enumerate(periods):
            actor = self.admin if index == 0 else self.outsider
            session = inspection_session(actor)
            response, _ = settings_create(actor, uuid.uuid4(), self.shift_payload(code=f'SYNTHETIC-ACTIVATE-{index}',
                active=False, effective_from_local=start, effective_until_local=end), session=session)
            setting_id, actor_id = response['setting']['id'], actor.pk
            def call(setting_id=setting_id, actor_id=actor_id, session=session):
                user = get_user_model().objects.get(pk=actor_id)
                return settings_update(user, setting_id, uuid.uuid4(), {'version': 1, 'active': True,
                    'reason': 'SYNTHETIC concurrent activation'}, session=session)
            callbacks.append(call)
        return callbacks

    def test_concurrent_overlapping_activation_has_one_conflict(self):
        results = self.concurrent(self.activation_callbacks([
            ('2026-10-08T08:00', None), ('2026-10-08T08:00', None)]))
        self.assertEqual(sorted(kind for kind, _ in results), ['error', 'result'], results)
        self.assertTrue(any(isinstance(value, InspectionConflict) for kind, value in results if kind == 'error'))
        self.assertEqual(InspectionShiftSetting.objects.filter(active=True).count(), 1)

    def test_concurrent_adjacent_effective_periods_both_activate(self):
        results = self.concurrent(self.activation_callbacks([
            ('2026-10-08T08:00', '2026-10-09T08:00'), ('2026-10-09T08:00', None)]))
        self.assertEqual([kind for kind, _ in results], ['result', 'result'], results)
        self.assertEqual(InspectionShiftSetting.objects.filter(active=True).count(), 2)
