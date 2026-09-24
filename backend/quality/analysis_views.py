from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .analysis import build_quality_analysis, parse_analysis_filters
from .permissions import QualityReadPermission


class QualityAnalysisView(APIView):
    permission_classes = [IsAuthenticated, QualityReadPermission]

    def get(self, request):
        filters = parse_analysis_filters(request.query_params)
        if request.query_params.get("core_only") == "1":
            return Response(build_quality_analysis(filters))
        return Response(build_quality_analysis(filters, include_production_context=True, include_report=True))
