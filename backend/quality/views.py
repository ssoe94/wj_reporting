from rest_framework import viewsets, filters
from rest_framework.decorators import action
from rest_framework.response import Response
from django_filters.rest_framework import DjangoFilterBackend
from .models import QualityReport, Supplier
from .serializers import QualityReportSerializer, SupplierSerializer


class QualityReportViewSet(viewsets.ModelViewSet):
    queryset = QualityReport.objects.all()
    serializer_class = QualityReportSerializer
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['section', 'model', 'part_no']
    search_fields = ['model', 'part_no', 'phenomenon', 'disposition']
    ordering_fields = ['report_dt', 'created_at']
    ordering = ['-report_dt']

    def perform_create(self, serializer):
        part_no = self.request.data.get('part_no')
        if isinstance(part_no, str):
            self.request.data._mutable = True if hasattr(self.request.data, '_mutable') else False
            self.request.data['part_no'] = part_no.upper()
        serializer.save()

    def perform_update(self, serializer):
        part_no = self.request.data.get('part_no')
        if isinstance(part_no, str):
            self.request.data._mutable = True if hasattr(self.request.data, '_mutable') else False
            self.request.data['part_no'] = part_no.upper()
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
