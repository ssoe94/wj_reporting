"""Authenticated, read-only access to preserved C/T evidence."""
from datetime import date, timedelta
import re

from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .cycle_time_history import MAX_RANGE_DAYS, business_date_at, read_cycle_time_history
from .permissions import InjectionPermission


class CycleTimeHistoryView(APIView):
    permission_classes = [IsAuthenticated, InjectionPermission]

    def get(self, request):
        if not request.user.is_active:
            self.permission_denied(request)
        today = business_date_at(timezone.now())
        for name in ('start_date', 'end_date'):
            raw = request.query_params.get(name)
            if raw is not None and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', raw):
                raise ValidationError({'date': 'Use YYYY-MM-DD business dates.'})
        try:
            end = date.fromisoformat(request.query_params.get('end_date', today.isoformat()))
            start = date.fromisoformat(request.query_params.get('start_date', (end - timedelta(days=6)).isoformat()))
        except (TypeError, ValueError):
            raise ValidationError({'date': 'Use YYYY-MM-DD business dates.'})
        if start > end or (end - start).days >= MAX_RANGE_DAYS:
            raise ValidationError({'date': 'Choose an inclusive range of 1 to 366 business dates.'})
        if end > today:
            raise ValidationError({'end_date': 'Future business dates are unavailable.'})
        machine = request.query_params.get('machine_number')
        if machine is not None:
            try:
                machine = int(machine)
            except (TypeError, ValueError):
                raise ValidationError({'machine_number': 'Use a machine number from 1 to 17.'})
            if not 1 <= machine <= 17:
                raise ValidationError({'machine_number': 'Use a machine number from 1 to 17.'})
        part_no = request.query_params.get('part_no')
        if part_no is not None and (not part_no.strip() or len(part_no.strip()) > 100):
            raise ValidationError({'part_no': 'Use a full Part No. of 1 to 100 characters.'})
        return Response(read_cycle_time_history(start, end, machine=machine, part_no=part_no))
