from django.contrib import admin
from .models import AssemblyReport, AssemblyPartSpec, AssemblyProduct


@admin.register(AssemblyReport)
class AssemblyReportAdmin(admin.ModelAdmin):
    list_display = [
        'date', 'line_no', 'part_no', 'model', 'plan_qty', 'actual_qty',
        'total_defect_qty', 'achievement_rate', 'defect_rate'
    ]
    list_filter = ['date', 'line_no', 'model']
    search_fields = ['part_no', 'model', 'note']
    ordering = ['-date', 'line_no']
    readonly_fields = ['total_defect_qty', 'achievement_rate', 'defect_rate', 'total_production_qty', 'uptime_rate']
    
    fieldsets = (
        ('기본 정보', {
            'fields': ('date', 'line_no', 'part_no', 'model')
        }),
        ('수량 정보', {
            'fields': ('plan_qty', 'input_qty', 'actual_qty')
        }),
        ('불량 분류', {
            'fields': ('injection_defect', 'outsourcing_defect', 'processing_defect')
        }),
        ('시간 정보', {
            'fields': ('total_time', 'idle_time', 'operation_time', 'workers')
        }),
        ('계산 결과', {
            'fields': ('total_defect_qty', 'achievement_rate', 'defect_rate', 'total_production_qty', 'uptime_rate'),
            'classes': ('collapse',)
        }),
        ('기타', {
            'fields': ('note',)
        }),
    )


@admin.register(AssemblyPartSpec)
class AssemblyPartSpecAdmin(admin.ModelAdmin):
    list_display = ['part_no', 'model_code', 'description', 'process_type', 'valid_from']
    list_filter = ['process_type', 'material_type', 'valid_from']
    search_fields = ['part_no', 'model_code', 'description']
    ordering = ['part_no']


@admin.register(AssemblyProduct)
class AssemblyProductAdmin(admin.ModelAdmin):
    list_display = ['model', 'part_no', 'process_line']
    list_filter = ['process_line']
    search_fields = ['model', 'part_no']
    ordering = ['model']