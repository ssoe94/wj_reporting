from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from .browser_direct_import import DIRECT_DELIVERY_MODE
from .incremental_import import INCREMENTAL_JOB_DATASET_KEY
from .models import QualityImportBatch, QualityImportRow, QualityReport


class QualityReportBulkDeleteTests(APITestCase):
    def setUp(self):
        self.editor = self._user('quality-bulk-delete-editor', view=True, edit=True)
        self.viewer = self._user('quality-bulk-delete-viewer', view=True, edit=False)
        self.url = reverse('quality-report-bulk-delete')

    @staticmethod
    def _user(username: str, *, view: bool, edit: bool):
        user = get_user_model().objects.create_user(
            username=username,
            password='test-password',
        )
        user.profile.can_view_quality = view
        user.profile.can_edit_quality = edit
        user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        return user

    @staticmethod
    def _report(*, suffix: str, images: int = 0) -> QualityReport:
        image_urls = {
            f'image{index}': f'https://res.cloudinary.com/example/image/upload/quality/{suffix}-{index}.jpg'
            for index in range(1, images + 1)
        }
        return QualityReport.objects.create(
            report_dt=timezone.now(),
            section='OQC',
            model=f'MODEL-{suffix}',
            part_no=f'PART-{suffix}',
            judgement='NG',
            phenomenon=f'phenomenon-{suffix}',
            **image_urls,
        )

    def _post(self, ids: list[int], *, confirmation: str | None = None):
        return self.client.post(
            self.url,
            {
                'ids': ids,
                'confirmation': confirmation or f'DELETE_REPORTS:{len(ids)}',
            },
            format='json',
        )

    def _batch(
        self,
        *,
        suffix: str,
        status: str = QualityImportBatch.Status.READY,
        result_report_ids: list[int] | None = None,
        phase: str = 'ready',
        dataset_key: str = INCREMENTAL_JOB_DATASET_KEY,
    ) -> QualityImportBatch:
        report_ids = list(result_report_ids or [])
        return QualityImportBatch.objects.create(
            uploaded_by=self.editor,
            original_filename=f'quality-{suffix}.xlsx',
            sha256=(suffix[0] * 64),
            import_scope_key=f'bdi:{suffix[:28]}',
            file_size=1024,
            dataset_key=dataset_key,
            status=status,
            phase=phase,
            progress_done=7,
            progress_total=7,
            last_heartbeat_at=timezone.now(),
            processing_owner=f'owner-{suffix}',
            lease_expires_at=timezone.now() + timedelta(minutes=5),
            next_attempt_at=timezone.now() + timedelta(minutes=1),
            results_persisted_at=timezone.now(),
            delta_summary={
                'delivery_mode': DIRECT_DELIVERY_MODE,
                'incremental_result': {
                    'created_report_ids': report_ids,
                    'skipped_report_ids': [],
                    'changed_report_ids': [],
                    'rows': [],
                },
                'preserved_checkpoint': suffix,
            },
        )

    @staticmethod
    def _published_row(
        *,
        batch: QualityImportBatch,
        report: QualityReport,
        suffix: str,
        reviewed_by,
    ) -> QualityImportRow:
        now = timezone.now()
        return QualityImportRow.objects.create(
            batch=batch,
            sheet_name='8月',
            sheet_role='monthly_issue',
            source_row_number=3,
            source_sequence=suffix,
            source_key=(suffix[0] * 64),
            business_key=(suffix[-1] * 64),
            content_sha256=((suffix[0] + suffix[-1]) * 32),
            reviewed_content_sha256=('f' * 64),
            report_date=report.report_dt.date(),
            section=report.section,
            model=report.model,
            part_no=report.part_no,
            phenomenon=report.phenomenon,
            review_status=QualityImportRow.ReviewStatus.PUBLISHED,
            reviewed_by=reviewed_by,
            reviewed_at=now,
            approved_report=report,
            published_at=now,
        )

    def test_editor_permission_is_required(self):
        report = self._report(suffix='permission')

        self.client.force_authenticate(self.viewer)
        forbidden = self._post([report.pk])

        self.assertEqual(forbidden.status_code, 403, forbidden.data)
        self.assertTrue(QualityReport.objects.filter(pk=report.pk).exists())

    def test_update_fails_closed_when_report_disappears_before_write_lock(self):
        report = self._report(suffix='concurrent-update')
        detail_url = reverse('quality-report-detail', args=[report.pk])
        self.client.force_authenticate(self.editor)

        with mock.patch(
            'quality.views.QualityReport.objects.select_for_update',
        ) as select_for_update:
            select_for_update.return_value.get.side_effect = QualityReport.DoesNotExist
            response = self.client.patch(
                detail_url,
                {'part_no': 'part-resurrected'},
                format='json',
            )

        self.assertEqual(response.status_code, 404, response.data)
        report.refresh_from_db()
        self.assertEqual(report.part_no, 'PART-CONCURRENT-UPDATE')

    def test_rejects_malformed_or_unsafe_selection(self):
        report = self._report(suffix='invalid')
        self.client.force_authenticate(self.editor)
        cases = (
            ('missing ids', {'confirmation': 'DELETE_REPORTS:0'}),
            ('empty ids', {'ids': [], 'confirmation': 'DELETE_REPORTS:0'}),
            ('non-list ids', {'ids': str(report.pk), 'confirmation': 'DELETE_REPORTS:1'}),
            ('duplicate ids', {'ids': [report.pk, report.pk], 'confirmation': 'DELETE_REPORTS:2'}),
            ('boolean id', {'ids': [True], 'confirmation': 'DELETE_REPORTS:1'}),
            ('zero id', {'ids': [0], 'confirmation': 'DELETE_REPORTS:1'}),
            ('negative id', {'ids': [-1], 'confirmation': 'DELETE_REPORTS:1'}),
            (
                'id beyond database range',
                {
                    'ids': [9_223_372_036_854_775_808],
                    'confirmation': 'DELETE_REPORTS:1',
                },
            ),
            (
                'over one hundred ids',
                {'ids': list(range(1, 102)), 'confirmation': 'DELETE_REPORTS:101'},
            ),
            ('wrong confirmation', {'ids': [report.pk], 'confirmation': 'DELETE_REPORTS:2'}),
        )

        for label, payload in cases:
            with self.subTest(label=label):
                response = self.client.post(self.url, payload, format='json')
                self.assertEqual(response.status_code, 400, response.data)
                self.assertTrue(QualityReport.objects.filter(pk=report.pk).exists())

    def test_missing_id_rejects_entire_selection_atomically(self):
        selected = self._report(suffix='scope-selected')
        preserved = self._report(suffix='scope-preserved')
        missing_id = max(selected.pk, preserved.pk) + 10_000
        self.client.force_authenticate(self.editor)

        response = self._post([selected.pk, missing_id])

        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data['code'], 'bulk_delete_scope_changed')
        self.assertTrue(QualityReport.objects.filter(pk=selected.pk).exists())
        self.assertTrue(QualityReport.objects.filter(pk=preserved.pk).exists())

    def test_success_deletes_exact_selection_and_defers_remote_image_cleanup(self):
        first = self._report(suffix='first', images=2)
        second = self._report(suffix='second')
        preserved = self._report(suffix='preserved', images=1)
        self.client.force_authenticate(self.editor)

        with (
            mock.patch('cloudinary.uploader.destroy') as destroy,
            mock.patch('cloudinary.api.delete_resources') as delete_resources,
        ):
            response = self._post([second.pk, first.pk])

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['deleted_count'], 2)
        self.assertEqual(response.data['deleted_report_ids'], sorted([first.pk, second.pk]))
        self.assertEqual(response.data['deleted_image_references'], 2)
        self.assertEqual(response.data['reset_incremental_jobs'], 0)
        self.assertEqual(response.data['remote_image_cleanup'], 'deferred')
        self.assertFalse(QualityReport.objects.filter(pk__in=[first.pk, second.pk]).exists())
        self.assertTrue(QualityReport.objects.filter(pk=preserved.pk).exists())
        destroy.assert_not_called()
        delete_resources.assert_not_called()

    def test_success_without_images_reports_cleanup_not_required(self):
        report = self._report(suffix='no-image')
        self.client.force_authenticate(self.editor)

        response = self._post([report.pk])

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['deleted_image_references'], 0)
        self.assertEqual(response.data['remote_image_cleanup'], 'not_required')

    def test_exactly_one_hundred_unique_reports_are_allowed(self):
        reports = [self._report(suffix=f'boundary-{index}') for index in range(100)]
        report_ids = [report.pk for report in reports]
        self.client.force_authenticate(self.editor)

        response = self._post(list(reversed(report_ids)))

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['deleted_count'], 100)
        self.assertEqual(response.data['deleted_report_ids'], sorted(report_ids))
        self.assertFalse(QualityReport.objects.filter(pk__in=report_ids).exists())

    def test_each_active_incremental_job_kind_blocks_deletion(self):
        report = self._report(suffix='active-job')
        self.client.force_authenticate(self.editor)
        active_jobs = (
            (
                'queued',
                QualityImportBatch.Status.QUEUED,
                {'phase': 'queued'},
            ),
            (
                'processing',
                QualityImportBatch.Status.PROCESSING,
                {'phase': 'processing'},
            ),
            (
                'leased browser-direct staging',
                QualityImportBatch.Status.STAGING,
                {'phase': 'awaiting_browser_upload'},
            ),
        )

        for index, (label, job_status, extra) in enumerate(active_jobs):
            with self.subTest(label=label):
                QualityImportBatch.objects.all().delete()
                batch = self._batch(
                    suffix=f'{index + 1}active',
                    status=job_status,
                    phase=extra['phase'],
                )
                response = self._post([report.pk])
                self.assertEqual(response.status_code, 409, response.data)
                self.assertEqual(response.data['code'], 'bulk_delete_jobs_active')
                self.assertTrue(QualityReport.objects.filter(pk=report.pk).exists())
                self.assertTrue(QualityImportBatch.objects.filter(pk=batch.pk).exists())

    def test_terminal_incremental_checkpoints_are_reset_without_deleting_jobs_or_rows(self):
        selected = self._report(suffix='terminal-selected', images=1)
        preserved = self._report(suffix='terminal-preserved')

        linked_batch = self._batch(
            suffix='alinked',
            status=QualityImportBatch.Status.READY_WITH_WARNINGS,
            result_report_ids=[],
        )
        linked_row = self._published_row(
            batch=linked_batch,
            report=selected,
            suffix='linked',
            reviewed_by=self.editor,
        )
        result_only_batch = self._batch(
            suffix='bresultonly',
            status=QualityImportBatch.Status.READY,
            result_report_ids=[selected.pk],
        )
        preserved_batch = self._batch(
            suffix='cpreserved',
            status=QualityImportBatch.Status.READY,
            result_report_ids=[preserved.pk],
        )
        preserved_row = self._published_row(
            batch=preserved_batch,
            report=preserved,
            suffix='preserved',
            reviewed_by=self.editor,
        )
        preserved_summary = preserved_batch.delta_summary
        self.client.force_authenticate(self.editor)

        response = self._post([selected.pk])

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['reset_incremental_jobs'], 2)
        self.assertFalse(QualityReport.objects.filter(pk=selected.pk).exists())
        self.assertTrue(QualityReport.objects.filter(pk=preserved.pk).exists())

        self.assertTrue(QualityImportBatch.objects.filter(pk=linked_batch.pk).exists())
        self.assertTrue(QualityImportBatch.objects.filter(pk=result_only_batch.pk).exists())
        self.assertTrue(QualityImportRow.objects.filter(pk=linked_row.pk).exists())
        for batch in (linked_batch, result_only_batch):
            batch.refresh_from_db()
            self.assertEqual(batch.status, QualityImportBatch.Status.FAILED)
            self.assertEqual(batch.phase, 'reports_deleted')
            self.assertIsNone(batch.delta_summary.get('incremental_result'))
            self.assertEqual(batch.processing_owner, '')
            self.assertIsNone(batch.last_heartbeat_at)
            self.assertIsNone(batch.lease_expires_at)
            self.assertIsNone(batch.next_attempt_at)
            self.assertIsNone(batch.results_persisted_at)

        linked_row.refresh_from_db()
        self.assertEqual(linked_row.review_status, QualityImportRow.ReviewStatus.DRAFT)
        self.assertEqual(linked_row.reviewed_content_sha256, '')
        self.assertIsNone(linked_row.reviewed_by_id)
        self.assertIsNone(linked_row.reviewed_at)
        self.assertIsNone(linked_row.approved_report_id)
        self.assertIsNone(linked_row.published_at)

        preserved_batch.refresh_from_db()
        preserved_row.refresh_from_db()
        self.assertEqual(preserved_batch.status, QualityImportBatch.Status.READY)
        self.assertEqual(preserved_batch.phase, 'ready')
        self.assertEqual(preserved_batch.delta_summary, preserved_summary)
        self.assertEqual(preserved_row.review_status, QualityImportRow.ReviewStatus.PUBLISHED)
        self.assertEqual(preserved_row.approved_report_id, preserved.pk)
        self.assertEqual(preserved_row.reviewed_by_id, self.editor.pk)
        self.assertIsNotNone(preserved_row.reviewed_at)
        self.assertIsNotNone(preserved_row.published_at)

    def test_legacy_import_row_is_reset_without_invalidating_legacy_batch(self):
        selected = self._report(suffix='legacy-selected')
        legacy_batch = self._batch(
            suffix='legacybatch',
            dataset_key='quality_issue_workbook',
            status=QualityImportBatch.Status.READY,
            result_report_ids=[selected.pk],
        )
        legacy_row = self._published_row(
            batch=legacy_batch,
            report=selected,
            suffix='legacyrow',
            reviewed_by=self.editor,
        )
        original_summary = legacy_batch.delta_summary
        self.client.force_authenticate(self.editor)

        response = self._post([selected.pk])

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['reset_incremental_jobs'], 0)
        self.assertFalse(QualityReport.objects.filter(pk=selected.pk).exists())

        legacy_row.refresh_from_db()
        self.assertEqual(legacy_row.review_status, QualityImportRow.ReviewStatus.DRAFT)
        self.assertIsNone(legacy_row.approved_report_id)
        self.assertEqual(legacy_row.reviewed_content_sha256, '')
        self.assertIsNone(legacy_row.reviewed_by_id)
        self.assertIsNone(legacy_row.reviewed_at)
        self.assertIsNone(legacy_row.published_at)

        legacy_batch.refresh_from_db()
        self.assertEqual(legacy_batch.status, QualityImportBatch.Status.READY)
        self.assertEqual(legacy_batch.phase, 'ready')
        self.assertEqual(legacy_batch.delta_summary, original_summary)
