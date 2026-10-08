"""Token views that preserve the live boundary for scoped service accounts."""
import secrets
from datetime import datetime, timedelta, timezone as dt_timezone

from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from rest_framework_simplejwt.exceptions import AuthenticationFailed, InvalidToken
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.utils import get_md5_hash_password
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from config.authentication import token_matches_current_password
from mes_oauth.pilot_scope import PILOT_SCOPE_CLAIM, pilot_route_scope_required
from quality.archive_access import (
    is_archive_identity_marker,
    is_valid_archive_service,
)


def _session_metadata(row):
    return {'session_idle_expires_at': row.idle_expires_at.isoformat(),
            'session_last_activity_at': row.last_activity_at.isoformat()}


def _record_refresh(refresh, user):
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
    OutstandingToken.objects.update_or_create(jti=refresh['jti'], defaults={
        'user': user, 'token': str(refresh),
        'created_at': datetime.fromtimestamp(refresh['iat'], dt_timezone.utc),
        'expires_at': datetime.fromtimestamp(refresh['exp'], dt_timezone.utc)})


def _bounded_pair(refresh, user, row, *, rotate):
    """Issue only within the persisted WJ deadline; never touch MES credentials."""
    from mes_oauth.session_guard import require_live_login
    deadline = require_live_login(row, require_v2=True)
    now = timezone.now()
    if rotate:
        # Recheck blacklist while holding the actor lock: another rotating
        # request may have consumed this token while this request was waiting.
        refresh = RefreshToken(str(refresh))
        refresh.blacklist()
        refresh.set_jti()
        refresh.set_iat(at_time=now)
    if pilot_route_scope_required(user, refresh):
        refresh[PILOT_SCOPE_CLAIM] = True
    refresh['mes_session_v'] = 2
    refresh['exp'] = min(int(deadline.timestamp()),
                         int((now + api_settings.REFRESH_TOKEN_LIFETIME).timestamp()))
    access = refresh.access_token
    access['exp'] = min(int(deadline.timestamp()),
                        int((now + api_settings.ACCESS_TOKEN_LIFETIME).timestamp()))
    _record_refresh(refresh, user)
    return {'access': str(access), 'refresh': str(refresh), **_session_metadata(row)}


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
        from mes_oauth import vault
        from mes_oauth.models import MESLoginSession
        refresh = RefreshToken(data['refresh'])
        with transaction.atomic():
            user = get_user_model().objects.select_for_update().get(pk=self.user.pk)
            if not user.is_active or not token_matches_current_password(user, refresh, user.profile):
                raise AuthenticationFailed('Login authority changed.')
            now = timezone.now()
            row = MESLoginSession.objects.create(
                digest=vault.digest('client-login', refresh['mes_sid']), actor_id=user.pk,
                authorization_digest=vault.authorization_digest(user),
                expires_at=datetime.fromtimestamp(refresh['mes_login_exp'], dt_timezone.utc),
                session_version=2, last_activity_at=now, idle_expires_at=now + timedelta(hours=24))
            return _bounded_pair(refresh, user, row, rotate=False)

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

    def _validate_actor_locked(self, refresh, user):
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
        row = check_known_login(user, refresh)
        return row

    def _validate_locked(self, attrs, refresh, user):
        from mes_oauth.session_guard import session_version
        row = self._validate_actor_locked(refresh, user)
        if pilot_route_scope_required(user, refresh):
            # Add confinement to older refresh tokens and retain signed scope
            # after allowlist removal. Rotation keeps its existing jti/blacklist
            # checks; only this verified token's server-owned claim is added.
            refresh[PILOT_SCOPE_CLAIM] = True
            attrs = {**attrs, 'refresh': str(refresh)}
        if session_version(refresh) == 2:
            return _bounded_pair(refresh, user, row, rotate=True)
        return super().validate(attrs)


class ScopedTokenRefreshView(TokenRefreshView):
    serializer_class = ScopedTokenRefreshSerializer



class SessionActivityView(APIView):
    """Explicit browser activity renews only its verified WJ login family."""
    from config.authentication import ScopedJWTAuthentication
    authentication_classes = [ScopedJWTAuthentication]
    permission_classes = [IsAuthenticated]

    def handle_exception(self, exc):
        from mes_oauth.session_guard import SessionIdleExpired
        from rest_framework.exceptions import MethodNotAllowed, ParseError, ValidationError
        from rest_framework_simplejwt.exceptions import TokenError
        if isinstance(exc, MethodNotAllowed):
            return Response({'detail': 'method_not_allowed', 'code': 'method_not_allowed'}, status=405)
        if isinstance(exc, (ParseError, ValidationError)):
            return Response({'detail': 'invalid_activity_request', 'code': 'invalid_activity_request'}, status=400)
        code = 'session_idle_expired' if isinstance(exc, SessionIdleExpired) else 'session_activity_rejected'
        status = 401 if isinstance(exc, TokenError) else getattr(exc, 'status_code', 503)
        if status not in (401, 403):
            status = 503
        return Response({'detail': code, 'code': code}, status=status)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'no-store, max-age=0'
        response['Referrer-Policy'] = 'no-referrer'
        return response

    def post(self, request):
        from mes_oauth import vault
        from mes_oauth.models import MESLoginSession
        from mes_oauth.session_guard import (login_identity, session_version,
            require_live_login, _normal_actor, LoginRejected)
        if (request.query_params or type(request.data) is not dict
                or set(request.data) != {'refresh'} or type(request.data['refresh']) is not str
                or not request.data['refresh']):
            return Response({'detail': 'invalid_activity_request', 'code': 'invalid_activity_request'}, status=400)
        refresh = RefreshToken(request.data['refresh'])
        access = request.auth
        # Both are verified JWTs. SID, anchor and actor are identity, never
        # browser choices. No timestamp from the browser is accepted.
        if (any(refresh.get(key) != access.get(key) for key in
                (api_settings.USER_ID_CLAIM, 'mes_sid', 'mes_login_exp', 'mes_session_v'))
                or str(refresh.get(api_settings.USER_ID_CLAIM)) != str(request.user.pk)):
            raise LoginRejected()
        digest, anchor = login_identity(refresh)
        with transaction.atomic():
            user = get_user_model().objects.select_for_update().get(pk=request.user.pk)
            access = AccessToken(str(access))
            if type(access.get('exp')) is not int or access['exp'] <= timezone.now().timestamp():
                raise LoginRejected()
            _normal_actor(user, access)
            # Verify both password bindings and the refresh blacklist again
            # after waiting for concurrent logout/activity/refresh transactions.
            refresh = RefreshToken(request.data['refresh'])
            ScopedTokenRefreshSerializer()._validate_actor_locked(refresh, user)
            row = MESLoginSession.objects.select_for_update().filter(pk=digest).first()
            if (row is None or row.actor_id != user.pk or row.expires_at != anchor
                    or row.authorization_digest != vault.authorization_digest(user)):
                raise LoginRejected()
            require_live_login(row, require_v2=session_version(refresh) == 2)
            now = timezone.now()
            row.session_version = 2
            row.last_activity_at, row.idle_expires_at = now, now + timedelta(hours=24)
            row.save(update_fields=['session_version', 'last_activity_at', 'idle_expires_at'])
            return Response(_bounded_pair(refresh, user, row, rotate=True))
