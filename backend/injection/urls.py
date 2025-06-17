from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import InjectionReportViewSet

router = DefaultRouter()
router.register(r'reports', InjectionReportViewSet)

urlpatterns = [
    path('', include(router.urls)),
] 