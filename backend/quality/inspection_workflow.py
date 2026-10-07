"""Transactional local workflow and a conservative external-operation outbox."""
import uuid
from decimal import Decimal

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

from . import inspection_adapter
from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest, InspectionNonconformance
from .inspection_validation import digest, quantity, validate_result
from .inspection_access import (can_access_inspections, can_access_request,
                                can_use_admin_inspection_flow, require_owned_request)


class InspectionConflict(APIException):
    status_code = 409
    default_code = 'inspection_conflict'

    def __init__(self, code, detail):
        super().__init__({'code': code, 'detail': detail})


def can_access_beta(user):
    return can_access_inspections(user)


def capabilities(user):
    can_view = can_access_beta(user)
    can_edit = can_view
    admin = can_use_admin_inspection_flow(user)
    result = {'can_view': can_view,
              'access_scope': 'all' if can_view and admin else 'assigned_only',
              'can_view_kanban': bool(can_view and admin),
              'data_mode': 'synthetic_preview' if getattr(settings, 'INSPECTION_SYNTHETIC_PREVIEW', False) else 'wj_local_beta'}
    for action in ('manage', 'submit', 'review'):
        result['can_' + action] = (can_edit and (action != 'review' or admin)
                                   and user.has_perm('quality.' + action + '_inspectionrequest'))
    result['can_prepare_integration_trial'] = bool(result['can_manage'] and user.is_superuser)
    result['can_manage_role_settings'] = bool(result['can_manage'] and admin)
    result['mes'] = inspection_adapter.get_inspection_adapter().capabilities()
    return result


def require(user, permission):
    if not capabilities(user).get('can_' + permission):
        raise PermissionDenied('Explicit inspection authority and active quality access are required.')


def reinspection_allowed(request):
    if request.source_kind == 'integration_test':
        return False
    eligible = request.status in {'failed', 'rejected'} or (
        request.status == 'approved' and request.judgement == 'fail'
        and request.reviewed_by_id and request.reviewed_by_id != request.submitted_by_id)
    if not eligible or hasattr(request, 'reinspection') or request.sync_status in {'pending', 'unknown'}:
        return False
    # Parent evidence remains immutable; an uncertain external action must be
    # reconciled before starting another inspection in the same lineage.
    if request.operations.filter(
            Q(status='pending', scope__regex=r':(sync|mes-save|mes-finish|mes-reconcile)$')
            | Q(status='unknown', scope__regex=r':(sync|mes-save|mes-finish)$')).exists():
        return False
    from .inspection_models import InspectionMesBinding
    return not InspectionMesBinding.objects.filter(request=request,
        phase__in=['save_pending', 'save_unknown', 'finish_pending', 'finish_unknown', 'blocked']).exists()


def request_capabilities(request, user):
    caps = capabilities(user)
    owner = request.assigned_to_id == user.pk
    final = request.status == 'approved'
    uncertain = request.sync_status in {'pending', 'unknown'}
    enabled = caps['mes']['enabled']
    accessible = can_access_request(user, request)
    result = {
        'can_edit': caps['can_manage'] and owner and request.status == 'draft',
        'can_submit': caps['can_submit'] and owner and request.status == 'draft',
        'can_review_failure': caps['can_review'] and request.status == 'failed' and request.submitted_by_id != user.pk,
        'can_review': caps['can_review'] and request.status == 'submitted' and request.submitted_by_id != user.pk,
        'can_reinspect': caps['can_manage'] and accessible and reinspection_allowed(request),
        'can_refresh': caps['can_view'] and accessible and enabled and request.source_kind != 'integration_test',
        'can_sync': (caps['can_submit'] and can_use_admin_inspection_flow(user)
                     and accessible and enabled and final and not uncertain and request.source_kind != 'integration_test'),
    }
    from .inspection_roles import role_summary
    roles = role_summary(request, user)
    if roles is not None:
        # Each area has its own writer and revision; a whole-request draft must
        # never replace the other inspector's measurements or derived verdict.
        result.update(can_edit=False, can_refresh=False, can_sync=False,
                      can_submit=bool(caps['can_submit'] and owner and request.status == 'draft'
                                      and roles.get('can_submit', False)))
        if any(area.get('completed_by') == user.pk for area in roles['areas']):
            result.update(can_review=False, can_review_failure=False)
    return result


