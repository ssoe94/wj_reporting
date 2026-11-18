from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from .issuer_rules import grant_summaries, label_date_code, policy_digest
from .issuer_views import SHANGHAI
from .models import FieldEvent, FieldLabelIssuer, FieldStation, FieldStationHeartbeat
from .test_device_api import ROOT, authenticate, device_post, fixture, register

REGISTER = ROOT + 'issuer-assignments/'
PART = 'SYNTH-P1'
NS = 'SYN'
OLD = 'SYNTH-STATION-01'
NEW = 'SYNTH-STATION-02'


def assignment(station=OLD, **extra):
    return {'namespace': NS, 'part_no': PART, 'station_id': station,
            'program': 'weigh_label' if station else 'Synthetic External',
            'pc_note': '' if station else 'Synthetic PC', 'reason': 'Synthetic evidence', **extra}


class IssuerRegistryTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(username='synthetic-issuer-admin')
        self.viewer = get_user_model().objects.create_user(username='synthetic-issuer-viewer')
        self.client = APIClient()
        authenticate(self.client, self.admin)
        self.old_url = register(self.client)
        self.token = self.client.post(self.old_url + 'issue-token/').data['token']
        self.client.post(ROOT + 'stations/', {'station_id': NEW, 'display_name': 'Synthetic new PC',
                                             'apps': ['weigh_label']}, format='json')
        self.day = timezone.now().astimezone(SHANGHAI).date()
        self.database = str(uuid4())

    def create_issuer(self, station=OLD, **extra):
        result = self.client.post(REGISTER, assignment(station, **extra), format='json')
        self.assertEqual(result.status_code, 201, result.data)
        return result.data['id']

    def action(self, row, step, **extra):
        return self.client.post(f'{REGISTER}{row}/{step}/', {'reason': 'Verified synthetic transition', **extra},
                                format='json')

    def policy(self, location=None):
        return self.client.get((location or self.old_url) + 'issuer-policy/').data

    def write_heartbeat(self, policy, sequence, *, pending=0, **extra):
        payload = fixture('heartbeat-valid')
        payload.update(station_id=OLD, database_id=self.database, heartbeat_id=str(uuid4()),
                       client_at=timezone.now().astimezone(SHANGHAI).isoformat(timespec='milliseconds'))
        payload['outbox'].update(pending_count=pending, state='ready')
        payload['issuer_policy'] = {'revision': policy['revision'], 'sha256': policy_digest(policy),
                                    'applied_seq': sequence, 'grants': grant_summaries(policy), **extra}
        return device_post(APIClient(), 'heartbeat', payload, self.token)

    def ingest(self, events):
        moment = timezone.now().astimezone(SHANGHAI).isoformat(timespec='milliseconds')
        payload = {'contract': 'wj.field.v1', 'station_id': OLD, 'database_id': self.database,
                   'batch_id': str(uuid4()), 'events': [
            {'app': 'weigh_label', 'occurred_at': moment, 'result': 'info', 'mode': 'unknown', **event}
            for event in events
        ]}
        response = device_post(APIClient(), 'ingest', payload, self.token)
        self.assertEqual(response.status_code, 200, response.data)

    def test_registry_and_policy_are_superuser_only(self):
        row = self.create_issuer()
        for user in (self.viewer, None):
            client = APIClient()
            if user:
                authenticate(client, user)
            expected = 403 if user else 401
            self.assertEqual(client.get(REGISTER).status_code, expected)
            self.assertEqual(client.post(REGISTER, assignment(NEW), format='json').status_code, expected)
            self.assertEqual(client.post(f'{REGISTER}{row}/stop/', {'reason': 'Denied'}, format='json').status_code, expected)
            self.assertEqual(client.post(f'{REGISTER}{row}/release/', {}, format='json').status_code, expected)
            self.assertEqual(client.get(self.old_url + 'issuer-policy/').status_code, expected)

    def test_external_unique_scope_and_history_has_server_actors(self):
        old = self.create_issuer(None)
        self.assertEqual(self.client.post(REGISTER, assignment(NEW), format='json').status_code, 409)
        self.create_issuer(None, namespace='EXT')
        self.assertEqual(self.action(old, 'release', ceilings=[{'print_date': str(self.day), 'serial_floor': 8}]).data['code'],
                         'issuer_stop_required')
        self.assertEqual(self.action(old, 'stop').status_code, 200)
        self.assertEqual(self.client.post(REGISTER, assignment(), format='json').status_code, 409)
        self.assertEqual(self.action(old, 'release', ceilings=[{'print_date': str(self.day), 'serial_floor': 8}]).status_code, 200)
        new = self.create_issuer()
        self.assertEqual(FieldLabelIssuer.objects.get(pk=new).predecessor_id, old)
        audit = FieldLabelIssuer.objects.get(pk=old)
        self.assertEqual((audit.assigned_by_id, audit.stopped_by_id, audit.released_by_id), (self.admin.pk,) * 3)
        self.assertEqual(self.policy()['grants'][0]['transfer'],
                         {'previous_id': old, 'ceilings': [{'print_date': str(self.day), 'serial_floor': 8}]})

    def test_handoff_requires_current_withdrawal_heartbeat_drained_queue_and_verified_floor(self):
        row = self.create_issuer()
        original = self.policy()
        self.assertEqual(self.action(row, 'stop').status_code, 200)
        policy = self.policy()
        self.assertEqual(policy['grants'], [])
        self.assertGreater(policy['revision'], original['revision'])
        last = [{'print_date': str(self.day), 'serial_floor': 25}]
        self.assertEqual(self.write_heartbeat(original, 1).status_code, 200)
        self.assertEqual(self.action(row, 'release', ceilings=last).data['code'], 'issuer_heartbeat_required')
        self.assertEqual(self.write_heartbeat(policy, 2, pending=1).status_code, 200)
        self.assertEqual(self.action(row, 'release', ceilings=last).data['code'], 'issuer_work_pending')
        self.assertEqual(self.write_heartbeat(policy, 2).status_code, 200)
        self.assertEqual(self.action(row, 'release', ceilings=last).data['code'], 'issuer_heartbeat_required')
        self.ingest([
            {'seq': 1, 'type': 'label.reserved', 'reason': 'label_reserved', 'part_no': PART,
             'barcode': PART + NS + label_date_code(self.day) + '000R', 'serial': '000R',
             'detail': {'print_date': str(self.day)}},
            {'seq': 2, 'type': 'operator.action', 'reason': 'issuer_policy_applied', 'config_version': policy_digest(policy),
             'detail': {'revision': policy['revision'], 'sha256': policy_digest(policy)}},
        ])
        indexed = FieldEvent.objects.get(seq=1)
        self.assertEqual((indexed.issuer_namespace, indexed.label_print_date), (NS, self.day))
        rejected = self.action(row, 'release', ceilings=[{'print_date': str(self.day), 'serial_floor': 24}])
        self.assertEqual(rejected.data, {'code': 'issuer_ceiling_required', 'minimums': last})
        saved = self.action(row, 'release', ceilings=last)
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(FieldLabelIssuer.objects.get(pk=row).release_proof['seq'], 2)
        self.create_issuer(NEW)
        inherited = self.policy(ROOT + 'stations/' + NEW + '/')['grants'][0]['transfer']
        self.assertEqual(inherited['ceilings'], last)
        self.assertEqual(inherited['previous_id'], row)

    def test_heartbeat_mismatch_has_station_warning_and_exception_until_exact(self):
        self.create_issuer()
        policy = self.policy()
        url = ROOT + f'overview/?station={OLD}'
        self.assertEqual(self.client.get(url).data['stations'][0]['warnings'], ['issuer_policy_mismatch'])
        self.assertEqual(self.write_heartbeat(policy, 1, grants=[]).status_code, 200)
        self.assertIn('issuer_policy_mismatch', self.client.get(ROOT + f'exceptions/?station={OLD}').data['exceptions'][0]['reason'])
        self.assertEqual(self.write_heartbeat(policy, 1).status_code, 200)
        self.assertNotIn('issuer_policy_mismatch', self.client.get(url).data['stations'][0]['warnings'])
        self.assertEqual(self.write_heartbeat(policy, 1, applied_seq=0).status_code, 400)

    def test_partial_constraint_rejects_second_open_row_directly(self):
        self.create_issuer()
        with self.assertRaises(IntegrityError), transaction.atomic():
            FieldLabelIssuer.objects.create(namespace=NS, part_no=PART, program='Synth', reason='Synthetic',
                                            assigned_by=self.admin, assigned_at=timezone.now())


class IssuerConcurrentTests(TransactionTestCase):
    def test_first_assignment_race_has_one_winner_postgres(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL transaction and advisory lock semantics')
        user = get_user_model().objects.create_superuser(username='synthetic-race-issuer')
        for name in (OLD, NEW):
            FieldStation.objects.create(station_id=name, display_name=name, apps=['weigh_label'], created_by=user)
        gate = Barrier(2)

        def assign(name):
            close_old_connections()
            try:
                client = APIClient()
                authenticate(client, user)
                gate.wait(timeout=5)
                return client.post(REGISTER, assignment(name), format='json').status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(assign, (OLD, NEW)))
        self.assertEqual(sorted(statuses), [201, 409])
        self.assertEqual(FieldLabelIssuer.objects.filter(released_at__isnull=True).count(), 1)
        self.assertEqual(sum(FieldStation.objects.values_list('issuer_policy_revision', flat=True)), 1)
