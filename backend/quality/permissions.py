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


class QualityReadPermission(QualityPermission):
    """Apply quality-view permission to read-only POST collection actions."""

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
        return bool(getattr(profile, self.section_flag, False))


class QualityImportPermission(QualityPermission):
    """Quality import access follows the same fail-closed quality policy."""


class QualityColorMasterPermission(QualityPermission):
    """Require injection edit authority before creating a PartSpec version."""

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
        return bool(
            getattr(profile, 'can_view_quality', False)
            and getattr(profile, 'can_edit_quality', False)
            and getattr(profile, 'can_edit_injection', False)
        )
