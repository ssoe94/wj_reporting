import re

from django.core.exceptions import ObjectDoesNotExist
from rest_framework.permissions import BasePermission


# Same account range as the field launcher. Its JWTs are for the station UI.
_TERMINAL = re.compile(r'(?:imm(?:0[1-9]|1[0-7])|assy0[1-4])', re.IGNORECASE)


def can_view_field_monitoring(user):
    if not (user and user.is_authenticated and user.is_active):
        return False
    if user.is_superuser:
        return True
    if _TERMINAL.fullmatch(user.get_username().strip()):
        return False
    try:
        return bool(user.profile.can_view_injection)
    except ObjectDoesNotExist:
        return False


class CanViewFieldMonitoring(BasePermission):
    def has_permission(self, request, view):
        return can_view_field_monitoring(request.user)


class CanManageFieldStations(BasePermission):
    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_active and user.is_superuser)
