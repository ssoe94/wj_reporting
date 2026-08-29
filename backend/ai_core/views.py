from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Case, IntegerField, Q, Value, When
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from production.ai_context import build_context_pack
from production.ai_answer import build_ai_briefing
from production.ai_metrics import SHANGHAI_TZ
from production.ai_retrievers import get_daily_production_context
from production.ai_types import (
    DEFAULT_PRODUCTION_AI_MODEL_ID,
    PRODUCTION_AI_MODEL_IDS,
    canonical_production_ai_model_id,
)

from .models import AiJob
from .model_registry import QUALITY_DAILY_MODEL_ID, SUPPORTED_AI_WORKER_VERSION
from .quality_daily import (
    QUALITY_DAILY_MODE,
    QUALITY_DAILY_TRIGGER,
    enqueue_daily_quality_summary,
    is_daily_quality_summary_job,
    restore_authoritative_quality_result,
)
from .quality_report_audit import (
    QUALITY_REPORT_AUDIT_MODE,
    QUALITY_REPORT_AUDIT_PROMPT_VERSION,
    QUALITY_REPORT_AUDIT_TRIGGER,
    is_quality_report_audit_job,
    restore_authoritative_quality_report_audit_result,
)
from .serializers import (
    AiJobClaimSerializer,
    AiJobCompleteSerializer,
    AiJobCreateSerializer,
    AiJobFailSerializer,
    AiJobResultSerializer,
    AiJobSerializer,
    AiWorkerHeartbeatSerializer,
)


AI_WORKER_HEARTBEAT_JOB_TYPE = 'worker_heartbeat'
MANUAL_AI_JOB_COOLDOWN_SECONDS = 60
AUTHORITATIVE_PRODUCTION_RESULT_FIELDS = (
    'answer',
    'severity',
    'facts',
    'top_risks',
    'used_data',
    'calculation_basis',
    'data_freshness',
    'warnings',
    'retrieval_trace',
)


def ai_worker_token():
    return getattr(settings, 'AI_WORKER_TOKEN', '') or ''


def ai_job_claim_limit():
    return int(getattr(settings, 'AI_JOB_CLAIM_LIMIT', 1) or 1)


def ai_job_timeout_seconds():
    return int(getattr(settings, 'AI_JOB_TIMEOUT_SECONDS', 600) or 600)


def visible_jobs_for_user(user):
    return (
        AiJob.objects
        .filter(
            Q(created_by=user)
            | Q(created_by__isnull=True, scope__trigger='hourly')
        )
        .exclude(job_type=AI_WORKER_HEARTBEAT_JOB_TYPE)
    )


def restore_authoritative_production_result(job, worker_result):
    """Keep verified production fields server-owned; the worker may change prose only."""
    result = dict(worker_result)
    scope = job.scope if isinstance(job.scope, dict) else {}
    if (
        job.job_type != AiJob.JOB_TYPE_PRODUCTION_DAILY
        or scope.get('trigger') not in {'hourly', 'question'}
    ):
        return result

    input_payload = job.input_payload if isinstance(job.input_payload, dict) else {}
    source_keys = (
        ('briefing',)
        if scope.get('trigger') == 'hourly'
        else ('deterministic', 'verified_context')
    )
    authoritative_sources = [
        input_payload.get(key)
        for key in source_keys
        if isinstance(input_payload.get(key), dict)
    ]
    for field in AUTHORITATIVE_PRODUCTION_RESULT_FIELDS:
        for source in authoritative_sources:
            if field in source:
                result[field] = source[field]
                break
        else:
            result.pop(field, None)
    return result


def ai_worker_heartbeat_stale_seconds():
    return max(30, int(getattr(settings, 'AI_WORKER_HEARTBEAT_STALE_SECONDS', 300) or 300))


def display_model_name(value):
    return str(value or '').replace('\\', '/').rsplit('/', 1)[-1][:128]


def current_business_scope(now=None):
    local_now = (now or timezone.now()).astimezone(SHANGHAI_TZ)
    business_date = (local_now - timedelta(hours=8)).date()
    schedule_slot = local_now.replace(minute=0, second=0, microsecond=0).isoformat()
    return business_date, schedule_slot


