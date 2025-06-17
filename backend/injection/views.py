from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from django.db.models import Avg
from .models import InjectionReport
from .serializers import InjectionReportSerializer

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