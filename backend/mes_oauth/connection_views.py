"""JWT metadata API and one-use, exact-origin, top-level MES session bridge.

The ticket is a short-lived body-only secret, never a URL or stored JWT. Bridge
sessions are confined to MES routes by middleware; they cannot open Django admin.
All token use remains server-side. No provider call happens on GET or launch.
"""
from datetime import datetime, timedelta, timezone as dt_timezone
import json
import re
import secrets
import jwt

from django.conf import settings
from django.contrib.auth import login, logout, get_user_model
from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.http import HttpResponse, HttpResponseRedirect
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.debug import sensitive_variables, sensitive_post_parameters
from django.views.decorators.http import require_POST
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated, PermissionDenied, ParseError, ValidationError
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.tokens import RefreshToken, UntypedToken
from rest_framework_simplejwt.state import token_backend

from config.authentication import ScopedJWTAuthentication, token_matches_current_password
from quality.archive_access import is_archive_identity_marker
from . import vault
from .app_tokens import AppCredentialUnavailable
from .models import MESCredential, MESLoginSession, MESLoginTicket
from .pilot_scope import pilot_route_scope_required


SESSION_KEY = 'mes_login_digest'
BRIDGE_ONLY = 'mes_bridge_only'
DIAGNOSTIC_SESSION_KEY = 'mes_diagnostic_request_uid'
BRIDGE_PATH = '/integrations/blacklake/session/'


STATUS_REASONS = frozenset({
    'http_scheme_untrusted', 'debug_enabled', 'insecure_session_cookie',
    'insecure_csrf_cookie', 'session_cookie_httponly_required',
    'session_cookie_samesite_invalid', 'session_cookie_domain_invalid',
    'csrf_cookie_domain_invalid', 'session_backend_invalid',
    'account_unavailable', 'account_inactive', 'restricted_identity', 'connection_unavailable',
    'user_profile_required', 'password_change_required', 'admin_staff_required',
    'account_role_required', 'callback_origin_unverified', 'provider_origin_unverified',
    'app_credential_missing', 'oauth_configuration_unreviewed',
    'connection_configuration_unreviewed', 'new_login_required', 'legacy_login_required', 'login_unavailable',
    'identity_mapping_unverified', 'storage_disabled', 'vault_key_unavailable',
    'storage_policy_unreviewed', 'actor_unavailable', 'policy_invalid',
    'continuity_disabled', 'policy_unreviewed', 'operation_unapproved',
    'clock_invalid', 'actor_invalid', 'local_login_required', 'actor_ineligible',
    'connection_missing', 'connection_invalid', 'connection_revoked', 'identity_mismatch',
    'session_changed', 'authorization_changed', 'review_changed', 'connection_clock_invalid',
    'provider_token_expired', 'consent_expired', 'connection_expired', 'connection_idle',
    'metadata_valid',
})


def status_reason(reason):
    return reason if type(reason) is str and reason in STATUS_REASONS else 'connection_unavailable'


def secure_request_reason(request):
    """The existing HTTPS/session gate, with fixed diagnostics and the same order."""
    if not request.is_secure():
        return 'http_scheme_untrusted'
    if settings.DEBUG:
        return 'debug_enabled'
    if not settings.SESSION_COOKIE_SECURE:
        return 'insecure_session_cookie'
    if not settings.CSRF_COOKIE_SECURE:
        return 'insecure_csrf_cookie'
    if not settings.SESSION_COOKIE_HTTPONLY:
        return 'session_cookie_httponly_required'
    if settings.SESSION_COOKIE_SAMESITE != 'Lax':
        return 'session_cookie_samesite_invalid'
    if settings.SESSION_COOKIE_DOMAIN is not None:
        return 'session_cookie_domain_invalid'
    if settings.CSRF_COOKIE_DOMAIN is not None:
        return 'csrf_cookie_domain_invalid'
    if settings.SESSION_ENGINE != 'django.contrib.sessions.backends.db':
        return 'session_backend_invalid'
    return None


def secure_request(request):
    return secure_request_reason(request) is None


