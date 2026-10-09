"""Service APP factory creation; durable per-order fences and exact-code reads.

Only import, base list and base detail are allowed. This does not dispatch,
start, amend, report, warehouse or generate inspections. Base readback records
creation separately from the unverified material/BOM and production totals.
"""
import hmac
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.db.models import OuterRef, Subquery
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from .mes_execution_contract import encode_exact_json, parse_json_exact, mes_id
from .models import PlanMesRequest, PlanMesRequestEvent, PlanMaterialApproval, ProductionPlan, PlanWorkRevision
from .plan_workflow import WorkflowConflict, digest, lock_type, snapshot
from .plan_workflow_contract import CREATE_PATH, build_contract
from .plan_workflow_transport import ORIGINS, ROUTE_BASE, PlanTransportError
from .permissions import user_can_edit_plan

LIST_PATH = '/med/open/v2/work_order/base/_list'
BASE_PATH = '/med/open/v2/work_order/base/_detail'
READBACK_STATES = frozenset({'checking', 'sending', 'uncertain', 'readback_pending', 'review', 'failed'})


def writes_enabled():
    return getattr(settings, 'MES_PLAN_WRITES_ENABLED', False) is True


def _identifier(value):
    try:
        if type(value) not in (int, str):
            raise ValueError()
        return str(mes_id(value))
    except Exception:
        raise PlanTransportError('work_order_id_unverified') from None


@sensitive_variables()
def _body(response):
    if getattr(response, 'history', ()):
        raise PlanTransportError('redirect_rejected')
    if response.status_code == 401:
        raise PlanTransportError('app_authentication_rejected')
    if response.status_code == 403:
        raise PlanTransportError('permission_required')
    if type(response.status_code) is not int or response.status_code != 200:
        raise PlanTransportError('http_result_unverified')
    if type(response.content) is not bytes or not 1 <= len(response.content) <= 524288:
        raise PlanTransportError('response_shape_unverified')
    try:
        body = parse_json_exact(response.content)
    except Exception:
        raise PlanTransportError('response_shape_unverified') from None
    if not isinstance(body, dict):
        raise PlanTransportError('response_shape_unverified')
    if type(body.get('code')) is int and body['code'] == 401:
        raise PlanTransportError('app_authentication_rejected')
    if body.get('subCode') == 'URL_NO_PERMISSION' or body.get('code') in (403, 3500060):
        raise PlanTransportError('permission_required')
    if type(body.get('code')) is not int or body['code'] != 200:
        raise PlanTransportError('provider_result_rejected')
    if 'needCheck' in body and (type(body['needCheck']) is not int or body['needCheck'] != 0):
        raise PlanTransportError('write_confirmation_required')
    permissions = body.get('fieldPermission')
    if permissions is not None and (not isinstance(permissions, dict)
            or permissions.get('noAccess', []) != []):
        raise PlanTransportError('field_permission_required')
    return body


