"""Token views that preserve the live boundary for scoped service accounts."""

from django.contrib.auth import get_user_model
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from quality.archive_access import (
    is_archive_identity_marker,
    is_valid_archive_service,
)


class ScopedTokenRefreshSerializer(TokenRefreshSerializer):
    """Recheck the live service identity before rotating an archive refresh."""

    def validate(self, attrs):
        refresh = RefreshToken(attrs['refresh'])
        user_id = refresh.get(api_settings.USER_ID_CLAIM)
        user = get_user_model().objects.filter(
            **{api_settings.USER_ID_FIELD: user_id}
        ).first()
        if is_archive_identity_marker(user, refresh) and not is_valid_archive_service(user, refresh):
            raise InvalidToken('The quality archive service identity is not active.')
        return super().validate(attrs)


class ScopedTokenRefreshView(TokenRefreshView):
    serializer_class = ScopedTokenRefreshSerializer
