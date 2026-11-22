from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord
from production.models import ProductionPartCavity, ProductionPlan

from .models import FieldEvent, FieldStation, FieldStationChange
from .test_device_api import ROOT, authenticate, device_post


CONTEXT = ROOT + 'production-context/'
BUSINESS_START = datetime(2026, 1, 2, tzinfo=timezone.utc)


class StationProductionContextTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.admin = user_model.objects.create_superuser(username='field-context-admin', password='fixture-only')
        self.viewer = user_model.objects.create_user(username='field-context-viewer', password='fixture-only')
        self.management = APIClient()
        authenticate(self.management, self.admin)
        self.station_url, self.token = self.create_station('context-pc')

    def create_station(self, station_id, **values):
        response = self.management.post(ROOT + 'stations/', {
            'station_id': station_id, 'display_name': 'Synthetic PC', 'apps': ['vision_backcover'], **values,
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        path = ROOT + f'stations/{station_id}/'
        token = self.management.post(path + 'issue-token/').data['token']
        return path, token

    def set_mapping(self, number):
        response = self.management.patch(self.station_url, {'injection_machine_number': number}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['injection_machine_number'], number)

    def context(self, minute, *, token=None, path=CONTEXT):
        now = BUSINESS_START + timedelta(minutes=minute)
        with patch('field_monitoring.production_context.timezone.now', return_value=now):
            return APIClient().get(path, HTTP_AUTHORIZATION='WJField ' + (token or self.token))

    def plan(self, part, *, machine=4, sequence=1, qty=10, day=BUSINESS_START.date(), **metadata):
        metadata.setdefault('model_name', f'Model {part}')
        return ProductionPlan.objects.create(
            plan_date=day, plan_type='injection', machine_name=f'1400T-{machine}',
            part_no=part, planned_quantity=qty, sequence=sequence, **metadata,
        )

    def samples(self, pairs, *, machine=4):
        InjectionMonitoringRecord.objects.bulk_create([
            InjectionMonitoringRecord(machine_name=f'{machine}호기', device_code=f'synthetic-{machine}',
                                      timestamp=BUSINESS_START + timedelta(minutes=minute), capacity=count)
            for minute, count in pairs
        ])

    def test_unmapped_and_mapping_is_admin_only_validated_and_audited(self):
        initial = self.context(3)
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(initial.data, {
            'contract': 'wj.field.v1', 'station_id': 'context-pc', 'status': 'unavailable',
            'part_no': None, 'model_name': None, 'part_spec': None,
            'product_family_code': None, 'product_family_name': None,
            'source': None, 'business_date': '2026-01-02', 'reason': 'station_unmapped',
        })
        other_user = APIClient()
        authenticate(other_user, self.viewer)
        denied = other_user.patch(self.station_url, {'injection_machine_number': 4}, format='json')
        self.assertEqual(denied.status_code, 403)
        for invalid in (-1, 0, 18):
            response = self.management.patch(self.station_url, {'injection_machine_number': invalid}, format='json')
            self.assertEqual(response.status_code, 400)
        self.set_mapping(4)
        change = FieldStationChange.objects.latest('pk')
        self.assertEqual(change.changes, {'injection_machine_number': {'before': None, 'after': 4}})
        with self.assertRaises(IntegrityError), transaction.atomic():
            FieldStation.objects.filter(station_id='context-pc').update(injection_machine_number=18)
        self.set_mapping(None)
        self.assertEqual(self.context(3).data['reason'], 'station_unmapped')

    def test_station_token_scope_and_read_only_request(self):
        self.set_mapping(4)
        self.plan('PART-FOUR', model_name='65', part_spec='2 POLE STAND',
                  product_family_code='STAND', product_family_name='스탠드')
        self.plan('PART-ELEVEN', machine=11, model_name='75')
        self.samples([(-2, 100), (1, 104), (2, 105)])
        self.samples([(-2, 500), (1, 504), (2, 505)], machine=11)
        _, other_token = self.create_station('other-pc', injection_machine_number=11)
        self.assertEqual(APIClient().get(CONTEXT).status_code, 401)
        self.assertEqual(self.management.get(CONTEXT).status_code, 401)
        response = self.context(3, token='invalid')
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers['WWW-Authenticate'], 'WJField')
        self.assertEqual(self.context(3, path=CONTEXT + '?machine_number=11').status_code, 400)
        self.assertEqual(self.context(3, token=other_token).data['part_no'], 'PART-ELEVEN')

        with CaptureQueriesContext(connection) as queries:
            response = self.context(3)
        self.assertEqual(response.data, {
            'contract': 'wj.field.v1', 'station_id': 'context-pc', 'status': 'current',
            'part_no': 'PART-FOUR', 'model_name': '65', 'part_spec': '2 POLE STAND',
            'product_family_code': 'STAND', 'product_family_name': '스탠드', 'source': 'injection_plan_mes_shots',
            'business_date': '2026-01-02', 'reason': None,
        })
        self.assertIn('no-store', response.headers['Cache-Control'])
        self.assertTrue(queries.captured_queries)
        self.assertTrue(all(query['sql'].lstrip().upper().startswith('SELECT') for query in queries))
        self.assertEqual(APIClient().post(CONTEXT, HTTP_AUTHORIZATION='WJField ' + self.token).status_code, 405)
        self.management.patch(self.station_url, {'enabled': False}, format='json')
        self.assertEqual(self.context(3).status_code, 403)
        self.management.patch(self.station_url, {'enabled': True}, format='json')
        self.management.post(self.station_url + 'revoke-token/')
        self.assertEqual(self.context(3).status_code, 401)

    def test_confirmed_part_does_not_require_metadata_or_substitute_spec_for_model(self):
        self.set_mapping(4)
        self.plan('ONE-PART', model_name=None, part_spec=' Part specification ',
                  product_family_code=' ', product_family_name='-')
        self.samples([(-2, 100), (1, 104), (2, 105)])
        response = self.context(3)
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.data['status'], response.data['part_no']), ('current', 'ONE-PART'))
        self.assertIsNone(response.data['model_name'])
        self.assertEqual(response.data['part_spec'], 'Part specification')
        self.assertIsNone(response.data['product_family_code'])
        self.assertIsNone(response.data['product_family_name'])

    def test_shanghai_boundary_rolls_to_a_new_plan_at_0800(self):
        self.set_mapping(4)
        self.plan('PRIOR-DAY', day=BUSINESS_START.date() - timedelta(days=1))
        self.plan('NEW-DAY')
        self.samples([(-5, 100), (-2, 105)])
        old = self.context(-1).data
        self.assertEqual((old['business_date'], old['part_no']), ('2026-01-01', 'PRIOR-DAY'))
        midnight = self.context(0).data
        self.assertEqual((midnight['business_date'], midnight['status']), ('2026-01-02', 'unavailable'))
        self.samples([(2, 107)])
        self.assertEqual(self.context(0).data['reason'], 'machine_data_unavailable')
        self.assertEqual(self.context(3).data['part_no'], 'NEW-DAY')

    def test_allocation_waits_for_stable_restart_and_ignores_other_machine_freshness(self):
        self.set_mapping(4)
        self.plan('OLD', sequence=1, qty=10, product_family_name='Old family')
        self.plan('NEXT', sequence=2, qty=40, product_family_name='New family')
        self.samples([(-2, 100), (1, 120), (2, 130)])
        self.assertEqual(self.context(3).data['part_no'], 'OLD')
        self.samples([(minute, 130) for minute in range(4, 15, 2)])
        self.assertEqual(self.context(15).data['reason'], 'no_verified_current_run')
        self.samples([(16, 131), (18, 133), (20, 135), (22, 137)])
        current = self.context(23).data
        self.assertEqual((current['part_no'], current['product_family_name']), ('NEXT', 'New family'))
        self.samples([(35, 300)], machine=11)
        stale = self.context(36).data
        self.assertEqual((stale['status'], stale['part_no'], stale['reason']),
                         ('unavailable', None, 'machine_data_unavailable'))
        self.assertIsNone(stale['product_family_name'])

    def test_two_simultaneous_cavity_part_numbers_are_ambiguous(self):
        self.set_mapping(4)
        for part, sequence in [('PART-A', 1), ('PART-B', 2)]:
            self.plan(part, sequence=sequence)
            ProductionPartCavity.objects.create(part_no=part, cavity=1, cavity_pattern='2x1',
                                                 parts_per_shot=2, cavity_group='PART-A+PART-B')
        self.samples([(-2, 100), (1, 104), (2, 105)])
        response = self.context(3)
        self.assertEqual((response.data['status'], response.data['part_no'], response.data['reason']),
                         ('unavailable', None, 'ambiguous_current_part'))
        self.assertIsNone(response.data['model_name'])

    def test_comparison_and_acknowledgment_events_use_the_existing_v1_contract(self):
        events = [
            {'seq': seq, 'app': 'vision_backcover', 'type': 'operator.action', 'mode': 'production',
             'result': 'info', 'reason': reason, 'occurred_at': BUSINESS_START.isoformat(),
             'part_no': 'BARCODE-PART', 'detail': {'wj_part_no': 'WJ-PART'}}
            for seq, reason in enumerate(('wj_part_mismatch', 'wj_part_acknowledged'), 1)
        ]
        payload = {'contract': 'wj.field.v1', 'station_id': 'context-pc',
                   'database_id': str(uuid4()), 'batch_id': str(uuid4()), 'events': events}
        response = device_post(APIClient(), 'ingest', payload, self.token)
        self.assertEqual((response.status_code, response.data.get('accepted')), (200, 2), response.data)
        self.assertEqual(list(FieldEvent.objects.order_by('seq').values_list('reason', flat=True)),
                         ['wj_part_mismatch', 'wj_part_acknowledged'])
