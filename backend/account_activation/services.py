"""Local, one-use self-set activation. No email, role grants or provider calls."""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone as dt_timezone
import hashlib
import json
import re
import secrets

from django.conf import settings
from django.contrib.auth import get_user_model, password_validation
from django.contrib.auth.models import Group, Permission
from django.core.exceptions import ValidationError
from django.db import connection, transaction
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from django.views.decorators.debug import sensitive_variables

from injection.models import UserProfile
from mes_oauth.pilot_scope import pilot_route_scope_required
from .models import ActivationGrant, ActivationRateBucket


LIFETIME = timedelta(minutes=15)
TOKEN_PATTERN = re.compile(r'([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})\Z')
PROFILE_POLICY_FIELDS = tuple(field.name for field in UserProfile._meta.fields
    if field.name.startswith(('can_view_', 'can_edit_', 'can_confirm_')) or field.name == 'is_admin')


class ActivationBlocked(Exception):
    """Only fixed reason codes; never attach input values."""


def enabled():
    return getattr(settings, 'ACCOUNT_ACTIVATION_ENABLED', False) is True


def administrator(user):
    return bool(user and user.is_authenticated and user.is_active
                and user.is_staff and user.is_superuser
                and not pilot_route_scope_required(user, {}))


@sensitive_variables()
def digest(namespace, value):
    return salted_hmac('account-activation-' + namespace, str(value), algorithm='sha256').hexdigest()


