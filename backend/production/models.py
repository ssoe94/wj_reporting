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


class ProductionPartCavity(models.Model):
    """Store cavity counts per part no for injection production."""
    part_no = models.CharField(max_length=100, unique=True, db_index=True)
    cavity = models.PositiveSmallIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['part_no']

    def __str__(self):
        return f"{self.part_no} - {self.cavity}"


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
