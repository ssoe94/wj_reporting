from rest_framework import viewsets, generics, status
from rest_framework.response import Response
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser
from django.db import models as django_models
from django.db.models import Q
from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404, render, redirect
from django.http import HttpResponse
import csv
import io

# Import actual models
from .models import (
    InjectionReport, Product, PartSpec, EcoPartSpec, EngineeringChangeOrder,
    UserRegistrationRequest, UserProfile, EcoDetail, InventorySnapshot,
    CycleTimeSetup, CycleTimeTestRecord, InjectionMonitoringRecord
)

# Import actual serializers
from .serializers import (
    InjectionReportSerializer, ProductSerializer, PartSpecSerializer,
    EcoPartSpecSerializer, EngineeringChangeOrderSerializer,
    UserRegistrationRequestSerializer, UserProfileSerializer,
    InventorySnapshotSerializer, EcoDetailSerializer, UserSerializer, ChangePasswordSerializer,
    HistoricalPerformanceSerializer, CycleTimeSetupSerializer, CycleTimeTestRecordSerializer,
    CycleTimeSetupDashboardSerializer, InjectionMonitoringRecordSerializer
)

# For User related views
from rest_framework.permissions import IsAuthenticated, AllowAny, IsAdminUser
from .permissions import (
    InjectionPermission,
    AssemblyPermission,
    QualityPermission,
    SalesPermission,
    DevelopmentPermission,
    AdminOnlyPermission,
)
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.views import TokenObtainPairView
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone
from django.core.cache import cache
import secrets, string
from datetime import datetime, timedelta
import pytz
import threading
from django.views import View
from django.utils.decorators import method_decorator
from django.contrib.auth.decorators import login_required
from django.contrib import messages

from .mes_service import mes_service
from .plan_processing import ProductionPlanProcessor, ProductionPlanProcessingError
from production.models import ProductionPlan

User = get_user_model()

class UpdateRecentSnapshotsView(generics.GenericAPIView):
    """On-demand API to trigger an update of the last 3 hours of snapshots from the MES."""
    permission_classes = [AllowAny] # Or IsAuthenticated, depending on requirements

    def post(self, request, *args, **kwargs):
        try:
            hours = int(request.data.get('hours', 3))
            if not 1 <= hours <= 24:
                raise ValueError("Hours must be between 1 and 24.")
        except (ValueError, TypeError):
            hours = 3 # Default to 3 hours on invalid input

        mode = str(request.data.get('mode') or '').lower()
        latest_only = mode == 'latest' or str(request.data.get('latest_only') or '').lower() in ('1', 'true', 'yes')

        job_id = secrets.token_hex(8)
        status_key = f"injection_update_status:{job_id}"
        latest_key = "injection_update_latest_job_id"
        machine_total = len(getattr(mes_service, 'device_code_map', {}) or {}) or 17
        total_steps = machine_total
        started_at = timezone.now().isoformat()

        cache.set(
            status_key,
            {
                "status": "running",
                "job_id": job_id,
                "total_steps": total_steps,
                "completed_steps": 0,
                "percent": 0,
                "started_at": started_at,
                "last_slot": None,
            },
            timeout=60 * 60,
        )
        cache.set(latest_key, job_id, timeout=60 * 60)

        def run_update_in_background():
            print(f"Background task started: Updating last {hours} hours.")
            try:
                def update_progress(completed_steps: int, total: int, slot_time):
                    percent = int((completed_steps / total) * 100) if total > 0 else 0
                    cache.set(
                        status_key,
                        {
                            "status": "running",
                            "job_id": job_id,
                            "total_steps": total,
                            "completed_steps": completed_steps,
                            "percent": percent,
                            "started_at": started_at,
                            "last_slot": slot_time.isoformat(),
                        },
                        timeout=60 * 60,
                    )

                if latest_only:
                    cst = pytz.timezone('Asia/Shanghai')
                    # 슬랏 정렬(10분 단위)과 맞추기 위해 10분 단위로 내림 처리
                    now = datetime.now(cst).replace(second=0, microsecond=0)
                    floored_min = (now.minute // 10) * 10
                    target_timestamp = now.replace(minute=floored_min)
                    mes_service._update_single_hour_snapshot(
                        target_timestamp,
                        progress_callback=update_progress,
                    )
                else:
                    mes_service.update_recent_hourly_snapshots(
                        hours_to_update=hours,
                        progress_callback=update_progress,
                    )
                cache.set(
                    status_key,
                    {
                        "status": "completed",
                        "job_id": job_id,
                        "total_steps": total_steps,
                        "completed_steps": total_steps,
                        "percent": 100,
                        "started_at": started_at,
                        "finished_at": timezone.now().isoformat(),
                        "last_slot": None,
                    },
                    timeout=60 * 60,
                )
                print(f"Background task finished: Successfully updated {hours} hours.")
            except Exception as e:
                cache.set(
                    status_key,
                    {
                        "status": "failed",
                        "job_id": job_id,
                        "total_steps": total_steps,
                        "completed_steps": 0,
                        "percent": 0,
                        "started_at": started_at,
                        "finished_at": timezone.now().isoformat(),
                        "error": str(e),
                        "last_slot": None,
                    },
                    timeout=60 * 60,
                )
                print(f"Background task failed: {e}")

        thread = threading.Thread(target=run_update_in_background, daemon=True)
        thread.start()

        return Response(
            {
                "status": "running",
                "message": f"Update process for the last {hours} hours started in the background.",
                "job_id": job_id,
                "total_steps": total_steps,
                "started_at": started_at,
            },
            status=status.HTTP_202_ACCEPTED
        )


class UpdateRecentSnapshotsStatusView(generics.GenericAPIView):
    """Check the progress of the background snapshot update job."""
    permission_classes = [AllowAny]

    def get(self, request, *args, **kwargs):
        job_id = request.query_params.get("job_id") or cache.get("injection_update_latest_job_id")
        if not job_id:
            return Response({"status": "idle"}, status=status.HTTP_200_OK)

        status_key = f"injection_update_status:{job_id}"
        payload = cache.get(status_key)
        if not payload:
            return Response({"status": "idle", "job_id": job_id}, status=status.HTTP_200_OK)

        return Response(payload, status=status.HTTP_200_OK)


class InjectionReportViewSet(viewsets.ModelViewSet):
    queryset = InjectionReport.objects.all()
    serializer_class = InjectionReportSerializer

    def get_queryset(self):
        """
        날짜 필터링을 지원하는 queryset 반환
        """
        queryset = super().get_queryset()
        
        # 날짜 필터링
        date_str = self.request.query_params.get('date')
        if date_str:
            queryset = queryset.filter(date=date_str)
        
        return queryset.order_by('-date', 'machine_no', 'start_datetime')

    @action(detail=False, methods=['get'])
    def dates(self, request):
        """
        Returns a list of distinct dates for which there are reports.
        """
        dates = InjectionReport.objects.values_list('date', flat=True).distinct().order_by('-date')
        return Response(list(dates))

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """사출 보고서 요약 통계"""
        qs = self.get_queryset()
        date_str = request.query_params.get('date')
        if date_str:
            qs = qs.filter(date=date_str)

        total_count = qs.count()
        total_plan_qty = sum(r.plan_qty for r in qs)
        total_actual_qty = sum(r.actual_qty for r in qs)
        total_defect_qty = sum(r.actual_defect for r in qs)

        achievement_rate = round((total_actual_qty / total_plan_qty) * 100, 1) if total_plan_qty else 0

        total_production = total_actual_qty + total_defect_qty
        defect_rate = round((total_defect_qty / total_production) * 100, 1) if total_production else 0

        return Response({
            'total_count': total_count,
            'total_plan_qty': total_plan_qty,
            'total_actual_qty': total_actual_qty,
            'total_defect_qty': total_defect_qty,
            'achievement_rate': achievement_rate,
            'defect_rate': defect_rate,
        })

    @action(detail=False, methods=['get'], url_path='export')
    def export_csv(self, request):
        """사출 보고서 전체를 CSV로 내보냅니다."""
        queryset = self.get_queryset().order_by('-date')
        
        today_str = timezone.now().strftime('%Y-%m-%d')
        filename = f'injection_reports_{today_str}.csv'
        
        response = HttpResponse(content_type='text/csv; charset=utf-8-sig')
        response['Content-Disposition'] = f'attachment; filename="{filename}"'

        writer = csv.writer(response)
        
        header = [
            'date', 'machine_no', 'tonnage', 'model', 'section', 'part_no',
            'plan_qty', 'actual_qty', 'reported_defect', 'actual_defect',
            'total_time', 'idle_time', 'operation_time', 'start_datetime', 'end_datetime', 'note',
            'achievement_rate', 'defect_rate', 'total_qty', 'uptime_rate'
        ]
        writer.writerow(header)
        
        for report in queryset:
            writer.writerow([
                report.date,
                report.machine_no,
                report.tonnage,
                report.model,
                report.section,
                report.part_no,
                report.plan_qty,
                report.actual_qty,
                report.reported_defect,
                report.actual_defect,
                report.total_time,
                report.idle_time,
                report.operation_time,
                report.start_datetime.strftime('%Y-%m-%d %H:%M:%S') if report.start_datetime else '',
                report.end_datetime.strftime('%Y-%m-%d %H:%M:%S') if report.end_datetime else '',
                report.note,
                report.achievement_rate,
                report.defect_rate,
                report.total_qty,
                report.uptime_rate
            ])
            
        return response

    @action(detail=False, methods=['post'], url_path='bulk-import')
    def bulk_import(self, request):
        """
        CSV 파일을 이용해 여러 개의 사출 보고서를 한 번에 생성하거나 업데이트합니다.
        'date', 'machine_no', 'part_no'를 기준으로 중복을 확인합니다.
        """
        file = request.FILES.get('file')
        if not file:
            return Response({'error': 'CSV file not provided'}, status=status.HTTP_400_BAD_REQUEST)

        if not file.name.endswith('.csv'):
            return Response({'error': 'File is not a CSV'}, status=status.HTTP_400_BAD_REQUEST)

        created_count = 0
        updated_count = 0
        errors = []

        try:
            decoded_file = file.read().decode('utf-8-sig')
            io_string = io.StringIO(decoded_file)
            reader = csv.DictReader(io_string)

            with transaction.atomic():
                for i, row in enumerate(reader):
                    try:
                        # --- 데이터 파싱 및 검증 ---
                        date_str = row.get('date', '').lstrip('\ufeff').strip()
                        if not date_str:
                            errors.append(f"Row {i+1}: Date is required.")
                            continue

                        machine_no = int(row['machine_no']) if row.get('machine_no') else None
                        part_no = row.get('part_no', '').strip().upper()

                        plan_qty = int(row.get('plan_qty') or 0)
                        actual_qty = int(row.get('actual_qty') or 0)
                        reported_defect = int(row.get('reported_defect') or 0)
                        actual_defect = int(row.get('actual_defect') or 0)
                        operation_time = int(row.get('operation_time') or 0)
                        total_time = int(row.get('total_time') or 1440)
                        idle_time = max(0, total_time - operation_time)

                        start_datetime = None
                        start_datetime_str = row.get('start_datetime')
                        if start_datetime_str:
                            try:
                                start_datetime = timezone.datetime.fromisoformat(start_datetime_str)
                            except ValueError:
                                start_datetime = None

                        end_datetime = None
                        end_datetime_str = row.get('end_datetime')
                        if end_datetime_str:
                            try:
                                end_datetime = timezone.datetime.fromisoformat(end_datetime_str)
                            except ValueError:
                                end_datetime = None

                        # --- Upsert 로직 ---
                        lookup_key = {
                            'date': date_str,
                            'machine_no': machine_no,
                            'part_no': part_no,
                        }

                        report_defaults = {
                            'tonnage': row.get('tonnage', ''),
                            'model': row.get('model', ''),
                            'section': row.get('section', ''),
                            'plan_qty': plan_qty,
                            'actual_qty': actual_qty,
                            'reported_defect': reported_defect,
                            'actual_defect': actual_defect,
                            'total_time': total_time,
                            'idle_time': idle_time,
                            'start_datetime': start_datetime,
                            'end_datetime': end_datetime,
                            'note': row.get('note', '')
                        }

                        obj, created = InjectionReport.objects.update_or_create(
                            **lookup_key,
                            defaults=report_defaults
                        )

                        if created:
                            created_count += 1
                        else:
                            updated_count += 1

                    except (ValueError, TypeError, KeyError) as e:
                        errors.append(f"Row {i+1}: Invalid data format - {e} - {row}")

            if errors:
                return Response({'errors': errors}, status=status.HTTP_400_BAD_REQUEST)

            return Response({
                'created': created_count,
                'skipped': updated_count, # 'skipped'는 프론트엔드 호환성을 위해 유지 (업데이트된 항목 수)
                'errors': len(errors)
            }, status=status.HTTP_201_CREATED)

        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['get'], url_path='historical-performance')
    def historical_performance(self, request):
        part_prefix = request.query_params.get('part_prefix', '').strip()
        if not part_prefix:
            return Response({'error': 'part_prefix is required'}, status=status.HTTP_400_BAD_REQUEST)

        queryset = InjectionReport.objects.filter(
            part_no__startswith=part_prefix
        ).order_by('-date', '-id')[:20]

        # Reverse the queryset so the chart shows oldest to newest
        queryset = reversed(queryset)

        serializer = HistoricalPerformanceSerializer(queryset, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='avg-cycle-time')
    def avg_cycle_time(self, request):
        """양품기준 평균 사이클 타임 계산"""
        part_no = request.query_params.get('part_no', '').strip().upper()
        machine_no = request.query_params.get('machine_no')

        if not part_no:
            return Response({'error': 'part_no is required'}, status=status.HTTP_400_BAD_REQUEST)

        # 기본 필터 조건: Part No.의 앞 9자리로 검색
        part_prefix = part_no[:9]
        filter_kwargs = {
            'part_no__startswith': part_prefix,
            'actual_qty__gt': 0,  # 실제 생산량이 있는 것만
            'actual_defect__lte': django_models.F('actual_qty') * 0.1  # 불량률 10% 이하 (양품 기준)
        }

        # 사출기 번호가 있으면 추가 필터링
        if machine_no:
            try:
                filter_kwargs['machine_no'] = int(machine_no)
            except (ValueError, TypeError):
                return Response({'error': 'Invalid machine_no'}, status=status.HTTP_400_BAD_REQUEST)

        # 최근 30일간의 데이터로 제한
        recent_date = timezone.now().date() - timedelta(days=30)
        filter_kwargs['date__gte'] = recent_date

        # 평균 사이클 타임 계산
        # operation_time(분) / actual_qty = 분당 사이클 타임 -> 초로 변환
        reports = InjectionReport.objects.filter(**filter_kwargs)

        if not reports.exists():
            return Response({
                'part_no': part_no,
                'machine_no': machine_no,
                'avg_cycle_time': None,
                'sample_count': 0,
                'calculation_method': 'operation_time / actual_qty'
            })

        # 평균 계산: (총 가동시간 / 총 생산량) * 60초
        total_operation_time = sum(r.operation_time for r in reports)  # 분
        total_production = sum(r.actual_qty for r in reports)

        if total_production == 0:
            avg_cycle_time = None
        else:
            avg_cycle_time = round((total_operation_time / total_production) * 60, 1)  # 초

        return Response({
            'part_no': part_no,
            'machine_no': machine_no,
            'avg_cycle_time': avg_cycle_time,
            'sample_count': reports.count(),
            'calculation_method': 'operation_time / actual_qty',
            'period_days': 30
        })

