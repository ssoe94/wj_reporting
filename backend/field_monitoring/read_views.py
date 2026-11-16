"""Read the field ledger without changing source records or station state."""

from collections import Counter, defaultdict
import csv
from datetime import date, timedelta
import hashlib
import json
import re

from django.core import signing
from django.db.models import Count, Exists, F, OuterRef, Q, Subquery, TextField
from django.db.models.fields.json import KT
from django.db.models.functions import Cast
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response

from config.authentication import ScopedJWTAuthentication
from injection.cycle_time_history import business_date_at

from .base import FieldAPIView
from .models import FieldEvent, FieldStation, FieldStationHeartbeat
from .permissions import CanViewFieldMonitoring

CSV_LIMIT = 10_000
RESULTS = ('ok', 'ng', 'error', 'info')
FORMULA_PREFIXES = ('=', '+', '-', '@', '＝', '＋', '－', '＠')
RESULT_EXCEPTION_TYPES = {
    'weigh.result': ('weight_outside_limit',),
    'label.dispatched': ('print_uncertain', 'print_rejected_unsent'),
    'vision.cycle': ('operation_not_confirmed', 'vision_incomplete'),
    'device.state': ('vision_device_fault', 'vision_runtime_fault'),
    'capture.pair': ('capture_pair_incomplete',),
    'vision.batch': ('uv_batch_fail',),
}
WORK_EVENT_TYPES = (
    'scan.recorded', 'weigh.result', 'label.reserved', 'label.dispatched',
    'label.reread', 'vision.cycle', 'capture.pair', 'capture.single', 'vision.batch',
)
SEARCH_FIELDS = {
    'station': ('station__station_id', 64),
    'app': ('app', 64),
    'type': ('event_type', 64),
    'result': ('result', 64),
    'reason': ('reason', 64),
    'mode': ('mode', 64),
    'barcode': ('barcode', 256),
    'serial': ('serial', 128),
    'part_no': ('part_no', 128),
    'job_id': ('job_id', 128),
    'cycle_id': ('payload__ref__cycle_id', 128),
}
JOB_DETAIL_SLOTS = tuple(f'payload__detail__job_ids__{idx}' for idx in range(3))
VISION_CYCLE_REF = 'payload__ref__cycle_id'
VISION_VERDICT = Q(result='ok', reason='occlusion_confirmed') | Q(result='ng', reason='operation_not_confirmed')
VISION_INCOMPLETE = Q(result='error', reason='vision_incomplete')
CURSOR_SALT = 'field-monitoring-event-page-v1'


class QueryError(ValueError):
    pass


def _date(value, name):
    if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        raise QueryError(f'{name} must use YYYY-MM-DD.')
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise QueryError(f'{name} must be a valid date.') from exc


def _filter_value(params, name):
    value = params.get(name, '')
    length = len(value.encode('utf-8')) if name == 'barcode' else len(value)
    if '\x00' in value or length > SEARCH_FIELDS[name][1]:
        raise QueryError(f'{name} exceeds the supported filter format.')
    return value


def _stations(params, now):
    raw_day = params.get('business_date')
    day = _date(raw_day, 'business_date') if raw_day is not None else business_date_at(now)
    stations = FieldStation.objects.order_by('station_id')
    station = _filter_value(params, 'station')
    if station:
        stations = stations.filter(station_id=station)
    stations = list(stations)
    heartbeats = {
        entry.station_id: entry
        for entry in FieldStationHeartbeat.objects.filter(station_id__in=[s.pk for s in stations])
    }
    return day, stations, heartbeats


def _health(station, heartbeat, now):
    if heartbeat is None:
        return 'never', []

    age = now - heartbeat.received_at
    if age <= timedelta(minutes=3):
        connection = 'online'
    elif age <= timedelta(minutes=15):
        connection = 'stale'
    else:
        connection = 'offline'

    warnings = []
    if station.enabled:
        if connection != 'online':
            warnings.append(f'connection_{connection}')
        if heartbeat.clock_offset_seconds is not None and abs(heartbeat.clock_offset_seconds) > 300:
            warnings.append('clock_offset')
        if heartbeat.duplicate_sender_until and heartbeat.duplicate_sender_until > now:
            warnings.append('duplicate_sender')
        outbox = heartbeat.payload.get('outbox') or {}
        oldest_raw = outbox.get('oldest_occurred_at')
        oldest = parse_datetime(oldest_raw) if isinstance(oldest_raw, str) else None
        if outbox.get('state') in ('blocked', 'storage_pressure') or (
            (outbox.get('pending_count') or 0) > 0
            and oldest is not None
            and oldest.tzinfo is not None
            and now - oldest > timedelta(minutes=30)
        ):
            warnings.append('upload_backlog')
    return connection, warnings


