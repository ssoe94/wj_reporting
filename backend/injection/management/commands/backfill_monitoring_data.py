
import time
from django.core.management.base import BaseCommand, CommandError
from datetime import datetime, timedelta
import pytz
import logging

# Django 설정이 로드된 후에 모델과 서비스를 임포트합니다.
from injection.models import InjectionMonitoringRecord
from injection.mes_service import mes_service

class Command(BaseCommand):
    help = 'Backfills historical injection monitoring data from the MES API for the last N hours.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--hours',
            type=int,
            default=24,
            help='Specifies how many hours back from the current time to backfill data. Defaults to 24.'
        )
        parser.add_argument(
            '--clear',
            action='store_true',
            help='If set, deletes all existing records within the specified hour range before backfilling.'
        )

    def handle(self, *args, **options):
        hours_to_backfill = options['hours']
        clear_first = options['clear']
        
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)
        
        self.stdout.write(self.style.SUCCESS(f'Starting data backfill for the last {hours_to_backfill} hours...'))

        if hours_to_backfill <= 0:
            raise CommandError('The value for --hours must be a positive integer.')

        # 1. 데이터 삭제 (옵션)
        if clear_first:
            start_delete_range = now - timedelta(hours=hours_to_backfill)
            end_delete_range = now
            
            self.stdout.write(f'Clearing existing data from {start_delete_range.isoformat()} to {end_delete_range.isoformat()}...')
            deleted_count, _ = InjectionMonitoringRecord.objects.filter(
                timestamp__gte=start_delete_range,
                timestamp__lte=end_delete_range
            ).delete()
            self.stdout.write(self.style.SUCCESS(f'Successfully deleted {deleted_count} records.'))

        # 2. 과거 시간대에 대해 데이터 백필
        for h in range(hours_to_backfill, -1, -1):
            # 각 시간의 정각을 타겟으로 설정
            target_time = now - timedelta(hours=h)
            target_timestamp = target_time.replace(minute=0, second=0, microsecond=0)
            
            self.stdout.write(f'--- Processing snapshot for {target_timestamp.isoformat()} ---')
            
            try:
                self.fetch_and_save_snapshot(target_timestamp)
                # API 과부하를 막기 위해 약간의 딜레이 추가
                time.sleep(1)
            except Exception as e:
                self.stderr.write(self.style.ERROR(f'Failed to process snapshot for {target_timestamp.isoformat()}: {e}'))

        self.stdout.write(self.style.SUCCESS('Data backfill process completed.'))

    def fetch_and_save_snapshot(self, target_timestamp: datetime):
        """
        주어진 정각 타임스탬프에 대해 MES 데이터를 가져와 스냅샷으로 저장합니다.
        mes_service.update_hourly_snapshot_from_mes의 핵심 로직을 재사용합니다.
        """
        cst = pytz.timezone('Asia/Shanghai')
        search_end_time = target_timestamp
        search_start_time = search_end_time - timedelta(hours=1)

        machine_numbers = list(range(1, 18))
        for machine_num in machine_numbers:
            device_code = mes_service._map_machine_to_device_code(machine_num)
            machine_name = f'{machine_num}호기'

            # 데이터가 이미 있는지 확인
            if InjectionMonitoringRecord.objects.filter(device_code=device_code, timestamp=target_timestamp).exists():
                self.stdout.write(f'  Skipping machine {machine_num}: Snapshot already exists.')
                continue

            try:
                # MES에서 데이터 가져오기
                raw_data = mes_service.get_resource_monitoring_data(
                    device_code=device_code,
                    begin_time=search_start_time,
                    end_time=search_end_time,
                    size=100,
                    max_total_records=500
                )
                
                data_list = raw_data.get('list', [])
                if not data_list:
                    self.stdout.write(f'  Machine {machine_num}: No data found in MES for the given time range.')
                    continue

                # 마지막 레코드 찾기
                prod_records, temp_records = mes_service._parse_raw_records(data_list)
                
                all_ts_records = {}
                for ts, val in prod_records:
                    if ts not in all_ts_records: all_ts_records[ts] = {}
                    all_ts_records[ts]['prod'] = val
                for ts, val in temp_records:
                    if ts not in all_ts_records: all_ts_records[ts] = {}
                    all_ts_records[ts]['temp'] = val

                if not all_ts_records:
                    self.stdout.write(f'  Machine {machine_num}: No valid records parsed from MES data.')
                    continue

                latest_ts = max(all_ts_records.keys())
                latest_record_data = all_ts_records[latest_ts]
                
                # 데이터베이스에 저장
                InjectionMonitoringRecord.objects.update_or_create(
                    device_code=device_code,
                    timestamp=target_timestamp,
                    defaults={
                        'machine_name': machine_name,
                        'capacity': latest_record_data.get('prod'),
                        'oil_temperature': latest_record_data.get('temp'),
                    }
                )
                self.stdout.write(self.style.SUCCESS(f'  Successfully saved snapshot for machine {machine_num}.'))

            except Exception as e:
                self.stderr.write(self.style.ERROR(f'  Error processing machine {machine_num}: {e}'))
