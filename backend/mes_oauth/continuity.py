"""Disconnected, metadata-only decisions for a future MES credential vault.

No token, credential storage, HTTP, refresh, logout hook or endpoint lives here.
Inputs must be constructed from trusted server authentication/configuration and
vault metadata, never from browser claims. A reuse candidate still requires a
reviewed vault and operation adapter; it is not permission to call MES or QC.
Credential storage and callback behavior are outside this module.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re


class ContinuityBlocked(Exception):
    """Fixed reason only, never provider values or credentials."""


@dataclass(frozen=True)
class ExpiryContract:
    # Explicit semantics require provider review. conservative_minimum requires
    # review of the seconds unit and local two-interpretation minimum policy;
    # it does not establish whether the provider returned TTL or Unix seconds.
    mode: str = ''
    review_reference: str = ''


@dataclass(frozen=True)
class ExpiryEvidence:
    expires_at: datetime
    contract: ExpiryContract


@dataclass(frozen=True)
class ActorState:
    local_user_id: int
    mes_user_id: int
    tenant_id: str
    app_id: int
    session_digest: str
    authorization_digest: str
    authenticated: bool
    active: bool
    eligible: bool
    password_change_required: bool


@dataclass(frozen=True)
class ConnectionState:
    local_user_id: int
    mes_user_id: int
    tenant_id: str
    app_id: int
    session_digest: str
    authorization_digest: str
    policy_reference: str
    verified_at: datetime
    last_used_at: datetime
    provider_expiry: ExpiryEvidence
    consent_expires_at: datetime
    revoked_at: datetime | None = None


@dataclass(frozen=True)
class ReusePolicy:
    enabled: bool = False
    review_reference: str = ''
    expiry_contract: ExpiryContract = ExpiryContract()
    allowed_operations: frozenset[str] = frozenset()
    max_connection_seconds: int = 0
    idle_seconds: int = 0
    safety_seconds: int = 30


@dataclass(frozen=True)
class ReuseDecision:
    action: str
    reason: str

    @property
    def live_ready(self):
        return False


def _utc(value):
    if type(value) is not datetime or value.tzinfo is None:
        return None
    try:
        if value.utcoffset() is None:
            return None
        return value.astimezone(timezone.utc)
    except Exception:
        # Malformed tzinfo/normalization overflow is invalid metadata, not an
        # exception carrying arbitrary input into request/error logs.
        return None


def _reference(value):
    return type(value) is str and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', value))


def _contract_valid(value):
    return (type(value) is ExpiryContract and value.mode in (
                'relative_seconds', 'unix_seconds', 'conservative_minimum')
            and _reference(value.review_reference))


def resolve_provider_expiry(raw_expire, *, request_started_at, received_at, contract=None):
    """Resolve seconds only with an explicitly reviewed expiry policy.

    Relative durations start at the local request start, conservatively earlier
    than provider issuance. Never infer relative/epoch units from magnitude or
    use a fallback lifetime. conservative_minimum accepts neither interpretation
    as fact: both must be representable and unexpired, and the earlier deadline
    bounds use. A past Unix interpretation cannot be discarded to allow a TTL.
    The caller must verify the seconds unit, same token/identity and HTTP
    provenance separately. No expiry policy is configured by default.
    """
    if not _contract_valid(contract):
        raise ContinuityBlocked('expiry_contract_unverified')
    if type(raw_expire) is not int or raw_expire <= 0:
        raise ContinuityBlocked('expiry_value_invalid')
    # UTC arithmetic avoids wall-clock/fold comparison across DST transitions.
    request_started_at = _utc(request_started_at)
    received_at = _utc(received_at)
    if (request_started_at is None or received_at is None
            or request_started_at > received_at):
        raise ContinuityBlocked('exchange_clock_invalid')
    try:
        if contract.mode == 'relative_seconds':
            expires_at = request_started_at + timedelta(seconds=raw_expire)
        elif contract.mode == 'unix_seconds':
            expires_at = datetime.fromtimestamp(raw_expire, timezone.utc)
        else:
            expires_at = min(
                request_started_at + timedelta(seconds=raw_expire),
                datetime.fromtimestamp(raw_expire, timezone.utc),
            )
    except (ValueError, OverflowError, OSError):
        raise ContinuityBlocked('expiry_value_invalid') from None
    if expires_at <= received_at:
        raise ContinuityBlocked('provider_token_expired')
    return ExpiryEvidence(expires_at, contract)


def _id(value):
    return type(value) is int and 1 <= value <= 9_223_372_036_854_775_807


def _digest(value):
    return type(value) is str and bool(re.fullmatch(r'[0-9a-f]{64}', value))


def _binding_valid(value):
    return (_id(value.local_user_id) and _id(value.mes_user_id) and _id(value.app_id)
            and _reference(value.tenant_id) and _digest(value.session_digest)
            and _digest(value.authorization_digest))


def decide_reuse(*, actor, connection, policy=ReusePolicy(), operation, now):
    """Choose a fixed local action; no token is fetched and no activity is saved.

    Successful use must atomically update last_used_at in the future vault.
    Reading readiness must never extend expiry/idle time. Concurrent revocation
    and dispatch must be serialized in that vault, not inferred from this pure
    snapshot. A logged-out account is blocked, even if a connection is present.
    Only identity_read is modelled; QC operations remain outside this module.
    """
    def blocked(reason):
        return ReuseDecision('blocked', reason)

    def reconnect(reason):
        return ReuseDecision('reauthenticate', reason)

    if type(policy) is not ReusePolicy or type(policy.enabled) is not bool:
        return blocked('policy_invalid')
    if not policy.enabled:
        return blocked('continuity_disabled')
    if (not _reference(policy.review_reference) or not _contract_valid(policy.expiry_contract)
            or type(policy.allowed_operations) is not frozenset
            or not policy.allowed_operations
            or not policy.allowed_operations <= frozenset({'identity_read'})
            or type(policy.max_connection_seconds) is not int
            or not 1 <= policy.max_connection_seconds <= 86_400
            or type(policy.idle_seconds) is not int
            or not 1 <= policy.idle_seconds <= policy.max_connection_seconds
            or type(policy.safety_seconds) is not int
            or not 0 <= policy.safety_seconds < policy.idle_seconds):
        return blocked('policy_unreviewed')
    if type(operation) is not str or operation not in policy.allowed_operations:
        return blocked('operation_unapproved')
    now = _utc(now)
    if now is None:
        return blocked('clock_invalid')
    if type(actor) is not ActorState or not _binding_valid(actor):
        return blocked('actor_invalid')
    flags = (actor.authenticated, actor.active, actor.eligible, actor.password_change_required)
    if any(type(value) is not bool for value in flags):
        return blocked('actor_invalid')
    if not actor.authenticated:
        return blocked('local_login_required')
    if not actor.active or not actor.eligible or actor.password_change_required:
        return blocked('actor_ineligible')
    if connection is None:
        return reconnect('connection_missing')
    if type(connection) is not ConnectionState or not _binding_valid(connection):
        return blocked('connection_invalid')
    expiry = connection.provider_expiry
    if type(expiry) is not ExpiryEvidence:
        return blocked('connection_invalid')
    provider_expires_at = _utc(expiry.expires_at)
    verified_at = _utc(connection.verified_at)
    last_used_at = _utc(connection.last_used_at)
    consent_expires_at = _utc(connection.consent_expires_at)
    if (any(value is None for value in (provider_expires_at, verified_at,
                                       last_used_at, consent_expires_at))
            or not _reference(connection.policy_reference)
            or (connection.revoked_at is not None and _utc(connection.revoked_at) is None)):
        return blocked('connection_invalid')
    if connection.revoked_at is not None:
        return reconnect('connection_revoked')
    identity = ('local_user_id', 'mes_user_id', 'tenant_id', 'app_id')
    if any(getattr(actor, key) != getattr(connection, key) for key in identity):
        return blocked('identity_mismatch')
    if actor.session_digest != connection.session_digest:
        return reconnect('session_changed')
    if actor.authorization_digest != connection.authorization_digest:
        return reconnect('authorization_changed')
    if (connection.policy_reference != policy.review_reference
            or expiry.contract != policy.expiry_contract):
        return reconnect('review_changed')
    if not verified_at <= last_used_at <= now:
        return blocked('connection_clock_invalid')
    try:
        deadlines = (
            (provider_expires_at, 'provider_token_expired'),
            (consent_expires_at, 'consent_expired'),
            (verified_at + timedelta(seconds=policy.max_connection_seconds), 'connection_expired'),
            (last_used_at + timedelta(seconds=policy.idle_seconds), 'connection_idle'),
        )
        deadline, reason = min(deadlines, key=lambda item: item[0])
        if now + timedelta(seconds=policy.safety_seconds) >= deadline:
            return reconnect(reason)
    except OverflowError:
        return blocked('connection_clock_invalid')
    return ReuseDecision('reuse_candidate', 'metadata_valid')
