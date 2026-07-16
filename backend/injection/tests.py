from datetime import datetime, timedelta
from io import BytesIO

import pytz
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from openpyxl import Workbook
from rest_framework.test import APIClient

from .mes_service import mes_service
from .models import InjectionMonitoringRecord, InjectionMonitoringRollup
from .plan_processing import ProductionPlanProcessingError, ProductionPlanProcessor
from production.models import ProductionPlan


def build_plan_workbook(headers, rows):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = '7-16'
    sheet.append([])
    sheet.append([])
    sheet.append(headers)
    for row in rows:
        sheet.append(row)

    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def build_model_only_injection_plan_workbook(plan_values=None):
    if plan_values is None:
        plan_values = [
            (114, None, None, None),
            (510, 624, 624, None),
        ]
    rows = []
    for day_16, day_17, day_18, day_20 in plan_values:
        rows.append(
            [
                '1300T-3',
                None,
                21700,
                '外框',
                None,
                day_16,
                day_17,
                day_18,
                day_20,
            ]
        )
    return build_plan_workbook(
        ['設  備  ', 'LOT NO', 'MODEL ', 'SPEC', '成品 P/N', 16, 17, 18, 20],
        rows,
    )


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


class ProductionPlanProcessorMissingOrderTests(TestCase):
    def test_identityless_injection_rows_remain_invalid(self):
        upload = SimpleUploadedFile(
            'injection-plan.xlsx',
            build_plan_workbook(
                ['設  備  ', 'LOT NO', 'MODEL ', 'SPEC', '成品 P/N', 16],
                [['1300T-3', None, None, None, None, 100]],
            ),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )

        with self.assertRaisesMessage(
            ProductionPlanProcessingError,
            '유효한 계획 행을 찾을 수 없습니다.',
        ):
            ProductionPlanProcessor(upload, 'injection', '2026-07-16').process()

    def test_machining_rows_without_lot_keep_existing_requirement(self):
        upload = SimpleUploadedFile(
            'machining-plan.xlsx',
            build_plan_workbook(
                ['設  備  ', 'LOT NO', 'MODEL ', 'SUFFIX', 'PART NO', 16],
                [['CNC-01', None, 'MODEL-A', 'A', 'PART-001', 100]],
            ),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )

        with self.assertRaisesMessage(
            ProductionPlanProcessingError,
            '유효한 계획 행을 찾을 수 없습니다.',
        ):
            ProductionPlanProcessor(upload, 'machining', '2026-07-16').process()

    def test_model_only_rows_without_positive_quantity_do_not_clear_plans(self):
        upload = SimpleUploadedFile(
            'injection-plan.xlsx',
            build_model_only_injection_plan_workbook(
                [('试料', None, None, None)],
            ),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )

        with self.assertRaisesMessage(
            ProductionPlanProcessingError,
            '양수 생산 계획 수량이 있는 유효한 계획 행을 찾을 수 없습니다.',
        ):
            ProductionPlanProcessor(upload, 'injection', '2026-07-16').process()

    def test_model_only_rows_without_lot_or_part_are_grouped(self):
        upload = SimpleUploadedFile(
            'injection-plan.xlsx',
            build_model_only_injection_plan_workbook(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )

        result = ProductionPlanProcessor(upload, 'injection', '2026-07-16').process()
        model_rows = [row for row in result['plan_long'] if row['model'] == '21700']

        self.assertEqual(
            [(row['date'], row['plan_qty']) for row in model_rows],
            [
                ('2026-07-16', 624),
                ('2026-07-17', 624),
                ('2026-07-18', 624),
            ],
        )
        for row in model_rows:
            self.assertEqual(row['machine'], '1300T-3')
            self.assertEqual(row['model'], '21700')
            self.assertEqual(row['part_spec'], '外框')
            self.assertIsNone(row['lot_no'])
            self.assertIsNone(row['fg_part_no'])
        self.assertIn(
            {'date': '2026-07-16', 'machine': '1300T-3', 'plan_qty': 624},
            result['machine_summary'],
        )

    def test_upload_persists_and_returns_model_only_plan(self):
        user = get_user_model().objects.create_user(
            username='plan-uploader',
            password='test-password',
            is_staff=True,
        )
        client = APIClient()
        client.force_authenticate(user=user)
        upload = SimpleUploadedFile(
            'injection-plan.xlsx',
            build_model_only_injection_plan_workbook(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )

        response = client.post(
            reverse('production-plan-upload-root'),
            {'file': upload, 'plan_type': 'injection', 'date': '2026-07-16'},
            format='multipart',
        )

        self.assertEqual(response.status_code, 200, response.data)
        plan = ProductionPlan.objects.get(
            plan_date='2026-07-16',
            plan_type='injection',
            machine_name='1300T-3',
            model_name='21700',
        )
        self.assertEqual(plan.planned_quantity, 624)
        self.assertIsNone(plan.lot_no)
        self.assertEqual(plan.part_no, '')

        summary_response = client.get(
            reverse('production-plan-summary'),
            {'date': '2026-07-16'},
        )
        self.assertEqual(summary_response.status_code, 200)
        records = summary_response.json()['injection']['records']
        model_records = [record for record in records if record['model_name'] == '21700']
        self.assertEqual(len(model_records), 1)
        model_record = model_records[0]
        self.assertEqual(model_record['machine_name'], '1300T-3')
        self.assertEqual(model_record['part_spec'], '外框')
        self.assertEqual(model_record['planned_quantity'], 624)
        self.assertIsNone(model_record['lot_no'])
        self.assertEqual(model_record['part_no'], '')
