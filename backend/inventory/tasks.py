from celery import shared_task
from django.core.management import call_command
from django.utils import timezone
from datetime import timedelta
from .models import DailyInventorySnapshot, DailyReportSummary
import logging
from django.db.models import Count, Sum

logger = logging.getLogger(__name__)

@shared_task
def daily_inventory_automation():
    """매일 08:00 자동 실행되는 재고 자동화 작업"""
    try:
        logger.info("일일 재고 자동화 작업 시작")
        
        # 1. MES 데이터 갱신
        logger.info("MES 데이터 갱신 시작")
        call_command('fetch_inventory')
        logger.info("MES 데이터 갱신 완료")
        
        # 2. 일일 스냅샷 생성
        logger.info("일일 스냅샷 생성 시작")
        call_command('create_daily_snapshot')
        logger.info("일일 스냅샷 생성 완료")
        
        # 3. 요약 데이터 생성
        logger.info("요약 데이터 생성 시작")
        create_daily_summary()
        logger.info("요약 데이터 생성 완료")
        
        # 4. 30일 이전 데이터 정리
        logger.info("30일 이전 데이터 정리 시작")
        cleanup_old_snapshots()
        logger.info("30일 이전 데이터 정리 완료")
        
        logger.info("일일 재고 자동화 작업 완료")
        return "success"
        
    except Exception as e:
        logger.error(f"일일 재고 자동화 작업 실패: {str(e)}")
        raise

def create_daily_summary():
    """일일 보고서 요약 데이터 생성"""
    today = timezone.now().date()
    
    # 오늘 데이터 집계
    today_data = DailyInventorySnapshot.objects.filter(snapshot_date=today).aggregate(
        total_items=Count('id'),
        total_quantity=Sum('total_quantity'),
        total_carts=Sum('cart_count')
    )
    
    # 창고별 요약
    warehouse_summary = DailyInventorySnapshot.objects.filter(snapshot_date=today).values(
        'warehouse_name'
    ).annotate(
        item_count=Count('id'),
        total_quantity=Sum('total_quantity'),
        cart_count=Sum('cart_count')
    ).order_by('warehouse_name')
    
    # 요약 데이터 저장 또는 업데이트
    summary, created = DailyReportSummary.objects.get_or_create(
        snapshot_date=today,
        defaults={
            'total_items': today_data['total_items'] or 0,
            'total_quantity': today_data['total_quantity'] or 0,
            'total_carts': today_data['total_carts'] or 0,
            'warehouse_summary': list(warehouse_summary),
            'is_email_sent': False,
        }
    )
    
    if not created:
        # 기존 데이터 업데이트
        summary.total_items = today_data['total_items'] or 0
        summary.total_quantity = today_data['total_quantity'] or 0
        summary.total_carts = today_data['total_carts'] or 0
        summary.warehouse_summary = list(warehouse_summary)
        summary.save()

def cleanup_old_snapshots():
    """30일 이전 스냅샷 자동 삭제"""
    cutoff_date = timezone.now().date() - timedelta(days=30)
    
    # 30일 이전 스냅샷 삭제
    deleted_snapshots, _ = DailyInventorySnapshot.objects.filter(
        snapshot_date__lt=cutoff_date
    ).delete()
    
    # 30일 이전 요약 데이터 삭제
    deleted_summaries, _ = DailyReportSummary.objects.filter(
        snapshot_date__lt=cutoff_date
    ).delete()
    
    logger.info(f"30일 이전 데이터 정리 완료: 스냅샷 {deleted_snapshots}개, 요약 {deleted_summaries}개 삭제")

@shared_task
def test_celery_connection():
    """Celery 연결 테스트용 태스크"""
    logger.info("Celery 연결 테스트 성공")
    return "Celery is working!" 