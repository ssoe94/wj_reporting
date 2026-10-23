"""Durable daily/model history. Only explicit sync writes; GET reads published days."""
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation, localcontext
from time import monotonic
import hashlib
import json
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import F, Q, Sum
from .models import MovementHistoryDay, MovementHistoryRevision, MovementHistoryGroup
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

SHANGHAI = ZoneInfo('Asia/Shanghai')
MAX_PAGES = 50
PAGE_SIZE = 200
MAX_SEARCH_EVENTS = 20_000


class HistoryRangeError(Exception):
    pass


def _date(value):
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError('Dates must use YYYY-MM-DD.')
    return parsed


def _integer(params, key, default, maximum):
    value = int(params.get(key, default))
    if not 1 <= value <= maximum:
        raise ValueError(f'{key} must be between 1 and {maximum}.')
    return value


def _fetch_page(page, start, end, timeout):
    # Lazy import keeps isolated API tests independent of MES credentials/config.
    from inventory.mes import call_inventory_change_log
    return call_inventory_change_log(
        page=page, size=PAGE_SIZE, dateStart=int(start.timestamp() * 1000),
        dateEnd=int(end.timestamp() * 1000) - 1,
        request_timeout=timeout, max_attempts=1,
    )


def _text(value):
    return str(value).strip() if value is not None else ''


def _record(value):
    return value if isinstance(value, dict) else {}


def _normalise(row, start, end):
    material = _record(row.get('material'))
    warehouse = row.get('warehouse')
    warehouse_name = _text(warehouse.get('name')) if isinstance(warehouse, dict) else _text(warehouse)
    warehouse_code = _text(warehouse.get('code')) if isinstance(warehouse, dict) else _text(row.get('warehouseCode'))
    if warehouse_name != '成品仓库' and warehouse_code != 'Product':
        return None
    try:
        occurred = datetime.fromtimestamp(float(Decimal(str(row['createdAt'])) / 1000), SHANGHAI)
    except (KeyError, TypeError, ValueError, OverflowError, InvalidOperation):
        raise ValueError('invalid_timestamp') from None
    if not start <= occurred < end:
        return None
    amount = _record(row.get('amount'))
    changed = _record(amount.get('amount'))
    try:
        quantity = Decimal(str(changed['amount'])).copy_abs()
        if not quantity.is_finite() or len(quantity.as_tuple().digits) > 40 or abs(quantity.as_tuple().exponent) > 20:
            raise ValueError('invalid_quantity')
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise ValueError('invalid_quantity') from None
    value = amount.get('direction')
    if value is True or value == 'true' or (type(value) is int and value == 1):
        direction = 'in'
    elif value is False or value == 'false' or (type(value) is int and value == 0):
        direction = 'out'
    else:
        direction = 'unknown'
    unit = changed.get('unit')
    if isinstance(unit, dict):
        unit = unit.get('code') or unit.get('name')
    action = row.get('action')
    if isinstance(action, dict):
        action_code = _text(action.get('action') or action.get('code'))
        action_label = _text(action.get('desc') or action.get('message'))
    else:
        action_code = _text(action)
        action_label = action_code
    operator = row.get('operator')
    if isinstance(operator, dict):
        operator = operator.get('name') or operator.get('username')
    return {
        'id': _text(row.get('id')), 'occurred_at': occurred.isoformat(),
        'material_code': _text(material.get('code') or row.get('materialCode')),
        'material_name': _text(material.get('name')),
        'specification': _text(row.get('specification') or material.get('specification')),
        'warehouse_name': warehouse_name, 'direction': direction,
        'quantity': format(quantity, 'f'), 'unit': _text(unit),
        'action_code': action_code, 'action_label': action_label,
        'batch_no': _text(row.get('batchNo')), 'operator_name': _text(operator),
        'storage_location': _text(row.get('storageLocation')),
        'qr_code': _text(row.get('qrCode')),
        'trolley_code': _text(row.get('trolleyCode')),
        'label_code': _text(row.get('labelCode')),
    }