def result_payload(request):
    return {'work_order_ref': request.work_order_ref, 'task_ref': request.task_ref, 'part_no': request.part_no,
            'equipment_ref': request.equipment_ref, 'lot_ref': request.lot_ref, 'uom': request.uom,
            'warehouse_ref': request.warehouse_ref, 'inspection_type': request.inspection_type,
            'inspection_items': request.inspection_items, 'measurements': request.measurements,
            'require_evidence': request.require_evidence, 'quantity_mode': request.quantity_mode, 'judgement_policy': request.judgement_policy,
            'evidence': request.evidence, 'inspected_quantity': str(request.inspected_quantity),
            'accepted_quantity': str(request.accepted_quantity), 'rejected_quantity': str(request.rejected_quantity),
            'judgement': request.judgement}


def serialize(request, user, *, detail=True):
    scalar = ['id', 'source_kind', 'work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'inspection_type',
              'uom', 'warehouse_ref', 'lot_ref', 'inspection_items', 'require_evidence', 'quantity_mode', 'judgement_policy', 'assigned_to_name', 'status', 'version',
              'measurements', 'evidence', 'judgement', 'notes', 'review_reason', 'sync_status', 'mes_completion_status', 'injection_receipt_readiness',
              'external_result_id', 'last_error_code']
    data = {field: getattr(request, field) for field in scalar}
    for field in ('target_quantity', 'inspected_quantity', 'accepted_quantity', 'rejected_quantity'):
        data[field] = str(getattr(request, field))
    for field in ('work_started_at', 'submitted_at', 'reviewed_at', 'mes_checked_at', 'created_at', 'updated_at'):
        value = getattr(request, field)
        data[field] = value.isoformat() if value else None
    data.update(parent=request.parent_id, assigned_to=request.assigned_to_id,
                submitted_by=request.submitted_by_id, reviewed_by=request.reviewed_by_id,
                capabilities=request_capabilities(request, user))
    from .inspection_roles import role_summary
    data['role_workflow'] = role_summary(request, user)
    # Only the normalized contract projection, never raw MES responses or transport errors.
    from .inspection_mes_stages import stage_summary
    data['mes_workflow'] = stage_summary(request, user)
    case = InspectionNonconformance.objects.filter(request=request).first()
    data['nonconformance'] = ({'state': case.state, 'quantity': str(case.quantity) if case.quantity is not None else None,
        'uom': case.uom, 'owner_name': case.owner_name, 'mes_status': case.mes_status, 'can_execute': False}
        if case else None)
    data['mes_state'] = {key: request.mes_snapshot.get(key) for key in ('task_status', 'qc_status', 'state_version', 'receipt_allowed')}
    if detail:
        data['mes_trial_observation'] = None
        binding = getattr(request, 'mes_binding', None)
        if request.source_kind == 'integration_test' or (binding and binding.test_only is True):
            # Reuse the board's identity, digest, time and lifecycle validation.
            # A trial verdict never becomes a production quality-status code.
            from .inspection_kanban import _trial_projection
            trial = _trial_projection(request, now=timezone.now())
            data['mes_trial_observation'] = {
                'verdict': trial['trial_verdict'], 'observed_at': trial['observed_at'],
            }
        data['audit'] = [{key: getattr(row, key) for key in ('id', 'actor_name', 'action', 'version', 'status', 'reason', 'result_digest')}
                         | {'created_at': row.created_at.isoformat()} for row in request.audit.all()]
        data['operations'] = [{'id': row.id, 'scope': row.scope, 'key': str(row.key), 'status': row.status,
                               'response_status': row.response_status, 'created_at': row.created_at.isoformat(),
                               'completed_at': row.completed_at.isoformat() if row.completed_at else None}
                              for row in request.operations.order_by('-id')[:20]]
    return data


