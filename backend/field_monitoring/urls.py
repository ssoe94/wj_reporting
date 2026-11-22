from django.urls import path

from .device_views import ArchiveIngestView, HeartbeatView, IngestView
from .issuer_views import IssuerAssignmentsView, IssuerPolicyView, IssuerReleaseView, IssuerStopView
from .production_context import ProductionContextView
from .read_views import EventsCsvView, EventsView, ExceptionsView, OverviewView
from .station_views import IssueTokenView, RevokeTokenView, StationsView, StationView


urlpatterns = [
    path('ingest/', IngestView.as_view(), name='field-ingest'),
    path('archive-ingest/', ArchiveIngestView.as_view(), name='field-archive-ingest'),
    path('heartbeat/', HeartbeatView.as_view(), name='field-heartbeat'),
    path('production-context/', ProductionContextView.as_view(), name='field-production-context'),
    path('overview/', OverviewView.as_view(), name='field-overview'),
    path('exceptions/', ExceptionsView.as_view(), name='field-exceptions'),
    path('events/', EventsView.as_view(), name='field-events'),
    path('events.csv', EventsCsvView.as_view(), name='field-events-csv'),
    path('issuer-assignments/', IssuerAssignmentsView.as_view(), name='field-issuer-assignments'),
    path('issuer-assignments/<int:assignment_id>/stop/', IssuerStopView.as_view(), name='field-issuer-stop'),
    path('issuer-assignments/<int:assignment_id>/release/', IssuerReleaseView.as_view(), name='field-issuer-release'),
    path('stations/<slug:station_id>/issuer-policy/', IssuerPolicyView.as_view(), name='field-issuer-policy'),
    path('stations/', StationsView.as_view(), name='field-stations'),
    path('stations/<slug:station_id>/', StationView.as_view(), name='field-station'),
    path('stations/<slug:station_id>/issue-token/', IssueTokenView.as_view(), name='field-issue-token'),
    path('stations/<slug:station_id>/revoke-token/', RevokeTokenView.as_view(), name='field-revoke-token'),
]
