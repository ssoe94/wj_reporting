"""Exact, single draft diagnostic; no worker, environment flag or cleanup.

Separate from PlanMesTransport and its complete material/version approval.
Default approval is absent. The trusted session bridge uses existing APP supply
only. Approval accepts disclosed unknown tenant automation; it does not attest
that creation has no side effects. No dispatch/start/finish/close/QC write exists.
"""
from copy import deepcopy
from dataclasses import dataclass
from datetime import timedelta
import hashlib
import hmac
import json
import re
import time

from django.conf import settings
from django.core.exceptions import ValidationError as ModelValidationError
from django.db import connection, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.debug import sensitive_variables

from quality.inspection_transport import InspectionUserAccessToken, MesAuthenticationExpired, MesAuthenticationRejected
from .mes_execution_contract import encode_exact_json, parse_json_exact, mes_id
from .models import MesCreateDiagnostic, MesCreateDiagnosticEvent, MesCreateDiagnosticPermit
from .plan_workflow import WorkflowConflict
from .plan_workflow_read_contract import READ_ROUTES as DETAIL_ROUTES, data, identifier, read_request, amount, epoch
from .plan_workflow_transport import ROUTE_BASE, PlanTransportError
from .plan_workflow_credentials import existing_provider_factory, provider_for_lease

ORIGIN = 'https://v3-ali.blacklake.cn'
TENANT = '南京万佳'
ACTOR_ID = 18
MES_USER_ID = '1733276056994641'
MATERIAL_ID = '1734569511470476'
CODE = 'WJ-IT-CREATE-20261009-001'
CREATE_PATH = '/med/open/v2/work_order/_doimport'
# Official public documents: 1686645473258367 / 1681109889053785 /
# 1681109889053816 / 1681109889053817 / 1681109889047072.
READ_ROUTES = {**DETAIL_ROUTES,
    'orders': '/med/open/v2/work_order/base/_list',
    'tasks': '/mfg/open/v1/produce_task/_list',
    'inventory': '/inventory/open/v1/material_inventory/_list',
    'changes': '/inventory/open/v1/material_inventory/_list_change_log',
    'qc': '/quality/open/v1/task/_list'}
PAYLOAD = {'code': CODE, 'externalOrderCode': CODE, 'identifier': CODE, 'status': 0,
    'planStartTime': 1791590400000, 'planFinishTime': 1791676800000,
    'outputMaterialOpenCOs': [{'lineSeq': '0', 'mainFlag': 1, 'materialCode': '0',
        'plannedAmount': '1', 'unitName': '个'}]}
PAYLOAD_DIGEST = 'f2e0c07365a74b4a52979fe541640fa32085a7ffcfad255b86e157fdf21ffa29'
APPROVAL_REFERENCE = '2026-10-09T12:41:25Z owner approved exact trial'
APPROVAL_KEYS = {'reference', 'request_uid', 'payload_digest', 'code', 'actor_id', 'mes_user_id',
    'origin', 'tenant', 'tenant_reference', 'approved_at', 'expires_at', 'max_attempts',
    'accept_unknown_common_automation', 'preserve_draft', 'read_scope'}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def require(good, reason='diagnostic_scope_rejected'):
    if not good:
        raise WorkflowConflict(reason)


def exact_request(req):
    require(req.tenant == TENANT and req.code == CODE and req.actor_id == ACTOR_ID
        and req.payload_digest == PAYLOAD_DIGEST and digest(req.payload) == PAYLOAD_DIGEST)


def prepare_diagnostic(actor):
    """Persist reviewable bytes locally; preparation neither approves nor sends."""
    require(actor.pk == ACTOR_ID and actor.is_active and actor.is_superuser)
    with transaction.atomic():
        req, created = MesCreateDiagnostic.objects.get_or_create(tenant=TENANT, code=CODE,
            defaults={'actor': actor, 'payload': deepcopy(PAYLOAD), 'payload_digest': PAYLOAD_DIGEST})
        exact_request(req)
        if created:
            MesCreateDiagnosticEvent.objects.create(request=req, state='prepared', evidence={
                'payload_digest': PAYLOAD_DIGEST, 'approval_present': False, 'full_workflow_verified': False})
    return req