def lock_scope(scope):
    # Serialize idempotency registration and request creation on PostgreSQL.
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [int(digest(scope)[:15], 16)])


def operation_key(value):
    try:
        key = uuid.UUID(str(value))
        if key.version != 4:
            raise ValueError()
        return key
    except (ValueError, TypeError, AttributeError):
        raise ValidationError({'idempotency_key': 'Idempotency-Key must be a UUID v4.'})


def existing_operation(scope, key, payload):
    operation = InspectionOperation.objects.filter(scope=scope, key=key).first()
    if operation and operation.payload_digest != digest(payload):
        raise InspectionConflict('idempotency_payload_mismatch', 'Use the original payload for this key.')
    return operation


def replay(operation, user=None):
    if user is None:
        raise PermissionDenied('An authenticated actor is required to replay this operation.')
    if not can_use_admin_inspection_flow(user):
        # Reinspection operations belong to a parent but return a child. Other
        # responses may nest the request. Check every returned object against
        # current assignments, never the cached response's old owner fields.
        targets = {operation.request_id} if operation.request_id else set()
        response = operation.response if isinstance(operation.response, dict) else {}
        nested = response.get('request')
        for value in (response.get('id'), nested.get('id') if isinstance(nested, dict) else None):
            if value is not None:
                if type(value) is not int or value < 1:
                    raise PermissionDenied('The replay target could not be verified.')
                targets.add(value)
        rows = list(InspectionRequest.objects.filter(pk__in=targets).only('assigned_to_id'))
        if not targets or len(rows) != len(targets):
            raise PermissionDenied('The replay target is no longer available.')
        for row in rows:
            require_owned_request(user, row)
    if operation.status == 'pending':
        data = {'code': 'operation_pending', 'detail': 'Operation is pending; refresh and reconcile before retry.',
                'operation_id': operation.id}
        if user is not None and operation.request_id:
            data['request'] = serialize(operation.request, user)
        return data, 202
    return operation.response, operation.response_status


def audit(request, user, action, reason=''):
    InspectionAudit.objects.create(request=request, actor=user, actor_name=user.get_username(), action=action,
                                   version=request.version, status=request.status, reason=reason,
                                   result_digest=digest(result_payload(request)))


def finish_operation(operation, response, status=200, state='succeeded'):
    operation.status = state
    operation.response_status = status
    operation.response = response
    operation.completed_at = timezone.now()
    request_data = response.get('request', response)
    for row in request_data.get('operations', []):
        if row['id'] == operation.id:
            row.update(status=state, response_status=status, completed_at=operation.completed_at.isoformat())
    operation.save(update_fields=['status', 'response_status', 'response', 'completed_at', 'request'])
    return response, status


def check_version(request, payload):
    if request.version != payload['version']:
        raise InspectionConflict('stale_version', 'The record changed. Keep your draft and explicitly reload the current record.')


def create_request(user, key, attrs, *, session):
    require(user, 'manage')
    attrs = dict(attrs)
    role_workflow = attrs.pop('role_workflow', False)
    if type(role_workflow) is not bool:
        raise ValidationError({'role_workflow': 'Use an explicit boolean.'})
    if role_workflow and (not isinstance(attrs.get('inspection_items'), list) or len(attrs['inspection_items']) < 2):
        raise ValidationError({'inspection_items': 'A role inspection needs items for both areas.'})
    scope = f'{user.pk}:create'
    payload = {k: (v.isoformat() if hasattr(v, 'isoformat') else str(v) if isinstance(v, Decimal) else v) for k, v in attrs.items()}
    if role_workflow:
        payload['role_workflow'] = True
    with session.lock('manage', actor_id=user.pk) as user:
        lock_scope('inspection:create')
        previous = existing_operation(scope, key, payload)
        if previous:
            require_owned_request(user, previous.request)
            return replay(previous, user)
        identity = digest({k: payload[k] for k in ('work_order_ref', 'task_ref', 'inspection_type', 'part_no', 'equipment_ref', 'lot_ref')})
        if InspectionRequest.objects.filter(identity=identity).exists():
            raise InspectionConflict('duplicate_request', 'This target already has a request. Open it or create an explicit reinspection.')
        request = InspectionRequest.objects.create(identity=identity, assigned_to=user, assigned_to_name=user.get_username(), **attrs)
        if role_workflow:
            from .inspection_roles import initialize_role_workflow
            initialize_role_workflow(request)
        operation = InspectionOperation.objects.create(scope=scope, key=key, request=request, payload_digest=digest(payload))
        audit(request, user, 'create')
        return finish_operation(operation, serialize(request, user), 201)


