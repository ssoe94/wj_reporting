import os, time
import requests
from django.core.cache import cache
from decouple import config

MES_BASE_URL = os.getenv('MES_API_BASE', 'https://v3-ali.blacklake.cn')
MES_ROUTE_BASE = '/api/openapi/domain/web/v1/route'

# 앱 토큰 엔드포인트 (기존)
APP_TOKEN_ENDPOINT = '/api/openapi/domain/api/v1/access_token/_get_access_token'
# 사용자 토큰 엔드포인트 (새로 추가)
USER_TOKEN_ENDPOINT = f'{MES_ROUTE_BASE}/openapi/open/v1/access_token/_get_user_token'

APP_KEY = os.getenv('MES_APP_KEY') or config('MES_APP_KEY', default='')
APP_SECRET = os.getenv('MES_APP_SECRET') or config('MES_APP_SECRET', default='')
ACCESS_TOKEN_ENV = os.getenv('MES_ACCESS_TOKEN') or config('MES_ACCESS_TOKEN', default='')
USER_CODE = os.getenv('MES_USER_CODE') or config('MES_USER_CODE', default='')  # 예약 승인 코드

APP_TOKEN_CACHE_KEY = 'mes_app_access_token'
USER_TOKEN_CACHE_KEY = 'mes_user_access_token'
TOKEN_EXPIRES_KEY = 'mes_token_expires'

INVENTORY_ENDPOINT = f'{MES_ROUTE_BASE}/inventory/open/v1/material_inventory/_list'


def fetch_app_token() -> str:
    """1단계: 앱 액세스 토큰 가져오기"""
    url = f"{MES_BASE_URL}{APP_TOKEN_ENDPOINT}"
    resp = requests.post(url, json={
        'appKey': APP_KEY,
        'appSecret': APP_SECRET,
    }, timeout=30)
    resp.raise_for_status()
    
    result = resp.json()
    if result.get('code') != 200:
        raise Exception(f"App token error: {result.get('message', 'Unknown error')}")
    
    data = result.get('data', {})
    token = data.get('appAccessToken')
    expires_in = data.get('expiresIn', 3600)
    
    cache.set(APP_TOKEN_CACHE_KEY, token, timeout=expires_in - 60)
    cache.set(TOKEN_EXPIRES_KEY, int(time.time()) + expires_in)
    return token


def fetch_user_token(app_token: str) -> str:
    """2단계: 사용자 액세스 토큰 가져오기"""
    if not USER_CODE:
        # USER_CODE가 없으면 앱 토큰을 그대로 사용
        return app_token
    
    url = f"{MES_BASE_URL}{USER_TOKEN_ENDPOINT}?access_token={app_token}"
    resp = requests.post(url, json={
        'code': USER_CODE,
        'grantType': 'authorization_code'
    }, timeout=30)
    resp.raise_for_status()
    
    result = resp.json()
    if result.get('code') != 200:
        raise Exception(f"User token error: {result.get('message', 'Unknown error')}")
    
    data = result.get('data', {})
    user_token = data.get('userAccessToken')
    if user_token:
        cache.set(USER_TOKEN_CACHE_KEY, user_token, timeout=3600 - 60)
        return user_token
    else:
        # 사용자 토큰이 없으면 앱 토큰 사용
        return app_token


def get_access_token(force_refresh: bool = False) -> str:
    """최종 액세스 토큰 가져오기 (환경변수 > 사용자토큰 > 앱토큰 순서)"""
    if ACCESS_TOKEN_ENV and not force_refresh:
        return ACCESS_TOKEN_ENV

    # 사용자 토큰 확인
    user_token = cache.get(USER_TOKEN_CACHE_KEY)
    app_token = cache.get(APP_TOKEN_CACHE_KEY)
    expires = cache.get(TOKEN_EXPIRES_KEY)
    
    # 토큰 갱신이 필요한 경우
    if force_refresh or not app_token or (expires and expires - time.time() < 120):
        app_token = fetch_app_token()
        user_token = fetch_user_token(app_token)
    elif not user_token and USER_CODE:
        # 앱 토큰은 있지만 사용자 토큰이 없는 경우
        user_token = fetch_user_token(app_token)
    
    # 사용자 토큰이 있으면 사용자 토큰, 없으면 앱 토큰 반환
    return user_token if user_token else app_token


def call_inventory_list(page:int=1, size:int=200, **filters):
    token = get_access_token()
    url = f"{MES_BASE_URL}{INVENTORY_ENDPOINT}?access_token={token}"
    body = {
        'page': page,
        'size': size,
        **filters
    }
    
    # 재시도 로직 (최대 3번)
    for attempt in range(3):
        try:
            resp = requests.post(url, json=body, timeout=120)  # 타임아웃 120초로 증가
            if resp.status_code == 401:
                # token expired -> refresh once
                token = get_access_token(force_refresh=True)
                url = f"{MES_BASE_URL}{INVENTORY_ENDPOINT}?access_token={token}"
                resp = requests.post(url, json=body, timeout=120)
            
            resp.raise_for_status()
            response_data = resp.json()
            
            # 응답 데이터 검증
            if not response_data:
                print(f'MES inventory list: Empty response for page {page}')
                return None
                
            # MES API에서 에러 응답 확인
            if response_data.get('code') != 200:
                error_msg = response_data.get('message', 'Unknown MES API error')
                print(f'MES inventory list: API error for page {page}: {error_msg}')
                raise Exception(f'MES API error: {error_msg}')
                
            return response_data
        except Exception as e:
            if attempt == 2:  # 마지막 시도
                print(f'MES inventory list error (page {page}):', resp.status_code if 'resp' in locals() else 'No response', str(e))
                raise
            else:
                print(f'Retry {attempt + 1}/3 for page {page}: {str(e)}')
                time.sleep(2)  # 2초 대기 후 재시도 