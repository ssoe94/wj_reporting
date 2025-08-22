from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.generics import ListAPIView
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters
from django_filters import rest_framework as df_filters
from .serializers import FactInventorySerializer
from .models import FactInventory, StagingInventory
from django.core.management import call_command
from rest_framework.pagination import PageNumberPagination
from django.http import HttpResponse
from django.db.models import Case, When, F, CharField, Max
import csv
from io import StringIO


import threading
import time
from django.core.cache import cache
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.db.models import Q, Sum, Count
from django.utils import timezone
from datetime import datetime, timedelta
from decimal import Decimal
from .models import StagingInventory, FactInventory, DailyInventorySnapshot, DailyReportSummary
from .serializers import (
    StagingInventorySerializer, 
    FactInventorySerializer, 
    DailyInventorySnapshotSerializer,
    DailyReportSerializer
)


class InventoryRefreshView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        # 백그라운드에서 실행
        def run_fetch():
            call_command('fetch_inventory')
        
        thread = threading.Thread(target=run_fetch)
        thread.start()
        
        return Response({'status': 'started'})
    
    def get(self, request):
        # 진행 상황 조회
        progress = cache.get('inventory_fetch_progress', {
            'current': 0,
            'total': 0,
            'status': 'idle'
        })
        return Response(progress)


class MESTokenTestView(APIView):
    """MES API 토큰 테스트용 디버깅 엔드포인트"""
    permission_classes = []  # 인증 없이 접근 가능하도록 변경
    
    def get(self, request):
        from inventory.mes import get_access_token, call_inventory_list
        import os
        from decouple import config
        
        try:
            # 환경 변수 확인
            env_info = {
                'MES_API_BASE': os.getenv('MES_API_BASE', 'https://v3-ali.blacklake.cn'),
                'MES_APP_KEY_exists': bool(os.getenv('MES_APP_KEY') or config('MES_APP_KEY', default='')),
                'MES_APP_SECRET_exists': bool(os.getenv('MES_APP_SECRET') or config('MES_APP_SECRET', default='')),
                'MES_ACCESS_TOKEN_exists': bool(os.getenv('MES_ACCESS_TOKEN') or config('MES_ACCESS_TOKEN', default='')),
                'MES_USER_CODE_exists': bool(os.getenv('MES_USER_CODE') or config('MES_USER_CODE', default=''))
            }
            
            # 토큰 가져오기 시도
            try:
                token = get_access_token()
                token_info = {
                    'token_exists': bool(token),
                    'token_length': len(token) if token else 0
                }
            except Exception as token_error:
                token_info = {
                    'token_error': str(token_error)
                }
            
            # 실제 API 호출 테스트
            try:
                data = call_inventory_list(page=1, size=1)
                api_test = {
                    'api_call_success': True,
                    'response_type': type(data).__name__,
                    'has_data': bool(data),
                    'response_keys': list(data.keys()) if isinstance(data, dict) else None
                }
            except Exception as api_error:
                api_test = {
                    'api_call_success': False,
                    'api_error': str(api_error)
                }
            
            return Response({
                'environment': env_info,
                'token': token_info,
                'api_test': api_test
            })
            
        except Exception as e:
            return Response({
                'error': str(e)
            }, status=500)


class LastUpdateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        # 가장 최근 업데이트 시간 조회
        latest_update = StagingInventory.objects.aggregate(
            latest=Max('updated_at')
        )['latest']
        
        return Response({
            'last_update': latest_update.isoformat() if latest_update else None
        })


class InventoryPagination(PageNumberPagination):
    page_size_query_param = 'size'
    page_query_param = 'page'


# --- filters ---
class CharInFilter(df_filters.BaseInFilter, df_filters.CharFilter):
    pass

class InventoryFilter(df_filters.FilterSet):
    warehouse_code__in = CharInFilter(field_name='warehouse_code', lookup_expr='in')
    qc_status = df_filters.CharFilter(field_name='qc_status')
    updated_at__gte = df_filters.DateTimeFilter(field_name='updated_at', lookup_expr='gte')
    updated_at__lte = df_filters.DateTimeFilter(field_name='updated_at', lookup_expr='lte')

    class Meta:
        model = StagingInventory
        fields = ['warehouse_code', 'warehouse_code__in', 'qc_status', 'updated_at__gte', 'updated_at__lte']

