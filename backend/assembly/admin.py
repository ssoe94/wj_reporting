from django.contrib import admin
from .models import AssemblyReport, DefectHistory


@admin.register(AssemblyReport)
class AssemblyReportAdmin(admin.ModelAdmin):
    list_display = [
        'date', 'line_no', 'part_no', 'model', 'supply_type', 'plan_qty', 'actual_qty',
        'total_defect_qty', 'achievement_rate'
    ]
    list_filter = ['date', 'line_no', 'model', 'supply_type']
    search_fields = ['part_no', 'model', 'note']
    ordering = ['-date', 'line_no']
    readonly_fields = ['total_defect_qty', 'achievement_rate', 'operation_rate', 'uph', 'upph']
    
    fieldsets = (
        ('기본 정보', {
            'fields': ('date', 'line_no', 'part_no', 'model', 'supply_type')
        }),
        ('수량 정보', {
            'fields': ('plan_qty', 'input_qty', 'actual_qty', 'rework_qty')
        }),
        ('불량 분류', {
            'fields': ('injection_defect', 'outsourcing_defect', 'processing_defect')
        }),
        ('동적 불량 상세', {
            'fields': ('processing_defects_dynamic', 'outsourcing_defects_dynamic')
        }),
        ('시간 정보', {
            'fields': ('total_time', 'idle_time', 'operation_time', 'workers')
        }),
        ('계산 결과', {
            'fields': ('total_defect_qty', 'achievement_rate', 'operation_rate', 'uph', 'upph'),
            'classes': ('collapse',)
        }),
        ('기타', {
            'fields': ('note',)
        }),
    )


@admin.register(DefectHistory)
class DefectHistoryAdmin(admin.ModelAdmin):
    list_display = ('category', 'defect_type', 'usage_count', 'last_used')
    list_filter = ('category',)
    search_fields = ('defect_type',)
    ordering = ('-last_used',)