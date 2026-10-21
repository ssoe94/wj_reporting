import base64
import datetime as dt
import hashlib
import json
import secrets
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor
from django.core import signing
from django.core.cache import cache
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ai_core.models import AiJob
from . import client,media,mirror,recognition
from .models import LgentProfile,LgentCart,LgentPhoto,LgentSaveEvent
from .security import encrypt_token,decrypt_token,can_edit

PHOTO_JOB='lgent_trolley_photo'
PROMPT='lgent-trolley-photo-v1'


def profile(user,create=False):
    if create:return LgentProfile.objects.get_or_create(user=user)[0]
    return LgentProfile.objects.filter(user=user).first()


def connection(user):
    value=profile(user)
    if not value or not value.expires_at or value.expires_at<=timezone.now():
        raise client.LgError('LG X-View에 먼저 연결하세요.','lg_connection_required',409)
    token=decrypt_token(value.encrypted_token)
    if not token:raise client.LgError('LG X-View에 다시 연결하세요.','lg_connection_required',409)
    return value,token


def login(user,user_id,password):
    if not isinstance(user_id,str) or not isinstance(password,str) or not user_id.strip() or not password or len(user_id)>150 or len(password)>512:
        raise client.LgError('LG 아이디와 비밀번호를 입력하세요.','invalid_login',400)
    record=profile(user,True)
    value=client.request('/user/login',payload={'UserId':user_id.strip(),'UserPassword':password,'DeviceId':str(record.device_id),'AppVersion':'1.6.72'})
    token=value.get('token') if isinstance(value,dict) else None
    info=value.get('user_info') if isinstance(value,dict) else None
    if not isinstance(token,str) or not token or not isinstance(info,dict):
        raise client.LgError('LG 아이디와 비밀번호를 확인하세요.','invalid_login',400)
    company=client.request('/user/current_com_code',token)
    orgs=client.rows(client.request('/common/org/'+quote(str(info.get('userId') or user_id.strip()),safe='')+'/AC_MWO_USER',token))
    if not any(str(row.get('orgCode'))=='ENT' for row in orgs):
        raise client.LgError('LGENT 사업장에 접근할 수 있는 계정이 필요합니다.','invalid_org',403)
    suppliers=client.rows(client.request('/cart/suppliers/ENT',token))
    if not any(str(row.get('supplier_code'))=='TT094' for row in suppliers):
        raise client.LgError('万佳 공급업체 조회 권한을 확인하세요.','foreign_supplier',403)
    permission=client.request('/user/permission/MOBILE/'+client.MENU,token)
    if company not in ('LGENT','LGETA') or not isinstance(permission,str) or not permission:
        raise client.LgError('LG 회사·메뉴 권한을 확인할 수 없습니다.')
    record=profile(user,True)
    record.encrypted_token=encrypt_token(token);record.lg_user_id=str(info.get('userId') or user_id.strip())[:160]
    record.lg_user_name=str(info.get('userName') or '')[:160];record.current_company=company
    record.menu_permission=permission;record.expires_at=client.session_expiry(token);record.save()
    return {'connected':True}


def remember(row):
    cart,_=LgentCart.objects.get_or_create(trolley_id=row['trolley_id'])
    known_photo=bool(cart.mirror_sha256 or cart.photo_sha256)
    if not known_photo and cart.baseline.get('pic_url')!=row.get('pic_url'):
        cart.verified_save_at=None;cart.photo_sha256=''
    cart.baseline={key:value for key,value in row.items() if key!='file_stream_bytes'}
    cart.supplier_code='TT094'
    cart.grade=str(row.get('last_grade') or '')[:8];cart.lg_modified_at=client.modified_at(row)
    # A metadata/URL change is a candidate, not proof of a new photograph.
    # Keep the prior photo date until mirror.copy compares the actual bytes.
    if not known_photo:cart.photo_file_at=client.photo_file_at(row.get('pic_url') or '')
    cart.checked_at=timezone.now()
    # Cache readers must never write back an older external-write lease.
    cart.save(update_fields=['baseline','supplier_code','grade','lg_modified_at','photo_file_at','checked_at','verified_save_at','photo_sha256','updated_at'])
    return cart


