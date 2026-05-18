from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from production.ai_context import build_context_pack
from production.ai_answer import build_ai_briefing
from production.ai_retrievers import get_daily_production_context

from .models import AiJob
from .serializers import (
    AiJobClaimSerializer,
    AiJobCompleteSerializer,
    AiJobCreateSerializer,
    AiJobFailSerializer,
    AiJobSerializer,
)


def ai_worker_token():
    return getattr(settings, 'AI_WORKER_TOKEN', '') or ''


def ai_job_claim_limit():
    return int(getattr(settings, 'AI_JOB_CLAIM_LIMIT', 1) or 1)


def ai_job_timeout_seconds():
    return int(getattr(settings, 'AI_JOB_TIMEOUT_SECONDS', 600) or 600)


class HasWorkerToken(BasePermission):
    def has_permission(self, request, view):
        expected = ai_worker_token()
        supplied = request.headers.get('X-AI-WORKER-TOKEN', '')
        return bool(expected) and supplied == expected


def normalize_language(value):
    return 'zh' if value == 'zh' else 'ko'


def build_machine_analysis_payload(target_date, language, machine):
    context = get_daily_production_context(target_date)
    context_pack = build_context_pack(context, language, question='production_machine_analysis')
    target = str(machine or '').strip()
    normalized_target = target.lower().replace(' ', '')
    rows = context['injection'].get('machine_rows', []) + context['machining'].get('rows', [])

    def matches(row):
        candidates = [
            row.get('machine'),
            row.get('machine_name'),
            row.get('equipment_label'),
            row.get('equipment_name'),
            row.get('equipment_key'),
        ]
        return any(str(candidate or '').lower().replace(' ', '') == normalized_target for candidate in candidates)

    target_row = next((row for row in rows if matches(row)), None) if normalized_target else None
    if target_row is None and rows:
        target_row = rows[0]

    related_parts = []
    if target_row:
        related_parts = target_row.get('parts') or []

    return {
        'source': 'production_machine_analysis',
        'date': target_date.isoformat(),
        'language': language,
        'machine': target or target_row.get('machine') if target_row else target,
        'target_row': target_row or {},
        'related_parts': related_parts[:20],
        'context_pack': context_pack.to_dict(),
    }


def build_job_input_payload(job_type, scope, supplied_payload):
    if supplied_payload:
        return supplied_payload

    if job_type == AiJob.JOB_TYPE_PRODUCTION_DAILY:
        date_str = scope.get('date') or timezone.localdate().isoformat()
        target_date = parse_date(str(date_str))
        if not target_date:
            raise ValidationError({'scope': 'date must use YYYY-MM-DD.'})
        language = normalize_language(scope.get('language'))
        briefing = build_ai_briefing(target_date, language)
        return {
            'source': 'production_ai_briefing',
            'date': target_date.isoformat(),
            'language': language,
            'briefing': briefing.to_dict(),
        }

    if job_type == AiJob.JOB_TYPE_PRODUCTION_MACHINE:
        date_str = scope.get('date') or timezone.localdate().isoformat()
        target_date = parse_date(str(date_str))
        if not target_date:
            raise ValidationError({'scope': 'date must use YYYY-MM-DD.'})
        language = normalize_language(scope.get('language'))
        return build_machine_analysis_payload(target_date, language, scope.get('machine') or '')

    return {}


class AiJobListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        queryset = AiJob.objects.all()
        job_type = request.query_params.get('job_type')
        status_filter = request.query_params.get('status')
        if job_type:
            queryset = queryset.filter(job_type=job_type)
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        page = self.paginate_queryset(request, queryset)
        if page is not None:
            serializer = AiJobSerializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        return Response(AiJobSerializer(queryset[:100], many=True).data)

    def post(self, request, *args, **kwargs):
        serializer = AiJobCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        job_type = serializer.validated_data['job_type']
        scope = serializer.validated_data.get('scope') or {}
        supplied_payload = serializer.validated_data.get('input_payload') or {}
        input_payload = build_job_input_payload(job_type, scope, supplied_payload)
        job = AiJob.objects.create(
            job_type=job_type,
            scope=scope,
            input_payload=input_payload,
            created_by=request.user if request.user.is_authenticated else None,
        )
        return Response(AiJobSerializer(job).data, status=status.HTTP_201_CREATED)

    def paginate_queryset(self, request, queryset):
        paginator = getattr(self, 'paginator', None)
        if paginator is None:
            from rest_framework.settings import api_settings
            paginator_class = api_settings.DEFAULT_PAGINATION_CLASS
            self.paginator = paginator_class() if paginator_class else None
            paginator = self.paginator
        if paginator is None:
            return None
        return paginator.paginate_queryset(queryset, request, view=self)

    def get_paginated_response(self, data):
        return self.paginator.get_paginated_response(data)


class AiJobDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get_object(self, pk):
        try:
            return AiJob.objects.get(pk=pk)
        except AiJob.DoesNotExist:
            raise NotFound('AI job not found.')

    def get(self, request, pk, *args, **kwargs):
        return Response(AiJobSerializer(self.get_object(pk)).data)