def local_action(user, request_id, action, key, payload, *, session):
    permission = {'draft': 'manage', 'submit': 'submit', 'approve': 'review', 'review-failure': 'review', 'reject': 'review', 'reinspect': 'manage'}[action]
    require(user, permission)
    scope = f'{user.pk}:{request_id}:{action}'
    # Normalize decimals before hashing or persistence; no user-supplied actor/time/state.
    canonical = {k: str(v) if isinstance(v, Decimal) else v for k, v in payload.items()}
    with session.lock(permission, actor_id=user.pk) as user:
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        require_owned_request(user, request)
        previous = existing_operation(scope, key, canonical)
        if previous:
            return replay(previous, user)
        check_version(request, payload)
        from .inspection_role_models import InspectionRoleWorkflow
        role_mode = InspectionRoleWorkflow.objects.filter(request=request).exists()
        if role_mode and action == 'draft':
            raise InspectionConflict('area_actions_required', 'Save only your assigned area or the separate quantity summary.')
        if action in {'draft', 'submit'}:
            if request.status != 'draft' or request.assigned_to_id != user.pk:
                raise PermissionDenied('Only the assigned editor may change or submit a draft.')
        if action == 'draft':
            for field, value in payload.items():
                if field != 'version':
                    setattr(request, field, value)
            validate_result(request)
        elif action == 'submit':
            if role_mode:
                from .inspection_roles import role_summary
                roles = role_summary(request, user)
                if not roles.get('can_submit', False):
                    raise InspectionConflict('inspection_areas_incomplete', 'Both assigned areas must be completed before submission.')
            validate_result(request, submit=True)
            request.status = 'submitted' if request.judgement == 'pass' else 'failed'
            request.submitted_by, request.submitted_at = user, timezone.now()
        elif action in {'approve', 'reject', 'review-failure'}:
            required_state = 'failed' if action == 'review-failure' else 'submitted'

            if request.status != required_state or (action == 'review-failure' and request.judgement != 'fail'):
                raise InspectionConflict('invalid_state', 'Use the separate independent review for a failed result.')
            if request.submitted_by_id == user.pk:
                raise PermissionDenied('An independent reviewer is required, including for superusers.')
            if role_mode and request.role_workflow.areas.filter(completed_by_id=user.pk).exists():
                raise PermissionDenied('An independent reviewer cannot review their own area results.')
            if action in {'reject', 'review-failure'} and not payload.get('reason', '').strip():
                raise ValidationError({'reason': 'A rejection reason is required.'})
            request.status = 'approved' if action in {'approve', 'review-failure'} else 'rejected'
            request.reviewed_by, request.reviewed_at = user, timezone.now()
            request.review_reason = payload.get('reason', '')
        else:
            if not reinspection_allowed(request):
                raise InspectionConflict('invalid_reinspection', 'Reinspection requires a settled failed/rejected result without an existing child.')
            if not payload.get('reason', '').strip():
                raise ValidationError({'reason': 'A reinspection reason is required.'})
            fields = ['work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'inspection_type', 'target_quantity',
                      'uom', 'warehouse_ref', 'lot_ref', 'work_started_at', 'inspection_items', 'require_evidence', 'quantity_mode', 'judgement_policy']
            child = InspectionRequest.objects.create(identity=digest({'parent': request.pk}), parent=request,
                assigned_to=user, assigned_to_name=user.get_username(), **{f: getattr(request, f) for f in fields})
            if role_mode:
                from .inspection_roles import initialize_role_workflow
                initialize_role_workflow(child)
            audit(child, user, 'create_reinspection', payload['reason'])
        if action == 'submit' and request.judgement == 'fail':
            InspectionNonconformance.objects.get_or_create(request=request, defaults={
                'quantity': request.rejected_quantity if request.quantity_mode == 'recorded' else None,
                'uom': request.uom, 'owner': request.assigned_to, 'owner_name': request.assigned_to_name,
                'evidence': request.evidence, 'original_result_digest': digest(result_payload(request))})
        request.version += 1
        request.save()
        audit(request, user, action, payload.get('reason', ''))
        operation = InspectionOperation.objects.create(scope=scope, key=key, request=request, payload_digest=digest(canonical))
        return finish_operation(operation, serialize(child if action == 'reinspect' else request, user), 201 if action == 'reinspect' else 200)


