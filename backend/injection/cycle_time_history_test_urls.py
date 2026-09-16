"""Minimal URL set for isolated C/T tests; no project settings or external services."""
from django.urls import path
from .cycle_time_history_views import CycleTimeHistoryView

urlpatterns = [path('api/injection/cycle-time-history/', CycleTimeHistoryView.as_view())]
