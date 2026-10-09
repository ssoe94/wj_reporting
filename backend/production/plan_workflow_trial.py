"""One explicitly approved trial creation; no HTTP/worker entry point or defaults.

An operator must review the exact request and test masters and record a short
server-side MES_PLAN_TRIAL_APPROVAL. Booleans are attestations tied to that review,
not inferred provider behavior. No ordinary flag activates the writer. Existing
APP/USER credentials only; no token issuance, refresh, dispatch, start, QC or
inventory mutation. New application code/configuration is not deployed here.
"""
from dataclasses import dataclass
import hmac
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views.decorators.debug import sensitive_variables

from .models import PlanMesRequest, PlanMesRequestEvent
from .permissions import user_can_edit_plan
from .plan_workflow import (WorkflowConflict, digest, lock_type,
    claim_for_isolated_adapter, record_adapter_result, reconcile_readback)
from .plan_workflow_contract import build_contract
from .plan_workflow_credentials import existing_provider_factory, provider_for_lease

EFFECTS = ('no_dispatch', 'no_start', 'no_stock_movement', 'no_backflush', 'no_inspections')


def request_digest(req):
    return digest({'request_uid': str(req.uid), 'intent': req.intent, 'contract': req.contract})


@dataclass(frozen=True)
class TrialPermit:
    request_uid: str
    digest: str
    setting_digest: str
    reference: str
    expires_at: object
    actor_id: int
    mes_user_id: int
    origin: str
    tenant: str

    def current(self):
        return (timezone.now() < self.expires_at
            and hmac.compare_digest(self.setting_digest, digest(getattr(settings, 'MES_PLAN_TRIAL_APPROVAL', None))))

    def allows(self, transport, payload):
        if (not self.current() or transport.actor_id != self.actor_id
                or transport.credential.user_id != self.mes_user_id
                or transport.origin != self.origin or transport.tenant != self.tenant):
            return False
        req = PlanMesRequest.objects.filter(uid=self.request_uid, state='sending', actor_id=self.actor_id).first()
        return (req is not None and req.operation == 'create' and not req.blockers
            and hmac.compare_digest(self.digest, request_digest(req))
            and digest(payload) == digest(req.contract.get('payload')))


def reviewed_trial(req):
    from .plan_workflow_transport import ORIGINS
    review = getattr(settings, 'MES_PLAN_TRIAL_APPROVAL', None)
    required = {'reference', 'request_uid', 'request_digest', 'actor_id', 'mes_user_id',
        'origin', 'tenant', 'approved_at', 'expires_at', 'test_master_reference', 'side_effect_reference',
        'test_resource_code', 'test_product_code', 'quantity', 'unit_id', *EFFECTS}
    if type(review) is not dict or not required.issubset(review):
        raise WorkflowConflict('Exact trial approval required.')
    if any(type(review[key]) is not str or not review[key].strip() for key in
            ('reference', 'test_master_reference', 'side_effect_reference')):
        raise WorkflowConflict('Reviewed test masters and side effects required.')
    try:
        start, end = parse_datetime(review['approved_at']), parse_datetime(review['expires_at'])
        good_time = (start is not None and end is not None and timezone.is_aware(start)
            and timezone.is_aware(end) and start <= timezone.now() < end
            and timedelta(0) < end - start <= timedelta(minutes=30))
    except (TypeError, ValueError):
        good_time = False
    setup = req.intent.get('setup', {})
    if (not good_time or any(review[key] is not True for key in EFFECTS)
            or type(review['actor_id']) is not int or review['actor_id'] != req.actor_id
            or type(review['mes_user_id']) is not int or not 1 <= review['mes_user_id'] <= 2**63 - 1
            or review['request_uid'] != str(req.uid) or review['request_digest'] != request_digest(req)
            or review['origin'] not in ORIGINS or review['tenant'] != req.contract.get('tenant')
            or review['test_resource_code'] != setup.get('resource_code')
            or review['test_product_code'] != req.intent.get('part_no')
            or review['quantity'] != req.intent.get('quantity') or review['unit_id'] != setup.get('output_unit_id')
            or req.operation != 'create' or req.blockers or not req.contract):
        raise WorkflowConflict('Trial scope or approval changed.')
    current, blockers = build_contract(req.work_order, req.intent)
    if blockers or digest(current) != digest(req.contract):
        raise WorkflowConflict('Trial contract changed.')
    return TrialPermit(str(req.uid), request_digest(req), digest(review), review['reference'], end,
        review['actor_id'], review['mes_user_id'], review['origin'], review['tenant'])


