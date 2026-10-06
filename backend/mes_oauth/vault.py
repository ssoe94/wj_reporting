"""Server-only credential lifecycle. Disabled unless every contract is reviewed.

No issuer, refresh, fallback, general request adapter or QC write is provided.
The only provider operation here is an explicit user-information recheck.
Lock order is user -> login -> credential; retain locks during the bounded read
so acknowledged revocation prevents later dispatch. No browser receives tokens.
"""
import base64
from dataclasses import dataclass
from datetime import timedelta, timezone as dt_timezone
import json
import re
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.views.decorators.debug import sensitive_variables

from quality.archive_access import is_archive_identity_marker
from .access import can_verify_identity
from .client import ORIGINS
from .app_tokens import app_credentials_configured, app_credential_binding
from .continuity import (ActorState, ConnectionState, ExpiryContract, ExpiryEvidence,
                         ReusePolicy, decide_reuse, resolve_provider_expiry)
from .identity import VerifiedUserContext, StoredIdentityRejected, verify_stored_identity_response
from .models import MESCredential, MESCredentialEvent, MESLoginSession, MESLoginTicket


class VaultBlocked(Exception):
    """Only fixed non-sensitive reason codes cross this boundary."""


@sensitive_variables()
def digest(namespace, value):
    return salted_hmac('mes-' + namespace, str(value), algorithm='sha256').hexdigest()


def enabled():
    return (getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is True
            and getattr(settings, 'MES_USER_SESSION_BRIDGE_ENABLED', False) is True
            and getattr(settings, 'MES_USER_TOKEN_STORAGE_ENABLED', False) is True)


def eligible(user):
    if not can_verify_identity(user) or is_archive_identity_marker(user):
        return False
    try:
        return not (user.profile.password_reset_required or user.profile.is_using_temp_password)
    except Exception:
        return False


@sensitive_variables()
def authorization_digest(user):
    try:
        profile = user.profile
        value = [user.pk, user.password, user.username, user.is_active, user.is_staff,
                 user.is_superuser, profile.password_reset_required,
                 profile.is_using_temp_password, list(user.groups.order_by('pk').values_list('pk', flat=True)),
                 list(user.user_permissions.order_by('pk').values_list('pk', flat=True)),
                 sorted(user.get_all_permissions())]
    except Exception:
        raise VaultBlocked('actor_unavailable') from None
    return digest('authorization', json.dumps(value, separators=(',', ':')))


def expected_user(actor_id):
    try:
        mapping = getattr(settings, 'MES_USER_OAUTH_USER_MAP', '{}')
        mapping = json.loads(mapping) if type(mapping) is str else mapping
        value = mapping[str(actor_id)]
        if type(value) is not str or not re.fullmatch(r'[1-9][0-9]{0,18}', value):
            raise ValueError()
        expected = int(value)
        if expected > 2**63 - 1 or list(mapping.values()).count(value) != 1:
            raise ValueError()
        return expected
    except Exception:
        raise VaultBlocked('identity_mapping_unverified') from None


@sensitive_variables()
def _keys():
    try:
        raw = getattr(settings, 'MES_USER_TOKEN_KEYS', '')
        data = json.loads(raw)
        active = getattr(settings, 'MES_USER_TOKEN_ACTIVE_KEY_ID', '')
        if type(data) is not dict or not 1 <= len(data) <= 3 or active not in data:
            raise ValueError()
        keys = {}
        for key_id, encoded in data.items():
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', key_id) or type(encoded) is not str:
                raise ValueError()
            key = base64.b64decode(encoded, altchars=b'-_', validate=True)
            if len(key) != 32:
                raise ValueError()
            keys[key_id] = AESGCM(key)
        return active, keys
    except Exception:
        raise VaultBlocked('vault_key_unavailable') from None


@dataclass(frozen=True)
class VaultPolicy:
    reuse: ReusePolicy
    app_id: int
    tenant: str
    consent_seconds: int


