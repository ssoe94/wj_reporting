"""Production-specific admission around the existing same-user lease broker.

No default token, APP issuance, identity-provider fallback or QC authority
promotion exists. Runtime activation must supply independent production role
evidence, an exact reviewed scope and an already configured identity reader.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta

from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from mes_oauth.inspection_credentials import call_with_user_credential
from mes_oauth.pilot_scope import pilot_route_scope_required
from mes_oauth.session_guard import InspectionSession

from .mes_delivery import ReviewedDeliveryScope, WRITE_STAGES
from .mes_delivery_transport import MesDeliveryUserTransport, ReviewedDeliveryAuthorization, digest_payload


@dataclass(frozen=True)
class VerifiedProductionAuthority:
    actor_id: int
    mes_user_id: int
    tenant: str
    verification_reference: str
    evidence_digest: str
    observed_at: datetime
    allowed_actions: frozenset


class ScopedProductionWriter:
    """Trusted server callback for the coordinator; never constructed from HTTP.

    The reusable inspection broker supplies login/credential identity checks as
    an additional constraint. Its submit permission alone grants no production
    action. This wrapper verifies independent exact production authority first.
    """
    def __init__(self, scope, *, session, authority_reader, identity_provider, origin, sender=None):
        if (type(scope) is not ReviewedDeliveryScope or type(session) is not InspectionSession
                or not callable(authority_reader) or identity_provider is None
                or not callable(getattr(identity_provider, 'userinfo', None))):
            raise PermissionDenied('Production authority and explicit identity readers are required.')
        self.scope, self.session = scope, session
        self.authority_reader, self.identity_provider = authority_reader, identity_provider
        self.origin, self.sender, self._transport = origin, sender, None

    @property
    def dispatched(self):
        return bool(self._transport and self._transport.dispatched is True)

    @property
    def status_flag(self):
        return self._transport.status_flag if self._transport else 'not_dispatched'

    def consume_readback_allowance(self):
        return bool(self._transport and self._transport.consume_readback_allowance())

    def _policy(self, action, payload):
        try:
            self.scope.require_current(action, payload)
            evidence = self.authority_reader(self.scope)
            now = timezone.now()
            return (type(evidence) is VerifiedProductionAuthority
                and type(evidence.actor_id) is int and type(evidence.mes_user_id) is int
                and evidence.actor_id == self.scope.actor_id
                and evidence.mes_user_id == self.scope.mes_user_id
                and evidence.tenant == self.scope.intent.tenant
                and evidence.verification_reference == self.scope.verification_reference
                and evidence.evidence_digest == self.scope.authority_evidence_digest
                and type(evidence.observed_at) is datetime and timezone.is_aware(evidence.observed_at)
                and now - timedelta(minutes=5) <= evidence.observed_at <= now
                and type(evidence.allowed_actions) is frozenset
                and action in evidence.allowed_actions and evidence.allowed_actions <= WRITE_STAGES)
        except Exception:
            return False

    def __call__(self, action, payload, scope):
        # Reset observable dispatch state before any admission failure so that
        # an earlier action cannot turn a later pre-dispatch failure into unknown.
        self._transport = None
        if scope is not self.scope or not self._policy(action, payload):
            raise PermissionDenied('The exact production action is not authorized.')
        failure, result = None, None
        with self.session.lock('submit', actor_id=self.scope.actor_id,
                               require_mapping=True, mes_actor=self.scope.mes_user_id) as user:
            if not user.is_active or not user.is_superuser or pilot_route_scope_required(user, self.session.claims):
                raise PermissionDenied('Unrestricted current production authority is required.')
            self._transport = MesDeliveryUserTransport(
                origin=self.origin, actor_id=self.scope.actor_id,
                tenant=self.scope.intent.tenant, work_order_code=self.scope.intent.work_order_code,
                expected_mes_user_id=self.scope.mes_user_id, sender=self.sender)
            authorization = ReviewedDeliveryAuthorization(
                actor_id=self.scope.actor_id, tenant=self.scope.intent.tenant,
                work_order_code=self.scope.intent.work_order_code, action=action,
                payload_sha=digest_payload(payload),
                verification_reference=self.scope.verification_reference,
                expires_at=self.scope.expires_at.timestamp())
            try:
                result = call_with_user_credential(self.session,
                    mes_user_id=self.scope.mes_user_id, tenant=self.scope.intent.tenant,
                    contract_reference=self.scope.verification_reference,
                    policy_check=lambda: self._policy(action, payload), operation='save',
                    callback=lambda credential: self._transport.call(action, payload, authorization, credential),
                    provider=self.identity_provider)
            except Exception as error:
                # The broker may have cleared a provider-rejected credential.
                # Commit that clear through our outer guard before rethrowing.
                # The coordinator catches this inside its own guard as well.
                failure = error
        if failure is not None:
            raise failure from None
        return result
