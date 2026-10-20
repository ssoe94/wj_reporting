"""Display-only replica. Never supplies an LG write preflight or readback."""
import hashlib
import threading
import weakref
from contextlib import contextmanager
from django.db import connection
from django.db.models import F,Q,TextField
from django.db.models.functions import Cast
from django.db.models.fields.json import KeyTextTransform
from django.utils import timezone
from . import client,media
from .models import LgentCart

_locks=weakref.WeakValueDictionary()
_guard=threading.Lock()

def current(cart):
    return bool(cart.mirror_key and cart.mirror_sha256 and cart.mirrored_at and cart.mirror_source_url==cart.baseline.get('pic_url')
        and cart.baseline.get('supplier_id')=='TT094' and cart.supplier_code=='TT094'
        and cart.baseline.get('com_code') in ('LGENT','LGETA') and cart.baseline.get('org_code')
        and cart.baseline.get('trolley_id')==cart.trolley_id)

def pending():
    return LgentCart.objects.filter(supplier_code='TT094',baseline__supplier_id='TT094').annotate(
        source_url=Cast(KeyTextTransform('pic_url','baseline'),output_field=TextField())).exclude(source_url__isnull=True).exclude(source_url='').filter(
        Q(mirror_key='')|Q(mirror_sha256='')|Q(mirrored_at__isnull=True)|~Q(mirror_error='')|~Q(mirror_source_url=F('source_url')))

@contextmanager
def claim(trolley_id):
    # Separate nonblocking display-copy lock. It never takes the business row
    # write lease, so a slow replica upload cannot block LG preflight/save.
    if connection.vendor=='postgresql':
        key=int.from_bytes(hashlib.sha256(('lgent-mirror:'+trolley_id).encode()).digest()[:8],'big',signed=True)
        with connection.cursor() as cursor:cursor.execute('SELECT pg_try_advisory_lock(%s)',[key]);acquired=cursor.fetchone()[0]
        try:yield acquired
        finally:
            if acquired:
                with connection.cursor() as cursor:cursor.execute('SELECT pg_advisory_unlock(%s)',[key])
    else:
        with _guard:
            lock=_locks.get(trolley_id)
            if lock is None:lock=threading.Lock();_locks[trolley_id]=lock
        acquired=lock.acquire(blocking=False)
        try:yield acquired
        finally:
            if acquired:lock.release()

def copy(cart,token,force=False):
    with claim(cart.trolley_id) as acquired:
        if not acquired:return None,client.LgError('사진 복제 중입니다. 잠시 후 다시 확인하세요.','mirror_pending',503)
        cart.refresh_from_db()
        if current(cart) and not force and not cart.mirror_error:return None,None
        if cart.save_attempt_id:return None,client.LgError('LG 저장 결과 확인 후 복제합니다.','mirror_pending',503)
        row=cart.baseline;source=row.get('pic_url') or ''
        if not source or row.get('supplier_id')!='TT094' or cart.supplier_code!='TT094' or row.get('com_code') not in ('LGENT','LGETA') or not row.get('org_code') or row.get('trolley_id')!=cart.trolley_id:
            return None,client.LgError('万佳 사진 원본을 확인하세요.','foreign_supplier',403)
        raw=None
        try:
            raw=client.photo(token,row,timeout=(3,8),max_seconds=14)
            if not raw:raise client.LgError('LG 사진이 없습니다.','mirror_unavailable',502)
            digest=hashlib.sha256(raw).hexdigest();key=media.put_mirror(raw,cart.trolley_id,digest)
            changed=LgentCart.objects.filter(pk=cart.pk,baseline=row,save_attempt_id='').update(
                mirror_key=key,mirror_sha256=digest,mirror_source_url=source,mirrored_at=timezone.now(),mirror_error='')
            if changed:cart.refresh_from_db()
            else:return raw,client.LgError('대차 정보 변경 후 다시 복제합니다.','mirror_source_changed',409)
            return raw,None
        except client.LgError as error:
            # Never persist provider URLs, credentials or arbitrary SDK text.
            message='LG 원본 조회 실패' if raw is None else '비공개 사진 복제 저장 실패'
            LgentCart.objects.filter(pk=cart.pk,baseline=row,save_attempt_id='').update(mirror_error=message)
            return raw,error

def attach_upload(cart,photo,row):
    """Called only after BOTH live LG field and photo digest verification."""
    media.mirror_ref(photo.storage_key)
    cart.mirror_key=photo.storage_key;cart.mirror_sha256=photo.sha256
    cart.mirror_source_url=str(row.get('pic_url') or '');cart.mirrored_at=timezone.now();cart.mirror_error=''
