from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.utils import timezone
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from production.models import ProductionPlan

from .models import FieldStationChange
from .test_device_api import ROOT, authenticate
from . import test_production_context as context_fixture


CONFIG = ROOT + 'station-config/'
PRESET = {'preset': 'vision_barcode', 'modules': ['vision', 'barcode'], 'language': 'ko'}
BUSINESS_START = context_fixture.BUSINESS_START


class WorkstationConfigTests(TestCase):
    create_station = context_fixture.StationProductionContextTests.create_station
    set_mapping = context_fixture.StationProductionContextTests.set_mapping
    plan = context_fixture.StationProductionContextTests.plan

    def setUp(self):
        users = get_user_model().objects
        admin = users.create_superuser(username='config-owner', password='fixture-only')
        self.viewer = users.create_user(username='config-viewer', password='fixture-only')
        self.management = APIClient()
        authenticate(self.management, admin)
        self.station_url, self.token = self.create_station('context-pc')

    def get_config(self, token=None, path=CONFIG):
        with patch.object(timezone, 'now', return_value=BUSINESS_START):
            return APIClient().get(path, HTTP_AUTHORIZATION='WJField ' + (token or self.token))

    def test_owner_update_and_legacy_fallback(self):
        self.assertIsNone(self.get_config().data['config']['preset'])
        user_client = APIClient()
        authenticate(user_client, self.viewer)
        self.assertEqual(user_client.patch(self.station_url, {'workstation': PRESET}, format='json').status_code, 403)
        updated = self.management.patch(self.station_url, {
            'display_name': 'Test bench', 'production_process': 'injection',
            'injection_machine_number': 4, 'workstation': PRESET,
        }, format='json')
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(self.get_config().data['config'], {
            'display_name': 'Test bench', 'production_process': 'injection',
            'injection_machine_number': 4, 'assembly_line': None,
            'preset': 'vision_barcode', 'modules': ['barcode', 'vision'], 'language': 'ko',
        })
        self.assertEqual(FieldStationChange.objects.latest('pk').changes['workstation']['before'], None)
        self.management.patch(self.station_url, {'workstation': None}, format='json')
        self.assertIsNone(self.get_config().data['config']['preset'])

    def test_invalid_combinations_do_not_replace_valid_configuration(self):
        self.assertEqual(self.management.patch(self.station_url, {'workstation': PRESET}, format='json').status_code, 200)
        for invalid in (
            {'preset': 'weigh'}, {**PRESET, 'modules': ['barcode']}, {**PRESET, 'modules': ['barcode', 'vision', 'vision']},
            {**PRESET, 'language': 'en'}, {**PRESET, 'token': 'never'},
        ):
            with self.subTest(invalid=invalid):
                response = self.management.patch(self.station_url, {'workstation': invalid}, format='json')
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.get_config().data['config']['preset'], 'vision_barcode')

    def test_token_can_read_only_own_station_and_its_business_day_catalog(self):
        self.set_mapping(4)
        self.plan('PAIR-A', model_name='Model X', part_spec='Stand')
        self.plan('PAIR-A', sequence=2, model_name='Model X', part_spec='Different')
        self.plan('PAIR-B', sequence=3, model_name='Model X', product_family_code='S')
        self.plan('OTHER-MACHINE', machine=3)
        _, other_token = self.create_station('other-cabinet', production_process='injection', injection_machine_number=3)
        self.assertEqual(APIClient().get(CONFIG).status_code, 401)
        self.assertEqual(self.get_config(path=CONFIG + '?machine=3').status_code, 400)
        self.assertEqual(self.get_config(token=other_token).data['catalog']['parts'][0]['part_no'], 'OTHER-MACHINE')
        with CaptureQueriesContext(connection) as queries:
            response = self.get_config()
        self.assertEqual(response.status_code, 200)
        self.assertIn('no-store', response.headers['Cache-Control'])
        statements = [query['sql'].lstrip().upper() for query in queries]
        self.assertTrue(statements)
        self.assertTrue(all(sql.startswith('SELECT') or
                            (sql.startswith('DECLARE ') and ' CURSOR ' in sql and ' FOR SELECT ' in sql)
                            for sql in statements), statements)
        self.assertEqual(response.data['station_id'], 'context-pc')
        catalog = response.data['catalog']
        self.assertEqual(catalog['business_date'], BUSINESS_START.date().isoformat())
        self.assertEqual([row['part_no'] for row in catalog['parts']], ['PAIR-A', 'PAIR-B'])
        self.assertEqual(catalog['parts'][0]['model_name'], 'Model X')
        self.assertIsNone(catalog['parts'][0]['part_spec'])
        self.management.patch(self.station_url, {'enabled': False}, format='json')
        self.assertEqual(self.get_config().status_code, 403)

    def test_assembly_station_gets_only_its_line_catalog_and_defaults(self):
        updated = self.management.patch(self.station_url, {
            'production_process': 'assembly', 'assembly_line': 'C', 'workstation': PRESET,
        }, format='json')
        self.assertEqual(updated.status_code, 200, updated.data)
        for line in ('B', 'C'):
            ProductionPlan.objects.create(
                plan_type='machining', plan_date=BUSINESS_START.date(), machine_name=f'{line} LINE',
                part_no=f'FIXTURE-{line}', model_name='DEMO-MODEL', planned_quantity=10,
            )
        payload = self.get_config().data
        self.assertEqual(payload['config']['assembly_line'], 'C')
        self.assertIsNone(payload['config']['injection_machine_number'])
        self.assertEqual([row['part_no'] for row in payload['catalog']['parts']], ['FIXTURE-C'])
