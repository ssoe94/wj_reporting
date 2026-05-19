from django.urls import path

from .views import AnalyticsProductionProgressView


urlpatterns = [
    path('production-progress/', AnalyticsProductionProgressView.as_view(), name='analytics-production-progress'),
]
