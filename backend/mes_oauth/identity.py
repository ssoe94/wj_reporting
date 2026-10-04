"""Disconnected user identity check for a future, separately reviewed OAuth flow.

No HTTP, token issuance, cache, configuration, callback, refresh or detail dispatch
is implemented here. A caller must independently establish consent, callback/state
protection and the provenance of the supplied exchange response.

``info_loader(token)`` is called once after a valid exchange. It must return a
UserContextResponse from the documented user-information endpoint, using exactly
that token, with redirects and retries disabled. It must not log credentials or
raw responses. Tests use only synthetic loaders. This module can check the
reported HTTP/API result; it cannot prove a caller's network/provenance claims.

The documented ``expire`` field has not yet been verified as relative or epoch
seconds. It is deliberately not interpreted. Identity evidence is not evidence
of token freshness, claim/save/finish authority, or readiness for live requests.
"""
from dataclasses import dataclass, field


class UserContextUnverified(Exception):
    """Only fixed, non-sensitive reason codes escape the validation boundary."""


@dataclass(frozen=True)
class UserContextResponse:
    status_code: int
    body: object = field(repr=False)
    redirected: bool


@dataclass(frozen=True)
class VerifiedUserContext:
    """Observed identity only; never a write authorization or live-ready token."""
    user_id: int
    token: str = field(repr=False)

    @property
    def expiry_verified(self):
        return False

    @property
    def live_ready(self):
        return False


def _successful_data(response, stage):
    if type(response) is not UserContextResponse:
        raise UserContextUnverified(stage + '_response_invalid')
    if type(response.redirected) is not bool or response.redirected:
        raise UserContextUnverified(stage + '_redirect_unverified')
    if type(response.status_code) is not int or response.status_code != 200:
        raise UserContextUnverified(stage + '_http_rejected')
    body = response.body
    if type(body) is not dict or type(body.get('code')) is not int or body['code'] != 200:
        raise UserContextUnverified(stage + '_api_rejected')
    if type(body.get('data')) is not dict:
        raise UserContextUnverified(stage + '_data_invalid')
    return body['data']


def verify_user_context(expected_user_id, exchange_response, *, info_loader):
    """Return identity evidence only after one same-token user-information check.

IDs must be exact positive signed-64-bit Python integers, never booleans, floats
or coerced strings. ``appAccessToken`` is ignored and cannot be a fallback.
The supplied response must contain a nonempty ``data.userAccessToken``. Token
kind is evidenced by that reviewed exchange field, not guessed from token bytes.
There is intentionally no detail callback or general runtime token provider.
"""
    if (type(expected_user_id) is not int
            or not 1 <= expected_user_id <= 9_223_372_036_854_775_807):
        raise UserContextUnverified('expected_user_invalid')
    if not callable(info_loader):
        raise UserContextUnverified('info_loader_invalid')
    data = _successful_data(exchange_response, 'exchange')
    token = data.get('userAccessToken')
    if type(token) is not str or not token.strip():
        raise UserContextUnverified('user_token_missing')
    try:
        response = info_loader(token)
    except Exception:
        # Do not propagate provider messages, request URLs or exception chains.
        raise UserContextUnverified('userinfo_load_failed') from None
    user_info = _successful_data(response, 'userinfo')
    if type(user_info.get('userId')) is not int or user_info['userId'] != expected_user_id:
        raise UserContextUnverified('user_identity_mismatch')
    return VerifiedUserContext(user_id=expected_user_id, token=token)
