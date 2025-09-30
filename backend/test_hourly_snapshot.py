#!/usr/bin/env python
"""
수동 테스트 스크립트: Hourly Snapshot 업데이트 테스트

이 스크립트는 MES API에서 데이터를 가져와 InjectionMonitoringRecord 테이블을 업데이트하는
과정을 테스트합니다.

사용법:
    python test_hourly_snapshot.py

옵션:
    --hours N  : 최근 N시간의 스냅샷을 업데이트 (기본값: 1)
"""

import os
import sys
import django
import logging
from datetime import datetime, timedelta
import pytz

# Django 설정
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
django.setup()

from injection.mes_service import mes_service
from injection.models import InjectionMonitoringRecord

# 로깅 설정
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


def test_single_hour_snapshot():
    """현재 시간에 대한 단일 스냅샷 업데이트 테스트"""
    logger.info("=" * 80)
    logger.info("Testing single hour snapshot update")
    logger.info("=" * 80)

    try:
        result = mes_service.update_hourly_snapshot_from_mes()
        logger.info(f"\nResult: {result}")

        # 결과 검증
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)
        target_timestamp = now.replace(minute=0, second=0, microsecond=0)

        records = InjectionMonitoringRecord.objects.filter(timestamp=target_timestamp)
        logger.info(f"\n{'-' * 80}")
        logger.info(f"Verification: Found {records.count()} records for timestamp {target_timestamp}")

        if records.exists():
            logger.info(f"\nSample records:")
            for record in records[:3]:
                logger.info(f"  - {record.machine_name}: Capacity={record.capacity}, Temp={record.oil_temperature}")

        return result.get("status") == "completed"

    except Exception as e:
        logger.error(f"Test failed: {e}", exc_info=True)
        return False


def test_recent_hours_snapshots(hours: int = 3):
    """최근 N시간의 스냅샷 업데이트 테스트"""
    logger.info("=" * 80)
    logger.info(f"Testing recent {hours} hours snapshot update")
    logger.info("=" * 80)

    try:
        result = mes_service.update_recent_hourly_snapshots(hours)
        logger.info(f"\nResult: {result}")

        # 결과 검증
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)

        logger.info(f"\n{'-' * 80}")
        logger.info(f"Verification for each hour:")

        for i in range(hours):
            target_timestamp = (now - timedelta(hours=i)).replace(minute=0, second=0, microsecond=0)
            records_count = InjectionMonitoringRecord.objects.filter(timestamp=target_timestamp).count()
            logger.info(f"  {target_timestamp}: {records_count} records")

        return result.get("status") == "completed"

    except Exception as e:
        logger.error(f"Test failed: {e}", exc_info=True)
        return False


def test_mes_api_connection():
    """MES API 연결 테스트"""
    logger.info("=" * 80)
    logger.info("Testing MES API connection")
    logger.info("=" * 80)

    try:
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)
        end_time = now
        start_time = end_time - timedelta(minutes=10)

        logger.info(f"Testing with time range: {start_time} ~ {end_time}")

        # 1호기 데이터 가져오기 테스트
        device_code = mes_service._map_machine_to_device_code(1)
        logger.info(f"Device code for machine 1: {device_code}")

        raw_data = mes_service.get_resource_monitoring_data(
            device_code=device_code,
            begin_time=start_time,
            end_time=end_time,
            size=100,
            max_total_records=500
        )

        data_list = raw_data.get('list', [])
        logger.info(f"Received {len(data_list)} records from MES API")

        if data_list:
            logger.info(f"\nSample record:")
            logger.info(f"  {data_list[0]}")

            prod_records, temp_records = mes_service._parse_raw_records(data_list)
            logger.info(f"\nParsed:")
            logger.info(f"  Production records: {len(prod_records)}")
            logger.info(f"  Temperature records: {len(temp_records)}")

            return True
        else:
            logger.warning("No data received from MES API")
            return False

    except Exception as e:
        logger.error(f"MES API connection test failed: {e}", exc_info=True)
        return False


def main():
    """메인 테스트 실행"""
    import argparse

    parser = argparse.ArgumentParser(description='Test hourly snapshot update')
    parser.add_argument('--hours', type=int, default=1,
                        help='Number of recent hours to update (default: 1)')
    parser.add_argument('--api-only', action='store_true',
                        help='Test only MES API connection')

    args = parser.parse_args()

    logger.info("\n" + "=" * 80)
    logger.info("HOURLY SNAPSHOT UPDATE TEST")
    logger.info("=" * 80 + "\n")

    if args.api_only:
        # MES API 연결만 테스트
        success = test_mes_api_connection()
    elif args.hours == 1:
        # 단일 시간 테스트
        success = test_single_hour_snapshot()
    else:
        # 다중 시간 테스트
        success = test_recent_hours_snapshots(args.hours)

    logger.info("\n" + "=" * 80)
    if success:
        logger.info("✓ TEST PASSED")
    else:
        logger.info("✗ TEST FAILED")
    logger.info("=" * 80 + "\n")

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()