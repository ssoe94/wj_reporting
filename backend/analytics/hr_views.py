"""Private HR endpoints. GET is read-only; every mutation is authenticated and audited."""
import json

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import hr_permissions
from .hr_contract import ImportSerializer, SaveImportSerializer, LayoutSerializer, preview_payload, validate_month
from .hr_permissions import IsHrAuthorized, IsHrSuperuser, IsHrLaborAuthorized
from .hr_access_service import set_hr_access
from .hr_service import save_import, save_layout, workspace_payload
from .models import HrAccessGrant, HrMonthWorkspace
from .hr_workbook_contract import SaveReferenceSerializer, WorkbookBatchSerializer, WorkbookCommitSerializer
from .hr_workbook_service import build_preview, save_batch
from .hr_roster_service import RosterUpdateSerializer, edit_roster, roster_payload, roster_history_payload
from .hr_reference_service import reference_payload, save_reference
from .hr_labor_contract import LaborStandardSaveSerializer, LaborCalendarSaveSerializer, LaborActualPaymentSaveSerializer
from .hr_labor_service import standard_payload, calendar_payload, save_standard, save_calendar, actual_payment_payload, save_actual_payment

from .hr_daily_contract import validate_day, DailyPreviewSerializer, DailySaveSerializer, PersonnelEventSerializer
from .hr_daily_work import daily_work_payload, preview_daily_work, save_daily_work
from .hr_personnel_events import append_personnel_event
from .hr_forecast_service import forecast_payload, shanghai_today
from .hr_dashboard_service import dashboard_payload


def validated_input(request, serializer_type, *, context=None):
    if len(json.dumps(request.data, ensure_ascii=False).encode('utf-8')) > 6_000_000:
        raise serializers.ValidationError({'detail': '입력 크기는 6MB 이하여야 합니다.'})
    serializer = serializer_type(data=request.data, context=context or {})
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


class HrRosterView(HrBaseView):
    def get(self, request, month):
        validate_month(month)
        return Response(roster_payload(month))


class HrRosterDetailView(HrBaseView):
    def get(self, request, month, employee_id):
        validate_month(month)
        return Response(roster_history_payload(employee_id))

    def patch(self, request, month, employee_id):
        validate_month(month)
        edit_roster(employee_id, validated_input(request, RosterUpdateSerializer), request.user)
        return Response(roster_payload(month))


class HrLaborStandardView(HrBaseView):
    permission_classes = [IsHrLaborAuthorized]

    def get(self, request, month):
        validate_month(month)
        return Response(standard_payload(month))

    def put(self, request, month):
        validate_month(month)
        return Response(save_standard(month, validated_input(request, LaborStandardSaveSerializer), request.user))


class HrLaborCalendarView(HrBaseView):
    permission_classes = [IsHrLaborAuthorized]

    def get(self, request, month):
        validate_month(month)
        return Response(calendar_payload(month))

    def put(self, request, month):
        validate_month(month)
        data = validated_input(request, LaborCalendarSaveSerializer, context={'month': month})
        return Response(save_calendar(month, data, request.user))


class HrLaborActualPaymentView(HrBaseView):
    permission_classes = [IsHrLaborAuthorized]

    def get(self, request, month):
        validate_month(month)
        return Response(actual_payment_payload(month))

    def put(self, request, month):
        validate_month(month)
        return Response(save_actual_payment(month, validated_input(request, LaborActualPaymentSaveSerializer), request.user))


class HrDailyWorkView(HrBaseView):
    permission_classes = [IsHrLaborAuthorized]

    def get(self, request, day):
        return Response(daily_work_payload(validate_day(day), can_edit=hr_permissions.can_edit_hr_labor(request.user)))

    def put(self, request, day):
        day = validate_day(day)
        return Response(save_daily_work(day, validated_input(request, DailySaveSerializer), request.user))


class HrDailyWorkPreviewView(HrBaseView):
    def post(self, request, day):
        day = validate_day(day)
        data = validated_input(request, DailyPreviewSerializer)
        return Response(preview_daily_work(day, data, can_edit=hr_permissions.can_edit_hr_labor(request.user)))


class HrPersonnelEventView(HrBaseView):
    permission_classes = [IsHrLaborAuthorized]

    @transaction.atomic
    def post(self, request, day):
        day = validate_day(day)
        append_personnel_event(day, validated_input(request, PersonnelEventSerializer), request.user)
        return Response(daily_work_payload(day, can_edit=True), status=201)


class HrLaborForecastView(HrBaseView):
    def get(self, request, month):
        return Response(forecast_payload(validate_month(month), shanghai_today()))


class HrDashboardView(HrBaseView):
    def get(self, request, month):
        return Response(dashboard_payload(validate_month(month), shanghai_today()))
