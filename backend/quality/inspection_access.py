"""Optional, explicitly assigned inspector pilot; no role or permission grants."""
from django.conf import settings
from rest_framework.exceptions import PermissionDenied
from mes_oauth.pilot_scope import PILOT_SCOPE_CLAIM, configured_pilot_actor_ids, pilot_route_scope_required

from .archive_access import is_archive_identity_marker


def is_inspection_pilot(user):
    if (getattr(settings, 'INSPECTION_PILOT_ENABLED', False) is not True
            or not user or not user.is_authenticated or not user.is_active
            or user.is_staff or user.is_superuser or is_archive_identity_marker(user)):
        return False
    try:
        if user.pk not in configured_pilot_actor_ids():
            return False
        profile = user.profile
        return bool(profile.can_view_quality and not profile.is_admin and not profile.password_reset_required
                    and not profile.is_using_temp_password and user.has_usable_password()
                    and user.has_perm('quality.view_inspectionrequest'))
    except (AttributeError, TypeError, ValueError):
        return False


def can_use_admin_inspection_flow(user):
    if not user or not user.is_authenticated or not user.is_active or not user.is_superuser:
        return False
    marker = {PILOT_SCOPE_CLAIM: True} if getattr(user, '_inspection_pilot_scope', False) else {}
    return not pilot_route_scope_required(user, marker)


def can_access_inspections(user):
    return can_use_admin_inspection_flow(user) or is_inspection_pilot(user)


def can_access_request(user, request):
    return can_access_inspections(user) and (can_use_admin_inspection_flow(user) or request.assigned_to_id == user.pk)


def require_owned_request(user, request):
    if not can_access_request(user, request):
        raise PermissionDenied('Only the assigned inspector may access this pilot request.')
