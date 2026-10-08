"""Real PG reservation races; synthetic rows only, no writers/MES/credentials."""
from datetime import timedelta
from queue import Queue
from threading import Barrier, Thread
from unittest import skipUnless
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.db import connection, connections
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from mes_oauth.session_guard import InspectionSession
from quality.inspection_models import InspectionOperation
from quality.inspection_workflow import InspectionConflict
from .mes_delivery import ProductionDeliveryCoordinator, ProductionDeliveryIntent, ReviewedDeliveryScope, _sha
from .mes_execution_contract import build_work_order_create
from .test_mes_delivery import synthetic_login_lock
from .test_mes_execution_contract import enums, work_order_approval, work_order_payload


@skipUnless(connection.vendor == 'postgresql', 'Real isolated PostgreSQL required; SQLite cannot verify advisory locks.')
@override_settings(INSPECTION_PILOT_USER_IDS=[])
class ProductionDeliveryPostgresTests(TransactionTestCase):
    def setUp(self):
        self.users = [get_user_model().objects.create_user(username=f'SYNTHETIC-PG-delivery-{i}', is_superuser=True)
                      for i in range(2)]
        approval = work_order_approval()
        self.payload = build_work_order_create(work_order_payload(), approval=approval, enums=enums())
        self.intent = ProductionDeliveryIntent('SYNTHETIC-PG-tenant', approval.code, 101, 102,
            approval.quantity.unit_id, approval.quantity.precision, approval.quantity.amount, 104, 105, 106, 107)
        login = patch.object(InspectionSession, 'lock', new=synthetic_login_lock)
        login.start(); self.addCleanup(login.stop)
        network = patch('socket.socket.connect', side_effect=AssertionError('No MES network allowed.'))
        network.start(); self.addCleanup(network.stop)

    def reserve(self, actor_id, key):
        scope = ReviewedDeliveryScope(self.intent, actor_id, 108, 'SYNTHETIC-PG-review', 'a' * 64,
            timezone.now() + timedelta(minutes=30), (('work_order_create', _sha(self.payload)),))
        session = InspectionSession(actor_id, 'SYNTHETIC-PG-login', timezone.now() + timedelta(hours=1), {})
        coordinator = ProductionDeliveryCoordinator(scope, session=session)
        try:
            row, created = coordinator._reservation('work_order_create', key, self.payload)
            result = {'operation_id': row.pk, 'created': created, 'actor_id': actor_id}
        except InspectionConflict as exc:
            result = {'conflict': str(exc.detail['code']), 'actor_id': actor_id}
        # Runs after _guard commits/rolls back on this independent connection.
        result['visible_pending'] = InspectionOperation.objects.filter(
            scope=self.intent.workflow_scope + ':work_order_create', status='pending').count()
        return result

    def parallel(self, calls):
        barrier, outcomes = Barrier(2), Queue(maxsize=2)
        def run(actor_id, key):
            connections.close_all()
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SET statement_timeout = '10000ms'")
                    cursor.execute("SET lock_timeout = '5000ms'")
                    cursor.execute('SELECT pg_backend_pid()')
                    pid = cursor.fetchone()[0]
                barrier.wait(timeout=10)
                outcomes.put({'pid': pid, 'result': self.reserve(actor_id, key)})
            except Exception as exc:
                outcomes.put({'error': exc})
            finally:
                connections.close_all()
        workers = [Thread(target=run, args=call, daemon=True, name='SYNTHETIC-PG-delivery') for call in calls]
        for worker in workers: worker.start()
        for worker in workers: worker.join(timeout=15)
        self.assertFalse(any(worker.is_alive() for worker in workers), 'Bounded PG fixture worker timed out.')
        self.assertEqual(outcomes.qsize(), 2)
        values = [outcomes.get_nowait() for _ in calls]
        for value in values:
            if 'error' in value: raise value['error']
        self.assertEqual(len({value['pid'] for value in values}), 2, 'Must use independent real PostgreSQL sessions.')
        return [value['result'] for value in values]

    def assert_one_committed_pending(self, results):
        self.assertEqual(InspectionOperation.objects.count(), 1)
        row = InspectionOperation.objects.get()
        self.assertEqual(row.status, 'pending')
        self.assertIsNone(row.request_id)
        self.assertEqual(row.payload_digest, _sha(self.payload))
        self.assertEqual(row.scope, self.intent.workflow_scope + ':work_order_create')
        self.assertIs(row.response['dispatched'], False)
        self.assertEqual([result['visible_pending'] for result in results], [1, 1])
        return row

    def test_same_physical_work_order_different_actors_and_keys_has_one_reservation(self):
        results = self.parallel([(user.pk, uuid.uuid4()) for user in self.users])
        winners = [result for result in results if result.get('created') is True]
        losers = [result for result in results if 'conflict' in result]
        self.assertEqual((len(winners), len(losers)), (1, 1))
        self.assertEqual(losers[0]['conflict'], 'production_reconciliation_required')
        row = self.assert_one_committed_pending(results)
        self.assertEqual(row.response['actor_id'], winners[0]['actor_id'])

    def test_same_key_concurrent_creator_returns_one_committed_operation(self):
        actor_id, key = self.users[0].pk, uuid.uuid4()
        results = self.parallel([(actor_id, key), (actor_id, key)])
        self.assertEqual(sorted(result['created'] for result in results), [False, True])
        self.assertEqual(len({result['operation_id'] for result in results}), 1)
        row = self.assert_one_committed_pending(results)
        self.assertEqual(row.key, key)