class HasWorkerToken(BasePermission):
    def has_permission(self, request, view):
        expected = ai_worker_token()
        supplied = request.headers.get('X-AI-WORKER-TOKEN', '')
        return bool(expected) and supplied == expected


def normalize_language(value):
    return 'zh' if value == 'zh' else 'ko'


def build_machine_analysis_payload(
    target_date,
    language,
    machine,
    model_id=DEFAULT_PRODUCTION_AI_MODEL_ID,
):
    context = get_daily_production_context(target_date)
    context_pack = build_context_pack(context, language, question='production_machine_analysis')
    target = str(machine or '').strip()
    normalized_target = target.lower().replace(' ', '')
    injection_rows = context['injection'].get('machine_rows', [])
    machining_rows = context['machining'].get('rows', [])
    rows = injection_rows + machining_rows

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
    target_process = (
        'injection'
        if target_row is not None and any(row is target_row for row in injection_rows)
        else 'machining'
        if target_row is not None
        else ''
    )

    related_parts = []
    if target_row:
        related_parts = target_row.get('parts') or []
    target_data_warnings = []
    if target_process == 'injection':
        row_warning = str((target_row or {}).get('data_warning') or '').strip()
        if row_warning:
            target_data_warnings.append(row_warning)
        target_data_warnings.extend(
            warning
            for warning in context_pack.warnings
            if warning in {
                'injection_mes_data_missing',
                'injection_mes_data_stale',
            }
            and warning not in target_data_warnings
        )
    elif target_process == 'machining' and 'machining_actual_missing' in context_pack.warnings:
        target_data_warnings.append('machining_actual_missing')
    if target_row and target_data_warnings:
        # A plan row without a fresh capacity counter is useful for selecting
        # the machine, but its zero actual/gap fields are not verified facts.
        target_row = {
            key: target_row[key]
            for key in (
                'machine',
                'machine_name',
                'machine_number',
                'equipment_label',
                'equipment_name',
                'equipment_key',
                'planned_qty',
            )
            if key in target_row
        }
        related_parts = []

    return {
        'source': 'production_machine_analysis',
        'date': target_date.isoformat(),
        'language': language,
        'model_id': model_id,
        'process': target_process,
        'machine': target or (
            target_row.get('machine')
            or target_row.get('equipment_label')
            or target_row.get('equipment_name')
            or target_row.get('equipment_key')
            if target_row
            else target
        ),
        'target_row': target_row or {},
        'related_parts': related_parts[:20],
        'target_data_warnings': target_data_warnings,
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
            'model_id': scope.get('model_id') or DEFAULT_PRODUCTION_AI_MODEL_ID,
            'briefing': briefing.to_dict(),
        }

    if job_type == AiJob.JOB_TYPE_PRODUCTION_MACHINE:
        date_str = scope.get('date') or timezone.localdate().isoformat()
        target_date = parse_date(str(date_str))
        if not target_date:
            raise ValidationError({'scope': 'date must use YYYY-MM-DD.'})
        language = normalize_language(scope.get('language'))
        return build_machine_analysis_payload(
            target_date,
            language,
            scope.get('machine') or '',
            scope.get('model_id') or DEFAULT_PRODUCTION_AI_MODEL_ID,
        )

    return {}


class AiJobListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        queryset = visible_jobs_for_user(request.user)
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
        scope = dict(serializer.validated_data.get('scope') or {})
        scope['model_id'] = DEFAULT_PRODUCTION_AI_MODEL_ID
        active_statuses = [
            AiJob.STATUS_PENDING,
            AiJob.STATUS_CLAIMED,
            AiJob.STATUS_RUNNING,
        ]
        recent_after = timezone.now() - timedelta(seconds=MANUAL_AI_JOB_COOLDOWN_SECONDS)
        with transaction.atomic():
            get_user_model().objects.select_for_update().only('pk').get(pk=request.user.pk)
            manual_jobs = AiJob.objects.filter(
                created_by=request.user,
            ).filter(Q(scope__trigger='manual') | Q(scope__trigger__isnull=True))
            if (
                manual_jobs.filter(status__in=active_statuses).exists()
                or manual_jobs.filter(created_at__gte=recent_after).exists()
            ):
                return Response({
                    'detail': 'A manual AI job is already active or was created recently.',
                    'code': 'manual_ai_job_rate_limited',
                }, status=status.HTTP_429_TOO_MANY_REQUESTS)
            input_payload = build_job_input_payload(job_type, scope, {})
            job = AiJob.objects.create(
                job_type=job_type,
                scope=scope,
                input_payload=input_payload,
                created_by=request.user,
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

    def get_object(self, request, pk):
        try:
            return visible_jobs_for_user(request.user).get(pk=pk)
        except AiJob.DoesNotExist:
            raise NotFound('AI job not found.')

    def get(self, request, pk, *args, **kwargs):
        return Response(AiJobResultSerializer(self.get_object(request, pk)).data)


class AiJobLatestView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        job_type = request.query_params.get('job_type') or AiJob.JOB_TYPE_PRODUCTION_DAILY
        if job_type not in [AiJob.JOB_TYPE_PRODUCTION_DAILY, AiJob.JOB_TYPE_PRODUCTION_MACHINE]:
            raise ValidationError({'job_type': 'Unsupported AI job type.'})

        business_date, _ = current_business_scope()
        date_str = request.query_params.get('date') or business_date.isoformat()
        if not parse_date(str(date_str)):
            raise ValidationError({'date': 'date must use YYYY-MM-DD.'})
        language = normalize_language(request.query_params.get('language'))
        requested_model_id = str(
            request.query_params.get('model_id') or DEFAULT_PRODUCTION_AI_MODEL_ID
        ).strip()
        model_id = canonical_production_ai_model_id(requested_model_id)
        if model_id is None:
            raise ValidationError({'model_id': 'Unsupported local AI model.'})

        jobs = (
            visible_jobs_for_user(request.user)
            .filter(
                job_type=job_type,
                status=AiJob.STATUS_COMPLETED,
                scope__date=str(date_str),
                scope__language=language,
                scope__trigger='hourly',
            )
        )
        jobs = jobs.filter(scope__model_id=model_id)
        job = jobs.order_by('-completed_at', '-id').first()
        return Response({'job': AiJobResultSerializer(job).data if job else None})


class AiWorkerHeartbeatView(APIView):
    authentication_classes = []
    permission_classes = [HasWorkerToken]

    def post(self, request, *args, **kwargs):
        serializer = AiWorkerHeartbeatSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data
        worker_name = payload['worker_name'].strip()
        now = timezone.now()
        result_payload = {
            'llm_enabled': bool(payload.get('llm_enabled')),
            'llm_ready': payload.get('llm_ready'),
            'model_name': display_model_name(payload.get('model_name')),
            'worker_version': (payload.get('worker_version') or '')[:64],
            'last_error': (payload.get('last_error') or '')[:500],
            'available_model_ids': list(payload.get('available_model_ids') or []),
        }

        with transaction.atomic():
            heartbeat = (
                AiJob.objects
                .select_for_update()
                .filter(
                    job_type=AI_WORKER_HEARTBEAT_JOB_TYPE,
                    scope__worker_name=worker_name,
                )
                .order_by('-id')
                .first()
            )
            if heartbeat is None:
                heartbeat = AiJob.objects.create(
                    job_type=AI_WORKER_HEARTBEAT_JOB_TYPE,
                    status=AiJob.STATUS_COMPLETED,
                    scope={'trigger': 'worker_heartbeat', 'worker_name': worker_name},
                    input_payload={},
                    result_payload=result_payload,
                    claimed_by=worker_name,
                    completed_at=now,
                    created_by=None,
                )
            else:
                heartbeat.status = AiJob.STATUS_COMPLETED
                heartbeat.scope = {'trigger': 'worker_heartbeat', 'worker_name': worker_name}
                heartbeat.result_payload = result_payload
                heartbeat.claimed_by = worker_name
                heartbeat.completed_at = now
                heartbeat.error_message = ''
                heartbeat.save(update_fields=[
                    'status',
                    'scope',
                    'result_payload',
                    'claimed_by',
                    'completed_at',
                    'error_message',
                    'updated_at',
                ])

        return Response({
            'state': 'online',
            'online': True,
            'worker_name': worker_name,
            'last_heartbeat_at': heartbeat.completed_at,
            **result_payload,
        })


class AiWorkerStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        language = normalize_language(request.query_params.get('language'))
        heartbeat = (
            AiJob.objects
            .filter(job_type=AI_WORKER_HEARTBEAT_JOB_TYPE)
            .order_by('-completed_at', '-id')
            .first()
        )
        stale_after_seconds = ai_worker_heartbeat_stale_seconds()
        heartbeat_time = heartbeat.completed_at if heartbeat else None
        heartbeat_age_seconds = None
        if heartbeat_time:
            heartbeat_age_seconds = max(0, int((timezone.now() - heartbeat_time).total_seconds()))
        if heartbeat_age_seconds is None:
            state = 'unknown'
        elif heartbeat_age_seconds <= stale_after_seconds:
            state = 'online'
        else:
            state = 'offline'

        heartbeat_result = heartbeat.result_payload if heartbeat else {}
        heartbeat_worker_version = (
            str(heartbeat_result.get('worker_version') or '') if heartbeat else ''
        )
        worker_compatible = heartbeat_worker_version == SUPPORTED_AI_WORKER_VERSION
        latest_analysis = (
            AiJob.objects
            .filter(
                job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
                status=AiJob.STATUS_COMPLETED,
                created_by__isnull=True,
                scope__trigger='hourly',
                scope__language=language,
                scope__model_id=DEFAULT_PRODUCTION_AI_MODEL_ID,
            )
            .order_by('-completed_at', '-id')
            .first()
        )
        analysis_result = latest_analysis.result_payload if latest_analysis else {}
        return Response({
            'state': state,
            'online': state == 'online',
            'worker_name': heartbeat.scope.get('worker_name', '') if heartbeat else '',
            'last_heartbeat_at': heartbeat_time,
            'heartbeat_age_seconds': heartbeat_age_seconds,
            'stale_after_seconds': stale_after_seconds,
            'llm_enabled': heartbeat_result.get('llm_enabled') if heartbeat else None,
            'llm_ready': (
                heartbeat_result.get('llm_ready') if heartbeat and worker_compatible else False
            ),
            'model_name': display_model_name(heartbeat_result.get('model_name')),
            'worker_version': heartbeat_worker_version,
            'worker_compatible': worker_compatible,
            'last_error': heartbeat_result.get('last_error', '') if heartbeat else '',
            'available_model_ids': (
                heartbeat_result.get('available_model_ids', [])
                if heartbeat and worker_compatible
                else []
            ),
            'last_analysis_completed_at': latest_analysis.completed_at if latest_analysis else None,
            'last_analysis_model_name': display_model_name(latest_analysis.model_name) if latest_analysis else '',
            'last_analysis_llm_fallback': (
                analysis_result.get('llm_fallback') is True if latest_analysis else None
            ),
        })


class AiJobCancelView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk, *args, **kwargs):
        try:
            job = AiJob.objects.get(pk=pk, created_by=request.user)
        except AiJob.DoesNotExist:
            raise NotFound('AI job not found.')

        if job.status in [AiJob.STATUS_COMPLETED, AiJob.STATUS_FAILED, AiJob.STATUS_CANCELLED]:
            raise ValidationError({'detail': f'{job.status} job cannot be cancelled.'})

        job.status = AiJob.STATUS_CANCELLED
        job.completed_at = timezone.now()
        job.save(update_fields=['status', 'completed_at', 'updated_at'])
        return Response(AiJobSerializer(job).data)


