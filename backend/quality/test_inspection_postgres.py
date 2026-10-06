"""Real PostgreSQL locking tests with disposable, conspicuously synthetic data.

These tests never create a transport or contact MES. They require a disposable
PostgreSQL test database provided by the caller; SQLite skips them because its
locking behavior cannot verify the advisory/row-lock protocol used in production.
"""
from copy import deepcopy
from datetime import timedelta
from queue import Queue
from threading import Barrier, Event, Thread
from unittest import mock, skipUnless
import uuid

from django.contrib.auth import get_user_model
from django.db import connection, connections
from django.test import TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest
from . import test_inspection_requests as fixtures


@skipUnless(connection.vendor == 'postgresql', 'Requires an isolated PostgreSQL test database; SQLite cannot verify row/advisory locks.')
class InspectionPostgresConcurrencyTests(TransactionTestCase):
    """Separate connections, bounded waits, and no TestCase transaction wrapper."""

    base_url = '/api/quality/inspection-requests/'
    thread_timeout = 15

    def setUp(self):
        User = get_user_model()
        self.editor = User.objects.create_user(username='SYNTHETIC-PG-editor', is_superuser=True)
        self.other_editor = User.objects.create_user(username='SYNTHETIC-PG-other-editor', is_superuser=True)
        self.reviewer = User.objects.create_user(username='SYNTHETIC-PG-reviewer', is_superuser=True)
        users = (self.editor, self.other_editor, self.reviewer)
        self.tokens = {user.pk: fixtures.synthetic_token(user) for user in users}
        mapping_settings = self.settings(MES_USER_OAUTH_USER_MAP={
            str(user.pk): str(91000000000000006 + index) for index, user in enumerate(users)})
        mapping_settings.enable()
        self.addCleanup(mapping_settings.disable)
        self.started_at = timezone.now() - timedelta(minutes=5)

    def create_payload(self, **changes):
        payload = {
            'work_order_ref': 'SYNTHETIC-PG-WO', 'task_ref': 'SYNTHETIC-PG-TASK',
            'part_no': 'SYNTHETIC-PG-PART', 'equipment_ref': 'SYNTHETIC-PG-MACHINE',
            'inspection_type': 'first', 'target_quantity': '10.000', 'uom': 'EA',
            'warehouse_ref': 'SYNTHETIC-PG-WAREHOUSE', 'lot_ref': 'SYNTHETIC-PG-LOT',
            'work_started_at': self.started_at.isoformat(),
            'require_evidence': False, 'quantity_mode': 'recorded',
            'inspection_items': [{'id': 'dimension', 'label': 'SYNTHETIC dimension',
                                  'kind': 'number', 'minimum': '9.5', 'maximum': '10.5',
                                  'required': True, 'evidence_required': False}],
        }
        payload.update(changes)
        return payload

    def draft_payload(self, version, **changes):
        payload = {
            'version': version,
            'measurements': [{'item_id': 'dimension', 'value': '10.0', 'judgement': 'pass'}],
            'evidence': [], 'inspected_quantity': '10.000', 'accepted_quantity': '10.000',
            'rejected_quantity': '0.000', 'judgement': 'pass', 'notes': 'SYNTHETIC-PG draft',
        }
        payload.update(changes)
        return payload

    def call(self, user_id, method, suffix, payload, key):
        # A fresh user and API client prevent cross-thread auth/permission caches.
        user = get_user_model().objects.get(pk=user_id)
        client = APIClient()
        fixtures.authenticate_inspection_client(client, user, token=self.tokens[user_id])
        response = getattr(client, method)(self.base_url + suffix, deepcopy(payload),
                                          format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        return {'status': response.status_code, 'body': deepcopy(response.data)}

    def start_call(self, callback, *, barrier=None):
        outcome = Queue(maxsize=1)

        def run():
            # Django connection handlers are thread-local. Close on entry/exit so
            # no connection outlives a test or contaminates its disposable DB.
            connections.close_all()
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SET statement_timeout = '10000ms'")
                    cursor.execute("SET lock_timeout = '5000ms'")
                    cursor.execute('SELECT pg_backend_pid()')
                    backend_pid = cursor.fetchone()[0]
                if barrier is not None:
                    barrier.wait(timeout=10)
                outcome.put({'result': callback(), 'backend_pid': backend_pid})
            except Exception as exc:
                outcome.put({'error': exc})
            finally:
                connections.close_all()

        thread = Thread(target=run, name='inspection-postgres-fixture', daemon=True)
        thread.start()
        return thread, outcome

    def finish_call(self, worker):
        thread, outcome = worker
        thread.join(timeout=self.thread_timeout)
        self.assertFalse(thread.is_alive(), 'PostgreSQL fixture worker exceeded its bounded timeout.')
        self.assertFalse(outcome.empty(), 'PostgreSQL fixture worker produced no outcome.')
        value = outcome.get_nowait()
        if 'error' in value:
            raise value['error']
        return value

    def parallel(self, *callbacks):
        barrier = Barrier(len(callbacks))
        workers = [self.start_call(callback, barrier=barrier) for callback in callbacks]
        # Always join every worker before a failed assertion can trigger DB flush.
        values, errors = [], []
        for worker in workers:
            try:
                values.append(self.finish_call(worker))
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise errors[0]
        self.assertEqual(len({value['backend_pid'] for value in values}), len(callbacks),
                         'The concurrency test must use independent PostgreSQL sessions.')
        return [value['result'] for value in values]

    def create(self):
        response = self.call(self.editor.pk, 'post', '', self.create_payload(), uuid.uuid4())
        self.assertEqual(response['status'], 201, response)
        return response['body']

    def approved(self):
        data = self.create()
        response = self.call(self.editor.pk, 'patch', f'{data["id"]}/',
                             self.draft_payload(data['version']), uuid.uuid4())
        self.assertEqual(response['status'], 200, response)
        data = response['body']
        response = self.call(self.editor.pk, 'post', f'{data["id"]}/submit/',
                             {'version': data['version']}, uuid.uuid4())
        self.assertEqual(response['status'], 200, response)
        data = response['body']
        response = self.call(self.reviewer.pk, 'post', f'{data["id"]}/approve/',
                             {'version': data['version']}, uuid.uuid4())
        self.assertEqual(response['status'], 200, response)
        return response['body']

    def test_simultaneous_same_uuid_and_body_replay_one_create_exactly(self):
        key, payload = uuid.uuid4(), self.create_payload()
        responses = self.parallel(
            lambda: self.call(self.editor.pk, 'post', '', payload, key),
            lambda: self.call(self.editor.pk, 'post', '', payload, key),
        )
        self.assertEqual([response['status'] for response in responses], [201, 201])
        self.assertEqual(responses[0]['body'], responses[1]['body'])
        self.assertEqual(InspectionRequest.objects.count(), 1)
        self.assertEqual(InspectionOperation.objects.count(), 1)
        self.assertEqual(InspectionAudit.objects.count(), 1)
        operation = InspectionOperation.objects.get()
        self.assertEqual(operation.status, 'succeeded')
        self.assertEqual(operation.response, responses[0]['body'])
        self.assertEqual(operation.key, key)
        self.assertEqual(operation.request_id, InspectionRequest.objects.get().pk)

    def test_simultaneous_same_uuid_changed_body_conflicts_without_overwrite(self):
        key = uuid.uuid4()
        payloads = [self.create_payload(warehouse_ref='SYNTHETIC-PG-WAREHOUSE-A'),
                    self.create_payload(warehouse_ref='SYNTHETIC-PG-WAREHOUSE-B')]
        responses = self.parallel(*[
            lambda payload=payload: self.call(self.editor.pk, 'post', '', payload, key)
            for payload in payloads
        ])
        self.assertEqual(sorted(response['status'] for response in responses), [201, 409])
        winner = next(response for response in responses if response['status'] == 201)
        loser = next(response for response in responses if response['status'] == 409)
        self.assertEqual(str(loser['body']['code']), 'idempotency_payload_mismatch')
        self.assertEqual(InspectionRequest.objects.count(), 1)
        self.assertEqual(InspectionOperation.objects.count(), 1)
        self.assertEqual(InspectionAudit.objects.count(), 1)
        self.assertEqual(InspectionRequest.objects.get().warehouse_ref, winner['body']['warehouse_ref'])

    def test_simultaneous_same_identity_different_actors_and_keys_has_one_winner(self):
        payload = self.create_payload()
        responses = self.parallel(
            lambda: self.call(self.editor.pk, 'post', '', payload, uuid.uuid4()),
            lambda: self.call(self.other_editor.pk, 'post', '', payload, uuid.uuid4()),
        )
        self.assertEqual(sorted(response['status'] for response in responses), [201, 409])
        winner = next(response for response in responses if response['status'] == 201)
        loser = next(response for response in responses if response['status'] == 409)
        self.assertEqual(str(loser['body']['code']), 'duplicate_request')
        self.assertEqual(InspectionRequest.objects.count(), 1)
        self.assertEqual(InspectionOperation.objects.count(), 1)
        self.assertEqual(InspectionAudit.objects.count(), 1)
        row = InspectionRequest.objects.get()
        self.assertEqual(row.assigned_to_id, winner['body']['assigned_to'])
        self.assertEqual(InspectionAudit.objects.get().actor_id, row.assigned_to_id)
        self.assertEqual(InspectionOperation.objects.get().scope, f'{row.assigned_to_id}:create')

    def test_two_draft_writers_at_same_version_preserve_winning_values(self):
        data = self.create()
        payloads = [self.draft_payload(data['version'], notes='SYNTHETIC-PG draft A'),
                    self.draft_payload(data['version'], notes='SYNTHETIC-PG draft B',
                                       measurements=[{'item_id': 'dimension', 'value': '10.1', 'judgement': 'pass'}])]
        responses = self.parallel(*[
            lambda payload=payload: self.call(self.editor.pk, 'patch', f'{data["id"]}/', payload, uuid.uuid4())
            for payload in payloads
        ])
        self.assertEqual(sorted(response['status'] for response in responses), [200, 409])
        winner = next(response for response in responses if response['status'] == 200)
        loser = next(response for response in responses if response['status'] == 409)
        self.assertEqual(str(loser['body']['code']), 'stale_version')
        row = InspectionRequest.objects.get(pk=data['id'])
        self.assertEqual(row.version, data['version'] + 1)
        self.assertEqual(row.notes, winner['body']['notes'])
        self.assertEqual(row.measurements, winner['body']['measurements'])
        self.assertEqual(row.status, 'draft')
        self.assertEqual(row.operations.count(), 2)  # create and the winning draft
        self.assertEqual(row.audit.filter(action='draft').count(), 1)

    def test_simultaneous_reinspection_creates_only_one_child(self):
        data = self.create()
        # Disposable failed fixture, not a bypass available through the API.
        InspectionRequest.objects.filter(pk=data['id']).update(status='failed', judgement='fail')
        responses = self.parallel(
            lambda: self.call(self.editor.pk, 'post', f'{data["id"]}/reinspect/',
                              {'version': data['version'], 'reason': 'SYNTHETIC-PG recheck A'}, uuid.uuid4()),
            lambda: self.call(self.other_editor.pk, 'post', f'{data["id"]}/reinspect/',
                              {'version': data['version'], 'reason': 'SYNTHETIC-PG recheck B'}, uuid.uuid4()),
        )
        self.assertEqual(sorted(response['status'] for response in responses), [201, 409])
        winner = next(response for response in responses if response['status'] == 201)
        loser = next(response for response in responses if response['status'] == 409)
        self.assertEqual(str(loser['body']['code']), 'stale_version')
        parent = InspectionRequest.objects.get(pk=data['id'])
        child = InspectionRequest.objects.get(parent_id=parent.pk)
        self.assertEqual(InspectionRequest.objects.count(), 2)
        self.assertEqual(parent.version, data['version'] + 1)
        self.assertEqual(child.pk, winner['body']['id'])
        self.assertEqual(child.assigned_to_id, winner['body']['assigned_to'])
        self.assertEqual(child.inspection_items, parent.inspection_items)
        self.assertEqual(child.measurements, [])
        self.assertEqual(child.status, 'draft')
        self.assertEqual(InspectionAudit.objects.filter(action='create_reinspection').count(), 1)
        self.assertEqual(parent.audit.filter(action='reinspect').count(), 1)
        self.assertEqual(parent.operations.count(), 2)
        repeat = self.call(self.editor.pk, 'post', f'{parent.pk}/reinspect/',
                           {'version': parent.version, 'reason': 'SYNTHETIC-PG duplicate'}, uuid.uuid4())
        self.assertEqual(repeat['status'], 409, repeat)
        self.assertEqual(str(repeat['body']['code']), 'invalid_reinspection')
        self.assertEqual(InspectionRequest.objects.filter(parent_id=parent.pk).count(), 1)

    def test_pending_sync_waits_for_actor_and_concurrent_refresh_survives_late_timeout(self):
        save_started, release_save = Event(), Event()
        adapter = fixtures.SyntheticInspectionAdapter()
        adapter.save_mode = 'timeout_after_commit'

        def block_after_synthetic_commit(request, operation):
            save_started.set()
            if not release_save.wait(timeout=self.thread_timeout):
                raise AssertionError('Synthetic save was not released within its bounded timeout.')

        adapter.on_save = block_after_synthetic_commit
        with mock.patch('quality.inspection_adapter.get_inspection_adapter', return_value=adapter):
            data = self.approved()
            key, payload = uuid.uuid4(), {'version': data['version']}
            # ActionSerializer adds the default reason to the persisted digest.
            worker = self.start_call(lambda: self.call(self.editor.pk, 'post', f'{data["id"]}/sync/', payload, key))
            workers, outcomes = {'sync': worker}, {}
            try:
                self.assertTrue(save_started.wait(timeout=10), 'Synthetic sync never reached its committed save fixture.')
                pending = InspectionRequest.objects.get(pk=data['id'])
                self.assertEqual(pending.sync_status, 'pending')
                self.assertEqual(pending.mes_completion_status, 'pending')
                self.assertEqual(pending.injection_receipt_readiness, 'not_verified')
                observed = self.call(self.editor.pk, 'get', f'{pending.pk}/', {}, uuid.uuid4())
                self.assertEqual(observed['status'], 200, observed)
                self.assertEqual(observed['body']['sync_status'], 'pending')
                self.assertEqual(observed['body']['mes_completion_status'], 'pending')
                for name, request_payload, request_key in (
                        ('replay', payload, key), ('denied', {'version': pending.version}, uuid.uuid4())):
                    started = Event()

                    def queued_sync(body=request_payload, operation_key=request_key, signal=started):
                        signal.set()
                        return self.call(self.editor.pk, 'post', f'{pending.pk}/sync/', body, operation_key)

                    workers[name] = self.start_call(queued_sync)
                    self.assertTrue(started.wait(timeout=5), 'The competing sync request did not start.')
                    thread, outcome = workers[name]
                    thread.join(timeout=0.2)
                    self.assertTrue(thread.is_alive(), 'The same actor must wait for the active dispatch.')
                    self.assertTrue(outcome.empty(), 'The competing sync returned before dispatch settled.')
                self.assertEqual(len(adapter.save_calls), 1)
                workers['refresh'] = self.start_call(lambda: self.call(self.reviewer.pk, 'post', f'{pending.pk}/refresh/',
                                                                      {'version': pending.version}, uuid.uuid4()))
                refreshed = self.finish_call(workers['refresh'])
                del workers['refresh']
                self.assertEqual(refreshed['result']['status'], 200, refreshed)
                settled = refreshed['result']['body']
                self.assertEqual(settled['sync_status'], 'succeeded')
                self.assertEqual(settled['mes_completion_status'], 'completed')
                self.assertEqual(settled['external_result_id'], 'SYNTHETIC-RESULT-001')
                settled_version = settled['version']
            finally:
                # Release even after an assertion failure; never leave a worker
                # connected while TransactionTestCase flushes its fixture DB.
                release_save.set()
                errors = []
                for name, active_worker in workers.items():
                    try:
                        outcomes[name] = self.finish_call(active_worker)
                    except Exception as error:
                        errors.append(error)
                if errors:
                    raise errors[0]
            finished = outcomes['sync']
            replay, denied = outcomes['replay']['result'], outcomes['denied']['result']
            self.assertNotEqual(finished['backend_pid'], refreshed['backend_pid'])
            self.assertEqual(finished['result']['status'], 200, finished)
            self.assertEqual(finished['result']['body']['code'], 'reconciled')
            self.assertEqual(replay, finished['result'])
            self.assertEqual(denied['status'], 409, denied)
            self.assertEqual(str(denied['body']['code']), 'stale_version')
            row = InspectionRequest.objects.get(pk=data['id'])
            self.assertEqual(row.version, settled_version)
            self.assertEqual(row.sync_status, 'succeeded')
            self.assertEqual(row.mes_completion_status, 'completed')
            self.assertEqual(row.external_result_id, 'SYNTHETIC-RESULT-001')
            self.assertEqual(row.last_error_code, '')
            self.assertEqual(row.audit.filter(action='reconcile_sync').count(), 1)
            self.assertEqual(row.audit.filter(action='sync_unknown').count(), 0)
            operation = row.operations.get(scope=f'{self.editor.pk}:{row.pk}:sync', key=key)
            self.assertEqual(operation.pk, replay['body']['operation_id'])
            self.assertEqual(operation.status, 'succeeded')
            self.assertEqual(operation.response_status, 200)
            self.assertEqual(len(adapter.save_calls), 1)
            repeat = self.call(self.editor.pk, 'post', f'{row.pk}/sync/', payload, key)
            self.assertEqual(repeat, finished['result'])
            self.assertEqual(len(adapter.save_calls), 1)