def _day_events(stations, day):
    return FieldEvent.objects.filter(
        station_id__in=[station.pk for station in stations], business_date=day, clock_suspect=False,
    ).order_by()


def _json_text(path):
    # A cast makes comparison use Django's text lookup on SQLite as well.
    return Cast(KT(path), TextField())


def _vision_cycles(query):
    return (
        query.filter(
            VISION_VERDICT | VISION_INCOMPLETE,
            app='vision_backcover', event_type='vision.cycle', mode='production', clock_suspect=False,
        )
        .annotate(cycle_key=_json_text(VISION_CYCLE_REF))
        .filter(cycle_key__isnull=False)
        .exclude(cycle_key='')
    )


def _same_vision_cycle():
    # The producer's ref.cycle_id incorporates its session. A restart can
    # append contradictory evidence for that same cycle on a later day.
    return _vision_cycles(FieldEvent.objects.all()).filter(
        station_id=OuterRef('station_id'), cycle_key=OuterRef('cycle_key'),
    )


def _conflicted_vision_cycles(events):
    related = _same_vision_cycle()
    return _vision_cycles(events).filter(
        (VISION_VERDICT & Q(Exists(related.filter(VISION_INCOMPLETE))))
        | (VISION_INCOMPLETE & Q(Exists(related.filter(VISION_VERDICT))))
    )


def _clean_production(events):
    return events.filter(mode='production').exclude(pk__in=_conflicted_vision_cycles(events).values('pk'))


def _production_counts(events):
    counts = defaultdict(lambda: defaultdict(Counter))
    rows = _clean_production(events).values('station_id', 'app', 'result').annotate(count=Count('pk'))
    for row in rows:
        counts[row['station_id']][row['app']][row['result']] = row['count']
    return counts


def _non_production_counts(events):
    counts = defaultdict(Counter)
    rows = events.exclude(mode='production').values('station_id', 'app').annotate(count=Count('pk'))
    for row in rows:
        counts[row['station_id']][row['app']] = row['count']
    return counts


def _app_counts(apps, app_status, production, non_production):
    app_names = dict.fromkeys([*apps, *(item['app'] for item in app_status), *sorted(set(production) | set(non_production))])
    totals = Counter()
    rows = []
    for app in app_names:
        results = {result: production.get(app, {}).get(result, 0) for result in RESULTS}
        totals.update(results)
        rows.append({'app': app, 'production_counts': results, 'non_production_count': non_production[app]})
    return rows, {result: totals[result] for result in RESULTS}


def _reread_overdue(events, now):
    submissions = events.filter(
        app='weigh_label', event_type='label.dispatched', reason='print_submitted',
        occurred_at__lt=now - timedelta(minutes=30),
    )
    rereads = FieldEvent.objects.filter(
        app='weigh_label', event_type='label.reread', mode='production', clock_suspect=False,
        result='ok', reason='reread_match', payload__detail__label_origin='local',
        station_id=OuterRef('station_id'), job_id=OuterRef('submission_job'),
        occurred_at__gt=OuterRef('occurred_at'), occurred_at__lte=now,
    )

    def overdue_for(job):
        return (
            submissions.annotate(submission_job=job)
            .filter(submission_job__isnull=False)
            .exclude(submission_job='')
            .filter(~Exists(rereads))
            .values_list('station_id', 'submission_job')
        )

    # Both ordinary jobs and up to three jobs sharing one physical row use the
    # same closure rule. UNION removes repeated submissions of the same job.
    return overdue_for(F('job_id')).union(
        *(overdue_for(_json_text(key)) for key in JOB_DETAIL_SLOTS)
    )