def public_cart(cart,stale_days=30):
    if cart.photo_changed_at:stamp,source=cart.photo_changed_at,'photo_changed'
    elif cart.verified_save_at:stamp,source=cart.verified_save_at,'verified_save'
    elif cart.photo_file_at:stamp,source=cart.photo_file_at,'photo_file'
    else:stamp,source=None,'unknown'
    days=max(0,(timezone.now()-stamp).days) if stamp else None
    candidate=client.modified_at(cart.baseline) or client.photo_file_at(str(cart.baseline.get('pic_url') or ''))
    result={'trolleyId':cart.trolley_id,'grade':cart.grade,'displayAt':stamp.astimezone(client.TZ).isoformat() if stamp else '',
            'dateSource':source,'ageDays':days,'alert':'unknown' if days is None else 'stale' if days>=stale_days else 'fresh',
            'hasPhoto':bool(cart.baseline.get('pic_url')),'photoKnown':cart.baseline.get('supplier_id')=='TT094',
            'photoVersion':cart_photo_version(cart),'lastHistoryAt':cart.last_history_at,
            'photoCheckPending':bool(cart.baseline.get('pic_url') and (cart.mirror_sha256 or cart.photo_sha256) and not mirror.current(cart)),
            'photoCandidateAt':candidate.astimezone(client.TZ).isoformat() if candidate else '',
            'checkedAt':cart.checked_at.isoformat() if cart.checked_at else ''}
    if mirror.current(cart):result.update(media.mirror_urls(cart.mirror_key))
    return result


def public_photo(value):
    status=value.status
    if status=='queued' and value.job_id:
        if value.job.status in ('claimed','running'):status='analyzing'
        elif value.job.status=='failed':status='error'
        elif value.job.status=='cancelled':status='review'
    return {'id':value.pk,'filename':value.filename,'trolleyId':value.trolley_id,'status':status,
            'note':value.note,'grade':value.grade,'recognizedIds':value.recognized_ids,
            'photoVersion':value.sha256,
            'jobStatus':value.job.status if value.job_id else ''}


def workspace(user,fleet_version=None):
    from .continuous import public_state
    record=profile(user);connected=bool(record and record.expires_at and record.expires_at>timezone.now() and decrypt_token(record.encrypted_token))
    days=record.stale_days if record else 30
    photos=LgentPhoto.objects.filter(user=user,archived_at__isnull=True).select_related('job').order_by('-created_at')
    active=list(photos.exclude(status__in=('saved','accepted'))[:500]);completed=list(photos.filter(status__in=('saved','accepted'))[:20])
    heartbeat=None
    # Portable on SQLite/PostgreSQL. Heartbeat rows are few and contain no images.
    for candidate in AiJob.objects.filter(job_type='worker_heartbeat').order_by('-completed_at')[:20]:
        if candidate.claimed_by.endswith('-lgent') and 'qwen38' in candidate.result_payload.get('available_model_ids',[]):heartbeat=candidate;break
    online=bool(heartbeat and heartbeat.completed_at and (timezone.now()-heartbeat.completed_at).total_seconds()<180 and heartbeat.result_payload.get('llm_ready'))
    fleet=[public_cart(cart,days) for cart in LgentCart.objects.filter(supplier_code='TT094').order_by('trolley_id')[:5000]]
    # Polls repeat every minute; skip the (large) fleet when the client already holds this exact list.
    version=hashlib.sha256(json.dumps(fleet,sort_keys=True,separators=(',',':')).encode()).hexdigest()[:32]
    return {'connection':{'authenticated':connected,'userName':record.lg_user_name if record else '',
                           'expiresAt':record.expires_at.isoformat() if record and record.expires_at else ''},
            'company':{'name':'万佳','code':'TT094'},'fleet':None if fleet_version==version else fleet,'fleetVersion':version,
            'queue':[public_photo(value) for value in active+completed],'settings':{'staleDays':days},
            'sync':{'enabled':bool(record and record.auto_sync_enabled),'state':public_state(record) if record else {}},
            'worker':{'state':'online' if online else 'offline','modelName':'Qwen 3.8 27B'},'capabilities':{'canEdit':can_edit(user)}}


