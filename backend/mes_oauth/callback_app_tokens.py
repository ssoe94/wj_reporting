"""Callback-scoped supplier matching the verified c0d3 authentication path.

The reserved OAuth callback owns one issuance budget. Business credential
rechecks retain their separate bounded process cache; neither path grants QC
write authority. Both suppliers share the strict provider-response parser.
"""
from datetime import datetime, timezone
import json
import logging
import threading
import time

import requests
from django.conf import settings
from django.views.decorators.debug import sensitive_variables

from .app_tokens import (AppCredentialUnavailable, AppTokenSupplier as _CachedSupplier,
    MAX_CACHE_SECONDS, MAX_PROVIDER_DURATION_SECONDS, SAFETY_SECONDS,
    _configuration, _declared_app_id, app_credential_binding)


class AppTokenSupplier(_CachedSupplier):
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
            if mode == 'server' and not _declared_app_id():
                raise AppCredentialUnavailable('app_credential_unconfigured')
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
def get_app_access_token():
    return AppTokenSupplier().get()
