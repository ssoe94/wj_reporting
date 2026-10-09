"""Documented v2 import + whole-campaign readback; live writes remain OFF.

The existing authenticated route gateway and USER lease format are reused.
No batch-import endpoint, credential refresh, retry, dispatch, start or QC call.
"""
import hmac
import time
import uuid

from django.db import connection, transaction
from django.views.decorators.debug import sensitive_variables

from quality.inspection_transport import InspectionUserAccessToken, MesAuthenticationExpired, MesAuthenticationRejected
from .mes_execution_contract import encode_exact_json, parse_json_exact
from .plan_workflow import (WorkflowConflict, lock_type, claim_for_isolated_adapter,
                            record_adapter_result, reconcile_readback, digest)
from .plan_workflow_contract import CREATE_PATH, build_contract
from .plan_workflow_read_contract import READ_ROUTES, read_request, verify_creation, identifier, data
from .models import PlanMesRequest, PlanMesRequestEvent

ORIGINS = frozenset({'https://v3-ali.blacklake.cn', 'https://v3-hw.blacklake.cn'})
ROUTE_BASE = '/api/openapi/domain/web/v1/route'
LIVE_WRITES_ENABLED = False


class PlanTransportError(Exception):
    def __init__(self, code='readback_unavailable'):
        self.code = code
        super().__init__(code)


class PlanMesTransport:
    @sensitive_variables()
    def __init__(self, *, origin, tenant, actor_id, mes_user_id, credential, sender=None, _trial_permit=None):
        if (origin not in ORIGINS or type(credential) is not InspectionUserAccessToken
                or type(actor_id) is not int or actor_id < 1 or type(mes_user_id) is not int
                or credential.user_id != mes_user_id or not isinstance(tenant, str) or not tenant
                or (sender is not None and not callable(sender))):
            raise PlanTransportError('credential_scope_required')
        self.origin, self.tenant, self.actor_id = origin, tenant, actor_id
        self.credential, self.sender = credential, sender
        self._trial_permit = _trial_permit
        self.attempted = False

    def _trial_allows(self, payload):
        from .plan_workflow_trial import TrialPermit
        return type(self._trial_permit) is TrialPermit and self._trial_permit.allows(self, payload)

    @sensitive_variables()
    def _post(self, path, payload, *, write=False, fixture=False):
        if path not in (*READ_ROUTES.values(), CREATE_PATH):
            raise PlanTransportError('route_not_supported')
        if path == CREATE_PATH and not self._trial_allows(payload) and (LIVE_WRITES_ENABLED is not False or fixture is not True
                or self.sender is None or not self.credential.value.startswith('SYNTHETIC-')):
            raise WorkflowConflict('MES plan writer is disabled.')
        credential = self.credential
        if credential.expires_at <= time.time():
            raise MesAuthenticationExpired()
        if (not isinstance(credential.value, str)
                or not credential.value or any(ord(c) <= 32 or ord(c) == 127 for c in credential.value)):
            raise PlanTransportError('credential_scope_required')
        sender = self.sender
        if sender is None:
            from quality.inspection_live_adapter import _user_sender
            sender = _user_sender
        try:
            response = sender(self.origin + ROUTE_BASE + path, params={'access_token': credential.value},
                data=encode_exact_json(payload), headers={'Content-Type': 'application/json'},
                timeout=(3, 15 if write else 7), allow_redirects=False)
            if getattr(response, 'history', ()):
                raise PlanTransportError('redirect_rejected')
            if response.status_code == 401:
                raise MesAuthenticationRejected()
            if response.status_code == 403:
                raise PlanTransportError('permission_required')
            if type(response.status_code) is not int or response.status_code != 200:
                raise PlanTransportError('http_result_unverified')
            if type(response.content) is not bytes or not 1 <= len(response.content) <= 524288:
                raise PlanTransportError('response_shape_unverified')
            body = parse_json_exact(response.content)
            if isinstance(body, dict) and type(body.get('code')) is int and body['code'] == 401:
                raise MesAuthenticationRejected()
            if isinstance(body, dict) and (body.get('subCode') == 'URL_NO_PERMISSION' or body.get('code') in (403, 3500060)):
                raise PlanTransportError('permission_required')
            if write and (type(body.get('needCheck')) is not int or body['needCheck'] != 0):
                raise PlanTransportError('write_confirmation_unverified')
            data(body)  # includes weak-control/field-permission rejection
            return body
        except (PlanTransportError, MesAuthenticationExpired, MesAuthenticationRejected):
            raise
        except Exception:
            raise PlanTransportError('result_unverified') from None

    def send_create(self, contract, *, fixture=False):
        # Ordinary flags/credentials do not activate writes. Only synthetic IO
        # or a current, exact server-reviewed trial permit reaches this route.
        if not self._trial_allows(contract.get('payload')) and (LIVE_WRITES_ENABLED is not False or fixture is not True or self.sender is None
                or not self.credential.value.startswith('SYNTHETIC-')):
            raise WorkflowConflict('MES plan writer is disabled.')
        if (self.attempted or contract.get('path') != CREATE_PATH
                or contract.get('tenant') != self.tenant):
            raise WorkflowConflict('Create replay or scope rejected.')
        self.attempted = True
        result = self._post(CREATE_PATH, contract['payload'], write=True, fixture=True)
        return identifier((data(result) or {}).get('id'))

    def read_creation(self, intent, contract, *, expected_id=''):
        if contract.get('tenant') != self.tenant or contract.get('path') != CREATE_PATH:
            raise PlanTransportError('tenant_readback_mapping_required')
        code = contract['payload']['code']
        responses = {'base': self._post(READ_ROUTES['base'], read_request(code))}
        work_id = identifier((data(responses['base']) or {}).get('id'))
        if expected_id and work_id != expected_id:
            raise PlanTransportError('work_order_id_mismatch')
        payload = read_request(code, work_id)
        for action in ('inputs', 'outputs', 'processes'):
            responses[action] = self._post(READ_ROUTES[action], payload)
        responses['base_after'] = self._post(READ_ROUTES['base'], payload)
        return verify_creation(intent, contract, responses, expected_id=expected_id)


