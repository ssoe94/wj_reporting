from django.urls import path
from . import views

urlpatterns = [
    path('inventory/', views.InventoryListView.as_view(), name='inventory_list'),
    path('inventory/refresh/', views.InventoryRefreshView.as_view(), name='inventory_refresh'),
    path('inventory/mes-test/', views.MESTokenTestView.as_view(), name='mes_token_test'),
    path('inventory/manual-snapshot/', views.ManualSnapshotView.as_view(), name='manual_snapshot'),
    path('inventory/last-update/', views.LastUpdateView.as_view(), name='last_update'),
    path('inventory/status/', views.inventory_status, name='inventory_status'),
    path('inventory/export/', views.InventoryExportView.as_view(), name='inventory_export'),
    path('inventory/daily-report/', views.daily_report, name='daily_report'),
    path('inventory/daily-report/summary/', views.daily_report_summary, name='daily_report_summary'),
    path('inventory/daily-report/calendar/', views.daily_report_calendar, name='daily_report_calendar'),
    path('inventory/daily-report/available-dates/', views.daily_report_available_dates, name='daily_report_available_dates'),
    path('inventory/daily-report/compare/', views.daily_report_compare, name='daily_report_compare'),
    path('inventory/daily-report/export-csv/', views.daily_report_export_csv, name='daily_report_export_csv'),
    path('inventory/snapshot/create/', views.create_snapshot, name='create_snapshot'),
    path('inventory/email/schedule/', views.schedule_email_report, name='schedule_email_report'),
    path('inventory/email/status/', views.email_status, name='email_status'),
    path('warehouses/', views.WarehouseListView.as_view(), name='warehouse_list'),
    
    # 통합 품목 관리 API
    path('unified-parts/', views.unified_parts_api, name='unified_parts_api'),
    path('unified-parts/<str:part_no>/', views.unified_parts_detail_api, name='unified_parts_detail'),
    path('unified-parts/search/', views.unified_parts_search, name='unified_parts_search'),
    path('unified-parts/models/', views.unified_parts_models, name='unified_parts_models'),
    path('unified-parts/migrate/', views.migrate_legacy_data, name='migrate_legacy_data'),
] 
