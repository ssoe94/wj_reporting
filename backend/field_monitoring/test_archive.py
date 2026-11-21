from datetime import datetime, timezone
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid4, uuid5

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .event_payload import wire_payload
from .models import FieldArchiveEvent, FieldEvent, FieldIngestBatch, FieldStationHeartbeat
from .test_device_api import ROOT, authenticate, device_post, fixture, register


class ArchiveApiTests(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        clock = patch('field_monitoring.device_views.timezone.now',
                      return_value=datetime(2026, 11, 21, tzinfo=timezone.utc))
        clock.start()
        cls.addClassCleanup(clock.stop)

    def setUp(self):
        self.client = APIClient()
        admin = get_user_model().objects.create_superuser(username='archive-synthetic', password='synthetic-only')
        authenticate(self.client, admin)
        self.token = self.client.post(register(self.client) + 'issue-token/').data['token']
        payload = fixture('ingest-valid-weigh')
        payload['database_id'] = str(uuid5(NAMESPACE_URL, 'synthetic-archive'))
        event = payload['events'][0]
        event.update(mode='unknown', archive_source='weigh_print', occurred_at='2025-09-10T07:00:00+08:00')
        event['ref']['source_key'] = 'synthetic-archive-1'
        self.payload = payload

    def send(self, payload, route='archive-ingest'):
        return device_post(APIClient(), route, payload, self.token)

    def test_preserves_old_rows_and_provenance_in_archive_only(self):
        check = {key: self.payload[key] for key in ('contract', 'database_id', 'station_id')}
        preflight = self.send(dict(check, archive_capability=True))
        self.assertEqual(preflight.data, dict(check, archive_capability=1))
        self.assertEqual(FieldIngestBatch.objects.count(), 0)
        self.assertEqual(self.send(self.payload, 'ingest').status_code, 400)
        response = self.send(self.payload)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['accepted'], 1)
        self.assertEqual(self.send(self.payload).data, response.data)
        different_batch = dict(self.payload, batch_id=str(uuid4()))
        self.assertEqual(self.send(different_batch).data['duplicates'], 1)
        record = FieldArchiveEvent.objects.get()
        self.assertEqual(wire_payload(record), self.payload['events'][0])
        self.assertNotIn('part_no', record.payload)
        self.assertEqual(record.business_date.isoformat(), '2025-09-09')
        self.assertEqual(FieldEvent.objects.count(), 0)
        self.assertEqual(FieldStationHeartbeat.objects.count(), 0)
        day = {'from': '2025-09-09', 'to': '2025-09-09'}
        self.assertEqual(self.client.get(ROOT + 'events/', day).data['results'], [])
        self.assertEqual(self.client.get(ROOT + 'events/', dict(day, archive='true')).data['results'][0]['reason'],
                         'weight_within_limit')
        self.assertIn(b'weight_within_limit', self.client.get(ROOT + 'events.csv', dict(day, archive='true')).content)
        self.assertEqual(self.client.get(ROOT + 'exceptions/', {'business_date': day['from']}).data['exceptions'], [])
        overview = self.client.get(ROOT + 'overview/', {'business_date': day['from']}).data
        self.assertEqual(overview['stations'][0]['non_production_count'], 0)

    def test_two_hundred_events_and_malformed_archive_rejected(self):
        base = self.payload['events'][0]
        events = [dict(base, seq=index, ref=dict(base['ref'], source_key=f'synthetic-archive-{index}'))
                  for index in range(1, 201)]
        oversized = dict(self.payload, events=events + [dict(base, seq=201)])
        self.assertEqual(self.send(oversized).status_code, 400)
        self.assertEqual(self.send(dict(self.payload, database_id=str(uuid4()))).status_code, 400)
        forbidden = dict(base, mode='production')
        self.assertEqual(self.send(dict(self.payload, events=[forbidden])).status_code, 400)
        self.assertEqual(self.send(dict(self.payload, events=[dict(base, archive_source='invalid')])).status_code, 400)
        self.assertEqual(self.send(dict(self.payload, events=events)).data['accepted'], 200)
        self.assertEqual(FieldArchiveEvent.objects.count(), 200)
        self.assertEqual(FieldEvent.objects.count(), 0)

    def test_duplicate_historical_issuers_do_not_run_operational_alerts(self):
        other = self.client.post(ROOT + 'stations/', {'station_id': 'SYNTH-STATION-02', 'display_name': 'Second fixture',
                                                       'apps': ['weigh_label']}, format='json')
        self.assertEqual(other.status_code, 201)
        token = self.client.post(ROOT + 'stations/SYNTH-STATION-02/issue-token/').data['token']
        day = '2025-09-10'
        reservation = {
            'seq': 1, 'app': 'weigh_label', 'type': 'label.reserved', 'status_raw': 'prepared',
            'mode': 'unknown', 'result': 'info', 'reason': 'label_reserved', 'barcode': 'SYNTH-PARTSYN59A0001',
            'occurred_at': day + 'T08:10:00+08:00', 'serial': '0001', 'part_no': 'SYNTH-PART',
            'archive_source': 'weigh_print', 'ref': {'source_key': 'synthetic-archive-reservation'},
            'detail': {'quantity': 1, 'print_date': day, 'issuer_namespace': 'SYN'},
        }
        self.assertEqual(self.send(dict(self.payload, events=[reservation])).data['accepted'], 1)
        second = dict(self.payload, batch_id=str(uuid4()), station_id='SYNTH-STATION-02', events=[reservation])
        self.assertEqual(device_post(APIClient(), 'archive-ingest', second, token).data['accepted'], 1)
        values = self.client.get(ROOT + 'events/', {'archive': 'true', 'from': day, 'to': day}).data['results']
        self.assertEqual(len(values), 2)
        self.assertEqual(self.client.get(ROOT + 'exceptions/', {'business_date': day}).data['exceptions'], [])
        self.assertEqual(FieldEvent.objects.count(), 0)
