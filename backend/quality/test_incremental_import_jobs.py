from __future__ import annotations

import hashlib
import json
import tempfile
from io import BytesIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError
from django.test import override_settings
from django.urls import reverse
from PIL import Image as PillowImage
from rest_framework.test import APITestCase

from . import incremental_import
from .excel_import import WorkbookValidationError, process_quality_import_batch
from .models import QualityImportAsset, QualityImportBatch, QualityReport


def _png_bytes(color: tuple[int, int, int]) -> bytes:
    output = BytesIO()
    PillowImage.new('RGB', (12, 8), color=color).save(output, format='PNG')
    return output.getvalue()


def _issue_rows(
    *,
    sequence: int = 1,
    row_number: int = 3,
    phenomenon: str = '顶部拉白',
) -> list[list[object]]:
    rows: list[list[object]] = [
        [None, '万佳品质问题点Issue'],
        [
            None,
            '序号',
            '发生日期',
            '发生场所',
            'Mold',
            'P/N',
            'Item',
            '不良现象',
            '不良数量',
            '不良照片',
            '备注',
        ],
    ]
    while len(rows) < row_number - 1:
        rows.append([])
    rows.append([
        None,
        sequence,
        '2026-08-18',
        '注塑',
        '27G523',
        'ACQ30854201',
        'B/C',
        phenomenon,
        'Lot数：8\n不良数：2',
        None,
        '刚生产',
    ])
    return rows


def _media_item(
    key: str,
    content: bytes,
    index: int,
    *,
    row: int = 3,
) -> dict[str, object]:
    return {
        'key': key,
        'source_sheet_name': '8月',
        'source_anchor_row': row,
        'source_anchor_col': 10,
        'source_index': index,
        'original_filename': f'{key}.png',
        'content_type': 'image/png',
        'byte_size': len(content),
        'sha256': hashlib.sha256(content).hexdigest(),
    }


def _manifest(
    media: list[dict[str, object]] | None = None,
    *,
    workbook_sha256: str = 'a' * 64,
    rows: list[list[object]] | None = None,
) -> dict[str, object]:
    return {
        'version': 'quality-incremental-v1',
        'filename': '品质 Issue List - 8月.xlsx',
        'file_size': 12_345,
        'workbook_sha256': workbook_sha256,
        'workbook_properties': {'title': 'quality-source'},
        'sheets': [{'sheet_name': '8月', 'rows': rows or _issue_rows()}],
        'media': media or [],
        'warnings': [],
    }


