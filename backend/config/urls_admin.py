from django.urls import include, path
from rest_framework.routers import DefaultRouter

from injection.views import UserProfileViewSet, UserRegistrationRequestViewSet, ChangePasswordView, ResetPasswordView

router = DefaultRouter()
router.register(r'user-profiles', UserProfileViewSet, basename='admin-user-profile')
router.register(r'signup-requests', UserRegistrationRequestViewSet, basename='admin-signup-request')

urlpatterns = [
    path('', include(router.urls)),
    path('user/reset-password/', ResetPasswordView.as_view(), name='admin-reset-password'),
    path('user/change-password/', ChangePasswordView.as_view(), name='admin-change-password'),
]
