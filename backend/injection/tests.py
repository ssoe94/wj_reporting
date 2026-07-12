from datetime import datetime, timedelta

import pytz
from django.test import TestCase
from rest_framework.test import APIClient

from .mes_service import mes_service
from .models import InjectionMonitoringRecord, InjectionMonitoringRollup


class InjectionMonitoringDatesApiTests(TestCase):
    def test_monitoring_dates_use_8am_business_day_boundary(self):
        cst = pytz.timezone('Asia/Shanghai')
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='850T-1',
            timestamp=cst.localize(datetime(2026, 5, 18, 9, 0)),
            capacity=10,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='850T-1',
            timestamp=cst.localize(datetime(2026, 5, 19, 7, 58)),
            capacity=20,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='850T-1',
            timestamp=cst.localize(datetime(2026, 5, 19, 8, 1)),
            capacity=30,
        )

        response = APIClient().get('/api/injection/monitoring-dates/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['dates'], ['2026-05-19', '2026-05-18'])


class InjectionMonitoringRollupTests(TestCase):
    def test_detailed_shots_override_stale_rollups_without_losing_rollup_only_data(self):
        cst = pytz.timezone('Asia/Shanghai')
        start_time = cst.localize(datetime(2026, 7, 11, 8, 0))
        end_time = start_time + timedelta(hours=1)

        InjectionMonitoringRollup.objects.create(
            machine_name='3호기',
            device_code='1300T-3',
            bucket_start=start_time,
            bucket_minutes=30,
            shot_count=0,
        )
        InjectionMonitoringRollup.objects.create(
            machine_name='4호기',
            device_code='1400T-4',
            bucket_start=start_time,
            bucket_minutes=30,
            shot_count=7,
        )
        InjectionMonitoringRollup.objects.create(
            machine_name='5호기',
            device_code='1400T-5',
            bucket_start=start_time,
            bucket_minutes=30,
            shot_count=99,
        )

        source_slots = [
            {
                'hour_offset': index,
                'time': (start_time + timedelta(minutes=index * 2)).isoformat(),
                'label': (start_time + timedelta(minutes=index * 2)).strftime('%H:%M'),
                'interval_minutes': 2,
            }
            for index in range(3)
        ]
        actual_matrix = {
            '3': [0, 5, 0],
            '4': [0, 0, 0],
            '5': [0, 4, 0],
        }

        _, rollup_matrix, has_rollup_source = mes_service._build_bucket_rollup_matrix(
            start_time,
            end_time,
            [3, 4, 5],
            actual_matrix,
            source_slots,
            bucket_minutes=30,
        )

        self.assertTrue(has_rollup_source)
        self.assertEqual(rollup_matrix['3'][0], 5)
        self.assertEqual(rollup_matrix['4'][0], 7)
        self.assertEqual(rollup_matrix['5'][0], 4)
