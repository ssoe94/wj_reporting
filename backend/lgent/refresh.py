"""Small display-cache refreshes. Never supplies an LG write decision."""
import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from django.core import signing
from django.db.models import Q
from django.utils import timezone
from . import client,mirror
from .models import LgentCart

SALT='lgent-refresh'
INTERVAL=dt.timedelta(minutes=15)


def page(user,cursor=None,force=False):
    from .service import connection,public_cart
    profile,token=connection(user)
    if type(force) is not bool:raise client.LgError('조회 조건을 확인하세요.','invalid_setting',400)
    if cursor is not None:
        try:
            if not isinstance(cursor,str) or len(cursor)>2048:raise ValueError()
            state=signing.loads(cursor,salt=SALT,max_age=1800)
            cutoff=dt.datetime.fromisoformat(state['cutoff']);after=state['after']
            if state['user']!=user.pk or not timezone.is_aware(cutoff) or cutoff>timezone.now() or not isinstance(after,str) or len(after)>64:raise ValueError()
        except (ValueError,TypeError,KeyError,signing.BadSignature):
            raise client.LgError('LG 확인을 다시 시작하세요.','invalid_cursor',400)
    else:
        cutoff=timezone.now()-(dt.timedelta() if force else INTERVAL);after=''
    # Session advisory lock is shared across processes, not a LocMem cache.
    # A second tab/user reuses the fresh rows instead of duplicating LG traffic.
    with mirror.claim('metadata-refresh:TT094') as acquired:
        if not acquired:return {'busy':True,'cursor':cursor,'processed':0,'changed':0,'errors':0}
        targets=LgentCart.objects.filter(supplier_code='TT094',save_attempt_id='',trolley_id__gt=after).filter(Q(checked_at__isnull=True)|Q(checked_at__lt=cutoff)).order_by('trolley_id')
        total=targets.count();carts=list(targets[:5])
        def read(cart):
            try:return client.info(token,cart.trolley_id),None
            except client.LgError as error:return None,error
        with ThreadPoolExecutor(max_workers=5) as pool:results=list(pool.map(read,carts))
        # Authentication failure must not be recorded as successful progress.
        for _,error in results:
            if error and error.code=='lg_connection_required':raise error
        changed=errors=0;updated=[];removed=[]
        for cart,(row,error) in zip(carts,results):
            # Network reads cannot race a save/readback and overwrite its newer
            # baseline or verification. No DB row lock is held during LG I/O.
            original=cart.baseline
            guard=LgentCart.objects.filter(pk=cart.pk,baseline=original,checked_at=cart.checked_at,
                photo_sha256=cart.photo_sha256,verified_save_at=cart.verified_save_at,save_attempt_id='')
            fields={'checked_at':timezone.now(),'updated_at':timezone.now()}
            if error:
                errors+=1
                if error.code=='foreign_supplier':fields['supplier_code']='not_wanjia'
            else:
                row={key:value for key,value in row.items() if key!='file_stream_bytes'}
                fields.update(baseline=row,grade=str(row.get('last_grade') or '')[:8],lg_modified_at=client.modified_at(row))
                if not (cart.mirror_sha256 or cart.photo_sha256):
                    fields['photo_file_at']=client.photo_file_at(row.get('pic_url') or '')
                    if original.get('pic_url')!=row.get('pic_url'):fields.update(photo_sha256='',verified_save_at=None)
            applied=guard.update(**fields)
            if applied and (fields.get('supplier_code') or row is not None and row!=original):
                changed+=1
                if fields.get('supplier_code'):removed.append(cart.trolley_id)
                else:
                    cart.refresh_from_db();updated.append(public_cart(cart,profile.stale_days))
        last=carts[-1].trolley_id if carts else after
        remaining=targets.filter(trolley_id__gt=last).count()
        next_cursor=signing.dumps({'user':user.pk,'cutoff':cutoff.isoformat(),'after':last},salt=SALT) if remaining else None
        # Reuse the existing, nonblocking replica pipeline after metadata reads.
        photos=mirror.pending().count() if not remaining else 0
        photo_cursor=signing.dumps({'user':user.pk,'start':timezone.now().isoformat(),'offset':30,'days':30,'phase':'photos','after':''},salt='lgent-sync') if photos else None
        return {'busy':False,'processed':len(carts),'remaining':remaining,'total':total,'changed':changed,'errors':errors,'updated':updated,'removed':removed,
            'cursor':next_cursor,'photoCursor':photo_cursor,'photoRemaining':photos}
