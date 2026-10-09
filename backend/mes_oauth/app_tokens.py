"""Opt-in ALI app-token supply; no user-token refresh or QC authority.

One memory cache/lock per server process. No network on configuration inspection,
no shared cache, secret persistence, background refresh or request retry. Multiple
workers can issue separately; this is not a deployment-wide issuance quota.
"""
import json
from datetime import datetime, timezone
import os
import re
import threading
import time

import requests
from django.conf import settings
from django.utils.crypto import salted_hmac
from django.views.decorators.debug import sensitive_variables

from .client import APP_TOKEN_HEADERS, _pairs, app_credential_configured


ALI = 'https://v3-ali.blacklake.cn'
ISSUE_PATH = '/api/openapi/domain/api/v1/access_token/_get_access_token'
SAFETY_SECONDS = 60
MAX_CACHE_SECONDS = 3600  # local upper bound, never a guessed provider lifetime
# The first-party SDK represents the provider TTL as Long. Its range is a
# schema bound; local reuse remains limited by MAX_CACHE_SECONDS. User-token
# expiry remains a separate, explicitly reviewed contract.
MAX_PROVIDER_DURATION_SECONDS = 2**63 - 1
FAILURE_COOLDOWN_SECONDS = 30


class AppCredentialUnavailable(Exception):
    """Fixed reason only; provider payloads/exceptions never escape."""


def _declared_app_id():
    """Keep the deployed OAuth app scope and an existing vault scope aligned."""
    oauth = getattr(settings, 'MES_USER_OAUTH_APP_ID', '')
    stored = getattr(settings, 'MES_USER_TOKEN_APP_ID', '')
    for value in (oauth, stored):
        if (type(value) is not str or (value and
                (not re.fullmatch(r'[1-9][0-9]{0,18}', value) or int(value) > 2**63 - 1))):
            raise AppCredentialUnavailable('app_credential_unconfigured')
    if oauth and stored and oauth != stored:
        raise AppCredentialUnavailable('app_credential_unconfigured')
    return oauth or stored


@sensitive_variables()
def _configuration():
    header = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token')
    if type(header) is not str or header not in APP_TOKEN_HEADERS:
        raise AppCredentialUnavailable('app_credential_unconfigured')
    target = getattr(settings, 'MES_USER_OAUTH_CONTROL_QC_ID', '')
    if (type(target) is not str or (target and (not re.fullmatch(r'[1-9][0-9]{0,18}',target)
            or int(target)>2**63-1))):
        raise AppCredentialUnavailable('app_credential_unconfigured')
    mode = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_SOURCE', 'static')
    if mode == 'static':
        token = getattr(settings, 'MES_USER_OAUTH_APP_ACCESS_TOKEN', '')
        if app_credential_configured(token):
            return mode, token, ''
    elif mode == 'server' and getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', '') == ALI:
        app_id = _declared_app_id()
        source = getattr(settings, 'MES_USER_OAUTH_APP_CREDENTIAL_SOURCE', 'dedicated')
        if source == 'dedicated':
            key = getattr(settings, 'MES_USER_OAUTH_APP_KEY', '')
            secret = getattr(settings, 'MES_USER_OAUTH_APP_SECRET', '')
        elif source == 'existing_mes':
            # An explicit operator selection, never an automatic fallback.
            # App ID records the reviewed intended binding, not provider proof.
            if (type(app_id) is not str or not re.fullmatch(r'[1-9][0-9]{0,18}', app_id)
                    or int(app_id) > 2**63 - 1):
                raise AppCredentialUnavailable('app_credential_unconfigured')
            key = getattr(settings, 'MES_APP_KEY', '')
            secret = getattr(settings, 'MES_APP_SECRET', '')
        else:
            raise AppCredentialUnavailable('app_credential_unconfigured')
        if all(type(value) is str and value.strip() and len(value) <= 8192
               for value in (key, secret)):
            return mode, key, secret
    raise AppCredentialUnavailable('app_credential_unconfigured')


def app_credentials_configured():
    try:
        _configuration()
        return True
    except AppCredentialUnavailable:
        return False