HISTORY_DAYS=(30,90,180,365,730,1095,1825)


def sync(user,cursor=None,days=None):
    _,token=connection(user)
    if cursor:
        if not isinstance(cursor,str) or len(cursor)>2048:raise client.LgError('동기화를 처음부터 다시 실행하세요.','invalid_cursor',400)
        try:
            data=signing.loads(cursor,salt='lgent-sync',max_age=1800)
            if data['user']!=user.pk:raise ValueError()
            cutoff=dt.datetime.fromisoformat(data['start']);offset=int(data['offset']);phase=data.get('phase','metadata');after=data.get('after','')
            window=int(data.get('days',30))
            if window not in HISTORY_DAYS or not 0<=offset<=window:raise ValueError()
            if phase not in ('metadata','photos') or not isinstance(after,str) or len(after)>64:raise ValueError()
        except (ValueError,KeyError,signing.BadSignature):raise client.LgError('동기화를 처음부터 다시 실행하세요.','invalid_cursor',400)
    else:
        # One-off wider windows find carts that have not entered LG in the last month.
        window=30 if days is None else days
        if type(window) is not int or window not in HISTORY_DAYS:raise client.LgError('이력 범위를 확인하세요.','invalid_setting',400)
        cutoff=timezone.now();offset=0;phase='metadata';after=''
    if phase=='photos':
        targets=mirror.pending().filter(trolley_id__gt=after).order_by('trolley_id')
        carts=list(targets[:5]);last,processed,errors=mirror.copy_batch(carts,token)
        last=last or after
        remaining=mirror.pending().filter(trolley_id__gt=last).count()
        return {'discovered':LgentCart.objects.filter(supplier_code='TT094').count(),'processed':processed,
            'remaining':remaining,'errors':0,'mirrorErrors':errors,'phase':'photos',
            'cursor':signing.dumps({'user':user.pk,'start':cutoff.isoformat(),'offset':window,'days':window,'phase':'photos','after':last},salt='lgent-sync') if remaining else None}
    if offset<window:
        end=cutoff.astimezone(client.TZ).date()
        days=[(end-dt.timedelta(days=i)).isoformat() for i in range(offset,min(offset+3,window))]
        def fetch(day):return day,client.rows(client.request('/cart/enter_history/LGETA/ENT/TT094/'+day,token))
        with ThreadPoolExecutor(max_workers=3) as pool:history=list(pool.map(fetch,days))
        for day,rows in history:
            for row in rows:
                code=str(row.get('trolley_id') or '')
                supplier=row.get('supplier_id') or row.get('supplier_code')
                if not client.ID.fullmatch(code) or supplier and supplier!='TT094':continue
                cart,_=LgentCart.objects.get_or_create(trolley_id=code,defaults={'grade':str(row.get('grade_code') or '')[:8]})
                stamp=day+' '+str(row.get('hms') or '')
                if stamp>cart.last_history_at:cart.last_history_at=stamp;cart.save(update_fields=['last_history_at','updated_at'])
        offset=min(offset+3,window)
        remaining=LgentCart.objects.filter(supplier_code='TT094').filter(Q(checked_at__isnull=True)|Q(checked_at__lt=cutoff)).count()
        return {'discovered':LgentCart.objects.filter(supplier_code='TT094').count(),'processed':0,'remaining':remaining,'errors':0,
                'cursor':signing.dumps({'user':user.pk,'start':cutoff.isoformat(),'offset':offset,'days':window},salt='lgent-sync')}
    targets=list(LgentCart.objects.filter(supplier_code='TT094').filter(Q(checked_at__isnull=True)|Q(checked_at__lt=cutoff)).order_by('checked_at','trolley_id')[:5])
    def fetch_info(cart):
        try:return client.info(token,cart.trolley_id),None
        except client.LgError as error:return None,error
    errors=0
    with ThreadPoolExecutor(max_workers=5) as pool:results=list(pool.map(fetch_info,targets))
    for cart,(row,error) in zip(targets,results):
        if row:remember(row)
        else:
            errors+=1
            if error.code=='lg_connection_required':raise error
            if error.code=='foreign_supplier':cart.supplier_code='not_wanjia'
            # Mark an attempted cache read so a missing or transferred trolley
            # cannot make the cursor loop forever. Its business data is untouched.
            cart.checked_at=timezone.now();cart.save(update_fields=['checked_at','supplier_code','updated_at'])
    remaining=LgentCart.objects.filter(supplier_code='TT094').filter(Q(checked_at__isnull=True)|Q(checked_at__lt=cutoff)).count()
    photos=mirror.pending().count() if not remaining else 0
    return {'discovered':LgentCart.objects.filter(supplier_code='TT094').count(),'processed':len(targets),'remaining':remaining,'errors':errors,
            'cursor':signing.dumps({'user':user.pk,'start':cutoff.isoformat(),'offset':offset,'days':window},salt='lgent-sync') if remaining else None,
            'photoRemaining':photos,'photoCursor':signing.dumps({'user':user.pk,'start':cutoff.isoformat(),'offset':window,'days':window,'phase':'photos','after':''},salt='lgent-sync') if photos else None}


