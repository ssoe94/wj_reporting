"""Signed WJ login admission for inspection mutations, without provider calls.

Lock order: user -> login -> inspection scope/rows. A reservation commits before
dispatch; dispatch reacquires this guard and holds it until its result settles.
This does not authorize a provider operation or supply an application credential.
"""
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone as dt_timezone
import re

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import AccessToken

from . import vault
from .models import MESLoginSession
from .pilot_scope import PILOT_SCOPE_CLAIM, pilot_route_scope_required


class LoginRejected(AuthenticationFailed):
    default_detail = 'A current authenticated login is required for this action.'
    default_code = 'inspection_login_required'


class SessionIdleExpired(LoginRejected):
    default_detail = 'The WJ session idle deadline has expired.'
    default_code = 'session_idle_expired'


def session_version(token):
    version = token.get('mes_session_v')
    if 'mes_session_v' in token and (type(version) is not int or version != 2):
        raise LoginRejected()
    return version


def effective_login_expiry(row, *, require_v2=False):
    """Read the effective deadline without renewing it or changing the anchor."""
    activity, idle = row.last_activity_at, row.idle_expires_at
    # Persisted provenance also protects tickets/callbacks that hold only the
    # login digest. Missing v2 clocks cannot fall back to the old signed anchor.
    if row.session_version is None:
        if require_v2 or activity is not None or idle is not None:
            raise LoginRejected()
        return row.expires_at
    if type(row.session_version) is not int or row.session_version != 2:
        raise LoginRejected()

    now = timezone.now()
    if (activity is None or idle is None or activity > now
            or not activity < idle <= activity + timedelta(hours=24)):
        raise LoginRejected()
    return idle


def require_live_login(row, *, require_v2=False):
    if row is None or row.revoked_at is not None:
        raise LoginRejected()
    deadline = effective_login_expiry(row, require_v2=require_v2)
    if deadline <= timezone.now():
        raise SessionIdleExpired()
    return deadline


@sensitive_variables()
def login_identity(token):
    sid, expiry = token.get('mes_sid'), token.get('mes_login_exp')
    if (type(sid) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{43}', sid)
            or type(expiry) is not int):
        raise LoginRejected()
    try:
        expires_at = datetime.fromtimestamp(expiry, dt_timezone.utc)
    except (ValueError, OverflowError, OSError):
        raise LoginRejected() from None
    version = session_version(token)
    if expires_at > timezone.now() + timedelta(days=31) or (version != 2 and expires_at <= timezone.now()):
        raise LoginRejected()
    return vault.digest('client-login', sid), expires_at


def _normal_actor(user, claims):
    from config.authentication import token_matches_current_password
    from quality.archive_access import is_archive_identity_marker
    try:
        profile = user.profile
        valid = (user.is_active and not is_archive_identity_marker(user, claims)
                 and not profile.password_reset_required and not profile.is_using_temp_password
                 and not claims.get('password_reset_required', False)
                 and token_matches_current_password(user, claims, profile))
    except Exception:
        valid = False
    if not valid:
        raise LoginRejected()
    user._inspection_pilot_scope = pilot_route_scope_required(user, claims)


@sensitive_variables()
def check_known_login(user, token):
    """Reject revoked modern families; legacy JWTs keep their existing routes.

    Called only after cryptographic JWT verification. No row is created on reads.
    Refresh callers hold the user lock, which is also used by logout.
    """
    if token.get('mes_sid') is None and token.get('mes_login_exp') is None:
        if session_version(token) is not None:
            raise LoginRejected()
        return
    digest, expiry = login_identity(token)
    row = MESLoginSession.objects.filter(pk=digest).first()
    version = session_version(token)
    if row is None:
        if version == 2:
            raise LoginRejected()
        return
    if (row.actor_id != user.pk or row.expires_at != expiry
            or row.authorization_digest != vault.authorization_digest(user)):
        raise LoginRejected()
    require_live_login(row, require_v2=version == 2)
    return row


def _mapping(actor_id):
    try:
        return vault.expected_user(actor_id)
    except vault.VaultBlocked:
        return None


@dataclass(repr=False)
class InspectionSession:
    actor_id: int
    login_digest: str = field(repr=False)
    expires_at: datetime
    claims: dict = field(repr=False)
    revision: int | None = None
    authorization: str | None = field(default=None, repr=False)
    mes_user_id: int | None = field(default=None, repr=False)
    version: int | None = None
    effective_expires_at: datetime | None = None

    @classmethod
    @sensitive_variables()
    def from_token(cls, user, token):
        # The API supplies its verified AccessToken, never body/header claims.
        if (not isinstance(token, AccessToken) or not user or not user.pk
                or type(token.get(api_settings.USER_ID_CLAIM)) not in (int, str)
                or str(token.get(api_settings.USER_ID_CLAIM)) != str(user.pk)):
            raise LoginRejected()
        digest, expiry = login_identity(token)
        claims = {key: token.get(key) for key in
                  (api_settings.REVOKE_TOKEN_CLAIM, 'iat', 'password_reset_required')}
        if pilot_route_scope_required(user, token):
            claims[PILOT_SCOPE_CLAIM] = True
        return cls(user.pk, digest, expiry, claims, version=session_version(token))

    @classmethod
    def from_request(cls, request):
        return cls.from_token(request.user, request.auth)

    @contextmanager
    @sensitive_variables()
    def lock(self, permission, *, actor_id, mes_actor=None, require_mapping=False):
        from quality.inspection_workflow import require
        if actor_id != self.actor_id:
            raise LoginRejected()
        with transaction.atomic():
            user = get_user_model().objects.select_for_update().filter(pk=self.actor_id).first()
            if user is None:
                raise LoginRejected()
            _normal_actor(user, self.claims)
            # A newly fetched user avoids cached permission decisions.
            require(user, permission)
            authorization = vault.authorization_digest(user)
            row = MESLoginSession.objects.select_for_update().filter(pk=self.login_digest).first()
            if row is None and self.version != 2:
                if self.expires_at <= timezone.now():
                    raise LoginRejected()
                row = MESLoginSession.objects.create(digest=self.login_digest,
                    actor_id=user.pk, authorization_digest=authorization, expires_at=self.expires_at)
            self.effective_expires_at = require_live_login(row, require_v2=self.version == 2)
            mapping = _mapping(user.pk)
            if (row.actor_id != user.pk or row.revoked_at is not None
                    or row.expires_at != self.expires_at or row.authorization_digest != authorization
                    or (self.revision is not None and (self.revision != row.revision
                        or self.authorization != authorization or self.mes_user_id != mapping))):
                raise LoginRejected()
            if require_mapping and mapping is None:
                raise LoginRejected()
            if mes_actor is not None and (mapping is None or type(mes_actor) not in (int, str)
                                           or str(mes_actor) != str(mapping)):
                raise LoginRejected()
            self.revision, self.authorization, self.mes_user_id = row.revision, authorization, mapping
            yield user
