from datetime import date
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import SimpleTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

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
from .excel_import import WorkbookValidationError


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
