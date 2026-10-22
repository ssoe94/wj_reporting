"""Opt-in cron-only reauthentication using administrator-supplied runtime secrets.

Never borrows a connection, stores a password, or retries a business write.
"""
import datetime as dt
import json
from types import SimpleNamespace
from django.conf import settings
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.dateparse import parse_datetime
from django.views.decorators.debug import sensitive_variables
from . import client,service
from .models import LgentProfile
from .security import LgentAccess

PREFIX='_autoLogin'


@sensitive_variables()
def renew_expired(record):
    """Called inside the existing cross-process scheduled-sync claim only."""
    owner=getattr(settings,'LGENT_AUTO_LOGIN_WJ_USERNAME','')
    user_id=getattr(settings,'LGENT_AUTO_LOGIN_USER_ID','')
    password=getattr(settings,'LGENT_AUTO_LOGIN_PASSWORD','')
    if not all(isinstance(value,str) and value for value in (owner,user_id,password)):return
    # A previously validated, explicitly subscribed connection must identify the
    # exact same LG account. An empty/logged-out profile cannot be provisioned.
    if record.user.username!=owner or not record.auto_sync_enabled or not record.lg_user_id or record.lg_user_id!=user_id.strip():return
    if record.expires_at and record.expires_at>timezone.now():return
    state=record.sync_state.copy()
    signature=salted_hmac('lgent-auto-login-config',json.dumps([owner,user_id,password]),algorithm='sha256').hexdigest()
    if state.get(PREFIX+'Config')==signature:
        if state.get(PREFIX+'Blocked'):return
        retry=parse_datetime(str(state.get(PREFIX+'RetryAt') or ''))
        if retry and timezone.is_aware(retry) and retry>timezone.now():return
    # A manual login/logout/disable during network I/O wins over this result.
    target=LgentProfile.objects.filter(pk=record.pk,auto_sync_enabled=True,
        encrypted_token=record.encrypted_token,expires_at=record.expires_at,lg_user_id=record.lg_user_id,
        user__is_active=True,user__username=owner)
    try:
        fields=service.login_fields(record,user_id,password,expected_user_id=record.lg_user_id)
    except client.LgError as error:
        state.update({PREFIX+'Config':signature,PREFIX+'RetryAt':(timezone.now()+dt.timedelta(minutes=30)).isoformat(),
            PREFIX+'Blocked':error.code in ('invalid_login','invalid_org','foreign_supplier','lg_connection_required')})
        # No upstream text, credential, or password-derived value is public.
        target.update(sync_state=state)
    else:
        record.user.refresh_from_db()
        if not LgentAccess().has_permission(SimpleNamespace(user=record.user),SimpleNamespace(edit_action=False)):return
        state={key:value for key,value in state.items() if not key.startswith(PREFIX)}
        target.update(**fields,sync_state=state)
    record.refresh_from_db()