class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()
    serializer_class = ProductSerializer

    @action(detail=False, methods=['get'], url_path='search-parts')
    def search_parts(self, request):
        """Part No. 검색 API"""
        search = request.query_params.get('search', '').strip()
        prefix_only = request.query_params.get('prefix_only', '0') == '1'

        if not search:
            return Response([])

        # PartSpec에서 검색
        from .models import PartSpec
        queryset = PartSpec.objects.all()

        if prefix_only:
            queryset = queryset.filter(part_no__istartswith=search)
        else:
            queryset = queryset.filter(part_no__icontains=search)

        # 최대 20개 결과 반환
        results = queryset.order_by('part_no')[:20]

        data = [{
            'id': spec.id,
            'part_no': spec.part_no,
            'description': spec.description,
            'model_code': spec.model_code,
        } for spec in results]

        return Response(data)

class PartSpecViewSet(viewsets.ModelViewSet):
    queryset = PartSpec.objects.all()
    serializer_class = PartSpecSerializer
    # 검색/필터 활성화: 모델코드 기반 추천 및 키워드 검색 지원
    search_fields = ['part_no', 'description', 'model_code']
    filterset_fields = ['model_code', 'part_no', 'description']

    @action(detail=False, methods=['get'], url_path='(?P<part_no>[^/.]+)/standard-cycle-time')
    def standard_cycle_time(self, request, part_no=None):
        """특정 Part No.의 표준 사이클 타임 조회"""
        part_no = part_no.upper() if part_no else ''

        # PartSpec에서 먼저 조회
        part_spec = PartSpec.objects.filter(part_no=part_no).first()
        if part_spec and part_spec.cycle_time_sec:
            return Response({
                'part_no': part_no,
                'standard_cycle_time': part_spec.cycle_time_sec,
                'source': 'spec'
            })

        # PartSpec에 없으면 최근 승인된 셋업에서 조회
        recent_setup = CycleTimeSetup.objects.filter(
            part_no=part_no,
            status='APPROVED',
            mean_cycle_time__isnull=False
        ).order_by('-approved_at').first()

        if recent_setup:
            return Response({
                'part_no': part_no,
                'standard_cycle_time': recent_setup.mean_cycle_time,
                'source': 'setup'
            })

        # 둘 다 없으면 null 반환
        return Response({
            'part_no': part_no,
            'standard_cycle_time': None,
            'source': None
        })
    
    def list(self, request, *args, **kwargs):
        """Models 데이터 + MES 데이터 통합 검색"""
        search = request.query_params.get('search', '').strip()
        model_code = request.query_params.get('model_code', '').strip()
        page_size = int(request.query_params.get('page_size', 20))
        page = int(request.query_params.get('page', 1))
        
        # 1. Models 데이터 (PartSpec) 검색 - 우선순위 높음
        models_queryset = self.get_queryset()
        if search:
            models_queryset = models_queryset.filter(
                Q(part_no__icontains=search) |
                Q(model_code__icontains=search) |
                Q(description__icontains=search)
            )
        if model_code:
            models_queryset = models_queryset.filter(model_code__icontains=model_code)
        
        models_data = []
        for part in models_queryset:
            models_data.append({
                'id': part.id,
                'part_no': part.part_no,
                'model_code': part.model_code,
                'description': part.description or '',
                'mold_type': part.mold_type or '',
                'color': part.color or '',
                'resin_type': part.resin_type or '',
                'resin_code': part.resin_code or '',
                'net_weight_g': str(part.net_weight_g) if part.net_weight_g else '',
                'sr_weight_g': str(part.sr_weight_g) if part.sr_weight_g else '',
                'tonnage': part.tonnage,
                'cycle_time_sec': part.cycle_time_sec,
                'efficiency_rate': str(part.efficiency_rate) if part.efficiency_rate else '',
                'cavity': part.cavity,
                'resin_loss_pct': str(part.resin_loss_pct) if part.resin_loss_pct else '',
                'defect_rate_pct': str(part.defect_rate_pct) if part.defect_rate_pct else '',
                'valid_from': part.valid_from.strftime('%Y-%m-%d') if part.valid_from else '',
                'created_at': part.created_at.isoformat() if part.created_at else '',
                'source': 'models'  # 데이터 출처 표시
            })
        
        # 2. MES 데이터 (AssemblyPartSpec + Production Reports) 검색
        mes_data = []
        if search or model_code:
            try:
                from assembly.models import AssemblyPartSpec, AssemblyReport
                
                # AssemblyPartSpec에서 검색
                assembly_filter = Q()
                if search:
                    assembly_filter |= (
                        Q(part_no__icontains=search) |
                        Q(model_code__icontains=search) |
                        Q(description__icontains=search)
                    )
                if model_code:
                    assembly_filter &= Q(model_code__icontains=model_code)
                
                assembly_parts = AssemblyPartSpec.objects.filter(assembly_filter)[:20] if assembly_filter.children else []
                
                for part in assembly_parts:
                    # Models에 이미 없는 것만 추가 (중복 방지)
                    if not any(m['part_no'] == part.part_no for m in models_data):
                        mes_data.append({
                            'id': f"assembly_{part.id}",
                            'part_no': part.part_no,
                            'model_code': part.model_code,
                            'description': part.description or '',
                            'process_type': part.process_type or '',
                            'material_type': part.material_type or '',
                            'standard_cycle_time': part.standard_cycle_time,
                            'standard_worker_count': part.standard_worker_count,
                            'valid_from': part.valid_from.strftime('%Y-%m-%d') if part.valid_from else '',
                            'source': 'mes_assembly'
                        })
                
                # AssemblyReport (생산 기록)에서도 검색
                report_filter = Q()
                if search:
                    report_filter |= (
                        Q(part_no__icontains=search) |
                        Q(model__icontains=search)
                    )
                if model_code:
                    report_filter &= Q(model__icontains=model_code)
                
                assembly_reports = AssemblyReport.objects.filter(report_filter).values('part_no', 'model').distinct()[:20] if report_filter.children else []
                
                for report in assembly_reports:
                    part_no = report['part_no']
                    model = report['model']
                    # 이미 추가되지 않은 것만 추가
                    if (not any(m['part_no'] == part_no for m in models_data) and
                        not any(m['part_no'] == part_no for m in mes_data)):
                        mes_data.append({
                            'id': f"report_assembly_{part_no}",
                            'part_no': part_no,
                            'model_code': model,
                            'description': '',
                            'source': 'mes_report_assembly'
                        })
                
                # InjectionReport (사출 생산 기록)에서도 검색
                injection_filter = Q()
                if search:
                    injection_filter |= (
                        Q(part_no__icontains=search) |
                        Q(model__icontains=search)
                    )
                if model_code:
                    injection_filter &= Q(model__icontains=model_code)
                
                injection_reports = InjectionReport.objects.filter(injection_filter).values('part_no', 'model', 'type').distinct()[:20] if injection_filter.children else []
                
                for report in injection_reports:
                    part_no = report['part_no']
                    model = report['model']
                    description = report['type'] or ''
                    # 이미 추가되지 않은 것만 추가
                    if (not any(m['part_no'] == part_no for m in models_data) and
                        not any(m['part_no'] == part_no for m in mes_data)):
                        mes_data.append({
                            'id': f"report_injection_{part_no}",
                            'part_no': part_no,
                            'model_code': model,
                            'description': description,
                            'source': 'mes_report_injection'
                        })
                        
            except Exception as e:
                # MES 데이터 조회 실패시 Models 데이터만 반환
                pass
        
        # 3. 결과 통합 (Models 우선, MES 보완)
        all_results = models_data + mes_data
        
        # 4. 페이지네이션
        total_count = len(all_results)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        page_results = all_results[start_idx:end_idx]
        
        # 5. 페이지네이션 응답 형식으로 반환
        return Response({
            'count': total_count,
            'next': f"?page={page + 1}&search={search}&page_size={page_size}" if end_idx < total_count else None,
            'previous': f"?page={page - 1}&search={search}&page_size={page_size}" if page > 1 else None,
            'results': page_results
        })

