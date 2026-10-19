from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from django.test import TestCase
from rest_framework.test import APIClient

from .models import ProductionMesReportRecord, ProductionPlan


class ProductionMesReportModelPlanTests(TestCase):
    business_date = date(2026, 10, 8)

    def create_plan(self, plan_type, *, part_no='', model_name='', quantity, sequence=1, day_offset=0):
        return ProductionPlan.objects.create(
            plan_date=self.business_date + timedelta(days=day_offset),
            plan_type=plan_type,
            machine_name='A LINE' if plan_type == 'machining' else '1300T-3',
            part_no=part_no,
            model_name=model_name,
            lot_no=None,
            planned_quantity=quantity,
            sequence=sequence,
        )

    def create_report(self, plan_type, *, part_no='ABJ76756112', quantity=556, detail_id=1, model_name='Real MES material'):
        return ProductionMesReportRecord.objects.create(
            report_record_detail_id=detail_id,
            business_date=self.business_date,
            plan_type=plan_type,
            process_code='JG' if plan_type == 'machining' else 'ZS',
            report_time=datetime(2026, 10, 8, 16, 28, 34, tzinfo=ZoneInfo('Asia/Shanghai')),
            equipment_name='B LINE' if plan_type == 'machining' else '1300T-3',
            equipment_key='B' if plan_type == 'machining' else '3',
            part_no=part_no,
            material_name=model_name,
            report_qty=quantity,
        )

    def get_stats(self, plan_type):
        response = APIClient().get('/api/production/mes-report-stats/', {
            'date': self.business_date.isoformat(),
            'plan_type': plan_type,
        })
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_both_processes_include_distinct_model_only_daily_targets_without_mes_credit(self):
        for index, plan_type in enumerate(['machining', 'injection']):
            with self.subTest(plan_type=plan_type):
                self.create_plan(plan_type, part_no='ABJ76756112', quantity=535)
                self.create_plan(plan_type, model_name='汽车外部行李箱', quantity=400, sequence=2)
                self.create_plan(plan_type, model_name='OTHER MODEL', quantity=20, sequence=3)
                self.create_plan(plan_type, model_name='汽车外部行李箱', quantity=480, sequence=2, day_offset=1)
                self.create_plan(plan_type, model_name='OLD MODEL', quantity=480, sequence=2, day_offset=-1)
                self.create_plan(plan_type, model_name='ZERO TARGET', quantity=0, sequence=4)
                self.create_report(plan_type, detail_id=index + 1)

                payload = self.get_stats(plan_type)

                self.assertEqual(payload['summary']['total_planned'], 955)
                self.assertEqual(payload['summary']['total_mes'], 556)
                self.assertEqual(payload['summary']['gap_qty'], -399)
                self.assertEqual(payload['summary']['matched_rows'], 1)
                self.assertEqual(payload['summary']['plan_only_rows'], 2)
                self.assertEqual(payload['summary']['mes_only_rows'], 0)
                self.assertEqual(len(payload['rows']), 3)
                real_part = next(row for row in payload['rows'] if row['part_no'] == 'ABJ76756112')
                self.assertEqual(real_part['mes_qty'], 556)
                self.assertEqual(real_part['planned_qty'], 535)
                self.assertEqual(real_part['compare_status'], 'matched')
                self.assertEqual(real_part['equipment_key'], 'A' if plan_type == 'machining' else '3')
                model_rows = {row['model_name']: row for row in payload['rows'] if not row['part_no']}
                self.assertEqual(set(model_rows), {'汽车外部行李箱', 'OTHER MODEL'})
                for model_name, quantity in [('汽车外部行李箱', 400), ('OTHER MODEL', 20)]:
                    row = model_rows[model_name]
                    self.assertEqual(row['planned_qty'], quantity)
                    self.assertEqual(row['mes_qty'], 0)
                    self.assertEqual(row['compare_status'], 'plan_only')
                    self.assertEqual(row['plan_row_count'], 1)
                    self.assertEqual(row['mes_report_count'], 0)
                    self.assertEqual(row['mes_material_names'], [])
                    self.assertIsNone(row['latest_report_time'])

    def test_blank_material_mes_report_never_matches_model_only_plan(self):
        for index, plan_type in enumerate(['machining', 'injection']):
            with self.subTest(plan_type=plan_type):
                self.create_plan(plan_type, model_name='汽车外部行李箱', quantity=400)
                self.create_report(plan_type, part_no='', quantity=17, detail_id=index + 10, model_name='汽车外部行李箱')

                payload = self.get_stats(plan_type)

                self.assertEqual(payload['summary']['total_planned'], 400)
                self.assertEqual(payload['summary']['total_mes'], 17)
                self.assertEqual(payload['summary']['matched_rows'], 0)
                self.assertEqual(payload['summary']['plan_only_rows'], 1)
                self.assertEqual(payload['summary']['mes_only_rows'], 1)
                self.assertEqual(len(payload['rows']), 2)
                plan_row = next(row for row in payload['rows'] if row['compare_status'] == 'plan_only')
                self.assertEqual(plan_row['part_no'], '')
                self.assertEqual(plan_row['model_name'], '汽车外部行李箱')
                self.assertEqual(plan_row['mes_qty'], 0)