class PlanMesServiceTransport:
    @sensitive_variables()
    def __init__(self, *, actor_id, origin=None, token_provider=None, sender=None):
        from inventory import mes
        origin = origin or mes.MES_BASE_URL
        if (origin not in ORIGINS or type(actor_id) is not int or actor_id < 1
                or token_provider is not None and not callable(token_provider)
                or sender is not None and not callable(sender)):
            raise PlanTransportError('service_configuration_required')
        self.origin, self.actor_id = origin, actor_id
        self.token_provider = token_provider or mes.get_app_access_token
        if sender is None:
            import requests
            sender = requests.post
        self.sender = sender
        self._token = None
        self._refreshed = False
        self.attempted = False

    @sensitive_variables()
    def _credential(self, *, refresh=False):
        try:
            token = self.token_provider(force_refresh=refresh)
            if (type(token) is not str or not token or any(ord(char) <= 32 or ord(char) == 127 for char in token)):
                raise ValueError()
            self._token = token
        except Exception:
            raise PlanTransportError('service_app_unavailable') from None

    @sensitive_variables()
    def _post(self, path, payload, *, write=False):
        if path not in (LIST_PATH, BASE_PATH, CREATE_PATH) or write != (path == CREATE_PATH):
            raise PlanTransportError('route_not_supported')
        if write and not writes_enabled():
            raise WorkflowConflict('MES plan writer is disabled.')
        if self._token is None:
            self._credential()
        for attempt in range(2):
            try:
                response = self.sender(self.origin + ROUTE_BASE + path,
                    params={'access_token': self._token}, data=encode_exact_json(payload),
                    headers={'Content-Type': 'application/json'}, timeout=(3, 15 if write else 7),
                    allow_redirects=False)
                return _body(response)
            except PlanTransportError as error:
                # Only explicit 401 proves an authentication rejection. An
                # uncertain HTTP result or timeout never retries a write.
                if error.code != 'app_authentication_rejected' or self._refreshed or attempt == 1:
                    raise
                self._refreshed = True
                self._credential(refresh=True)
            except WorkflowConflict:
                raise
            except Exception:
                raise PlanTransportError('result_unverified') from None
        raise PlanTransportError('app_authentication_rejected')

    def find_by_code(self, code):
        body = self._post(LIST_PATH, {'exactWorkOrderCode': code, 'page': 1, 'size': 25})
        node = body.get('data')
        if (not isinstance(node, dict) or type(node.get('total')) is not int or node['total'] not in (0, 1)
                or type(node.get('page')) is not int or node['page'] != 1
                or not isinstance(node.get('list'), list) or len(node['list']) != node['total']):
            raise PlanTransportError('exact_code_lookup_unverified')
        if not node['list']:
            return None
        row = node['list'][0]
        if not isinstance(row, dict) or row.get('workOrderCode') != code:
            raise PlanTransportError('exact_code_lookup_unverified')
        return _identifier(row.get('workOrderId'))

    def read_base(self, code, work_order_id):
        body = self._post(BASE_PATH, {'workOrderCode': code,
            'workOrderId': mes_id(work_order_id), 'warehouseFlag': False})
        value = body.get('data')
        if (not isinstance(value, dict) or value.get('code') != code
                or _identifier(value.get('id')) != work_order_id):
            raise PlanTransportError('base_readback_unverified')
        return value

    def send_create(self, contract):
        if (self.attempted or contract.get('path') != CREATE_PATH
                or contract.get('authentication') != 'service_app' or not writes_enabled()):
            raise WorkflowConflict('Create replay or disabled writer.')
        self.attempted = True
        # Import data/id is optional in the official contract; exact code
        # lookup supplies the durable MES identity independently of the ACK.
        return self._post(CREATE_PATH, contract['payload'], write=True)


def _current(req):
    if req.operation != 'create' or req.blockers or req.work_order.mes_id:
        raise WorkflowConflict('Request cannot be created.')
    if digest(req.work_order.approved_snapshot) != digest(req.intent):
        raise WorkflowConflict('Stale work order snapshot.')
    for uid, version in req.intent['versions'].items():
        plan = ProductionPlan.objects.filter(work_uid=uid, work_version=version).first()
        if plan is None or not PlanWorkRevision.objects.filter(work_id=uid, version=version,
                fingerprint=digest(snapshot(plan)), work__active=True, work__resolution='identified').exists():
            raise WorkflowConflict('Stale plan version.')
    for approval_id in req.intent['approval_ids']:
        approval = PlanMaterialApproval.objects.select_related('revision').get(pk=approval_id)
        if (approval.revision.approvals.order_by('-id').first().pk != approval_id
                or req.intent['versions'].get(str(approval.revision.work_id)) != approval.revision.version):
            raise WorkflowConflict('Material approval changed.')
    contract, blockers = build_contract(req.work_order, req.intent)
    if blockers or not hmac.compare_digest(digest(contract), digest(req.contract)):
        raise WorkflowConflict('Request contract changed; prepare the current version.')


