"""Identity constants and helpers for the local quality-media archive service."""

from __future__ import annotations


ARCHIVE_SERVICE_GROUP = 'quality_media_archive_service'
ARCHIVE_SERVICE_USERNAME = 'wj_quality_archive_service'
ARCHIVE_TOKEN_SCOPE = 'quality_media_archive'
ARCHIVE_SCOPE_CLAIM = 'scope'


def has_archive_service_group(user) -> bool:
    if not getattr(user, 'is_authenticated', False) or not getattr(user, 'is_active', False):
        return False
    return user.groups.filter(name=ARCHIVE_SERVICE_GROUP).exists()


def is_archive_identity_marker(user, token=None) -> bool:
    """Recognize the reserved identity even if one marker is removed accidentally."""

    username_matches = (
        getattr(user, 'username', None) == ARCHIVE_SERVICE_USERNAME
    )
    group_matches = has_archive_service_group(user)
    token_matches = bool(
        token
        and token.get(ARCHIVE_SCOPE_CLAIM) == ARCHIVE_TOKEN_SCOPE
    )
    return username_matches or group_matches or token_matches


def is_valid_archive_service(user, token=None) -> bool:
    """Grant archive access only when every durable/runtime marker agrees."""

    return bool(
        getattr(user, 'username', None) == ARCHIVE_SERVICE_USERNAME
        and has_archive_service_group(user)
        and token
        and token.get(ARCHIVE_SCOPE_CLAIM) == ARCHIVE_TOKEN_SCOPE
    )
