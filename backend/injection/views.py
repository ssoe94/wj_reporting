from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import InjectionReport, Product, PartSpec, EngineeringChangeOrder, EcoDetail, EcoPartSpec, InventorySnapshot
from .serializers import (
    InjectionReportSerializer,
    ProductSerializer,
    PartSpecSerializer,
    EngineeringChangeOrderSerializer,
    EcoDetailSerializer,
    EcoPartSpecSerializer,
    InventorySnapshotSerializer,
)
import csv
import io
from django.http import HttpResponse
import datetime as dt
from datetime import date
from django.utils import timezone
from django.conf import settings
import requests
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from django.db import models

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
            'ID', 'Date', 'Machine No', 'Tonnage', 'Model', 'Type', 'Part No', 'Plan Qty', 'Actual Qty',
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
                r.part_no,
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

        csv_data = '\ufeff' + buffer.getvalue()  # prepend UTF-8 BOM for Excel
        response = HttpResponse(csv_data, content_type='text/csv')
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
                    date=parse_dt(row.get("Date")).date() if parse_dt(row.get("Date")) else None,
                    machine_no=parse_int(row.get("Machine No")),
                    tonnage=row.get("Tonnage"),
                    model=row.get("Model"),
                    section=row.get("Type"),
                    part_no=row.get("Part No"),
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

    @action(detail=False, methods=["get"], url_path="by-part")
    def by_part(self, request):
        """part_no 로 ECO 목록 조회"""
        keyword = request.query_params.get("part_no", "").strip()
        if not keyword:
            return Response({"detail": "part_no query param required"}, status=400)

        qs = self.get_queryset().filter(details__part_spec__part_no__icontains=keyword).distinct()
        page = self.paginate_queryset(qs)
        serializer = self.get_serializer(page, many=True)
        return self.get_paginated_response(serializer.data)

# ==== 제품 마스터 관리 (CRUD) ====
class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()
    serializer_class = ProductSerializer
    filterset_fields = ['type']
    search_fields = ['model', 'fg_part_no', 'wip_part_no']
    ordering = ['model']

# ==== 품목 스펙 관리 (CRUD) ====
class PartSpecViewSet(viewsets.ModelViewSet):
    queryset = PartSpec.objects.all()
    serializer_class = PartSpecSerializer
    filterset_fields = ['model_code', 'part_no']
    search_fields = ['part_no', 'description', 'model_code']
    ordering = ['part_no']

    @action(detail=False, methods=['get'], url_path='with-eco-count')
    def with_eco_count(self, request):
        """검색어에 맞는 Part 중 ECO에 포함된 건수 반환"""
        kw = request.query_params.get('search', '').strip()
        qs = self.get_queryset()
        if kw:
            qs = qs.filter(part_no__icontains=kw)
        qs = qs.annotate(eco_cnt=models.Count('ecodetail'))
        data = [
            {'part_no': p.part_no, 'description': p.description, 'count': p.eco_cnt}
            for p in qs if p.eco_cnt
        ][:50]
        return Response(data)

    @action(detail=True, methods=['patch'], url_path='update-description')
    def update_description(self, request, pk=None):
        """Part description 수정"""
        part = self.get_object()
        description = request.data.get('description', '').strip()
        if not description:
            return Response({'detail': 'description is required'}, status=400)
        
        part.description = description
        part.save(update_fields=['description'])
        return Response({'part_no': part.part_no, 'description': part.description})

    @action(detail=False, methods=['post'], url_path='create-or-update')
    def create_or_update(self, request):
        """Part 번호로 생성 또는 업데이트 (직접추가용)"""
        part_no = request.data.get('part_no', '').strip()
        description = request.data.get('description', '').strip()
        
        if not part_no:
            return Response({'detail': 'part_no is required'}, status=400)
        
        # 기존 Part가 있는지 확인
        try:
            part = PartSpec.objects.get(part_no=part_no)
            # description이 제공된 경우에만 업데이트
            if description:
                part.description = description
                part.save(update_fields=['description'])
            return Response({
                'id': part.id,
                'part_no': part.part_no,
                'description': part.description,
                'created': False
            })
        except PartSpec.DoesNotExist:
            # 새로 생성
            part = PartSpec.objects.create(
                part_no=part_no,
                description=description,
                model_code='',  # 기본값
                valid_from=date.today()
            )
            return Response({
                'id': part.id,
                'part_no': part.part_no,
                'description': part.description,
                'created': True
            })