@sensitive_variables()
def app_credential_binding():
    # Bind user credentials to the configured app key/version, not each short
    # lived app token: routine app renewal must not revoke the user connection.
    configuration = [_configuration(),
        getattr(settings, 'MES_USER_OAUTH_APP_CREDENTIAL_SOURCE', 'dedicated'),
        _declared_app_id(),
        getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token'),
        getattr(settings, 'MES_USER_OAUTH_CONTROL_QC_ID', '')]
    return salted_hmac('mes-oauth-app-source', json.dumps(configuration),
                       algorithm='sha256').hexdigest()


class AppTokenSupplier:
    def __init__(self, *, session_factory=None, clock=None):
        self._session_factory = session_factory or requests.Session
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._binding = None
        self._token = None
        self._deadline = 0
        self._retry_after = 0
        self._attempts = 0
        self._provider_seconds = None
        self._issued_at = None
        self._cache_owner_pid = os.getpid()

    def _existing_state(self):
        """Inspect under the caller's lock without changing or obtaining supply."""
        if getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is not True:
            return False, 'oauth_disabled', 0
        try:
            mode, _, _ = _configuration()
            if mode == 'static':
                return True, 'static_supply', 0
            now = self._clock()
            if (self._binding == app_credential_binding() and self._token is not None
                    and self._cache_owner_pid == os.getpid() and now < self._deadline):
                return True, 'cached_supply', max(0, int(self._deadline - now))
            return False, 'existing_supply_unavailable', 0
        except Exception:
            return False, 'app_credential_unconfigured', 0

    def status(self):
        """Server diagnostics only: no token, key, secret, payload or identity."""
        with self._lock:
            available, reason, remaining = self._existing_state()
            mode = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_SOURCE', 'static')
            source = getattr(settings, 'MES_USER_OAUTH_APP_CREDENTIAL_SOURCE', 'dedicated')
            header = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token')
            return {'http_attempts': self._attempts,
                    'supply_mode': mode if type(mode) is str and mode in ('static', 'server') else 'unknown',
                    'credential_source': source if type(source) is str and source in ('dedicated', 'existing_mes') else 'unknown',
                    'app_token_header': header if type(header) is str and header in APP_TOKEN_HEADERS else 'unknown',
                    'provider_expire_seconds': self._provider_seconds,
                    'issued_at': self._issued_at,
                    'usable_for_seconds': remaining,
                    'available': available, 'reason': reason}

    @sensitive_variables()
    def _accept_callback_supply(self, source):
        """Accept a verified callback's in-memory cache without renewing its TTL.

        The callback owns its lock while calling this method. The source and
        destination must use the same process and monotonic clock domain.
        No token is returned, serialized, logged, or fetched by this operation.
        """
        with self._lock:
            if getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is not True:
                return False
            try:
                mode, _, _ = _configuration()
                if (mode != 'server' or source._clock is not self._clock
                        or source._cache_owner_pid != os.getpid()
                        or source._binding != app_credential_binding()
                        or source._token is None or self._clock() >= source._deadline):
                    return False
                self._binding, self._token = source._binding, source._token
                self._deadline = source._deadline
                self._provider_seconds = source._provider_seconds
                self._issued_at = source._issued_at.isoformat()
                self._cache_owner_pid = os.getpid()
                self._retry_after = 0
                return True
            except Exception:
                return False

    @sensitive_variables()
    def peek_existing(self):
        """Read a usable static/cached APP token without issuance or renewal.

        Production status reads must preserve the existing user connection.
        A missing process cache is an unavailable supply, never permission to
        obtain a new APP or USER credential.
        """
        if getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is not True:
            raise AppCredentialUnavailable('oauth_disabled')
        with self._lock:
            mode, key, _ = _configuration()
            if mode == 'static':
                return key
            if (self._binding == app_credential_binding() and self._token is not None
                    and self._cache_owner_pid == os.getpid()
                    and self._clock() < self._deadline):
                return self._token
            raise AppCredentialUnavailable('app_credential_existing_supply_unavailable')

    @sensitive_variables()
    def get(self):
        # This gate also prevents a future caller from minting while OAuth OFF.
        if getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is not True:
            raise AppCredentialUnavailable('oauth_disabled')
        with self._lock:
            mode, key, secret = _configuration()
            binding = app_credential_binding()
            if binding != self._binding or self._cache_owner_pid != os.getpid():
                self._binding, self._token = binding, None
                self._deadline = self._retry_after = 0
                self._provider_seconds = self._issued_at = None
                self._cache_owner_pid = os.getpid()
            if mode == 'static':
                return key
            now = self._clock()
            if self._token is not None and now < self._deadline:
                return self._token
            self._token = None
            self._provider_seconds = self._issued_at = None
            if now < self._retry_after:
                raise AppCredentialUnavailable('app_credential_cooldown')
            try:
                issued_at = datetime.now(timezone.utc).isoformat()
                token, duration = self._issue(key, secret)
                deadline = now + min(duration, MAX_CACHE_SECONDS) - SAFETY_SECONDS
                if self._clock() >= deadline:
                    raise AppCredentialUnavailable('app_credential_expired')
                self._token, self._deadline = token, deadline
                self._provider_seconds, self._issued_at = duration, issued_at
                self._cache_owner_pid = os.getpid()
                self._retry_after = 0
                return token
            except Exception:
                self._retry_after = self._clock() + FAILURE_COOLDOWN_SECONDS
                raise AppCredentialUnavailable('app_credential_unavailable') from None

    @sensitive_variables()
    def _issue(self, key, secret):
        with self._session_factory() as session:
            session.trust_env = False
            self._attempts += 1  # Session.post invocation, not provider receipt.
            with session.post(
                ALI + ISSUE_PATH, json={'appKey': key, 'appSecret': secret},
                headers={'Accept': 'application/json'}, timeout=(3, 10),
                allow_redirects=False, stream=True,
            ) as response:
                self._http_status = response.status_code
                if type(response.status_code) is not int or response.status_code != 200 or response.history:
                    raise AppCredentialUnavailable('app_credential_rejected')
                chunks, size = [], 0
                for chunk in response.iter_content(4096):
                    size += len(chunk)
                    if size > 65536:
                        raise AppCredentialUnavailable('app_credential_response_invalid')
                    chunks.append(chunk)
                body = json.loads(b''.join(chunks).decode('utf-8'), object_pairs_hook=_pairs,
                    parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                code = body.get('code') if type(body) is dict else None
                if type(code) is int and -2**31 <= code < 2**31:
                    self._api_code = code
                if type(code) is not int or code != 200:
                    raise AppCredentialUnavailable('app_credential_rejected')
                data = body.get('data')
                if type(data) is not dict:
                    raise AppCredentialUnavailable('app_credential_response_invalid')
                token, duration = data.get('appAccessToken'), data.get('expire')
                # Preserve bounded TTL metadata even if another field fails,
                # without retaining the response body or credential.
                self._provider_seconds = (duration if type(duration) is int
                    and SAFETY_SECONDS < duration <= MAX_PROVIDER_DURATION_SECONDS else None)
                if (type(token) is not str or not 1 <= len(token) <= 8192
                        or any(ord(char) < 33 or ord(char) > 126 for char in token)
                        or type(duration) is not int
                        or not SAFETY_SECONDS < duration <= MAX_PROVIDER_DURATION_SECONDS):
                    raise AppCredentialUnavailable('app_credential_response_invalid')
                return token, duration


_supplier = AppTokenSupplier()


@sensitive_variables()
def get_existing_app_access_token():
    return _supplier.peek_existing()


@sensitive_variables()
def get_app_access_token():
    return _supplier.get()


def app_token_status():
    return _supplier.status()


def app_supply_readiness():
    """Pure, bounded metadata for the current serving worker; never issues APP."""
    status = app_token_status()
    available = status.get('available') is True
    reasons = {'oauth_disabled', 'static_supply', 'cached_supply',
               'existing_supply_unavailable', 'app_credential_unconfigured'}
    reason = status.get('reason')
    remaining = status.get('usable_for_seconds')
    return {'available': available,
            'reason': reason if type(reason) is str and reason in reasons else 'existing_supply_unavailable',
            'usable_for_seconds': remaining if available and type(remaining) is int
                and 0 <= remaining <= MAX_CACHE_SECONDS else 0}
