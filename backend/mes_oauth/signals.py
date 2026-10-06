"""Invalidate local MES credentials when server-side identity changes.

Signals complement per-use checks; bulk SQL updates cannot bypass fresh actor
and fingerprint validation. No provider revoke is implied or attempted.
"""
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.contrib.auth.signals import user_logged_out
from django.db.models.signals import pre_save, post_save, pre_delete, m2m_changed
from django.dispatch import receiver
from injection.models import UserProfile

from .vault import revoke_actor


User = get_user_model()
SECURITY_FIELDS = ('password', 'username', 'is_active', 'is_staff', 'is_superuser')


@receiver(pre_save, sender=User, dispatch_uid='mes-user-before-save')
def user_before_save(sender, instance, raw=False, **kwargs):
    if not raw and instance.pk:
        instance._mes_security_before = sender.objects.filter(pk=instance.pk).values(*SECURITY_FIELDS).first()


@receiver(post_save, sender=User, dispatch_uid='mes-user-after-save')
def user_after_save(sender, instance, raw=False, created=False, **kwargs):
    before = getattr(instance, '_mes_security_before', None)
    if not raw and not created and before and any(before[field] != getattr(instance, field) for field in SECURITY_FIELDS):
        revoke_actor(instance.pk, reason='account_changed')


@receiver(post_save, sender=UserProfile, dispatch_uid='mes-profile-saved')
def profile_saved(sender, instance, raw=False, created=False, **kwargs):
    if not raw and not created:
        revoke_actor(instance.user_id, reason='profile_changed')


@receiver(pre_delete, sender=User, dispatch_uid='mes-user-deleting')
def user_deleting(sender, instance, **kwargs):
    revoke_actor(instance.pk, reason='account_deleted')


@receiver(user_logged_out, dispatch_uid='mes-django-logout')
def django_logout(sender, request, user, **kwargs):
    if user is not None and user.pk:
        revoke_actor(user.pk, reason='logout')


@receiver(m2m_changed, sender=User.groups.through, dispatch_uid='mes-user-group-change')
@receiver(m2m_changed, sender=User.user_permissions.through, dispatch_uid='mes-user-permission-change')
def user_permissions_changed(sender, instance, action, reverse, pk_set, **kwargs):
    if action not in ('pre_add', 'pre_remove', 'pre_clear'):
        return
    if reverse:
        ids = list(instance.user_set.values_list('pk', flat=True)) if pk_set is None else sorted(pk_set)
    else:
        ids = [instance.pk]
    for actor_id in sorted(ids):
        revoke_actor(actor_id, reason='permissions_changed')


@receiver(m2m_changed, sender=Group.permissions.through, dispatch_uid='mes-group-permission-change')
def group_permissions_changed(sender, instance, action, reverse, pk_set, **kwargs):
    if action not in ('pre_add', 'pre_remove', 'pre_clear'):
        return
    if reverse:
        groups = instance.group_set.all() if pk_set is None else Group.objects.filter(pk__in=pk_set)
        ids = User.objects.filter(groups__in=groups).values_list('pk', flat=True).distinct()
    else:
        ids = instance.user_set.values_list('pk', flat=True)
    for actor_id in sorted(ids):
        revoke_actor(actor_id, reason='permissions_changed')
