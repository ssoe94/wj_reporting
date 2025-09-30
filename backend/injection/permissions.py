from rest_framework import permissions

class SectionPermission(permissions.BasePermission):
    section_flag = ''

    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False

        if request.user.is_staff:
            return True

        try:
            profile = request.user.profile
        except Exception:
            # 프로필이 없는 경우 기본값으로 접근 허용
            return True

        # 프로필이 있는 경우 해당 권한 확인, 없으면 기본값 True
        return getattr(profile, self.section_flag, True)

class InjectionPermission(SectionPermission):
    section_flag = 'can_view_injection'

class AssemblyPermission(SectionPermission):
    section_flag = 'can_view_assembly'

class QualityPermission(SectionPermission):
    section_flag = 'can_view_quality'

class SalesPermission(SectionPermission):
    section_flag = 'can_view_sales'

class DevelopmentPermission(SectionPermission):
    section_flag = 'can_view_development'

class AdminOnlyPermission(permissions.BasePermission):
    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False

        if request.user.is_staff:
            return True

        try:
            profile = request.user.profile
        except Exception:
            return False

        return getattr(profile, 'is_admin', False) 