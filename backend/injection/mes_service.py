#!/usr/bin/env python
"""
BLACKLAKE MES API를 사용한 사출기 모니터링 서비스
resources parameter monitoring API를 통해 실제 생산 데이터 조회
"""
import os
import time
import requests
import pytz
import logging
from typing import List, Dict, Optional, Callable
from datetime import datetime, timedelta
from django.core.cache import cache
from django.db.models.functions import TruncHour
from inventory.mes import get_access_token, MES_BASE_URL, MES_ROUTE_BASE
from injection.models import InjectionMonitoringRecord


# BLACKLAKE API 엔드포인트
RESOURCE_MONITOR_ENDPOINT = '/resource/open/v1/resource_monitor/_page_list'

# 환경 설정 (설비코드/파라미터코드 매핑)
MES_DEVICE_CODE_MAP = os.getenv('MES_DEVICE_CODE_MAP', '')  # 예: "1:EQP001,2:EQP002"
MES_DEVICE_CODE_PREFIX = os.getenv('MES_DEVICE_CODE_PREFIX', '')  # 예: "EQP" (없으면 기계번호 문자열 사용)
MES_PARAM_CODE_PROD = os.getenv('MES_PARAM_CODE_PROD', '')  # production param code
MES_PARAM_CODE_TEMP = os.getenv('MES_PARAM_CODE_TEMP', '')  # oil temp param code
MES_PARAM_CODE_POWER = os.getenv('MES_PARAM_CODE_POWER', '')  # power/energy param code
MES_PARAM_ID_PROD = os.getenv('MES_PARAM_ID_PROD', '')      # production param id
MES_PARAM_ID_TEMP = os.getenv('MES_PARAM_ID_TEMP', '')      # oil temp param id
MES_PARAM_ID_POWER = os.getenv('MES_PARAM_ID_POWER', '')    # power/energy param id

# 프로젝트 기본값(확인된 값). 환경변수가 있으면 환경변수 우선
if not MES_PARAM_ID_PROD:
    MES_PARAM_ID_PROD = '1741659367715995'
if not MES_PARAM_ID_TEMP:
    MES_PARAM_ID_TEMP = '1741230035347466'