def _load_history(start, end):
    deadline = monotonic() + 20
    raw = []
    total = None
    for page in range(1, MAX_PAGES + 1):
        remaining = deadline - monotonic()
        if remaining < 1:
            raise HistoryRangeError('history_range_too_large')
        response = _fetch_page(page, start, end, min(8, remaining))
        if not isinstance(response, dict) or not isinstance(response.get('list'), list):
            raise RuntimeError('invalid_mes_response')
        records = response['list']
        reported = response.get('total')
        if reported is not None:
            try:
                reported = int(reported)
            except (ValueError, TypeError):
                raise RuntimeError('invalid_mes_total') from None
            if reported < 0 or (total is not None and total != reported):
                raise RuntimeError('mes_history_changed')
            total = reported
            if total > MAX_PAGES * PAGE_SIZE:
                raise HistoryRangeError('history_range_too_large')
        raw.extend(records)
        if total is not None and len(raw) >= total:
            if len(raw) != total:
                raise RuntimeError('invalid_mes_total')
            break
        if len(records) < PAGE_SIZE:
            if total is not None:
                raise RuntimeError('incomplete_mes_history')
            break
    else:
        raise HistoryRangeError('history_range_too_large')

    rows, seen, invalid = [], set(), 0
    for item in raw:
        if not isinstance(item, dict):
            invalid += 1
            continue
        # Duplicate IDs across pages indicate a moving/unstable upstream page.
        # Fail instead of silently dropping or double-counting movement records.
        identifier = _text(item.get('id'))
        if not identifier or identifier in seen:
            raise RuntimeError('unstable_mes_history')
        seen.add(identifier)
        try:
            row = _normalise(item, start, end)
        except ValueError:
            invalid += 1
            continue
        if row is not None:
            rows.append(row)
    if invalid or any(row['direction'] == 'unknown' or not row['material_code'] or not row['unit'] for row in rows):
        raise RuntimeError('invalid_mes_history')
    return {'rows': rows, 'source': {
        'fetched_at': timezone.now().isoformat(), 'fetched_records': len(raw),
        'invalid_records': invalid,
        'unclassified_records': sum(row['direction'] == 'unknown' for row in rows),
    }}


def closed_business_date(now=None):
    return current_business_date(now) - timedelta(days=1)


def current_business_date(now=None):
    return ((now or timezone.now()).astimezone(SHANGHAI) - timedelta(hours=8)).date()


def amounts(incoming, outgoing):
    return {'total_in': format(incoming, 'f'), 'total_out': format(outgoing, 'f'),
            'net_change': format(incoming - outgoing, 'f')}


def _group_rows(rows):
    groups = {}
    with localcontext() as ctx:
        ctx.prec = 100
        for row in sorted(rows, key=lambda r: (r['occurred_at'], r['id'])):
            key = (row['material_code'], row['warehouse_name'], row['unit'])
            if key not in groups:
                groups[key] = {k: row[k] for k in ('material_code', 'material_name', 'specification', 'warehouse_name', 'unit')}
                groups[key].update(inbound_count=0, outbound_count=0, identifiers={}, incoming=Decimal(0), outgoing=Decimal(0))
            group = groups[key]
            incoming = row['direction'] == 'in'
            group['incoming' if incoming else 'outgoing'] += Decimal(row['quantity'])
            group['inbound_count' if incoming else 'outbound_count'] += 1
            identity = (row['qr_code'], row['trolley_code'], row['label_code'])
            if identity not in group['identifiers']:
                group['identifiers'][identity] = dict(zip(('qr_code', 'trolley_code', 'label_code'), identity),
                    incoming=Decimal(0), outgoing=Decimal(0), events=[])
            detail = group['identifiers'][identity]
            detail['incoming' if incoming else 'outgoing'] += Decimal(row['quantity'])
            detail['events'].append({k: row[k] for k in ('id', 'occurred_at', 'direction', 'quantity', 'action_label', 'storage_location', 'batch_no')})
        for group in groups.values():
            group['amounts'] = amounts(group.pop('incoming'), group.pop('outgoing'))
            identifiers = group['identifiers']
            group['identifier_count'] = sum(any(key) for key in identifiers)
            group['missing_identifier_count'] = len(identifiers.get(('', '', ''), {}).get('events', []))
            for detail in identifiers.values():
                detail.update(amounts(detail.pop('incoming'), detail.pop('outgoing')))
                detail['first_at'] = detail['events'][0]['occurred_at']
                detail['last_at'] = detail['events'][-1]['occurred_at']
            group['identifiers'] = list(identifiers.values())
    return list(groups.values())


def sync_history_day(business_date, *, allow_open=False):
    """Fetch fully before publication. Preserve last good data on any failure."""
    started = timezone.now()
    if business_date > (current_business_date(started) if allow_open else closed_business_date(started)):
        raise ValueError('Only closed business days can be collected.')
    start = datetime.combine(business_date, time(8), SHANGHAI)
    end = min(start + timedelta(days=1), started.astimezone(SHANGHAI))
    payload = _load_history(start, end)
    payload['source'].update(period_start=start.isoformat(), period_end=end.isoformat())
    groups = _group_rows(payload['rows'])
    fingerprint = hashlib.sha256(json.dumps(sorted(payload['rows'], key=lambda r: r['id']), sort_keys=True).encode()).hexdigest()
    with transaction.atomic():
        day, _ = MovementHistoryDay.objects.get_or_create(business_date=business_date)
        day = MovementHistoryDay.objects.select_for_update().get(pk=day.pk)
        # A slower concurrent collector cannot replace a more recent capture.
        if day.checked_at and day.checked_at > started:
            return day.version
        latest = day.revisions.filter(version=day.version).first()
        # The final closed capture must replace an open capture even if no new
        # movements occurred, so its coverage endpoint remains auditable.
        coverage_changed = latest and latest.source.get('period_end') != end.isoformat()
        if latest is None or latest.fingerprint != fingerprint or coverage_changed:
            revision = MovementHistoryRevision.objects.create(day=day, version=day.version + 1,
                fingerprint=fingerprint, collected_at=started, source=payload['source'])
            MovementHistoryGroup.objects.bulk_create([MovementHistoryGroup(revision=revision, **group) for group in groups])
            day.version = revision.version
        day.checked_at = started
        day.save(update_fields=['version', 'checked_at'])
    return day.version


