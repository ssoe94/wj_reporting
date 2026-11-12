from django.urls import path

from .views import AnalyticsProductionProgressView
from .field_operations_views import AnalyticsFieldOperationsView
from .development_task_views import DevelopmentTaskDetailView, DevelopmentTaskInitializeView, DevelopmentTaskListView
from .hr_views import HrRosterView, HrRosterDetailView, HrClassificationReferenceView, HrWorkbookPreviewView, HrWorkbookImportView, HrMonthListView, HrWorkspaceView, HrImportPreviewView, HrImportView, HrAccessView, HrAccessDetailView
from .hr_views import HrLaborStandardView, HrLaborCalendarView, HrLaborActualPaymentView


from .hr_views import HrDailyWorkView, HrDailyWorkPreviewView, HrPersonnelEventView

urlpatterns = [
    path('hr/daily-work/<str:day>/', HrDailyWorkView.as_view()),
    path('hr/daily-work/<str:day>/preview/', HrDailyWorkPreviewView.as_view()),
    path('hr/daily-work/<str:day>/events/', HrPersonnelEventView.as_view()),
    path('hr/labor-actual-payments/<str:month>/', HrLaborActualPaymentView.as_view()),
    path('hr/labor-standards/<str:month>/', HrLaborStandardView.as_view()),
    path('hr/labor-calendar/<str:month>/', HrLaborCalendarView.as_view()),
    path('hr/roster/<str:month>/', HrRosterView.as_view()),
    path('hr/roster/<str:month>/<int:employee_id>/', HrRosterDetailView.as_view()),
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
