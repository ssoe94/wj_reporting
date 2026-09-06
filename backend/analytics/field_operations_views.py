from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .field_operations import build_field_operations, parse_field_business_date


class AnalyticsFieldOperationsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        try:
            target_date = parse_field_business_date(request.query_params.get("date"))
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        response = Response(build_field_operations(target_date))
        response["Cache-Control"] = "no-store"
        return response
