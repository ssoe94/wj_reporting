from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from django.db.models import Avg
from .models import InjectionReport, Product, PartSpec
from .serializers import InjectionReportSerializer, ProductSerializer, PartSpecSerializer
import csv
import io
from django.http import HttpResponse

class InjectionReportViewSet(viewsets.ModelViewSet):
    queryset = InjectionReport.objects.all()
    serializer_class = InjectionReportSerializer
    filterset_fields = ['date', 'tonnage', 'model', 'section']
    ordering_fields = ['date', 'tonnage', 'model', 'achievement_rate', 'defect_rate']
    search_fields = ['tonnage', 'model', 'note']

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """전체 통계 정보를 제공하는 엔드포인트"""
        today_reports = self.get_queryset().filter(date=request.query_params.get('date'))
        
        summary_data = {
            'total_count': today_reports.count(),
            'total_plan_qty': sum(report.plan_qty for report in today_reports),
            'total_actual_qty': sum(report.actual_qty for report in today_reports),
            'total_defect_qty': sum(report.actual_defect for report in today_reports),
            'average_achievement_rate': today_reports.aggregate(Avg('actual_qty'))['actual_qty__avg'],
            'average_defect_rate': today_reports.aggregate(Avg('actual_defect'))['actual_defect__avg'],
        }
        
        return Response(summary_data)

    @action(detail=False, methods=['get'])
    def export(self, request):
        """생산 기록 전체를 CSV 파일로 다운로드하도록 반환"""
        queryset = self.filter_queryset(self.get_queryset())

        buffer = io.StringIO()
        writer = csv.writer(buffer)

        # 헤더 작성
        writer.writerow([
            'ID', 'Date', 'Machine No', 'Tonnage', 'Model', 'Type', 'Plan Qty', 'Actual Qty',
            'Reported Defect', 'Real Defect', 'Start', 'End', 'Total Time', 'Operation Time', 'Note'
        ])

        for r in queryset:
            writer.writerow([
                r.id,
                r.date,
                r.machine_no,
                r.tonnage,
                r.model,
                r.section,
                r.plan_qty,
                r.actual_qty,
                r.reported_defect,
                r.actual_defect,
                r.start_datetime,
                r.end_datetime,
                r.total_time,
                r.operation_time,
                r.note,
            ])

        response = HttpResponse(buffer.getvalue(), content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="reports.csv"'
        return response

class ProductViewSet(viewsets.ReadOnlyModelViewSet):
    """제품 마스터 검색용 뷰셋 (읽기 전용)"""
    queryset = Product.objects.all()
    serializer_class = ProductSerializer
    filterset_fields = ['type']
    search_fields = ['model', 'fg_part_no', 'wip_part_no']
    ordering = ['model']

class PartSpecViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = PartSpec.objects.all()
    serializer_class = PartSpecSerializer
    filterset_fields = ['model_code', 'part_no']
    search_fields = ['part_no', 'description', 'model_code']
    ordering = ['part_no'] 