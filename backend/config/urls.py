"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path, include, re_path
from django.views.generic import TemplateView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('injection.urls')),
    path('api/assembly/', include('assembly.urls')),
    path('api/sales/', include('sales.urls')),
    path('api/overview/', include('overview.urls')),
    path('api/quality/', include('quality.urls')),
    path('api/mes/', include('inventory.urls')),
    path('api/token/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('api/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    # ── SPA routes fallback ──
    # 운영 환경에서 frontend/dist가 없을 때를 대비해 backend/static/index.html을 기본 템플릿으로 사용
    re_path(r'^(?!api/).*$', TemplateView.as_view(template_name='index.html'), name='spa'),
]