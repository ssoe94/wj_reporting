"""Cloudinary Signed Upload 유틸리티."""

from __future__ import annotations

import hmac
import logging
import threading
import time
from typing import Dict

import cloudinary.api
from django.conf import settings
from cloudinary.utils import api_sign_request

logger = logging.getLogger(__name__)


# This preset is an operational security boundary, not a client preference.
# It must remain signed-only.  Cloudinary does not expose a persisted
# ``max_file_size`` setting for this signed preset, so the 10 MB limit is
# enforced by the workbook scanner/manifest validator and confirmed against
# Cloudinary's authoritative byte count before a report is created.
QUALITY_IMPORT_DIRECT_UPLOAD_PRESET = 'wj-quality-import-browser-direct-v1'
QUALITY_IMPORT_DIRECT_PRESET_CACHE_SECONDS = 300
QUALITY_IMPORT_DIRECT_PRESET_API_TIMEOUT_SECONDS = 10
_direct_preset_cache: dict[str, float] = {}
_direct_preset_lock = threading.Lock()


def _cloudinary_credentials() -> tuple[str, str, str]:
    config = getattr(settings, 'CLOUDINARY_STORAGE', {}) or {}
    cloud_name = str(config.get('CLOUD_NAME') or '')
    api_key = str(config.get('API_KEY') or '')
    api_secret = str(config.get('API_SECRET') or '')
    if not all((cloud_name, api_key, api_secret)):
        raise ValueError('Cloudinary image storage is not configured.')
    return cloud_name, api_key, api_secret


def clear_quality_import_direct_preset_cache() -> None:
    """Clear the short-lived preset verification cache (primarily for tests)."""

    with _direct_preset_lock:
        _direct_preset_cache.clear()


def _verify_quality_import_direct_preset(
    *,
    cloud_name: str,
    api_key: str,
    api_secret: str,
) -> None:
    """Fail closed unless Cloudinary confirms the dedicated signed preset."""

    now = time.monotonic()
    with _direct_preset_lock:
        if _direct_preset_cache.get(cloud_name, 0) > now:
            return
        try:
            preset = cloudinary.api.upload_preset(
                QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
                cloud_name=cloud_name,
                api_key=api_key,
                api_secret=api_secret,
                timeout=QUALITY_IMPORT_DIRECT_PRESET_API_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                'Cloudinary quality-import preset verification failed type=%s',
                type(exc).__name__,
            )
            raise ValueError('Cloudinary quality-import upload preset is unavailable.') from exc

        if (
            not isinstance(preset, dict)
            or preset.get('name') != QUALITY_IMPORT_DIRECT_UPLOAD_PRESET
            or preset.get('unsigned') is not False
        ):
            raise ValueError('Cloudinary quality-import upload preset is unsafe.')
        _direct_preset_cache[cloud_name] = now + QUALITY_IMPORT_DIRECT_PRESET_CACHE_SECONDS


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


def get_direct_upload_params(public_id: str, *, allowed_formats: str) -> Dict[str, object]:
    """Issue narrowly scoped parameters for one immutable browser upload.

    The caller never chooses a folder, preset, or transformation.  ``public_id``
    is generated from a server-validated image digest by the quality import
    service, and ``overwrite=false`` prevents a retry from replacing an object
    that has already been accepted.
    """

    cloud_name, api_key, api_secret = _cloudinary_credentials()
    _verify_quality_import_direct_preset(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
    )
    timestamp = int(time.time())
    signed_params: Dict[str, object] = {
        'allowed_formats': allowed_formats,
        'overwrite': 'false',
        'public_id': public_id,
        'timestamp': timestamp,
        'unique_filename': 'false',
        'upload_preset': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
    }
    signature = api_sign_request(signed_params, api_secret)
    return {
        'cloud_name': cloud_name,
        'api_key': api_key,
        'timestamp': timestamp,
        'signature': signature,
        'public_id': public_id,
        'allowed_formats': allowed_formats,
        'overwrite': False,
        'unique_filename': False,
        'upload_preset': QUALITY_IMPORT_DIRECT_UPLOAD_PRESET,
    }


def verify_direct_upload_response(
    *,
    public_id: str,
    version: int,
    signature: str,
) -> bool:
    """Verify the signed ``public_id``/``version`` Cloudinary response pair."""

    _, _, api_secret = _cloudinary_credentials()
    expected = api_sign_request(
        {'public_id': public_id, 'version': version},
        api_secret,
    )
    return bool(signature) and hmac.compare_digest(expected, signature)
