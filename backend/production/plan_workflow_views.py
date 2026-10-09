from datetime import date, timedelta
from uuid import UUID
from collections.abc import Mapping
from django.db import transaction
from django.db.models import Prefetch
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ProductionPlan, PlanMesRequest, PlanMesRequestEvent, PlanMaterialDefault
from .permissions import user_can_edit_plan, user_can_view_plan
from .plan_workflow import (lock_type, serialize_row, material_catalog, approve_materials,
                            resolve_identity, preview, prepare, text, WorkflowConflict)
from .plan_workflow import digest
from .plan_workflow_read_context import PlanWorkflowReadContext
from .plan_service_transport import (writes_enabled, PlanMesServiceTransport, dispatch_service_batch,
                                    recheck_service_creation, READBACK_STATES)


def request_summary(row, current_keys):
    event = row.audit_events[0] if getattr(row, 'audit_events', []) else None
    evidence = event.evidence if event else {}
    latest = {key: evidence[key] for key in ('outcome', 'mes_id', 'blockers', 'verified_scope') if key in evidence}
    return {'uid': str(row.uid), 'work_order_code': row.work_order.code,
        'operation': row.operation, 'state': row.state, 'blockers': row.blockers,
        'intent': row.intent, 'contract': row.contract, 'attempt': row.attempt,
        'mes_id': row.work_order.mes_id or evidence.get('mes_id', ''), 'last_result': latest,
        'can_send': (row.operation == 'create' and row.state in ('disabled', 'prepared', 'failed')
            and row.attempt == 0 and not row.blockers and not row.work_order.mes_id
            and row.contract.get('authentication') == 'service_app'
            and current_keys.get(row.work_order.code) == digest(row.intent)),
        'can_recheck': row.operation == 'create' and row.state in READBACK_STATES}


def selected_request(uid, start, end, plan_type):
    try:
        if type(uid) is not str:
            raise ValueError()
        uid = str(UUID(uid))
        req = PlanMesRequest.objects.select_related('work_order').get(uid=uid, work_order__plan_type=plan_type)
        first = date.fromisoformat(req.intent['planned_start'][:10])
        last = date.fromisoformat(req.intent['planned_end'][:10]) - timedelta(days=1)
        if first > end or last < start:
            raise ValueError()
        return req
    except (ValueError, TypeError, KeyError, PlanMesRequest.DoesNotExist):
        raise WorkflowConflict('Request is outside the selected plan scope.') from None


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
        groups = preview(start, end, plan_type, context)
        current_keys = {group['work_order_code']: group['key'] for group in groups
            if group['work_order_code'] and not group['blockers']}
        return Response({'write_enabled': writes_enabled(), 'rows': [serialize_row(row, context) for row in context.rows],
            'catalog': material_catalog(), 'preview': groups,
            'can_edit': request.user.is_active and user_can_edit_plan(request.user, plan_type),
            'can_manage_defaults': request.user.is_active and request.user.is_superuser,
            'requests': [request_summary(row, current_keys)
                for row in PlanMesRequest.objects.filter(work_order__plan_type=plan_type).select_related('work_order')
                    .prefetch_related(Prefetch('events', queryset=PlanMesRequestEvent.objects.order_by('-id'),
                        to_attr='audit_events')).order_by('-created_at')[:100]]})

    def post(self, request):
        start, end, plan_type = scope(request.data)
        if not request.user.is_active or not user_can_edit_plan(request.user, plan_type): raise PermissionDenied()
        action = request.data.get('action')
        if action == 'prepare':
            return Response({'write_enabled': writes_enabled(), 'results': prepare(start, end, plan_type,
                request.data.get('keys'), request.user)})
        if action == 'send':
            if set(request.data) - {'start', 'end', 'plan_type', 'action', 'request_uids'}:
                raise ValidationError('Unexpected send fields.')
            if not writes_enabled():
                return Response({'detail': 'mes_plan_writes_disabled', 'write_enabled': False}, status=409)
            def factory(uid):
                selected_request(uid, start, end, plan_type)
                return PlanMesServiceTransport(actor_id=request.user.pk)
            return Response({'write_enabled': True,
                'results': dispatch_service_batch(request.data.get('request_uids'), factory)})
        if action == 'recheck':
            if set(request.data) - {'start', 'end', 'plan_type', 'action', 'request_uid'}:
                raise ValidationError('Unexpected recheck fields.')
            req = selected_request(request.data.get('request_uid'), start, end, plan_type)
            return Response(recheck_service_creation(req.uid, PlanMesServiceTransport(actor_id=request.user.pk)))
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
