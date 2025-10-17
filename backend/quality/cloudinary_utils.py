"""Cloudinary Signed Upload 유틸리티."""

from __future__ import annotations

import time
import logging
from typing import Dict

from django.conf import settings
from cloudinary.utils import api_sign_request

logger = logging.getLogger(__name__)


def get_upload_params(folder: str = 'quality') -> Dict[str, object]:
    """Signed preset 업로드용 파라미터를 생성한다."""

    upload_preset = 'wj-reporting'

    cloud_name = settings.CLOUDINARY_STORAGE.get('CLOUD_NAME')
    api_key = settings.CLOUDINARY_STORAGE.get('API_KEY')
    api_secret = settings.CLOUDINARY_STORAGE.get('API_SECRET')

    logger.info(f"Cloudinary config - cloud_name: '{cloud_name}', api_key: '{api_key}', api_secret: {'*' * len(api_secret) if api_secret else 'None'}")
    logger.debug(f"Cloudinary config check - cloud_name: {bool(cloud_name)}, api_key: {bool(api_key)}, api_secret: {bool(api_secret)}")

    if not all([cloud_name, api_key, api_secret]):
        missing = []
        if not cloud_name:
            missing.append('CLOUDINARY_CLOUD_NAME')
        if not api_key:
            missing.append('CLOUDINARY_API_KEY')
        if not api_secret:
            missing.append('CLOUDINARY_API_SECRET')
        error_msg = f'Cloudinary 환경 변수가 설정되지 않았습니다: {", ".join(missing)}'
        logger.error(error_msg)
        raise ValueError(error_msg)

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
