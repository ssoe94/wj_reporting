import hashlib
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

class ProductionPlan(models.Model):
    """
    Stores a single production plan entry for a specific date, machine, and part.
    """
    work_uid = models.UUIDField(null=True, editable=False, unique=True)
    work_version = models.PositiveIntegerField(default=1, editable=False)
    plan_date = models.DateField(db_index=True)
    plan_type = models.CharField(max_length=20, db_index=True)  # 'injection' or 'machining'
    machine_name = models.CharField(max_length=100, db_index=True)
    lot_no = models.CharField(max_length=100, null=True, blank=True)
    model_name = models.CharField(max_length=100, null=True, blank=True, db_index=True)
    part_spec = models.CharField(max_length=100, null=True, blank=True)
    product_family_code = models.CharField(max_length=20, null=True, blank=True, db_index=True)
    product_family_name = models.CharField(max_length=100, null=True, blank=True)
    is_finished_product = models.BooleanField(default=False, db_index=True)
    part_no = models.CharField(max_length=100, null=True, blank=True, db_index=True)  # Corresponds to fg_part_no
    planned_quantity = models.FloatField()
    sequence = models.IntegerField(default=-1) # To preserve order from upload
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        # A plan for a given day, machine, and part should be unique.
        # Lot no is included for cases where the same part is planned with different lot numbers.
        unique_together = ('plan_date', 'machine_name', 'part_no', 'lot_no', 'plan_type', 'sequence')
        ordering = ['plan_date', 'machine_name', 'sequence']
        indexes = [
            models.Index(fields=['plan_date', 'plan_type']),
        ]

    def __str__(self):
        return f"{self.plan_date} - {self.machine_name} - {self.part_no} ({self.planned_quantity})"


class ProductionPlanChangeLog(models.Model):
    """Append-only audit log for production plan uploads and edits."""

    ACTION_CHOICES = [
        ('upload', 'Upload'),
        ('create', 'Create'),
        ('update', 'Update'),
        ('reorder', 'Reorder'),
        ('delete', 'Delete'),
    ]

    plan_date = models.DateField(db_index=True)
    plan_type = models.CharField(max_length=20, db_index=True)
    action = models.CharField(max_length=20, choices=ACTION_CHOICES, db_index=True)
    machine_name = models.CharField(max_length=100, null=True, blank=True)
    part_no = models.CharField(max_length=100, null=True, blank=True)
    model_name = models.CharField(max_length=100, null=True, blank=True)
    lot_no = models.CharField(max_length=100, null=True, blank=True)
    plan_id = models.IntegerField(null=True, blank=True)
    before = models.JSONField(default=dict, blank=True)
    after = models.JSONField(default=dict, blank=True)
    summary = models.CharField(max_length=255, blank=True, default='')
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='production_plan_change_logs',
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at', '-id']
        indexes = [
            models.Index(fields=['plan_date', 'plan_type', '-created_at'], name='production__plan_da_295cf3_idx'),
        ]

    def __str__(self):
        return f"{self.plan_date} {self.plan_type} {self.action} {self.summary}"