@sensitive_variables()
def dispatch_trial_create(request_uid, session, *, provider_factory=None, sender=None):
    """Trusted server bridge. Reserve before a second credential-held write call.

    Initial credential admission performs no MES write. Its transaction commits
    before the request reservation; any later ambiguous failure leaves the
    durable reservation fenced. No automatic retry or batch trial is exposed.
    """
    from django.contrib.auth import get_user_model
    from mes_oauth import vault
    from mes_oauth.inspection_credentials import call_with_user_credential
    from mes_oauth.pilot_scope import pilot_route_scope_required
    from mes_oauth.session_guard import InspectionSession
    from .plan_workflow_transport import PlanMesTransport
    if type(session) is not InspectionSession or connection.in_atomic_block:
        raise WorkflowConflict('A current session outside a transaction is required.')
    req = PlanMesRequest.objects.select_related('work_order').get(uid=request_uid)
    permit = reviewed_trial(req)
    if req.state != 'disabled' or session.actor_id != permit.actor_id:
        raise WorkflowConflict('Trial replay or actor rejected.')
    configuration = vault.policy()
    if configuration.tenant != permit.tenant or vault.expected_user(session.actor_id) != permit.mes_user_id:
        raise WorkflowConflict('Current MES identity required.')
    def policy_check():
        user = get_user_model().objects.filter(pk=session.actor_id).first()
        return (permit.current() and user is not None and user.is_active and user.is_superuser
            and user_can_edit_plan(user, req.work_order.plan_type)
            and not pilot_route_scope_required(user, session.claims)
            and vault.policy() == configuration and vault.expected_user(user.pk) == permit.mes_user_id
            and getattr(settings, 'MES_INSPECTION_ENABLED', False) is True
            and getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is True)
    if provider_factory is None:
        # Deliberately fail before reservation if the existing supply is absent.
        # Passing a provider prevents the broker's usual APP issuance fallback.
        provider_factory = existing_provider_factory(permit.origin)
    def with_credential(operation, callback):
        return call_with_user_credential(session, mes_user_id=permit.mes_user_id, tenant=permit.tenant,
            contract_reference='WJ-PLAN-EXACT-TRIAL-20261008', policy_check=policy_check,
            operation=operation, callback=callback, provider=provider_for_lease(provider_factory))
    with_credential('read', lambda credential: {'ready': True})
    with transaction.atomic():
        lock_type(req.work_order.plan_type)
        req = PlanMesRequest.objects.select_for_update().select_related('work_order').get(uid=request_uid)
        permit = reviewed_trial(req)
        req = claim_for_isolated_adapter(req.uid, fixture=True)
        PlanMesRequestEvent.objects.create(request=req, state='sending',
            evidence={'trial_reference': permit.reference, 'approved_digest': permit.digest})
    def write(credential):
        # Hold the plan lock through IO so a concurrent upload cannot replace
        # the approved versions between final validation and transmission.
        lock_type(req.work_order.plan_type)
        current = PlanMesRequest.objects.select_for_update().select_related('work_order').get(uid=request_uid)
        reviewed_trial(current)
        for uid, version in current.intent['versions'].items():
            from .models import ProductionPlan
            if not ProductionPlan.objects.filter(work_uid=uid, work_version=version).exists():
                raise WorkflowConflict('Stale trial plan.')
        for approval_id in current.intent['approval_ids']:
            from .models import PlanMaterialApproval
            approval = PlanMaterialApproval.objects.get(pk=approval_id)
            if approval.revision.approvals.order_by('-id').first().pk != approval_id:
                raise WorkflowConflict('Trial material approval changed.')
        transport = PlanMesTransport(origin=permit.origin, tenant=permit.tenant, actor_id=permit.actor_id,
            mes_user_id=permit.mes_user_id, credential=credential, sender=sender, _trial_permit=permit)
        work_id = transport.send_create(current.contract)
        try:
            observed = transport.read_creation(current.intent, current.contract, expected_id=work_id)
        except Exception:
            observed = None
        return {'work_order_id': work_id, 'observation': observed}
    try:
        result = with_credential('save', write)
    except Exception:
        record_adapter_result(req.uid, 'unknown')
        return {'state': 'uncertain', 'blockers': ['readback_required']}
    record_adapter_result(req.uid, 'acknowledged', work_order_id=result['work_order_id'])
    if result['observation'] is None:
        return {'state': 'readback_pending', 'blockers': ['complete_creation_readback_required']}
    return {'state': reconcile_readback(req.uid, result['observation']),
        'work_order_id': result['work_order_id'], 'verified_scope': 'creation_snapshot',
        'production_totals_verified': False}
