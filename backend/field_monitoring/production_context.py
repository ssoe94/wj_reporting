"""Read the station's verified injection group or daily assembly line plan."""

from django.utils import timezone
from rest_framework.response import Response

from injection.cycle_time_history import business_date_at
from production.ai_retrievers import INJECTION_PLAN_METADATA_FIELDS, get_injection_summary
from production.mes_progress import normalize_equipment_key, normalize_part_no
from production.models import ProductionPlan

from .base import FieldAPIView
from .contract import CONTRACT, ContractError
from .device_views import _device_identity


SOURCE = 'injection_plan_mes_shots'
ASSEMBLY_SOURCE = 'assembly_line_plan'


def _shared_plan_value(group, name):
    values = {(part[name] or '').strip() for part in group}
    if len(values) == 1:
        value = values.pop()
        if value not in ('', '-'):
            return value
    return None


def plan_parts(rows):
    by_number = {}
    for number, metadata in rows:
        if number and number != '-':
            by_number.setdefault(number, []).append(metadata)
    return [
        {'part_no': number, **{name: _shared_plan_value(group, name) for name in INJECTION_PLAN_METADATA_FIELDS}}
        for number, group in sorted(by_number.items())
    ]


def station_assembly_parts(day, line):
    plans = ProductionPlan.objects.filter(plan_date=day, plan_type='machining', planned_quantity__gt=0)
    rows = plans.values_list('machine_name', 'part_no', *INJECTION_PLAN_METADATA_FIELDS).order_by('pk')
    return plan_parts(
        (normalize_part_no(number), dict(zip(INJECTION_PLAN_METADATA_FIELDS, metadata)))
        for machine, number, *metadata in rows
        if normalize_equipment_key('machining', machine) == line
    )


def _current_group(business_date, machine_number, now):
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
    parts_per_shot = max(part['parts_per_shot'] or 1 for part in group)
    part_numbers = sorted({part['part_no'] for part in group})
    if (not current['production_group_complete'] or len(part_numbers) != parts_per_shot
            or any(part in ('', '-') for part in part_numbers)):
        return None, 'ambiguous_current_part'
    return plan_parts((part['part_no'], part['plan_metadata']) for part in group), None


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
            parts, source, reason = [], None, 'station_unmapped'
            if station.production_process == 'injection' and station.injection_machine_number is not None:
                parts, reason = _current_group(business_date, station.injection_machine_number, now)
                source = SOURCE if parts else None
            elif station.production_process == 'assembly' and station.assembly_line is not None:
                parts = station_assembly_parts(business_date, station.assembly_line)
                source, reason = (ASSEMBLY_SOURCE, None) if parts else (None, 'no_assembly_plan')
            parts = parts or []
            return Response({
                'contract': CONTRACT,
                'station_id': station.station_id,
                'production_process': station.production_process,
                'injection_machine_number': station.injection_machine_number,
                'assembly_line': station.assembly_line,
                'status': 'planned' if source == ASSEMBLY_SOURCE else 'current' if parts else 'unavailable',
                'parts': parts,
                'part_no': parts[0]['part_no'] if len(parts) == 1 else None,
                **{name: _shared_plan_value(parts, name) for name in INJECTION_PLAN_METADATA_FIELDS},
                'source': source,
                'business_date': business_date.isoformat(),
                'reason': reason,
            })
        except ContractError as exc:
            headers = {'WWW-Authenticate': 'WJField'} if exc.status == 401 else None
            return Response({'code': exc.code}, status=exc.status, headers=headers)
