"""Find cross-station label issuance evidence within bounded business dates."""

from collections import defaultdict
from datetime import date
from itertools import islice

from django.db import connection
from django.db.models import Count, Max, Min, Q, TextField
from django.db.models.fields.json import KT
from django.db.models.functions import Cast, Collate

from .models import FieldEvent, FieldLabelIssuer


RESERVATION_KEY = ('issuer_namespace', 'part_no', 'label_print_date')
REVIEW_MODES = ('production', 'unknown')
_SERIAL_PATTERN = r'^[0-9A-HJ-NP-Z]{4}$'
_ASSIGNMENT_REF = 'payload__detail__issuer_assignment_id'
_SCAN_TYPES = Q(app='barcode', event_type='scan.recorded') | Q(app='weigh_label', event_type='label.reread')


def successful_label_scans(events):
    """Select successful observations of canonical barcodes."""
    return events.filter(_SCAN_TYPES, mode__in=REVIEW_MODES, result='ok', clock_suspect=False).exclude(barcode='')


def tracked_label_reservations(events):
    """Select committed reservations with an attributable printed-date key."""
    return events.filter(
        app='weigh_label', event_type='label.reserved', result='info',
        mode__in=(*REVIEW_MODES, 'test'), clock_suspect=False,
        label_print_date__isnull=False,
    ).exclude(issuer_namespace='').exclude(part_no='')


def _adjacent_days(day):
    return (
        date.fromordinal(max(date.min.toordinal(), day.toordinal() - 1)),
        date.fromordinal(min(date.max.toordinal(), day.toordinal() + 1)),
    )


def _reservation_key(row):
    return tuple(row[field] for field in RESERVATION_KEY)


def _assignment_id(value):
    if isinstance(value, str) and len(value) <= 18 and value.isascii() and value.isdecimal():
        return int(value)
    return None


def _owns_group(assignment, row):
    return (
        assignment is not None
        and assignment.station_id == row['station_id']
        and (assignment.namespace, assignment.part_no) == (row['issuer_namespace'], row['part_no'])
        and assignment.assigned_at <= row['first_at']
        and (assignment.released_at is None or assignment.released_at >= row['last_at'])
    )


def _ordered_transfer(previous, following, assignments):
    if previous['invalid_serials'] or following['invalid_serials']:
        return False
    old = assignments.get(_assignment_id(previous['assignment_ref']))
    new = assignments.get(_assignment_id(following['assignment_ref']))
    return (
        _owns_group(old, previous) and _owns_group(new, following)
        and old.released_at is not None and old.released_at <= new.assigned_at
        and previous['max_serial'] < following['min_serial']
    )


def _disputed_keys(events, keys, anchors):
    # Group once in the bounded business window. A correlated peer query
    # could visit one issuer's entire daily history for every one of its rows.
    return (
        events.order_by().values(*keys)
        .annotate(station_count=Count('station_id', distinct=True), anchor_count=Count('pk', filter=anchors))
        .filter(station_count__gt=1, anchor_count__gt=0)
        .values_list(*keys).order_by(*keys).iterator(chunk_size=1_000)
    )


def _batches(keys):
    while batch := list(islice(keys, 100)):
        yield batch


def _reserve_groups(window, keys):
    matching = Q()
    serial = Collate('serial', 'C' if connection.vendor == 'postgresql' else 'BINARY')
    for key in keys:
        matching |= Q(**dict(zip(RESERVATION_KEY, key, strict=True)))
    return (
        window.filter(matching).order_by()
        .annotate(assignment_ref=Cast(KT(_ASSIGNMENT_REF), TextField()))
        .values(*RESERVATION_KEY, 'business_date', 'station_id', 'assignment_ref')
        .annotate(
            first_at=Min('occurred_at'), last_at=Max('occurred_at'),
            min_serial=Min(serial), max_serial=Max(serial),
            invalid_serials=Count('pk', filter=~Q(serial__regex=_SERIAL_PATTERN)),
        ).order_by(*RESERVATION_KEY).iterator(chunk_size=1_000)
    )


def _reservation_exceptions(station_ids, day, add):
    first_day, last_day = _adjacent_days(day)
    window = tracked_label_reservations(FieldEvent.objects.filter(business_date__range=(first_day, last_day)))
    keys = _disputed_keys(window, RESERVATION_KEY, Q(business_date=day, station_id__in=station_ids))
    # Use the indexed printed-date key for each evidence batch. The adjoining
    # days include reservations on both sides of our 08:00 business boundary.
    for batch in _batches(keys):
        by_key = defaultdict(list)
        assignment_ids = set()
        for group in _reserve_groups(window, batch):
            by_key[_reservation_key(group)].append(group)
            assignment_id = _assignment_id(group['assignment_ref'])
            if assignment_id is not None:
                assignment_ids.add(assignment_id)
        assignments = FieldLabelIssuer.objects.in_bulk(assignment_ids)

        for (namespace, part, print_date), records in by_key.items():
            flagged = {
                anchor['station_id']
                for anchor in records
                if anchor['business_date'] == day and anchor['station_id'] in station_ids
                and any(
                    peer['station_id'] != anchor['station_id']
                    and not (_ordered_transfer(anchor, peer, assignments) or _ordered_transfer(peer, anchor, assignments))
                    for peer in records
                )
            }
            for station_id in sorted(flagged):
                add(station_id, 'concurrent_label_issuance', 1, station='', app='weigh_label',
                    type='label.reserved', part_no=part, issuer_namespace=namespace, label_print_date=print_date.isoformat(),
                    **{'from': first_day.isoformat(), 'to': last_day.isoformat()})


def _scan_exceptions(station_ids, day, add):
    observations = successful_label_scans(FieldEvent.objects.filter(business_date=day)).order_by()
    keys = _disputed_keys(observations, ('barcode',), Q(station_id__in=station_ids))
    # Exact lookups retain the existing (barcode, business_date) index.
    for batch in _batches(keys):
        groups = (
            observations.filter(station_id__in=station_ids, barcode__in=[key[0] for key in batch])
            .values_list('station_id', 'barcode').distinct().order_by('station_id', 'barcode')
        )
        for station_id, barcode in groups.iterator(chunk_size=1_000):
            add(station_id, 'duplicate_barcode_issuance_suspected', 1, station='', barcode=barcode,
                result='ok', issuance_scan='true')


def issuance_exceptions(stations, day, add):
    """Report evidence for selected stations, always checking global peers."""
    station_ids = {station.pk for station in stations}
    if station_ids:
        _reservation_exceptions(station_ids, day, add)
        _scan_exceptions(station_ids, day, add)
