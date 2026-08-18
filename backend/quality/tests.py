from __future__ import annotations

import hashlib
import tempfile
from datetime import date, datetime, timedelta
from io import BytesIO, StringIO
from unittest import mock
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import override_settings
from django.urls import NoReverseMatch, reverse
from django.utils import timezone
from openpyxl import Workbook
from openpyxl.drawing.image import Image as ExcelImage
from PIL import Image as PillowImage
from rest_framework.test import APITestCase

from .excel_import import (
    WorkbookValidationError,
    _image_dimensions,
    _normalize_image_content,
    process_quality_import_batch,
    recover_stale_quality_imports,
)
from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportProvenance,
    QualityImportRow,
    QualityReport,
)


class QualityReportPermissionTests(APITestCase):
    def setUp(self):
        self.viewer = get_user_model().objects.create_user(
            username='quality-viewer',
            password='test-password',
        )
        self.viewer.profile.can_view_quality = True
        self.viewer.profile.can_edit_quality = False
        self.viewer.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])

        self.editor = get_user_model().objects.create_user(
            username='quality-report-editor',
            password='test-password',
        )
        self.editor.profile.can_view_quality = True
        self.editor.profile.can_edit_quality = True
        self.editor.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])

        self.hidden_user = get_user_model().objects.create_user(
            username='quality-hidden-user',
            password='test-password',
        )
        self.hidden_user.profile.can_view_quality = False
        self.hidden_user.profile.can_edit_quality = False
        self.hidden_user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])

        self.report = QualityReport.objects.create(
            report_dt=timezone.now(),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30776301',
            judgement='NG',
            phenomenon='表面色差',
            action_result='확인 중',
        )
        self.list_url = reverse('quality-report-list')
        self.by_ids_url = reverse('quality-report-by-ids')
        self.detail_url = reverse('quality-report-detail', args=[self.report.pk])

    def test_view_permission_allows_read_but_denies_report_and_supporting_writes(self):
        self.client.force_authenticate(self.viewer)

        self.assertEqual(self.client.get(self.list_url).status_code, 200)
        self.assertEqual(
            self.client.patch(self.detail_url, {'action_result': '변경'}, format='json').status_code,
            403,
        )
        self.assertEqual(self.client.delete(self.detail_url).status_code, 403)
        self.assertEqual(
            self.client.post(self.list_url, {'report_dt': timezone.now().isoformat()}, format='json').status_code,
            403,
        )
        self.assertEqual(self.client.get(reverse('supplier-list')).status_code, 200)
        self.assertEqual(
            self.client.post(reverse('supplier-list'), {'name': 'restricted'}, format='json').status_code,
            403,
        )
        self.assertEqual(
            self.client.post(reverse('cloudinary-signature'), {'folder': 'quality'}, format='json').status_code,
            403,
        )
        self.assertEqual(
            self.client.post(reverse('quality-excel-import'), {}, format='multipart').status_code,
            403,
        )

    def test_editor_can_update_and_delete_report(self):
        self.client.force_authenticate(self.editor)

        response = self.client.patch(
            self.detail_url,
            {'action_result': '조치 완료'},
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.report.refresh_from_db()
        self.assertEqual(self.report.action_result, '조치 완료')
        self.assertEqual(self.client.delete(self.detail_url).status_code, 204)

    def test_report_list_can_be_scoped_to_import_result_ids(self):
        other = QualityReport.objects.create(
            report_dt=timezone.now(),
            section='OQC',
            model='32QN600',
            part_no='ABJ76507611',
            phenomenon='表面脏 灰',
        )
        self.client.force_authenticate(self.viewer)

        response = self.client.get(self.list_url, {'ids': str(other.pk), 'page_size': 500})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['id'], other.pk)
        invalid = self.client.get(self.list_url, {'ids': '1,not-an-id'})
        self.assertEqual(invalid.status_code, 400, invalid.data)

        over_legacy_limit = self.client.get(
            self.list_url,
            {'ids': ','.join(str(value) for value in range(1, 502))},
        )
        self.assertEqual(over_legacy_limit.status_code, 400, over_legacy_limit.data)

    def test_report_list_by_ids_uses_read_permission_ordering_and_pagination(self):
        older = QualityReport.objects.create(
            report_dt=timezone.now() - timedelta(days=2),
            section='OQC',
            model='OLDER',
            part_no='OLD-01',
            phenomenon='older report',
        )
        newest = QualityReport.objects.create(
            report_dt=timezone.now() + timedelta(days=2),
            section='OQC',
            model='NEWEST',
            part_no='NEW-01',
            phenomenon='newest report',
        )
        excluded = QualityReport.objects.create(
            report_dt=timezone.now() + timedelta(days=3),
            section='OQC',
            model='EXCLUDED',
            part_no='EXCLUDED-01',
            phenomenon='excluded report',
        )
        self.client.force_authenticate(self.viewer)

        first_page = self.client.post(
            f'{self.by_ids_url}?page_size=2',
            {'ids': [older.pk, self.report.pk, newest.pk]},
            format='json',
        )

        self.assertEqual(first_page.status_code, 200, first_page.data)
        self.assertEqual(first_page.data['count'], 3)
        self.assertEqual(len(first_page.data['results']), 2)
        self.assertEqual(first_page.data['results'][0]['id'], newest.pk)
        self.assertNotIn(excluded.pk, [item['id'] for item in first_page.data['results']])
        self.assertIsNotNone(first_page.data['next'])

        second_page = self.client.post(
            f'{self.by_ids_url}?page_size=2&page=2',
            {'ids': [older.pk, self.report.pk, newest.pk]},
            format='json',
        )
        self.assertEqual(second_page.status_code, 200, second_page.data)
        returned_ids = {
            item['id']
            for item in [*first_page.data['results'], *second_page.data['results']]
        }
        self.assertEqual(returned_ids, {older.pk, self.report.pk, newest.pk})

    def test_report_list_by_ids_accepts_ten_thousand_unique_ids(self):
        self.client.force_authenticate(self.viewer)

        response = self.client.post(
            self.by_ids_url,
            {'ids': list(range(1, 10_001))},
            format='json',
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['id'], self.report.pk)

    def test_report_list_by_ids_rejects_invalid_id_arrays(self):
        self.client.force_authenticate(self.viewer)
        invalid_payloads = (
            {},
            {'ids': '1,2'},
            {'ids': [1, True]},
            {'ids': [1, 0]},
            {'ids': [1, -2]},
            {'ids': [1, 1]},
            {'ids': [9_223_372_036_854_775_808]},
            {'ids': list(range(1, 10_002))},
        )

        for payload in invalid_payloads:
            with self.subTest(payload_type=type(payload.get('ids')).__name__):
                response = self.client.post(self.by_ids_url, payload, format='json')
                self.assertEqual(response.status_code, 400, response.data)

    def test_report_list_by_ids_remains_fail_closed(self):
        self.client.force_authenticate(self.hidden_user)
        self.assertEqual(
            self.client.post(self.by_ids_url, {'ids': [self.report.pk]}, format='json').status_code,
            403,
        )

        no_profile = get_user_model().objects.create_user(
            username='quality-by-ids-no-profile',
            password='test-password',
        )
        no_profile.profile.delete()
        self.client.force_authenticate(no_profile)
        self.assertEqual(
            self.client.post(self.by_ids_url, {'ids': [self.report.pk]}, format='json').status_code,
            403,
        )

    def test_quality_access_is_fail_closed_without_view_permission_or_profile(self):
        self.client.force_authenticate(self.hidden_user)
        self.assertEqual(self.client.get(self.list_url).status_code, 403)

        no_profile = get_user_model().objects.create_user(
            username='quality-no-profile',
            password='test-password',
        )
        no_profile.profile.delete()
        self.client.force_authenticate(no_profile)
        self.assertEqual(self.client.get(self.list_url).status_code, 403)


