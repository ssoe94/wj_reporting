"""One audited grant path for HR and user-administration screens."""
from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework.exceptions import PermissionDenied, ValidationError

from .models import HrAccessGrant, HrAccessHistory


def require_hr_grant_manager(actor):
    if not (actor and actor.is_authenticated and actor.is_active and actor.is_superuser):
        raise PermissionDenied('인사관리 권한 부여·해제는 활성 superuser만 할 수 있습니다.')


@transaction.atomic
def set_hr_access(target, enabled, actor):
    require_hr_grant_manager(actor)
    if type(enabled) is not bool:
        raise ValidationError({'can_manage_hr': '참/거짓만 입력해 주세요.'})
    # All entry points lock the user, including when no grant row exists yet.
    target = get_user_model().objects.select_for_update().get(pk=target.pk)
    if target.is_superuser:
        raise ValidationError({'can_manage_hr': 'superuser는 인사관리 권한이 자동 적용됩니다.'})
    if enabled and not target.is_active:
        raise ValidationError({'can_manage_hr': '활성 계정에만 인사관리 권한을 부여할 수 있습니다.'})
    grant = HrAccessGrant.objects.filter(user=target).first()
    if grant is None and not enabled:
        return
    if grant is None:
        grant = HrAccessGrant(user=target)
    if grant.enabled != enabled:
        grant.enabled = enabled
        grant.updated_by = actor
        grant.save()
        HrAccessHistory.objects.create(
            user=target, user_label=(target.get_full_name() or target.username)[:200], enabled=enabled,
            actor=actor, actor_label=(actor.get_full_name() or actor.username)[:200],
        )
