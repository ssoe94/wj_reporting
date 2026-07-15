from datetime import datetime, timedelta
from unittest import TestCase
from unittest.mock import patch

import pytz
from django.core.management import call_command
from django.contrib.auth import get_user_model
from django.test import TestCase as DjangoTestCase
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord

from .mes_progress import get_business_date, is_machining_progress_report, normalize_mes_part_no
from .counter_utils import calculate_cumulative_counter_delta
from .ai_context import build_context_pack
from .ai_retrievers import get_daily_production_context, get_injection_summary, machine_monitoring_name
from .models import (
    InjectionActivityConfirmation,
    InjectionDowntimeConfirmation,
    MachiningManualReport,
    ProductionExecution,
    ProductionMesReportRecord,
    ProductionPartCavity,
    ProductionPlan,
)


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


class InjectionDowntimeConfirmationApiTests(DjangoTestCase):
    def setUp(self):
        user_model = get_user_model()
        self.editor = user_model.objects.create_user(
            username='injection-manager',
            password='test-password',
            is_staff=True,
        )
        self.viewer = user_model.objects.create_user(
            username='production-viewer',
            password='test-password',
        )
        self.editor_client = APIClient()
        self.editor_client.force_authenticate(self.editor)
        self.viewer_client = APIClient()
        self.viewer_client.force_authenticate(self.viewer)
        self.payload = {
            'business_date': '2026-07-11',
            'event_key': '2026-07-11:5:29729082:gap',
            'machine_key': '5',
            'machine_label': '5호기 - 1400',
            'detected_type': 'production_stop',
            'detected_start': '2026-07-11T12:42:00+08:00',
            'detected_end': '2026-07-11T12:56:00+08:00',
            'duration_minutes': 999,
            'resolution': 'confirmed',
            'reason_code': 'mechanical_failure',
            'note': '유압 경보 확인',
            'evidence': {'target_part_no': 'ACQ30844711', 'produced_qty': 291, 'planned_qty': 1185},
        }

    def test_editor_can_confirm_and_all_authenticated_users_can_read(self):
        create_response = self.editor_client.post(
            '/api/production/injection-downtime-confirmations/',
            self.payload,
            format='json',
        )

        self.assertEqual(create_response.status_code, 201)
        self.assertEqual(create_response.json()['duration_minutes'], 14)
        self.assertEqual(create_response.json()['confirmed_by_name'], 'injection-manager')

        read_response = self.viewer_client.get(
            '/api/production/injection-downtime-confirmations/',
            {'date': '2026-07-11'},
        )

        self.assertEqual(read_response.status_code, 200)
        self.assertEqual(len(read_response.json()['confirmations']), 1)
        self.assertEqual(read_response.json()['confirmations'][0]['reason_code'], 'mechanical_failure')

    def test_editor_can_update_and_reset_a_confirmation(self):
        self.editor_client.post(
            '/api/production/injection-downtime-confirmations/',
            self.payload,
            format='json',
        )
        updated_payload = {**self.payload, 'resolution': 'dismissed', 'reason_code': 'mechanical_failure'}

        update_response = self.editor_client.post(
            '/api/production/injection-downtime-confirmations/',
            updated_payload,
            format='json',
        )

        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()['resolution'], 'dismissed')
        self.assertEqual(update_response.json()['reason_code'], 'not_stop')

        reset_response = self.editor_client.post(
            '/api/production/injection-downtime-confirmations/',
            {'action': 'reset', 'event_key': self.payload['event_key']},
            format='json',
        )

        self.assertEqual(reset_response.status_code, 200)
        self.assertTrue(reset_response.json()['deleted'])
        self.assertFalse(InjectionDowntimeConfirmation.objects.exists())

    def test_viewer_cannot_confirm_and_other_reason_requires_note(self):
        forbidden_response = self.viewer_client.post(
            '/api/production/injection-downtime-confirmations/',
            self.payload,
            format='json',
        )
        invalid_response = self.editor_client.post(
            '/api/production/injection-downtime-confirmations/',
            {**self.payload, 'reason_code': 'other', 'note': ''},
            format='json',
        )

        self.assertEqual(forbidden_response.status_code, 403)
        self.assertEqual(invalid_response.status_code, 400)
        self.assertIn('note', invalid_response.json())

    def test_confirmation_must_match_business_date_and_machine(self):
        invalid_response = self.editor_client.post(
            '/api/production/injection-downtime-confirmations/',
            {**self.payload, 'event_key': '2026-07-10:6:29729082:gap'},
            format='json',
        )

        self.assertEqual(invalid_response.status_code, 400)
        self.assertIn('event_key', invalid_response.json())