def lookup(user,trolley_id):
    _,token=connection(user);cart=remember(client.info(token,trolley_id))
    return {'cart':public_cart(cart,profile(user).stale_days)}


def cart_photo_version(cart):
    # Metadata polling must not invalidate every photograph. A verified save
    # changes its digest even when LG reuses an image URL.
    return hashlib.sha256((str(cart.baseline.get('pic_url') or '')+':'+cart.photo_sha256).encode()).hexdigest()


def cart_thumbnail_key(cart):
    return 'lgent-thumb:'+cart.trolley_id+':'+cart_photo_version(cart)


def cached_cart_version(user,trolley_id):
    # Local validation only: never perform an upstream read to answer a 304.
    client.code(trolley_id)
    cart=LgentCart.objects.filter(trolley_id=trolley_id,supplier_code='TT094').first()
    if not cart or not mirror.current(cart):connection(user)
    row=cart.baseline if cart else {}
    if (row.get('supplier_id')=='TT094' and row.get('com_code') in ('LGENT','LGETA')
        and row.get('trolley_id')==trolley_id and row.get('org_code') and row.get('pic_url')):
        return cart_photo_version(cart)
    return ''


def cart_image(user,trolley_id,thumbnail=False):
    client.code(trolley_id)
    cart=LgentCart.objects.filter(trolley_id=trolley_id,supplier_code='TT094').first()
    mirror_failed=False
    if cart and mirror.current(cart):
        key=cart_thumbnail_key(cart)
        cached=cache.get(key) if thumbnail else None
        if isinstance(cached,bytes):return cached,cart_photo_version(cart)
        try:
            raw=media.read_mirror(cart.mirror_key)
            if thumbnail:raw=media.thumbnail(raw);cache.set(key,raw,900)
            return raw,cart_photo_version(cart)
        except client.LgError:
            mirror_failed=True
            LgentCart.objects.filter(pk=cart.pk,mirror_key=cart.mirror_key).update(mirror_error='비공개 복제 사진 조회 실패')
    _,token=connection(user)
    # The workspace already holds supplier-verified LG metadata. Re-fetching
    # cart/info for every thumbnail doubles slow upstream reads and DB writes.
    row=cart.baseline if cart else {}
    if row.get('supplier_id')!='TT094' or row.get('com_code') not in ('LGENT','LGETA') or row.get('trolley_id')!=trolley_id or not row.get('org_code'):
        row=client.info(token,trolley_id);cart=remember(row)
    key=cart_thumbnail_key(cart)
    if thumbnail:
        cached=cache.get(key)
        if isinstance(cached,bytes):return cached,cart_photo_version(cart)
    raw,error=mirror.copy(cart,token,force=mirror_failed) if row.get('pic_url') else (b'',None)
    if raw is None:
        if error and error.code=='mirror_pending':raw=client.photo(token,row)
        elif error:raise error
        else:raw=media.read_mirror(cart.mirror_key)
    key=cart_thumbnail_key(cart)
    digest=hashlib.sha256(raw).hexdigest() if raw else ''
    if cart.verified_save_at and cart.photo_sha256 and digest!=cart.photo_sha256:
        # LG can replace bytes at the same URL. Invalidate only the snapshot
        # actually read, never a concurrent save's verification or active lease.
        changed=LgentCart.objects.filter(pk=cart.pk,baseline=cart.baseline,
            photo_sha256=cart.photo_sha256,verified_save_at=cart.verified_save_at,save_attempt_id='').update(
                verified_save_at=None,photo_sha256='',updated_at=timezone.now())
        if changed:
            cart.verified_save_at=None;cart.photo_sha256='';key=cart_thumbnail_key(cart)
    # Gallery cache is small; original bytes and their write-verification digest
    # stay untouched. Image reads never acquire or erase write leases.
    if thumbnail:
        raw=media.thumbnail(raw);cache.set(key,raw,900)
    return raw,cart_photo_version(cart)


