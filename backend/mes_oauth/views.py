"""Session-bound, one-use user identity check; disabled until separately approved.

Blacklake sends ?code=... to a fixed static relay, which passes it in a fragment
to this backend so its HTTP request URL contains no code. Start binds a random
browser cookie to an existing backend
Django login and a server-selected expected MES identity. Callback GET performs
no exchange. Same-origin, CSRF-protected POST consumes the attempt before I/O.
This flow verifies identity only. Explicitly enabled storage uses a bound,
encrypted vault; it grants no inspection/production/inventory authority. The
separate JWT bridge creates only a restricted MES-connection backend session.
"""
from datetime import timedelta
import hashlib
import json
import logging
import re
import secrets
from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError, transaction
from django.http import HttpResponse, JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.crypto import salted_hmac, constant_time_compare
from django.utils.html import format_html
from django.utils.safestring import mark_safe
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables
from django.views.decorators.http import require_http_methods

from .client import BlacklakeUserOAuthClient, ORIGINS
from .app_tokens import app_credentials_configured, app_credential_binding
from .callback_app_tokens import get_app_access_token
from .models import OAuthAttempt
from .identity import verify_user_context
from .diagnostics import (CALLBACK_FAILURE_CODES, expiry_metadata, failure_expiry_metadata,
                          safe_callback_failure_code, safe_expiry_metadata)
from .access import can_verify_identity
from .security import REFERRER_POLICY
from quality.archive_access import is_archive_identity_marker


START = '/integrations/blacklake/start/'
CALLBACK = '/integrations/blacklake/callback/'
RELAY_URL = 'https://wj-reporting.onrender.com/integrations/blacklake/relay.html'
WJ_RETURN_URL = 'https://wj-reporting.onrender.com/quality/inspection-requests'
# Existing permission-controlled WJLEE_OAUTH_BTN_20261005, observed 2026-10-08.
# Unlike the custom-page menu, this button opens the registered relay top-level.
# This is a landing page only, not an authorize URL, grant or account mapping.
WJ_REGISTERED_LAUNCH_URL = 'https://v3-ali.blacklake.cn/custom/customObject/cust_object9__c'
COOKIE = '__Host-wj-mes-oauth'
ATTEMPT_SECONDS = 300  # local attempt TTL; not the user token lifetime


def _record_failure_diagnostic(reason, provider, *, expiry=None):
    # Only fixed enums and bounded integers reach this WARNING event. No
    # request, actor, attempt digest, exception, URL or response body is logged.
    try:
        if type(reason) is not str or reason not in CALLBACK_FAILURE_CODES:
            reason = 'identity_verification_failed'
        if type(provider) is BlacklakeUserOAuthClient:
            snapshot = BlacklakeUserOAuthClient.diagnostic_snapshot(provider)
        else:
            count = 0 if provider is None else None
            snapshot = {'exchange_http_attempts': count, 'userinfo_http_attempts': count}
        diagnostic = {'reason': reason}
        for key in ('exchange_http_attempts', 'userinfo_http_attempts',
                    'exchange_http_status', 'userinfo_http_status',
                    'exchange_api_code', 'userinfo_api_code'):
            value = snapshot.get(key) if type(snapshot) is dict else None
            if key.endswith('_attempts'):
                low, high = 0, 1
            elif key.endswith('_status'):
                low, high = 100, 599
            else:
                low, high = -2_147_483_648, 2_147_483_647
            diagnostic[key] = value if type(value) is int and low <= value <= high else None
        safe_expiry = safe_expiry_metadata(expiry)
        if safe_expiry is not None:
            diagnostic['expiry'] = safe_expiry
        logging.getLogger('mes_oauth.diagnostics').warning(
            'mes_oauth_identity_failure %s',
            json.dumps(diagnostic, sort_keys=True, separators=(',', ':')))
    except Exception:
        # Diagnostic collection/handlers must not replace the fixed failure
        # response or expose a provider exception via a chained traceback.
        return


class OAuthBlocked(Exception):
    pass


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _session_digest(request):
    return salted_hmac('mes-oauth-session', request.session.session_key or '',
                       algorithm='sha256').hexdigest()