class MESResourceService:
    """BLACKLAKE MES 리소스 모니터링 서비스"""

    def __init__(self):
        # MES BASE 조합: 환경변수에 route 가 포함되어 있으면 그대로 사용, 아니면 route 접합
        self.base_url = MES_BASE_URL if '/api/openapi/domain/web/v1/route' in MES_BASE_URL else f"{MES_BASE_URL}{MES_ROUTE_BASE}"
        self.endpoint = RESOURCE_MONITOR_ENDPOINT

        # 설비 코드 매핑 테이블 파싱
        self.device_code_map: dict[str, str] = {}
        if MES_DEVICE_CODE_MAP:
            try:
                # 구분자 ',' 로 분리, 각 항목은 '번호:코드'
                for pair in [p.strip() for p in MES_DEVICE_CODE_MAP.split(',') if p.strip()]:
                    k, v = [x.strip() for x in pair.split(':', 1)]
                    self.device_code_map[str(int(k))] = v
            except Exception:
                # 잘못된 형식이면 무시하고 기본 매핑 사용
                self.device_code_map = {}

        # 환경변수가 없으면 프로젝트 기본 매핑(1~17호기)을 사용
        if not self.device_code_map:
            self.device_code_map = {
                '1': '850T-1',
                '2': '850T-2',
                '3': '1300T-3',
                '4': '1400T-4',
                '5': '1400T-5',
                '6': '2500T-6',
                '7': '1300T-7',
                '8': '850T-8',
                '9': '850T-9',
                '10': '650T-10',
                '11': '550T-11',
                '12': '550T-12',
                '13': '450T-13',
                '14': '850T-14',
                '15': '650T-15',
                '16': '1050T-16',
                '17': '1200T-17',
            }

    def _map_machine_to_device_code(self, machine_number: int) -> str:
        key = str(machine_number)
        if key in self.device_code_map:
            return self.device_code_map[key]
        if MES_DEVICE_CODE_PREFIX:
            return f"{MES_DEVICE_CODE_PREFIX}{machine_number}"
        return key

    def get_resource_monitoring_data(
        self,
        device_code: str,
        begin_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        param_codes: Optional[List[str]] = None,
        page: int = 1,
        size: int = 1000,
        param_types: Optional[List[int]] = [0],
        max_total_records: int = 10000 # New parameter
    ) -> Dict:
        """
        리소스 모니터링 데이터 조회
        """
        token = get_access_token()
        url = f"{self.base_url}{self.endpoint}?access_token={token}"

        if not end_time:
            end_time = datetime.now()
        if not begin_time:
            begin_time = end_time - timedelta(hours=1)

        begin_timestamp = int(begin_time.timestamp() * 1000)
        end_timestamp = int(end_time.timestamp() * 1000)

        request_body = {
            "deviceCode": device_code,
            "beginRecordTime": begin_timestamp,
            "endRecordTime": end_timestamp,
            "page": page,
            "size": size,
            "selectFlag": 0
        }
        if param_types is not None:
            request_body["paramTypes"] = param_types

        if param_codes:
            request_body["paramCodeList"] = param_codes
        else:
            env_codes: list[str] = []
            if MES_PARAM_CODE_PROD:
                env_codes.append(MES_PARAM_CODE_PROD)
            if MES_PARAM_CODE_TEMP:
                env_codes.append(MES_PARAM_CODE_TEMP)
            if MES_PARAM_CODE_POWER:
                env_codes.append(MES_PARAM_CODE_POWER)
            if env_codes:
                request_body["paramCodeList"] = env_codes

        try:
            collected_list: List[Dict] = []
            current_page = page
            for _ in range(100): # Max 100 pages
                body = {**request_body, 'page': current_page}
                response = requests.post(url, json=body, timeout=30)
                if response.status_code == 401:
                    token = get_access_token(force_refresh=True)
                    url = f"{self.base_url}{self.endpoint}?access_token={token}"
                    response = requests.post(url, json=body, timeout=30)

                response.raise_for_status()
                result = response.json()
                if result.get('code') != 200:
                    error_msg = result.get('message', 'Unknown MES API error')
                    raise Exception(f'MES API error: {error_msg}')

                data = result.get('data', {}) or {}
                page_list = data.get('list', []) or []
                collected_list.extend(page_list)

                if len(collected_list) >= max_total_records: # Stop if max_total_records reached
                    break
                if len(page_list) < size: # Stop if last page
                    break
                current_page += 1

            return {
                'list': collected_list,
                'page': page,
                'total': len(collected_list)
            }

        except Exception as e:
            print(f"MES API error for device {device_code}: {str(e)}")
            raise

    def _parse_raw_records(self, data_list: List[Dict]) -> tuple[list, list, list]:
        """Helper to parse raw MES records into production, temperature, and power lists."""
        prod_records = []
        temp_records = []
        power_records = []
        for rec in data_list:
            name = (rec.get('paramName') or '').lower()
            ts = rec.get('recordTime') or rec.get('ts')
            try:
                val = float(rec.get('val')) if rec.get('val') not in (None, '') else None
            except (ValueError, TypeError):
                val = None
            
            if not ts or val is None:
                continue

            pid = str(rec.get('paramId') or '')
            pcode = str(rec.get('paramCode') or '')
            if MES_PARAM_ID_PROD and pid == str(MES_PARAM_ID_PROD):
                prod_records.append((ts, val)); continue
            if MES_PARAM_ID_TEMP and pid == str(MES_PARAM_ID_TEMP):
                temp_records.append((ts, val)); continue
            if MES_PARAM_ID_POWER and pid == str(MES_PARAM_ID_POWER):
                power_records.append((ts, val)); continue
            if MES_PARAM_CODE_POWER and pcode == str(MES_PARAM_CODE_POWER):
                power_records.append((ts, val)); continue
            if '电能' in name or '电量' in name:
                power_records.append((ts, val)); continue

            if any(k in name for k in ['production', 'output', 'capacity']):
                prod_records.append((ts, val))
            elif any(k in name for k in ['temperature', 'temp', 'oil']):
                temp_records.append((ts, val))
            elif any(k in name for k in ['energy', 'power', 'kwh']):
                power_records.append((ts, val))
        return prod_records, temp_records, power_records

    def _save_monitoring_records(self, machine_num: int, device_code: str, prod_records: list, temp_records: list, power_records: list):
        cst = pytz.timezone('Asia/Shanghai')
        
        all_records: dict[datetime, dict[str, float]] = {}

        for ts_ms, val in prod_records:
            ts = datetime.fromtimestamp(ts_ms / 1000, tz=cst).replace(microsecond=0)
            if ts not in all_records:
                all_records[ts] = {}
            all_records[ts]['prod'] = val

        for ts_ms, val in temp_records:
            ts = datetime.fromtimestamp(ts_ms / 1000, tz=cst).replace(microsecond=0)
            if ts not in all_records:
                all_records[ts] = {}
            all_records[ts]['temp'] = val

        for ts_ms, val in power_records:
            ts = datetime.fromtimestamp(ts_ms / 1000, tz=cst).replace(microsecond=0)
            if ts not in all_records:
                all_records[ts] = {}
            all_records[ts]['power'] = val

        records_to_create = [
            InjectionMonitoringRecord(
                device_code=device_code,
                timestamp=ts,
                machine_name=f'{machine_num}호기',
                capacity=values.get('prod'),
                oil_temperature=values.get('temp'),
                power_kwh=values.get('power'),
            )
            for ts, values in all_records.items()
        ]
        
        if records_to_create:
            InjectionMonitoringRecord.objects.bulk_create(records_to_create, ignore_conflicts=True)

    def _build_time_slots(
        self,
        interval_type: str = '30min',
        columns: int = 13,
        reference_time: Optional[datetime] = None,
        use_exact_latest: bool = False,
    ) -> List[Dict]:
        cst = pytz.timezone('Asia/Shanghai')
        current_time = reference_time or datetime.now(cst)

        time_slots: List[Dict] = []
        if interval_type == '10min':
            for i in range(columns, 0, -1):
                minutes_back = (i - 1) * 10
                slot_time = current_time - timedelta(minutes=minutes_back)
                if i == 1 and use_exact_latest:
                    slot_time = slot_time.replace(second=0, microsecond=0)
                else:
                    floored = (slot_time.minute // 10) * 10
                    slot_time = slot_time.replace(minute=floored, second=0, microsecond=0)

                time_diff = current_time - slot_time
                minutes_diff = int(time_diff.total_seconds() / 60)
                label = f"{minutes_diff}분 전" if minutes_diff < 60 else f"{minutes_diff // 60}시간 전"

                time_slots.append({
                    'hour_offset': i,
                    'time': slot_time.isoformat(),
                    'label': label,
                    'interval_minutes': 10
                })
        elif interval_type == '30min':
            for i in range(columns, 0, -1):
                minutes_back = (i - 1) * 30
                slot_time = current_time - timedelta(minutes=minutes_back)
                if slot_time.minute < 30:
                    slot_time = slot_time.replace(minute=0, second=0, microsecond=0)
                else:
                    slot_time = slot_time.replace(minute=30, second=0, microsecond=0)

                time_diff = current_time - slot_time
                hours_diff = time_diff.total_seconds() / 3600
                if hours_diff < 1:
                    label = f"{int(time_diff.total_seconds() / 60)}분 전"
                else:
                    label = f"{hours_diff:.1f}시간 전"

                time_slots.append({
                    'hour_offset': i,
                    'time': slot_time.isoformat(),
                    'label': label,
                    'interval_minutes': 30
                })
        elif interval_type == '1day':
            day_start = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
            for i in range(columns - 1, -1, -1):
                slot_time = day_start - timedelta(days=i)
                label = 'today' if i == 0 else f'{i}d ago'
                time_slots.append({
                    'hour_offset': i * 24,
                    'time': slot_time.isoformat(),
                    'label': label,
                    'interval_minutes': 1440
                })
        else: # '1hour'
            for i in range(columns - 1, -1, -1):
                slot_time = current_time - timedelta(hours=i)
                slot_time = slot_time.replace(minute=0, second=0, microsecond=0)
                time_slots.append({
                    'hour_offset': i,
                    'time': slot_time.isoformat(),
                    'label': f'{i}시간 전' if i > 0 else '현재',
                    'interval_minutes': 60
                })

        return time_slots

    def update_records_from_mes(self):
        """
        Performs an incremental update for all machines based on their
        last saved timestamp in the database, fetching only snapshot data.
        """
        cst = pytz.timezone('Asia/Shanghai')
        machine_numbers = list(range(1, 18))
        
        # Use cst.localize() for proper timezone handling, avoiding historical LMT offsets.
        absolute_start_date = cst.localize(datetime(2025, 9, 19))

        for machine_num in machine_numbers:
            device_code = self._map_machine_to_device_code(machine_num)
            
            last_record = InjectionMonitoringRecord.objects.filter(machine_name=f'{machine_num}호기').order_by('-timestamp').first()
            
            # Ensure all datetimes are handled in the same timezone (CST) for consistency.
            if last_record and last_record.timestamp.astimezone(cst) > absolute_start_date:
                # Convert timestamp from DB (likely UTC) to CST before further calculations.
                begin_fetch_time = last_record.timestamp.astimezone(cst) - timedelta(minutes=30)
            else:
                begin_fetch_time = absolute_start_date
            
            end_fetch_time = datetime.now(cst)

            # Generate snapshot times (every 10 minutes)
            snapshot_times = []
            current_snapshot_time = begin_fetch_time.replace(second=0, microsecond=0)
            # Adjust to the next nearest 10-min mark if not already there
            minute_block = (current_snapshot_time.minute // 10) * 10
            if current_snapshot_time.minute % 10 != 0:
                current_snapshot_time = current_snapshot_time.replace(minute=minute_block, second=0, microsecond=0) + timedelta(minutes=10)

            while current_snapshot_time <= end_fetch_time:
                snapshot_times.append(current_snapshot_time)
                current_snapshot_time += timedelta(minutes=10) # Move to next 10-min mark

            for target_ts in snapshot_times:
                search_start = target_ts - timedelta(minutes=1)
                search_end = target_ts + timedelta(minutes=1)
                target_ts_ms = int(target_ts.timestamp() * 1000)

                try:
                    print(f"Fetching snapshot for Machine {machine_num} at {target_ts} (window: {search_start}-{search_end})...")
                    raw = self.get_resource_monitoring_data(
                        device_code=device_code,
                        begin_time=search_start,
                        end_time=search_end,
                        size=100,
                        max_total_records=500
                    ) or {}

                    data_list: List[Dict] = raw.get('list', []) or []
                    if not data_list:
                        # print(f"  - No data found for snapshot {machine_num} at {target_ts}.")
                        continue

                    prod_records, temp_records, power_records = self._parse_raw_records(data_list)

                    def pick_closest(records: list[tuple[int, float]]) -> Optional[float]:
                        if not records:
                            return None
                        ts, val = min(
                            records,
                            key=lambda item: (
                                abs(item[0] - target_ts_ms),
                                0 if item[0] >= target_ts_ms else 1
                            )
                        )
                        return val

                    latest_capacity = pick_closest(prod_records)
                    latest_oil_temp = pick_closest(temp_records)
                    latest_power = pick_closest(power_records)

                    defaults = {'machine_name': f'{machine_num}호기'}
                    if latest_capacity is not None:
                        defaults['capacity'] = latest_capacity
                    if latest_oil_temp is not None:
                        defaults['oil_temperature'] = latest_oil_temp
                    if latest_power is not None:
                        defaults['power_kwh'] = latest_power

                    if len(defaults) == 1:
                        continue

                    InjectionMonitoringRecord.objects.update_or_create(
                        device_code=device_code,
                        timestamp=target_ts.replace(microsecond=0),
                        defaults=defaults
                    )
                    print(f"  - Saved snapshot for {machine_num} at {target_ts}.")

                except Exception as e:
                    print(f"  - Failed to fetch or save snapshot for machine {machine_num} at {target_ts}: {e}")
                    # Do not re-raise here, continue to next snapshot
                    # The outer get_production_matrix will handle overall errors if no data is found

    def get_production_matrix(self, interval_type: str = '30min', columns: int = 13) -> Dict:
        from injection.models import InjectionReport

        # 1. Trigger the incremental update for all machines. (REMOVED FOR PERFORMANCE)
        # self.update_records_from_mes()

        # 2. Proceed with reading from the DB and building the matrix.
        machine_numbers = list(range(1, 18))
        cst = pytz.timezone('Asia/Shanghai')
        latest_record = InjectionMonitoringRecord.objects.order_by('-timestamp').first()
        latest_time = latest_record.timestamp.astimezone(cst) if latest_record else datetime.now(cst)
        use_exact_latest = latest_time.minute % 10 != 0
        time_slots = self._build_time_slots(
            interval_type=interval_type,
            columns=columns,
            reference_time=latest_time,
            use_exact_latest=use_exact_latest,
        )

        cumulative_matrix: Dict[str, List[float]] = {}
        actual_matrix: Dict[str, List[float]] = {}
        temperature_matrix: Dict[str, List[float]] = {}
        power_matrix: Dict[str, List[float]] = {}
        power_usage_matrix: Dict[str, List[float]] = {}

        start_of_first_slot = datetime.fromisoformat(time_slots[0]['time'])
        last_slot = time_slots[-1]
        interval_minutes = last_slot.get('interval_minutes', 60)
        end_of_last_slot = datetime.fromisoformat(last_slot['time']) + timedelta(minutes=interval_minutes)

        for machine_num in machine_numbers:
            db_records = InjectionMonitoringRecord.objects.filter(
                machine_name=f'{machine_num}호기',
                timestamp__gte=start_of_first_slot,
                timestamp__lt=end_of_last_slot
            ).order_by('timestamp')

            # 1. 시간 슬롯별로 마지막 레코드를 미리 계산합니다.
            slot_records = {}
            for r in db_records:
                # 레코드가 속하는 시간 슬롯을 찾습니다.
                # time_slots는 시간순으로 정렬되어 있으므로, 뒤에서부터 찾는 것이 효율적입니다.
                for slot in reversed(time_slots):
                    slot_start = datetime.fromisoformat(slot['time'])
                    if r.timestamp >= slot_start:
                        # 이 슬롯에 속하는 레코드입니다.
                        # db_records가 시간순이므로, 같은 슬롯에 여러 레코드가 있다면 마지막 레코드가 덮어쓰게 됩니다.
                        slot_records[slot['time']] = r
                        break

            # 2. 매트릭스 행을 만듭니다.
            cum_row: List[float] = []
            act_row: List[float] = []
            temp_row: List[float] = []
            power_row: List[float] = []
            power_act_row: List[float] = []
            
            # 첫 번째 슬롯 이전의 누적 생산량을 찾아 시간당 생산량의 기준점으로 삼습니다.
            record_before_first_slot = InjectionMonitoringRecord.objects.filter(
                machine_name=f'{machine_num}호기',
                timestamp__lt=start_of_first_slot,
                capacity__isnull=False
            ).order_by('-timestamp').first()

            record_before_first_slot_power = InjectionMonitoringRecord.objects.filter(
                machine_name=f'{machine_num}호기',
                timestamp__lt=start_of_first_slot,
                power_kwh__isnull=False
            ).order_by('-timestamp').first()
            
            # 이전 슬롯의 확정된 누적값 (데이터가 있는 슬롯의 값만 사용)
            prev_confirmed_cum = record_before_first_slot.capacity if record_before_first_slot else None
            # 화면 표시용 이전 누적값 (데이터 없는 슬롯은 이전 값을 그대로 표시)
            prev_display_cum = prev_confirmed_cum if prev_confirmed_cum is not None else 0.0
            prev_confirmed_power = record_before_first_slot_power.power_kwh if record_before_first_slot_power else None
            prev_display_power = prev_confirmed_power if prev_confirmed_power is not None else 0.0

            for slot in time_slots:
                slot_time_iso = slot['time']
                record = slot_records.get(slot_time_iso)

                cum_val = record.capacity if record and record.capacity is not None else None
                t_val = record.oil_temperature if record and record.oil_temperature is not None else 0.0
                p_val = record.power_kwh if record and record.power_kwh is not None else None

                # 시간당 생산량은 확정된 누적값 간의 차이로 계산합니다.
                act_val = (cum_val - prev_confirmed_cum) if (cum_val is not None and prev_confirmed_cum is not None and cum_val >= prev_confirmed_cum) else 0.0
                power_act_val = (p_val - prev_confirmed_power) if (p_val is not None and prev_confirmed_power is not None and p_val >= prev_confirmed_power) else 0.0
                
                # 화면에 표시될 누적 생산량: 현재 슬롯에 데이터가 없으면 이전 값을 사용합니다.
                display_cum = cum_val if cum_val is not None else prev_display_cum
                display_power = p_val if p_val is not None else prev_display_power

                cum_row.append(round(display_cum, 3))
                act_row.append(round(act_val, 3))
                temp_row.append(round(t_val, 3))
                power_row.append(round(display_power, 3))
                power_act_row.append(round(power_act_val, 3))

                # 다음 루프를 위해 값을 업데이트합니다.
                prev_display_cum = display_cum
                prev_display_power = display_power
                if cum_val is not None:
                    prev_confirmed_cum = cum_val
                if p_val is not None:
                    prev_confirmed_power = p_val

            cumulative_matrix[str(machine_num)] = cum_row
            actual_matrix[str(machine_num)] = act_row
            temperature_matrix[str(machine_num)] = temp_row
            power_matrix[str(machine_num)] = power_row
            power_usage_matrix[str(machine_num)] = power_act_row

        # --- Machine Info and Final Response ---
        now = datetime.now(cst)
        all_machine_nos = sorted(set(list(range(1, 18)) + [int(m) for m in cumulative_matrix.keys()]))
        
        machine_info_map = {}
        for machine_no in all_machine_nos:
            recent_report = InjectionReport.objects.filter(machine_no=machine_no, tonnage__isnull=False).exclude(tonnage='').order_by('-date', '-id').first()
            default_tonnage_map = {
                1: '850T', 2: '850T', 3: '1300T', 4: '1400T', 5: '1400T', 6: '2500T',
                7: '1300T', 8: '850T', 9: '850T', 10: '650T', 11: '550T', 12: '550T',
                13: '450T', 14: '850T', 15: '650T', 16: '1050T', 17: '1200T'
            }
            tonnage = recent_report.tonnage if recent_report else default_tonnage_map.get(machine_no, f'{machine_no * 50}T')
            machine_info_map[machine_no] = {
                'name': f'{machine_no}호기',
                'tonnage': tonnage
            }

        machines = [
            {
                'machine_number': num,
                'machine_name': info['name'],
                'tonnage': info['tonnage'],
                'display_name': f"{info['name']} - {info['tonnage']}"
            }
            for num, info in machine_info_map.items() if num in machine_numbers
        ]

        return {
            'timestamp': now.isoformat(),
            'time_slots': time_slots,
            'interval_type': interval_type,
            'columns': columns,
            'machines': machines,
            'cumulative_production_matrix': cumulative_matrix,
            'actual_production_matrix': actual_matrix,
            'oil_temperature_matrix': temperature_matrix,
            'power_kwh_matrix': power_matrix,
            'power_usage_matrix': power_usage_matrix,
            'mes_source': True
        }

    def _update_single_hour_snapshot(
        self,
        target_timestamp: datetime,
        progress_callback: Optional[Callable[[int, int, datetime], None]] = None,
    ):
        """
        Helper function to fetch and save the snapshot for a single, specific hour.
        """
        logger = logging.getLogger(__name__)

        # MES 데이터 수집 시점이 슬랏(10분 단위)과 딱 맞지 않을 때가 많아
        # ±1분 범위로는 새 기록을 놓칠 수 있다. 충분한 여유(±10분)로 검색 후
        # target_timestamp에 가장 가까운 값을 선택하도록 한다.
        search_start_time = target_timestamp - timedelta(minutes=10)
        search_end_time = target_timestamp + timedelta(minutes=1)
        target_ts_ms = int(target_timestamp.timestamp() * 1000)

        logger.info(f"=== Starting snapshot update for timestamp: {target_timestamp.isoformat()} ===")
        logger.info(f"Search range: {search_start_time.isoformat()} ~ {search_end_time.isoformat()}")

        machine_numbers = list(range(1, 18))
        total_machines = len(machine_numbers)
        processed_machines = 0
        logger.info("Processing %s machines..." % total_machines)

        for machine_num in machine_numbers:
            device_code = self._map_machine_to_device_code(machine_num)
            machine_name = f'{machine_num}호기'
            logger.info(f"--- Processing machine {machine_num} (device_code: {device_code}) ---")

            try:
                logger.debug(f"Fetching MES data for machine {machine_num}...")
                raw_data = self.get_resource_monitoring_data(
                    device_code=device_code,
                    begin_time=search_start_time,
                    end_time=search_end_time,
                    size=100,
                    max_total_records=500
                )

                data_list = raw_data.get('list', [])
                logger.info(f"Machine {machine_num}: Received {len(data_list)} raw records from MES API")

                if not data_list:
                    logger.warning(f"No data found for machine {machine_num} in range {search_start_time} - {search_end_time}.")
                    continue

                prod_records, temp_records, power_records = self._parse_raw_records(data_list)
                logger.info(f"Machine {machine_num}: Parsed {len(prod_records)} production records, {len(temp_records)} temperature records, and {len(power_records)} power records")

                def pick_closest(records: list[tuple[int, float]]) -> Optional[float]:
                    if not records:
                        return None
                    ts, val = min(
                        records,
                        key=lambda item: (
                            abs(item[0] - target_ts_ms),
                            0 if item[0] >= target_ts_ms else 1
                        )
                    )
                    return val

                latest_capacity = pick_closest(prod_records)
                latest_oil_temp = pick_closest(temp_records)
                latest_power = pick_closest(power_records)

                if latest_capacity is None and latest_oil_temp is None and latest_power is None:
                    logger.warning(f"No valid production/temperature records found for machine {machine_num}.")
                    continue

                defaults = {'machine_name': machine_name}
                if latest_capacity is not None:
                    defaults['capacity'] = latest_capacity
                if latest_oil_temp is not None:
                    defaults['oil_temperature'] = latest_oil_temp
                if latest_power is not None:
                    defaults['power_kwh'] = latest_power

                InjectionMonitoringRecord.objects.update_or_create(
                    device_code=device_code,
                    timestamp=target_timestamp,
                    defaults=defaults
                )
                logger.info(f"✓ Saved snapshot for machine {machine_num} at {target_timestamp.isoformat()}")

            except Exception as e:
                logger.error(f"Failed to update snapshot for machine {machine_num}: {e}", exc_info=True)
            finally:
                processed_machines += 1
                if progress_callback:
                    progress_callback(processed_machines, total_machines, target_timestamp)

    def update_hourly_snapshot_from_mes(self):
        """
        10? ??? ?? ???? ????? ?????.
        """
        logger = logging.getLogger(__name__)
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)
        floored = (now.minute // 10) * 10
        target_timestamp = now.replace(minute=floored, second=0, microsecond=0)

        logger.info(f"=== Interval snapshot update started at {now.isoformat()} ===")
        logger.info(f"Target timestamp: {target_timestamp.isoformat()}")

        try:
            self._update_single_hour_snapshot(target_timestamp)

            # Count successful records
            records_count = InjectionMonitoringRecord.objects.filter(timestamp=target_timestamp).count()
            logger.info(f"=== Interval snapshot update completed successfully ===")
            logger.info(f"Total records saved: {records_count} / 17 machines")

            self.compact_monitoring_records(retention_hours=24, hours_to_compact=2)
            return {"status": "completed", "timestamp": now.isoformat(), "records_saved": records_count}

        except Exception as e:
            logger.error(f"=== Interval snapshot update failed ===", exc_info=True)
            return {"status": "failed", "timestamp": now.isoformat(), "error": str(e)}

    def update_recent_hourly_snapshots(
        self,
        hours_to_update: int,
        progress_callback: Optional[Callable[[int, int, datetime], None]] = None,
    ):
        """
        ??? ???? ?? 10? ??? ???? ???????.
        """
        logger = logging.getLogger(__name__)
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)
        floored = (now.minute // 10) * 10
        target_base = now.replace(minute=floored, second=0, microsecond=0)

        logger.info(f"Starting update for recent {hours_to_update} hours.")

        total_minutes = max(0, hours_to_update) * 60

        for minutes_back in range(0, total_minutes + 1, 10):
            target_timestamp = target_base - timedelta(minutes=minutes_back)
            slot_callback = None
            if progress_callback:
                slot_callback = lambda completed, total, slot_time=target_timestamp: progress_callback(completed, total, slot_time)
            self._update_single_hour_snapshot(target_timestamp, progress_callback=slot_callback)

        self.compact_monitoring_records(retention_hours=24, hours_to_compact=6)
        logger.info(f"Finished update for recent {hours_to_update} hours.")
        return {"status": "completed", "hours_updated": hours_to_update}

    def compact_monitoring_records(self, retention_hours: int = 24, hours_to_compact: int = 2) -> None:
        """
        Keep 10-min snapshots for the last retention_hours and compact older data to hourly.
        """
        if hours_to_compact <= 0:
            return

        logger = logging.getLogger(__name__)
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)
        cutoff = now - timedelta(hours=retention_hours)
        compact_before = cutoff.replace(minute=0, second=0, microsecond=0)
        compact_start = compact_before - timedelta(hours=hours_to_compact)

        candidates = InjectionMonitoringRecord.objects.filter(
            timestamp__gte=compact_start,
            timestamp__lt=compact_before
        )
        if not candidates.exists():
            return

        grouped_hours = candidates.annotate(hour=TruncHour('timestamp')).values('device_code', 'hour').distinct()

        deleted_total = 0
        for entry in grouped_hours:
            hour_start = entry['hour']
            if hour_start is None:
                continue
            hour_end = hour_start + timedelta(hours=1)
            hour_qs = candidates.filter(
                device_code=entry['device_code'],
                timestamp__gte=hour_start,
                timestamp__lt=hour_end
            ).order_by('-timestamp')
            latest = hour_qs.first()
            if not latest:
                continue
            deleted_count, _ = hour_qs.exclude(id=latest.id).delete()
            deleted_total += deleted_count

        if deleted_total:
            logger.info(
                "Compacted monitoring records: kept hourly snapshots for %s~%s (deleted %s rows).",
                compact_start.isoformat(),
                compact_before.isoformat(),
                deleted_total
            )


# 서비스 인스턴스
mes_service = MESResourceService()
ce = MESResourceService()

mes_service = MESResourceService()