def _collect_exceptions(stations, heartbeats, events, now, add):
    production = events.filter(mode='production')
    exception_types = Q(app='barcode', event_type='scan.recorded', result='ng')
    for event_type, reasons in RESULT_EXCEPTION_TYPES.items():
        exception_types |= Q(event_type=event_type, reason__in=reasons)
    for item in _clean_production(events).filter(exception_types).values(
        'station_id', 'app', 'event_type', 'reason', 'result',
    ).annotate(count=Count('pk')):
        add(
            item['station_id'], item['reason'], item['count'], app=item['app'], type=item['event_type'],
            reason=item['reason'], result=item['result'], mode='production',
        )

    related = _same_vision_cycle()
    vision_conflicts = _conflicted_vision_cycles(production).annotate(
        first_day=Subquery(related.order_by('business_date').values('business_date')[:1]),
        last_day=Subquery(related.order_by('-business_date').values('business_date')[:1]),
    ).values_list('station_id', 'cycle_key', 'first_day', 'last_day').distinct()
    for station_id, cycle_id, first_day, last_day in vision_conflicts.iterator(chunk_size=1_000):
        add(station_id, 'vision_cycle_conflict', 1, app='vision_backcover', type='vision.cycle',
            cycle_id=cycle_id, mode='production', **{'from': first_day.isoformat(), 'to': last_day.isoformat()})

    for station_id, job_id in _reread_overdue(production, now).iterator(chunk_size=1_000):
        add(station_id, 'print_reread_overdue', 1, app='weigh_label', job_id=job_id, mode='production')

    active_apps = production.filter(
        station_id=OuterRef('station_id'), app=OuterRef('app'), event_type__in=WORK_EVENT_TYPES,
    )
    for item in events.filter(
        mode__in=('test', 'demo', 'manual'),
    ).filter(Exists(active_apps)).values('station_id', 'app', 'mode').annotate(count=Count('pk')):
        add(item['station_id'], 'non_production_activity', item['count'], app=item['app'], mode=item['mode'])

    for station in stations:
        heartbeat = heartbeats.get(station.pk)
        _, warnings = _health(station, heartbeat, now)
        for warning in warnings:
            add(station.pk, warning, 1)
        if station.enabled and heartbeat is not None:
            fault_counts = Counter(
                (device['app'], device['state']) for device in heartbeat.payload.get('devices', [])
                if device['state'] in ('fault', 'disconnected')
            )
            for (app, state), count in fault_counts.items():
                add(station.pk, f'device_{state}', count, app=app, type='device.state')


def _exceptions(stations, heartbeats, events, day, now):
    by_id = {item.pk: item for item in stations}
    rows = []
    lookup_date = day.isoformat()

    def add(station_id, code, count, **filters):
        station = by_id[station_id]
        rows.append({
            'station_id': station.station_id,
            'display_name': station.display_name,
            'reason': code,
            'count': count,
            'filters': {'from': lookup_date, 'to': lookup_date, 'station': station.station_id, **filters},
        })

    _collect_exceptions(stations, heartbeats, events, now, add)
    return sorted(rows, key=lambda row: (
        row['station_id'], row['reason'], row['filters'].get('app', ''),
        row['filters'].get('mode', ''), row['filters'].get('job_id', ''),
        row['filters'].get('cycle_id', ''),
    ))


def _exception_counts(stations, heartbeats, events, now):
    counts = Counter()

    def add(station_id, _code, count, **_filters):
        counts[station_id] += count

    if stations:
        _collect_exceptions(stations, heartbeats, events, now, add)
    return counts


def _event_search(params):
    first = params.get('from')
    last = params.get('to')
    today = business_date_at(timezone.now()).isoformat()
    start = _date(first if first is not None else last if last is not None else today, 'from')
    end = _date(last if last is not None else start.isoformat(), 'to')
    if start > end:
        raise QueryError('from must not follow to.')

    query = FieldEvent.objects.filter(business_date__range=(start, end))
    scope = {'from': start.isoformat(), 'to': end.isoformat()}
    for name, (field, _) in SEARCH_FIELDS.items():
        value = _filter_value(params, name)
        if not value:
            continue
        scope[name] = value
        lookup = Q(**{field: value})
        if name == 'job_id':
            for slot in JOB_DETAIL_SLOTS:
                lookup |= Q(**{slot: value})
        query = query.filter(lookup)
    return query.select_related('station').order_by('-occurred_at', '-pk'), scope


def _scope_digest(scope):
    return hashlib.sha256(json.dumps(scope, sort_keys=True).encode('utf-8')).hexdigest()


def _event_page(params):
    query, scope = _event_search(params)
    raw_size = params.get('page_size', '100')
    if not re.fullmatch(r'[1-9][0-9]{0,2}', raw_size) or int(raw_size) > 500:
        raise QueryError('page_size must be between 1 and 500.')
    size = int(raw_size)
    scope_hash = _scope_digest(scope)
    cursor = params.get('cursor')
    if cursor:
        try:
            if len(cursor) > 1024:
                raise ValueError()
            marker = signing.loads(cursor, salt=CURSOR_SALT)
            timestamp = parse_datetime(marker['occurred_at'])
            pk = marker['pk']
            if marker['scope'] != scope_hash or timestamp is None or timestamp.tzinfo is None or type(pk) is not int:
                raise ValueError()
        except (AttributeError, KeyError, TypeError, ValueError, signing.BadSignature) as exc:
            raise QueryError('cursor does not match this search.') from exc
        query = query.filter(Q(occurred_at__lt=timestamp) | Q(occurred_at=timestamp, pk__lt=pk))

    items = list(query[: size + 1])
    next_cursor = None
    if len(items) > size:
        items.pop()
        last = items[-1]
        next_cursor = signing.dumps(
            {'scope': scope_hash, 'occurred_at': last.occurred_at.isoformat(), 'pk': last.pk}, salt=CURSOR_SALT,
        )
    return {'results': [_row(item) for item in items], 'next_cursor': next_cursor}


