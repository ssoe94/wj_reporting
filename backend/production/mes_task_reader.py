"""Bounded list reader. Only the list endpoint is exposed; no action transport."""
from time import monotonic

from .mes_task_reconciliation import quantity, timestamp


def normalize_tasks(rows, normalize_part, extract_machine):
    """Whitelist list fields; absent/unsupported identity fields invalidate coverage.

    The documented list contract nests material/amounts in progressReportOpenVO
    and represents taskStatus as an enum object. Older flat responses are also
    accepted. Quantity comparisons require an explicit matching unit identity.
    Missing amounts remain null. Never substitute a daily plan quantity for a task's.
    """
    tasks, complete = [], True
    for row in rows:
        process = row.get('processCode')
        if not isinstance(process, str) or not process.strip():
            complete = False
            continue
        if process.strip().upper() != 'ZS':
            continue
        status = row.get('taskStatus')
        if isinstance(status, dict):
            status = status.get('code')
        if type(status) is not int or status not in {1, 2, 3}:
            complete = False
            continue
        progress = row.get('progressReportOpenVO')
        documented_progress = isinstance(progress, dict)
        material = progress.get('materialInfo') if documented_progress else row.get('materialInfo')
        base = material.get('baseInfo') if isinstance(material, dict) else None
        nested_code = base.get('code') if isinstance(base, dict) else None
        flat_code = None if documented_progress else row.get('mainMaterialCode')
        material_fields = {
            'materialInfo': {'baseInfo': {'code': nested_code if isinstance(nested_code, str) else ''}},
            'mainMaterialCode': flat_code if isinstance(flat_code, str) else '',
        }
        try:
            part = normalize_part(material_fields)
        except (TypeError, AttributeError):
            part = ''
        if not isinstance(part, str):
            part = ''
        equipments = row.get('equipments')
        numbers = []
        equipment_valid = isinstance(equipments, list) and bool(equipments)
        for equipment in equipments if isinstance(equipments, list) else []:
            if not isinstance(equipment, dict):
                equipment_valid = False
                continue
            # Device code digits are not machine numbers. Resolve the equipment name.
            number = extract_machine(equipment.get('name'))
            if number not in range(1, 18):
                equipment_valid = False
            else:
                numbers.append(number)
        machine = numbers[0] if equipment_valid and len(set(numbers)) == 1 else None
        task_code = row.get('taskCode')
        identity_complete = bool(part and isinstance(task_code, str) and task_code.strip())
        complete = complete and identity_complete
        if documented_progress:
            # The list contract has no inbound amount. Reported != warehoused.
            amounts = [progress.get('plannedAmount'), progress.get('alreadyReportedAmount'), None]
        else:
            amounts = [row.get(key) for key in ('planAmount', 'reportAmount', 'inboundAmount')]
        units = []
        for value in amounts:
            unit = None
            if isinstance(value, dict):
                if documented_progress:
                    unit_object = value.get('unit')
                    unit = unit_object.get('id') if isinstance(unit_object, dict) else None
                else:
                    unit = value.get('unitId')
            units.append(str(unit) if type(unit) in (str, int) and str(unit) else '')
        quantities = [quantity(value.get('amount')) if isinstance(value, dict) else None for value in amounts]
        same_unit = bool(units[0] and units[0] == units[1])
        opened = timestamp(row.get('actualStartTime'))
        tasks.append({
            'task_id': str(row['taskId']),
            'task_code': task_code if isinstance(task_code, str) else '',
            'work_order_code': row.get('workOrderCode') if isinstance(row.get('workOrderCode'), str) else '',
            'part_no': part, 'machine_number': machine, 'status': status,
            'actual_start': opened.isoformat() if opened else None,
            'planned_quantity': quantities[0], 'reported_quantity': quantities[1],
            'inbound_quantity': quantities[2], 'quantity_unit': units[0] if same_unit else None,
            'identity_complete': identity_complete,
        })
    return tasks, complete


def read_task_pages(fetch_page, *, size=100, max_pages=5, time_budget=20):
    rows, seen = [], set()
    expected_total = None
    started = monotonic()
    for page in range(1, max_pages + 1):
        if monotonic() - started >= time_budget:
            return rows, False, ['mes_time_limit']
        try:
            payload = fetch_page(page, size)
        except Exception:
            # Raw upstream errors can contain credentials, URLs or personal data.
            return rows, False, ['mes_read_failed']
        if not isinstance(payload, dict) or payload.get('code') != 200:
            return rows, False, ['mes_read_failed']
        data = payload.get('data')
        if not isinstance(data, dict) or not isinstance(data.get('list'), list):
            return rows, False, ['mes_invalid_response']
        batch, total = data['list'], data.get('total')
        if type(total) is not int or total < 0 or len(batch) > size:
            return rows, False, ['mes_invalid_response']
        if expected_total is not None and total != expected_total:
            return rows, False, ['mes_snapshot_changed']
        expected_total = total
        for row in batch:
            if not isinstance(row, dict):
                return rows, False, ['mes_invalid_response']
            identity = row.get('taskId')
            if isinstance(identity, bool) or not isinstance(identity, (str, int)) or not str(identity):
                return rows, False, ['mes_invalid_response']
            if str(identity) in seen:
                return rows, False, ['mes_duplicate_page']
            seen.add(str(identity))
            rows.append(row)
        if len(rows) == total:
            return rows, True, []
        if len(rows) > total or len(batch) < size:
            return rows, False, ['mes_partial_response']
    return rows, False, ['mes_page_limit']


def fetch_task_page(page, size):
    # Imported only when a real, authorized API request invokes the service.
    import requests
    from inventory.mes import MES_BASE_URL, MES_ROUTE_BASE, get_access_token

    token = get_access_token()
    response = requests.post(
        f'{MES_BASE_URL}{MES_ROUTE_BASE}/mfg/open/v1/produce_task/_list',
        # Render uses Blacklake's route gateway, which authenticates via query
        # parameters. The downstream endpoint's documented header is not enough.
        params={'access_token': token},
        json={'page': page, 'size': size, 'taskStatusList': [1, 2, 3]},
        timeout=(3, 5),
    )
    response.raise_for_status()
    return response.json()
