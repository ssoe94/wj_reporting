"""Current executor checks for the separately reviewed full-snapshot protocol.

This module installs no route, policy, permission or credential issuer. The
trusted server caller supplies the exact reviewed policy and a real version-2
InspectionSession. Acquire ``guard.lock()`` before the common request lock;
then pass the freshly locked request/binding to the guard. The transport must
repeat these checks inside its credential callback and keep that lease/session
held through readback and dispatch. An authority is not a bearer credential.

Completed source requires UI0015 provenance. Missing fields/authorship are a
blocking condition, never reconstructed from current users. Existing request
approval is distinct from this server-reviewed delivery policy.

The credential broker may clear a rejected USER credential. A coordinator with
an outer transaction must catch failures inside that transaction and commit its
fixed blocked/unknown outcome; rolling back also rolls back the credential wipe.
"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import math
import re

from django.conf import settings
from django.contrib.auth import get_user_model
from django.views.decorators.debug import sensitive_variables

from mes_oauth.app_tokens import get_existing_app_access_token
from mes_oauth.client import APP_TOKEN_HEADERS, ORIGINS, BlacklakeUserOAuthClient
from mes_oauth.inspection_credentials import call_with_user_credential
from mes_oauth.session_guard import InspectionSession
from mes_oauth.vault import VaultBlocked

from .inspection_full_snapshot import (CredentialGuardFailure, ExecutorAuthority, FullSnapshotError,
                                      fingerprint, validate_source)
from .inspection_full_snapshot_source import DjangoCompletedSource
from .inspection_transport import InspectionUserAccessToken


def _require(condition, code):
    if not condition:
        raise FullSnapshotError(code)


def _mes_id(value):
    _require(type(value) is str and 1 <= len(value) <= 19 and value.isascii() and value.isdigit()
             and 0 < int(value) < 2**63 and str(int(value)) == value,
             'executor_policy_invalid')
    return int(value)


def _reference(value):
    _require(type(value) is str
             and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', value) is not None,
             'executor_policy_invalid')
    return value


class ReuseOnlyIdentityProvider:
    """One identity read using the existing APP cache; never issues or retries."""

    def __init__(self, policy):
        self.origin = getattr(policy, 'origin', None)
        self.app_token_header = getattr(policy, 'app_token_header', None)

    def _configuration(self):
        _require(type(self.origin) is str and self.origin in ORIGINS
                 and self.origin == getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', None)
                 and type(self.app_token_header) is str and self.app_token_header in APP_TOKEN_HEADERS
                 and self.app_token_header == getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token'),
                 'executor_provider_configuration_changed')

    @sensitive_variables()
    def userinfo(self, token):
        self._configuration()
        # A cache miss propagates. Do not call a general token supplier, exchange,
        # refresh, default broker provider or alternate origin/header here.
        client = BlacklakeUserOAuthClient(
            origin=self.origin,
            app_access_token=get_existing_app_access_token(),
            app_token_header=self.app_token_header,
        )
        return client.userinfo(token)


class CurrentExecutorGuard:
    """Same-current-user authority, checked again for replay/reconciliation.

    ``policy.matches(request, binding)`` must verify the reviewed target/binding
    and expiry. Source content is checked here independently, normalizing only
    the coordinator's request-version reservation to source_request_version.
    Injected broker/provider objects are trusted server dependencies for tests,
    never values accepted from an HTTP request.
    """

    def __init__(self, policy, session, *, credential_call=call_with_user_credential,
                 provider=None):
        self.policy = policy
        self.session = session
        self.credential_call = credential_call
        self.provider = provider if provider is not None else ReuseOnlyIdentityProvider(policy)

    def _identity(self, actor, stage):
        policy = self.policy
        _require(stage in {'read', 'save', 'finish', 'submit'}, 'invalid_stage')
        _require(type(self.session) is InspectionSession
                 and type(self.session.version) is int and self.session.version == 2
                 and type(self.session.actor_id) is int
                 and type(getattr(actor, 'pk', None)) is int
                 and type(getattr(policy, 'actor_id', None)) is int
                 and actor.pk == policy.actor_id == self.session.actor_id,
                 'executor_session_mismatch')
        mes_user_id = getattr(policy, 'mes_user_id', None)
        _require(type(mes_user_id) is int and 0 < mes_user_id < 2**63,
                 'executor_policy_invalid')
        _require(isinstance(getattr(policy, 'expires_at', None), datetime)
                 and policy.expires_at.utcoffset() is not None
                 and policy.expires_at > datetime.now(timezone.utc),
                 'executor_policy_expired')
        if stage != 'read':
            _require(getattr(policy, 'write_authorized', False) is True,
                     'executor_write_not_authorized')
        _require(callable(self.credential_call)
                 and callable(getattr(self.provider, 'userinfo', None)),
                 'executor_credential_unavailable')
        _require(getattr(policy, 'origin', None) == getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', None)
                 and type(getattr(policy, 'origin', None)) is str and policy.origin in ORIGINS
                 and getattr(policy, 'app_token_header', None) == getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token')
                 and type(policy.app_token_header) is str and policy.app_token_header in APP_TOKEN_HEADERS,
                 'executor_provider_configuration_changed')
        if type(self.provider) is ReuseOnlyIdentityProvider:
            _require(self.provider.origin == policy.origin
                     and self.provider.app_token_header == policy.app_token_header,
                     'executor_provider_configuration_changed')
        return mes_user_id

    @contextmanager
    def lock(self, actor, stage):
        """Enter before inspection:<id>/request locks to keep user-first order."""
        mes_user_id = self._identity(actor, stage)
        permission = 'view' if stage == 'read' else 'submit'
        with self.session.lock(permission, actor_id=actor.pk,
                               require_mapping=True, mes_actor=mes_user_id) as current:
            self._identity(current, stage)
            yield current

    def _reviewed_source(self, request):
        source, _ = validate_source(DjangoCompletedSource.capture(request))
        _require(source['request_version'] == request.version,
                 'source_changed')
        original_version = getattr(self.policy, 'source_request_version', None)
        _require(type(original_version) is int and 0 < original_version <= request.version,
                 'executor_policy_invalid')
        normalized = deepcopy(source)
        normalized['request_version'] = original_version
        _require(fingerprint(normalized) == getattr(self.policy, 'source_digest', None),
                 'source_changed')
        return source

    @staticmethod
    def _contributors(source):
        actors = set()
        for area in source['areas']:
            if area['assigned'].get('kind', 'wj_actor') == 'wj_actor':
                actors.add(area['assigned']['id'])
            if area['completion']['inspector'].get('kind', 'wj_actor') == 'wj_actor':
                actors.add(area['completion']['inspector']['id'])
            actors.add(area['completion']['recorder']['id'])
            for author in area['authorship'].values():
                if author.get('inspector_kind', 'wj_actor') == 'wj_actor':
                    actors.add(author['inspector_id'])
                actors.add(author['recorded_by_id'])
        actors.update(row['actor_id'] for row in source['historical_contributors'])
        return actors

    def _check_policy(self, current, request, binding, stage):
        from .inspection_access import require_owned_request
        from .inspection_workflow import require

        self._identity(current, stage)
        policy = self.policy
        _reference(getattr(policy, 'tenant', None))
        _reference(getattr(policy, 'review_reference', None))
        if stage != 'read':
            _reference(getattr(policy, 'concurrency_reference', None))
        else:
            _require(type(getattr(policy, 'concurrency_reference', None)) is str,
                     'executor_policy_invalid')
        _mes_id(getattr(policy, 'qc_id', None))
        _mes_id(getattr(policy, 'snapshot_id', None))
        mode = getattr(policy, 'concurrency_mode', None)
        _require(type(mode) is str
                 and mode in ({'unverified', 'provider_cas', 'exclusive_writer', 'reviewed_single_writer_trial'}
                              if stage == 'read' else {'provider_cas', 'exclusive_writer', 'reviewed_single_writer_trial'})
                 and type(getattr(policy, 'residual_remote_race', None)) is bool
                 and type(getattr(policy, 'operational_conditions_reference', None)) is str,
                 'executor_policy_invalid')
        if mode == 'reviewed_single_writer_trial':
            _reference(policy.operational_conditions_reference)
            _require(policy.residual_remote_race is True and binding.test_only is True
                     and binding.work_order_id == '' and type(binding.contract) is dict
                     and binding.contract.get('context') == 'standalone_test',
                     'remote_concurrency_unverified')
        _require(binding.request_id == request.pk
                 and binding.tenant == policy.tenant and binding.qc_id == policy.qc_id
                 and type(binding.contract) is dict
                 and str(binding.contract.get('snapshot_id')) == policy.snapshot_id
                 and str(binding.contract.get('actor_id')) == str(policy.mes_user_id)
                 and callable(getattr(policy, 'matches', None))
                 and policy.matches(request, binding) is True,
                 'executor_policy_changed')
        require_owned_request(current, request)
        source = self._reviewed_source(request)
        reviewer_id = getattr(policy, 'reviewer_actor_id', None)
        if source['request_status'] == 'approved':
            _require(request.reviewed_by_id == reviewer_id
                     and source['approval']['reviewer']['id'] == reviewer_id
                     and binding.reviewed_result_digest == source['approval']['result_digest'],
                     'independent_approval_changed')
        _require(type(reviewer_id) is int and reviewer_id > 0
                 and reviewer_id != current.pk
                 and reviewer_id != request.submitted_by_id
                 and reviewer_id not in self._contributors(source),
                 'independent_reviewer_required')
        # Fresh permission objects avoid Django's cached user permission sets.
        # Do not acquire a second actor lock after the common request lock.
        reviewer = get_user_model().objects.using(request._state.db).filter(pk=reviewer_id).first()
        _require(reviewer is not None and reviewer.is_active is True,
                 'independent_reviewer_unavailable')
        try:
            require(reviewer, 'review')
        except Exception:
            raise FullSnapshotError('independent_reviewer_unavailable') from None
        try:
            from .inspection_roles import is_area_contributor
        except ImportError:
            raise FullSnapshotError('provenance_schema_unavailable') from None
        _require(not is_area_contributor(request, reviewer), 'independent_reviewer_required')
        return True

    def check_current(self, actor, request, binding, stage):
        """Repeat local authority under an already-held transport lease.

        The caller supplies freshly locked request/binding rows and already
        holds the executor's outer credential/session lock before those rows.
        This method never opens a credential or makes an identity/network call.
        Use it after identity I/O and immediately before fresh detail/dispatch.
        """
        with self.lock(actor, stage) as current:
            return self._check_policy(current, request, binding, stage)

    @sensitive_variables()
    def __call__(self, actor, request, binding, stage):
        _require(stage in {'read', 'save', 'finish'}, 'invalid_stage')
        failure, result, authority = None, None, None
        with self.lock(actor, stage) as current:
            self._check_policy(current, request, binding, stage)

            def accepted():
                return self._check_policy(current, request, binding, stage)

            @sensitive_variables()
            def checked_identity(lease):
                _require(type(lease) is InspectionUserAccessToken
                         and type(lease.user_id) is int
                         and lease.user_id == self.policy.mes_user_id
                         and type(lease.expires_at) in (int, float)
                         and math.isfinite(lease.expires_at),
                         'executor_identity_mismatch')
                self._check_policy(current, request, binding, stage)
                deadline = datetime.fromtimestamp(lease.expires_at, timezone.utc)
                _require(deadline > datetime.now(timezone.utc), 'executor_credential_expired')
                # No credential bytes/provider response are copied or returned.
                return {'_mes_user_id': str(lease.user_id), 'expires_at': deadline.isoformat()}

            try:
                result = self.credential_call(
                    self.session,
                    mes_user_id=self.policy.mes_user_id,
                    tenant=self.policy.tenant,
                    contract_reference=self.policy.review_reference,
                    policy_check=accepted,
                    operation=stage,
                    callback=checked_identity,
                    provider=self.provider,
                )
            except VaultBlocked:
                # Exit our session transaction normally before raising. The
                # coordinator still owns any encompassing transaction boundary.
                failure = 'full_snapshot_credential_blocked'
            if failure is None:
                _require(type(result) is dict and set(result) == {'_mes_user_id', 'expires_at'}
                         and result['_mes_user_id'] == str(self.policy.mes_user_id)
                         and type(result['expires_at']) is str,
                         'executor_identity_mismatch')
                try:
                    credential_deadline = datetime.fromisoformat(result['expires_at'])
                except ValueError:
                    raise FullSnapshotError('executor_credential_expired') from None
                _require(credential_deadline.utcoffset() is not None,
                         'executor_credential_expired')
                self._check_policy(current, request, binding, stage)
                deadline = min(self.policy.expires_at, credential_deadline,
                               self.session.effective_expires_at or self.session.expires_at)
                _require(deadline > datetime.now(timezone.utc), 'executor_credential_expired')
                authority = ExecutorAuthority(
                    actor_id=current.pk,
                    mes_user_id=str(self.policy.mes_user_id),
                    tenant=self.policy.tenant,
                    qc_id=self.policy.qc_id,
                    snapshot_id=self.policy.snapshot_id,
                    expires_at=deadline,
                    review_reference=self.policy.review_reference,
                    concurrency_reference=self.policy.concurrency_reference,
                    concurrency_mode=self.policy.concurrency_mode,
                    residual_remote_race=self.policy.residual_remote_race,
                    operational_conditions_reference=self.policy.operational_conditions_reference,
                )
        if failure is not None:
            raise CredentialGuardFailure(failure) from None
        return authority
