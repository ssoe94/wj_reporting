"""Explicit user-code exchange; no app issuance, cache, fallback or retries.

Constructing this client makes no request. Runtime activation is separate from
shipping the code. Tokens only live in this request's memory and are not returned
to the browser or connected to inspection write adapters.
"""
import json

import requests
from django.views.decorators.debug import sensitive_variables

from .identity import UserContextResponse, UserContextUnverified, safe_failure_code


ROUTE = '/api/openapi/domain/web/v1/route'
EXCHANGE = '/openapi/open/v1/access_token/_get_user_token'
USERINFO = '/openapi/open/v1/access_token/_get_user_info'
ORIGINS = {'https://v3-ali.blacklake.cn', 'https://v3-hw.blacklake.cn'}


@sensitive_variables()
def app_credential_configured(value):
    return type(value) is str and bool(value.strip())


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError('Duplicate field.')
        value[key] = item
    return value


class BlacklakeUserOAuthClient:
    @sensitive_variables()
    def __init__(self, *, origin, app_access_token, session_factory=None):
        if origin not in ORIGINS:
            raise UserContextUnverified('oauth_origin_invalid')
        if not app_credential_configured(app_access_token):
            raise UserContextUnverified('app_credential_missing')
        self._origin = origin
        self._app_access_token = app_access_token
        self._session_factory = session_factory or requests.Session
        self._http_attempts = {'exchange': 0, 'userinfo': 0}
        self._http_statuses = {'exchange': None, 'userinfo': None}
        self._api_codes = {'exchange': None, 'userinfo': None}

    def diagnostic_snapshot(self):
        """Only bounded counts/statuses, never credentials, payloads or identity."""
        def count(stage):
            value = self._http_attempts[stage]
            return value if type(value) is int and value in (0, 1) else None

        def status(stage):
            value = self._http_statuses[stage]
            return value if type(value) is int and 100 <= value <= 599 else None

        def api_code(stage):
            value = self._api_codes[stage]
            return value if type(value) is int and -2_147_483_648 <= value <= 2_147_483_647 else None

        return {
            'exchange_http_attempts': count('exchange'),
            'userinfo_http_attempts': count('userinfo'),
            'exchange_http_status': status('exchange'),
            'userinfo_http_status': status('userinfo'),
            'exchange_api_code': api_code('exchange'),
            'userinfo_api_code': api_code('userinfo'),
        }

    @sensitive_variables()
    def _post(self, endpoint, payload):
        if endpoint not in (EXCHANGE, USERINFO):
            raise UserContextUnverified('oauth_endpoint_invalid')
        stage = 'exchange' if endpoint == EXCHANGE else 'userinfo'
        if self._http_attempts[stage] != 0:
            raise UserContextUnverified(stage + '_attempt_already_used')
        try:
            # Default requests adapter has no retry; no environment proxy/netrc.
            with self._session_factory() as session:
                session.trust_env = False
                # Count invocation of Session.post, not provider receipt. Header
                # rejection can occur inside this call before any network I/O.
                self._http_attempts[stage] += 1
                with session.post(
                    self._origin + ROUTE + endpoint,
                    headers={'access_token': self._app_access_token,
                             'Accept': 'application/json'},
                    json=payload, timeout=(3, 10), allow_redirects=False, stream=True,
                ) as response:
                    status = response.status_code
                    self._http_statuses[stage] = status
                    redirected = bool(response.history) or 300 <= status < 400
                    if status != 200 or redirected:
                        return UserContextResponse(status, {}, redirected)
                    chunks, size = [], 0
                    for chunk in response.iter_content(4096):
                        size += len(chunk)
                        if size > 65536:
                            raise UserContextUnverified(stage + '_response_too_large')
                        chunks.append(chunk)
                    try:
                        body = json.loads(b''.join(chunks).decode('utf-8'),
                                          object_pairs_hook=_pairs,
                                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                    except (UnicodeError, ValueError):
                        raise UserContextUnverified(stage + '_response_decode_failed') from None
                    # The official schema defines this metadata as int32. Do
                    # not retain the body, message, data, token or identity.
                    api_code = body.get('code') if type(body) is dict else None
                    if type(api_code) is int and -2_147_483_648 <= api_code <= 2_147_483_647:
                        self._api_codes[stage] = api_code
                    return UserContextResponse(status, body, redirected)
        except UserContextUnverified as error:
            reason = safe_failure_code(error)
            if not reason.startswith(stage + '_'):
                reason = stage + '_request_failed'
            raise UserContextUnverified(reason) from None
        except (requests.exceptions.InvalidHeader, UnicodeEncodeError):
            raise UserContextUnverified(stage + '_header_invalid') from None
        except Exception:
            raise UserContextUnverified(stage + '_request_failed') from None

    @sensitive_variables()
    def exchange(self, code):
        return self._post(EXCHANGE, {'code': code, 'grantType': 'authorization_code'})

    @sensitive_variables()
    def userinfo(self, user_access_token):
        return self._post(USERINFO, {'userAccessToken': user_access_token})
