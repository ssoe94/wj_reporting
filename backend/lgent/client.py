"""Fixed X-View 1.6.72 contract, recovered and verified against the supplied APK."""
import base64
import datetime as dt
import hashlib
import json
import re
from urllib.parse import quote,urlsplit
import requests
from django.utils import timezone

BASE='https://dx-view.lg.com.cn:8000'
ORG='ENT'
SUPPLIER='TT094'
MENU='MNU_M_CART_MANAGECARTGRADE'
TZ=dt.timezone(dt.timedelta(hours=8))
ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$')
BASELINE_FIELDS=('com_code','org_code','trolley_id','supplier_id','last_item_id','last_grade','problem','memo','pic_url','update_user_id')

class LgError(Exception):
    def __init__(self,message,code='lg_unavailable',status=502):
        super().__init__(message);self.code=code;self.status=status


def request(path,token='',payload=None):
    headers={'Accept':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    try:
        response=requests.request('POST' if payload is not None else 'GET',BASE+'/api'+path,
                                  headers=headers,json=payload,timeout=(5,18),allow_redirects=False)
    except requests.RequestException:
        raise LgError('LG 서버 응답을 받지 못했습니다.')
    if response.status_code in (401,403):
        raise LgError('LG 로그인이 만료됐거나 조회 권한이 없습니다. 다시 연결하세요.','lg_connection_required',409)
    if response.status_code!=200 or len(response.content)>4*1024*1024:
        raise LgError('LG 요청을 완료하지 못했습니다.')
    try:return response.json()
    except ValueError:raise LgError('LG 응답 형식을 확인할 수 없습니다.')


def rows(value):
    for _ in range(3):
        if isinstance(value,str):
            try:value=json.loads(value);continue
            except ValueError:break
        if isinstance(value,list):return [x for x in value if isinstance(x,dict)]
        if isinstance(value,dict):
            for key in ('data','rows','value','result','Table'):
                if isinstance(value.get(key),(str,list)):
                    value=value[key];break
            else:return [value]
            continue
        break
    return []


def code(value):
    if not isinstance(value,str) or not ID.fullmatch(value):raise LgError('대차 번호 형식을 확인하세요.','invalid_id',400)
    return quote(value,safe='')


def info(token,trolley_id):
    result=rows(request('/cart/info/LGETA/X/'+code(trolley_id),token))
    if not result or str(result[0].get('trolley_id',''))!=trolley_id:
        raise LgError('대차 번호를 찾지 못했습니다.','cart_not_found',404)
    row=result[0]
    if row.get('supplier_id')!=SUPPLIER or row.get('com_code') not in ('LGENT','LGETA'):
        raise LgError('万佳(TT094) 대차가 아닙니다.','foreign_supplier',403)
    if not row.get('org_code'):
        raise LgError('LG 사업장 정보를 확인할 수 없습니다.','invalid_org',403)
    return row


def photo(token,row):
    encoded=row.get('file_stream_bytes')
    if isinstance(encoded,str) and encoded and len(encoded)<=7*1024*1024:
        try:
            raw=base64.b64decode(encoded,validate=True)
            if raw.startswith(b'\xff\xd8\xff') or raw.startswith(b'\x89PNG\r\n\x1a\n'):return raw
        except ValueError:pass
    path=row.get('pic_url') or ''
    parsed=urlsplit(path)
    if parsed.netloc and (parsed.hostname not in ('dx-view.lg.com.cn','156.147.197.20') or parsed.port not in (None,8000)):
        raise LgError('등록 사진 주소를 확인할 수 없습니다.')
    if not parsed.path:return b''
    if not parsed.path.startswith('/') or parsed.path.startswith('//') or '..' in parsed.path or parsed.query:
        raise LgError('등록 사진 주소 형식이 올바르지 않습니다.')
    try:
        response=requests.get(BASE+quote(parsed.path,safe='/%:@-_.~'),headers={'Authorization':'Bearer '+token},
                              timeout=(5,18),allow_redirects=False,stream=True)
        if response.status_code!=200:raise LgError('LG 사진을 읽지 못했습니다.')
        data=bytearray()
        for block in response.iter_content(65536):
            data.extend(block)
            if len(data)>5*1024*1024:raise LgError('LG 사진 크기가 너무 큽니다.')
        raw=bytes(data)
        if not raw.startswith((b'\xff\xd8\xff',b'\x89PNG\r\n\x1a\n')):raise LgError('LG 사진 형식을 확인할 수 없습니다.')
        return raw
    except requests.RequestException:raise LgError('LG 사진 응답을 받지 못했습니다.')
    finally:
        if 'response' in locals():response.close()


def fingerprint(row):
    return hashlib.sha256(json.dumps({key:row.get(key) for key in BASELINE_FIELDS},sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def photo_file_at(path):
    match=re.search(r'/trolley_grade_management/[^?#]+/(\d{14})\d*\.(?:jpe?g|png)$',path,re.I)
    if not match:return None
    try:
        stamp=dt.datetime.strptime(match[1],'%Y%m%d%H%M%S').replace(tzinfo=TZ)
        return stamp if dt.datetime(2015,1,1,tzinfo=TZ)<=stamp<=timezone.now()+dt.timedelta(days=1) else None
    except ValueError:return None


def modified_at(row):
    for key in ('update_time','updated_at','updateTime','update_date','modify_time','modified_at','last_update_time'):
        value=row.get(key)
        if not value:continue
        try:
            stamp=dt.datetime.fromisoformat(str(value).replace('Z','+00:00'))
            return stamp.replace(tzinfo=TZ) if stamp.tzinfo is None else stamp
        except ValueError:continue
    return None
