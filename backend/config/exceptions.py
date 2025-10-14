"""
Custom exception handlers for DRF to ensure all API errors return JSON
"""
from rest_framework.views import exception_handler
from rest_framework.response import Response
from rest_framework import status
from django.http import Http404
from django.core.exceptions import PermissionDenied


def custom_exception_handler(exc, context):
    """
    Custom exception handler that ensures all API errors return JSON
    instead of HTML, even for 404 and 500 errors.
    """
    # Call REST framework's default exception handler first
    response = exception_handler(exc, context)
    
    # If DRF didn't handle it, create a JSON response
    if response is None:
        if isinstance(exc, Http404):
            data = {
                'detail': 'Not found',
                'path': context['request'].path,
                'method': context['request'].method,
            }
            response = Response(data, status=status.HTTP_404_NOT_FOUND)
        elif isinstance(exc, PermissionDenied):
            data = {
                'detail': 'Permission denied',
                'path': context['request'].path,
                'method': context['request'].method,
            }
            response = Response(data, status=status.HTTP_403_FORBIDDEN)
        else:
            # Generic server error
            data = {
                'detail': 'Internal server error',
                'error': str(exc),
                'path': context['request'].path,
                'method': context['request'].method,
            }
            response = Response(data, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
    
    # Add custom headers to prevent caching
    if response is not None:
        response['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response['Pragma'] = 'no-cache'
        response['Expires'] = '0'
    
    return response
