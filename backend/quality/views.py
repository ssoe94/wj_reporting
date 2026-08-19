import logging
from datetime import datetime, time
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import Q
from django.http import FileResponse
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import filters, mixins, status, viewsets
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import JSONParser
from rest_framework.views import APIView
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from .duplicate_detection import (
    find_best_report_duplicate,
    find_best_report_duplicates,
    score_report_duplicate,
)
from .browser_direct_import import DIRECT_DELIVERY_MODE
from .excel_import import _lock_staging_capacity, normalized_row_fingerprint
from .incremental_import import (
    INCREMENTAL_JOB_DATASET_KEY,
    update_incremental_result_after_publish,
)
from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportMedia,
    QualityImportRow,
    QualityReport,
    Supplier,
)
from .permissions import QualityImportPermission, QualityPermission, QualityReadPermission
from .serializers import (
    QualityImportAssetSerializer,
    QualityImportMediaSerializer,
    QualityImportRowSerializer,
    QualityReportSerializer,
    SupplierSerializer,
)
from .cloudinary_utils import get_upload_params
from .daily_attention import build_daily_quality_attention
from ai_core.quality_daily import quality_daily_report_for_page

logger = logging.getLogger(__name__)


BULK_DELETE_MAX_REPORTS = 100
MAX_DATABASE_ID = 9_223_372_036_854_775_807


def _active_incremental_report_delete_jobs():
    """Jobs that could race a user-selected report deletion."""

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


def _result_report_ids(batch: QualityImportBatch) -> set[int]:
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


def _content_archive_path(sha256):
    return f'objects/sha256/{sha256[:2]}/{sha256[2:4]}/{sha256}'


def _require_archive_admin(request):
    try:
        profile_is_admin = bool(request.user.profile.is_admin)
    except Exception:
        profile_is_admin = False
    if not (request.user.is_staff or profile_is_admin):
        raise PermissionDenied('Only an administrator or archive service account may acknowledge a mirror.')


class QualityReportPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 500


class QualityImportPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 200


class QualityReportViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated, QualityPermission]
    queryset = QualityReport.objects.select_related('source_import_row').all()
    serializer_class = QualityReportSerializer
    pagination_class = QualityReportPagination
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['section', 'model', 'part_no']
    search_fields = ['model', 'part_no', 'phenomenon', 'disposition']
    ordering_fields = ['report_dt', 'created_at', 'id']
    ordering = ['-report_dt', '-id']

    @action(
        detail=False,
        methods=['post'],
        url_path='by-ids',
        url_name='by-ids',
        parser_classes=[JSONParser],
        permission_classes=[IsAuthenticated, QualityReadPermission],
    )
    def by_ids(self, request):
        """Return the normal paginated report list scoped by a JSON ID array."""

        if not isinstance(request.data, dict):
            raise ValidationError({'ids': 'Request body must contain an ids array.'})
        report_ids = request.data.get('ids')
        if not isinstance(report_ids, list):
            raise ValidationError({'ids': 'Report IDs must be provided as an array.'})
        if len(report_ids) > 10_000:
            raise ValidationError({'ids': 'At most 10,000 report IDs may be requested.'})
        if any(type(value) is not int for value in report_ids):
            raise ValidationError({'ids': 'Report IDs must be integers.'})
        if any(value <= 0 or value > MAX_DATABASE_ID for value in report_ids):
            raise ValidationError({'ids': 'Report IDs must be valid positive integers.'})
        if len(set(report_ids)) != len(report_ids):
            raise ValidationError({'ids': 'Report IDs must be unique.'})

        queryset = self.filter_queryset(self.get_queryset().filter(pk__in=report_ids))
        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)

    def get_queryset(self):
        queryset = super().get_queryset()
        query_params = self.request.query_params

        ids_filter = query_params.get('ids')
        if ids_filter:
            raw_ids = [value.strip() for value in ids_filter.split(',') if value.strip()]
            if len(raw_ids) > 500:
                raise ValidationError({'ids': 'At most 500 report IDs may be requested.'})
            try:
                report_ids = [int(value) for value in raw_ids]
            except ValueError as exc:
                raise ValidationError({'ids': 'Report IDs must be comma-separated integers.'}) from exc
            if any(value <= 0 for value in report_ids):
                raise ValidationError({'ids': 'Report IDs must be positive integers.'})
            queryset = queryset.filter(pk__in=report_ids)

        date_after = query_params.get('report_dt_after')
        if date_after:
            queryset = queryset.filter(report_dt__date__gte=date_after)

        date_before = query_params.get('report_dt_before')
        if date_before:
            queryset = queryset.filter(report_dt__date__lte=date_before)

        model_filter = query_params.get('model__icontains')
        if model_filter:
            queryset = queryset.filter(model__icontains=model_filter)

        part_contains = query_params.get('part_no__icontains')
        if part_contains:
            queryset = queryset.filter(part_no__icontains=part_contains)

        part_startswith = query_params.get('part_no__istartswith')
        if part_startswith:
            queryset = queryset.filter(part_no__istartswith=part_startswith)

        return queryset

    def perform_create(self, serializer):
        part_no = serializer.validated_data.get('part_no')
        if isinstance(part_no, str):
            serializer.save(part_no=part_no.upper())
        else:
            serializer.save()

    def perform_update(self, serializer):
        # The normal DRF update flow reads the instance before this hook.  Lock
        # and re-fetch it inside the write transaction so a concurrent bulk
        # delete cannot commit between that read and ``Model.save()`` (which
        # could otherwise fall back to an INSERT with the deleted primary key).
        with transaction.atomic():
            try:
                locked_report = (
                    QualityReport.objects
                    .select_for_update(of=('self',))
                    .get(pk=serializer.instance.pk)
                )
            except QualityReport.DoesNotExist as exc:
                raise NotFound('The quality report no longer exists.') from exc

            serializer.instance = locked_report
            part_no = serializer.validated_data.get('part_no')
            if isinstance(part_no, str):
                serializer.save(part_no=part_no.upper())
            else:
                serializer.save()

    @action(
        detail=False,
        methods=['post'],
        url_path='bulk-delete',
        url_name='bulk-delete',
        parser_classes=[JSONParser],
    )
    def bulk_delete(self, request):
        """Atomically delete an exact user-selected set of quality reports.

        Remote image objects are deliberately retained because report image
        URLs can refer to shared, content-addressed assets.  Incremental Excel
        checkpoints that mention a deleted report are invalidated so retrying
        the workbook cannot replay stale report IDs.
        """

        if not isinstance(request.data, dict):
            raise ValidationError({'detail': 'Expected a JSON object.'})
        report_ids = request.data.get('ids')
        if not isinstance(report_ids, list) or not report_ids:
            raise ValidationError({'ids': 'Select at least one report.'})
        if len(report_ids) > BULK_DELETE_MAX_REPORTS:
            raise ValidationError({
                'ids': f'At most {BULK_DELETE_MAX_REPORTS} reports may be deleted at once.',
            })
        if any(
            type(value) is not int or value <= 0 or value > MAX_DATABASE_ID
            for value in report_ids
        ):
            raise ValidationError({'ids': 'Report IDs must be positive integers.'})
        if len(set(report_ids)) != len(report_ids):
            raise ValidationError({'ids': 'Report IDs must be unique.'})
        expected_confirmation = f'DELETE_REPORTS:{len(report_ids)}'
        if request.data.get('confirmation') != expected_confirmation:
            raise ValidationError({'confirmation': 'The deletion confirmation token does not match.'})

        requested_ids = sorted(report_ids)
        with transaction.atomic():
            # Serialize report deletion with new durable Excel intake.  This
            # prevents a job from publishing one of these rows between the
            # active-job check and the report delete.
            _lock_staging_capacity()
            active_job_ids = list(
                _active_incremental_report_delete_jobs()
                .select_for_update()
                .values_list('id', flat=True)
            )
            if active_job_ids:
                return Response(
                    {
                        'code': 'bulk_delete_jobs_active',
                        'error': 'Wait for active Excel jobs to finish before deleting reports.',
                        'active_incremental_jobs': len(active_job_ids),
                    },
                    status=status.HTTP_409_CONFLICT,
                )

            # ``source_import_row`` is nullable.  PostgreSQL rejects FOR
            # UPDATE across that outer join, so lock only QualityReport rows.
            reports = list(
                QualityReport.objects
                .select_for_update(of=('self',))
                .filter(pk__in=requested_ids)
                .order_by('id')
            )
            found_ids = [report.pk for report in reports]
            if found_ids != requested_ids:
                found_id_set = set(found_ids)
                return Response(
                    {
                        'code': 'bulk_delete_scope_changed',
                        'error': 'The selected reports changed. Refresh the list and select them again.',
                        'missing_report_ids': [
                            report_id for report_id in requested_ids
                            if report_id not in found_id_set
                        ],
                    },
                    status=status.HTTP_409_CONFLICT,
                )

            image_reference_count = sum(
                bool(getattr(report, field_name))
                for report in reports
                for field_name in ('image1', 'image2', 'image3', 'image4', 'image5')
            )
            linked_rows = list(
                QualityImportRow.objects.select_for_update().filter(
                    approved_report_id__in=requested_ids,
                )
            )
            linked_row_ids = [row.pk for row in linked_rows]
            linked_batch_ids = set(
                QualityImportRow.objects.filter(
                    pk__in=linked_row_ids,
                    batch__dataset_key=INCREMENTAL_JOB_DATASET_KEY,
                ).values_list('batch_id', flat=True)
            )

            terminal_batches = list(
                QualityImportBatch.objects.select_for_update().filter(
                    dataset_key=INCREMENTAL_JOB_DATASET_KEY,
                    status__in=[
                        QualityImportBatch.Status.READY,
                        QualityImportBatch.Status.READY_WITH_WARNINGS,
                        QualityImportBatch.Status.FAILED,
                    ],
                )
            )
            requested_id_set = set(requested_ids)
            affected_batches = [
                batch for batch in terminal_batches
                if (
                    batch.pk in linked_batch_ids
                    or bool(_result_report_ids(batch).intersection(requested_id_set))
                )
            ]

            QualityReport.objects.filter(pk__in=requested_ids).delete()
            if linked_row_ids:
                QualityImportRow.objects.filter(pk__in=linked_row_ids).update(
                    review_status=QualityImportRow.ReviewStatus.DRAFT,
                    reviewed_by=None,
                    reviewed_at=None,
                    reviewed_content_sha256='',
                    published_at=None,
                    updated_at=timezone.now(),
                )

            for batch in affected_batches:
                summary = dict(batch.delta_summary or {})
                summary['incremental_result'] = None
                batch.delta_summary = summary
                batch.status = QualityImportBatch.Status.FAILED
                batch.phase = 'reports_deleted'
                batch.processing_owner = ''
                batch.lease_expires_at = None
                batch.next_attempt_at = None
                batch.last_heartbeat_at = None
                batch.results_persisted_at = None
                batch.save(update_fields=[
                    'delta_summary', 'status', 'phase', 'processing_owner',
                    'lease_expires_at', 'next_attempt_at', 'last_heartbeat_at',
                    'results_persisted_at', 'updated_at',
                ])

        logger.warning(
            'Quality report bulk delete user=%s report_ids=%s reset_incremental_jobs=%s',
            request.user.pk,
            requested_ids,
            len(affected_batches),
        )
        return Response({
            'deleted_count': len(requested_ids),
            'deleted_report_ids': requested_ids,
            'deleted_image_references': image_reference_count,
            'reset_incremental_jobs': len(affected_batches),
            'remote_image_cleanup': (
                'not_required' if image_reference_count == 0 else 'deferred'
            ),
        })