def build_quality_workbook(
    *,
    workbook_title='quality-source',
    phenomenon='顶部拉白',
    part_no='acq30854201',
    include_image=True,
    issue_count=1,
    phenomena=None,
    image_rows=None,
    unique_images=False,
    issue_date=8.03,
    oqc_date=1.15,
) -> bytes:
    workbook = Workbook()
    workbook.properties.title = workbook_title
    issue = workbook.active
    issue.title = '8月'
    issue.append([None, '万佳品质问题点Issue'])
    issue.append([
        None, '序号', '发生日期', '发生场所', 'Mold', 'P/N', 'Item',
        '不良现象', '不良数量', '不良照片', '备注',
    ])
    for index in range(1, issue_count + 1):
        row_phenomenon = phenomena[index - 1] if phenomena else phenomenon
        issue.append([
            None, index, issue_date, '注塑', '27G523', f'{part_no}{index}' if issue_count > 1 else part_no,
            'B/C', row_phenomenon, 'Lot数：8\n不良数：2', None, '刚生产',
        ])
    if include_image:
        for image_index, row_number in enumerate(image_rows or (3,)):
            image_buffer = BytesIO()
            color = (20 + image_index, 120, 220) if unique_images else (20, 120, 220)
            PillowImage.new('RGB', (12, 8), color=color).save(image_buffer, format='PNG')
            image_content = image_buffer.getvalue()
            issue.add_image(ExcelImage(BytesIO(image_content)), f'J{row_number}')

    oqc = workbook.create_sheet('OQC出库不良 返工list')
    oqc.append([None, '2026年 OQC 出库不良 LIST'])
    oqc.append([
        None, 'NO', '检查日期', '型号', 'P/N', '品名', '数量',
        '生产日期', '不良类型', '对应部门', '处理结果', '备注',
    ])
    oqc.append([
        None, 1, oqc_date, '32QN600', 'ABJ76507611', 'C/A', 3,
        '26.1.19', '表面脏 灰', '注塑', '已处理', '复检完成',
    ])
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


