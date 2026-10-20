"""Private media in the existing configured Cloudinary account; local only in tests/dev."""
import hashlib
import io
import time
import re
from urllib3.util import Timeout
from threading import BoundedSemaphore
from pathlib import Path
import cloudinary.uploader
import cloudinary.utils
import requests
from PIL import Image,ImageOps,UnidentifiedImageError
from django.conf import settings
from django.core.cache import cache
from .client import LgError

MAX_BYTES=3*1024*1024
MIRROR_MAX_BYTES=5*1024*1024
THUMB_TRANSFORMATION='w_420,c_limit,q_auto,f_auto'
_THUMBNAIL_SLOTS=BoundedSemaphore(2)

def thumbnail(raw):
    if not raw:return raw
    try:
        with _THUMBNAIL_SLOTS, Image.open(io.BytesIO(raw)) as source:
            if source.width*source.height>24_000_000:raise ValueError()
            # Ask JPEG's decoder to downsample before EXIF transpose loads pixels.
            if source.format=='JPEG':source.draft('RGB',(840,840))
            with ImageOps.exif_transpose(source).convert('RGB') as image:
                image.thumbnail((420,420))
                output=io.BytesIO();image.save(output,format='JPEG',quality=75)
                return output.getvalue()
    except (ValueError,OSError,UnidentifiedImageError,Image.DecompressionBombError):
        raise LgError('사진 미리보기를 만들지 못했습니다.','image_unavailable',502)

def normalize(raw):
    if not raw or len(raw)>MAX_BYTES:raise LgError('사진은 3MB 이하로 준비하세요.','invalid_photo',400)
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width*source.height>12_000_000:raise ValueError()
            image=ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((1440,1440))
            output=io.BytesIO();image.save(output,format='JPEG',quality=85)
        return output.getvalue()
    except (ValueError,OSError,UnidentifiedImageError,Image.DecompressionBombError):
        raise LgError('JPEG 또는 PNG 사진을 선택하세요.','invalid_photo',400)


def configured():
    if getattr(settings,'LGENT_FORCE_LOCAL_MEDIA',False):return False
    value=getattr(settings,'CLOUDINARY_STORAGE',{}) or {}
    return all(value.get(key) for key in ('CLOUD_NAME','API_KEY','API_SECRET'))


def put(raw,user_id,digest):
    key=f'lgent/private/{user_id}/{digest}'
    if configured():
        try:
            result=cloudinary.uploader.upload(io.BytesIO(raw),public_id=key,resource_type='image',
                         type='authenticated',overwrite=False,unique_filename=False,timeout=25)
            return result['public_id']
        except Exception:raise LgError('사진 보관을 완료하지 못했습니다. 다시 시도하세요.','media_unavailable',503)
    if not (getattr(settings,'DEBUG',False) or getattr(settings,'LGENT_ALLOW_LOCAL_MEDIA',False)):
        raise LgError('사진 저장소가 준비되지 않았습니다.','media_unavailable',503)
    path=Path(settings.MEDIA_ROOT)/(key+'.jpg');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
    return key


def read(key):
    if not isinstance(key,str) or not key.startswith('lgent/private/') or '..' in key:
        raise LgError('사진 보관 경로를 확인할 수 없습니다.')
    cached=cache.get('lgent-media:'+key)
    if isinstance(cached,bytes):return cached
    if configured():
        url=cloudinary.utils.private_download_url(key,'jpg',resource_type='image',type='authenticated',expires_at=int(time.time())+60)
        try:
            with requests.get(url,timeout=(5,20),stream=True) as response:
                response.raise_for_status();raw=bytearray()
                for block in response.iter_content(65536):
                    raw.extend(block)
                    if len(raw)>MAX_BYTES:raise LgError('사진 크기를 확인할 수 없습니다.')
                result=bytes(raw)
        except requests.RequestException:raise LgError('등록 대기 사진을 읽지 못했습니다.')
    else:
        if not (getattr(settings,'DEBUG',False) or getattr(settings,'LGENT_ALLOW_LOCAL_MEDIA',False)):
            raise LgError('사진 저장소가 준비되지 않았습니다.')
        try:result=(Path(settings.MEDIA_ROOT)/(key+'.jpg')).read_bytes()
        except OSError:raise LgError('등록 대기 사진을 찾지 못했습니다.')
    if not result.startswith(b'\xff\xd8\xff'):raise LgError('사진 형식을 확인할 수 없습니다.')
    cache.set('lgent-media:'+key,result,60)
    return result


