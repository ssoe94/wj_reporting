"""Existing administrators or an explicitly admitted inspector; no role grants."""
from quality.inspection_access import can_use_admin_inspection_flow, is_inspection_pilot


def can_verify_identity(user):
    return bool(user and user.is_authenticated and user.is_active
                and ((can_use_admin_inspection_flow(user) and user.is_staff) or is_inspection_pilot(user)))
