"""Explicit user-code exchange; no app issuance, cache, fallback or retries.

Constructing this client makes no request. Runtime activation is separate from
shipping the code. Tokens only live in this request's memory and are not returned
to the browser or connected to inspection write adapters.
"""
import json
import logging

import requests
from django.views.decorators.debug import sensitive_variables

from .identity import UserContextResponse, UserContextUnverified, _successful_data, safe_failure_code


ROUTE = '/api/openapi/domain/web/v1/route'
EXCHANGE = '/openapi/open/v1/access_token/_get_user_token'
USERINFO = '/openapi/open/v1/access_token/_get_user_info'
APP_READ_CONTROL = '/quality/open/v1/task/_detail'
ORIGINS = {'https://v3-ali.blacklake.cn', 'https://v3-hw.blacklake.cn'}
APP_TOKEN_HEADERS = frozenset({'access_token', 'X-AUTH'})


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
    def __init__(self, *, origin, app_access_token, app_token_header='access_token', session_factory=None):
        if origin not in ORIGINS:
            raise UserContextUnverified('oauth_origin_invalid')
        if not app_credential_configured(app_access_token):
            raise UserContextUnverified('app_credential_missing')
        if type(app_token_header) is not str or app_token_header not in APP_TOKEN_HEADERS:
            raise UserContextUnverified('oauth_header_contract_invalid')
        self._origin = origin
        self._app_access_token = app_access_token
        self._app_token_header = app_token_header
        self._session_factory = session_factory or requests.Session
        self._http_attempts = {'exchange': 0, 'userinfo': 0, 'control': 0}
        self._http_statuses = {'exchange': None, 'userinfo': None, 'control': None}
        self._api_codes = {'exchange': None, 'userinfo': None, 'control': None}

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
        if endpoint not in (EXCHANGE, USERINFO, APP_READ_CONTROL):
            raise UserContextUnverified('oauth_endpoint_invalid')
        stage = {EXCHANGE: 'exchange', USERINFO: 'userinfo', APP_READ_CONTROL: 'control'}[endpoint]
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
                    headers={self._app_token_header: self._app_access_token,
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

    @sensitive_variables()
    def check_app_read_access(self, qc_id):
        """One optional server-scoped read control before consuming code at MES.

        No values leave this method. Success proves this app/header can read this
        QC; it does not establish identity, claim eligibility or write authority.
        """
        if type(qc_id) is not int or not 1 <= qc_id <= 2**63 - 1:
            raise UserContextUnverified('control_target_invalid')
        reason = 'control_verified'
        try:
            data = _successful_data(self._post(APP_READ_CONTROL, {'id': qc_id}), 'control')
            if type(data.get('id')) is not int or data['id'] != qc_id:
                raise UserContextUnverified('control_target_mismatch')
        except Exception as error:
            reason = safe_failure_code(error)
            raise
        finally:
            # This separate event does not widen the established seven-field
            # identity event. No target ID, subCode, message or body is logged.
            count = self._http_attempts['control']
            status, api = self._http_statuses['control'], self._api_codes['control']
            event = {
                'reason': reason,
                'control_http_attempts': count if type(count) is int and count in (0, 1) else None,
                'control_http_status': status if type(status) is int and 100 <= status <= 599 else None,
                'control_api_code': api if type(api) is int and -2**31 <= api < 2**31 else None,
            }
            try:
                logging.getLogger('mes_oauth.diagnostics').warning('mes_oauth_app_control %s',
                    json.dumps(event, sort_keys=True, separators=(',', ':')))
            except Exception:
                pass
