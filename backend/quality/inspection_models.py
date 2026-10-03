"""Local inspection workflow. These records are never MES completion evidence."""
from django.conf import settings
from django.db import models


class InspectionRequest(models.Model):
    identity = models.CharField(max_length=64, unique=True, editable=False)
    source_kind = models.CharField(max_length=24, default='local_manual', editable=False)
    work_order_ref = models.CharField(max_length=128)
    task_ref = models.CharField(max_length=128)
    part_no = models.CharField(max_length=128)
    equipment_ref = models.CharField(max_length=128)
    inspection_type = models.CharField(max_length=16, default='first')
    target_quantity = models.DecimalField(max_digits=18, decimal_places=3)
    uom = models.CharField(max_length=32)
    warehouse_ref = models.CharField(max_length=128)
    lot_ref = models.CharField(max_length=128)
    work_started_at = models.DateTimeField()
    inspection_items = models.JSONField(default=list)
    require_evidence = models.BooleanField(default=False)
    quantity_mode = models.CharField(max_length=16, default='recorded')
    judgement_policy = models.CharField(max_length=16, default='strict_items')
    parent = models.OneToOneField('self', on_delete=models.PROTECT, null=True, blank=True, related_name='reinspection')
    assigned_to = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='assigned_inspections')
    assigned_to_name = models.CharField(max_length=150)
    status = models.CharField(max_length=16, default='draft', db_index=True)
    version = models.PositiveIntegerField(default=1)
    measurements = models.JSONField(default=list)
    evidence = models.JSONField(default=list)
    inspected_quantity = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    accepted_quantity = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    rejected_quantity = models.DecimalField(max_digits=18, decimal_places=3, default=0)
    judgement = models.CharField(max_length=8, blank=True, default='')
    notes = models.TextField(blank=True, default='')
    submitted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='submitted_inspections')
    submitted_at = models.DateTimeField(null=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='reviewed_inspections')
    reviewed_at = models.DateTimeField(null=True)
    review_reason = models.CharField(max_length=500, blank=True, default='')
    sync_status = models.CharField(max_length=16, default='not_synced')
    mes_completion_status = models.CharField(max_length=24, default='not_completed')
    injection_receipt_readiness = models.CharField(max_length=16, default='not_verified')
    mes_snapshot = models.JSONField(default=dict)
    mes_checked_at = models.DateTimeField(null=True)
    external_result_id = models.CharField(max_length=128, blank=True, default='')
    last_error_code = models.CharField(max_length=64, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at', '-id']
        permissions = [
            ('manage_inspectionrequest', 'Create and edit local inspection requests'),
            ('submit_inspectionrequest', 'Submit inspection results'),
            ('review_inspectionrequest', 'Independently review inspection results'),
        ]


class InspectionAudit(models.Model):
    request = models.ForeignKey(InspectionRequest, on_delete=models.PROTECT, related_name='audit')
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    actor_name = models.CharField(max_length=150)
    action = models.CharField(max_length=32)
    version = models.PositiveIntegerField()
    status = models.CharField(max_length=16)
    reason = models.CharField(max_length=500, blank=True, default='')
    result_digest = models.CharField(max_length=64, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['id']
        default_permissions = ()


class InspectionOperation(models.Model):
    request = models.ForeignKey(InspectionRequest, on_delete=models.PROTECT, null=True, related_name='operations')
    # Includes actor id + request id + action; a UUID cannot authorize another operation.
    scope = models.CharField(max_length=128)
    key = models.UUIDField()
    payload_digest = models.CharField(max_length=64)
    status = models.CharField(max_length=16, default='pending')
    response_status = models.PositiveSmallIntegerField(default=202)
    response = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['scope', 'key'], name='quality_inspection_operation_key')]
        default_permissions = ()


class InspectionMesBinding(models.Model):
    """Reviewed server-owned identity/mapping; no browser creation or auto-import.

    Retained independently from transient adapter objects. A binding is not an
    assertion that the live write contract has been verified by this build.
    """
    request = models.OneToOneField(InspectionRequest, on_delete=models.PROTECT, related_name='mes_binding')
    tenant = models.CharField(max_length=128)
    qc_id = models.CharField(max_length=19)
    work_order_id = models.CharField(max_length=19)
    contract = models.JSONField(default=dict)
    reviewed_result_digest = models.CharField(max_length=64)
    test_only = models.BooleanField(default=False)
    test_label = models.CharField(max_length=500)
    phase = models.CharField(max_length=24, default='ready')
    evidence_digest = models.CharField(max_length=64, blank=True, default='')
    last_verified_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        default_permissions = ()
        constraints = [models.UniqueConstraint(fields=['tenant', 'qc_id'], name='quality_mes_binding_target')]


class InspectionNonconformance(models.Model):
    """Open follow-up is separate from QC completion; no disposition execution."""
    request = models.OneToOneField(InspectionRequest, on_delete=models.PROTECT, related_name='nonconformance')
    state = models.CharField(max_length=24, default='open')
    quantity = models.DecimalField(max_digits=18, decimal_places=3, null=True)
    uom = models.CharField(max_length=32)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    owner_name = models.CharField(max_length=150)
    defect_types = models.JSONField(default=list)
    cause = models.TextField(blank=True, default='')
    evidence = models.JSONField(default=list)
    original_result_digest = models.CharField(max_length=64)
    mes_status = models.CharField(max_length=24, default='unverified')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        default_permissions = ()