def ineligible_account_reason(user):
    """Describe a failed eligible() check; this helper never grants admission."""
    if not user or not user.is_authenticated:
        return 'account_unavailable'
    if not user.is_active:
        return 'account_inactive'
    if is_archive_identity_marker(user):
        return 'restricted_identity'
    try:
        profile = user.profile
    except ObjectDoesNotExist:
        return 'user_profile_required'
    except Exception:
        return 'account_unavailable'
    if profile.password_reset_required or profile.is_using_temp_password:
        return 'password_change_required'
    if user.is_superuser and not user.is_staff:
        return 'admin_staff_required'
    return 'account_role_required'


def bridge_ready():
    return (getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is True
            and getattr(settings, 'MES_USER_SESSION_BRIDGE_ENABLED', False) is True)


def login_hint(user):
    """Display only the current WJ actor's explicitly mapped MES login name.

    Neither this hint nor copied text authenticates a user. OAuth verifies the
    actual provider identity against the existing numeric map independently.
    """
    try:
        if not vault.eligible(user):
            return None
        factory = getattr(settings, 'MES_USER_OAUTH_LOGIN_FACTORY_NUMBER', '')
        raw = getattr(settings, 'MES_USER_OAUTH_LOGIN_HINTS', '{}')
        hints = json.loads(raw) if type(raw) is str else raw
        item = hints[str(user.pk)]
        if (type(factory) is not str or not re.fullmatch(r'[0-9]{1,20}', factory)
                or type(item) is not dict or set(item) != {'mes_user_id', 'account_name'}
                or type(item['mes_user_id']) is not str or item['mes_user_id'] != str(vault.expected_user(user.pk))
                or type(item['account_name']) is not str
                or not re.fullmatch(r'[A-Za-z0-9._@-]{1,80}', item['account_name'])):
            return None
        return {'factory_number': factory, 'account_name': item['account_name'], 'prefill_supported': False}
    except (ValueError, TypeError, KeyError, AttributeError, vault.VaultBlocked):
        return None


def require_reviewed_configuration():
    from .views import reviewed_configuration, OAuthBlocked
    try:
        reviewed_configuration()
    except OAuthBlocked as error:
        reason = str(error)
        if reason in {'callback_origin_unverified', 'provider_origin_unverified',
                      'app_credential_missing', 'oauth_configuration_unreviewed'}:
            raise vault.VaultBlocked(reason) from None
        raise vault.VaultBlocked('connection_configuration_unreviewed') from None
    except ValueError:
        raise vault.VaultBlocked('connection_configuration_unreviewed') from None


def exact_origin(request):
    return request.headers.get('Origin') == getattr(settings, 'MES_USER_FRONTEND_ORIGIN',
                                                    'https://wj-reporting.onrender.com')


def login_claims(token, diagnostic=False):
    from .session_guard import login_identity, LoginRejected
    if diagnostic is True and token.get('mes_sid') is None and token.get('mes_login_exp') is None:
        raise vault.VaultBlocked('legacy_login_required')
    try:
        return login_identity(token)
    except LoginRejected:
        raise vault.VaultBlocked('new_login_required') from None


class ConnectionAPI(APIView):
    authentication_classes = [ScopedJWTAuthentication]
    permission_classes = [IsAuthenticated]

    def handle_exception(self, exc):
        # The global legacy handler includes str(exc) on 500s. This credential
        # boundary must never render arbitrary exception/provider contents.
        status = (401 if isinstance(exc, (AuthenticationFailed, NotAuthenticated))
                  else 403 if isinstance(exc, PermissionDenied)
                  else 400 if isinstance(exc, (ParseError, ValidationError)) else 503)
        return Response({'detail': 'connection_unavailable'}, status=status)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'no-store, max-age=0'
        response['Referrer-Policy'] = 'no-referrer'
        return response

    def require_action(self, request):
        if not secure_request(request) or not exact_origin(request):
            raise vault.VaultBlocked('secure_origin_required')


