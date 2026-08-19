from datetime import date, datetime, time
from unittest import mock
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import SimpleTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from .duplicate_detection import _score, find_best_report_duplicates
from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportMedia,
    QualityImportProvenance,
    QualityImportRow,
    QualityReport,
)
from .serializers import QualityImportRowSerializer
from .storage import ContentAddressedImageCloudinaryStorage
from .import_views import _safe_filename
from .excel_import import WorkbookValidationError, normalized_row_fingerprint


@override_settings(QUALITY_IMPORT_DISABLE_BACKGROUND_PUMP=True)
class QualityImportSecurityTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username='quality-import-security',
            password='test-password',
        )
        self.user.profile.can_view_quality = True
        self.user.profile.can_edit_quality = True
        self.user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        self.client.force_authenticate(self.user)
        self.batch = QualityImportBatch.objects.create(
            uploaded_by=self.user,
            original_filename='quality.xlsx',
            sha256='1' * 64,
            file_size=1024,
            status=QualityImportBatch.Status.READY,
            phase='ready',
        )
        self.provenance = QualityImportProvenance.objects.create(
            batch=self.batch,
            source_sha256=self.batch.sha256,
            source_content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            source_filename='quality.xlsx',
            source_byte_size=self.batch.file_size,
            source_discarded_at=timezone.now(),
        )
        self.row = QualityImportRow.objects.create(
            batch=self.batch,
            sheet_name='8月',
            source_row_number=3,
            source_key='2' * 64,
            business_key='3' * 64,
            content_sha256='4' * 64,
            report_date=date(2026, 8, 14),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30854201',
            phenomenon='original defect',
        )
        self.asset = QualityImportAsset.objects.create(
            sha256='5' * 64,
            byte_size=123,
            content_type='image/png',
            width=10,
            height=10,
            extension='png',
            storage_key='quality-import/assets/' + ('5' * 64),
            file='quality-import/assets/' + ('5' * 64),
            upload_state=QualityImportAsset.UploadState.READY,
            created_by_batch=self.batch,
            archive_relative_path='objects/sha256/55/55/' + ('5' * 64),
        )
        self.media = QualityImportMedia.objects.create(
            batch=self.batch,
            row=self.row,
            asset=self.asset,
            source_sheet_name='8月',
            source_anchor_row=3,
            source_anchor_col=10,
            original_filename='issue.png',
        )

    def test_normal_serializers_never_expose_staged_bytes_or_storage_internals(self):
        batch_response = self.client.get(
            reverse('quality-import-batch-detail', kwargs={'pk': self.batch.pk}),
        )
        self.assertEqual(batch_response.status_code, 200, batch_response.data)
        self.assertNotIn('chunk_count', batch_response.data)
        self.assertNotIn('uploaded_chunks', batch_response.data)
        self.assertNotIn('source_file', batch_response.data['provenance'])

        media_response = self.client.get(
            reverse('quality-import-media-detail', kwargs={'pk': self.media.pk}),
        )
        self.assertEqual(media_response.status_code, 200, media_response.data)
        self.assertNotIn('storage_key', media_response.data)
        self.assertNotIn('staged_bytes', media_response.data)

        asset_response = self.client.get(
            reverse('quality-import-asset-detail', kwargs={'pk': self.asset.pk}),
        )
        self.assertEqual(asset_response.status_code, 200, asset_response.data)
        self.assertNotIn('storage_key', asset_response.data)
        self.assertNotIn('staged_bytes', asset_response.data)
        self.assertNotIn('processing_owner', asset_response.data)

    def test_patch_cannot_overwrite_a_publish_that_won_after_validation(self):
        report = QualityReport.objects.create(
            report_dt=timezone.now(),
            section='LQC_INJ',
            model=self.row.model,
            part_no=self.row.part_no,
            phenomenon=self.row.phenomenon,
        )
        original_validate = QualityImportRowSerializer.validate

        def publish_after_validation(serializer, attrs):
            validated = original_validate(serializer, attrs)
            QualityImportRow.objects.filter(pk=self.row.pk).update(
                approved_report=report,
                review_status=QualityImportRow.ReviewStatus.PUBLISHED,
                published_at=timezone.now(),
            )
            return validated

        with mock.patch.object(QualityImportRowSerializer, 'validate', new=publish_after_validation):
            response = self.client.patch(
                reverse('quality-import-row-detail', kwargs={'pk': self.row.pk}),
                {'phenomenon': 'stale patch must not win'},
                format='json',
            )
        self.assertEqual(response.status_code, 400, response.data)
        self.row.refresh_from_db()
        self.assertEqual(self.row.review_status, QualityImportRow.ReviewStatus.PUBLISHED)
        self.assertEqual(self.row.phenomenon, 'original defect')

    def test_pending_batch_rows_and_assets_are_not_public(self):
        pending = QualityImportBatch.objects.create(
            uploaded_by=self.user,
            original_filename='pending.xlsx',
            sha256='a' * 64,
            file_size=1024,
            status=QualityImportBatch.Status.QUEUED,
        )
        pending_row = QualityImportRow.objects.create(
            batch=pending,
            sheet_name='8月',
            source_row_number=3,
            source_key='b' * 64,
            business_key='c' * 64,
            content_sha256='d' * 64,
            phenomenon='private until ready',
        )
        row_response = self.client.get(
            reverse('quality-import-row-detail', kwargs={'pk': pending_row.pk}),
        )
        self.assertEqual(row_response.status_code, 404, row_response.data)

    def test_unsafe_filename_is_rejected_without_state(self):
        with self.assertRaises(WorkbookValidationError):
            _safe_filename('../quality.xlsx')


