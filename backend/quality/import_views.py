from __future__ import annotations

import logging
import json
import re
import uuid
from collections import Counter
from datetime import datetime, time, timedelta

from django.core.files.uploadhandler import StopUpload, TemporaryFileUploadHandler
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .direct_import import import_quality_workbook_direct, safe_workbook_filename
from .browser_direct_import import (
    DIRECT_DELIVERY_MODE,
    complete_browser_direct_asset,
    destroy_browser_direct_pending_uploads,
    finalize_browser_direct_job,
    prepare_browser_direct_quality_manifest,
    serialize_browser_direct_job,
    unresolved_browser_direct_public_ids,
)
from .duplicate_detection import find_best_report_duplicates
from .excel_import import (
    MAX_UPLOAD_BYTES,
    WorkbookValidationError,
    _lock_staging_capacity,
    ingest_quality_workbook,
    kick_quality_import_pump,
    parse_import_scope,
    retry_quality_import_batch,
)
from .models import QualityImportBatch, QualityImportRow, QualityReport
from .incremental_import import (
    MAX_COMMIT_MEDIA_BYTES,
    MAX_COMMIT_ROWS,
    MAX_MANIFEST_BYTES,
    commit_quality_manifest,
    enqueue_quality_manifest,
    INCREMENTAL_JOB_DATASET_KEY,
    preview_quality_manifest,
    serialize_quality_import_job,
)
from .direct_import import REPORT_TIMEZONE
from .permissions import QualityImportPermission
from .serializers import QualityImportBatchSerializer, QualityImportRowSerializer
from .views import QualityImportPagination


READY_STATUSES = {
    QualityImportBatch.Status.READY,
    QualityImportBatch.Status.READY_WITH_WARNINGS,
}
LOGGER = logging.getLogger(__name__)
# Backward-compatible private alias for the existing security test and any
# in-process callers while the direct endpoint owns the shared implementation.
_safe_filename = safe_workbook_filename


def _require_staff(request) -> None:
    if not request.user.is_staff:
        raise PermissionDenied('Only an administrator may roll back Excel imports.')


def _excel_origin_predicate() -> Q:
    """Excel-created reports, excluding manual reports merely linked in review."""

    legacy_created = (
        Q(source_import_row__isnull=False)
        & ~Q(source_import_row__duplicate_override_reason__startswith='link_existing:')
        & ~Q(source_import_row__duplicate_override_reason__startswith='update_existing:')
    )
    return Q(excel_import_key__isnull=False) | legacy_created


def _today_excel_report_queryset(target_date):
    """Reports created on one Shanghai day with verifiable Excel provenance."""

    start = datetime.combine(target_date, time.min, tzinfo=REPORT_TIMEZONE)
    end = start + timedelta(days=1)
    return (
        QualityReport.objects.select_related('source_import_row__batch__provenance')
        .filter(created_at__gte=start, created_at__lt=end)
        .filter(_excel_origin_predicate())
        .order_by('id')
    )


def _excel_report_source(report: QualityReport) -> tuple[str, str]:
    try:
        source_row = report.source_import_row
    except QualityImportRow.DoesNotExist:
        source_row = None
    if source_row is not None:
        try:
            filename = source_row.batch.provenance.source_filename
        except Exception:
            filename = source_row.batch.original_filename
        return filename or '(unknown workbook)', source_row.sheet_name or '(unknown sheet)'
    source = report.excel_source or {}
    return (
        str(source.get('source_filename') or '(unknown workbook)'),
        str(source.get('sheet_name') or '(unknown sheet)'),
    )


def _active_incremental_jobs_queryset():
    now = timezone.now()
    return QualityImportBatch.objects.filter(dataset_key=INCREMENTAL_JOB_DATASET_KEY).filter(
        Q(status=QualityImportBatch.Status.QUEUED)
        | Q(status=QualityImportBatch.Status.PROCESSING)
        | (
            Q(status=QualityImportBatch.Status.STAGING)
            & Q(delta_summary__delivery_mode=DIRECT_DELIVERY_MODE)
            & Q(lease_expires_at__gt=now)
        )
    )