class EcoPartSpecViewSet(viewsets.ModelViewSet):
    queryset = EcoPartSpec.objects.all()
    serializer_class = EcoPartSpecSerializer
    # 검색: part_no, description, model_code
    search_fields = ['part_no', 'description', 'model_code']

    @action(detail=False, methods=['post'], url_path='create-or-update')
    def create_or_update(self, request):
        """part_no 기준으로 EcoPartSpec 생성 또는 업데이트"""
        part_no = (request.data.get('part_no') or '').strip().upper()
        if not part_no:
            return Response({'part_no': 'required'}, status=status.HTTP_400_BAD_REQUEST)

        description = request.data.get('description', '')
        model_code = request.data.get('model_code', '')
        eco_category = request.data.get('eco_category', '')
        change_history = request.data.get('change_history', '')

        obj, created = EcoPartSpec.objects.get_or_create(
            part_no=part_no,
            defaults={
                'description': description,
                'model_code': model_code,
                'eco_category': eco_category,
                'change_history': change_history,
            }
        )

        if not created:
            # 전달된 값이 있으면 갱신
            updated = False
            if description != '':
                obj.description = description; updated = True
            if model_code != '':
                obj.model_code = model_code; updated = True
            if eco_category != '':
                obj.eco_category = eco_category; updated = True
            if change_history != '':
                obj.change_history = change_history; updated = True
            if updated:
                obj.save()

        serializer = self.get_serializer(obj)
        return Response(serializer.data)

class EngineeringChangeOrderViewSet(viewsets.ModelViewSet):
    queryset = EngineeringChangeOrder.objects.all()
    serializer_class = EngineeringChangeOrderSerializer

    @action(detail=True, methods=['post'], url_path='details/bulk')
    def bulk_details(self, request, pk=None):
        """
        주어진 ECO 헤더의 상세 목록을 일괄 저장(업서트)하고,
        요청에 포함되지 않은 기존 상세는 삭제합니다.

        payload: { details: [{ eco_part_spec, change_details, status }, ...] }
        """
        header = self.get_object()
        details = request.data.get('details', [])
        if not isinstance(details, list):
            return Response({'details': 'must be a list'}, status=status.HTTP_400_BAD_REQUEST)

        desired_ids = []
        # 유효성 검사 선행
        for idx, item in enumerate(details):
            eco_part_spec_id = item.get('eco_part_spec')
            if not eco_part_spec_id:
                return Response({f'details[{idx}].eco_part_spec': 'required'}, status=status.HTTP_400_BAD_REQUEST)
            desired_ids.append(eco_part_spec_id)

        with transaction.atomic():
            # 제거: 요청에 없는 상세 삭제
            EcoDetail.objects.filter(eco_header=header).exclude(eco_part_spec_id__in=desired_ids).delete()

            # 업서트 처리
            for item in details:
                eco_part_spec_id = item.get('eco_part_spec')
                change_details = item.get('change_details', '')
                status_val = item.get('status', 'OPEN')

                EcoDetail.objects.update_or_create(
                    eco_header=header,
                    eco_part_spec_id=eco_part_spec_id,
                    defaults={
                        'change_details': change_details,
                        'status': status_val,
                    }
                )

            # 상세 상태를 기반으로 헤더 상태 자동 갱신
            total_cnt = EcoDetail.objects.filter(eco_header=header).count()
            closed_cnt = EcoDetail.objects.filter(eco_header=header, status='CLOSED').count()
            open_cnt = EcoDetail.objects.filter(eco_header=header, status='OPEN').count()

            if total_cnt > 0 and closed_cnt == total_cnt:
                new_status = 'CLOSED'
            elif 0 < closed_cnt < total_cnt:
                new_status = 'WIP'
            else:
                # 모든 상세가 OPEN 이거나 상세가 없는 경우
                new_status = 'OPEN'

            if header.status != new_status:
                header.status = new_status
                # 완료 시점에 close_date 자동 세팅 (이미 값이 있으면 유지)
                if new_status == 'CLOSED' and not header.close_date:
                    header.close_date = timezone.now().date()
                # 다시 열리면 close_date 는 유지 (업무 규칙에 따라 None 처리하려면 아래 주석 해제)
                # elif new_status != 'CLOSED':
                #     header.close_date = None
                header.save(update_fields=['status', 'close_date'])

        # 최신 데이터 반환
        qs = EcoDetail.objects.filter(eco_header=header).select_related('eco_part_spec')
        serializer = EcoDetailSerializer(qs, many=True)
        return Response({'details': serializer.data})

    @action(detail=False, methods=['get'], url_path='unified-search')
    def unified_search(self, request):
        """
        ECO 번호, Part No., 모델 코드를 통합하여 검색
        ?keyword=검색어&type=검색타입(eco|part|model|all)
        ?part_numbers=part1,part2&type=part (for multiple part numbers)
        """
        keyword = request.query_params.get('keyword', '').strip()
        part_numbers_str = request.query_params.get('part_numbers', '')
        search_type = request.query_params.get('type', 'all')
        
        queryset = self.get_queryset()
        
        if search_type == 'part' and part_numbers_str:
            part_numbers = [p.strip() for p in part_numbers_str.split(',') if p.strip()]
            if part_numbers:
                queryset = queryset.filter(details__eco_part_spec__part_no__in=part_numbers).distinct()
            else:
                queryset = queryset.none()
        elif keyword:
            if search_type == 'eco':
                queryset = queryset.filter(eco_no__icontains=keyword)
            elif search_type == 'part':
                queryset = queryset.filter(details__eco_part_spec__part_no__icontains=keyword).distinct()
            elif search_type == 'model':
                queryset = queryset.filter(
                    django_models.Q(eco_model__icontains=keyword) |
                    django_models.Q(details__eco_part_spec__model_code__icontains=keyword)
                ).distinct()
            else:
                queryset = queryset.filter(
                    django_models.Q(eco_no__icontains=keyword) |
                    django_models.Q(details__eco_part_spec__part_no__icontains=keyword) |
                    django_models.Q(eco_model__icontains=keyword) |
                    django_models.Q(details__eco_part_spec__model_code__icontains=keyword)
                ).distinct()
        
        queryset = queryset.order_by('-prepared_date')
        
        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)


