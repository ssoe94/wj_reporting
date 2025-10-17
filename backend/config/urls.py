"""
URL configuration for config project.
"""
from django.contrib import admin
from django.urls import path, include, re_path
from django.views.generic import TemplateView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from . import views
from . import urls_admin
from injection.views import SignupRequestView, ChangePasswordView, SignupApprovalPortalView
from django.conf import settings
from django.conf.urls.static import static

# API 라우팅
api_urlpatterns = [
    path('api/injection/', include('injection.urls')),
    path('api/assembly/', include('assembly.urls')),
    path('api/sales/', include('sales.urls')),
    path('api/overview/', include('overview.urls')),
    path('api/inventory/', include('inventory.urls')),
    path('api/quality/', include('quality.urls')),
    path('api/health/', views.health_check, name='health_check'),
    path('api/health', views.health_check, name='health_check_no_slash'),
    path('api/signup-request/', SignupRequestView.as_view(), name='signup_request'),
    path('api/user/change-password/', ChangePasswordView.as_view(), name='user_change_password'),
    path('api/ecos/', include('injection.urls_ecos')),
    path('api/eco-parts/', include('injection.urls_eco_parts')),
    # `api/signup-requests/` is defined within injection.urls, so this line is removed to avoid conflict.
    # path('api/signup-requests/', include('config.urls_auth'))
]

urlpatterns = [
    path('admin/', admin.site.urls),
    path('staff/signup-approvals/', SignupApprovalPortalView.as_view(), name='signup-approval-portal'),

    # JWT endpoints (AllowAny by default)
    path('api/token/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('api/token', TokenObtainPairView.as_view(), name='token_obtain_pair_no_slash'),
    path('api/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('api/token/refresh', TokenRefreshView.as_view(), name='token_refresh_no_slash'),

    # API routes
    path('', include(api_urlpatterns)),
    path('api/admin/', include(urls_admin)),

    # SPA fallback
    re_path(r'^(?!api/|admin/|static/|media/).*$', TemplateView.as_view(template_name='index.html')),
]

# 개발 환경에서 미디어 파일 서빙
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
