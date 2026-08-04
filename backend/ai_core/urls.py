from django.urls import path

from .views import (
    AiJobCancelView,
    AiJobDetailView,
    AiJobLatestView,
    AiJobListCreateView,
    AiWorkerClaimView,
    AiWorkerHeartbeatView,
    AiWorkerJobTransitionView,
    AiWorkerPeriodicEnqueueView,
    AiWorkerStatusView,
)


urlpatterns = [
    path('jobs/', AiJobListCreateView.as_view(), name='ai-job-list-create'),
    path('jobs/latest/', AiJobLatestView.as_view(), name='ai-job-latest'),
    path('jobs/<int:pk>/', AiJobDetailView.as_view(), name='ai-job-detail'),
    path('jobs/<int:pk>/cancel/', AiJobCancelView.as_view(), name='ai-job-cancel'),
    path('jobs/claim/', AiWorkerClaimView.as_view(), name='ai-worker-job-claim'),
    path('jobs/enqueue-periodic/', AiWorkerPeriodicEnqueueView.as_view(), name='ai-worker-periodic-enqueue'),
    path('worker/heartbeat/', AiWorkerHeartbeatView.as_view(), name='ai-worker-heartbeat'),
    path('worker/status/', AiWorkerStatusView.as_view(), name='ai-worker-status'),
    path(
        'jobs/<int:pk>/start/',
        AiWorkerJobTransitionView.as_view(transition='start'),
        name='ai-worker-job-start',
    ),
    path(
        'jobs/<int:pk>/complete/',
        AiWorkerJobTransitionView.as_view(transition='complete'),
        name='ai-worker-job-complete',
    ),
    path(
        'jobs/<int:pk>/fail/',
        AiWorkerJobTransitionView.as_view(transition='fail'),
        name='ai-worker-job-fail',
    ),
]
