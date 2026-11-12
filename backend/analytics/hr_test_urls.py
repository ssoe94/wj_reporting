from django.urls import path
from .hr_views import HrRosterView, HrRosterDetailView, HrClassificationReferenceView, HrWorkbookPreviewView, HrWorkbookImportView, HrMonthListView, HrWorkspaceView, HrImportPreviewView, HrImportView, HrAccessView, HrAccessDetailView
from .hr_views import HrLaborStandardView, HrLaborCalendarView, HrLaborActualPaymentView
from injection.admin_approvals import AdminUserCreateView, SignupApprovalRequestsView, SignupApprovalApproveView
from injection.views import UserProfileViewSet

from .hr_views import HrDailyWorkView, HrDailyWorkPreviewView, HrPersonnelEventView

urlpatterns = [
    path('api/analytics/hr/daily-work/<str:day>/', HrDailyWorkView.as_view()),
    path('api/analytics/hr/daily-work/<str:day>/preview/', HrDailyWorkPreviewView.as_view()),
    path('api/analytics/hr/daily-work/<str:day>/events/', HrPersonnelEventView.as_view()),
    path('api/analytics/hr/labor-actual-payments/<str:month>/', HrLaborActualPaymentView.as_view()),
    path('api/analytics/hr/labor-standards/<str:month>/', HrLaborStandardView.as_view()),
    path('api/analytics/hr/labor-calendar/<str:month>/', HrLaborCalendarView.as_view()),
    path('api/analytics/hr/roster/<str:month>/', HrRosterView.as_view()),
    path('api/analytics/hr/roster/<str:month>/<int:employee_id>/', HrRosterDetailView.as_view()),
    path('api/analytics/hr/classification-reference/', HrClassificationReferenceView.as_view()),
    path('api/analytics/hr/workbook-preview/', HrWorkbookPreviewView.as_view()),
    path('api/analytics/hr/workbook-import/', HrWorkbookImportView.as_view()),
    path('api/admin/users/', AdminUserCreateView.as_view()),
    path('api/admin/user-profiles/', UserProfileViewSet.as_view({'get': 'list'})),
    path('api/admin/user-profiles/<int:pk>/', UserProfileViewSet.as_view({'get': 'retrieve', 'patch': 'partial_update', 'delete': 'destroy'})),
    path('api/admin/approval-requests/', SignupApprovalRequestsView.as_view()),
    path('api/admin/approval-requests/<int:pk>/approve/', SignupApprovalApproveView.as_view()),
    path('api/analytics/hr/workspaces/', HrMonthListView.as_view()),
    path('api/analytics/hr/workspaces/<str:month>/', HrWorkspaceView.as_view()),
    path('api/analytics/hr/workspaces/<str:month>/import/', HrImportView.as_view()),
    path('api/analytics/hr/import-preview/', HrImportPreviewView.as_view()),
    path('api/analytics/hr/access/', HrAccessView.as_view()),
    path('api/analytics/hr/access/<int:user_id>/', HrAccessDetailView.as_view()),
]