def data_image(raw):
    if not raw:return {'photoData':None}
    mime='image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg'
    return {'photoData':'data:'+mime+';base64,'+base64.b64encode(raw).decode()}


def upload(user,file):
    raw=media.normalize(file.read(media.MAX_BYTES+1));digest=hashlib.sha256(raw).hexdigest()
    existing=LgentPhoto.objects.filter(user=user,sha256=digest).first()
    if existing:
        if existing.archived_at and existing.status not in ('saved','accepted','uncertain','saving'):
            existing.archived_at=None;existing.save(update_fields=['archived_at','updated_at'])
        return existing
    if LgentPhoto.objects.filter(user=user,archived_at__isnull=True).exclude(status__in=('saved','accepted')).count()>=500:
        raise client.LgError('등록 대기 사진은 최대 500장입니다.','queue_full',400)
    key=media.put(raw,user.pk,digest)
    return LgentPhoto.objects.get_or_create(user=user,sha256=digest,defaults={'filename':str(file.name).replace('\\','/').rsplit('/',1)[-1][:255],
                   'storage_key':key,'byte_size':len(raw),'note':'번호 분석 대기'})[0]


def owned_photos(user,ids,limit=500):
    if not isinstance(ids,list) or not 1<=len(ids)<=limit or any(type(value) is not int for value in ids):
        raise client.LgError('사진 선택을 확인하세요.','invalid_selection',400)
    unique=list(dict.fromkeys(ids));items=list(LgentPhoto.objects.filter(pk__in=unique,user=user,archived_at__isnull=True).select_related('job'))
    if len(items)!=len(unique):raise client.LgError('선택한 사진을 찾지 못했습니다.','photo_not_found',404)
    return items


def analyze(user,ids):
    items=owned_photos(user,ids)
    if any(value.status in ('saving','saved','accepted','uncertain') for value in items):
        raise client.LgError('이미 저장을 시도한 사진은 다시 전송하지 않습니다.','already_submitted',409)
    queued=0
    with transaction.atomic():
        for value in LgentPhoto.objects.select_for_update().filter(pk__in=[x.pk for x in items],user=user):
            if value.status in ('saving','saved','accepted','uncertain'):
                raise client.LgError('이미 저장을 시도한 사진은 다시 분석하지 않습니다.','already_submitted',409)
            if value.job_id and value.job.status in ('pending','claimed','running'):continue
            value.job=AiJob.objects.create(job_type=PHOTO_JOB,created_by=user,
                scope={'model_id':'qwen38','trigger':'lgent_photo','photo_id':value.pk},
                input_payload={'photo_id':value.pk,'image_endpoint':f'/lgent/worker/photos/{value.pk}/','sha256':value.sha256})
            value.status='queued';value.note='맥 워커가 켜지면 번호 분석을 시작합니다.';value.save();queued+=1
    return {'queued':queued}


