"""Private HR endpoints. GET is read-only; every mutation is authenticated and audited."""
import json

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .hr_contract import ImportSerializer, SaveImportSerializer, LayoutSerializer, preview_payload, validate_month
from .hr_permissions import IsHrAuthorized, IsHrSuperuser
from .hr_access_service import set_hr_access
from .hr_service import save_import, save_layout, workspace_payload
from .models import HrAccessGrant, HrMonthWorkspace
from .hr_workbook_contract import SaveReferenceSerializer, WorkbookBatchSerializer, WorkbookCommitSerializer
from .hr_workbook_service import build_preview, save_batch
from .hr_reference_service import reference_payload, save_reference


def validated_input(request, serializer_type):
    if len(json.dumps(request.data, ensure_ascii=False).encode('utf-8')) > 6_000_000:
        raise serializers.ValidationError({'detail': '입력 크기는 6MB 이하여야 합니다.'})
    serializer = serializer_type(data=request.data)
    serializer.is_valid(raise_exception=True)
    return dict(serializer.validated_data)


class HrBaseView(APIView):
    permission_classes = [IsHrAuthorized]
    parser_classes = [JSONParser]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        response['Pragma'] = 'no-cache'
        response['Vary'] = 'Authorization, Cookie'
        return response


class HrMonthListView(HrBaseView):
    def get(self, request):
        return Response({'months': list(HrMonthWorkspace.objects.values('month', 'currency', 'version'))})


class HrWorkspaceView(HrBaseView):
    def get(self, request, month):
        validate_month(month)
        return Response(workspace_payload(HrMonthWorkspace.objects.filter(month=month).first(), month))

    def patch(self, request, month):
        validate_month(month)
        workspace = save_layout(month, validated_input(request, LayoutSerializer), request.user)
        return Response(workspace_payload(workspace))


class HrImportPreviewView(HrBaseView):
    def post(self, request):
        return Response(preview_payload(validated_input(request, ImportSerializer)))


class HrImportView(HrBaseView):
    def post(self, request, month):
        validate_month(month)
        workspace = save_import(month, validated_input(request, SaveImportSerializer), request.user)
        return Response(workspace_payload(workspace))


class HrClassificationReferenceView(HrBaseView):
    def get(self, request):
        return Response(reference_payload())

    def put(self, request):
        return Response(save_reference(validated_input(request, SaveReferenceSerializer), request.user))


class HrWorkbookPreviewView(HrBaseView):
    def post(self, request):
        return Response(build_preview(validated_input(request, WorkbookBatchSerializer)))


class HrWorkbookImportView(HrBaseView):
    def post(self, request):
        workspaces = save_batch(validated_input(request, WorkbookCommitSerializer), request.user)
        return Response({'workspaces': [workspace_payload(workspace) for workspace in workspaces]})


def access_payload():
    enabled_ids = set(HrAccessGrant.objects.filter(enabled=True).values_list('user_id', flat=True))
    return {'users': [{
        'id': user.pk, 'username': user.username, 'name': user.get_full_name() or user.username,
        'granted': user.pk in enabled_ids, 'is_superuser': user.is_superuser, 'is_active': user.is_active,
    } for user in get_user_model().objects.all().order_by('username')[:2000]]}


class HrAccessView(HrBaseView):
    permission_classes = [IsHrSuperuser]

    def get(self, request):
        return Response(access_payload())


class HrAccessDetailView(HrBaseView):
    permission_classes = [IsHrSuperuser]

    @transaction.atomic
    def patch(self, request, user_id):
        if not isinstance(request.data, dict) or set(request.data) != {'granted'} or type(request.data['granted']) is not bool:
            raise serializers.ValidationError({'granted': 'granted 참/거짓만 입력해 주세요.'})
        target = get_object_or_404(get_user_model().objects.select_for_update(), pk=user_id)
        try:
            set_hr_access(target, request.data['granted'], request.user)
        except serializers.ValidationError as error:
            raise serializers.ValidationError({'granted': error.detail['can_manage_hr']}) from error
        return Response(access_payload())
