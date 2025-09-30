from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views
from injection.views import ProductViewSet, PartSpecViewSet

app_name = 'assembly'

# DRF router 설정
router = DefaultRouter()
router.register(r'reports', views.AssemblyReportViewSet)
router.register(r'products', ProductViewSet)
router.register(r'partspecs', PartSpecViewSet, basename='partspecs')

urlpatterns = [
    path('', views.index, name='index'),
    path('', include(router.urls)),
]