@override_settings(QUALITY_IMPORT_DISABLE_BACKGROUND_PUMP=True)
class QualityImportManualDuplicateTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username='quality-duplicate-reviewer',
            password='test-password',
        )
        self.user.profile.can_view_quality = True
        self.user.profile.can_edit_quality = True
        self.user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        self.client.force_authenticate(self.user)
        self.batch = QualityImportBatch.objects.create(
            uploaded_by=self.user,
            original_filename='daily.xlsx',
            sha256='8' * 64,
            file_size=1024,
            status=QualityImportBatch.Status.READY,
            phase='ready',
        )
        self.row = QualityImportRow.objects.create(
            batch=self.batch,
            sheet_name='8月',
            sheet_role='monthly_issue',
            source_row_number=3,
            source_key='9' * 64,
            business_key='a' * 64,
            content_sha256='b' * 64,
            evidence_sha256='c' * 64,
            report_date=date(2026, 8, 17),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30776301',
            defect_qty=8,
            judgement='NG',
            phenomenon='表面色差',
            disposition='注塑调整后生产',
            action_result='确认中',
            review_status=QualityImportRow.ReviewStatus.REVIEWED,
            reviewed_by=self.user,
            reviewed_at=timezone.now(),
        )
        self.row.reviewed_content_sha256 = normalized_row_fingerprint(self.row)
        self.row.save(update_fields=['reviewed_content_sha256', 'updated_at'])
        self.manual = QualityReport.objects.create(
            report_dt=datetime.combine(
                self.row.report_date,
                time(hour=15, minute=36),
                tzinfo=ZoneInfo('Asia/Shanghai'),
            ),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30776301',
            lot_qty=99,
            inspection_qty=120,
            defect_qty=8,
            judgement='NG',
            phenomenon='色差',
            disposition='调整后继续生产',
            action_result='기존 수동 보고',
            image1='https://res.cloudinary.com/example/image/upload/quality/existing.jpg',
        )
        self.detail_url = reverse('quality-import-row-detail', kwargs={'pk': self.row.pk})
        self.publish_url = reverse('quality-import-row-publish', kwargs={'pk': self.row.pk})

    def test_semantically_equivalent_manual_report_is_exposed_and_blocks_publish(self):
        detail = self.client.get(self.detail_url)
        self.assertEqual(detail.status_code, 200, detail.data)
        match = detail.data['duplicate_match']
        self.assertEqual(match['level'], 'likely')
        self.assertEqual(match['report_id'], self.manual.pk)
        self.assertEqual(match['source_kind'], 'manual')
        self.assertEqual(match['report']['report_date'], '2026-08-17')
        self.assertEqual(len(match['version']), 64)
        self.assertIn('same_defect_category', match['reasons'])
        self.assertEqual(match['report']['lot_qty'], 99)
        self.assertEqual(match['report']['inspection_qty'], 120)
        self.assertEqual(match['report']['judgement'], 'NG')
        self.assertEqual(match['report']['disposition'], '调整后继续生产')
        self.assertEqual(
            match['report']['images'],
            ['https://res.cloudinary.com/example/image/upload/quality/existing.jpg'],
        )

        blocked = self.client.post(self.publish_url, {}, format='json')
        self.assertEqual(blocked.status_code, 409, blocked.data)
        self.assertEqual(blocked.data['code'], 'possible_existing_report_duplicate')
        self.assertEqual(
            blocked.data['allowed_actions'],
            ['link_existing', 'update_existing', 'separate'],
        )
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_future_reviewed_row_cannot_be_published(self):
        self.row.report_date = date(2026, 8, 20)
        self.row.reviewed_content_sha256 = normalized_row_fingerprint(self.row)
        self.row.save(update_fields=['report_date', 'reviewed_content_sha256', 'updated_at'])

        with mock.patch(
            'quality.views.timezone.now',
            return_value=datetime(2026, 8, 19, 12, tzinfo=ZoneInfo('Asia/Shanghai')),
        ):
            blocked = self.client.post(self.publish_url, {}, format='json')

        self.assertEqual(blocked.status_code, 400, blocked.data)
        self.assertEqual(blocked.data['code'], 'publish_validation_failed')
        self.assertIn('report_date cannot be in the future', blocked.data['errors'])
        self.assertIsNone(self.row.approved_report_id)

    def test_same_part_with_unrelated_defect_is_not_flagged(self):
        self.manual.phenomenon = '尺寸超差'
        self.manual.disposition = '重新测量尺寸'
        self.manual.save(update_fields=['phenomenon', 'disposition', 'updated_at'])

        detail = self.client.get(self.detail_url)
        self.assertEqual(detail.status_code, 200, detail.data)
        self.assertIsNone(detail.data['duplicate_match'])

    def test_identifier_formatting_is_normalized_but_conflicting_part_is_rejected(self):
        self.manual.part_no = 'ACQ-3077 6301'
        self.manual.save(update_fields=['part_no', 'updated_at'])
        formatted = self.client.get(self.detail_url)
        self.assertEqual(formatted.status_code, 200, formatted.data)
        self.assertEqual(formatted.data['duplicate_match']['report_id'], self.manual.pk)

        self.manual.part_no = 'DIFFERENT-PART'
        self.manual.save(update_fields=['part_no', 'updated_at'])
        conflicting = self.client.get(self.detail_url)
        self.assertEqual(conflicting.status_code, 200, conflicting.data)
        self.assertIsNone(conflicting.data['duplicate_match'])

    def test_generic_row_list_uses_one_bulk_duplicate_pass(self):
        with mock.patch(
            'quality.views.find_best_report_duplicates',
            wraps=find_best_report_duplicates,
        ) as bulk, mock.patch(
            'quality.serializers.find_best_report_duplicate',
        ) as singleton:
            response = self.client.get(reverse('quality-import-row-list'))
        self.assertEqual(response.status_code, 200, response.data)
        bulk.assert_called_once()
        singleton.assert_not_called()

    def test_bulk_duplicate_query_excludes_unrequested_dates(self):
        other_row = QualityImportRow.objects.create(
            batch=self.batch,
            sheet_name='8月',
            sheet_role='monthly_issue',
            source_row_number=99,
            source_key='1' * 64,
            business_key='2' * 64,
            content_sha256='3' * 64,
            report_date=date(2026, 8, 19),
            section='LQC_INJ',
            model='OTHER',
            part_no='OTHER-PART',
            phenomenon='划伤',
            review_status=QualityImportRow.ReviewStatus.DRAFT,
        )
        irrelevant = QualityReport.objects.create(
            report_dt=datetime.combine(
                date(2026, 8, 18),
                time(hour=10),
                tzinfo=ZoneInfo('Asia/Shanghai'),
            ),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30776301',
            phenomenon='色差',
        )
        with mock.patch(
            'quality.duplicate_detection._score',
            wraps=_score,
        ) as score:
            matches = find_best_report_duplicates([self.row, other_row])

        self.assertEqual(matches[self.row.pk]['report_id'], self.manual.pk)
        scored_report_ids = {call.args[1].pk for call in score.call_args_list}
        self.assertNotIn(irrelevant.pk, scored_report_ids)

    def test_link_existing_records_provenance_without_overwriting_report(self):
        candidate = find_best_report_duplicates([self.row])[self.row.pk]
        response = self.client.post(
            self.publish_url,
            {
                'duplicate_action': 'link_existing',
                'duplicate_report_id': self.manual.pk,
                'duplicate_report_version': candidate['version'],
                'duplicate_reason': '동일한 현장 불량 건 확인',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.row.refresh_from_db()
        self.manual.refresh_from_db()
        self.assertEqual(self.row.approved_report_id, self.manual.pk)
        self.assertEqual(self.row.review_status, QualityImportRow.ReviewStatus.PUBLISHED)
        self.assertEqual(self.manual.phenomenon, '色差')
        self.assertTrue(response.data['linked_existing_report'])

    def test_update_existing_and_separate_are_explicit(self):
        self.row.lot_qty = None
        self.row.inspection_qty = None
        self.row.disposition = ''
        self.row.action_result = ''
        self.row.judgement = ''
        self.manual.judgement = 'HOLD'
        self.manual.save(update_fields=['judgement', 'updated_at'])
        self.row.reviewed_content_sha256 = normalized_row_fingerprint(self.row)
        self.row.save(update_fields=[
            'lot_qty', 'inspection_qty', 'disposition', 'action_result', 'judgement',
            'reviewed_content_sha256', 'updated_at',
        ])
        update_candidate = find_best_report_duplicates([self.row])[self.row.pk]
        updated = self.client.post(
            self.publish_url,
            {
                'duplicate_action': 'update_existing',
                'duplicate_report_id': self.manual.pk,
                'duplicate_report_version': update_candidate['version'],
                'duplicate_reason': '엑셀 검토 내용으로 기존 건 보완',
            },
            format='json',
        )
        self.assertEqual(updated.status_code, 200, updated.data)
        self.manual.refresh_from_db()
        self.assertEqual(self.manual.phenomenon, self.row.phenomenon)
        self.assertEqual(self.manual.report_dt.astimezone(ZoneInfo('Asia/Shanghai')).time(), time(15, 36))
        self.assertEqual(self.manual.lot_qty, 99)
        self.assertEqual(self.manual.inspection_qty, 120)
        self.assertEqual(self.manual.disposition, '调整后继续生产')
        self.assertEqual(self.manual.action_result, '기존 수동 보고')
        self.assertEqual(self.manual.judgement, 'HOLD')
        self.assertEqual(
            self.manual.image1,
            'https://res.cloudinary.com/example/image/upload/quality/existing.jpg',
        )
        self.assertTrue(updated.data['updated_existing_report'])

        second_row = QualityImportRow.objects.create(
            batch=self.batch,
            sheet_name='8月',
            sheet_role='monthly_issue',
            source_row_number=4,
            source_key='d' * 64,
            business_key='e' * 64,
            content_sha256='f' * 64,
            report_date=date(2026, 8, 17),
            section='LQC_INJ',
            model='27G523',
            part_no='ACQ30776301',
            defect_qty=8,
            judgement='NG',
            phenomenon='색차',
            disposition='별도 생산 Lot',
            review_status=QualityImportRow.ReviewStatus.REVIEWED,
            reviewed_by=self.user,
            reviewed_at=timezone.now(),
        )
        second_row.reviewed_content_sha256 = normalized_row_fingerprint(second_row)
        second_row.save(update_fields=['reviewed_content_sha256', 'updated_at'])
        separate_candidate = find_best_report_duplicates([second_row])[second_row.pk]
        separate = self.client.post(
            reverse('quality-import-row-publish', kwargs={'pk': second_row.pk}),
            {
                'duplicate_action': 'separate',
                'duplicate_report_id': self.manual.pk,
                'duplicate_report_version': separate_candidate['version'],
                'duplicate_reason': '동일 품번이지만 별도 생산 Lot',
            },
            format='json',
        )
        self.assertEqual(separate.status_code, 201, separate.data)
        self.assertEqual(QualityReport.objects.count(), 2)

    def test_stale_duplicate_version_cannot_overwrite_recent_manual_edit(self):
        candidate = find_best_report_duplicates([self.row])[self.row.pk]
        self.manual.action_result = '다른 관리자가 방금 확정한 조치'
        self.manual.save(update_fields=['action_result', 'updated_at'])

        response = self.client.post(
            self.publish_url,
            {
                'duplicate_action': 'update_existing',
                'duplicate_report_id': self.manual.pk,
                'duplicate_report_version': candidate['version'],
                'duplicate_reason': '기존 보고와 동일 건으로 판단',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data['code'], 'duplicate_candidate_changed')
        self.manual.refresh_from_db()
        self.row.refresh_from_db()
        self.assertEqual(self.manual.action_result, '다른 관리자가 방금 확정한 조치')
        self.assertIsNone(self.row.approved_report_id)

    def test_duplicate_report_date_is_serialized_in_shanghai_timezone(self):
        self.manual.report_dt = datetime(
            2026, 8, 16, 17, 30, tzinfo=ZoneInfo('UTC')
        )
        self.manual.save(update_fields=['report_dt', 'updated_at'])

        match = find_best_report_duplicates([self.row])[self.row.pk]

        self.assertEqual(match['report']['report_dt'][:10], '2026-08-16')
        self.assertEqual(match['report']['report_date'], '2026-08-17')


class QualityImportStorageContractTests(SimpleTestCase):
    @mock.patch('quality.storage.cloudinary.uploader.destroy', return_value={'result': 'not found'})
    @mock.patch('quality.storage.cloudinary.uploader.upload', return_value={'public_id': 'asset-key'})
    def test_content_addressed_image_storage_never_overwrites(self, upload, destroy):
        storage = ContentAddressedImageCloudinaryStorage()
        storage._upload('quality-import/assets/abc', ContentFile(b'png'))
        self.assertEqual(upload.call_args.kwargs['public_id'], 'quality-import/assets/abc')
        self.assertEqual(upload.call_args.kwargs['resource_type'], 'image')
        self.assertFalse(upload.call_args.kwargs['overwrite'])
        self.assertFalse(upload.call_args.kwargs['unique_filename'])
        self.assertEqual(upload.call_args.kwargs['timeout'], 60)
        self.assertTrue(storage.delete('quality-import/assets/abc'))
        self.assertEqual(destroy.call_args.kwargs['timeout'], 60)