@override_settings(
    QUALITY_IMPORT_ALLOW_LOCAL_PROXY=True,
    QUALITY_IMPORT_DISABLE_BACKGROUND_PUMP=True,
)
class QualityWorkbookImportAPITests(APITestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_field = QualityImportAsset._meta.get_field('file')
        self.original_storage = self.media_field.storage
        self.storage = FileSystemStorage(location=self.temp_dir.name, base_url='/test-media/')
        self.media_field.storage = self.storage
        self.user = get_user_model().objects.create_user(
            username='quality-editor',
            password='test-password',
        )
        self.user.profile.can_view_quality = True
        self.user.profile.can_edit_quality = True
        self.user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        self.client.force_authenticate(self.user)
        self.url = reverse('quality-import-batch-list')
        self.workbook = build_quality_workbook()

    def tearDown(self):
        self.media_field.storage = self.original_storage
        self.temp_dir.cleanup()

    def upload(
        self,
        content=None,
        *,
        filename='品质 Issue List - 8月.xlsx',
        content_type=None,
        import_mode='full',
        range_start=None,
        range_end=None,
    ):
        content = self.workbook if content is None else content
        payload = {
            'file': SimpleUploadedFile(
                filename,
                content,
                content_type=content_type or 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ),
            'import_mode': import_mode,
        }
        if range_start is not None:
            payload['range_start'] = range_start
        if range_end is not None:
            payload['range_end'] = range_end
        return self.client.post(
            self.url,
            payload,
            format='multipart',
        )

    def test_single_post_atomically_stages_rows_and_normalized_images(self):
        response = self.upload()

        self.assertEqual(response.status_code, 202, response.data)
        self.assertFalse(response.data['idempotent_replay'])
        self.assertNotIn('chunk_count', response.data)
        self.assertNotIn('uploaded_chunks', response.data)
        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        self.assertEqual(batch.status, QualityImportBatch.Status.QUEUED)
        self.assertEqual(batch.total_rows, 2)
        self.assertEqual(batch.total_media, 1)
        self.assertEqual(batch.rows.count(), 2)
        self.assertEqual(batch.provenance.source_sha256, hashlib.sha256(self.workbook).hexdigest())
        self.assertIsNotNone(batch.provenance.source_discarded_at)
        self.assertEqual(QualityReport.objects.count(), 0)
        asset = QualityImportAsset.objects.get()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertTrue(asset.staged_bytes)
        self.assertFalse(asset.file)
        rows = self.client.get(reverse('quality-import-batch-rows', kwargs={'pk': batch.pk}))
        self.assertEqual(rows.status_code, 409, rows.data)

        process_quality_import_batch(batch.pk)

        batch.refresh_from_db()
        asset.refresh_from_db()
        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)
        self.assertIsNone(asset.staged_bytes)
        self.assertTrue(asset.file.name)
        with asset.file.open('rb') as stored:
            self.assertEqual(hashlib.sha256(stored.read()).hexdigest(), asset.sha256)
        issue = batch.rows.get(sheet_name='8月')
        self.assertEqual(issue.part_no, 'ACQ30854201')
        self.assertEqual(issue.lot_qty, 8)
        self.assertEqual(issue.media.get().asset_id, asset.pk)

    def test_date_range_persists_only_selected_rows_and_linked_media(self):
        response = self.upload(
            import_mode='date_range',
            range_start='2026-08-03',
            range_end='2026-08-03',
        )

        self.assertEqual(response.status_code, 202, response.data)
        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        self.assertEqual(batch.source_total_rows, 2)
        self.assertEqual(batch.total_rows, 1)
        self.assertEqual(batch.total_media, 1)
        self.assertEqual(list(batch.rows.values_list('report_date', flat=True)), [date(2026, 8, 3)])
        scope = batch.delta_summary['selection_scope']
        self.assertEqual(scope, {
            'mode': 'date_range',
            'range_start': '2026-08-03',
            'range_end': '2026-08-03',
            'source_total_rows': 2,
            'selected_rows': 1,
            'retained_rows': 1,
            'excluded_rows': 1,
            'undated_rows': 0,
        })
        self.assertEqual(batch.provenance.workbook_properties['selection_scope'], scope)

    def test_date_range_retains_undated_rows_and_photos_for_review(self):
        workbook = build_quality_workbook(workbook_title='undated', issue_date=None)
        response = self.upload(
            content=workbook,
            import_mode='date_range',
            range_start='2026-08-17',
            range_end='2026-08-17',
        )
        self.assertEqual(response.status_code, 202, response.data)
        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        self.assertEqual(batch.total_rows, 1)
        self.assertEqual(batch.total_media, 1)
        row = batch.rows.get()
        self.assertIsNone(row.report_date)
        self.assertIn('missing_report_date', row.warnings)
        scope = batch.delta_summary['selection_scope']
        self.assertEqual(scope['selected_rows'], 0)
        self.assertEqual(scope['retained_rows'], 1)
        self.assertEqual(scope['undated_rows'], 1)
        self.assertEqual(scope['excluded_rows'], 1)

        process_quality_import_batch(batch.id)
        repeated = self.upload(
            content=workbook,
            import_mode='date_range',
            range_start='2026-08-18',
            range_end='2026-08-18',
        )
        self.assertEqual(repeated.status_code, 202, repeated.data)
        repeated_row = QualityImportBatch.objects.get(pk=repeated.data['id']).rows.get()
        self.assertEqual(repeated_row.delta_status, QualityImportRow.DeltaStatus.UNCHANGED)
        self.assertEqual(repeated_row.review_status, QualityImportRow.ReviewStatus.UNCHANGED)

    def test_date_range_validation_and_exact_source_can_be_reused_for_another_scope(self):
        missing_mode = self.client.post(
            self.url,
            {
                'file': SimpleUploadedFile(
                    'quality.xlsx',
                    self.workbook,
                    content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ),
            },
            format='multipart',
        )
        self.assertEqual(missing_mode.status_code, 400, missing_mode.data)
        self.assertEqual(missing_mode.data['code'], 'invalid_import_mode')

        invalid_range = self.upload(
            import_mode='date_range',
            range_start='2026-08-04',
            range_end='2026-08-03',
        )
        self.assertEqual(invalid_range.status_code, 400, invalid_range.data)
        self.assertEqual(invalid_range.data['code'], 'invalid_import_range')

        empty_range = self.upload(
            import_mode='date_range',
            range_start='2026-08-17',
            range_end='2026-08-17',
        )
        self.assertEqual(empty_range.status_code, 400, empty_range.data)
        self.assertEqual(empty_range.data['code'], 'no_rows_in_selected_range')
        self.assertEqual(QualityImportBatch.objects.count(), 0)

        accepted = self.upload()
        self.assertEqual(accepted.status_code, 202, accepted.data)
        scoped = self.upload(
            import_mode='date_range',
            range_start='2026-08-03',
            range_end='2026-08-03',
        )
        self.assertEqual(scoped.status_code, 202, scoped.data)
        self.assertNotEqual(scoped.data['id'], accepted.data['id'])
        self.assertFalse(scoped.data['idempotent_replay'])
        self.assertEqual(QualityImportBatch.objects.count(), 2)
        full_batch = QualityImportBatch.objects.get(pk=accepted.data['id'])
        scoped_batch = QualityImportBatch.objects.get(pk=scoped.data['id'])
        self.assertEqual(full_batch.import_scope_key, 'full')
        self.assertEqual(scoped_batch.import_scope_key, '2026-08-03:2026-08-03')

        replay = self.upload(
            import_mode='date_range',
            range_start='2026-08-03',
            range_end='2026-08-03',
        )
        self.assertEqual(replay.status_code, 202, replay.data)
        self.assertEqual(replay.data['id'], scoped.data['id'])
        self.assertTrue(replay.data['idempotent_replay'])
        self.assertEqual(QualityImportBatch.objects.count(), 2)

    def test_scoped_revision_finds_prior_date_across_newer_daily_batch(self):
        first = self.upload(
            content=build_quality_workbook(workbook_title='day-1', phenomenon='表面色差'),
            import_mode='date_range',
            range_start='2026-08-03',
            range_end='2026-08-03',
        )
        self.assertEqual(first.status_code, 202, first.data)
        process_quality_import_batch(first.data['id'])
        baseline_row = QualityImportBatch.objects.get(pk=first.data['id']).rows.get()

        second = self.upload(
            content=build_quality_workbook(
                workbook_title='day-2',
                issue_date=8.04,
                phenomenon='划伤',
            ),
            import_mode='date_range',
            range_start='2026-08-04',
            range_end='2026-08-04',
        )
        self.assertEqual(second.status_code, 202, second.data)
        process_quality_import_batch(second.data['id'])

        correction = self.upload(
            content=build_quality_workbook(
                workbook_title='day-1-corrected',
                phenomenon='表面色差 调整后',
            ),
            import_mode='date_range',
            range_start='2026-08-03',
            range_end='2026-08-03',
        )
        self.assertEqual(correction.status_code, 202, correction.data)
        corrected_row = QualityImportBatch.objects.get(pk=correction.data['id']).rows.get()
        self.assertEqual(corrected_row.delta_status, QualityImportRow.DeltaStatus.CHANGED)
        self.assertEqual(corrected_row.supersedes_id, baseline_row.id)

    def test_mixed_period_workbook_keeps_one_dataset_identity_across_scopes(self):
        full = self.upload()
        self.assertEqual(full.status_code, 202, full.data)
        process_quality_import_batch(full.data['id'])
        full_batch = QualityImportBatch.objects.get(pk=full.data['id'])
        baseline_oqc = full_batch.rows.get(sheet_name='OQC出库不良 返工list')
        self.assertEqual(full_batch.dataset_key, 'quality_issue_workbook:2026-08')

        january = self.upload(
            import_mode='date_range',
            range_start='2026-01-15',
            range_end='2026-01-15',
        )
        self.assertEqual(january.status_code, 202, january.data)
        january_batch = QualityImportBatch.objects.get(pk=january.data['id'])
        january_row = january_batch.rows.get()
        self.assertEqual(january_batch.dataset_key, full_batch.dataset_key)
        self.assertEqual(january_row.delta_status, QualityImportRow.DeltaStatus.UNCHANGED)
        self.assertEqual(january_row.baseline_row_id, baseline_oqc.id)

    def test_request_persistence_performs_no_storage_network_io(self):
        with mock.patch.object(self.storage, 'exists') as exists, mock.patch.object(self.storage, 'save') as save:
            response = self.upload()
        self.assertEqual(response.status_code, 202, response.data)
        exists.assert_not_called()
        save.assert_not_called()

    def test_same_source_sha_is_idempotent(self):
        first = self.upload()
        second = self.upload()
        self.assertEqual(first.status_code, 202, first.data)
        self.assertEqual(second.status_code, 202, second.data)
        self.assertEqual(first.data['id'], second.data['id'])
        self.assertTrue(second.data['idempotent_replay'])
        self.assertEqual(QualityImportBatch.objects.count(), 1)

    def test_invalid_workbook_leaves_no_durable_import_state(self):
        response = self.upload(content=b'not-an-xlsx')
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data['code'], 'invalid_ooxml')
        self.assertEqual(QualityImportBatch.objects.count(), 0)
        self.assertEqual(QualityImportAsset.objects.count(), 0)
        self.assertEqual(QualityImportProvenance.objects.count(), 0)

    def test_first_or_backfill_upload_is_not_capped_at_fifty_rows(self):
        response = self.upload(content=build_quality_workbook(
            workbook_title='quality-backfill',
            include_image=False,
            issue_count=75,
        ))
        self.assertEqual(response.status_code, 202, response.data)
        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        self.assertEqual(batch.total_rows, 76)
        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })

    def test_management_command_is_manual_queue_recovery(self):
        queued = self.upload()
        output = StringIO()
        call_command('process_quality_imports', limit=1, stdout=output)
        batch = QualityImportBatch.objects.get(pk=queued.data['id'])
        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertIn(f'Batch {batch.id}:', output.getvalue())

    def test_crash_after_remote_upload_before_checkpoint_is_idempotent(self):
        queued = self.upload()
        asset = QualityImportAsset.objects.get()
        self.storage.save(asset.storage_key, ContentFile(bytes(asset.staged_bytes)))

        process_quality_import_batch(queued.data['id'])

        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)
        self.assertEqual(asset.file.name, asset.storage_key)
        self.assertIsNone(asset.staged_bytes)
        self.assertEqual(len([name for name in self.storage.listdir('quality-import/assets')[1]]), 1)

    def test_missing_ready_object_is_repaired_by_next_workbook(self):
        first = self.upload()
        process_quality_import_batch(first.data['id'])
        asset = QualityImportAsset.objects.get()
        missing_name = asset.file.name
        self.storage.delete(missing_name)
        self.assertFalse(self.storage.exists(missing_name))

        revised = self.upload(content=build_quality_workbook(
            workbook_title='quality-revision',
            phenomenon='顶部拉白 修订',
        ))
        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertTrue(asset.staged_bytes)

        process_quality_import_batch(revised.data['id'])

        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)
        self.assertTrue(self.storage.exists(asset.file.name))
        self.assertIsNone(asset.staged_bytes)

    def test_changed_row_forces_verification_without_reupload(self):
        first = self.upload()
        process_quality_import_batch(first.data['id'])
        asset = QualityImportAsset.objects.get()
        self.assertIsNotNone(asset.remote_verified_at)

        with mock.patch.object(self.storage, 'exists') as exists, mock.patch.object(self.storage, 'save') as save:
            revised = self.upload(content=build_quality_workbook(
                workbook_title='quality-identical-media-revision',
                phenomenon='顶部拉白 内容修订',
            ))

        self.assertEqual(revised.status_code, 202, revised.data)
        batch = QualityImportBatch.objects.get(pk=revised.data['id'])
        asset.refresh_from_db()
        self.assertEqual(batch.status, QualityImportBatch.Status.QUEUED)
        self.assertEqual(batch.new_media_count, 0)
        self.assertEqual(batch.reused_media_count, 1)
        self.assertTrue(asset.staged_bytes)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        exists.assert_not_called()
        save.assert_not_called()

        with mock.patch.object(self.storage, 'save', wraps=self.storage.save) as pump_save:
            process_quality_import_batch(batch.pk)

        batch.refresh_from_db()
        asset.refresh_from_db()
        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertIsNone(asset.staged_bytes)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)
        pump_save.assert_not_called()

    def test_unchanged_cumulative_workbook_reuses_recent_asset_without_io(self):
        first = self.upload()
        process_quality_import_batch(first.data['id'])
        asset = QualityImportAsset.objects.get()

        with mock.patch.object(self.storage, 'exists') as exists, mock.patch.object(self.storage, 'save') as save:
            cumulative = self.upload(content=build_quality_workbook(
                workbook_title='quality-next-cumulative-export',
            ))

        self.assertEqual(cumulative.status_code, 202, cumulative.data)
        batch = QualityImportBatch.objects.get(pk=cumulative.data['id'])
        asset.refresh_from_db()
        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertEqual(batch.new_media_count, 0)
        self.assertEqual(batch.reused_media_count, 1)
        self.assertEqual(batch.changed_count, 0)
        self.assertEqual(batch.unchanged_count, 2)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)
        self.assertIsNone(asset.staged_bytes)
        exists.assert_not_called()
        save.assert_not_called()

    def test_changed_reference_wins_when_unchanged_row_shares_same_sha(self):
        baseline_content = build_quality_workbook(
            workbook_title='quality-shared-image-baseline',
            issue_count=2,
            phenomena=['issue-a', 'issue-b'],
            image_rows=(3, 4),
        )
        first = self.upload(content=baseline_content)
        process_quality_import_batch(first.data['id'])
        self.assertEqual(QualityImportAsset.objects.count(), 1)

        with mock.patch.object(self.storage, 'exists') as request_exists:
            mixed = self.upload(content=build_quality_workbook(
                workbook_title='quality-shared-image-mixed-delta',
                issue_count=2,
                phenomena=['issue-a', 'issue-b changed'],
                image_rows=(3, 4),
            ))
        request_exists.assert_not_called()

        batch = QualityImportBatch.objects.get(pk=mixed.data['id'])
        asset = QualityImportAsset.objects.get()
        self.assertEqual(batch.status, QualityImportBatch.Status.QUEUED)
        self.assertEqual(batch.changed_count, 1)
        self.assertEqual(batch.unchanged_count, 2)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertTrue(asset.staged_bytes)

        with mock.patch.object(self.storage, 'exists', wraps=self.storage.exists) as pump_exists, mock.patch.object(
            self.storage,
            'save',
            wraps=self.storage.save,
        ) as pump_save:
            process_quality_import_batch(batch.pk)

        batch.refresh_from_db()
        asset.refresh_from_db()
        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertTrue(pump_exists.called)
        pump_save.assert_not_called()
        self.assertIsNone(asset.staged_bytes)

    def test_existing_failed_asset_without_bytes_is_repaired_at_staging(self):
        first = self.upload()
        process_quality_import_batch(first.data['id'])
        asset = QualityImportAsset.objects.get()
        self.storage.delete(asset.file.name)
        asset.file = ''
        asset.staged_bytes = None
        asset.upload_state = QualityImportAsset.UploadState.FAILED
        asset.last_error = 'simulated prior failure'
        asset.save(update_fields=['file', 'staged_bytes', 'upload_state', 'last_error'])

        revised = self.upload(content=build_quality_workbook(
            workbook_title='failed-asset-repair',
            phenomenon='顶部拉白 再确认',
        ))

        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertTrue(asset.staged_bytes)
        self.assertEqual(asset.last_error, '')
        process_quality_import_batch(revised.data['id'])
        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)

    def test_expired_batch_and_asset_leases_return_to_queue(self):
        queued = self.upload()
        batch = QualityImportBatch.objects.get(pk=queued.data['id'])
        asset = QualityImportAsset.objects.get()
        expired = timezone.now() - timedelta(minutes=1)
        QualityImportBatch.objects.filter(pk=batch.pk).update(
            status=QualityImportBatch.Status.PROCESSING,
            processing_owner='dead-worker',
            lease_expires_at=expired,
            attempt_count=1,
        )
        QualityImportAsset.objects.filter(pk=asset.pk).update(
            upload_state=QualityImportAsset.UploadState.UPLOADING,
            processing_owner='dead-worker',
            lease_expires_at=expired,
        )

        self.assertEqual(recover_stale_quality_imports(), 1)
        batch.refresh_from_db()
        asset.refresh_from_db()
        self.assertEqual(batch.status, QualityImportBatch.Status.QUEUED)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)

    def test_revised_workbook_preserves_delta_and_human_publish_boundary(self):
        first = self.upload()
        process_quality_import_batch(first.data['id'])
        revised = self.upload(content=build_quality_workbook(
            workbook_title='quality-revision-delta',
            phenomenon='顶部拉白 加重',
        ))
        process_quality_import_batch(revised.data['id'])
        batch = QualityImportBatch.objects.get(pk=revised.data['id'])
        self.assertEqual(batch.changed_count, 1)
        self.assertEqual(batch.unchanged_count, 1)
        changed = batch.rows.get(delta_status=QualityImportRow.DeltaStatus.CHANGED)
        self.assertEqual(changed.review_status, QualityImportRow.ReviewStatus.DRAFT)
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_old_chunk_routes_do_not_exist(self):
        for name, kwargs in (
            ('quality-import-batch-initiate', {}),
            ('quality-import-batch-finalize', {'pk': 1}),
            ('quality-import-batch-chunk-sign', {'pk': 1, 'chunk_index': 0}),
            ('quality-import-batch-chunk-upload', {'pk': 1, 'chunk_index': 0}),
        ):
            with self.subTest(name=name), self.assertRaises(NoReverseMatch):
                reverse(name, kwargs=kwargs)

    @override_settings(
        DEBUG=False,
        QUALITY_IMPORT_ALLOW_LOCAL_PROXY=False,
        CLOUDINARY_STORAGE={'CLOUD_NAME': '', 'API_KEY': '', 'API_SECRET': ''},
    )
    def test_production_without_cloudinary_fails_closed_before_commit(self):
        response = self.upload()
        self.assertEqual(response.status_code, 503, response.data)
        self.assertEqual(response.data['code'], 'production_storage_required')
        self.assertEqual(QualityImportBatch.objects.count(), 0)