def _claim(uid, actor_id, *, creation=False, reservation_id=None):
    if connection.in_atomic_block:
        raise WorkflowConflict('Reservation must commit before provider IO.')
    with transaction.atomic():
        req = PlanMesRequest.objects.select_related('work_order').get(uid=uid)
        lock_type(req.work_order.plan_type)
        req = PlanMesRequest.objects.select_for_update().select_related('work_order').get(uid=uid)
        if not writes_enabled():
            raise WorkflowConflict('MES plan writer is disabled.')
        actor = get_user_model().objects.filter(pk=actor_id, is_active=True).first()
        if actor is None or not user_can_edit_plan(actor, req.work_order.plan_type):
            raise WorkflowConflict('Current plan editor required.')
        states = ('checking',) if creation else ('disabled', 'prepared', 'failed')
        if req.state not in states or req.attempt != 0:
            raise WorkflowConflict('Request cannot be replayed.')
        if creation:
            checking = req.events.filter(state='checking', evidence__create_reserved=False).order_by('-id').first()
            if checking is None or checking.pk != reservation_id:
                raise WorkflowConflict('Lookup reservation changed.')
        _current(req)
        req.state = 'sending' if creation else 'checking'
        if creation:
            req.attempt = 1
        req.save(update_fields=['state', 'attempt', 'updated_at'])
        event = PlanMesRequestEvent.objects.create(request=req, state=req.state,
            evidence={'actor_id': actor_id, 'authentication': 'service_app', 'create_reserved': creation})
        req._reservation_id = reservation_id if creation else event.pk
        return req


def _finish(req, transport, state, *, mes_id_value='', blockers=None, base=None, outcome=None):
    blockers = blockers or []
    evidence = {'actor_id': transport.actor_id, 'authentication': 'service_app',
        'outcome': outcome or state, 'mes_id': mes_id_value,
        'blockers': blockers, 'verified_scope': 'base_creation', 'material_assignment_verified': False,
        'production_totals_verified': False, 'checked_at': timezone.now().isoformat()}
    if base is not None:
        evidence['base'] = {key: base.get(key) for key in ('code', 'plannedStartTime', 'plannedFinishTime', 'status')}
    with transaction.atomic():
        lock_type(req.work_order.plan_type)
        current = PlanMesRequest.objects.select_for_update().select_related('work_order').get(pk=req.pk)
        reservation_id = getattr(req, '_reservation_id', None)
        if reservation_id is not None:
            checking = current.events.filter(state='checking', evidence__create_reserved=False).order_by('-id').first()
            if checking is None or checking.pk != reservation_id:
                return public_result(current)
        if req.attempt == 0 and current.attempt == 1:
            return public_result(current)
        # A late failed lookup must not erase a concurrently recorded success.
        if current.state in ('created', 'already_exists'):
            return public_result(current)
        if state in ('created', 'already_exists'):
            order = current.work_order
            if order.mes_id and order.mes_id != mes_id_value:
                state, blockers = 'review', ['work_order_id_mismatch']
                evidence.update(outcome='review', blockers=blockers)
            else:
                order.mes_id = mes_id_value
                order.save(update_fields=['mes_id'])
        current.state = state
        current.save(update_fields=['state', 'updated_at'])
        PlanMesRequestEvent.objects.create(request=current, state=state, evidence=evidence)
        return public_result(current)


def public_result(req):
    event = req.events.order_by('-id').first()
    evidence = event.evidence if event else {}
    return {'uid': str(req.uid), 'work_order_code': req.work_order.code, 'state': req.state,
        'mes_id': req.work_order.mes_id or evidence.get('mes_id', ''), 'attempt': req.attempt,
        'blockers': evidence.get('blockers', req.blockers),
        'verified_scope': evidence.get('verified_scope'), 'material_assignment_verified': False}