def normalize_snapshot(request, value):
    if not isinstance(value, dict):
        raise inspection_adapter.MesOutcomeUnknown()
    invariant_fields = ['work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'lot_ref', 'uom', 'warehouse_ref']
    if any(value.get(f) != getattr(request, f) for f in invariant_fields):
        raise InspectionConflict('mes_identity_changed', 'MES target, material, equipment, lot, UOM or warehouse changed.')
    if quantity(value.get('target_quantity')) != request.target_quantity:
        raise InspectionConflict('mes_quantity_changed', 'MES target quantity changed.')
    if (type(value.get('task_status')) is not int or value['task_status'] not in range(6)
            or type(value.get('qc_status')) is not int or value['qc_status'] not in {1, 2, 3, 4}
            or type(value.get('work_started')) is not bool or type(value.get('receipt_allowed')) is not bool
            or not isinstance(value.get('state_version'), str) or not 1 <= len(value['state_version']) <= 128):
        raise inspection_adapter.MesOutcomeUnknown()
    result = {f: value[f] for f in invariant_fields + ['task_status', 'qc_status', 'work_started', 'receipt_allowed', 'state_version']}
    result['target_quantity'] = str(quantity(value['target_quantity']))
    result['available_quantity'] = str(quantity(value.get('available_quantity')))
    for f in ['result_digest', 'external_result_id']:
        val = value.get(f, '')
        if not isinstance(val, str) or len(val) > 128:
            raise inspection_adapter.MesOutcomeUnknown()
        result[f] = val
    return result


def update_completion_state(request, snapshot):
    # QC lifecycle and injection receipt policy are separate contracts. A pending
    # periodic QC did not block the observed July reporting/receipt case, and a
    # completed/pass QC alone does not prove the current tenant's warehouse gate.
    # The synthetic receipt_allowed flag is retained as an observation, never
    # promoted to a live receipt permission or universal block.
    state = snapshot['task_status']
    request.mes_completion_status = {0: 'not_completed', 1: 'not_completed', 2: 'completed',
        3: 'cancelled', 4: 'approval_pending', 5: 'rejected'}[state]
    request.injection_receipt_readiness = 'not_verified'


def _reconcile(request, snapshot, user):
    # Read evidence may settle an uncertain result/finish saga. No writes replayed.
    if snapshot['result_digest'] != digest(result_payload(request)) or not snapshot['external_result_id']:
        return
    # Saved items alone cannot settle a possibly failed finish step.
    if snapshot['task_status'] not in {2, 4}:
        return
    for operation in request.operations.filter(status__in=['pending', 'unknown'], scope__endswith=':sync').order_by('id'):
        request.sync_status = 'succeeded'
        request.external_result_id = snapshot['external_result_id']
        finish_operation(operation, {'code': 'reconciled', 'operation_id': operation.id}, state='succeeded')
        audit(request, user, 'reconcile_sync')


def external_action(user, request_id, action, key, payload, *, session):
    if action not in {'refresh', 'sync'}:
        raise ValidationError('Quality cannot execute inventory receipt.')
    permission = {'refresh': 'view', 'sync': 'submit'}[action]
    require(user, permission)
    from .inspection_role_actions import require_verified_role_mes_contract
    require_verified_role_mes_contract(user, request_id)
    from .inspection_models import InspectionMesBinding
    if InspectionMesBinding.objects.filter(request_id=request_id).exists():
        raise InspectionConflict('separate_mes_stages_required', 'Use separate MES save, finish and reconciliation actions.')
    adapter = inspection_adapter.get_inspection_adapter()
    canonical = {k: str(v) if isinstance(v, Decimal) else v for k, v in payload.items()}
    scope = f'{user.pk}:{request_id}:{action}'
    with session.lock(permission, actor_id=user.pk) as user:
        if action == 'sync' and not can_use_admin_inspection_flow(user):
            raise PermissionDenied('This inspector must use separate MES save and finish actions.')
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        require_owned_request(user, request)
        if request.source_kind == 'integration_test':
            raise InspectionConflict('separate_mes_stages_required', 'Use separate MES save, finish and reconciliation actions.')
        previous = existing_operation(scope, key, canonical)
        if previous:
            return replay(previous, user)
        check_version(request, payload)
        if action == 'sync':
            if request.status != 'approved':
                raise InspectionConflict('invalid_state', 'MES completion requires local approval.')
            if request.operations.filter(status='pending', scope__endswith=':sync').exists() or request.sync_status == 'unknown':
                raise InspectionConflict('reconciliation_required', 'Refresh and reconcile pending/uncertain completion first.')
            if request.mes_completion_status in {'completed', 'approval_pending'}:
                raise InspectionConflict('already_completed', 'The MES finish/approval step was already observed.')
        operation = InspectionOperation.objects.create(scope=scope, key=key, request=request, payload_digest=digest(canonical))
        if action == 'sync':
            request.sync_status, request.mes_completion_status = 'pending', 'pending'
        request.injection_receipt_readiness = 'not_verified'
        request.version += 1
        request.save()
        audit(request, user, action + '_reserved')
        reserved_version = request.version
    from mes_oauth.session_guard import LoginRejected
    try:
        with session.lock(permission, actor_id=user.pk,
                          require_mapping=bool(adapter.enabled)) as fresh_user:
            require_owned_request(fresh_user, InspectionRequest.objects.only('assigned_to_id').get(pk=request_id))
            return _external_dispatch(fresh_user, request_id, action, payload, request,
                                      operation, reserved_version, adapter)
    except (LoginRejected, PermissionDenied):
        return blocked_before_dispatch(user, request_id, operation, action, reserved_version)


def _external_dispatch(user, request_id, action, payload, request, operation, reserved_version, adapter):
    # Reserve/commit before the result+finish saga. A timeout after any step is
    # unknown: never replay saved items/finish without scoped reconciliation.
    snapshot, code = None, ''
    response_status, operation_state = 200, 'succeeded'
    try:
        snapshot = normalize_snapshot(request, adapter.refresh(request, operation))
        if action == 'sync':
            if not snapshot['work_started'] or snapshot['task_status'] in {2, 3, 4, 5}:
                raise InspectionConflict('mes_task_closed', 'MES request is already finished, approving, cancelled or rejected, or work has not started.')
            request.mes_snapshot = snapshot
            adapter.save_result(request, operation)  # Records required data then finishes; transport success alone is insufficient.
            snapshot = normalize_snapshot(request, adapter.refresh(request, operation))
            if (snapshot['result_digest'] != digest(result_payload(request)) or not snapshot['external_result_id']
                    or snapshot['task_status'] not in {2, 4}):
                raise inspection_adapter.MesOutcomeUnknown()
    except inspection_adapter.MesContractUnavailable:
        code, response_status, operation_state = 'mes_contract_unverified', 503, 'blocked'
    except InspectionConflict as exc:
        code, response_status, operation_state = str(exc.detail['code']), 409, 'failed'
    except inspection_adapter.MesRejected:
        code, response_status, operation_state = 'mes_rejected', 409, 'failed'
    except Exception:
        # No raw URL/exception/response or payload is logged or returned.
        code, response_status, operation_state = 'mes_outcome_unknown', 503, 'unknown'
    with transaction.atomic():
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        operation = InspectionOperation.objects.select_for_update().get(pk=operation.pk)
        if operation.status != 'pending':
            return replay(operation, user)
        if request.version != reserved_version:
            # Another scoped observation completed after this operation began.
            # Never restore an older external pass over a newer failed result.
            if action == 'sync':
                request.sync_status, request.mes_completion_status = 'unknown', 'unknown'
                request.injection_receipt_readiness = 'not_verified'
                request.last_error_code = 'stale_remote_observation'
                request.version += 1
                request.save()
            audit(request, user, action + '_stale_observation')
            return finish_operation(operation, {'code': 'stale_remote_observation',
                'detail': 'A newer observation was saved. Refresh and reconcile without replaying writes.',
                'request': serialize(request, user), 'operation_id': operation.id}, 409,
                'unknown' if action == 'sync' else 'failed')
        request.last_error_code = code
        if snapshot is not None and not code:
            request.mes_snapshot, request.mes_checked_at = snapshot, timezone.now()
        if action == 'sync':
            request.sync_status = operation_state
            request.mes_completion_status = 'unknown' if operation_state == 'unknown' else 'blocked' if code else 'not_completed'
            if not code:
                request.external_result_id = snapshot['external_result_id']
                update_completion_state(request, snapshot)
        elif not code:
            _reconcile(request, snapshot, user)
            if request.sync_status == 'succeeded' and snapshot['result_digest'] != digest(result_payload(request)):
                request.sync_status = 'stale'
            update_completion_state(request, snapshot)
        else:
            request.mes_checked_at = None
            request.injection_receipt_readiness = 'not_verified'
        request.version += 1
        request.save()
        audit(request, user, action + '_' + operation_state, payload.get('reason', ''))
        data = serialize(request, user)
        response = {'code': code, 'detail': 'MES inspection completion was not confirmed. Refresh and reconcile before retry.',
                    'request': data, 'operation_id': operation.id} if code else data
        return finish_operation(operation, response, response_status, operation_state)


def blocked_before_dispatch(user, request_id, operation, action, reserved_version, *,
                            initial_phase=None, initial_sync_status=None):
    """Settle a committed reservation that never reached its adapter.

    Keep prior uncertain operations intact. The original reserving actor is
    retained even if its login or permissions were revoked in the meantime.
    """
    from django.contrib.auth import get_user_model
    from .inspection_models import InspectionMesBinding
    with transaction.atomic():
        get_user_model().objects.select_for_update().filter(pk=user.pk).first()
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        operation = InspectionOperation.objects.select_for_update().get(pk=operation.pk)
        if operation.status != 'pending':
            return replay(operation, user)
        if request.version == reserved_version:
            if initial_phase is not None:
                binding = InspectionMesBinding.objects.select_for_update().get(request=request)
                binding.phase = initial_phase
                binding.save(update_fields=['phase'])
            if action == 'mes-reconcile':
                request.sync_status = initial_sync_status
            if action in {'sync', 'mes-save', 'mes-finish'}:
                request.sync_status = 'blocked'
                request.mes_completion_status = 'blocked'
            request.last_error_code = 'inspection_login_changed'
            request.version += 1
            request.save()
        audit(request, user, action + '_login_rejected')
        return finish_operation(operation, {'code': 'inspection_login_changed',
            'detail': 'The authenticated inspector changed before dispatch. Sign in again.',
            'operation_id': operation.pk}, 403, 'blocked')
