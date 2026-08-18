from __future__ import annotations

import hashlib
import json
import tempfile
from datetime import date, datetime
from io import BytesIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.urls import reverse
from PIL import Image as PillowImage
from rest_framework.test import APITestCase

from .incremental_import import _concurrent_report_differences, _validate_manifest
from .models import QualityImportBatch, QualityImportMedia, QualityImportRow, QualityReport


def png_bytes(color=(20, 120, 220)) -> bytes:
    output = BytesIO()
    PillowImage.new('RGB', (12, 8), color=color).save(output, format='PNG')
    return output.getvalue()


def issue_rows(*, phenomenon='顶部拉白', sequence=1, report_date='2026-08-03', row_number=3):
    rows = [
        [None, '万佳品质问题点Issue'],
        [
            None, '序号', '发生日期', '发生场所', 'Mold', 'P/N', 'Item',
            '不良现象', '不良数量', '不良照片', '备注',
        ],
    ]
    while len(rows) < row_number - 1:
        rows.append([])
    rows.append([
        None, sequence, report_date, '注塑', '27G523', 'ACQ30854201', 'B/C',
        phenomenon, 'Lot数：8\n不良数：2', None, '刚生产',
    ])
    return rows


def media_entry(key: str, content: bytes, *, row=3, col=10, index=0):
    return {
        'key': key,
        'source_sheet_name': '8月',
        'source_anchor_row': row,
        'source_anchor_col': col,
        'source_index': index,
        'original_filename': f'{key}.png',
        'content_type': 'image/png',
        'byte_size': len(content),
        'sha256': hashlib.sha256(content).hexdigest(),
    }


def make_manifest(*, rows=None, media=None, workbook_hash='a' * 64):
    return {
        'version': 'quality-incremental-v1',
        'filename': '品质 Issue List - 8月.xlsx',
        'file_size': 12_345,
        'workbook_sha256': workbook_hash,
        'workbook_properties': {'title': 'quality-source'},
        'sheets': [{'sheet_name': '8月', 'rows': rows or issue_rows()}],
        'media': media or [],
        'warnings': [],
    }


