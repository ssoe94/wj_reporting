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
from .import_views import (
    QualityExcelImportCommitView,
    QualityExcelImportJobDetailView,
    QualityExcelImportJobRetryView,
    QualityExcelImportJobView,
    QualityExcelImportPreviewView,
    QualityExcelImportRollbackView,
    QualityExcelImportView,
    QualityImportBatchViewSet,
)
from .archive_views import (
    ArchiveAssetContentView,
    ArchiveAssetListView,
    ArchiveAssetMarkMirroredView,
    ArchiveReportListView,
    ArchiveServiceProvisionView,
)


router = DefaultRouter()
router.register(r'reports', QualityReportViewSet, basename='quality-report')
router.register(r'suppliers', SupplierViewSet, basename='supplier')
router.register(r'import-batches', QualityImportBatchViewSet, basename='quality-import-batch')
router.register(r'import-rows', QualityImportRowViewSet, basename='quality-import-row')
router.register(r'import-media', QualityImportMediaViewSet, basename='quality-import-media')
router.register(r'import-assets', QualityImportAssetViewSet, basename='quality-import-asset')

urlpatterns = [
    path('excel-import/', QualityExcelImportView.as_view(), name='quality-excel-import'),
    path(
        'excel-import/preview/',
        QualityExcelImportPreviewView.as_view(),
        name='quality-excel-import-preview',
    ),
    path(
        'excel-import/commit/',
        QualityExcelImportCommitView.as_view(),
        name='quality-excel-import-commit',
    ),
    path(
        'excel-import/jobs/',
        QualityExcelImportJobView.as_view(),
        name='quality-excel-import-jobs',
    ),
    path(
        'excel-import/jobs/<int:pk>/',
        QualityExcelImportJobDetailView.as_view(),
        name='quality-excel-import-job-detail',
    ),
    path(
        'excel-import/jobs/<int:pk>/retry/',
        QualityExcelImportJobRetryView.as_view(),
        name='quality-excel-import-job-retry',
    ),
    path(
        'excel-import/rollback-today/',
        QualityExcelImportRollbackView.as_view(),
        name='quality-excel-import-rollback-today',
    ),
    path('archive/reports/', ArchiveReportListView.as_view(), name='quality-archive-report-list'),
    path('archive/assets/', ArchiveAssetListView.as_view(), name='quality-archive-asset-list'),
    path(
        'archive/assets/<int:pk>/content/',
        ArchiveAssetContentView.as_view(),
        name='quality-archive-asset-content',
    ),
    path(
        'archive/assets/<int:pk>/mark-mirrored/',
        ArchiveAssetMarkMirroredView.as_view(),
        name='quality-archive-asset-mark-mirrored',
    ),
    path(
        'archive/provision/',
        ArchiveServiceProvisionView.as_view(),
        name='quality-archive-service-provision',
    ),
    path('cloudinary-signature/', get_cloudinary_signature, name='cloudinary-signature'),
    path('daily-attention/', DailyQualityAttentionView.as_view(), name='daily-quality-attention'),
] + router.urls