# ==== ECO Part 스펙 관리 (ECO 전용) ====
class EcoPartSpecViewSet(viewsets.ModelViewSet):
    queryset = EcoPartSpec.objects.all()
    serializer_class = EcoPartSpecSerializer
    search_fields = ['part_no', 'description', 'model_code']
    ordering = ['part_no']

    @action(detail=False, methods=['get'], url_path='with-eco-count')
    def with_eco_count(self, request):
        """검색어에 맞는 ECO Part 중 ECO에 포함된 건수 반환"""
        kw = request.query_params.get('search', '').strip()
        qs = self.get_queryset()
        if kw:
            qs = qs.filter(part_no__icontains=kw)
        qs = qs.annotate(eco_cnt=models.Count('eco_details'))
        data = [
            {'part_no': p.part_no, 'description': p.description, 'count': p.eco_cnt}
            for p in qs if p.eco_cnt
        ][:50]
        return Response(data)

    @action(detail=True, methods=['patch'], url_path='update-description')
    def update_description(self, request, pk=None):
        """ECO Part description 수정"""
        part = self.get_object()
        description = request.data.get('description', '').strip()
        if not description:
            return Response({'detail': 'description is required'}, status=400)
        
        part.description = description
        part.save(update_fields=['description'])
        return Response({'part_no': part.part_no, 'description': part.description})

    @action(detail=False, methods=['post'], url_path='create-or-update')
    def create_or_update(self, request):
        """ECO Part 번호로 생성 또는 업데이트 (직접추가용)"""
        part_no = request.data.get('part_no', '').strip()
        description = request.data.get('description', '').strip()
        
        if not part_no:
            return Response({'detail': 'part_no is required'}, status=400)
        
        # 기존 ECO Part가 있는지 확인
        try:
            part = EcoPartSpec.objects.get(part_no=part_no)
            # description이 제공된 경우에만 업데이트
            if description:
                part.description = description
                part.save(update_fields=['description'])
            return Response({
                'id': part.id,
                'part_no': part.part_no,
                'description': part.description,
                'created': False
            })
        except EcoPartSpec.DoesNotExist:
            # 새로 생성
            part = EcoPartSpec.objects.create(
                part_no=part_no,
                description=description,
                model_code=''  # 기본값
            )
            return Response({
                'id': part.id,
                'part_no': part.part_no,
                'description': part.description,
                'created': True
            })

