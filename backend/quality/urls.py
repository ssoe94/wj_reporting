from rest_framework.routers import DefaultRouter
from .views import QualityReportViewSet


router = DefaultRouter()
router.register(r'reports', QualityReportViewSet, basename='quality-report')

urlpatterns = router.urls