def dispatch_prepared_create(request_uid, transport, *, fixture=False):
    """Reserve durably before IO; every post-dispatch failure requires readback."""
    if fixture is not True or not isinstance(transport, PlanMesTransport) or transport.sender is None:
        raise WorkflowConflict('MES plan writer is disabled.')
    if not transport.credential.value.startswith('SYNTHETIC-'):
        raise WorkflowConflict('Synthetic credential required.')
    if connection.in_atomic_block:
        raise WorkflowConflict('Reservation must commit before provider IO.')
    with transaction.atomic():
        req = PlanMesRequest.objects.select_related('work_order').get(uid=request_uid)
        lock_type(req.work_order.plan_type)
        req = PlanMesRequest.objects.select_for_update().select_related('work_order').get(uid=request_uid)
        current, blockers = build_contract(req.work_order, req.intent)
        if (req.actor_id != transport.actor_id or req.operation != 'create' or blockers
                or current.get('tenant') != transport.tenant
                or not hmac.compare_digest(digest(current), digest(req.contract))):
            raise WorkflowConflict('Request contract or actor changed.')
        req = claim_for_isolated_adapter(req.uid, fixture=True)
    # Commit the reservation before any side effect. A crash after this line leaves
    # sending fenced; no retry worker or automatic replay is implemented.
    try:
        created_id = transport.send_create(req.contract, fixture=True)
    except Exception:
        record_adapter_result(req.uid, 'unknown')
        return {'state': 'uncertain', 'blockers': ['readback_required']}
    record_adapter_result(req.uid, 'acknowledged', work_order_id=created_id)
    try:
        evidence = transport.read_creation(req.intent, req.contract, expected_id=created_id)
    except Exception:
        return {'state': 'readback_pending', 'blockers': ['complete_creation_readback_required']}
    return {'state': reconcile_readback(req.uid, evidence), 'work_order_id': evidence['work_order_id'],
            'verified_scope': 'creation_snapshot', 'production_totals_verified': False}


def dispatch_prepared_batch(request_uids, transport_factory, *, fixture=False):
    """Sequential per-order imports, with persistent independent partial results.

    No undocumented provider batch endpoint or starts; no live entry point.
    """
    if fixture is not True or not callable(transport_factory):
        raise WorkflowConflict('MES plan writer is disabled.')
    if not isinstance(request_uids, list) or not 1 <= len(request_uids) <= 50:
        raise WorkflowConflict('Select 1–50 prepared requests.')
    try:
        uids = [str(uuid.UUID(value)) for value in request_uids if isinstance(value, str)]
    except ValueError:
        raise WorkflowConflict('Invalid request UID.') from None
    if len(uids) != len(request_uids) or len(set(uids)) != len(uids):
        raise WorkflowConflict('Duplicate or invalid request UID.')
    results = []
    for uid in uids:
        try:
            result = dispatch_prepared_create(uid, transport_factory(uid), fixture=True)
        except (WorkflowConflict, PlanTransportError, PlanMesRequest.DoesNotExist):
            result = {'state': 'blocked', 'blockers': ['request_scope_or_replay_rejected']}
        results.append({'uid': uid, **result})
    return results


