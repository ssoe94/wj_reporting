from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    InjectionReportViewSet, ProductViewSet, PartSpecViewSet, EcoPartSpecViewSet,
    EngineeringChangeOrderViewSet, InventoryView, SignupRequestView,
    UserRegistrationRequestViewSet, UserProfileViewSet, UserMeView,
    ChangePasswordView, ResetPasswordView, CycleTimeSetupViewSet,
    CycleTimeTestRecordViewSet, InjectionMonitoringRecordListView,
    ResourceMonitorPageListView, ProductionMatrixView, MachineListView,
    MesRawDebugView, SingleDeviceMonitorView, UpdateRecentSnapshotsView
)

router = DefaultRouter()
router.register(r'reports', InjectionReportViewSet)
router.register(r'products', ProductViewSet)
router.register(r'parts', PartSpecViewSet)
router.register(r'eco-parts', EcoPartSpecViewSet)
router.register(r'ecos', EngineeringChangeOrderViewSet)
router.register(r'signup-requests', UserRegistrationRequestViewSet)
router.register(r'user-profiles', UserProfileViewSet)
router.register(r'setup', CycleTimeSetupViewSet)
router.register(r'test-records', CycleTimeTestRecordViewSet)

urlpatterns = [
    path('', include(router.urls)),
    path('inventory/', InventoryView.as_view(), name='inventory'),
    path('monitoring-data/', InjectionMonitoringRecordListView.as_view(), name='injection-monitoring-data'),
    path('update-recent-snapshots/', UpdateRecentSnapshotsView.as_view(), name='update-recent-snapshots'),
    # BLACKLAKE 스펙을 따르는 새로운 API 엔드포인트
    path('resource/open/v1/resource_monitor/_page_list/', ResourceMonitorPageListView.as_view(), name='resource-monitor-page-list'),
    # 생산 모니터링 매트릭스 API
    path('production-matrix/', ProductionMatrixView.as_view(), name='production-matrix'),
    path('machines/', MachineListView.as_view(), name='machine-list'),
    path('api/mes/', include('inventory.urls')),
    path('injection/monitoring/single-device/', SingleDeviceMonitorView.as_view(), name='single-device-monitor'),
    path('signup-request/', SignupRequestView.as_view(), name='signup-request'),
    path('user/me/', UserMeView.as_view(), name='user-me'),
    path('user/change-password/', ChangePasswordView.as_view(), name='change-password'),
    path('user/reset-password/', ResetPasswordView.as_view(), name='reset-password'),

    # 사출 모니터링 데이터 수집 작업 관리

] 