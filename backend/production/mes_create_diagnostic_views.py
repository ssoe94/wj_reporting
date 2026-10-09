"""The owner-approved, fixed draft bridge; GET is strictly metadata-only."""
import re
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied, ValidationError
from rest_framework.parsers import JSONParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from config.authentication import ScopedJWTAuthentication
from mes_oauth import vault
from mes_oauth.app_tokens import AppCredentialUnavailable, app_supply_readiness, app_token_status
from mes_oauth.models import MESCredential
from mes_oauth.pilot_scope import pilot_route_scope_required
from mes_oauth.session_guard import InspectionSession, _normal_actor, check_known_login, require_live_login
from quality.inspection_workflow import require as require_inspection
from . import mes_create_diagnostic as diagnostic
from .models import MesCreateDiagnostic, MesCreateDiagnosticPermit
from .plan_workflow import WorkflowConflict
from .plan_workflow_transport import PlanTransportError


SCOPE = {'material_code': '0', 'quantity': '1', 'unit_name': '个', 'status': 0,
    'planned_start': '2026-10-10T08:00:00+08:00', 'planned_end': '2026-10-11T08:00:00+08:00',
    'resource_assigned': False, 'inputs_assigned': False, 'processes_assigned': False}
READBACK_STATES = {'sending', 'uncertain', 'readback_pending', 'review', 'draft_observed'}
RESULT_FIELDS = {'work_order_id', 'work_order_code', 'status', 'quantity', 'unit_name',
    'planned_start', 'planned_end', 'actual_started_at', 'draft_snapshot_matches', 'task_count',
    'inventory_change_count', 'inventory_changed', 'qc_changed', 'review_required',
    'global_or_delayed_effects_verified', 'reported_and_inbound_totals_verified',
    'full_material_workflow_verified', 'blocker', 'effects_verified', 'acknowledged'}


def fixed_reason(value, fallback):
    return value if type(value) is str and re.fullmatch(r'[a-z][a-z0-9_]{0,79}', value) else fallback


@sensitive_variables()
def admitted(request, permission):
    user = get_user_model().objects.filter(pk=request.user.pk).first()
    if (user is None or user.pk != diagnostic.ACTOR_ID or not user.is_active or not user.is_superuser
            or pilot_route_scope_required(user, request.auth or {})):
        raise PermissionDenied('exact_diagnostic_actor_required')
    session = InspectionSession.from_request(request)
    if session.version != 2:
        raise AuthenticationFailed('current_normal_session_required')
    _normal_actor(user, session.claims)
    login = check_known_login(user, request.auth)
    session.effective_expires_at = require_live_login(login, require_v2=True)
    require_inspection(user, permission)
    return user, session


def configuration():
    diagnostic.require(getattr(settings, 'MES_INSPECTION_ENABLED', False) is True
        and vault.enabled()
        and getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', '') == diagnostic.ORIGIN,
        'diagnostic_runtime_unavailable')
    policy = vault.policy()
    diagnostic.require(vault.expected_user(diagnostic.ACTOR_ID) == int(diagnostic.MES_USER_ID),
        'diagnostic_scope_rejected')
    return policy


def connection_metadata(user, session, policy):
    # Never open USER ciphertext or enter the broker on a readiness read.
    row = MESCredential.objects.defer('ciphertext').filter(pk=user.pk).first()
    decision = vault.decision(user, row, session.login_digest, policy)
    if decision.action == 'reuse_candidate':
        status = 'ready'
    elif decision.action == 'reauthenticate':
        status = 'reconnect_required'
    else:
        status = 'blocked'
    return {'status': status, 'reason': fixed_reason(decision.reason, 'connection_unavailable')}


