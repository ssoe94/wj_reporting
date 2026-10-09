from django.urls import path
from .hr_views import HrMonthListView, HrWorkspaceView, HrImportPreviewView, HrImportView, HrAccessView, HrAccessDetailView
from injection.admin_approvals import AdminUserCreateView, SignupApprovalRequestsView, SignupApprovalApproveView
from injection.views import UserProfileViewSet

urlpatterns = [
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