def accept_result(job,result,prompt_version):
    if prompt_version!=PROMPT:raise ValueError('Unsupported trolley recognition prompt.')
    primary=str(result.get('primary_id') or '').strip().upper()
    evidence=result.get('local_evidence') or []
    if not isinstance(evidence,list) or len(evidence)>100:raise ValueError('Invalid local label evidence.')
    valid=[{**item,'id':item['id'].upper()} for item in evidence if isinstance(item,dict) and isinstance(item.get('id'),str) and client.ID.fullmatch(item['id'])
           and type(item.get('confidence')) in (int,float) and .8<=item['confidence']<=1]
    agreed=client.ID.fullmatch(primary) is not None and result.get('uncertain') is False and any(item['id']==primary for item in valid)
    known=set(LgentCart.objects.filter(supplier_code='TT094').values_list('trolley_id',flat=True))
    recognized=sorted({item['id'] for item in valid})
    suggestions=[]
    if known:
        agreed=agreed and primary in known
        recognized=sorted(set(recognized)&known)
        if primary not in known:
            if len(recognized)==1:suggestions=recognized
            elif not recognized:suggestions=recognition.candidates(primary,known) if client.ID.fullmatch(primary) else []
            recognized=suggestions
    value=LgentPhoto.objects.select_for_update().filter(job=job,pk=job.scope.get('photo_id'),user_id=job.created_by_id,archived_at__isnull=True).first()
    if not value:raise ValueError('The trolley photo no longer belongs to this job.')
    value.trolley_id=primary if client.ID.fullmatch(primary) else '';value.recognized_ids=recognized
    value.status='recognized' if agreed else 'review'
    value.note='AI·QR 번호 일치. LG 소속 대조 대기' if agreed else '사진의 대차 번호를 직접 확인하세요.'
    if len(suggestions)==1:value.note=f'{primary} → {suggestions[0]}? 사진과 번호를 직접 확인하세요.'
    elif known and primary not in known:value.note='알려진 万佳 목록에 없는 번호입니다. 직접 확인하세요.'
    value.save()
    return {'primary_id':value.trolley_id,'local_evidence':valid,'uncertain':not agreed,'model_id':'qwen38'}


def match(user,value,trolley_id,confirmed):
    if confirmed is not True:raise client.LgError('사진과 번호가 맞는지 확인하세요.','confirmation_required',400)
    if value.status in ('saving','uncertain'):
        raise client.LgError('저장을 시도한 사진은 먼저 LG에서 다시 조회하세요.','already_submitted',409)
    correcting=value.status in ('saved','accepted')
    if correcting and trolley_id==value.trolley_id:
        raise client.LgError('이미 저장한 번호입니다. 다른 번호로 수정하거나 LG 결과를 재조회하세요.','same_saved_number',409)
    _,token=connection(user);row=client.info(token,trolley_id);remember(row);raw=client.photo(token,row)
    with transaction.atomic():
        # Worker completion/failure locks AiJob before its photo.
        if value.job_id:AiJob.objects.select_for_update().filter(pk=value.job_id).first()
        live=LgentPhoto.objects.select_for_update().get(pk=value.pk,user=user)
        if live.status in ('saving','uncertain') or live.updated_at!=value.updated_at:
            raise client.LgError('사진 처리 상태가 변경됐습니다. 다시 조회하세요.','photo_conflict',409)
        if correcting:
            # Keep the original external write under its original trolley in
            # SaveEvent. A correction prepares a new target; it never undoes or
            # repeats the previous LG write, nor releases an unresolved lease.
            old_cart=LgentCart.objects.select_for_update().get(trolley_id=live.trolley_id)
            if old_cart.save_attempt_id or not live.save_events.filter(attempt_id=live.save_attempt_id,
                    trolley_id=live.trolley_id,outcome__in=('saved','accepted')).exists():
                raise client.LgError('이전 LG 저장 결과를 먼저 확인하세요.','already_submitted',409)
            live.save_attempt_id='';live.saved_at=None
        if live.job_id and live.job.status in ('pending','claimed','running'):
            AiJob.objects.filter(pk=live.job_id).update(status='cancelled')
            live.job=None
        live.trolley_id=trolley_id;live.baseline={key:data for key,data in row.items() if key!='file_stream_bytes'}
        live.previous_photo_sha256=hashlib.sha256(raw).hexdigest() if raw else '';live.grade=str(row.get('last_grade') or '')
        live.status='ready';live.note='LG 万佳 소속과 대차 번호 대조 완료';live.save()
    return live


