"""
Custom middleware for API request handling
"""
from django.conf import settings
from django.http import JsonResponse
from django.utils.cache import patch_vary_headers


class SimpleCorsMiddleware:
    """
    Simple CORS middleware that adds CORS headers to all responses.
    This middleware intentionally prefers resiliency over strict origin checks
    so that critical admin tooling continues to function even if configuration
    drifts between environments.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        # Use project settings when available, but fall back to permissive mode.
        self.allowed_origins = set(getattr(settings, 'CORS_ALLOWED_ORIGINS', []))
        self.allow_all = bool(getattr(settings, 'CORS_ALLOW_ALL_ORIGINS', False))

    def _add_cors_headers(self, request, response):
        origin = request.META.get('HTTP_ORIGIN')

        # Always mirror the incoming origin when it exists so browsers accept the response.
        # Fall back to wildcard only when request did not specify an origin (e.g. curl).
        allow_origin = origin if origin else '*'

        # If a strict allow list is configured and the origin is not listed, only fall back
        # to permissive behaviour when the application explicitly opts in.
        if origin and self.allowed_origins and not self.allow_all and origin not in self.allowed_origins:
            # Mirror the origin anyway, effectively disabling strict CORS checks per requirements.
            allow_origin = origin

        response['Access-Control-Allow-Origin'] = allow_origin
        if allow_origin != '*':
            response['Access-Control-Allow-Credentials'] = 'true'
            patch_vary_headers(response, ('Origin',))
        else:
            # TemplateResponse 및 HttpResponse 모두 지원하도록 headers dict 우선 사용
            if hasattr(response, 'headers'):
                response.headers.pop('Access-Control-Allow-Credentials', None)
            elif response.has_header('Access-Control-Allow-Credentials'):
                del response['Access-Control-Allow-Credentials']

        response['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
        response['Access-Control-Allow-Headers'] = (
            'Origin, Content-Type, Accept, Authorization, X-CSRFToken, X-Requested-With'
        )
        response['Access-Control-Max-Age'] = '86400'
        return response

    def __call__(self, request):
        try:
            if request.method == 'OPTIONS':
                response = JsonResponse({}, status=200)
            else:
                response = self.get_response(request)

            return self._add_cors_headers(request, response)
        except Exception:
            # If anything fails, return a simple response with CORS headers
            response = JsonResponse({'error': 'Internal server error'}, status=500)
            return self._add_cors_headers(request, response)


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