def envelope(user, session, *, result=None):
    blockers = []
    try:
        policy = configuration()
        connection = connection_metadata(user, session, policy)
    except (vault.VaultBlocked, WorkflowConflict):
        policy = None
        connection = {'status': 'blocked', 'reason': 'diagnostic_runtime_unavailable'}
        blockers.append('diagnostic_runtime_unavailable')
    readiness = app_supply_readiness()
    mode = app_token_status().get('supply_mode')
    app_supply = {'available': readiness['available'],
        'usable_for_seconds': readiness['usable_for_seconds'],
        'supply_mode': mode if mode in ('static', 'server') else 'unknown'}
    req = MesCreateDiagnostic.objects.filter(tenant=diagnostic.TENANT, code=diagnostic.CODE,
        actor_id=user.pk).first()
    approval = {'reference': diagnostic.APPROVAL_REFERENCE, 'approved_at': None,
        'expires_at': None, 'active': False, 'expired': False, 'max_attempts': 1,
        'app_max_attempts': 1, 'app_attempt': 0}
    record = None if req is None else MesCreateDiagnosticPermit.objects.filter(request_id=req.pk).first()
    if record is not None:
        approval.update(approved_at=record.approved_at.isoformat(), expires_at=record.expires_at.isoformat(),
            expired=timezone.now() >= record.expires_at, app_attempt=record.auth_app_attempt)
        try:
            permit = diagnostic.reviewed_permit(req)
            approval['active'] = policy is not None and permit.tenant_reference == policy.tenant
        except WorkflowConflict:
            pass
        if not approval['active']:
            blockers.append('diagnostic_approval_expired' if approval['expired'] else 'diagnostic_approval_changed')
    if connection['status'] != 'ready':
        blockers.append(connection['reason'])
    if not app_supply['available']:
        blockers.append('existing_app_provider_required')
    can_prepare = policy is not None and record is None and (req is None or req.state == 'prepared' and req.attempt == 0)
    can_send = bool(req and req.state == 'prepared' and req.attempt == 0 and approval['active']
        and connection['status'] == 'ready' and app_supply['available'])
    can_recheck = bool(req and req.attempt == 1 and req.state in READBACK_STATES and policy is not None
        and connection['status'] == 'ready' and app_supply['available'])
    can_reconnect = bool(req and req.state == 'prepared' and req.attempt == 0 and approval['active']
        and record.auth_app_attempt == 0 and policy is not None)
    data = {'code': diagnostic.CODE, 'scope': SCOPE, 'state': req.state if req else 'unprepared',
        'request_uid': str(req.uid) if req else None, 'attempt': req.attempt if req else 0,
        'approval': approval, 'app_supply': app_supply, 'connection': connection,
        'can_prepare': can_prepare, 'can_send': can_send, 'can_recheck': can_recheck,
        'can_reconnect': can_reconnect, 'blockers': list(dict.fromkeys(blockers)),
        'ordinary_writer_enabled': False}
    if req is not None and req.attempt == 1:
        if result is None:
            event = req.events.filter(state=req.state).order_by('-id').first()
            result = event.evidence if event else {}
        data['result'] = {'state': req.state, 'work_order_id': req.mes_id,
            **{key: value for key, value in result.items() if key in RESULT_FIELDS}}
    return data


class MesCreateDiagnosticView(APIView):
    authentication_classes = [ScopedJWTAuthentication]
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]
    http_method_names = ['get', 'post', 'options']

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        response['Referrer-Policy'] = 'no-referrer'
        return response

    def handle_exception(self, error):
        # Provider payloads and arbitrary exception strings never cross this API.
        if isinstance(error, WorkflowConflict):
            return Response({'detail': fixed_reason(str(error.detail), 'diagnostic_scope_rejected')}, status=409)
        if isinstance(error, PermissionDenied):
            return Response({'detail': 'exact_diagnostic_actor_required'}, status=403)
        if isinstance(error, AuthenticationFailed):
            return Response({'detail': 'current_normal_session_required'}, status=401)
        if isinstance(error, ValidationError):
            return Response({'detail': 'diagnostic_request_invalid'}, status=400)
        if isinstance(error, (vault.VaultBlocked, PlanTransportError, AppCredentialUnavailable)):
            return Response({'detail': 'current_authorized_connection_required'}, status=409)
        return super().handle_exception(error)

    def get(self, request):
        if request.query_params:
            raise ValidationError('diagnostic_request_invalid')
        user, session = admitted(request, 'view')
        return Response(envelope(user, session))

    @sensitive_variables()
    def post(self, request):
        if request.query_params or type(request.data) is not dict:
            raise ValidationError('diagnostic_request_invalid')
        action = request.data.get('action')
        if type(action) is not str or action not in ('prepare', 'send', 'recheck'):
            raise ValidationError('diagnostic_request_invalid')
        expected = {'action'} if action == 'prepare' else {'action', 'request_uid'}
        if set(request.data) != expected:
            raise ValidationError('diagnostic_request_invalid')
        user, session = admitted(request, 'submit')
        policy = configuration()
        if action == 'prepare':
            with session.lock('submit', actor_id=diagnostic.ACTOR_ID,
                    mes_actor=int(diagnostic.MES_USER_ID), require_mapping=True) as locked_user:
                diagnostic.activate_diagnostic(locked_user, policy.tenant)
            return Response(envelope(user, session))
        try:
            uid = request.data['request_uid']
            if type(uid) is not str or str(uuid.UUID(uid)) != uid:
                raise ValueError()
            req = MesCreateDiagnostic.objects.get(pk=uid, tenant=diagnostic.TENANT,
                code=diagnostic.CODE, actor_id=user.pk)
        except (ValueError, TypeError, MesCreateDiagnostic.DoesNotExist):
            raise ValidationError('diagnostic_request_invalid') from None
        diagnostic.exact_request(req)
        result = diagnostic.run_for_session(str(req.uid), session, read_only=action == 'recheck')
        return Response(envelope(user, session, result=result))
