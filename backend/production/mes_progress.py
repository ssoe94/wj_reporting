from __future__ import annotations

import time
import re
from datetime import datetime, timedelta
from typing import Any

import requests
import pytz

from inventory.mes import MES_BASE_URL, MES_ROUTE_BASE, get_access_token


PROGRESS_REPORT_LIST_ENDPOINT = f'{MES_ROUTE_BASE}/mfg/open/v1/progress_report/_list'
SHANGHAI_TZ = pytz.timezone('Asia/Shanghai')


class MesApiError(Exception):
    def __init__(self, message: str, sub_code: str | None = None, payload: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        self.sub_code = sub_code or ''
        self.payload = payload or {}


def call_progress_report_list(page: int = 1, size: int = 200, **filters: Any) -> dict[str, Any]:
    token = get_access_token()
    url = f"{MES_BASE_URL}{PROGRESS_REPORT_LIST_ENDPOINT}?access_token={token}"
    body = {
        'page': page,
        'size': size,
        **filters,
    }

    for attempt in range(3):
        try:
            response = requests.post(url, json=body, timeout=120)
            if response.status_code == 401:
                token = get_access_token(force_refresh=True)
                url = f"{MES_BASE_URL}{PROGRESS_REPORT_LIST_ENDPOINT}?access_token={token}"
                response = requests.post(url, json=body, timeout=120)

            response.raise_for_status()
            payload = response.json()
            if payload.get('code') != 200:
                raise MesApiError(
                    payload.get('message') or 'MES API error',
                    sub_code=payload.get('subCode'),
                    payload=payload,
                )
            return payload.get('data') or {}
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)

    return {}


def fetch_all_progress_reports(report_time_from: int, report_time_to: int, size: int = 200, **filters: Any) -> list[dict[str, Any]]:
    page = 1
    rows: list[dict[str, Any]] = []

    while True:
        data = call_progress_report_list(
            page=page,
            size=size,
            reportTimeFrom=report_time_from,
            reportTimeTo=report_time_to,
            **filters,
        )
        page_rows = data.get('list') or []
        if not page_rows:
            break
        rows.extend(page_rows)

        total = int(data.get('total') or 0)
        if total and len(rows) >= total:
            break
        if len(page_rows) < size:
            break
        page += 1

    return rows


def get_business_date(dt: datetime):
    localized = dt.astimezone(SHANGHAI_TZ)
    if localized.hour < 8:
        return (localized - timedelta(days=1)).date()
    return localized.date()


def parse_report_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=SHANGHAI_TZ)
    except (TypeError, ValueError, OSError):
        return None


def normalize_part_no(part_no: Any) -> str:
    return re.sub(r'\s+', '', str(part_no or '').upper())


def normalize_plan_type(process_code: Any) -> str | None:
    code = str(process_code or '').strip().upper()
    if code == 'ZS':
        return 'injection'
    if code == 'JG':
        return 'machining'
    return None


def extract_equipment_name(row: dict[str, Any]) -> str:
    equipments = row.get('equipments') or []
    if isinstance(equipments, list) and equipments:
        first = equipments[0] or {}
        return (first.get('name') or first.get('code') or '').strip()
    return ''


def extract_mes_material_name(row: dict[str, Any]) -> str:
    name = (row.get('mainMaterialName') or '').strip()
    if name:
        return name
    material_info = row.get('materialInfo') or {}
    base_info = material_info.get('baseInfo') or {}
    return (base_info.get('name') or '').strip()


def normalize_mes_part_no(row: dict[str, Any]) -> str:
    main_part = normalize_part_no(row.get('mainMaterialCode'))
    if main_part:
        return main_part
    material_info = row.get('materialInfo') or {}
    base_info = material_info.get('baseInfo') or {}
    return normalize_part_no(base_info.get('code'))


def extract_qty(row: dict[str, Any]) -> int:
    base_amount = row.get('reportBaseAmount') or {}
    try:
        return int(round(float(base_amount.get('amount') or 0)))
    except (TypeError, ValueError):
        return 0


def extract_machine_number(name: Any) -> int | None:
    if not name:
        return None
    text = str(name)
    for pattern in (r'-(\d+)\s*$', r'^\s*(\d+)\b', r'(\d+)'):
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    return None


def extract_line_key(name: Any) -> str:
    if not name:
        return ''
    text = str(name).strip().upper()
    match = re.search(r'([A-Z])', text)
    if match:
        return match.group(1)
    return text


def normalize_equipment_key(plan_type: str, equipment_name: Any) -> str:
    if plan_type == 'injection':
        number = extract_machine_number(equipment_name)
        return str(number) if number is not None else ''
    return extract_line_key(equipment_name)


def format_equipment_label(plan_type: str, equipment_name: str, equipment_key: str) -> str:
    if plan_type == 'injection':
        number = extract_machine_number(equipment_name) if equipment_name else None
        machine_number = number if number is not None else int(equipment_key)
        tonnage_match = re.search(r'(\d{2,5}T)', str(equipment_name or '').upper())
        tonnage = tonnage_match.group(1) if tonnage_match else ''
        return f"{machine_number}\uD638\uAE30 {tonnage}".strip()
    return f"{equipment_key}\uB77C\uC778"


def equipment_sort_order(plan_type: str, equipment_key: str):
    if plan_type == 'injection':
        try:
            return int(equipment_key)
        except (TypeError, ValueError):
            return 9999
    return ord(str(equipment_key or 'Z')[0])