class ProductionPartCavity(models.Model):
    """Store per-part cavity rules for injection production."""
    part_no = models.CharField(max_length=100, unique=True, db_index=True)
    cavity = models.PositiveSmallIntegerField(default=1)
    cavity_pattern = models.CharField(max_length=20, default='1x1')
    parts_per_shot = models.PositiveSmallIntegerField(default=1)
    cavity_group = models.CharField(max_length=255, blank=True, default='', db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['part_no']

    def __str__(self):
        return f"{self.part_no} - {self.cavity_pattern or self.cavity}"


class ProductionPlanPart(models.Model):
    """Stores part number to model mappings derived from production plan uploads."""
    id = models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")
    plan_type = models.CharField(max_length=20, db_index=True)
    part_no = models.CharField(max_length=100, db_index=True)
    model_name = models.CharField(max_length=100, null=True, blank=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('plan_type', 'part_no')
        ordering = ['plan_type', 'part_no']

    def __str__(self):
        return f"{self.plan_type}: {self.part_no} - {self.model_name or ''}"


class ProductionExecution(models.Model):
    """
    Stores day-of-operation values entered from the production console.
    It is keyed by the uploaded plan identity rather than a FK so it survives plan re-uploads.
    """

    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('running', 'Running'),
        ('completed', 'Completed'),
        ('paused', 'Paused'),
    ]

    plan_date = models.DateField(db_index=True)
    plan_type = models.CharField(max_length=20, db_index=True)
    machine_name = models.CharField(max_length=100, db_index=True)
    part_no = models.CharField(max_length=100, blank=True, default='', db_index=True)
    lot_no = models.CharField(max_length=100, null=True, blank=True)
    sequence = models.IntegerField(default=-1)

    model_name = models.CharField(max_length=100, null=True, blank=True)
    actual_qty = models.IntegerField(default=0)
    defect_qty = models.IntegerField(default=0)
    idle_time = models.IntegerField(default=0)
    personnel_count = models.FloatField(default=0)
    operating_ct = models.FloatField(null=True, blank=True)
    start_datetime = models.DateTimeField(null=True, blank=True)
    end_datetime = models.DateTimeField(null=True, blank=True)
    note = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='production_executions',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('plan_date', 'plan_type', 'machine_name', 'part_no', 'lot_no', 'sequence')
        ordering = ['plan_date', 'machine_name', 'sequence']
        indexes = [
            models.Index(fields=['plan_date', 'plan_type'], name='production__plan_da_997e03_idx'),
            models.Index(fields=['plan_type', 'machine_name'], name='production__plan_ty_983761_idx'),
        ]

    def __str__(self):
        return f"{self.plan_date} - {self.machine_name} - {self.part_no or '-'}"


class InjectionDowntimeConfirmation(models.Model):
    """Human confirmation for an automatically detected injection downtime event."""

    DETECTED_TYPE_CHOICES = [
        ('mold_change', 'Mold change'),
        ('core_change', 'Core change'),
        ('tuning', 'Tuning'),
        ('production_stop', 'Production stop'),
    ]
    RESOLUTION_CHOICES = [
        ('confirmed', 'Confirmed downtime'),
        ('dismissed', 'Not downtime'),
    ]
    REASON_CHOICES = [
        ('mold_change', 'Mold change'),
        ('core_change', 'Core change'),
        ('tuning', 'Tuning'),
        ('mechanical_failure', 'Machine failure'),
        ('mold_issue', 'Mold issue'),
        ('material_wait', 'Material wait'),
        ('quality_check', 'Quality check'),
        ('planned_stop', 'Planned stop'),
        ('staffing', 'Staffing or shift change'),
        ('other', 'Other'),
        ('not_stop', 'Not downtime'),
    ]

    business_date = models.DateField(db_index=True)
    event_key = models.CharField(max_length=160, unique=True)
    machine_key = models.CharField(max_length=40, db_index=True)
    machine_label = models.CharField(max_length=100)
    detected_type = models.CharField(max_length=30, choices=DETECTED_TYPE_CHOICES)
    detected_start = models.DateTimeField(db_index=True)
    detected_end = models.DateTimeField()
    duration_minutes = models.PositiveIntegerField(default=0)
    resolution = models.CharField(max_length=20, choices=RESOLUTION_CHOICES, default='confirmed', db_index=True)
    reason_code = models.CharField(max_length=40, choices=REASON_CHOICES)
    note = models.TextField(blank=True, default='')
    evidence = models.JSONField(default=dict, blank=True)
    confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='injection_downtime_confirmations',
    )
    confirmed_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-detected_start', '-id']
        indexes = [
            models.Index(fields=['business_date', 'resolution']),
            models.Index(fields=['business_date', 'machine_key', 'detected_start']),
        ]

    def save(self, *args, **kwargs):
        self.event_key = (self.event_key or '').strip()
        self.machine_key = (self.machine_key or '').strip()
        self.machine_label = (self.machine_label or '').strip()
        self.note = (self.note or '').strip()
        self.duration_minutes = max(0, int(self.duration_minutes or 0))
        if self.resolution == 'dismissed':
            self.reason_code = 'not_stop'
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.business_date} {self.machine_label} {self.reason_code}"


class InjectionActivityConfirmation(models.Model):
    """Human classification for MES activity that has no matching production plan."""

    ACTIVITY_TYPE_CHOICES = [
        ('production', 'Production'),
        ('test_shot', 'Test shot'),
        ('mold_check', 'Mold check'),
        ('machine_check', 'Machine check'),
        ('maintenance', 'Maintenance'),
        ('quality_check', 'Quality check'),
        ('other', 'Other'),
    ]

    business_date = models.DateField(db_index=True)
    machine_key = models.CharField(max_length=40, db_index=True)
    machine_label = models.CharField(max_length=100)
    activity_type = models.CharField(max_length=30, choices=ACTIVITY_TYPE_CHOICES)
    part_no = models.CharField(max_length=100, blank=True, default='', db_index=True)
    model_name = models.CharField(max_length=100, blank=True, default='')
    shot_count = models.PositiveIntegerField(default=0)
    last_shot_at = models.DateTimeField(null=True, blank=True)
    note = models.TextField(blank=True, default='')
    confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='injection_activity_confirmations',
    )
    confirmed_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('business_date', 'machine_key')
        ordering = ['business_date', 'machine_key']
        indexes = [
            models.Index(fields=['business_date', 'activity_type'], name='prod_act_bus_type_idx'),
        ]

    def save(self, *args, **kwargs):
        self.machine_key = (self.machine_key or '').strip()
        self.machine_label = (self.machine_label or '').strip()
        self.part_no = (self.part_no or '').strip().upper()
        self.model_name = (self.model_name or '').strip()
        self.note = (self.note or '').strip()
        self.shot_count = max(0, int(self.shot_count or 0))
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.business_date} {self.machine_label} {self.activity_type}"


