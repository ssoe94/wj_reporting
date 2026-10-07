"""Explicit WJ area assignments; none of these rows assert a MES executor."""
from django.conf import settings
from django.db import models


class InspectionShiftSetting(models.Model):
    code = models.CharField(max_length=64, unique=True)
    label = models.CharField(max_length=128)
    timezone = models.CharField(max_length=64, default='Asia/Shanghai')
    starts_at = models.TimeField(null=True, blank=True)
    ends_at = models.TimeField(null=True, blank=True)
    effective_from = models.DateTimeField(null=True, blank=True)
    effective_until = models.DateTimeField(null=True, blank=True)
    appearance_assignee = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='appearance_inspection_shifts')
    dimension_assignee = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='dimension_inspection_shifts')
    active = models.BooleanField(default=False)
    version = models.PositiveIntegerField(default=1)
    creator = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='created_inspection_shifts')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['code', 'id']
        default_permissions = ()


class InspectionRoleWorkflow(models.Model):
    request = models.OneToOneField('quality.InspectionRequest', on_delete=models.PROTECT,
        related_name='role_workflow')
    shift_setting = models.ForeignKey(InspectionShiftSetting, null=True,
        on_delete=models.PROTECT, related_name='workflows')
    shift_snapshot = models.JSONField(default=dict)
    actor_snapshot = models.JSONField(default=dict)
    config_version = models.PositiveIntegerField(default=1)
    item_areas = models.JSONField(default=dict)
    status = models.CharField(max_length=24, default='unconfigured')
    new_role_only = models.BooleanField(default=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        default_permissions = ()


class InspectionAreaResult(models.Model):
    workflow = models.ForeignKey(InspectionRoleWorkflow, on_delete=models.PROTECT,
        related_name='areas')
    area = models.CharField(max_length=16, choices=[('appearance', 'Appearance'), ('dimension', 'Dimension')])
    assigned_to = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='assigned_inspection_areas')
    assigned_to_name = models.CharField(max_length=150, blank=True, default='')
    version = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, default='draft')
    judgement = models.CharField(max_length=8, blank=True, default='')
    measurements = models.JSONField(default=list)
    evidence = models.JSONField(default=list)
    completed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='completed_inspection_areas')
    completed_by_name = models.CharField(max_length=150, blank=True, default='')
    completed_at = models.DateTimeField(null=True)
    mes_status = models.CharField(max_length=24, default='blocked')
    mes_blocked_reason = models.CharField(max_length=64, default='mes_partial_multi_executor_contract_unverified')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        default_permissions = ()
        constraints = [models.UniqueConstraint(fields=['workflow', 'area'], name='quality_inspection_role_area')]
