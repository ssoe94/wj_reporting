from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .analysis import build_quality_analysis, parse_analysis_filters
from .permissions import QualityReadPermission


class QualityAnalysisView(APIView):
    permission_classes = [IsAuthenticated, QualityReadPermission]

    def get(self, request):
        return Response(build_quality_analysis(parse_analysis_filters(request.query_params)))