def _observe(req, transport, *, existed=False, known_id=None):
    found = known_id or transport.find_by_code(req.work_order.code)
    if found is None:
        return _finish(req, transport, 'uncertain' if req.attempt else 'failed',
            blockers=['code_not_observed_recheck_required'])
    base = transport.read_base(req.work_order.code, found)
    payload = req.contract['payload']
    status = base.get('status')
    if (base.get('plannedStartTime') != payload['planStartTime']
            or base.get('plannedFinishTime') != payload['planFinishTime']
            or not isinstance(status, dict) or type(status.get('code')) is not int
            or status['code'] not in range(6)):
        return _finish(req, transport, 'review', mes_id_value=found,
            blockers=['existing_code_snapshot_mismatch'], base=base)
    return _finish(req, transport, 'already_exists' if existed else 'created', mes_id_value=found, base=base)


def dispatch_service_create(request_uid, transport):
    if type(transport) is not PlanMesServiceTransport:
        raise WorkflowConflict('Service APP transport required.')
    req = _claim(request_uid, transport.actor_id)
    try:
        found = transport.find_by_code(req.work_order.code)
    except PlanTransportError as error:
        return _finish(req, transport, 'failed', blockers=[error.code])
    if found is not None:
        try:
            return _observe(req, transport, existed=True, known_id=found)
        except PlanTransportError as error:
            return _finish(req, transport, 'review', mes_id_value=found, blockers=[error.code])
    try:
        req = _claim(req.uid, transport.actor_id, creation=True, reservation_id=req._reservation_id)
    except WorkflowConflict:
        return _finish(req, transport, 'failed', blockers=['current_approval_or_plan_required'])
    try:
        transport.send_create(req.contract)
    except (PlanTransportError, WorkflowConflict) as error:
        if getattr(error, 'code', '') in ('write_confirmation_required', 'field_permission_required'):
            return _finish(req, transport, 'review', blockers=[error.code])
        if getattr(error, 'code', '') in ('permission_required', 'provider_result_rejected',
                'app_authentication_rejected', 'service_app_unavailable'):
            return _finish(req, transport, 'failed', blockers=[error.code])
        _finish(req, transport, 'uncertain', blockers=[getattr(error, 'code', 'readback_required')])
    try:
        return _observe(req, transport)
    except PlanTransportError as error:
        return _finish(req, transport, 'uncertain', blockers=[error.code, 'readback_required'])


def dispatch_service_batch(request_uids, transport_factory):
    if (not isinstance(request_uids, list) or not 1 <= len(request_uids) <= 50
            or not callable(transport_factory)):
        raise WorkflowConflict('Select 1–50 distinct prepared requests.')
    try:
        values = [str(uuid.UUID(value)) for value in request_uids if type(value) is str]
    except ValueError:
        raise WorkflowConflict('Invalid request UID.') from None
    if len(values) != len(request_uids) or len(set(values)) != len(values):
        raise WorkflowConflict('Duplicate or invalid request UID.')
    results = []
    for uid in values:
        try:
            result = dispatch_service_create(uid, transport_factory(uid))
        except (WorkflowConflict, PlanTransportError, PlanMesRequest.DoesNotExist):
            result = {'uid': uid, 'state': 'blocked', 'mes_id': '', 'blockers': ['request_scope_or_replay_rejected']}
        results.append(result)
    return results


def recheck_service_creation(request_uid, transport):
    checking = PlanMesRequestEvent.objects.filter(request_id=OuterRef('pk'), state='checking',
        evidence__create_reserved=False).order_by('-id').values('pk')[:1]
    # Pin state, attempt and lookup generation in one DB snapshot before IO.
    req = PlanMesRequest.objects.select_related('work_order').annotate(
        _reservation_id=Subquery(checking)).get(uid=request_uid)
    if req.operation != 'create' or req.state not in READBACK_STATES:
        raise WorkflowConflict('Only unresolved creation requests can be rechecked.')
    if req.contract.get('authentication') != 'service_app':
        return {'uid': str(req.uid), 'state': req.state, 'mes_id': req.work_order.mes_id,
            'blockers': ['current_service_contract_required']}
    try:
        return _observe(req, transport, existed=req.attempt == 0)
    except PlanTransportError as error:
        return _finish(req, transport, req.state, blockers=[error.code, 'readback_required'])
