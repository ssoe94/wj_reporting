from copy import deepcopy
from datetime import datetime, timedelta
from unittest.mock import patch

import pytz
from django.test import TestCase
from rest_framework.test import APIClient

from .mes_service import mes_service
from .models import InjectionMonitoringRecord


TELEMETRY_FIELDS = {'oil_temperature_matrix', 'power_kwh_matrix', 'power_usage_matrix'}


class InjectionBoardMatrixProfileTests(TestCase):
    endpoint = '/api/injection/production-matrix/'

    def setUp(self):
        self.client = APIClient()
        self.start = pytz.timezone('Asia/Shanghai').localize(datetime(2026, 9, 4, 8))
        # Include a reset, a collection gap and a machine with no samples.
        for minutes, capacity in [(-1, 90), (0, 100), (1, 5), (2, 9), (20, 15)]:
            InjectionMonitoringRecord.objects.create(
                machine_name='1호기', device_code='850T-1',
                timestamp=self.start + timedelta(minutes=minutes),
                capacity=capacity, oil_temperature=40 + minutes / 10,
                power_kwh=100 + minutes / 10,
            )

    def test_board_profile_only_removes_unused_telemetry_for_live_and_history(self):
        with patch('injection.mes_service.datetime', wraps=datetime) as clock:
            clock.now.return_value = self.start + timedelta(days=3)
            for params in (
                {'interval': '2min', 'columns': 721},
                {'interval': '10min', 'columns': 145, 'date': '2026-09-04'},
                {'interval': '30min', 'columns': 49, 'date': '2026-09-04'},
                {'interval': '10min', 'columns': 144},
            ):
                with self.subTest(params=params):
                    full = self.client.get(self.endpoint, params)
                    board = self.client.get(self.endpoint, {**params, 'profile': 'injection-board'})
                    self.assertEqual(full.status_code, 200)
                    self.assertEqual(board.status_code, 200)
                    self.assertEqual(set(full.data) - set(board.data), TELEMETRY_FIELDS)
                    self.assertEqual(board.data, {
                        key: value for key, value in full.data.items() if key not in TELEMETRY_FIELDS
                    })
                    self.assertEqual(len(board.data['machines']), 17)
                    self.assertEqual(len(board.data['time_slots']), params['columns'])
                    self.assertEqual(board.data['machine_sources']['2']['status'], 'missing')
                    self.assertFalse(any(board.data['capacity_observed_matrix']['2']))

    def test_projection_does_not_mutate_service_data_or_default_full_response(self):
        data = mes_service.get_production_matrix(interval_type='10min', columns=3)
        original = deepcopy(data)
        with patch.object(mes_service, 'get_production_matrix', return_value=data):
            board = self.client.get(self.endpoint, {'profile': 'injection-board'})
            self.assertEqual(board.status_code, 200)
            self.assertEqual(data, original)
            for params in ({}, {'profile': 'full'}):
                self.assertEqual(self.client.get(self.endpoint, params).data, original)

    def test_board_profile_preserves_machine_scope(self):
        response = self.client.get(self.endpoint, {
            'profile': 'injection-board', 'machine_number': 1, 'columns': 3,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data['actual_production_matrix']), {'1'})
        self.assertEqual(set(response.data['machine_sources']), {'1'})

    def test_invalid_profile_is_rejected_before_reading_matrix(self):
        with patch.object(mes_service, 'get_production_matrix') as build:
            response = self.client.get(self.endpoint, {'profile': 'unknown'})
        self.assertEqual(response.status_code, 400)
        build.assert_not_called()

    def test_board_profile_does_not_hide_source_errors(self):
        with patch.object(mes_service, 'get_production_matrix', side_effect=RuntimeError('unavailable')):
            response = self.client.get(self.endpoint, {'profile': 'injection-board'})
        self.assertEqual(response.status_code, 502)
