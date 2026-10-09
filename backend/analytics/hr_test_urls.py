from django.urls import path
from .hr_views import HrMonthListView, HrWorkspaceView, HrImportPreviewView, HrImportView, HrAccessView, HrAccessDetailView

urlpatterns = [
    path('api/analytics/hr/workspaces/', HrMonthListView.as_view()),
    path('api/analytics/hr/workspaces/<str:month>/', HrWorkspaceView.as_view()),
    path('api/analytics/hr/workspaces/<str:month>/import/', HrImportView.as_view()),
    path('api/analytics/hr/import-preview/', HrImportPreviewView.as_view()),
    path('api/analytics/hr/access/', HrAccessView.as_view()),
    path('api/analytics/hr/access/<int:user_id>/', HrAccessDetailView.as_view()),
]
