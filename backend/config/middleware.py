"""
Custom middleware for API request handling
"""
from django.http import JsonResponse


class APINotFoundMiddleware:
    """
    Middleware to ensure /api/* paths that don't match any route
    return JSON 404 instead of HTML
    """
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        
        # If it's an API path and we got a 404, ensure it's JSON
        if request.path.startswith('/api/') and response.status_code == 404:
            # Check if response is already JSON
            content_type = response.get('Content-Type', '')
            if 'application/json' not in content_type:
                return JsonResponse({
                    'detail': 'Not found',
                    'path': request.path,
                    'method': request.method,
                }, status=404)
        
        return response


class NoCacheAPIMiddleware:
    """
    Middleware to add no-cache headers to all API responses
    """
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        
        # Add no-cache headers to API responses
        if request.path.startswith('/api/'):
            response['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
            response['Pragma'] = 'no-cache'
            response['Expires'] = '0'
        
        return response
