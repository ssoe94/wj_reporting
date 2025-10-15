from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import QualityReportViewSet, SupplierViewSet, get_cloudinary_signature


router = DefaultRouter()
router.register(r'reports', QualityReportViewSet, basename='quality-report')
router.register(r'suppliers', SupplierViewSet, basename='supplier')

urlpatterns = [
    path('cloudinary-signature/', get_cloudinary_signature, name='cloudinary-signature'),
] + router.urls