def recheck_creation(request_uid, transport):
    req = PlanMesRequest.objects.select_related('work_order').get(uid=request_uid)
    if (req.state not in ('sending', 'uncertain', 'readback_pending', 'review')
            or req.actor_id != transport.actor_id or req.operation != 'create'):
        raise WorkflowConflict('Only unresolved own creation requests can be rechecked.')
    try:
        acknowledgement = req.events.filter(state='readback_pending', evidence__has_key='work_order_id').order_by('-id').first()
        expected_id = req.work_order.mes_id or ((acknowledgement.evidence.get('work_order_id') or '') if acknowledgement else '')
        evidence = transport.read_creation(req.intent, req.contract, expected_id=expected_id)
    except (MesAuthenticationExpired, MesAuthenticationRejected):
        # Let the established broker revoke rejected leases. No refresh/retry.
        raise
    except Exception as error:
        code = error.code if isinstance(error, PlanTransportError) else 'complete_creation_readback_required'
        with transaction.atomic():
            lock_type(req.work_order.plan_type)
            req = PlanMesRequest.objects.select_for_update().get(pk=req.pk)
            PlanMesRequestEvent.objects.create(request=req, state=req.state,
                evidence={'read_scope': 'creation_snapshot', 'complete': False, 'blocker': code})
        # Do not interpret an empty/error lookup as proof that create did not occur.
        return {'state': req.state, 'blockers': [code], 'production_totals_verified': False}
    return {'state': reconcile_readback(req.uid, evidence), 'work_order_id': evidence['work_order_id'],
            'verified_scope': 'creation_snapshot', 'production_totals_verified': False}


@sensitive_variables()
def recheck_creation_for_session(request_uid, session, *, provider=None, sender=None):
    """Use the existing same-user broker for reads only; never issue USER tokens."""
    from django.conf import settings
    from django.contrib.auth import get_user_model
    from mes_oauth import vault
    from mes_oauth.app_tokens import AppCredentialUnavailable, get_existing_app_access_token
    from mes_oauth.client import BlacklakeUserOAuthClient
    from mes_oauth.inspection_credentials import call_with_user_credential
    from mes_oauth.pilot_scope import pilot_route_scope_required
    from mes_oauth.session_guard import InspectionSession
    if type(session) is not InspectionSession:
        raise WorkflowConflict('Current USER session required.')
    req = PlanMesRequest.objects.select_related('work_order').get(uid=request_uid)
    if req.actor_id != session.actor_id or req.operation != 'create' or not req.contract:
        return {'state': req.state, 'blockers': ['own_reviewed_creation_required']}
    try:
        configuration = vault.policy()
        mes_user_id = vault.expected_user(session.actor_id)
        if req.contract.get('tenant') != configuration.tenant:
            raise PlanTransportError('tenant_readback_mapping_required')
        origin = settings.MES_USER_OAUTH_PROVIDER_ORIGIN
        def policy_check():
            user = get_user_model().objects.filter(pk=session.actor_id).only('is_active', 'is_superuser').first()
            return (user is not None and user.is_active and user.is_superuser
                    and not pilot_route_scope_required(user, session.claims)
                    and vault.policy() == configuration and vault.expected_user(session.actor_id) == mes_user_id
                    and getattr(settings, 'MES_INSPECTION_ENABLED', False) is True
                    and getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is True)
        if provider is None:
            # Existing-only failure must stop before broker admission. Passing
            # None would enable the broker's normal APP issuance fallback.
            app = get_existing_app_access_token()
            provider = BlacklakeUserOAuthClient(origin=origin, app_access_token=app,
                app_token_header=getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token'))
        def callback(credential):
            transport = PlanMesTransport(origin=origin, tenant=configuration.tenant,
                actor_id=session.actor_id, mes_user_id=mes_user_id, credential=credential, sender=sender)
            return recheck_creation(req.uid, transport)
        return call_with_user_credential(session, mes_user_id=mes_user_id, tenant=configuration.tenant,
            contract_reference='WJ-PLAN-CREATION-READBACK-20261008', policy_check=policy_check,
            operation='read', callback=callback, provider=provider)
    except (vault.VaultBlocked, AppCredentialUnavailable, PlanTransportError):
        return {'state': req.state, 'blockers': ['connection_or_read_authority_required']}
