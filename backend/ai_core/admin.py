from django.contrib import admin

from .models import AiJob


@admin.register(AiJob)
class AiJobAdmin(admin.ModelAdmin):
    list_display = (
        'id',
        'job_type',
        'status',
        'claimed_by',
        'model_name',
        'created_by',
        'created_at',
        'updated_at',
    )
    list_filter = ('job_type', 'status', 'created_at')
    search_fields = ('claimed_by', 'model_name', 'prompt_version', 'error_message')
    readonly_fields = ('created_at', 'updated_at', 'claimed_at', 'started_at', 'completed_at')
    ordering = ('-created_at', '-id')
