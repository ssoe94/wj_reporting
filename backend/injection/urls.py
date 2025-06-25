from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import InjectionReportViewSet, ProductViewSet, PartSpecViewSet

router = DefaultRouter()
router.register(r'reports', InjectionReportViewSet)
router.register(r'products', ProductViewSet)
router.register(r'parts', PartSpecViewSet)

urlpatterns = [
    path('', include(router.urls)),
] 