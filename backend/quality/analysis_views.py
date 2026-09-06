from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .analysis import build_quality_analysis, parse_analysis_filters
from .activity_calendar import build_activity_calendar
from .production_shifts import build_production_shifts
from .permissions import QualityReadPermission


class QualityAnalysisView(APIView):
    permission_classes = [IsAuthenticated, QualityReadPermission]

    def get(self, request):
        filters = parse_analysis_filters(request.query_params)
        result = build_quality_analysis(filters, include_production_context=True)
        result["activity_calendar"] = build_activity_calendar(result, filters)
        result["production_shifts"] = build_production_shifts(filters)
        return Response(result)
