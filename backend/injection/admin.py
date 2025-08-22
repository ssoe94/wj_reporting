from django.contrib import admin
from .models import UserRegistrationRequest, UserProfile


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
                'can_view_injection', 'can_edit_injection',
                'can_view_machining', 'can_edit_machining',
                'can_view_inventory', 'can_edit_inventory',
                'can_view_eco', 'can_edit_eco'
            )
        }),
        ('날짜', {
            'fields': ('created_at', 'updated_at')
        }),
    )


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ['user', 'can_view_injection', 'can_edit_injection', 'can_view_eco', 'can_edit_eco', 'updated_at']
    list_filter = ['can_view_injection', 'can_edit_injection', 'can_view_eco', 'can_edit_eco']
    search_fields = ['user__username', 'user__email', 'user__first_name']
    readonly_fields = ['created_at', 'updated_at']
    
    fieldsets = (
        ('사용자', {
            'fields': ('user',)
        }),
        ('사출 권한', {
            'fields': ('can_view_injection', 'can_edit_injection')
        }),
        ('가공 권한', {
            'fields': ('can_view_machining', 'can_edit_machining')
        }),
        ('재고 권한', {
            'fields': ('can_view_inventory', 'can_edit_inventory')
        }),
        ('ECO 권한', {
            'fields': ('can_view_eco', 'can_edit_eco')
        }),
        ('날짜', {
            'fields': ('created_at', 'updated_at')
        }),
    )