class UserRegistrationRequestViewSet(viewsets.ModelViewSet):
    queryset = UserRegistrationRequest.objects.all()
    serializer_class = UserRegistrationRequestSerializer
    authentication_classes = [JWTAuthentication]
    permission_classes = [IsAdminUser]

    def get_queryset(self):
        """
        Order by creation date, newest first.
        """
        return super().get_queryset().order_by('-created_at')

    @action(detail=True, methods=['post', 'options'], url_path='approve')
    def approve(self, request, pk=None):
        if request.method == 'OPTIONS':
            return Response(status=status.HTTP_200_OK)
        signup_req = self.get_object()
        if signup_req.status != 'pending':
            return Response({'detail': '이미 처리된 요청입니다.'}, status=status.HTTP_400_BAD_REQUEST)

        # 권한 페이로드 파싱
        perms = (request.data or {}).get('permissions', {})
        default_bool = lambda k: bool(perms.get(k, False))
        is_admin_flag = default_bool('is_admin')

        # 사용자 생성 또는 업데이트
        username_base = signup_req.email.split('@')[0]
        username = username_base
        # 동일 사용자명 충돌 회피
        i = 1
        while User.objects.filter(username=username).exclude(email=signup_req.email).exists():
            username = f"{username_base}{i}"
            i += 1

        # 안전한 랜덤 임시 비밀번호 생성 (영문 대/소문자+숫자, 최소 각 1자 포함)
        def generate_temp_password(length: int = 12) -> str:
            alphabet = string.ascii_letters + string.digits
            while True:
                pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
                if any(c.islower() for c in pwd) and any(c.isupper() for c in pwd) and any(c.isdigit() for c in pwd):
                    return pwd

        temp_password = generate_temp_password(12)

        user, created = User.objects.get_or_create(
            email=signup_req.email,
            defaults={
                'username': username,
                'first_name': signup_req.full_name,
                'password': make_password(temp_password),
                'is_staff': is_admin_flag,
            }
        )

        # 사용자 기본 정보 및 관리자 권한 동기화
        user.password = make_password(temp_password)
        update_fields = ['password']
        if not user.username:
            user.username = username
            update_fields.append('username')
        if not user.first_name:
            user.first_name = signup_req.full_name
            update_fields.append('first_name')
        if user.is_staff != is_admin_flag:
            user.is_staff = is_admin_flag
            update_fields.append('is_staff')
        if update_fields:
            user.save(update_fields=update_fields)

        # 프로필 권한 적용
        profile = UserProfile.get_user_permissions(user)
        profile.department = signup_req.department
        profile.can_edit_injection = default_bool('can_edit_injection')
        profile.can_edit_assembly = default_bool('can_edit_assembly')
        profile.can_edit_quality = default_bool('can_edit_quality')
        profile.can_edit_sales = default_bool('can_edit_sales')
        profile.can_edit_development = default_bool('can_edit_development')
        profile.is_admin = is_admin_flag

        # 레거시 호환 필드 매핑 (모델에는 존재하지 않지만 필수 default 처리)
        profile.is_using_temp_password = True
        profile.password_reset_required = True
        profile.save(update_fields=[
            'department',
            'can_edit_injection',
            'can_edit_assembly',
            'can_edit_quality',
            'can_edit_sales',
            'can_edit_development',
            'is_admin',
            'is_using_temp_password',
            'password_reset_required',
            'updated_at'
        ])

        signup_req.status = 'approved'
        signup_req.approved_by = request.user
        signup_req.approved_at = timezone.now()
        signup_req.temporary_password = temp_password
        signup_req.save(update_fields=['status', 'approved_by', 'approved_at', 'temporary_password'])

        return Response({
            'username': user.username,
            'temporary_password': temp_password,
        })

    @action(detail=True, methods=['post', 'options'], url_path='reject')
    def reject(self, request, pk=None):
        if request.method == 'OPTIONS':
            return Response(status=status.HTTP_200_OK)
        signup_req = self.get_object()
        if signup_req.status != 'pending':
            return Response({'detail': '이미 처리된 요청입니다.'}, status=status.HTTP_400_BAD_REQUEST)

        signup_req.status = 'rejected'
        signup_req.approved_by = request.user
        signup_req.approved_at = timezone.now()
        signup_req.save(update_fields=['status', 'approved_by', 'approved_at'])

        return Response({'detail': '요청이 거부되었습니다.'})

@method_decorator(login_required, name='dispatch')
class SignupApprovalPortalView(View):
    template_name = 'injection/signup_approval_portal.html'
    permission_options = [
        ('can_edit_injection', '사출 편집/삭제'),
        ('can_edit_assembly', '가공 편집/삭제'),
        ('can_edit_quality', '품질 편집/삭제'),
        ('can_edit_sales', '영업/재고 편집/삭제'),
        ('can_edit_development', '개발/ECO 편집/삭제'),
        ('is_admin', '관리자 권한'),
    ]

    def _ensure_staff(self, request):
        if not request.user.is_staff:
            messages.error(request, '관리자 권한이 필요합니다.')
            return False
        return True

    def get(self, request):
        if not self._ensure_staff(request):
            return redirect('admin:login')

        pending_requests = UserRegistrationRequest.objects.filter(status='pending').order_by('-created_at')
        context = {
            'pending_requests': pending_requests,
            'permission_options': self.permission_options,
            'focus_request_id': request.GET.get('request') or request.GET.get('request_id'),
        }
        return render(request, self.template_name, context)

    def post(self, request):
        if not self._ensure_staff(request):
            return redirect('admin:login')

        action = request.POST.get('action')
        request_id = request.POST.get('request_id')
        signup_req = get_object_or_404(UserRegistrationRequest, pk=request_id)

        if signup_req.status != 'pending':
            messages.warning(request, '이미 처리된 요청입니다.')
            return redirect('signup-approval-portal')

        if action == 'approve':
            perms = {
                key: request.POST.get(key) == 'on'
                for key, _ in self.permission_options
            }
            is_admin_flag = perms.get('is_admin', False)

            username_base = signup_req.email.split('@')[0]
            username = username_base
            i = 1
            while User.objects.filter(username=username).exclude(email=signup_req.email).exists():
                username = f"{username_base}{i}"
                i += 1

            def generate_temp_password(length: int = 12) -> str:
                alphabet = string.ascii_letters + string.digits
                while True:
                    pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
                    if any(c.islower() for c in pwd) and any(c.isupper() for c in pwd) and any(c.isdigit() for c in pwd):
                        return pwd

            temp_password = generate_temp_password(12)

            user, _ = User.objects.get_or_create(
                email=signup_req.email,
                defaults={
                    'username': username,
                    'first_name': signup_req.full_name,
                    'password': make_password(temp_password),
                    'is_staff': is_admin_flag,
                }
            )

            update_fields = ['password']
            user.password = make_password(temp_password)
            if not user.username:
                user.username = username
                update_fields.append('username')
            if not user.first_name:
                user.first_name = signup_req.full_name
                update_fields.append('first_name')
            if user.is_staff != is_admin_flag:
                user.is_staff = is_admin_flag
                update_fields.append('is_staff')
            if update_fields:
                user.save(update_fields=update_fields)

            profile = UserProfile.get_user_permissions(user)
            profile.can_edit_injection = perms.get('can_edit_injection', False)
            profile.can_edit_assembly = perms.get('can_edit_assembly', False)
            profile.can_edit_quality = perms.get('can_edit_quality', False)
            profile.can_edit_sales = perms.get('can_edit_sales', False)
            profile.can_edit_development = perms.get('can_edit_development', False)
            profile.is_admin = is_admin_flag
            profile.is_using_temp_password = True
            profile.password_reset_required = True
            profile.save(update_fields=[
                'can_edit_injection',
                'can_edit_assembly',
                'can_edit_quality',
                'can_edit_sales',
                'can_edit_development',
                'is_admin',
                'is_using_temp_password',
                'password_reset_required',
                'updated_at',
            ])

            signup_req.status = 'approved'
            signup_req.approved_by = request.user
            signup_req.approved_at = timezone.now()
            signup_req.temporary_password = temp_password
            signup_req.save(update_fields=['status', 'approved_by', 'approved_at', 'temporary_password'])

            messages.success(
                request,
                f"{signup_req.full_name} 승인 완료. 임시 비밀번호: {temp_password} (사용자: {user.username})"
            )
        elif action == 'reject':
            signup_req.status = 'rejected'
            signup_req.approved_by = request.user
            signup_req.approved_at = timezone.now()
            signup_req.save(update_fields=['status', 'approved_by', 'approved_at'])
            messages.info(request, f"{signup_req.full_name} 요청을 거부했습니다.")
        else:
            messages.error(request, '잘못된 요청입니다.')

        return redirect('signup-approval-portal')