class InjectionActivityConfirmationApiTests(DjangoTestCase):
    def setUp(self):
        user_model = get_user_model()
        self.editor = user_model.objects.create_user(
            username='activity-manager',
            password='test-password',
            is_staff=True,
        )
        self.viewer = user_model.objects.create_user(
            username='activity-viewer',
            password='test-password',
        )
        self.editor_client = APIClient()
        self.editor_client.force_authenticate(self.editor)
        self.viewer_client = APIClient()
        self.viewer_client.force_authenticate(self.viewer)
        self.payload = {
            'business_date': '2026-07-11',
            'machine_key': '3',
            'machine_label': '3호기 - 1300',
            'activity_type': 'production',
            'part_no': ' acq30000001 ',
            'model_name': 'TEST MODEL',
            'shot_count': 181,
            'last_shot_at': '2026-07-11T15:10:00+08:00',
            'note': '현장 생산품 확인',
        }

    def test_editor_can_confirm_and_viewer_can_read_activity(self):
        create_response = self.editor_client.post(
            '/api/production/injection-activity-confirmations/',
            self.payload,
            format='json',
        )

        self.assertEqual(create_response.status_code, 201)
        self.assertEqual(create_response.json()['part_no'], 'ACQ30000001')
        self.assertEqual(create_response.json()['confirmed_by_name'], 'activity-manager')

        read_response = self.viewer_client.get(
            '/api/production/injection-activity-confirmations/',
            {'date': '2026-07-11'},
        )

        self.assertEqual(read_response.status_code, 200)
        self.assertEqual(len(read_response.json()['confirmations']), 1)
        self.assertEqual(read_response.json()['confirmations'][0]['activity_type'], 'production')

    def test_update_reset_permissions_and_required_fields(self):
        self.editor_client.post(
            '/api/production/injection-activity-confirmations/',
            self.payload,
            format='json',
        )
        update_response = self.editor_client.post(
            '/api/production/injection-activity-confirmations/',
            {
                **self.payload,
                'activity_type': 'mold_check',
                'part_no': '',
                'note': '금형 확인 형합',
            },
            format='json',
        )
        forbidden_response = self.viewer_client.post(
            '/api/production/injection-activity-confirmations/',
            self.payload,
            format='json',
        )
        missing_part_response = self.editor_client.post(
            '/api/production/injection-activity-confirmations/',
            {**self.payload, 'part_no': ''},
            format='json',
        )

        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()['activity_type'], 'mold_check')
        self.assertEqual(forbidden_response.status_code, 403)
        self.assertEqual(missing_part_response.status_code, 400)
        self.assertIn('part_no', missing_part_response.json())

        reset_response = self.editor_client.post(
            '/api/production/injection-activity-confirmations/',
            {
                'action': 'reset',
                'business_date': '2026-07-11',
                'machine_key': '3',
            },
            format='json',
        )
        self.assertEqual(reset_response.status_code, 200)
        self.assertTrue(reset_response.json()['deleted'])
        self.assertFalse(InjectionActivityConfirmation.objects.exists())


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
    def test_ai_briefing_api_allows_read_only_access_without_auth(self):
        response = APIClient().get('/api/production/ai/briefing/', {
            'date': '2026-05-18',
            'language': 'ko',
        })

        self.assertEqual(response.status_code, 200)
        self.assertIn('answer', response.json())

    def test_stats_api_matches_machining_rows_by_part_no_without_auth(self):
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
            equipment_name='C LINE',
            equipment_key='C',
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

        rows_by_part = {row['part_no']: row for row in payload['rows']}
        self.assertEqual(rows_by_part['PART-A']['compare_status'], 'matched')
        self.assertEqual(rows_by_part['PART-A']['equipment_key'], 'A')
        self.assertEqual(rows_by_part['PART-A']['mes_qty'], 70)
        self.assertEqual(rows_by_part['PART-B']['compare_status'], 'plan_only')
        self.assertEqual(rows_by_part['PART-C']['compare_status'], 'mes_only')

    def test_stats_api_preserves_injection_mes_material_name_candidates(self):
        target_date = datetime(2026, 5, 18).date()
        tz = pytz.timezone('Asia/Shanghai')
        report_time = tz.localize(datetime(2026, 5, 18, 10, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='ABJ76763510',
            model_name='27GR75',
            planned_quantity=100,
            sequence=1,
        )
        ProductionMesReportRecord.objects.create(
            report_record_detail_id=2101,
            report_record_id=701,
            report_record_code='R-2101',
            business_date=target_date,
            plan_type='injection',
            process_code='ZS',
            report_time=report_time,
            equipment_name='850T-1',
            equipment_key='1',
            part_no='MBH65682501',
            material_name='ABJ76763501/02/06/10',
            report_qty=40,
            raw_payload={},
        )

        response = APIClient().get('/api/production/mes-report-stats/', {
            'date': '2026-05-18',
            'plan_type': 'injection',
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        rows_by_part = {row['part_no']: row for row in payload['rows']}
        self.assertEqual(rows_by_part['MBH65682501']['compare_status'], 'mes_only')
        self.assertEqual(rows_by_part['MBH65682501']['model_name'], 'ABJ76763501/02/06/10')
        self.assertEqual(rows_by_part['MBH65682501']['mes_material_names'], ['ABJ76763501/02/06/10'])


class MachiningManualSupplementContractTests(DjangoTestCase):
    def setUp(self):
        self.business_date = datetime(2026, 5, 18).date()
        self.advance_plan_date = datetime(2026, 5, 19).date()
        self.tz = pytz.timezone('Asia/Shanghai')
        self.user = get_user_model().objects.create_user(
            username='machining-admin',
            password='test-password',
            is_staff=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.plan = ProductionPlan.objects.create(
            plan_date=self.advance_plan_date,
            plan_type='machining',
            machine_name='A LINE',
            part_no='PART-ADV',
            lot_no='LOT-ADV',
            model_name='Model Advance',
            planned_quantity=120,
            sequence=1,
        )

    def test_dashboard_provision_uses_manual_open_qty_when_mes_is_missing(self):
        response = self.client.post('/api/production/machining/manual-reports/', {
            'business_date': self.business_date.isoformat(),
            'plan_id': self.plan.id,
            'good_qty': 100,
            'defect_qty': 2,
            'defect_items': [
                {'defect_category': 'processing', 'defect_type': 'scratch', 'quantity': 2},
            ],
            'reason_code': 'mes_work_order_missing',
            'note': '5/19 plan produced early without MES work order',
        }, format='json')

        self.assertEqual(response.status_code, 201)
        report_payload = response.json()
        self.assertEqual(report_payload['total_reported_qty'], 100)
        self.assertEqual(report_payload['defect_qty'], 2)
        self.assertEqual(report_payload['status'], 'open')

        provision_response = self.client.get('/api/production/machining/provision/', {
            'business_date': self.business_date.isoformat(),
            'days': 2,
        })

        self.assertEqual(provision_response.status_code, 200)
        payload = provision_response.json()
        self.assertEqual(payload['summary']['effective_actual_qty'], 100)
        self.assertEqual(payload['summary']['manual_open_qty'], 100)
        self.assertEqual(payload['summary']['advance_qty'], 100)
        row = next(item for item in payload['rows'] if item['part_no'] == 'PART-ADV')
        self.assertEqual(row['plan_date'], self.advance_plan_date.isoformat())
        self.assertEqual(row['day_offset'], 1)
        self.assertEqual(row['status'], 'manual_open')
        self.assertEqual(row['defect_qty'], 2)

    def test_manual_match_prevents_late_mes_from_being_counted_twice(self):
        manual_report = MachiningManualReport.objects.create(
            business_date=self.business_date,
            plan_date=self.advance_plan_date,
            plan=self.plan,
            plan_identity_hash='',
            machine_name='A LINE',
            equipment_key='A',
            part_no='PART-ADV',
            model_name='Model Advance',
            lot_no='LOT-ADV',
            sequence=1,
            planned_qty_at_report=120,
            good_qty=100,
            defect_qty=0,
            total_reported_qty=100,
            reason_code='mes_work_order_missing',
            credit_business_date=self.business_date,
            reported_by=self.user,
            updated_by=self.user,
        )
        mes_record = ProductionMesReportRecord.objects.create(
            report_record_detail_id=3001,
            report_record_id=701,
            report_record_code='R-3001',
            business_date=self.advance_plan_date,
            plan_type='machining',
            process_code='JG',
            report_time=self.tz.localize(datetime(2026, 5, 19, 10, 0)),
            equipment_name='A LINE',
            equipment_key='A',
            part_no='PART-ADV',
            material_name='Model Advance',
            report_qty=100,
            raw_payload={},
        )

        confirm_response = self.client.post(
            f'/api/production/machining/reconciliation/{manual_report.id}/confirm/',
            {
                'mes_report_record_ids': [mes_record.id],
                'matched_qty': 100,
                'note': 'MES 후등록분과 동일 생산으로 확인',
            },
            format='json',
        )

        self.assertEqual(confirm_response.status_code, 200)
        manual_report.refresh_from_db()
        self.assertEqual(manual_report.status, 'matched')

        original_day = self.client.get('/api/production/machining/provision/', {
            'business_date': self.business_date.isoformat(),
            'days': 2,
        }).json()
        mes_day = self.client.get('/api/production/machining/provision/', {
            'business_date': self.advance_plan_date.isoformat(),
            'days': 1,
        }).json()

        self.assertEqual(original_day['summary']['effective_actual_qty'], 100)
        self.assertEqual(original_day['summary']['manual_open_qty'], 0)
        self.assertEqual(original_day['summary']['manual_matched_qty'], 100)
        self.assertEqual(mes_day['summary']['effective_actual_qty'], 0)

    def test_reconcile_command_auto_matches_later_mes_report(self):
        MachiningManualReport.objects.create(
            business_date=self.business_date,
            plan_date=self.advance_plan_date,
            plan=self.plan,
            plan_identity_hash='',
            machine_name='A LINE',
            equipment_key='A',
            part_no='PART-ADV',
            model_name='Model Advance',
            lot_no='LOT-ADV',
            sequence=1,
            planned_qty_at_report=120,
            good_qty=60,
            total_reported_qty=60,
            reason_code='mes_work_order_missing',
            credit_business_date=self.business_date,
            reported_by=self.user,
            updated_by=self.user,
        )
        ProductionMesReportRecord.objects.create(
            report_record_detail_id=3002,
            report_record_id=702,
            report_record_code='R-3002',
            business_date=self.advance_plan_date,
            plan_type='machining',
            process_code='JG',
            report_time=self.tz.localize(datetime(2026, 5, 19, 11, 0)),
            equipment_name='A LINE',
            equipment_key='A',
            part_no='PART-ADV',
            material_name='Model Advance',
            report_qty=60,
            raw_payload={},
        )

        call_command(
            'reconcile_machining_manual_reports',
            from_date=self.business_date.isoformat(),
            to_date=self.advance_plan_date.isoformat(),
        )

        report = MachiningManualReport.objects.get(part_no='PART-ADV')
        self.assertEqual(report.status, 'matched')
        provision = self.client.get('/api/production/machining/provision/', {
            'business_date': self.business_date.isoformat(),
            'days': 2,
        }).json()
        self.assertEqual(provision['summary']['effective_actual_qty'], 60)
        self.assertEqual(provision['summary']['manual_open_qty'], 0)


class ProductionConsoleContractTests(DjangoTestCase):
    def setUp(self):
        self.target_date = datetime(2026, 5, 18).date()
        self.user = get_user_model().objects.create_user(
            username='production-admin',
            password='test-password',
            is_staff=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        ProductionPlan.objects.create(
            plan_date=self.target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-A',
            lot_no='',
            model_name='Model A',
            planned_quantity=100,
            sequence=1,
        )

    def test_console_returns_plan_anchored_rows_before_execution_exists(self):
        response = self.client.get('/api/production/console/', {
            'date': self.target_date.isoformat(),
            'plan_type': 'injection',
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['summary']['total_planned'], 100)
        self.assertEqual(payload['summary']['pending_count'], 1)
        self.assertEqual(payload['rows'][0]['key'], '2026-05-18|injection|850T-1|PART-A||1')
        self.assertEqual(payload['rows'][0]['status'], 'pending')

    def test_execution_upsert_preserves_plan_key_and_updates_idempotently(self):
        first_response = self.client.post('/api/production/executions/upsert/', {
            'plan_date': self.target_date.isoformat(),
            'plan_type': 'injection',
            'machine_name': '850T-1',
            'part_no': 'part-a',
            'lot_no': '',
            'sequence': 1,
            'planned_quantity': 100,
            'actual_qty': 40,
            'defect_qty': -5,
            'idle_time': -10,
            'personnel_count': 1,
        }, format='json')

        self.assertEqual(first_response.status_code, 200)
        first_payload = first_response.json()
        self.assertEqual(first_payload['part_no'], 'PART-A')
        self.assertEqual(first_payload['actual_qty'], 40)
        self.assertEqual(first_payload['defect_qty'], 0)
        self.assertEqual(first_payload['idle_time'], 0)
        self.assertEqual(first_payload['status'], 'running')

        second_response = self.client.post('/api/production/executions/upsert/', {
            'plan_date': self.target_date.isoformat(),
            'plan_type': 'injection',
            'machine_name': '850T-1',
            'part_no': 'PART-A',
            'lot_no': None,
            'sequence': 1,
            'planned_quantity': 100,
            'actual_qty': 120,
            'personnel_count': 2,
        }, format='json')

        self.assertEqual(second_response.status_code, 200)
        second_payload = second_response.json()
        self.assertEqual(second_payload['status'], 'completed')
        self.assertEqual(ProductionExecution.objects.count(), 1)


class AiBriefingContractTests(DjangoTestCase):
    def test_ai_briefing_response_contains_deterministic_evidence_contract(self):
        target_date = datetime(2026, 5, 18).date()
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-A',
            lot_no='A01',
            model_name='Model A',
            planned_quantity=100,
            sequence=1,
        )
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='machining',
            machine_name='A LINE',
            part_no='PART-M',
            lot_no='M01',
            model_name='Machining A',
            planned_quantity=80,
            sequence=1,
        )

        response = APIClient().get('/api/production/ai/briefing/', {
            'date': target_date.isoformat(),
            'language': 'ko',
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload['answer'])
        self.assertIn('facts', payload)
        self.assertIn('top_risks', payload)
        self.assertIn('used_data', payload)
        self.assertIn('calculation_basis', payload)
        self.assertIn('context_pack', payload)
        self.assertIn('cache', payload)

        self.assertEqual(payload['facts']['injection']['planned_qty'], 100)
        self.assertEqual(payload['facts']['machining']['planned_qty'], 80)
        self.assertGreaterEqual(len(payload['used_data']), 3)
        self.assertTrue(any(item['name'] == 'ProductionPlan' for item in payload['used_data']))
        self.assertTrue(any('08:00' in item for item in payload['calculation_basis']))

        context_pack = payload['context_pack']
        self.assertEqual(context_pack['scope']['business_date'], target_date.isoformat())
        self.assertEqual(context_pack['scope']['processes'], ['injection', 'machining'])
        self.assertIn('data_freshness', context_pack)
        self.assertIn('warnings', context_pack)
        self.assertIn('retrieval_trace', context_pack)
        self.assertTrue(any('production.plan' in item for item in context_pack['retrieval_trace']))

    def test_ai_briefing_uses_same_facts_for_korean_and_chinese(self):
        target_date = datetime(2026, 5, 18).date()
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-A',
            planned_quantity=100,
            sequence=1,
        )

        client = APIClient()
        ko_response = client.get('/api/production/ai/briefing/', {
            'date': target_date.isoformat(),
            'language': 'ko',
        })
        zh_response = client.get('/api/production/ai/briefing/', {
            'date': target_date.isoformat(),
            'language': 'zh',
        })

        self.assertEqual(ko_response.status_code, 200)
        self.assertEqual(zh_response.status_code, 200)
        self.assertEqual(ko_response.json()['facts'], zh_response.json()['facts'])


class InjectionAllocationContractTests(DjangoTestCase):
    def test_status_and_ai_retriever_allocate_shots_by_sequence_and_cavity(self):
        target_date = datetime(2026, 5, 18).date()
        tz = pytz.timezone('Asia/Shanghai')
        start = tz.localize(datetime(2026, 5, 18, 8, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-A',
            model_name='Model A',
            planned_quantity=30,
            sequence=1,
        )
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-B',
            model_name='Model B',
            planned_quantity=40,
            sequence=2,
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

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machine = response.json()['injection'][0]
        self.assertEqual(machine['total_planned'], 70)
        self.assertEqual(machine['total_actual'], 50)
        self.assertEqual(machine['parts'][0]['part_no'], 'PART-A')
        self.assertEqual(machine['parts'][0]['actual_quantity'], 30)
        self.assertEqual(machine['parts'][0]['progress'], 100.0)
        self.assertEqual(machine['parts'][1]['part_no'], 'PART-B')
        self.assertEqual(machine['parts'][1]['actual_quantity'], 20)
        self.assertEqual(machine['parts'][1]['progress'], 50.0)

        summary = get_injection_summary(target_date)
        summary_row = summary['machine_rows'][0]
        self.assertEqual(summary_row['planned_qty'], 70)
        self.assertEqual(summary_row['actual_qty'], 50)
        self.assertEqual(summary_row['parts'][0]['estimated_qty'], 30)
        self.assertEqual(summary_row['parts'][0]['status'], 'completed')
        self.assertEqual(summary_row['parts'][1]['estimated_qty'], 20)
        self.assertEqual(summary_row['parts'][1]['status'], 'in_progress')

    def test_default_cavity_pattern_keeps_part_as_one_by_one(self):
        target_date = datetime(2026, 5, 19).date()
        tz = pytz.timezone('Asia/Shanghai')
        start = tz.localize(datetime(2026, 5, 19, 8, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-DEFAULT',
            model_name='Model Default',
            planned_quantity=20,
            sequence=1,
        )
        ProductionPartCavity.objects.create(part_no='PART-DEFAULT', cavity=4)
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(1),
            device_code='inj-1',
            timestamp=start - timedelta(minutes=1),
            capacity=100,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(1),
            device_code='inj-1',
            timestamp=start + timedelta(minutes=10),
            capacity=110,
        )

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machine = response.json()['injection'][0]
        self.assertEqual(machine['total_actual'], 10)
        self.assertEqual(machine['parts'][0]['actual_quantity'], 10)
        self.assertEqual(machine['parts'][0]['progress'], 50.0)

    def test_grouped_cavity_parts_share_the_same_shots(self):
        target_date = datetime(2026, 7, 3).date()
        tz = pytz.timezone('Asia/Shanghai')
        start = tz.localize(datetime(2026, 7, 3, 8, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='650T-10',
            part_no='AAN30078443',
            model_name='65UQ79',
            planned_quantity=2520,
            sequence=1,
        )
        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='650T-10',
            part_no='AAN30078444',
            model_name='65UQ79',
            planned_quantity=2520,
            sequence=2,
        )
        ProductionPartCavity.objects.update_or_create(
            part_no='AAN30078443',
            defaults={
                'cavity': 2,
                'cavity_pattern': '2x2',
                'parts_per_shot': 2,
                'cavity_group': 'AAN30078443+AAN30078444',
            },
        )
        ProductionPartCavity.objects.update_or_create(
            part_no='AAN30078444',
            defaults={
                'cavity': 2,
                'cavity_pattern': '2x2',
                'parts_per_shot': 2,
                'cavity_group': 'AAN30078443+AAN30078444',
            },
        )
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(10),
            device_code='inj-10',
            timestamp=start - timedelta(minutes=1),
            capacity=100,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(10),
            device_code='inj-10',
            timestamp=start + timedelta(minutes=10),
            capacity=110,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(10),
            device_code='inj-10',
            timestamp=start + timedelta(minutes=20),
            capacity=120,
        )

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machine = response.json()['injection'][0]
        self.assertEqual(machine['total_planned'], 5040)
        self.assertEqual(machine['total_actual'], 80)
        self.assertEqual(machine['parts'][0]['actual_quantity'], 40)
        self.assertEqual(machine['parts'][1]['actual_quantity'], 40)

    def test_repeated_grouped_cavity_occurrences_allocate_shots_in_sequence(self):
        target_date = datetime(2026, 7, 4).date()
        tz = pytz.timezone('Asia/Shanghai')
        start = tz.localize(datetime(2026, 7, 4, 8, 0))

        for sequence, (part_no, lot_no) in enumerate([
            ('PAIR-A', 'A1'),
            ('PAIR-B', 'B1'),
            ('PAIR-A', 'A2'),
            ('PAIR-B', 'B2'),
        ], start=1):
            ProductionPlan.objects.create(
                plan_date=target_date,
                plan_type='injection',
                machine_name='850T-1',
                part_no=part_no,
                lot_no=lot_no,
                model_name='Repeated Pair',
                planned_quantity=100,
                sequence=sequence,
            )

        for part_no in ['PAIR-A', 'PAIR-B']:
            ProductionPartCavity.objects.create(
                part_no=part_no,
                cavity=2,
                cavity_pattern='2x2',
                parts_per_shot=2,
                cavity_group='PAIR-A+PAIR-B',
            )

        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(1),
            device_code='inj-1',
            timestamp=start - timedelta(minutes=1),
            capacity=100,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(1),
            device_code='inj-1',
            timestamp=start + timedelta(minutes=10),
            capacity=160,
        )

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machine = response.json()['injection'][0]
        self.assertEqual(machine['total_planned'], 400)
        self.assertEqual(machine['total_actual'], 240)
        self.assertEqual(
            [part['actual_quantity'] for part in machine['parts']],
            [100, 100, 20, 20],
        )
        self.assertEqual(
            [part['progress'] for part in machine['parts']],
            [100.0, 100.0, 20.0, 20.0],
        )

        summary = get_injection_summary(target_date)
        summary_row = summary['machine_rows'][0]
        self.assertEqual(summary_row['planned_qty'], 400)
        self.assertEqual(summary_row['actual_qty'], 240)
        self.assertEqual(
            [part['estimated_qty'] for part in summary_row['parts']],
            [100, 100, 20, 20],
        )
        self.assertEqual(
            [part['status'] for part in summary_row['parts']],
            ['completed', 'completed', 'in_progress', 'in_progress'],
        )

    def test_grouped_cavity_does_not_pair_later_lot_when_parallel_part_is_missing(self):
        target_date = datetime(2026, 7, 5).date()
        tz = pytz.timezone('Asia/Shanghai')
        start = tz.localize(datetime(2026, 7, 5, 8, 0))

        for sequence, lot_no in enumerate(['A1', 'A2'], start=1):
            ProductionPlan.objects.create(
                plan_date=target_date,
                plan_type='injection',
                machine_name='850T-1',
                part_no='PAIR-A',
                lot_no=lot_no,
                model_name='Incomplete Pair',
                planned_quantity=100,
                sequence=sequence,
            )

        ProductionPartCavity.objects.create(
            part_no='PAIR-A',
            cavity=2,
            cavity_pattern='2x2',
            parts_per_shot=2,
            cavity_group='PAIR-A+PAIR-B',
        )
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(1),
            device_code='inj-1',
            timestamp=start - timedelta(minutes=1),
            capacity=100,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name=machine_monitoring_name(1),
            device_code='inj-1',
            timestamp=start + timedelta(minutes=10),
            capacity=110,
        )

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machine = response.json()['injection'][0]
        self.assertEqual(machine['total_actual'], 20)
        self.assertEqual(
            [part['actual_quantity'] for part in machine['parts']],
            [20, 0],
        )

    def test_status_api_does_not_count_first_cumulative_value_without_baseline(self):
        target_date = datetime(2026, 5, 18).date()
        tz = pytz.timezone('Asia/Shanghai')
        start = tz.localize(datetime(2026, 5, 18, 8, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='injection',
            machine_name='850T-1',
            part_no='PART-A',
            model_name='Model A',
            planned_quantity=100,
            sequence=1,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='inj-1',
            timestamp=start,
            capacity=1000,
        )
        InjectionMonitoringRecord.objects.create(
            machine_name='1호기',
            device_code='inj-1',
            timestamp=start + timedelta(minutes=10),
            capacity=1010,
        )

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machine = response.json()['injection'][0]
        self.assertEqual(machine['total_actual'], 10)

    def test_status_api_uses_canonical_mes_context_for_machining(self):
        target_date = datetime(2026, 5, 18).date()
        tz = pytz.timezone('Asia/Shanghai')
        report_time = tz.localize(datetime(2026, 5, 18, 10, 0))

        ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='machining',
            machine_name='A LINE',
            part_no='PART-M',
            model_name='Machining A',
            planned_quantity=80,
            sequence=1,
        )
        ProductionMesReportRecord.objects.create(
            report_record_detail_id=3001,
            report_record_id=701,
            report_record_code='R-3001',
            business_date=target_date,
            plan_type='machining',
            process_code='JG',
            report_time=report_time,
            equipment_name='A LINE',
            equipment_key='A',
            part_no='PART-M',
            material_name='Machining A',
            report_qty=60,
            raw_payload={},
        )

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machining = response.json()['machining'][0]
        self.assertEqual(machining['machine_name'], 'A라인')
        self.assertEqual(machining['total_planned'], 80)
        self.assertEqual(machining['total_actual'], 60)
        self.assertEqual(machining['progress'], 75.0)
        self.assertEqual(machining['parts'][0]['part_no'], 'PART-M')
        self.assertEqual(machining['parts'][0]['actual_quantity'], 60)

    def test_status_api_uses_manual_machining_supplement_until_mes_arrives(self):
        target_date = datetime(2026, 5, 18).date()
        plan = ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='machining',
            machine_name='B LINE',
            part_no='PART-MANUAL',
            model_name='Manual Model',
            planned_quantity=80,
            sequence=1,
        )
        MachiningManualReport.objects.create(
            business_date=target_date,
            credit_business_date=target_date,
            plan_date=target_date,
            plan=plan,
            machine_name='B LINE',
            equipment_key='B',
            part_no='PART-MANUAL',
            model_name='Manual Model',
            sequence=1,
            planned_qty_at_report=80,
            good_qty=25,
            defect_qty=3,
            total_reported_qty=25,
            reason_code='mes_work_order_missing',
        )

        response = APIClient().get('/api/production/status/', {
            'date': target_date.isoformat(),
        })

        self.assertEqual(response.status_code, 200)
        machining = response.json()['machining'][0]
        self.assertEqual(machining['machine_name'], 'B라인')
        self.assertEqual(machining['total_planned'], 80)
        self.assertEqual(machining['total_actual'], 25)
        self.assertEqual(machining['total_manual_open'], 25)
        self.assertEqual(machining['total_defect'], 3)
        self.assertEqual(machining['progress'], 31.2)
        self.assertEqual(machining['parts'][0]['part_no'], 'PART-MANUAL')
        self.assertEqual(machining['parts'][0]['actual_quantity'], 25)
        self.assertEqual(machining['parts'][0]['manual_open_qty'], 25)
        self.assertEqual(machining['parts'][0]['defect_qty'], 3)

    def test_ai_context_uses_manual_machining_supplement_until_mes_arrives(self):
        target_date = datetime(2026, 5, 18).date()
        plan = ProductionPlan.objects.create(
            plan_date=target_date,
            plan_type='machining',
            machine_name='D LINE',
            part_no='PART-AI-MANUAL',
            model_name='AI Manual Model',
            planned_quantity=100,
            sequence=1,
        )
        MachiningManualReport.objects.create(
            business_date=target_date,
            credit_business_date=target_date,
            plan_date=target_date,
            plan=plan,
            machine_name='D LINE',
            equipment_key='D',
            part_no='PART-AI-MANUAL',
            model_name='AI Manual Model',
            sequence=1,
            planned_qty_at_report=100,
            good_qty=40,
            defect_qty=2,
            total_reported_qty=40,
            reason_code='mes_work_order_missing',
        )

        context = get_daily_production_context(target_date)
        context_pack = build_context_pack(context, 'ko')
        machining_table = next(table for table in context_pack.tables if table['name'] == 'machining_line_progress')

        self.assertEqual(context_pack.facts['machining']['planned_qty'], 100)
        self.assertEqual(context_pack.facts['machining']['actual_qty'], 40)
        self.assertEqual(machining_table['rows'][0]['actual_qty'], 40)
