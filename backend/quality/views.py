from collections import Counter, defaultdict
import logging
import re

from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import viewsets, filters, status
from rest_framework.pagination import PageNumberPagination
from rest_framework.views import APIView
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from .models import QualityReport, Supplier
from .serializers import QualityReportSerializer, SupplierSerializer
from .cloudinary_utils import get_upload_params
from production.models import ProductionPlan

logger = logging.getLogger(__name__)


class QualityReportPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = 'page_size'
    max_page_size = 200


class QualityReportViewSet(viewsets.ModelViewSet):
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
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _normalize_part_no(part_no: str | None) -> str:
        return re.sub(r'\s+', '', (part_no or '').upper())

    @classmethod
    def _part_prefix(cls, part_no: str | None) -> str:
        return cls._normalize_part_no(part_no)[:9]

    @staticmethod
    def _extract_machine_number(machine_name: str | None) -> int | None:
        if not machine_name:
            return None
        match = re.search(r'(\d+)\s*호기', machine_name)
        if match:
            return int(match.group(1))
        match = re.search(r'-(\d+)\s*$', machine_name)
        if match:
            return int(match.group(1))
        return None

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        target_date = parse_date(date_str) if date_str else timezone.localdate()
        if not target_date:
            return Response({'error': 'Invalid date format. Use YYYY-MM-DD.'}, status=status.HTTP_400_BAD_REQUEST)

        plan_rows = list(
            ProductionPlan.objects.filter(
                plan_date=target_date,
                plan_type='injection',
                planned_quantity__gt=0,
            )
            .order_by('machine_name', 'sequence', 'id')
            .values('machine_name', 'model_name', 'part_no', 'planned_quantity', 'sequence', 'lot_no')
        )

        prefixes = sorted({
            prefix
            for prefix in (self._part_prefix(row.get('part_no')) for row in plan_rows)
            if prefix
        })

        report_groups: dict[str, list[QualityReport]] = defaultdict(list)
        if prefixes:
            report_filter = Q()
            for prefix in prefixes:
                report_filter |= Q(part_no__istartswith=prefix)

            reports = (
                QualityReport.objects.filter(report_filter)
                .exclude(part_no='')
                .order_by('-report_dt', '-id')
            )

            for report in reports:
                prefix = self._part_prefix(report.part_no)
                if prefix:
                    report_groups[prefix].append(report)

        items = []
        without_history = 0
        total_matching_reports = 0

        for row in plan_rows:
            part_no = self._normalize_part_no(row.get('part_no'))
            prefix = self._part_prefix(part_no)
            matched_reports = report_groups.get(prefix, [])
            top_phenomena = Counter(
                (report.phenomenon or '').strip()
                for report in matched_reports
                if (report.phenomenon or '').strip()
            ).most_common(3)

            reports_data = [
                {
                    'id': report.id,
                    'report_dt': report.report_dt.isoformat(),
                    'section': report.section,
                    'part_no': report.part_no,
                    'judgement': report.judgement,
                    'defect_rate': report.defect_rate,
                    'phenomenon': report.phenomenon or '',
                    'disposition': report.disposition or '',
                    'action_result': report.action_result or '',
                    'images': [img for img in [report.image1, report.image2, report.image3] if img],
                }
                for report in matched_reports[:6]
            ]

            if not matched_reports:
                without_history += 1
            total_matching_reports += len(matched_reports)

            items.append({
                'machine_name': row.get('machine_name') or '',
                'machine_number': self._extract_machine_number(row.get('machine_name')),
                'sequence': row.get('sequence'),
                'model_name': row.get('model_name') or '',
                'part_no': part_no,
                'part_prefix': prefix,
                'lot_no': row.get('lot_no') or '',
                'planned_quantity': int(round(row.get('planned_quantity') or 0)),
                'matching_report_count': len(matched_reports),
                'latest_report_dt': reports_data[0]['report_dt'] if reports_data else None,
                'top_phenomena': [
                    {'phenomenon': phenomenon, 'count': count}
                    for phenomenon, count in top_phenomena
                ],
                'reports': reports_data,
            })

        return Response({
            'date': target_date.isoformat(),
            'total_plan_count': len(items),
            'total_matching_reports': total_matching_reports,
            'without_history_count': without_history,
            'items': items,
        })


class SupplierViewSet(viewsets.ModelViewSet):
    """공급자 관리 ViewSet"""
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


@csrf_exempt
@api_view(['POST'])
@permission_classes([IsAuthenticated])
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