class UserProfileViewSet(viewsets.ModelViewSet):
    queryset = UserProfile.objects.all()
    serializer_class = UserProfileSerializer

class InventoryView(generics.GenericAPIView):
    """
    간단 재고 조회 API
    입력: ?part_ids=1&part_ids=2 ... (PartSpec ID 목록)
    출력: { "1": 수량, "2": 수량 }
    가장 최근 스냅샷(Injection.InventorySnapshot 기준)을 사용합니다.
    """
    def get(self, request):
        part_ids = request.query_params.getlist('part_ids')
        try:
            part_ids_int = [int(x) for x in part_ids if str(x).strip()]
        except ValueError:
            return Response({'part_ids': 'must be integers'}, status=status.HTTP_400_BAD_REQUEST)

        result: dict[int, float] = {}
        if not part_ids_int:
            return Response(result)

        # 각 PartSpec에 대해 최신 스냅샷의 qty 반환
        for pid in part_ids_int:
            snap = InventorySnapshot.objects.filter(part_spec_id=pid).order_by('-collected_at').first()
            result[pid] = float(getattr(snap, 'qty', 0) or 0)

        return Response(result)

class SignupRequestView(generics.CreateAPIView):
    serializer_class = UserRegistrationRequestSerializer
    permission_classes = [AllowAny]

    def create(self, request, *args, **kwargs):
        # only accept required fields; ignore unknowns
        data = {
            'full_name': request.data.get('full_name', '').strip(),
            'department': request.data.get('department', '').strip(),
            'email': request.data.get('email', '').strip(),
            'reason': request.data.get('reason', ''),
        }
        email = data['email']

        if not email:
            return Response({'email': ['이메일을 입력해주세요.']}, status=status.HTTP_400_BAD_REQUEST)

        existing_request = UserRegistrationRequest.objects.filter(email=email).first()

        if existing_request:
            if existing_request.status != 'rejected':
                return Response(
                    {'email': ['이미 처리 중인 가입 요청이 존재합니다. 관리자 승인을 기다려주세요.']},
                    status=status.HTTP_400_BAD_REQUEST
                )

            serializer = self.get_serializer(existing_request, data=data, partial=True)
            serializer.is_valid(raise_exception=True)

            # 기존 거절 요청을 재활성화: 최신 정보로 갱신하고 상태 초기화
            for field in ['full_name', 'department', 'reason']:
                setattr(existing_request, field, serializer.validated_data.get(field, getattr(existing_request, field)))
            existing_request.status = 'pending'
            existing_request.approved_by = None
            existing_request.approved_at = None
            existing_request.temporary_password = ''
            existing_request.save(update_fields=[
                'full_name', 'department', 'reason', 'status', 'approved_by', 'approved_at', 'temporary_password', 'updated_at'
            ])

            response_serializer = self.get_serializer(existing_request)
            return Response(response_serializer.data, status=status.HTTP_200_OK)

        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

class UserMeView(generics.RetrieveAPIView):
    # Placeholder for UserMeView logic - needs actual queryset and serializer_class
    # Example:
    # queryset = User.objects.all()
    serializer_class = UserSerializer # Set the serializer class
    permission_classes = [IsAuthenticated]
    def get_object(self):
        return self.request.user

