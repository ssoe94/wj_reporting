import os, time
import requests
from django.core.cache import cache
from decouple import config

MES_BASE_URL = os.getenv('MES_API_BASE', 'https://v3-ali.blacklake.cn')

TOKEN_ENDPOINT = '/api/openapi/domain/api/v1/access_token/_get_access_token'
APP_KEY = os.getenv('MES_APP_KEY') or config('MES_APP_KEY', default='')
APP_SECRET = os.getenv('MES_APP_SECRET') or config('MES_APP_SECRET', default='')
ACCESS_TOKEN_ENV = os.getenv('MES_ACCESS_TOKEN') or config('MES_ACCESS_TOKEN', default='')

TOKEN_CACHE_KEY = 'mes_access_token'
TOKEN_EXPIRES_KEY = 'mes_access_token_expires'

INVENTORY_ENDPOINT = '/api/openapi/domain/web/v1/route/inventory/open/v1/material_inventory/_list'


def fetch_new_token() -> str:
    """Call auth endpoint to get new access token. Adjust URL/params as per MES docs."""
    url = f"{MES_BASE_URL}{TOKEN_ENDPOINT}"
    resp = requests.post(url, json={
        'appKey': APP_KEY,
        'appSecret': APP_SECRET,
    }, timeout=30)
    resp.raise_for_status()
    data = resp.json().get('data', {})
    token = data.get('appAccessToken')
    expires_in = data.get('expiresIn', 3600)
    cache.set(TOKEN_CACHE_KEY, token, timeout=expires_in - 60)
    cache.set(TOKEN_EXPIRES_KEY, int(time.time()) + expires_in)
    return token


def get_access_token(force_refresh: bool = False) -> str:
    if ACCESS_TOKEN_ENV and not force_refresh:
        return ACCESS_TOKEN_ENV

    token = cache.get(TOKEN_CACHE_KEY)
    expires = cache.get(TOKEN_EXPIRES_KEY)
    if force_refresh or not token or (expires and expires - time.time() < 120):
        token = fetch_new_token()
    return token


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
                token = fetch_new_token()
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