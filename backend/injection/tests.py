from datetime import datetime

import pytz
from django.test import TestCase
from rest_framework.test import APIClient

from .models import InjectionMonitoringRecord


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