class ConnectionStatus(ConnectionAPI):
    def get(self, request):
        data = dict(enabled=bridge_ready(), status='disabled', reason='connection_disabled',
                    expires_at=None, can_connect=False, can_disconnect=False,
                    mode='stored_identity' if vault.enabled() else 'identity_only', live_ready=False,
                    login_hint=login_hint(request.user))
        if not bridge_ready():
            return Response(data)
        try:
            reason = secure_request_reason(request)
            if reason is not None:
                raise vault.VaultBlocked(reason)
            if not vault.eligible(request.user):
                raise vault.VaultBlocked(ineligible_account_reason(request.user))
            require_reviewed_configuration()
            login_digest, _ = login_claims(request.auth, diagnostic=True)
            stored_login = MESLoginSession.objects.filter(pk=login_digest).first()
            # A fresh signed WJ login can inspect actor-bound metadata without
            # registering a session on GET. Existing markers must remain valid.
            if stored_login is not None:
                vault._login(request.user, login_digest)
            vault.expected_user(request.user.pk)
            row = MESCredential.objects.filter(pk=request.user.pk).first()
            data.update(status='disconnected', reason='connection_missing', can_connect=True,
                        can_disconnect=bool(row and row.revoked_at is None))
            if vault.enabled():
                configuration = vault.policy()
                if row is not None:
                    result = vault.decision(request.user, row, login_digest, configuration)
                    data.update(status='connected' if result.action == 'reuse_candidate' else 'reconnect_required',
                                reason=status_reason(result.reason),
                                expires_at=min(row.expires_at, row.idle_expires_at).isoformat()
                                           if result.action == 'reuse_candidate' else None)
            return Response(data)
        except vault.VaultBlocked as error:
            data.update(status='blocked', reason=status_reason(str(error)), can_connect=False)
            return Response(data)


class ConnectionLaunch(ConnectionAPI):
    @sensitive_variables()
    def post(self, request):
        try:
            self.require_action(request)
            pilot_scoped = pilot_route_scope_required(request.user, request.auth or {})
            request.user._inspection_pilot_scope = pilot_scoped
            if (not bridge_ready() or type(request.data) is not dict
                    or set(request.data) - {'diagnostic_request_uid'} or not vault.eligible(request.user)):
                raise vault.VaultBlocked('connection_unavailable')
            diagnostic_uid = request.data.get('diagnostic_request_uid')
            if 'diagnostic_request_uid' in request.data:
                from uuid import UUID
                from production.mes_create_diagnostic import require_diagnostic_reconnect
                from production.plan_workflow import WorkflowConflict
                try:
                    if type(diagnostic_uid) is not str or str(UUID(diagnostic_uid)) != diagnostic_uid:
                        raise ValueError()
                    require_diagnostic_reconnect(diagnostic_uid, request.user.pk)
                except (ValueError, WorkflowConflict):
                    return Response({'detail': 'diagnostic_reconnect_unavailable'}, status=409)
            require_reviewed_configuration()
            if getattr(settings, 'MES_USER_TOKEN_STORAGE_ENABLED', False):
                vault.policy()  # Unknown expiry/key policy must fail before code/ticket issuance.
            # Reuse the server-selected OAuth policy; no provider call or code issuance.
            vault.expected_user(request.user.pk)
            login_digest, expires = login_claims(request.auth)
            with transaction.atomic():
                user = vault._lock_user(request.user.pk)
                user._inspection_pilot_scope = pilot_scoped
                if not vault.eligible(user):
                    raise vault.VaultBlocked('account_unavailable')
                if diagnostic_uid is not None:
                    try:
                        require_diagnostic_reconnect(diagnostic_uid, user.pk)
                    except WorkflowConflict:
                        raise vault.VaultBlocked('connection_unavailable') from None
                authorization = vault.authorization_digest(user)
                from .session_guard import check_known_login, session_version
                check_known_login(user, request.auth)
                if session_version(request.auth) != 2:
                    MESLoginSession.objects.get_or_create(pk=login_digest,
                        defaults=dict(actor_id=user.pk, expires_at=expires, authorization_digest=authorization))
                session = vault._login(user, login_digest, lock=True)
                MESLoginTicket.objects.filter(actor_id=user.pk, login_digest=login_digest,
                    consumed_at__isnull=True).update(consumed_at=timezone.now())
                ticket = secrets.token_urlsafe(32)
                MESLoginTicket.objects.create(digest=vault.digest('ticket', ticket), actor_id=user.pk,
                    login_digest=login_digest, authorization_digest=authorization,
                    login_revision=session.revision,
                    diagnostic_request_uid=diagnostic_uid,
                    expires_at=timezone.now() + timedelta(seconds=60))
            return Response(dict(ticket=ticket, expires_in=60,
                submit_url=settings.MES_USER_OAUTH_CALLBACK_ORIGIN + BRIDGE_PATH))
        except vault.VaultBlocked:
            return Response({'detail': 'connection_unavailable'}, status=403)