@sensitive_variables()
def policy():
    if not enabled():
        raise VaultBlocked('storage_disabled')
    try:
        if (getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', '') not in ORIGINS
                or not app_credentials_configured()):
            raise ValueError()
        app = getattr(settings, 'MES_USER_TOKEN_APP_ID', '')
        tenant = getattr(settings, 'MES_USER_TOKEN_TENANT_REFERENCE', '')
        review = getattr(settings, 'MES_USER_TOKEN_POLICY_REFERENCE', '')
        contract = ExpiryContract(getattr(settings, 'MES_USER_TOKEN_EXPIRY_MODE', ''),
                                  getattr(settings, 'MES_USER_TOKEN_CONTRACT_REFERENCE', ''))
        maximum = getattr(settings, 'MES_USER_TOKEN_MAX_AGE_SECONDS', 0)
        idle = getattr(settings, 'MES_USER_TOKEN_IDLE_SECONDS', 0)
        consent = getattr(settings, 'MES_USER_TOKEN_CONSENT_SECONDS', 0)
        safety = getattr(settings, 'MES_USER_TOKEN_SAFETY_SECONDS', 30)
        if (type(app) is not str or not re.fullmatch(r'[1-9][0-9]{0,18}', app)
                or int(app) > 2**63-1 or type(tenant) is not str
                or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', tenant)
                or type(review) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', review)
                or type(consent) is not int or not 1 <= consent <= 86400):
            raise ValueError()
        reference = digest('vault-policy', json.dumps([
            review, contract.mode, contract.review_reference, app, tenant,
            maximum, idle, consent, safety, settings.MES_USER_OAUTH_PROVIDER_ORIGIN,
            app_credential_binding()], separators=(',', ':')))
        reuse = ReusePolicy(True, reference, contract, frozenset({'identity_read'}), maximum, idle, safety)
        # Validate the policy without supplying an actor or making any request.
        checked = decide_reuse(actor=None, connection=None, policy=reuse,
                               operation='identity_read', now=timezone.now())
        if checked.reason != 'actor_invalid':
            raise ValueError()
        _keys()
        return VaultPolicy(reuse, int(app), tenant, consent)
    except VaultBlocked:
        raise
    except Exception:
        raise VaultBlocked('storage_policy_unreviewed') from None


def _aad(row):
    return json.dumps([
        'wj-mes-vault-v1', row.actor_id, row.mes_user_id, row.app_id,
        row.tenant_reference, row.login_digest, row.authorization_digest,
        row.policy_reference, row.key_id, row.version,
        row.verified_at.astimezone(dt_timezone.utc).isoformat(),
        row.expires_at.astimezone(dt_timezone.utc).isoformat(),
        row.provider_expires_at.astimezone(dt_timezone.utc).isoformat(),
        row.consent_expires_at.astimezone(dt_timezone.utc).isoformat(),
        row.last_used_at.astimezone(dt_timezone.utc).isoformat(),
        row.idle_expires_at.astimezone(dt_timezone.utc).isoformat(),
    ], separators=(',', ':')).encode('utf-8')


@sensitive_variables()
def _seal(row, token):
    if type(token) is not str or not re.fullmatch(r'[!-~]{1,8192}', token):
        raise VaultBlocked('credential_invalid')
    active, keys = _keys()
    row.key_id = active
    nonce = secrets.token_bytes(12)
    row.ciphertext = nonce + keys[active].encrypt(nonce, token.encode('ascii'), _aad(row))


@sensitive_variables()
def _open(row):
    try:
        _, keys = _keys()
        encrypted = bytes(row.ciphertext)
        if len(encrypted) < 29 or len(encrypted) > 8220:
            raise ValueError()
        return keys[row.key_id].decrypt(encrypted[:12], encrypted[12:], _aad(row)).decode('ascii')
    except Exception:
        raise VaultBlocked('credential_unreadable') from None


def _event(actor_id, action, reason):
    # Callers supply only fixed, reviewed codes, not provider error strings.
    MESCredentialEvent.objects.create(actor_id=actor_id, action=action, reason=reason)


def _clear(row, reason):
    if row.revoked_at is None or row.ciphertext:
        row.ciphertext = b''
        row.revoked_at = timezone.now()
        row.save(update_fields=['ciphertext', 'revoked_at'])
        _event(row.actor_id, 'revoked', reason)


