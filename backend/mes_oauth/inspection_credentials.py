"""One same-user credential lease for a separately reviewed inspection adapter.

This neither grants QC scope nor broadens the vault's identity_read policy.
Only trusted server adapter closures may call it; no request parameter supplies
policy_check/callback/provider. No exchange, refresh or app-token fallback exists.

Failures are raised after our session transaction exits normally so a rejected
credential is wiped. If the caller owns an outer transaction, it must catch
VaultBlocked inside that transaction and commit its fixed blocked/unknown result;
rolling back that caller transaction necessarily rolls back the wipe as well.
"""
from datetime import datetime, timedelta
from dataclasses import dataclass
from decimal import Decimal
import math
import re

from django.conf import settings
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from quality.inspection_transport import (InspectionUserAccessToken, InspectionWriteAcknowledgement,
    MesAuthenticationExpired, MesAuthenticationMissing, MesAuthenticationRejected)
from . import vault
from .client import BlacklakeUserOAuthClient
from .app_tokens import AppCredentialUnavailable, get_app_access_token
from .identity import StoredIdentityRejected, verify_stored_identity_response
from .models import MESCredential
from .session_guard import InspectionSession


UNAVAILABLE = 'inspection_credential_unavailable'
POLICY = 'inspection_policy_unreviewed'
IDENTITY = 'inspection_identity_recheck_failed'
CALLBACK = 'inspection_callback_failed'
READ_AUTH = 'inspection_read_authentication_failed'
APP_CREDENTIAL = 'inspection_app_credential_unavailable'
TEMPORARY = 'inspection_identity_temporarily_unavailable'


@dataclass(frozen=True)
class ReviewedInspectionReadScope:
    actor_id: int
    mes_user_id: int
    qc_id: str
    qc_code: str
    reference: str


# The owner approved this one account/QC for detail reads. This is a server
# scope, never a client-supplied subject, write authority or general MES access.
APPROVED_QC_READ_SCOPE = ReviewedInspectionReadScope(
    18, 1733276056994641, '1791013139392836', 'QC-26100300323',
    'OWNER-QC-26100300323-READ-20261006')


class _Blocked(Exception):
    pass


def _policy(policy_check, tenant, initial=None, *, approved_read=False):
    try:
        accepted = ((getattr(settings, 'MES_INSPECTION_ENABLED', False) is True
                     or approved_read is True)
                    and policy_check() is True)
    except Exception:
        accepted = False
    if not accepted:
        raise _Blocked(POLICY)
    configuration = vault.policy()
    if configuration.tenant != tenant or (initial is not None and configuration != initial):
        raise _Blocked(POLICY)
    return configuration


def _reusable(user, row, session, mes_user_id, tenant, configuration):
    if (row is None or row.actor_id != session.actor_id
            or (configuration.reuse.credential_scope == 'login'
                and row.login_digest != session.login_digest)
            or row.mes_user_id != str(mes_user_id) or row.tenant_reference != tenant
            or vault.expected_user(user.pk) != mes_user_id
            or vault.decision(user, row, session.login_digest, configuration).action != 'reuse_candidate'):
        raise _Blocked(UNAVAILABLE)
    deadline = min(row.expires_at, row.idle_expires_at, row.provider_expires_at,
                   row.consent_expires_at, session.effective_expires_at or session.expires_at)
    if timezone.now() + timedelta(seconds=configuration.reuse.safety_seconds) >= deadline:
        raise _Blocked(UNAVAILABLE)
    return deadline


@sensitive_variables()
def _safe_result(result, token):
    """Refuse credential objects/bytes and accidental token echoes in results."""
    if type(result) is InspectionWriteAcknowledgement:
        return (type(result.accepted_stages) is int and result.accepted_stages >= 0
                and type(result.completion_confirmed) is bool)
    if type(result) is not dict:
        return False
    pending, visited = [(result, 0)], 0
    while pending:
        value, depth = pending.pop()
        visited += 1
        if depth > 20 or visited > 10000:
            return False
        if type(value) is str:
            if token in value:
                return False
        elif type(value) is dict:
            if any(type(key) is not str or token in key for key in value):
                return False
            pending.extend((item, depth + 1) for item in value.values())
        elif type(value) in (list, tuple):
            pending.extend((item, depth + 1) for item in value)
        elif type(value) is float:
            if not math.isfinite(value):
                return False
        elif type(value) is Decimal:
            if not value.is_finite():
                return False
        elif type(value) not in (int, bool, type(None), datetime):
            return False
    return True