@override_settings(
    QUALITY_IMPORT_ALLOW_LOCAL_PROXY=True,
    QUALITY_IMPORT_DISABLE_BACKGROUND_PUMP=True,
)
class QualityExcelDirectImportAPITests(APITestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.storage = FileSystemStorage(location=self.temp_dir.name, base_url='/test-media/')
        self.storage_patch = mock.patch(
            'quality.direct_import.quality_import_media_storage',
            return_value=self.storage,
        )
        self.storage_patch.start()
        self.user = get_user_model().objects.create_user(
            username='quality-direct-import-editor',
            password='test-password',
        )
        self.user.profile.can_view_quality = True
        self.user.profile.can_edit_quality = True
        self.user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        self.client.force_authenticate(self.user)
        self.url = reverse('quality-excel-import')
        self.workbook = build_quality_workbook(
            image_rows=(3, 3, 3, 3, 3),
            unique_images=True,
        )

    def tearDown(self):
        self.storage_patch.stop()
        self.temp_dir.cleanup()

    def upload(self, content=None):
        return self.client.post(
            self.url,
            {
                'file': SimpleUploadedFile(
                    '品质 Issue List - 8月.xlsx',
                    self.workbook if content is None else content,
                    content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ),
            },
            format='multipart',
        )

    def test_registers_reports_immediately_with_five_images_and_source_audit(self):
        response = self.upload()

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['total_rows'], 2)
        self.assertEqual(response.data['created_count'], 2)
        self.assertEqual(response.data['skipped_count'], 0)
        self.assertEqual(response.data['failed_count'], 0)
        self.assertEqual(response.data['images_found'], 5)
        self.assertEqual(response.data['images_saved'], 5)
        self.assertEqual(
            response.data['images_found'],
            response.data['images_saved']
            + response.data['images_failed']
            + response.data['images_ignored']
            + response.data['images_skipped'],
        )
        self.assertEqual(QualityImportBatch.objects.count(), 0)
        report = QualityReport.objects.get(part_no='ACQ30854201')
        self.assertTrue(all(getattr(report, field) for field in ('image1', 'image2', 'image3', 'image4', 'image5')))
        self.assertEqual(
            len({getattr(report, field) for field in ('image1', 'image2', 'image3', 'image4', 'image5')}),
            5,
        )
        self.assertEqual(report.excel_source['sheet_name'], '8月')
        self.assertEqual(report.excel_source['source_row_number'], 3)
        self.assertEqual(report.excel_source['occurrence_location'], '注塑')
        self.assertEqual(report.excel_source['item_name'], 'B/C')
        detail = self.client.get(reverse('quality-report-detail', kwargs={'pk': report.pk}))
        self.assertEqual(detail.status_code, 200, detail.data)
        self.assertNotIn('excel_source', detail.data)
        self.assertNotIn('excel_import_key', detail.data)
        self.assertEqual(detail.data['source_import']['source_row_number'], 3)

    def test_replaying_same_workbook_skips_every_existing_excel_event(self):
        first = self.upload()
        second = self.upload()

        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(second.data['created_count'], 0)
        self.assertEqual(second.data['skipped_count'], 2)
        self.assertEqual(second.data['failed_count'], 0)
        self.assertEqual(len(second.data['skipped_report_ids']), 2)
        self.assertEqual(second.data['images_skipped'], 5)
        self.assertEqual(QualityReport.objects.count(), 2)

    def test_sixth_image_is_reported_and_not_saved(self):
        response = self.upload(content=build_quality_workbook(
            image_rows=(3, 3, 3, 3, 3, 3),
            unique_images=True,
        ))

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['images_found'], 6)
        self.assertEqual(response.data['images_saved'], 5)
        self.assertEqual(response.data['images_ignored'], 1)
        issue_result = next(item for item in response.data['rows'] if item['part_no'] == 'ACQ30854201')
        self.assertEqual(issue_result['images_found'], 6)
        self.assertEqual(issue_result['images_saved'], 5)
        self.assertIn('images_over_limit:1', issue_result['warnings'])
        report = QualityReport.objects.get(part_no='ACQ30854201')
        self.assertTrue(all(getattr(report, field) for field in ('image1', 'image2', 'image3', 'image4', 'image5')))

    def test_exact_existing_manual_report_is_skipped_without_overwriting_post_processing(self):
        uploaded_on = timezone.localdate()
        report_year = uploaded_on.year - 1 if 8 > uploaded_on.month + 1 else uploaded_on.year
        manual = QualityReport.objects.create(
            report_dt=datetime(report_year, 8, 3, 11, tzinfo=ZoneInfo('Asia/Shanghai')),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30854201',
            lot_qty=8,
            defect_qty=2,
            judgement='NG',
            phenomenon='顶部拉白',
            disposition='수동 후처리',
            action_result='조치 완료',
        )

        response = self.upload()

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['created_count'], 1)
        self.assertEqual(response.data['skipped_count'], 1)
        self.assertIn(manual.pk, response.data['skipped_report_ids'])
        issue_result = next(item for item in response.data['rows'] if item['part_no'] == 'ACQ30854201')
        self.assertEqual(issue_result['status'], 'skipped')
        self.assertEqual(issue_result['report_id'], manual.pk)
        self.assertIn('existing_match:exact_report_match', issue_result['warnings'])
        manual.refresh_from_db()
        self.assertEqual(manual.action_result, '조치 완료')
        self.assertEqual(QualityReport.objects.count(), 2)

    def test_existing_excel_event_with_changed_content_is_skipped_and_flagged(self):
        first = self.upload()
        revised = self.upload(content=build_quality_workbook(phenomenon='顶部拉白 修订'))

        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(revised.status_code, 200, revised.data)
        self.assertEqual(revised.data['created_count'], 0)
        self.assertEqual(revised.data['skipped_count'], 2)
        issue_result = next(item for item in revised.data['rows'] if item['part_no'] == 'ACQ30854201')
        self.assertEqual(issue_result['status'], 'skipped')
        self.assertIn('existing_content_differs', issue_result['warnings'])
        self.assertEqual(QualityReport.objects.count(), 2)

    def test_exact_source_replay_matches_even_if_inferred_year_changes(self):
        from .direct_import import _existing_reports_for_rows

        source_sha256 = 'a' * 64
        report = QualityReport.objects.create(
            report_dt=datetime(2026, 8, 3, 8, tzinfo=ZoneInfo('Asia/Shanghai')),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30854201',
            defect_qty=2,
            phenomenon='顶部拉白',
            excel_import_key='b' * 64,
            excel_source={
                'source_sha256': source_sha256,
                'sheet_name': '8月',
                'source_row_number': 3,
                'source_sequence': '1',
            },
        )
        replay_row = {
            'sheet_name': '8月',
            'source_row_number': 3,
            'source_sequence': '1',
            'business_key': 'c' * 64,
            'content_sha256': 'd' * 64,
            'report_date': date(2027, 8, 3),
            'section': 'LQC_INJ',
            'model': '27G523',
            'part_no': 'ACQ30854201',
            'lot_qty': None,
            'inspection_qty': None,
            'defect_qty': 2,
            'defect_rate': '',
            'judgement': 'NG',
            'phenomenon': '顶部拉白',
        }

        matches = _existing_reports_for_rows([replay_row], source_sha256=source_sha256)

        self.assertEqual(matches[0]['report'].pk, report.pk)
        self.assertEqual(matches[0]['reason'], 'exact_source_replay')

    def test_one_manual_report_only_consumes_one_identical_excel_row(self):
        from .direct_import import _existing_reports_for_rows

        report_date = date(2026, 8, 3)
        manual = QualityReport.objects.create(
            report_dt=datetime(2026, 8, 3, 11, tzinfo=ZoneInfo('Asia/Shanghai')),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30854201',
            lot_qty=8,
            defect_qty=2,
            judgement='NG',
            phenomenon='顶部拉白',
        )

        def row(*, row_number, sequence, business_key):
            return {
                'sheet_name': '8月',
                'source_row_number': row_number,
                'source_sequence': sequence,
                'business_key': business_key,
                'content_sha256': business_key,
                'report_date': report_date,
                'section': 'LQC_INJ',
                'model': '27G523',
                'part_no': 'ACQ30854201',
                'lot_qty': 8,
                'inspection_qty': None,
                'defect_qty': 2,
                'defect_rate': '',
                'judgement': 'NG',
                'phenomenon': '顶部拉白',
            }

        matches = _existing_reports_for_rows(
            [
                row(row_number=3, sequence='1', business_key='1' * 64),
                row(row_number=4, sequence='2', business_key='2' * 64),
            ],
            source_sha256='3' * 64,
        )

        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['report'].pk, manual.pk)
        self.assertNotIn(1, matches)

    def test_direct_report_is_not_reused_as_a_manual_signature_fallback(self):
        from .direct_import import _existing_reports_for_rows

        QualityReport.objects.create(
            report_dt=datetime(2026, 8, 3, 8, tzinfo=ZoneInfo('Asia/Shanghai')),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30854201',
            lot_qty=8,
            defect_qty=2,
            judgement='NG',
            phenomenon='顶部拉白',
            excel_import_key='4' * 64,
            excel_source={'source_sha256': '5' * 64},
        )
        new_event = {
            'sheet_name': '8月',
            'source_row_number': 4,
            'source_sequence': '2',
            'business_key': '6' * 64,
            'content_sha256': '7' * 64,
            'report_date': date(2026, 8, 3),
            'section': 'LQC_INJ',
            'model': '27G523',
            'part_no': 'ACQ30854201',
            'lot_qty': 8,
            'inspection_qty': None,
            'defect_qty': 2,
            'defect_rate': '',
            'judgement': 'NG',
            'phenomenon': '顶部拉白',
        }

        matches = _existing_reports_for_rows([new_event], source_sha256='8' * 64)

        self.assertEqual(matches, {})

    def test_invalid_workbook_returns_specific_api_error_without_reports(self):
        response = self.upload(content=b'not-an-xlsx')

        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data['code'], 'invalid_ooxml')
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_image_storage_failure_leaves_affected_row_retryable(self):
        with mock.patch.object(self.storage, 'save', side_effect=OSError('storage unavailable')):
            with mock.patch('quality.direct_import.LOGGER.exception'):
                response = self.upload()

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['created_count'], 1)
        self.assertEqual(response.data['failed_count'], 1)
        self.assertEqual(response.data['images_failed'], 5)
        self.assertFalse(QualityReport.objects.filter(part_no='ACQ30854201').exists())
        imported_row = next(
            item for item in response.data['rows']
            if item['part_no'] == 'ACQ30854201'
        )
        self.assertEqual(imported_row['status'], 'failed')
        self.assertIsNone(imported_row['report_id'])
        self.assertEqual(imported_row['images_saved'], 0)
        self.assertIn('image_upload_failed:1', imported_row['warnings'])

    @override_settings(
        DEBUG=False,
        QUALITY_IMPORT_ALLOW_LOCAL_PROXY=False,
    )
    def test_production_rejects_image_import_when_durable_storage_is_unavailable(self):
        with mock.patch(
            'quality.direct_import.quality_import_media_upload_available',
            return_value=False,
        ):
            response = self.upload()

        self.assertEqual(response.status_code, 503, response.data)
        self.assertEqual(response.data['code'], 'production_storage_required')
        self.assertEqual(QualityReport.objects.count(), 0)