def _lock_user(actor_id):
    user = get_user_model().objects.select_for_update().filter(pk=actor_id).first()
    if user is None:
        raise VaultBlocked('actor_unavailable')
    return user


def _login(user, login_digest, *, lock=False, revision=None):
    query = MESLoginSession.objects.select_for_update() if lock else MESLoginSession.objects
    row = query.filter(pk=login_digest, actor_id=user.pk).first()
    if (row is None or row.revoked_at is not None or row.expires_at <= timezone.now()
            or row.authorization_digest != authorization_digest(user) or not eligible(user)
            or (revision is not None and row.revision != revision)):
        raise VaultBlocked('login_unavailable')
    return row


def decision(user, row, login_digest, configuration):
    current = ActorState(user.pk, expected_user(user.pk), configuration.tenant, configuration.app_id,
                         login_digest, authorization_digest(user), True, user.is_active,
                         eligible(user), False)
    stored = None if row is None else ConnectionState(
        row.actor_id, int(row.mes_user_id), row.tenant_reference, int(row.app_id),
        row.login_digest, row.authorization_digest, row.policy_reference,
        row.verified_at, row.last_used_at,
        ExpiryEvidence(row.provider_expires_at, configuration.reuse.expiry_contract),
        row.consent_expires_at, row.revoked_at)
    return decide_reuse(actor=current, connection=stored, policy=configuration.reuse,
                        operation='identity_read', now=timezone.now())


@sensitive_variables()
def store_context(actor_id, login_digest, context, *, request_started_at, received_at, login_revision):
    configuration = policy()
    if type(context) is not VerifiedUserContext:
        raise VaultBlocked('identity_unverified')
    evidence = resolve_provider_expiry(context.expire, request_started_at=request_started_at,
                                      received_at=received_at, contract=configuration.reuse.expiry_contract)
    with transaction.atomic():
        user = _lock_user(actor_id)
        if type(login_revision) is not int or login_revision < 1:
            raise VaultBlocked('login_unavailable')
        _login(user, login_digest, lock=True, revision=login_revision)
        if context.user_id != expected_user(user.pk):
            raise VaultBlocked('identity_mismatch')
        previous = MESCredential.objects.select_for_update().filter(pk=user.pk).first()
        now = timezone.now()
        consent = now + timedelta(seconds=configuration.consent_seconds)
        expiry = min(evidence.expires_at, consent,
                     now + timedelta(seconds=configuration.reuse.max_connection_seconds))
        if now + timedelta(seconds=configuration.reuse.safety_seconds) >= expiry:
            raise VaultBlocked('credential_expired')
        row = MESCredential(actor_id=user.pk, mes_user_id=str(context.user_id),
            app_id=str(configuration.app_id), tenant_reference=configuration.tenant,
            login_digest=login_digest, authorization_digest=authorization_digest(user),
            policy_reference=configuration.reuse.review_reference,
            verified_at=now, last_used_at=now, expires_at=expiry,
            provider_expires_at=evidence.expires_at, consent_expires_at=consent,
            idle_expires_at=min(expiry, now + timedelta(seconds=configuration.reuse.idle_seconds)),
            version=(previous.version + 1) if previous else 1)
        _seal(row, context.token)
        row.save()
        _event(user.pk, 'connected', 'identity_verified')
        return row.expires_at


def revoke_actor(actor_id, *, login_digest=None, login_expires_at=None,
                 reason='disconnected', revoke_login=True):
    # Revocation works even with OAuth/storage OFF or unavailable encryption keys.
    with transaction.atomic():
        user = get_user_model().objects.select_for_update().filter(pk=actor_id).first()
        if user is None:
            return
        if revoke_login:
            if login_digest is not None and login_expires_at is not None:
                # Logout must also revoke a signed login that never launched MES.
                # Keep this tombstone under the same user lock as launch.
                marker, _ = MESLoginSession.objects.get_or_create(pk=login_digest,
                    defaults=dict(actor_id=actor_id, authorization_digest=authorization_digest(user),
                                  expires_at=login_expires_at, revoked_at=timezone.now()))
                if marker.actor_id != actor_id:
                    raise VaultBlocked('login_unavailable')
            logins = MESLoginSession.objects.filter(actor_id=actor_id, revoked_at__isnull=True)
            if login_digest is not None:
                logins = logins.filter(pk=login_digest)
            logins.update(revoked_at=timezone.now())
        else:
            from django.db.models import F
            logins = MESLoginSession.objects.filter(actor_id=actor_id, revoked_at__isnull=True)
            if login_digest is not None:
                logins = logins.filter(pk=login_digest)
            logins.update(revision=F('revision') + 1)
        row = MESCredential.objects.select_for_update().filter(pk=actor_id).first()
        if row and (login_digest is None or row.login_digest == login_digest):
            _clear(row, reason)
        tickets = MESLoginTicket.objects.filter(actor_id=actor_id, consumed_at__isnull=True)
        if login_digest is not None:
            tickets = tickets.filter(login_digest=login_digest)
        tickets.update(consumed_at=timezone.now())


