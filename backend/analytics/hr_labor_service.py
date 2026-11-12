"""Effective labor standards and explicit calendars with atomic private audit."""
from copy import deepcopy
import hashlib

from django.db import connection, IntegrityError, transaction
from django.utils import timezone

from .hr_contract import HrConflict, validate_month
from .hr_labor_rules import default_labor_rules
from .hr_service import check_version
from .models import HrLaborStandard, HrLaborCalendar, HrLaborStandardHistory, HrLaborCalendarHistory


def lock_labor(scope):
    # One lock per collection precedes snapshots, including missing start months.
    if connection.vendor == 'postgresql':
        key = int.from_bytes(hashlib.sha256(f'wj-hr-labor-{scope}'.encode()).digest()[:8], 'big', signed=True)
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [key])


def effective_standard(month):
    validate_month(month)
    record = HrLaborStandard.objects.filter(month__lte=month).order_by('-month').first()
    return {'month': record.month if record else None, 'version': record.version if record else 0,
            'rules': deepcopy(record.rules) if record else default_labor_rules()}


def _history(record):
    return list(record.history.order_by('-created_at', '-pk').values(
        'id', 'version', 'before', 'after', 'reason', 'actor_label', 'created_at')[:20]) if record else []


def standard_payload(month):
    record = HrLaborStandard.objects.filter(pk=month).first()
    source = effective_standard(month)
    return {'month': month, 'version': record.version if record else 0,
            'source_month': source['month'], 'source_version': source['version'], 'rules': source['rules'],
            'periods': list(HrLaborStandard.objects.values('month', 'version')), 'history': _history(record)}


def calendar_payload(month):
    record = HrLaborCalendar.objects.filter(pk=month).first()
    return {'month': month, 'version': record.version if record else 0,
            'days': deepcopy(record.days) if record else {}, 'history': _history(record)}


def _save(model, audit_model, relation, month, field, data, actor):
    lock_labor(relation)
    record = model.objects.select_for_update().filter(pk=month).first()
    check_version(record, data['version'])
    before = deepcopy(getattr(record, field)) if record else {}
    after = data[field]
    if record and before == after:
        return
    if record is None:
        try:
            with transaction.atomic():
                record = model.objects.create(month=month, **{field: after}, updated_by=actor)
        except IntegrityError as error:
            raise HrConflict() from error
    else:
        updated = model.objects.filter(pk=record.pk, version=record.version).update(
            **{field: after}, version=record.version + 1, updated_by=actor, updated_at=timezone.now())
        if updated != 1:
            raise HrConflict()
        record.refresh_from_db()
    audit_model.objects.create(**{relation: record}, version=record.version, before=before, after=after,
                               reason=data['reason'], actor=actor,
                               actor_label=(actor.get_full_name() or actor.username)[:200])


@transaction.atomic
def save_standard(month, data, actor):
    _save(HrLaborStandard, HrLaborStandardHistory, 'standard', month, 'rules', data, actor)
    return standard_payload(month)


@transaction.atomic
def save_calendar(month, data, actor):
    _save(HrLaborCalendar, HrLaborCalendarHistory, 'calendar', month, 'days', data, actor)
    return calendar_payload(month)
