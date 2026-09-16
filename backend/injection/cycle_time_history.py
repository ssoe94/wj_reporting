"""Versioned, durable C/T estimates from observed MES counter intervals.

C/T is positive observed elapsed seconds / accepted shots, never wall-clock
hour / shots. A gap, counter correction/reset or compressed hourly counter
cannot establish active cycle time. No external requests are made here.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta
import hashlib
from itertools import groupby
import json
import math
import re
from zoneinfo import ZoneInfo

from django.db import connection, transaction
from django.utils import timezone

from production.cavity import build_cavity_plan_groups, default_cavity_meta, get_cavity_meta_map
from production.counter_utils import calculate_counter_increment
from production.models import ProductionExecution, ProductionPartCavity, ProductionPlan
from .cycle_time_codec import pack, unpack
from .models import InjectionCycleTimeBucket, InjectionCycleTimeRevision, InjectionMonitoringRecord

TZ = ZoneInfo('Asia/Shanghai')
VERSION = 'observed-positive-intervals-v1'
MAX_INTERVAL_SECONDS = 300
MAX_RANGE_DAYS = 366
ARCHIVE_DELAY_MINUTES = 5
ARCHIVE_LOCK_KEY = 2026091601


def business_date_at(value):
    return (value.astimezone(TZ) - timedelta(hours=8)).date()


def business_start(value):
    return datetime.combine(value, time(8), tzinfo=TZ)


def machine_number(value):
    text = str(value or '')
    for pattern in (r'-(\d+)\s*$', r'^\s*(\d+)(?:\D|$)'):
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    return None


def normalized_part(value):
    return str(value or '').strip().upper()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _finite(value):
    return value is not None and math.isfinite(float(value)) and float(value) >= 0


def _new_metrics():
    return dict(positive_interval_seconds=0.0, shot_count=0.0, observed_seconds=0.0,
                expected_seconds=0.0, sample_count=0, gap_count=0, reset_count=0,
                correction_count=0, invalid_sample_count=0, excluded_shot_count=0.0, warnings=[])


SUM_FIELDS = ('positive_interval_seconds', 'shot_count', 'observed_seconds', 'expected_seconds',
              'sample_count', 'gap_count', 'reset_count', 'correction_count',
              'invalid_sample_count', 'excluded_shot_count')


def _finish_metrics(row):
    row['cycle_time_seconds'] = round(row['positive_interval_seconds'] / row['shot_count'], 2) if row['shot_count'] > 0 else None
    row['coverage_percent'] = round(min(100.0, 100 * row['observed_seconds'] / row['expected_seconds']), 1) if row['expected_seconds'] > 0 else None
    warnings = set(row.get('warnings', []))
    if row['gap_count']:
        warnings.add('observation_gap')
    if row['reset_count']:
        warnings.add('counter_reset')
    if row['correction_count']:
        warnings.add('counter_correction')
    if row['invalid_sample_count']:
        warnings.add('invalid_counter')
    if (row['coverage_percent'] or 0) < 80:
        warnings.add('incomplete_coverage')
    if row['cycle_time_seconds'] is not None:
        row['quality'] = 'limited' if warnings else 'available'
    else:
        row['quality'] = 'no_production' if not warnings and row['observed_seconds'] > 0 else 'unavailable'
    row['warnings'] = sorted(warnings)
    for field in ('positive_interval_seconds', 'shot_count', 'observed_seconds', 'expected_seconds', 'excluded_shot_count'):
        row[field] = round(row[field], 6)
    return row


def _sum_metrics(rows):
    result = _new_metrics()
    warnings = set()
    for row in rows:
        for field in SUM_FIELDS:
            result[field] += row.get(field, 0) or 0
        warnings.update(row.get('warnings', []))
    result['warnings'] = sorted(warnings)
    return _finish_metrics(result)


def _snapshot(row, cavity_map=None):
    result = {key: getattr(row, key) for key in ('machine_name', 'part_no', 'lot_no', 'sequence', 'model_name')}
    result.update(plan_date=row.plan_date.isoformat(), part_no=normalized_part(row.part_no))
    result['source_identity'] = digest({key: result[key] for key in ('plan_date', 'machine_name', 'part_no', 'lot_no', 'sequence')})
    if isinstance(row, ProductionPlan):
        result['planned_quantity'] = row.planned_quantity
        result['cavity'] = (cavity_map or {}).get(result['part_no']) or default_cavity_meta(result['part_no'])
    else:
        result.update(start_datetime=row.start_datetime.isoformat() if row.start_datetime else None,
                      end_datetime=row.end_datetime.isoformat() if row.end_datetime else None,
                      status=row.status)
    return result


def _identity(part):
    return (part.get('part_no', ''), part.get('lot_no') or '', part.get('sequence', -1), part.get('attribution', 'unattributed'))


def _attributions(start, end, ordinal, shots, plans, executions, groups):
    """Return (identity snapshot, share), preserving unknown execution boundaries."""
    overlapping = []
    for execution in executions:
        if not execution.get('start_datetime') or not execution.get('end_datetime') or not execution.get('part_no'):
            continue
        begin = datetime.fromisoformat(execution['start_datetime'])
        finish = datetime.fromisoformat(execution['end_datetime'])
        if begin < finish and begin < end and finish > start:
            overlapping.append((execution, begin, finish))
    if overlapping:
        if len(overlapping) == 1:
            entry, begin, finish = overlapping[0]
            if begin <= start and finish >= end:
                return [({**entry, 'attribution': 'execution_interval'}, 1.0)]
        return [({'part_no': '', 'lot_no': None, 'sequence': -1, 'attribution': 'unattributed',
                  'attribution_warning': 'execution_boundary_ambiguous'}, 1.0)]
    result = []
    cursor = 0.0
    for index, group in enumerate(groups):
        stop = cursor + float(group['required_shots'])
        # Canonical plan sequence allocation sends overproduction to the final group.
        if index == len(groups) - 1:
            stop = max(stop, ordinal + shots)
        share = max(0.0, min(ordinal + shots, stop) - max(ordinal, cursor)) / shots
        if share > 0:
            for member in group['members']:
                entry = member['plan']
                if entry.get('part_no'):
                    result.append(({**entry, 'attribution': 'plan_estimated'}, share))
        cursor = stop
    if result:
        return result
    return [({'part_no': '', 'lot_no': None, 'sequence': -1, 'attribution': 'unattributed'}, 1.0)]


def _build_device_day(day, device, number, records, plans, executions, now):
    start, end = business_start(day), business_start(day) + timedelta(days=1)
    finalized_through = (now.astimezone(TZ) - timedelta(minutes=ARCHIVE_DELAY_MINUTES)).replace(minute=0, second=0, microsecond=0)
    elapsed_end = min(end, finalized_through)
    if elapsed_end <= start:
        return []
    by_hour = {}
    cursor = start
    while cursor < elapsed_end:
        metrics = _new_metrics()
        metrics['expected_seconds'] = (min(cursor + timedelta(hours=1), elapsed_end) - cursor).total_seconds()
        by_hour[cursor] = {**metrics, 'business_date': day.isoformat(), 'machine_number': number,
                           'machine_name': f'{number}호기', 'device_code': device,
                           'bucket_start': cursor.isoformat(), 'bucket_end': (cursor + timedelta(hours=1)).isoformat(),
                           'source_sample_count': 0, 'source_latest_at': None,
                           'source_records': [], 'parts_map': {}, 'source_plan_snapshots': plans,
                           'source_execution_snapshots': executions}
        cursor += timedelta(hours=1)
    cavity_map = {row['part_no']: row.get('cavity') or default_cavity_meta(row['part_no']) for row in plans}
    groups = build_cavity_plan_groups(plans, cavity_map)
    ordinal = 0.0
    previous = None
    for record in records:
        stamp = record.timestamp.astimezone(TZ)
        cap = record.capacity
        in_day = start <= stamp < elapsed_end
        hour = stamp.replace(minute=0, second=0, microsecond=0)
        if in_day and hour in by_hour:
            row = by_hour[hour]
            row['sample_count'] += 1
            row['source_sample_count'] += 1
            row['source_latest_at'] = stamp.isoformat()
            row['source_records'].append([stamp.isoformat(), float(cap) if _finite(cap) else None])
            if not _finite(cap):
                row['invalid_sample_count'] += 1
        if previous is None or not _finite(cap) or not _finite(previous.capacity):
            previous = record
            continue
        prior_stamp = previous.timestamp.astimezone(TZ)
        seconds = (stamp - prior_stamp).total_seconds()
        if seconds <= 0:
            previous = record
            continue
        interval_start, interval_end = max(start, prior_stamp), min(stamp, elapsed_end)
        if interval_start >= interval_end:
            previous = record
            continue
        delta = calculate_counter_increment(previous.capacity, cap)
        clipped_shots = delta * (interval_end - interval_start).total_seconds() / seconds
        valid = seconds <= MAX_INTERVAL_SECONDS and float(cap) >= float(previous.capacity)
        target = interval_start
        while target < interval_end:
            bucket_start = target.replace(minute=0, second=0, microsecond=0)
            stop = min(bucket_start + timedelta(hours=1), interval_end)
            span = (stop - target).total_seconds()
            row = by_hour.get(bucket_start)
            if row is not None:
                # A baseline or next-hour endpoint is part of the evidence too.
                row['source_latest_at'] = max(row.get('source_latest_at') or '', stamp.isoformat())
                row.setdefault('interval_evidence', []).append([prior_stamp.isoformat(), float(previous.capacity), stamp.isoformat(), float(cap)])
                if valid:
                    row['observed_seconds'] += span
                    if delta > 0:
                        accepted_shots = delta * span / seconds
                        piece_ordinal = ordinal + delta * (target - interval_start).total_seconds() / seconds
                        attribution = _attributions(target, stop, piece_ordinal, accepted_shots, plans, executions, groups)
                        row['positive_interval_seconds'] += span
                        row['shot_count'] += accepted_shots
                        for entry, share in attribution:
                            identity = _identity(entry)
                            part = row['parts_map'].setdefault(identity, {**_new_metrics(), **entry})
                            part['positive_interval_seconds'] += span * share
                            part['shot_count'] += accepted_shots * share
                            part['observed_seconds'] += span * share
                            part['expected_seconds'] += span * share
                            part['sample_count'] += 1
                            part['warnings'] = (['plan_estimated'] if entry['attribution'] == 'plan_estimated' else [])
                            if entry['attribution'] == 'unattributed':
                                part['warnings'] = [entry.get('attribution_warning', 'unattributed')]
                else:
                    row['excluded_shot_count'] += delta * span / seconds
                    if seconds > MAX_INTERVAL_SECONDS:
                        row['gap_count'] += 1
                    if float(cap) < float(previous.capacity):
                        row['reset_count' if delta > 0 or float(cap) == 0 else 'correction_count'] += 1
            target = stop
        ordinal += clipped_shots
        previous = record
    output = []
    for row in by_hour.values():
        _finish_metrics(row)
        for part in row['parts_map'].values():
            # Part coverage is eligible attributed observation, not proof of its run duration.
            part['warnings'] = sorted(set(part['warnings']) | set(row['warnings']))
            _finish_metrics(part)
            part['coverage_percent'] = None
        row['parts'] = sorted(row.pop('parts_map').values(), key=_identity)
        row['source_fingerprint'] = digest({'records': row.pop('source_records'), 'intervals': row.get('interval_evidence', [])})
        row['source_day_sample_count'] = sum(start <= item.timestamp < elapsed_end for item in records)
        row['calculation_version'] = VERSION
        row['preservation_status'] = 'archived'
        output.append(row)
    return output


@transaction.atomic
def archive_cycle_time_range(start_date, end_date, *, machine=None, now=None, compact=True):
    """Explicit writer used only by collectors, compaction and the backfill command.

    Revisions are idempotent and serialized on PostgreSQL. Never replace dense
    archived evidence with fewer raw observations after retention compaction.
    """
    if not isinstance(start_date, date) or not isinstance(end_date, date) or start_date > end_date:
        raise ValueError('Invalid business date range.')
    if (end_date - start_date).days >= MAX_RANGE_DAYS:
        raise ValueError('The maximum range is 366 business dates.')
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [ARCHIVE_LOCK_KEY])
    now = now or timezone.now()
    counts = dict(created=0, revised=0, unchanged=0, preserved=0)
    current = start_date
    while current <= end_date:
        _archive_day(current, machine, now, counts, compact)
        current += timedelta(days=1)
    return counts


def _archive_day(day, machine, now, counts, compact):
    start, end = business_start(day), business_start(day) + timedelta(days=1)
    # One day plus boundary neighbours. A remote old baseline cannot establish C/T.
    records = list(InjectionMonitoringRecord.objects.filter(
        timestamp__gte=start - timedelta(seconds=MAX_INTERVAL_SECONDS),
        timestamp__lte=min(end + timedelta(seconds=MAX_INTERVAL_SECONDS), now),
    ).order_by('device_code', 'timestamp', 'id'))
    existing = list(InjectionCycleTimeBucket.objects.select_for_update().filter(business_date=day))
    for saved in existing:
        saved.payload = unpack(saved.payload)
    existing_by_key = {(row.device_code, row.bucket_start): row for row in existing}
    plan_rows = list(ProductionPlan.objects.filter(plan_date=day, plan_type='injection').order_by('sequence', 'id'))
    cavity_map = get_cavity_meta_map(ProductionPartCavity, {normalized_part(row.part_no) for row in plan_rows})
    plans_by_machine, executions_by_machine = defaultdict(list), defaultdict(list)
    for row in plan_rows:
        plans_by_machine[machine_number(row.machine_name)].append(_snapshot(row, cavity_map))
    # Executions may cross the business-day boundary. Include their actual interval.
    from django.db.models import Q
    execution_rows = ProductionExecution.objects.filter(plan_type='injection').filter(
        Q(plan_date=day) | Q(start_datetime__lt=end, end_datetime__gt=start)
    ).order_by('start_datetime', 'sequence', 'id')
    for row in execution_rows:
        executions_by_machine[machine_number(row.machine_name)].append(_snapshot(row))
    devices = defaultdict(list)
    for record in records:
        number = machine_number(record.machine_name)
        if number and (machine is None or machine == number):
            devices[(record.device_code, number)].append(record)
    for (device, number), source_records in devices.items():
        if not any(start <= row.timestamp < end for row in source_records):
            continue
        plans, executions = plans_by_machine[number], executions_by_machine[number]
        device_archives = [row for row in existing if row.device_code == device]
        # Source deletion must not erase saved plan/LOT identities.
        prior = next((row.payload for row in device_archives if row.payload.get('source_plan_snapshots')), {})
        retained_identity = False
        prior_plans = prior.get('source_plan_snapshots', [])
        if {row['source_identity'] for row in prior_plans} - {row['source_identity'] for row in plans}:
            plans = prior_plans
            retained_identity = True
        prior_exec = next((row.payload for row in device_archives if row.payload.get('source_execution_snapshots')), {})
        prior_executions = prior_exec.get('source_execution_snapshots', [])
        if {row['source_identity'] for row in prior_executions} - {row['source_identity'] for row in executions}:
            executions = prior_executions
            retained_identity = True
        for payload in _build_device_day(day, device, number, source_records, plans, executions, now):
            if retained_identity:
                payload['warnings'] = sorted(set(payload['warnings']) | {'source_identity_retained'})
                if payload['quality'] == 'available':
                    payload['quality'] = 'limited'
            bucket_start = datetime.fromisoformat(payload['bucket_start'])
            old = existing_by_key.get((device, bucket_start))
            if old and (payload['source_sample_count'] < old.payload.get('source_sample_count', 0) or payload['source_day_sample_count'] < old.source_day_sample_count):
                if old.source_preservation_note != 'archived_source_retained':
                    old.source_preservation_note = 'archived_source_retained'
                    old.save(update_fields=['source_preservation_note'])
                counts['preserved'] += 1
                continue
            # Evidence on adjacent-hour boundaries can also disappear during compaction.
            if old and payload['observed_seconds'] < old.payload.get('observed_seconds', 0) and (
                len(payload.get('interval_evidence', [])) < len(old.payload.get('interval_evidence', []))
            ):
                if old.source_preservation_note != 'archived_source_retained':
                    old.source_preservation_note = 'archived_source_retained'
                    old.save(update_fields=['source_preservation_note'])
                counts['preserved'] += 1
                continue
            day_sample_count = payload.pop('source_day_sample_count')
            source_hash = digest(payload)
            summary = {key: value for key, value in payload.items() if key not in ('source_plan_snapshots', 'source_execution_snapshots', 'interval_evidence')}
            if old and old.source_hash == source_hash:
                if old.source_day_sample_count < day_sample_count:
                    old.source_day_sample_count = day_sample_count
                    old.save(update_fields=['source_day_sample_count'])
                counts['unchanged'] += 1
                continue
            if old:
                old.payload, old.source_hash, old.calculation_version = (pack(payload) if compact else payload), source_hash, VERSION
                old.summary, old.source_day_sample_count = (pack(summary) if compact else summary), day_sample_count
                old.source_preservation_note = ''
                old.machine_number, old.machine_name = payload['machine_number'], payload['machine_name']
                old.revision += 1
                old.save(update_fields=['payload', 'summary', 'source_day_sample_count', 'source_preservation_note', 'source_hash', 'calculation_version', 'machine_number', 'machine_name', 'revision', 'archived_at'])
                bucket, reason = old, 'source_or_attribution_changed'
                counts['revised'] += 1
            else:
                bucket = InjectionCycleTimeBucket.objects.create(
                    device_code=device, machine_number=number, machine_name=payload['machine_name'],
                    business_date=day, bucket_start=bucket_start, calculation_version=VERSION,
                    source_hash=source_hash, payload=pack(payload) if compact else payload, summary=pack(summary) if compact else summary, source_day_sample_count=day_sample_count,
                )
                reason = 'initial_archive'
                counts['created'] += 1
            InjectionCycleTimeRevision.objects.create(bucket=bucket, revision=bucket.revision,
                source_hash=source_hash, calculation_version=VERSION, payload=pack(payload) if compact else payload, reason=reason)


def archive_cycle_time_window(start_time, end_time):
    if start_time >= end_time:
        return dict(created=0, revised=0, unchanged=0, preserved=0)
    return archive_cycle_time_range(business_date_at(start_time - timedelta(seconds=MAX_INTERVAL_SECONDS)),
                                    business_date_at(end_time + timedelta(seconds=MAX_INTERVAL_SECONDS) - timedelta(microseconds=1)))


def _public_hour(row, part_no=None):
    payload = row.summary
    parts = [part for part in payload.get('parts', []) if not part_no or part.get('part_no') == part_no]
    if part_no and not parts:
        return None
    metrics = _sum_metrics(parts) if part_no else {key: payload.get(key) for key in (*SUM_FIELDS, 'cycle_time_seconds', 'coverage_percent', 'quality', 'warnings')}
    # Full machine sampling coverage remains honest in a product slice.
    if part_no:
        for field in ('observed_seconds', 'expected_seconds', 'sample_count', 'coverage_percent'):
            metrics[field] = payload.get(field)
    if row.source_preservation_note:
        metrics['warnings'] = sorted(set(metrics.get('warnings', [])) | {row.source_preservation_note})
    return {**metrics, **{key: payload[key] for key in ('business_date', 'machine_number', 'machine_name', 'device_code', 'bucket_start', 'bucket_end')},
            'parts': parts, 'revision': row.revision, 'archived_at': row.archived_at.isoformat(),
            'source_latest_at': payload.get('source_latest_at'), 'preservation_status': 'archived',
            'calculation_version': row.calculation_version}


def _add_metrics(target, source):
    for field in SUM_FIELDS:
        target[field] += source.get(field, 0) or 0
    target['warnings'] = sorted(set(target['warnings']) | set(source.get('warnings', [])))


def _add_parts(target, parts):
    for part in parts:
        if not part.get('part_no'):
            continue
        key = _identity(part)
        accumulator = target.setdefault(key, {**_new_metrics(),
            **{field: part.get(field) for field in ('part_no', 'lot_no', 'sequence', 'attribution', 'model_name')},
            'preservation_status': 'archived'})
        _add_metrics(accumulator, part)


def _finish_parts(parts):
    result = []
    for _, part in sorted(parts.items()):
        _finish_metrics(part)
        # Attributed intervals do not establish an independent product run duration.
        part['coverage_percent'] = None
        result.append(part)
    return result


def _read_hour_stream(query, part_no):
    # A changed device mapping must not silently blend simultaneous counters.
    key = lambda row: (row.summary['bucket_start'], row.summary['machine_number'])
    def decoded_rows():
        for row in query.iterator(chunk_size=500):
            row.summary = unpack(row.summary)
            yield row

    for _, grouped in groupby(decoded_rows(), key=key):
        rows = list(grouped)
        ambiguous = sum((row.summary.get('observed_seconds') or 0) > 0 for row in rows) > 1
        for index, row in enumerate(rows):
            source = dict(row.summary)
            # One machine-hour has one coverage denominator even across device IDs.
            if index:
                source['expected_seconds'] = 0
            if ambiguous:
                source['observed_seconds'] = 0
                source['warnings'] = sorted(set(source.get('warnings', [])) | {'ambiguous_device_mapping'})
            hour = _public_hour(row, part_no)
            if hour is not None:
                if index:
                    hour['expected_seconds'] = 0
                if ambiguous:
                    hour.update(source_cycle_time_seconds=hour['cycle_time_seconds'],
                                source_shot_count=hour['shot_count'], cycle_time_seconds=None,
                                positive_interval_seconds=0.0, shot_count=0.0, observed_seconds=0.0,
                                coverage_percent=None, quality='unavailable',
                                warnings=sorted(set(hour['warnings']) | {'ambiguous_device_mapping'}))
                    hour['parts'] = [{**part, 'source_cycle_time_seconds': part.get('cycle_time_seconds'),
                        'source_shot_count': part.get('shot_count'), 'cycle_time_seconds': None,
                        'positive_interval_seconds': 0.0, 'shot_count': 0.0, 'observed_seconds': 0.0,
                        'expected_seconds': 0.0, 'coverage_percent': None, 'quality': 'unavailable',
                        'warnings': sorted(set(part.get('warnings', [])) | {'ambiguous_device_mapping'})}
                        for part in hour['parts']]
            yield source, hour


def read_cycle_time_history(start_date, end_date, *, machine=None, part_no=None):
    """Read compact summaries in a stream; a GET never creates an archive."""
    part_no = normalized_part(part_no) or None
    query = InjectionCycleTimeBucket.objects.filter(business_date__gte=start_date, business_date__lte=end_date).only(
        'summary', 'revision', 'archived_at', 'calculation_version', 'source_preservation_note')
    if machine is not None:
        query = query.filter(machine_number=machine)
    include_hourly = bool(machine or part_no) and (end_date - start_date).days < 31
    hours, day_groups, source_days, all_parts = [], {}, {}, {}
    summary = _new_metrics()
    for source, hour in _read_hour_stream(query, part_no):
        key = (source['business_date'], source['machine_number'])
        source_day = source_days.setdefault(key, _new_metrics())
        _add_metrics(source_day, source)
        if hour is None:
            continue
        if include_hourly:
            if part_no:
                hour['coverage_percent'] = None
            hours.append(hour)
        _add_metrics(summary, hour)
        _add_parts(all_parts, hour['parts'])
        group = day_groups.setdefault(key, {**_new_metrics(),
            'business_date': key[0], 'machine_number': key[1], 'machine_name': hour['machine_name'],
            'parts_map': {}, 'preservation_status': 'archived', 'revision': 0,
            'archived_at': '', 'source_latest_at': None})
        _add_metrics(group, hour)
        _add_parts(group['parts_map'], hour['parts'])
        group['revision'] = max(group['revision'], hour['revision'])
        group['archived_at'] = max(group['archived_at'], hour['archived_at'])
        if hour['source_latest_at']:
            group['source_latest_at'] = max(group['source_latest_at'] or '', hour['source_latest_at'])
    daily = []
    for key, row in sorted(day_groups.items()):
        if part_no:
            # Keep known machine collection gaps visible in the product slice.
            row['warnings'] = sorted(set(row['warnings']) | set(source_days[key]['warnings']))
            summary['warnings'] = sorted(set(summary['warnings']) | set(source_days[key]['warnings']))
        _finish_metrics(row)
        if part_no:
            row['coverage_percent'] = None
        row['parts'] = _finish_parts(row.pop('parts_map'))
        daily.append(row)
    _finish_metrics(summary)
    if part_no:
        summary['coverage_percent'] = None
    warnings = list(summary['warnings'])
    if not daily:
        warnings.append('no_archived_data')
    return {'scope': {'start_date': start_date.isoformat(), 'end_date': end_date.isoformat(),
                      'machine_number': machine, 'part_no': part_no, 'timezone': 'Asia/Shanghai', 'day_start_hour': 8},
            'calculation': {'version': VERSION, 'method': 'positive_observed_interval_seconds / accepted_counter_shots',
                            'maximum_interval_seconds': MAX_INTERVAL_SECONDS,
                            'completed_hours_only': True, 'archive_delay_minutes': ARCHIVE_DELAY_MINUTES,
                            'part_coverage_basis': 'unavailable_without_verified_product_run_duration',
                            'description': 'Estimated C/T; excludes intervals over 300 seconds and counter resets/corrections. Part assignment from plans is estimated; parallel cavity parts share shots.'},
            'summary': summary, 'daily': daily, 'hourly': hours,
            'hourly_available': include_hourly, 'parts': _finish_parts(all_parts), 'warnings': warnings}
