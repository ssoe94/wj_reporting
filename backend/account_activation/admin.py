from django.contrib import admin
from django.urls import path
from . import services, views
from .models import ActivationGrant


@admin.register(ActivationGrant)
class ActivationGrantAdmin(admin.ModelAdmin):
    change_list_template = 'account_activation/change_list.html'
    list_display = ('target_id', 'issuer_id', 'status', 'created_at', 'expires_at', 'consumed_at', 'revoked_at')
    fields = list_display + ('review_reference', 'revoked_by')
    readonly_fields = fields
    actions = None

    def has_module_permission(self, request):
        return services.enabled() and services.administrator(request.user)

    def has_view_permission(self, request, obj=None):
        return self.has_module_permission(request)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_urls(self):
        return [path('issue/', self.admin_site.admin_view(views.issue),
                     name='account_activation_issue')] + super().get_urls()
