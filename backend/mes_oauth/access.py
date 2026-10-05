"""Existing account eligibility only; this flow never elevates a role."""


def can_verify_identity(user):
    return bool(user.is_authenticated and user.is_active and user.is_superuser and user.is_staff)
