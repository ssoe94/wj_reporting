from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import InjectionReportViewSet, ProductViewSet, PartSpecViewSet, EcoPartSpecViewSet, EngineeringChangeOrderViewSet, InventoryView, SignupRequestView, UserRegistrationRequestViewSet

router = DefaultRouter()
router.register(r'reports', InjectionReportViewSet)
router.register(r'products', ProductViewSet)
router.register(r'parts', PartSpecViewSet)
router.register(r'eco-parts', EcoPartSpecViewSet)
router.register(r'ecos', EngineeringChangeOrderViewSet)
router.register(r'signup-requests', UserRegistrationRequestViewSet)

urlpatterns = [
    path('', include(router.urls)),
    path('inventory/', InventoryView.as_view(), name='inventory'),
    path('signup-request/', SignupRequestView.as_view(), name='signup-request'),
] 