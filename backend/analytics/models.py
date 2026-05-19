from django.db import models
from django.utils import timezone


class MartProductionDailyProgress(models.Model):
    PROCESS_CHOICES = [
        ('injection', 'Injection'),
        ('machining', 'Machining'),
    ]

    STATUS_CHOICES = [
        ('ahead', 'Ahead'),
        ('on_track', 'On Track'),
        ('behind', 'Behind'),
        ('no_plan', 'No Plan'),
    ]

    business_date = models.DateField(db_index=True)
    process = models.CharField(max_length=20, choices=PROCESS_CHOICES, db_index=True)
    range_start = models.DateTimeField()
    range_end = models.DateTimeField()
    reference_time = models.DateTimeField(null=True, blank=True)
    source_latest_at = models.DateTimeField(null=True, blank=True)

    planned_qty = models.IntegerField(default=0)
    actual_qty = models.IntegerField(default=0)
    gap_qty = models.IntegerField(default=0)
    progress_rate = models.FloatField(default=0)
    time_progress_rate = models.FloatField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='no_plan', db_index=True)

    active_equipment_count = models.IntegerField(default=0)
    running_equipment_count = models.IntegerField(default=0)
    total_equipment_count = models.IntegerField(default=0)

    source_row_counts = models.JSONField(default=dict, blank=True)
    used_data = models.JSONField(default=list, blank=True)
    calculation_basis = models.JSONField(default=list, blank=True)
    warnings = models.JSONField(default=list, blank=True)
    generated_at = models.DateTimeField(auto_now=True, db_index=True)

    class Meta:
        unique_together = ('business_date', 'process')
        ordering = ['-business_date', 'process']
        indexes = [
            models.Index(fields=['business_date', 'status']),
            models.Index(fields=['process', 'business_date']),
        ]

    def __str__(self):
        return f'{self.business_date} {self.process} {self.progress_rate}%'


class MartEquipmentDailyProgress(models.Model):
    business_date = models.DateField(db_index=True)
    process = models.CharField(max_length=20, db_index=True)
    equipment_key = models.CharField(max_length=50, db_index=True)
    equipment_label = models.CharField(max_length=100, blank=True, default='')
    equipment_name = models.CharField(max_length=200, blank=True, default='')

    planned_qty = models.IntegerField(default=0)
    actual_qty = models.IntegerField(default=0)
    gap_qty = models.IntegerField(default=0)
    progress_rate = models.FloatField(default=0)
    recent_60m_shots = models.IntegerField(default=0)
    recent_60m_avg_ct_sec = models.FloatField(null=True, blank=True)
    is_running = models.BooleanField(default=False)

    completed_count = models.IntegerField(default=0)
    in_progress_count = models.IntegerField(default=0)
    pending_count = models.IntegerField(default=0)
    source_payload = models.JSONField(default=dict, blank=True)
    generated_at = models.DateTimeField(auto_now=True, db_index=True)

    class Meta:
        unique_together = ('business_date', 'process', 'equipment_key')
        ordering = ['business_date', 'process', 'equipment_key']
        indexes = [
            models.Index(fields=['business_date', 'process', 'gap_qty']),
            models.Index(fields=['process', 'equipment_key']),
        ]

    def __str__(self):
        return f'{self.business_date} {self.process} {self.equipment_label or self.equipment_key}'


class MartPartDailyProgress(models.Model):
    business_date = models.DateField(db_index=True)
    process = models.CharField(max_length=20, db_index=True)
    equipment_key = models.CharField(max_length=50, db_index=True)
    equipment_label = models.CharField(max_length=100, blank=True, default='')
    part_no = models.CharField(max_length=100, db_index=True)
    model_name = models.CharField(max_length=100, blank=True, default='')
    lot_no = models.CharField(max_length=100, blank=True, default='')
    sequence = models.IntegerField(default=0)

    planned_qty = models.IntegerField(default=0)
    actual_qty = models.IntegerField(default=0)
    gap_qty = models.IntegerField(default=0)
    progress_rate = models.FloatField(default=0)
    cavity = models.IntegerField(default=1)
    status = models.CharField(max_length=30, blank=True, default='pending', db_index=True)
    source_payload = models.JSONField(default=dict, blank=True)
    generated_at = models.DateTimeField(auto_now=True, db_index=True)

    class Meta:
        unique_together = ('business_date', 'process', 'equipment_key', 'part_no', 'lot_no', 'sequence')
        ordering = ['business_date', 'process', 'equipment_key', 'sequence', 'part_no']
        indexes = [
            models.Index(fields=['business_date', 'process', 'status']),
            models.Index(fields=['part_no', 'business_date']),
        ]

    def __str__(self):
        return f'{self.business_date} {self.process} {self.equipment_label} {self.part_no}'


class FactExceptionEvent(models.Model):
    SEVERITY_CHOICES = [
        ('info', 'Info'),
        ('warning', 'Warning'),
        ('critical', 'Critical'),
    ]

    STATUS_CHOICES = [
        ('open', 'Open'),
        ('acknowledged', 'Acknowledged'),
        ('resolved', 'Resolved'),
        ('ignored', 'Ignored'),
    ]

    source = models.CharField(max_length=50, default='production_mart', db_index=True)
    source_key = models.CharField(max_length=255, unique=True, db_index=True)
    business_date = models.DateField(db_index=True)
    process = models.CharField(max_length=20, blank=True, default='', db_index=True)
    exception_type = models.CharField(max_length=80, db_index=True)
    severity = models.CharField(max_length=20, choices=SEVERITY_CHOICES, default='warning', db_index=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='open', db_index=True)

    equipment_key = models.CharField(max_length=50, blank=True, default='', db_index=True)
    equipment_label = models.CharField(max_length=100, blank=True, default='')
    part_no = models.CharField(max_length=100, blank=True, default='', db_index=True)
    title = models.CharField(max_length=200)
    detail = models.TextField(blank=True, default='')
    source_payload = models.JSONField(default=dict, blank=True)

    detected_at = models.DateTimeField(default=timezone.now, db_index=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-business_date', 'status', 'severity', 'exception_type', 'equipment_key']
        indexes = [
            models.Index(fields=['business_date', 'status']),
            models.Index(fields=['business_date', 'process', 'exception_type']),
            models.Index(fields=['status', 'severity']),
        ]

    def __str__(self):
        return f'{self.business_date} {self.exception_type} {self.equipment_label or self.part_no}'
