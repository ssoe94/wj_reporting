from django.urls import path

from .views import (
    AiJobCancelView,
    AiJobDetailView,
    AiJobListCreateView,
    AiWorkerClaimView,
    AiWorkerJobTransitionView,
)


urlpatterns = [
    path('jobs/', AiJobListCreateView.as_view(), name='ai-job-list-create'),
    path('jobs/<int:pk>/', AiJobDetailView.as_view(), name='ai-job-detail'),
    path('jobs/<int:pk>/cancel/', AiJobCancelView.as_view(), name='ai-job-cancel'),
    path('jobs/claim/', AiWorkerClaimView.as_view(), name='ai-worker-job-claim'),
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
