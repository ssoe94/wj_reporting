"""Narrow API surface and provisioning for the local quality-media archive."""

from __future__ import annotations

import logging

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.db import transaction
from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from injection.models import UserProfile
from injection.permissions import AdminOnlyPermission

from .archive_access import (
    ARCHIVE_SCOPE_CLAIM,
    ARCHIVE_SERVICE_GROUP,
    ARCHIVE_SERVICE_USERNAME,
    ARCHIVE_TOKEN_SCOPE,
    is_valid_archive_service,
)
from .models import QualityImportAsset, QualityImportBatch, QualityReport


logger = logging.getLogger(__name__)
User = get_user_model()


def _content_archive_path(sha256: str) -> str:
    return f'objects/sha256/{sha256[:2]}/{sha256[2:4]}/{sha256}'


def _validate_archive_query(request, *, asset_list: bool = False) -> None:
    allowed = {'page', 'page_size'} | ({'mirror_state'} if asset_list else set())
    if set(request.query_params) - allowed:
        raise ValidationError({'query': 'Unexpected archive query parameter.'})
    if request.query_params.get('page_size') != '200':
        raise ValidationError({'page_size': 'The archive page size must be 200.'})
    raw_page = request.query_params.get('page')
    if raw_page is not None and (not raw_page.isdigit() or int(raw_page) < 1):
        raise ValidationError({'page': 'The archive page must be a positive integer.'})
    if asset_list and request.query_params.get('mirror_state') != 'pending':
        raise ValidationError({'mirror_state': 'The archive only reads pending assets.'})


class ArchiveServicePermission(BasePermission):
    def has_permission(self, request, view):
        return is_valid_archive_service(request.user, request.auth)


class ArchivePagination(PageNumberPagination):
    page_size = 200
    page_size_query_param = 'page_size'
    max_page_size = 200


class ArchiveQualityReportSerializer(serializers.ModelSerializer):
    class Meta:
        model = QualityReport
        fields = ['id', 'updated_at', 'image1', 'image2', 'image3']


class ArchiveQualityAssetSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = QualityImportAsset
        fields = [
            'id', 'sha256', 'byte_size', 'content_type', 'width', 'height',
            'extension', 'mirror_state', 'url', 'created_at',
        ]

    def get_url(self, obj):
        request = self.context.get('request')
        path = reverse('quality-archive-asset-content', kwargs={'pk': obj.pk})
        return request.build_absolute_uri(path) if request else path


class ArchiveReportListView(APIView):
    permission_classes = [IsAuthenticated, ArchiveServicePermission]

    def get(self, request):
        _validate_archive_query(request)
        queryset = QualityReport.objects.only(
            'id', 'updated_at', 'image1', 'image2', 'image3',
        ).order_by('id')
        paginator = ArchivePagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = ArchiveQualityReportSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)


def _archive_asset_queryset():
    return QualityImportAsset.objects.filter(
        attachments__batch__status__in=[
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        ]
    ).distinct().order_by('id')


class ArchiveAssetListView(APIView):
    permission_classes = [IsAuthenticated, ArchiveServicePermission]

    def get(self, request):
        _validate_archive_query(request, asset_list=True)
        queryset = _archive_asset_queryset().filter(
            mirror_state=QualityImportAsset.MirrorState.PENDING,
        )
        paginator = ArchivePagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = ArchiveQualityAssetSerializer(
            page,
            many=True,
            context={'request': request},
        )
        return paginator.get_paginated_response(serializer.data)


