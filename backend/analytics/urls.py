from django.urls import path

from .views import AnalyticsProductionProgressView
from .field_operations_views import AnalyticsFieldOperationsView
from .development_task_views import DevelopmentTaskDetailView, DevelopmentTaskInitializeView, DevelopmentTaskListView
from .hr_views import HrClassificationReferenceView, HrWorkbookPreviewView, HrWorkbookImportView, HrMonthListView, HrWorkspaceView, HrImportPreviewView, HrImportView, HrAccessView, HrAccessDetailView


urlpatterns = [
    path('hr/classification-reference/', HrClassificationReferenceView.as_view()),
    path('hr/workbook-preview/', HrWorkbookPreviewView.as_view()),
    path('hr/workbook-import/', HrWorkbookImportView.as_view()),
    path('hr/workspaces/', HrMonthListView.as_view(), name='hr-month-list'),
    path('hr/workspaces/<str:month>/', HrWorkspaceView.as_view(), name='hr-workspace'),
    path('hr/workspaces/<str:month>/import/', HrImportView.as_view(), name='hr-import'),
    path('hr/import-preview/', HrImportPreviewView.as_view(), name='hr-import-preview'),
    path('hr/access/', HrAccessView.as_view(), name='hr-access'),
    path('hr/access/<int:user_id>/', HrAccessDetailView.as_view(), name='hr-access-detail'),
    path('development-tasks/', DevelopmentTaskListView.as_view(), name='development-task-list'),
    path('development-tasks/initialize/', DevelopmentTaskInitializeView.as_view(), name='development-task-initialize'),
    path('development-tasks/<slug:slug>/', DevelopmentTaskDetailView.as_view(), name='development-task-detail'),
    path('production-progress/', AnalyticsProductionProgressView.as_view(), name='analytics-production-progress'),
    path('field-operations/', AnalyticsFieldOperationsView.as_view(), name='analytics-field-operations'),
]
