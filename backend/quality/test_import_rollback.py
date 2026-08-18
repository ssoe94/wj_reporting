from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from .incremental_import import INCREMENTAL_JOB_DATASET_KEY
from .models import QualityImportBatch, QualityImportRow, QualityReport


SHANGHAI = ZoneInfo('Asia/Shanghai')


class QualityExcelRollbackTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.staff = get_user_model().objects.create_user(
            username='quality-rollback-admin',
            password='test-password',
            is_staff=True,
        )
        self.editor = get_user_model().objects.create_user(
            username='quality-rollback-editor',
            password='test-password',
        )
        self.editor.profile.can_view_quality = True
        self.editor.profile.can_edit_quality = True
        self.editor.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        self.url = reverse('quality-excel-import-rollback-today')
        self.now = datetime(2026, 8, 18, 14, 30, tzinfo=SHANGHAI)

    def report(self, *, excel=False, created_at=None):
        report = QualityReport.objects.create(
            report_dt=datetime(2026, 8, 15, 8, 0, tzinfo=SHANGHAI),
            section='OQC',
            model='27G523B',
            part_no='ACQ30854201',
            judgement='NG',
            phenomenon='扫码标签用错',
            excel_import_key=('a' * 63 + str(QualityReport.objects.count() % 10)) if excel else None,
            excel_source=(
                {
                    'source_filename': '品质 Issue List - 8月.xlsx',
                    'sheet_name': '8月',
                    'source_row_number': 3,
                }
                if excel else {}
            ),
        )
        QualityReport.objects.filter(pk=report.pk).update(created_at=created_at or self.now)
        report.refresh_from_db()
        return report

    @mock.patch('quality.import_views.timezone.now')
    def test_preview_and_confirm_delete_only_today_excel_reports(self, mocked_now):
        mocked_now.return_value = self.now
        excel_report = self.report(excel=True)
        manual_report = self.report(excel=False)
        old_excel_report = self.report(
            excel=True,
            created_at=datetime(2026, 8, 17, 23, 59, tzinfo=SHANGHAI),
        )
        self.client.force_authenticate(self.staff)

        preview = self.client.get(self.url)

        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.data['target_date'], '2026-08-18')
        self.assertEqual(preview.data['count'], 1)
        self.assertEqual(preview.data['manual_reports_preserved'], 1)
        self.assertEqual(preview.data['source_groups'][0]['count'], 1)

        deleted = self.client.post(
            self.url,
            {
                'target_date': '2026-08-18',
                'expected_count': 1,
                'confirmation': 'DELETE:2026-08-18:1',
            },
            format='json',
        )

        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.data['deleted_count'], 1)
        self.assertFalse(QualityReport.objects.filter(pk=excel_report.pk).exists())
        self.assertTrue(QualityReport.objects.filter(pk=manual_report.pk).exists())
        self.assertTrue(QualityReport.objects.filter(pk=old_excel_report.pk).exists())

    @mock.patch('quality.import_views.timezone.now')
    def test_count_change_blocks_delete_and_editor_is_forbidden(self, mocked_now):
        mocked_now.return_value = self.now
        report = self.report(excel=True)
        self.client.force_authenticate(self.editor)
        self.assertEqual(self.client.get(self.url).status_code, 403)

        self.client.force_authenticate(self.staff)
        response = self.client.post(
            self.url,
            {
                'target_date': '2026-08-18',
                'expected_count': 0,
                'confirmation': 'DELETE:2026-08-18:0',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 409)
        self.assertTrue(QualityReport.objects.filter(pk=report.pk).exists())

    @mock.patch('quality.import_views.timezone.now')
    def test_rollback_removes_terminal_incremental_job_checkpoint(self, mocked_now):
        mocked_now.return_value = self.now
        report = self.report(excel=True)
        batch = QualityImportBatch.objects.create(
            uploaded_by=self.staff,
            original_filename='品质 Issue List - 8月.xlsx',
            sha256='b' * 64,
            import_scope_key='inc:' + ('c' * 28),
            file_size=12_345,
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
            status=QualityImportBatch.Status.READY,
            phase='ready',
        )
        QualityImportRow.objects.create(
            batch=batch,
            sheet_name='8月',
            sheet_role='monthly_issue',
            source_row_number=3,
            source_sequence='1',
            source_key='d' * 64,
            business_key=report.excel_import_key,
            content_sha256='e' * 64,
            report_date=report.report_dt.date(),
            section='OQC',
            model=report.model,
            part_no=report.part_no,
            phenomenon=report.phenomenon,
            review_status=QualityImportRow.ReviewStatus.PUBLISHED,
            approved_report=report,
        )
        self.client.force_authenticate(self.staff)
        preview = self.client.get(self.url)

        deleted = self.client.post(
            self.url,
            {
                'target_date': '2026-08-18',
                'expected_count': preview.data['count'],
                'confirmation': f'DELETE:2026-08-18:{preview.data["count"]}',
            },
            format='json',
        )

        self.assertEqual(deleted.status_code, 200, deleted.data)
        self.assertEqual(deleted.data['deleted_incremental_jobs'], 1)
        self.assertFalse(QualityImportBatch.objects.filter(pk=batch.pk).exists())
        # The unique workbook/chunk checkpoint is free for a safe re-import.
        recreated = QualityImportBatch.objects.create(
            uploaded_by=self.staff,
            original_filename='品质 Issue List - 8月.xlsx',
            sha256='b' * 64,
            import_scope_key='inc:' + ('c' * 28),
            file_size=12_345,
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
        )
        self.assertIsNotNone(recreated.pk)

    @mock.patch('quality.import_views.timezone.now')
    def test_prior_day_active_incremental_job_blocks_rollback(self, mocked_now):
        mocked_now.return_value = self.now
        report = self.report(excel=True)
        batch = QualityImportBatch.objects.create(
            uploaded_by=self.staff,
            original_filename='yesterday.xlsx',
            sha256='f' * 64,
            import_scope_key='inc:' + ('1' * 28),
            file_size=12_345,
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
            status=QualityImportBatch.Status.QUEUED,
            phase='queued',
        )
        QualityImportBatch.objects.filter(pk=batch.pk).update(
            created_at=datetime(2026, 8, 17, 23, 50, tzinfo=SHANGHAI),
        )
        self.client.force_authenticate(self.staff)
        preview = self.client.get(self.url)
        self.assertEqual(preview.data['active_incremental_jobs'], 1)

        response = self.client.post(
            self.url,
            {
                'target_date': '2026-08-18',
                'expected_count': preview.data['count'],
                'confirmation': f'DELETE:2026-08-18:{preview.data["count"]}',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data['code'], 'rollback_jobs_active')
        self.assertTrue(QualityReport.objects.filter(pk=report.pk).exists())

    @mock.patch('quality.import_views.timezone.now')
    def test_rollback_removes_terminal_job_with_stale_skipped_report_id(self, mocked_now):
        mocked_now.return_value = self.now
        report = self.report(excel=True)
        skipped_job = QualityImportBatch.objects.create(
            uploaded_by=self.staff,
            original_filename='prior-workbook.xlsx',
            sha256='2' * 64,
            import_scope_key='inc:' + ('3' * 28),
            file_size=12_345,
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
            status=QualityImportBatch.Status.READY,
            phase='ready',
            delta_summary={
                'incremental_result': {
                    'created_report_ids': [],
                    'skipped_report_ids': [report.pk],
                    'changed_report_ids': [],
                },
            },
        )
        QualityImportBatch.objects.filter(pk=skipped_job.pk).update(
            created_at=datetime(2026, 8, 17, 20, 0, tzinfo=SHANGHAI),
        )
        self.client.force_authenticate(self.staff)
        preview = self.client.get(self.url)

        response = self.client.post(
            self.url,
            {
                'target_date': '2026-08-18',
                'expected_count': preview.data['count'],
                'confirmation': f'DELETE:2026-08-18:{preview.data["count"]}',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(QualityImportBatch.objects.filter(pk=skipped_job.pk).exists())
        self.assertFalse(QualityReport.objects.filter(pk=report.pk).exists())

    @mock.patch('quality.import_views.timezone.now')
    def test_manual_reports_linked_during_review_are_preserved(self, mocked_now):
        mocked_now.return_value = self.now
        excel_report = self.report(excel=True)
        linked_manual = self.report(excel=False)
        updated_manual = self.report(excel=False)
        batch = QualityImportBatch.objects.create(
            uploaded_by=self.staff,
            original_filename='review.xlsx',
            sha256='4' * 64,
            import_scope_key='full',
            file_size=12_345,
            status=QualityImportBatch.Status.READY,
            phase='ready',
        )
        for index, (manual_report, reason) in enumerate((
            (linked_manual, 'link_existing:confirmed'),
            (updated_manual, 'update_existing:confirmed'),
        ), start=1):
            QualityImportRow.objects.create(
                batch=batch,
                sheet_name='8月',
                sheet_role='monthly_issue',
                source_row_number=index + 2,
                source_sequence=str(index),
                source_key=str(index) * 64,
                business_key=str(index + 4) * 64,
                content_sha256=str(index + 6) * 64,
                report_date=manual_report.report_dt.date(),
                section='OQC',
                model=manual_report.model,
                part_no=manual_report.part_no,
                phenomenon=manual_report.phenomenon,
                duplicate_override_reason=reason,
                review_status=QualityImportRow.ReviewStatus.PUBLISHED,
                approved_report=manual_report,
            )
        self.client.force_authenticate(self.staff)
        preview = self.client.get(self.url)

        self.assertEqual(preview.data['count'], 1)
        self.assertEqual(preview.data['manual_reports_preserved'], 2)
        response = self.client.post(
            self.url,
            {
                'target_date': '2026-08-18',
                'expected_count': 1,
                'confirmation': 'DELETE:2026-08-18:1',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(QualityReport.objects.filter(pk=excel_report.pk).exists())
        self.assertTrue(QualityReport.objects.filter(pk=linked_manual.pk).exists())
        self.assertTrue(QualityReport.objects.filter(pk=updated_manual.pk).exists())
