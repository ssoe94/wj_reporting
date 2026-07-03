import hashlib

from django.conf import settings
from django.db import models

class ProductionPlan(models.Model):
    """
    Stores a single production plan entry for a specific date, machine, and part.
    """
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
            models.Index(fields=['plan_date', 'plan_type', '-created_at']),
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
            models.Index(fields=['plan_date', 'plan_type']),
            models.Index(fields=['plan_type', 'machine_name']),
        ]

    def __str__(self):
        return f"{self.plan_date} - {self.machine_name} - {self.part_no or '-'}"


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
            models.Index(fields=['business_date', 'plan_type']),
            models.Index(fields=['business_date', 'equipment_key', 'part_no']),
            models.Index(fields=['report_time']),
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
