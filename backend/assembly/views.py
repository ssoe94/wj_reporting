from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import AssemblyReport, AssemblyPartSpec, AssemblyProduct
from .serializers import (
    AssemblyReportSerializer,
    AssemblyPartSpecSerializer, 
    AssemblyProductSerializer,
)
from injection.permissions import MachiningPermission
import csv
import io
from django.http import HttpResponse, JsonResponse
import datetime as dt
from datetime import date
from django.utils import timezone
from django_filters import rest_framework as filters
from django.db import models


# === Custom Filter ===
class CharInFilter(filters.BaseInFilter, filters.CharFilter):
    pass


class AssemblyPartSpecFilter(filters.FilterSet):
    part_no__in = CharInFilter(field_name='part_no', lookup_expr='in')

    class Meta:
        model = AssemblyPartSpec
        fields = ['model_code', 'part_no', 'part_no__in']


class AssemblyReportViewSet(viewsets.ModelViewSet):
    queryset = AssemblyReport.objects.all()
    serializer_class = AssemblyReportSerializer
    permission_classes = [MachiningPermission]
    filterset_fields = ['date', 'line_no', 'model', 'part_no', 'supply_type']
    # 주의: 계산 필드는 정렬 대상에서 제외 (DB 필드만 허용)
    ordering_fields = ['date', 'line_no', 'model', 'part_no', 'plan_qty', 'actual_qty', 'total_time', 'idle_time']
    search_fields = ['line_no', 'model', 'part_no', 'note']

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """전체 통계 정보를 제공하는 엔드포인트"""
        qs = self.get_queryset()
        date_str = request.query_params.get('date')
        if date_str:
            qs = qs.filter(date=date_str)

        today_reports = qs
        
        total_count = today_reports.count()
        total_plan_qty = sum(r.plan_qty for r in today_reports)
        total_actual_qty = sum(r.actual_qty for r in today_reports)
        total_injection_defect = sum(r.injection_defect for r in today_reports)
        total_outsourcing_defect = sum(r.outsourcing_defect for r in today_reports)
        total_processing_defect = sum(r.processing_defect for r in today_reports)
        total_incoming_defect = total_injection_defect + total_outsourcing_defect
        total_defect_qty = total_injection_defect + total_outsourcing_defect + total_processing_defect

        achievement_rate = (
            round((total_actual_qty / total_plan_qty) * 100, 1)
            if total_plan_qty else 0
        )
        
        total_production = total_actual_qty + total_defect_qty
        defect_rate = (
            round((total_defect_qty / total_production) * 100, 1)
            if total_production else 0
        )
        
        summary_data = {
            'total_count': total_count,
            'total_plan_qty': total_plan_qty,
            'total_actual_qty': total_actual_qty,
            'total_injection_defect': total_injection_defect,
            'total_outsourcing_defect': total_outsourcing_defect,
            'total_incoming_defect': total_incoming_defect,
            'total_processing_defect': total_processing_defect,
            'total_defect_qty': total_defect_qty,
            'achievement_rate': achievement_rate,  # %
            'defect_rate': defect_rate,  # %
        }
        
        return Response(summary_data)

    @action(detail=False, methods=['get'])
    def export(self, request):
        """가공 생산 기록을 CSV 파일로 다운로드"""
        queryset = self.filter_queryset(self.get_queryset())

        buffer = io.StringIO()
        writer = csv.writer(buffer)

        # 헤더 작성 (상세 불량 포함)
        incoming_detail_keys = ['scratch','black_dot','eaten_meat','air_mark','deform','short_shot','broken_pillar','flow_mark','sink_mark','whitening','other']
        processing_detail_keys = ['scratch','printing','rework','other']

        writer.writerow([
            'ID', 'Date', 'Line No', 'Part No', 'Model', 'Plan Qty', 'Input Qty', 'Actual Qty',
            'Rework Qty', 'Supply Type', 'Injection Defect', 'Outsourcing Defect', 'Processing Defect', 'Total Defect',
            # 상세 불량: Incoming (사출/입고)
            *[f"Inc {k}" for k in incoming_detail_keys],
            # 상세 불량: Processing (가공)
            *[f"Proc {k}" for k in processing_detail_keys],
            'Total Time', 'Idle Time', 'Operation Time', 'Workers', 'Note'
        ])

        for r in queryset:
            inc = getattr(r, 'incoming_defects_detail', {}) or {}
            prc = getattr(r, 'processing_defects_detail', {}) or {}
            inc_values = [int((inc.get(k) or 0)) for k in incoming_detail_keys]
            prc_values = [int((prc.get(k) or 0)) for k in processing_detail_keys]

            writer.writerow([
                r.id,
                r.date,
                r.line_no,
                r.part_no,
                r.model,
                r.plan_qty,
                r.input_qty,
                r.actual_qty,
                r.rework_qty,
                r.supply_type,
                r.injection_defect,
                r.outsourcing_defect,
                r.processing_defect,
                r.total_defect_qty,
                *inc_values,
                *prc_values,
                r.total_time,
                r.idle_time,
                r.operation_time,
                r.workers,
                r.note,
            ])

        csv_data = '\ufeff' + buffer.getvalue()  # UTF-8 BOM for Excel
        response = HttpResponse(csv_data, content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="assembly_reports.csv"'
        return response

    # CSV 관련 대량 업로드/미리보기/일괄 생성 엔드포인트는 현재 비활성화되었습니다.


class AssemblyPartSpecViewSet(viewsets.ModelViewSet):
    queryset = AssemblyPartSpec.objects.all()
    serializer_class = AssemblyPartSpecSerializer
    permission_classes = [MachiningPermission]
    filterset_class = AssemblyPartSpecFilter
    search_fields = ['part_no', 'description', 'model_code']
    ordering = ['part_no']

    @action(detail=False, methods=['post'], url_path='create-or-update')
    def create_or_update(self, request):
        """Part 번호로 생성 또는 업데이트"""
        part_no = request.data.get('part_no', '').strip()
        description = request.data.get('description', '').strip()
        model_code = request.data.get('model_code', '').strip()
        
        if not part_no:
            return Response({'detail': 'part_no is required'}, status=400)
        
        # 기존 Part가 있는지 확인
        try:
            part = AssemblyPartSpec.objects.get(part_no=part_no)
            # 제공된 필드들만 업데이트
            if description:
                part.description = description
            if model_code:
                part.model_code = model_code
            part.save()
            return Response({
                'id': part.id,
                'part_no': part.part_no,
                'description': part.description,
                'model_code': part.model_code,
                'created': False
            })
        except AssemblyPartSpec.DoesNotExist:
            # 새로 생성
            part = AssemblyPartSpec.objects.create(
                part_no=part_no,
                description=description,
                model_code=model_code or '',
                valid_from=date.today()
            )
            return Response({
                'id': part.id,
                'part_no': part.part_no,
                'description': part.description,
                'model_code': part.model_code,
                'created': True
            })


class AssemblyProductViewSet(viewsets.ModelViewSet):
    queryset = AssemblyProduct.objects.all()
    serializer_class = AssemblyProductSerializer
    permission_classes = [MachiningPermission]
    search_fields = ['model', 'part_no', 'process_line']
    ordering = ['model']

    @action(detail=False, methods=['get'], url_path='search-by-part')
    def search_by_part(self, request):
        """Part No로 관련 모델 검색"""
        part_no = request.query_params.get('part_no', '').strip()
        if not part_no:
            return Response([], safe=False)
        
        products = self.get_queryset().filter(part_no__icontains=part_no)[:10]
        return Response([
            {'model': p.model, 'part_no': p.part_no, 'process_line': p.process_line}
            for p in products
        ])

    @action(detail=False, methods=['get'], url_path='search-by-model')
    def search_by_model(self, request):
        """Model로 관련 Part No 검색"""
        model = request.query_params.get('model', '').strip()
        if not model:
            return Response([], safe=False)
        
        products = self.get_queryset().filter(model__icontains=model)[:10]
        return Response([
            {'model': p.model, 'part_no': p.part_no, 'process_line': p.process_line}
            for p in products
        ])

    @action(detail=False, methods=['get'], url_path='search-parts')
    def search_parts(self, request):
        """Part No. 검색을 위한 API"""
        search = request.query_params.get('search', '').strip()
        prefix_only = request.query_params.get('prefix_only', '').lower() in ['1', 'true', 'yes']
        if not search or len(search) < 2:
            return Response([], safe=False)
        
        # AssemblyPartSpec에서 검색
        from .models import AssemblyPartSpec
        part_specs = AssemblyPartSpec.objects.filter(
            part_no__icontains=search
        ).values('part_no', 'model_code', 'description')[:10]
        
        # 기존 Product에서도 검색
        products = self.get_queryset().filter(
            part_no__icontains=search
        ).values('part_no', 'model')[:10]
        
        # 결과 통합 (중복 제거)
        results = {}
        
        # PartSpec 결과 추가
        for spec in part_specs:
            results[spec['part_no']] = {
                'part_no': spec['part_no'],
                'model': spec['model_code'],
                'description': spec['description']
            }
        
        # Product 결과 추가 (PartSpec이 없는 경우에만)
        for product in products:
            if product['part_no'] not in results:
                results[product['part_no']] = {
                    'part_no': product['part_no'],
                    'model': product['model'],
                    'description': ''
                }
        
        merged = list(results.values())
        # prefix_only 옵션: 앞부분이 정확히 일치하는 항목만 반환
        if prefix_only:
            s = search.upper()
            merged = [r for r in merged if r['part_no'].upper().startswith(s)]
        # startswith 우선 정렬
        s = search.upper()
        merged.sort(key=lambda r: (0 if r['part_no'].upper().startswith(s) else 1, r['part_no']))
        # 제한
        merged = merged[:50]
        return Response(merged)


def index(request):
    """기본 API 엔드포인트"""
    return JsonResponse({"message": "Assembly module ready"}) 