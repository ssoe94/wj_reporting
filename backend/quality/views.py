from rest_framework import viewsets, filters
from django_filters.rest_framework import DjangoFilterBackend
from .models import QualityReport
from .serializers import QualityReportSerializer


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

# Create your views here.
