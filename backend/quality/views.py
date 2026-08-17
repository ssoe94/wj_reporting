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
from rest_framework.views import APIView
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from .excel_import import normalized_row_fingerprint
from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportMedia,
    QualityImportRow,
    QualityReport,
    Supplier,
)
from .permissions import QualityImportPermission, QualityPermission
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
    max_page_size = 200


class QualityImportPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 200


class QualityReportViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated, QualityPermission]
    queryset = QualityReport.objects.all()
    serializer_class = QualityReportSerializer
    pagination_class = QualityReportPagination
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['section', 'model', 'part_no']
    search_fields = ['model', 'part_no', 'phenomenon', 'disposition']
    ordering_fields = ['report_dt', 'created_at']
    ordering = ['-report_dt']

    def get_queryset(self):
        queryset = super().get_queryset()
        query_params = self.request.query_params

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
        part_no = serializer.validated_data.get('part_no')
        if isinstance(part_no, str):
            serializer.save(part_no=part_no.upper())
        else:
            serializer.save()


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
            related_rows = list(
                QualityImportRow.objects.select_for_update().select_related(
                    'approved_report',
                ).filter(related_filter).order_by('id')
            )
            row = next(item for item in related_rows if item.pk == seed.pk)
            if row.approved_report_id:
                payload = self.get_serializer(row).data
                payload['idempotent_replay'] = True
                return Response(payload, status=status.HTTP_200_OK)

            if row.review_status != QualityImportRow.ReviewStatus.REVIEWED:
                return Response(
                    {'code': 'row_not_reviewed', 'error': 'Review the draft before publishing it.'},
                    status=status.HTTP_400_BAD_REQUEST,
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

            image_urls = []
            for media in row.media.select_related('asset').order_by('source_index', 'id')[:3]:
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
            }
            updated_existing_report = bool(revision_source)
            if revision_source:
                report = QualityReport.objects.select_for_update().get(
                    pk=revision_source.approved_report_id,
                )
                revision_source.approved_report = None
                revision_source.save(update_fields=['approved_report', 'updated_at'])
                for field, value in report_values.items():
                    setattr(report, field, value)
                report.save(update_fields=[*report_values.keys(), 'updated_at'])
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

        payload = self.get_serializer(row).data
        payload['idempotent_replay'] = False
        payload['updated_existing_report'] = updated_existing_report
        return Response(
            payload,
            status=status.HTTP_200_OK if updated_existing_report else status.HTTP_201_CREATED,
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
