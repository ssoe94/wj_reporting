from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import (
    DailyQualityAttentionView,
    QualityImportAssetViewSet,
    QualityImportMediaViewSet,
    QualityImportRowViewSet,
    QualityReportViewSet,
    SupplierViewSet,
    get_cloudinary_signature,
)
from .import_views import QualityImportBatchViewSet


router = DefaultRouter()
router.register(r'reports', QualityReportViewSet, basename='quality-report')
router.register(r'suppliers', SupplierViewSet, basename='supplier')
router.register(r'import-batches', QualityImportBatchViewSet, basename='quality-import-batch')
router.register(r'import-rows', QualityImportRowViewSet, basename='quality-import-row')
router.register(r'import-media', QualityImportMediaViewSet, basename='quality-import-media')
router.register(r'import-assets', QualityImportAssetViewSet, basename='quality-import-asset')

urlpatterns = [
    path('cloudinary-signature/', get_cloudinary_signature, name='cloudinary-signature'),
    path('daily-attention/', DailyQualityAttentionView.as_view(), name='daily-quality-attention'),
] + router.urls