def _expired_direct_jobs_queryset():
    return QualityImportBatch.objects.filter(
        dataset_key=INCREMENTAL_JOB_DATASET_KEY,
        delta_summary__delivery_mode=DIRECT_DELIVERY_MODE,
        status=QualityImportBatch.Status.STAGING,
    ).filter(Q(lease_expires_at__isnull=True) | Q(lease_expires_at__lte=timezone.now()))


def _incremental_result_report_ids(batch: QualityImportBatch) -> set[int]:
    result = (batch.delta_summary or {}).get('incremental_result')
    if not isinstance(result, dict):
        return set()
    report_ids: set[int] = set()
    for field_name in ('created_report_ids', 'skipped_report_ids', 'changed_report_ids'):
        values = result.get(field_name)
        if not isinstance(values, list):
            continue
        report_ids.update(
            value for value in values
            if type(value) is int and value > 0
        )
    return report_ids


def _excel_rollback_preview(target_date) -> dict:
    reports = list(_today_excel_report_queryset(target_date))
    groups = Counter(_excel_report_source(report) for report in reports)
    local_created = [timezone.localtime(report.created_at, REPORT_TIMEZONE) for report in reports]
    report_dates = [timezone.localtime(report.report_dt, REPORT_TIMEZONE).date() for report in reports]
    start = datetime.combine(target_date, time.min, tzinfo=REPORT_TIMEZONE)
    end = start + timedelta(days=1)
    manual_preserved = (
        QualityReport.objects.filter(created_at__gte=start, created_at__lt=end)
        .exclude(_excel_origin_predicate())
        .count()
    )
    active_jobs = _active_incremental_jobs_queryset().count()
    expired_direct_jobs = _expired_direct_jobs_queryset().count()
    terminal_jobs_today = QualityImportBatch.objects.filter(
        dataset_key=INCREMENTAL_JOB_DATASET_KEY,
        created_at__gte=start,
        created_at__lt=end,
        status__in=[
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
            QualityImportBatch.Status.FAILED,
        ],
    ).count()
    return {
        'target_date': target_date.isoformat(),
        'count': len(reports),
        'manual_reports_preserved': manual_preserved,
        'active_incremental_jobs': active_jobs,
        'expired_direct_jobs': expired_direct_jobs,
        'terminal_incremental_jobs': terminal_jobs_today,
        'image_reference_count': sum(
            bool(getattr(report, field_name))
            for report in reports
            for field_name in ('image1', 'image2', 'image3', 'image4', 'image5')
        ),
        'created_at_first': min(local_created).isoformat() if local_created else None,
        'created_at_last': max(local_created).isoformat() if local_created else None,
        'report_date_first': min(report_dates).isoformat() if report_dates else None,
        'report_date_last': max(report_dates).isoformat() if report_dates else None,
        'source_groups': [
            {'source_filename': filename, 'sheet_name': sheet_name, 'count': count}
            for (filename, sheet_name), count in sorted(groups.items())
        ],
    }


class QualityImportTemporaryUploadHandler(TemporaryFileUploadHandler):
    """Force disk-backed request streaming and stop a file above 80 MiB."""

    def __init__(self, request=None):
        super().__init__(request)
        self.received = 0
        self.exceeded = False

    def new_file(self, *args, **kwargs):
        self.received = 0
        self.exceeded = False
        return super().new_file(*args, **kwargs)

    def receive_data_chunk(self, raw_data, start):
        self.received += len(raw_data)
        if self.received > MAX_UPLOAD_BYTES:
            self.exceeded = True
            raise StopUpload(connection_reset=False)
        return super().receive_data_chunk(raw_data, start)


def _error(exc: WorkbookValidationError) -> Response:
    if exc.code == 'file_too_large':
        response_status = status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    elif exc.code in {
        'production_storage_required',
        'staging_capacity_exceeded',
        'cloudinary_verification_unavailable',
    }:
        response_status = status.HTTP_503_SERVICE_UNAVAILABLE
    elif exc.code == 'job_owner_mismatch':
        response_status = status.HTTP_403_FORBIDDEN
    elif exc.code in {'job_busy', 'job_delivery_conflict', 'job_expired', 'missing_media'}:
        response_status = status.HTTP_409_CONFLICT
    else:
        response_status = status.HTTP_400_BAD_REQUEST
    return Response({'code': exc.code, 'error': exc.message}, status=response_status)


class QualityImportBatchViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    """Single-request XLSX intake followed by durable normalized-image upload."""

    permission_classes = [IsAuthenticated, QualityImportPermission]
    serializer_class = QualityImportBatchSerializer
    pagination_class = QualityImportPagination
    parser_classes = [MultiPartParser, FormParser]
    http_method_names = ['get', 'post', 'head', 'options']

    def initialize_request(self, request, *args, **kwargs):
        handler = QualityImportTemporaryUploadHandler(request)
        request.upload_handlers = [handler]
        request._quality_import_upload_handler = handler
        return super().initialize_request(request, *args, **kwargs)

    def get_queryset(self):
        return QualityImportBatch.objects.select_related(
            'uploaded_by', 'provenance', 'baseline_batch',
        ).all()

    def list(self, request, *args, **kwargs):
        kick_quality_import_pump()
        return super().list(request, *args, **kwargs)

    def retrieve(self, request, *args, **kwargs):
        kick_quality_import_pump()
        return super().retrieve(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        # Accessing FILES triggers the bounded streaming handler above.
        upload = request.FILES.get('file')
        raw_request = request._request
        handler = getattr(raw_request, '_quality_import_upload_handler', None)
        if handler and handler.exceeded:
            return _error(WorkbookValidationError(
                'file_too_large',
                f'Workbook exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit.',
            ))
        if upload is None:
            return Response(
                {'code': 'file_required', 'error': 'Multipart field "file" is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(request.FILES) != 1:
            upload.close()
            return Response(
                {'code': 'one_file_required', 'error': 'Upload exactly one workbook.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            upload.name = safe_workbook_filename(upload.name)
            import_scope = parse_import_scope(
                request.data.get('import_mode'),
                request.data.get('range_start'),
                request.data.get('range_end'),
            )
            batch, replay = ingest_quality_workbook(
                upload,
                uploaded_by=request.user,
                import_scope=import_scope,
            )
        except WorkbookValidationError as exc:
            return _error(exc)
        payload = self.get_serializer(batch).data
        payload['idempotent_replay'] = replay
        return Response(payload, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=['post'])
    def retry(self, request, pk=None):
        batch = self.get_object()
        try:
            batch = retry_quality_import_batch(batch)
        except WorkbookValidationError as exc:
            return _error(exc)
        payload = self.get_serializer(batch).data
        payload['retried'] = True
        return Response(payload, status=status.HTTP_202_ACCEPTED)

    @action(detail=True, methods=['get'])
    def rows(self, request, pk=None):
        batch = self.get_object()
        if batch.status not in READY_STATUSES:
            return Response(
                {'code': 'batch_not_ready', 'error': 'Rows remain private until processing completes.'},
                status=status.HTTP_409_CONFLICT,
            )
        queryset = batch.rows.select_related(
            'duplicate_of', 'baseline_row', 'supersedes',
        ).prefetch_related('media__asset')
        sheet_name = request.query_params.get('sheet_name')
        review_status = request.query_params.get('review_status')
        delta_status = request.query_params.get('delta_status')
        if sheet_name:
            queryset = queryset.filter(sheet_name=sheet_name)
        if review_status:
            queryset = queryset.filter(review_status=review_status)
        if delta_status:
            allowed = {value for value, _label in QualityImportRow.DeltaStatus.choices}
            if delta_status not in allowed:
                raise ValidationError({'delta_status': 'Expected added, changed, or unchanged.'})
            queryset = queryset.filter(delta_status=delta_status)
        page = self.paginate_queryset(queryset)
        selected_rows = list(page) if page is not None else list(queryset)
        context = self.get_serializer_context()
        context['duplicate_matches'] = find_best_report_duplicates(selected_rows)
        serializer = QualityImportRowSerializer(
            selected_rows,
            many=True,
            context=context,
        )
        return self.get_paginated_response(serializer.data) if page is not None else Response(serializer.data)


class QualityExcelImportView(APIView):
    """Register new quality reports directly from one XLSX workbook."""

    permission_classes = [IsAuthenticated, QualityImportPermission]
    parser_classes = [MultiPartParser, FormParser]

    def initialize_request(self, request, *args, **kwargs):
        handler = QualityImportTemporaryUploadHandler(request)
        request.upload_handlers = [handler]
        request._quality_import_upload_handler = handler
        return super().initialize_request(request, *args, **kwargs)

    def post(self, request, *args, **kwargs):
        upload = request.FILES.get('file')
        handler = getattr(request._request, '_quality_import_upload_handler', None)
        if handler and handler.exceeded:
            return _error(WorkbookValidationError(
                'file_too_large',
                f'Workbook exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit.',
            ))
        if upload is None:
            return Response(
                {'code': 'file_required', 'error': 'Multipart field "file" is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(request.FILES) != 1:
            upload.close()
            return Response(
                {'code': 'one_file_required', 'error': 'Upload exactly one workbook.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            result = import_quality_workbook_direct(upload, uploaded_by=request.user)
        except WorkbookValidationError as exc:
            return _error(exc)
        except Exception:
            reference = uuid.uuid4().hex[:12]
            LOGGER.exception('Direct quality Excel import failed reference=%s', reference)
            return Response(
                {
                    'code': 'quality_import_failed',
                    'error': (
                        'The workbook could not be registered. '
                        f'Retry the upload or contact an administrator with reference {reference}.'
                    ),
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(result, status=status.HTTP_200_OK)


class QualityExcelImportRollbackView(APIView):
    """Preview and delete only today's Excel-origin reports.

    The destructive POST is staff-only, locked, and guarded by both an exact
    expected count and a date/count confirmation token. Manual reports are
    never part of this queryset.
    """

    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    @staticmethod
    def _target_date(request):
        local_today = timezone.now().astimezone(REPORT_TIMEZONE).date()
        raw_value = request.query_params.get('target_date') if request.method == 'GET' else request.data.get('target_date')
        target_date = parse_date(str(raw_value)) if raw_value else local_today
        if target_date is None:
            raise ValidationError({'target_date': 'Expected an ISO date.'})
        if target_date != local_today:
            raise ValidationError({'target_date': 'This recovery action is limited to today.'})
        return target_date

    def get(self, request, *args, **kwargs):
        _require_staff(request)
        target_date = self._target_date(request)
        return Response(_excel_rollback_preview(target_date))

    def post(self, request, *args, **kwargs):
        _require_staff(request)
        if not isinstance(request.data, dict):
            raise ValidationError({'detail': 'Expected a JSON object.'})
        target_date = self._target_date(request)
        expected_count = request.data.get('expected_count')
        if type(expected_count) is not int or expected_count < 0:
            raise ValidationError({'expected_count': 'Expected a non-negative integer.'})
        expected_confirmation = f'DELETE:{target_date.isoformat()}:{expected_count}'
        if request.data.get('confirmation') != expected_confirmation:
            raise ValidationError({'confirmation': 'The rollback confirmation token does not match.'})

        with transaction.atomic():
            # Serialize this destructive recovery action with new durable job
            # intake. Existing queued rows are locked below so the pump cannot
            # start one between the safety check and deletion.
            _lock_staging_capacity()
            # Cancel expired, non-processing browser reservations under the
            # same advisory lock used by prepare/reclaim. Their upload targets
            # are job-scoped, so a late receipt becomes a harmless 404 instead
            # of recreating reports after the rollback.
            expired_direct_jobs = list(
                _expired_direct_jobs_queryset()
                .select_for_update()
            )
            expired_direct_job_ids = [batch.pk for batch in expired_direct_jobs]
            abandoned_public_ids = [
                public_id
                for batch in expired_direct_jobs
                for public_id in unresolved_browser_direct_public_ids(batch)
            ]
            cancelled_expired_jobs = len(expired_direct_job_ids)
            if expired_direct_job_ids:
                QualityImportBatch.objects.filter(pk__in=expired_direct_job_ids).delete()
            if abandoned_public_ids:
                transaction.on_commit(
                    lambda public_ids=tuple(abandoned_public_ids):
                    destroy_browser_direct_pending_uploads(public_ids)
                )
            active_job_ids = list(
                _active_incremental_jobs_queryset()
                .select_for_update()
                .values_list('id', flat=True)
            )
            active_jobs = len(active_job_ids)
            if active_jobs:
                return Response(
                    {
                        'code': 'rollback_jobs_active',
                        'error': 'Wait for active Excel jobs to finish before rolling back today.',
                        'active_incremental_jobs': active_jobs,
                        'cancelled_expired_jobs': cancelled_expired_jobs,
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            # The source-import relation is nullable. PostgreSQL rejects FOR
            # UPDATE across that outer join, so lock only the report rows.
            reports = list(
                _today_excel_report_queryset(target_date).select_for_update(of=('self',))
            )
            if len(reports) != expected_count:
                return Response(
                    {
                        'code': 'rollback_scope_changed',
                        'error': 'The Excel report count changed. Preview the rollback again.',
                        **_excel_rollback_preview(target_date),
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            report_ids = [report.pk for report in reports]
            incremental_batch_ids = list(
                QualityImportRow.objects.filter(
                    approved_report_id__in=report_ids,
                    batch__dataset_key=INCREMENTAL_JOB_DATASET_KEY,
                )
                .values_list('batch_id', flat=True)
                .distinct()
            )
            terminal_jobs = list(
                QualityImportBatch.objects.select_for_update().filter(
                    dataset_key=INCREMENTAL_JOB_DATASET_KEY,
                    status__in=[
                        QualityImportBatch.Status.READY,
                        QualityImportBatch.Status.READY_WITH_WARNINGS,
                        QualityImportBatch.Status.FAILED,
                    ],
                ).only('id', 'created_at', 'delta_summary')
            )
            incremental_batch_ids = sorted({
                *incremental_batch_ids,
                *(
                    batch.pk
                    for batch in terminal_jobs
                    if (
                        timezone.localtime(batch.created_at, REPORT_TIMEZONE).date() == target_date
                        or bool(_incremental_result_report_ids(batch).intersection(report_ids))
                    )
                ),
            })
            source_groups = _excel_rollback_preview(target_date)['source_groups']
            image_reference_count = sum(
                bool(getattr(report, field_name))
                for report in reports
                for field_name in ('image1', 'image2', 'image3', 'image4', 'image5')
            )
            QualityReport.objects.filter(pk__in=report_ids).delete()
            # Terminal direct-import jobs are idempotent by workbook/chunk. If
            # their reports are rolled back, the job checkpoint must go too or
            # the same workbook would replay stale deleted report IDs.
            incremental_batches = QualityImportBatch.objects.filter(
                pk__in=incremental_batch_ids,
                dataset_key=INCREMENTAL_JOB_DATASET_KEY,
            )
            deleted_job_count = incremental_batches.count()
            incremental_batches.delete()

        LOGGER.warning(
            'Staff user=%s rolled back %s Excel quality reports created on %s groups=%s',
            request.user.pk,
            len(report_ids),
            target_date.isoformat(),
            source_groups,
        )
        return Response({
            'target_date': target_date.isoformat(),
            'deleted_count': len(report_ids),
            'deleted_report_ids': report_ids,
            'source_groups': source_groups,
            'deleted_image_references': image_reference_count,
            'deleted_incremental_jobs': deleted_job_count,
            'cancelled_expired_jobs': cancelled_expired_jobs,
            'remote_image_cleanup': 'not_required' if image_reference_count == 0 else 'deferred',
        })


class QualityExcelImportPreviewView(APIView):
    """Classify a locally scanned workbook without uploading its pictures."""

    permission_classes = [IsAuthenticated, QualityImportPermission]
    parser_classes = [JSONParser]

    def post(self, request, *args, **kwargs):
        try:
            content_length = int(request.META.get('CONTENT_LENGTH') or 0)
        except (TypeError, ValueError):
            content_length = 0
        if content_length > MAX_MANIFEST_BYTES:
            return _error(WorkbookValidationError(
                'manifest_too_large',
                'Workbook manifest exceeds the safe limit.',
            ))
        try:
            result = preview_quality_manifest(
                request.data,
                uploaded_on=datetime.now(REPORT_TIMEZONE).date(),
            )
        except WorkbookValidationError as exc:
            return _error(exc)
        except Exception:
            reference = uuid.uuid4().hex[:12]
            LOGGER.exception('Quality Excel manifest preview failed reference=%s', reference)
            return Response(
                {
                    'code': 'quality_import_preview_failed',
                    'error': (
                        'The workbook could not be compared. '
                        f'Retry or contact an administrator with reference {reference}.'
                    ),
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(result, status=status.HTTP_200_OK)


class QualityIncrementalTemporaryUploadHandler(TemporaryFileUploadHandler):
    """Keep incremental image uploads disk-backed and cap their total bytes."""

    def __init__(self, request=None):
        super().__init__(request)
        self.total_received = 0
        self.exceeded = False

    def receive_data_chunk(self, raw_data, start):
        self.total_received += len(raw_data)
        if self.total_received > MAX_COMMIT_MEDIA_BYTES:
            self.exceeded = True
            raise StopUpload(connection_reset=False)
        return super().receive_data_chunk(raw_data, start)


def _direct_row_keys(value):
    if (
        not isinstance(value, list)
        or len(value) > MAX_COMMIT_ROWS
        or any(
            not isinstance(item, str)
            or re.fullmatch(r'[0-9a-f]{64}', item) is None
            for item in value
        )
        or len(set(value)) != len(value)
    ):
        raise WorkbookValidationError(
            'invalid_row_selection',
            'row_keys must contain unique workbook row keys.',
        )
    return set(value)


class QualityExcelDirectJobView(APIView):
    """Prepare a manifest chunk and issue immutable browser upload intents."""

    permission_classes = [IsAuthenticated, QualityImportPermission]
    parser_classes = [JSONParser]

    def post(self, request, *args, **kwargs):
        envelope = request.data
        if not isinstance(envelope, dict) or not isinstance(envelope.get('manifest'), dict):
            return Response(
                {'code': 'manifest_required', 'error': 'JSON field "manifest" is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            row_keys = _direct_row_keys(envelope.get('row_keys'))
            batch, replay = prepare_browser_direct_quality_manifest(
                envelope['manifest'],
                uploaded_by=request.user,
                uploaded_on=datetime.now(REPORT_TIMEZONE).date(),
                selected_row_keys=row_keys,
            )
            payload = serialize_browser_direct_job(batch, requester=request.user)
        except WorkbookValidationError as exc:
            return _error(exc)
        except Exception:
            reference = uuid.uuid4().hex[:12]
            LOGGER.exception('Browser-direct quality import prepare failed reference=%s', reference)
            return Response(
                {
                    'code': 'quality_import_prepare_failed',
                    'error': (
                        'The workbook chunk could not be prepared. '
                        f'Retry or contact an administrator with reference {reference}.'
                    ),
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        payload['idempotent_replay'] = replay
        return Response(payload, status=status.HTTP_202_ACCEPTED)


class QualityExcelDirectJobDetailView(APIView):
    permission_classes = [IsAuthenticated, QualityImportPermission]
    parser_classes = [JSONParser]

    @staticmethod
    def _job(pk):
        return get_object_or_404(
            QualityImportBatch.objects.select_related('uploaded_by'),
            pk=pk,
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
        )

    def get(self, request, pk, *args, **kwargs):
        try:
            return Response(serialize_browser_direct_job(
                self._job(pk),
                requester=request.user,
            ))
        except WorkbookValidationError as exc:
            return _error(exc)


class QualityExcelDirectAssetCompleteView(QualityExcelDirectJobDetailView):
    def post(self, request, pk, asset_sha256, *args, **kwargs):
        if re.fullmatch(r'[0-9a-f]{64}', asset_sha256) is None:
            return Response(
                {'code': 'unknown_upload_asset', 'error': 'Invalid image identifier.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Resolve the job first so an invalid or foreign identifier does not
        # disclose Cloudinary receipt validation behavior.
        batch = self._job(pk)
        try:
            batch = complete_browser_direct_asset(
                batch.pk,
                asset_sha256=asset_sha256,
                receipt=request.data,
                requester=request.user,
            )
            payload = serialize_browser_direct_job(batch, requester=request.user)
        except WorkbookValidationError as exc:
            return _error(exc)
        except Exception:
            reference = uuid.uuid4().hex[:12]
            LOGGER.exception(
                'Browser-direct quality image confirmation failed batch=%s reference=%s',
                pk,
                reference,
            )
            return Response(
                {
                    'code': 'quality_import_confirmation_failed',
                    'error': (
                        'The uploaded image could not be confirmed. '
                        f'Retry or contact an administrator with reference {reference}.'
                    ),
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(payload, status=status.HTTP_200_OK)


class QualityExcelDirectFinalizeView(QualityExcelDirectJobDetailView):
    def post(self, request, pk, *args, **kwargs):
        batch = self._job(pk)
        try:
            batch = finalize_browser_direct_job(batch.pk, requester=request.user)
            payload = serialize_browser_direct_job(batch, requester=request.user)
        except WorkbookValidationError as exc:
            return _error(exc)
        except Exception:
            reference = uuid.uuid4().hex[:12]
            LOGGER.exception(
                'Browser-direct quality import finalize failed batch=%s reference=%s',
                pk,
                reference,
            )
            return Response(
                {
                    'code': 'quality_import_finalize_failed',
                    'error': (
                        'The accepted workbook rows could not be registered. '
                        f'Retry or contact an administrator with reference {reference}.'
                    ),
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(payload, status=status.HTTP_200_OK)


class QualityExcelImportJobView(APIView):
    """Accept a bounded incremental chunk and return before Cloudinary work."""

    permission_classes = [IsAuthenticated, QualityImportPermission]
    parser_classes = [MultiPartParser, FormParser]

    def initialize_request(self, request, *args, **kwargs):
        handler = QualityIncrementalTemporaryUploadHandler(request)
        request.upload_handlers = [handler]
        request._quality_incremental_upload_handler = handler
        return super().initialize_request(request, *args, **kwargs)

    def post(self, request, *args, **kwargs):
        handler = getattr(request._request, '_quality_incremental_upload_handler', None)
        raw_manifest = request.data.get('manifest')
        if handler and handler.exceeded:
            return _error(WorkbookValidationError(
                'images_too_large',
                'Uploaded images exceed the aggregate safe limit.',
            ))
        if not isinstance(raw_manifest, str) or not raw_manifest:
            return Response(
                {'code': 'manifest_required', 'error': 'Multipart field "manifest" is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(raw_manifest.encode('utf-8')) > MAX_MANIFEST_BYTES:
            return _error(WorkbookValidationError(
                'manifest_too_large',
                'Workbook manifest exceeds the safe limit.',
            ))
        try:
            manifest = json.loads(raw_manifest)
        except json.JSONDecodeError:
            return Response(
                {'code': 'invalid_manifest', 'error': 'Multipart manifest must be valid JSON.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        raw_row_keys = request.data.get('row_keys')
        try:
            parsed_row_keys = json.loads(raw_row_keys) if raw_row_keys is not None else []
        except (TypeError, json.JSONDecodeError):
            parsed_row_keys = None
        if (
            not isinstance(parsed_row_keys, list)
            or len(parsed_row_keys) > MAX_COMMIT_ROWS
            or any(
                not isinstance(value, str)
                or not re.fullmatch(r'[0-9a-f]{64}', value)
                for value in parsed_row_keys
            )
            or len(set(parsed_row_keys)) != len(parsed_row_keys)
        ):
            return Response(
                {'code': 'invalid_row_selection', 'error': 'row_keys must contain unique workbook row keys.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        uploaded_files = {}
        for field_name, upload in request.FILES.items():
            if not field_name.startswith('media_'):
                return Response(
                    {'code': 'unexpected_media', 'error': 'Unexpected multipart file field.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            media_key = field_name.removeprefix('media_')
            if not media_key or media_key in uploaded_files:
                return Response(
                    {'code': 'unexpected_media', 'error': 'Invalid or duplicate media field.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            uploaded_files[media_key] = upload

        try:
            batch, replay = enqueue_quality_manifest(
                manifest,
                uploaded_files=uploaded_files,
                uploaded_by=request.user,
                uploaded_on=datetime.now(REPORT_TIMEZONE).date(),
                selected_row_keys=set(parsed_row_keys),
            )
        except WorkbookValidationError as exc:
            return _error(exc)
        except Exception:
            reference = uuid.uuid4().hex[:12]
            LOGGER.exception('Quality Excel job intake failed reference=%s', reference)
            return Response(
                {
                    'code': 'quality_import_job_failed',
                    'error': (
                        'The workbook chunk could not be accepted. '
                        f'Retry or contact an administrator with reference {reference}.'
                    ),
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        payload = serialize_quality_import_job(batch)
        payload['idempotent_replay'] = replay
        return Response(payload, status=status.HTTP_202_ACCEPTED)


class QualityExcelImportJobDetailView(APIView):
    permission_classes = [IsAuthenticated, QualityImportPermission]
    parser_classes = [JSONParser]

    @staticmethod
    def _job(pk):
        return get_object_or_404(
            QualityImportBatch,
            pk=pk,
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
        )

    def get(self, request, pk, *args, **kwargs):
        batch = self._job(pk)
        kick_quality_import_pump()
        batch.refresh_from_db()
        return Response(serialize_quality_import_job(batch))


class QualityExcelImportJobRetryView(QualityExcelImportJobDetailView):
    def post(self, request, pk, *args, **kwargs):
        batch = self._job(pk)
        try:
            batch = retry_quality_import_batch(batch)
        except WorkbookValidationError as exc:
            return _error(exc)
        return Response(serialize_quality_import_job(batch), status=status.HTTP_202_ACCEPTED)


class QualityExcelImportCommitView(APIView):
    """Upload only required pictures and register newly classified rows."""

    permission_classes = [IsAuthenticated, QualityImportPermission]
    parser_classes = [MultiPartParser, FormParser]

    def initialize_request(self, request, *args, **kwargs):
        handler = QualityIncrementalTemporaryUploadHandler(request)
        request.upload_handlers = [handler]
        request._quality_incremental_upload_handler = handler
        return super().initialize_request(request, *args, **kwargs)

    def post(self, request, *args, **kwargs):
        handler = getattr(request._request, '_quality_incremental_upload_handler', None)
        raw_manifest = request.data.get('manifest')
        # Multipart parsing is lazy; only now can the upload handler know
        # whether it stopped an oversized request.
        if handler and handler.exceeded:
            return _error(WorkbookValidationError(
                'images_too_large',
                'Uploaded images exceed the aggregate safe limit.',
            ))
        if not isinstance(raw_manifest, str) or not raw_manifest:
            return Response(
                {'code': 'manifest_required', 'error': 'Multipart field "manifest" is required.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(raw_manifest.encode('utf-8')) > MAX_MANIFEST_BYTES:
            return _error(WorkbookValidationError(
                'manifest_too_large',
                'Workbook manifest exceeds the safe limit.',
            ))
        try:
            manifest = json.loads(raw_manifest)
        except json.JSONDecodeError:
            return Response(
                {'code': 'invalid_manifest', 'error': 'Multipart manifest must be valid JSON.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        selected_row_keys = None
        raw_row_keys = request.data.get('row_keys')
        if raw_row_keys is not None:
            try:
                parsed_row_keys = json.loads(raw_row_keys)
            except (TypeError, json.JSONDecodeError):
                parsed_row_keys = None
            if (
                not isinstance(parsed_row_keys, list)
                or len(parsed_row_keys) > MAX_COMMIT_ROWS
                or any(
                    not isinstance(value, str)
                    or not re.fullmatch(r'[0-9a-f]{64}', value)
                    for value in parsed_row_keys
                )
                or len(set(parsed_row_keys)) != len(parsed_row_keys)
            ):
                return Response(
                    {'code': 'invalid_row_selection', 'error': 'row_keys must contain unique workbook row keys.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            selected_row_keys = set(parsed_row_keys)

        uploaded_files = {}
        for field_name, upload in request.FILES.items():
            if not field_name.startswith('media_'):
                return Response(
                    {'code': 'unexpected_media', 'error': 'Unexpected multipart file field.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            media_key = field_name.removeprefix('media_')
            if not media_key or media_key in uploaded_files:
                return Response(
                    {'code': 'unexpected_media', 'error': 'Invalid or duplicate media field.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            uploaded_files[media_key] = upload

        try:
            result = commit_quality_manifest(
                manifest,
                uploaded_files=uploaded_files,
                uploaded_by=request.user,
                uploaded_on=datetime.now(REPORT_TIMEZONE).date(),
                selected_row_keys=selected_row_keys,
            )
        except WorkbookValidationError as exc:
            return _error(exc)
        except Exception:
            reference = uuid.uuid4().hex[:12]
            LOGGER.exception('Quality Excel incremental commit failed reference=%s', reference)
            return Response(
                {
                    'code': 'quality_import_failed',
                    'error': (
                        'The workbook could not be registered. '
                        f'Retry or contact an administrator with reference {reference}.'
                    ),
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(result, status=status.HTTP_200_OK)
