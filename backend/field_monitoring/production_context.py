"""Read the current WJ injection part for the station identified by its token."""

from django.utils import timezone
from rest_framework.response import Response

from injection.cycle_time_history import business_date_at
from production.ai_retrievers import INJECTION_PLAN_METADATA_FIELDS, get_injection_summary

from .base import FieldAPIView
from .contract import CONTRACT, ContractError
from .device_views import _device_identity


SOURCE = 'injection_plan_mes_shots'


def _shared_plan_value(group, name):
    values = {(part['plan_metadata'][name] or '').strip() for part in group}
    if len(values) == 1:
        value = values.pop()
        if value not in ('', '-'):
            return value
    return None


def _current_part(business_date, machine_number, now):
    summary = get_injection_summary(
        business_date, machine_numbers=[machine_number], scope_capacity_to_machines=True,
        include_plan_metadata=True,
    )
    rows = summary['machine_rows']
    if not rows:
        return None, 'no_verified_current_run'
    if len(rows) != 1:
        return None, 'ambiguous_current_part'

    row = rows[0]
    latest = row['latest_capacity_time']
    if not row['capacity_data_available'] or latest is None or latest > now:
        return None, 'machine_data_unavailable'
    if row['transition']['phase'] == 'changeover' or not row['is_running']:
        return None, 'no_verified_current_run'

    # Use the allocation's actual transition group. An earlier partially
    # completed group may still be marked in_progress after a changeover.
    current_id = row['transition']['current_plan_id']
    parts = row['parts']
    current = next((part for part in parts if part['plan_id'] == current_id), None)
    if current is None or current['allocated_shots'] <= 0:
        return None, 'no_verified_current_run'
    group = [part for part in parts if part['production_group_id'] == current['production_group_id']]
    part_numbers = {part['part_no'] for part in group}
    if (not current['production_group_complete'] or len(part_numbers) != 1
            or part_numbers.intersection({'', '-'})):
        return None, 'ambiguous_current_part'
    return {
        'part_no': part_numbers.pop(),
        **{name: _shared_plan_value(group, name) for name in INJECTION_PLAN_METADATA_FIELDS},
    }, None


class ProductionContextView(FieldAPIView):
    authentication_classes = ()
    permission_classes = ()
    parser_classes = ()

    def get(self, request):
        try:
            station = _device_identity(request).station
            if request.query_params:
                raise ContractError('unexpected_query', 400)
            now = timezone.now()
            business_date = business_date_at(now)
            current, reason = (None, 'station_unmapped')
            if station.injection_machine_number is not None:
                current, reason = _current_part(business_date, station.injection_machine_number, now)
            fields = current or dict.fromkeys(('part_no', *INJECTION_PLAN_METADATA_FIELDS))
            return Response({
                'contract': CONTRACT,
                'station_id': station.station_id,
                'status': 'current' if current else 'unavailable',
                **fields,
                'source': SOURCE if current else None,
                'business_date': business_date.isoformat(),
                'reason': reason,
            })
        except ContractError as exc:
            headers = {'WWW-Authenticate': 'WJField'} if exc.status == 401 else None
            return Response({'code': exc.code}, status=exc.status, headers=headers)
