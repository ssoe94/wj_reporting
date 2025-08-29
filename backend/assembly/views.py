from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import AssemblyReport, AssemblyPartSpec, AssemblyProduct
from .serializers import (
    AssemblyReportSerializer,
    AssemblyPartSpecSerializer, 
    AssemblyProductSerializer,
    CSVUploadSerializer,
    CSVValidationResultSerializer,
    NewPartInfoSerializer
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
    filterset_fields = ['date', 'line_no', 'model', 'part_no']
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

        # 헤더 작성
        writer.writerow([
            'ID', 'Date', 'Line No', 'Part No', 'Model', 'Plan Qty', 'Input Qty', 'Actual Qty',
            'Injection Defect', 'Outsourcing Defect', 'Processing Defect', 'Total Defect',
            'Total Time', 'Idle Time', 'Operation Time', 'Workers', 'Note'
        ])

        for r in queryset:
            writer.writerow([
                r.id,
                r.date,
                r.line_no,
                r.part_no,
                r.model,
                r.plan_qty,
                r.input_qty,
                r.actual_qty,
                r.injection_defect,
                r.outsourcing_defect,
                r.processing_defect,
                r.total_defect_qty,
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

    @action(detail=False, methods=["post"], url_path="bulk-import")
    def bulk_import(self, request):
        """CSV 파일을 업로드하여 대량의 가공 생산 기록을 생성"""
        upload = request.FILES.get("file")
        if not upload:
            return Response({"detail": "file field is required"}, status=400)

        created = skipped = errors = 0

        try:
            # CSV 파일 읽기
            content = upload.read()
            
            # UTF-8 BOM 제거
            if content.startswith(b'\xef\xbb\xbf'):
                content = content[3:]
            
            # 인코딩 시도
            encodings = ['utf-8', 'cp949', 'euc-kr', 'latin-1']
            csv_content = None
            
            for encoding in encodings:
                try:
                    csv_content = content.decode(encoding)
                    break
                except UnicodeDecodeError:
                    continue
            
            if csv_content is None:
                return Response({"detail": "Unable to decode CSV file"}, status=400)

            # CSV 파싱
            reader = csv.DictReader(io.StringIO(csv_content))
            
            # 파싱 유틸
            def parse_int(val):
                try:
                    return int(float(val)) if val and str(val).strip() else 0
                except (TypeError, ValueError):
                    return 0

            def parse_date_only(val):
                if not val or str(val).strip() == '':
                    return None
                try:
                    txt = str(val).strip()
                    if '/' in txt:
                        txt = txt.replace('/', '-')
                    # YYYY-MM-DD 형태만 사용
                    return dt.datetime.fromisoformat(txt).date()
                except ValueError:
                    return None

            for i, row in enumerate(reader):
                try:
                    # 중복 체크 (같은 날짜, 라인, Part No.)
                    date_val = parse_date_only(row.get("Date"))
                    line_no = str(row.get("Line No", "")).strip()
                    part_no = str(row.get("Part No", "")).strip()

                    if AssemblyReport.objects.filter(
                        date=date_val,
                        line_no=line_no,
                        part_no=part_no,
                    ).exists():
                        skipped += 1
                        continue

                    total_time = parse_int(row.get("Total Time"))
                    idle_time = parse_int(row.get("Idle Time"))
                    operation_time = parse_int(row.get("Operation Time"))
                    if operation_time == 0 and total_time:
                        operation_time = max(0, total_time - idle_time)

                    report = AssemblyReport(
                        date=date_val,
                        line_no=line_no,
                        part_no=part_no,
                        model=str(row.get("Model", "")),
                        plan_qty=parse_int(row.get("Plan Qty")),
                        input_qty=parse_int(row.get("Input Qty")),
                        actual_qty=parse_int(row.get("Actual Qty")),
                        injection_defect=parse_int(row.get("Injection Defect")),
                        outsourcing_defect=parse_int(row.get("Outsourcing Defect")),
                        processing_defect=parse_int(row.get("Processing Defect")),
                        total_time=total_time,
                        idle_time=idle_time,
                        operation_time=operation_time,
                        workers=parse_int(row.get("Workers")) or 1,
                        note=str(row.get("Note", "")),
                    )
                    report.save()
                    created += 1
                except Exception as e:
                    errors += 1

        except Exception as e:
            return Response({"detail": f"CSV file processing error: {str(e)}"}, status=400)

        return Response({"created": created, "skipped": skipped, "errors": errors})

    @action(detail=False, methods=['post'], url_path='csv-preview')
    def csv_preview(self, request):
        """CSV 파일 업로드 및 검증 미리보기"""
        serializer = CSVUploadSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=400)
        
        try:
            validation_result = serializer.validate_and_preview_csv()
            result_serializer = CSVValidationResultSerializer(validation_result)
            return Response(result_serializer.data)
        except Exception as e:
            return Response({'detail': str(e)}, status=400)
    
    @action(detail=False, methods=['post'], url_path='csv-import')
    def csv_import(self, request):
        """검증된 CSV 데이터 최종 저장"""
        validated_data = request.data.get('validated_data', [])
        new_parts_info = request.data.get('new_parts_info', [])
        
        if not validated_data:
            return Response({'detail': 'validated_data is required'}, status=400)
        
        created_reports = 0
        created_parts = 0
        errors = []
        
        # 1단계: 신규 Part 정보 먼저 생성
        for part_info in new_parts_info:
            part_serializer = NewPartInfoSerializer(data=part_info)
            if part_serializer.is_valid():
                try:
                    AssemblyPartSpec.objects.create(
                        part_no=part_serializer.validated_data['part_no'],
                        model_code=part_serializer.validated_data['model_code'],
                        description=part_serializer.validated_data.get('description', ''),
                        process_type=part_serializer.validated_data.get('process_type', ''),
                        material_type=part_serializer.validated_data.get('material_type', ''),
                        standard_cycle_time=part_serializer.validated_data.get('standard_cycle_time'),
                        standard_worker_count=part_serializer.validated_data.get('standard_worker_count', 1),
                        valid_from=date.today()
                    )
                    created_parts += 1
                except Exception as e:
                    errors.append(f"Part 생성 실패 ({part_info.get('part_no')}): {str(e)}")
            else:
                errors.append(f"Part 검증 실패 ({part_info.get('part_no')}): {part_serializer.errors}")
        
        # 2단계: AssemblyReport 데이터 저장
        for item in validated_data:
            row_data = item.get('data', {})
            try:
                # 중복 체크 (같은 날짜, 라인, Part No.)
                existing = AssemblyReport.objects.filter(
                    date=row_data['date'],
                    line_no=row_data.get('line_no', ''),
                    part_no=row_data['part_no']
                ).first()
                
                if existing:
                    errors.append(f"중복 데이터 (행 {item.get('row_number')}): {row_data['date']} - {row_data['part_no']}")
                    continue
                
                report = AssemblyReport.objects.create(
                    date=row_data['date'],
                    line_no=row_data.get('line_no', ''),
                    part_no=row_data['part_no'],
                    model=row_data['model'],
                    plan_qty=row_data['plan_qty'],
                    input_qty=row_data.get('input_qty', 0),
                    actual_qty=row_data['actual_qty'],
                    injection_defect=row_data.get('injection_defect', 0),
                    outsourcing_defect=row_data.get('outsourcing_defect', 0),
                    processing_defect=row_data.get('processing_defect', 0),
                    operation_time=row_data.get('operation_time', 0),
                    total_time=row_data.get('total_time', 1440),
                    idle_time=row_data.get('idle_time', 0),
                    workers=row_data.get('workers', 1),
                    note=row_data.get('note', '')
                )
                created_reports += 1
                
            except Exception as e:
                errors.append(f"Report 생성 실패 (행 {item.get('row_number')}): {str(e)}")
        
        return Response({
            'created_reports': created_reports,
            'created_parts': created_parts,
            'errors': errors,
            'success': len(errors) == 0
        })

    @action(detail=False, methods=['post'], url_path='bulk-create')
    def bulk_create(self, request):
        """테이블 형태(JSON 배열)로 전달된 행들을 일괄 생성"""
        rows = request.data.get('rows', [])
        if not isinstance(rows, list) or len(rows) == 0:
            return Response({'detail': 'rows must be a non-empty list'}, status=400)

        created_reports = 0
        errors = []

        # CSV 업로더의 행 검증 로직 재사용
        csv_ser = CSVUploadSerializer()

        for idx, row in enumerate(rows):
            row_number = idx + 1
            try:
                validated = csv_ser._validate_row(row, row_number)

                # 중복 체크 (같은 날짜, 라인, Part No.)
                existing = AssemblyReport.objects.filter(
                    date=validated['date'],
                    line_no=validated.get('line_no', ''),
                    part_no=validated['part_no']
                ).first()
                if existing:
                    errors.append(f"중복 데이터 (행 {row_number}): {validated['date']} - {validated['part_no']}")
                    continue

                AssemblyReport.objects.create(
                    date=validated['date'],
                    line_no=validated.get('line_no', ''),
                    part_no=validated['part_no'],
                    model=validated['model'],
                    plan_qty=validated['plan_qty'],
                    input_qty=validated.get('input_qty', 0),
                    actual_qty=validated['actual_qty'],
                    injection_defect=validated.get('injection_defect', 0),
                    outsourcing_defect=validated.get('outsourcing_defect', 0),
                    processing_defect=validated.get('processing_defect', 0),
                    operation_time=validated.get('operation_time', 0),
                    total_time=validated.get('total_time', 1440),
                    idle_time=validated.get('idle_time', 0),
                    workers=validated.get('workers', 1),
                    note=validated.get('note', '')
                )
                created_reports += 1
            except Exception as e:
                errors.append(f"행 {row_number} 오류: {str(e)}")

        return Response({
            'created_reports': created_reports,
            'errors': errors,
            'success': len(errors) == 0
        })


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