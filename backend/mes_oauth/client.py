"""Explicit user-code exchange; no app issuance, cache, fallback or retries.

Constructing this client makes no request. Runtime activation is separate from
shipping the code. Tokens only live in this request's memory and are not returned
to the browser or connected to inspection write adapters.
"""
import json

import requests
from django.views.decorators.debug import sensitive_variables

from .identity import UserContextResponse, UserContextUnverified


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

    @sensitive_variables()
    def _post(self, endpoint, payload):
        try:
            # Default requests adapter has no retry; no environment proxy/netrc.
            with self._session_factory() as session:
                session.trust_env = False
                with session.post(
                    self._origin + ROUTE + endpoint,
                    headers={'access_token': self._app_access_token,
                             'Accept': 'application/json'},
                    json=payload, timeout=(3, 10), allow_redirects=False, stream=True,
                ) as response:
                    status = response.status_code
                    redirected = bool(response.history) or 300 <= status < 400
                    if status != 200 or redirected:
                        return UserContextResponse(status, {}, redirected)
                    chunks, size = [], 0
                    for chunk in response.iter_content(4096):
                        size += len(chunk)
                        if size > 65536:
                            raise ValueError('Response exceeds limit.')
                        chunks.append(chunk)
                    body = json.loads(b''.join(chunks).decode('utf-8'),
                                      object_pairs_hook=_pairs,
                                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                    return UserContextResponse(status, body, redirected)
        except Exception:
            raise UserContextUnverified('oauth_provider_unavailable') from None

    @sensitive_variables()
    def exchange(self, code):
        return self._post(EXCHANGE, {'code': code, 'grantType': 'authorization_code'})

    @sensitive_variables()
    def userinfo(self, user_access_token):
        return self._post(USERINFO, {'userAccessToken': user_access_token})
