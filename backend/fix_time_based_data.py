#!/usr/bin/env python
"""
시간대별로 정확한 누적 생산량 데이터 생성
- 과거에서 현재로 갈수록 누적량이 증가
- 시간당 생산량이 실제로 계산되도록 함
"""
import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from injection.models import InjectionMonitoringRecord
from datetime import datetime, timedelta
import pytz
import random

def create_correct_time_based_data():
    """시간대별로 올바른 누적 생산량 데이터 생성"""

    # 기존 데이터 삭제
    InjectionMonitoringRecord.objects.all().delete()
    print("Existing data deleted.")

    cst = pytz.timezone('Asia/Shanghai')
    now = datetime.now(cst)

    # 17개 사출기 설정
    machine_configs = [
        (1, 65, 45.0, True),   # (번호, 시간당생산량, 기본온도, 가동여부)
        (2, 58, 46.0, True),
        (3, 72, 47.0, True),
        (4, 0, 48.0, False),   # 정지중
        (5, 68, 46.5, True),
        (6, 0, 49.0, False),   # 정지중
        (7, 0, 47.5, False),   # 정지중
        (8, 62, 45.5, True),
        (9, 0, 48.5, False),   # 정지중
        (10, 59, 45.0, True),
        (11, 63, 48.0, True),
        (12, 0, 44.0, False),  # 정지중
        (13, 0, 43.5, False),  # 정지중
        (14, 66, 46.8, True),
        (15, 0, 44.5, False),  # 정지중
        (16, 61, 47.2, True),
        (17, 69, 48.8, True),
    ]

    created_records = []

    # 각 사출기별로 24시간 데이터 생성
    for machine_no, hourly_rate, base_temp, is_active in machine_configs:

        # 24시간 전 시작 누적량 (각 사출기별로 다름)
        base_cumulative = 30000 + (machine_no * 1000) + random.randint(0, 5000)

        # 시간별로 데이터 생성 (24시간 전부터 현재까지)
        for hour_offset in range(24, 0, -1):  # 24, 23, 22, ..., 1

            # 기록 시간 (정시에서 약간 전)
            record_time = now - timedelta(hours=hour_offset)
            record_time = record_time.replace(minute=random.randint(55, 59),
                                            second=random.randint(0, 59),
                                            microsecond=0)

            # 누적 생산량 계산 (시간이 지날수록 증가)
            if is_active and hourly_rate > 0:
                # 경과 시간에 따른 누적 생산량
                hours_passed = 24 - hour_offset

                # 기본 증가량
                base_increase = hours_passed * hourly_rate

                # 시간대별 변동성 (주간/야간 차이)
                current_hour = record_time.hour
                if 6 <= current_hour <= 18:  # 주간: 110% 생산
                    multiplier = random.uniform(1.0, 1.2)
                else:  # 야간: 80% 생산
                    multiplier = random.uniform(0.7, 0.9)

                # 가끔 설비 문제 (5% 확률로 생산량 급감)
                if random.random() < 0.05:
                    multiplier *= 0.3

                actual_increase = int(base_increase * multiplier)
                cumulative = base_cumulative + actual_increase
            else:
                # 정지중인 사출기: 누적량 변화 없음
                cumulative = base_cumulative

            # 온도 계산
            if is_active:
                # 가동중: 시간에 따른 온도 변화
                temp_variation = random.uniform(-2.0, 3.0)
                if random.random() < 0.03:  # 3% 확률로 과열
                    temp_variation += random.uniform(5, 15)
                oil_temp = base_temp + temp_variation
            else:
                # 정지중: 낮은 온도
                oil_temp = max(base_temp - random.uniform(3, 8), 25.0)

            # 레코드 생성
            record = InjectionMonitoringRecord.objects.create(
                machine_name=f'{machine_no}호기',
                device_code=f'사출기{machine_no}호기',
                timestamp=record_time,
                capacity=cumulative,
                oil_temperature=round(oil_temp, 1)
            )
            created_records.append(record)

    print(f"Created {len(created_records)} time-based records.")

    # 결과 확인
    print("\nSample verification for Machine 1:")
    machine_1_records = InjectionMonitoringRecord.objects.filter(
        machine_name='1호기'
    ).order_by('timestamp')

    print("First 3 records (oldest):")
    for r in machine_1_records[:3]:
        print(f"  {r.timestamp.strftime('%m-%d %H:%M')} - Capacity: {r.capacity}")

    print("Last 3 records (newest):")
    for r in machine_1_records[machine_1_records.count()-3:]:
        print(f"  {r.timestamp.strftime('%m-%d %H:%M')} - Capacity: {r.capacity}")

    # 누적량이 시간순으로 증가하는지 확인
    capacities = [r.capacity for r in machine_1_records if r.capacity]
    if all(capacities[i] <= capacities[i+1] for i in range(len(capacities)-1)):
        print("✅ Cumulative production is correctly increasing over time!")
    else:
        print("❌ Issue: Cumulative production not properly increasing")

    return created_records

if __name__ == '__main__':
    create_correct_time_based_data()