# --- list view ---
class InventoryListView(ListAPIView):
    serializer_class = FactInventorySerializer
    pagination_class = InventoryPagination
    queryset = StagingInventory.objects.all()
    permission_classes = [IsAuthenticated]
    filter_backends = [DjangoFilterBackend, filters.SearchFilter]
    filterset_class = InventoryFilter
    search_fields = ['qr_code', 'label_code', 'material_code', 'specification', 'material_name']

    def get_queryset(self):
        queryset = StagingInventory.objects.all()
        
        # 정렬 파라미터 처리
        sort_field = self.request.query_params.get('sort_field', '')
        sort_order = self.request.query_params.get('sort_order', 'asc')
        
        if sort_field:
            # 필드별 정렬 처리
            if sort_field == 'qr_code':
                # qr_code, label_code, material_id 순서로 정렬
                from django.db.models import F, Value
                queryset = queryset.annotate(
                    sort_key=Case(
                        When(qr_code__isnull=False, then=F('qr_code')),
                        When(label_code__isnull=False, then=F('label_code')),
                        default=F('material_id'),
                        output_field=CharField(),
                    )
                ).order_by(f'{"-" if sort_order == "desc" else ""}sort_key')
            elif sort_field == 'quantity':
                queryset = queryset.order_by(f'{"-" if sort_order == "desc" else ""}quantity')
            elif sort_field == 'updated_at':
                queryset = queryset.order_by(f'{"-" if sort_order == "desc" else ""}updated_at')
            elif sort_field in ['material_code', 'specification', 'warehouse_name', 'qc_status', 'work_order_code']:
                queryset = queryset.order_by(f'{"-" if sort_order == "desc" else ""}{sort_field}')
        else:
            # 기본 정렬: 최신 업데이트 순
            queryset = queryset.order_by('-updated_at')
        
        return queryset


class WarehouseListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        # 창고 이름별로 고유한 값만 가져오기
        warehouses = {}
        for item in StagingInventory.objects.values('warehouse_code', 'warehouse_name'):
            if item['warehouse_code'] and item['warehouse_name']:
                # warehouse_name을 키로 사용하여 중복 제거
                warehouses[item['warehouse_name']] = {
                    'warehouse_code': item['warehouse_code'],
                    'warehouse_name': item['warehouse_name']
                }
        return Response(list(warehouses.values()))


