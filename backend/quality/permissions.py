from injection.permissions import QualityPermission as BaseQualityPermission


class QualityPermission(BaseQualityPermission):
    """Quality permission flags with a fail-closed missing-profile policy."""

    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        if request.user.is_staff:
            return True
        try:
            profile = request.user.profile
        except Exception:
            return False
        if not getattr(profile, 'pk', None):
            return False
        return super().has_permission(request, view)


class QualityImportPermission(QualityPermission):
    """Quality import access follows the same fail-closed quality policy."""