class AiJobCancelView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk, *args, **kwargs):
        try:
            job = AiJob.objects.get(pk=pk)
        except AiJob.DoesNotExist:
            raise NotFound('AI job not found.')

        if job.status in [AiJob.STATUS_COMPLETED, AiJob.STATUS_FAILED, AiJob.STATUS_CANCELLED]:
            raise ValidationError({'detail': f'{job.status} job cannot be cancelled.'})

        job.status = AiJob.STATUS_CANCELLED
        job.completed_at = timezone.now()
        job.save(update_fields=['status', 'completed_at', 'updated_at'])
        return Response(AiJobSerializer(job).data)


class AiWorkerClaimView(APIView):
    authentication_classes = []
    permission_classes = [HasWorkerToken]

    def post(self, request, *args, **kwargs):
        serializer = AiJobClaimSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        worker_name = serializer.validated_data['worker_name']
        limit = min(serializer.validated_data.get('limit') or ai_job_claim_limit(), ai_job_claim_limit())
        job_types = serializer.validated_data.get('job_types') or [
            AiJob.JOB_TYPE_PRODUCTION_DAILY,
            AiJob.JOB_TYPE_PRODUCTION_MACHINE,
        ]
        now = timezone.now()
        stale_before = now - timedelta(seconds=ai_job_timeout_seconds())

        with transaction.atomic():
            AiJob.objects.filter(
                status__in=[AiJob.STATUS_CLAIMED, AiJob.STATUS_RUNNING],
                updated_at__lt=stale_before,
            ).update(status=AiJob.STATUS_PENDING, claimed_by='', claimed_at=None, started_at=None)

            queryset = (
                AiJob.objects
                .select_for_update()
                .filter(status=AiJob.STATUS_PENDING, job_type__in=job_types)
                .order_by('created_at', 'id')[:limit]
            )
            jobs = list(queryset)
            for job in jobs:
                job.status = AiJob.STATUS_CLAIMED
                job.claimed_by = worker_name
                job.claimed_at = now
                job.save(update_fields=['status', 'claimed_by', 'claimed_at', 'updated_at'])

        return Response({'jobs': AiJobSerializer(jobs, many=True).data})


class AiWorkerJobTransitionView(APIView):
    authentication_classes = []
    permission_classes = [HasWorkerToken]
    transition = None

    def get_object(self, pk):
        try:
            return AiJob.objects.get(pk=pk)
        except AiJob.DoesNotExist:
            raise NotFound('AI job not found.')

    def post(self, request, pk, *args, **kwargs):
        job = self.get_object(pk)
        if job.status == AiJob.STATUS_CANCELLED:
            raise PermissionDenied('Cancelled job cannot be updated.')
        if self.transition == 'start':
            return self.start(job)
        if self.transition == 'complete':
            return self.complete(request, job)
        if self.transition == 'fail':
            return self.fail(request, job)
        raise NotFound('Unknown transition.')

    def start(self, job):
        if job.status not in [AiJob.STATUS_CLAIMED, AiJob.STATUS_PENDING]:
            raise ValidationError({'detail': f'{job.status} job cannot be started.'})
        job.status = AiJob.STATUS_RUNNING
        job.started_at = timezone.now()
        job.save(update_fields=['status', 'started_at', 'updated_at'])
        return Response(AiJobSerializer(job).data)

    def complete(self, request, job):
        if job.status not in [AiJob.STATUS_CLAIMED, AiJob.STATUS_RUNNING]:
            raise ValidationError({'detail': f'{job.status} job cannot be completed.'})
        serializer = AiJobCompleteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        job.status = AiJob.STATUS_COMPLETED
        job.result_payload = serializer.validated_data['result_payload']
        job.model_name = serializer.validated_data.get('model_name') or ''
        job.prompt_version = serializer.validated_data.get('prompt_version') or ''
        job.error_message = ''
        job.completed_at = timezone.now()
        job.save(update_fields=[
            'status',
            'result_payload',
            'model_name',
            'prompt_version',
            'error_message',
            'completed_at',
            'updated_at',
        ])
        return Response(AiJobSerializer(job).data)

    def fail(self, request, job):
        if job.status not in [AiJob.STATUS_CLAIMED, AiJob.STATUS_RUNNING]:
            raise ValidationError({'detail': f'{job.status} job cannot be failed.'})
        serializer = AiJobFailSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        job.status = AiJob.STATUS_FAILED
        job.error_message = serializer.validated_data['error_message']
        job.model_name = serializer.validated_data.get('model_name') or ''
        job.prompt_version = serializer.validated_data.get('prompt_version') or ''
        job.completed_at = timezone.now()
        job.save(update_fields=[
            'status',
            'error_message',
            'model_name',
            'prompt_version',
            'completed_at',
            'updated_at',
        ])
        return Response(AiJobSerializer(job).data)