def reviewed_configuration():
    origin = getattr(settings, 'MES_USER_OAUTH_CALLBACK_ORIGIN', '')
    if type(origin) is not str or len(origin) > 255:
        raise OAuthBlocked('callback_origin_unverified')
    parsed = urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.port is not None or parsed.path or parsed.query or parsed.fragment):
        raise OAuthBlocked('callback_origin_unverified')
    provider_origin = getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', '')
    if provider_origin not in ORIGINS:
        raise OAuthBlocked('provider_origin_unverified')
    if not app_credentials_configured():
        raise OAuthBlocked('app_credential_missing')
    review = getattr(settings, 'MES_USER_OAUTH_REVIEW_REFERENCE', '')
    launch = getattr(settings, 'MES_USER_OAUTH_LAUNCH_URL', '')
    if type(launch) is not str or len(launch) > 1024:
        raise OAuthBlocked('oauth_configuration_unreviewed')
    launch_parts = urlsplit(launch)
    if (type(review) is not str or not review.strip() or len(review) > 200
            or launch_parts.scheme + '://' + launch_parts.netloc != provider_origin
            or launch_parts.query or launch_parts.fragment):
        raise OAuthBlocked('oauth_configuration_unreviewed')
    # Replace only this WJ deployment's observed generic home landing. Preserve
    # every explicitly configured launch path and every other tenant/origin.
    if (origin == 'https://wj-reporting-backend.onrender.com'
            and provider_origin == 'https://v3-ali.blacklake.cn'
            and launch_parts.path in {'', '/'}):
        launch = WJ_REGISTERED_LAUNCH_URL
    return origin, provider_origin, launch, review


def _policy(request):
    if not getattr(settings, 'MES_USER_OAUTH_ENABLED', False):
        raise OAuthBlocked('oauth_disabled')
    if (not request.is_secure() or settings.DEBUG or not settings.SESSION_COOKIE_SECURE
            or not settings.SESSION_COOKIE_HTTPONLY or not settings.CSRF_COOKIE_SECURE
            or settings.SESSION_COOKIE_SAMESITE != 'Lax'
            or settings.SESSION_COOKIE_DOMAIN is not None
            or settings.CSRF_COOKIE_DOMAIN is not None
            or settings.SESSION_ENGINE != 'django.contrib.sessions.backends.db'):
        raise OAuthBlocked('secure_backend_session_required')
    if not can_verify_identity(request.user) or not request.session.session_key:
        raise OAuthBlocked('backend_login_required')
    # A concurrent Django logout deletes the durable session, but an in-flight
    # request still has a cached session/user. Never authorize from that cache.
    persisted = request.session.__class__(session_key=request.session.session_key).load()
    if (persisted.get('_auth_user_id') != str(request.user.pk)
            or not constant_time_compare(persisted.get('_auth_user_hash', ''),
                                         request.user.get_session_auth_hash())):
        raise OAuthBlocked('backend_login_required')
    # Match the durable restrictions of ScopedJWTAuthentication. Django's
    # AuthenticationMiddleware separately validates the session password hash.
    if is_archive_identity_marker(request.user):
        raise OAuthBlocked('restricted_identity')
    try:
        profile = request.user.profile
        if profile.password_reset_required or profile.is_using_temp_password:
            raise OAuthBlocked('password_change_required')
    except ObjectDoesNotExist:
        raise OAuthBlocked('user_profile_required') from None
    # JWT is not a backend session; do not admit the existing Bearer CSRF bypass.
    if request.META.get('HTTP_AUTHORIZATION'):
        raise OAuthBlocked('backend_session_required')
    origin, provider_origin, launch, review = reviewed_configuration()
    if request.get_host() != urlsplit(origin).netloc:
        raise OAuthBlocked('callback_origin_unverified')
    if request.method == 'POST' and request.headers.get('Origin') != origin:
        raise OAuthBlocked('callback_origin_mismatch')
    mapping = getattr(settings, 'MES_USER_OAUTH_USER_MAP', '{}')
    try:
        mapping = json.loads(mapping) if type(mapping) is str else mapping
        value = mapping[str(request.user.pk)] if type(mapping) is dict else None
        if type(value) is not str or not re.fullmatch(r'[1-9][0-9]{0,18}', value):
            raise ValueError()
        expected = int(value)
        if expected > 9_223_372_036_854_775_807:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise OAuthBlocked('expected_identity_unconfigured') from None
    fingerprint = _digest(json.dumps([origin, provider_origin, launch, review, value,
                                      RELAY_URL, 'fragment-relay-v1', app_credential_binding()]))
    if request.session.get('mes_bridge_only') or getattr(settings, 'MES_USER_TOKEN_STORAGE_ENABLED', False):
        from . import vault
        try:
            if not request.session.get('mes_bridge_only'):
                raise vault.VaultBlocked('bridge_session_required')
            revision = request.session.get('mes_login_revision')
            if type(revision) is not int or revision < 1:
                raise vault.VaultBlocked('bridge_session_required')
            vault._login(request.user, request.session.get('mes_login_digest'), revision=revision)
            storage_policy = vault.policy().reuse.review_reference if vault.enabled() else 'identity-only'
            fingerprint = _digest(json.dumps([fingerprint, storage_policy, revision]))
        except vault.VaultBlocked:
            raise OAuthBlocked('connection_unavailable') from None
    return origin, launch, expected, fingerprint


