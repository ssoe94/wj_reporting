from rest_framework.routers import DefaultRouter
from .views import QualityReportViewSet, SupplierViewSet


router = DefaultRouter()
router.register(r'reports', QualityReportViewSet, basename='quality-report')
router.register(r'suppliers', SupplierViewSet, basename='supplier')

urlpatterns = router.urls