class AiWorkerPeriodicEnqueueView(APIView):
    authentication_classes = []
    permission_classes = [HasWorkerToken]

    def post(self, request, *args, **kwargs):
        languages = request.data.get('languages') or ['ko', 'zh']
        if not isinstance(languages, list) or not languages:
            raise ValidationError({'languages': 'languages must be a non-empty list.'})
        normalized_languages = []
        for value in languages:
            language = normalize_language(value)
            if language not in normalized_languages:
                normalized_languages.append(language)

        target_date, schedule_slot = current_business_scope()
        jobs = []
        created_count = 0
        for language in normalized_languages:
            for model_id in PRODUCTION_AI_MODEL_IDS:
                filters = {
                    'job_type': AiJob.JOB_TYPE_PRODUCTION_DAILY,
                    'scope__date': target_date.isoformat(),
                    'scope__language': language,
                    'scope__model_id': model_id,
                    'scope__schedule_slot': schedule_slot,
                }
                existing = AiJob.objects.filter(**filters).order_by('-id').first()
                if existing:
                    jobs.append(existing)
                    continue

                scope = {
                    'date': target_date.isoformat(),
                    'language': language,
                    'model_id': model_id,
                    'schedule_slot': schedule_slot,
                    'trigger': 'hourly',
                }
                input_payload = build_job_input_payload(AiJob.JOB_TYPE_PRODUCTION_DAILY, scope, {})
                with transaction.atomic():
                    existing = AiJob.objects.filter(**filters).order_by('-id').first()
                    if existing:
                        jobs.append(existing)
                        continue
                    job = AiJob.objects.create(
                        job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
                        scope=scope,
                        input_payload=input_payload,
                        created_by=None,
                    )
                    jobs.append(job)
                    created_count += 1

        quality_enqueue = enqueue_daily_quality_summary()
        if quality_enqueue.get('created'):
            created_count += 1
        quality_job = quality_enqueue.get('job')
        from quality.classification_audit import enqueue_stale_quality_report_audits

        quality_audit_enqueue = enqueue_stale_quality_report_audits(
            bounded_scan=True,
        )
        created_count += int(quality_audit_enqueue.get('created_count') or 0)

        return Response({
            'schedule_slot': schedule_slot,
            'created_count': created_count,
            'jobs': AiJobResultSerializer(jobs, many=True).data,
            'quality_summary': {
                key: value
                for key, value in quality_enqueue.items()
                if key != 'job'
            } | {
                'job': AiJobResultSerializer(quality_job).data if quality_job else None,
            },
            'quality_report_audit': quality_audit_enqueue,
        })