@override_settings(
    QUALITY_IMPORT_ALLOW_LOCAL_PROXY=True,
    QUALITY_IMPORT_DISABLE_BACKGROUND_PUMP=True,
)
class QualityExcelIncrementalJobTests(APITestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.storage = FileSystemStorage(location=self.temp_dir.name, base_url='/test-media/')
        self.media_field = QualityImportAsset._meta.get_field('file')
        self.original_storage = self.media_field.storage
        self.media_field.storage = self.storage

        self.editor = self._user('incremental-job-editor', view=True, edit=True)
        self.viewer = self._user('incremental-job-viewer', view=True, edit=False)
        self.hidden_user = self._user('incremental-job-hidden', view=False, edit=False)
        self.client.force_authenticate(self.editor)

        self.preview_url = reverse('quality-excel-import-preview')
        self.jobs_url = reverse('quality-excel-import-jobs')

    def tearDown(self):
        self.media_field.storage = self.original_storage
        self.temp_dir.cleanup()

    @staticmethod
    def _user(username: str, *, view: bool, edit: bool):
        user = get_user_model().objects.create_user(username=username, password='test-password')
        user.profile.can_view_quality = view
        user.profile.can_edit_quality = edit
        user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        return user

    def _preview(self, manifest: dict[str, object]):
        response = self.client.post(self.preview_url, manifest, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        return response

    def _job_payload(
        self,
        manifest: dict[str, object],
        files_by_key: dict[str, bytes] | None = None,
    ) -> dict[str, object]:
        preview = self._preview(manifest)
        payload: dict[str, object] = {
            'manifest': json.dumps(manifest, ensure_ascii=False),
            'row_keys': json.dumps([row['row_key'] for row in preview.data['rows']]),
        }
        for key, content in (files_by_key or {}).items():
            payload[f'media_{key}'] = SimpleUploadedFile(
                f'{key}.png',
                content,
                content_type='image/png',
            )
        return payload

    def _post_job(
        self,
        manifest: dict[str, object],
        files_by_key: dict[str, bytes] | None = None,
    ):
        return self.client.post(
            self.jobs_url,
            self._job_payload(manifest, files_by_key),
            format='multipart',
        )

    def test_job_intake_returns_202_and_stages_bytes_without_storage_io(self):
        image = _png_bytes((20, 120, 220))
        manifest = _manifest([_media_item('m0', image, 0)])
        payload = self._job_payload(manifest, {'m0': image})

        with (
            mock.patch.object(self.storage, 'save', wraps=self.storage.save) as save,
            mock.patch.object(self.storage, 'exists', wraps=self.storage.exists) as exists,
            mock.patch.object(self.storage, 'open', wraps=self.storage.open) as open_file,
        ):
            response = self.client.post(self.jobs_url, payload, format='multipart')

        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(response.data['status'], QualityImportBatch.Status.QUEUED)
        self.assertIsNone(response.data['result'])
        save.assert_not_called()
        exists.assert_not_called()
        open_file.assert_not_called()

        asset = QualityImportAsset.objects.get()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertTrue(bytes(asset.staged_bytes))
        self.assertEqual(hashlib.sha256(bytes(asset.staged_bytes)).hexdigest(), asset.sha256)
        self.assertFalse(asset.file)
        self.assertEqual(QualityReport.objects.count(), 0)

    @override_settings(
        DEBUG=False,
        QUALITY_IMPORT_ALLOW_LOCAL_PROXY=False,
        CLOUDINARY_STORAGE={'CLOUD_NAME': '', 'API_KEY': '', 'API_SECRET': ''},
    )
    def test_image_job_intake_fails_closed_without_production_storage(self):
        image = _png_bytes((20, 120, 220))
        manifest = _manifest([_media_item('m0', image, 0)])

        response = self._post_job(manifest, {'m0': image})

        self.assertEqual(response.status_code, 503, response.data)
        self.assertEqual(response.data['code'], 'production_storage_required')
        self.assertEqual(QualityImportBatch.objects.count(), 0)
        self.assertEqual(QualityImportAsset.objects.count(), 0)

    def test_worker_fails_closed_if_storage_becomes_unavailable_after_intake(self):
        image = _png_bytes((20, 120, 220))
        manifest = _manifest([_media_item('m0', image, 0)])
        response = self._post_job(manifest, {'m0': image})
        self.assertEqual(response.status_code, 202, response.data)

        with self.settings(
            DEBUG=False,
            QUALITY_IMPORT_ALLOW_LOCAL_PROXY=False,
            CLOUDINARY_STORAGE={'CLOUD_NAME': '', 'API_KEY': '', 'API_SECRET': ''},
        ):
            with self.assertRaises(WorkbookValidationError) as raised:
                process_quality_import_batch(response.data['id'])

        self.assertEqual(raised.exception.code, 'production_storage_required')
        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        asset = QualityImportAsset.objects.get()
        self.assertEqual(batch.status, QualityImportBatch.Status.QUEUED)
        self.assertEqual(batch.phase, 'retry_wait')
        self.assertTrue(any('production_storage_required' in warning for warning in batch.warnings))
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertTrue(asset.staged_bytes)
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_same_workbook_chunk_replay_returns_same_job(self):
        image = _png_bytes((20, 120, 220))
        manifest = _manifest([_media_item('m0', image, 0)])

        first = self._post_job(manifest, {'m0': image})
        second = self._post_job(manifest, {'m0': image})

        self.assertEqual(first.status_code, 202, first.data)
        self.assertEqual(second.status_code, 202, second.data)
        self.assertFalse(first.data['idempotent_replay'])
        self.assertTrue(second.data['idempotent_replay'])
        self.assertEqual(second.data['id'], first.data['id'])
        self.assertEqual(QualityImportBatch.objects.count(), 1)
        self.assertEqual(QualityImportAsset.objects.count(), 1)

    def test_intake_integrity_retry_rewinds_uploaded_image(self):
        image = _png_bytes((20, 120, 220))
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='1' * 64,
        )
        original = incremental_import._enqueue_quality_manifest_once
        attempts = 0

        def conflict_once(*args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                for upload in kwargs['uploaded_files'].values():
                    upload.read()
                raise IntegrityError('simulated concurrent intake winner')
            return original(*args, **kwargs)

        with mock.patch.object(
            incremental_import,
            '_enqueue_quality_manifest_once',
            side_effect=conflict_once,
        ):
            response = self._post_job(manifest, {'m0': image})

        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(attempts, 2)
        self.assertEqual(QualityImportBatch.objects.count(), 1)
        self.assertTrue(QualityImportAsset.objects.get().staged_bytes)

    def test_missing_ready_asset_is_restaged_and_recreated_by_worker(self):
        image = _png_bytes((20, 120, 220))
        first_manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='2' * 64,
        )
        first = self._post_job(first_manifest, {'m0': image})
        process_quality_import_batch(first.data['id'])
        asset = QualityImportAsset.objects.get()
        missing_name = asset.file.name
        self.storage.delete(missing_name)
        self.assertFalse(self.storage.exists(missing_name))

        second_manifest = _manifest(
            [_media_item('m1', image, 0, row=4)],
            workbook_sha256='3' * 64,
            rows=_issue_rows(sequence=2, row_number=4, phenomenon='顶部拉白 二次'),
        )
        with (
            mock.patch.object(self.storage, 'save', wraps=self.storage.save) as intake_save,
            mock.patch.object(self.storage, 'exists', wraps=self.storage.exists) as intake_exists,
            mock.patch.object(self.storage, 'open', wraps=self.storage.open) as intake_open,
        ):
            second = self._post_job(second_manifest, {'m1': image})

        self.assertEqual(second.status_code, 202, second.data)
        intake_save.assert_not_called()
        intake_exists.assert_not_called()
        intake_open.assert_not_called()
        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertTrue(asset.staged_bytes)

        process_quality_import_batch(second.data['id'])

        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)
        self.assertIsNone(asset.staged_bytes)
        self.assertTrue(self.storage.exists(asset.file.name))
        self.assertEqual(QualityReport.objects.count(), 2)

    def test_worker_stores_at_most_five_images_and_persists_final_result(self):
        files = {
            f'm{index}': _png_bytes((20 + index * 20, 80 + index * 10, 180 - index * 10))
            for index in range(6)
        }
        manifest = _manifest([
            _media_item(key, content, index)
            for index, (key, content) in enumerate(files.items())
        ])
        preview = self._preview(manifest)
        required_keys = preview.data['required_media_keys']
        self.assertEqual(len(required_keys), 5)
        response = self.client.post(
            self.jobs_url,
            self._job_payload(
                manifest,
                {key: files[key] for key in required_keys},
            ),
            format='multipart',
        )
        self.assertEqual(response.status_code, 202, response.data)

        processed = process_quality_import_batch(response.data['id'])

        self.assertIsNotNone(processed)
        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        result = batch.delta_summary['incremental_result']
        self.assertEqual(result['created_count'], 1)
        self.assertEqual(result['failed_count'], 0)
        self.assertEqual(result['images_found'], 6)
        self.assertEqual(result['images_saved'], 5)
        self.assertEqual(result['images_ignored'], 1)
        self.assertEqual(len(result['created_report_ids']), 1)

        report = QualityReport.objects.get()
        self.assertEqual(
            [bool(report.image1), bool(report.image2), bool(report.image3), bool(report.image4), bool(report.image5)],
            [True, True, True, True, True],
        )
        self.assertEqual(QualityImportAsset.objects.filter(staged_bytes__isnull=True).count(), 5)
        self.assertEqual(process_quality_import_batch(batch.pk), None)
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_no_image_job_registers_report(self):
        response = self._post_job(_manifest(workbook_sha256='b' * 64))
        self.assertEqual(response.status_code, 202, response.data)
        self.assertEqual(response.data['progress_total'], 0)

        process_quality_import_batch(response.data['id'])

        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        result = batch.delta_summary['incremental_result']
        self.assertEqual(result['created_count'], 1)
        self.assertEqual(result['images_found'], 0)
        self.assertEqual(result['images_saved'], 0)
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_retry_after_report_checkpoint_does_not_create_a_duplicate(self):
        response = self._post_job(_manifest(workbook_sha256='e' * 64))
        process_quality_import_batch(response.data['id'])
        batch = QualityImportBatch.objects.get(pk=response.data['id'])
        report_id = QualityReport.objects.get().pk

        # Simulate a worker crash after the per-row report/link checkpoint but
        # before the terminal result/batch checkpoint became durable.
        summary = dict(batch.delta_summary)
        summary['incremental_result'] = None
        QualityImportBatch.objects.filter(pk=batch.pk).update(
            status=QualityImportBatch.Status.QUEUED,
            phase='queued',
            delta_summary=summary,
            processing_owner='',
            lease_expires_at=None,
            next_attempt_at=None,
        )

        process_quality_import_batch(batch.pk)

        batch.refresh_from_db()
        self.assertEqual(QualityReport.objects.count(), 1)
        self.assertEqual(QualityReport.objects.get().pk, report_id)
        self.assertEqual(batch.delta_summary['incremental_result']['created_report_ids'], [report_id])
        self.assertEqual(batch.delta_summary['incremental_result']['created_count'], 1)

    def test_polling_returns_queued_then_terminal_contract_and_kicks_pump(self):
        queued = self._post_job(_manifest(workbook_sha256='c' * 64))
        self.assertEqual(queued.status_code, 202, queued.data)
        detail_url = reverse('quality-excel-import-job-detail', args=[queued.data['id']])

        with mock.patch('quality.import_views.kick_quality_import_pump') as kick:
            polling = self.client.get(detail_url)

        self.assertEqual(polling.status_code, 200, polling.data)
        self.assertEqual(polling.data['status'], QualityImportBatch.Status.QUEUED)
        self.assertEqual(polling.data['phase'], 'queued')
        self.assertIsNone(polling.data['result'])
        kick.assert_called_once_with()

        process_quality_import_batch(queued.data['id'])
        terminal = self.client.get(detail_url)

        self.assertEqual(terminal.status_code, 200, terminal.data)
        self.assertIn(terminal.data['status'], {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertEqual(terminal.data['phase'], 'ready')
        self.assertEqual(terminal.data['progress_done'], terminal.data['progress_total'])
        self.assertEqual(terminal.data['result']['created_count'], 1)

    def test_job_permissions_require_authentication_and_edit_access(self):
        manifest = _manifest(workbook_sha256='d' * 64)
        preview = self._preview(manifest)
        row_keys = json.dumps([row['row_key'] for row in preview.data['rows']])

        def payload():
            return {
                'manifest': json.dumps(manifest, ensure_ascii=False),
                'row_keys': row_keys,
            }

        self.client.force_authenticate(user=None)
        anonymous = self.client.post(self.jobs_url, payload(), format='multipart')
        self.assertIn(anonymous.status_code, {401, 403})

        self.client.force_authenticate(self.viewer)
        viewer = self.client.post(self.jobs_url, payload(), format='multipart')
        self.assertEqual(viewer.status_code, 403, viewer.data)

        self.client.force_authenticate(self.editor)
        accepted = self.client.post(self.jobs_url, payload(), format='multipart')
        self.assertEqual(accepted.status_code, 202, accepted.data)
        detail_url = reverse('quality-excel-import-job-detail', args=[accepted.data['id']])

        self.client.force_authenticate(user=None)
        anonymous_poll = self.client.get(detail_url)
        self.assertIn(anonymous_poll.status_code, {401, 403})

        self.client.force_authenticate(self.hidden_user)
        hidden_poll = self.client.get(detail_url)
        self.assertEqual(hidden_poll.status_code, 403, hidden_poll.data)

        self.client.force_authenticate(self.viewer)
        viewer_poll = self.client.get(detail_url)
        self.assertEqual(viewer_poll.status_code, 200, viewer_poll.data)
        retry_url = reverse('quality-excel-import-job-retry', args=[accepted.data['id']])
        viewer_retry = self.client.post(retry_url, {}, format='json')
        self.assertEqual(viewer_retry.status_code, 403, viewer_retry.data)

        self.client.force_authenticate(self.editor)
        editor_retry = self.client.post(retry_url, {}, format='json')
        self.assertEqual(editor_retry.status_code, 202, editor_retry.data)
