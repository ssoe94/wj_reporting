from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import InjectionReportViewSet, ProductViewSet, PartSpecViewSet, EngineeringChangeOrderViewSet, InventoryView

router = DefaultRouter()
router.register(r'reports', InjectionReportViewSet)
router.register(r'products', ProductViewSet)
router.register(r'parts', PartSpecViewSet)
router.register(r'ecos', EngineeringChangeOrderViewSet)

urlpatterns = [
    path('', include(router.urls)),
    path('inventory/', InventoryView.as_view(), name='inventory'),
] 