def _row(event):
    return {
        'id': event.pk,
        'station_id': event.station.station_id,
        'business_date': event.business_date,
        'app': event.app,
        'type': event.event_type,
        'result': event.result,
        'reason': event.reason,
        'mode': event.mode,
        'occurred_at': event.occurred_at,
        'received_at': event.received_at,
        'barcode': event.barcode,
        'serial': event.serial,
        'part_no': event.part_no,
        'status_raw': event.payload.get('status_raw'),
        'ref': event.payload.get('ref', {}),
        'detail': event.payload.get('detail', {}),
        'clock_suspect': event.clock_suspect,
        'clock_offset_seconds': event.clock_offset_seconds,
    }


def _csv_cell(value):
    if isinstance(value, str) and (
        value.startswith(('\t', '\r', '\n'))
        or value.lstrip(' \t\r\n\v\f\u00a0\u200b\ufeff').startswith(FORMULA_PREFIXES)
    ):
        return "'" + value
    return value


class FieldReadView(FieldAPIView):
    authentication_classes = [ScopedJWTAuthentication]
    permission_classes = [CanViewFieldMonitoring]

    def get(self, request):
        try:
            return self.read(request.query_params)
        except QueryError as exc:
            return Response({'code': 'invalid_filter', 'detail': str(exc)}, status=400)


class OverviewView(FieldReadView):
    def read(self, params):
        now = timezone.now()
        day, stations, heartbeats = _stations(params, now)
        events = _day_events(stations, day)
        production_counts = _production_counts(events)
        non_production_counts = _non_production_counts(events)
        exception_counts = _exception_counts(stations, heartbeats, events, now)
        online_count = 0
        output = []
        for station in stations:
            heartbeat = heartbeats.get(station.pk)
            payload = heartbeat.payload if heartbeat is not None else {}
            connection, warnings = _health(station, heartbeat, now)
            online_count += connection == 'online'
            app_status = payload.get('apps', [])
            app_counts, station_totals = _app_counts(
                station.apps, app_status, production_counts[station.pk], non_production_counts[station.pk],
            )
            output.append({
                'station_id': station.station_id,
                'display_name': station.display_name,
                'apps': station.apps,
                'location': station.location,
                'line_note': station.line_note,
                'enabled': station.enabled,
                'connection': connection,
                'last_heartbeat_at': heartbeat.received_at if heartbeat is not None else None,
                'app_status': app_status,
                'devices': payload.get('devices', []),
                'outbox': payload.get('outbox'),
                'production_counts': station_totals,
                'non_production_count': sum(non_production_counts[station.pk].values()),
                'app_counts': app_counts,
                'exception_count': exception_counts[station.pk],
                'clock_offset_seconds': heartbeat.clock_offset_seconds if heartbeat is not None else None,
                'warnings': warnings,
            })
        return Response({
            'business_date': day,
            'stations': output,
            'summary': {
                'registered_pc_count': len(output),
                'online_pc_count': online_count,
                'disconnected_pc_count': len(output) - online_count,
                'exception_count': sum(exception_counts.values()),
            },
        })


class ExceptionsView(FieldReadView):
    def read(self, params):
        now = timezone.now()
        day, stations, heartbeats = _stations(params, now)
        events = _day_events(stations, day)
        rows = _exceptions(stations, heartbeats, events, day, now)
        return Response({'business_date': day, 'exceptions': rows})


class EventsView(FieldReadView):
    def read(self, params):
        return Response(_event_page(params))


class EventsCsvView(FieldReadView):
    def read(self, params):
        query, _ = _event_search(params)
        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="field-monitoring-events.csv"'
        response.write('\ufeff')
        fields = (
            'id', 'business_date', 'station_id', 'app', 'type', 'result', 'reason', 'mode', 'occurred_at',
            'received_at', 'barcode', 'serial', 'part_no', 'status_raw', 'clock_suspect', 'clock_offset_seconds',
        )
        writer = csv.writer(response)
        writer.writerow(fields)
        for index, event in enumerate(query[: CSV_LIMIT + 1].iterator(chunk_size=1_000)):
            if index == CSV_LIMIT:
                return Response({'code': 'csv_limit_exceeded', 'limit': CSV_LIMIT}, status=400)
            row = _row(event)
            writer.writerow([_csv_cell(row[field]) for field in fields])
        return response
