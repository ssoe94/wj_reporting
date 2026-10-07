"""Explicit WJ area assignments; none of these rows assert a MES executor."""
from django.conf import settings
from django.db import models


class InspectionInspector(models.Model):
    """Declared human name only; never an authentication or MES account."""
    display_name = models.CharField(max_length=128)
    normalized_name = models.CharField(max_length=384)
    distinguishing_note = models.CharField(max_length=64, blank=True, default='')
    normalized_note = models.CharField(max_length=192, blank=True, default='')
    creator = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='created_inspection_inspectors')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['display_name', 'id']
        default_permissions = ()
        constraints = [models.UniqueConstraint(fields=['normalized_name', 'normalized_note'],
            name='quality_inspector_normalized_name_note')]


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
    appearance_person = models.ForeignKey(InspectionInspector, null=True, blank=True,
        on_delete=models.PROTECT, related_name='appearance_shifts')
    dimension_person = models.ForeignKey(InspectionInspector, null=True, blank=True,
        on_delete=models.PROTECT, related_name='dimension_shifts')
    active = models.BooleanField(default=False)
    version = models.PositiveIntegerField(default=1)
    creator = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='created_inspection_shifts')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['code', 'id']
        default_permissions = ()


class InspectionWeeklyRoster(models.Model):
    week_start = models.DateField(unique=True)
    version = models.PositiveIntegerField(default=1)
    day_setting = models.ForeignKey(InspectionShiftSetting, on_delete=models.PROTECT,
        related_name='day_weeks')
    night_setting = models.ForeignKey(InspectionShiftSetting, on_delete=models.PROTECT,
        related_name='night_weeks')
    creator = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='created_inspection_weeks')
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='updated_inspection_weeks')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['week_start']
        default_permissions = ()


class InspectionRoleWorkflow(models.Model):
    request = models.OneToOneField('quality.InspectionRequest', on_delete=models.PROTECT,
        related_name='role_workflow')
    shift_setting = models.ForeignKey(InspectionShiftSetting, null=True,
        on_delete=models.PROTECT, related_name='workflows')
    shift_snapshot = models.JSONField(default=dict)
    actor_snapshot = models.JSONField(default=dict)
    shared_terminal_operator = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='shared_terminal_inspection_workflows')
    shared_terminal_operator_name = models.CharField(max_length=150, blank=True, default='')
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
    assigned_person = models.ForeignKey(InspectionInspector, null=True, blank=True,
        on_delete=models.PROTECT, related_name='assigned_areas')
    assigned_to_name = models.CharField(max_length=150, blank=True, default='')
    version = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, default='draft')
    judgement = models.CharField(max_length=8, blank=True, default='')
    measurements = models.JSONField(default=list)
    item_authorship = models.JSONField(default=dict)
    evidence = models.JSONField(default=list)
    completed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True,
        on_delete=models.SET_NULL, related_name='completed_inspection_areas')
    completed_person = models.ForeignKey(InspectionInspector, null=True, blank=True,
        on_delete=models.PROTECT, related_name='completed_areas')
    completed_by_name = models.CharField(max_length=150, blank=True, default='')
    completed_recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='recorded_completed_inspection_areas')
    completed_recorded_by_name = models.CharField(max_length=150, blank=True, default='')
    completed_at = models.DateTimeField(null=True)
    mes_status = models.CharField(max_length=24, default='blocked')
    mes_blocked_reason = models.CharField(max_length=64, default='mes_partial_multi_executor_contract_unverified')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        default_permissions = ()
        constraints = [models.UniqueConstraint(fields=['workflow', 'area'], name='quality_inspection_role_area')]