def _private(data, status=200):
    response = Response(data, status=status)
    response['Cache-Control'] = 'private, no-store'
    return response


class HistoryRefreshThrottle(UserRateThrottle):
    scope = 'movement_history_refresh'
    rate = '6/min'


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([HistoryRefreshThrottle])
def refresh_finished_goods_history(request):
    """Mirror today's read-only MES ledger; never create an MES movement."""
    if request.data or request.query_params:
        return _private({'error': 'No parameters are accepted.'}, 400)
    day = current_business_date()
    saved = MovementHistoryDay.objects.filter(business_date=day, version__gt=0).first()
    # Coalesce page opens and repeated refreshes without hiding older captures.
    if saved and saved.checked_at and timezone.now() - saved.checked_at < timedelta(seconds=30):
        return _private({'business_date': day.isoformat(), 'version': saved.version, 'refreshed': False})
    try:
        version = sync_history_day(day, allow_open=True)
    except Exception:
        return _private({'error': 'history_refresh_failed'}, 503)
    return _private({'business_date': day.isoformat(), 'version': version, 'refreshed': True})


def _model_matches(group, search):
    needle = search.casefold()
    return not needle or any(needle in getattr(group, key).casefold()
                            for key in ('material_code', 'material_name', 'specification'))


def _matching_identifiers(group, search):
    needle = search.casefold()
    if _model_matches(group, search):
        return group.identifiers
    return [item for item in group.identifiers if any(needle in item.get(key, '').casefold()
            for key in ('qr_code', 'trolley_code', 'label_code'))]


def _is_provisional(revision):
    end = revision.source.get('period_end')
    expected = datetime.combine(revision.day.business_date + timedelta(days=1), time(8), SHANGHAI)
    return (datetime.fromisoformat(end) < expected) if end else revision.day.business_date > closed_business_date()