class ChangePasswordView(generics.GenericAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = ChangePasswordSerializer

    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        user = request.user
        new_password = serializer.validated_data['new_password']
        user.set_password(new_password)
        user.save()

        # 프로필 플래그 해제
        try:
            profile = user.profile
            profile.is_using_temp_password = False
            profile.password_reset_required = False
            profile.last_password_change = timezone.now()
            profile.save(update_fields=['is_using_temp_password', 'password_reset_required', 'last_password_change'])
        except Exception:
            pass

        return Response({'detail': '비밀번호가 변경되었습니다.'})

class ResetPasswordView(generics.CreateAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        if not request.user.is_staff:
            return Response({'detail': '관리자 권한이 필요합니다.'}, status=status.HTTP_403_FORBIDDEN)

        user_id = request.data.get('user_id')
        if not user_id:
            return Response({'user_id': 'required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            user_id = int(user_id)
        except (TypeError, ValueError):
            return Response({'user_id': 'must be an integer'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            target = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return Response({'detail': '사용자를 찾을 수 없습니다.'}, status=status.HTTP_404_NOT_FOUND)

        # 안전한 랜덤 임시 비밀번호 생성
        def generate_temp_password(length: int = 12) -> str:
            alphabet = string.ascii_letters + string.digits
            while True:
                pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
                if any(c.islower() for c in pwd) and any(c.isupper() for c in pwd) and any(c.isdigit() for c in pwd):
                    return pwd

        temp_password = generate_temp_password(12)
        target.set_password(temp_password)
        target.save()

        # 사용자 프로필 플래그 설정
        try:
            profile = UserProfile.get_user_permissions(target)
            profile.is_using_temp_password = True
            profile.password_reset_required = True
            profile.save(update_fields=['is_using_temp_password', 'password_reset_required'])
        except Exception:
            pass

        return Response({'username': target.username, 'temporary_password': temp_password})


class CycleTimeSetupViewSet(viewsets.ModelViewSet):
    queryset = CycleTimeSetup.objects.all()
    serializer_class = CycleTimeSetupSerializer
    permission_classes = [InjectionPermission]

    def get_permissions(self):
        """
        권한 체크:
        - dashboard: 인증된 사용자면 누구나 접근 가능 (읽기 전용)
        - 조회 작업 (list, retrieve): can_view_injection 필요
        - 편집 작업 (create, update, destroy, bulk_create 등): can_edit_injection 필요
        """
        if self.action == 'dashboard':
            return [IsAuthenticated()]
        return super().get_permissions()

    def get_queryset(self):
        queryset = super().get_queryset()

        # 필터링 옵션
        machine_no = self.request.query_params.get('machine_no')
        part_no = self.request.query_params.get('part_no')
        status = self.request.query_params.get('status')
        date_from = self.request.query_params.get('date_from')
        date_to = self.request.query_params.get('date_to')

        if machine_no:
            queryset = queryset.filter(machine_no=machine_no)
        if part_no:
            queryset = queryset.filter(part_no__icontains=part_no.upper())
        if status:
            queryset = queryset.filter(status=status)
        if date_from:
            queryset = queryset.filter(setup_date__date__gte=date_from)
        if date_to:
            queryset = queryset.filter(setup_date__date__lte=date_to)

        return queryset.select_related('setup_by').prefetch_related('test_records__tested_by')

    def perform_create(self, serializer):
        serializer.save(setup_by=self.request.user)

    @action(detail=False, methods=['get'], url_path='dashboard')
    def dashboard(self, request):
        """셋업 대시보드 데이터"""
        from django.utils import timezone
        from django.db.models import Q, Avg
        today = timezone.now().date()

        today_setups = CycleTimeSetup.objects.filter(setup_date__date=today)

        # Part no.의 앞 9자리별 평균 target_cycle_time 계산
        part_prefix_avg_ct = {}  # 앞 9자리 -> 평균 C/T
        part_to_prefix = {}  # 전체 Part no. -> 앞 9자리 매핑

        for part_no in today_setups.values_list('part_no', flat=True).distinct():
            if part_no and len(part_no) >= 9:
                prefix = part_no[:9]
                part_to_prefix[part_no] = prefix

        # 앞 9자리별로 그룹화하여 평균 계산
        for prefix in set(part_to_prefix.values()):
            # 앞 9자리가 동일한 모든 Part no. 찾기
            matching_parts = [pn for pn, px in part_to_prefix.items() if px == prefix]

            # 해당 Part no.들의 평균 target_cycle_time 계산
            avg = today_setups.filter(part_no__in=matching_parts).aggregate(
                avg_ct=Avg('target_cycle_time')
            )['avg_ct']

            if avg:
                part_prefix_avg_ct[prefix] = round(avg)

        # 머신별 최신 셋업만 추출 (1~17호기)
        machine_latest_setups = {}
        for machine_no in range(1, 18):  # 1~17호기
            latest = today_setups.filter(machine_no=machine_no).order_by('-setup_date').first()
            if latest:
                # Part no.의 앞 9자리로 평균 C/T 조회
                if latest.part_no and len(latest.part_no) >= 9:
                    prefix = latest.part_no[:9]
                    latest.mean_cycle_time = part_prefix_avg_ct.get(prefix)
                machine_latest_setups[machine_no] = latest

        # 최신순으로 정렬된 리스트로 변환
        recent_setups_list = sorted(
            machine_latest_setups.values(),
            key=lambda x: x.setup_date,
            reverse=True
        )

        dashboard_data = {
            'total_setups_today': today_setups.count(),
            'pending_approvals': today_setups.filter(Q(status='SETUP') | Q(status='TESTING')).count(),
            'approved_today': today_setups.filter(status='APPROVED').count(),
            'rejected_today': today_setups.filter(status='REJECTED').count(),
            'active_machines': list(today_setups.values_list('machine_no', flat=True).distinct()),
            'recent_setups': recent_setups_list
        }

        serializer = CycleTimeSetupDashboardSerializer(dashboard_data)
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='add-test')
    def add_test(self, request, pk=None):
        """테스트 기록 추가"""
        setup = self.get_object()

        if setup.status not in ['SETUP', 'TESTING']:
            return Response({'error': '테스트할 수 없는 상태입니다.'}, status=status.HTTP_400_BAD_REQUEST)

        serializer = CycleTimeTestRecordSerializer(data=request.data)
        if serializer.is_valid():
            test_record = serializer.save(setup=setup, tested_by=request.user)

            # 상태를 TESTING으로 변경 (아직 SETUP 상태인 경우)
            if setup.status == 'SETUP':
                setup.status = 'TESTING'
                setup.save(update_fields=['status'])

            # 테스트 결과를 바탕으로 standard_cycle_time 업데이트
            all_tests = setup.test_records.all()
            if all_tests:
                avg_cycle_time = sum(t.actual_cycle_time for t in all_tests) / len(all_tests)
                setup.standard_cycle_time = round(avg_cycle_time)
                setup.save(update_fields=['standard_cycle_time'])

            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=False, methods=['get'], url_path='cycle-time-history')
    def cycle_time_history(self, request):
        """파트 넘버 앞자리 기준 사이클 타임 히스토리"""
        part_prefix = request.query_params.get('part_prefix', '')

        if len(part_prefix) < 9:
            return Response({
                'error': 'Part prefix must be at least 9 characters'
            }, status=status.HTTP_400_BAD_REQUEST)

        # 앞 9자리가 같은 모델들 찾기
        setups = CycleTimeSetup.objects.filter(
            part_no__istartswith=part_prefix
        ).select_related('setup_by').order_by('setup_date')

        if not setups.exists():
            return Response({
                'part_prefix': part_prefix,
                'models': []
            })

        # 데이터 그룹화 - part_no별로 그룹화
        models_data = {}
        for setup in setups:
            part_no = setup.part_no
            if part_no not in models_data:
                models_data[part_no] = {
                    'model_code': setup.model_code or '',
                    'part_no': part_no,
                    'data': []
                }

            models_data[part_no]['data'].append({
                'setup_date': setup.setup_date.isoformat(),
                'target_cycle_time': setup.target_cycle_time,
                'mean_cycle_time': setup.mean_cycle_time,
                'standard_cycle_time': setup.standard_cycle_time,
                'status': setup.status
            })

        return Response({
            'part_prefix': part_prefix,
            'models': list(models_data.values())
        })

    @action(detail=False, methods=['get'], url_path='machine-status')
    def machine_status(self, request):
        """사출기별 현재 셋업 상태"""
        machine_no = request.query_params.get('machine_no')

        queryset = CycleTimeSetup.objects.all()
        if machine_no:
            queryset = queryset.filter(machine_no=machine_no)

        # 각 사출기의 최신 셋업 상태
        latest_setups = {}
        for setup in queryset.order_by('-setup_date'):
            if setup.machine_no not in latest_setups:
                latest_setups[setup.machine_no] = setup

        serializer = self.get_serializer(list(latest_setups.values()), many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='machines')
    def machines(self, request):
        """사출기 번호 목록 조회"""
        # 실제 사용 중인 사출기 번호들을 생산 기록에서 추출
        machine_nos = list(InjectionReport.objects.values_list('machine_no', flat=True).distinct().order_by('machine_no'))

        # 추가로 설정된 사출기 번호들도 포함
        setup_machine_nos = list(CycleTimeSetup.objects.values_list('machine_no', flat=True).distinct())

        # 통합하고 정렬
        all_machine_nos = sorted(set(machine_nos + setup_machine_nos))

        return Response({'machines': all_machine_nos})

    @action(detail=False, methods=['post'], url_path='bulk-create')
    def bulk_create(self, request):
        """일괄 셋업 생성"""
        setup_date = request.data.get('setup_date')
        setups_data = request.data.get('setups', [])
        duplicate_action = request.data.get('duplicate_action')  # 'new_version', 'update_existing', 또는 None


        if not setup_date:
            return Response({'error': '설정 날짜를 입력해주세요.'}, status=status.HTTP_400_BAD_REQUEST)

        if not setups_data or not isinstance(setups_data, list):
            return Response({'error': '셋업 데이터를 입력해주세요.'}, status=status.HTTP_400_BAD_REQUEST)

        created_setups = []
        updated_setups = []
        errors = []
        duplicate_items = []

        # 1단계: 중복 검사
        for i, setup_data in enumerate(setups_data):
            try:
                machine_no = setup_data.get('machine_no')
                part_no = setup_data.get('part_no', '').strip().upper()
                target_cycle_time = setup_data.get('target_cycle_time')

                if not machine_no or not part_no or not target_cycle_time:
                    continue

                # 중복 검사 (같은 날짜, 사출기, Part No.)
                existing = CycleTimeSetup.objects.filter(
                    setup_date__date=setup_date,
                    machine_no=machine_no,
                    part_no=part_no
                ).first()

                if existing:
                    duplicate_items.append({
                        'row_index': i + 1,
                        'machine_no': machine_no,
                        'part_no': part_no,
                        'target_cycle_time': target_cycle_time,
                        'existing_setup': {
                            'id': existing.id,
                            'target_cycle_time': existing.target_cycle_time,
                            'setup_date': existing.setup_date.isoformat(),
                            'status': existing.status
                        }
                    })
            except Exception:
                continue

        # 중복이 발견되었고 처리 방법이 지정되지 않은 경우만 409 반환
        if duplicate_items and not duplicate_action:
            return Response({
                'duplicates_found': True,
                'duplicate_items': duplicate_items
            }, status=status.HTTP_409_CONFLICT)

        # 2단계: 실제 처리
        try:
            with transaction.atomic():
                for i, setup_data in enumerate(setups_data):
                    try:
                        # 필수 필드 검증
                        machine_no = setup_data.get('machine_no')
                        part_no = setup_data.get('part_no', '').strip().upper()
                        model_code = setup_data.get('model_code', '').strip()
                        target_cycle_time = setup_data.get('target_cycle_time')
                        standard_cycle_time = setup_data.get('standard_cycle_time')
                        mean_cycle_time = setup_data.get('mean_cycle_time')
                        personnel_count = setup_data.get('personnel_count')

                        if not machine_no:
                            errors.append(f"Row {i+1}: 사출기 번호가 필요합니다.")
                            continue

                        if not part_no:
                            errors.append(f"Row {i+1}: Part No.가 필요합니다.")
                            continue

                        if not target_cycle_time:
                            errors.append(f"Row {i+1}: 목표 사이클 타임이 필요합니다.")
                            continue

                        # 기존 설정 검사
                        existing = CycleTimeSetup.objects.filter(
                            setup_date__date=setup_date,
                            machine_no=machine_no,
                            part_no=part_no
                        ).first()

                        if existing:
                            if duplicate_action == 'update_existing':
                                # 기존 설정 수정
                                existing.target_cycle_time = target_cycle_time
                                existing.model_code = model_code
                                if standard_cycle_time:
                                    existing.standard_cycle_time = standard_cycle_time
                                if mean_cycle_time:
                                    existing.mean_cycle_time = mean_cycle_time
                                if personnel_count is not None:
                                    existing.personnel_count = personnel_count
                                existing.note = setup_data.get('note', existing.note)
                                existing.setup_date = timezone.now()
                                existing.setup_by = request.user
                                existing.save()
                                updated_setups.append(existing)
                            elif duplicate_action == 'new_version':
                                # 기존 설정은 그대로 유지 (이력 보존)
                                pass

                                # 새 버전 생성
                                setup_fields = {
                                    'machine_no': machine_no,
                                    'part_no': part_no,
                                    'model_code': model_code,
                                    'target_cycle_time': target_cycle_time,
                                    'note': setup_data.get('note', ''),
                                    'setup_by': request.user
                                }
                                if standard_cycle_time:
                                    setup_fields['standard_cycle_time'] = standard_cycle_time
                                if mean_cycle_time:
                                    setup_fields['mean_cycle_time'] = mean_cycle_time
                                if personnel_count is not None:
                                    setup_fields['personnel_count'] = personnel_count

                                setup = CycleTimeSetup.objects.create(**setup_fields)
                                created_setups.append(setup)
                            else:
                                errors.append(f"Row {i+1}: {machine_no}번기의 {part_no}는 이미 설정되어 있습니다.")
                                continue
                        else:
                            # 새 셋업 생성
                            setup_fields = {
                                'machine_no': machine_no,
                                'part_no': part_no,
                                'model_code': model_code,
                                'target_cycle_time': target_cycle_time,
                                'note': setup_data.get('note', ''),
                                'setup_by': request.user
                            }
                            if standard_cycle_time:
                                setup_fields['standard_cycle_time'] = standard_cycle_time
                            if mean_cycle_time:
                                setup_fields['mean_cycle_time'] = mean_cycle_time
                            if personnel_count is not None:
                                setup_fields['personnel_count'] = personnel_count

                            setup = CycleTimeSetup.objects.create(**setup_fields)
                            created_setups.append(setup)

                    except Exception as e:
                        errors.append(f"Row {i+1}: {str(e)}")

                # 에러가 있으면 전체 롤백
                if errors:
                    raise Exception("Validation errors occurred")

        except Exception:
            return Response({'errors': errors}, status=status.HTTP_400_BAD_REQUEST)

        # 결과 반환
        result = {
            'created_count': len(created_setups),
            'updated_count': len(updated_setups)
        }

        if created_setups:
            result['created_setups'] = self.get_serializer(created_setups, many=True).data
        if updated_setups:
            result['updated_setups'] = self.get_serializer(updated_setups, many=True).data

        return Response(result, status=status.HTTP_201_CREATED)


class CycleTimeTestRecordViewSet(viewsets.ModelViewSet):
    queryset = CycleTimeTestRecord.objects.all()
    serializer_class = CycleTimeTestRecordSerializer
    permission_classes = [InjectionPermission]

    def get_queryset(self):
        queryset = super().get_queryset()
        setup_id = self.request.query_params.get('setup_id')

        if setup_id:
            queryset = queryset.filter(setup_id=setup_id)

        return queryset.select_related('setup', 'tested_by')

    def perform_create(self, serializer):
        serializer.save(tested_by=self.request.user)

class InjectionMonitoringRecordListView(generics.ListAPIView):
    """사출기 모니터링 시계열 데이터 조회 API (기존 호환성)"""
    serializer_class = InjectionMonitoringRecordSerializer
    permission_classes = [AllowAny] # 필요에 따라 IsAuthenticated 등으로 변경

    def get_queryset(self):
        queryset = InjectionMonitoringRecord.objects.all()

        # URL query parameter로 필터링
        device_codes = self.request.query_params.getlist('device_code')
        start_date = self.request.query_params.get('start_date')
        end_date = self.request.query_params.get('end_date')

        if device_codes:
            queryset = queryset.filter(device_code__in=device_codes)

        if start_date:
            queryset = queryset.filter(timestamp__date__gte=start_date)

        if end_date:
            queryset = queryset.filter(timestamp__date__lte=end_date)

        return queryset.order_by('timestamp', 'device_code')

class MesRawDebugView(generics.GenericAPIView):
    """MES 원시 응답 점검용 디버그 API"""
    permission_classes = [AllowAny]

    def get(self, request):
        from datetime import datetime, timedelta
        try:
            from .mes_service import mes_service
        except Exception as e:
            return Response({'error': f'mes_service import error: {e}'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        # 입력 파라미터
        machine = request.query_params.get('machine', '1')
        hours = int(request.query_params.get('hours', '12'))
        size = int(request.query_params.get('size', '500'))

        end_time = datetime.now()
        begin_time = end_time - timedelta(hours=hours)

        try:
            # 장비코드 매핑을 확인하기 위해 내부 매핑 함수를 사용
            device_code = mes_service._map_machine_to_device_code(int(machine))
        except Exception:
            device_code = str(machine)

        raw = mes_service.get_resource_monitoring_data(
            device_code=device_code,
            begin_time=begin_time,
            end_time=end_time,
            size=size,
            param_types=None  # 모든 타입 수집해서 전수 확인
        ) or {}

        data_list = raw.get('list', []) or []
        # 파라미터명/코드/단위/타입 집계
        param_names = {}
        earliest = None
        latest = None
        for rec in data_list:
            name = rec.get('paramName') or ''
            code = rec.get('paramId') or rec.get('paramCode')
            unit = rec.get('paramUnit') or ''
            ptype = (rec.get('paramType') or {}).get('message') or ''
            key = f"{name}:{code}:{unit}:{ptype}" if code is not None else f"{name}::${unit}:{ptype}"
            param_names[key] = param_names.get(key, 0) + 1
            ts = rec.get('recordTime') or rec.get('ts')
            if ts:
                earliest = ts if earliest is None or ts < earliest else earliest
                latest = ts if latest is None or ts > latest else latest

        # 상위 10개 파라미터 이름만 노출
        top_params = sorted(param_names.items(), key=lambda x: x[1], reverse=True)[:20]

        return Response({
            'machine': machine,
            'device_code_used': device_code,
            'records_count': len(data_list),
            'top_param_names': top_params,
            'earliest_ts': earliest,
            'latest_ts': latest,
            'sample': data_list[:10],
        })

class ResourceMonitorPageListView(generics.GenericAPIView):
    """BLACKLAKE API 스펙을 따르는 자원 파라미터 모니터링 목록 API"""
    permission_classes = [AllowAny]

    def post(self, request):
        """
        BLACKLAKE 스펙에 따른 자원 모니터링 데이터 조회
        POST /resource/open/v1/resource_monitor/_page_list
        """
        from datetime import datetime
        import pytz

        # 요청 데이터 파싱
        data = request.data
        device_code = data.get('deviceCode')
        begin_record_time = data.get('beginRecordTime')  # 13자리 timestamp
        end_record_time = data.get('endRecordTime')  # 13자리 timestamp
        page = data.get('page', 1)
        size = data.get('size', 20)

        # 필수 파라미터 검증
        if not device_code:
            return Response({
                'code': 400,
                'message': '설비 코드가 필요합니다',
                'subCode': '400001'
            }, status=status.HTTP_400_BAD_REQUEST)

        if not begin_record_time and not end_record_time:
            return Response({
                'code': 400,
                'message': '시작시간과 종료시간 중 적어도 하나는 필요합니다',
                'subCode': '400002'
            }, status=status.HTTP_400_BAD_REQUEST)

        # QuerySet 구성
        queryset = InjectionMonitoringRecord.objects.filter(device_code=device_code)

        # 시간 필터링 (13자리 timestamp를 datetime으로 변환)
        timezone_kst = pytz.timezone('Asia/Shanghai')

        if begin_record_time:
            try:
                begin_dt = datetime.fromtimestamp(begin_record_time / 1000, tz=timezone_kst)
                queryset = queryset.filter(timestamp__gte=begin_dt)
            except (ValueError, OSError):
                return Response({
                    'code': 400,
                    'message': '잘못된 시작시간 형식입니다',
                    'subCode': '400003'
                }, status=status.HTTP_400_BAD_REQUEST)

        if end_record_time:
            try:
                end_dt = datetime.fromtimestamp(end_record_time / 1000, tz=timezone_kst)
                queryset = queryset.filter(timestamp__lt=end_dt)  # 개구간
            except (ValueError, OSError):
                return Response({
                    'code': 400,
                    'message': '잘못된 종료시간 형식입니다',
                    'subCode': '400004'
                }, status=status.HTTP_400_BAD_REQUEST)

        # 정렬
        queryset = queryset.order_by('-timestamp')  # 최신순

        # 페이지네이션
        total_count = queryset.count()
        start_idx = (page - 1) * size
        end_idx = start_idx + size
        page_queryset = queryset[start_idx:end_idx]

        # BLACKLAKE 스펙에 맞는 응답 데이터 구성
        resource_monitors = []
        for record in page_queryset:
            # timestamp를 13자리 밀리초로 변환
            record_time_ms = int(record.timestamp.timestamp() * 1000)

            resource_monitors.append({
                'deviceId': None,  # 없으면 null
                'resourceId': record.device_code,
                'resourceName': record.machine_name,
                'paramId': 1,  # capacity용 고정 ID
                'paramName': '생산량',
                'paramUnit': 'EA',
                'paramType': {'code': 1, 'message': '자원파라미터'},
                'paramClassification': '생산성능',
                'val': str(record.capacity) if record.capacity is not None else None,
                'recordTime': record_time_ms,
                'ts': record_time_ms,
                'beginTime': None,
                'endTime': None,
                'refTaskId': None,
                'refTaskType': None,
                'createType': {'code': 1, 'message': '자동수집'},
                'rpStatus': {'code': 1, 'message': '정상'} if record.capacity else {'code': 2, 'message': '이상'},
                'rpStandardVal': None,
                'rpUpLimit': None,
                'rpUpsLimit': None,
                'rpDownLimit': None,
                'rpDownsLimit': None,
                'ppStatus': None,
                'ppStandardVal': None,
                'ppUpLimit': None,
                'ppUpsLimit': None,
                'ppDownLimit': None,
                'ppDownsLimit': None
            })

            # 오일온도 데이터도 추가 (별도 파라미터로)
            if record.oil_temperature is not None:
                resource_monitors.append({
                    'deviceId': None,
                    'resourceId': record.device_code,
                    'resourceName': record.machine_name,
                    'paramId': 2,  # oil_temperature용 고정 ID
                    'paramName': '오일온도',
                    'paramUnit': '°C',
                    'paramType': {'code': 1, 'message': '자원파라미터'},
                    'paramClassification': '온도관리',
                    'val': str(record.oil_temperature),
                    'recordTime': record_time_ms,
                    'ts': record_time_ms,
                    'beginTime': None,
                    'endTime': None,
                    'refTaskId': None,
                    'refTaskType': None,
                    'createType': {'code': 1, 'message': '자동수집'},
                    'rpStatus': {'code': 1, 'message': '정상'},  # 온도는 기본 정상으로
                    'rpStandardVal': None,
                    'rpUpLimit': None,
                    'rpUpsLimit': None,
                    'rpDownLimit': None,
                    'rpDownsLimit': None,
                    'ppStatus': None,
                    'ppStandardVal': None,
                    'ppUpLimit': None,
                    'ppUpsLimit': None,
                    'ppDownLimit': None,
                    'ppDownsLimit': None
                })

            # 전력(kWh) 데이터 추가
            if record.power_kwh is not None:
                resource_monitors.append({
                    'deviceId': None,
                    'resourceId': record.device_code,
                    'resourceName': record.machine_name,
                    'paramId': 3,
                    'paramName': '电能',
                    'paramUnit': 'kWh',
                    'paramType': {'code': 1, 'message': '资源参数'},
                    'paramClassification': '能耗',
                    'val': str(record.power_kwh),
                    'recordTime': record_time_ms,
                    'ts': record_time_ms,
                    'beginTime': None,
                    'endTime': None,
                    'refTaskId': None,
                    'refTaskType': None,
                    'createType': {'code': 1, 'message': '自动采集'},
                    'rpStatus': {'code': 1, 'message': '正常'},
                    'rpStandardVal': None,
                    'rpUpLimit': None,
                    'rpUpsLimit': None,
                    'rpDownLimit': None,
                    'rpDownsLimit': None,
                    'ppStatus': None,
                    'ppStandardVal': None,
                    'ppUpLimit': None,
                    'ppUpsLimit': None,
                    'ppDownLimit': None,
                    'ppDownsLimit': None
                })

        # BLACKLAKE 표준 응답 형식
        response_data = {
            'code': 200,
            'message': '성공',
            'subCode': '100001',
            'needCheck': 0,
            'fieldPermission': {
                'encoding': 'UTF-8',
                'noAccess': [],
                'readonly': []
            },
            'data': {
                'page': page,
                'total': total_count * 2,  # capacity + oil_temperature 각각 카운트
                'list': resource_monitors
            }
        }

        return Response(response_data)





import re
from datetime import datetime, timedelta, timezone as dt_timezone

# 중국 시간대 (UTC+8)
CST = dt_timezone(timedelta(hours=8))

def get_machine_name_from_device_code(device_code):
    """deviceCode에서 호기 번호를 추출합니다 (예: '1050T-16' -> '16호기')."""
    match = re.search(r'-(\d+)', device_code)
    return f"{match.group(1)}호기" if match else device_code


class ProductionMatrixView(generics.GenericAPIView):
    """사출기 생산 매트릭스 뷰 - MES API 우선, 실패 시 DB 폴백"""
    permission_classes = [AllowAny]

    def get_machine_info(self):
        """실제 사출기 목록과 톤수 정보 조회"""
        # 실제 사용 중인 사출기 번호들을 생산 기록에서 추출
        machine_nos = list(InjectionReport.objects.values_list('machine_no', flat=True).distinct().order_by('machine_no'))

        # 추가로 설정된 사출기 번호들도 포함
        setup_machine_nos = list(CycleTimeSetup.objects.values_list('machine_no', flat=True).distinct())

        # 통합하고 정렬
        all_machine_nos = sorted(set(machine_nos + setup_machine_nos))

        # 기본 1-17호기가 없으면 추가
        if not all_machine_nos:
            all_machine_nos = list(range(1, 18))

        # 각 사출기의 대표 톤수 조회 (가장 최근 기록) - 기본 매핑 반영
        machine_info = {}
        for machine_no in all_machine_nos:
            # 가장 최근 보고서에서 톤수 정보 조회
            recent_report = InjectionReport.objects.filter(
                machine_no=machine_no,
                tonnage__isnull=False
            ).exclude(tonnage='').order_by('-date', '-id').first()

            # 기본 매핑: 번호별 톤수
            default_tonnage_map = {
                1: '850T', 2: '850T', 3: '1300T', 4: '1400T', 5: '1400T', 6: '2500T',
                7: '1300T', 8: '850T', 9: '850T', 10: '650T', 11: '550T', 12: '550T',
                13: '450T', 14: '850T', 15: '650T', 16: '1050T', 17: '1200T'
            }
            tonnage = recent_report.tonnage if recent_report else default_tonnage_map.get(machine_no, f'{machine_no * 50}T')

            machine_info[machine_no] = {
                'name': f'{machine_no}호기',
                'tonnage': tonnage
            }

        return machine_info

    def get(self, request):
        """생산 매트릭스 데이터 조회 - 30분/1시간 단위, 13열 지원(MES 고정)"""
        from .mes_service import mes_service

        # 파라미터 처리
        interval_type = request.query_params.get('interval', '30min')  # '10min', '30min', '1hour', or '1day'
        columns = int(request.query_params.get('columns', '13'))  # 기본 13열

        # 1) MES 우선 시도 (항상)
        try:
            mes_data = mes_service.get_production_matrix(interval_type=interval_type, columns=columns)
            
            # mes_data가 비어있거나 mes_source가 없는 경우, 에러로 간주
            if not mes_data or not mes_data.get('mes_source'):
                raise Exception("MES 서비스에서 유효한 데이터를 받지 못했습니다 (mes_data is empty or missing 'mes_source').")
            
            return Response(mes_data)

        except Exception as e:
            # 에러를 프론트엔드로 전달
            error_message = f"MES API error: {str(e)}"
            print(error_message) # 서버 로그에 에러 기록
            return Response(
                {"message": "MES 데이터 조회에 실패했습니다. MES 서비스 상태 또는 API 인증 정보를 확인해주세요.", "details": error_message},
                status=status.HTTP_502_BAD_GATEWAY
            )


class MachineListView(generics.GenericAPIView):
    """사출기 목록 뷰"""
    permission_classes = [AllowAny]

    def get(self, request):
        """사출기 목록 반환"""
        # ProductionMatrixView의 실제 사출기 정보 조회 로직 재사용
        matrix_view = ProductionMatrixView()
        machine_info = matrix_view.get_machine_info()

        machines = []
        for num, info in machine_info.items():
            machines.append({
                'machine_number': num,
                'machine_name': info['name'],
                'tonnage': info['tonnage'],
                'display_name': f"{info['name']} - {info['tonnage']}"
            })

        return Response({'machines': machines})


class SingleDeviceMonitorView(generics.GenericAPIView):
    permission_classes = [AllowAny]

    def get(self, request, *args, **kwargs):
        device_code = request.query_params.get('device_code')
        if not device_code:
            return Response({'error': 'device_code is required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            import requests
            from .models import InjectionMonitoringRecord
            from inventory.mes import get_access_token, MES_BASE_URL, MES_ROUTE_BASE

            token = get_access_token()
            api_endpoint = f"{MES_ROUTE_BASE}/resource/open/v1/resource_monitor/_page_list"
            url = f"{MES_BASE_URL}{api_endpoint}?access_token={token}"

            now_cst = datetime.now(CST)
            record_time = now_cst.replace(minute=0, second=0, microsecond=0)
            start_time = record_time - timedelta(hours=1)
            begin_record_time = int(start_time.timestamp() * 1000)
            end_record_time = int(record_time.timestamp() * 1000)

            body = {
                "deviceCode": device_code,
                "beginRecordTime": begin_record_time,
                "endRecordTime": end_record_time,
                "page": 1,
                "size": 500
            }

            resp = requests.post(url, json=body, timeout=120)
            resp.raise_for_status()

            response_data = resp.json()
            if response_data.get('code') != 200:
                return Response({'error': f"API error: {response_data.get('message')}"}, status=status.HTTP_502_BAD_GATEWAY)

            records = response_data.get('data', {}).get('list', [])
            
            latest_capacity = None
            latest_oil_temp = None
            latest_power = None

            for record in sorted(records, key=lambda x: x.get('recordTime', 0), reverse=True):
                param_name = record.get('paramName')
                if param_name == '产能' and latest_capacity is None:
                    try: latest_capacity = float(record.get('val'))
                    except (ValueError, TypeError): pass
                elif param_name == '油温' and latest_oil_temp is None:
                    try: latest_oil_temp = float(record.get('val'))
                    except (ValueError, TypeError): pass
                elif param_name == '电能' and latest_power is None:
                    try: latest_power = float(record.get('val'))
                    except (ValueError, TypeError): pass
                if latest_capacity is not None and latest_oil_temp is not None and latest_power is not None: break

            machine_name = get_machine_name_from_device_code(device_code)
            
            obj, created = InjectionMonitoringRecord.objects.update_or_create(
                device_code=device_code,
                timestamp=record_time,
                defaults={
                    'machine_name': machine_name,
                    'capacity': latest_capacity,
                    'oil_temperature': latest_oil_temp,
                    'power_kwh': latest_power,
                }
            )
            
            serializer = InjectionMonitoringRecordSerializer(obj)
            return Response(serializer.data, status=status.HTTP_200_OK)

        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class ProductionPlanUploadView(generics.GenericAPIView):
    """Upload production-plan workbooks for injection or machining."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request, *args, **kwargs):
        uploaded_file = request.FILES.get("file")
        plan_type = request.data.get("plan_type")
        target_date = request.data.get("date")

        if not uploaded_file:
            return Response(
                {"error": "파일이 제공되지 않았습니다."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            processor = ProductionPlanProcessor(uploaded_file, plan_type, target_date)
            response_data = processor.process()
        except ProductionPlanProcessingError as exc:
            return Response(
                {"error": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # --- Begin: Save processed data to the database ---
        try:
            with transaction.atomic():
                # 1. Get the date range and plan type from the processed data
                available_days = response_data.get("available_days", [])
                plan_type = response_data.get("plan_type")

                if available_days and plan_type:
                    # 2. Delete all existing plan entries within this date range for this plan type
                    ProductionPlan.objects.filter(
                        plan_date__in=available_days,
                        plan_type=plan_type
                    ).delete()

                # 3. Create new records from the 'plan_long' data
                plan_long_data = response_data.get("plan_long", [])
                plans_to_create = []
                for i, record in enumerate(plan_long_data):
                    plan_qty = record.get("plan_qty")
                    try:
                        plan_qty = int(round(float(plan_qty)))
                    except (TypeError, ValueError):
                        plan_qty = 0
                    if plan_qty <= 0:
                        continue
                    plans_to_create.append(
                        ProductionPlan(
                            plan_date=record.get("date"),
                            plan_type=record.get("plan_type"),
                            machine_name=record.get("machine"),
                            lot_no=record.get("lot_no"),
                            model_name=record.get("model"),
                            part_spec=record.get("part_spec"),
                            part_no=record.get("fg_part_no"), # fg_part_no is mapped to part_no
                            planned_quantity=plan_qty,
                            sequence=record.get("original_order", i) # Use original_order, with i as fallback
                        )
                    )
                
                ProductionPlan.objects.bulk_create(plans_to_create)

        except Exception as e:
            # If the database operation fails, return an error.
            # The file processing was successful, but saving failed.
            return Response(
                {"error": f"데이터베이스 저장 중 오류가 발생했습니다: {str(e)}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        # --- End: Save logic ---

        # Return the original response data to the frontend
        return Response(response_data)


