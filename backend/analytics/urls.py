from django.urls import path

from .views import AnalyticsProductionProgressView
from .field_operations_views import AnalyticsFieldOperationsView
from .development_task_views import DevelopmentTaskDetailView, DevelopmentTaskInitializeView, DevelopmentTaskListView


urlpatterns = [
    path('development-tasks/', DevelopmentTaskListView.as_view(), name='development-task-list'),
    path('development-tasks/initialize/', DevelopmentTaskInitializeView.as_view(), name='development-task-initialize'),
    path('development-tasks/<slug:slug>/', DevelopmentTaskDetailView.as_view(), name='development-task-detail'),
    path('production-progress/', AnalyticsProductionProgressView.as_view(), name='analytics-production-progress'),
    path('field-operations/', AnalyticsFieldOperationsView.as_view(), name='analytics-field-operations'),
]