class ProductionMesReportRecord(models.Model):
    report_record_detail_id = models.BigIntegerField(unique=True)
    report_record_id = models.BigIntegerField(null=True, blank=True, db_index=True)
    report_record_code = models.CharField(max_length=100, null=True, blank=True)
    business_date = models.DateField(db_index=True)
    plan_type = models.CharField(max_length=20, db_index=True)
    process_code = models.CharField(max_length=20, db_index=True)
    report_time = models.DateTimeField(db_index=True)
    equipment_name = models.CharField(max_length=200, blank=True, default='')
    equipment_key = models.CharField(max_length=50, db_index=True)
    part_no = models.CharField(max_length=100, db_index=True)
    material_name = models.CharField(max_length=200, blank=True, default='')
    report_qty = models.IntegerField(default=0)
    raw_payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['business_date', 'plan_type', 'equipment_key', 'part_no', 'report_time']
        indexes = [
            models.Index(fields=['business_date', 'plan_type'], name='production__busine_9aa955_idx'),
            models.Index(fields=['business_date', 'equipment_key', 'part_no'], name='production__busine_7f65d3_idx'),
            models.Index(fields=['report_time'], name='production__report__64aafe_idx'),
        ]

    def __str__(self):
        return f"{self.business_date} {self.plan_type} {self.equipment_key} {self.part_no} {self.report_qty}"


def build_plan_identity_hash(plan_date, plan_type, machine_name, part_no, lot_no, sequence) -> str:
    payload = "|".join([
        str(plan_date or ""),
        str(plan_type or "").strip(),
        str(machine_name or "").strip(),
        str(part_no or "").strip().upper(),
        str(lot_no or "").strip(),
        str(sequence if sequence is not None else ""),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class MachiningManualReport(models.Model):
    """Manual machining supplement used only until matching MES reports arrive."""

    STATUS_CHOICES = [
        ("open", "Open"),
        ("partial", "Partial"),
        ("matched", "Matched"),
        ("mismatch", "Mismatch"),
        ("cancelled", "Cancelled"),
    ]

    business_date = models.DateField(db_index=True)
    plan_date = models.DateField(db_index=True)
    plan_type = models.CharField(max_length=20, default="machining", db_index=True)
    plan = models.ForeignKey(
        ProductionPlan,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="machining_manual_reports",
    )
    plan_identity_hash = models.CharField(max_length=64, db_index=True)
    machine_name = models.CharField(max_length=100, db_index=True)
    equipment_key = models.CharField(max_length=50, db_index=True)
    part_no = models.CharField(max_length=100, db_index=True)
    model_name = models.CharField(max_length=100, blank=True, default="")
    lot_no = models.CharField(max_length=100, null=True, blank=True)
    sequence = models.IntegerField(default=-1)
    planned_qty_at_report = models.IntegerField(default=0)
    good_qty = models.IntegerField(default=0)
    defect_qty = models.IntegerField(default=0)
    total_reported_qty = models.IntegerField(default=0)
    reason_code = models.CharField(max_length=80, blank=True, default="")
    note = models.TextField(blank=True, default="")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="open", db_index=True)
    credit_business_date = models.DateField(db_index=True)
    reported_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="machining_manual_reports",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="machining_manual_report_updates",
    )
    reported_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-business_date", "machine_name", "sequence", "-id"]
        indexes = [
            models.Index(fields=["business_date", "status"]),
            models.Index(fields=["plan_date", "equipment_key", "part_no"]),
            models.Index(fields=["credit_business_date", "status"]),
        ]

    def save(self, *args, **kwargs):
        self.plan_type = "machining"
        self.machine_name = (self.machine_name or "").strip()
        self.equipment_key = (self.equipment_key or "").strip().upper()
        self.part_no = (self.part_no or "").strip().upper()
        self.model_name = (self.model_name or "").strip()
        self.lot_no = (self.lot_no or "").strip() or None
        self.good_qty = max(0, int(self.good_qty or 0))
        self.defect_qty = max(0, int(self.defect_qty or 0))
        self.total_reported_qty = max(0, int(self.total_reported_qty or self.good_qty))
        if not self.credit_business_date:
            self.credit_business_date = self.business_date
        self.plan_identity_hash = self.plan_identity_hash or build_plan_identity_hash(
            self.plan_date,
            self.plan_type,
            self.machine_name,
            self.part_no,
            self.lot_no,
            self.sequence,
        )
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.business_date} {self.machine_name} {self.part_no} manual {self.total_reported_qty}"


