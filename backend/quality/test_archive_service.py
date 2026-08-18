from __future__ import annotations

from datetime import date
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from .archive_access import (
    ARCHIVE_SERVICE_GROUP,
    ARCHIVE_SERVICE_USERNAME,
    ARCHIVE_TOKEN_SCOPE,
)
from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportMedia,
    QualityImportRow,
    QualityReport,
)


class QualityArchiveServiceTests(APITestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user(
            username='archive-provision-admin',
            password='test-password',
            is_staff=True,
        )
        admin_access = str(RefreshToken.for_user(self.admin).access_token)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {admin_access}')
        provision = self.client.post(
            reverse('quality-archive-service-provision'),
            {},
            format='json',
        )
        self.assertEqual(provision.status_code, 200, provision.data)
        self.assertIn('no-store', provision['Cache-Control'])
        self.assertEqual(provision['Pragma'], 'no-cache')
        self.service_refresh = provision.data['refresh']
        service_access = str(RefreshToken(self.service_refresh).access_token)
        self.service_client = APIClient()
        self.service_client.credentials(HTTP_AUTHORIZATION=f'Bearer {service_access}')

        self.report = QualityReport.objects.create(
            report_dt=timezone.now(),
            section='LQC_INJ',
            model='secret-model-not-in-archive-feed',
            part_no='ACQ12345601',
            judgement='NG',
            phenomenon='secret-phenomenon-not-in-archive-feed',
            image1='https://res.cloudinary.com/demo/image/upload/quality/example.jpg',
        )
        self.batch = QualityImportBatch.objects.create(
            uploaded_by=self.admin,
            original_filename='quality.xlsx',
            sha256='1' * 64,
            file_size=1024,
            status=QualityImportBatch.Status.READY,
            phase='ready',
        )
        self.row = QualityImportRow.objects.create(
            batch=self.batch,
            sheet_name='8月',
            source_row_number=3,
            source_key='2' * 64,
            business_key='3' * 64,
            content_sha256='4' * 64,
            report_date=date(2026, 8, 18),
            section='LQC_INJ',
        )
        self.asset = QualityImportAsset.objects.create(
            sha256='5' * 64,
            byte_size=8,
            content_type='image/png',
            width=1,
            height=1,
            extension='png',
            storage_key='quality-import/assets/' + ('5' * 64),
            file='quality-import/assets/' + ('5' * 64),
            upload_state=QualityImportAsset.UploadState.READY,
            created_by_batch=self.batch,
        )
        QualityImportMedia.objects.create(
            batch=self.batch,
            row=self.row,
            asset=self.asset,
            source_sheet_name='8月',
            source_anchor_row=3,
            source_anchor_col=10,
            original_filename='issue.png',
        )

    def test_provisioned_identity_has_no_general_application_permissions(self):
        service = get_user_model().objects.get(username=ARCHIVE_SERVICE_USERNAME)
        self.assertTrue(service.is_active)
        self.assertFalse(service.is_staff)
        self.assertFalse(service.is_superuser)
        self.assertFalse(service.has_usable_password())
        self.assertEqual(list(service.groups.values_list('name', flat=True)), [ARCHIVE_SERVICE_GROUP])
        self.assertFalse(service.user_permissions.exists())

        profile = service.profile
        for field_name in (
            'can_view_injection', 'can_view_assembly', 'can_view_quality',
            'can_view_sales', 'can_view_development', 'can_edit_injection',
            'can_edit_assembly', 'can_edit_quality', 'can_edit_sales',
            'can_edit_development', 'can_confirm_moulds', 'is_admin',
        ):
            self.assertFalse(getattr(profile, field_name), field_name)

    def test_archive_feed_is_minimal_and_allows_only_required_operations(self):
        reports = self.service_client.get(
            reverse('quality-archive-report-list'),
            {'page_size': 200},
        )
        self.assertEqual(reports.status_code, 200, reports.data)
        self.assertEqual(reports.data['count'], 1)
        self.assertEqual(
            set(reports.data['results'][0]),
            {'id', 'updated_at', 'image1', 'image2', 'image3'},
        )

        assets = self.service_client.get(
            reverse('quality-archive-asset-list'),
            {'page_size': 200, 'mirror_state': 'pending'},
        )
        self.assertEqual(assets.status_code, 200, assets.data)
        self.assertEqual(assets.data['count'], 1)
        content_url = reverse('quality-archive-asset-content', args=[self.asset.pk])
        self.assertTrue(assets.data['results'][0]['url'].endswith(content_url))

        storage = QualityImportAsset._meta.get_field('file').storage
        with mock.patch.object(storage, 'open', return_value=ContentFile(b'png-data')):
            content = self.service_client.get(content_url)
        self.assertEqual(content.status_code, 200)

        mark_url = reverse('quality-archive-asset-mark-mirrored', args=[self.asset.pk])
        archive_path = 'objects/sha256/55/55/' + ('5' * 64)
        marked = self.service_client.post(
            mark_url,
            {'sha256': self.asset.sha256, 'archive_relative_path': archive_path},
            format='json',
        )
        self.assertEqual(marked.status_code, 200, marked.data)
        self.asset.refresh_from_db()
        first_mirrored_at = self.asset.mirrored_at
        replay = self.service_client.post(
            mark_url,
            {'sha256': self.asset.sha256, 'archive_relative_path': archive_path},
            format='json',
        )
        self.assertEqual(replay.status_code, 200, replay.data)
        self.asset.refresh_from_db()
        self.assertEqual(self.asset.mirrored_at, first_mirrored_at)

    def test_archive_token_is_rejected_by_every_representative_general_route(self):
        blocked = [
            ('get', reverse('quality-report-list'), None),
            ('get', reverse('quality-report-detail', args=[self.report.pk]), None),
            ('patch', reverse('quality-report-detail', args=[self.report.pk]), {'action_result': 'bad'}),
            ('get', reverse('quality-import-asset-list'), None),
            ('get', reverse('daily-quality-attention'), None),
            ('post', reverse('cloudinary-signature'), {'folder': 'quality'}),
            ('get', reverse('analytics-production-progress') + '?date=2026-08-18', None),
            ('get', reverse('user-me'), None),
        ]
        for method_name, url, payload in blocked:
            with self.subTest(method=method_name, url=url):
                method = getattr(self.service_client, method_name)
                response = method(url, payload, format='json') if payload is not None else method(url)
                self.assertEqual(response.status_code, 403, getattr(response, 'data', None))
        self.report.refresh_from_db()
        self.assertEqual(self.report.action_result, '')

    def test_archive_query_contract_is_fail_closed(self):
        response = self.service_client.get(
            reverse('quality-archive-report-list'),
            {'page_size': 100},
        )
        self.assertEqual(response.status_code, 400)
        response = self.service_client.get(
            reverse('quality-archive-asset-list'),
            {'page_size': 200, 'mirror_state': 'mirrored'},
        )
        self.assertEqual(response.status_code, 400)
        response = self.service_client.get(
            reverse('quality-archive-report-list'),
            {'page_size': 200, 'unexpected': '1'},
        )
        self.assertEqual(response.status_code, 400)

    def test_provision_rotation_blacklists_the_previous_service_refresh(self):
        second = self.client.post(
            reverse('quality-archive-service-provision'),
            {},
            format='json',
        )
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(second.data['scope'], ARCHIVE_TOKEN_SCOPE)
        rejected = APIClient().post(
            reverse('token_refresh'),
            {'refresh': self.service_refresh},
            format='json',
        )
        self.assertEqual(rejected.status_code, 401)
        accepted = APIClient().post(
            reverse('token_refresh'),
            {'refresh': second.data['refresh']},
            format='json',
        )
        self.assertEqual(accepted.status_code, 200, accepted.data)
        access = RefreshToken(accepted.data['refresh']).access_token
        self.assertEqual(access['scope'], ARCHIVE_TOKEN_SCOPE)

    def test_refresh_rechecks_live_archive_group_and_active_state(self):
        service = get_user_model().objects.get(username=ARCHIVE_SERVICE_USERNAME)
        group = service.groups.get(name=ARCHIVE_SERVICE_GROUP)
        service.groups.remove(group)
        rejected_group = APIClient().post(
            reverse('token_refresh'),
            {'refresh': self.service_refresh},
            format='json',
        )
        self.assertEqual(rejected_group.status_code, 401)

        service.groups.add(group)
        service.is_active = False
        service.save(update_fields=['is_active'])
        rejected_inactive = APIClient().post(
            reverse('token_refresh'),
            {'refresh': self.service_refresh},
            format='json',
        )
        self.assertEqual(rejected_inactive.status_code, 401)

    def test_non_service_users_cannot_use_archive_feed_or_provision(self):
        viewer = get_user_model().objects.create_user(
            username='ordinary-quality-viewer',
            password='test-password',
        )
        viewer.profile.can_view_quality = True
        viewer.profile.save(update_fields=['can_view_quality'])
        access = str(RefreshToken.for_user(viewer).access_token)
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {access}')
        self.assertEqual(
            client.get(reverse('quality-archive-report-list'), {'page_size': 200}).status_code,
            403,
        )
        self.assertEqual(
            client.post(reverse('quality-archive-service-provision'), {}, format='json').status_code,
            403,
        )

    def test_reserved_username_collision_is_not_converted_into_a_service_account(self):
        get_user_model().objects.filter(username=ARCHIVE_SERVICE_USERNAME).delete()
        collision = get_user_model().objects.create_user(
            username=ARCHIVE_SERVICE_USERNAME,
            password='ordinary-password',
        )
        response = self.client.post(
            reverse('quality-archive-service-provision'),
            {},
            format='json',
        )
        self.assertEqual(response.status_code, 403)
        collision.refresh_from_db()
        self.assertTrue(collision.has_usable_password())
        self.assertFalse(collision.groups.filter(name=ARCHIVE_SERVICE_GROUP).exists())
