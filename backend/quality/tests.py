from __future__ import annotations

import hashlib
import tempfile
from datetime import timedelta
from io import BytesIO, StringIO
from unittest import mock

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
            None, index, 8.03, '注塑', '27G523', f'{part_no}{index}' if issue_count > 1 else part_no,
            'B/C', row_phenomenon, 'Lot数：8\n不良数：2', None, '刚生产',
        ])
    if include_image:
        image_buffer = BytesIO()
        PillowImage.new('RGB', (12, 8), color=(20, 120, 220)).save(image_buffer, format='PNG')
        image_content = image_buffer.getvalue()
        for row_number in image_rows or (3,):
            issue.add_image(ExcelImage(BytesIO(image_content)), f'J{row_number}')

    oqc = workbook.create_sheet('OQC出库不良 返工list')
    oqc.append([None, '2026年 OQC 出库不良 LIST'])
    oqc.append([
        None, 'NO', '检查日期', '型号', 'P/N', '品名', '数量',
        '生产日期', '不良类型', '对应部门', '处理结果', '备注',
    ])
    oqc.append([
        None, 1, 1.15, '32QN600', 'ABJ76507611', 'C/A', 3,
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

    def upload(self, content=None, *, filename='品质 Issue List - 8月.xlsx', content_type=None):
        content = self.workbook if content is None else content
        return self.client.post(
            self.url,
            {
                'file': SimpleUploadedFile(
                    filename,
                    content,
                    content_type=content_type or 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ),
            },
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
