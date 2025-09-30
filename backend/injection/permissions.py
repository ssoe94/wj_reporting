from rest_framework import permissions

class SectionPermission(permissions.BasePermission):
    section_flag = ''
    edit_flag = ''  # 편집 권한 플래그 (예: can_edit_injection)

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

        # 편집 작업인지 확인 (POST, PUT, PATCH, DELETE 또는 특정 액션들)
        write_actions = ['create', 'update', 'partial_update', 'destroy', 'bulk_create',
                        'add_test', 'approve', 'reject']
        is_write_action = (
            request.method in ['POST', 'PUT', 'PATCH', 'DELETE'] or
            getattr(view, 'action', None) in write_actions
        )

        if is_write_action and self.edit_flag:
            # 편집 작업: edit 권한 체크
            return getattr(profile, self.edit_flag, False)
        else:
            # 조회 작업: view 권한 체크
            return getattr(profile, self.section_flag, True)

class InjectionPermission(SectionPermission):
    section_flag = 'can_view_injection'
    edit_flag = 'can_edit_injection'

class AssemblyPermission(SectionPermission):
    section_flag = 'can_view_assembly'
    edit_flag = 'can_edit_assembly'

class QualityPermission(SectionPermission):
    section_flag = 'can_view_quality'
    edit_flag = 'can_edit_quality'

class SalesPermission(SectionPermission):
    section_flag = 'can_view_sales'
    edit_flag = 'can_edit_sales'

class DevelopmentPermission(SectionPermission):
    section_flag = 'can_view_development'
    edit_flag = 'can_edit_development'

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