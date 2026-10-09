from datetime import date
from collections.abc import Mapping
from django.db import transaction
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ProductionPlan, PlanMesRequest, PlanMesRequestEvent, PlanMaterialDefault
from .permissions import user_can_edit_plan, user_can_view_plan
from .plan_workflow import (lock_type, serialize_row, material_catalog, approve_materials,
                            resolve_identity, preview, prepare, text, WorkflowConflict)
from .plan_workflow_read_context import PlanWorkflowReadContext


def scope(data):
    if not isinstance(data, Mapping): raise ValidationError('Expected an object.')
    plan_type = data.get('plan_type')
    try:
        start = date.fromisoformat(data.get('start', ''))
        end = date.fromisoformat(data.get('end', ''))
        if not 2000 <= start.year <= end.year <= 2100 or not 0 <= (end - start).days <= 31:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValidationError('Select a date range of at most 32 days.') from None
    if plan_type not in ('injection', 'machining'): raise ValidationError('Invalid plan type.')
    return start, end, plan_type


class PlanWorkflowView(APIView):
    permission_classes = [IsAuthenticated]
    http_method_names = ['get', 'post', 'options']

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        return response

    def get(self, request):
        start, end, plan_type = scope(request.query_params)
        if not user_can_view_plan(request.user, plan_type): raise PermissionDenied()
        context = PlanWorkflowReadContext(start, end, plan_type)
        return Response({'write_enabled': False, 'rows': [serialize_row(row, context) for row in context.rows],
            'catalog': material_catalog(), 'preview': preview(start, end, plan_type, context),
            'can_edit': request.user.is_active and user_can_edit_plan(request.user, plan_type),
            'can_manage_defaults': request.user.is_active and request.user.is_superuser,
            'requests': [{'uid': str(row.uid), 'work_order_code': row.work_order.code,
                'operation': row.operation, 'state': row.state, 'blockers': row.blockers,
                'intent': row.intent, 'contract': row.contract}
                for row in PlanMesRequest.objects.filter(work_order__plan_type=plan_type).select_related('work_order').order_by('-created_at')[:100]]})

    def post(self, request):
        start, end, plan_type = scope(request.data)
        if not request.user.is_active or not user_can_edit_plan(request.user, plan_type): raise PermissionDenied()
        action = request.data.get('action')
        if action == 'prepare':
            return Response({'write_enabled': False, 'results': prepare(start, end, plan_type,
                request.data.get('keys'), request.user)})
        if action == 'recheck':
            # Existing credential/authority rules still apply. No alternate token fallback.
            if not request.user.is_superuser: raise PermissionDenied()
            from mes_oauth.session_guard import InspectionSession
            from .mes_read_status import read_mes_production_status
            try:
                req = PlanMesRequest.objects.select_related('work_order').get(uid=request.data.get('request_uid'), work_order__plan_type=plan_type)
            except (ValueError, PlanMesRequest.DoesNotExist): raise ValidationError('Invalid request.') from None
            if req.state not in ('sending', 'uncertain', 'readback_pending', 'review'):
                raise WorkflowConflict('No unresolved transmission to recheck.')
            if req.operation == 'create' and req.contract.get('readback_binding'):
                from .plan_workflow_transport import recheck_creation_for_session
                return Response(recheck_creation_for_session(req.uid, InspectionSession.from_request(request)))
            observed = read_mes_production_status(InspectionSession.from_request(request),
                date.fromisoformat(req.intent['planned_start'][:10]), req.work_order.code)
            # Current four-read projection cannot prove BOM and campaign-wide qty.
            # Persist observation, keep replay fenced, never mark confirmed from HTTP 200.
            with transaction.atomic():
                lock_type(plan_type)
                req = PlanMesRequest.objects.select_for_update().get(pk=req.pk)
                if req.state not in ('sending', 'uncertain', 'readback_pending', 'review'): raise WorkflowConflict()
                PlanMesRequestEvent.objects.create(request=req, state=req.state,
                    evidence={'read_state': observed['state'], 'checked_scope': 'business_day_only',
                              'full_snapshot_verified': False})
            return Response({'state': req.state, 'observation': observed,
                             'blockers': ['campaign_bom_readback_adapter_required']})
        with transaction.atomic():
            lock_type(plan_type)
            if type(request.data.get('plan_id')) is not int: raise ValidationError('Invalid plan ID.')
            try:
                plan = ProductionPlan.objects.select_for_update().get(pk=request.data.get('plan_id'), plan_type=plan_type)
            except (ValueError, ProductionPlan.DoesNotExist): raise ValidationError('Invalid plan.') from None
            if not start <= plan.plan_date <= end: raise ValidationError('Plan is outside selected dates.')
            if action == 'resolve_identity':
                return Response(resolve_identity(plan, request.data, request.user))
            if action == 'approve':
                approval = approve_materials(plan, request.data, request.user)
                return Response({'approval_id': approval.pk, 'snapshot': approval.snapshot}, status=201)
            if action == 'save_default':
                # Separate explicit superuser operation; approval never updates defaults.
                if not request.user.is_superuser: raise PermissionDenied()
                if request.data.get('version') != plan.work_version: raise WorkflowConflict()
                from .models import PlanMaterialApproval
                approval = PlanMaterialApproval.objects.filter(revision__work_id=plan.work_uid,
                    revision__version=plan.work_version).order_by('-id').first()
                if not approval: raise ValidationError('Approve this version first.')
                latest = PlanMaterialDefault.objects.filter(plan_type=plan_type, part_no=plan.part_no).order_by('-version').first()
                expected = latest.version if latest else 0
                if request.data.get('default_version') != expected: raise WorkflowConflict()
                default = PlanMaterialDefault.objects.create(plan_type=plan_type, part_no=plan.part_no,
                    version=expected + 1, effective_from=plan.plan_date, snapshot=approval.snapshot,
                    actor=request.user, reason=text(request.data.get('reason'), 500))
                return Response({'version': default.version}, status=201)
        raise ValidationError('Unknown preparation action.')