def verify(user,ids):
    items=owned_photos(user,ids,limit=5);count=0
    for value in items:
        if value.status!='recognized':continue
        try:match(user,value,value.trolley_id,True);count+=1
        except client.LgError as error:
            if error.code=='lg_connection_required':raise error
            if error.code=='foreign_supplier':
                LgentCart.objects.filter(trolley_id=value.trolley_id).update(supplier_code='not_wanjia')
            value.status='review';value.note=str(error);value.save()
    return {'verified':count}


def save_one(user,photo_id):
    record,token=connection(user)
    if record.current_company=='LGETA' and record.menu_permission[:1] not in ('A','M'):
        raise client.LgError('현재 LG 회사와 메뉴의 저장 권한을 확인하세요.','lg_write_denied',403)
    attempt=secrets.token_hex(24)
    with transaction.atomic():
        value=LgentPhoto.objects.select_for_update().get(pk=photo_id,user=user)
        if value.status!='ready' or not value.baseline:raise client.LgError('번호 대조가 완료된 사진만 저장하세요.','not_ready',409)
        # Lock the cart for this preflight/attempt. Other photos for the same cart
        # cannot be committed against the old baseline after the first update.
        locked_cart=LgentCart.objects.select_for_update().get(trolley_id=value.trolley_id)
        if locked_cart.save_attempt_id:
            raise client.LgError('이 대차의 이전 저장 결과를 먼저 확인하세요.','cart_save_pending',409)
        row=client.info(token,value.trolley_id);old_photo=client.photo(token,row)
        if client.fingerprint(row)!=client.fingerprint(value.baseline) or (hashlib.sha256(old_photo).hexdigest() if old_photo else '')!=value.previous_photo_sha256:
            raise client.LgError('LG 정보나 사진이 변경됐습니다. 다시 대조하세요.','lg_conflict',409)
        raw=media.read(value.storage_key)
        if hashlib.sha256(raw).hexdigest()!=value.sha256:raise client.LgError('저장할 사진이 변경됐습니다.','photo_conflict',409)
        value.status='saving';value.save_attempt_id=attempt;value.note='LG에 사진 저장 중';value.save()
        locked_cart.save_attempt_id=attempt;locked_cart.save_started_at=timezone.now()
        locked_cart.save(update_fields=['save_attempt_id','save_started_at','updated_at'])
        LgentSaveEvent.objects.create(user=user,photo=value,trolley_id=value.trolley_id,attempt_id=attempt,outcome='sending')
    # Durable sending state is committed BEFORE the external write. A lost
    # response or process restart must not make a repeated POST possible.
    payload={'com_code':'LGETA','org_code':row['org_code'],'trolley_id':value.trolley_id,'supplier_id':'TT094',
             'last_item_id':str(row.get('last_item_id') or ''),'last_grade':str(row.get('last_grade') or ''),
             'problem':row.get('problem') or '','memo':row.get('memo') or '',
             'file_stream_bytes':base64.b64encode(raw).decode(),'update_user_id':record.lg_user_id}
    if not payload['last_item_id'] or payload['last_grade'] not in ('A','B','C','D','E'):
        value.status='review';value.note='현재 LG 품목·등급을 확인하세요.';value.save()
        LgentSaveEvent.objects.filter(attempt_id=attempt).update(outcome='preflight_failed')
        LgentCart.objects.filter(pk=locked_cart.pk,save_attempt_id=attempt).update(save_attempt_id='',save_started_at=None)
        return {'id':value.pk,'status':value.status,'message':value.note}
    accepted=False;info_verified=photo_verified=False
    try:
        result=client.request('/cart/info',token,payload)
        accepted=isinstance(result,dict) and str(result.get('typeCode')).lower()=='true'
        if accepted:
            after=client.info(token,value.trolley_id);after_photo=client.photo(token,after)
            info_verified=all(str(after.get(key) or '')==str(payload[key]) for key in ('last_item_id','last_grade','problem','memo'))
            photo_verified=hashlib.sha256(after_photo).hexdigest()==value.sha256
            cart=remember(after)
            if info_verified and photo_verified:
                mirror.attach_upload(cart,value,after,previous_sha256=hashlib.sha256(old_photo).hexdigest() if old_photo else '')
                cart.photo_sha256=value.sha256;cart.save()
    except client.LgError:pass
    value.status='saved' if info_verified and photo_verified else 'accepted' if accepted else 'uncertain'
    value.note='LG 저장·재조회 일치 확인' if value.status=='saved' else 'LG에서 사진과 저장 결과를 다시 확인하세요. 자동 재전송하지 않습니다.'
    value.saved_at=timezone.now() if accepted else None;value.save()
    LgentSaveEvent.objects.filter(attempt_id=attempt).update(outcome=value.status,info_verified=info_verified,photo_verified=photo_verified)
    if accepted:
        LgentCart.objects.filter(pk=locked_cart.pk,save_attempt_id=attempt).update(save_attempt_id='',save_started_at=None)
    return {'id':value.pk,'status':value.status,'message':value.note}


