"""Code readiness only: no production records, MES requests or writes during GET."""
from django.contrib.auth import get_user_model
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from mes_oauth.pilot_scope import pilot_route_scope_required

from .mes_delivery import DELIVERY_STAGES, implementation_readiness


APPROVAL_GROUPS = (
    ('material_bom_routing_resource', ('material', 'bom', 'routing', 'resource')),
    ('quantity_unit_qc_plans', ('quantity', 'unit', 'first_qc_plan', 'periodic_qc_plan')),
    ('warehouse_location_effects', ('warehouse', 'location', 'inventory_effects')),
    ('actor_api_authority', ('actor', 'api_authority')),
)


class IsMesDeliverySuperuser(BasePermission):
    message = 'Production delivery readiness requires an active unrestricted superuser.'

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated or not user.pk:
            return False
        token = request.auth or {}
        # Keep the authentication boundary's sticky classification as well as
        # signed claims and current pilot configuration. Re-reading a user must
        # never turn an inspector-scoped session into a general admin session.
        if pilot_route_scope_required(user, token):
            return False
        fresh_user = get_user_model().objects.only('pk', 'is_active', 'is_superuser').filter(pk=user.pk).first()
        return bool(fresh_user and fresh_user.is_active and fresh_user.is_superuser
                    and not pilot_route_scope_required(fresh_user, token))


class MesDeliveryReadinessView(APIView):
    permission_classes = [IsAuthenticated, IsMesDeliverySuperuser]
    http_method_names = ['get', 'head', 'options']

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        response['Referrer-Policy'] = 'no-referrer'
        return response

    def get(self, request):
        readiness = implementation_readiness()
        return Response({
            'schema_version': 'production-mes-delivery-readiness/v1',
            'scope': 'code_readiness_only',
            'read_only': True,
            'contract_stages': list(DELIVERY_STAGES),
            'writers_implemented': readiness['writers_implemented'],
            'runtime_connected': readiness['runtime_connected'],
            # This metadata endpoint never grants a live production write.
            'live_writes_enabled': False,
            'reason': readiness['reason'],
            'production_flow_status': 'not_evaluated',
            'receipt_verification': 'not_evaluated',
            'missing_approval_groups': [
                {'id': group, 'status': 'approval_required', 'requirements': list(requirements)}
                for group, requirements in APPROVAL_GROUPS
            ],
        })
