from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from .contract import MAX_BODY
from .models import FieldCredential, FieldEvent, FieldIngestBatch, FieldStation, FieldStationChange, FieldStationHeartbeat


ROOT = '/api/field/v1/'
FIXTURES = Path(__file__).resolve().parents[2] / 'docs/field-monitoring/fixtures'
RECEIVED = datetime(2026, 1, 2, 0, 12, tzinfo=timezone.utc)


def fixture(name):
    return json.loads((FIXTURES / f'{name}.json').read_text(encoding='utf-8'))


def authenticate(client, user):
    client.credentials(HTTP_AUTHORIZATION=f'Bearer {AccessToken.for_user(user)}')


def device_post(client, endpoint, payload, token, *, media='application/json', **request_fields):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return client.generic('POST', ROOT + endpoint + '/', body, content_type=media,
                          HTTP_AUTHORIZATION=f'WJField {token}', **request_fields)


def register(client):
    path = ROOT + 'stations/'
    result = client.post(path, {'station_id': 'SYNTH-STATION-01', 'display_name': 'Synthetic PC',
                                'apps': ['weigh_label', 'vision_uv']}, format='json')
    assert result.status_code == 201, result.data
    return path + 'SYNTH-STATION-01/'


class DeviceApiTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.admin = user_model.objects.create_superuser(username='synthetic-admin', password='fixture-only')
        self.viewer = user_model.objects.create_user(username='synthetic-viewer', password='fixture-only')
        self.client = APIClient()
        authenticate(self.client, self.admin)
        self.station_url = register(self.client)
        self.token = self.client.post(self.station_url + 'issue-token/').data['token']

    def post_device(self, endpoint, payload, *, moment=RECEIVED, token=None, **options):
        with patch('field_monitoring.device_views.timezone.now', return_value=moment):
            return device_post(APIClient(), endpoint, payload, self.token if token is None else token, **options)

    def test_shared_protocol_fixtures(self):
        for case in fixture('manifest')['cases']:
            with self.subTest(case=case['name']):
                body = (FIXTURES / case['file']).read_bytes()
                response = self.post_device(case['endpoint'], body)
                expected = case['expected']
                self.assertEqual(response.status_code, expected['status'], response.data)
                if 'code' in expected:
                    self.assertEqual(response.data['code'], expected['code'])
                for key, value in expected.get('ack', {}).items():
                    self.assertEqual(response.data[key], value)
        self.assertEqual(FieldEvent.objects.count(), 2)
        self.assertEqual(FieldStationHeartbeat.objects.count(), 1)

    def test_station_token_hash_rotation_revocation_and_audit(self):
        key, secret = self.token.split('.')
        credential = FieldCredential.objects.get(key_id=key)
        self.assertEqual(credential.secret_hash, hashlib.sha256(secret.encode()).hexdigest())
        self.assertEqual(credential.issued_by, self.admin)
        self.assertNotIn(key, self.client.get(ROOT + 'stations/').content.decode())
        self.assertNotIn(secret, self.client.get(self.station_url, follow=True).content.decode())

        new = self.client.post(self.station_url + 'issue-token/')
        self.assertEqual(new.status_code, 200)
        self.assertIn('no-store', new.headers['Cache-Control'])
        self.assertEqual(self.post_device('ingest', fixture('ingest-valid-weigh')).status_code, 401)
        credential.refresh_from_db()
        self.assertEqual(credential.revoked_by, self.admin)
        self.assertEqual(self.post_device('ingest', fixture('ingest-valid-weigh'),
                                          token=new.data['token']).status_code, 200)
        self.assertEqual(self.client.post(self.station_url + 'revoke-token/').status_code, 204)
        self.assertEqual(self.post_device('heartbeat', fixture('heartbeat-valid'),
                                          token=new.data['token']).status_code, 401)
        self.assertEqual(list(FieldStationChange.objects.order_by('id').values_list('action', flat=True)),
                         ['registered', 'token_issued', 'token_rotated', 'token_revoked'])
        self.assertFalse(FieldStationChange.objects.exclude(actor=self.admin).exists())
        self.assertFalse(FieldCredential.objects.filter(revoked_at__isnull=True).exists())

    def test_station_disabled_wrong_station_and_wrong_secret_denied(self):
        payload = fixture('ingest-valid-weigh')
        other = {**payload, 'station_id': 'SYNTH-OTHER'}
        for candidate, expected in [(other, 403), (payload, 200)]:
            self.assertEqual(self.post_device('ingest', candidate).status_code, expected)
        wrong_secret = self.token.split('.')[0] + '.' + 'A' * 43
        self.assertEqual(self.post_device('ingest', payload, token=wrong_secret).data['code'], 'invalid_token')
        self.assertEqual(self.client.patch(self.station_url, {'enabled': False}, format='json').status_code, 200)
        self.assertEqual(self.post_device('ingest', payload).data['code'], 'station_denied')
        self.assertEqual(self.client.post(self.station_url + 'issue-token/').status_code, 403)
        self.assertEqual(FieldStationChange.objects.latest('pk').changes,
                         {'enabled': {'before': True, 'after': False}})

    def test_jwt_admin_and_device_credentials_are_separate(self):
        payload = fixture('ingest-valid-weigh')
        self.assertEqual(self.client.post(ROOT + 'ingest/', payload, format='json').status_code, 401)
        self.assertEqual(self.client.post(ROOT + 'heartbeat/', fixture('heartbeat-valid'), format='json').status_code, 401)
        session_client = APIClient()
        session_client.force_login(self.admin)
        for client in (APIClient(), session_client):
            response = client.generic('GET', ROOT + 'overview/', HTTP_AUTHORIZATION=f'WJField {self.token}')
            self.assertEqual(response.status_code, 401)
        authenticate(self.client, self.viewer)
        self.assertEqual(self.client.get(ROOT + 'overview/').status_code, 200)
        self.assertEqual(self.client.get(ROOT + 'stations/').status_code, 403)
        self.assertEqual(self.client.post(self.station_url + 'issue-token/').status_code, 403)
        self.assertEqual(self.client.patch(self.station_url, {'enabled': False}, format='json').status_code, 403)
        self.viewer.profile.can_view_injection = False
        self.viewer.profile.save(update_fields=['can_view_injection'])
        self.assertEqual(self.client.get(ROOT + 'events.csv').status_code, 403)
        self.viewer.is_staff = True
        self.viewer.save(update_fields=['is_staff'])
        self.assertEqual(self.client.get(ROOT + 'overview/').status_code, 403)
        self.assertFalse(self.client.get('/api/injection/user/me/').data['can_access_field_monitoring'])

    def test_wire_limits_before_json_and_bad_event_shape(self):
        payload = fixture('ingest-valid-weigh')
        self.assertEqual(self.post_device('ingest', b'!' * (MAX_BODY + 1)).data['code'], 'payload_too_large')
        self.assertEqual(self.post_device('heartbeat', b'!' * (MAX_BODY + 1)).status_code, 413)
        self.assertEqual(self.post_device('ingest', payload, media='text/plain').status_code, 415)
        self.assertEqual(self.post_device('ingest', payload, HTTP_CONTENT_ENCODING='gzip').status_code, 415)
        self.assertEqual(self.post_device('ingest', b'{"events":[],"events":[]}').status_code, 400)
        self.assertEqual(self.post_device('ingest', b'{"events":NaN}').status_code, 400)
        self.assertEqual(self.post_device('ingest', b'{"event":"\\ud800"}').status_code, 400)
        event = payload['events'][0]
        self.assertEqual(self.post_device('ingest', {**payload, 'events': [event] * 201}).status_code, 400)
        response = self.post_device('ingest', {**payload, 'events': [{**event, 'detail': {'blob': '가' * 700}}]})
        self.assertEqual((response.status_code, response.data.get('event_index')), (400, 0))
        self.assertEqual(self.post_device('ingest', {**payload, 'events': [{**event, 'barcode': '중' * 86}]}).status_code, 400)
        self.assertEqual(self.post_device('ingest', {**payload, 'events': [{**event, 'ref': {}}]}).status_code, 400)
        self.assertFalse(FieldEvent.objects.exists())

    def test_delivery_replay_duplicate_conflict_and_atomic_rejection(self):
        payload = fixture('ingest-valid-weigh')
        first = self.post_device('ingest', payload)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.post_device('ingest', payload).data, first.data)
        self.assertEqual(self.post_device('ingest', json.dumps(payload, indent=2).encode()).data['code'], 'batch_conflict')

        duplicate = self.post_device('ingest', {**payload, 'batch_id': str(uuid4())})
        self.assertEqual((duplicate.data['accepted'], duplicate.data['duplicates']), (0, 1))
        event = payload['events'][0]
        conflict = {**payload, 'batch_id': str(uuid4()), 'events': [
            {**event, 'seq': event['seq'] - 1}, {**event, 'result': 'error'},
        ]}
        self.assertEqual(self.post_device('ingest', conflict).data, {'code': 'event_conflict', 'event_index': 1})
        self.assertEqual(FieldEvent.objects.count(), 1)
        self.assertEqual(FieldIngestBatch.objects.count(), 2)

    def test_clock_offset_warns_without_hiding_regular_events(self):
        heartbeat = fixture('heartbeat-valid')
        heartbeat['client_at'] = (RECEIVED + timedelta(minutes=6)).isoformat()
        self.assertEqual(self.post_device('heartbeat', heartbeat).status_code, 200)
        payload = fixture('ingest-valid-weigh')
        template = payload['events'][0]
        payload['events'] = [
            {**template, 'seq': 1, 'occurred_at': '2026-01-02T07:59:59+08:00', 'mode': 'production'},
            {**template, 'seq': 2, 'occurred_at': '2026-01-02T08:00:00+08:00', 'mode': 'production'},
            {**template, 'seq': 3, 'occurred_at': '2026-01-02T08:17:01+08:00', 'mode': 'production'},
        ]
        self.assertEqual(self.post_device('ingest', payload).status_code, 200)
        records = list(FieldEvent.objects.order_by('seq'))
        self.assertEqual([str(row.business_date) for row in records], ['2026-01-01', '2026-01-02', '2026-01-02'])
        self.assertEqual([row.clock_suspect for row in records], [False, False, True])
        self.assertEqual([row.clock_offset_seconds for row in records], [360, 360, 360])
        self.assertEqual(records[2].payload['occurred_at'], '2026-01-02T08:17:01+08:00')
        overview = self.client.get(ROOT + 'overview/', {'business_date': '2026-01-02'}).data
        self.assertEqual(overview['stations'][0]['production_counts']['ok'], 1)
        self.assertIn('clock_offset', overview['stations'][0]['warnings'])
        self.assertEqual(len(self.client.get(ROOT + 'events/', {'from': '2026-01-02',
                                                               'to': '2026-01-02'}).data['results']), 2)

        heartbeat['client_at'] = (RECEIVED - timedelta(minutes=61)).isoformat()
        self.assertEqual(self.post_device('heartbeat', heartbeat).status_code, 200)
        self.assertEqual(self.post_device('ingest', {**payload, 'batch_id': str(uuid4()), 'events': [
            {**template, 'seq': 4},
        ]}).status_code, 200)
        held = FieldEvent.objects.get(seq=4)
        self.assertEqual(held.clock_offset_seconds, -3660)
        self.assertTrue(held.clock_suspect)
        self.assertFalse(FieldEvent.objects.get(seq=2).clock_suspect)

    def test_heartbeat_receipt_order_and_alternating_sender(self):
        first = fixture('heartbeat-valid')
        second = {**first, 'session_id': str(uuid4()), 'heartbeat_id': str(uuid4()), 'heartbeat_seq': 15}
        self.assertEqual(self.post_device('heartbeat', first).status_code, 200)
        self.assertEqual(self.post_device('heartbeat', second, moment=RECEIVED + timedelta(minutes=1)).status_code, 200)
        same_session_lower_seq = {**second, 'heartbeat_seq': 1}
        now = RECEIVED + timedelta(minutes=2)
        self.assertTrue(self.post_device('heartbeat', same_session_lower_seq, moment=now).data['current'])
        self.assertEqual(FieldStationHeartbeat.objects.get().payload['heartbeat_seq'], 1)
        self.assertIsNone(FieldStationHeartbeat.objects.get().duplicate_sender_until)
        self.assertFalse(self.post_device('heartbeat', first, moment=RECEIVED).data['current'])
        self.assertEqual(FieldStationHeartbeat.objects.get().received_at, now)

        now = RECEIVED + timedelta(minutes=3)
        self.assertTrue(self.post_device('heartbeat', first, moment=now).data['current'])
        self.assertEqual(FieldStationHeartbeat.objects.get().duplicate_sender_until, now + timedelta(minutes=10))
        self.assertEqual(FieldStationHeartbeat.objects.get().payload['session_id'], first['session_id'])


class ConcurrentDeliveryTests(TransactionTestCase):
    def test_competing_batches_replay_without_duplicate_events(self):
        if connection.vendor != 'postgresql':
            self.skipTest('PostgreSQL row-lock behavior')
        admin = get_user_model().objects.create_superuser(username='synthetic-admin', password='fixture-only')
        client = APIClient()
        authenticate(client, admin)
        station_url = register(client)
        token = client.post(station_url + 'issue-token/').data['token']
        first = fixture('ingest-valid-weigh')
        second = deepcopy(first)
        second['batch_id'] = str(uuid4())
        barrier = Barrier(3)

        def submit(payload):
            close_old_connections()
            try:
                barrier.wait(timeout=8)
                response = device_post(APIClient(), 'ingest', payload, token)
                return response.status_code, response.data
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=3) as executor:
            response_a, replay, response_b = executor.map(submit, [first, first, second])
        self.assertEqual(response_a, replay)
        self.assertEqual([response_a[0], response_b[0]], [200, 200])
        self.assertEqual(sorted([response_a[1]['accepted'], response_b[1]['accepted']]), [0, 1])
        self.assertEqual(FieldEvent.objects.count(), 1)
        self.assertEqual(FieldIngestBatch.objects.count(), 2)