def _cloud_options():
    value=settings.CLOUDINARY_STORAGE
    return {'cloud_name':value['CLOUD_NAME'],'api_key':value['API_KEY'],'api_secret':value['API_SECRET'],'secure':True}


def mirror_ref(key):
    if re.fullmatch(r'lgent/private/[0-9]+/[a-f0-9]{64}',key or ''):return key,'jpg'
    match=re.fullmatch(r'(lgent/lg-mirror/TT094/[A-Za-z0-9_-]{3,64}/[a-f0-9]{64})\.(jpg|png)',key or '')
    if not match:raise LgError('복제 사진 경로를 확인할 수 없습니다.','mirror_unavailable',502)
    return match.group(1),match.group(2)


def put_mirror(raw,trolley_id,digest,*,max_seconds=15):
    from .client import code
    code(trolley_id)
    if not raw or len(raw)>MIRROR_MAX_BYTES or hashlib.sha256(raw).hexdigest()!=digest:
        raise LgError('복제 사진 데이터를 확인할 수 없습니다.','mirror_unavailable',502)
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.width*image.height>24_000_000:raise ValueError()
            image.verify()
    except (ValueError,OSError,UnidentifiedImageError,Image.DecompressionBombError):
        raise LgError('복제 사진 형식을 확인할 수 없습니다.','mirror_unavailable',502)
    extension='png' if raw.startswith(b'\x89PNG') else 'jpg'
    public_id=f'lgent/lg-mirror/TT094/{trolley_id}/{digest}'
    if configured():
        try:
            value=cloudinary.uploader.upload(io.BytesIO(raw),public_id=public_id,resource_type='image',
                type='authenticated',overwrite=False,unique_filename=False,timeout=Timeout(total=max_seconds,connect=min(3,max_seconds),read=min(12,max_seconds)),**_cloud_options())
            if value.get('public_id')!=public_id:raise ValueError()
        except Exception:raise LgError('사진 복제 저장이 지연되고 있습니다.','mirror_unavailable',503)
    else:
        if not (getattr(settings,'DEBUG',False) or getattr(settings,'LGENT_ALLOW_LOCAL_MEDIA',False)):
            raise LgError('사진 복제 저장소가 준비되지 않았습니다.','mirror_unavailable',503)
        path=Path(settings.MEDIA_ROOT)/(public_id+'.'+extension)
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
    # The field is an asset locator; Cloudinary public_id excludes the extension.
    return public_id+'.'+extension


def mirror_urls(key):
    public_id,extension=mirror_ref(key)
    if not configured():return {}
    def url(thumbnail=False):
        options={'transformation':THUMB_TRANSFORMATION} if thumbnail else {}
        return cloudinary.utils.cloudinary_url(public_id,type='authenticated',sign_url=True,
            format=extension,**options,**_cloud_options())[0]
    return {'thumbnailUrl':url(True),'imageUrl':url()}



def read_mirror(key):
    public_id,extension=mirror_ref(key)
    if public_id.startswith('lgent/private/'):return read(public_id)
    if not configured():
        if not (getattr(settings,'DEBUG',False) or getattr(settings,'LGENT_ALLOW_LOCAL_MEDIA',False)):
            raise LgError('사진 복제 저장소가 준비되지 않았습니다.','mirror_unavailable',503)
        try:return (Path(settings.MEDIA_ROOT)/(public_id+'.'+extension)).read_bytes()
        except OSError:raise LgError('복제 사진을 읽지 못했습니다.','mirror_unavailable',502)
    url=cloudinary.utils.private_download_url(public_id,extension,resource_type='image',type='authenticated',
        expires_at=int(time.time())+60,**_cloud_options())
    try:
        with requests.get(url,timeout=(3,10),stream=True) as response:
            response.raise_for_status();raw=bytearray()
            for block in response.iter_content(65536):
                raw.extend(block)
                if len(raw)>MIRROR_MAX_BYTES:raise LgError('복제 사진 크기를 확인할 수 없습니다.','mirror_unavailable',502)
            result=bytes(raw)
            if not result.startswith((b'\xff\xd8\xff',b'\x89PNG\r\n\x1a\n')):
                raise LgError('복제 사진 형식을 확인할 수 없습니다.','mirror_unavailable',502)
            return result
    except requests.RequestException:raise LgError('복제 사진을 읽지 못했습니다.','mirror_unavailable',502)
