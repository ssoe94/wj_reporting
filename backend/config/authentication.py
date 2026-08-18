"""JWT authentication with a fail-closed boundary for service identities."""

from rest_framework.exceptions import PermissionDenied
from rest_framework_simplejwt.authentication import JWTAuthentication

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


class ScopedJWTAuthentication(JWTAuthentication):
    """Prevent an archive token from becoming a general application login."""

    def authenticate(self, request):
        result = super().authenticate(request)
        if result is None:
            return None

        user, token = result
        if not is_archive_identity_marker(user, token):
            return result

        if not is_valid_archive_service(user, token):
            raise PermissionDenied('The quality archive service identity is not active.')

        resolver_match = getattr(request, 'resolver_match', None)
        route_name = getattr(resolver_match, 'url_name', None)
        if (request.method.upper(), route_name) not in _ARCHIVE_ALLOWED_ROUTES:
            raise PermissionDenied('The quality archive credential cannot access this endpoint.')
        return result
