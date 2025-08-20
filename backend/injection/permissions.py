from rest_framework import permissions

class IsAdminUser(permissions.BasePermission):
    """
    관리자만 접근 가능
    """
    def has_permission(self, request, view):
        return request.user.is_authenticated and request.user.is_staff

class IsEditorUser(permissions.BasePermission):
    """
    편집자 이상 권한 필요 (관리자, 편집자)
    """
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        return request.user.is_staff or request.user.groups.filter(name='editor').exists()

class IsViewerUser(permissions.BasePermission):
    """
    조회자 이상 권한 필요 (모든 인증된 사용자)
    """
    def has_permission(self, request, view):
        return request.user.is_authenticated 