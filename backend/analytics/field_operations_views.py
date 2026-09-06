from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .field_operations import build_field_operations, parse_field_business_date, parse_field_machine_number


class AnalyticsFieldOperationsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        try:
            target_date = parse_field_business_date(request.query_params.get("date"))
            machine_number = parse_field_machine_number(request.query_params.get("machine_number"))
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        response = Response(build_field_operations(target_date, machine_number=machine_number))
        response["Cache-Control"] = "no-store"
        return response