class AiWorkerClaimView(APIView):
    authentication_classes = []
    permission_classes = [HasWorkerToken]

    def post(self, request, *args, **kwargs):
        serializer = AiJobClaimSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        worker_name = serializer.validated_data['worker_name']
        worker_version = serializer.validated_data['worker_version']
        available_model_ids = set(
            serializer.validated_data.get('available_model_ids') or []
        )
        if worker_version != SUPPORTED_AI_WORKER_VERSION:
            return Response({
                'detail': 'This AI Worker version is not supported.',
                'code': 'unsupported_worker_version',
                'supported_worker_version': SUPPORTED_AI_WORKER_VERSION,
            }, status=status.HTTP_409_CONFLICT)
        limit = min(serializer.validated_data.get('limit') or ai_job_claim_limit(), ai_job_claim_limit())
        job_types = serializer.validated_data.get('job_types') or [
            AiJob.JOB_TYPE_PRODUCTION_DAILY,
            AiJob.JOB_TYPE_PRODUCTION_MACHINE,
            AiJob.JOB_TYPE_QUALITY_IMAGE,
        ]
        production_job_types = [
            job_type for job_type in job_types
            if job_type != AiJob.JOB_TYPE_QUALITY_IMAGE
        ]
        eligible_jobs = Q(pk__in=[])
        if production_job_types and available_model_ids:
            eligible_jobs |= Q(
                job_type__in=production_job_types,
                scope__model_id__in=available_model_ids,
            )
        if (
            AiJob.JOB_TYPE_QUALITY_IMAGE in job_types
            and QUALITY_DAILY_MODEL_ID in available_model_ids
        ):
            eligible_jobs |= (
                Q(
                    job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                    scope__mode=QUALITY_DAILY_MODE,
                    scope__trigger=QUALITY_DAILY_TRIGGER,
                    scope__model_id=QUALITY_DAILY_MODEL_ID,
                )
                | Q(
                    job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                    scope__mode=QUALITY_REPORT_AUDIT_MODE,
                    scope__trigger=QUALITY_REPORT_AUDIT_TRIGGER,
                    scope__model_id=QUALITY_DAILY_MODEL_ID,
                )
            )
        now = timezone.now()
        local_today = now.astimezone(SHANGHAI_TZ).date().isoformat()
        stale_before = now - timedelta(seconds=ai_job_timeout_seconds())

        with transaction.atomic():
            AiJob.objects.filter(
                status__in=[AiJob.STATUS_CLAIMED, AiJob.STATUS_RUNNING],
                updated_at__lt=stale_before,
            ).update(status=AiJob.STATUS_PENDING, claimed_by='', claimed_at=None, started_at=None)

            queryset = (
                AiJob.objects
                .select_for_update()
                .filter(status=AiJob.STATUS_PENDING)
                .filter(eligible_jobs)
                .annotate(
                    trigger_priority=Case(
                        When(
                            scope__trigger=QUALITY_DAILY_TRIGGER,
                            scope__date=local_today,
                            then=Value(0),
                        ),
                        When(scope__trigger=QUALITY_DAILY_TRIGGER, then=Value(1)),
                        When(scope__trigger='hourly', then=Value(2)),
                        default=Value(3),
                        output_field=IntegerField(),
                    )
                )
                .order_by('trigger_priority', 'created_at', 'id')[:limit]
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

    def get_object(self, pk, *, for_update=False):
        try:
            queryset = AiJob.objects.select_for_update() if for_update else AiJob.objects
            return queryset.get(pk=pk)
        except AiJob.DoesNotExist:
            raise NotFound('AI job not found.')

    def post(self, request, pk, *args, **kwargs):
        with transaction.atomic():
            job = self.get_object(pk, for_update=True)
            if job.status == AiJob.STATUS_CANCELLED:
                raise PermissionDenied('Cancelled job cannot be updated.')
            if self.transition == 'start':
                return self.start(request, job)
            if self.transition == 'complete':
                return self.complete(request, job)
            if self.transition == 'fail':
                return self.fail(request, job)
            raise NotFound('Unknown transition.')

    def assert_claim_lease(self, job, payload):
        """Reject transitions from a Worker that no longer owns this claim."""
        worker_name = str(payload.get('worker_name') or '').strip()
        claim_timestamp = payload.get('claim_timestamp')
        if isinstance(claim_timestamp, str):
            claim_timestamp = parse_datetime(claim_timestamp)
        if (
            not worker_name
            or worker_name != job.claimed_by
            or claim_timestamp is None
            or job.claimed_at is None
            or claim_timestamp != job.claimed_at
        ):
            raise PermissionDenied('This job lease belongs to another Worker claim.')

    def start(self, request, job):
        self.assert_claim_lease(job, request.data)
        if job.status != AiJob.STATUS_CLAIMED:
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
        self.assert_claim_lease(job, serializer.validated_data)
        if (
            is_quality_report_audit_job(job)
            and serializer.validated_data.get('prompt_version')
            != QUALITY_REPORT_AUDIT_PROMPT_VERSION
        ):
            raise ValidationError({
                'prompt_version': 'The quality report audit prompt version is not supported.',
            })
        job.status = AiJob.STATUS_COMPLETED
        worker_result = serializer.validated_data['result_payload']
        if is_daily_quality_summary_job(job):
            job.result_payload = restore_authoritative_quality_result(job, worker_result)
        elif is_quality_report_audit_job(job):
            job.result_payload = restore_authoritative_quality_report_audit_result(
                job,
                worker_result,
            )
        else:
            job.result_payload = restore_authoritative_production_result(job, worker_result)
        scope = job.scope if isinstance(job.scope, dict) else {}
        scope_model_id = str(scope.get('model_id') or '').strip()
        if scope_model_id in PRODUCTION_AI_MODEL_IDS or scope_model_id == QUALITY_DAILY_MODEL_ID:
            job.result_payload['model_id'] = scope_model_id
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
        self.assert_claim_lease(job, serializer.validated_data)
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
