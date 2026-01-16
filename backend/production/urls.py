from django.urls import path
from .views import ProductionDashboardView, ProductionPlanDatesView, ProductionPlanSummaryView, ProductionStatusView, DebugPlanView

urlpatterns = [
    path('dashboard/', ProductionDashboardView.as_view(), name='production-dashboard'),
    path('plan-dates/', ProductionPlanDatesView.as_view(), name='production-plan-dates'),
    path('plan-summary/', ProductionPlanSummaryView.as_view(), name='production-plan-summary'),
    path('status/', ProductionStatusView.as_view(), name='production-status'),
    path('debug-plan/', DebugPlanView.as_view(), name='debug-plan'),
]
