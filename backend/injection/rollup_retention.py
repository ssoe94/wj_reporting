"""Retain 30 days of five-minute buckets, preserving verified hourly totals."""
from datetime import timedelta
from itertools import groupby
import math

from django.db import connection, transaction
from django.db.models.functions import TruncHour
from django.utils import timezone

from .models import InjectionMonitoringRollup

RETENTION_DAYS = 30


def retention_cutoff(now=None):
    return ((now or timezone.now()) - timedelta(days=RETENTION_DAYS)).replace(minute=0, second=0, microsecond=0)


def compact_five_minute_rollups(start, end, *, apply=False, max_hours=24, now=None):
    if start.minute or start.second or start.microsecond:
        start = start.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    end = min(end, retention_cutoff(now)).replace(minute=0, second=0, microsecond=0)
    hours = list(InjectionMonitoringRollup.objects.filter(
        bucket_minutes=5, bucket_start__gte=start, bucket_start__lt=end,
    ).annotate(hour=TruncHour('bucket_start')).order_by('hour').values_list('hour', flat=True).distinct()[:max_hours])
    result = {'hours': 0, 'eligible_rows': 0, 'deleted_rows': 0, 'created_hours': 0, 'skipped_groups': 0, 'next_start': None}
    for hour in hours:
        with transaction.atomic():
            if connection.vendor == 'postgresql':
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL lock_timeout = '2s'")
                    cursor.execute("SET LOCAL statement_timeout = '15s'")
                    cursor.execute('SELECT pg_advisory_xact_lock(%s)', [2026091603])
            rows = list(InjectionMonitoringRollup.objects.select_for_update().filter(
                bucket_minutes=5, bucket_start__gte=hour, bucket_start__lt=hour + timedelta(hours=1),
            ).order_by('device_code', 'bucket_start'))
            for device, grouped in groupby(rows, key=lambda row: row.device_code):
                source = list(grouped)
                # Partial hours are not proof of a complete hourly total.
                if len(source) != 12 or any(row.bucket_start != hour + timedelta(minutes=5 * i) for i, row in enumerate(source)) or len({row.machine_name for row in source}) != 1:
                    result['skipped_groups'] += 1
                    continue
                values = {field: sum(getattr(row, field) for row in source) for field in ('shot_count', 'active_minutes', 'sample_count')}
                if any(not math.isfinite(value) or value < 0 for value in values.values()):
                    result['skipped_groups'] += 1
                    continue
                powers = [row.max_power_kwh for row in source if row.max_power_kwh is not None]
                values.update(machine_name=source[0].machine_name, start_capacity=source[0].start_capacity,
                              end_capacity=source[-1].end_capacity, max_power_kwh=max(powers) if powers else None)
                target = InjectionMonitoringRollup.objects.select_for_update().filter(
                    device_code=device, bucket_start=hour, bucket_minutes=60).first()
                if target:
                    # Independent writers round each bucket to 3 decimals. Preserve
                    # the existing hour only when the totals agree within that bound.
                    agrees = all(math.isclose(getattr(target, field), values[field], rel_tol=0, abs_tol=0.013)
                                 for field in ('shot_count', 'active_minutes'))
                    agrees = agrees and all(getattr(target, field) == values[field]
                                            for field in ('sample_count', 'machine_name', 'start_capacity', 'end_capacity', 'max_power_kwh'))
                    if not agrees:
                        result['skipped_groups'] += 1
                        continue
                elif apply:
                    InjectionMonitoringRollup.objects.create(device_code=device, bucket_start=hour, bucket_minutes=60, **values)
                    result['created_hours'] += 1
                result['eligible_rows'] += len(source)
                if apply:
                    deleted, _ = InjectionMonitoringRollup.objects.filter(pk__in=[row.pk for row in source]).delete()
                    result['deleted_rows'] += deleted
        result['hours'] += 1
        result['next_start'] = (hour + timedelta(hours=1)).isoformat()
    return result