def _headers(response):
    response['Cache-Control'] = 'no-store, max-age=0'
    response['Pragma'] = 'no-cache'
    response['Referrer-Policy'] = REFERRER_POLICY
    response['X-Content-Type-Options'] = 'nosniff'
    response['X-Frame-Options'] = 'DENY'
    return response


def _page(content, *, status=200, callback=False, automatic_start=False,
          automatic_launch=False, connected=False):
    nonce = secrets.token_urlsafe(24)
    # Capture only the documented code in browser memory; immediately remove
    # the query from history. No external assets, analytics or browser storage.
    script = "history.replaceState(null, '', location.pathname);"
    if callback:
        script = """const u=new URL(location.href);
const p=new URLSearchParams(u.hash.slice(1));
const c=p.getAll('code'); history.replaceState(null,'',location.pathname);
document.addEventListener('DOMContentLoaded',()=>{
 const f=document.querySelector('form'); if(!f)return;
 if(u.search||Array.from(p.keys()).some(k=>k!=='code')||
    c.length!==1||!/^[!-~]{1,4096}$/.test(c[0])){f.remove();return;}
 f.elements.code.value=c[0];
 f.querySelector('button[type="submit"]').disabled=false;
 if(f.dataset.autoMesConnect==='true')f.requestSubmit();
});"""
    elif automatic_start:
        script += """document.addEventListener('DOMContentLoaded',()=>{
 if(window.top!==window.self)return;
 const f=document.querySelector('form[data-auto-mes-connect="true"]');
 if(f)f.requestSubmit();
});"""
    elif automatic_launch:
        script += """document.addEventListener('DOMContentLoaded',()=>{
 if(window.top!==window.self)return;
 const a=document.querySelector('a[data-mes-launch]');
 if(a)location.replace(a.href);
});"""
    elif connected:
        # A native form opened this dedicated tab from the original WJ tab.
        # Closing returns focus there; its server status recheck is authoritative.
        script += """document.addEventListener('DOMContentLoaded',()=>{
 const b=document.getElementById('mes-close');
 if(b)b.addEventListener('click',()=>window.close());
 window.close();
});"""
    response = HttpResponse(format_html(
        '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
        '<meta name="referrer" content="{}"><title>MES 사용자 확인</title>'
        '<script nonce="{}">{}</script></head><body>{}</body></html>',
        REFERRER_POLICY, nonce, mark_safe(script), content), status=status)
    response['Content-Security-Policy'] = (
        "default-src 'none'; script-src 'nonce-" + nonce +
        "'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    return _headers(response)


def _blocked(code, status=403):
    # Codes are fixed local strings, never provider messages.
    return _page(format_html('<p>사용자 연결을 진행할 수 없습니다: {}</p>'
                             '<p>원래 WJ 탭에서 현재 사용자와 MES 연결 상태를 확인한 뒤 다시 연결해 주세요.</p>'
                             '<a href="{}">WJ 검사관리로 돌아가기</a>', code, WJ_RETURN_URL), status=status)


def _attempt(request, fingerprint):
    nonce = request.COOKIES.get(COOKIE, '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', nonce):
        raise OAuthBlocked('oauth_attempt_missing')
    attempt = OAuthAttempt.objects.filter(
        nonce_digest=_digest(nonce), actor_id=request.user.pk,
        session_digest=_session_digest(request), policy_digest=fingerprint,
        status='pending', expires_at__gt=timezone.now(),
    ).first()
    if attempt is None:
        raise OAuthBlocked('oauth_attempt_unavailable')
    return attempt


@sensitive_variables()
@sensitive_post_parameters('code')
@csrf_protect
@require_http_methods(['GET', 'POST'])
def start(request):
    try:
        origin, launch, expected, fingerprint = _policy(request)
    except (OAuthBlocked, ValueError):
        return _blocked('oauth_start_unavailable')
    if request.method == 'GET':
        automatic = request.session.get('mes_bridge_only') is True
        return _page(format_html(
            '<h1>MES 사용자 확인</h1><p>기존 백엔드 로그인 사용자에게 지정된 MES 신원을 확인합니다.</p>'
            '<form method="post" action="{}" data-auto-mes-connect="{}"><input type="hidden" name="csrfmiddlewaretoken" value="{}">'
            '<button type="submit">MES 연결 계속</button></form>', origin + START,
            'true' if automatic else 'false', get_token(request)), automatic_start=automatic)
    nonce = secrets.token_urlsafe(32)
    now = timezone.now()
    OAuthAttempt.objects.filter(actor_id=request.user.pk, status='pending').update(
        status='superseded', consumed_at=now)
    OAuthAttempt.objects.create(
        nonce_digest=_digest(nonce), actor_id=request.user.pk,
        session_digest=_session_digest(request), policy_digest=fingerprint,
        expected_user_id=str(expected), expires_at=now + timedelta(seconds=ATTEMPT_SECONDS))
    response = _page(format_html(
        '<p>MES 연결 화면으로 이동합니다. 이미 로그인했다면 기존 계정을 사용합니다.</p>'
        '<a data-mes-launch href="{}" rel="noreferrer noopener" target="_blank">MES 연결 화면 열기</a>'
        '<p>다른 사용자이면 MES에서 본인의 계정으로 전환해 주세요.</p>', launch),
        automatic_launch=request.session.get('mes_bridge_only') is True)
    response.set_cookie(COOKIE, nonce, max_age=ATTEMPT_SECONDS, secure=True,
                        httponly=True, samesite='Lax', path='/')
    return response


def get_provider():
    # Only reached after one-use reservation; supply is selected server-side.
    return BlacklakeUserOAuthClient(
        origin=settings.MES_USER_OAUTH_PROVIDER_ORIGIN,
        app_access_token=get_app_access_token(),
        app_token_header=getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token'))


@sensitive_variables()
@sensitive_post_parameters('code')
@csrf_protect
@require_http_methods(['GET', 'POST'])
def callback(request):
    try:
        origin, _, expected, fingerprint = _policy(request)
        attempt = _attempt(request, fingerprint)
    except (OAuthBlocked, ValueError):
        return _blocked('oauth_callback_unavailable')
    if getattr(request, 'mes_oauth_query_present', False):
        return _blocked('oauth_callback_query_rejected', 400)
    if request.method == 'GET':
        return _page(format_html(
            '<p>이미 로그인한 WJ 사용자에게 지정된 MES 신원만 확인합니다.</p>'
            '<form method="post" action="{}" data-auto-mes-connect="{}"><input type="hidden" name="csrfmiddlewaretoken" value="{}">'
            '<input type="hidden" name="code"><button type="submit" disabled>사용자 신원 확인</button></form>',
            origin + CALLBACK, 'true' if request.session.get('mes_bridge_only') is True else 'false',
            get_token(request)), callback=True)
    if (set(request.POST) - {'csrfmiddlewaretoken', 'code'} or len(request.POST.getlist('code')) != 1):
        return _blocked('oauth_code_invalid', 400)
    code = request.POST.get('code', '')
    if not code or len(code) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in code):
        return _blocked('oauth_code_invalid', 400)
    now = timezone.now()
    code_digest = salted_hmac('mes-oauth-code',
        settings.MES_USER_OAUTH_PROVIDER_ORIGIN + '|' + code, algorithm='sha256').hexdigest()
    try:
        with transaction.atomic():
            claimed = OAuthAttempt.objects.filter(
                nonce_digest=attempt.nonce_digest, status='pending', expires_at__gt=now,
            ).update(status='processing', consumed_at=now, code_digest=code_digest)
    except IntegrityError:
        OAuthAttempt.objects.filter(pk=attempt.pk, status='pending').update(
            status='rejected', consumed_at=now, error_code='authorization_code_reused')
        return _blocked('authorization_code_reused', 409)
    if claimed != 1:
        return _blocked('oauth_attempt_already_used', 409)
    provider = None
    storage_expiry = None
    try:
        stored_until = None
        from . import vault
        with transaction.atomic():
            # Serialize dispatch and acceptance with logout/disconnect. The
            # one-use reservation was already committed before provider I/O.
            request.user = vault._lock_user(request.user.pk)
            _, _, dispatch_expected, dispatch_fingerprint = _policy(request)
            if dispatch_expected != expected or dispatch_fingerprint != fingerprint:
                raise OAuthBlocked('connection_changed')
            provider = get_provider()
            control_qc = getattr(settings, 'MES_USER_OAUTH_CONTROL_QC_ID', '')
            if control_qc:
                provider.check_app_read_access(int(control_qc))
            exchange_started_at = timezone.now()
            context = verify_user_context(expected, provider.exchange(code), info_loader=provider.userinfo)
            _, _, current_expected, current_fingerprint = _policy(request)
            if current_expected != expected or current_fingerprint != fingerprint:
                raise OAuthBlocked('connection_changed')
            if vault.enabled():
                received_at = timezone.now()
                storage_expiry = expiry_metadata(context.expire,
                    request_started_at=exchange_started_at, received_at=received_at)
                stored_until = vault.store_context(request.user.pk, request.session.get('mes_login_digest'), context,
                    request_started_at=exchange_started_at, received_at=received_at,
                    login_revision=request.session.get('mes_login_revision'))
                storage_expiry = None
            OAuthAttempt.objects.filter(pk=attempt.pk, status='processing').update(
                status='verified', verified_at=timezone.now())
        del context
    except Exception as error:
        reason = safe_callback_failure_code(error)
        OAuthAttempt.objects.filter(pk=attempt.pk, status='processing').update(
            status='rejected', error_code=reason)
        _record_failure_diagnostic(reason, provider, expiry=failure_expiry_metadata(error, storage_expiry))
        response = _blocked('identity_verification_failed', 502)
    else:
        payload = {'identity_verified': True, 'expiry_verified': False, 'live_ready': False}
        if stored_until is not None:
            payload.update(expiry_verified=True, credential_stored=True, expires_at=stored_until.isoformat())
        if request.session.get('mes_bridge_only') is True and 'text/html' in request.headers.get('Accept', ''):
            response = _page(format_html(
                '<h1>{}</h1><p>원래 WJ 탭으로 돌아가 연결 상태를 확인합니다.</p>'
                '<button type="button" id="mes-close">이 창 닫기</button> '
                '<a href="{}">WJ 검사관리로 돌아가기</a>',
                'MES 계정 연결 완료' if stored_until is not None else 'MES 사용자 확인 완료', WJ_RETURN_URL),
                connected=True)
        else:
            response = _headers(JsonResponse(payload))
    response.delete_cookie(COOKIE, path='/', samesite='Lax')
    return response
