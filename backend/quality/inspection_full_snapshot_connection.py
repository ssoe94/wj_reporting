"""Explicit server-owned full-snapshot connection; no default live policy.

Reads use an existing USER credential and a reuse-only APP identity provider.
The inspected Blacklake record API has no conditional-write field. A narrowly
reviewed standalone trial can accept its remaining external race explicitly;
this operational admission never represents atomic CAS or a provider lock.
"""
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import datetime, timezone as utc
import json

from .inspection_full_snapshot import (
    OWNER, CredentialGuardFailure, FullSnapshotCoordinator, FullSnapshotError,
    _check, binding_fingerprint, fingerprint, remote_fingerprint, verify_readback,
)
from .inspection_full_snapshot_readback import decode_full_detail, decode_production_full_detail


@dataclass(frozen=True)
class ReviewedFullSnapshotConnection:
    request_id: int
    actor_id: int
    reviewer_actor_id: int
    tenant: str
    mes_user_id: int
    qc_id: str
    qc_code: str
    snapshot_id: str
    binding_digest: str
    source_digest: str
    source_request_version: int
    expires_at: datetime
    review_reference: str
    detail_review: object = field(repr=False)
    origin: str = 'https://v3-ali.blacklake.cn'
    app_token_header: str = 'access_token'
    write_authorized: bool = False
    concurrency_mode: str = 'unverified'
    concurrency_reference: str = ''
    residual_remote_race: bool = True
    operational_conditions_reference: str = ''
    source_mode: str = 'independent_approval'
    preserves_existing_records: bool = False

    def matches(self, request, binding):
        return bool(isinstance(self.expires_at, datetime) and self.expires_at.utcoffset() is not None
            and datetime.now(utc.utc) < self.expires_at and request.pk == self.request_id
            and binding.request_id == request.pk and binding.tenant == self.tenant
            and binding.qc_id == self.qc_id and self.snapshot_id == str(binding.contract.get('snapshot_id'))
            and str(self.mes_user_id) == str(binding.contract.get('actor_id'))
            and binding_fingerprint(binding) == self.binding_digest
            and self.detail_review.qc_code == self.qc_code)


