"""Freeze the JSON emitted by the matrix and parts endpoints before their queries change."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models import F, Value
from django.test import TestCase
from rest_framework.renderers import JSONRenderer
from rest_framework.test import APIClient

from assembly import models as assembly_models
from assembly.models import AssemblyReport

from . import views
from .models import InjectionMonitoringRecord, InjectionMonitoringRollup, InjectionReport, PartSpec


FIXTURE_DIR = Path(__file__).with_name('fixtures')
SHANGHAI = timezone(timedelta(hours=8))
START = datetime(2026, 11, 1, 8, tzinfo=SHANGHAI)
NOW = START + timedelta(days=3, hours=3)
TELEMETRY = {'oil_temperature_matrix', 'power_kwh_matrix', 'power_usage_matrix'}


class GoldenResponses(TestCase):
    def assert_golden(self, fixture, case, response, *, board=False):
        self.assertEqual(response.status_code, 200)
        expected = json.loads((FIXTURE_DIR / fixture).read_text(encoding='utf-8'))[case]
        if board:
            expected = {key: value for key, value in expected.items() if key not in TELEMETRY}
        self.assertEqual(response.content, JSONRenderer().render(expected))


class MatrixResponseGoldenTests(GoldenResponses):
    endpoint = '/api/injection/production-matrix/'
    fixture = 'production_matrix_baseline.json'

    @classmethod
    def setUpTestData(cls):
        # Offsets are minutes from the synthetic business day boundary.
        samples = (
            # Separate valid capacity and power baselines, then invalid rows.
            (1, 8, 'A', 90, None, None),
            (1, 9, 'A', None, None, 100),
            (1, 10, 'A', 100, 40, 102),
            (1, 11, 'A', 5, 41, 103),  # Reset inside the first two-minute slot.
            (1, 12, 'A', 9, 42, 104),
            (1, 13, 'A', -3, 43, -1),
            (1, 20, 'A', 14, None, 108),
            (1, 20, 'B', 500, 48, 500),  # Same timestamp, different device and PK.
            (1, 21, 'B', 507, 49, 501),
            (2, 11, 'C', 31, None, None),
            (2, 17, 'C', 33, None, None),
            (2, 24, 'C', None, None, None),
            (1, 1375, 'B', 524, 50, None),
            (1, 1379, 'B', None, 50, 509),
            (1, 1380, 'B', 529, None, 510),
            (1, 1381, 'B', 4, 50, 511),
            (1, 1388, 'B', None, 52, None),
            (2, 1385, 'C', 100, None, None),
            (2, 1400, 'D', 210, None, None),
            (2, 1401, 'D', 214, None, None),
            (1, 1440, 'B', 19, 53, 513),
            (1, 1450, 'B', 22, 54, 515),  # Outside the historical window.
        )
        InjectionMonitoringRecord.objects.bulk_create([
            InjectionMonitoringRecord(
                machine_name=f'{machine}호기', device_code=f'SYNTHETIC-DEVICE-{device}',
                timestamp=START + timedelta(minutes=minute),
                capacity=capacity, oil_temperature=temperature, power_kwh=power,
            )
            for machine, minute, device, capacity, temperature, power in samples
        ])
        InjectionMonitoringRollup.objects.create(
            machine_name='2호기', device_code='SYNTHETIC-DEVICE-C',
            bucket_start=START + timedelta(minutes=60), bucket_minutes=30,
            shot_count=17,
        )

    def test_full_and_board_preserve_the_rendered_matrix(self):
        cases = {
            'live_two_minute_721': {'interval': '2min', 'columns': 721},
            'live_selected_machine': {'interval': '10min', 'columns': 7, 'machine_number': 1},
            'historical_ten_minute': {'interval': '10min', 'columns': 7, 'date': START.date().isoformat()},
        }
        with patch('injection.mes_service.datetime', wraps=datetime) as clock:
            clock.now.return_value = NOW
            for case, params in cases.items():
                for profile in ('full', 'injection-board'):
                    with self.subTest(case=case, profile=profile):
                        response = self.client.get(self.endpoint, {**params, 'profile': profile})
                        self.assert_golden(self.fixture, case, response, board=profile == 'injection-board')


class PartSearchGoldenTests(GoldenResponses):
    endpoint = '/api/injection/parts/'
    fixture = 'part_search_baseline.json'

    @classmethod
    def setUpTestData(cls):
        cls.reader = get_user_model().objects.create_user(username='SYNTHETIC-READER')
        with patch('django.utils.timezone.now', return_value=NOW):
            rows = [
                (2101, 'SYNTHETIC-UNION-A', 'SYNTHETIC-MODEL-A', 0),
                (2102, 'SYNTHETIC-UNION-A', 'SYNTHETIC-MODEL-A', -2),
                (2103, 'SYNTHETIC-UNION-B', 'SYNTHETIC-MODEL-A', 0),
                (2104, 'SYNTHETIC-UNION-C', 'SYNTHETIC-MODEL-A', 0),
                (2105, 'SYNTHETIC-UNION-D', 'SYNTHETIC-MODEL-A', 0),
                (2106, 'SYNTHETIC-UNION-E', 'SYNTHETIC-MODEL-A', 0),
                (2107, 'SYNTHETIC-UNION-FILTERED', 'SYNTHETIC-MODEL-B', 0),
                (2108, 'SYNTHETIC-LOCAL-ONLY', 'SYNTHETIC-MODEL-A', 0),
            ]
            for pk, part, model, offset in rows:
                PartSpec.objects.create(
                    pk=pk, part_no=part, model_code=model, description='SYNTHETIC-DESCRIPTION',
                    valid_from=START.date() + timedelta(days=offset),
                    cavity=2 if pk == 2101 else None, cycle_time_sec=22 if pk == 2101 else None,
                    net_weight_g='15.25' if pk == 2101 else None, sr_weight_g='0' if pk == 2101 else None,
                )

        # Seed real report rows in an order fixed by their models' Meta.ordering.
        # Earlier date rows stand in for the retired AssemblyPartSpec provider
        # when the compatibility branch is temporarily exercised.
        for pk, suffix in enumerate(('A', 'FILTERED', 'G', 'H'), start=3101):
            AssemblyReport.objects.create(
                pk=pk, date=START.date() - timedelta(days=1), line_no=f'SYNTHETIC-{pk}',
                part_no=f'SYNTHETIC-UNION-{suffix}', model='SYNTHETIC-MODEL-A',
                plan_qty=1, actual_qty=1,
            )
        for pk, suffix in enumerate(('C', 'G', 'H', 'I'), start=3201):
            AssemblyReport.objects.create(
                pk=pk, date=START.date(), line_no=f'SYNTHETIC-{pk}',
                part_no=f'SYNTHETIC-UNION-{suffix}', model='SYNTHETIC-MODEL-A',
                plan_qty=1, actual_qty=1,
            )
        for offset, suffix in enumerate(('D', 'I', 'J')):
            InjectionReport.objects.create(
                date=START.date() - timedelta(days=offset), tonnage='', model='SYNTHETIC-MODEL-A',
                section='SYNTHETIC-SECTION', part_no=f'SYNTHETIC-UNION-{suffix}',
                plan_qty=1, actual_qty=1, reported_defect=0, actual_defect=0,
            )

    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(user=self.reader)

    def test_current_schema_keeps_local_results_when_a_legacy_provider_is_unavailable(self):
        for key, params in {
            'schema_empty_search': {},
            'schema_provider_unavailable': {'search': 'SYNTHETIC-UNION', 'page_size': 1000},
        }.items():
            with self.subTest(case=key):
                self.assert_golden(self.fixture, key, self.client.get(self.endpoint, params))

    def test_legacy_provider_merge_order_page_and_duplicate_rules(self):
        # The current schema no longer supplies AssemblyPartSpec or the
        # historical InjectionReport.type field. Project synthetic rows into
        # those two source shapes so the original merge path can be exercised
        # without repairing that separate upstream contract here.
        legacy_spec = AssemblyReport.objects.filter(date__lt=START.date()).annotate(
            model_code=F('model'), description=Value('SYNTHETIC-LEGACY-DESCRIPTION'),
            process_type=Value('SYNTHETIC-PROCESS'), material_type=Value('SYNTHETIC-MATERIAL'),
            standard_cycle_time=Value(32), standard_worker_count=Value(2), valid_from=F('date'),
        )
        assembly_reports = AssemblyReport.objects.filter(date=START.date())
        injection_reports = InjectionReport.objects.annotate(type=F('section'))
        union = {'search': 'SYNTHETIC-UNION'}
        cases = {
            'models_only': {'search': 'SYNTHETIC-LOCAL-ONLY', 'page_size': 20},
            'union_size_one': {**union, 'page_size': 1, 'page': 2},
            'union_boundary': {**union, 'page_size': 5, 'page': 2},
            'union_mes_only_page': {**union, 'page_size': 5, 'page': 3},
            'union_past_end': {**union, 'page_size': 5, 'page': 4},
            'union_size_ten': {**union, 'page_size': 10},
            'union_all_sources': {**union, 'page_size': 1000},
            'model_code_filters_duplicate_reference': {
                **union, 'model_code': 'SYNTHETIC-MODEL-A', 'page_size': 1000,
            },
            'legacy_page_zero': {**union, 'page_size': 5, 'page': 0},
            'legacy_page_negative': {**union, 'page_size': 5, 'page': -1},
            'legacy_size_zero': {**union, 'page_size': 0},
            'legacy_size_negative': {**union, 'page_size': -2},
        }
        with patch.object(
            assembly_models, 'AssemblyPartSpec', SimpleNamespace(objects=legacy_spec), create=True,
        ), patch.object(
            assembly_models, 'AssemblyReport', SimpleNamespace(objects=assembly_reports),
        ), patch.object(views, 'InjectionReport', SimpleNamespace(objects=injection_reports)):
            for key, params in cases.items():
                with self.subTest(case=key):
                    self.assert_golden(self.fixture, key, self.client.get(self.endpoint, params))

    def test_legacy_invalid_page_numbers_raise_value_error(self):
        for field in ('page', 'page_size'):
            with self.subTest(field=field), self.assertRaises(ValueError):
                views.PartSpecViewSet().list(SimpleNamespace(query_params={field: 'SYNTHETIC-INVALID'}))
