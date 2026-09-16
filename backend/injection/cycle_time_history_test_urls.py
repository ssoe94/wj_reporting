"""Minimal URL set for isolated C/T tests; no project settings or external services."""
from django.urls import path
from .cycle_time_history_views import CycleTimeHistoryView, BoardPartCycleTimeSummaryView

urlpatterns = [path('api/injection/board-part-cycle-time/', BoardPartCycleTimeSummaryView.as_view(), name='board-part-cycle-time'), path('api/injection/cycle-time-history/', CycleTimeHistoryView.as_view())]
