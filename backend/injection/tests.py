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


def build_plan_workbook(headers, rows, sheet_name='7-16'):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
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


def build_daily_target_plan_workbook(plan_type):
    if plan_type == 'machining':
        headers = ['設  備  ', 'LOT NO', 'MODEL ', 'SUFFIX', 'SPEC', 'PART NO', 8, 9, 10, 12]
        rows = [
            ['A LINE', '6K1M0567', '22U403A-BB.BKRMVN', None, 'C/A完', 'ABJ76756112', 535, None, None, None],
            ['A LINE', '未来', '汽车外部行李箱', None, None, None, 400, 480, 480, 480],
            ['D LINE', '6K1M01JT', 'BFP300-24.AUADCKN', None, 'B/C完', 'ACQ30720101', 184, None, None, None],
            ['D LINE', None, '55C7', None, 'BASE', 'AAN00883301', 52, None, None, None],
            ['D LINE', None, 'MRGB93', None, 'BASE', 'AAN00886101', 150, None, None, None],
            ['D LINE', '6JPXXL0K', '65UQ79', 'CKD', 'base', 'AAN00880701', 3360, None, None, None],
            ['D LINE', None, None, None, None, None, 10000, None, None, None],
            ['D LINE', None, 'ZERO TARGET', None, None, 'ZERO-PART', 0, None, None, None],
        ]
    else:
        headers = ['設  備  ', 'LOT NO', 'MODEL ', 'SPEC', '成品 P/N', 8, 9, 10, 12]
        rows = [
            ['1300T-3', '6K1M0567', '22U403A-BB.BKRMVN', '外框', 'ABJ76756112', 535, None, None, None],
            ['1300T-3', None, '汽车外部行李箱', None, None, 400, 480, 480, 480],
            ['1300T-3', None, 'OTHER MODEL', None, None, 20, None, None, None],
            ['1300T-3', None, None, None, None, 10000, None, None, None],
            ['1300T-3', None, 'ZERO TARGET', None, 'ZERO-PART', 0, None, None, None],
        ]
    return build_plan_workbook(headers, rows, sheet_name='10-8')


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


class InjectionEnergyMatrixTests(TestCase):
    def test_negative_missing_counter_does_not_create_energy_spike(self):
        cst = pytz.timezone('Asia/Shanghai')
        reference = cst.localize(datetime(2026, 8, 11, 10, 0))
        for hour, value in [(8, 100.0), (9, -1.0), (10, 101.0)]:
            InjectionMonitoringRecord.objects.create(
                machine_name='3호기',
                device_code='1300T-3',
                timestamp=reference.replace(hour=hour),
                power_kwh=value,
            )

        matrix = mes_service.get_production_matrix(
            interval_type='1hour',
            columns=3,
            reference_time=reference,
        )

        self.assertEqual(matrix['power_usage_matrix']['3'], [0.0, 0.0, 1.0])
        self.assertEqual(matrix['power_kwh_matrix']['3'], [100.0, 100.0, 101.0])

    def test_matrix_can_be_limited_to_one_field_machine(self):
        cst = pytz.timezone('Asia/Shanghai')
        reference = cst.localize(datetime(2026, 8, 11, 10, 0))
        for machine_number in (3, 4):
            InjectionMonitoringRecord.objects.create(
                machine_name=f'{machine_number}호기',
                device_code=f'machine-{machine_number}',
                timestamp=reference.replace(hour=9),
                capacity=100 + machine_number,
                power_kwh=200 + machine_number,
            )

        matrix = mes_service.get_production_matrix(
            interval_type='1hour',
            columns=2,
            reference_time=reference,
            machine_numbers=[3],
        )

        self.assertEqual(list(matrix['actual_production_matrix']), ['3'])
        self.assertEqual(list(matrix['power_usage_matrix']), ['3'])
        self.assertEqual(
            [row['machine_number'] for row in matrix['machines']],
            [3],
        )


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

    def test_machining_rows_without_lot_keep_model_and_part_identity(self):
        upload = SimpleUploadedFile(
            'machining-plan.xlsx',
            build_plan_workbook(
                ['設  備  ', 'LOT NO', 'MODEL ', 'SUFFIX', 'PART NO', 16],
                [['CNC-01', None, 'MODEL-A', 'A', 'PART-001', 100]],
            ),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )

        result = ProductionPlanProcessor(upload, 'machining', '2026-07-16').process()

        self.assertEqual(len(result['plan_long']), 1)
        row = result['plan_long'][0]
        self.assertIsNone(row['lot_no'])
        self.assertEqual(row['model'], 'MODEL-A')
        self.assertEqual(row['fg_part_no'], 'PART-001')
        self.assertEqual(row['plan_qty'], 100)

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


