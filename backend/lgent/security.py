import base64
import hashlib
from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from rest_framework.permissions import BasePermission


def cipher():
    key=hashlib.sha256((settings.SECRET_KEY+':lgent-token-v1').encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_token(value):
    return cipher().encrypt(value.encode()).decode()


def decrypt_token(value):
    try:
        return cipher().decrypt(value.encode()).decode()
    except (InvalidToken,ValueError,UnicodeError):
        return ''


class LgentAccess(BasePermission):
    def has_permission(self,request,view):
        user=request.user
        if not user or not user.is_authenticated or not user.is_active:
            return False
        if user.is_staff or user.is_superuser:
            return True
        try:
            profile=user.profile
        except Exception:
            return False
        return bool(getattr(profile,'can_edit_sales' if getattr(view,'edit_action',False) else 'can_view_sales',False))


def can_edit(user):
    if not user or not user.is_authenticated or not user.is_active:return False
    if user.is_staff or user.is_superuser:return True
    try:return bool(user.profile.can_edit_sales)
    except Exception:return False
