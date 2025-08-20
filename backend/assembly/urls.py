from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views

app_name = 'assembly'

# DRF router 설정
router = DefaultRouter()
router.register(r'reports', views.AssemblyReportViewSet)
router.register(r'partspecs', views.AssemblyPartSpecViewSet)
router.register(r'products', views.AssemblyProductViewSet)

urlpatterns = [
    path('', views.index, name='index'),
    path('api/', include(router.urls)),
] 