@dataclass(frozen=True)
class DiagnosticPermit:
    request_uid: str
    approval_digest: str
    reference: str
    expires_at: object
    tenant_reference: str

    def current(self):
        try:
            req = MesCreateDiagnostic.objects.get(pk=self.request_uid)
            current = reviewed_permit(req)
            return hmac.compare_digest(self.approval_digest, current.approval_digest)
        except Exception:
            return False

    def allows(self, req, credential):
        exact_request(req)
        require(self.current() and self.request_uid == str(req.uid)
            and req.state == 'sending' and req.attempt == 1
            and type(credential) is InspectionUserAccessToken
            and credential.user_id == int(MES_USER_ID), 'diagnostic_approval_changed')


def reviewed_permit(req):
    exact_request(req)
    record = MesCreateDiagnosticPermit.objects.filter(request_id=req.pk).first()
    require(record is not None, 'exact_diagnostic_approval_required')
    review = record.snapshot
    require(type(review) is dict and set(review) == APPROVAL_KEYS
        and review['reference'] == APPROVAL_REFERENCE
        and hmac.compare_digest(record.snapshot_digest, digest(review)), 'exact_diagnostic_approval_required')
    # The MES company display name is not the vault's reviewed tenant reference.
    require(type(review['tenant_reference']) is str and re.fullmatch(
        r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', review['tenant_reference']),
        'diagnostic_tenant_reference_required')
    try:
        start, end = parse_datetime(review['approved_at']), parse_datetime(review['expires_at'])
        valid = (start is not None and end is not None and timezone.is_aware(start)
            and timezone.is_aware(end)
            and timedelta(0) < end - start <= timedelta(minutes=30)
            and start == record.approved_at and end == record.expires_at)
    except (TypeError, ValueError):
        valid = False
    require(valid and review['request_uid'] == str(req.uid)
        and review['payload_digest'] == PAYLOAD_DIGEST and review['code'] == CODE
        and type(review['actor_id']) is int and review['actor_id'] == ACTOR_ID
        and review['mes_user_id'] == MES_USER_ID and review['origin'] == ORIGIN
        and review['tenant'] == TENANT and type(review['max_attempts']) is int
        and review['max_attempts'] == 1 and review['accept_unknown_common_automation'] is True
        and review['preserve_draft'] is True
        and review['read_scope'] == 'exact_order_and_code0_effect_window', 'diagnostic_approval_scope_rejected')
    require(start <= timezone.now() < end, 'diagnostic_approval_expired')
    return DiagnosticPermit(str(req.uid), record.snapshot_digest, review['reference'], end,
        review['tenant_reference'])


def activate_diagnostic(actor, tenant_reference):
    """Prepare and activate once; retries never refresh an expired grant."""
    require(type(tenant_reference) is str and re.fullmatch(
        r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', tenant_reference), 'diagnostic_tenant_reference_required')
    with transaction.atomic():
        req = prepare_diagnostic(actor)
        req = MesCreateDiagnostic.objects.select_for_update().get(pk=req.pk)
        require(req.state == 'prepared' and req.attempt == 0, 'diagnostic_replay_rejected')
        existing = MesCreateDiagnosticPermit.objects.filter(request_id=req.pk).first()
        if existing is not None:
            permit = reviewed_permit(req)
            require(permit.tenant_reference == tenant_reference, 'diagnostic_approval_changed')
            return req
        now = timezone.now()
        snapshot = {'reference': APPROVAL_REFERENCE, 'request_uid': str(req.uid),
            'payload_digest': PAYLOAD_DIGEST, 'code': CODE, 'actor_id': ACTOR_ID,
            'mes_user_id': MES_USER_ID, 'origin': ORIGIN, 'tenant': TENANT,
            'tenant_reference': tenant_reference, 'approved_at': now.isoformat(),
            'expires_at': (now + timedelta(minutes=30)).isoformat(), 'max_attempts': 1,
            'accept_unknown_common_automation': True, 'preserve_draft': True,
            'read_scope': 'exact_order_and_code0_effect_window'}
        MesCreateDiagnosticPermit.objects.create(request=req, snapshot=snapshot,
            snapshot_digest=digest(snapshot), approved_at=now, expires_at=now + timedelta(minutes=30))
        MesCreateDiagnosticEvent.objects.create(request=req, state='approved', evidence={
            'reference': APPROVAL_REFERENCE, 'payload_digest': PAYLOAD_DIGEST,
            'tenant_reference': tenant_reference, 'expires_at': snapshot['expires_at'],
            'max_attempts': 1, 'app_max_attempts': 1})
    return req


@dataclass(frozen=True)
class CallbackAppPermit:
    request_uid: str
    oauth_attempt_id: str
    approval_digest: str

    def _assert(self, *, completed):
        from django.contrib.auth import get_user_model
        from mes_oauth import vault
        from mes_oauth.models import OAuthAttempt
        req = MesCreateDiagnostic.objects.get(pk=self.request_uid)
        permit = reviewed_permit(req)
        approval = MesCreateDiagnosticPermit.objects.get(request_id=req.pk)
        attempt = OAuthAttempt.objects.filter(pk=self.oauth_attempt_id).first()
        user = get_user_model().objects.filter(pk=ACTOR_ID).first()
        require(req.state == 'prepared' and req.attempt == 0
            and permit.approval_digest == self.approval_digest
            and approval.auth_app_attempt == 1 and approval.auth_oauth_attempt == self.oauth_attempt_id
            and attempt is not None and attempt.actor_id == ACTOR_ID
            and str(attempt.diagnostic_request_uid) == self.request_uid
            and attempt.status == ('verified' if completed else 'processing')
            and attempt.consumed_at is not None and attempt.expires_at > timezone.now()
            and attempt.expected_user_id == MES_USER_ID
            and user is not None and user.is_active and user.is_superuser and vault.eligible(user)
            and vault.expected_user(ACTOR_ID) == int(MES_USER_ID)
            and vault.policy().tenant == permit.tenant_reference, 'diagnostic_auth_budget_rejected')
        if completed:
            require(approval.auth_completed_at is not None and attempt.verified_at is not None
                and req.events.filter(state='auth_verified', evidence__oauth_attempt_id=self.oauth_attempt_id).exists(),
                'diagnostic_auth_budget_rejected')

    def assert_current(self):
        """Pre-issuer fence, while the pinned OAuth attempt is processing."""
        self._assert(completed=False)

    def assert_completed(self):
        """Pure post-store handoff fence; never exports a credential."""
        self._assert(completed=True)


def require_diagnostic_reconnect(request_uid, actor_id):
    """Admission for an explicitly pinned normal connection launch, no writes."""
    from django.contrib.auth import get_user_model
    from mes_oauth import vault
    from mes_oauth.pilot_scope import pilot_route_scope_required
    require(actor_id == ACTOR_ID, 'diagnostic_scope_rejected')
    try:
        req = MesCreateDiagnostic.objects.get(pk=request_uid)
    except (ValueError, TypeError, ModelValidationError, MesCreateDiagnostic.DoesNotExist):
        raise WorkflowConflict('diagnostic_scope_rejected') from None
    permit = reviewed_permit(req)
    user = get_user_model().objects.filter(pk=actor_id).first()
    require(user is not None and user.is_active and user.is_superuser and vault.eligible(user)
        and not pilot_route_scope_required(user, {})
        and vault.expected_user(actor_id) == int(MES_USER_ID)
        and vault.policy().tenant == permit.tenant_reference, 'diagnostic_scope_rejected')
    require(req.state == 'prepared' and req.attempt == 0, 'diagnostic_replay_rejected')
    require(req.approval.auth_app_attempt == 0, 'diagnostic_auth_budget_exhausted')
    return req


def claim_callback_app_budget(actor_id, oauth_attempt):
    """Commit max-one authorization before the callback's user transaction/IO."""
    from mes_oauth.models import OAuthAttempt
    # A stale caller instance cannot determine the durable callback state or
    # erase the diagnostic pin. Ordinary connections carry no pin at all.
    attempt = OAuthAttempt.objects.filter(pk=oauth_attempt.pk).first()
    require(attempt is not None, 'diagnostic_auth_budget_rejected')
    if attempt.diagnostic_request_uid is None:
        return None
    require(not connection.in_atomic_block, 'committed_auth_reservation_required')
    require(actor_id == ACTOR_ID and attempt.actor_id == actor_id, 'diagnostic_auth_budget_rejected')
    with transaction.atomic():
        req = MesCreateDiagnostic.objects.select_for_update().filter(pk=attempt.diagnostic_request_uid).first()
        require(req is not None, 'diagnostic_auth_budget_rejected')
        permit = reviewed_permit(req)
        require(req.state == 'prepared' and req.attempt == 0
            and attempt.status == 'processing' and attempt.expected_user_id == MES_USER_ID
            and attempt.consumed_at is not None and attempt.expires_at > timezone.now(),
            'diagnostic_auth_budget_rejected')
        changed = MesCreateDiagnosticPermit.objects.filter(request_id=req.pk, auth_app_attempt=0,
            snapshot_digest=permit.approval_digest).update(auth_app_attempt=1,
                auth_oauth_attempt=str(attempt.pk), auth_claimed_at=timezone.now())
        require(changed == 1, 'diagnostic_auth_budget_exhausted')
        MesCreateDiagnosticEvent.objects.create(request=req, state='auth_reserved', evidence={
            'reference': APPROVAL_REFERENCE, 'app_attempt': 1, 'oauth_attempt_id': str(attempt.pk)})
    return CallbackAppPermit(str(req.uid), str(attempt.pk), permit.approval_digest)


def finish_callback_app_budget(permit, *, succeeded):
    """Record the outcome without refunding, extending or exporting credentials."""
    if permit is None:
        return
    from mes_oauth.models import OAuthAttempt
    require(type(permit) is CallbackAppPermit and type(succeeded) is bool)
    with transaction.atomic():
        record = MesCreateDiagnosticPermit.objects.select_for_update().get(request_id=permit.request_uid)
        require(record.auth_app_attempt == 1 and record.auth_oauth_attempt == permit.oauth_attempt_id
            and record.snapshot_digest == permit.approval_digest, 'diagnostic_auth_budget_rejected')
        if succeeded:
            require(OAuthAttempt.objects.filter(pk=permit.oauth_attempt_id, actor_id=ACTOR_ID,
                diagnostic_request_uid=permit.request_uid, status='verified', verified_at__isnull=False).exists(),
                'diagnostic_auth_budget_rejected')
        if record.auth_completed_at is not None:
            return
        record.auth_completed_at = timezone.now()
        record.save(update_fields=['auth_completed_at'])
        MesCreateDiagnosticEvent.objects.create(request_id=permit.request_uid,
            state='auth_verified' if succeeded else 'auth_failed', evidence={
                'reference': APPROVAL_REFERENCE, 'app_attempt': 1, 'oauth_attempt_id': permit.oauth_attempt_id})


def complete_page(body):
    """A bounded complete page, never an error/partial list interpreted as zero."""
    node = data(body)
    require(type(node) is dict and type(node.get('page')) is int and node['page'] == 1
        and type(node.get('total')) is int and type(node.get('list')) is list
        and 0 <= node['total'] <= 25 and len(node['list']) == node['total']
        and all(type(row) is dict for row in node['list']), 'complete_page_required')
    return node['list']


def inventory_snapshot(rows):
    ids = []
    for row in rows:
        ids.append(identifier(row.get('id')))
        require(identifier((row.get('material') or {}).get('id')) == MATERIAL_ID,
            'inventory_material_scope_mismatch')
    require(len(ids) == len(set(ids)), 'duplicate_inventory_rows')
    # Canonical strings retain exact numeric IDs/quantities without putting
    # provider employee fields or credentials in the persistent audit.
    encoded = sorted(encode_exact_json(row).decode() for row in rows)
    return {'ids': sorted(ids), 'count': len(rows), 'digest': digest(encoded)}


def qc_snapshot(rows):
    ids = []
    for row in rows:
        ids.append(identifier(row.get('id')))
        require(identifier(row.get('materialId')) == MATERIAL_ID, 'qc_material_scope_mismatch')
    require(len(ids) == len(set(ids)), 'duplicate_qc_rows')
    return {'ids': sorted(ids), 'count': len(rows),
        'digest': digest(sorted(encode_exact_json(row).decode() for row in rows))}


class DiagnosticTransport:
    """Finite route allowlist; single exact create requires a durable permit."""
    @sensitive_variables()
    def __init__(self, credential, *, sender=None):
        require(type(credential) is InspectionUserAccessToken and credential.user_id == int(MES_USER_ID))
        self.credential, self.sender = credential, sender
        self.attempted = False
        self.work_id = ''

    def _read_scope(self, action, payload):
        material = {'materialIds': [mes_id(MATERIAL_ID)], 'page': 1, 'size': 25}
        if action == 'orders':
            valid = payload == {'exactWorkOrderCode': CODE, 'page': 1, 'size': 25}
        elif action in ('inventory', 'qc'):
            valid = payload == material
        elif action == 'changes':
            start, end = payload.get('dateStart'), payload.get('dateEnd')
            valid = (set(payload) == {*material, 'dateStart', 'dateEnd'}
                and all(payload[key] == value for key, value in material.items())
                and type(start) is int and type(end) is int and 0 < end - start <= 86400000)
        elif action == 'tasks':
            valid = bool(self.work_id) and payload == {'workOrderIdList': [mes_id(self.work_id)], 'page': 1, 'size': 25}
        elif action in DETAIL_ROUTES:
            valid = bool(self.work_id) and payload == read_request(CODE, self.work_id)
        else:
            valid = False
        require(valid, 'diagnostic_read_scope_rejected')

    @sensitive_variables()
    def post(self, action, payload, *, req=None, permit=None):
        write = action == 'create'
        if write:
            require(type(permit) is DiagnosticPermit and req is not None)
            current = MesCreateDiagnostic.objects.get(pk=req.pk)
            permit.allows(current, self.credential)
            require(not self.attempted and digest(payload) == PAYLOAD_DIGEST, 'diagnostic_replay_rejected')
            self.attempted = True
        else:
            require(action in READ_ROUTES, 'diagnostic_route_rejected')
            self._read_scope(action, payload)
        require(self.credential.expires_at > time.time(), 'existing_credential_expired')
        token = self.credential.value
        require(type(token) is str and token and not any(ord(c) <= 32 or ord(c) == 127 for c in token))
        sender = self.sender
        if sender is None:
            from quality.inspection_live_adapter import _user_sender
            sender = _user_sender
        path = CREATE_PATH if write else READ_ROUTES[action]
        try:
            response = sender(ORIGIN + ROUTE_BASE + path, params={'access_token': token},
                data=encode_exact_json(payload), headers={'Content-Type': 'application/json'},
                timeout=(3, 15 if write else 7), allow_redirects=False)
            if response.status_code == 401:
                raise MesAuthenticationRejected()
            if response.status_code == 403:
                raise PlanTransportError('permission_required')
            require(type(response.status_code) is int and response.status_code == 200
                and not getattr(response, 'history', ()) and type(response.content) is bytes
                and 0 < len(response.content) <= 524288, 'provider_result_unverified')
            body = parse_json_exact(response.content)
            require(type(body) is dict)
            if body.get('code') == 401:
                raise MesAuthenticationRejected()
            if body.get('subCode') == 'URL_NO_PERMISSION' or body.get('code') in (403, 3500060):
                raise PlanTransportError('permission_required')
            require(not write or (type(body.get('needCheck')) is int and body['needCheck'] == 0),
                'provider_confirmation_unverified')
            data(body)
            if write:
                node = data(body)
                require(type(node) is dict and not body.get('failAmount') and not body.get('failResults')
                    and not node.get('failAmount') and not node.get('failResults'), 'partial_result_unverified')
            return body
        except (WorkflowConflict, PlanTransportError, MesAuthenticationExpired, MesAuthenticationRejected):
            raise
        except Exception:
            raise PlanTransportError('provider_result_unverified') from None

    def orders(self):
        rows = complete_page(self.post('orders', {'exactWorkOrderCode': CODE, 'page': 1, 'size': 25}))
        require(len(rows) <= 1 and all(row.get('code') == CODE for row in rows), 'exact_order_scope_mismatch')
        self.work_id = identifier(rows[0].get('id')) if rows else ''
        return rows

    def baseline(self):
        require(self.orders() == [], 'code_already_present')
        scope = {'materialIds': [mes_id(MATERIAL_ID)], 'page': 1, 'size': 25}
        inventory = inventory_snapshot(complete_page(self.post('inventory', scope)))
        qc = qc_snapshot(complete_page(self.post('qc', scope)))
        return {'inventory': inventory, 'qc': qc, 'window_start_ms': int(time.time() * 1000) - 30000}

    def observe(self, req, baseline):
        orders = self.orders()
        require(len(orders) == 1 and orders[0].get('code') == CODE, 'exact_order_readback_required')
        work_id = identifier(orders[0].get('id'))
        require(not req.mes_id or req.mes_id == work_id, 'work_order_id_mismatch')
        payload = read_request(CODE, work_id)
        before = data(self.post('base', payload))
        inputs = data(self.post('inputs', payload))
        outputs = data(self.post('outputs', payload))
        processes = data(self.post('processes', payload))
        tasks = complete_page(self.post('tasks', {'workOrderIdList': [mes_id(work_id)], 'page': 1, 'size': 25}))
        for row in tasks:
            require(identifier(row.get('workOrderId')) == work_id and row.get('workOrderCode') == CODE,
                'task_scope_mismatch')
        scope = {'materialIds': [mes_id(MATERIAL_ID)], 'page': 1, 'size': 25}
        qc = qc_snapshot(complete_page(self.post('qc', scope)))
        inventory = inventory_snapshot(complete_page(self.post('inventory', scope)))
        end = int(time.time() * 1000) + 1
        start = baseline['window_start_ms']
        require(type(start) is int and 0 < end - start <= 86400000, 'effect_window_expired')
        changes = complete_page(self.post('changes', {**scope, 'dateStart': start, 'dateEnd': end}))
        for row in changes:
            require(identifier((row.get('material') or {}).get('id')) == MATERIAL_ID,
                'inventory_change_scope_mismatch')
            require(type(row.get('createdAt')) is int and start <= row['createdAt'] < end,
                'inventory_change_window_mismatch')
        after = data(self.post('base', payload))
        require(type(before) is dict and before == after and type(before.get('updatedAt')) is int
            and before['updatedAt'] > 0 and identifier(before.get('id')) == work_id,
            'concurrent_or_incomplete_readback')
        require(type(outputs) is list and len(outputs) == 1 and type(outputs[0]) is dict,
            'output_readback_required')
        output = outputs[0]
        quantity = amount((output.get('plannedAmount') or {}).get('amount'))
        status = (before.get('status') or {}).get('code')
        require(type(status) is int and status in range(6), 'status_readback_required')
        planned_start, planned_end = epoch(before.get('plannedStartTime')), epoch(before.get('plannedFinishTime'))
        started = before.get('actualStartTime', 'unverified')
        actual_start = epoch(started) if type(started) is int else None if 'actualStartTime' in before and started is None else 'unverified'
        require(identifier(output.get('materialId')) == MATERIAL_ID
            and ((output.get('material') or {}).get('baseInfo') or {}).get('code') == '0'
            and type(output.get('main')) is int and output['main'] == 1
            and (output.get('plannedAmount') or {}).get('unitName') == '个'
            and output.get('unitName') == '个', 'output_readback_mismatch')
        # Explicit null/empty fields required. Missing is not proof of omission.
        draft = (quantity == 1 and before.get('code') == CODE and before.get('identifier') == CODE
            and before.get('externalOrderCode') == CODE
            and before.get('plannedStartTime') == PAYLOAD['planStartTime']
            and before.get('plannedFinishTime') == PAYLOAD['planFinishTime']
            and type((before.get('status') or {}).get('code')) is int and before['status']['code'] == 0
            and 'actualStartTime' in before and before['actualStartTime'] is None
            and 'resource' in before and before['resource'] is None
            and 'bomId' in before and before['bomId'] is None and inputs == []
            and type(processes) is dict and processes.get('processes') == []
            and processes.get('relations') == [] and 'originalProcessRoute' in processes
            and processes['originalProcessRoute'] is None
            and 'processRouteCode' in output and output['processRouteCode'] in (None, '')
            and 'outputProcessSimpleVO' in output and output['outputProcessSimpleVO'] is None)
        effects = bool(tasks or changes or inventory != baseline['inventory'] or qc != baseline['qc'])
        defaults = {}
        for prefix, node, fields in [('base', before, ('enableSop', 'specifiedMaterial', 'useBomFlag', 'useProcessRouteFlag')),
                ('processes', processes, ('enableSop',)), ('output', output, ('warehousing', 'autoWarehousingFlag'))]:
            if type(node) is dict:
                for key in fields:
                    if key in node:
                        value = node[key]
                        defaults[prefix+'.'+key] = value if type(value) in (int, bool, type(None)) or (type(value) is str and len(value)<=40) else 'unverified'
        return {'work_order_id': work_id, 'work_order_code': CODE, 'status': status,
            'quantity': str(quantity), 'unit_name': '个', 'planned_start': planned_start,
            'planned_end': planned_end, 'actual_started_at': actual_start,
            'provider_defaults_observed': defaults, 'draft_snapshot_matches': draft,
            'task_count': len(tasks), 'inventory_change_count': len(changes),
            'inventory_changed': inventory != baseline['inventory'], 'qc_changed': qc != baseline['qc'],
            'inventory': inventory, 'qc': qc, 'effect_window_end_ms': end,
            'review_required': not draft or effects, 'global_or_delayed_effects_verified': False,
            'reported_and_inbound_totals_verified': False, 'full_material_workflow_verified': False}


def reserve(req, permit, baseline):
    require(not connection.in_atomic_block, 'committed_reservation_required')
    with transaction.atomic():
        current = MesCreateDiagnostic.objects.get(pk=req.pk)
        reviewed_permit(current)
        require(permit.current())
        changed = MesCreateDiagnostic.objects.filter(pk=req.pk, state='prepared', attempt=0,
            payload_digest=PAYLOAD_DIGEST, actor_id=ACTOR_ID).update(state='sending', attempt=1, updated_at=timezone.now())
        require(changed == 1, 'diagnostic_replay_rejected')
        MesCreateDiagnosticEvent.objects.create(request=req, state='sending', evidence={
            'reference': permit.reference, 'payload_digest': PAYLOAD_DIGEST,
            'tenant_reference': permit.tenant_reference, 'baseline': baseline})
    req.refresh_from_db()


def record(req, state, evidence, *, work_id=''):
    with transaction.atomic():
        current = MesCreateDiagnostic.objects.select_for_update().get(pk=req.pk)
        require(current.attempt == 1 and current.state != 'prepared')
        # Later empty snapshots cannot erase an already observed side effect.
        if current.state == 'review':
            state = 'review'
        if work_id:
            require(not current.mes_id or current.mes_id == work_id, 'work_order_id_mismatch')
            current.mes_id = work_id
        current.state = state
        current.save(update_fields=['state', 'mes_id', 'updated_at'])
        MesCreateDiagnosticEvent.objects.create(request=current, state=state, evidence=evidence)
    return {'state': state, 'work_order_id': current.mes_id, **evidence}


def readback(req, transport):
    exact_request(req)
    require(req.attempt == 1 and req.state in ('sending', 'uncertain', 'readback_pending', 'review', 'draft_observed'))
    event = req.events.filter(state='sending').get()
    try:
        observed = transport.observe(req, event.evidence['baseline'])
    except (MesAuthenticationExpired, MesAuthenticationRejected):
        raise  # Existing broker revokes a rejected lease; no refresh/fallback.
    except Exception as error:
        reason = error.code if isinstance(error, PlanTransportError) else 'complete_readback_required'
        return record(req, 'readback_pending', {'blocker': reason, 'effects_verified': False})
    return record(req, 'review' if observed['review_required'] else 'draft_observed', observed,
        work_id=observed['work_order_id'])


@sensitive_variables()
def run_for_session(request_uid, session, *, read_only=False, provider_factory=None, sender=None):
    """Trusted bridge only. No app issuance, session import or live activation here."""
    from django.contrib.auth import get_user_model
    from mes_oauth import vault
    from mes_oauth.inspection_credentials import call_with_user_credential
    from mes_oauth.pilot_scope import pilot_route_scope_required
    from mes_oauth.session_guard import InspectionSession
    require(type(session) is InspectionSession and not connection.in_atomic_block)
    req = MesCreateDiagnostic.objects.get(pk=request_uid)
    exact_request(req)
    require(session.actor_id == ACTOR_ID)
    permit = None if read_only else reviewed_permit(req)
    if not read_only:
        require(req.state == 'prepared' and req.attempt == 0, 'diagnostic_replay_rejected')
    else:
        require(req.attempt == 1 and req.state in ('sending', 'uncertain', 'readback_pending', 'review', 'draft_observed'),
            'unresolved_own_diagnostic_required')
    config = vault.policy()
    tenant_reference = (permit.tenant_reference if permit is not None else
        req.events.filter(state='sending').get().evidence.get('tenant_reference'))
    require(type(tenant_reference) is str and re.fullmatch(
        r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', tenant_reference),
        'diagnostic_tenant_reference_required')
    require(config.tenant == tenant_reference and vault.expected_user(ACTOR_ID) == int(MES_USER_ID))

    def policy_check():
        user = get_user_model().objects.filter(pk=ACTOR_ID).first()
        return (user is not None and user.is_active and user.is_superuser
            and not pilot_route_scope_required(user, session.claims)
            and vault.policy() == config and vault.expected_user(ACTOR_ID) == int(MES_USER_ID)
            and getattr(settings, 'MES_INSPECTION_ENABLED', False) is True
            and getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is True
            and (read_only or permit.current()))

    # Passing an explicit provider prevents the broker's ordinary issuance
    # fallback. Existing-only supply failure occurs before any reservation.
    if provider_factory is None:
        provider_factory = existing_provider_factory(ORIGIN)

    def call(operation, callback):
        return call_with_user_credential(session, mes_user_id=int(MES_USER_ID), tenant=tenant_reference,
            contract_reference='WJ-EXACT-CODE0-CREATE-DIAGNOSTIC-20261009', policy_check=policy_check,
            operation=operation, callback=callback, provider=provider_for_lease(provider_factory))

    if read_only:
        return call('read', lambda credential: readback(req, DiagnosticTransport(credential, sender=sender)))
    baseline = call('read', lambda credential: DiagnosticTransport(credential, sender=sender).baseline())
    require(policy_check(), 'current_identity_required')
    reserve(req, permit, baseline)

    def write(credential):
        current = MesCreateDiagnostic.objects.select_for_update().get(pk=req.pk)
        reviewed_permit(current)
        transport = DiagnosticTransport(credential, sender=sender)
        # Repeat immediately under the current write lease. An intervening
        # external import must not be treated as a new diagnostic creation.
        require(transport.orders() == [], 'code_already_present')
        body = transport.post('create', current.payload, req=current, permit=permit)
        return {'work_order_id': identifier((data(body) or {}).get('id'))}

    try:
        acknowledgement = call('save', write)
    except Exception:
        # The committed fence survives broker rollback, timeout and lost ACK.
        return record(req, 'uncertain', {'blocker': 'readback_required', 'effects_verified': False})
    record(req, 'readback_pending', {'acknowledged': True, 'effects_verified': False},
        work_id=acknowledgement['work_order_id'])
    req.refresh_from_db()
    try:
        return call('read', lambda credential: readback(req, DiagnosticTransport(credential, sender=sender)))
    except Exception:
        return record(req, 'readback_pending', {'blocker': 'current_authorized_read_required', 'effects_verified': False})
