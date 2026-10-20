"""Private media in the existing configured Cloudinary account; local only in tests/dev."""
import hashlib
import io
import time
from pathlib import Path
import cloudinary.uploader
import cloudinary.utils
import requests
from PIL import Image,ImageOps,UnidentifiedImageError
from django.conf import settings
from django.core.cache import cache
from .client import LgError

MAX_BYTES=3*1024*1024

def thumbnail(raw):
    if not raw:return raw
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width*source.height>24_000_000:raise ValueError()
            image=ImageOps.exif_transpose(source).convert('RGB');image.thumbnail((420,420))
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
