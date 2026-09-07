from rest_framework.permissions import BasePermission


class IsDevelopmentSuperuser(BasePermission):
    message = '개발 과제는 활성 superuser만 관리할 수 있습니다.'

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_active and user.is_superuser)
