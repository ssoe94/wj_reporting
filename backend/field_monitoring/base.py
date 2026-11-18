"""Keep field credentials, queries and event values out of exception responses."""

import logging

from rest_framework.response import Response
from rest_framework.views import APIView, exception_handler


logger = logging.getLogger(__name__)


def field_exception_handler(exc, context):
    response = exception_handler(exc, context)
    if response is not None:
        return response
    logger.error('Field monitoring request failed: %s', type(exc).__name__)
    return Response({'code': 'server_error'}, status=500)


class FieldAPIView(APIView):
    def get_exception_handler(self):
        return field_exception_handler

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'no-store'
        return response