class BlacklakeFullSnapshotAdapter:
    def __init__(self, policy, *, session, sender=None, credential_call=None,
                 identity_provider=None, executor_guard=None, atomic_writer=None, external_fence=None):
        from .inspection_full_snapshot_authority import CurrentExecutorGuard, ReuseOnlyIdentityProvider
        from .inspection_live_adapter import _user_sender
        from mes_oauth.inspection_credentials import call_with_user_credential
        self.policy, self.session = policy, session
        self.sender = sender or _user_sender
        self.credential_call = credential_call or call_with_user_credential
        self.identity_provider = identity_provider or ReuseOnlyIdentityProvider(policy)
        self.executor_guard = executor_guard or CurrentExecutorGuard(policy, session,
            credential_call=self.credential_call, provider=self.identity_provider)
        self.atomic_writer, self.external_fence = atomic_writer, external_fence
        self.concurrency_mode = policy.concurrency_mode
        self.enabled = bool(policy.write_authorized is True and (
            (self.concurrency_mode == 'provider_cas' and callable(atomic_writer))
            or (self.concurrency_mode == 'exclusive_writer' and callable(external_fence))
            or (self.concurrency_mode == 'reviewed_single_writer_trial'
                and policy.residual_remote_race is True and policy.operational_conditions_reference)))

    def validate_save_baseline(self, binding, intent):
        # The documented payload cannot set record IDs/authors/timestamps.
        # A nonempty collection therefore needs separately observed preservation
        # semantics; no local lock or successful acknowledgement proves them.
        _check(not intent['baseline']['records']
               or self.policy.preserves_existing_records is True,
               'mes_existing_result_preservation_unverified')

    def _call(self, binding, operation, callback):
        from mes_oauth import vault
        _check(self.session.actor_id == self.policy.actor_id
               and self.policy.matches(binding.request, binding), 'connection_policy_changed')
        if operation != 'read':
            _check(self.enabled and self.policy.write_authorized is True, 'full_write_unapproved')
        try:
            return self.credential_call(self.session, mes_user_id=self.policy.mes_user_id,
                tenant=self.policy.tenant, contract_reference=self.policy.review_reference,
                policy_check=lambda: self._policy_check(binding, operation),
                operation=operation, callback=callback, provider=self.identity_provider)
        except vault.VaultBlocked:
            raise CredentialGuardFailure('full_snapshot_credential_blocked') from None

    def _policy_check(self, binding, stage):
        from django.contrib.auth import get_user_model
        request, current = self._locked_target(binding)
        actor = get_user_model().objects.get(pk=self.policy.actor_id)
        return self.executor_guard.check_current(actor, request, current, stage) is True

    def _locked_target(self, binding):
        from .inspection_models import InspectionMesBinding, InspectionRequest
        from .inspection_workflow import lock_scope
        lock_scope(f'inspection:{binding.request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=binding.request_id)
        current = InspectionMesBinding.objects.select_for_update().get(request=request)
        _check(self.policy.matches(request, current), 'connection_policy_changed')
        return request, current

    def _read_with_token(self, binding, token):
        from django.utils import timezone
        from .inspection_transport import InspectionUserAccessToken
        _check(type(token) is InspectionUserAccessToken and token.user_id == self.policy.mes_user_id
               and token.expires_at > timezone.now().timestamp(), 'mes_executor_mismatch')
        response = self.sender(self.policy.origin + '/api/openapi/domain/web/v1/route/quality/open/v1/task/_detail',
            params={'access_token': token.value}, data=json.dumps({'id': int(binding.qc_id)}),
            headers={'Content-Type':'application/json'}, timeout=(5,20), allow_redirects=False)
        _check(response.status_code == 200, 'mes_detail_unverified')
        decoder = (decode_production_full_detail
                   if binding.contract.get('context') == 'production_qc' else decode_full_detail)
        return decoder(response.content.decode('utf-8'), binding=binding,
                                review=self.policy.detail_review, observed_at=timezone.now())

    def read(self, binding, authority):
        self._authority_matches(authority)
        def perform(token):
            _, current = self._locked_target(binding)
            return self._read_with_token(current, token)
        return self._call(binding, 'read', perform)

    def _authority_matches(self, authority):
        _check(authority.actor_id == self.policy.actor_id and authority.tenant == self.policy.tenant
               and authority.qc_id == self.policy.qc_id and authority.snapshot_id == self.policy.snapshot_id
               and authority.mes_user_id == str(self.policy.mes_user_id)
               and authority.expires_at > datetime.now(utc.utc), 'executor_authority_mismatch')

    def _guarded(self, binding, intent, expected, operation_id, authority, stage):
        from .inspection_models import InspectionOperation
        from .inspection_full_snapshot_source import DjangoCompletedSource
        from .inspection_transport import (BlacklakeInspectionTransport, ReviewedWriteAuthorization,
            ReviewedFinishAuthorization, stages_digest)
        from .inspection_blacklake_contract import result_and_finish_plan
        self._authority_matches(authority)
        _check(self.enabled and self.policy.write_authorized is True, 'full_write_unapproved')
        if stage == 'save':
            self.validate_save_baseline(binding, intent)
        def perform(token):
            request, current = self._locked_target(binding)
            op = InspectionOperation.objects.select_for_update().get(pk=operation_id, request=request)
            _check(op.status == 'pending' and op.response.get('owner') == OWNER
                   and op.response.get('state') == 'dispatch_claimed' and op.response.get('stage') == stage
                   and op.response.get('executor_actor_id') == self.policy.actor_id
                   and fingerprint(op.response['intent']) == fingerprint(intent)
                   and expected == intent['remote_fingerprint'], 'dispatch_scope_changed')
            _check(current.phase == f'full_{stage}_pending', 'binding_phase_changed')
            FullSnapshotCoordinator._same_source(DjangoCompletedSource.capture(request), request.version,
                                                op.response['reserved_version'], intent)
            if self.concurrency_mode == 'reviewed_single_writer_trial':
                _check(current.test_only is True and current.work_order_id == ''
                       and current.contract.get('context') == 'standalone_test'
                       and self.policy.residual_remote_race is True
                       and bool(self.policy.operational_conditions_reference), 'trial_conditions_unreviewed')
            fence = self.external_fence(current, authority) if self.concurrency_mode == 'exclusive_writer' else nullcontext()
            with fence:
                before = self._read_with_token(current, token)
                _check(remote_fingerprint(before) == expected, 'mes_concurrent_change')
                _check(self._policy_check(current, stage), 'connection_policy_changed')
                if stage == 'finish':
                    verified = verify_readback(intent, before, stage='save')
                    _check(verified['records'] == op.response['previous_readback']['records'],
                           'mes_result_provenance_changed')
                stages = result_and_finish_plan(current.qc_id, intent['payload']['checkItems'], verdict=intent['verdict'])
                if self.concurrency_mode == 'provider_cas':
                    return self.atomic_writer(current, stages, stage, expected, operation_id, token)
                # No conditional-write field exists in these reviewed bytes.
                # Only explicitly accepted standalone operating conditions can
                # admit the remaining external read→write race without a fence.
                transport = BlacklakeInspectionTransport(None, qc_task_id=current.qc_id,
                    origin=self.policy.origin, token_provider=lambda: token, sender=self.sender,
                    standalone_test=True, write_authorization=ReviewedWriteAuthorization(
                        current.qc_id, stages_digest(stages), self.policy.review_reference))
                if stage == 'save':
                    return transport.send_reviewed_record(stages)
                authorization = ReviewedFinishAuthorization(current.qc_id, stages_digest(stages),
                    self.policy.review_reference, 'saved', self.policy.mes_user_id, token.user_id,
                    remote_fingerprint(before), datetime.fromisoformat(before['observed_at']).timestamp())
                return transport.send_reviewed_finish(stages, authorization=authorization)
        return self._call(binding, stage, perform)

    def guarded_save(self, binding, intent, expected, operation_id, authority):
        return self._guarded(binding, intent, expected, operation_id, authority, 'save')

    def guarded_finish(self, binding, intent, expected, operation_id, authority):
        return self._guarded(binding, intent, expected, operation_id, authority, 'finish')
