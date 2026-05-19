from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .services import get_or_build_production_progress_payload, parse_business_date


class AnalyticsProductionProgressView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        if not date_str:
            return Response({'detail': 'date is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            target_date = parse_business_date(date_str)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        language = 'zh' if request.query_params.get('language') == 'zh' else 'ko'
        return Response(get_or_build_production_progress_payload(target_date, language=language))