def reconcile(user,photo_id):
    """Readback only: never repeat a possibly accepted LG write."""
    _,token=connection(user)
    value=LgentPhoto.objects.get(pk=photo_id,user=user,archived_at__isnull=True)
    if value.status not in ('accepted','uncertain','saving'):
        raise client.LgError('저장 결과 확인 대상이 아닙니다.','not_submitted',409)
    if value.status=='saving' and (timezone.now()-value.updated_at).total_seconds()<300:
        raise client.LgError('저장 처리 후 다시 확인하세요.','busy',409)
    row=client.info(token,value.trolley_id);raw=client.photo(token,row)
    info_ok=all(str(row.get(key) or '')==str(value.baseline.get(key) or '') for key in ('last_item_id','last_grade','problem','memo'))
    photo_ok=bool(raw) and hashlib.sha256(raw).hexdigest()==value.sha256
    if not info_ok or not photo_ok:
        return {'id':value.pk,'status':value.status,'verified':False}
    with transaction.atomic():
        live=LgentPhoto.objects.select_for_update().get(pk=value.pk,user=user)
        cart=LgentCart.objects.select_for_update().get(trolley_id=value.trolley_id)
        if live.save_attempt_id!=value.save_attempt_id or (cart.save_attempt_id and cart.save_attempt_id!=value.save_attempt_id):
            raise client.LgError('다른 저장이 진행 중입니다. 다시 조회하세요.','photo_conflict',409)
        live.status='saved';live.saved_at=timezone.now();live.note='LG 결과 재조회·사진 일치 확인';live.save()
        cart=remember(row);mirror.attach_upload(cart,live,row,previous_sha256=live.previous_photo_sha256);cart.photo_sha256=value.sha256
        cart.save_attempt_id='';cart.save_started_at=None;cart.save()
        LgentSaveEvent.objects.filter(attempt_id=value.save_attempt_id,photo=live).update(outcome='saved',info_verified=True,photo_verified=True)
    return {'id':value.pk,'status':'saved','verified':True}


def record_failure(job):
    LgentPhoto.objects.filter(job=job,user_id=job.created_by_id,archived_at__isnull=True,status__in=('queued','analyzing')).update(status='error',note='맥 AI 번호 분석에 실패했습니다. 다시 분석하거나 번호를 직접 확인하세요.',updated_at=timezone.now())
