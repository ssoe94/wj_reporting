"""Admin-managed station defaults and the station's own plan catalog."""

from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response

from injection.cycle_time_history import business_date_at
from production.ai_retrievers import INJECTION_PLAN_METADATA_FIELDS, parse_machine_number
from production.models import ProductionPlan

from .base import FieldAPIView
from .contract import CONTRACT, ContractError
from .device_views import _device_identity
from .production_context import station_assembly_parts


PRESETS = {
    'barcode': ('barcode',), 'vision': ('vision',), 'vision_barcode': ('vision', 'barcode'),
    'weigh': ('weigh',), 'vision_weigh': ('vision', 'weigh'), 'custom': (),
}
MODULES = ('barcode', 'vision', 'weigh', 'companion')
CATALOG_LIMIT = 200


class WorkstationInput(serializers.Serializer):
    preset = serializers.ChoiceField(choices=PRESETS)
    modules = serializers.ListField(child=serializers.ChoiceField(choices=MODULES),
                                    allow_empty=False, max_length=len(MODULES))
    language = serializers.ChoiceField(choices=('ko', 'zh'))

    def to_internal_value(self, data):
        # A PATCH of the station replaces this bounded value as one unit.
        if not isinstance(data, dict) or set(data) != set(self.fields):
            raise serializers.ValidationError('Provide preset, modules and language.')
        return super().to_internal_value(data)

    def validate(self, values):
        modules = set(values['modules'])
        required = set(PRESETS[values['preset']])
        extras = {'companion'} if 'vision' in required else set()
        if (len(modules) != len(values['modules']) or not required <= modules
                or (values['preset'] != 'custom' and modules - required - extras)):
            raise serializers.ValidationError('Modules must match the preset.')
        return {**values, 'modules': [name for name in MODULES if name in modules]}


def planned_products(day, station):
    if station.production_process == 'assembly' and station.assembly_line is not None:
        return station_assembly_parts(day, station.assembly_line)[:CATALOG_LIMIT]
    machine = station.injection_machine_number
    if machine is None:
        return []
    plans = ProductionPlan.objects.filter(plan_date=day, plan_type='injection', planned_quantity__gt=0)
    rows = plans.values_list('machine_name', 'part_no', *INJECTION_PLAN_METADATA_FIELDS).order_by('sequence', 'pk')
    products = {}
    for machine_name, part_no, *metadata in rows.iterator(chunk_size=128):
        if parse_machine_number(machine_name) != machine:
            continue
        code = (part_no or '').strip().upper()
        if not code or code == '-':
            continue
        values = {name: value.strip() if value and value.strip() not in ('', '-') else None
                  for name, value in zip(INJECTION_PLAN_METADATA_FIELDS, metadata)}
        if code in products:
            prior = products[code]
            for name, value in values.items():
                if prior[name] != value:
                    prior[name] = None
        elif len(products) < CATALOG_LIMIT:
            products[code] = {'part_no': code, **values}
    return list(products.values())


class WorkstationConfigView(FieldAPIView):
    authentication_classes = ()
    permission_classes = ()
    parser_classes = ()

    def get(self, request):
        try:
            station = _device_identity(request).station
            if request.query_params:
                raise ContractError('unexpected_query', 400)
            day = business_date_at(timezone.now())
            return Response({
                'contract': CONTRACT, 'station_id': station.station_id,
                'config': {
                    'display_name': station.display_name,
                    'production_process': station.production_process,
                    'injection_machine_number': station.injection_machine_number,
                    'assembly_line': station.assembly_line,
                    **(station.workstation or {'preset': None, 'modules': [], 'language': None}),
                },
                'catalog': {'business_date': day.isoformat(),
                            'parts': planned_products(day, station)},
            })
        except ContractError as exc:
            headers = {'WWW-Authenticate': 'WJField'} if exc.status == 401 else None
            return Response({'code': exc.code}, status=exc.status, headers=headers)