def _summary(group, search='', direction='all'):
    item = {k: getattr(group, k) for k in ('id', 'material_code', 'material_name', 'specification',
        'warehouse_name', 'unit', 'identifier_count', 'missing_identifier_count')}
    item.update(group.amounts)
    if search and not _model_matches(group, search):
        details = _matching_identifiers(group, search)
        if not details:
            return None
        if direction != 'all' and not any(event['direction'] == direction for detail in details for event in detail['events']):
            return None
        with localcontext() as ctx:
            ctx.prec = 100
            item.update(amounts(sum((Decimal(d['total_in']) for d in details), Decimal(0)),
                                sum((Decimal(d['total_out']) for d in details), Decimal(0))))
        item['identifier_count'] = sum(any(d.get(key) for key in ('qr_code', 'trolley_code', 'label_code')) for d in details)
        item['missing_identifier_count'] = sum(len(d['events']) for d in details
            if not any(d.get(key) for key in ('qr_code', 'trolley_code', 'label_code')))
    item.update(business_date=group.revision.day.business_date.isoformat(), revision=group.revision.version,
        provisional=_is_provisional(group.revision),
        captured_through=group.revision.source.get('period_end') or group.revision.day.checked_at)
    return item


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def finished_goods_history(request):
    params = request.query_params
    today = current_business_date()
    try:
        start = _date(params.get('start_date', (today - timedelta(days=6)).isoformat()))
        end = _date(params.get('end_date', today.isoformat()))
        if not 0 <= (end - start).days < 366 or end == date.max:
            raise ValueError('Select an ordered range of at most 366 business dates.')
        direction = params.get('direction', 'all')
        ordering = params.get('ordering', 'asc')
        search = params.get('search', '').strip()
        if direction not in ('all', 'in', 'out') or ordering not in ('asc', 'desc') or len(search) > 100:
            raise ValueError('Invalid filters.')
        page = _integer(params, 'page', 1, 100_000)
        page_size = _integer(params, 'page_size', 50, 200)
    except (ValueError, TypeError, OverflowError) as exc:
        return _private({'error': str(exc)}, 400)
    # Freeze revision IDs first. Later concurrent publication cannot mix versions.
    revisions = list(MovementHistoryRevision.objects.filter(day__business_date__range=(start, end),
        version=F('day__version')).select_related('day').order_by('day__business_date'))
    token = hashlib.sha256(json.dumps([rev.pk for rev in revisions]).encode()).hexdigest()[:32]
    requested = params.get('snapshot_token', '')
    if page > 1 and not requested:
        return _private({'error': 'snapshot_token_required'}, 400)
    if requested and requested != token:
        return _private({'error': 'history_query_expired'}, 409)
    queryset = MovementHistoryGroup.objects.filter(revision_id__in=[rev.pk for rev in revisions])
    model_search = Q(material_code__icontains=search) | Q(material_name__icontains=search) | Q(specification__icontains=search)
    if search:
        queryset = queryset.filter(model_search | Q(identifiers__icontains=search))
    if direction != 'all':
        queryset = queryset.filter(**{('inbound_count' if direction == 'in' else 'outbound_count') + '__gt': 0})
    prefix = '-' if ordering == 'desc' else ''
    ordered = queryset.select_related('revision__day').order_by(prefix + 'revision__day__business_date', 'material_code', 'id')
    # Identifier searches project both the daily row and its totals to those
    # identifiers. Searching a model continues to show its complete daily flow.
    matched = None
    if search:
        # Model searches need only stored aggregates. Bound the event payload
        # needed for identifier-only projections before loading any JSON arrays.
        identifier_groups = queryset.exclude(model_search)
        event_count = identifier_groups.aggregate(count=Sum(F('inbound_count') + F('outbound_count')))['count'] or 0
        if event_count > MAX_SEARCH_EVENTS:
            return _private({'error': 'history_range_too_large'}, 400)
        identifiers = {group['id']: group['identifiers'] for group in identifier_groups.values('id', 'identifiers')} if event_count else {}
        matched = []
        for group in ordered.defer('identifiers'):
            if group.pk in identifiers:
                group.identifiers = identifiers[group.pk]
            item = _summary(group, search, direction)
            if item is not None:
                matched.append(item)
    totals = defaultdict(lambda: [Decimal(0), Decimal(0)])
    with localcontext() as ctx:
        ctx.prec = 100
        values = matched if matched is not None else queryset.values('unit', 'amounts')
        for group in values:
            movement_amounts = group if matched is not None else group['amounts']
            if direction != 'out':
                totals[group['unit']][0] += Decimal(movement_amounts['total_in'])
            if direction != 'in':
                totals[group['unit']][1] += Decimal(movement_amounts['total_out'])
        total_rows = [dict(unit=unit, **amounts(*values)) for unit, values in sorted(totals.items())]
    count = len(matched) if matched is not None else queryset.count()
    begin, finish = (page-1)*page_size, page*page_size
    result = matched[begin:finish] if matched is not None else [_summary(group) for group in ordered.defer('identifiers')[begin:finish]]
    captured = {rev.day.business_date for rev in revisions}
    dates = [start + timedelta(days=i) for i in range((end-start).days+1)]
    return _private({'count': count, 'page': page, 'page_size': page_size, 'snapshot_token': token,
        'results': result, 'totals': total_rows, 'source': {
            'fetched_at': max((rev.day.checked_at for rev in revisions), default=None),
            'missing_dates': [d.isoformat() for d in dates if d <= today and d not in captured],
            'pending_dates': [d.isoformat() for d in dates if d > today],
            'provisional_dates': [rev.day.business_date.isoformat() for rev in revisions if _is_provisional(rev)],
            'business_day': '08:00',
        }})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def finished_goods_history_detail(request, group_id):
    direction = request.query_params.get('direction', 'all')
    search = request.query_params.get('search', '').strip()
    if direction not in ('all', 'in', 'out') or len(search) > 100:
        return _private({'error': 'Invalid direction.'}, 400)
    group = MovementHistoryGroup.objects.filter(pk=group_id).first()
    if group is None:
        return _private({'error': 'not_found'}, 404)
    # Immutable old revision IDs remain readable if a daily refresh occurred.
    result = []
    for original in _matching_identifiers(group, search):
        detail = dict(original)
        events = [e for e in original['events'] if direction == 'all' or e['direction'] == direction]
        if not events:
            continue
        detail.update(events=events, first_at=events[0]['occurred_at'], last_at=events[-1]['occurred_at'])
        if direction != 'all':
            detail['total_out' if direction == 'in' else 'total_in'] = '0'
            with localcontext() as ctx:
                ctx.prec = 100
                detail['net_change'] = format(Decimal(detail['total_in']) - Decimal(detail['total_out']), 'f')
        result.append(detail)
    return _private({'id': group.pk, 'results': result})
