"""Token views that preserve the live boundary for scoped service accounts."""

from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist
from rest_framework_simplejwt.exceptions import AuthenticationFailed, InvalidToken
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.utils import get_md5_hash_password
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from config.authentication import token_matches_current_password
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
        return token


class ScopedTokenObtainPairView(TokenObtainPairView):
    serializer_class = ScopedTokenObtainPairSerializer


class ScopedTokenRefreshSerializer(TokenRefreshSerializer):
    """Recheck the live service identity before rotating an archive refresh."""

    def validate(self, attrs):
        refresh = RefreshToken(attrs['refresh'])
        user_id = refresh.get(api_settings.USER_ID_CLAIM)
        user = get_user_model().objects.filter(
            **{api_settings.USER_ID_FIELD: user_id}
        ).first()
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
        return super().validate(attrs)


class ScopedTokenRefreshView(TokenRefreshView):
    serializer_class = ScopedTokenRefreshSerializer