class DailyQualityAttentionView(APIView):
    permission_classes = [IsAuthenticated, QualityPermission]

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        target_date = (
            parse_date(date_str)
            if date_str
            else timezone.now().astimezone(ZoneInfo('Asia/Shanghai')).date()
        )
        if not target_date:
            return Response({'error': 'Invalid date format. Use YYYY-MM-DD.'}, status=status.HTTP_400_BAD_REQUEST)

        payload = build_daily_quality_attention(target_date)
        report_metrics = payload.pop('report_metrics', {})
        payload['report'] = quality_daily_report_for_page(
            target_date,
            deterministic_report=report_metrics,
            source_plan_hash=payload.get('source_plan_hash'),
            source_plan_last_changed_at=payload.get('source_plan_last_changed_at'),
            source_evidence_hash=payload.get('source_evidence_hash'),
            source_evidence_last_changed_at=payload.get(
                'source_evidence_last_changed_at'
            ),
        )
        # Fingerprints are internal scheduler/ready-gate details.  The daily
        # page receives only the opaque report.source_revision; job scope and
        # input retain the exact hashes for authoritative matching.
        payload.pop('source_plan_hash', None)
        payload.pop('source_evidence_hash', None)
        return Response(payload)


class SupplierViewSet(viewsets.ModelViewSet):
    """공급자 관리 ViewSet"""
    permission_classes = [IsAuthenticated, QualityPermission]
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name']
    ordering = ['name']

    @action(detail=False, methods=['post'])
    def get_or_create(self, request):
        """공급자 이름으로 조회하거나 없으면 생성"""
        name = request.data.get('name', '').strip()
        if not name:
            return Response({'error': 'Name is required'}, status=400)
        
        supplier, created = Supplier.objects.get_or_create(name=name)
        serializer = self.get_serializer(supplier)
        return Response({
            'supplier': serializer.data,
            'created': created
        })


class QualityImportRowViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated, QualityImportPermission]
    serializer_class = QualityImportRowSerializer
    pagination_class = QualityImportPagination
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        queryset = QualityImportRow.objects.select_related(
            'batch', 'duplicate_of', 'reviewed_by', 'approved_report',
        ).prefetch_related('media__asset').filter(
            batch__status__in=[
                QualityImportBatch.Status.READY,
                QualityImportBatch.Status.READY_WITH_WARNINGS,
            ]
        )
        batch_id = self.request.query_params.get('batch')
        review_status = self.request.query_params.get('review_status')
        delta_status = self.request.query_params.get('delta_status')
        sheet_name = self.request.query_params.get('sheet_name')
        if batch_id:
            queryset = queryset.filter(batch_id=batch_id)
        if review_status:
            queryset = queryset.filter(review_status=review_status)
        if delta_status:
            allowed = {value for value, _label in QualityImportRow.DeltaStatus.choices}
            if delta_status not in allowed:
                raise ValidationError({'delta_status': 'Expected added, changed, or unchanged.'})
            queryset = queryset.filter(delta_status=delta_status)
        if sheet_name:
            queryset = queryset.filter(sheet_name=sheet_name)
        return queryset

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        rows = list(page) if page is not None else list(queryset)
        context = self.get_serializer_context()
        context['duplicate_matches'] = find_best_report_duplicates(rows)
        serializer = self.get_serializer(rows, many=True, context=context)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    def perform_update(self, serializer):
        # DRF validates before calling ``perform_update``. Re-lock and reload
        # the row so a publish that committed after that validation cannot be
        # overwritten by a PATCH built from the earlier draft snapshot.
        with transaction.atomic():
            instance = QualityImportRow.objects.select_for_update().get(
                pk=serializer.instance.pk,
            )
            if (
                instance.approved_report_id
                or instance.review_status == QualityImportRow.ReviewStatus.PUBLISHED
            ):
                raise ValidationError('Published import rows are immutable.')
            serializer.instance = instance

            review_status = serializer.validated_data.get('review_status')
            normalized_fields = {
                'report_date', 'section', 'occurrence_location', 'model', 'part_no',
                'item_name', 'lot_qty', 'inspection_qty', 'defect_qty', 'defect_rate',
                'judgement', 'phenomenon', 'disposition', 'action_result',
            }
            changed_normalized = bool(normalized_fields.intersection(serializer.validated_data))
            if review_status in {
                QualityImportRow.ReviewStatus.REVIEWED,
                QualityImportRow.ReviewStatus.REJECTED,
            }:
                instance = serializer.save(reviewed_by=self.request.user, reviewed_at=timezone.now())
                instance.reviewed_content_sha256 = (
                    normalized_row_fingerprint(instance)
                    if review_status == QualityImportRow.ReviewStatus.REVIEWED
                    else ''
                )
                instance.save(update_fields=['reviewed_content_sha256', 'updated_at'])
            elif review_status == QualityImportRow.ReviewStatus.DRAFT:
                serializer.save(
                    reviewed_by=None,
                    reviewed_at=None,
                    reviewed_content_sha256='',
                )
            elif changed_normalized:
                serializer.save(
                    review_status=QualityImportRow.ReviewStatus.DRAFT,
                    reviewed_by=None,
                    reviewed_at=None,
                    reviewed_content_sha256='',
                )
            else:
                serializer.save()

    @action(detail=True, methods=['post'])
    def publish(self, request, pk=None):
        """Idempotently publish one reviewed draft into legacy QualityReport."""

        seed_id = self.get_object().pk
        with transaction.atomic():
            seed = QualityImportRow.objects.only(
                'id', 'batch_id', 'business_key', 'reviewed_content_sha256',
            ).get(pk=seed_id)
            related_filter = Q(business_key=seed.business_key)
            if seed.reviewed_content_sha256:
                related_filter |= Q(reviewed_content_sha256=seed.reviewed_content_sha256)
            # ``approved_report`` is nullable.  Joining it in a locking query
            # makes PostgreSQL reject ``FOR UPDATE`` on the outer-joined side.
            related_rows = list(
                QualityImportRow.objects.select_for_update()
                .filter(related_filter)
                .order_by('id')
            )
            row = next(item for item in related_rows if item.pk == seed.pk)
            if row.approved_report_id:
                update_incremental_result_after_publish(row, row.approved_report)
                payload = self.get_serializer(row).data
                payload['idempotent_replay'] = True
                return Response(payload, status=status.HTTP_200_OK)

            if row.review_status != QualityImportRow.ReviewStatus.REVIEWED:
                return Response(
                    {'code': 'row_not_reviewed', 'error': 'Review the draft before publishing it.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            expected_review = request.data.get('expected_reviewed_content_sha256')
            if expected_review is not None:
                if not isinstance(expected_review, str) or not expected_review:
                    return Response(
                        {
                            'code': 'invalid_review_version',
                            'error': 'A valid reviewed content version is required.',
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if expected_review != row.reviewed_content_sha256:
                    return Response(
                        {
                            'code': 'review_version_changed',
                            'error': 'This row was edited again after your review. Reload and confirm the latest values.',
                        },
                        status=status.HTTP_409_CONFLICT,
                    )
            if row.reviewed_content_sha256 != normalized_row_fingerprint(row):
                return Response(
                    {
                        'code': 'review_is_stale',
                        'error': 'Normalized fields changed after review; review the row again.',
                    },
                    status=status.HTTP_409_CONFLICT,
                )

            revision_source = None
            if row.delta_status == QualityImportRow.DeltaStatus.CHANGED:
                revision_source = next(
                    (
                        item for item in reversed(related_rows)
                        if item.pk != row.pk
                        and item.business_key == row.business_key
                        and item.approved_report_id
                    ),
                    None,
                )
            published_duplicate = next(
                (
                    item for item in related_rows
                    if item.pk != row.pk
                    and (revision_source is None or item.pk != revision_source.pk)
                    and item.batch_id != row.batch_id
                    and item.approved_report_id
                    and (
                        item.business_key == row.business_key
                        or (
                            row.reviewed_content_sha256
                            and item.reviewed_content_sha256 == row.reviewed_content_sha256
                        )
                    )
                ),
                None,
            )
            if published_duplicate:
                confirmed = request.data.get('confirm_duplicate') is True
                reason = str(request.data.get('duplicate_reason', '')).strip()[:255]
                duplicate_kind = (
                    'same_source_revision'
                    if published_duplicate.business_key == row.business_key
                    else 'same_normalized_content'
                )
                if not confirmed:
                    return Response(
                        {
                            'code': 'possible_duplicate_already_published',
                            'error': 'A possible cross-workbook duplicate has already been published.',
                            'duplicate_kind': duplicate_kind,
                            'original_import_row': published_duplicate.pk,
                            'approved_report': published_duplicate.approved_report_id,
                            'confirmation_required': True,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )
                if len(reason) < 3:
                    return Response(
                        {
                            'code': 'duplicate_reason_required',
                            'error': 'duplicate_reason (3-255 characters) is required for an override.',
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                row.duplicate_override_by = request.user
                row.duplicate_override_at = timezone.now()
                row.duplicate_override_reason = reason

            validation_errors = []
            if not row.report_date:
                validation_errors.append('report_date is required')
            elif row.report_date > timezone.now().astimezone(ZoneInfo('Asia/Shanghai')).date():
                validation_errors.append('report_date cannot be in the future')
            if not row.section:
                validation_errors.append('section is required')
            if not (row.model or row.part_no):
                validation_errors.append('model or part_no is required')
            if not row.phenomenon:
                validation_errors.append('phenomenon is required')
            if len(row.model) > 64:
                validation_errors.append('model exceeds QualityReport limit (64)')
            if len(row.part_no) > 64:
                validation_errors.append('part_no exceeds QualityReport limit (64)')
            if len(row.defect_rate) > 16:
                validation_errors.append('defect_rate exceeds QualityReport limit (16)')
            if len(row.judgement or 'NG') > 8:
                validation_errors.append('judgement exceeds QualityReport limit (8)')
            if validation_errors:
                return Response(
                    {'code': 'publish_validation_failed', 'errors': validation_errors},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            duplicate_action = str(request.data.get('duplicate_action', '')).strip()
            duplicate_report = None
            manual_candidate = None
            if not revision_source and not published_duplicate:
                manual_candidate = find_best_report_duplicate(row)
            if manual_candidate:
                requested_report_id = request.data.get('duplicate_report_id')
                requested_report_version = str(
                    request.data.get('duplicate_report_version', '')
                ).strip()
                try:
                    requested_report_id = int(requested_report_id) if requested_report_id else None
                except (TypeError, ValueError):
                    requested_report_id = None
                allowed_actions = manual_candidate['allowed_actions']
                if not duplicate_action:
                    return Response(
                        {
                            'code': 'possible_existing_report_duplicate',
                            'error': 'A semantically similar quality report already exists.',
                            'candidate': manual_candidate,
                            'allowed_actions': allowed_actions,
                            'confirmation_required': True,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )
                if (
                    requested_report_id != manual_candidate['report_id']
                    or requested_report_version != manual_candidate['version']
                    or duplicate_action not in allowed_actions
                ):
                    return Response(
                        {
                            'code': 'duplicate_candidate_changed',
                            'error': 'The duplicate candidate changed; review it again.',
                            'candidate': manual_candidate,
                            'allowed_actions': allowed_actions,
                        },
                        status=status.HTTP_409_CONFLICT,
                    )
                reason = str(request.data.get('duplicate_reason', '')).strip()[:255]
                if len(reason) < 3:
                    return Response(
                        {
                            'code': 'duplicate_reason_required',
                            'error': 'duplicate_reason (3-255 characters) is required.',
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                row.duplicate_override_by = request.user
                row.duplicate_override_at = timezone.now()
                row.duplicate_override_reason = (
                    f'{duplicate_action}:report:{requested_report_id}:{reason}'
                )[:255]
                if duplicate_action in {'link_existing', 'update_existing'}:
                    try:
                        duplicate_report = QualityReport.objects.select_for_update().get(
                            pk=requested_report_id,
                        )
                    except QualityReport.DoesNotExist:
                        return Response(
                            {
                                'code': 'duplicate_candidate_changed',
                                'error': 'The existing report is no longer available.',
                            },
                            status=status.HTTP_409_CONFLICT,
                        )
                    locked_candidate = score_report_duplicate(row, duplicate_report)
                    if (
                        not locked_candidate
                        or locked_candidate['source_kind'] != 'manual'
                        or locked_candidate['version'] != requested_report_version
                        or duplicate_action not in locked_candidate['allowed_actions']
                    ):
                        return Response(
                            {
                                'code': 'duplicate_candidate_changed',
                                'error': 'The existing report changed; review it again.',
                                'candidate': locked_candidate,
                                'allowed_actions': (
                                    locked_candidate['allowed_actions']
                                    if locked_candidate
                                    else []
                                ),
                            },
                            status=status.HTTP_409_CONFLICT,
                        )
                    try:
                        existing_source_row = duplicate_report.source_import_row
                    except QualityImportRow.DoesNotExist:
                        existing_source_row = None
                    if existing_source_row is not None:
                        return Response(
                            {
                                'code': 'duplicate_candidate_changed',
                                'error': 'The existing report is already linked to another import row.',
                            },
                            status=status.HTTP_409_CONFLICT,
                        )
            elif duplicate_action and not revision_source and not published_duplicate:
                return Response(
                    {
                        'code': 'duplicate_candidate_changed',
                        'error': 'The duplicate candidate is no longer available; review the row again.',
                    },
                    status=status.HTTP_409_CONFLICT,
                )

            image_urls = []
            for media in row.media.select_related('asset').order_by('source_index', 'id')[:5]:
                try:
                    if media.asset_id and media.asset.file:
                        image_urls.append(media.asset.file.url)
                except Exception:
                    logger.warning('Media URL unavailable while publishing import row %s', row.pk)

            report_dt = datetime.combine(row.report_date, time(hour=8), tzinfo=ZoneInfo('Asia/Shanghai'))
            report_values = {
                'report_dt': report_dt,
                'section': row.section,
                'model': row.model,
                'part_no': row.part_no,
                'lot_qty': row.lot_qty,
                'inspection_qty': row.inspection_qty,
                'defect_qty': row.defect_qty,
                'defect_rate': row.defect_rate,
                'judgement': row.judgement or 'NG',
                'phenomenon': row.phenomenon,
                'disposition': row.disposition,
                'action_result': row.action_result,
                'image1': image_urls[0] if len(image_urls) > 0 else None,
                'image2': image_urls[1] if len(image_urls) > 1 else None,
                'image3': image_urls[2] if len(image_urls) > 2 else None,
                'image4': image_urls[3] if len(image_urls) > 3 else None,
                'image5': image_urls[4] if len(image_urls) > 4 else None,
            }
            updated_existing_report = bool(revision_source or duplicate_action == 'update_existing')
            linked_existing_report = bool(duplicate_action == 'link_existing')
            if revision_source:
                report = QualityReport.objects.select_for_update().get(
                    pk=revision_source.approved_report_id,
                )
                revision_source.approved_report = None
                revision_source.save(update_fields=['approved_report', 'updated_at'])
                for field, value in report_values.items():
                    setattr(report, field, value)
                report.save(update_fields=[*report_values.keys(), 'updated_at'])
            elif duplicate_report is not None:
                report = duplicate_report
                if duplicate_action == 'update_existing':
                    update_values = {
                        field: value
                        for field, value in report_values.items()
                        if field != 'report_dt' and value not in (None, '')
                    }
                    if not row.judgement:
                        update_values.pop('judgement', None)
                    # Only supplied Excel evidence replaces a matching slot;
                    # omitted slots and fields keep richer manually entered
                    # evidence.  The manual timestamp is preserved because the
                    # workbook carries a date, not an occurrence time.
                    for index, field in enumerate(('image1', 'image2', 'image3', 'image4', 'image5')):
                        if index >= len(image_urls):
                            update_values.pop(field, None)
                    for field, value in update_values.items():
                        setattr(report, field, value)
                    report.save(update_fields=[*update_values.keys(), 'updated_at'])
            else:
                report = QualityReport.objects.create(**report_values)
            now = timezone.now()
            row.approved_report = report
            row.review_status = QualityImportRow.ReviewStatus.PUBLISHED
            row.reviewed_by = request.user
            row.reviewed_at = now
            row.published_at = now
            row.save(
                update_fields=[
                    'approved_report', 'review_status', 'reviewed_by',
                    'reviewed_at', 'published_at', 'duplicate_override_by',
                    'duplicate_override_at', 'duplicate_override_reason', 'updated_at',
                ]
            )
            update_incremental_result_after_publish(row, report)

        payload = self.get_serializer(row).data
        payload['idempotent_replay'] = False
        payload['updated_existing_report'] = updated_existing_report
        payload['linked_existing_report'] = linked_existing_report
        return Response(
            payload,
            status=(
                status.HTTP_200_OK
                if updated_existing_report or linked_existing_report
                else status.HTTP_201_CREATED
            ),
        )


class QualityImportMediaViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated, QualityImportPermission]
    queryset = QualityImportMedia.objects.select_related('batch', 'row', 'asset')
    serializer_class = QualityImportMediaSerializer
    pagination_class = QualityImportPagination
    http_method_names = ['get', 'head', 'options']

    def get_queryset(self):
        queryset = super().get_queryset().filter(
            batch__status__in=[
                QualityImportBatch.Status.READY,
                QualityImportBatch.Status.READY_WITH_WARNINGS,
            ]
        )
        batch_id = self.request.query_params.get('batch')
        mirror_state = self.request.query_params.get('mirror_state')
        if batch_id:
            queryset = queryset.filter(batch_id=batch_id)
        if mirror_state:
            queryset = queryset.filter(asset__mirror_state=mirror_state)
        return queryset

    @action(detail=True, methods=['get'], url_path='content', url_name='content')
    def content(self, request, pk=None):
        media = self.get_object()
        if not media.asset_id or not media.asset.file or not media.asset.file.name:
            return Response(
                {'code': 'media_not_ready', 'error': 'Media file is not available.'},
                status=status.HTTP_409_CONFLICT,
            )
        try:
            file_handle = media.asset.file.open('rb')
        except Exception:
            logger.exception('Quality import media could not be opened: %s', media.pk)
            return Response(
                {'code': 'media_unavailable', 'error': 'Media file is temporarily unavailable.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        response = FileResponse(
            file_handle,
            as_attachment=False,
            filename=media.original_filename,
            content_type=media.asset.content_type,
        )
        response['Cache-Control'] = 'private, max-age=3600'
        response['X-Content-Type-Options'] = 'nosniff'
        return response

class QualityImportAssetViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated, QualityImportPermission]
    serializer_class = QualityImportAssetSerializer
    pagination_class = QualityImportPagination
    http_method_names = ['get', 'post', 'head', 'options']

    def get_queryset(self):
        queryset = QualityImportAsset.objects.filter(
            attachments__batch__status__in=[
                QualityImportBatch.Status.READY,
                QualityImportBatch.Status.READY_WITH_WARNINGS,
            ]
        ).distinct().order_by('id')
        mirror_state = self.request.query_params.get('mirror_state')
        if mirror_state:
            queryset = queryset.filter(mirror_state=mirror_state)
        return queryset

    @action(detail=True, methods=['get'], url_path='content', url_name='content')
    def content(self, request, pk=None):
        asset = self.get_object()
        try:
            file_handle = asset.file.open('rb')
        except Exception:
            logger.exception('Quality import asset could not be opened: %s', asset.pk)
            return Response({'code': 'media_unavailable', 'error': 'Media is temporarily unavailable.'}, status=503)
        response = FileResponse(
            file_handle,
            as_attachment=False,
            filename=f'{asset.sha256}.{asset.extension or "bin"}',
            content_type=asset.content_type,
        )
        response['Cache-Control'] = 'private, max-age=3600'
        response['X-Content-Type-Options'] = 'nosniff'
        return response

    @action(detail=True, methods=['post'], url_path='mark-mirrored')
    def mark_mirrored(self, request, pk=None):
        _require_archive_admin(request)
        asset = self.get_object()
        supplied_sha = str(request.data.get('sha256', '')).strip().lower()
        relative_path = str(request.data.get('archive_relative_path', '')).strip().replace('\\', '/')
        if supplied_sha != asset.sha256:
            return Response({'code': 'checksum_mismatch', 'error': 'Archived media checksum does not match.'}, status=400)
        if relative_path != _content_archive_path(asset.sha256):
            return Response({'code': 'invalid_archive_path', 'error': 'A safe relative path is required.'}, status=400)
        with transaction.atomic():
            asset = QualityImportAsset.objects.select_for_update().get(pk=asset.pk)
            asset.archive_relative_path = relative_path
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


@csrf_exempt
@api_view(['POST'])
@permission_classes([IsAuthenticated, QualityPermission])
def get_cloudinary_signature(request):
    """
    Cloudinary 업로드를 위한 서명 생성

    POST /api/quality/cloudinary-signature/
    Body: { "folder": "quality" }  (optional, default: "quality")

    Returns:
        {
            "signature": "...",
            "timestamp": 1234567890,
            "upload_preset": "wj-reporting",
            "api_key": "...",
            "cloud_name": "deoic09y3"
        }

    Note:
    - Signed preset 사용 시 timestamp만 서명
    - folder는 프론트에서 직접 전송 (서명에 미포함)
    """
    try:
        folder = request.data.get('folder', 'quality')
        logger.info(f"Cloudinary signature request for folder: {folder}")
        upload_params = get_upload_params(folder=folder)
        logger.info(f"Cloudinary signature generated successfully")
        return Response(upload_params, status=status.HTTP_200_OK)
    except ValueError as e:
        logger.error(f"Cloudinary configuration error: {str(e)}")
        return Response(
            {'error': str(e), 'detail': 'Cloudinary 환경 변수가 설정되지 않았습니다. 관리자에게 문의하세요.'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
    except Exception as e:
        logger.error(f"Cloudinary signature error: {str(e)}", exc_info=True)
        return Response(
            {'error': str(e), 'detail': '서명 생성 중 오류가 발생했습니다.'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
