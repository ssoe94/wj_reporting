"""Cloudinary Signed Upload 유틸리티."""

from __future__ import annotations

import time
from typing import Dict

from django.conf import settings
from cloudinary.utils import api_sign_request


def get_upload_params(folder: str = 'quality') -> Dict[str, object]:
    """Signed preset 업로드용 파라미터를 생성한다."""

    upload_preset = 'wj-reporting'

    cloud_name = settings.CLOUDINARY_STORAGE.get('CLOUD_NAME')
    api_key = settings.CLOUDINARY_STORAGE.get('API_KEY')
    api_secret = settings.CLOUDINARY_STORAGE.get('API_SECRET')

    if not all([cloud_name, api_key, api_secret]):
        raise ValueError('Cloudinary 설정이 올바르지 않습니다. 환경변수를 확인하세요.')

    timestamp = int(time.time())

    params_to_sign: Dict[str, str] = {
        'timestamp': str(timestamp),
        'upload_preset': upload_preset,
    }
    if folder:
        params_to_sign['folder'] = folder

    signature = api_sign_request(params_to_sign, api_secret)

    response: Dict[str, object] = {
        'cloud_name': cloud_name,
        'api_key': api_key,
        'upload_preset': upload_preset,
        'timestamp': timestamp,
        'signature': signature,
    }

    if folder:
        response['folder'] = folder

    return response
