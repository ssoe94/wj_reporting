"""Read-only MES orders/records joined only to already verified TT094 carts.

Calendar dates (Shanghai), not the production 08:00 business day. Record creation
is preparation evidence, never proof that a vehicle departed. No LG reads/writes.
"""
import copy
import datetime as dt
import re
from time import monotonic
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.utils import timezone
from . import client, service
from .models import LgentCart

TZ = ZoneInfo('Asia/Shanghai')
PAGE_SIZE = 200
MAX_PAGES = 10


def _mes(body, *, records=False, timeout=8):
    # Reuse the existing authorized app-token path, with two fixed read routes.
    from inventory.services.outbound_performance import _post_mes
    return _post_mes(body, records=records, timeout=timeout)


def _date(value):
    try:
        parsed = dt.date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError()
        return parsed
    except (ValueError, TypeError):
        raise client.LgError('조회 날짜를 확인하세요.', 'invalid_range', 400) from None


def _stamp(value):
    from inventory.services.outbound_performance import _parse_datetime
    parsed = _parse_datetime(value)
    return parsed.astimezone(TZ) if parsed else None


def _enum(value):
    return value.get('code') if isinstance(value, dict) else value


def _code(row):
    return str(row.get('code') or row.get('outboundOrderCode') or '').strip()


def _company(row):
    customer = row.get('customer') or {}
    customer_code = customer.get('code') if isinstance(customer, dict) else customer
    return customer_code in ('LGENT', 'LGETA') or bool(re.search(r'(?:^|[0-9_-])(?:LGENT|LGETA)(?:$|[-_])', _code(row).upper()))


def _pages(filters, records, deadline):
    from inventory.services.outbound_performance import _page_rows
    rows, seen, expected = [], set(), None
    for page in range(1, MAX_PAGES + 1):
        remaining = deadline - monotonic()
        if remaining <= 1:
            raise client.LgError('MES 조회가 지연됩니다. 기간을 줄여 다시 조회하세요.', 'mes_timeout', 504)
        payload = _mes({**filters, 'page': page, 'size': PAGE_SIZE}, records=records, timeout=min(8, remaining))
        batch, total = _page_rows(payload)
        if total is None:
            raise ValueError('MES pagination total missing')
        if total > MAX_PAGES * PAGE_SIZE:
            raise client.LgError('조회량이 많습니다. 기간을 줄여 주세요.', 'mes_range_too_large', 422)
        if total is not None:
            if total < 0 or (expected is not None and total != expected):
                raise ValueError('MES pagination changed')
            expected = total
        for row in batch:
            identity = str(row.get('id') or '')
            if not identity or identity in seen:
                raise ValueError('MES duplicate/missing source identity')
            seen.add(identity)
        # Keep only the modal contract, not large material/operator/custom-field
        # trees. Even a maximum-size range remains a small cache entry.
        fields = ('id', 'outboundOrderCode', 'qrCode', 'createTime', 'bizType', 'executeType') if records else (
            'id', 'code', 'outboundOrderCode', 'customer', 'planAt', 'planTime', 'bizType', 'bizStatus', 'status', 'cancelled', 'canceled')
        for row in batch:
            slim = {key: row[key] for key in fields if key in row}
            if isinstance(slim.get('customer'), dict):
                slim['customer'] = {'code': slim['customer'].get('code')}
            rows.append(slim)
        if expected is not None and len(rows) >= expected:
            if len(rows) != expected:
                raise ValueError('MES inconsistent pagination')
            return rows
        if len(batch) < PAGE_SIZE:
            if expected is not None:
                raise ValueError('MES incomplete pagination')
            return rows
    raise client.LgError('조회량이 많습니다. 기간을 줄여 주세요.', 'mes_range_too_large', 422)


def _source(start, end, mode):
    key = f'lgent:mes-shipments:v1:{mode}:{start}:{end}'
    cached = cache.get(key)
    if cached is not None:
        return copy.deepcopy(cached)
    since = dt.datetime.combine(start, dt.time.min, TZ)
    until = dt.datetime.combine(end + dt.timedelta(days=1), dt.time.min, TZ)
    deadline = monotonic() + 22
    orders = []
    if mode == 'plan':
        orders = _pages({'planAtFrom': int(since.timestamp()*1000), 'planAtTill': int(until.timestamp()*1000)-1}, False, deadline)
        from inventory.services.outbound_performance import _is_cancelled
        orders = [row for row in orders if _company(row) and _enum(row.get('bizType')) == 1
                  and not row.get('cancelled') and not row.get('canceled') and not _is_cancelled(row.get('bizStatus', row.get('status')))]
        orders = [row for row in orders if (stamp := _stamp(row.get('planAt') or row.get('planTime'))) and since <= stamp < until]
        codes = sorted({_code(row) for row in orders if _code(row)})
        # No unbounded record scan. Empty plan cohort is a complete empty result.
        records = _pages({'outboundOrderCodes': codes, 'bizType': [1]}, True, deadline) if codes else []
        records = [row for row in records if str(row.get('outboundOrderCode') or '') in codes]
    else:
        records = _pages({'createdAtFrom': int(since.timestamp()*1000), 'createdAtTill': int(until.timestamp()*1000)-1, 'bizType': [1]}, True, deadline)
        records = [row for row in records if _company({'code': row.get('outboundOrderCode')})
                   and (stamp := _stamp(row.get('createTime'))) and since <= stamp < until]
    value = {'orders': orders, 'records': records, 'fetchedAt': timezone.now().isoformat()}
    cache.set(key, value, 60)
    return copy.deepcopy(value)


