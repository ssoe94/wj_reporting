from django.urls import path

from .views import AnalyticsProductionProgressView
from .field_operations_views import AnalyticsFieldOperationsView


urlpatterns = [
    path('production-progress/', AnalyticsProductionProgressView.as_view(), name='analytics-production-progress'),
    path('field-operations/', AnalyticsFieldOperationsView.as_view(), name='analytics-field-operations'),
]
