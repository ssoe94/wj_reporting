"""Token views that preserve the live boundary for scoped service accounts."""
import secrets

from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from rest_framework_simplejwt.exceptions import AuthenticationFailed, InvalidToken
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.utils import get_md5_hash_password
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from config.authentication import token_matches_current_password
from mes_oauth.pilot_scope import PILOT_SCOPE_CLAIM, pilot_route_scope_required
from quality.archive_access import (
    is_archive_identity_marker,
    is_valid_archive_service,
)


class ScopedTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Keep first-login sessions restricted until the user authenticates again."""

    def validate(self, attrs):
        data = super().validate(attrs)
        try:
            self.user.profile
        except ObjectDoesNotExist as exc:
            raise AuthenticationFailed(
                '사용자 권한 프로필을 찾을 수 없습니다. 관리자에게 문의해주세요.',
                code='user_profile_required',
            ) from exc
        return data

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        # Stable across refresh rotation; shared by MES and inspection revocation.
        token['mes_sid'] = secrets.token_urlsafe(32)
        token['mes_login_exp'] = token['exp']
        try:
            profile = user.profile
            reset_required = bool(
                profile.password_reset_required or profile.is_using_temp_password
            )
        except ObjectDoesNotExist:
            # Defensive default. ``validate`` rejects the login, but tokens
            # minted by any direct serializer use must remain fail-closed.
            reset_required = True
        token['password_reset_required'] = reset_required
        token[api_settings.REVOKE_TOKEN_CLAIM] = get_md5_hash_password(user.password)
        if pilot_route_scope_required(user, token):
            token[PILOT_SCOPE_CLAIM] = True
        return token


class ScopedTokenObtainPairView(TokenObtainPairView):
    serializer_class = ScopedTokenObtainPairSerializer


class ScopedTokenRefreshSerializer(TokenRefreshSerializer):
    """Recheck the live service identity before rotating an archive refresh."""

    def validate(self, attrs):
        refresh = RefreshToken(attrs['refresh'])
        user_id = refresh.get(api_settings.USER_ID_CLAIM)
        # Logout and refresh serialize on the same actor lock. A rotated token
        # retains its family sid and cannot outlive an acknowledged revocation.
        with transaction.atomic():
            user = get_user_model().objects.select_for_update().filter(
                **{api_settings.USER_ID_FIELD: user_id}
            ).first()
            return self._validate_locked(attrs, refresh, user)

    def _validate_locked(self, attrs, refresh, user):
        from mes_oauth.session_guard import check_known_login
        if user is None:
            raise InvalidToken('User not found.')
        if not user.is_active:
            raise InvalidToken('User is inactive.')
        try:
            profile = user.profile
        except ObjectDoesNotExist as exc:
            raise InvalidToken('User permission profile is missing.') from exc
        if not token_matches_current_password(user, refresh, profile):
            raise InvalidToken('The user password has changed.')
        if is_archive_identity_marker(user, refresh) and not is_valid_archive_service(user, refresh):
            raise InvalidToken('The quality archive service identity is not active.')
        check_known_login(user, refresh)
        if pilot_route_scope_required(user, refresh):
            # Add confinement to older refresh tokens and retain signed scope
            # after allowlist removal. Rotation keeps its existing jti/blacklist
            # checks; only this verified token's server-owned claim is added.
            refresh[PILOT_SCOPE_CLAIM] = True
            attrs = {**attrs, 'refresh': str(refresh)}
        return super().validate(attrs)


class ScopedTokenRefreshView(TokenRefreshView):
    serializer_class = ScopedTokenRefreshSerializer
