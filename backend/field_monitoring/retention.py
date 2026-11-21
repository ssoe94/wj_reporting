"""Bounded retention of occurrence-day field history."""

from heapq import merge

from django.db import connection, transaction
from django.db.models import Q

from injection.cycle_time_history import business_date_at

from .issuer_rules import label_date_code, serial_number
from .models import FieldArchiveEvent, FieldEvent, FieldIssuerRetainedFloor, FieldStation


DEFAULT_LIMIT = 500
MAX_LIMIT = 5000
_PURGE_LOCK = 2026112105
_TABLES = {'live': FieldEvent, 'archive': FieldArchiveEvent}
_RESERVATION_COLUMNS = ('station_id', 'issuer_namespace', 'part_no', 'label_print_date', 'serial')


def history_cutoff(moment):
    today = business_date_at(moment)
    year = today.year - 2
    day = 28 if today.month == 2 and today.day == 29 else today.day
    return today.replace(year=year, day=day)


def retain_serial_floors(reservations):
    floors = {}
    for station, namespace, part_no, day, serial in reservations:
        number = serial_number(serial)
        if day is not None and namespace and number is not None:
            key = (station, namespace, part_no, label_date_code(day))
            candidate = (number, day)
            if key not in floors or candidate > floors[key]:
                floors[key] = candidate
    for (station, namespace, part_no, code), (number, day) in sorted(floors.items()):
        floor, created = FieldIssuerRetainedFloor.objects.get_or_create(
            station_id=station, namespace=namespace, part_no=part_no, date_code=code,
            defaults={'serial_floor': number, 'print_date': day},
        )
        if not created:
            # Protect against a concurrent late batch and retain the greater
            # date on equal serials, matching the issuer's date-code merge.
            FieldIssuerRetainedFloor.objects.filter(pk=floor.pk).filter(
                Q(serial_floor__lt=number) | Q(serial_floor=number, print_date__lt=day)
            ).update(serial_floor=number, print_date=day)


def _candidate_rows(model, name, cutoff, limit):
    rows = model.objects.filter(business_date__lt=cutoff).order_by('business_date', 'pk')
    return [(day, name, pk) for day, pk in rows.values_list('business_date', 'pk')[:limit]]


@transaction.atomic
def prune_field_history(moment, *, limit=DEFAULT_LIMIT, dry_run=True):
    if not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f'limit must be between 1 and {MAX_LIMIT}')
    cutoff = history_cutoff(moment)
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '2s'")
            cursor.execute("SET LOCAL statement_timeout = '15s'")
            if not dry_run:
                cursor.execute('SELECT pg_advisory_xact_lock(%s)', [_PURGE_LOCK])
    candidates = list(merge(*(_candidate_rows(model, name, cutoff, limit + 1)
                              for name, model in _TABLES.items())))
    selected = {name: [] for name in _TABLES}
    for _, name, pk in candidates[:limit]:
        selected[name].append(pk)

    deleted = dict.fromkeys(_TABLES, 0)
    if not dry_run:
        for name, model in _TABLES.items():
            rows = model.objects.filter(pk__in=selected[name], business_date__lt=cutoff)
            if model is FieldEvent:
                reservations = list(rows.filter(
                    app='weigh_label', event_type='label.reserved', label_print_date__isnull=False,
                ).values_list(*_RESERVATION_COLUMNS))
                # Order writes with ingest and issuer release before acquiring
                # any floor locks or checking its station foreign key.
                stations = {reservation[0] for reservation in reservations}
                list(FieldStation.objects.select_for_update().filter(pk__in=stations)
                     .order_by('pk').values_list('pk', flat=True))
                retain_serial_floors(reservations)
            _, by_model = rows.delete()
            deleted[name] = by_model.get(model._meta.label, 0)
    return {
        'cutoff_business_date': cutoff.isoformat(), 'dry_run': dry_run, 'limit': limit,
        'selected': {name: len(ids) for name, ids in selected.items()},
        'deleted': deleted, 'more_eligible': len(candidates) > limit,
    }
