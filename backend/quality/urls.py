from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import (
    DailyQualityAttentionView,
    QualityClassificationAuditApplyColorView,
    QualityClassificationAuditReviewView,
    QualityClassificationAuditView,
    QualityImportAssetViewSet,
    QualityImportMediaViewSet,
    QualityImportRowViewSet,
    QualityReportViewSet,
    SupplierViewSet,
    get_cloudinary_signature,
)
from .import_views import (
    QualityExcelDirectAssetCompleteView,
    QualityExcelDirectFinalizeView,
    QualityExcelDirectJobDetailView,
    QualityExcelDirectJobView,
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
        'excel-import/direct/jobs/',
        QualityExcelDirectJobView.as_view(),
        name='quality-excel-import-direct-jobs',
    ),
    path(
        'excel-import/direct/jobs/<int:pk>/',
        QualityExcelDirectJobDetailView.as_view(),
        name='quality-excel-import-direct-job-detail',
    ),
    path(
        'excel-import/direct/jobs/<int:pk>/assets/<str:asset_sha256>/complete/',
        QualityExcelDirectAssetCompleteView.as_view(),
        name='quality-excel-import-direct-asset-complete',
    ),
    path(
        'excel-import/direct/jobs/<int:pk>/finalize/',
        QualityExcelDirectFinalizeView.as_view(),
        name='quality-excel-import-direct-finalize',
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
    path(
        'classification-audit/',
        QualityClassificationAuditView.as_view(),
        name='quality-classification-audit',
    ),
    path(
        'classification-audit/<int:job_id>/review/',
        QualityClassificationAuditReviewView.as_view(),
        name='quality-classification-audit-review',
    ),
    path(
        'classification-audit/<int:job_id>/apply-color/',
        QualityClassificationAuditApplyColorView.as_view(),
        name='quality-classification-audit-apply-color',
    ),
] + router.urls
