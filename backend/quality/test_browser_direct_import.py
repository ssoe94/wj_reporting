from __future__ import annotations

import hashlib
import re
import tempfile
from datetime import date, datetime, timedelta
from io import BytesIO
from unittest import mock
from zoneinfo import ZoneInfo

from cloudinary.utils import api_sign_request
from django.contrib.auth import get_user_model
from django.core.files.storage import FileSystemStorage
from django.test import override_settings
from django.utils import timezone
from PIL import Image as PillowImage
from rest_framework.test import APITestCase

from .cloudinary_utils import (
    QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
    clear_quality_import_direct_preset_cache,
)
from .browser_direct_import import _resume_existing_direct_batch
from .excel_import import MAX_MEDIA_BYTES
from .incremental_import import (
    INCREMENTAL_JOB_DATASET_KEY,
    _incremental_job_scope_key,
    preview_quality_manifest,
)
from .models import QualityImportAsset, QualityImportBatch, QualityReport
from .test_incremental_import_jobs import _issue_rows, _manifest, _media_item, _png_bytes


TEST_CLOUD_NAME = 'browser-direct-test-cloud'
TEST_API_KEY = 'browser-direct-test-key'
TEST_API_SECRET = 'browser-direct-test-secret'


@override_settings(
    QUALITY_IMPORT_ALLOW_LOCAL_PROXY=False,
    QUALITY_IMPORT_DISABLE_BACKGROUND_PUMP=True,
    CLOUDINARY_STORAGE={
        'CLOUD_NAME': TEST_CLOUD_NAME,
        'API_KEY': TEST_API_KEY,
        'API_SECRET': TEST_API_SECRET,
    },
)
class QualityBrowserDirectImportTests(APITestCase):
    """Contract tests for the browser-to-Cloudinary incremental import path."""

    jobs_url = '/api/quality/excel-import/direct/jobs/'

    def setUp(self):
        clear_quality_import_direct_preset_cache()
        self.preset_api_patcher = mock.patch(
            'quality.cloudinary_utils.cloudinary.api.upload_preset',
            return_value={
                'name': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
                'unsigned': False,
                'settings': {},
            },
        )
        self.preset_api = self.preset_api_patcher.start()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.storage = FileSystemStorage(location=self.temp_dir.name, base_url='/test-media/')
        self.media_field = QualityImportAsset._meta.get_field('file')
        self.original_storage = self.media_field.storage
        self.media_field.storage = self.storage

        self.editor = self._user('browser-direct-editor', view=True, edit=True)
        self.other_editor = self._user('browser-direct-other-editor', view=True, edit=True)
        self.viewer = self._user('browser-direct-viewer', view=True, edit=False)
        self.client.force_authenticate(self.editor)

    def tearDown(self):
        self.media_field.storage = self.original_storage
        self.temp_dir.cleanup()
        self.preset_api_patcher.stop()
        clear_quality_import_direct_preset_cache()

    @staticmethod
    def _user(username: str, *, view: bool, edit: bool):
        user = get_user_model().objects.create_user(username=username, password='test-password')
        user.profile.can_view_quality = view
        user.profile.can_edit_quality = edit
        user.profile.save(update_fields=['can_view_quality', 'can_edit_quality'])
        return user

    @staticmethod
    def _prepare_payload(manifest: dict[str, object]) -> dict[str, object]:
        preview = preview_quality_manifest(manifest, uploaded_on=date(2026, 8, 19))
        return {
            'manifest': manifest,
            'row_keys': [row['row_key'] for row in preview['rows']],
        }

    def _prepare(self, manifest: dict[str, object]):
        return self.client.post(
            self.jobs_url,
            self._prepare_payload(manifest),
            format='json',
        )

    @staticmethod
    def _complete_url(batch_id: int, asset_sha256: str) -> str:
        return (
            f'/api/quality/excel-import/direct/jobs/{batch_id}/assets/'
            f'{asset_sha256}/complete/'
        )

    @staticmethod
    def _finalize_url(batch_id: int) -> str:
        return f'/api/quality/excel-import/direct/jobs/{batch_id}/finalize/'

    def _assert_prepare_contract(self, response, *, intent_count: int):
        payload = getattr(response, 'data', None)
        self.assertEqual(response.status_code, 202, payload)
        self.assertEqual(payload['delivery_mode'], 'browser_direct')
        self.assertIsInstance(payload['idempotent_replay'], bool)
        self.assertEqual(len(payload['upload_intents']), intent_count)

    def _assert_terminal_finalize(self, response):
        payload = getattr(response, 'data', None)
        self.assertEqual(response.status_code, 200, payload)
        self.assertEqual(payload['delivery_mode'], 'browser_direct')
        self.assertIn(payload['status'], {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertIsInstance(payload['result'], dict)
        self.assertEqual(payload['upload_intents'], [])

    def _assert_pending_public_id(
        self,
        public_id: str,
        *,
        batch_id: int,
        asset_sha256: str,
        storage_prefix: str = '',
    ):
        self.assertRegex(
            public_id,
            re.compile(
                rf'^{re.escape(storage_prefix)}quality-import/pending/{batch_id}/'
                rf'{asset_sha256}-[0-9a-f]{{24}}$'
            ),
        )

    @staticmethod
    def _admin_metadata(
        *,
        public_id: str,
        version: int,
        content: bytes,
    ) -> dict[str, object]:
        with PillowImage.open(BytesIO(content)) as image:
            width, height = image.size
        return {
            'asset_id': f'asset-{hashlib.sha256(public_id.encode()).hexdigest()[:24]}',
            'public_id': public_id,
            'version': version,
            'resource_type': 'image',
            'type': 'upload',
            'format': 'png',
            'bytes': len(content),
            'width': width,
            'height': height,
            'etag': hashlib.md5(content, usedforsecurity=False).hexdigest(),
            'secure_url': (
                f'https://res.cloudinary.com/{TEST_CLOUD_NAME}/image/upload/'
                f'v{version}/{public_id}.png'
            ),
        }

    def _complete(
        self,
        *,
        batch_id: int,
        intent: dict[str, object],
        content: bytes,
        version: int = 1,
    ):
        upload = intent['upload']
        receipt = {
            'public_id': upload['public_id'],
            'version': version,
            'signature': 'verified-response-signature',
        }
        metadata = self._admin_metadata(
            public_id=upload['public_id'],
            version=version,
            content=content,
        )
        with (
            mock.patch(
                'quality.browser_direct_import.verify_direct_upload_response',
                return_value=True,
            ) as verify,
            mock.patch(
                'quality.browser_direct_import.cloudinary.api.resource',
                return_value=metadata,
            ) as resource,
        ):
            response = self.client.post(
                self._complete_url(batch_id, intent['asset_sha256']),
                receipt,
                format='json',
            )
        self.assertIn(response.status_code, {200, 202}, response.data)
        verify.assert_called_once_with(
            public_id=upload['public_id'],
            version=version,
            signature=receipt['signature'],
        )
        resource.assert_called_once()
        called_public_id = (
            resource.call_args.args[0]
            if resource.call_args.args
            else resource.call_args.kwargs['public_id']
        )
        self.assertEqual(called_public_id, upload['public_id'])
        return response

    def test_prepare_requires_editor_and_mutating_job_endpoints_keep_that_boundary(self):
        manifest = _manifest(workbook_sha256='1' * 64)
        payload = self._prepare_payload(manifest)

        self.client.force_authenticate(user=None)
        anonymous = self.client.post(self.jobs_url, payload, format='json')
        self.assertIn(anonymous.status_code, {401, 403})

        self.client.force_authenticate(self.viewer)
        viewer = self.client.post(self.jobs_url, payload, format='json')
        self.assertEqual(viewer.status_code, 403, viewer.data)

        self.client.force_authenticate(self.editor)
        prepared = self.client.post(self.jobs_url, payload, format='json')
        self._assert_prepare_contract(prepared, intent_count=0)
        batch_id = prepared.data['id']

        self.client.force_authenticate(user=None)
        anonymous_finalize = self.client.post(self._finalize_url(batch_id), {}, format='json')
        self.assertIn(anonymous_finalize.status_code, {401, 403})

        self.client.force_authenticate(self.viewer)
        viewer_finalize = self.client.post(self._finalize_url(batch_id), {}, format='json')
        self.assertEqual(viewer_finalize.status_code, 403, viewer_finalize.data)

        self.client.force_authenticate(self.editor)
        editor_finalize = self.client.post(self._finalize_url(batch_id), {}, format='json')
        self._assert_terminal_finalize(editor_finalize)

    def test_prepare_stages_no_bytes_or_remote_io_and_returns_narrow_signed_intent(self):
        image = _png_bytes((20, 120, 220))
        image_sha256 = hashlib.sha256(image).hexdigest()
        media = _media_item('m0', image, 0)
        # Untrusted routing fields must never affect the issued Cloudinary target.
        media.update({
            'public_id': 'attacker-controlled/object',
            'folder': 'attacker-controlled',
            'overwrite': True,
            'unique_filename': True,
        })
        manifest = _manifest([media], workbook_sha256='2' * 64)

        with (
            mock.patch.object(self.storage, 'save', wraps=self.storage.save) as storage_save,
            mock.patch.object(self.storage, 'exists', wraps=self.storage.exists) as storage_exists,
            mock.patch.object(self.storage, 'open', wraps=self.storage.open) as storage_open,
            mock.patch('cloudinary.uploader.upload') as cloudinary_upload,
            mock.patch('cloudinary.api.resource') as cloudinary_resource,
        ):
            response = self._prepare(manifest)

        self._assert_prepare_contract(response, intent_count=1)
        storage_save.assert_not_called()
        storage_exists.assert_not_called()
        storage_open.assert_not_called()
        cloudinary_upload.assert_not_called()
        cloudinary_resource.assert_not_called()

        intent = response.data['upload_intents'][0]
        self.assertEqual(intent['asset_sha256'], image_sha256)
        self.assertEqual(intent['media_keys'], ['m0'])
        self.assertEqual(intent['source_byte_size'], len(image))
        self.assertEqual(intent['source_content_type'], 'image/png')
        upload = intent['upload']
        self.assertEqual(upload['cloud_name'], TEST_CLOUD_NAME)
        self.assertEqual(upload['api_key'], TEST_API_KEY)
        self._assert_pending_public_id(
            upload['public_id'],
            batch_id=response.data['id'],
            asset_sha256=image_sha256,
        )
        self.assertNotEqual(upload['public_id'], media['public_id'])
        self.assertEqual(upload['allowed_formats'], 'png')
        self.assertEqual(
            upload['upload_preset'],
            QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
        )
        self.assertIs(upload['overwrite'], False)
        self.assertIs(upload['unique_filename'], False)
        # Cloudinary's Python helper drops false booleans. They must therefore
        # be signed as the exact strings submitted by multipart FormData.
        self.assertEqual(
            upload['signature'],
            api_sign_request(
                {
                    'allowed_formats': 'png',
                    'overwrite': 'false',
                    'public_id': upload['public_id'],
                    'timestamp': upload['timestamp'],
                    'unique_filename': 'false',
                    'upload_preset': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
                },
                TEST_API_SECRET,
            ),
        )

        asset = QualityImportAsset.objects.get(sha256=image_sha256)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertIsNone(asset.staged_bytes)
        self.assertFalse(asset.file)
        self.assertEqual(asset.storage_key, f'quality-import/assets/{image_sha256}')
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_prepare_fails_closed_for_missing_or_unsigned_cloudinary_preset(self):
        image = _png_bytes((70, 20, 140))
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='d' * 64,
        )
        unsafe_responses = [
            None,
            {},
            {
                'name': 'different-browser-direct-preset',
                'unsigned': False,
            },
            {
                'name': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
                'unsigned': True,
            },
            {
                'name': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
                'settings': {},
            },
            {
                'name': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
                'unsigned': 'false',
            },
        ]
        for unsafe in unsafe_responses:
            with self.subTest(preset=unsafe):
                clear_quality_import_direct_preset_cache()
                self.preset_api.reset_mock(side_effect=True, return_value=True)
                self.preset_api.return_value = unsafe
                response = self._prepare(manifest)
                self.assertEqual(response.status_code, 503, response.data)
                self.assertEqual(response.data['code'], 'production_storage_required')
                self.assertEqual(QualityImportBatch.objects.count(), 0)
                self.assertEqual(QualityImportAsset.objects.count(), 0)

        clear_quality_import_direct_preset_cache()
        self.preset_api.reset_mock(side_effect=True, return_value=True)
        self.preset_api.side_effect = TimeoutError('simulated admin timeout')
        response = self._prepare(manifest)
        self.assertEqual(response.status_code, 503, response.data)
        self.assertEqual(response.data['code'], 'production_storage_required')
        self.assertEqual(QualityImportBatch.objects.count(), 0)
        self.assertEqual(QualityImportAsset.objects.count(), 0)

    def test_prepare_accepts_signed_preset_without_size_metadata_and_caches_success(self):
        self.preset_api.return_value = {
            'name': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
            'unsigned': False,
            'settings': {},
        }
        image = _png_bytes((40, 120, 80))
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='e' * 64,
        )
        first = self._prepare(manifest)
        self._assert_prepare_contract(first, intent_count=1)
        replay = self._prepare(manifest)
        self._assert_prepare_contract(replay, intent_count=1)
        self.preset_api.assert_called_once_with(
            QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
            cloud_name=TEST_CLOUD_NAME,
            api_key=TEST_API_KEY,
            api_secret=TEST_API_SECRET,
            timeout=10,
        )

    def test_prepare_rejects_declared_media_over_10mb_before_issuing_signature(self):
        image = _png_bytes((60, 80, 100))
        media = _media_item('m0', image, 0)
        manifest = _manifest([media], workbook_sha256='f' * 64)
        payload = self._prepare_payload(manifest)
        media['byte_size'] = MAX_MEDIA_BYTES + 1

        response = self.client.post(self.jobs_url, payload, format='json')

        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data['code'], 'invalid_manifest')
        self.preset_api.assert_not_called()
        self.assertEqual(QualityImportBatch.objects.count(), 0)
        self.assertEqual(QualityImportAsset.objects.count(), 0)

    def test_complete_rejects_foreign_owner_wrong_public_id_and_bad_signature(self):
        image = _png_bytes((80, 20, 160))
        prepared = self._prepare(
            _manifest([_media_item('m0', image, 0)], workbook_sha256='3' * 64)
        )
        self._assert_prepare_contract(prepared, intent_count=1)
        intent = prepared.data['upload_intents'][0]
        upload = intent['upload']
        complete_url = self._complete_url(prepared.data['id'], intent['asset_sha256'])
        valid_shape = {
            'public_id': upload['public_id'],
            'version': 1,
            'signature': 'candidate-signature',
        }

        with (
            mock.patch(
                'quality.browser_direct_import.verify_direct_upload_response',
                return_value=True,
            ) as verify,
            mock.patch('quality.browser_direct_import.cloudinary.api.resource') as resource,
        ):
            self.client.force_authenticate(user=None)
            anonymous = self.client.post(complete_url, valid_shape, format='json')
            self.assertIn(anonymous.status_code, {401, 403})

            self.client.force_authenticate(self.viewer)
            viewer = self.client.post(complete_url, valid_shape, format='json')
            self.assertEqual(viewer.status_code, 403, viewer.data)

            self.client.force_authenticate(self.other_editor)
            foreign = self.client.post(complete_url, valid_shape, format='json')
        self.assertIn(foreign.status_code, {403, 404})
        verify.assert_not_called()
        resource.assert_not_called()

        self.client.force_authenticate(self.editor)
        wrong_public_id = {**valid_shape, 'public_id': 'quality-import/assets/' + 'f' * 64}
        with (
            mock.patch(
                'quality.browser_direct_import.verify_direct_upload_response',
                return_value=True,
            ) as verify,
            mock.patch('quality.browser_direct_import.cloudinary.api.resource') as resource,
        ):
            wrong_target = self.client.post(complete_url, wrong_public_id, format='json')
        self.assertIn(wrong_target.status_code, {400, 409})
        verify.assert_not_called()
        resource.assert_not_called()

        with (
            mock.patch(
                'quality.browser_direct_import.verify_direct_upload_response',
                return_value=False,
            ) as verify,
            mock.patch('quality.browser_direct_import.cloudinary.api.resource') as resource,
        ):
            bad_signature = self.client.post(complete_url, valid_shape, format='json')
        self.assertIn(bad_signature.status_code, {400, 409})
        verify.assert_called_once()
        resource.assert_not_called()
        self.assertEqual(
            QualityImportAsset.objects.get().upload_state,
            QualityImportAsset.UploadState.STAGED,
        )
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_complete_accepts_verified_admin_metadata_and_marks_asset_ready(self):
        image = _png_bytes((40, 100, 180))
        prepared = self._prepare(
            _manifest([_media_item('m0', image, 0)], workbook_sha256='4' * 64)
        )
        self._assert_prepare_contract(prepared, intent_count=1)
        intent = prepared.data['upload_intents'][0]

        self._complete(
            batch_id=prepared.data['id'],
            intent=intent,
            content=image,
            version=17,
        )

        asset = QualityImportAsset.objects.get(sha256=intent['asset_sha256'])
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)
        self.assertIsNone(asset.staged_bytes)
        self.assertEqual(asset.file.name, intent['upload']['public_id'])
        self.assertIsNotNone(asset.remote_verified_at)
        self.assertEqual(QualityReport.objects.count(), 0)

    def test_direct_public_id_uses_storage_prefix_but_storage_key_does_not(self):
        image = _png_bytes((30, 150, 90))
        image_sha256 = hashlib.sha256(image).hexdigest()
        storage_key = f'quality-import/assets/{image_sha256}'

        with mock.patch.object(
            self.storage,
            '_prepend_prefix',
            side_effect=lambda name: f'media/{name}',
            create=True,
        ) as prepend_prefix:
            prepared = self._prepare(
                _manifest([_media_item('m0', image, 0)], workbook_sha256='b' * 64)
            )
            self._assert_prepare_contract(prepared, intent_count=1)
            intent = prepared.data['upload_intents'][0]
            prefixed_public_id = intent['upload']['public_id']
            self._assert_pending_public_id(
                prefixed_public_id,
                batch_id=prepared.data['id'],
                asset_sha256=image_sha256,
                storage_prefix='media/',
            )

            self._complete(
                batch_id=prepared.data['id'],
                intent=intent,
                content=image,
                version=41,
            )

        prepend_prefix.assert_any_call(
            f'quality-import/pending/{prepared.data["id"]}/'
        )
        asset = QualityImportAsset.objects.get(sha256=image_sha256)
        self.assertEqual(asset.storage_key, storage_key)
        self.assertEqual(asset.file.name, prefixed_public_id)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.READY)

    def test_detail_and_prepare_replay_return_only_missing_upload_intents(self):
        first_image = _png_bytes((40, 50, 160))
        second_image = _png_bytes((120, 70, 20))
        manifest = _manifest(
            [
                _media_item('m0', first_image, 0),
                _media_item('m1', second_image, 1),
            ],
            workbook_sha256='a' * 64,
        )
        prepared = self._prepare(manifest)
        self._assert_prepare_contract(prepared, intent_count=2)
        intents_by_key = {
            intent['media_keys'][0]: intent
            for intent in prepared.data['upload_intents']
        }

        self._complete(
            batch_id=prepared.data['id'],
            intent=intents_by_key['m0'],
            content=first_image,
            version=31,
        )

        detail = self.client.get(
            f'/api/quality/excel-import/direct/jobs/{prepared.data["id"]}/'
        )
        self.assertEqual(detail.status_code, 200, detail.data)
        self.assertEqual(detail.data['delivery_mode'], 'browser_direct')
        self.assertEqual(detail.data['phase'], 'awaiting_browser_upload')
        self.assertEqual(
            [intent['media_keys'] for intent in detail.data['upload_intents']],
            [['m1']],
        )

        replay = self._prepare(manifest)
        self._assert_prepare_contract(replay, intent_count=1)
        self.assertTrue(replay.data['idempotent_replay'])
        self.assertEqual(replay.data['id'], prepared.data['id'])
        self.assertEqual(replay.data['upload_intents'][0]['media_keys'], ['m1'])

    def test_complete_rejects_admin_metadata_that_does_not_match_manifest(self):
        image = _png_bytes((140, 30, 70))
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='5' * 64,
        )
        prepared = self._prepare(manifest)
        self._assert_prepare_contract(prepared, intent_count=1)
        intent = prepared.data['upload_intents'][0]
        upload = intent['upload']
        rejected_public_id = upload['public_id']
        metadata = self._admin_metadata(
            public_id=rejected_public_id,
            version=2,
            content=image,
        )
        metadata['bytes'] = len(image) + 1

        with (
            mock.patch(
                'quality.browser_direct_import.verify_direct_upload_response',
                return_value=True,
            ),
            mock.patch(
                'quality.browser_direct_import.cloudinary.api.resource',
                return_value=metadata,
            ),
            mock.patch(
                'quality.browser_direct_import.cloudinary.uploader.destroy',
                return_value={'result': 'ok'},
            ) as destroy,
        ):
            response = self.client.post(
                self._complete_url(prepared.data['id'], intent['asset_sha256']),
                {
                    'public_id': rejected_public_id,
                    'version': 2,
                    'signature': 'verified-response-signature',
                },
                format='json',
            )

        self.assertIn(response.status_code, {400, 409})
        destroy.assert_called_once_with(
            rejected_public_id,
            invalidate=True,
            resource_type='image',
            timeout=60,
        )
        asset = QualityImportAsset.objects.get(sha256=intent['asset_sha256'])
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertFalse(asset.file)
        self.assertEqual(QualityReport.objects.count(), 0)

        replay = self._prepare(manifest)
        self._assert_prepare_contract(replay, intent_count=1)
        self.assertTrue(replay.data['idempotent_replay'])
        self.assertEqual(replay.data['id'], prepared.data['id'])
        rotated_public_id = replay.data['upload_intents'][0]['upload']['public_id']
        self.assertNotEqual(rotated_public_id, rejected_public_id)
        self._assert_pending_public_id(
            rotated_public_id,
            batch_id=prepared.data['id'],
            asset_sha256=intent['asset_sha256'],
        )

    def test_finalize_rejects_job_with_missing_upload_receipt(self):
        image = _png_bytes((10, 90, 190))
        prepared = self._prepare(
            _manifest([_media_item('m0', image, 0)], workbook_sha256='6' * 64)
        )
        self._assert_prepare_contract(prepared, intent_count=1)

        with mock.patch('quality.browser_direct_import.cloudinary.api.resource') as resource:
            response = self.client.post(
                self._finalize_url(prepared.data['id']),
                {},
                format='json',
            )

        self.assertIn(response.status_code, {400, 409})
        resource.assert_not_called()
        self.assertEqual(QualityReport.objects.count(), 0)
        self.assertEqual(
            QualityImportAsset.objects.get().upload_state,
            QualityImportAsset.UploadState.STAGED,
        )

    def test_no_image_job_finalizes_without_upload_intents(self):
        prepared = self._prepare(_manifest(workbook_sha256='7' * 64))
        self._assert_prepare_contract(prepared, intent_count=0)

        finalized = self.client.post(
            self._finalize_url(prepared.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(finalized)
        batch = QualityImportBatch.objects.get(pk=prepared.data['id'])

        self.assertIn(batch.status, {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        })
        self.assertEqual(QualityReport.objects.count(), 1)
        report = QualityReport.objects.get()
        self.assertFalse(any((
            report.image1,
            report.image2,
            report.image3,
            report.image4,
            report.image5,
        )))

    def test_all_existing_workbook_accepts_empty_row_selection_and_finalizes(self):
        first_manifest = _manifest(workbook_sha256='c' * 64)
        first = self._prepare(first_manifest)
        self._assert_prepare_contract(first, intent_count=0)
        first_finalize = self.client.post(
            self._finalize_url(first.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(first_finalize)
        self.assertEqual(QualityReport.objects.count(), 1)

        existing_manifest = _manifest(workbook_sha256='d' * 64)
        preview = preview_quality_manifest(
            existing_manifest,
            uploaded_on=date(2026, 8, 19),
        )
        self.assertEqual(preview['new_count'], 0)
        self.assertEqual(preview['unchanged_count'], 1)

        prepared = self.client.post(
            self.jobs_url,
            {'manifest': existing_manifest, 'row_keys': []},
            format='json',
        )
        self._assert_prepare_contract(prepared, intent_count=0)
        self.assertEqual(prepared.data['total_rows'], 0)

        finalized = self.client.post(
            self._finalize_url(prepared.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(finalized)
        self.assertEqual(finalized.data['result']['total_rows'], 0)
        self.assertEqual(finalized.data['result']['created_count'], 0)
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_rollback_cancels_expired_staging_direct_job(self):
        prepared = self._prepare(_manifest(workbook_sha256='e' * 64))
        self._assert_prepare_contract(prepared, intent_count=0)
        fixed_now = datetime(2026, 8, 19, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai'))
        QualityImportBatch.objects.filter(pk=prepared.data['id']).update(
            lease_expires_at=fixed_now - timedelta(seconds=1),
        )
        staff = get_user_model().objects.create_user(
            username='browser-direct-rollback-expired',
            password='test-password',
            is_staff=True,
        )
        self.client.force_authenticate(staff)

        with mock.patch('quality.import_views.timezone.now', return_value=fixed_now):
            response = self.client.post(
                '/api/quality/excel-import/rollback-today/',
                {
                    'target_date': '2026-08-19',
                    'expected_count': 0,
                    'confirmation': 'DELETE:2026-08-19:0',
                },
                format='json',
            )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['cancelled_expired_jobs'], 1)
        self.assertFalse(
            QualityImportBatch.objects.filter(pk=prepared.data['id']).exists()
        )

    def test_rollback_keeps_unexpired_staging_direct_job_and_returns_conflict(self):
        prepared = self._prepare(_manifest(workbook_sha256='f' * 64))
        self._assert_prepare_contract(prepared, intent_count=0)
        fixed_now = datetime(2026, 8, 19, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai'))
        QualityImportBatch.objects.filter(pk=prepared.data['id']).update(
            lease_expires_at=fixed_now + timedelta(minutes=1),
        )
        staff = get_user_model().objects.create_user(
            username='browser-direct-rollback-active',
            password='test-password',
            is_staff=True,
        )
        self.client.force_authenticate(staff)

        with mock.patch('quality.import_views.timezone.now', return_value=fixed_now):
            response = self.client.post(
                '/api/quality/excel-import/rollback-today/',
                {
                    'target_date': '2026-08-19',
                    'expected_count': 0,
                    'confirmation': 'DELETE:2026-08-19:0',
                },
                format='json',
            )

        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data['code'], 'rollback_jobs_active')
        self.assertEqual(response.data['active_incremental_jobs'], 1)
        self.assertEqual(response.data['cancelled_expired_jobs'], 0)
        self.assertTrue(
            QualityImportBatch.objects.filter(pk=prepared.data['id']).exists()
        )

    def test_rollback_cleans_only_unresolved_pending_uploads_after_commit(self):
        ready_image = _png_bytes((35, 85, 135))
        pending_image = _png_bytes((145, 95, 45))
        manifest = _manifest(
            [
                _media_item('ready', ready_image, 0),
                _media_item('pending', pending_image, 1),
            ],
            workbook_sha256='1' * 64,
        )
        prepared = self._prepare(manifest)
        self._assert_prepare_contract(prepared, intent_count=2)
        intents_by_key = {
            intent['media_keys'][0]: intent
            for intent in prepared.data['upload_intents']
        }
        self._complete(
            batch_id=prepared.data['id'],
            intent=intents_by_key['ready'],
            content=ready_image,
            version=71,
        )
        ready_public_id = intents_by_key['ready']['upload']['public_id']
        pending_public_id = intents_by_key['pending']['upload']['public_id']

        fixed_now = datetime(2026, 8, 19, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai'))
        QualityImportBatch.objects.filter(pk=prepared.data['id']).update(
            lease_expires_at=fixed_now - timedelta(seconds=1),
        )
        staff = get_user_model().objects.create_user(
            username='browser-direct-rollback-cleanup',
            password='test-password',
            is_staff=True,
        )
        self.client.force_authenticate(staff)

        with mock.patch(
            'quality.browser_direct_import.cloudinary.api.delete_resources',
            return_value={'deleted': {pending_public_id: 'deleted'}},
        ) as delete_resources:
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                with mock.patch('quality.import_views.timezone.now', return_value=fixed_now):
                    response = self.client.post(
                        '/api/quality/excel-import/rollback-today/',
                        {
                            'target_date': '2026-08-19',
                            'expected_count': 0,
                            'confirmation': 'DELETE:2026-08-19:0',
                        },
                        format='json',
                    )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['cancelled_expired_jobs'], 1)
        self.assertEqual(len(callbacks), 1)
        delete_resources.assert_called_once_with(
            [pending_public_id],
            invalidate=True,
            resource_type='image',
            type='upload',
            timeout=10,
        )
        deleted_public_ids = delete_resources.call_args.args[0]
        self.assertNotIn(ready_public_id, deleted_public_ids)
        self.assertFalse(
            QualityImportBatch.objects.filter(pk=prepared.data['id']).exists()
        )

    def test_expired_rollback_preserves_public_id_used_by_older_report(self):
        image = _png_bytes((45, 95, 145))
        first_manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='b' * 64,
        )
        first = self._prepare(first_manifest)
        first_intent = first.data['upload_intents'][0]
        old_public_id = first_intent['upload']['public_id']
        self._complete(
            batch_id=first.data['id'],
            intent=first_intent,
            content=image,
            version=72,
        )
        self._assert_terminal_finalize(self.client.post(
            self._finalize_url(first.data['id']), {}, format='json'
        ))
        report = QualityReport.objects.get()
        old_url = report.image1
        QualityReport.objects.filter(pk=report.pk).update(
            created_at=datetime(2026, 8, 18, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai')),
        )

        asset = QualityImportAsset.objects.get()
        QualityImportAsset.objects.filter(pk=asset.pk).update(
            remote_verified_at=timezone.now() - timedelta(days=31),
        )
        second_manifest = _manifest(
            [_media_item('m1', image, 0, row=4)],
            workbook_sha256='c' * 64,
            rows=_issue_rows(sequence=2, row_number=4, phenomenon='侧面发白'),
        )
        second = self._prepare(second_manifest)
        self._complete(
            batch_id=second.data['id'],
            intent=second.data['upload_intents'][0],
            content=image,
            version=73,
        )

        fixed_now = datetime(2026, 8, 19, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai'))
        QualityImportBatch.objects.filter(pk=first.data['id']).update(
            status=QualityImportBatch.Status.STAGING,
            lease_expires_at=fixed_now - timedelta(seconds=1),
        )
        QualityImportBatch.objects.filter(pk=second.data['id']).update(
            status=QualityImportBatch.Status.READY,
            lease_expires_at=None,
        )
        staff = get_user_model().objects.create_user(
            username='browser-direct-rollback-historical',
            password='test-password',
            is_staff=True,
        )
        self.client.force_authenticate(staff)

        with mock.patch(
            'quality.browser_direct_import.cloudinary.api.delete_resources'
        ) as delete_resources:
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                with mock.patch('quality.import_views.timezone.now', return_value=fixed_now):
                    response = self.client.post(
                        '/api/quality/excel-import/rollback-today/',
                        {
                            'target_date': '2026-08-19',
                            'expected_count': 0,
                            'confirmation': 'DELETE:2026-08-19:0',
                        },
                        format='json',
                    )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['cancelled_expired_jobs'], 1)
        self.assertEqual(len(callbacks), 1)
        delete_resources.assert_not_called()
        self.assertFalse(QualityImportBatch.objects.filter(pk=first.data['id']).exists())
        report.refresh_from_db()
        self.assertEqual(report.image1, old_url)
        self.assertIn(old_public_id.rsplit('/', 1)[-1], report.image1)

    def test_expired_same_file_reclaim_rotates_target_and_cleans_old_pending_upload(self):
        image = _png_bytes((55, 105, 155))
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='2' * 64,
        )
        prepared = self._prepare(manifest)
        self._assert_prepare_contract(prepared, intent_count=1)
        old_public_id = prepared.data['upload_intents'][0]['upload']['public_id']
        QualityImportBatch.objects.filter(pk=prepared.data['id']).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1),
        )

        with mock.patch(
            'quality.browser_direct_import.cloudinary.api.delete_resources',
            return_value={'deleted': {old_public_id: 'deleted'}},
        ) as delete_resources:
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                replay = self._prepare(manifest)

        self._assert_prepare_contract(replay, intent_count=1)
        self.assertTrue(replay.data['idempotent_replay'])
        self.assertEqual(replay.data['id'], prepared.data['id'])
        new_intent = replay.data['upload_intents'][0]
        new_public_id = new_intent['upload']['public_id']
        self.assertNotEqual(new_public_id, old_public_id)
        self._assert_pending_public_id(
            new_public_id,
            batch_id=prepared.data['id'],
            asset_sha256=new_intent['asset_sha256'],
        )
        self.assertEqual(len(callbacks), 1)
        delete_resources.assert_called_once_with(
            [old_public_id],
            invalidate=True,
            resource_type='image',
            type='upload',
            timeout=10,
        )

    def test_six_images_issue_only_five_intents_and_save_at_most_five(self):
        images = {
            f'm{index}': _png_bytes((20 + index * 20, 80 + index * 10, 180 - index * 10))
            for index in range(6)
        }
        manifest = _manifest(
            [
                _media_item(key, content, index)
                for index, (key, content) in enumerate(images.items())
            ],
            workbook_sha256='8' * 64,
        )
        prepared = self._prepare(manifest)
        self._assert_prepare_contract(prepared, intent_count=5)
        self.assertEqual(
            {key for intent in prepared.data['upload_intents'] for key in intent['media_keys']},
            {'m0', 'm1', 'm2', 'm3', 'm4'},
        )

        for version, intent in enumerate(prepared.data['upload_intents'], start=1):
            media_key = intent['media_keys'][0]
            self._complete(
                batch_id=prepared.data['id'],
                intent=intent,
                content=images[media_key],
                version=version,
            )

        finalized = self.client.post(
            self._finalize_url(prepared.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(finalized)
        batch = QualityImportBatch.objects.get(pk=prepared.data['id'])
        result = batch.delta_summary['incremental_result']

        self.assertEqual(result['images_found'], 6)
        self.assertEqual(result['images_saved'], 5)
        self.assertEqual(result['images_ignored'], 1)
        self.assertEqual(QualityImportAsset.objects.count(), 5)
        report = QualityReport.objects.get()
        self.assertEqual(
            [bool(report.image1), bool(report.image2), bool(report.image3), bool(report.image4), bool(report.image5)],
            [True, True, True, True, True],
        )

    def test_prepare_and_finalize_replay_create_one_report(self):
        manifest = _manifest(workbook_sha256='9' * 64)

        first = self._prepare(manifest)
        second = self._prepare(manifest)
        self._assert_prepare_contract(first, intent_count=0)
        self._assert_prepare_contract(second, intent_count=0)
        self.assertFalse(first.data['idempotent_replay'])
        self.assertTrue(second.data['idempotent_replay'])
        self.assertEqual(second.data['id'], first.data['id'])

        first_finalize = self.client.post(
            self._finalize_url(first.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(first_finalize)

        second_finalize = self.client.post(
            self._finalize_url(first.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(second_finalize)

        self.assertEqual(QualityImportBatch.objects.count(), 1)
        self.assertEqual(QualityReport.objects.count(), 1)
        self.assertEqual(second_finalize.data['id'], first.data['id'])

    def test_existing_direct_replay_restores_missing_media_fingerprint_baseline(self):
        image = _png_bytes((75, 125, 175))
        image_sha256 = hashlib.sha256(image).hexdigest()
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='3' * 64,
        )
        prepared = self._prepare(manifest)
        self._assert_prepare_contract(prepared, intent_count=1)
        self._complete(
            batch_id=prepared.data['id'],
            intent=prepared.data['upload_intents'][0],
            content=image,
            version=81,
        )
        finalized = self.client.post(
            self._finalize_url(prepared.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(finalized)

        report = QualityReport.objects.get()
        source = dict(report.excel_source)
        self.assertEqual(source['media_source_sha256s'], [image_sha256])
        self.assertIn('media_source_fingerprints', source)
        source.pop('media_source_fingerprints')
        report.excel_source = source
        report.save(update_fields=['excel_source'])

        replay = self._prepare(manifest)

        self._assert_prepare_contract(replay, intent_count=0)
        self.assertTrue(replay.data['idempotent_replay'])
        self.assertEqual(replay.data['id'], prepared.data['id'])
        report.refresh_from_db()
        self.assertEqual(
            report.excel_source['media_source_fingerprints'],
            [f'0:10:{image_sha256}'],
        )
        self.assertEqual(report.excel_source['media_source_sha256s'], [image_sha256])

    def test_stale_ready_asset_gets_new_intent_and_cannot_finalize_before_completion(self):
        image = _png_bytes((95, 145, 195))
        first_manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='4' * 64,
        )
        first = self._prepare(first_manifest)
        self._assert_prepare_contract(first, intent_count=1)
        self._complete(
            batch_id=first.data['id'],
            intent=first.data['upload_intents'][0],
            content=image,
            version=91,
        )
        first_finalize = self.client.post(
            self._finalize_url(first.data['id']),
            {},
            format='json',
        )
        self._assert_terminal_finalize(first_finalize)
        self.assertEqual(QualityReport.objects.count(), 1)

        asset = QualityImportAsset.objects.get()
        previous_public_id = asset.file.name
        QualityImportAsset.objects.filter(pk=asset.pk).update(
            remote_verified_at=timezone.now() - timedelta(days=31),
        )
        second_manifest = _manifest(
            [_media_item('m1', image, 0, row=4)],
            workbook_sha256='5' * 64,
            rows=_issue_rows(
                sequence=2,
                row_number=4,
                phenomenon='侧面发白',
            ),
        )

        second = self._prepare(second_manifest)

        self._assert_prepare_contract(second, intent_count=1)
        intent = second.data['upload_intents'][0]
        self.assertNotEqual(intent['upload']['public_id'], previous_public_id)
        self._assert_pending_public_id(
            intent['upload']['public_id'],
            batch_id=second.data['id'],
            asset_sha256=intent['asset_sha256'],
        )
        asset.refresh_from_db()
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)

        rejected = self.client.post(
            self._finalize_url(second.data['id']),
            {},
            format='json',
        )

        self.assertEqual(rejected.status_code, 409, rejected.data)
        self.assertEqual(rejected.data['code'], 'missing_media')
        self.assertEqual(QualityReport.objects.count(), 1)

    def test_terminal_old_receipt_is_noop_after_shared_asset_refresh(self):
        image = _png_bytes((105, 155, 205))
        first_manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='6' * 64,
        )
        first = self._prepare(first_manifest)
        first_intent = first.data['upload_intents'][0]
        self._complete(
            batch_id=first.data['id'],
            intent=first_intent,
            content=image,
            version=101,
        )
        self._assert_terminal_finalize(self.client.post(
            self._finalize_url(first.data['id']), {}, format='json'
        ))
        first_report = QualityReport.objects.get()
        first_url = first_report.image1

        asset = QualityImportAsset.objects.get()
        QualityImportAsset.objects.filter(pk=asset.pk).update(
            remote_verified_at=timezone.now() - timedelta(days=31),
        )
        second_manifest = _manifest(
            [_media_item('m1', image, 0, row=4)],
            workbook_sha256='7' * 64,
            rows=_issue_rows(sequence=2, row_number=4, phenomenon='侧面发白'),
        )
        second = self._prepare(second_manifest)
        second_intent = second.data['upload_intents'][0]
        self._complete(
            batch_id=second.data['id'],
            intent=second_intent,
            content=image,
            version=102,
        )
        self._assert_terminal_finalize(self.client.post(
            self._finalize_url(second.data['id']), {}, format='json'
        ))

        old_receipt = {
            'public_id': first_intent['upload']['public_id'],
            'version': 101,
            'signature': 'verified-response-signature',
        }
        with (
            mock.patch(
                'quality.browser_direct_import.verify_direct_upload_response'
            ) as verify,
            mock.patch('quality.browser_direct_import.cloudinary.api.resource') as resource,
            mock.patch('quality.browser_direct_import.cloudinary.uploader.destroy') as destroy,
        ):
            replay = self.client.post(
                self._complete_url(first.data['id'], first_intent['asset_sha256']),
                old_receipt,
                format='json',
            )

        self.assertEqual(replay.status_code, 200, replay.data)
        verify.assert_not_called()
        resource.assert_not_called()
        destroy.assert_not_called()
        first_report.refresh_from_db()
        self.assertEqual(first_report.image1, first_url)

    def test_expired_replay_does_not_delete_public_id_used_by_historical_report(self):
        image = _png_bytes((115, 165, 215))
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='8' * 64,
        )
        prepared = self._prepare(manifest)
        intent = prepared.data['upload_intents'][0]
        old_public_id = intent['upload']['public_id']
        self._complete(
            batch_id=prepared.data['id'],
            intent=intent,
            content=image,
            version=103,
        )
        self._assert_terminal_finalize(self.client.post(
            self._finalize_url(prepared.data['id']), {}, format='json'
        ))
        report = QualityReport.objects.get()
        old_url = report.image1
        asset = QualityImportAsset.objects.get()
        QualityImportAsset.objects.filter(pk=asset.pk).update(
            file='quality-import/pending/other/current-object',
            remote_verified_at=timezone.now() - timedelta(days=31),
        )
        QualityImportBatch.objects.filter(pk=prepared.data['id']).update(
            status=QualityImportBatch.Status.STAGING,
            lease_expires_at=timezone.now() - timedelta(seconds=1),
        )

        with mock.patch(
            'quality.browser_direct_import.cloudinary.api.delete_resources'
        ) as delete_resources:
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                replay = self._prepare(manifest)

        self._assert_prepare_contract(replay, intent_count=1)
        self.assertEqual(len(callbacks), 1)
        self.assertNotEqual(
            replay.data['upload_intents'][0]['upload']['public_id'],
            old_public_id,
        )
        delete_resources.assert_not_called()
        report.refresh_from_db()
        self.assertEqual(report.image1, old_url)

    def test_remote_verification_does_not_adopt_a_rotated_target(self):
        image = _png_bytes((125, 175, 225))
        manifest = _manifest(
            [_media_item('m0', image, 0)],
            workbook_sha256='a' * 64,
        )
        prepared = self._prepare(manifest)
        intent = prepared.data['upload_intents'][0]
        old_public_id = intent['upload']['public_id']
        metadata = self._admin_metadata(
            public_id=old_public_id,
            version=104,
            content=image,
        )

        def rotate_during_verification(*args, **kwargs):
            QualityImportBatch.objects.filter(pk=prepared.data['id']).update(
                lease_expires_at=timezone.now() - timedelta(seconds=1),
            )
            _resume_existing_direct_batch(
                prepared.data['id'],
                uploaded_by=self.editor,
            )
            return metadata

        receipt = {
            'public_id': old_public_id,
            'version': 104,
            'signature': 'verified-response-signature',
        }
        with (
            mock.patch(
                'quality.browser_direct_import.verify_direct_upload_response',
                return_value=True,
            ),
            mock.patch(
                'quality.browser_direct_import.cloudinary.api.resource',
                side_effect=rotate_during_verification,
            ),
        ):
            response = self.client.post(
                self._complete_url(prepared.data['id'], intent['asset_sha256']),
                receipt,
                format='json',
            )

        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(response.data['code'], 'invalid_upload_receipt')
        asset = QualityImportAsset.objects.get()
        self.assertFalse(asset.file)
        self.assertEqual(asset.upload_state, QualityImportAsset.UploadState.STAGED)
        self.assertEqual(asset.processing_owner, '')
        batch = QualityImportBatch.objects.get(pk=prepared.data['id'])
        rotated_public_id = batch.delta_summary['direct_upload']['assets'][
            intent['asset_sha256']
        ]['public_id']
        self.assertNotEqual(rotated_public_id, old_public_id)

    def test_terminal_legacy_async_checkpoint_does_not_conflict_with_direct_prepare(self):
        manifest = _manifest(workbook_sha256='0' * 64)
        payload = self._prepare_payload(manifest)
        legacy_scope = _incremental_job_scope_key(set(payload['row_keys']))
        legacy = QualityImportBatch.objects.create(
            uploaded_by=self.editor,
            original_filename=manifest['filename'],
            sha256=manifest['workbook_sha256'],
            import_scope_key=legacy_scope,
            file_size=manifest['file_size'],
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
            status=QualityImportBatch.Status.READY,
            phase='ready',
            total_rows=1,
            delta_summary={
                'incremental_result': {
                    'total_rows': 1,
                    'created_count': 0,
                    'skipped_count': 1,
                    'changed_count': 0,
                    'failed_count': 0,
                    'created_report_ids': [],
                    'skipped_report_ids': [],
                    'changed_report_ids': [],
                    'rows': [],
                    'warnings': [],
                },
            },
        )

        prepared = self.client.post(self.jobs_url, payload, format='json')

        self._assert_prepare_contract(prepared, intent_count=0)
        self.assertFalse(prepared.data['idempotent_replay'])
        self.assertNotEqual(prepared.data['id'], legacy.pk)
        direct = QualityImportBatch.objects.get(pk=prepared.data['id'])
        self.assertTrue(legacy.import_scope_key.startswith('inc:'))
        self.assertTrue(direct.import_scope_key.startswith('bdi:'))
        self.assertNotEqual(direct.import_scope_key, legacy.import_scope_key)

        finalized = self.client.post(
            self._finalize_url(direct.pk),
            {},
            format='json',
        )
        self._assert_terminal_finalize(finalized)
        self.assertEqual(QualityReport.objects.count(), 1)
        legacy.refresh_from_db()
        self.assertEqual(legacy.status, QualityImportBatch.Status.READY)
        self.assertIsInstance(legacy.delta_summary['incremental_result'], dict)
