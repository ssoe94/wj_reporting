from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import InjectionReportViewSet, ProductViewSet, PartSpecViewSet, EcoPartSpecViewSet, EngineeringChangeOrderViewSet, InventoryView, SignupRequestView, UserRegistrationRequestViewSet, UserProfileViewSet, UserMeView, ChangePasswordView, ResetPasswordView

router = DefaultRouter()
router.register(r'reports', InjectionReportViewSet)
router.register(r'products', ProductViewSet)
router.register(r'parts', PartSpecViewSet)
router.register(r'eco-parts', EcoPartSpecViewSet)
router.register(r'ecos', EngineeringChangeOrderViewSet)
router.register(r'signup-requests', UserRegistrationRequestViewSet)
router.register(r'user-profiles', UserProfileViewSet)

urlpatterns = [
    path('', include(router.urls)),
    path('inventory/', InventoryView.as_view(), name='inventory'),
    path('signup-request/', SignupRequestView.as_view(), name='signup-request'),
    path('user/me/', UserMeView.as_view(), name='user-me'),
    path('user/change-password/', ChangePasswordView.as_view(), name='change-password'),
    path('user/reset-password/', ResetPasswordView.as_view(), name='reset-password'),
] 