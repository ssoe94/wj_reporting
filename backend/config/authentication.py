"""JWT authentication with fail-closed boundaries for restricted identities."""

import hmac

from django.core.exceptions import ObjectDoesNotExist
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.utils import get_md5_hash_password

from quality.archive_access import (
    is_archive_identity_marker,
    is_valid_archive_service,
)


_ARCHIVE_ALLOWED_ROUTES = {
    ('GET', 'quality-archive-report-list'),
    ('GET', 'quality-archive-asset-list'),
    ('GET', 'quality-archive-asset-content'),
    ('POST', 'quality-archive-asset-mark-mirrored'),
}

_PASSWORD_RESET_ALLOWED_ROUTES = {
    ('GET', 'user-me'),
    ('HEAD', 'user-me'),
    ('POST', 'change-password'),
    ('POST', 'user_change_password'),
    ('POST', 'admin-change-password'),
}


def token_matches_current_password(user, token, profile) -> bool:
    """Validate new password-hash claims and safely retire legacy tokens."""
    password_hash_claim = token.get(api_settings.REVOKE_TOKEN_CLAIM)
    if password_hash_claim is not None:
        return hmac.compare_digest(
            str(password_hash_claim),
            get_md5_hash_password(user.password),
        )

    last_password_change = getattr(profile, 'last_password_change', None)
    if last_password_change is None:
        # Backward compatibility for sessions minted before this claim existed.
        return True

    try:
        issued_at = int(token.get('iat'))
    except (TypeError, ValueError):
        return False
    return issued_at > int(last_password_change.timestamp())


class ScopedJWTAuthentication(JWTAuthentication):
    """Prevent an archive token from becoming a general application login."""

    def authenticate(self, request):
        result = super().authenticate(request)
        if result is None:
            return None

        user, token = result
        resolver_match = getattr(request, 'resolver_match', None)
        route_name = getattr(resolver_match, 'url_name', None)

        if is_archive_identity_marker(user, token):
            if not is_valid_archive_service(user, token):
                raise PermissionDenied('The quality archive service identity is not active.')
            if (request.method.upper(), route_name) not in _ARCHIVE_ALLOWED_ROUTES:
                raise PermissionDenied('The quality archive credential cannot access this endpoint.')
            return result

        try:
            profile = user.profile
            password_reset_required = bool(
                profile.password_reset_required
                or profile.is_using_temp_password
                or token.get('password_reset_required', False)
            )
        except ObjectDoesNotExist:
            raise PermissionDenied({
                'detail': '사용자 권한 프로필을 찾을 수 없습니다. 관리자에게 문의해주세요.',
                'code': 'user_profile_required',
            })

        if not token_matches_current_password(user, token, profile):
            raise AuthenticationFailed(
                '비밀번호가 변경되어 기존 로그인 세션이 종료되었습니다.',
                code='password_changed',
            )

        if (
            password_reset_required
            and request.method.upper() != 'OPTIONS'
            and (request.method.upper(), route_name) not in _PASSWORD_RESET_ALLOWED_ROUTES
        ):
            raise PermissionDenied({
                'detail': '계속하려면 먼저 비밀번호를 변경해야 합니다.',
                'code': 'password_change_required',
            })
        return result
