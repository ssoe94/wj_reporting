from typing import Optional


def user_can_edit_plan(user, plan_type: Optional[str]) -> bool:
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    if getattr(user, 'is_staff', False):
        return True

    try:
        profile = user.profile
    except Exception:
        return False

    if getattr(profile, 'is_admin', False):
        return True

    if plan_type == 'injection':
        return bool(getattr(profile, 'can_edit_injection', False))

    if plan_type == 'machining':
        # Machining is managed under assembly permissions in this project.
        return bool(getattr(profile, 'can_edit_assembly', False) or getattr(profile, 'can_edit_machining', False))

    return False