class ArchiveAssetContentView(APIView):
    permission_classes = [IsAuthenticated, ArchiveServicePermission]

    def get(self, request, pk: int):
        asset = get_object_or_404(_archive_asset_queryset(), pk=pk)
        try:
            file_handle = asset.file.open('rb')
        except Exception:
            logger.exception('Quality archive asset could not be opened: %s', asset.pk)
            return Response(
                {'code': 'media_unavailable', 'error': 'Media is temporarily unavailable.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        response = FileResponse(
            file_handle,
            as_attachment=False,
            filename=f'{asset.sha256}.{asset.extension or "bin"}',
            content_type=asset.content_type,
        )
        response['Cache-Control'] = 'private, max-age=3600'
        response['X-Content-Type-Options'] = 'nosniff'
        return response


class ArchiveAssetMarkMirroredView(APIView):
    permission_classes = [IsAuthenticated, ArchiveServicePermission]

    @transaction.atomic
    def post(self, request, pk: int):
        asset = get_object_or_404(
            QualityImportAsset.objects.select_for_update(),
            pk=pk,
        )
        if not asset.attachments.filter(
            batch__status__in=[
                QualityImportBatch.Status.READY,
                QualityImportBatch.Status.READY_WITH_WARNINGS,
            ]
        ).exists():
            raise Http404('Archive asset not found.')
        supplied_sha = str(request.data.get('sha256', '')).strip().lower()
        relative_path = str(request.data.get('archive_relative_path', '')).strip().replace('\\', '/')
        expected_path = _content_archive_path(asset.sha256)
        if supplied_sha != asset.sha256:
            return Response(
                {'code': 'checksum_mismatch', 'error': 'Archived media checksum does not match.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if relative_path != expected_path:
            return Response(
                {'code': 'invalid_archive_path', 'error': 'A safe relative path is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if asset.mirror_state == QualityImportAsset.MirrorState.MIRRORED:
            if asset.archive_relative_path != expected_path:
                return Response(
                    {'code': 'mirror_state_conflict', 'error': 'The asset has conflicting mirror metadata.'},
                    status=status.HTTP_409_CONFLICT,
                )
        elif asset.mirror_state != QualityImportAsset.MirrorState.PENDING:
            return Response(
                {'code': 'mirror_state_conflict', 'error': 'Only pending assets can be acknowledged.'},
                status=status.HTTP_409_CONFLICT,
            )
        else:
            asset.archive_relative_path = expected_path
            asset.mirror_state = QualityImportAsset.MirrorState.MIRRORED
            asset.mirrored_at = timezone.now()
            asset.save(update_fields=['archive_relative_path', 'mirror_state', 'mirrored_at'])
        return Response({
            'id': asset.pk,
            'sha256': asset.sha256,
            'mirror_state': asset.mirror_state,
            'archive_relative_path': asset.archive_relative_path,
            'mirrored_at': asset.mirrored_at,
        })


class ArchiveServiceProvisionView(APIView):
    """Create/repair the passwordless service identity and rotate its refresh token."""

    permission_classes = [IsAuthenticated, AdminOnlyPermission]

    @transaction.atomic
    def post(self, request):
        group, _created = Group.objects.get_or_create(name=ARCHIVE_SERVICE_GROUP)
        user = User.objects.select_for_update().filter(
            username=ARCHIVE_SERVICE_USERNAME,
        ).first()
        if user is None:
            user = User(username=ARCHIVE_SERVICE_USERNAME)
            user.set_unusable_password()
            user.is_active = True
            user.is_staff = False
            user.is_superuser = False
            user.first_name = 'Quality Archive Service'
            user.save()
        elif not user.groups.filter(name=ARCHIVE_SERVICE_GROUP).exists():
            raise PermissionDenied('The reserved archive username is already in use.')

        changed_fields = []
        for field_name, expected in (
            ('is_active', True),
            ('is_staff', False),
            ('is_superuser', False),
        ):
            if getattr(user, field_name) != expected:
                setattr(user, field_name, expected)
                changed_fields.append(field_name)
        if user.has_usable_password():
            user.set_unusable_password()
            changed_fields.append('password')
        if changed_fields:
            user.save(update_fields=changed_fields)

        user.groups.clear()
        user.groups.add(group)
        user.user_permissions.clear()

        profile = UserProfile.get_user_permissions(user)
        profile.department = 'Quality Archive Service'
        for field_name in (
            'can_view_injection', 'can_view_assembly', 'can_view_quality',
            'can_view_sales', 'can_view_development', 'can_edit_injection',
            'can_edit_assembly', 'can_edit_quality', 'can_edit_sales',
            'can_edit_development', 'can_confirm_moulds', 'is_admin',
            'is_using_temp_password', 'password_reset_required',
        ):
            setattr(profile, field_name, False)
        profile.save()

        for outstanding in OutstandingToken.objects.filter(user=user):
            BlacklistedToken.objects.get_or_create(token=outstanding)

        refresh = RefreshToken.for_user(user)
        refresh[ARCHIVE_SCOPE_CLAIM] = ARCHIVE_TOKEN_SCOPE
        logger.info(
            'Quality archive service credential provisioned by admin user_id=%s',
            request.user.pk,
        )
        response = Response({
            'service_username': ARCHIVE_SERVICE_USERNAME,
            'scope': ARCHIVE_TOKEN_SCOPE,
            'refresh': str(refresh),
        })
        response['Cache-Control'] = 'no-store'
        response['Pragma'] = 'no-cache'
        return response