class ProductionPlanDailyTargetTests(TestCase):
    target_date = '2026-10-08'

    def make_upload(self, plan_type):
        return SimpleUploadedFile(
            f'{plan_type}-daily-plan.xlsx',
            build_daily_target_plan_workbook(plan_type),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )

    def test_machining_keeps_excel_dates_and_blank_lot_targets(self):
        result = ProductionPlanProcessor(self.make_upload('machining'), 'machining', self.target_date).process()

        self.assertEqual(result['available_days'], ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12'])
        self.assertEqual(result['daily_totals'], [
            {'date': '2026-10-08', 'plan_qty': 4681},
            {'date': '2026-10-09', 'plan_qty': 480},
            {'date': '2026-10-10', 'plan_qty': 480},
            {'date': '2026-10-12', 'plan_qty': 480},
        ])
        self.assertIn({'date': self.target_date, 'machine': 'A LINE', 'plan_qty': 935}, result['machine_summary'])
        self.assertIn({'date': self.target_date, 'machine': 'D LINE', 'plan_qty': 3746}, result['machine_summary'])
        rows = {row['fg_part_no']: row for row in result['plan_long'] if row['date'] == self.target_date}
        for part_no, quantity in [('AAN00883301', 52), ('AAN00886101', 150)]:
            self.assertEqual(rows[part_no]['plan_qty'], quantity)
            self.assertIsNone(rows[part_no]['lot_no'])
        self.assertEqual(rows[None]['model'], '汽车外部行李箱')
        self.assertEqual(rows[None]['plan_qty'], 400)
        self.assertNotIn('ZERO-PART', rows)
        self.assertEqual(len(result['plan_long']), 9)

    def test_injection_keeps_daily_quantities_and_distinct_model_only_rows(self):
        result = ProductionPlanProcessor(self.make_upload('injection'), 'injection', self.target_date).process()

        self.assertEqual(result['daily_totals'], [
            {'date': '2026-10-08', 'plan_qty': 955},
            {'date': '2026-10-09', 'plan_qty': 480},
            {'date': '2026-10-10', 'plan_qty': 480},
            {'date': '2026-10-12', 'plan_qty': 480},
        ])
        model_rows = [row for row in result['plan_long'] if not row['fg_part_no']]
        self.assertEqual([(row['model'], row['date'], row['plan_qty']) for row in model_rows], [
            ('汽车外部行李箱', '2026-10-08', 400),
            ('汽车外部行李箱', '2026-10-09', 480),
            ('汽车外部行李箱', '2026-10-10', 480),
            ('汽车外部行李箱', '2026-10-12', 480),
            ('OTHER MODEL', '2026-10-08', 20),
        ])
        self.assertTrue(all(row['lot_no'] is None for row in model_rows))
        self.assertEqual(len(result['plan_long']), 6)

    def test_machining_model_only_rows_without_lot_remain_distinct(self):
        upload = SimpleUploadedFile(
            'machining-model-plans.xlsx',
            build_plan_workbook(
                ['設  備  ', 'LOT NO', 'MODEL ', 'PART NO', 8, 9],
                [
                    ['A LINE', None, '汽车外部行李箱', None, 400, 480],
                    ['A LINE', None, 'OTHER MODEL', None, 20, None],
                ],
                sheet_name='10-8',
            ),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        result = ProductionPlanProcessor(upload, 'machining', self.target_date).process()

        self.assertEqual([(row['model'], row['date'], row['plan_qty']) for row in result['plan_long']], [
            ('汽车外部行李箱', '2026-10-08', 400),
            ('汽车外部行李箱', '2026-10-09', 480),
            ('OTHER MODEL', '2026-10-08', 20),
        ])
        self.assertTrue(all(row['lot_no'] is None and row['fg_part_no'] is None for row in result['plan_long']))

    def test_identityless_or_nonpositive_machining_uploads_remain_invalid(self):
        for lot_no, model, part_no, quantity, message in [
            (None, None, None, 100, '유효한 계획 행을 찾을 수 없습니다.'),
            (None, 'MODEL ONLY', None, 0, '양수 생산 계획 수량이 있는 유효한 계획 행을 찾을 수 없습니다.'),
            (None, None, 'PART ONLY', -1, '양수 생산 계획 수량이 있는 유효한 계획 행을 찾을 수 없습니다.'),
        ]:
            with self.subTest(model=model, part_no=part_no, quantity=quantity):
                upload = SimpleUploadedFile(
                    'machining-plan.xlsx',
                    build_plan_workbook(
                        ['設  備  ', 'LOT NO', 'MODEL ', 'PART NO', 8],
                        [['D LINE', lot_no, model, part_no, quantity]],
                        sheet_name='10-8',
                    ),
                    content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                )
                with self.assertRaisesMessage(ProductionPlanProcessingError, message):
                    ProductionPlanProcessor(upload, 'machining', self.target_date).process()

    def test_upload_and_summary_preserve_daily_targets_and_optional_identifiers(self):
        user = get_user_model().objects.create_user(username='daily-plan-uploader', is_staff=True)
        client = APIClient()
        client.force_authenticate(user=user)

        for plan_type, current_total, machine_totals in [
            ('machining', 4681, {'A LINE': 935, 'D LINE': 3746}),
            ('injection', 955, {'1300T-3': 955}),
        ]:
            with self.subTest(plan_type=plan_type):
                response = client.post(
                    reverse('production-plan-upload-root'),
                    {'file': self.make_upload(plan_type), 'plan_type': plan_type, 'date': self.target_date},
                    format='multipart',
                )
                self.assertEqual(response.status_code, 200, response.data)
                summary_response = client.get(reverse('production-plan-summary'), {'date': self.target_date})
                self.assertEqual(summary_response.status_code, 200)
                summary = summary_response.json()[plan_type]
                self.assertEqual(summary['daily_totals'], [{'date': self.target_date, 'plan_qty': current_total}])
                self.assertEqual({row['machine_name']: row['plan_qty'] for row in summary['machine_summary']}, machine_totals)
                records = summary['records']
                car = next(row for row in records if row['model_name'] == '汽车外部行李箱')
                self.assertEqual(car['planned_quantity'], 400)
                self.assertEqual(car['part_no'], '')
                if plan_type == 'machining':
                    for part_no, quantity in [('AAN00883301', 52), ('AAN00886101', 150)]:
                        plan = ProductionPlan.objects.get(plan_type=plan_type, plan_date=self.target_date, part_no=part_no)
                        self.assertEqual(plan.planned_quantity, quantity)
                        self.assertIsNone(plan.lot_no)
                else:
                    self.assertIsNone(car['lot_no'])
                    self.assertEqual(len([row for row in records if not row['part_no']]), 2)
                for future_date in ['2026-10-09', '2026-10-10', '2026-10-12']:
                    future_response = client.get(reverse('production-plan-summary'), {'date': future_date})
                    self.assertEqual(future_response.status_code, 200)
                    future = future_response.json()[plan_type]
                    self.assertEqual(future['daily_totals'], [{'date': future_date, 'plan_qty': 480}])
                    self.assertEqual(len(future['records']), 1)
                    self.assertEqual(future['records'][0]['model_name'], '汽车外部行李箱')
                    self.assertEqual(future['records'][0]['planned_quantity'], 480)
