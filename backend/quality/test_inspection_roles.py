"""Disposable fixtures for independent WJ area input; never contact MES."""
from copy import deepcopy
from datetime import timedelta
from threading import Barrier, Thread
from queue import Queue
from unittest import skipUnless
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
            'dimension_assignee': self.dimension.pk, 'active': True}
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
