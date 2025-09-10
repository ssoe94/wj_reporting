from django.contrib import admin
from .models import QualityReport


@admin.register(QualityReport)
class QualityReportAdmin(admin.ModelAdmin):
    list_display = ('report_dt', 'section', 'model', 'part_no', 'lot_qty', 'inspection_qty', 'defect_qty', 'defect_rate', 'judgement')
    search_fields = ('model', 'part_no', 'phenomenon', 'disposition')
    list_filter = ('section', 'judgement')

# Register your models here.