@sensitive_variables()
def call_with_user_credential(session, *, mes_user_id, tenant, contract_reference,
                              policy_check, operation, callback, provider=None,
                              approved_read_scope=None):
    """Verify the stored user token, then invoke one reviewed adapter callback.

Returns only a checked dictionary or InspectionWriteAcknowledgement. A callback
error never causes a retry; the caller must preserve an uncertain write outcome.
Read admission requires view authority; save/finish require submit authority.
"""
    if (type(session) is not InspectionSession or type(mes_user_id) is not int
            or not 1 <= mes_user_id <= 2**63 - 1 or type(tenant) is not str
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', tenant)
            or type(contract_reference) is not str
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', contract_reference)
            or type(operation) is not str or operation not in {'read', 'save', 'finish'}
            or not callable(policy_check) or not callable(callback)):
        raise vault.VaultBlocked(POLICY) from None
    approved_read = False
    if approved_read_scope is not None:
        if (type(approved_read_scope) is not ReviewedInspectionReadScope
                or approved_read_scope is not APPROVED_QC_READ_SCOPE
                or operation != 'read'
                or session.actor_id != APPROVED_QC_READ_SCOPE.actor_id
                or mes_user_id != APPROVED_QC_READ_SCOPE.mes_user_id
                or contract_reference != APPROVED_QC_READ_SCOPE.reference):
            raise vault.VaultBlocked(POLICY) from None
        approved_read = True
    permission = 'view' if operation == 'read' else 'submit'
    failure, result, callback_entered = None, None, False
    try:
        with session.lock(permission, actor_id=session.actor_id,
                          require_mapping=True, mes_actor=mes_user_id) as user:
            try:
                configuration = _policy(policy_check, tenant, approved_read=approved_read)
                row = MESCredential.objects.select_for_update().filter(pk=session.actor_id).first()
                _reusable(user, row, session, mes_user_id, tenant, configuration)
                try:
                    try:
                        token = vault._open(row)
                    except vault.VaultBlocked:
                        raise StoredIdentityRejected('credential_unreadable') from None
                    loader = provider if provider is not None else BlacklakeUserOAuthClient(
                        origin=settings.MES_USER_OAUTH_PROVIDER_ORIGIN,
                        app_access_token=get_app_access_token(),
                        app_token_header=getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token'))
                    verify_stored_identity_response(loader.userinfo(token), mes_user_id)
                except AppCredentialUnavailable:
                    # App supply failed before userinfo. Reconnecting the user
                    # cannot repair this and must not erase their valid lease.
                    failure = APP_CREDENTIAL
                except StoredIdentityRejected:
                    vault._clear(row, IDENTITY)
                    failure = IDENTITY
                except Exception:
                    failure = TEMPORARY
                else:
                    # Fresh actor/permission/login checks after external I/O.
                    # Keep the original outer user/login/credential locks held.
                    with session.lock(permission, actor_id=session.actor_id,
                                      require_mapping=True, mes_actor=mes_user_id) as user:
                        configuration = _policy(policy_check, tenant, configuration,
                                                approved_read=approved_read)
                        _reusable(user, row, session, mes_user_id, tenant, configuration)
                        configuration = _policy(policy_check, tenant, configuration,
                                                approved_read=approved_read)
                        deadline = _reusable(user, row, session, mes_user_id, tenant, configuration)
                        lease = InspectionUserAccessToken(token, deadline.timestamp(), user_id=mes_user_id)
                        try:
                            callback_entered = True
                            result = callback(lease)
                            if not _safe_result(result, token):
                                raise _Blocked(CALLBACK)
                            row.last_used_at = timezone.now()
                            row.idle_expires_at = min(row.expires_at,
                                row.last_used_at + timedelta(seconds=configuration.reuse.idle_seconds))
                            vault._seal(row, token)
                            row.save(update_fields=['last_used_at', 'idle_expires_at', 'key_id', 'ciphertext'])
                            vault._event(user.pk, operation, 'inspection_identity_verified')
                        except (MesAuthenticationExpired, MesAuthenticationMissing, MesAuthenticationRejected):
                            # Only the separately scoped read callback can prove
                            # it made no write. The stage coordinator still keeps
                            # a preceding writer's outcome unknown on readback.
                            failure, result = CALLBACK, None
                            if operation == 'read':
                                vault._clear(row, READ_AUTH)
                                failure = READ_AUTH
                        except Exception:
                            failure, result = CALLBACK, None
                        finally:
                            del lease
                finally:
                    # Drop our references; Python does not promise memory zeroing.
                    token = None
            except _Blocked as error:
                failure = CALLBACK if callback_entered else str(error)
            except Exception:
                failure = CALLBACK if callback_entered else UNAVAILABLE
    except Exception:
        # A save/finish may already have reached MES even when our transaction
        # later fails to commit. Never classify that as a safe pre-dispatch stop.
        failure = CALLBACK if callback_entered else UNAVAILABLE
    if failure:
        raise vault.VaultBlocked(failure) from None
    return result
