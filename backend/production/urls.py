from django.urls import path
from .views import (
    ProductionDashboardView,
    ProductionPlanDatesView,
    ProductionPlanSummaryView,
    ProductionStatusView,
    ProductionPartCavityView,
    DebugPlanView,
    ProductionPlanListView,
    ProductionPlanDetailView,
    ProductionPlanPartSearchView,
)

urlpatterns = [
    path('dashboard/', ProductionDashboardView.as_view(), name='production-dashboard'),
    path('plan-dates/', ProductionPlanDatesView.as_view(), name='production-plan-dates'),
    path('plan-summary/', ProductionPlanSummaryView.as_view(), name='production-plan-summary'),
    path('plans/', ProductionPlanListView.as_view(), name='production-plan-list'),
    path('plans/<int:pk>/', ProductionPlanDetailView.as_view(), name='production-plan-detail'),
    path('plan-parts/', ProductionPlanPartSearchView.as_view(), name='production-plan-part-search'),
    path('part-cavity/', ProductionPartCavityView.as_view(), name='production-part-cavity'),
    path('status/', ProductionStatusView.as_view(), name='production-status'),
    path('debug-plan/', DebugPlanView.as_view(), name='debug-plan'),
]
