from datetime import date, datetime, timezone
from io import StringIO
import json
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid4, uuid5

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import TestCase, SimpleTestCase
from rest_framework.test import APIClient

from .issuer_rules import label_date_code
from .issuer_views import _compact_floors, _verified_ceilings
from .models import FieldArchiveEvent, FieldEvent, FieldIngestBatch, FieldIssuerRetainedFloor, FieldLabelIssuer
from .retention import history_cutoff
from .test_device_api import authenticate, device_post, fixture, register


NOW = datetime(2026, 11, 21, 0, 0, tzinfo=timezone.utc)
EARLIER = datetime(2024, 11, 21, 0, 0, tzinfo=timezone.utc)
EXPIRED = '2024-11-21T07:59:59+08:00'
BOUNDARY = '2024-11-21T08:00:00+08:00'


class RetentionCalendarTests(SimpleTestCase):
    def test_shanghai_boundary_and_leap_day(self):
        before = datetime(2024, 2, 28, 23, 59, 59, tzinfo=timezone.utc)
        leap = datetime(2024, 2, 29, 0, 0, tzinfo=timezone.utc)
        after = datetime(2024, 3, 1, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(history_cutoff(before), date(2022, 2, 28))
        self.assertEqual(history_cutoff(leap), date(2022, 2, 28))
        self.assertEqual(history_cutoff(after), date(2022, 3, 1))


class RetentionTests(TestCase):
    def setUp(self):
        admin = get_user_model().objects.create_superuser(username='retention-synthetic')
        client = APIClient()
        authenticate(client, admin)
        self.token = client.post(register(client) + 'issue-token/').data['token']
        self.admin = admin
        self.template = fixture('ingest-valid-weigh')

    def batch(self, *events, archive=False):
        payload = dict(self.template, batch_id=str(uuid4()), events=list(events))
        if archive:
            payload['database_id'] = str(uuid5(NAMESPACE_URL, 'synthetic-retention-archive'))
            payload['events'] = [
                dict(event, mode='unknown', archive_source='weigh_print',
                     ref={'source_key': f'retention-synthetic-{event["seq"]}'})
                for event in events
            ]
        return payload

    def event(self, seq, occurred_at=EXPIRED, **extra):
        return dict(self.template['events'][0], seq=seq, occurred_at=occurred_at, **extra)

    def send(self, payload, *, archive=False, at=NOW):
        with patch('field_monitoring.device_views.timezone.now', return_value=at):
            endpoint = 'archive-ingest' if archive else 'ingest'
            return device_post(APIClient(), endpoint, payload, self.token)

    def prune(self, *args):
        stream = StringIO()
        with patch('field_monitoring.management.commands.prune_field_history.timezone.now', return_value=NOW):
            call_command('prune_field_history', *args, stdout=stream)
        return json.loads(stream.getvalue())

    def test_bound_is_shared_and_receipt_replay_survives(self):
        live = self.batch(self.event(1), self.event(2, BOUNDARY))
        archived = self.batch(self.event(1), self.event(2, BOUNDARY), archive=True)
        old_ack = self.send(live, at=EARLIER).data
        self.assertEqual(old_ack['accepted'], 2)
        self.assertEqual(self.send(archived, archive=True, at=EARLIER).data['accepted'], 2)
        before = self.prune('--limit', '1')
        self.assertEqual(before['cutoff_business_date'], '2024-11-21')
        self.assertTrue(before['dry_run'])
        self.assertTrue(before['more_eligible'])
        self.assertEqual(sum(before['selected'].values()), 1)
        self.assertEqual(sum(before['deleted'].values()), 0)
        self.assertEqual(FieldEvent.objects.count() + FieldArchiveEvent.objects.count(), 4)
        self.assertFalse(FieldIssuerRetainedFloor.objects.exists())

        first = self.prune('--apply', '--limit', '1')
        self.assertTrue(first['more_eligible'])
        self.assertEqual(sum(first['deleted'].values()), 1)
        second = self.prune('--apply', '--limit', '1')
        self.assertFalse(second['more_eligible'])
        self.assertEqual(sum(second['deleted'].values()), 1)
        self.assertEqual(FieldEvent.objects.get().seq, 2)
        self.assertEqual(FieldArchiveEvent.objects.get().seq, 2)
        self.assertEqual(FieldIngestBatch.objects.count(), 2)
        self.assertEqual(self.send(live).data, old_ack)
        conflict = self.send(dict(live, events=live['events'][:1]))
        self.assertEqual(conflict.data['code'], 'batch_conflict')
        self.assertEqual(sum(self.prune('--apply')['deleted'].values()), 0)
        with self.assertRaises(CommandError):
            self.prune('--apply', '--limit', '5001')

    def test_late_batches_acknowledge_expiry_and_keep_boundary_rows(self):
        for model, archive in ((FieldEvent, False), (FieldArchiveEvent, True)):
            with self.subTest(archive=archive):
                payload = self.batch(self.event(1), self.event(2, BOUNDARY), archive=archive)
                ack = self.send(payload, archive=archive).data
                self.assertEqual((ack['accepted'], ack['duplicates'], ack['expired'], ack['max_seq']), (1, 1, 1, 2))
                self.assertEqual(self.send(payload, archive=archive).data, ack)
                rebatch = dict(payload, batch_id=str(uuid4()))
                repeated = self.send(rebatch, archive=archive).data
                self.assertEqual((repeated['accepted'], repeated['duplicates'], repeated['expired']), (0, 2, 1))
                self.assertEqual(model.objects.get().seq, 2)

    def reservation(self, seq, day, serial, *, occurred_at=EXPIRED):
        date_code = label_date_code(day)
        return {
            'seq': seq, 'app': 'weigh_label', 'type': 'label.reserved', 'mode': 'production', 'result': 'info',
            'reason': 'label_reserved', 'occurred_at': occurred_at,
            'app_version': '1.0.0', 'agent_version': '1.0.0', 'config_version': 'synthetic',
            'part_no': 'SYNTH-PART', 'serial': serial, 'barcode': f'SYNTH-PARTSYN{date_code}{serial}',
            'ref': {'job_id': f'synthetic-retention-job-{seq}'},
            'detail': {'quantity': 1, 'print_date': day.isoformat(), 'issuer_namespace': 'SYN'},
        }

    def test_pruning_preserves_issuer_ceiling_across_reused_date_codes(self):
        first = date(2014, 11, 20)
        second = date(2024, 11, 20)
        records = self.batch(self.reservation(1, first, '000Z'), self.reservation(2, second, '0008'))
        self.assertEqual(self.send(records, at=EARLIER).data['accepted'], 2)
        issuer = FieldLabelIssuer(station_id=FieldEvent.objects.first().station_id,
                                 namespace='SYN', part_no='SYNTH-PART')
        expect = {first.isoformat(): 33}
        self.assertEqual(_compact_floors(_verified_ceilings(issuer)), expect)
        self.assertEqual(self.prune('--apply')['deleted']['live'], 2)
        self.assertEqual(_compact_floors(_verified_ceilings(issuer)), expect)
        self.assertEqual(FieldIssuerRetainedFloor.objects.count(), 1)

        late = self.batch(self.reservation(3, second, '0010'))
        self.assertEqual(self.send(late).data['expired'], 1)
        self.assertEqual(_compact_floors(_verified_ceilings(issuer)), {second.isoformat(): 34})
        self.assertEqual(FieldIssuerRetainedFloor.objects.count(), 1)
        self.assertFalse(FieldEvent.objects.exists())
