from rest_framework import viewsets, filters, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
from .models import QualityReport, Supplier
from .serializers import QualityReportSerializer, SupplierSerializer
from .cloudinary_utils import get_upload_params
import logging

logger = logging.getLogger(__name__)


class QualityReportViewSet(viewsets.ModelViewSet):
    queryset = QualityReport.objects.all()
    serializer_class = QualityReportSerializer
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['section', 'model', 'part_no']
    search_fields = ['model', 'part_no', 'phenomenon', 'disposition']
    ordering_fields = ['report_dt', 'created_at']
    ordering = ['-report_dt']

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