class InventoryExportView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        # Apply the same filters and sorting as the list view
        queryset = StagingInventory.objects.all()
        
        # Apply filters
        filterset = InventoryFilter(request.GET, queryset=queryset)
        queryset = filterset.qs
        
        # Apply search
        search = request.GET.get('search')
        if search:
            from django.db.models import Q
            queryset = queryset.filter(
                Q(qr_code__icontains=search) |
                Q(label_code__icontains=search) |
                Q(material_code__icontains=search) |
                Q(specification__icontains=search) |
                Q(material_name__icontains=search)
            )
        
        # Apply sorting (same logic as InventoryListView)
        sort_field = request.GET.get('sort_field', '')
        sort_order = request.GET.get('sort_order', 'asc')
        
        if sort_field:
            if sort_field == 'qr_code':
                queryset = queryset.annotate(
                    sort_key=Case(
                        When(qr_code__isnull=False, then=F('qr_code')),
                        When(label_code__isnull=False, then=F('label_code')),
                        default=F('material_id'),
                        output_field=CharField(),
                    )
                ).order_by(f'{"-" if sort_order == "desc" else ""}sort_key')
            elif sort_field == 'quantity':
                queryset = queryset.order_by(f'{"-" if sort_order == "desc" else ""}quantity')
            elif sort_field == 'updated_at':
                queryset = queryset.order_by(f'{"-" if sort_order == "desc" else ""}updated_at')
            elif sort_field in ['material_code', 'specification', 'warehouse_name', 'qc_status', 'work_order_code']:
                queryset = queryset.order_by(f'{"-" if sort_order == "desc" else ""}{sort_field}')
        else:
            queryset = queryset.order_by('-updated_at')
        
        # Limit to 10000 records for CSV export
        queryset = queryset[:10000]
        
        # Create CSV response
        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="inventory_export.csv"'
        
        # Write CSV with BOM for proper Chinese character encoding
        response.write('\ufeff')  # BOM for UTF-8
        
        writer = csv.writer(response)
        
        # Write headers
        writer.writerow([
            '更新时间', '标识码', '物料编号', '物料规格', '数量', 
            '仓库', '质量状态', '生产工单编号'
        ])
        
        # Write data
        for item in queryset:
            qc_status_map = {
                '1': '合格',
                '2': '让步合格', 
                '3': '待检',
                '4': '不合格'
            }
            qc_status = qc_status_map.get(str(item.qc_status), str(item.qc_status) if item.qc_status else '-')
            
            writer.writerow([
                item.updated_at.strftime('%Y-%m-%d %H:%M'),  # 분 단위까지만
                item.qr_code or item.label_code or str(item.material_id),
                item.material_code,
                getattr(item, 'specification', '') or '-',
                str(item.quantity),
                item.warehouse_name,
                qc_status,
                getattr(item, 'work_order_code', '') or '-'
            ])
        
        return response 


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def inventory_status(request):
    """재고 상세 현황 API"""
    # 파라미터 처리
    page = int(request.GET.get('page', 1))
    size = int(request.GET.get('size', 100))
    search = request.GET.get('search', '')
    warehouse_code_in = request.GET.get('warehouse_code__in', '')
    qc_status = request.GET.get('qc_status', '')
    updated_at_gte = request.GET.get('updated_at__gte', '')
    updated_at_lte = request.GET.get('updated_at__lte', '')
    sort_field = request.GET.get('sort_field', '')
    sort_order = request.GET.get('sort_order', 'asc')

    # 쿼리셋 생성 - StagingInventory 사용
    queryset = StagingInventory.objects.all()

    # 검색 필터
    if search:
        queryset = queryset.filter(
            Q(qr_code__icontains=search) |
            Q(label_code__icontains=search) |
            Q(material_code__icontains=search) |
            Q(specification__icontains=search)
        )

    # 창고 필터
    if warehouse_code_in:
        warehouse_codes = warehouse_code_in.split(',')
        queryset = queryset.filter(warehouse_code__in=warehouse_codes)

    # QC 상태 필터
    if qc_status:
        queryset = queryset.filter(qc_status=qc_status)

    # 날짜 필터
    if updated_at_gte:
        queryset = queryset.filter(updated_at__gte=updated_at_gte)
    if updated_at_lte:
        queryset = queryset.filter(updated_at__lte=updated_at_lte)

    # 정렬
    if sort_field:
        if sort_order == 'desc':
            sort_field = f'-{sort_field}'
        queryset = queryset.order_by(sort_field)
    else:
        queryset = queryset.order_by('-updated_at')

    # 페이지네이션
    total = queryset.count()
    start = (page - 1) * size
    end = start + size
    results = queryset[start:end]

    # 시리얼라이징 - StagingInventorySerializer 사용
    serializer = StagingInventorySerializer(results, many=True)

    return Response({
        'results': serializer.data,
        'total': total,
        'page': page,
        'size': size,
        'pages': (total + size - 1) // size
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def daily_report(request):
    """일일 보고서 API"""
    # 파라미터 처리
    date_str = request.GET.get('date', '')
    warehouse_code = request.GET.get('warehouse_code', '')
    material_code = request.GET.get('material_code', '')
    
    # 날짜 결정 (기본값: 오늘)
    if date_str:
        try:
            report_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': '잘못된 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.'},
                status=status.HTTP_400_BAD_REQUEST
            )
    else:
        report_date = timezone.now().date()

    # 전일 날짜 계산
    prev_date = report_date - timedelta(days=1)

    # 쿼리셋 생성
    queryset = DailyInventorySnapshot.objects.filter(snapshot_date=report_date)

    # 필터 적용
    if warehouse_code:
        queryset = queryset.filter(warehouse_code=warehouse_code)
    if material_code:
        queryset = queryset.filter(material_code__icontains=material_code)
    
    # 창고 타입 필터링 (warehouse_name 기반)
    warehouse_type = request.GET.get('warehouse_type', '')
    # print(f"Requested warehouse_type: {warehouse_type}")
    
    if warehouse_type == 'finished':
        # 成品仓库만 포함
        queryset = queryset.filter(warehouse_name='成品仓库')
        # print(f"Filtering: finished warehouse, count: {queryset.count()}")
        # 필터링된 창고 이름들 출력
        warehouse_names = queryset.values_list('warehouse_name', flat=True).distinct()
        # print(f"Filtered warehouses: {list(warehouse_names)}")
    elif warehouse_type == 'semi':
        # 半成品仓库만 포함 (다른 창고들은 제외)
        queryset = queryset.filter(warehouse_name='半成品仓库')
        # print(f"Filtering: semi-finished warehouse, count: {queryset.count()}")
        # 필터링된 창고 이름들 출력
        warehouse_names = queryset.values_list('warehouse_name', flat=True).distinct()
        # print(f"Filtered warehouses: {list(warehouse_names)}")
    else:
        # 기본값: 제품창고와 반제품창고만 포함
        queryset = queryset.filter(
            warehouse_name__in=['成品仓库', '半成品仓库', '注塑车间仓库', '加工车间仓库']
        )
        # print(f"Default filtering: finished+semi warehouses, count: {queryset.count()}")
        warehouse_names = queryset.values_list('warehouse_name', flat=True).distinct()
        # print(f"Filtered warehouses: {list(warehouse_names)}")
    
    # 검색 디버깅
    if material_code:
        # print(f"Search term: {material_code}, filtered count: {queryset.count()}")
        if queryset.count() == 0:
            # 전체 데이터에서 해당 제품 검색
            all_items = DailyInventorySnapshot.objects.filter(snapshot_date=report_date)
            matching_items = all_items.filter(material_code__icontains=material_code)
            # print(f"Search results for '{material_code}': {matching_items.count()} items")
            for item in matching_items[:5]:  # 처음 5개만 출력
                print(f"  - {item.material_code} @ {item.warehouse_name}")

    # 전일 데이터 조회
    prev_queryset = DailyInventorySnapshot.objects.filter(snapshot_date=prev_date)
    if warehouse_code:
        prev_queryset = prev_queryset.filter(warehouse_code=warehouse_code)
    if material_code:
        prev_queryset = prev_queryset.filter(material_code__icontains=material_code)
    
    # 창고 타입 필터링 (전일 데이터에도 적용)
    if warehouse_type == 'finished':
        prev_queryset = prev_queryset.filter(warehouse_name='成品仓库')
    elif warehouse_type == 'semi':
        prev_queryset = prev_queryset.filter(warehouse_name='半成品仓库')

    # 전일 데이터를 딕셔너리로 변환 (빠른 조회용)
    prev_data = {}
    for item in prev_queryset:
        key = (item.material_code, item.warehouse_code, item.qc_status)
        prev_data[key] = item

    # 결과 데이터 생성
    results = []
    for item in queryset:
        key = (item.material_code, item.warehouse_code, item.qc_status)
        prev_item = prev_data.get(key)
        
        # 증감 계산 (전날 데이터와 비교)
        prev_quantity = prev_item.total_quantity if prev_item else 0
        quantity_change = item.total_quantity - prev_quantity
        quantity_change_percent = None
        
        # 전날 수량이 0이 아닌 경우에만 변화율 계산
        if prev_quantity > 0:
            quantity_change_percent = (quantity_change / prev_quantity) * 100
        elif prev_quantity == 0 and item.total_quantity > 0:
            # 전날 0에서 오늘 양수면 100% 증가로 표시
            quantity_change_percent = 100.0
        elif prev_quantity == 0 and item.total_quantity == 0:
            # 둘 다 0이면 변화 없음
            quantity_change_percent = 0.0
            
        prev_cart_count = prev_item.cart_count if prev_item else 0
        cart_count_change = item.cart_count - prev_cart_count

        # 결과 데이터 구성
        result_data = {
            'snapshot_date': item.snapshot_date,
            'material_code': item.material_code,
            'material_name': item.material_name,
            'specification': item.specification,
            'warehouse_code': item.warehouse_code,
            'warehouse_name': item.warehouse_name,
            'qc_status': item.qc_status,
            'total_quantity': item.total_quantity,
            'unit': item.unit,
            'cart_count': item.cart_count,
            'cart_details': item.cart_details,
            'prev_quantity': prev_quantity,
            'quantity_change': quantity_change,
            'quantity_change_percent': quantity_change_percent,
            'prev_cart_count': prev_cart_count,
            'cart_count_change': cart_count_change,
        }
        results.append(result_data)

    # 시리얼라이징
    serializer = DailyReportSerializer(results, many=True)

    # 스냅샷 생성 시간 조회 (해당 날짜의 가장 최근 스냅샷)
    snapshot_created_at = None
    if queryset.exists():
        latest_snapshot = queryset.order_by('-created_at').first()
        snapshot_created_at = latest_snapshot.created_at

    return Response({
        'results': serializer.data,
        'report_date': report_date,
        'prev_date': prev_date,
        'total': len(results),
        'snapshot_created_at': snapshot_created_at
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def daily_report_summary(request):
    """일일 보고서 요약 API"""
    # 파라미터 처리
    date_str = request.GET.get('date', '')
    
    # 날짜 결정 (기본값: 오늘)
    if date_str:
        try:
            report_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': '잘못된 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.'},
                status=status.HTTP_400_BAD_REQUEST
            )
    else:
        report_date = timezone.now().date()

    # 전일 날짜 계산
    prev_date = report_date - timedelta(days=1)

    # 오늘 데이터 집계 (제품창고/반제품창고만)
    today_data = DailyInventorySnapshot.objects.filter(
        snapshot_date=report_date,
        warehouse_name__in=['成品仓库', '半成品仓库']
    ).aggregate(
        total_items=Count('id'),
        total_quantity=Sum('total_quantity'),
        total_carts=Sum('cart_count')
    )

    # 전일 데이터 집계 (제품창고/반제품창고만)
    prev_data = DailyInventorySnapshot.objects.filter(
        snapshot_date=prev_date,
        warehouse_name__in=['成品仓库', '半成品仓库']
    ).aggregate(
        total_items=Count('id'),
        total_quantity=Sum('total_quantity'),
        total_carts=Sum('cart_count')
    )

    # 창고별 요약 (제품창고/반제품창고만)
    warehouse_summary = DailyInventorySnapshot.objects.filter(
        snapshot_date=report_date,
        warehouse_name__in=['成品仓库', '半成品仓库']
    ).values(
        'warehouse_name'
    ).annotate(
        item_count=Count('id'),
        total_quantity=Sum('total_quantity'),
        cart_count=Sum('cart_count')
    ).order_by('warehouse_name')
    
    # 디버깅: 창고별 요약 출력
    # print(f"Warehouse summary data:")
    for summary in warehouse_summary:
        pass  # print(f"  {summary['warehouse_name']}: {summary['item_count']} items, qty {summary['total_quantity']}, carts {summary['cart_count']}")

    return Response({
        'report_date': report_date,
        'prev_date': prev_date,
        'today': {
            'total_items': today_data['total_items'] or 0,
            'total_quantity': float(today_data['total_quantity'] or 0),
            'total_carts': today_data['total_carts'] or 0,
        },
        'prev_day': {
            'total_items': prev_data['total_items'] or 0,
            'total_quantity': float(prev_data['total_quantity'] or 0),
            'total_carts': prev_data['total_carts'] or 0,
        },
        'warehouse_summary': list(warehouse_summary)
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def create_snapshot(request):
    """수동으로 스냅샷 생성"""
    from django.core.management import call_command
    from io import StringIO
    
    date_str = request.data.get('date', '')
    force = request.data.get('force', False)
    
    try:
        # StringIO를 사용하여 명령어 출력 캡처
        out = StringIO()
        call_command('create_daily_snapshot', date=date_str, force=force, stdout=out)
        output = out.getvalue()
        out.close()
        
        # 10일 이전의 오래된 스냅샷 데이터 자동 삭제
        ten_days_ago = timezone.now().date() - timedelta(days=10)
        deleted_snapshots = DailyInventorySnapshot.objects.filter(
            snapshot_date__lt=ten_days_ago
        ).delete()
        
        deleted_summaries = DailyReportSummary.objects.filter(
            snapshot_date__lt=ten_days_ago
        ).delete()
        
        cleanup_message = ""
        if deleted_snapshots[0] > 0 or deleted_summaries[0] > 0:
            cleanup_message = f"\n10일 이전 데이터 정리: 스냅샷 {deleted_snapshots[0]}개, 요약 {deleted_summaries[0]}개 삭제됨"
        
        return Response({
            'success': True,
            'message': '스냅샷이 성공적으로 생성되었습니다.' + cleanup_message,
            'output': output
        })
    except Exception as e:
        return Response({
            'success': False,
            'error': str(e)
        }, status=status.HTTP_500_INTERNAL_SERVER_ERROR) 


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def daily_report_calendar(request):
    """일일 보고서 달력 데이터 API (30일간)"""
    year = request.GET.get('year', timezone.now().year)
    month = request.GET.get('month', timezone.now().month)
    
    try:
        year = int(year)
        month = int(month)
    except ValueError:
        return Response(
            {'error': '잘못된 년도 또는 월입니다.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # 해당 월의 시작일과 종료일
    start_date = timezone.datetime(year, month, 1).date()
    end_date = (start_date.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    
    # 10일 이전 날짜 계산
    ten_days_ago = timezone.now().date() - timedelta(days=10)
    
    # 스냅샷 데이터 조회 (10일 이내만)
    snapshots = DailyInventorySnapshot.objects.filter(
        snapshot_date__gte=ten_days_ago,
        snapshot_date__lte=end_date
    ).values('snapshot_date').distinct()
    
    # 요약 데이터 조회 (10일 이내만)
    summaries = DailyReportSummary.objects.filter(
        snapshot_date__gte=ten_days_ago,
        snapshot_date__lte=end_date
    ).values('snapshot_date', 'is_email_sent', 'email_status')
    
    # 달력 데이터 구성
    calendar_data = {}
    
    # 스냅샷이 있는 날짜들
    snapshot_dates = {item['snapshot_date'] for item in snapshots}
    
    # 요약 데이터가 있는 날짜들
    summary_dates = {}
    for item in summaries:
        summary_dates[item['snapshot_date']] = {
            'has_summary': True,
            'email_sent': item['is_email_sent'],
            'email_status': item['email_status']
        }
    
    # 달력 데이터 생성 (오늘 날짜 이후는 제외)
    today = timezone.now().date()
    current_date = start_date
    while current_date <= end_date:
        # 미래 날짜는 달력에 표시하지 않음
        if current_date > today:
            current_date += timedelta(days=1)
            continue
            
        date_str = current_date.strftime('%Y-%m-%d')
        has_snapshot = current_date in snapshot_dates
        summary_info = summary_dates.get(current_date, {})
        
        if has_snapshot:
            calendar_data[date_str] = {
                'has_snapshot': True,
                'has_summary': summary_info.get('has_summary', False),
                'email_sent': summary_info.get('email_sent', False),
                'status': 'completed' if summary_info.get('has_summary') else 'partial'
            }
        else:
            # 10일 이내이지만 스냅샷이 없는 경우 (오늘 이전 날짜만)
            if current_date >= ten_days_ago:
                calendar_data[date_str] = {
                    'has_snapshot': False,
                    'has_summary': False,
                    'email_sent': False,
                    'status': 'missing'
                }
        
        current_date += timedelta(days=1)
    
    return Response({
        'calendar_data': calendar_data,
        'month': month,
        'year': year,
        'ten_days_ago': ten_days_ago.strftime('%Y-%m-%d')
    })

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def daily_report_available_dates(request):
    """사용 가능한 일일 보고서 날짜 목록 (10일간)"""
    # 10일 이전 날짜 계산
    ten_days_ago = timezone.now().date() - timedelta(days=10)
    
    # 스냅샷이 있는 날짜들 조회
    available_dates = DailyInventorySnapshot.objects.filter(
        snapshot_date__gte=ten_days_ago
    ).values_list('snapshot_date', flat=True).distinct().order_by('snapshot_date')
    
    return Response({
        'available_dates': [date.strftime('%Y-%m-%d') for date in available_dates],
        'ten_days_ago': ten_days_ago.strftime('%Y-%m-%d')
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def schedule_email_report(request):
    """일일 보고서 이메일 발송 예약 (개발 중 - 실제 발송 안함)"""
    date_str = request.data.get('date', '')
    recipients = request.data.get('recipients', [])
    scheduled_at = request.data.get('scheduled_at', None)
    
    # 날짜 결정
    if date_str:
        try:
            report_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': '잘못된 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.'},
                status=status.HTTP_400_BAD_REQUEST
            )
    else:
        report_date = timezone.now().date()
    
    # 요약 데이터 조회 또는 생성
    summary, created = DailyReportSummary.objects.get_or_create(
        snapshot_date=report_date,
        defaults={
            'total_items': 0,
            'total_quantity': 0,
            'total_carts': 0,
            'warehouse_summary': [],
            'is_email_sent': False,
        }
    )
    
    # 이메일 발송 정보 업데이트
    summary.email_recipients = recipients
    summary.email_status = 'pending'
    
    if scheduled_at:
        try:
            summary.email_scheduled_at = datetime.fromisoformat(scheduled_at.replace('Z', '+00:00'))
        except ValueError:
            return Response(
                {'error': '잘못된 예약 시간 형식입니다.'},
                status=status.HTTP_400_BAD_REQUEST
            )
    
    summary.save()
    
    # 개발 중 로그 출력 (실제 발송 안함)
    logger.info(f"이메일 발송 예약 (개발 중): {report_date}, 수신자: {recipients}")
    
    return Response({
        'message': '이메일 발송이 예약되었습니다. (개발 중 - 실제 발송되지 않습니다)',
        'date': report_date,
        'recipients': recipients,
        'status': 'pending'
    })

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def email_status(request):
    """이메일 발송 상태 조회"""
    date_str = request.GET.get('date', '')
    
    if date_str:
        try:
            report_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': '잘못된 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.'},
                status=status.HTTP_400_BAD_REQUEST
            )
    else:
        report_date = timezone.now().date()
    
    try:
        summary = DailyReportSummary.objects.get(snapshot_date=report_date)
        return Response({
            'date': report_date,
            'email_status': summary.email_status,
            'email_recipients': summary.email_recipients,
            'email_scheduled_at': summary.email_scheduled_at,
            'email_sent_at': summary.email_sent_at,
        })
    except DailyReportSummary.DoesNotExist:
        return Response({
            'date': report_date,
            'email_status': 'not_found',
            'message': '해당 날짜의 보고서가 없습니다.'
        }) 

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def daily_report_compare(request):
    """두 날짜의 일일 보고서 비교 API"""
    date1_str = request.GET.get('date1', '')
    date2_str = request.GET.get('date2', '')
    warehouse_code = request.GET.get('warehouse_code', '')
    
    if not date1_str or not date2_str:
        return Response(
            {'error': 'date1과 date2 파라미터가 필요합니다.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    try:
        date1 = datetime.strptime(date1_str, '%Y-%m-%d').date()
        date2 = datetime.strptime(date2_str, '%Y-%m-%d').date()
    except ValueError:
        return Response(
            {'error': '잘못된 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # 두 날짜의 데이터 조회
    queryset1 = DailyInventorySnapshot.objects.filter(snapshot_date=date1)
    queryset2 = DailyInventorySnapshot.objects.filter(snapshot_date=date2)
    
    if warehouse_code:
        queryset1 = queryset1.filter(warehouse_code=warehouse_code)
        queryset2 = queryset2.filter(warehouse_code=warehouse_code)
    
    # 데이터를 딕셔너리로 변환
    data1 = {}
    data2 = {}
    
    for item in queryset1:
        key = (item.material_code, item.warehouse_code, item.qc_status)
        data1[key] = item
    
    for item in queryset2:
        key = (item.material_code, item.warehouse_code, item.qc_status)
        data2[key] = item
    
    # 비교 결과 생성
    all_keys = set(data1.keys()) | set(data2.keys())
    comparison_results = []
    
    for key in all_keys:
        item1 = data1.get(key)
        item2 = data2.get(key)
        
        if item1 and item2:
            # 두 날짜 모두 데이터가 있는 경우
            quantity_diff = float(item2.total_quantity) - float(item1.total_quantity)
            cart_diff = item2.cart_count - item1.cart_count
            
            comparison_results.append({
                'material_code': item1.material_code,
                'material_name': item1.material_name,
                'warehouse_code': item1.warehouse_code,
                'warehouse_name': item1.warehouse_name,
                'qc_status': item1.qc_status,
                'date1_quantity': float(item1.total_quantity),
                'date2_quantity': float(item2.total_quantity),
                'quantity_diff': quantity_diff,
                'quantity_change_percent': (quantity_diff / float(item1.total_quantity) * 100) if float(item1.total_quantity) > 0 else 0,
                'date1_carts': item1.cart_count,
                'date2_carts': item2.cart_count,
                'cart_diff': cart_diff,
                'status': 'both'  # 두 날짜 모두 데이터 있음
            })
        elif item1:
            # date1에만 데이터가 있는 경우
            comparison_results.append({
                'material_code': item1.material_code,
                'material_name': item1.material_name,
                'warehouse_code': item1.warehouse_code,
                'warehouse_name': item1.warehouse_name,
                'qc_status': item1.qc_status,
                'date1_quantity': float(item1.total_quantity),
                'date2_quantity': 0,
                'quantity_diff': -float(item1.total_quantity),
                'quantity_change_percent': -100,
                'date1_carts': item1.cart_count,
                'date2_carts': 0,
                'cart_diff': -item1.cart_count,
                'status': 'date1_only'  # date1에만 데이터 있음
            })
        else:
            # date2에만 데이터가 있는 경우
            comparison_results.append({
                'material_code': item2.material_code,
                'material_name': item2.material_name,
                'warehouse_code': item2.warehouse_code,
                'warehouse_name': item2.warehouse_name,
                'qc_status': item2.qc_status,
                'date1_quantity': 0,
                'date2_quantity': float(item2.total_quantity),
                'quantity_diff': float(item2.total_quantity),
                'quantity_change_percent': float('inf') if float(item2.total_quantity) > 0 else 0,
                'date1_carts': 0,
                'date2_carts': item2.cart_count,
                'cart_diff': item2.cart_count,
                'status': 'date2_only'  # date2에만 데이터 있음
            })
    
    # 요약 통계
    total_items_date1 = len(data1)
    total_items_date2 = len(data2)
    total_quantity_date1 = sum(float(item.total_quantity) for item in data1.values())
    total_quantity_date2 = sum(float(item.total_quantity) for item in data2.values())
    total_carts_date1 = sum(item.cart_count for item in data1.values())
    total_carts_date2 = sum(item.cart_count for item in data2.values())
    
    return Response({
        'date1': date1_str,
        'date2': date2_str,
        'comparison_results': comparison_results,
        'summary': {
            'date1': {
                'total_items': total_items_date1,
                'total_quantity': total_quantity_date1,
                'total_carts': total_carts_date1
            },
            'date2': {
                'total_items': total_items_date2,
                'total_quantity': total_quantity_date2,
                'total_carts': total_carts_date2
            },
            'changes': {
                'items_diff': total_items_date2 - total_items_date1,
                'quantity_diff': total_quantity_date2 - total_quantity_date1,
                'carts_diff': total_carts_date2 - total_carts_date1,
                'quantity_change_percent': (total_quantity_date2 - total_quantity_date1) / total_quantity_date1 * 100 if total_quantity_date1 > 0 else 0
            }
        },
        'total': len(comparison_results)
    }) 

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def daily_report_export_csv(request):
    """일일 보고서 CSV 다운로드 API"""
    date_str = request.GET.get('date', '')
    warehouse_code = request.GET.get('warehouse_code', '')
    material_code = request.GET.get('material_code', '')
    compare_date = request.GET.get('compare_date', '')  # 비교 날짜 (선택사항)
    
    # 날짜 결정
    if date_str:
        try:
            report_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': '잘못된 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.'},
                status=status.HTTP_400_BAD_REQUEST
            )
    else:
        report_date = timezone.now().date()
    
    # 비교 날짜 처리
    compare_data = None
    if compare_date:
        try:
            compare_date_obj = datetime.strptime(compare_date, '%Y-%m-%d').date()
            compare_queryset = DailyInventorySnapshot.objects.filter(snapshot_date=compare_date_obj)
            if warehouse_code:
                compare_queryset = compare_queryset.filter(warehouse_code=warehouse_code)
            if material_code:
                compare_queryset = compare_queryset.filter(material_code__icontains=material_code)
            
            # 비교 데이터를 딕셔너리로 변환
            compare_data = {}
            for item in compare_queryset:
                key = (item.material_code, item.warehouse_code, item.qc_status)
                compare_data[key] = item
        except ValueError:
            return Response(
                {'error': '잘못된 비교 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.'},
                status=status.HTTP_400_BAD_REQUEST
            )
    
    # 메인 데이터 조회
    queryset = DailyInventorySnapshot.objects.filter(snapshot_date=report_date)
    if warehouse_code:
        queryset = queryset.filter(warehouse_code=warehouse_code)
    if material_code:
        queryset = queryset.filter(material_code__icontains=material_code)
    
    # CSV 생성
    response = HttpResponse(content_type='text/csv; charset=utf-8')
    filename = f'daily_report_{report_date}'
    if compare_date:
        filename += f'_vs_{compare_date}'
    filename += '.csv'
    
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    
    # BOM 추가 (한글 깨짐 방지)
    response.write('\ufeff')
    
    writer = csv.writer(response)
    
    # 헤더 작성
    headers = [
        '날짜', '품목코드', '품목명', '규격', '창고코드', '창고명', 
        'QC상태', '총수량', '단위', '带车数'
    ]
    
    if compare_date:
        headers.extend([
            f'{compare_date}_수량', f'{compare_date}_带车数', 
            '수량변화', '수량변화율(%)', '带车数变化'
        ])
    
    writer.writerow(headers)
    
    # 데이터 작성
    for item in queryset:
        row = [
            report_date,
            item.material_code,
            item.material_name,
            item.specification,
            item.warehouse_code,
            item.warehouse_name,
            item.qc_status,
            float(item.total_quantity),
            item.unit,
            item.cart_count
        ]
        
        if compare_date and compare_data:
            key = (item.material_code, item.warehouse_code, item.qc_status)
            compare_item = compare_data.get(key)
            
            if compare_item:
                quantity_diff = float(item.total_quantity) - float(compare_item.total_quantity)
                quantity_change_percent = (quantity_diff / float(compare_item.total_quantity) * 100) if float(compare_item.total_quantity) > 0 else 0
                cart_diff = item.cart_count - compare_item.cart_count
                
                row.extend([
                    float(compare_item.total_quantity),
                    compare_item.cart_count,
                    quantity_diff,
                    round(quantity_change_percent, 2),
                    cart_diff
                ])
            else:
                row.extend([0, 0, float(item.total_quantity), 100, item.cart_count])
        else:
            row.extend([0, 0, 0, 0, 0])
        
        writer.writerow(row)
    
    return response 