"""User-selected MES state read; production/inbound actions stay in MES."""
from datetime import date

from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from mes_oauth.session_guard import InspectionSession
from .mes_delivery_views import IsMesDeliverySuperuser
from .mes_read_status import read_mes_production_status, status_response, valid_work_order_code


class MesProductionReadStatusView(APIView):
    permission_classes = [IsAuthenticated, IsMesDeliverySuperuser]
    http_method_names = ['get', 'head', 'options']

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        response['Referrer-Policy'] = 'no-referrer'
        return response

    def _query(self, request):
        query = request.query_params
        if (set(query) - {'business_date', 'work_order_code'}
                or any(len(query.getlist(key)) != 1 for key in query)):
            raise ValidationError('Select one date and one existing MES work order code.')
        value = query.get('business_date', '')
        try:
            selected_date = date.fromisoformat(value)
            if selected_date.isoformat() != value or not 2000 <= selected_date.year <= 2100:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValidationError('Use YYYY-MM-DD for the production business date.') from None
        code = query.get('work_order_code', '')
        if code and not valid_work_order_code(code):
            raise ValidationError('Use the exact existing MES work order code, up to 100 characters.')
        return selected_date, code

    def get(self, request):
        selected_date, code = self._query(request)
        if not code:
            return Response(status_response(selected_date, 'not_queried'))
        return Response(read_mes_production_status(InspectionSession.from_request(request), selected_date, code))

    def head(self, request):
        selected_date, _ = self._query(request)
        return Response(status_response(selected_date, 'not_queried'))