@override_settings(
    QUALITY_IMPORT_ALLOW_LOCAL_PROXY=True,
    QUALITY_IMPORT_DISABLE_BACKGROUND_PUMP=True,
)
class QualityExcelIncrementalImportAPITests(APITestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.storage = FileSystemStorage(location=self.temp_dir.name, base_url='/test-media/')
        self.storage_patch = mock.patch(
            'quality.direct_import.quality_import_media_storage',
            return_value=self.storage,
        )
        self.storage_patch.start()
        self.user = get_user_model().objects.create_user(
            username='quality-incremental-editor',
            password='test-password',
        )
        self.user.profile.can_view_quality = True
        self.user.profile.can_edit_quality = True
        self.user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        self.client.force_authenticate(self.user)
        self.preview_url = reverse('quality-excel-import-preview')
        self.commit_url = reverse('quality-excel-import-commit')

    def tearDown(self):
        self.storage_patch.stop()
        self.temp_dir.cleanup()

    def preview(self, manifest):
        return self.client.post(self.preview_url, manifest, format='json')

    def commit(self, manifest, files=None, row_keys=None):
        payload = {'manifest': json.dumps(manifest, ensure_ascii=False)}
        if row_keys is not None:
            payload['row_keys'] = json.dumps(row_keys)
        for key, content in (files or {}).items():
            payload[f'media_{key}'] = SimpleUploadedFile(
                f'{key}.png',
                content,
                content_type='image/png',
            )
        return self.client.post(self.commit_url, payload, format='multipart')

    def test_preview_is_read_only_and_commit_uploads_only_new_row_media(self):
        image = png_bytes()
        manifest = make_manifest(media=[media_entry('m0', image)])

        preview = self.preview(manifest)

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data['new_count'], 1)
        self.assertEqual(preview.data['required_media_keys'], ['m0'])
        self.assertEqual(QualityReport.objects.count(), 0)

        committed = self.commit(manifest, {'m0': image})

        self.assertEqual(committed.status_code, 200, committed.data)
        self.assertEqual(committed.data['created_count'], 1)
        self.assertEqual(committed.data['images_saved'], 1)
        report = QualityReport.objects.get()
        self.assertTrue(report.image1)
        self.assertEqual(report.excel_source['media_source_sha256s'], [hashlib.sha256(image).hexdigest()])
        self.assertEqual(len(report.excel_source['media_source_fingerprints']), 1)

    def test_same_manifest_replay_skips_without_reupload(self):
        image = png_bytes()
        manifest = make_manifest(media=[media_entry('m0', image)])
        self.assertEqual(self.commit(manifest, {'m0': image}).status_code, 200)

        preview = self.preview(manifest)
        replay = self.commit(manifest)

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data['unchanged_count'], 1)
        self.assertEqual(preview.data['required_media_keys'], [])
        self.assertEqual(replay.status_code, 200, replay.data)
        self.assertEqual(replay.data['created_count'], 0)
        self.assertEqual(replay.data['skipped_count'], 1)
        self.assertEqual(replay.data['images_skipped'], 1)
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_changed_content_is_reported_without_overwriting_existing_report(self):
        original = make_manifest()
        self.assertEqual(self.commit(original).status_code, 200)
        report = QualityReport.objects.get()
        report.action_result = '사용자 후처리'
        report.save(update_fields=['action_result'])
        revised = make_manifest(
            rows=issue_rows(phenomenon='顶部拉白 修订'),
            workbook_hash='b' * 64,
        )

        preview = self.preview(revised)
        committed = self.commit(revised)

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data['changed_count'], 1)
        self.assertEqual(preview.data['required_media_keys'], [])
        self.assertEqual(committed.status_code, 200, committed.data)
        self.assertEqual(committed.data['changed_count'], 1)
        self.assertEqual(committed.data['changed_report_ids'], [report.pk])
        report.refresh_from_db()
        self.assertEqual(report.phenomenon, '顶部拉白')
        self.assertEqual(report.action_result, '사용자 후처리')
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_changed_raw_image_or_anchor_order_is_detected(self):
        original_image = png_bytes()
        original = make_manifest(media=[media_entry('m0', original_image)])
        self.assertEqual(self.commit(original, {'m0': original_image}).status_code, 200)
        changed_image = png_bytes((220, 40, 40))
        revised = make_manifest(
            media=[media_entry('m0', changed_image)],
            workbook_hash='b' * 64,
        )

        preview = self.preview(revised)

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data['changed_count'], 1)
        self.assertEqual(preview.data['required_media_keys'], [])
        self.assertIn('existing_images_differ', preview.data['rows'][0]['warnings'])

    def test_sequence_correction_on_same_row_is_changed_not_new(self):
        original = make_manifest(rows=issue_rows(sequence=1))
        self.assertEqual(self.commit(original).status_code, 200)
        report = QualityReport.objects.get()
        revised = make_manifest(
            rows=issue_rows(sequence=99),
            workbook_hash='b' * 64,
        )

        preview = self.preview(revised)
        committed = self.commit(revised)

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data['new_count'], 0)
        self.assertEqual(preview.data['changed_count'], 1)
        self.assertEqual(preview.data['rows'][0]['report_id'], report.pk)
        self.assertIn('existing_sequence_differs', preview.data['rows'][0]['warnings'])
        self.assertEqual(committed.data['changed_count'], 1)
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_missing_old_image_fingerprint_requires_review_and_is_not_baselined(self):
        original_image = png_bytes()
        original = make_manifest(media=[media_entry('m0', original_image)])
        self.assertEqual(self.commit(original, {'m0': original_image}).status_code, 200)
        report = QualityReport.objects.get()
        source = dict(report.excel_source)
        source.pop('media_source_sha256s', None)
        source.pop('media_source_fingerprints', None)
        report.excel_source = source
        report.save(update_fields=['excel_source'])
        revised_image = png_bytes((220, 40, 40))
        revised = make_manifest(
            media=[media_entry('m0', revised_image)],
            workbook_hash='b' * 64,
        )

        preview = self.preview(revised)
        committed = self.commit(revised)
        replay = self.preview(revised)

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data['changed_count'], 1)
        self.assertIn('existing_image_fingerprint_missing', preview.data['rows'][0]['warnings'])
        self.assertEqual(committed.data['changed_count'], 1)
        report.refresh_from_db()
        self.assertNotIn('media_source_fingerprints', report.excel_source)
        self.assertEqual(replay.data['changed_count'], 1)

    def test_same_source_can_safely_establish_missing_image_fingerprint(self):
        image = png_bytes()
        manifest = make_manifest(media=[media_entry('m0', image)])
        self.assertEqual(self.commit(manifest, {'m0': image}).status_code, 200)
        report = QualityReport.objects.get()
        source = dict(report.excel_source)
        source.pop('media_source_sha256s', None)
        source.pop('media_source_fingerprints', None)
        report.excel_source = source
        report.save(update_fields=['excel_source'])

        preview = self.preview(manifest)
        committed = self.commit(manifest)

        self.assertEqual(preview.data['unchanged_count'], 1)
        self.assertIn('image_fingerprint_baseline_pending', preview.data['rows'][0]['warnings'])
        self.assertEqual(committed.data['skipped_count'], 1)
        report.refresh_from_db()
        self.assertEqual(
            report.excel_source['media_source_sha256s'],
            [hashlib.sha256(image).hexdigest()],
        )

    def test_legacy_approved_row_uses_legacy_content_and_image_fingerprints(self):
        image = png_bytes()
        manifest = make_manifest(media=[media_entry('m0', image)])
        context = _validate_manifest(manifest, uploaded_on=date(2026, 8, 18))
        source_row = context.parsed.rows[0]
        report = QualityReport.objects.create(
            report_dt=datetime.fromisoformat('2026-08-03T08:00:00+08:00'),
            section=source_row['section'],
            model=source_row['model'],
            part_no=source_row['part_no'],
            lot_qty=source_row['lot_qty'],
            defect_qty=source_row['defect_qty'],
            judgement=source_row['judgement'],
            phenomenon=source_row['phenomenon'],
            disposition=source_row['disposition'],
            action_result=source_row['action_result'],
            image1='/legacy/image.png',
        )
        batch = QualityImportBatch.objects.create(
            uploaded_by=self.user,
            original_filename=manifest['filename'],
            sha256='c' * 64,
            file_size=manifest['file_size'],
        )
        legacy_row = QualityImportRow.objects.create(
            batch=batch,
            sheet_name=source_row['sheet_name'],
            sheet_role=source_row['sheet_role'],
            source_row_number=source_row['source_row_number'],
            source_sequence=source_row['source_sequence'],
            source_key='d' * 64,
            business_key=source_row['business_key'],
            content_sha256=source_row['content_sha256'],
            report_date=source_row['report_date'],
            section=source_row['section'],
            model=source_row['model'],
            part_no=source_row['part_no'],
            lot_qty=source_row['lot_qty'],
            defect_qty=source_row['defect_qty'],
            judgement=source_row['judgement'],
            phenomenon=source_row['phenomenon'],
            disposition=source_row['disposition'],
            action_result=source_row['action_result'],
            approved_report=report,
        )
        QualityImportMedia.objects.create(
            batch=batch,
            row=legacy_row,
            source_sheet_name=source_row['sheet_name'],
            source_anchor_row=source_row['source_row_number'],
            source_anchor_col=10,
            source_index=0,
            original_filename='legacy.png',
            source_sha256=hashlib.sha256(image).hexdigest(),
            source_byte_size=len(image),
        )

        unchanged = self.preview(manifest)
        revised_rows = issue_rows()
        revised_rows[2][10] = '수정된 비고'
        revised = make_manifest(
            rows=revised_rows,
            media=[media_entry('m0', image)],
            workbook_hash='b' * 64,
        )
        changed = self.preview(revised)

        self.assertEqual(unchanged.status_code, 200, unchanged.data)
        self.assertEqual(unchanged.data['unchanged_count'], 1)
        self.assertNotIn('existing_image_fingerprint_missing', unchanged.data['rows'][0]['warnings'])
        self.assertEqual(changed.status_code, 200, changed.data)
        self.assertEqual(changed.data['changed_count'], 1)
        self.assertIn('existing_content_differs', changed.data['rows'][0]['warnings'])

    def test_concurrent_winner_is_rechecked_for_different_content_and_images(self):
        image = png_bytes()
        manifest = make_manifest(media=[media_entry('m0', image)])
        context = _validate_manifest(manifest, uploaded_on=date(2026, 8, 18))
        row = context.parsed.rows[0]
        report = QualityReport.objects.create(
            report_dt=datetime.fromisoformat('2026-08-03T08:00:00+08:00'),
            section='injection',
            model='27G523',
            part_no='ACQ30854201',
            judgement='NG',
            phenomenon='다른 내용',
            excel_import_key=row['business_key'],
            excel_source={
                'content_sha256': 'f' * 64,
                'source_sequence': row['source_sequence'],
                'source_sha256': 'b' * 64,
                'media_source_fingerprints': [],
            },
        )

        differences = _concurrent_report_differences(
            report,
            row,
            context.parsed.media,
            source_sha256=context.source_sha256,
        )

        self.assertIn('existing_content_differs', differences)
        self.assertIn('existing_images_differ', differences)

    def test_only_first_five_images_are_required(self):
        images = [png_bytes((index * 20, 80, 180)) for index in range(6)]
        entries = [
            media_entry(f'm{index}', image, col=10 + index, index=index)
            for index, image in enumerate(images)
        ]
        manifest = make_manifest(media=entries)

        preview = self.preview(manifest)
        committed = self.commit(manifest, {f'm{index}': images[index] for index in range(5)})

        self.assertEqual(preview.status_code, 200, preview.data)
        self.assertEqual(preview.data['required_media_keys'], [f'm{index}' for index in range(5)])
        self.assertEqual(preview.data['images_ignored'], 1)
        self.assertEqual(committed.status_code, 200, committed.data)
        self.assertEqual(committed.data['images_saved'], 5)
        self.assertEqual(committed.data['images_ignored'], 1)
        report = QualityReport.objects.get()
        self.assertTrue(all(getattr(report, f'image{index}') for index in range(1, 6)))

    def test_unique_sequence_can_move_rows_but_duplicate_sequence_uses_exact_anchor(self):
        original = make_manifest(rows=issue_rows(row_number=3))
        self.assertEqual(self.commit(original).status_code, 200)
        moved = make_manifest(rows=issue_rows(row_number=4), workbook_hash='b' * 64)
        moved_preview = self.preview(moved)
        self.assertEqual(moved_preview.status_code, 200, moved_preview.data)
        self.assertEqual(moved_preview.data['unchanged_count'], 1)

        QualityReport.objects.all().delete()
        rows = issue_rows(sequence=9, report_date='2026-08-03', row_number=3)
        rows.append([
            None, 9, '2026-08-04', '注塑', '27G523', 'ACQ30854202', 'B/C',
            '另一事件', 'Lot数：8\n不良数：1', None, '',
        ])
        duplicate_manifest = make_manifest(rows=rows, workbook_hash='c' * 64)
        first = self.commit(duplicate_manifest)
        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(first.data['created_count'], 2)
        rows[3][7] = '另一事件 修订'
        revised = make_manifest(rows=rows, workbook_hash='d' * 64)
        revised_preview = self.preview(revised)
        self.assertEqual(revised_preview.status_code, 200, revised_preview.data)
        self.assertEqual(revised_preview.data['changed_count'], 1)
        self.assertEqual(revised_preview.data['unchanged_count'], 1)
        self.assertEqual(QualityReport.objects.count(), 2)

    def test_hash_mismatch_rejects_commit_before_any_report_is_created(self):
        declared = png_bytes()
        different = png_bytes((1, 2, 3))
        manifest = make_manifest(media=[media_entry('m0', declared)])

        response = self.commit(manifest, {'m0': different})

        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data['code'], 'image_size_mismatch' if len(declared) != len(different) else 'image_hash_mismatch')
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_chunk_rejects_known_but_unrequested_media(self):
        image = png_bytes()
        manifest = make_manifest(media=[media_entry('m0', image)])

        response = self.commit(manifest, {'m0': image}, row_keys=[])

        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data['code'], 'unexpected_media')
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_stale_new_preview_media_is_ignored_after_another_commit_wins(self):
        image = png_bytes()
        manifest = make_manifest(media=[media_entry('m0', image)])
        preview = self.preview(manifest)
        row_key = preview.data['rows'][0]['row_key']
        self.assertEqual(self.commit(manifest, {'m0': image}, [row_key]).status_code, 200)

        stale_commit = self.commit(manifest, {'m0': image}, [row_key])

        self.assertEqual(stale_commit.status_code, 200, stale_commit.data)
        self.assertEqual(stale_commit.data['created_count'], 0)
        self.assertEqual(stale_commit.data['skipped_count'], 1)
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_manifest_warnings_and_chunk_row_selection_are_bounded(self):
        invalid_warnings = make_manifest()
        invalid_warnings['warnings'] = 'not-an-array'
        warning_response = self.preview(invalid_warnings)

        row_keys = [hashlib.sha256(str(index).encode()).hexdigest() for index in range(11)]
        chunk_response = self.commit(make_manifest(), row_keys=row_keys)

        self.assertEqual(warning_response.status_code, 400, warning_response.data)
        self.assertEqual(warning_response.data['code'], 'invalid_manifest')
        self.assertEqual(chunk_response.status_code, 400, chunk_response.data)
        self.assertEqual(chunk_response.data['code'], 'invalid_row_selection')

    def test_selected_row_chunks_register_only_the_requested_new_rows(self):
        rows = issue_rows(sequence=1, report_date='2026-08-03', row_number=3)
        rows.append([
            None, 2, '2026-08-04', '注塑', '27G523', 'ACQ30854202', 'B/C',
            '另一事件', 'Lot数：8\n不良数：1', None, '',
        ])
        manifest = make_manifest(rows=rows)
        preview = self.preview(manifest)
        row_keys = [row['row_key'] for row in preview.data['rows']]

        first = self.commit(manifest, row_keys=[row_keys[0]])
        remaining = self.preview(manifest)
        second = self.commit(manifest, row_keys=[row_keys[1]])

        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(first.data['total_rows'], 1)
        self.assertEqual(first.data['created_count'], 1)
        self.assertEqual(remaining.data['new_count'], 1)
        self.assertEqual(remaining.data['unchanged_count'], 1)
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(second.data['created_count'], 1)
        self.assertEqual(QualityReport.objects.count(), 2)

    def test_preview_and_commit_require_edit_permission(self):
        viewer = get_user_model().objects.create_user(
            username='quality-incremental-viewer',
            password='test-password',
        )
        viewer.profile.can_view_quality = True
        viewer.profile.can_edit_quality = False
        viewer.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        self.client.force_authenticate(viewer)

        self.assertEqual(self.preview(make_manifest()).status_code, 403)
        self.assertEqual(self.commit(make_manifest()).status_code, 403)
