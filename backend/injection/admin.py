from django.contrib import admin
from .models import UserRegistrationRequest, InjectionReport, Product, PartSpec, EngineeringChangeOrder, EcoDetail, EcoPartSpec


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


@admin.register(InjectionReport)
class InjectionReportAdmin(admin.ModelAdmin):
    list_display = ['machine', 'part', 'shift', 'start_datetime', 'input_qty', 'output_qty']
    list_filter = ['machine', 'shift', 'start_datetime']
    search_fields = ['part', 'machine']


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ['name', 'created_at']
    search_fields = ['name']


@admin.register(PartSpec)
class PartSpecAdmin(admin.ModelAdmin):
    list_display = ['part_name', 'part_no', 'std_ct', 'created_at']
    search_fields = ['part_name', 'part_no']


@admin.register(EngineeringChangeOrder)
class EngineeringChangeOrderAdmin(admin.ModelAdmin):
    list_display = ['eco_number', 'title', 'status', 'created_by', 'created_at']
    list_filter = ['status', 'created_at']
    search_fields = ['eco_number', 'title']


@admin.register(EcoDetail)
class EcoDetailAdmin(admin.ModelAdmin):
    list_display = ['eco', 'part_name', 'change_type', 'status']
    list_filter = ['change_type', 'status']
    search_fields = ['part_name']


@admin.register(EcoPartSpec)
class EcoPartSpecAdmin(admin.ModelAdmin):
    list_display = ['eco', 'part_name', 'part_no', 'std_ct']
    search_fields = ['part_name', 'part_no']