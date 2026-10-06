"""Opt-in ALI app supply: one issuance budget per reserved OAuth callback.

No global token cache, background refresh, retry, persistence or inventory helper.
The existing DB attempt reservation prevents duplicate callback dispatch across
workers. Separate newly authorized attempts have separate budgets; this is not a
deployment-wide issuance cap. Configuration inspection never contacts MES.
"""
from datetime import datetime, timezone
import json
import logging
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
MAX_CACHE_SECONDS = 3600
# The documented TTL is represented as Long in the first-party SDK. Its range
# is a schema bound, not a token-lifetime policy: local reuse remains capped by
# MAX_CACHE_SECONDS and this callback can never issue a second credential.
MAX_PROVIDER_DURATION_SECONDS = 2**63 - 1


class AppCredentialUnavailable(Exception):
    """Fixed reason only; no provider response or credential escapes."""


def _valid_id(value):
    return (type(value) is str and re.fullmatch(r'[1-9][0-9]{0,18}', value) is not None
            and int(value) <= 2**63 - 1)


@sensitive_variables()
def _configuration():
    header = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token')
    target = getattr(settings, 'MES_USER_OAUTH_CONTROL_QC_ID', '')
    if (type(header) is not str or header not in APP_TOKEN_HEADERS
            or type(target) is not str or (target and not _valid_id(target))):
        raise AppCredentialUnavailable('app_credential_unconfigured')
    mode = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_SOURCE', 'static')
    if mode == 'static':
        token = getattr(settings, 'MES_USER_OAUTH_APP_ACCESS_TOKEN', '')
        if app_credential_configured(token):
            return mode, token, ''
    elif mode == 'server' and getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', '') == ALI:
        # Declared app ID scopes operator intent; it does not prove key ownership.
        if not _valid_id(getattr(settings, 'MES_USER_OAUTH_APP_ID', '')):
            raise AppCredentialUnavailable('app_credential_unconfigured')
        source = getattr(settings, 'MES_USER_OAUTH_APP_CREDENTIAL_SOURCE', 'dedicated')
        if source == 'dedicated':
            key = getattr(settings, 'MES_USER_OAUTH_APP_KEY', '')
            secret = getattr(settings, 'MES_USER_OAUTH_APP_SECRET', '')
        elif source == 'existing_mes':
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
    values = [_configuration(),
              getattr(settings, 'MES_USER_OAUTH_APP_CREDENTIAL_SOURCE', 'dedicated'),
              getattr(settings, 'MES_USER_OAUTH_APP_ID', ''),
              getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token'),
              getattr(settings, 'MES_USER_OAUTH_CONTROL_QC_ID', '')]
    return salted_hmac('mes-oauth-app-source', json.dumps(values), algorithm='sha256').hexdigest()


class AppTokenSupplier:
    def __init__(self, *, session_factory=None, clock=None):
        self._session_factory = session_factory or requests.Session
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._used = False
        self._binding = None
        self._token = None
        self._deadline = 0
        self._attempts = 0
        self._http_status = self._api_code = None
        self._provider_seconds = self._issued_at = None

    def diagnostic_snapshot(self):
        """Only bounded evidence from this issuing object in this web process."""
        def number(value, low, high):
            return value if type(value) is int and low <= value <= high else None
        issued = self._issued_at
        return {
            'http_attempts': number(self._attempts, 0, 1),
            'http_status': number(self._http_status, 100, 599),
            'api_code': number(self._api_code, -2**31, 2**31 - 1),
            'provider_expire_seconds': number(self._provider_seconds, 61, MAX_PROVIDER_DURATION_SECONDS),
            'issued_at': issued.isoformat() if type(issued) is datetime and issued.tzinfo is timezone.utc else None,
        }

    def _record_result(self, reason):
        try:
            # Exactly six fields; never include a key, token, app/QC/user ID,
            # provider text, exception chain, arbitrary status object or URL.
            event = {'reason': reason if reason in ('app_credential_issued', 'app_credential_unavailable')
                     else 'app_credential_unavailable', **self.diagnostic_snapshot()}
            logging.getLogger('mes_oauth.diagnostics').warning(
                'mes_oauth_app_supply %s', json.dumps(event, sort_keys=True, separators=(',', ':')))
        except Exception:
            pass  # A broken logging handler must not cause issuance retry.

    @sensitive_variables()
    def get(self):
        if getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is not True:
            raise AppCredentialUnavailable('oauth_disabled')
        with self._lock:
            mode, key, secret = _configuration()
            binding = app_credential_binding()
            if self._binding is not None and binding != self._binding:
                raise AppCredentialUnavailable('app_credential_changed')
            self._binding = binding
            if mode == 'static':
                return key
            now = self._clock()
            if self._token is not None and now < self._deadline:
                return self._token
            self._token = None
            if self._used:
                raise AppCredentialUnavailable('app_credential_budget_exhausted')
            # Consume before even constructing Session: no retry after an
            # uncertain failure or a successful token's expiry in this attempt.
            self._used = True
            self._issued_at = datetime.now(timezone.utc)
            reason = 'app_credential_unavailable'
            try:
                token, duration = self._issue(key, secret)
                self._provider_seconds = duration
                deadline = now + min(duration, MAX_CACHE_SECONDS) - SAFETY_SECONDS
                if self._clock() >= deadline:
                    raise AppCredentialUnavailable('app_credential_expired')
                self._token, self._deadline = token, deadline
                reason = 'app_credential_issued'
                return token
            except Exception:
                raise AppCredentialUnavailable('app_credential_unavailable') from None
            finally:
                self._record_result(reason)

    @sensitive_variables()
    def _issue(self, key, secret):
        with self._session_factory() as session:
            session.trust_env = False
            self._attempts += 1  # Invocation, not evidence of provider receipt.
            with session.post(ALI + ISSUE_PATH, json={'appKey': key, 'appSecret': secret},
                    headers={'Accept': 'application/json'}, timeout=(3, 10),
                    allow_redirects=False, stream=True) as response:
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
                # Record only the bounded numeric TTL metadata, even when a
                # different response field fails validation. Never retain body.
                self._provider_seconds = duration if type(duration) is int else None
                if (type(token) is not str or not 1 <= len(token) <= 8192
                        or any(ord(char) < 33 or ord(char) > 126 for char in token)
                        or type(duration) is not int
                        or not SAFETY_SECONDS < duration <= MAX_PROVIDER_DURATION_SECONDS):
                    raise AppCredentialUnavailable('app_credential_response_invalid')
                return token, duration


@sensitive_variables()
def get_app_access_token():
    # Deliberately not module-global: the caller's DB reservation owns the budget.
    return AppTokenSupplier().get()
