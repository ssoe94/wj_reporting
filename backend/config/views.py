"""
Health check and utility views
"""
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt


@csrf_exempt
@require_http_methods(["GET", "HEAD"])
def health_check(request):
    """
    Health check endpoint for Render and monitoring
    Returns 200 OK with status information
    """
    return JsonResponse({
        "status": "healthy",
        "service": "wj_reporting_backend",
    })
