from __future__ import annotations

import logging
import json
import re
import uuid
from datetime import datetime

from django.core.files.uploadhandler import StopUpload, TemporaryFileUploadHandler
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .direct_import import import_quality_workbook_direct, safe_workbook_filename
from .duplicate_detection import find_best_report_duplicates
from .excel_import import (
    MAX_UPLOAD_BYTES,
    WorkbookValidationError,
    ingest_quality_workbook,
    kick_quality_import_pump,
    parse_import_scope,
    retry_quality_import_batch,
)
from .models import QualityImportBatch, QualityImportRow
from .incremental_import import (
    MAX_COMMIT_MEDIA_BYTES,
    MAX_COMMIT_ROWS,
    MAX_MANIFEST_BYTES,
    commit_quality_manifest,
    preview_quality_manifest,
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
    elif exc.code in {'production_storage_required', 'staging_capacity_exceeded'}:
        response_status = status.HTTP_503_SERVICE_UNAVAILABLE
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
