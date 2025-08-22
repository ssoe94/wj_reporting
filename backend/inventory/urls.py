from django.urls import path
from . import views

urlpatterns = [
    path('inventory/', views.InventoryListView.as_view(), name='inventory_list'),
    path('inventory/refresh/', views.InventoryRefreshView.as_view(), name='inventory_refresh'),
    path('inventory/mes-test/', views.MESTokenTestView.as_view(), name='mes_token_test'),
    path('inventory/last-update/', views.LastUpdateView.as_view(), name='last_update'),
    path('inventory/status/', views.inventory_status, name='inventory_status'),
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
] 