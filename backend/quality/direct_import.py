"""Synchronous Excel-to-QualityReport import with deterministic replay safety."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import tempfile
import uuid
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, time, timedelta
from pathlib import PurePosixPath
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction

from .excel_import import (
    MAX_UPLOAD_BYTES,
    ParsedWorkbook,
    WorkbookValidationError,
    parse_quality_workbook,
    validate_upload_metadata,
)
from .duplicate_detection import normalize_identifier, normalize_text
from .models import QualityImportRow, QualityReport
from .storage import quality_import_media_storage, quality_import_media_upload_available


LOGGER = logging.getLogger(__name__)
REPORT_TIMEZONE = ZoneInfo('Asia/Shanghai')
MAX_IMAGES_PER_REPORT = 5
IMAGE_FIELDS = tuple(f'image{index}' for index in range(1, MAX_IMAGES_PER_REPORT + 1))
QUERY_CHUNK_SIZE = 500


def safe_workbook_filename(value: object) -> str:
    if not isinstance(value, str):
        raise WorkbookValidationError('invalid_filename', 'The workbook filename is invalid.')
    basename = PurePosixPath(value.replace('\\', '/')).name
    if (
        not value
        or value != value.strip()
        or value != basename
        or len(value) > 255
        or len(value.encode('utf-8')) > 512
        or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value)
    ):
        raise WorkbookValidationError(
            'invalid_filename',
            'The workbook filename must be a safe basename.',
        )
    return value


def _chunks(values: list[str], size: int = QUERY_CHUNK_SIZE) -> Iterable[list[str]]:
    for offset in range(0, len(values), size):
        yield values[offset:offset + size]


def _report_local_date(report: QualityReport):
    value = report.report_dt
    if value.tzinfo is None:
        value = value.replace(tzinfo=REPORT_TIMEZONE)
    return value.astimezone(REPORT_TIMEZONE).date()


def _row_report_signature(row: dict[str, Any]) -> tuple[Any, ...]:
    """Exact fields shared by Excel rows and manually created reports.

    Disposition and action result are deliberately excluded because they are
    user-editable post-processing fields.  All remaining identity evidence must
    match before a manual report can be skipped automatically.
    """

    return (
        row.get('report_date'),
        row.get('section') or '',
        normalize_identifier(row.get('model')),
        normalize_identifier(row.get('part_no')),
        row.get('lot_qty'),
        row.get('inspection_qty'),
        row.get('defect_qty'),
        normalize_text(row.get('defect_rate')),
        str(row.get('judgement') or '').strip().upper(),
        normalize_text(row.get('phenomenon')),
    )


def _report_signature(report: QualityReport) -> tuple[Any, ...]:
    return (
        _report_local_date(report),
        report.section or '',
        normalize_identifier(report.model),
        normalize_identifier(report.part_no),
        report.lot_qty,
        report.inspection_qty,
        report.defect_qty,
        normalize_text(report.defect_rate),
        str(report.judgement or '').strip().upper(),
        normalize_text(report.phenomenon),
    )


def _existing_reports_for_rows(
    rows: list[dict[str, Any]],
    *,
    source_sha256: str,
) -> dict[int, dict[str, Any]]:
    """Resolve exact replays, prior Excel events, and exact manual matches."""

    matches: dict[int, dict[str, Any]] = {}
    indexes_by_business_key: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        indexes_by_business_key[row['business_key']].append(index)

    # An identical workbook replay must remain idempotent even when a date with
    # no explicit year would be inferred differently at a later upload time.
    source_reports = QualityReport.objects.filter(
        excel_source__source_sha256=source_sha256,
    ).order_by('-updated_at', '-id')
    by_source_anchor: dict[tuple[str, int, str], QualityReport] = {}
    for report in source_reports:
        source = report.excel_source or {}
        try:
            source_row_number = int(source.get('source_row_number'))
        except (TypeError, ValueError):
            continue
        anchor = (
            str(source.get('sheet_name') or ''),
            source_row_number,
            str(source.get('source_sequence') or ''),
        )
        by_source_anchor.setdefault(anchor, report)
    for index, row in enumerate(rows):
        anchor = (
            row['sheet_name'],
            row['source_row_number'],
            str(row.get('source_sequence') or ''),
        )
        report = by_source_anchor.get(anchor)
        if report is not None:
            matches[index] = {'report': report, 'reason': 'exact_source_replay'}

    keys = list(indexes_by_business_key)
    for chunk in _chunks(keys):
        for report in QualityReport.objects.filter(excel_import_key__in=chunk).order_by('-updated_at', '-id'):
            if not report.excel_import_key:
                continue
            source_content_sha256 = str((report.excel_source or {}).get('content_sha256') or '')
            for index in indexes_by_business_key.get(report.excel_import_key, []):
                if index in matches:
                    continue
                content_changed = bool(
                    source_content_sha256
                    and source_content_sha256 != rows[index].get('content_sha256')
                )
                matches[index] = {
                    'report': report,
                    'reason': 'excel_event_key',
                    'content_changed': content_changed,
                }

        legacy_rows = (
            QualityImportRow.objects.filter(
                business_key__in=chunk,
                approved_report__isnull=False,
            )
            .select_related('approved_report')
            .prefetch_related('media')
            .order_by('-published_at', '-id')
        )
        for legacy_row in legacy_rows:
            if not legacy_row.approved_report_id:
                continue
            for index in indexes_by_business_key.get(legacy_row.business_key, []):
                if index in matches:
                    continue
                matches[index] = {
                    'report': legacy_row.approved_report,
                    'reason': 'legacy_excel_event_key',
                    'legacy_row': legacy_row,
                    'content_changed': bool(
                        legacy_row.content_sha256
                        and legacy_row.content_sha256 != rows[index].get('content_sha256')
                    ),
                }

    requested_dates = {row.get('report_date') for row in rows if row.get('report_date')}
    if requested_dates:
        start = datetime.combine(min(requested_dates), time.min, tzinfo=REPORT_TIMEZONE)
        end = datetime.combine(
            max(requested_dates) + timedelta(days=1),
            time.min,
            tzinfo=REPORT_TIMEZONE,
        )
        reports_by_signature: dict[tuple[Any, ...], deque[QualityReport]] = defaultdict(deque)
        reports = QualityReport.objects.filter(
            report_dt__gte=start,
            report_dt__lt=end,
            excel_import_key__isnull=True,
            source_import_row__isnull=True,
        ).order_by('-updated_at', '-id')
        for report in reports:
            reports_by_signature[_report_signature(report)].append(report)
        for index, row in enumerate(rows):
            if index in matches:
                continue
            candidates = reports_by_signature.get(_row_report_signature(row))
            if candidates:
                report = candidates.popleft()
                matches[index] = {'report': report, 'reason': 'exact_report_match'}
    return matches


def _media_by_row(parsed: ParsedWorkbook) -> dict[tuple[str, int], list[dict[str, Any]]]:
    grouped: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for item in parsed.media:
        key = (item['source_sheet_name'], item['source_anchor_row'])
        grouped.setdefault(key, []).append(item)
    for items in grouped.values():
        items.sort(key=lambda item: (item['source_index'], item['source_anchor_col']))
    return grouped


def stable_source_key(row: dict[str, Any]) -> str:
    """Return the stable worksheet coordinate for one source row.

    Sequence is intentionally metadata, not part of the coordinate.  Users can
    correct a sequence in-place; including it here would make that correction
    look like a brand-new event and could create a duplicate report.
    """

    sheet_name = re.sub(r'\s+', '', str(row.get('sheet_name') or '')).casefold()
    report_date = row.get('report_date')
    source_year = getattr(report_date, 'year', None) or row.get('source_year') or 0
    identity = {
        'sheet_role': str(row.get('sheet_role') or ''),
        'sheet_name': sheet_name,
        'source_year': int(source_year),
        'source_row_number': int(row.get('source_row_number') or 0),
    }
    return hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True).encode('utf-8')
    ).hexdigest()


def _row_validation_issues(row: dict[str, Any]) -> list[dict[str, str]]:
    """Return stable, field-addressable validation issues for import UIs."""

    issues: list[dict[str, str]] = []

    def add(field: str, code: str, message: str) -> None:
        issues.append({'field': field, 'code': code, 'message': message})

    if not row.get('report_date'):
        add('report_date', 'required', 'report_date is required')
    if row.get('section') not in {value for value, _label in QualityReport.SECTION_CHOICES}:
        add('section', 'unsupported', 'a supported section is required')
    if not (row.get('model') or row.get('part_no')):
        add('model_or_part_no', 'required', 'model or part_no is required')
    if not row.get('phenomenon'):
        add('phenomenon', 'required', 'phenomenon is required')
    for field_name, maximum in (
        ('model', 64),
        ('part_no', 64),
        ('defect_rate', 16),
        ('judgement', 8),
    ):
        if len(str(row.get(field_name) or '')) > maximum:
            add(
                field_name,
                'max_length',
                f'{field_name} exceeds {maximum} characters',
            )
    return issues


def _row_validation_errors(row: dict[str, Any]) -> list[str]:
    """Backward-compatible plain validation messages."""

    return [issue['message'] for issue in _row_validation_issues(row)]


def _store_image(run_id: str, item: dict[str, Any]) -> str:
    content = item.get('content')
    if not content:
        raise WorkbookValidationError(
            'invalid_embedded_image',
            'An embedded image could not be normalized.',
        )
    extension = str(item.get('extension') or 'bin').lower()
    storage_name = f'quality/excel/{run_id}/{item["sha256"]}.{extension}'
    storage = quality_import_media_storage()
    saved_name = storage.save(storage_name, ContentFile(content))
    url = storage.url(saved_name)
    if not isinstance(url, str) or not url or len(url) > 500:
        raise WorkbookValidationError(
            'image_url_invalid',
            'A stored image did not return a usable URL.',
        )
    return url


def _iter_row_image_results(
    run_id: str,
    prepared_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]],
):
    """Yield each row as soon as every selected image has resolved.

    Database registration happens between yields in the caller.  If a long
    request is interrupted, rows whose images completed are therefore durable
    and a retry can skip them instead of restarting the whole workbook.
    """

    media_items = [item for _row, items in prepared_rows for item in items]
    unique_items: dict[str, dict[str, Any]] = {}
    missing_content: set[str] = set()
    for item in media_items:
        sha256 = item['sha256']
        if not item.get('content'):
            missing_content.add(sha256)
            continue
        unique_items.setdefault(sha256, item)
    failures = {
        sha256: 'Embedded image normalization failed.'
        for sha256 in missing_content
        if sha256 not in unique_items
    }

    row_hashes = [
        [item['sha256'] for item in items]
        for _row, items in prepared_rows
    ]
    uploaded: dict[str, str] = {}
    resolved = set(failures)
    yielded: set[int] = set()

    def ready_rows():
        for row_index, hashes in enumerate(row_hashes):
            if row_index in yielded or not all(sha256 in resolved for sha256 in hashes):
                continue
            yielded.add(row_index)
            yield (
                row_index,
                [uploaded.get(sha256) for sha256 in hashes],
                [failures[sha256] for sha256 in hashes if sha256 in failures],
            )

    yield from ready_rows()
    if not unique_items:
        return

    configured_workers = int(getattr(settings, 'QUALITY_EXCEL_IMPORT_UPLOAD_WORKERS', 12) or 12)
    worker_count = max(1, min(configured_workers, 16, len(unique_items)))
    with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix='quality-excel-image') as pool:
        futures = {
            pool.submit(_store_image, run_id, item): sha256
            for sha256, item in unique_items.items()
        }
        for future in as_completed(futures):
            sha256 = futures[future]
            try:
                uploaded[sha256] = future.result()
            except Exception:
                failures[sha256] = 'Image storage failed.'
                LOGGER.exception('Quality Excel image upload failed sha256=%s', sha256[:12])
            resolved.add(sha256)
            yield from ready_rows()


def _source_metadata(
    row: dict[str, Any],
    *,
    filename: str,
    source_sha256: str,
    uploaded_by,
    media_items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        'source_filename': filename,
        'source_sha256': source_sha256,
        'sheet_name': row['sheet_name'],
        'sheet_role': row['sheet_role'],
        'source_row_number': row['source_row_number'],
        'source_sequence': row['source_sequence'],
        'business_key': row['business_key'],
        'content_sha256': row['content_sha256'],
        'stable_source_key': stable_source_key(row),
        'source_year': row['report_date'].year if row.get('report_date') else None,
        'media_source_sha256s': [
            str(item.get('source_sha256') or item.get('sha256') or '')
            for item in (media_items or [])
        ],
        'media_source_fingerprints': [
            (
                f'{int(item.get("source_index") or 0)}:'
                f'{int(item.get("source_anchor_col") or 0)}:'
                f'{str(item.get("source_sha256") or item.get("sha256") or "")}'
            )
            for item in (media_items or [])
        ],
        'occurrence_location': row.get('occurrence_location', ''),
        'item_name': row.get('item_name', ''),
        'raw_data': row.get('raw_data') or {},
        'uploaded_by': getattr(uploaded_by, 'username', '') or '',
    }


def _report_values(
    row: dict[str, Any],
    *,
    image_urls: list[str | None],
    filename: str,
    source_sha256: str,
    uploaded_by,
    media_items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    report_dt = datetime.combine(row['report_date'], time(hour=8), tzinfo=REPORT_TIMEZONE)
    values = {
        'report_dt': report_dt,
        'section': row['section'],
        'model': row.get('model', ''),
        'part_no': row.get('part_no', ''),
        'lot_qty': row.get('lot_qty'),
        'inspection_qty': row.get('inspection_qty'),
        'defect_qty': row.get('defect_qty'),
        'defect_rate': row.get('defect_rate', ''),
        'judgement': row.get('judgement') or 'NG',
        'phenomenon': row.get('phenomenon', ''),
        'disposition': row.get('disposition', ''),
        'action_result': row.get('action_result', ''),
        'excel_import_key': row['business_key'],
        'excel_source': _source_metadata(
            row,
            filename=filename,
            source_sha256=source_sha256,
            uploaded_by=uploaded_by,
            media_items=media_items,
        ),
    }
    for index, field_name in enumerate(IMAGE_FIELDS):
        values[field_name] = image_urls[index] if index < len(image_urls) else None
    return values


def _result_row(
    row: dict[str, Any],
    *,
    status: str,
    report_id: int | None,
    images_found: int,
    images_saved: int,
    warnings: list[str],
    message: str,
) -> dict[str, Any]:
    report_date = row.get('report_date')
    return {
        'row_key': stable_source_key(row),
        'sheet_name': row['sheet_name'],
        'source_row_number': row['source_row_number'],
        'source_sequence': row['source_sequence'],
        'status': status,
        'import_row_id': None,
        'report_id': report_id,
        'report_date': report_date.isoformat() if report_date else None,
        'section': row.get('section', ''),
        'occurrence_location': row.get('occurrence_location', ''),
        'model': row.get('model', ''),
        'part_no': row.get('part_no', ''),
        'lot_qty': row.get('lot_qty'),
        'inspection_qty': row.get('inspection_qty'),
        'defect_qty': row.get('defect_qty'),
        'defect_rate': row.get('defect_rate', ''),
        'judgement': row.get('judgement', ''),
        'phenomenon': row.get('phenomenon', ''),
        'disposition': row.get('disposition', ''),
        'action_result': row.get('action_result', ''),
        'images_found': images_found,
        'images_saved': images_saved,
        'media_keys': [],
        'editable': False,
        'failure_code': '',
        'validation_errors': [],
        'warnings': sorted(set(warnings)),
        'message': message,
    }


def _parse_upload(upload, *, filename: str) -> tuple[ParsedWorkbook, str, int]:
    content_type = str(getattr(upload, 'content_type', '') or '')
    validate_upload_metadata(filename, content_type, int(getattr(upload, 'size', 0) or 0))
    digest = hashlib.sha256()
    size = 0
    parsed = None
    with tempfile.TemporaryFile() as source:
        try:
            for block in upload.chunks(chunk_size=1024 * 1024):
                if not block:
                    continue
                size += len(block)
                if size > MAX_UPLOAD_BYTES:
                    raise WorkbookValidationError(
                        'file_too_large',
                        f'Workbook exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit.',
                    )
                digest.update(block)
                source.write(block)
            validate_upload_metadata(filename, content_type, size)
            source_sha256 = digest.hexdigest()
            source.seek(0)
            parsed = parse_quality_workbook(
                source,
                workbook_sha256=source_sha256,
                uploaded_on=datetime.now(REPORT_TIMEZONE).date(),
            )
        finally:
            try:
                upload.close()
            except Exception:
                pass
    if parsed is None:
        raise WorkbookValidationError('unreadable_workbook', 'Workbook parsing did not complete.')
    if not parsed.rows:
        raise WorkbookValidationError('no_quality_rows', 'No quality rows were found in the workbook.')
    return parsed, source_sha256, size


def import_quality_workbook_direct(upload, *, uploaded_by) -> dict[str, Any]:
    """Parse one workbook, skip known Excel events, and create new reports now."""

    filename = safe_workbook_filename(getattr(upload, 'name', ''))
    parsed, source_sha256, _source_size = _parse_upload(upload, filename=filename)
    media_by_row = _media_by_row(parsed)
    existing = _existing_reports_for_rows(parsed.rows, source_sha256=source_sha256)
    row_anchors = {
        (row['sheet_name'], row['source_row_number'])
        for row in parsed.rows
    }
    unlinked_media_count = sum(
        (item['source_sheet_name'], item['source_anchor_row']) not in row_anchors
        for item in parsed.media
    )
    result_warnings = list(parsed.warnings)
    if unlinked_media_count:
        result_warnings.append(f'unlinked_images_ignored:{unlinked_media_count}')

    prepared_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    results: list[dict[str, Any]] = []
    skipped_report_ids: list[int] = []
    created_report_ids: list[int] = []
    images_skipped = 0
    images_ignored = unlinked_media_count

    for row_index, row in enumerate(parsed.rows):
        row_media = media_by_row.get((row['sheet_name'], row['source_row_number']), [])
        existing_match = existing.get(row_index)
        if existing_match is not None:
            known_report = existing_match['report']
            row_warnings = list(row.get('warnings') or [])
            row_warnings.append(f'existing_match:{existing_match["reason"]}')
            if existing_match.get('content_changed'):
                row_warnings.append('existing_content_differs')
            skipped_report_ids.append(known_report.pk)
            images_skipped += len(row_media)
            results.append(_result_row(
                row,
                status='skipped',
                report_id=known_report.pk,
                images_found=len(row_media),
                images_saved=0,
                warnings=row_warnings,
                message='Existing report skipped.',
            ))
            continue
        validation_errors = _row_validation_errors(row)
        if validation_errors:
            images_ignored += len(row_media)
            results.append(_result_row(
                row,
                status='failed',
                report_id=None,
                images_found=len(row_media),
                images_saved=0,
                warnings=[*(row.get('warnings') or []), *validation_errors],
                message='Required report fields are missing or invalid.',
            ))
            continue
        selected_media = row_media[:MAX_IMAGES_PER_REPORT]
        if len(row_media) > MAX_IMAGES_PER_REPORT:
            ignored_for_row = len(row_media) - MAX_IMAGES_PER_REPORT
            images_ignored += ignored_for_row
            row = {
                **row,
                'warnings': [
                    *(row.get('warnings') or []),
                    f'images_over_limit:{ignored_for_row}',
                ],
            }
        prepared_rows.append((row, selected_media))

    selected_media_items = [item for _row, items in prepared_rows for item in items]
    if selected_media_items and not quality_import_media_upload_available():
        raise WorkbookValidationError(
            'production_storage_required',
            'Cloudinary image storage is required for Excel quality imports in production.',
        )
    run_id = uuid.uuid4().hex

    images_saved = 0
    images_failed = 0
    for prepared_index, image_urls, image_failures in _iter_row_image_results(run_id, prepared_rows):
        row, selected_media = prepared_rows[prepared_index]
        row_warnings = list(row.get('warnings') or [])
        for item, image_url in zip(selected_media, image_urls):
            if image_url:
                continue
            row_warnings.extend(item.get('warnings') or [])
            row_warnings.append(
                f'image_upload_failed:{item["source_index"] + 1}'
            )
        row_warnings.extend(image_failures)
        if any(url is None for url in image_urls):
            images_failed += len(selected_media)
            results.append(_result_row(
                row,
                status='failed',
                report_id=None,
                images_found=len(media_by_row.get((row['sheet_name'], row['source_row_number']), [])),
                images_saved=0,
                warnings=row_warnings,
                message='One or more images could not be stored; this row was not registered.',
            ))
            continue
        values = _report_values(
            row,
            image_urls=image_urls,
            filename=filename,
            source_sha256=source_sha256,
            uploaded_by=uploaded_by,
            media_items=selected_media,
        )
        try:
            with transaction.atomic():
                report = QualityReport.objects.create(**values)
        except IntegrityError:
            report = QualityReport.objects.filter(excel_import_key=row['business_key']).first()
            if report is None:
                raise
            skipped_report_ids.append(report.pk)
            images_skipped += len(selected_media)
            results.append(_result_row(
                row,
                status='skipped',
                report_id=report.pk,
                images_found=len(media_by_row.get((row['sheet_name'], row['source_row_number']), [])),
                images_saved=0,
                warnings=row_warnings,
                message='Existing report skipped.',
            ))
            continue
        except Exception:
            images_failed += len(selected_media)
            LOGGER.exception(
                'Quality Excel row registration failed sheet=%s row=%s',
                row['sheet_name'],
                row['source_row_number'],
            )
            results.append(_result_row(
                row,
                status='failed',
                report_id=None,
                images_found=len(media_by_row.get((row['sheet_name'], row['source_row_number']), [])),
                images_saved=0,
                warnings=row_warnings,
                message='Database registration failed for this row.',
            ))
            continue

        saved_for_row = sum(bool(url) for url in image_urls)
        images_saved += saved_for_row
        created_report_ids.append(report.pk)
        results.append(_result_row(
            row,
            status='created',
            report_id=report.pk,
            images_found=len(media_by_row.get((row['sheet_name'], row['source_row_number']), [])),
            images_saved=saved_for_row,
            warnings=row_warnings,
            message='Registered.',
        ))

    results.sort(key=lambda item: (item['sheet_name'], item['source_row_number']))
    created_count = sum(item['status'] == 'created' for item in results)
    skipped_count = sum(item['status'] == 'skipped' for item in results)
    failed_count = sum(item['status'] == 'failed' for item in results)
    return {
        'filename': filename,
        'total_rows': len(parsed.rows),
        'created_count': created_count,
        'skipped_count': skipped_count,
        'failed_count': failed_count,
        'images_found': len(parsed.media),
        'images_saved': images_saved,
        'images_failed': images_failed,
        'images_ignored': images_ignored,
        'images_skipped': images_skipped,
        'created_report_ids': created_report_ids,
        'skipped_report_ids': list(dict.fromkeys(skipped_report_ids)),
        'warnings': sorted(set(result_warnings)),
        'rows': results,
    }
