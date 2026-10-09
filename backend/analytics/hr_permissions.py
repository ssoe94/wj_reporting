from rest_framework.permissions import BasePermission

from .models import HrAccessGrant


def can_access_hr(user):
    if not user or not user.is_authenticated or not user.is_active:
        return False
    return bool(user.is_superuser or HrAccessGrant.objects.filter(user_id=user.pk, enabled=True).exists())


class IsHrAuthorized(BasePermission):
    message = '인사·총무는 활성 superuser 또는 지정된 인사 담당자만 접근할 수 있습니다.'

    def has_permission(self, request, view):
        return can_access_hr(request.user)


class IsHrSuperuser(BasePermission):
    message = '인사 담당자 지정은 활성 superuser만 할 수 있습니다.'

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_active and user.is_superuser)
