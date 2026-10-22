"""Scheduled LG reads for users who explicitly enabled server synchronization."""
import time
from types import SimpleNamespace
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from . import autologin,client,mirror,refresh,service
from .models import LgentCart,LgentProfile
from .security import LgentAccess,decrypt_token

PUBLIC_STATE=('status','startedAt','lastRunAt','processed','metadataChanged','photoChanged','photoUnchanged','photoBaselined','errors')


def public_state(profile):
    return {key:profile.sync_state[key] for key in PUBLIC_STATE if key in profile.sync_state}


def enable(user,enabled):
    if type(enabled) is not bool:raise client.LgError('설정을 확인하세요.','invalid_setting',400)
    record=service.connection(user)[0] if enabled else service.profile(user,True)
    record.auto_sync_enabled=enabled
    record.save(update_fields=['auto_sync_enabled','updated_at'])
    return {'enabled':enabled}


def run(seconds=240,*,min_interval_seconds=0):
    deadline=time.monotonic()+seconds;summary={'profiles':0,'processed':0,'photoChanged':0,'errors':0}
    # One scheduled run across processes; web refresh uses its own small-page
    # lock and photo copies use per-cart locks. Never lock business rows here.
    with mirror.claim('server-sync:TT094') as acquired:
        if not acquired:return {**summary,'busy':True}
        records=LgentProfile.objects.filter(auto_sync_enabled=True,user__is_active=True).select_related('user').order_by('pk')
        for record in records:
            if time.monotonic()>=deadline:break
            if not LgentAccess().has_permission(SimpleNamespace(user=record.user),SimpleNamespace(edit_action=False)):continue
            # Preserve a valid web token if this cron has a mismatched key.
            if record.encrypted_token and not decrypt_token(record.encrypted_token):
                state=record.sync_state.copy();state.update(status='configuration_error',lastRunAt=timezone.now().isoformat())
                _store(record,state);summary['errors']+=1;continue
            autologin.renew_expired(record)
            if not record.auto_sync_enabled:continue
            record.user.refresh_from_db()
            if not LgentAccess().has_permission(SimpleNamespace(user=record.user),SimpleNamespace(edit_action=False)):continue
            state=record.sync_state.copy();state['lastRunAt']=timezone.now().isoformat()
            if not record.expires_at or record.expires_at<=timezone.now():
                state['status']='connection_required';_store(record,state);continue
            # A successful renewal must also decrypt in this runtime.
            if not decrypt_token(record.encrypted_token):
                state['status']='configuration_error';_store(record,state);summary['errors']+=1;continue
            previous=record.sync_state
            last_run=parse_datetime(str(previous.get('lastRunAt') or ''))
            resuming=bool(previous.get('_cursor') or previous.get('_photoCursor'))
            if (not resuming and previous.get('status')=='idle' and last_run and timezone.is_aware(last_run)
                    and (timezone.now()-last_run).total_seconds()<min_interval_seconds):continue
            try:
                _,token=service.connection(record.user)
                summary['profiles']+=1
                while time.monotonic()<deadline:
                    # Re-read opt-in and session on every bounded page. Disabling
                    # stops the next page. Reauthentication happens only at the
                    # next cron entry, never around photo-save/preflight calls.
                    record.refresh_from_db()
                    if not record.auto_sync_enabled:break
                    record.user.refresh_from_db()
                    if not LgentAccess().has_permission(SimpleNamespace(user=record.user),SimpleNamespace(edit_action=False)):break
                    _,token=service.connection(record.user)
                    photo_cursor=state.get('_photoCursor')
                    if photo_cursor:
                        before={cart.pk:(cart.mirror_sha256 or cart.photo_sha256,cart.photo_checked_at)
                            for cart in mirror.pending()}
                        result=service.sync(record.user,photo_cursor)
                        for cart in LgentCart.objects.filter(pk__in=before):
                            digest,checked=before[cart.pk]
                            if cart.photo_checked_at and cart.photo_checked_at!=checked:
                                key='photoBaselined' if not digest else 'photoUnchanged' if cart.mirror_sha256==digest else 'photoChanged'
                                state[key]=state.get(key,0)+1
                                if key=='photoChanged':summary['photoChanged']+=1
                        state['_photoCursor']=result['cursor'];state['errors']=state.get('errors',0)+result.get('mirrorErrors',0)
                        if not result['cursor']:
                            state['status']='idle';_store(record,state);break
                    else:
                        cursor=state.get('_cursor')
                        if not cursor:
                            state={key:value for key,value in state.items() if key in ('lastRunAt',)}
                            state.update(status='running',startedAt=timezone.now().isoformat(),processed=0,metadataChanged=0,photoChanged=0,photoUnchanged=0,photoBaselined=0,errors=0)
                        result=refresh.page(record.user,cursor)
                        if result['busy']:break
                        state['_cursor']=result['cursor'];state['processed']+=result['processed']
                        state['metadataChanged']+=result['changed'];state['errors']+=result['errors']
                        summary['processed']+=result['processed'];summary['errors']+=result['errors']
                        if not result['cursor']:
                            state['_photoCursor']=result.get('photoCursor')
                            if not state['_photoCursor']:
                                state['status']='idle';_store(record,state);break
                    _store(record,state)
            except client.LgError as error:
                state['status']='connection_required' if error.code=='lg_connection_required' else 'error'
                if error.code=='invalid_cursor':state.pop('_cursor',None);state.pop('_photoCursor',None)
                if error.code=='lg_connection_required':
                    LgentProfile.objects.filter(pk=record.pk).update(encrypted_token='',expires_at=None)
                state['errors']=state.get('errors',0)+1;summary['errors']+=1;_store(record,state)
    return summary


def _store(record,state):
    # No tokens, source URLs or provider exception strings in diagnostic state.
    LgentProfile.objects.filter(pk=record.pk).update(sync_state=state)
