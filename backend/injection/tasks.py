"""
사출기 모니터링을 위한 Celery 태스크 정의
MES 시스템에서 정각마다 최신 데이터를 자동으로 업데이트
"""

from celery import shared_task
from django.utils import timezone
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

@shared_task
def update_production_matrix_hourly():
    """
    매 정시에 MES 시스템에서 생산 매트릭스 데이터를 갱신합니다.
    mes_service의 update_hourly_snapshot_from_mes 함수를 호출하여, 
    직전 1시간의 마지막 데이터를 정각 스냅샷으로 저장합니다.
    """
    from .mes_service import mes_service

    try:
        current_time = timezone.now()
        logger.info(f"Starting hourly production matrix update task at {current_time.isoformat()}")

        # MES 서비스의 스냅샷 업데이트 함수를 직접 호출
        result = mes_service.update_hourly_snapshot_from_mes()

        logger.info(f"Hourly production matrix update task finished with result: {result}")
        return {
            'status': 'success',
            'updated_at': current_time.isoformat(),
            'details': result
        }

    except Exception as e:
        logger.error(f"Failed to update production matrix via Celery task: {str(e)}", exc_info=True)
        return {
            'status': 'error',
            'updated_at': timezone.now().isoformat(),
            'error': str(e)
        }

@shared_task
def update_monitoring_data_realtime():
    """
    실시간 모니터링 데이터 업데이트 (필요 시 사용)
    """
    try:
        current_time = timezone.now()
        logger.info(f"Real-time monitoring data update triggered at {current_time}")

        # 실시간 업데이트 로직 구현 예정
        # 현재는 로깅만 수행

        return {
            'status': 'success',
            'updated_at': current_time.isoformat(),
            'message': 'Real-time monitoring data processed'
        }

    except Exception as e:
        logger.error(f"Failed to update real-time monitoring data: {str(e)}")
        return {
            'status': 'error',
            'updated_at': timezone.now().isoformat(),
            'error': str(e)
        }