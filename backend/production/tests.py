from datetime import datetime
from unittest import TestCase
from unittest.mock import patch

import pytz
from django.core.management import call_command
from django.test import TestCase as DjangoTestCase
from rest_framework.test import APIClient

from .mes_progress import get_business_date, is_machining_progress_report, normalize_mes_part_no
from .counter_utils import calculate_cumulative_counter_delta
from .models import ProductionMesReportRecord, ProductionPlan


class CumulativeCounterDeltaTests(TestCase):
    def test_missing_baseline_uses_first_value_as_starting_point(self):
        result = calculate_cumulative_counter_delta([104726, 104728, 104730], baseline=None)

        self.assertEqual(result, 4)

    def test_existing_baseline_counts_first_in_window_delta(self):
        result = calculate_cumulative_counter_delta([104726, 104728, 104730], baseline=104700)

        self.assertEqual(result, 30)

    def test_counter_reset_counts_post_reset_counter(self):
        result = calculate_cumulative_counter_delta([100, 5, 9], baseline=90)

        self.assertEqual(result, 19)

    def test_small_counter_correction_is_not_treated_as_reset(self):
        result = calculate_cumulative_counter_delta([104820, 104822, 104821, 104825], baseline=None)

        self.assertEqual(result, 6)


class MesProgressParsingTests(TestCase):
    def test_report_material_code_takes_precedence_over_main_material_code(self):
        row = {
            'mainMaterialCode': 'MAIN-001',
            'materialInfo': {'baseInfo': {'code': ' REPORT-002 '}},
        }

        self.assertEqual(normalize_mes_part_no(row), 'REPORT-002')

    def test_report_time_before_8am_belongs_to_previous_business_date(self):
        tz = pytz.timezone('Asia/Shanghai')
        report_time = tz.localize(datetime(2026, 5, 18, 7, 59, 59))

        self.assertEqual(get_business_date(report_time).isoformat(), '2026-05-17')

    def test_machining_report_requires_jg_code_and_processing_name(self):
        self.assertTrue(is_machining_progress_report({'processCode': 'JG', 'processName': '加工'}))
        self.assertFalse(is_machining_progress_report({'processCode': 'JG', 'processName': '组装'}))
        self.assertFalse(is_machining_progress_report({'processCode': 'ZS', 'processName': '加工'}))


class MesProgressSyncCommandTests(DjangoTestCase):
    def test_sync_keeps_only_machining_processing_reports_and_updates_duplicates(self):
        tz = pytz.timezone('Asia/Shanghai')
        report_time = tz.localize(datetime(2026, 5, 18, 9, 0))
        report_time_ms = int(report_time.timestamp() * 1000)

        rows = [
            {
                'reportRecordDetailId': 1001,
                'reportRecordId': 501,
                'reportRecordCode': 'R-1001',
                'processCode': 'JG',
                'processName': '加工',
                'reportTime': report_time_ms,
                'equipments': [{'name': 'A LINE'}],
                'mainMaterialCode': 'MAIN-A',
                'mainMaterialName': 'Main A',
                'materialInfo': {'baseInfo': {'code': 'PART-A', 'name': 'Report Part A'}},
                'reportBaseAmount': {'amount': 12},
            },
            {
                'reportRecordDetailId': 1002,
                'reportRecordId': 502,
                'reportRecordCode': 'R-1002',
                'processCode': 'JG',
                'processName': '组装',
                'reportTime': report_time_ms,
                'equipments': [{'name': 'A LINE'}],
                'materialInfo': {'baseInfo': {'code': 'PART-B', 'name': 'Report Part B'}},
                'reportBaseAmount': {'amount': 7},
            },
        ]

        with patch('production.management.commands.sync_mes_progress_reports.fetch_all_progress_reports', return_value=rows):
            call_command('sync_mes_progress_reports', mode='incremental')

        record = ProductionMesReportRecord.objects.get(report_record_detail_id=1001)
        self.assertEqual(record.plan_type, 'machining')
        self.assertEqual(record.process_code, 'JG')
        self.assertEqual(record.business_date.isoformat(), '2026-05-18')
        self.assertEqual(record.equipment_key, 'A')
        self.assertEqual(record.part_no, 'PART-A')
        self.assertEqual(record.report_qty, 12)
        self.assertEqual(ProductionMesReportRecord.objects.count(), 1)

        updated_rows = [dict(rows[0], reportBaseAmount={'amount': 18})]
        with patch('production.management.commands.sync_mes_progress_reports.fetch_all_progress_reports', return_value=updated_rows):
            call_command('sync_mes_progress_reports', mode='incremental')

        record.refresh_from_db()
        self.assertEqual(record.report_qty, 18)
        self.assertEqual(ProductionMesReportRecord.objects.count(), 1)


class ProductionMesReportStatsApiTests(DjangoTestCase):
    def test_stats_api_compares_plan_and_mes_rows_without_auth(self):
        target_date = datetime(2026, 5, 18).date()
        tz = pytz.timezone('Asia/Shanghai')
        report_time = tz.localize(datetime(2026, 5, 18, 10, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='machining',
            machine_name='A LINE',
            part_no='PART-A',
            planned_quantity=100,
            sequence=1,
        )
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='machining',
            machine_name='B LINE',
            part_no='PART-B',
            planned_quantity=50,
            sequence=1,
        )
        ProductionMesReportRecord.objects.create(
            report_record_detail_id=2001,
            report_record_id=601,
            report_record_code='R-2001',
            business_date=target_date,
            plan_type='machining',
            process_code='JG',
            report_time=report_time,
            equipment_name='A LINE',
            equipment_key='A',
            part_no='PART-A',
            material_name='Part A',
            report_qty=70,
            raw_payload={},
        )
        ProductionMesReportRecord.objects.create(
            report_record_detail_id=2002,
            report_record_id=602,
            report_record_code='R-2002',
            business_date=target_date,
            plan_type='machining',
            process_code='JG',
            report_time=report_time,
            equipment_name='C LINE',
            equipment_key='C',
            part_no='PART-C',
            material_name='Part C',
            report_qty=30,
            raw_payload={},
        )

        response = APIClient().get('/api/production/mes-report-stats/', {
            'date': '2026-05-18',
            'plan_type': 'machining',
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['summary']['total_planned'], 150)
        self.assertEqual(payload['summary']['total_mes'], 100)
        self.assertEqual(payload['summary']['gap_qty'], -50)
        self.assertEqual(payload['summary']['matched_rows'], 1)
        self.assertEqual(payload['summary']['plan_only_rows'], 1)
        self.assertEqual(payload['summary']['mes_only_rows'], 1)

        statuses = {(row['equipment_key'], row['part_no']): row['compare_status'] for row in payload['rows']}
        self.assertEqual(statuses[('A', 'PART-A')], 'matched')
        self.assertEqual(statuses[('B', 'PART-B')], 'plan_only')
        self.assertEqual(statuses[('C', 'PART-C')], 'mes_only')
