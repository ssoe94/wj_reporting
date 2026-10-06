"""Persistent JWT route confinement for explicitly configured inspector pilots.

This grants no inspection, object, or MES authority. Those checks stay at their
existing boundaries. Disabling the pilot feature never removes confinement.
"""
import json

from django.conf import settings


PILOT_SCOPE_CLAIM = 'inspection_pilot_scope'

PILOT_ALLOWED_ROUTES = frozenset({
    ('POST', 'token_obtain_pair'),
    ('POST', 'token_obtain_pair_no_slash'),
    ('POST', 'token_refresh'),
    ('POST', 'token_refresh_no_slash'),
    ('POST', 'auth_activity'),
    ('GET', 'user-me'),
    ('HEAD', 'user-me'),
    ('POST', 'change-password'),
    ('POST', 'user_change_password'),
    ('POST', 'admin-change-password'),  # The existing view changes request.user only.
    ('GET', 'mes-connection-status'),
    ('HEAD', 'mes-connection-status'),
    ('POST', 'mes-connection-launch'),
    ('POST', 'mes-connection-disconnect'),
    ('POST', 'mes-connection-logout'),
    ('POST', 'mes-connection-recheck'),
    ('GET', 'inspection-request-capabilities'),
    ('HEAD', 'inspection-request-capabilities'),
    ('GET', 'inspection-request-list'),
    ('HEAD', 'inspection-request-list'),
    ('POST', 'inspection-request-list'),
    ('GET', 'inspection-request-detail'),
    ('HEAD', 'inspection-request-detail'),
    ('PATCH', 'inspection-request-detail'),
    ('POST', 'inspection-request-submit'),
    ('POST', 'inspection-request-reinspect'),
    ('POST', 'inspection-request-refresh'),
    ('POST', 'inspection-request-mes-save'),
    ('POST', 'inspection-request-mes-finish'),
    ('POST', 'inspection-request-mes-reconcile'),
})


def configured_pilot_actor_ids():
    """Return validated IDs independently of the pilot activation switch."""
    value = getattr(settings, 'INSPECTION_PILOT_USER_IDS', '[]')
    try:
        value = json.loads(value) if type(value) is str else value
    except (TypeError, ValueError):
        raise ValueError('Invalid inspection pilot account configuration.') from None
    if (type(value) is not list or len(value) > 20
            or any(type(actor_id) is not int or not 1 <= actor_id <= 2**63 - 1 for actor_id in value)
            or len(set(value)) != len(value)):
        raise ValueError('Invalid inspection pilot account configuration.')
    return set(value)


def pilot_route_scope_required(user, token):
    # Preserve this request's classification across later configuration reads.
    if getattr(user, '_inspection_pilot_scope', False):
        return True
    # Ordinary tokens omit this claim. A malformed signed scope marker must
    # never downgrade a restricted token to a general application login.
    if PILOT_SCOPE_CLAIM in token:
        return True
    try:
        return user.pk in configured_pilot_actor_ids()
    except ValueError:
        # Invalid global configuration must not restore general JWT access.
        return True


def pilot_route_allowed(method, route_name):
    return (method.upper(), route_name) in PILOT_ALLOWED_ROUTES
