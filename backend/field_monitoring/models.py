from django.conf import settings
from django.db import models
from django.db.models import Q


class FieldStation(models.Model):
    station_id = models.SlugField(max_length=64, unique=True)
    display_name = models.CharField(max_length=120)
    apps = models.JSONField(default=list)
    location = models.CharField(max_length=120, blank=True)
    line_note = models.CharField(max_length=160, blank=True)
    enabled = models.BooleanField(default=True)
    issuer_policy_revision = models.PositiveBigIntegerField(default=0)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class FieldStationChange(models.Model):
    station = models.ForeignKey(FieldStation, on_delete=models.PROTECT)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+')
    action = models.CharField(max_length=16)
    changes = models.JSONField(default=dict)
    recorded_at = models.DateTimeField(auto_now_add=True)


class FieldCredential(models.Model):
    station = models.ForeignKey(FieldStation, on_delete=models.PROTECT)
    key_id = models.CharField(max_length=32, unique=True)
    secret_hash = models.CharField(max_length=64)
    issued_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+')
    issued_at = models.DateTimeField(auto_now_add=True)
    revoked_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name='+')
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['station'], condition=Q(revoked_at__isnull=True),
                                    name='field_one_active_credential'),
        ]


class FieldIngestBatch(models.Model):
    station = models.ForeignKey(FieldStation, on_delete=models.PROTECT)
    batch_id = models.UUIDField()
    request_sha256 = models.CharField(max_length=64)
    ack = models.JSONField()
    received_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['station', 'batch_id'], name='field_batch_identity'),
        ]


class FieldEvent(models.Model):
    station = models.ForeignKey(FieldStation, on_delete=models.PROTECT)
    database_id = models.UUIDField()
    seq = models.PositiveBigIntegerField()
    app = models.CharField(max_length=64)
    event_type = models.CharField(max_length=64)
    mode = models.CharField(max_length=16)
    result = models.CharField(max_length=16)
    reason = models.CharField(max_length=64)
    barcode = models.CharField(max_length=256, blank=True)
    serial = models.CharField(max_length=128, blank=True)
    part_no = models.CharField(max_length=128, blank=True)
    issuer_namespace = models.CharField(max_length=3, blank=True)
    label_print_date = models.DateField(null=True)
    job_id = models.CharField(max_length=128, blank=True)
    occurred_at = models.DateTimeField()
    received_at = models.DateTimeField()
    business_date = models.DateField()
    clock_offset_seconds = models.BigIntegerField(null=True)
    clock_suspect = models.BooleanField(default=False)
    payload = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['station', 'database_id', 'seq'], name='field_event_identity'),
        ]
        indexes = [
            models.Index(fields=['station', 'business_date', 'occurred_at'], name='field_station_day_moment'),
            models.Index(fields=['business_date', 'app', 'result'], name='field_day_app_result'),
            models.Index(fields=['station', 'job_id', 'occurred_at'], name='field_station_job_moment'),
            models.Index(fields=['barcode', 'business_date'], name='field_barcode_day'),
            models.Index(fields=['serial', 'business_date'], name='field_serial_day'),
            models.Index(fields=['part_no', 'business_date'], name='field_part_day'),
            models.Index(fields=['issuer_namespace', 'part_no', 'label_print_date', 'business_date', 'station'],
                         condition=Q(app='weigh_label', event_type='label.reserved'),
                         name='field_label_issuer_date'),
        ]


class FieldArchiveEvent(models.Model):
    """Historical imports are queried independently of the live field ledger."""

    # Both archive identity and station/date indexes already lead with station.
    station = models.ForeignKey(FieldStation, on_delete=models.PROTECT, db_index=False)
    database_id = models.UUIDField()
    seq = models.PositiveBigIntegerField()
    app = models.CharField(max_length=64)
    event_type = models.CharField(max_length=64)
    mode = models.CharField(max_length=16)
    result = models.CharField(max_length=16)
    reason = models.CharField(max_length=64)
    barcode = models.CharField(max_length=256, blank=True)
    serial = models.CharField(max_length=128, blank=True)
    part_no = models.CharField(max_length=128, blank=True)
    job_id = models.CharField(max_length=128, blank=True)
    occurred_at = models.DateTimeField()
    received_at = models.DateTimeField()
    business_date = models.DateField()
    clock_offset_seconds = models.BigIntegerField(null=True)
    clock_suspect = models.BooleanField(default=False)
    payload = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['station', 'database_id', 'seq'], name='field_archive_event_identity'),
        ]
        indexes = [
            models.Index(fields=['station', 'business_date', 'occurred_at'], name='field_archive_station_day'),
            models.Index(fields=['business_date', 'occurred_at'], name='field_archive_day'),
        ]


class FieldIssuerRetainedFloor(models.Model):
    """Per-date-code serial safety evidence left by expired live reservations."""

    station = models.ForeignKey(FieldStation, on_delete=models.PROTECT, db_index=False)
    namespace = models.CharField(max_length=3)
    part_no = models.CharField(max_length=32)
    date_code = models.CharField(max_length=3)
    print_date = models.DateField()
    serial_floor = models.PositiveIntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['station', 'namespace', 'part_no', 'date_code'],
                                    name='field_retained_floor_identity'),
        ]


class FieldStationHeartbeat(models.Model):
    station = models.OneToOneField(FieldStation, on_delete=models.PROTECT, related_name='heartbeat')
    received_at = models.DateTimeField()
    clock_offset_seconds = models.BigIntegerField()
    payload = models.JSONField()
    previous_session_id = models.UUIDField(null=True)
    previous_session_received_at = models.DateTimeField(null=True)
    duplicate_sender_until = models.DateTimeField(null=True)


class FieldLabelIssuer(models.Model):
    namespace = models.CharField(max_length=3)
    part_no = models.CharField(max_length=32)
    station = models.ForeignKey(FieldStation, on_delete=models.PROTECT, null=True)
    program = models.CharField(max_length=80)
    pc_note = models.CharField(max_length=120, blank=True)
    predecessor = models.ForeignKey('self', on_delete=models.PROTECT, null=True, related_name='+')
    assigned_at = models.DateTimeField()
    assigned_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='+')
    reason = models.CharField(max_length=240)
    stopped_at = models.DateTimeField(null=True)
    stopped_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name='+')
    stop_reason = models.CharField(max_length=240, blank=True)
    withdrawal_revision = models.PositiveBigIntegerField(null=True)
    released_at = models.DateTimeField(null=True)
    released_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name='+')
    release_reason = models.CharField(max_length=240, blank=True)
    ceilings = models.JSONField(default=list)
    release_proof = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['namespace', 'part_no'], condition=Q(released_at__isnull=True),
                                    name='field_one_active_label_issuer'),
        ]
        indexes = [
            models.Index(fields=['station', 'stopped_at', 'released_at'], name='field_issuer_station_state'),
            models.Index(fields=['namespace', 'part_no', 'released_at'], name='field_issuer_key_history'),
        ]
