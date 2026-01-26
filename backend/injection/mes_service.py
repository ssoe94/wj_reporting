#!/usr/bin/env python
"""
BLACKLAKE MES API毳?靷毄頃?靷稖旮?氇媹韯半 靹滊箘鞀?
resources parameter monitoring API毳?韱淀暣 鞁れ牅 靸濎偘 雿办澊韯?臁绊殞
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


# BLACKLAKE API 鞐旊摐韽澑韸?
RESOURCE_MONITOR_ENDPOINT = '/resource/open/v1/resource_monitor/_page_list'

# 頇橁步 靹れ爼 (靹る箘旖旊摐/韺岆澕氙疙劙旖旊摐 毵ろ晳)
MES_DEVICE_CODE_MAP = os.getenv('MES_DEVICE_CODE_MAP', '')  # 鞓? "1:EQP001,2:EQP002"
MES_DEVICE_CODE_PREFIX = os.getenv('MES_DEVICE_CODE_PREFIX', '')  # 鞓? "EQP" (鞐嗢溂氅?旮瓣硠氩堩樃 氍胳瀽鞐?靷毄)
MES_PARAM_CODE_PROD = os.getenv('MES_PARAM_CODE_PROD', '')  # production param code
MES_PARAM_CODE_TEMP = os.getenv('MES_PARAM_CODE_TEMP', '')  # oil temp param code
MES_PARAM_CODE_POWER = os.getenv('MES_PARAM_CODE_POWER', '')  # power/energy param code
MES_PARAM_ID_PROD = os.getenv('MES_PARAM_ID_PROD', '')      # production param id
MES_PARAM_ID_TEMP = os.getenv('MES_PARAM_ID_TEMP', '')      # oil temp param id
MES_PARAM_ID_POWER = os.getenv('MES_PARAM_ID_POWER', '')    # power/energy param id

# 頂勲鞝濏姼 旮半掣臧?頇曥澑霅?臧?. 頇橁步氤€靾橁皜 鞛堨溂氅?頇橁步氤€靾?鞖办劆
if not MES_PARAM_ID_PROD:
    MES_PARAM_ID_PROD = '1741659367715995'
if not MES_PARAM_ID_TEMP:
    MES_PARAM_ID_TEMP = '1741230035347466'

class MESResourceService:
    """BLACKLAKE MES 자원 파라미터 모니터링 서비스"""
    def __init__(self):
        # MES BASE 臁绊暕: 頇橁步氤€靾橃棎 route 臧€ 韽暔霅橃柎 鞛堨溂氅?攴鸽寑搿?靷毄, 鞎勲媹氅?route 鞝戫暕
        self.base_url = MES_BASE_URL if '/api/openapi/domain/web/v1/route' in MES_BASE_URL else f"{MES_BASE_URL}{MES_ROUTE_BASE}"
        self.endpoint = RESOURCE_MONITOR_ENDPOINT

        # 靹る箘 旖旊摐 毵ろ晳 韰岇澊敫?韺岇嫳
        self.device_code_map: dict[str, str] = {}
        if MES_DEVICE_CODE_MAP:
            try:
                # 甑秳鞛?',' 搿?攵勲Μ, 臧?頃鞚€ '氩堩樃:旖旊摐'
                for pair in [p.strip() for p in MES_DEVICE_CODE_MAP.split(',') if p.strip()]:
                    k, v = [x.strip() for x in pair.split(':', 1)]
                    self.device_code_map[str(int(k))] = v
            except Exception:
                # 鞛橂霅?順曥嫕鞚措┐ 氍挫嫓頃橁碃 旮半掣 毵ろ晳 靷毄
                self.device_code_map = {}

        # 頇橁步氤€靾橁皜 鞐嗢溂氅?頂勲鞝濏姼 旮半掣 毵ろ晳(1~17順戈赴)鞚?靷毄
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
        max_total_records: int = 10000
    ) -> Dict:
        """Fetch resource monitoring data from MES (merges paged results)."""
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

        power_code = MES_PARAM_CODE_POWER or None
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

        def fetch(body: Dict) -> Dict:
            collected_list: List[Dict] = []
            current_page = page
            for _ in range(100):  # Max 100 pages
                body_page = {**body, 'page': current_page}
                response = requests.post(url, json=body_page, timeout=30)
                if response.status_code == 401:
                    token = get_access_token(force_refresh=True)
                    url_retry = f"{self.base_url}{self.endpoint}?access_token={token}"
                    response = requests.post(url_retry, json=body_page, timeout=30)

                response.raise_for_status()
                result = response.json()
                if result.get('code') != 200:
                    error_msg = result.get('message', 'Unknown MES API error')
                    raise Exception(f'MES API error: {error_msg}')

                data = result.get('data', {}) or {}
                page_list = data.get('list', []) or []
                collected_list.extend(page_list)

                if len(collected_list) >= max_total_records:
                    break
                if len(page_list) < size:
                    break
                current_page += 1

            return {
                'list': collected_list,
                'page': page,
                'total': len(collected_list)
            }

        try:
            return fetch(request_body)
        except Exception as e:
            msg = str(e)
            # If MES rejects power code, retry once without it to keep prod/temp flowing.
            if power_code and ('参数定义' in msg or 'param definition' in msg or '不存在' in msg or '电能' in msg):
                logging.getLogger(__name__).warning(
                    "MES power code '%s' rejected for device %s, retrying without power code", power_code, device_code
                )
                codes = [c for c in request_body.get("paramCodeList", []) if c != power_code]
                if codes:
                    request_body["paramCodeList"] = codes
                else:
                    request_body.pop("paramCodeList", None)
                return fetch(request_body)

            print(f"MES API error for device {device_code}: {msg}")
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
            if '鐢佃兘' in name or '鐢甸噺' in name or '电能' in name or '电量' in name or ('电能' in pcode):
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
                machine_name=f'{machine_num}順戈赴',
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
                label = f"{minutes_diff} min" if minutes_diff < 60 else f"{minutes_diff // 60} h"

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
                    label = f"{int(time_diff.total_seconds() / 60)} min"
                else:
                    label = f"{hours_diff:.1f} h"

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
                    'label': f'{i} h' if i > 0 else 'now',
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
            
            last_record = InjectionMonitoringRecord.objects.filter(machine_name=f'{machine_num}順戈赴').order_by('-timestamp').first()
            
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

                    defaults = {'machine_name': f'{machine_num}順戈赴'}
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
                machine_name=f'{machine_num}順戈赴',
                timestamp__gte=start_of_first_slot,
                timestamp__lt=end_of_last_slot
            ).order_by('timestamp')

            # 1. 鞁滉皠 鞀’氤勲 毵堨毵?霠堨綌霌滊ゼ 氙鸽Μ 瓿勳偘頃╇媹雼?
            slot_records = {}
            for r in db_records:
                # 霠堨綌霌滉皜 靻嶍晿電?鞁滉皠 鞀’鞚?彀眷姷雼堧嫟.
                # time_slots電?鞁滉皠靾滌溂搿?鞝曤牞霅橃柎 鞛堨溂氙€搿? 霋れ棎靹滊秬韯?彀倦姅 瓴冹澊 須湪鞝侅瀰雼堧嫟.
                for slot in reversed(time_slots):
                    slot_start = datetime.fromisoformat(slot['time'])
                    if r.timestamp >= slot_start:
                        # 鞚?鞀’鞐?靻嶍晿電?霠堨綌霌滌瀰雼堧嫟.
                        # db_records臧€ 鞁滉皠靾滌澊氙€搿? 臧欖潃 鞀’鞐?鞐煬 霠堨綌霌滉皜 鞛堧嫟氅?毵堨毵?霠堨綌霌滉皜 雿柎鞊瓣矊 霅╇媹雼?
                        slot_records[slot['time']] = r
                        break

            # 2. 毵ろ姼毽姢 頄夓潉 毵岆摥雼堧嫟.
            cum_row: List[float] = []
            act_row: List[float] = []
            temp_row: List[float] = []
            power_row: List[float] = []
            power_act_row: List[float] = []
            
            # 觳?氩堨Ц 鞀’ 鞚挫爠鞚?雸勳爜 靸濎偘霟夓潉 彀眷晞 鞁滉皠雼?靸濎偘霟夓潣 旮办鞝愳溂搿?靷检姷雼堧嫟.
            record_before_first_slot = InjectionMonitoringRecord.objects.filter(
                machine_name=f'{machine_num}順戈赴',
                timestamp__lt=start_of_first_slot,
                capacity__isnull=False
            ).order_by('-timestamp').first()

            record_before_first_slot_power = InjectionMonitoringRecord.objects.filter(
                machine_name=f'{machine_num}順戈赴',
                timestamp__lt=start_of_first_slot,
                power_kwh__isnull=False
            ).order_by('-timestamp').first()
            
            # 鞚挫爠 鞀’鞚?頇曥爼霅?雸勳爜臧?(雿办澊韯瓣皜 鞛堧姅 鞀’鞚?臧掚 靷毄)
            prev_confirmed_cum = record_before_first_slot.capacity if record_before_first_slot else None
            # 頇旊┐ 響滌嫓鞖?鞚挫爠 雸勳爜臧?(雿办澊韯?鞐嗠姅 鞀’鞚€ 鞚挫爠 臧掛潉 攴鸽寑搿?響滌嫓)
            prev_display_cum = prev_confirmed_cum if prev_confirmed_cum is not None else 0.0
            prev_confirmed_power = record_before_first_slot_power.power_kwh if record_before_first_slot_power else None
            prev_display_power = prev_confirmed_power if prev_confirmed_power is not None else 0.0

            for slot in time_slots:
                slot_time_iso = slot['time']
                record = slot_records.get(slot_time_iso)

                cum_val = record.capacity if record and record.capacity is not None else None
                t_val = record.oil_temperature if record and record.oil_temperature is not None else 0.0
                p_val = record.power_kwh if record and record.power_kwh is not None else None

                # 鞁滉皠雼?靸濎偘霟夓潃 頇曥爼霅?雸勳爜臧?臧勳潣 彀澊搿?瓿勳偘頃╇媹雼?
                act_val = (cum_val - prev_confirmed_cum) if (cum_val is not None and prev_confirmed_cum is not None and cum_val >= prev_confirmed_cum) else 0.0
                power_act_val = (p_val - prev_confirmed_power) if (p_val is not None and prev_confirmed_power is not None and p_val >= prev_confirmed_power) else 0.0
                
                # 頇旊┐鞐?響滌嫓霅?雸勳爜 靸濎偘霟? 順勳灛 鞀’鞐?雿办澊韯瓣皜 鞐嗢溂氅?鞚挫爠 臧掛潉 靷毄頃╇媹雼?
                display_cum = cum_val if cum_val is not None else prev_display_cum
                display_power = p_val if p_val is not None else prev_display_power

                cum_row.append(round(display_cum, 3))
                act_row.append(round(act_val, 3))
                temp_row.append(round(t_val, 3))
                power_row.append(round(display_power, 3))
                power_act_row.append(round(power_act_val, 3))

                # 雼れ潓 耄攧毳?鞙勴暣 臧掛潉 鞐呺嵃鞚错姼頃╇媹雼?
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
                'name': f'{machine_no}順戈赴',
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

        # MES 雿办澊韯?靾橃 鞁滌爯鞚?鞀瀼(10攵?雼渼)瓿?鞏搓笅雮?靾?鞛堨柎 於╇秳頌?雱撽矊 臁绊殞頃滊嫟.
        # -30攵?~ +10攵?氩旍渼鞐愳劀 臧€鞛?臧€旯岇毚 臧掛潉 靹犿儩.
        search_start_time = target_timestamp - timedelta(minutes=30)
        search_end_time = target_timestamp + timedelta(minutes=10)
        target_ts_ms = int(target_timestamp.timestamp() * 1000)

        logger.info(f"=== Starting snapshot update for timestamp: {target_timestamp.isoformat()} ===")
        logger.info(f"Search range: {search_start_time.isoformat()} ~ {search_end_time.isoformat()}")

        machine_numbers = list(range(1, 18))
        total_machines = len(machine_numbers)
        processed_machines = 0
        logger.info("Processing %s machines..." % total_machines)

        for machine_num in machine_numbers:
            device_code = self._map_machine_to_device_code(machine_num)
            machine_name = f'{machine_num}順戈赴'
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
                logger.info(f"鉁?Saved snapshot for machine {machine_num} at {target_timestamp.isoformat()}")

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


# 靹滊箘鞀?鞚胳姢韯挫姢
mes_service = MESResourceService()
ce = MESResourceService()

mes_service = MESResourceService()
