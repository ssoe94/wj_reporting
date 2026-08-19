"""Browser-to-Cloudinary delivery for incremental quality imports.

The workbook manifest remains server-authoritative, while image bytes travel
directly from the authenticated editor's browser to an immutable, server-chosen
Cloudinary public ID.  Reports are created only after Cloudinary's signed
response and authoritative asset metadata have both been checked.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import date, timedelta
from typing import Any

import cloudinary.api
import cloudinary.uploader
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from .cloudinary_utils import get_direct_upload_params, verify_direct_upload_response
from .excel_import import (
    MAX_IMAGE_PIXELS,
    REMOTE_VERIFICATION_TTL,
    WorkbookValidationError,
    _finish_batch,
    _lock_staging_capacity,
)
from .incremental_import import (
    INCREMENTAL_JOB_DATASET_KEY,
    MAX_COMMIT_MEDIA_BYTES,
    MAX_COMMIT_MEDIA_ITEMS,
    MAX_COMMIT_ROWS,
    _classify,
    _decision_row,
    _ensure_monthly_direct_scope,
    _incremental_job_scope_key,
    _manifest_error,
    _quality_import_row_values,
    _record_media_baselines,
    _unlinked_media_count,
    _validate_manifest,
    finalize_quality_import_job,
    serialize_quality_import_job,
    stable_source_key,
)
from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportMedia,
    QualityImportProvenance,
    QualityImportRow,
    QualityReport,
)
from .storage import QUALITY_STORAGE_MUTATION_TIMEOUT


DIRECT_DELIVERY_MODE = 'browser_direct'
DIRECT_UPLOAD_VERSION = 'cloudinary-direct-v1'
DIRECT_UPLOAD_PREFIX = 'quality-import/assets/'
DIRECT_UPLOAD_DATA_VERSION = 1
DIRECT_FINALIZE_LEASE = timedelta(minutes=2)
DIRECT_STAGING_LEASE = timedelta(hours=1)
DIRECT_CLOUDINARY_TIMEOUT_SECONDS = 10
DIRECT_PUBLIC_ID_NONCE_LENGTH = 24
LOGGER = logging.getLogger(__name__)

_REMOTE_FORMAT_ALIASES = {
    'jpeg': 'jpg',
    'jpe': 'jpg',
    'tif': 'tiff',
}
_EXPECTED_REMOTE_FORMATS = {
    'image/png': {'png'},
    'image/jpeg': {'jpg', 'jpeg'},
    'image/gif': {'gif'},
    'image/bmp': {'bmp'},
    'image/tiff': {'tif', 'tiff'},
    'image/webp': {'webp'},
}
_ALLOWED_UPLOAD_FORMATS = {
    'image/png': 'png',
    'image/jpeg': 'jpg,jpeg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tif,tiff',
    'image/webp': 'webp',
}
_REPORT_IMAGE_FIELDS = ('image1', 'image2', 'image3', 'image4', 'image5')


def _prepend_storage_prefix(storage_key: str) -> str:
    storage = QualityImportAsset._meta.get_field('file').storage
    prepend_prefix = getattr(storage, '_prepend_prefix', None)
    if callable(prepend_prefix):
        return str(prepend_prefix(storage_key)).lstrip('/')
    return storage_key


def _new_public_id(batch_id: int, source_sha256: str) -> str:
    nonce = uuid.uuid4().hex[:DIRECT_PUBLIC_ID_NONCE_LENGTH]
    return _prepend_storage_prefix(
        f'quality-import/pending/{batch_id}/{source_sha256}-{nonce}'
    )


def _valid_public_id(batch_id: int, source_sha256: str, public_id: str) -> bool:
    prefix = _prepend_storage_prefix(f'quality-import/pending/{batch_id}/')
    return re.fullmatch(
        re.escape(f'{prefix}{source_sha256}-') + rf'[0-9a-f]{{{DIRECT_PUBLIC_ID_NONCE_LENGTH}}}',
        public_id,
    ) is not None


def _direct_summary(batch: QualityImportBatch) -> dict[str, Any] | None:
    summary = batch.delta_summary or {}
    direct = summary.get('direct_upload')
    if summary.get('delivery_mode') != DIRECT_DELIVERY_MODE or not isinstance(direct, dict):
        return None
    if direct.get('version') != DIRECT_UPLOAD_DATA_VERSION:
        return None
    assets = direct.get('assets')
    if not isinstance(assets, dict):
        return None
    return direct


def _direct_lease_expired(batch: QualityImportBatch, *, now=None) -> bool:
    now = now or timezone.now()
    return batch.lease_expires_at is None or batch.lease_expires_at <= now


def _browser_direct_scope_key(selected_row_keys: set[str]) -> str:
    """Keep browser delivery checkpoints separate from legacy worker jobs."""

    incremental_key = _incremental_job_scope_key(selected_row_keys)
    return f'bdi:{incremental_key.removeprefix("inc:")}'


def _asset_remote_fresh(asset: QualityImportAsset, *, now=None) -> bool:
    now = now or timezone.now()
    return bool(
        asset.upload_state == QualityImportAsset.UploadState.READY
        and asset.file
        and asset.remote_verified_at
        and asset.remote_verified_at >= now - REMOTE_VERIFICATION_TTL
    )


def _ready_asset_sha256s(batch: QualityImportBatch) -> set[str]:
    verification_cutoff = timezone.now() - REMOTE_VERIFICATION_TTL
    return set(
        QualityImportAsset.objects.filter(
            attachments__batch=batch,
            upload_state=QualityImportAsset.UploadState.READY,
            remote_verified_at__gte=verification_cutoff,
        )
        .exclude(file='')
        .values_list('sha256', flat=True)
        .distinct()
    )


def _rotate_unresolved_targets(batch: QualityImportBatch) -> list[str]:
    direct = _direct_summary(batch)
    if direct is None:
        raise _manifest_error('invalid_job', 'The batch is not a browser-direct upload job.')
    ready_sha256s = _ready_asset_sha256s(batch)
    assets = {
        source_sha256: dict(metadata)
        for source_sha256, metadata in direct['assets'].items()
        if isinstance(metadata, dict)
    }
    retired_public_ids: list[str] = []
    for source_sha256, metadata in assets.items():
        if source_sha256 not in ready_sha256s:
            old_public_id = str(metadata.get('public_id') or '')
            if _valid_public_id(batch.pk, source_sha256, old_public_id):
                retired_public_ids.append(old_public_id)
            metadata['public_id'] = _new_public_id(batch.pk, source_sha256)
    summary = dict(batch.delta_summary or {})
    summary['direct_upload'] = {**direct, 'assets': assets}
    batch.delta_summary = summary
    return retired_public_ids


def _resume_existing_direct_batch(batch_id: int, *, uploaded_by) -> QualityImportBatch:
    """Renew or safely reclaim an idempotent browser-direct checkpoint."""

    retired_public_ids: list[str] = []
    with transaction.atomic():
        _lock_staging_capacity()
        batch = QualityImportBatch.objects.select_for_update().select_related('uploaded_by').get(
            pk=batch_id,
        )
        if _direct_summary(batch) is None:
            raise _manifest_error(
                'job_delivery_conflict',
                'This workbook scope is already being processed by another upload method.',
            )
        if batch.status in {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        }:
            return batch

        now = timezone.now()
        expired = _direct_lease_expired(batch, now=now)
        same_owner = batch.uploaded_by_id == getattr(uploaded_by, 'pk', None)
        if batch.status == QualityImportBatch.Status.PROCESSING and not expired:
            raise _manifest_error('job_busy', 'The upload job is already being finalized.')
        if not same_owner and not getattr(uploaded_by, 'is_staff', False) and not expired:
            raise _manifest_error(
                'job_owner_mismatch',
                'This upload is still reserved by the user who prepared it.',
            )
        if batch.status not in {
            QualityImportBatch.Status.STAGING,
            QualityImportBatch.Status.PROCESSING,
            QualityImportBatch.Status.FAILED,
        }:
            raise _manifest_error(
                'job_delivery_conflict',
                'This workbook scope is already being processed by another upload method.',
            )

        reclaim = expired or batch.status != QualityImportBatch.Status.STAGING or not same_owner
        if reclaim:
            retired_public_ids = _rotate_unresolved_targets(batch)
        verification_cutoff = now - REMOTE_VERIFICATION_TTL
        pending = (
            batch.media.filter(asset__isnull=False).exclude(
                asset__upload_state=QualityImportAsset.UploadState.READY,
            ).exists()
            or batch.media.filter(asset__isnull=False, asset__file='').exists()
            or batch.media.filter(asset__isnull=False).exclude(
                asset__remote_verified_at__gte=verification_cutoff,
            ).exists()
        )
        batch.uploaded_by = uploaded_by
        batch.status = QualityImportBatch.Status.STAGING
        batch.phase = 'awaiting_browser_upload' if pending else 'ready_to_finalize'
        batch.processing_owner = ''
        batch.lease_expires_at = now + DIRECT_STAGING_LEASE
        batch.next_attempt_at = None
        batch.last_heartbeat_at = now
        update_fields = [
            'uploaded_by', 'status', 'phase', 'processing_owner',
            'lease_expires_at', 'next_attempt_at', 'last_heartbeat_at', 'updated_at',
        ]
        if reclaim:
            update_fields.append('delta_summary')
        batch.save(update_fields=update_fields)
        if retired_public_ids:
            transaction.on_commit(
                lambda public_ids=tuple(retired_public_ids):
                destroy_browser_direct_pending_uploads(public_ids)
            )
    return QualityImportBatch.objects.select_related('uploaded_by').get(pk=batch_id)


def _assert_direct_owner(batch: QualityImportBatch, user) -> None:
    if getattr(user, 'is_staff', False):
        return
    if batch.uploaded_by_id != getattr(user, 'pk', None):
        raise _manifest_error(
            'job_owner_mismatch',
            'Only the user who prepared this upload can deliver its images.',
        )


def _selected_decisions(context, selected_row_keys: set[str] | None):
    all_decisions = _classify(context)
    decisions_by_key = {
        stable_source_key(decision.row): decision
        for decision in all_decisions
    }
    selected = set(decisions_by_key) if selected_row_keys is None else set(selected_row_keys)
    if selected - set(decisions_by_key):
        raise _manifest_error(
            'invalid_row_selection',
            'Job references an unknown workbook row.',
        )
    decisions = [
        decision
        for decision in all_decisions
        if stable_source_key(decision.row) in selected
    ]
    if len(decisions) > MAX_COMMIT_ROWS:
        raise _manifest_error(
            'commit_too_large',
            f'Job may contain at most {MAX_COMMIT_ROWS} workbook rows.',
        )
    return all_decisions, decisions, selected


def _required_media(decisions) -> tuple[dict[str, dict[str, Any]], dict[str, list[str]]]:
    by_key: dict[str, dict[str, Any]] = {}
    keys_by_sha: dict[str, list[str]] = {}
    for decision in decisions:
        if decision.status != 'new':
            continue
        for item in decision.selected_media:
            by_key[item['key']] = item
            keys_by_sha.setdefault(item['source_sha256'], []).append(item['key'])
    if len(by_key) > MAX_COMMIT_MEDIA_ITEMS:
        raise _manifest_error(
            'commit_too_large',
            f'Job may contain at most {MAX_COMMIT_MEDIA_ITEMS} images.',
        )
    if sum(int(item['original_byte_size']) for item in by_key.values()) > MAX_COMMIT_MEDIA_BYTES:
        raise _manifest_error(
            'commit_too_large',
            'Selected images exceed the 20 MiB browser upload limit.',
        )
    return by_key, keys_by_sha


def _asset_metadata_matches(asset: QualityImportAsset, item: dict[str, Any]) -> bool:
    return (
        asset.byte_size == int(item['original_byte_size'])
        and asset.content_type == item['content_type']
        and asset.storage_key == f'{DIRECT_UPLOAD_PREFIX}{item["source_sha256"]}'
    )


def _get_or_create_direct_asset(
    *,
    batch: QualityImportBatch,
    item: dict[str, Any],
) -> tuple[QualityImportAsset, bool]:
    source_sha256 = item['source_sha256']
    storage_key = f'{DIRECT_UPLOAD_PREFIX}{source_sha256}'
    asset = QualityImportAsset.objects.select_for_update().filter(sha256=source_sha256).first()
    if asset is None:
        return QualityImportAsset.objects.create(
            sha256=source_sha256,
            normalizer_version=DIRECT_UPLOAD_VERSION,
            byte_size=int(item['original_byte_size']),
            content_type=item['content_type'],
            width=None,
            height=None,
            extension=item['extension'],
            storage_key=storage_key,
            file='',
            staged_bytes=None,
            upload_state=QualityImportAsset.UploadState.STAGED,
            created_by_batch=batch,
        ), True
    if not _asset_metadata_matches(asset, item):
        raise _manifest_error(
            'asset_metadata_mismatch',
            'An existing content-addressed image has conflicting metadata.',
        )
    active_upload = bool(
        asset.upload_state == QualityImportAsset.UploadState.UPLOADING
        and asset.processing_owner
        and asset.lease_expires_at
        and asset.lease_expires_at > timezone.now()
    )
    needs_browser_refresh = not active_upload and (
        asset.upload_state == QualityImportAsset.UploadState.FAILED
        or not _asset_remote_fresh(asset)
    )
    if needs_browser_refresh:
        asset.upload_state = QualityImportAsset.UploadState.STAGED
        asset.processing_owner = ''
        asset.lease_expires_at = None
        asset.next_attempt_at = None
        asset.last_error = ''
        asset.save(update_fields=[
            'upload_state', 'processing_owner', 'lease_expires_at',
            'next_attempt_at', 'last_error',
        ])
    return asset, False


def _prepare_browser_direct_once(
    payload: Any,
    *,
    uploaded_by,
    uploaded_on: date | None,
    selected_row_keys: set[str] | None,
) -> tuple[QualityImportBatch, bool]:
    context = _validate_manifest(payload, uploaded_on=uploaded_on or date.today())
    _ensure_monthly_direct_scope(context)
    all_decisions, decisions, selected = _selected_decisions(context, selected_row_keys)
    required_by_key, keys_by_sha = _required_media(decisions)

    # Validate credentials and the remote signed/size-limited preset before
    # persisting a job that could never issue safe browser upload intents.
    if keys_by_sha:
        try:
            source_sha256 = next(iter(keys_by_sha))
            item = required_by_key[keys_by_sha[source_sha256][0]]
            get_direct_upload_params(
                _new_public_id(0, source_sha256),
                allowed_formats=_ALLOWED_UPLOAD_FORMATS[item['content_type']],
            )
        except ValueError as exc:
            raise _manifest_error(
                'production_storage_required',
                'Cloudinary image storage is required for browser-direct Excel imports.',
            ) from exc

    import_scope_key = _browser_direct_scope_key(selected)
    existing = QualityImportBatch.objects.filter(
        sha256=context.source_sha256,
        import_scope_key=import_scope_key,
    ).first()
    if existing is not None:
        if existing.dataset_key != INCREMENTAL_JOB_DATASET_KEY:
            raise _manifest_error('job_delivery_conflict', 'This workbook scope is already in use.')
        direct = _direct_summary(existing)
        if direct is not None:
            _record_media_baselines(all_decisions)
            return _resume_existing_direct_batch(existing.pk, uploaded_by=uploaded_by), True
        if existing.status in {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        }:
            _record_media_baselines(all_decisions)
            return existing, True
        raise _manifest_error(
            'job_delivery_conflict',
            'This workbook scope is already being processed by the previous upload method.',
        )

    preview_rows = [_decision_row(decision, preview=True) for decision in decisions]
    images_ignored = _unlinked_media_count(context)
    images_ignored += sum(
        max(0, len(decision.media) - len(decision.selected_media))
        for decision in decisions
    )
    images_ignored += sum(
        len(decision.selected_media)
        for decision in decisions
        if decision.status == 'failed'
    )
    now = timezone.now()
    with transaction.atomic():
        _lock_staging_capacity()
        existing = QualityImportBatch.objects.select_for_update().filter(
            sha256=context.source_sha256,
            import_scope_key=import_scope_key,
        ).first()
        if existing is not None:
            if _direct_summary(existing) is None:
                raise _manifest_error(
                    'job_delivery_conflict',
                    'This workbook scope is already being processed by another upload method.',
                )
            _record_media_baselines(all_decisions)
            return _resume_existing_direct_batch(existing.pk, uploaded_by=uploaded_by), True

        batch = QualityImportBatch.objects.create(
            uploaded_by=uploaded_by,
            original_filename=context.filename,
            sha256=context.source_sha256,
            import_scope_key=import_scope_key,
            file_size=context.file_size,
            dataset_key=INCREMENTAL_JOB_DATASET_KEY,
            status=QualityImportBatch.Status.STAGING,
            phase='awaiting_browser_upload' if required_by_key else 'ready_to_finalize',
            lease_expires_at=now + DIRECT_STAGING_LEASE,
            last_heartbeat_at=now,
            sheet_names=context.parsed.sheet_names,
            total_rows=len(decisions),
            total_media=len(required_by_key),
            source_total_rows=len(context.parsed.rows),
            added_count=sum(decision.status == 'new' for decision in decisions),
            changed_count=sum(decision.status == 'changed' for decision in decisions),
            unchanged_count=sum(decision.status == 'unchanged' for decision in decisions),
            warnings=context.parsed.warnings,
            warning_count=(
                len(context.parsed.warnings)
                + sum(len(decision.warnings) for decision in decisions)
            ),
            delta_summary={
                'incremental_preview_rows': preview_rows,
                'incremental_result': None,
                'images_found': len(context.parsed.media),
                'images_ignored': images_ignored,
                'selected_row_keys': sorted(selected),
                'delivery_mode': DIRECT_DELIVERY_MODE,
                'direct_upload': {
                    'version': DIRECT_UPLOAD_DATA_VERSION,
                    'assets': {},
                },
            },
            results_persisted_at=now,
        )
        QualityImportProvenance.objects.create(
            batch=batch,
            source_sha256=context.source_sha256,
            source_content_type='application/vnd.wj.quality-manifest+json',
            source_filename=context.filename,
            source_byte_size=context.file_size,
            parser_name='quality_browser_direct_manifest_v1',
            parser_version='1',
            workbook_properties=context.parsed.properties,
            source_discarded_at=now,
        )

        row_models = {}
        for decision in decisions:
            row_models[stable_source_key(decision.row)] = QualityImportRow.objects.create(
                batch=batch,
                **_quality_import_row_values(decision),
            )

        assets_by_sha: dict[str, QualityImportAsset] = {}
        new_asset_ids: set[int] = set()
        for source_sha256, media_keys in keys_by_sha.items():
            item = required_by_key[media_keys[0]]
            asset, created = _get_or_create_direct_asset(batch=batch, item=item)
            assets_by_sha[source_sha256] = asset
            if created:
                new_asset_ids.add(asset.pk)

        for decision in decisions:
            if decision.status != 'new':
                continue
            row_model = row_models[stable_source_key(decision.row)]
            for item in decision.selected_media:
                asset = assets_by_sha[item['source_sha256']]
                QualityImportMedia.objects.create(
                    batch=batch,
                    row=row_model,
                    asset=asset,
                    source_sheet_name=item['source_sheet_name'],
                    source_anchor_row=item['source_anchor_row'],
                    source_anchor_col=item['source_anchor_col'],
                    source_index=item['source_index'],
                    original_filename=item['original_filename'],
                    source_sha256=item['source_sha256'],
                    source_byte_size=item['original_byte_size'],
                    source_width=asset.width,
                    source_height=asset.height,
                    warnings=item.get('warnings') or [],
                )

        direct_assets = {
            source_sha256: {
                'public_id': _new_public_id(batch.pk, source_sha256),
                'media_keys': sorted(media_keys),
                'source_byte_size': int(required_by_key[media_keys[0]]['original_byte_size']),
                'source_content_type': required_by_key[media_keys[0]]['content_type'],
                'allowed_formats': _ALLOWED_UPLOAD_FORMATS[
                    required_by_key[media_keys[0]]['content_type']
                ],
            }
            for source_sha256, media_keys in keys_by_sha.items()
        }
        summary = dict(batch.delta_summary or {})
        summary['direct_upload']['assets'] = direct_assets
        unique_assets = list(assets_by_sha.values())
        ready_assets = sum(_asset_remote_fresh(asset) for asset in unique_assets)
        batch.delta_summary = summary
        batch.new_media_count = len(new_asset_ids)
        batch.reused_media_count = max(0, len(required_by_key) - len(new_asset_ids))
        batch.progress_done = ready_assets
        batch.progress_total = len(unique_assets)
        if ready_assets == len(unique_assets):
            batch.phase = 'ready_to_finalize'
        batch.save(update_fields=[
            'delta_summary', 'new_media_count', 'reused_media_count',
            'progress_done', 'progress_total', 'phase', 'updated_at',
        ])
        _record_media_baselines(all_decisions)
    return batch, False


def prepare_browser_direct_quality_manifest(
    payload: Any,
    *,
    uploaded_by,
    uploaded_on: date | None = None,
    selected_row_keys: set[str] | None = None,
) -> tuple[QualityImportBatch, bool]:
    """Create or replay one browser-direct chunk without remote image I/O."""

    try:
        return _prepare_browser_direct_once(
            payload,
            uploaded_by=uploaded_by,
            uploaded_on=uploaded_on,
            selected_row_keys=selected_row_keys,
        )
    except IntegrityError:
        return _prepare_browser_direct_once(
            payload,
            uploaded_by=uploaded_by,
            uploaded_on=uploaded_on,
            selected_row_keys=selected_row_keys,
        )


def serialize_browser_direct_job(
    batch: QualityImportBatch,
    *,
    requester,
    include_upload_intents: bool = True,
) -> dict[str, Any]:
    payload = serialize_quality_import_job(batch)
    payload['delivery_mode'] = DIRECT_DELIVERY_MODE
    payload['upload_intents'] = []
    direct = _direct_summary(batch)
    if direct is None or not include_upload_intents:
        return payload
    if batch.status != QualityImportBatch.Status.STAGING:
        return payload
    _assert_direct_owner(batch, requester)
    if _direct_lease_expired(batch):
        raise _manifest_error(
            'job_expired',
            'This browser upload reservation expired. Select the same workbook to resume safely.',
        )

    asset_metadata = direct['assets']
    assets = {
        asset.sha256: asset
        for asset in QualityImportAsset.objects.filter(
            attachments__batch=batch,
            sha256__in=list(asset_metadata),
        ).distinct()
    }
    intents = []
    for source_sha256 in sorted(asset_metadata):
        metadata = asset_metadata[source_sha256]
        asset = assets.get(source_sha256)
        if asset is not None and _asset_remote_fresh(asset):
            continue
        public_id = str(metadata.get('public_id') or '')
        allowed_formats = str(metadata.get('allowed_formats') or '')
        expected_formats = _ALLOWED_UPLOAD_FORMATS.get(
            str(metadata.get('source_content_type') or ''),
        )
        if (
            not _valid_public_id(batch.pk, source_sha256, public_id)
            or not expected_formats
            or allowed_formats != expected_formats
        ):
            raise _manifest_error('invalid_job', 'The upload job contains an invalid asset path.')
        try:
            upload = get_direct_upload_params(
                public_id,
                allowed_formats=allowed_formats,
            )
        except ValueError as exc:
            raise _manifest_error(
                'production_storage_required',
                'Cloudinary image storage is required for browser-direct Excel imports.',
            ) from exc
        intents.append({
            'asset_sha256': source_sha256,
            'media_keys': list(metadata.get('media_keys') or []),
            'source_byte_size': int(metadata.get('source_byte_size') or 0),
            'source_content_type': str(metadata.get('source_content_type') or ''),
            'upload': upload,
        })
    payload['upload_intents'] = intents
    return payload


def _positive_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise _manifest_error('invalid_upload_receipt', f'{field} must be a positive integer.')
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise _manifest_error('invalid_upload_receipt', f'{field} must be a positive integer.') from exc
    if parsed <= 0:
        raise _manifest_error('invalid_upload_receipt', f'{field} must be a positive integer.')
    return parsed


def _verify_remote_resource(
    *,
    asset: QualityImportAsset,
    public_id: str,
    version: int,
) -> tuple[int, int, str]:
    try:
        resource = cloudinary.api.resource(
            public_id,
            resource_type='image',
            type='upload',
            timeout=DIRECT_CLOUDINARY_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        raise _manifest_error(
            'cloudinary_verification_unavailable',
            'Cloudinary has not confirmed this image yet. Retry the confirmation.',
        ) from exc
    if not isinstance(resource, dict):
        raise _manifest_error('remote_asset_mismatch', 'Cloudinary returned invalid asset metadata.')
    remote_version = _positive_int(resource.get('version'), field='remote version')
    if (
        resource.get('public_id') != public_id
        or remote_version != version
        or resource.get('resource_type') != 'image'
        or resource.get('type') != 'upload'
    ):
        raise _manifest_error('remote_asset_mismatch', 'Cloudinary confirmed a different asset.')
    remote_bytes = _positive_int(resource.get('bytes'), field='remote byte size')
    if remote_bytes != asset.byte_size:
        raise _manifest_error('remote_asset_mismatch', 'Cloudinary image size does not match the workbook.')
    width = _positive_int(resource.get('width'), field='remote width')
    height = _positive_int(resource.get('height'), field='remote height')
    if width * height > MAX_IMAGE_PIXELS:
        raise _manifest_error('remote_asset_mismatch', 'Cloudinary image dimensions exceed the safe limit.')
    remote_format = str(resource.get('format') or '').lower()
    accepted_formats = _EXPECTED_REMOTE_FORMATS.get(asset.content_type, set())
    if remote_format not in accepted_formats:
        raise _manifest_error('remote_asset_mismatch', 'Cloudinary image format does not match the workbook.')
    extension = _REMOTE_FORMAT_ALIASES.get(remote_format, remote_format)
    return width, height, extension


def unresolved_browser_direct_public_ids(batch: QualityImportBatch) -> list[str]:
    """Return only job-scoped objects that were never adopted by an asset."""

    direct = _direct_summary(batch)
    if direct is None:
        return []
    adopted_names = {
        asset.sha256: asset.file.name
        for asset in QualityImportAsset.objects.filter(
            attachments__batch=batch,
            upload_state=QualityImportAsset.UploadState.READY,
        ).exclude(file='').distinct()
    }
    unresolved: list[str] = []
    for source_sha256, metadata in direct['assets'].items():
        if not isinstance(metadata, dict):
            continue
        public_id = str(metadata.get('public_id') or '')
        if (
            _valid_public_id(batch.pk, source_sha256, public_id)
            and adopted_names.get(source_sha256) != public_id
        ):
            unresolved.append(public_id)
    return sorted(set(unresolved))


def _unreferenced_pending_public_ids(public_ids) -> list[str]:
    """Exclude current assets and historical report URLs from remote cleanup.

    ``QualityImportAsset.file`` can move to a freshly verified Cloudinary object
    after its verification TTL. Reports deliberately retain the URL that was
    current when they were created, so checking only the asset's latest file
    name can delete an older object that a report still displays.
    """

    candidates = sorted({str(public_id) for public_id in public_ids if public_id})
    if not candidates:
        return []
    protected: set[str] = set()
    try:
        asset_lookup = Q(file__in=candidates)
        for public_id in candidates:
            token = public_id.rsplit('/', 1)[-1]
            asset_lookup |= Q(file__endswith=f'/{token}')
        current_files = QualityImportAsset.objects.filter(asset_lookup).exclude(file='').values_list(
            'file', flat=True
        )
        for file_name in current_files:
            current_token = str(file_name).rsplit('/', 1)[-1]
            protected.update(
                public_id
                for public_id in candidates
                if public_id.rsplit('/', 1)[-1] == current_token
            )

        remaining = [public_id for public_id in candidates if public_id not in protected]
        for offset in range(0, len(remaining), 50):
            chunk = remaining[offset:offset + 50]
            lookup = Q()
            for public_id in chunk:
                token = public_id.rsplit('/', 1)[-1]
                for field_name in _REPORT_IMAGE_FIELDS:
                    lookup |= Q(**{f'{field_name}__contains': token})
            for image_urls in QualityReport.objects.filter(lookup).values_list(
                *_REPORT_IMAGE_FIELDS
            ):
                for public_id in chunk:
                    token = public_id.rsplit('/', 1)[-1]
                    if any(token in str(image_url or '') for image_url in image_urls):
                        protected.add(public_id)
    except Exception:
        LOGGER.exception('Could not verify browser-direct image references; cleanup skipped.')
        return []
    return [public_id for public_id in candidates if public_id not in protected]


def destroy_browser_direct_pending_uploads(public_ids) -> None:
    """Best-effort bulk cleanup after DB state no longer references targets."""

    unique_ids = _unreferenced_pending_public_ids(public_ids)
    for offset in range(0, len(unique_ids), 100):
        chunk = unique_ids[offset:offset + 100]
        try:
            cloudinary.api.delete_resources(
                chunk,
                invalidate=True,
                resource_type='image',
                type='upload',
                timeout=DIRECT_CLOUDINARY_TIMEOUT_SECONDS,
            )
        except Exception:
            LOGGER.exception(
                'Failed to clean %s abandoned browser-direct Cloudinary objects.',
                len(chunk),
            )


def _destroy_pending_upload(public_id: str) -> None:
    """Best-effort cleanup for a verified but rejected job-scoped upload."""

    if not _unreferenced_pending_public_ids([public_id]):
        return

    try:
        cloudinary.uploader.destroy(
            public_id,
            invalidate=True,
            resource_type='image',
            timeout=QUALITY_STORAGE_MUTATION_TIMEOUT,
        )
    except Exception:
        LOGGER.exception('Failed to clean rejected browser-direct asset public_id=%s', public_id)


def _rotate_rejected_target(
    batch_id: int,
    *,
    asset_sha256: str,
    rejected_public_id: str,
) -> None:
    with transaction.atomic():
        batch = QualityImportBatch.objects.select_for_update().get(pk=batch_id)
        direct = _direct_summary(batch)
        if direct is None or batch.status != QualityImportBatch.Status.STAGING:
            return
        metadata = direct['assets'].get(asset_sha256)
        if not isinstance(metadata, dict) or metadata.get('public_id') != rejected_public_id:
            return
        assets = {
            source_sha256: dict(value)
            for source_sha256, value in direct['assets'].items()
            if isinstance(value, dict)
        }
        assets[asset_sha256]['public_id'] = _new_public_id(batch.pk, asset_sha256)
        summary = dict(batch.delta_summary or {})
        summary['direct_upload'] = {**direct, 'assets': assets}
        batch.delta_summary = summary
        batch.lease_expires_at = timezone.now() + DIRECT_STAGING_LEASE
        batch.last_heartbeat_at = timezone.now()
        batch.save(update_fields=[
            'delta_summary', 'lease_expires_at', 'last_heartbeat_at', 'updated_at',
        ])


def _release_verification_claim(asset_id: int, owner: str) -> None:
    QualityImportAsset.objects.filter(
        pk=asset_id,
        upload_state=QualityImportAsset.UploadState.UPLOADING,
        processing_owner=owner,
    ).update(
        upload_state=QualityImportAsset.UploadState.STAGED,
        processing_owner='',
        lease_expires_at=None,
        next_attempt_at=None,
    )


def complete_browser_direct_asset(
    batch_id: int,
    *,
    asset_sha256: str,
    receipt: Any,
    requester,
) -> QualityImportBatch:
    """Verify one Cloudinary receipt and mark the immutable asset ready."""

    batch = QualityImportBatch.objects.select_related('uploaded_by').get(pk=batch_id)
    direct = _direct_summary(batch)
    if direct is None:
        raise _manifest_error('invalid_job', 'The batch is not a browser-direct upload job.')
    _assert_direct_owner(batch, requester)
    metadata = direct['assets'].get(asset_sha256)
    expected_public_id = str(metadata.get('public_id') or '') if isinstance(metadata, dict) else ''
    if not isinstance(metadata, dict) or not _valid_public_id(
        batch.pk,
        asset_sha256,
        expected_public_id,
    ):
        raise _manifest_error('unknown_upload_asset', 'This image is not part of the upload job.')
    if batch.status in {
        QualityImportBatch.Status.READY,
        QualityImportBatch.Status.READY_WITH_WARNINGS,
    }:
        return batch
    if not isinstance(receipt, dict):
        raise _manifest_error('invalid_upload_receipt', 'Upload receipt must be an object.')
    public_id = str(receipt.get('public_id') or '')
    version = _positive_int(receipt.get('version'), field='version')
    signature = str(receipt.get('signature') or '')
    if len(signature) > 256:
        raise _manifest_error('invalid_upload_receipt', 'Upload receipt signature is invalid.')
    if public_id != expected_public_id:
        raise _manifest_error('invalid_upload_receipt', 'Upload receipt public ID does not match the job.')
    try:
        response_valid = verify_direct_upload_response(
            public_id=public_id,
            version=version,
            signature=signature,
        )
    except ValueError as exc:
        raise _manifest_error(
            'production_storage_required',
            'Cloudinary image storage is required for browser-direct Excel imports.',
        ) from exc
    if not response_valid:
        raise _manifest_error('invalid_upload_receipt', 'Cloudinary upload response signature is invalid.')

    asset = QualityImportAsset.objects.filter(
        sha256=asset_sha256,
        attachments__batch=batch,
    ).distinct().first()
    if asset is None:
        raise _manifest_error('unknown_upload_asset', 'This image is not part of the upload job.')

    verification_owner = f'browser-direct-verify:{uuid.uuid4().hex}'
    redundant_public_id = ''
    with transaction.atomic():
        locked_batch = QualityImportBatch.objects.select_for_update().get(pk=batch.pk)
        _assert_direct_owner(locked_batch, requester)
        if locked_batch.status in {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        }:
            return locked_batch
        locked_direct = _direct_summary(locked_batch)
        locked_metadata = (
            locked_direct['assets'].get(asset_sha256)
            if locked_direct is not None
            else None
        )
        if (
            not isinstance(locked_metadata, dict)
            or locked_metadata.get('public_id') != expected_public_id
        ):
            raise _manifest_error(
                'invalid_upload_receipt',
                'The upload target changed. Select the same workbook to resume safely.',
            )
        if (
            locked_batch.status == QualityImportBatch.Status.STAGING
            and _direct_lease_expired(locked_batch)
        ):
            raise _manifest_error(
                'job_expired',
                'This browser upload reservation expired. Select the same workbook to resume safely.',
            )
        if locked_batch.status not in {
            QualityImportBatch.Status.STAGING,
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        }:
            raise _manifest_error('job_busy', 'The upload job is currently being finalized.')
        locked_asset = QualityImportAsset.objects.select_for_update().get(pk=asset.pk)
        if not locked_asset.attachments.filter(batch=locked_batch).exists():
            raise _manifest_error('unknown_upload_asset', 'This image is not part of the upload job.')
        if _asset_remote_fresh(locked_asset):
            if locked_asset.file.name != expected_public_id:
                redundant_public_id = expected_public_id
        else:
            now = timezone.now()
            if (
                locked_asset.upload_state == QualityImportAsset.UploadState.UPLOADING
                and locked_asset.processing_owner
                and locked_asset.processing_owner != verification_owner
                and locked_asset.lease_expires_at
                and locked_asset.lease_expires_at > now
            ):
                raise _manifest_error('job_busy', 'This image is already being confirmed.')
            locked_asset.upload_state = QualityImportAsset.UploadState.UPLOADING
            locked_asset.processing_owner = verification_owner
            locked_asset.lease_expires_at = now + timedelta(minutes=1)
            locked_asset.next_attempt_at = None
            locked_asset.last_error = ''
            locked_asset.save(update_fields=[
                'upload_state', 'processing_owner', 'lease_expires_at',
                'next_attempt_at', 'last_error',
            ])

    if redundant_public_id:
        _destroy_pending_upload(redundant_public_id)
        return QualityImportBatch.objects.get(pk=batch.pk)
    asset.refresh_from_db()
    try:
        width, height, extension = _verify_remote_resource(
            asset=asset,
            public_id=public_id,
            version=version,
        )
    except WorkbookValidationError as exc:
        _release_verification_claim(asset.pk, verification_owner)
        if exc.code != 'cloudinary_verification_unavailable':
            _rotate_rejected_target(
                batch.pk,
                asset_sha256=asset_sha256,
                rejected_public_id=expected_public_id,
            )
            _destroy_pending_upload(expected_public_id)
        raise

    target_changed = False
    terminal_replay = False
    with transaction.atomic():
        locked_batch = QualityImportBatch.objects.select_for_update().get(pk=batch.pk)
        _assert_direct_owner(locked_batch, requester)
        if locked_batch.status in {
            QualityImportBatch.Status.READY,
            QualityImportBatch.Status.READY_WITH_WARNINGS,
        }:
            terminal_replay = True
        else:
            locked_direct = _direct_summary(locked_batch)
            locked_metadata = (
                locked_direct['assets'].get(asset_sha256)
                if locked_direct is not None
                else None
            )
            locked_asset = QualityImportAsset.objects.select_for_update().get(pk=asset.pk)
            if (
                not isinstance(locked_metadata, dict)
                or locked_metadata.get('public_id') != expected_public_id
            ):
                target_changed = True
                if locked_asset.processing_owner == verification_owner:
                    locked_asset.upload_state = QualityImportAsset.UploadState.STAGED
                    locked_asset.processing_owner = ''
                    locked_asset.lease_expires_at = None
                    locked_asset.next_attempt_at = None
                    locked_asset.save(update_fields=[
                        'upload_state', 'processing_owner', 'lease_expires_at',
                        'next_attempt_at',
                    ])
            elif locked_batch.status != QualityImportBatch.Status.STAGING:
                raise _manifest_error('job_busy', 'The upload job is currently being finalized.')
            else:
                if _asset_remote_fresh(locked_asset):
                    if locked_asset.file.name != expected_public_id:
                        redundant_public_id = expected_public_id
                elif locked_asset.processing_owner != verification_owner:
                    raise _manifest_error('job_busy', 'The image confirmation lease was lost.')
                else:
                    locked_asset.width = width
                    locked_asset.height = height
                    locked_asset.extension = extension
                    locked_asset.file = expected_public_id
                    locked_asset.staged_bytes = None
                    locked_asset.upload_state = QualityImportAsset.UploadState.READY
                    locked_asset.processing_owner = ''
                    locked_asset.lease_expires_at = None
                    locked_asset.next_attempt_at = None
                    locked_asset.last_error = ''
                    locked_asset.remote_verified_at = timezone.now()
                    locked_asset.save(update_fields=[
                        'width', 'height', 'extension', 'file', 'staged_bytes',
                        'upload_state', 'processing_owner', 'lease_expires_at',
                        'next_attempt_at', 'last_error', 'remote_verified_at',
                    ])
                    QualityImportMedia.objects.filter(
                        batch=locked_batch,
                        asset=locked_asset,
                    ).update(source_width=width, source_height=height)
                total = locked_batch.media.filter(asset__isnull=False).values('asset_id').distinct().count()
                ready = locked_batch.media.filter(
                    asset__upload_state=QualityImportAsset.UploadState.READY,
                ).exclude(asset__file='').values('asset_id').distinct().count()
                locked_batch.progress_total = total
                locked_batch.progress_done = ready
                locked_batch.phase = 'ready_to_finalize' if ready == total else 'awaiting_browser_upload'
                locked_batch.last_heartbeat_at = timezone.now()
                locked_batch.lease_expires_at = timezone.now() + DIRECT_STAGING_LEASE
                locked_batch.save(update_fields=[
                    'progress_total', 'progress_done', 'phase', 'last_heartbeat_at',
                    'lease_expires_at', 'updated_at',
                ])
    if terminal_replay:
        _release_verification_claim(asset.pk, verification_owner)
        return QualityImportBatch.objects.get(pk=batch.pk)
    if target_changed:
        raise _manifest_error(
            'invalid_upload_receipt',
            'The upload target changed. Select the same workbook to resume safely.',
        )
    if redundant_public_id:
        _destroy_pending_upload(redundant_public_id)
    return QualityImportBatch.objects.get(pk=batch.pk)


def finalize_browser_direct_job(batch_id: int, *, requester) -> QualityImportBatch:
    """Create reports synchronously after every browser-delivered asset is ready."""

    owner = f'browser-direct:{uuid.uuid4().hex}'
    try:
        with transaction.atomic():
            batch = QualityImportBatch.objects.select_for_update().get(pk=batch_id)
            if _direct_summary(batch) is None:
                raise _manifest_error('invalid_job', 'The batch is not a browser-direct upload job.')
            _assert_direct_owner(batch, requester)
            if batch.status in {
                QualityImportBatch.Status.READY,
                QualityImportBatch.Status.READY_WITH_WARNINGS,
            }:
                return batch
            now = timezone.now()
            if (
                batch.status == QualityImportBatch.Status.STAGING
                and _direct_lease_expired(batch, now=now)
            ):
                raise _manifest_error(
                    'job_expired',
                    'This browser upload reservation expired. Select the same workbook to resume safely.',
                )
            if (
                batch.status == QualityImportBatch.Status.PROCESSING
                and batch.lease_expires_at
                and batch.lease_expires_at > now
            ):
                raise _manifest_error('job_busy', 'The upload job is already being finalized.')
            attached_media = batch.media.filter(asset__isnull=False)
            verification_cutoff = now - REMOTE_VERIFICATION_TTL
            pending = (
                attached_media.exclude(
                    asset__upload_state=QualityImportAsset.UploadState.READY,
                ).exists()
                or attached_media.filter(asset__file='').exists()
                or attached_media.exclude(
                    asset__remote_verified_at__gte=verification_cutoff,
                ).exists()
            )
            invalid_anchor = batch.media.filter(asset__isnull=True, warnings=[]).exists()
            if pending or invalid_anchor:
                raise _manifest_error(
                    'missing_media',
                    'Every required image must be uploaded and confirmed before registration.',
                )
            batch.status = QualityImportBatch.Status.PROCESSING
            batch.phase = 'registering_reports'
            batch.processing_owner = owner
            batch.lease_expires_at = now + DIRECT_FINALIZE_LEASE
            batch.next_attempt_at = None
            batch.last_heartbeat_at = now
            batch.attempt_count += 1
            batch.save(update_fields=[
                'status', 'phase', 'processing_owner', 'lease_expires_at',
                'next_attempt_at', 'last_heartbeat_at', 'attempt_count', 'updated_at',
            ])
    except IntegrityError as exc:
        raise _manifest_error('job_busy', 'Another import job is being finalized. Retry shortly.') from exc

    try:
        finalize_quality_import_job(batch_id, owner)
        return _finish_batch(batch_id, owner)
    except Exception:
        QualityImportBatch.objects.filter(pk=batch_id, processing_owner=owner).update(
            status=QualityImportBatch.Status.STAGING,
            phase='ready_to_finalize',
            processing_owner='',
            lease_expires_at=None,
            next_attempt_at=None,
        )
        raise
