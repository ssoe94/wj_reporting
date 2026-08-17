from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage
from cloudinary_storage.storage import MediaCloudinaryStorage
from django.utils.deconstruct import deconstructible
import cloudinary
import cloudinary.uploader
import requests


QUALITY_MEDIA_MAX_BYTES = 10_000_000
QUALITY_STORAGE_TIMEOUT = (5, 45)
QUALITY_STORAGE_MUTATION_TIMEOUT = 60


class _BoundedCloudinaryReadMixin:
    """Replace django-cloudinary-storage's unbounded HTTP reads/checks."""

    max_download_bytes = QUALITY_MEDIA_MAX_BYTES

    def _open(self, name, mode='rb'):
        response = requests.get(
            self._get_url(name),
            stream=True,
            timeout=QUALITY_STORAGE_TIMEOUT,
        )
        try:
            if response.status_code == 404:
                raise IOError(f'Cloudinary object is missing: {name}')
            response.raise_for_status()
            content_length = response.headers.get('content-length')
            if content_length:
                try:
                    declared_size = int(content_length)
                except (TypeError, ValueError) as exc:
                    raise IOError(f'Cloudinary object has an invalid byte length: {name}') from exc
                if declared_size < 0 or declared_size > self.max_download_bytes:
                    raise IOError(f'Cloudinary object exceeds its safe byte limit: {name}')
            payload = bytearray()
            for block in response.iter_content(chunk_size=1024 * 1024):
                if not block:
                    continue
                payload.extend(block)
                if len(payload) > self.max_download_bytes:
                    raise IOError(f'Cloudinary object exceeds its safe byte limit: {name}')
        finally:
            response.close()
        file = ContentFile(bytes(payload))
        file.name = name
        file.mode = mode
        return file

    def exists(self, name):
        response = requests.head(self._get_url(name), timeout=QUALITY_STORAGE_TIMEOUT)
        try:
            if response.status_code == 404:
                return False
            response.raise_for_status()
            return True
        finally:
            response.close()


@deconstructible
class ContentAddressedImageCloudinaryStorage(_BoundedCloudinaryReadMixin, MediaCloudinaryStorage):
    """Immutable image storage keyed by the caller-provided SHA path."""

    def _upload(self, name, content):
        return cloudinary.uploader.upload(
            content,
            public_id=name,
            resource_type='image',
            overwrite=False,
            unique_filename=False,
            timeout=QUALITY_STORAGE_MUTATION_TIMEOUT,
        )

    def delete(self, name):
        name = self._prepend_prefix(name)
        response = cloudinary.uploader.destroy(
            name,
            invalidate=True,
            resource_type='image',
            timeout=QUALITY_STORAGE_MUTATION_TIMEOUT,
        )
        return response.get('result') in {'ok', 'not found'}


def quality_import_media_storage():
    """Use the existing Cloudinary media store in deployment, local media in dev.

    Django 5.2 no longer honors the legacy ``DEFAULT_FILE_STORAGE`` setting used
    by this project, so the import model must select the already-configured
    backend explicitly.  This reads existing settings only; it adds no secret or
    deployment configuration.
    """

    config = getattr(settings, 'CLOUDINARY_STORAGE', {}) or {}
    if all(config.get(key) for key in ('CLOUD_NAME', 'API_KEY', 'API_SECRET')):
        return ContentAddressedImageCloudinaryStorage()
    return FileSystemStorage(location=settings.MEDIA_ROOT, base_url=settings.MEDIA_URL)


def quality_import_media_upload_available() -> bool:
    """Fail closed in production instead of writing images to ephemeral disk."""

    config = getattr(settings, 'CLOUDINARY_STORAGE', {}) or {}
    if all(config.get(key) for key in ('CLOUD_NAME', 'API_KEY', 'API_SECRET')):
        return True
    return bool(
        getattr(settings, 'DEBUG', False)
        or getattr(settings, 'QUALITY_IMPORT_ALLOW_LOCAL_PROXY', False)
    )