def approved_targets():
    try:
        data = getattr(settings, 'ACCOUNT_ACTIVATION_APPROVED_TARGETS', {})
        data = json.loads(data) if isinstance(data, str) else data
        if type(data) is not dict or len(data) > 4:
            raise ValueError()
        for actor, entry in data.items():
            if (type(actor) is not str or not re.fullmatch(r'[1-9][0-9]{0,18}', actor)
                    or int(actor) > 2**63 - 1 or type(entry) is not dict
                    or set(entry) != {'username', 'policy_digest', 'reference'}
                    or type(entry['username']) is not str or not 1 <= len(entry['username']) <= 150
                    or not re.fullmatch(r'[a-f0-9]{64}', entry['policy_digest'])
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', entry['reference'])):
                raise ValueError()
        return data
    except (ValueError, TypeError, KeyError):
        raise ActivationBlocked('configuration_unreviewed') from None


def policy_digest(user, profile=None):
    """Non-secret approval fingerprint; deliberately excludes password/active."""
    profile = profile or UserProfile.objects.get(user_id=user.pk)
    # Fresh queries avoid the permission cache on a previously loaded User.
    groups = list(user.groups.order_by('pk').values_list('pk', flat=True))
    direct = list(user.user_permissions.order_by('pk').values_list('pk', flat=True))
    inherited = list(user.groups.order_by('permissions__pk').values_list('permissions__pk', flat=True))
    meaning = list(Permission.objects.filter(pk__in=set(direct + inherited)).order_by('pk')
                   .values_list('pk', 'codename', 'content_type__app_label', 'content_type__model'))
    value = [user.pk, user.username, user.email, user.first_name, user.last_name,
             user.is_staff, user.is_superuser, profile.department,
             [(name, getattr(profile, name)) for name in PROFILE_POLICY_FIELDS],
             groups, direct, sorted({value for value in inherited if value is not None}), meaning]
    return hashlib.sha256(json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()


def _lock_permission_policy():
    """Freeze permission memberships through the short activation transaction.

    Legacy role edits do not share a per-user lock protocol. PostgreSQL SHARE
    locks therefore serialize their writes without changing those older paths.
    Acquire before user locks; a conflicting legacy lock order fails closed on
    timeout/deadlock. Ordinary reads and other activation readers remain free.
    """
    if connection.vendor == 'postgresql':
        User = get_user_model()
        tables = sorted({User.groups.through._meta.db_table,
            User.user_permissions.through._meta.db_table, Group.permissions.through._meta.db_table,
            Permission._meta.db_table})
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '3s'")
            cursor.execute('LOCK TABLE ' + ', '.join(connection.ops.quote_name(name) for name in tables)
                           + ' IN SHARE MODE')


@sensitive_variables()
def credential_digest(user, profile):
    return digest('credential', json.dumps([user.password, profile.is_using_temp_password,
        profile.password_reset_required, str(profile.last_password_change)], separators=(',', ':')))


def _target(user, profile):
    entry = approved_targets().get(str(user.pk))
    if (not entry or user.username != entry['username'] or user.is_active
            or user.has_usable_password() or user.is_staff or user.is_superuser
            or profile.is_admin or policy_digest(user, profile) != entry['policy_digest']):
        raise ActivationBlocked('target_unavailable')
    return entry


@sensitive_variables()
def take_rate(namespace, value, limit, *, now=None):
    """A shared, atomic fixed 15-minute bucket; committed before any grant work."""
    now = now or timezone.now()
    window = int(now.timestamp()) // 900
    key = digest('rate', f'{namespace}:{value}:{window}')
    with transaction.atomic():
        ActivationRateBucket.objects.get_or_create(pk=key, defaults={
            'expires_at': datetime.fromtimestamp((window + 1) * 900, dt_timezone.utc)})
        bucket = ActivationRateBucket.objects.select_for_update().get(pk=key)
        if bucket.count >= limit:
            return False
        bucket.count += 1
        bucket.save(update_fields=['count'])
    return True


@sensitive_variables()
def rate_action(action, *, source, actor=None, target=None):
    # Do not trust forwarding headers. A shared ingress address fails closed.
    if not take_rate(action + '-source', str(source or 'unknown')[:200], 40):
        raise ActivationBlocked('rate_limited')
    if actor is not None and not take_rate(action + '-actor', actor, 10):
        raise ActivationBlocked('rate_limited')
    if target is not None and not take_rate(action + '-target', target, 8):
        raise ActivationBlocked('rate_limited')


@dataclass(frozen=True)
class IssuedActivation:
    token: str = field(repr=False)
    expires_at: datetime


@sensitive_variables()
def issue(issuer_id, target_id):
    if not enabled():
        raise ActivationBlocked('disabled')
    with transaction.atomic():
        _lock_permission_policy()
        issuer = get_user_model().objects.select_for_update().filter(pk=issuer_id).first()
        if not administrator(issuer):
            raise ActivationBlocked('issuer_unavailable')
        user = get_user_model().objects.select_for_update().filter(pk=target_id).first()
        profile = UserProfile.objects.select_for_update().filter(user_id=target_id).first()
        if not user or not profile:
            raise ActivationBlocked('target_unavailable')
        entry = _target(user, profile)
        now = timezone.now()
        pending = ActivationGrant.objects.select_for_update().filter(target_id=target_id, status='pending')
        pending.filter(expires_at__lte=now).update(status='expired')
        if pending.exists():
            raise ActivationBlocked('pending_grant_exists')
        selector, secret = secrets.token_urlsafe(18), secrets.token_urlsafe(32)
        token = selector + '.' + secret
        expires = now + LIFETIME
        ActivationGrant.objects.create(selector=selector, token_digest=digest('token', token),
            target_id=user.pk, issuer_id=issuer.pk, policy_digest=entry['policy_digest'],
            credential_digest=credential_digest(user, profile), review_reference=entry['reference'],
            expires_at=expires)
        return IssuedActivation(token, expires)


def revoke(issuer_id, target_id):
    if not enabled() or str(target_id) not in approved_targets():
        raise ActivationBlocked('target_unavailable')
    with transaction.atomic():
        issuer = get_user_model().objects.select_for_update().filter(pk=issuer_id).first()
        if not administrator(issuer):
            raise ActivationBlocked('issuer_unavailable')
        # Same user -> grant lock order as issue and consume.
        get_user_model().objects.select_for_update().filter(pk=target_id).first()
        ActivationGrant.objects.filter(target_id=target_id, status='pending').update(
            status='revoked', revoked_at=timezone.now(), revoked_by=issuer_id)


@sensitive_variables()
def activate(token, password, confirmation):
    if not enabled():
        raise ActivationBlocked('disabled')
    match = TOKEN_PATTERN.fullmatch(token) if isinstance(token, str) else None
    if not match:
        raise ActivationBlocked('activation_unavailable')
    identity = ActivationGrant.objects.filter(pk=match[1]).values_list('issuer_id', 'target_id').first()
    if identity is None:
        raise ActivationBlocked('activation_unavailable')
    issuer_id, target = identity
    with transaction.atomic():
        _lock_permission_policy()
        # Consistent issuer -> target order also makes issuer deactivation wait
        # until the decision commits (or win first and reject the activation).
        issuer = get_user_model().objects.select_for_update().filter(pk=issuer_id).first()
        user = get_user_model().objects.select_for_update().filter(pk=target).first()
        row = ActivationGrant.objects.select_for_update().get(pk=match[1])
        profile = UserProfile.objects.select_for_update().filter(user_id=target).first()
        if (not user or not profile or row.status != 'pending' or row.expires_at <= timezone.now()
                or not constant_time_compare(row.token_digest, digest('token', token))):
            raise ActivationBlocked('activation_unavailable')
        entry = _target(user, profile)
        if (row.issuer_id != issuer_id or row.target_id != target or not administrator(issuer)
                or entry['policy_digest'] != row.policy_digest
                or entry['reference'] != row.review_reference
                or credential_digest(user, profile) != row.credential_digest):
            raise ActivationBlocked('activation_unavailable')
        if (not isinstance(password, str) or not 1 <= len(password) <= 256
                or password != confirmation):
            raise ActivationBlocked('password_invalid')
        try:
            password_validation.validate_password(password, user=user)
        except ValidationError:
            raise ActivationBlocked('password_invalid') from None
        user.set_password(password)
        user.is_active = True
        user.save(update_fields=['password', 'is_active'])
        now = timezone.now()
        profile.is_using_temp_password = False
        profile.password_reset_required = False
        profile.last_password_change = now
        profile.save(update_fields=['is_using_temp_password', 'password_reset_required', 'last_password_change'])
        # Password hash change invalidates existing Django sessions; existing
        # JWT helper plus change timestamp and MES revocation cover other logins.
        from injection.views import _blacklist_user_refresh_tokens
        from mes_oauth.vault import revoke_actor
        _blacklist_user_refresh_tokens(user)
        revoke_actor(user.pk, reason='account_activated')
        row.status = 'consumed'
        row.consumed_at = now
        row.save(update_fields=['status', 'consumed_at'])