class ConnectionDisconnect(ConnectionAPI):
    def post(self, request):
        try:
            self.require_action(request)
            if request.data:
                raise vault.VaultBlocked('invalid_request')
            login_digest, _ = login_claims(request.auth)
            # Serialize admission with logout and identity changes. A genuine
            # fresh login may deliberately disconnect its actor's connection
            # before ever launching MES; no login marker is needed for this.
            with transaction.atomic():
                user = vault._lock_user(request.user.pk)
                user._inspection_pilot_scope = pilot_route_scope_required(user, request.auth or {})
                if (not vault.eligible(user) or not token_matches_current_password(
                        user, request.auth, user.profile)):
                    raise vault.VaultBlocked('account_unavailable')
                from .session_guard import check_known_login
                check_known_login(user, request.auth)
                vault.revoke_actor(user.pk, login_digest=login_digest,
                                   reason='disconnected', revoke_login=False)
            return Response({'disconnected': True})
        except vault.VaultBlocked:
            return Response({'detail': 'disconnect_unavailable'}, status=403)


class ConnectionRecheck(ConnectionAPI):
    def post(self, request):
        try:
            self.require_action(request)
            if request.data:
                raise vault.VaultBlocked('invalid_request')
            pilot_scoped = pilot_route_scope_required(request.user, request.auth or {})
            request.user._inspection_pilot_scope = pilot_scoped
            if not vault.eligible(request.user):
                raise vault.VaultBlocked('account_unavailable')
            login_digest, _ = login_claims(request.auth)
            from .views import get_provider
            return Response(vault.recheck_identity(request.user.pk, login_digest, get_provider(),
                                                   pilot_scoped=pilot_scoped))
        except AppCredentialUnavailable:
            return Response({'detail': 'mes_connection_temporarily_unavailable'}, status=503)
        except vault.VaultBlocked as error:
            if str(error) == 'provider_temporarily_unavailable':
                return Response({'detail': 'mes_connection_temporarily_unavailable'}, status=503)
            return Response({'detail': 'reconnect_required'}, status=409)


class ConnectionLogout(ConnectionAPI):
    # Revocation-only proof: verify signature/expiry, even after role/password
    # changes. No user permission, credential use or session creation is granted.
    authentication_classes = []
    permission_classes = [AllowAny]

    @sensitive_variables()
    def post(self, request):
        try:
            self.require_action(request)
            if type(request.data) is not dict or set(request.data) - {'refresh'}:
                raise ValueError()
            auth = JWTAuthentication()
            header = auth.get_header(request)
            raw = auth.get_raw_token(header) if header is not None else None
            refresh_value = request.data.get('refresh')
            refresh_proof = None
            if refresh_value:
                try:
                    refresh_proof = UntypedToken(refresh_value)
                    if refresh_proof.get('token_type') != 'refresh':
                        raise ValueError()
                except Exception:
                    refresh_proof = None
            if raw is not None:
                # Expired access is only an identity comparison when a current,
                # signed refresh proves this same login. Never issues a token.
                token = jwt.decode(raw, token_backend.get_verifying_key(raw),
                    algorithms=[token_backend.algorithm], audience=token_backend.audience,
                    issuer=token_backend.issuer, leeway=token_backend.get_leeway(),
                    options={'verify_aud': token_backend.audience is not None,
                             'verify_exp': refresh_proof is None,
                             'require': ['exp', 'iat', 'jti', 'token_type']})
                if token.get('token_type') != 'access':
                    raise ValueError()
            elif header is None and refresh_proof is not None:
                token = refresh_proof
            else:
                raise ValueError()
            actor_id = token.get('user_id')
            if type(actor_id) is not int or actor_id < 1:
                raise ValueError()
            if refresh_proof is not None:
                if (refresh_proof.get('user_id') != actor_id
                        or refresh_proof.get('mes_sid') != token.get('mes_sid')
                        or refresh_proof.get('mes_login_exp') != token.get('mes_login_exp')):
                    raise ValueError()
            sid = token.get('mes_sid')
            if type(sid) is str and re.fullmatch(r'[A-Za-z0-9_-]{43}', sid):
                expires = token.get('mes_login_exp')
                if type(expires) is not int:
                    raise ValueError()
                expiry = datetime.fromtimestamp(expires, dt_timezone.utc)
                if expiry > timezone.now() + timedelta(days=31):
                    raise ValueError()
                # End only this signed WJ login family. The inspector's stored
                # MES connection survives logout and remains actor-bound.
                vault.revoke_actor(actor_id, login_digest=vault.digest('client-login', sid),
                                   login_expires_at=expiry, reason='logout')
            # Legacy tokens cannot establish a MES connection; preserve their
            # ordinary local logout while blacklisting only the supplied refresh.
            if refresh_proof is not None:
                # Signature, lifetime and type checked above. An already
                # blacklisted proof can only repeat revocation, never refresh.
                RefreshToken(refresh_value, verify=False).blacklist()
            return Response({'disconnected': True})
        except Exception:
            return Response({'detail': 'logout_unconfirmed'}, status=401)