# ==== ECO 관리 (CRUD) ====
class EngineeringChangeOrderViewSet(viewsets.ModelViewSet):
    queryset = EngineeringChangeOrder.objects.all()
    serializer_class = EngineeringChangeOrderSerializer
    filterset_fields = ['status', 'eco_model', 'customer']
    search_fields = ['eco_no', 'change_reason', 'change_details', 'customer', 'eco_model']
    ordering = ['-prepared_date'] 

    @action(detail=False, methods=["get"], url_path="by-part")
    def by_part(self, request):
        """part_no 로 ECO 목록 조회

        ?part_no=AAN... → 해당 Part 가 포함된 ECO 헤더 + details preload
        """
        keyword = request.query_params.get("part_no", "").strip()
        if not keyword:
            return Response({"detail": "part_no query param required"}, status=400)

        qs = (
            self.get_queryset()
            .filter(details__eco_part_spec__part_no__icontains=keyword)
            .distinct()
        )
        page = self.paginate_queryset(qs)
        serializer = self.get_serializer(page, many=True)
        return self.get_paginated_response(serializer.data)

    @action(detail=True, methods=['post'], url_path='details/bulk')
    def bulk_details(self, request, pk=None):
        """part_spec_ids=[..] + optional reason/msg 로 다중 EcoDetail 생성"""
        eco = self.get_object()
        items = request.data.get('details')
        if not isinstance(items, list):
            return Response({'detail':'details must be list'}, status=400)
        created = 0
        updated = 0
        for it in items:
            pid = it.get('eco_part_spec')
            if not pid:
                continue
            try:
                part = EcoPartSpec.objects.get(id=pid)
                detail, created_flag = EcoDetail.objects.get_or_create(
                    eco_header=eco,
                    eco_part_spec=part,
                    defaults={
                        'change_reason': it.get('change_reason',''),
                        'change_details': it.get('change_details',''),
                        'status': it.get('status','OPEN') or 'OPEN'
                    }
                )
                if created_flag:
                    created +=1
                else:
                    # update existing fields if changed
                    changed = False
                    if 'change_reason' in it and detail.change_reason != it['change_reason']:
                        detail.change_reason = it['change_reason']; changed=True
                    if 'change_details' in it and detail.change_details != it['change_details']:
                        detail.change_details = it['change_details']; changed=True
                    if 'status' in it and detail.status != (it['status'] or 'OPEN'):
                        detail.status = it['status'] or 'OPEN'; changed=True
                    if changed:
                        detail.save(); updated+=1
            except EcoPartSpec.DoesNotExist:
                continue
        # 헤더 상태 자동 집계
        if eco.details.filter(status='OPEN').exists():
            if eco.status != 'OPEN':
                eco.status='OPEN'; eco.save(update_fields=['status'])
        else:
            if eco.status != 'CLOSED':
                eco.status='CLOSED'; eco.save(update_fields=['status'])

        return Response({'created':created,'updated':updated})


# ==== Inventory API ====

class InventoryView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        part_ids = request.query_params.getlist('part_ids')
        if not part_ids:
            return Response({'detail':'part_ids query param required'}, status=400)
        parts = PartSpec.objects.filter(id__in=part_ids)

        # If snapshot within 30min exists, use it; else fetch
        result = {}
        now = timezone.now()
        need_fetch = []
        for p in parts:
            snap = InventorySnapshot.objects.filter(part_spec=p).order_by('-collected_at').first()
            if snap and (now - snap.collected_at).total_seconds() < 1800:
                result[p.id] = snap.qty
            else:
                need_fetch.append(p)

        if need_fetch:
            token = getattr(settings, 'MES_ACCESS_TOKEN', '')
            base = getattr(settings, 'MES_API_BASE', '')
            if not (token and base):
                # MES 설정이 없으면 재고 0 으로 처리하고 오류 반환하지 않음
                for p in need_fetch:
                    InventorySnapshot.objects.create(part_spec=p, qty=0)
                    result[p.id] = 0
            else:
                url = base.rstrip('/') + '/inventory/open/v1/material_inventory/_list'
                codes = [p.part_no for p in need_fetch]
                payload = {"materialCodes": codes, "selectFlag":0, "page":1, "size":100}
                try:
                    resp = requests.post(url, params={'access_token':token}, json=payload, timeout=10)
                    resp.raise_for_status()
                    data = resp.json()
                    items = data.get('data', {}).get('list', [])
                    # aggregate qty by material code
                    qty_map = {}
                    for it in items:
                        code = it.get('material',{}).get('code')
                        amount = it.get('amount',{}).get('amount',0)
                        qty_map[code] = qty_map.get(code,0)+amount
                except Exception as e:
                    return Response({'detail':f'MES fetch error: {e}'}, status=502)

                # save snapshots & fill result
                for p in need_fetch:
                    qty = qty_map.get(p.part_no, 0)
                    InventorySnapshot.objects.create(part_spec=p, qty=qty)
                    result[p.id] = qty

        return Response(result) 