def overview(user, params):
    start, end = _date(params.get('start')), _date(params.get('end'))
    mode = params.get('mode', 'plan')
    if end < start or (end-start).days > 30 or mode not in ('plan', 'history'):
        raise client.LgError('조회 기간은 최대 31일입니다.', 'invalid_range', 400)
    try:
        source = _source(start, end, mode)
    except client.LgError:
        raise
    except Exception as error:
        from inventory.services.outbound_performance import PERMISSION_DENIED_TOKENS
        message = str(error).casefold()
        if '403' in message or any(token in message for token in PERMISSION_DENIED_TOKENS):
            raise client.LgError('MES 출고 조회 권한을 확인하세요.', 'mes_permission_denied', 403) from None
        # Never expose upstream response/request bodies or credentials.
        raise client.LgError('MES 출고 정보를 조회하지 못했습니다.', 'mes_unavailable', 502) from None
    # Joining source identifiers is exact; a TT prefix is not ownership evidence.
    fleet = {c.trolley_id: c for c in LgentCart.objects.filter(supplier_code='TT094')
             if c.baseline.get('supplier_id') == 'TT094' and c.baseline.get('com_code') in ('LGENT','LGETA')}
    profile = service.profile(user)
    stale_days = profile.stale_days if profile else 30
    from inventory.services.outbound_performance import _status_label
    orders = {_code(row): row for row in source['orders']}
    result, seen_orders = {}, set()
    for record in source['records']:
        if _enum(record.get('bizType')) != 1 or _enum(record.get('executeType')) not in (0, 2, 3):
            continue
        code = str(record.get('outboundOrderCode') or '')
        order = orders.get(code, {})
        identifier = str(record.get('qrCode') or '').strip()
        stamp = _stamp(record.get('createTime'))
        if not stamp:
            continue
        reversed_record = _enum(record.get('executeType')) == 2
        date_key = stamp.date().isoformat() if mode == 'history' else ''
        key = (code, identifier or str(record['id']), date_key, reversed_record)
        seen_orders.add(code)
        previous = result.get(key)
        if previous:
            previous['recordCount'] += 1
            if stamp.isoformat() > previous['recordedAt']:
                previous['recordedAt'] = stamp.isoformat()
            continue
        cart = fleet.get(identifier)
        plan_stamp = _stamp(order.get('planAt') or order.get('planTime'))
        result[key] = {'id': str(record['id']), 'orderCode': code, 'identifier': identifier,
            'trolleyId': identifier if cart else '', 'plannedAt': plan_stamp.isoformat() if plan_stamp else '',
            'recordedAt': stamp.isoformat(), 'status': 'reversed' if reversed_record else _status_label(order.get('bizStatus', order.get('status'))) or 'recorded',
            'recordCount': 1, 'cart': service.public_cart(cart, stale_days) if cart else None}
    for code, order in orders.items():
        if code in seen_orders:
            continue
        stamp = _stamp(order.get('planAt') or order.get('planTime'))
        result[(code, '', '', False)] = {'id': f'order:{order["id"]}', 'orderCode': code, 'identifier': '', 'trolleyId': '',
            'plannedAt': stamp.isoformat() if stamp else '', 'recordedAt': '',
            'status': _status_label(order.get('bizStatus', order.get('status'))) or 'unknown', 'recordCount': 0, 'cart': None}
    rows = sorted(result.values(), key=lambda row: (row['plannedAt'] if mode == 'plan' else row['recordedAt'], row['orderCode'], row['identifier']))
    return {'mode': mode, 'start': start.isoformat(), 'end': end.isoformat(), 'rows': rows,
            'fetchedAt': source['fetchedAt'], 'complete': True,
            'source': 'MES outbound_order/_list + _list_outbound_record' if mode == 'plan' else 'MES outbound_order/_list_outbound_record'}
