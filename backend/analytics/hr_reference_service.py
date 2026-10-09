"""Company classification master, with optimistic concurrency and private history."""
from copy import deepcopy
import hashlib

from django.db import connection, IntegrityError, transaction
from django.utils import timezone

from .hr_contract import HrConflict
from .hr_service import check_version
from .models import HrClassificationHistory, HrClassificationReference


def lock_reference():
    # Serialize initial creation as well as updates. Batch imports take this
    # lock before any month locks, so a reviewed reference cannot change mid-save.
    if connection.vendor == 'postgresql':
        key = int.from_bytes(hashlib.sha256(b'wj-hr-classification-reference').digest()[:8], 'big', signed=True)
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [key])
    return HrClassificationReference.objects.select_for_update().filter(pk='company').first()


def reference_payload(record=None):
    if record is None:
        record = HrClassificationReference.objects.filter(pk='company').first()
    return {
        'reference': deepcopy(record.reference) if record else None,
        'version': record.version if record else 0,
        'updated_at': record.updated_at.isoformat() if record else None,
    }


def stored_reference(version):
    record = HrClassificationReference.objects.filter(pk='company').first()
    check_version(record, version)
    if record is None:
        raise HrConflict()
    return deepcopy(record.reference)


@transaction.atomic
def save_reference(data, user):
    from .hr_workbook_service import resolve_reference

    record = lock_reference()
    check_version(record, data['version'])
    resolved = resolve_reference(data['reference'])
    before = deepcopy(record.reference) if record else {}
    if record and before == resolved:
        return reference_payload(record)
    if record is None:
        try:
            with transaction.atomic():
                record = HrClassificationReference.objects.create(reference=resolved, updated_by=user)
        except IntegrityError as error:
            raise HrConflict() from error
    else:
        updated = HrClassificationReference.objects.filter(pk=record.pk, version=record.version).update(
            reference=resolved, version=record.version + 1, updated_by=user, updated_at=timezone.now(),
        )
        if updated != 1:
            raise HrConflict()
        record.refresh_from_db()
    HrClassificationHistory.objects.create(
        reference=record, version=record.version, before=before, after=resolved,
        actor=user, actor_label=(user.get_full_name() or user.username)[:200],
    )
    return reference_payload(record)