class MachiningManualReportDefect(models.Model):
    manual_report = models.ForeignKey(
        MachiningManualReport,
        on_delete=models.CASCADE,
        related_name="defect_items",
    )
    defect_category = models.CharField(max_length=40, blank=True, default="processing")
    defect_type = models.CharField(max_length=100)
    quantity = models.IntegerField(default=0)
    note = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["manual_report_id", "id"]
        indexes = [
            models.Index(fields=["defect_category", "defect_type"]),
        ]

    def save(self, *args, **kwargs):
        self.defect_category = (self.defect_category or "processing").strip()
        self.defect_type = (self.defect_type or "").strip()
        self.quantity = max(0, int(self.quantity or 0))
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.manual_report_id} {self.defect_type} {self.quantity}"


class MachiningManualReportMatch(models.Model):
    CONFIDENCE_CHOICES = [
        ("exact", "Exact"),
        ("probable", "Probable"),
        ("manual_confirmed", "Manual confirmed"),
    ]

    manual_report = models.ForeignKey(
        MachiningManualReport,
        on_delete=models.CASCADE,
        related_name="matches",
    )
    mes_report_record = models.ForeignKey(
        ProductionMesReportRecord,
        on_delete=models.CASCADE,
        related_name="manual_matches",
    )
    matched_qty = models.IntegerField(default=0)
    match_confidence = models.CharField(max_length=40, choices=CONFIDENCE_CHOICES, default="probable")
    match_reason = models.CharField(max_length=255, blank=True, default="")
    matched_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="machining_manual_report_matches",
    )
    matched_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["manual_report_id", "id"]
        unique_together = ("manual_report", "mes_report_record")
        indexes = [
            models.Index(fields=["matched_at"]),
        ]

    def save(self, *args, **kwargs):
        self.matched_qty = max(0, int(self.matched_qty or 0))
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.manual_report_id} -> {self.mes_report_record_id} ({self.matched_qty})"


class MesTaskActionLog(models.Model):
    """One operator-requested MES task action and its verified outcome. Never deleted."""

    ACTION_CHOICES = [
        ("start", "Start"),
        ("resume", "Resume"),
        ("pause", "Pause"),
        ("close_work_order", "Close work order"),
    ]
    OUTCOME_CHOICES = [
        ("confirmed", "Confirmed"),
        ("rejected", "Rejected"),
        ("uncertain", "Uncertain"),
        ("blocked", "Blocked"),
    ]

    request_id = models.CharField(max_length=36, db_index=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="mes_task_actions",
    )
    action = models.CharField(max_length=30, choices=ACTION_CHOICES)
    reason = models.CharField(max_length=200)
    machine_number = models.PositiveSmallIntegerField(db_index=True)
    task_id = models.CharField(max_length=20, db_index=True)
    task_code = models.CharField(max_length=100)
    work_order_code = models.CharField(max_length=100, blank=True, default="")
    part_no = models.CharField(max_length=100, blank=True, default="")
    status_before = models.PositiveSmallIntegerField()
    status_after = models.PositiveSmallIntegerField(null=True, blank=True)
    outcome = models.CharField(max_length=20, choices=OUTCOME_CHOICES, db_index=True)
    outcome_reason = models.CharField(max_length=60, blank=True, default="")
    mes_code = models.IntegerField(null=True, blank=True)
    mes_sub_code = models.CharField(max_length=40, blank=True, default="")
    mes_message = models.CharField(max_length=200, blank=True, default="")
    need_check = models.SmallIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"{self.machine_number} {self.task_code} {self.action} {self.outcome}"


class PlanWorkflowLock(models.Model):
    """Seeded rows serialize plan upload, edit, approval and request preparation."""
    plan_type = models.CharField(max_length=20, primary_key=True)


