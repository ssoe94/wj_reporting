from django.contrib import admin
from .models import (
    MouldDataSnapshot,
    MouldUsageConfirmation,
    UserRegistrationRequest,
    UserProfile,
)


@admin.register(UserRegistrationRequest)
class UserRegistrationRequestAdmin(admin.ModelAdmin):
    list_display = ['full_name', 'department', 'email', 'status', 'created_at', 'approved_by', 'approved_at']
    list_filter = ['status', 'department', 'created_at']
    search_fields = ['full_name', 'email', 'department']
    readonly_fields = ['created_at', 'updated_at']
    
    fieldsets = (
        ('기본 정보', {
            'fields': ('full_name', 'department', 'email', 'reason')
        }),
        ('상태', {
            'fields': ('status', 'approved_by', 'approved_at', 'temporary_password')
        }),
        ('권한', {
            'fields': (
                'can_view_injection', 'can_view_assembly', 'can_view_quality',
                'can_view_sales', 'can_view_development', 'is_admin'
            )
        }),
        ('날짜', {
            'fields': ('created_at', 'updated_at')
        }),
    )


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ['user', 'can_view_injection', 'can_view_assembly', 'can_view_quality', 'can_view_sales', 'can_view_development', 'is_admin', 'updated_at']
    list_filter = ['can_view_injection', 'can_view_assembly', 'can_view_quality', 'can_view_sales', 'can_view_development', 'is_admin']
    search_fields = ['user__username', 'user__email', 'user__first_name']
    readonly_fields = ['created_at', 'updated_at']
    
    fieldsets = (
        ('사용자', {
            'fields': ('user',)
        }),
        ('권한', {
            'fields': ('can_view_injection', 'can_view_assembly', 'can_view_quality', 'can_view_sales', 'can_view_development', 'is_admin')
        }),
        ('날짜', {
            'fields': ('created_at', 'updated_at')
        }),
    )


@admin.register(MouldDataSnapshot)
class MouldDataSnapshotAdmin(admin.ModelAdmin):
    list_display = ['snapshot_key', 'kind', 'instance_id', 'refreshed_at', 'source_latest_at', 'last_error']
    list_filter = ['kind', 'refreshed_at']
    search_fields = ['snapshot_key', 'instance_id']
    readonly_fields = [
        'snapshot_key', 'kind', 'instance_id', 'payload', 'source_latest_at',
        'refreshed_at', 'refresh_started_at', 'last_error',
    ]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(MouldUsageConfirmation)
class MouldUsageConfirmationAdmin(admin.ModelAdmin):
    list_display = [
        'mould_instance_id', 'milestone_shots', 'shot_count_at_confirmation',
        'confirmed_by', 'confirmed_at',
    ]
    list_filter = ['confirmed_at']
    search_fields = ['mould_instance_id', 'confirmed_by__username', 'note']
    readonly_fields = [
        'mould_instance_id', 'milestone_shots', 'shot_count_at_confirmation',
        'confirmed_by', 'confirmed_at', 'note',
    ]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
