from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import InjectionReport, Product, PartSpec
from .serializers import InjectionReportSerializer, ProductSerializer, PartSpecSerializer
import csv
import io
from django.http import HttpResponse
import datetime as dt

class InjectionReportViewSet(viewsets.ModelViewSet):
    queryset = InjectionReport.objects.all()
    serializer_class = InjectionReportSerializer
    filterset_fields = ['date', 'tonnage', 'model', 'section']
    ordering_fields = ['date', 'tonnage', 'model', 'achievement_rate', 'defect_rate']
    search_fields = ['tonnage', 'model', 'note']

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
        total_defect_qty = sum(r.actual_defect for r in today_reports)

        achievement_rate = (
            round((total_actual_qty / total_plan_qty) * 100, 1)
            if total_plan_qty else 0
        )
        defect_rate = (
            round((total_defect_qty / total_actual_qty) * 100, 1)
            if total_actual_qty else 0
        )

        summary_data = {
            'total_count': total_count,
            'total_plan_qty': total_plan_qty,
            'total_actual_qty': total_actual_qty,
            'total_defect_qty': total_defect_qty,
            'achievement_rate': achievement_rate,  # %
            'defect_rate': defect_rate,  # %
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

    @action(detail=False, methods=["post"], url_path="bulk-import")
    def bulk_import(self, request):
        """CSV 파일을 업로드하여 대량의 생산 기록을 생성한다.

        입력 형식: multipart/form-data, field name "file"
        응답 예시: {"created": 10, "skipped": 2, "errors": 1}
        중복 판단 기준: (date, machine_no, start_datetime, model) 조합이 이미 존재하면 skip
        """
        upload = request.FILES.get("file")
        if not upload:
            return Response({"detail": "file field is required"}, status=400)

        import csv, io

        created = skipped = errors = 0
        reader = csv.DictReader(io.TextIOWrapper(upload, encoding="utf-8"))

        unique_fields = ("Date", "Machine No", "Start", "Model")

        for row in reader:
            try:
                key = (
                    row.get("Date"),
                    int(row.get("Machine No") or 0),
                    row.get("Start"),
                    row.get("Model"),
                )

                if InjectionReport.objects.filter(
                    date=key[0],
                    machine_no=key[1],
                    start_datetime=key[2],
                    model=key[3],
                ).exists():
                    skipped += 1
                    continue

                # 파싱 유틸
                def parse_int(val):
                    try:
                        return int(val)
                    except (TypeError, ValueError):
                        return 0

                def parse_dt(val):
                    if not val:
                        return None
                    txt = str(val).strip().replace("/", "-")
                    # 공백 → 'T' 로 치환해 ISO 형태로 맞춤
                    txt = txt.replace(" ", "T")
                    try:
                        return dt.datetime.fromisoformat(txt)
                    except ValueError:
                        return None

                report = InjectionReport(
                    date=row.get("Date") or None,
                    machine_no=parse_int(row.get("Machine No")),
                    tonnage=row.get("Tonnage"),
                    model=row.get("Model"),
                    section=row.get("Type"),
                    plan_qty=parse_int(row.get("Plan Qty")),
                    actual_qty=parse_int(row.get("Actual Qty")),
                    reported_defect=parse_int(row.get("Reported Defect")),
                    actual_defect=parse_int(row.get("Real Defect")),
                    start_datetime=parse_dt(row.get("Start")),
                    end_datetime=parse_dt(row.get("End")),
                    total_time=parse_int(row.get("Total Time")),
                    operation_time=parse_int(row.get("Operation Time")),
                    note=row.get("Note", ""),
                )
                report.save()
                created += 1
            except Exception:
                errors += 1

        return Response({"created": created, "skipped": skipped, "errors": errors})

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