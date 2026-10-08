"""Django boundary for the read-only task comparison."""
from datetime import datetime, time, timedelta

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from .cavity import get_cavity_meta_map
from .mes_progress import extract_machine_number, normalize_mes_part_no, normalize_part_no
from .mes_task_reader import fetch_task_page, normalize_tasks, read_task_pages
from .mes_task_reconciliation import SHANGHAI, observe_samples, reconcile
from .models import ProductionPartCavity, ProductionPlan


TASK_LIST_CACHE_KEY = 'production:mes-task-list:v1'


def read_snapshot():
    key = TASK_LIST_CACHE_KEY
    cached = cache.get(key)
    if cached is not None:
        return cached
    rows, complete, warnings = read_task_pages(fetch_task_page)
    tasks, identity_complete = normalize_tasks(rows, normalize_mes_part_no, extract_machine_number)
    if not identity_complete:
        warnings.append('mes_identity_incomplete')
    snapshot = {
        'tasks': tasks, 'complete': complete and identity_complete,
        'warnings': warnings, 'queried_at': timezone.now().isoformat(),
    }
    # Cache only whitelisted data, never raw payloads or errors. Retry failures on refresh.
    if snapshot['complete']:
        cache.set(key, snapshot, timeout=60)
    return snapshot


def read_observations(business_date):
    from injection.models import InjectionMonitoringRecord

    start = datetime.combine(business_date, time(8), SHANGHAI)
    end = start + timedelta(days=1)
    buckets = {number: [] for number in range(1, 18)}
    rows = InjectionMonitoringRecord.objects.filter(
        timestamp__gte=start, timestamp__lt=end, capacity__isnull=False,
    ).order_by('-timestamp').values('machine_name', 'timestamp', 'capacity')[:10000]
    for row in rows:
        number = extract_machine_number(row['machine_name'])
        if number in buckets:
            buckets[number].append({'timestamp': row['timestamp'].isoformat(), 'capacity': row['capacity']})
    return {number: observe_samples(samples) for number, samples in buckets.items()}


def build_reconciliation(business_date):
    warnings = []
    try:
        raw_plans = list(ProductionPlan.objects.filter(
            plan_type='injection', plan_date__in=[business_date, business_date + timedelta(days=1)],
        ).order_by('plan_date', 'machine_name', 'sequence', 'id').values(
            'id', 'plan_date', 'machine_name', 'part_no', 'lot_no', 'sequence', 'planned_quantity',
        ))
        plans = []
        for row in raw_plans:
            number = extract_machine_number(row['machine_name'])
            if number not in range(1, 18):
                warnings.append('plan_equipment_unmapped')
                continue
            plans.append({
                'plan_id': row['id'], 'plan_date': row['plan_date'].isoformat(),
                'machine_number': number, 'part_no': normalize_part_no(row['part_no']),
                'lot_no': row['lot_no'] or '', 'sequence': row['sequence'],
                'planned_quantity': row['planned_quantity'],
            })
        cavity_map = get_cavity_meta_map(ProductionPartCavity, {row['part_no'] for row in plans})
    except Exception:
        plans, cavity_map = [], {}
        warnings.append('plan_read_failed')
    try:
        snapshot = read_snapshot()
    except Exception:
        snapshot = {'tasks': [], 'complete': False, 'queried_at': None, 'warnings': ['mes_read_failed']}
    try:
        observations = read_observations(business_date)
    except Exception:
        observations = {number: {'state': 'unavailable', 'sample_count': 0, 'first_at': None, 'last_at': None}
                        for number in range(1, 18)}
        warnings.append('observation_read_failed')
    old_days = getattr(settings, 'MES_TASK_OLD_OPEN_DAYS', 14)
    if type(old_days) is not int or old_days < 1:
        old_days = 14
    return reconcile(
        business_date=business_date, plans=plans, tasks=snapshot['tasks'], cavity_map=cavity_map,
        observations=observations, mes_complete=snapshot['complete'],
        plan_source_complete=not any(code in warnings for code in ('plan_equipment_unmapped', 'plan_read_failed')),
        queried_at=snapshot['queried_at'], now=timezone.now(),
        warnings=warnings + snapshot['warnings'], old_days=old_days,
    )
