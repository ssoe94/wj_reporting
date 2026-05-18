from django.conf import settings
from django.db import models


class AiJob(models.Model):
    JOB_TYPE_PRODUCTION_DAILY = 'production_daily_analysis'
    JOB_TYPE_PRODUCTION_MACHINE = 'production_machine_analysis'
    JOB_TYPE_QUALITY_IMAGE = 'quality_image_analysis'

    JOB_TYPE_CHOICES = [
        (JOB_TYPE_PRODUCTION_DAILY, 'Production Daily Analysis'),
        (JOB_TYPE_PRODUCTION_MACHINE, 'Production Machine Analysis'),
        (JOB_TYPE_QUALITY_IMAGE, 'Quality Image Analysis'),
    ]

    STATUS_PENDING = 'pending'
    STATUS_CLAIMED = 'claimed'
    STATUS_RUNNING = 'running'
    STATUS_COMPLETED = 'completed'
    STATUS_FAILED = 'failed'
    STATUS_CANCELLED = 'cancelled'

    STATUS_CHOICES = [
        (STATUS_PENDING, 'Pending'),
        (STATUS_CLAIMED, 'Claimed'),
        (STATUS_RUNNING, 'Running'),
        (STATUS_COMPLETED, 'Completed'),
        (STATUS_FAILED, 'Failed'),
        (STATUS_CANCELLED, 'Cancelled'),
    ]

    job_type = models.CharField(max_length=64, choices=JOB_TYPE_CHOICES, db_index=True)
    status = models.CharField(max_length=32, choices=STATUS_CHOICES, default=STATUS_PENDING, db_index=True)
    scope = models.JSONField(default=dict, blank=True)
    input_payload = models.JSONField(default=dict, blank=True)
    result_payload = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True, default='')
    claimed_by = models.CharField(max_length=128, blank=True, default='')
    claimed_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    model_name = models.CharField(max_length=128, blank=True, default='')
    prompt_version = models.CharField(max_length=64, blank=True, default='')
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='ai_jobs',
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at', '-id']
        indexes = [
            models.Index(fields=['status', 'created_at']),
            models.Index(fields=['job_type', 'status', 'created_at']),
            models.Index(fields=['created_by', '-created_at']),
        ]

    def __str__(self):
        return f'{self.job_type} #{self.pk} ({self.status})'
