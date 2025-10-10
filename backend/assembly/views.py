from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework import status
from rest_framework.response import Response
from .models import AssemblyReport, DefectHistory
from .serializers import (
    AssemblyReportSerializer,
)
from injection.permissions import AssemblyPermission
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

class AssemblyReportViewSet(viewsets.ModelViewSet):
    queryset = AssemblyReport.objects.all()
    serializer_class = AssemblyReportSerializer
    permission_classes = [AssemblyPermission]
    filterset_fields = ['date', 'line_no', 'model', 'part_no', 'supply_type']
    # 주의: 계산 필드는 정렬 대상에서 제외 (DB 필드만 허용)
    ordering_fields = ['date', 'line_no', 'model', 'part_no', 'plan_qty', 'actual_qty', 'total_time', 'idle_time']
    search_fields = ['line_no', 'model', 'part_no', 'note']

    @action(detail=False, methods=['get'], url_path='trend-data')
    def trend_data(self, request):
        """
        Returns data for the last 30 days for the trend chart.
        Not paginated.
        """
        thirty_days_ago = timezone.now().date() - dt.timedelta(days=30)
        queryset = AssemblyReport.objects.filter(date__gte=thirty_days_ago).order_by('date')
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)

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
    def dates(self, request):
        """캘린더에 표시할 날짜 목록을 반환 (페이지네이션 없이)"""
        dates = AssemblyReport.objects.values_list('date', flat=True).distinct().order_by('-date')
        return Response(list(dates))

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

    @action(detail=False, methods=['post'], url_path='bulk-import')
    def bulk_import(self, request):
        """CSV 파일을 업로드하여 대량 가공 생산 기록 생성"""
        csv_file = request.FILES.get('file')
        if not csv_file:
            return Response({'detail': 'CSV 파일이 필요합니다.'}, status=400)

        if not csv_file.name.endswith('.csv'):
            return Response({'detail': 'CSV 파일만 업로드 가능합니다.'}, status=400)

        results = {
            'created': 0,
            'skipped': 0,
            'errors': 0,
            'error_details': []
        }

        try:
            # 파일 읽기
            decoded_file = csv_file.read().decode('utf-8-sig')  # BOM 제거
            reader = csv.DictReader(io.StringIO(decoded_file))

            for row_num, row in enumerate(reader, 1):
                try:
                    # 필수 필드 확인
                    required_fields = ['Date', 'Line No', 'Part No', 'Model', 'Plan Qty', 'Actual Qty']
                    missing_fields = [field for field in required_fields if not row.get(field, '').strip()]

                    if missing_fields:
                        results['errors'] += 1
                        results['error_details'].append(f"행 {row_num}: 필수 필드 누락 - {missing_fields}")
                        continue

                    # 날짜 형식 검증
                    try:
                        date_obj = dt.datetime.strptime(row['Date'].strip(), '%Y-%m-%d').date()
                    except ValueError:
                        results['errors'] += 1
                        results['error_details'].append(f"행 {row_num}: 잘못된 날짜 형식 - {row['Date']}")
                        continue

                    # 숫자 필드 검증
                    try:
                        plan_qty = int(row['Plan Qty'])
                        actual_qty = int(row['Actual Qty'])
                        input_qty = int(row.get('Input Qty', 0) or 0)
                        rework_qty = int(row.get('Rework Qty', 0) or 0)
                        injection_defect = int(row.get('Injection Defect', 0) or 0)
                        outsourcing_defect = int(row.get('Outsourcing Defect', 0) or 0)
                        processing_defect = int(row.get('Processing Defect', 0) or 0)
                        total_time = int(row.get('Total Time', 0) or row.get('총시간', 0) or 0)
                        idle_time = int(row.get('Idle Time', 0) or row.get('부동시간', 0) or 0)
                        operation_time = int(row.get('Operation Time', 0) or row.get('가동시간', 0) or 0)
                        workers = int(row.get('Workers', 1) or row.get('작업인원', 1) or 1)
                    except (ValueError, TypeError):
                        results['errors'] += 1
                        results['error_details'].append(f"행 {row_num}: 숫자 필드 형식 오류")
                        continue

                    # 중복 체크
                    existing = AssemblyReport.objects.filter(
                        date=date_obj,
                        line_no=row['Line No'].strip(),
                        part_no=row['Part No'].strip(),
                        model=row['Model'].strip()
                    ).first()

                    if existing:
                        results['skipped'] += 1
                        continue

                    # 상세 불량 데이터 처리
                    incoming_detail_keys = ['scratch','black_dot','eaten_meat','air_mark','deform','short_shot','broken_pillar','flow_mark','sink_mark','whitening','other']
                    processing_detail_keys = ['scratch','printing','rework','other']

                    incoming_defects_detail = {}
                    for key in incoming_detail_keys:
                        col_name = f"Inc {key}"
                        if col_name in row:
                            try:
                                incoming_defects_detail[key] = int(row[col_name] or 0)
                            except ValueError:
                                incoming_defects_detail[key] = 0

                    processing_defects_detail = {}
                    for key in processing_detail_keys:
                        col_name = f"Proc {key}"
                        if col_name in row:
                            try:
                                processing_defects_detail[key] = int(row[col_name] or 0)
                            except ValueError:
                                processing_defects_detail[key] = 0

                    # AssemblyReport 생성
                    report = AssemblyReport.objects.create(
                        date=date_obj,
                        line_no=row['Line No'].strip(),
                        part_no=row['Part No'].strip(),
                        model=row['Model'].strip(),
                        plan_qty=plan_qty,
                        input_qty=input_qty,
                        actual_qty=actual_qty,
                        rework_qty=rework_qty,
                        supply_type=row.get('Supply Type', '').strip(),
                        injection_defect=injection_defect,
                        outsourcing_defect=outsourcing_defect,
                        processing_defect=processing_defect,
                        incoming_defects_detail=incoming_defects_detail,
                        processing_defects_detail=processing_defects_detail,
                        total_time=total_time,
                        idle_time=idle_time,
                        operation_time=operation_time,
                        workers=workers,
                        note=row.get('Note', '').strip()
                    )
                    results['created'] += 1

                except Exception as e:
                    results['errors'] += 1
                    results['error_details'].append(f"행 {row_num}: {str(e)}")

        except Exception as e:
            return Response({'detail': f'CSV 파일 처리 중 오류: {str(e)}'}, status=400)

        return Response(results)

    @action(detail=False, methods=['get'], url_path='historical-performance')
    def historical_performance(self, request):
        """Part No. 앞자리 9자리 기준 가공 생산 기록 히스토리 조회"""
        part_prefix = request.query_params.get('part_prefix')
        if not part_prefix:
            return Response({'detail': 'part_prefix 파라미터가 필요합니다.'}, status=400)

        # Part No. 앞자리 9자리로 필터링하여 최근 20개 기록 조회
        queryset = AssemblyReport.objects.filter(
            part_no__startswith=part_prefix[:9]
        ).order_by('-date', '-id')[:20]

        # 필요한 데이터만 직렬화 (모델의 property 사용)
        data = []
        for report in queryset:
            data.append({
                'id': report.id,
                'date': report.date,
                'part_no': report.part_no,
                'line_no': report.line_no,
                'actual_qty': report.actual_qty,
                'uph': report.uph,  # 모델의 property 사용
                'upph': report.upph,  # 모델의 property 사용
            })

        return Response(data)

    @action(detail=False, methods=['get'], url_path='defect-history')
    def defect_history(self, request):
        """불량 히스토리 조회"""
        try:
            # 가공불량 히스토리 (최근 사용 순)
            processing_defects = DefectHistory.get_recent_types('processing', limit=20)
            processing_list = [history.defect_type for history in processing_defects]

            # 외주불량 히스토리 (최근 사용 순)
            outsourcing_defects = DefectHistory.get_recent_types('outsourcing', limit=20)
            outsourcing_list = [history.defect_type for history in outsourcing_defects]

            return Response({
                'processing_defects': processing_list,
                'outsourcing_defects': outsourcing_list
            })

        except Exception as e:
            return Response(
                {'error': str(e)},
                status=500
            )

    @action(detail=False, methods=['post'], url_path='record-defect-usage')
    def record_defect_usage(self, request):
        """불량 유형 사용 기록"""
        try:
            data = request.data
            category = data.get('defect_category')
            defect_type = data.get('defect_type')

            if not category or not defect_type:
                return Response(
                    {'error': 'defect_category and defect_type are required'},
                    status=400
                )

            if category not in ['processing', 'outsourcing']:
                return Response(
                    {'error': 'Invalid defect_category. Must be "processing" or "outsourcing"'},
                    status=400
                )

            # 히스토리 기록
            history = DefectHistory.record_usage(category, defect_type)

            return Response({
                'success': True,
                'defect_type': history.defect_type,
                'usage_count': history.usage_count,
                'last_used': history.last_used
            })

        except Exception as e:
            return Response(
                {'error': str(e)},
                status=500
            )

def index(request):
    """기본 API 엔드포인트"""
    return JsonResponse({"message": "Assembly module ready"})
