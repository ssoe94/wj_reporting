import re
from datetime import date

from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .mes_task_reconciliation import business_date_at
from .mes_task_reconciliation_service import build_reconciliation
from .permissions import user_can_view_plan


class MesTaskReconciliationView(APIView):
    permission_classes = [IsAuthenticated]
    http_method_names = ['get', 'head', 'options']

    def get(self, request):
        if not request.user.is_active or not user_can_view_plan(request.user, 'injection'):
            return Response({'detail': 'Permission denied.'}, status=403)
        raw_date = request.query_params.get('business_date')
        try:
            if raw_date is not None and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', raw_date):
                raise ValueError
            business_date = date.fromisoformat(raw_date) if raw_date is not None else business_date_at(timezone.now())
            if business_date == date.max:
                raise ValueError
        except ValueError:
            return Response({'detail': 'Invalid business_date. Use YYYY-MM-DD.'}, status=400)
        response = Response(build_reconciliation(business_date))
        response['Cache-Control'] = 'no-store'
        return response
