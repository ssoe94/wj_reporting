"""Callback-scoped supplier matching the verified c0d3 authentication path.

The reserved OAuth callback owns one issuance budget. After identity verification
and USER storage commit, its supply may be offered once to the same worker's
business cache. Neither path grants QC write authority.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import logging
import os
import threading
import time

import requests
from django.conf import settings
from django.views.decorators.debug import sensitive_variables

from . import app_tokens
from .app_tokens import (AppCredentialUnavailable, AppTokenSupplier as _CachedSupplier,
    MAX_CACHE_SECONDS, MAX_PROVIDER_DURATION_SECONDS, SAFETY_SECONDS,
    _configuration, _declared_app_id, app_credential_binding)


class AppTokenSupplier(_CachedSupplier):
    def __init__(self, *, session_factory=None, clock=None, issuance_fence=None):
        if issuance_fence is not None and not callable(issuance_fence):
            raise TypeError('issuance_fence must be callable')
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
        self._cache_owner_pid = os.getpid()
        self._handoff_used = False
        self._issuance_fence = issuance_fence

    @sensitive_variables()
    def offer_to_business_cache(self, *, identity_verified=False, credential_stored=False,
                                publication_fence=None):
        """Post-commit hook only; source cache never leaves this process memory."""
        with self._lock:
            if identity_verified is not True or credential_stored is not True:
                return False
            if self._handoff_used:
                return False
            self._handoff_used = True
            if (self._issuance_fence is None or not self._used
                    or self._attempts != 1 or self._token is None
                    or self._cache_owner_pid != os.getpid() or not callable(publication_fence)):
                return False
            try:
                permitted = publication_fence()
                if permitted is not None and permitted is not True:
                    return False
            except Exception:
                return False
            return app_tokens._supplier._accept_callback_supply(self)

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
                if self._cache_owner_pid != os.getpid():
                    raise AppCredentialUnavailable('app_credential_existing_supply_unavailable')
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
                # Exact diagnostic callers already committed the persistent
                # budget. Recheck its fence immediately before external I/O.
                # A failed fence also consumes this object's local budget.
                if self._issuance_fence is not None:
                    permitted = self._issuance_fence()
                    if permitted is not None and permitted is not True:
                        raise AppCredentialUnavailable('app_credential_budget_rejected')
                token, duration = self._issue(key, secret)
                self._provider_seconds = duration
                deadline = now + min(duration, MAX_CACHE_SECONDS) - SAFETY_SECONDS
                if self._clock() >= deadline:
                    raise AppCredentialUnavailable('app_credential_expired')
                self._token, self._deadline = token, deadline
                self._cache_owner_pid = os.getpid()
                reason = 'app_credential_issued'
                return token
            except Exception:
                raise AppCredentialUnavailable('app_credential_unavailable') from None
            finally:
                self._record_result(reason)


_callback_supplier = ContextVar('mes_oauth_callback_app_supplier', default=None)


@contextmanager
def use_callback_app_supplier(supplier):
    """Keep get_provider() compatible while pinning one callback's supplier."""
    handle = _callback_supplier.set(supplier)
    try:
        yield
    finally:
        _callback_supplier.reset(handle)


@sensitive_variables()
def get_app_access_token():
    supplier = _callback_supplier.get()
    return (supplier if supplier is not None else AppTokenSupplier()).get()
