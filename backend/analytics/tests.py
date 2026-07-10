from datetime import datetime, timedelta

import pytz
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord
from production.models import ProductionMesReportRecord, ProductionPartCavity, ProductionPlan

from .models import FactExceptionEvent, MartEquipmentDailyProgress, MartPartDailyProgress, MartProductionDailyProgress


class AnalyticsProductionMartTests(TestCase):
    def setUp(self):
        self.target_date = datetime(2026, 5, 18).date()
        self.user = get_user_model().objects.create_user(
            username='analytics-user',
            password='test-password',
            is_staff=True,
        )
        tz = pytz.timezone('Asia/Shanghai')
        start = tz.localize(datetime(2026, 5, 18, 8, 0))

        ProductionPlan.objects.create(
            plan_date=self.target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-A',
            model_name='Model A',
            planned_quantity=30,
            sequence=1,
        )
        ProductionPlan.objects.create(
            plan_date=self.target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-B',
            model_name='Model B',
            planned_quantity=40,
            sequence=2,
        )
        ProductionPlan.objects.create(
            plan_date=self.target_date,
            plan_type='machining',
            machine_name='A LINE',
            part_no='PART-M',
            model_name='Machining A',
            planned_quantity=80,
            sequence=1,
        )
        ProductionPlan.objects.create(
            plan_date=self.target_date,
            plan_type='machining',
            machine_name='B LINE',
            part_no='PART-N',
            model_name='Machining B',
            planned_quantity=50,
            sequence=1,
        )
        ProductionPartCavity.objects.create(part_no='PART-A', cavity=2, cavity_pattern='1x2')
        ProductionPartCavity.objects.create(part_no='PART-B', cavity=4, cavity_pattern='1x4')
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='inj-1',
            timestamp=start - timedelta(minutes=1),
            capacity=100,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='inj-1',
            timestamp=start + timedelta(minutes=10),
            capacity=110,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='inj-1',
            timestamp=start + timedelta(minutes=20),
            capacity=120,
        )
        ProductionMesReportRecord.objects.create(
            report_record_detail_id=9001,
            report_record_id=901,
            report_record_code='R-9001',
            business_date=self.target_date,
            plan_type='machining',
            process_code='JG',
            report_time=start + timedelta(hours=2),
            equipment_name='C LINE',
            equipment_key='C',
            part_no='PART-X',
            material_name='Unexpected Part',
            report_qty=12,
            raw_payload={},
        )

    def test_refresh_command_persists_production_marts_and_exceptions(self):
        call_command('refresh_analytics_marts', date=self.target_date.isoformat(), scope='production')

        injection_daily = MartProductionDailyProgress.objects.get(
            business_date=self.target_date,
            process='injection',
        )
        self.assertEqual(injection_daily.planned_qty, 70)
        self.assertEqual(injection_daily.actual_qty, 50)
        self.assertEqual(injection_daily.gap_qty, -20)
        self.assertEqual(injection_daily.status, 'behind')
        self.assertEqual(injection_daily.source_row_counts['monitoring_row_count'], 2)
        self.assertTrue(injection_daily.calculation_basis)

        equipment = MartEquipmentDailyProgress.objects.get(
            business_date=self.target_date,
            process='injection',
            equipment_key='1',
        )
        self.assertEqual(equipment.actual_qty, 50)
        self.assertEqual(equipment.completed_count, 1)
        self.assertEqual(equipment.in_progress_count, 1)

        part_rows = MartPartDailyProgress.objects.filter(
            business_date=self.target_date,
            process='injection',
        ).order_by('sequence')
        self.assertEqual(part_rows.count(), 2)
        self.assertEqual(part_rows[0].part_no, 'PART-A')
        self.assertEqual(part_rows[0].actual_qty, 30)
        self.assertEqual(part_rows[0].status, 'completed')
        self.assertEqual(part_rows[1].part_no, 'PART-B')
        self.assertEqual(part_rows[1].actual_qty, 20)
        self.assertEqual(part_rows[1].status, 'in_progress')

        exception_types = set(FactExceptionEvent.objects.values_list('exception_type', flat=True))
        self.assertIn('production_behind_schedule', exception_types)
        self.assertIn('plan_only', exception_types)
        self.assertIn('mes_only', exception_types)

    def test_production_progress_api_returns_persisted_mart_payload(self):
        call_command('refresh_analytics_marts', date=self.target_date.isoformat(), scope='production')

        client = APIClient()
        client.force_authenticate(self.user)
        response = client.get('/api/analytics/production-progress/', {
            'date': self.target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload['freshness']['is_persisted'])
        self.assertEqual(payload['scope']['business_date'], self.target_date.isoformat())
        daily_by_process = {row['process']: row for row in payload['daily']}
        self.assertEqual(daily_by_process['injection']['actual_qty'], 50)
        self.assertEqual(daily_by_process['machining']['planned_qty'], 130)
        self.assertTrue(payload['used_data'])
        self.assertTrue(payload['calculation_basis'])
        self.assertTrue(any(item['exception_type'] == 'mes_only' for item in payload['exceptions']))