@csrf_exempt  # Nonambient single-use ticket, exact Origin, 60s and role checks.
@sensitive_variables()
@sensitive_post_parameters()
@require_POST
def establish_session(request):
    def refused():
        return HttpResponse('MES 연결을 시작할 수 없습니다.', status=403)
    if (not bridge_ready() or not secure_request(request) or not exact_origin(request)
            or getattr(request, 'mes_oauth_query_present', False)
            or set(request.POST) != {'ticket'} or len(request.POST.getlist('ticket')) != 1):
        return refused()
    ticket = request.POST.get('ticket', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', ticket):
        return refused()
    actor_id = MESLoginTicket.objects.filter(pk=vault.digest('ticket', ticket)).values_list('actor_id', flat=True).first()
    if actor_id is None:
        return refused()
    try:
        with transaction.atomic():
            user = vault._lock_user(actor_id)
            row = MESLoginTicket.objects.select_for_update().get(pk=vault.digest('ticket', ticket))
            if row.consumed_at is not None or row.expires_at <= timezone.now():
                raise vault.VaultBlocked('ticket_unavailable')
            vault._login(user, row.login_digest, lock=True, revision=row.login_revision)
            if row.authorization_digest != vault.authorization_digest(user):
                raise vault.VaultBlocked('ticket_unavailable')
            if row.diagnostic_request_uid is not None:
                from production.mes_create_diagnostic import require_diagnostic_reconnect
                require_diagnostic_reconnect(row.diagnostic_request_uid, user.pk)
            row.consumed_at = timezone.now()
            row.save(update_fields=['consumed_at'])
            request.session.flush()
            login(request, user, backend='django.contrib.auth.backends.ModelBackend')
            request.session[SESSION_KEY] = row.login_digest
            request.session['mes_login_revision'] = row.login_revision
            request.session[BRIDGE_ONLY] = True
            if row.diagnostic_request_uid is not None:
                request.session[DIAGNOSTIC_SESSION_KEY] = str(row.diagnostic_request_uid)
            request.session.set_expiry(10 * 60)  # Bridge ceremony only, never MES token lifetime.
        return HttpResponseRedirect('/integrations/blacklake/start/')
    except Exception:
        return refused()


class BridgeRestrictionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # Ordinary Django staff/admin cookies do not pass through JWT authentication.
        # Keep configured pilots confined even if staff/superuser flags are
        # accidentally granted, and independently of the pilot enable switch.
        if ((request.path_info == '/admin' or request.path_info.startswith('/admin/')
                or request.path_info.rstrip('/') == '/staff/signup-approvals')
                and request.user.is_authenticated
                and pilot_route_scope_required(request.user, {})):
            response = HttpResponse('검사 전용 계정은 관리자 기능을 사용할 수 없습니다.', status=403)
            response['Cache-Control'] = 'no-store, max-age=0'
            response['X-Frame-Options'] = 'DENY'
            return response
        if request.session.get(BRIDGE_ONLY) and request.path not in {
                BRIDGE_PATH, '/integrations/blacklake/start/', '/integrations/blacklake/callback/'}:
            response = HttpResponse('이 세션은 MES 연결에만 사용할 수 있습니다.', status=403)
            response['Cache-Control'] = 'no-store, max-age=0'
            response['X-Frame-Options'] = 'DENY'
            return response
        return self.get_response(request)
