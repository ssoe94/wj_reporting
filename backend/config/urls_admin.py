from django.urls import include, path
from rest_framework.routers import DefaultRouter

from injection.views import UserProfileViewSet, UserRegistrationRequestViewSet, ChangePasswordView, ResetPasswordView
from injection.admin_approvals import (
    SignupApprovalRequestsView,
    SignupApprovalApproveView,
    SignupApprovalRejectView,
)

router = DefaultRouter()
router.register(r'user-profiles', UserProfileViewSet, basename='admin-user-profile')
router.register(r'signup-requests', UserRegistrationRequestViewSet, basename='admin-signup-request')

urlpatterns = [
    path('', include(router.urls)),
    path('approval-requests/', SignupApprovalRequestsView.as_view(), name='admin-approval-requests'),
    path('approval-requests/<int:pk>/approve/', SignupApprovalApproveView.as_view(), name='admin-approval-approve'),
    path('approval-requests/<int:pk>/reject/', SignupApprovalRejectView.as_view(), name='admin-approval-reject'),
    path('user/reset-password/', ResetPasswordView.as_view(), name='admin-reset-password'),
    path('user/change-password/', ChangePasswordView.as_view(), name='admin-change-password'),
]
