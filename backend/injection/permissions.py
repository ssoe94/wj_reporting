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

class ViewOnlyOrEditorPermission(permissions.BasePermission):
    """
    조회 액션은 모든 인증된 사용자, 편집 액션은 편집자 이상만 가능
    """
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # 조회 액션 (GET, HEAD, OPTIONS)
        if request.method in permissions.SAFE_METHODS:
            return True
        
        # 편집 액션 (POST, PUT, PATCH, DELETE)
        return request.user.is_staff or request.user.groups.filter(name='editor').exists()


class InjectionPermission(permissions.BasePermission):
    """사출 관련 권한 체크"""
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # 관리자는 모든 권한
        if request.user.is_staff:
            return True
        
        try:
            profile = request.user.profile
        except:
            return False
        
        # 조회 액션
        if request.method in permissions.SAFE_METHODS:
            return profile.can_view_injection
        
        # 편집 액션
        return profile.can_edit_injection


class EcoPermission(permissions.BasePermission):
    """ECO 관련 권한 체크"""
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # 관리자는 모든 권한
        if request.user.is_staff:
            return True
        
        try:
            profile = request.user.profile
        except:
            return False
        
        # 조회 액션
        if request.method in permissions.SAFE_METHODS:
            return profile.can_view_eco
        
        # 편집 액션
        return profile.can_edit_eco


class MachiningPermission(permissions.BasePermission):
    """가공 관련 권한 체크"""
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # 관리자는 모든 권한
        if request.user.is_staff:
            return True
        
        try:
            profile = request.user.profile
        except:
            return False
        
        # 조회 액션
        if request.method in permissions.SAFE_METHODS:
            return profile.can_view_machining
        
        # 편집 액션
        return profile.can_edit_machining


class InventoryPermission(permissions.BasePermission):
    """재고 관련 권한 체크"""
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False
        
        # 관리자는 모든 권한
        if request.user.is_staff:
            return True
        
        try:
            profile = request.user.profile
        except:
            return False
        
        # 조회 액션
        if request.method in permissions.SAFE_METHODS:
            return profile.can_view_inventory
        
        # 편집 액션
        return profile.can_edit_inventory 