@sensitive_variables()
def recheck_identity(actor_id, login_digest, provider, *, pilot_scoped=False):
    """One same-token read only. No token leaves this bounded provider call."""
    configuration = policy()
    failure = None
    with transaction.atomic():
        user = _lock_user(actor_id)
        # JWT confinement must survive the fresh row-lock lookup too. A marker
        # is not permission to regain the administrator identity path.
        user._inspection_pilot_scope = pilot_scoped
        _login(user, login_digest, lock=True)
        row = MESCredential.objects.select_for_update().filter(pk=actor_id).first()
        result = decision(user, row, login_digest, configuration)
        if result.action != 'reuse_candidate':
            if row and row.login_digest == login_digest:
                _clear(row, 'reuse_unavailable')
            failure = 'reuse_unavailable'
        else:
            try:
                token = _open(row)
            except Exception:
                _clear(row, 'provider_recheck_failed')
                failure = 'provider_recheck_failed'
            else:
                try:
                    verify_stored_identity_response(provider.userinfo(token), expected_user(actor_id))
                except StoredIdentityRejected:
                    _clear(row, 'provider_recheck_failed')
                    failure = 'provider_recheck_failed'
                except Exception:
                    failure = 'provider_temporarily_unavailable'
                else:
                    if decision(user, row, login_digest, configuration).action != 'reuse_candidate':
                        _clear(row, 'provider_recheck_failed')
                        failure = 'provider_recheck_failed'
                    else:
                        row.last_used_at = timezone.now()
                        row.idle_expires_at = min(row.expires_at,
                            row.last_used_at + timedelta(seconds=configuration.reuse.idle_seconds))
                        _seal(row, token)
                        row.save(update_fields=['last_used_at', 'idle_expires_at', 'key_id', 'ciphertext'])
                        _event(actor_id, 'identity_read', 'identity_verified')
                finally:
                    token = None
    if failure:
        raise VaultBlocked(failure)
    return {'identity_verified': True, 'live_ready': False}


@sensitive_variables()
def rotate_actor_key(actor_id):
    """Explicit local maintenance; never renew token lifetime or grant scope."""
    with transaction.atomic():
        _lock_user(actor_id)
        row = MESCredential.objects.select_for_update().filter(pk=actor_id, revoked_at__isnull=True).first()
        if row is None:
            return False
        if min(row.expires_at, row.idle_expires_at) <= timezone.now():
            _clear(row, 'expired')
            return False
        token = _open(row)
        row.version += 1
        _seal(row, token)
        del token
        row.save(update_fields=['key_id', 'ciphertext', 'version'])
        _event(actor_id, 'key_rotated', 'maintenance')
        return True


def purge_expired(*, apply=False):
    from django.db.models import Q
    now = timezone.now()
    ids = list(MESCredential.objects.filter(revoked_at__isnull=True).filter(
        Q(expires_at__lte=now) | Q(idle_expires_at__lte=now)).values_list('actor_id', flat=True)[:1000])
    if apply:
        for actor_id in ids:
            with transaction.atomic():
                _lock_user(actor_id)
                row = MESCredential.objects.select_for_update().get(pk=actor_id)
                if row.revoked_at is None and min(row.expires_at, row.idle_expires_at) <= timezone.now():
                    _clear(row, 'expired')
    return len(ids)