class QualityImportImageValidationTests(APITestCase):
    def test_image_with_valid_header_but_corrupt_payload_is_rejected(self):
        buffer = BytesIO()
        PillowImage.new('RGB', (10, 10), color=(20, 120, 220)).save(buffer, format='PNG')
        malformed = bytearray(buffer.getvalue())
        idat_index = malformed.find(b'IDAT')
        self.assertGreater(idat_index, 0)
        malformed[idat_index + 8] ^= 0xFF
        with self.assertRaises(WorkbookValidationError) as raised:
            _image_dimensions(bytes(malformed))
        self.assertEqual(raised.exception.code, 'invalid_embedded_image')

    def test_png_normalization_strips_source_icc_metadata(self):
        source = BytesIO()
        marker = b'private-workbook-icc-profile-marker'
        PillowImage.new('RGB', (10, 10), color=(20, 120, 220)).save(
            source,
            format='PNG',
            icc_profile=marker,
        )
        normalized, extension, content_type, width, height = _normalize_image_content(
            source.getvalue(),
            extension='png',
            content_type='image/png',
        )
        self.assertEqual((extension, content_type, width, height), ('png', 'image/png', 10, 10))
        self.assertNotIn(marker, normalized)
        with PillowImage.open(BytesIO(normalized)) as image:
            self.assertNotIn('icc_profile', image.info)