class PlanWorkIdentity(models.Model):
    uid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    plan_type = models.CharField(max_length=20, db_index=True)
    current_version = models.PositiveIntegerField(default=1)
    active = models.BooleanField(default=True)
    resolution = models.CharField(max_length=24, default='identified')
    candidates = models.JSONField(default=list)


class PlanWorkRevision(models.Model):
    work = models.ForeignKey(PlanWorkIdentity, on_delete=models.PROTECT, related_name='revisions')
    version = models.PositiveIntegerField()
    snapshot = models.JSONField()
    fingerprint = models.CharField(max_length=64)
    change = models.CharField(max_length=24)
    reason = models.CharField(max_length=500, blank=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['work', 'version'], name='plan_work_revision_uniq')]


class PlanMaterialApproval(models.Model):
    revision = models.ForeignKey(PlanWorkRevision, on_delete=models.PROTECT, related_name='approvals')
    snapshot = models.JSONField()
    fingerprint = models.CharField(max_length=64)
    reason = models.CharField(max_length=500)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)


class PlanMaterialDefault(models.Model):
    plan_type = models.CharField(max_length=20)
    part_no = models.CharField(max_length=100)
    version = models.PositiveIntegerField()
    effective_from = models.DateField()
    snapshot = models.JSONField()
    reason = models.CharField(max_length=500)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['plan_type', 'part_no', 'version'], name='plan_material_default_uniq')]


class PlanWorkOrder(models.Model):
    uid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=100, unique=True)
    plan_type = models.CharField(max_length=20)
    members = models.JSONField(default=list)
    setup_fingerprint = models.CharField(max_length=64)
    approved_snapshot = models.JSONField()
    version = models.PositiveIntegerField(default=1)
    mes_id = models.CharField(max_length=19, blank=True)
    actual_started_at = models.DateTimeField(null=True)
    reported_quantity = models.DecimalField(max_digits=25, decimal_places=10, default=0)
    inbound_quantity = models.DecimalField(max_digits=25, decimal_places=10, default=0)
    observed_at = models.DateTimeField(null=True)
    observation_complete = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)


class PlanMesRequest(models.Model):
    uid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    work_order = models.ForeignKey(PlanWorkOrder, on_delete=models.PROTECT, related_name='requests')
    dedupe_key = models.CharField(max_length=64, unique=True)
    operation = models.CharField(max_length=20)
    state = models.CharField(max_length=24, default='disabled')
    intent = models.JSONField()
    contract = models.JSONField(default=dict)
    blockers = models.JSONField(default=list)
    attempt = models.PositiveIntegerField(default=0)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class PlanMesRequestEvent(models.Model):
    request = models.ForeignKey(PlanMesRequest, on_delete=models.PROTECT, related_name='events')
    state = models.CharField(max_length=24)
    evidence = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)


class MesCreateDiagnostic(models.Model):
    """Single reviewed diagnostic, independent of production plans/materials."""
    uid = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.CharField(max_length=128)
    code = models.CharField(max_length=100)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    payload = models.JSONField()
    payload_digest = models.CharField(max_length=64)
    state = models.CharField(max_length=24, default='prepared')
    attempt = models.PositiveIntegerField(default=0)
    mes_id = models.CharField(max_length=19, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['tenant', 'code'], name='mes_create_diagnostic_code_uniq')]


class MesCreateDiagnosticEvent(models.Model):
    request = models.ForeignKey(MesCreateDiagnostic, on_delete=models.PROTECT, related_name='events')
    state = models.CharField(max_length=24)
    evidence = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)


class MesCreateDiagnosticPermit(models.Model):
    """One immutable activation and one reconnect APP budget for the exact draft."""
    request = models.OneToOneField(MesCreateDiagnostic, primary_key=True, on_delete=models.PROTECT,
                                  related_name='approval')
    snapshot = models.JSONField()
    snapshot_digest = models.CharField(max_length=64)
    approved_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    auth_app_attempt = models.PositiveSmallIntegerField(default=0)
    auth_oauth_attempt = models.CharField(max_length=64, blank=True)
    auth_claimed_at = models.DateTimeField(null=True)
    auth_completed_at = models.DateTimeField(null=True)

    class Meta:
        default_permissions = ()
        constraints = [
            models.CheckConstraint(condition=models.Q(expires_at__gt=models.F('approved_at')) &
                models.Q(expires_at__lte=models.F('approved_at') + timedelta(minutes=30)),
                name='mes_diagnostic_permit_short'),
            models.CheckConstraint(condition=models.Q(auth_app_attempt__in=[0, 1]),
                name='mes_diagnostic_app_max_one'),
        ]
