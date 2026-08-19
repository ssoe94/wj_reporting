"""Incremental quality workbook import using a browser-produced manifest.

The browser reads the XLSX locally and sends cell values plus image hashes for
comparison.  Only images belonging to genuinely new rows are sent on commit.
Existing reports are never overwritten: changed source rows are returned for
human post-processing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Iterable, Mapping

from django.db import IntegrityError, transaction
from django.utils import timezone

from .direct_import import (
    IMAGE_FIELDS,
    MAX_IMAGES_PER_REPORT,
    REPORT_TIMEZONE,
    _existing_reports_for_rows,
    _iter_row_image_results,
    _media_by_row,
    _report_local_date,
    _report_signature,
    _report_values,
    _result_row,
    _row_report_signature,
    _row_validation_issues,
    safe_workbook_filename,
    stable_source_key,
)
from .excel_import import (
    ISSUE_SHEET_PATTERN,
    MAX_STAGED_MEDIA_BYTES,
    MAX_CELL_TEXT,
    MAX_MEDIA_BYTES,
    MAX_NORMALIZED_MEDIA_TOTAL_BYTES,
    MAX_NORMALIZED_ROW_BYTES,
    MAX_ROWS_PER_SHEET,
    MAX_SUPPORTED_SHEETS,
    MAX_TOTAL_ROWS,
    MAX_UPLOAD_BYTES,
    NORMALIZER_VERSION,
    OQC_SHEET_NAME,
    ParsedWorkbook,
    WorkbookValidationError,
    _dataset_period_from_rows,
    _image_dimensions,
    _image_format,
    _normalize_image_content,
    _lock_staging_capacity,
    _metadata_matches,
    _pending_staged_bytes,
    _parse_issue_sheet,
    _parse_oqc_sheet,
    kick_quality_import_pump,
)
from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportMedia,
    QualityImportProvenance,
    QualityImportRow,
    QualityReport,
)
from .storage import quality_import_media_upload_available


MANIFEST_VERSION = 'quality-incremental-v1'
INCREMENTAL_JOB_DATASET_KEY = 'quality_incremental_direct:v1'
# Multipart form fields use Django's default in-memory request guard.  Two MiB
# is still far above the measured 8월 workbook manifest (~109 KiB) while
# keeping preview and commit behavior consistent without deployment settings.
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_MEDIA_ITEMS = 2_000
MAX_MANIFEST_MEDIA_TOTAL_BYTES = 128 * 1024 * 1024
MAX_COMMIT_ROWS = 10
MAX_COMMIT_MEDIA_ITEMS = 10
MAX_COMMIT_MEDIA_BYTES = 20 * 1024 * 1024
HASH_PATTERN = re.compile(r'^[0-9a-f]{64}$')
MEDIA_KEY_PATTERN = re.compile(r'^[A-Za-z0-9._-]{1,80}$')
SUPPORTED_IMAGE_TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
}
LOGGER = logging.getLogger(__name__)


@dataclass
class ManifestContext:
    filename: str
    file_size: int
    source_sha256: str
    parsed: ParsedWorkbook
    media_by_key: dict[str, dict[str, Any]]


@dataclass
class RowDecision:
    row: dict[str, Any]
    media: list[dict[str, Any]]
    selected_media: list[dict[str, Any]]
    status: str
    report: QualityReport | None
    warnings: list[str]
    message: str
    baseline_media: bool = False
    editable: bool = False
    failure_code: str = ''
    validation_errors: list[dict[str, str]] = field(default_factory=list)


class _ManifestWorksheet:
    """Small worksheet adapter for the existing canonical row parsers."""

    def __init__(self, title: str, rows: list[list[Any]]):
        self.title = title
        self._rows = rows
        self.supports_cell_metadata = False
        self.max_row = len(rows)
        self.max_column = max((len(row) for row in rows), default=0)

    def iter_rows(
        self,
        *,
        min_row: int,
        max_row: int,
        min_col: int,
        max_col: int,
        values_only: bool = True,
    ):
        if not values_only:
            raise ValueError('Manifest worksheet only supports values_only rows.')
        width = max(0, max_col - min_col + 1)
        for row_number in range(min_row, max_row + 1):
            source = self._rows[row_number - 1] if row_number <= len(self._rows) else []
            start = min_col - 1
            values = list(source[start:start + width])
            if len(values) < width:
                values.extend([None] * (width - len(values)))
            yield tuple(values)


def _manifest_error(code: str, message: str) -> WorkbookValidationError:
    return WorkbookValidationError(code, message)


def _ensure_monthly_direct_scope(context: ManifestContext) -> None:
    """Direct registration accepts one monthly issue sheet, never the OQC ledger."""

    sheet_names = list(context.parsed.sheet_names or [])
    if (
        len(sheet_names) != 1
        or sheet_names[0] == OQC_SHEET_NAME
        or ISSUE_SHEET_PATTERN.fullmatch(sheet_names[0]) is None
    ):
        raise _manifest_error(
            'monthly_sheet_required',
            'Direct quality registration must contain exactly one monthly issue sheet.',
        )


def _bounded_int(value: Any, *, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise _manifest_error('invalid_manifest', f'{name} must be an integer.')
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise _manifest_error('invalid_manifest', f'{name} must be an integer.') from exc
    if parsed < minimum or parsed > maximum:
        raise _manifest_error('invalid_manifest', f'{name} is outside the supported range.')
    return parsed


def _validate_cell(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise _manifest_error('invalid_manifest', 'Workbook cells must contain finite numbers.')
        return value
    if isinstance(value, str):
        if len(value) > MAX_CELL_TEXT:
            raise _manifest_error('invalid_manifest', 'A workbook cell exceeds the text limit.')
        return value
    raise _manifest_error('invalid_manifest', 'Workbook cells must contain scalar JSON values.')


def _validate_manifest(payload: Any, *, uploaded_on: date) -> ManifestContext:
    if not isinstance(payload, dict):
        raise _manifest_error('invalid_manifest', 'Manifest must be a JSON object.')
    try:
        encoded_size = len(
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(',', ':'),
            ).encode('utf-8')
        )
    except (TypeError, ValueError) as exc:
        raise _manifest_error('invalid_manifest', 'Manifest is not valid JSON data.') from exc
    if encoded_size > MAX_MANIFEST_BYTES:
        raise _manifest_error('manifest_too_large', 'Workbook manifest exceeds the safe limit.')
    if payload.get('version') != MANIFEST_VERSION:
        raise _manifest_error('unsupported_manifest_version', 'Workbook manifest version is not supported.')

    filename = safe_workbook_filename(payload.get('filename'))
    file_size = _bounded_int(
        payload.get('file_size'),
        name='file_size',
        minimum=1,
        maximum=MAX_UPLOAD_BYTES,
    )
    workbook_sha256 = str(payload.get('workbook_sha256') or '').lower()
    if not HASH_PATTERN.fullmatch(workbook_sha256):
        raise _manifest_error('invalid_manifest', 'workbook_sha256 must be a lowercase SHA-256 value.')

    raw_sheets = payload.get('sheets')
    if not isinstance(raw_sheets, list) or not raw_sheets:
        raise _manifest_error('no_supported_sheets', 'Manifest contains no supported quality sheets.')
    if len(raw_sheets) > MAX_SUPPORTED_SHEETS:
        raise _manifest_error('too_many_supported_sheets', 'Manifest has too many supported sheets.')

    worksheets: list[_ManifestWorksheet] = []
    seen_sheet_names: set[str] = set()
    raw_row_count = 0
    for raw_sheet in raw_sheets:
        if not isinstance(raw_sheet, dict):
            raise _manifest_error('invalid_manifest', 'Each manifest sheet must be an object.')
        sheet_name = str(raw_sheet.get('sheet_name') or '')
        if not sheet_name or len(sheet_name) > 128 or sheet_name in seen_sheet_names:
            raise _manifest_error('invalid_manifest', 'Manifest sheet names must be unique and valid.')
        if sheet_name != OQC_SHEET_NAME and not ISSUE_SHEET_PATTERN.match(sheet_name):
            raise _manifest_error('unsupported_sheet', f'Unsupported quality sheet: {sheet_name}')
        seen_sheet_names.add(sheet_name)
        raw_rows = raw_sheet.get('rows')
        if not isinstance(raw_rows, list):
            raise _manifest_error('invalid_manifest', f'{sheet_name} rows must be an array.')
        if len(raw_rows) > MAX_ROWS_PER_SHEET:
            raise _manifest_error('too_many_rows', f'{sheet_name} exceeds the row limit.')
        raw_row_count += len(raw_rows)
        if raw_row_count > MAX_TOTAL_ROWS + (2 * MAX_SUPPORTED_SHEETS):
            raise _manifest_error('too_many_total_rows', 'Manifest exceeds the total row limit.')
        rows: list[list[Any]] = []
        for raw_row in raw_rows:
            if not isinstance(raw_row, list) or len(raw_row) > 32:
                raise _manifest_error('invalid_manifest', 'Workbook rows must contain at most 32 cells.')
            rows.append([_validate_cell(value) for value in raw_row])
        worksheets.append(_ManifestWorksheet(sheet_name, rows))

    properties = payload.get('workbook_properties') or {}
    if not isinstance(properties, dict):
        raise _manifest_error('invalid_manifest', 'workbook_properties must be an object.')
    workbook_title = str(properties.get('title') or '')[:MAX_CELL_TEXT]

    parsed_rows: list[dict[str, Any]] = []
    normalized_row_bytes = 0
    normalized_row_count = 0

    def consume_row(row: dict[str, Any]):
        nonlocal normalized_row_bytes, normalized_row_count
        normalized_row_count += 1
        if normalized_row_count > MAX_TOTAL_ROWS:
            raise _manifest_error('too_many_total_rows', 'Manifest exceeds the total normalized row limit.')
        normalized_row_bytes += len(
            json.dumps(row, ensure_ascii=False, default=str).encode('utf-8')
        )
        if normalized_row_bytes > MAX_NORMALIZED_ROW_BYTES:
            raise _manifest_error(
                'normalized_rows_too_large',
                'Manifest normalized row content exceeds the safe limit.',
            )

    for worksheet in worksheets:
        if worksheet.title == OQC_SHEET_NAME:
            parsed_rows.extend(_parse_oqc_sheet(
                worksheet,
                uploaded_on,
                workbook_title=workbook_title,
                consume_row=consume_row,
            ))
        else:
            parsed_rows.extend(_parse_issue_sheet(
                worksheet,
                uploaded_on,
                consume_row=consume_row,
            ))
    if not parsed_rows:
        raise _manifest_error('no_quality_rows', 'No quality rows were found in the workbook manifest.')

    raw_media = payload.get('media') or []
    if not isinstance(raw_media, list):
        raise _manifest_error('invalid_manifest', 'Manifest media must be an array.')
    if len(raw_media) > MAX_MANIFEST_MEDIA_ITEMS:
        raise _manifest_error('too_many_images', 'Manifest exceeds the embedded image limit.')
    media: list[dict[str, Any]] = []
    media_by_key: dict[str, dict[str, Any]] = {}
    media_total_bytes = 0
    seen_media_anchors: set[tuple[str, int, int]] = set()
    for raw_item in raw_media:
        if not isinstance(raw_item, dict):
            raise _manifest_error('invalid_manifest', 'Each media entry must be an object.')
        key = str(raw_item.get('key') or '')
        if not MEDIA_KEY_PATTERN.fullmatch(key) or key in media_by_key:
            raise _manifest_error('invalid_manifest', 'Media keys must be unique safe identifiers.')
        sheet_name = str(raw_item.get('source_sheet_name') or '')
        if sheet_name not in seen_sheet_names:
            raise _manifest_error('invalid_manifest', 'Media references an unknown sheet.')
        anchor_row = _bounded_int(
            raw_item.get('source_anchor_row'), name='source_anchor_row', minimum=1, maximum=MAX_ROWS_PER_SHEET,
        )
        anchor_col = _bounded_int(
            raw_item.get('source_anchor_col'), name='source_anchor_col', minimum=1, maximum=16_384,
        )
        source_index = _bounded_int(
            raw_item.get('source_index'),
            name='source_index',
            minimum=0,
            maximum=MAX_MANIFEST_MEDIA_ITEMS - 1,
        )
        media_anchor = (sheet_name, anchor_row, source_index)
        if media_anchor in seen_media_anchors:
            raise _manifest_error('invalid_manifest', 'Media anchor indexes must be unique per row.')
        seen_media_anchors.add(media_anchor)
        byte_size = _bounded_int(
            raw_item.get('byte_size'), name='byte_size', minimum=1, maximum=MAX_MEDIA_BYTES,
        )
        media_total_bytes += byte_size
        if media_total_bytes > MAX_MANIFEST_MEDIA_TOTAL_BYTES:
            raise _manifest_error('images_too_large', 'Manifest images exceed the aggregate safe limit.')
        source_sha256 = str(raw_item.get('sha256') or '').lower()
        if not HASH_PATTERN.fullmatch(source_sha256):
            raise _manifest_error('invalid_manifest', 'Media sha256 must be a lowercase SHA-256 value.')
        content_type = str(raw_item.get('content_type') or '').lower()
        extension = SUPPORTED_IMAGE_TYPES.get(content_type)
        if extension is None:
            raise _manifest_error('unsupported_image_format', 'Manifest contains an unsupported image type.')
        original_filename = str(raw_item.get('original_filename') or f'{key}.{extension}')
        if len(original_filename) > 255:
            raise _manifest_error('invalid_manifest', 'Media filename exceeds the safe limit.')
        item = {
            'key': key,
            'source_sheet_name': sheet_name,
            'source_anchor_row': anchor_row,
            'source_anchor_col': anchor_col,
            'source_index': source_index,
            'original_filename': original_filename,
            'content_type': content_type,
            'byte_size': byte_size,
            # Preview comparisons always use the original browser-computed
            # hash.  Commit replaces sha256 with the normalized upload hash.
            'sha256': source_sha256,
            'source_sha256': source_sha256,
            'original_byte_size': byte_size,
            'storage_key': '',
            'content': None,
            'extension': extension,
            'warnings': [],
        }
        media.append(item)
        media_by_key[key] = item

    recognized_rows = {
        (row['sheet_name'], row['source_row_number'])
        for row in parsed_rows
    }
    raw_warnings = payload.get('warnings') or []
    if not isinstance(raw_warnings, list) or len(raw_warnings) > 500:
        raise _manifest_error('invalid_manifest', 'Manifest warnings must be a bounded array.')
    warnings = [str(value)[:255] for value in raw_warnings if isinstance(value, str)]
    for item in media:
        anchor = (item['source_sheet_name'], item['source_anchor_row'])
        if anchor not in recognized_rows:
            item['warnings'].append('image_not_linked_to_import_row')
            warnings.append(
                f'image_not_linked:{item["source_sheet_name"]}:{item["source_anchor_row"]}:{item["source_index"]}'
            )

    dataset_key, dataset_warnings = _dataset_period_from_rows(
        parsed_rows,
        fallback_date=uploaded_on,
    )
    parsed = ParsedWorkbook(
        sheet_names=[worksheet.title for worksheet in worksheets],
        properties={
            'title': workbook_title,
            'recognized_sheets': [worksheet.title for worksheet in worksheets],
            'source_dataset_key': dataset_key,
            'source_dataset_warnings': dataset_warnings,
        },
        rows=parsed_rows,
        media=media,
        warnings=sorted(set(warnings)),
    )
    return ManifestContext(
        filename=filename,
        file_size=file_size,
        source_sha256=workbook_sha256,
        parsed=parsed,
        media_by_key=media_by_key,
    )


def _chunks(values: list[Any], size: int = 400) -> Iterable[list[Any]]:
    for offset in range(0, len(values), size):
        yield values[offset:offset + size]


def _sequence_key(row: Mapping[str, Any]) -> tuple[str, str, int, str] | None:
    sequence = str(row.get('source_sequence') or '').strip()
    if not sequence:
        return None
    report_date = row.get('report_date')
    source_year = getattr(report_date, 'year', None) or row.get('source_year') or 0
    return (
        str(row.get('sheet_role') or ''),
        re.sub(r'\s+', '', str(row.get('sheet_name') or '')).casefold(),
        int(source_year),
        sequence,
    )


def _source_dict_for_report(report: QualityReport) -> dict[str, Any]:
    source = dict(report.excel_source or {})
    source.setdefault('report_date', _report_local_date(report))
    source.setdefault('source_year', _report_local_date(report).year)
    return source


def _source_candidates(rows: list[dict[str, Any]]):
    """Index existing Excel sources by exact anchor and unique sequence."""

    if not rows:
        return defaultdict(list), defaultdict(list), {}

    sequences = sorted({
        str(row.get('source_sequence') or '').strip()
        for row in rows
        if str(row.get('source_sequence') or '').strip()
    })
    row_numbers = sorted({int(row['source_row_number']) for row in rows})
    sheet_names = sorted({str(row.get('sheet_name') or '') for row in rows})
    years = sorted({
        int(row['report_date'].year)
        for row in rows
        if row.get('report_date')
    })
    if not years:
        return defaultdict(list), defaultdict(list), {}
    range_start = datetime(min(years), 1, 1, tzinfo=REPORT_TIMEZONE)
    range_end = datetime(max(years), 12, 31, 23, 59, 59, 999999, tzinfo=REPORT_TIMEZONE)

    direct_base = QualityReport.objects.filter(
        excel_import_key__isnull=False,
        excel_source__sheet_name__in=sheet_names,
        report_dt__gte=range_start,
        report_dt__lte=range_end,
    )
    direct_reports: dict[int, QualityReport] = {}
    for chunk in _chunks(sequences):
        queryset = direct_base.filter(
            excel_source__source_sequence__in=chunk,
        ).order_by('-updated_at', '-id')
        for report in queryset:
            direct_reports.setdefault(report.pk, report)
    for chunk in _chunks(row_numbers):
        queryset = direct_base.filter(
            excel_source__source_row_number__in=chunk,
        ).order_by('-updated_at', '-id')
        for report in queryset:
            direct_reports.setdefault(report.pk, report)

    legacy_rows: dict[int, QualityImportRow] = {}
    legacy_base = QualityImportRow.objects.filter(
        sheet_name__in=sheet_names,
        report_date__gte=date(min(years), 1, 1),
        report_date__lte=date(max(years), 12, 31),
        approved_report__isnull=False,
    )
    for chunk in _chunks(sequences):
        queryset = (
            legacy_base.filter(
                source_sequence__in=chunk,
            )
            .select_related('approved_report')
            .prefetch_related('media')
            .order_by('-published_at', '-id')
        )
        for legacy_row in queryset:
            legacy_rows.setdefault(legacy_row.pk, legacy_row)
    for chunk in _chunks(row_numbers):
        queryset = (
            legacy_base.filter(
                source_row_number__in=chunk,
            )
            .select_related('approved_report')
            .prefetch_related('media')
            .order_by('-published_at', '-id')
        )
        for legacy_row in queryset:
            legacy_rows.setdefault(legacy_row.pk, legacy_row)

    anchor_candidates: dict[str, list[dict[str, Any]]] = defaultdict(list)
    sequence_candidates: dict[tuple[str, str, int, str], list[dict[str, Any]]] = defaultdict(list)
    legacy_by_report_id: dict[int, QualityImportRow] = {}
    for report in direct_reports.values():
        source = _source_dict_for_report(report)
        candidate = {'report': report, 'reason': 'source_anchor'}
        anchor_candidates[stable_source_key(source)].append(candidate)
        sequence_key = _sequence_key(source)
        if sequence_key is not None:
            sequence_candidates[sequence_key].append(candidate)
    for legacy_row in legacy_rows.values():
        report = legacy_row.approved_report
        if report is None:
            continue
        source = {
            'sheet_role': legacy_row.sheet_role,
            'sheet_name': legacy_row.sheet_name,
            'source_row_number': legacy_row.source_row_number,
            'source_sequence': legacy_row.source_sequence,
            'report_date': legacy_row.report_date,
            'source_year': legacy_row.report_date.year if legacy_row.report_date else 0,
        }
        candidate = {
            'report': report,
            'reason': 'legacy_source_anchor',
            'legacy_row': legacy_row,
        }
        anchor_candidates[stable_source_key(source)].append(candidate)
        sequence_key = _sequence_key(source)
        if sequence_key is not None:
            sequence_candidates[sequence_key].append(candidate)
        legacy_by_report_id.setdefault(report.pk, legacy_row)
    return anchor_candidates, sequence_candidates, legacy_by_report_id


def _media_fingerprints(items: list[dict[str, Any]]) -> list[str]:
    return [
        f'{int(item.get("source_index") or 0)}:{int(item.get("source_anchor_col") or 0)}:{item["source_sha256"]}'
        for item in items
    ]


def _stored_media_fingerprints(
    match: dict[str, Any],
    *,
    legacy_by_report_id: dict[int, QualityImportRow],
) -> list[str] | None:
    legacy_row = match.get('legacy_row') or legacy_by_report_id.get(match['report'].pk)
    if legacy_row is not None:
        return [
            f'{media.source_index}:{media.source_anchor_col}:{media.source_sha256}'
            for media in sorted(legacy_row.media.all(), key=lambda item: (item.source_index, item.source_anchor_col))
            if media.source_sha256
        ][:MAX_IMAGES_PER_REPORT]
    source = match['report'].excel_source or {}
    fingerprints = source.get('media_source_fingerprints')
    if isinstance(fingerprints, list) and all(isinstance(value, str) for value in fingerprints):
        return fingerprints[:MAX_IMAGES_PER_REPORT]
    hashes = source.get('media_source_sha256s')
    if isinstance(hashes, list) and all(isinstance(value, str) for value in hashes):
        # Old direct imports did not persist anchor columns.  Preserve their
        # hash-only baseline until this commit records full fingerprints.
        return [f'hash-only:{value}' for value in hashes[:MAX_IMAGES_PER_REPORT]]
    return None


def _stored_content_sha256(
    match: dict[str, Any],
    *,
    legacy_by_report_id: dict[int, QualityImportRow],
) -> str:
    legacy_row = match.get('legacy_row') or legacy_by_report_id.get(match['report'].pk)
    if legacy_row is not None:
        return legacy_row.content_sha256 or ''
    return str((match['report'].excel_source or {}).get('content_sha256') or '')


def _stored_source_sequence(
    match: dict[str, Any],
    *,
    legacy_by_report_id: dict[int, QualityImportRow],
) -> str | None:
    legacy_row = match.get('legacy_row') or legacy_by_report_id.get(match['report'].pk)
    if legacy_row is not None:
        return str(legacy_row.source_sequence or '').strip()
    source = match['report'].excel_source or {}
    if 'source_sequence' not in source:
        return None
    return str(source.get('source_sequence') or '').strip()


def _concurrent_report_differences(
    report: QualityReport,
    row: dict[str, Any],
    selected_media: list[dict[str, Any]],
    *,
    source_sha256: str,
) -> list[str]:
    """Recheck a unique-key winner before treating a concurrent commit as equal."""

    differences: list[str] = []
    source = report.excel_source or {}
    stored_content_sha256 = str(source.get('content_sha256') or '')
    if stored_content_sha256:
        if stored_content_sha256 != str(row.get('content_sha256') or ''):
            differences.append('existing_content_differs')
    elif _report_signature(report) != _row_report_signature(row):
        differences.append('existing_content_differs')

    stored_sequence = source.get('source_sequence')
    if stored_sequence is not None and str(stored_sequence).strip() != str(row.get('source_sequence') or '').strip():
        differences.append('existing_sequence_differs')

    current_fingerprints = _media_fingerprints(selected_media)
    fingerprints = source.get('media_source_fingerprints')
    hashes = source.get('media_source_sha256s')
    if isinstance(fingerprints, list) and all(isinstance(value, str) for value in fingerprints):
        if fingerprints[:MAX_IMAGES_PER_REPORT] != current_fingerprints:
            differences.append('existing_images_differ')
    elif isinstance(hashes, list) and all(isinstance(value, str) for value in hashes):
        current_hashes = [item['source_sha256'] for item in selected_media]
        if hashes[:MAX_IMAGES_PER_REPORT] != current_hashes:
            differences.append('existing_images_differ')
    elif str(source.get('source_sha256') or '') != source_sha256:
        stored_count = sum(bool(getattr(report, field_name)) for field_name in IMAGE_FIELDS)
        if stored_count or current_fingerprints:
            differences.append('existing_image_fingerprint_missing')
    return differences


def _classify(context: ManifestContext) -> list[RowDecision]:
    rows = context.parsed.rows
    media_by_row = _media_by_row(context.parsed)
    existing = _existing_reports_for_rows(rows, source_sha256=context.source_sha256)
    unmatched_rows = [row for index, row in enumerate(rows) if index not in existing]
    anchor_candidates, sequence_candidates, legacy_by_report_id = _source_candidates(unmatched_rows)

    current_sequence_counts = Counter(
        key for row in rows if (key := _sequence_key(row)) is not None
    )
    used_report_ids = {
        match['report'].pk
        for match in existing.values()
    }
    decisions: list[RowDecision] = []

    for index, row in enumerate(rows):
        all_media = media_by_row.get((row['sheet_name'], row['source_row_number']), [])
        selected_media = all_media[:MAX_IMAGES_PER_REPORT]
        warnings = list(row.get('warnings') or [])
        if len(all_media) > MAX_IMAGES_PER_REPORT:
            warnings.append(f'images_over_limit:{len(all_media) - MAX_IMAGES_PER_REPORT}')
        validation_issues = _row_validation_issues(row)
        match = existing.get(index)
        ambiguous_source_identity = False
        if match is None:
            candidates = anchor_candidates.get(stable_source_key(row), [])
            available_by_report = {
                value['report'].pk: value
                for value in candidates
                if value['report'].pk not in used_report_ids
            }
            if len(available_by_report) == 1:
                match = next(iter(available_by_report.values()))
            elif len(available_by_report) > 1:
                ambiguous_source_identity = True
        if match is None:
            sequence_key = _sequence_key(row)
            candidates = sequence_candidates.get(sequence_key, []) if sequence_key else []
            # Row movement is safe only when the sequence is unique in both
            # the current workbook and stored source history.
            available = [value for value in candidates if value['report'].pk not in used_report_ids]
            if (
                sequence_key is not None
                and current_sequence_counts[sequence_key] == 1
                and len(available) == 1
            ):
                match = available[0]
                match = {**match, 'reason': f'{match["reason"]}_sequence_move'}
            elif sequence_key is not None and candidates:
                ambiguous_source_identity = True

        if match is None and ambiguous_source_identity:
            decisions.append(RowDecision(
                row=row,
                media=all_media,
                selected_media=selected_media,
                status='failed',
                report=None,
                warnings=[*warnings, 'ambiguous_source_identity'],
                message='A moved row could not be matched safely; review it manually.',
                failure_code='ambiguous_source_identity',
            ))
            continue

        # A corrected draft keeps the original workbook fingerprint for audit.
        # When that exact source row has already been published, an unchanged
        # re-upload must resolve to the approved report instead of surfacing the
        # original validation error again.  Any changed/unknown source still
        # fails validation and remains editable.
        validation_matches_published_source = False
        if validation_issues and match is not None:
            stored_content_sha256 = _stored_content_sha256(
                match,
                legacy_by_report_id=legacy_by_report_id,
            )
            stored_sequence = _stored_source_sequence(
                match,
                legacy_by_report_id=legacy_by_report_id,
            )
            current_sequence = str(row.get('source_sequence') or '').strip()
            validation_matches_published_source = bool(
                stored_content_sha256
                and stored_content_sha256 == str(row.get('content_sha256') or '')
                and (stored_sequence is None or stored_sequence == current_sequence)
            )
        if validation_issues and not validation_matches_published_source:
            selected_media_bytes = sum(
                int(item.get('original_byte_size') or 0)
                for item in selected_media
            )
            editable = selected_media_bytes <= MAX_COMMIT_MEDIA_BYTES
            failure_code = (
                'row_validation_failed'
                if editable
                else 'selected_row_images_too_large'
            )
            if not editable:
                warnings.append('selected_row_images_too_large')
            decisions.append(RowDecision(
                row=row,
                media=all_media,
                selected_media=selected_media,
                status='failed',
                report=None,
                warnings=[
                    *warnings,
                    *(issue['message'] for issue in validation_issues),
                ],
                message=(
                    'Correct the highlighted input fields and register this row.'
                    if editable
                    else 'This row needs more than 20 MiB of images; compress them before importing.'
                ),
                editable=editable,
                failure_code=failure_code,
                validation_errors=validation_issues,
            ))
            continue

        if match is None:
            if sum(int(item.get('original_byte_size') or 0) for item in selected_media) > MAX_COMMIT_MEDIA_BYTES:
                decisions.append(RowDecision(
                    row=row,
                    media=all_media,
                    selected_media=selected_media,
                    status='failed',
                    report=None,
                    warnings=[*warnings, 'selected_row_images_too_large'],
                    message='This row needs more than 20 MiB of images; compress them before importing.',
                    failure_code='selected_row_images_too_large',
                ))
                continue
            decisions.append(RowDecision(
                row=row,
                media=all_media,
                selected_media=selected_media,
                status='new',
                report=None,
                warnings=warnings,
                message='New report will be registered.',
            ))
            continue

        report = match['report']
        used_report_ids.add(report.pk)
        warnings.append(f'existing_match:{match.get("reason", "existing") }')
        content_changed = bool(match.get('content_changed'))
        stored_content_sha256 = _stored_content_sha256(
            match,
            legacy_by_report_id=legacy_by_report_id,
        )
        if stored_content_sha256:
            content_changed = stored_content_sha256 != row.get('content_sha256')
        elif match.get('reason') != 'exact_report_match':
            content_changed = _report_signature(report) != _row_report_signature(row)
        stored_sequence = _stored_source_sequence(
            match,
            legacy_by_report_id=legacy_by_report_id,
        )
        current_sequence = str(row.get('source_sequence') or '').strip()
        sequence_changed = (
            stored_sequence is not None
            and stored_sequence != current_sequence
            and match.get('reason') != 'exact_report_match'
        )
        content_changed = content_changed or sequence_changed

        baseline_media = False
        media_changed = False
        missing_media_fingerprint = False
        if match.get('reason') != 'exact_report_match':
            current_fingerprints = _media_fingerprints(selected_media)
            stored_fingerprints = _stored_media_fingerprints(
                match,
                legacy_by_report_id=legacy_by_report_id,
            )
            if stored_fingerprints is not None:
                if stored_fingerprints and stored_fingerprints[0].startswith('hash-only:'):
                    current_hashes = [item['source_sha256'] for item in selected_media]
                    media_changed = [value.removeprefix('hash-only:') for value in stored_fingerprints] != current_hashes
                    baseline_media = not media_changed and bool(report.excel_import_key)
                else:
                    media_changed = stored_fingerprints != current_fingerprints
            elif str((report.excel_source or {}).get('source_sha256') or '') == context.source_sha256:
                media_changed = False
                baseline_media = bool(report.excel_import_key)
            else:
                stored_count = sum(bool(getattr(report, field_name)) for field_name in IMAGE_FIELDS)
                if stored_count == 0 and not current_fingerprints:
                    # Empty on both sides is a complete, safe fingerprint.
                    baseline_media = bool(report.excel_import_key)
                else:
                    # Image URLs do not preserve the original workbook bytes.
                    # Equal counts therefore cannot prove that pictures match.
                    media_changed = True
                    missing_media_fingerprint = True

        if content_changed or media_changed:
            if content_changed:
                warnings.append('existing_content_differs')
            if sequence_changed:
                warnings.append('existing_sequence_differs')
            if media_changed:
                warnings.append(
                    'existing_image_fingerprint_missing'
                    if missing_media_fingerprint
                    else 'existing_images_differ'
                )
            decisions.append(RowDecision(
                row=row,
                media=all_media,
                selected_media=selected_media,
                status='changed',
                report=report,
                warnings=warnings,
                message='Existing report differs; review before applying changes.',
            ))
        else:
            if baseline_media:
                warnings.append('image_fingerprint_baseline_pending')
            decisions.append(RowDecision(
                row=row,
                media=all_media,
                selected_media=selected_media,
                status='unchanged',
                report=report,
                warnings=warnings,
                message='Existing report is unchanged and will be skipped.',
                baseline_media=baseline_media,
            ))
    return decisions


def _unlinked_media_count(context: ManifestContext) -> int:
    row_anchors = {
        (row['sheet_name'], row['source_row_number'])
        for row in context.parsed.rows
    }
    return sum(
        (item['source_sheet_name'], item['source_anchor_row']) not in row_anchors
        for item in context.parsed.media
    )


def _decision_row(decision: RowDecision, *, preview: bool) -> dict[str, Any]:
    status = decision.status
    if preview:
        result_status = status
    else:
        result_status = 'skipped' if status == 'unchanged' else status
    payload = _result_row(
        decision.row,
        status=result_status,
        report_id=decision.report.pk if decision.report else None,
        images_found=len(decision.media),
        images_saved=0,
        warnings=decision.warnings,
        message=decision.message,
    )
    payload['media_keys'] = [item['key'] for item in decision.selected_media]
    payload['row_key'] = stable_source_key(decision.row)
    payload['editable'] = decision.editable
    payload['failure_code'] = decision.failure_code
    payload['validation_errors'] = decision.validation_errors
    return payload


def preview_quality_manifest(payload: Any, *, uploaded_on: date | None = None) -> dict[str, Any]:
    context = _validate_manifest(payload, uploaded_on=uploaded_on or date.today())
    _ensure_monthly_direct_scope(context)
    decisions = _classify(context)
    required_media_keys = [
        item['key']
        for decision in decisions
        if decision.status == 'new' or decision.editable
        for item in decision.selected_media
    ]
    unlinked = _unlinked_media_count(context)
    ignored = unlinked + sum(max(0, len(decision.media) - MAX_IMAGES_PER_REPORT) for decision in decisions)
    ignored += sum(
        len(decision.selected_media)
        for decision in decisions
        if decision.status == 'failed' and not decision.editable
    )
    return {
        'version': MANIFEST_VERSION,
        'filename': context.filename,
        'total_rows': len(decisions),
        'new_count': sum(decision.status == 'new' for decision in decisions),
        'unchanged_count': sum(decision.status == 'unchanged' for decision in decisions),
        'changed_count': sum(decision.status == 'changed' for decision in decisions),
        'failed_count': sum(decision.status == 'failed' for decision in decisions),
        'images_found': len(context.parsed.media),
        'images_to_upload': len(required_media_keys),
        'images_ignored': ignored,
        'required_media_keys': required_media_keys,
        'warnings': context.parsed.warnings,
        'rows': [_decision_row(decision, preview=True) for decision in decisions],
    }


def _read_uploaded_media(upload: Any, manifest_item: dict[str, Any]) -> dict[str, Any]:
    content = bytearray()
    for chunk in upload.chunks(chunk_size=1024 * 1024):
        content.extend(chunk)
        if len(content) > MAX_MEDIA_BYTES:
            raise _manifest_error('image_too_large', 'Uploaded image exceeds the safe limit.')
    raw = bytes(content)
    if len(raw) != manifest_item['original_byte_size']:
        raise _manifest_error('image_size_mismatch', 'Uploaded image size does not match its manifest.')
    source_sha256 = hashlib.sha256(raw).hexdigest()
    if source_sha256 != manifest_item['source_sha256']:
        raise _manifest_error('image_hash_mismatch', 'Uploaded image does not match its manifest hash.')
    detected = _image_format(raw)
    if detected is None:
        raise _manifest_error('unsupported_image_format', 'Uploaded image format is not supported.')
    extension, content_type = detected
    original_width, original_height = _image_dimensions(raw)
    normalized, normalized_extension, normalized_type, width, height = _normalize_image_content(
        raw,
        extension=extension,
        content_type=content_type,
    )
    return {
        **manifest_item,
        'content': normalized,
        'sha256': hashlib.sha256(normalized).hexdigest(),
        'source_sha256': source_sha256,
        'byte_size': len(normalized),
        'content_type': normalized_type,
        'extension': normalized_extension,
        'original_width': original_width,
        'original_height': original_height,
        'width': width,
        'height': height,
    }


def _record_media_baselines(decisions: list[RowDecision]) -> None:
    reports_to_update: list[QualityReport] = []
    for decision in decisions:
        report = decision.report
        if not decision.baseline_media or report is None or not report.excel_import_key:
            continue
        source = dict(report.excel_source or {})
        if 'media_source_fingerprints' in source:
            continue
        source['media_source_sha256s'] = [
            item['source_sha256'] for item in decision.selected_media
        ]
        source['media_source_fingerprints'] = _media_fingerprints(decision.selected_media)
        source.setdefault('stable_source_key', stable_source_key(decision.row))
        source.setdefault(
            'source_year',
            decision.row['report_date'].year if decision.row.get('report_date') else None,
        )
        report.excel_source = source
        reports_to_update.append(report)
    if reports_to_update:
        QualityReport.objects.bulk_update(
            reports_to_update,
            ['excel_source'],
            batch_size=200,
        )


def _incremental_job_scope_key(selected_row_keys: set[str]) -> str:
    digest = hashlib.sha256(
        ('\n'.join(sorted(selected_row_keys)) or 'empty-selection').encode('ascii')
    ).hexdigest()
    return f'inc:{digest[:28]}'


def _incremental_job_metadata(decision: RowDecision) -> dict[str, Any]:
    return {
        'row_key': stable_source_key(decision.row),
        'preview_status': decision.status,
        'preview_message': decision.message,
        'preview_report_id': decision.report.pk if decision.report else None,
        'editable': decision.editable,
        'failure_code': decision.failure_code,
        'validation_errors': decision.validation_errors,
        'images_found': len(decision.media),
        'media': [
            {
                'key': item['key'],
                'source_anchor_row': item['source_anchor_row'],
                'source_anchor_col': item['source_anchor_col'],
                'source_index': item['source_index'],
                'original_filename': item['original_filename'],
                'source_sha256': item['source_sha256'],
                'original_byte_size': item['original_byte_size'],
                'content_type': item['content_type'],
            }
            for item in decision.selected_media
        ],
    }


def _quality_import_row_values(decision: RowDecision) -> dict[str, Any]:
    row = decision.row
    raw_data = dict(row.get('raw_data') or {})
    raw_data['_incremental_job'] = _incremental_job_metadata(decision)
    evidence = hashlib.sha256(json.dumps(
        {
            'content_sha256': row['content_sha256'],
            'media': [
                {
                    'column': item['source_anchor_col'],
                    'index': item['source_index'],
                    'sha256': item['source_sha256'],
                }
                for item in decision.selected_media
            ],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
    delta_status = {
        'new': QualityImportRow.DeltaStatus.ADDED,
        'changed': QualityImportRow.DeltaStatus.CHANGED,
        'unchanged': QualityImportRow.DeltaStatus.UNCHANGED,
        'failed': QualityImportRow.DeltaStatus.ADDED,
    }[decision.status]
    review_status = (
        QualityImportRow.ReviewStatus.UNCHANGED
        if decision.status == 'unchanged'
        else QualityImportRow.ReviewStatus.DRAFT
    )
    return {
        'sheet_name': row['sheet_name'],
        'sheet_role': row.get('sheet_role', ''),
        'source_row_number': row['source_row_number'],
        'source_sequence': row.get('source_sequence', ''),
        'source_key': stable_source_key(row),
        'business_key': row['business_key'],
        'content_sha256': row['content_sha256'],
        'evidence_sha256': evidence,
        'delta_status': delta_status,
        'report_date': row.get('report_date'),
        'section': row.get('section', ''),
        'occurrence_location': row.get('occurrence_location', ''),
        'model': row.get('model', ''),
        'part_no': row.get('part_no', ''),
        'item_name': row.get('item_name', ''),
        'lot_qty': row.get('lot_qty'),
        'inspection_qty': row.get('inspection_qty'),
        'defect_qty': row.get('defect_qty'),
        'defect_rate': row.get('defect_rate', ''),
        'judgement': row.get('judgement', ''),
        'phenomenon': row.get('phenomenon', ''),
        'disposition': row.get('disposition', ''),
        'action_result': row.get('action_result', ''),
        'raw_data': raw_data,
        'warnings': sorted(set([*(row.get('warnings') or []), *decision.warnings])),
        'review_status': review_status,
    }


def _stage_incremental_asset(
    *,
    batch: QualityImportBatch,
    item: dict[str, Any],
    pending_bytes: list[int],
) -> tuple[QualityImportAsset, bool]:
    item['storage_key'] = f'quality-import/assets/{item["sha256"]}'
    asset = QualityImportAsset.objects.select_for_update().filter(sha256=item['sha256']).first()
    if asset is None:
        pending_bytes[0] += item['byte_size']
        if pending_bytes[0] > MAX_STAGED_MEDIA_BYTES:
            raise _manifest_error(
                'staging_capacity_exceeded',
                'Pending normalized images exceed the temporary database staging limit.',
            )
        return QualityImportAsset.objects.create(
            sha256=item['sha256'],
            normalizer_version=NORMALIZER_VERSION,
            byte_size=item['byte_size'],
            content_type=item['content_type'],
            width=item['width'],
            height=item['height'],
            extension=item['extension'],
            storage_key=item['storage_key'],
            file='',
            staged_bytes=item['content'],
            upload_state=QualityImportAsset.UploadState.STAGED,
            created_by_batch=batch,
        ), True
    if not _metadata_matches(asset, item):
        raise _manifest_error(
            'asset_metadata_mismatch',
            'An existing content-addressed image has conflicting metadata.',
        )
    if asset.staged_bytes is None and asset.upload_state != QualityImportAsset.UploadState.UPLOADING:
        pending_bytes[0] += item['byte_size']
        if pending_bytes[0] > MAX_STAGED_MEDIA_BYTES:
            raise _manifest_error(
                'staging_capacity_exceeded',
                'Pending normalized images exceed the temporary database staging limit.',
            )
        asset.staged_bytes = item['content']
    if asset.upload_state != QualityImportAsset.UploadState.UPLOADING:
        # READY in the database is not proof that the remote object still
        # exists. The worker verifies/recreates it from these staged bytes.
        asset.upload_state = QualityImportAsset.UploadState.STAGED
        asset.processing_owner = ''
        asset.lease_expires_at = None
        asset.next_attempt_at = None
        asset.last_error = ''
        asset.save(update_fields=[
            'staged_bytes', 'upload_state', 'processing_owner',
            'lease_expires_at', 'next_attempt_at', 'last_error',
        ])
    return asset, False


def _enqueue_quality_manifest_once(
    payload: Any,
    *,
    uploaded_files: Mapping[str, Any],
    uploaded_by,
    uploaded_on: date | None = None,
    selected_row_keys: set[str] | None = None,
) -> tuple[QualityImportBatch, bool]:
    """Durably stage one small incremental chunk and return before remote I/O."""

    context = _validate_manifest(payload, uploaded_on=uploaded_on or date.today())
    _ensure_monthly_direct_scope(context)
    all_decisions = _classify(context)
    decisions_by_key = {
        stable_source_key(decision.row): decision
        for decision in all_decisions
    }
    selected_row_keys = set(decisions_by_key) if selected_row_keys is None else selected_row_keys
    unknown_row_keys = selected_row_keys - set(decisions_by_key)
    if unknown_row_keys:
        raise _manifest_error('invalid_row_selection', 'Job references an unknown workbook row.')
    decisions = [
        decision for decision in all_decisions
        if stable_source_key(decision.row) in selected_row_keys
    ]
    if len(decisions) > MAX_COMMIT_ROWS:
        raise _manifest_error(
            'commit_too_large',
            f'Job may contain at most {MAX_COMMIT_ROWS} workbook rows.',
        )
    required_keys = {
        item['key']
        for decision in decisions
        if decision.status == 'new' or decision.editable
        for item in decision.selected_media
    }
    selected_media_keys = {
        item['key']
        for decision in decisions
        for item in decision.selected_media
    }
    provided_keys = set(uploaded_files)
    if len(required_keys) > MAX_COMMIT_MEDIA_ITEMS or len(provided_keys) > MAX_COMMIT_MEDIA_ITEMS:
        raise _manifest_error(
            'commit_too_large',
            f'Job may contain at most {MAX_COMMIT_MEDIA_ITEMS} images.',
        )
    provided_bytes = sum(
        max(0, int(getattr(upload, 'size', 0) or 0))
        for upload in uploaded_files.values()
    )
    if provided_bytes > MAX_COMMIT_MEDIA_BYTES:
        raise _manifest_error('commit_too_large', 'Uploaded images exceed the 20 MiB request limit.')
    if provided_keys - selected_media_keys:
        raise _manifest_error('unexpected_media', 'Job contains media outside its selected rows.')
    if required_keys - provided_keys:
        raise _manifest_error('missing_media', 'One or more required images were not uploaded.')
    if required_keys and not quality_import_media_upload_available():
        raise _manifest_error(
            'production_storage_required',
            'Cloudinary image storage is required for Excel quality imports in production.',
        )

    import_scope_key = _incremental_job_scope_key(selected_row_keys)
    existing = QualityImportBatch.objects.filter(
        sha256=context.source_sha256,
        import_scope_key=import_scope_key,
        dataset_key=INCREMENTAL_JOB_DATASET_KEY,
    ).first()
    if existing is not None:
        if existing.status == QualityImportBatch.Status.QUEUED:
            kick_quality_import_pump()
        return existing, True

    normalized_by_key: dict[str, dict[str, Any]] = {}
    normalized_total = 0
    cache_by_source_hash: dict[str, dict[str, Any]] = {}
    for key in required_keys:
        manifest_item = context.media_by_key[key]
        cached = cache_by_source_hash.get(manifest_item['source_sha256'])
        if cached is not None:
            normalized_by_key[key] = {**manifest_item, **cached}
            continue
        normalized = _read_uploaded_media(uploaded_files[key], manifest_item)
        normalized['storage_key'] = f'quality-import/assets/{normalized["sha256"]}'
        normalized_total += len(normalized['content'])
        if normalized_total > MAX_NORMALIZED_MEDIA_TOTAL_BYTES:
            raise _manifest_error(
                'normalized_images_too_large',
                'Normalized images exceed the aggregate safe limit.',
            )
        cached_values = {
            field: normalized[field]
            for field in (
                'content', 'sha256', 'source_sha256', 'byte_size', 'content_type',
                'extension', 'original_width', 'original_height', 'width', 'height',
                'storage_key',
            )
        }
        cache_by_source_hash[manifest_item['source_sha256']] = cached_values
        normalized_by_key[key] = normalized

    preview_rows = [_decision_row(decision, preview=True) for decision in decisions]
    images_ignored = sum(max(0, len(decision.media) - MAX_IMAGES_PER_REPORT) for decision in decisions)
    images_ignored += sum(
        len(decision.selected_media)
        for decision in decisions
        if decision.status == 'failed' and not decision.editable
    )
    now = timezone.now()
    with transaction.atomic():
        _lock_staging_capacity()
        existing = QualityImportBatch.objects.select_for_update().filter(
            sha256=context.source_sha256,
            import_scope_key=import_scope_key,
        ).first()
        if existing is not None:
            replay = True
            batch = existing
        else:
            replay = False
            batch = QualityImportBatch.objects.create(
                uploaded_by=uploaded_by,
                original_filename=context.filename,
                sha256=context.source_sha256,
                import_scope_key=import_scope_key,
                file_size=context.file_size,
                dataset_key=INCREMENTAL_JOB_DATASET_KEY,
                status=QualityImportBatch.Status.QUEUED,
                phase='queued',
                sheet_names=context.parsed.sheet_names,
                total_rows=len(decisions),
                total_media=len(required_keys),
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
                    'images_found': sum(len(decision.media) for decision in decisions),
                    'images_ignored': images_ignored,
                    'selected_row_keys': sorted(selected_row_keys),
                },
                results_persisted_at=now,
            )
            QualityImportProvenance.objects.create(
                batch=batch,
                source_sha256=context.source_sha256,
                source_content_type='application/vnd.wj.quality-manifest+json',
                source_filename=context.filename,
                source_byte_size=context.file_size,
                parser_name='quality_browser_manifest_v1',
                parser_version='1',
                workbook_properties=context.parsed.properties,
                source_discarded_at=now,
            )
            row_models: dict[str, QualityImportRow] = {}
            for decision in decisions:
                row_model = QualityImportRow.objects.create(
                    batch=batch,
                    **_quality_import_row_values(decision),
                )
                row_models[stable_source_key(decision.row)] = row_model

            pending_bytes = [_pending_staged_bytes()]
            assets_by_key: dict[str, QualityImportAsset] = {}
            new_asset_ids: set[int] = set()
            for key, item in normalized_by_key.items():
                asset, created = _stage_incremental_asset(
                    batch=batch,
                    item=item,
                    pending_bytes=pending_bytes,
                )
                assets_by_key[key] = asset
                if created:
                    new_asset_ids.add(asset.pk)

            for decision in decisions:
                if decision.status != 'new' and not decision.editable:
                    continue
                row_model = row_models[stable_source_key(decision.row)]
                for item in decision.selected_media:
                    normalized = normalized_by_key[item['key']]
                    QualityImportMedia.objects.create(
                        batch=batch,
                        row=row_model,
                        asset=assets_by_key[item['key']],
                        source_sheet_name=item['source_sheet_name'],
                        source_anchor_row=item['source_anchor_row'],
                        source_anchor_col=item['source_anchor_col'],
                        source_index=item['source_index'],
                        original_filename=item['original_filename'],
                        source_sha256=item['source_sha256'],
                        source_byte_size=item['original_byte_size'],
                        source_width=normalized['original_width'],
                        source_height=normalized['original_height'],
                        warnings=item.get('warnings') or [],
                    )
            unique_assets = set(assets_by_key.values())
            ready_assets = sum(
                asset.upload_state == QualityImportAsset.UploadState.READY
                for asset in unique_assets
            )
            batch.new_media_count = len(new_asset_ids)
            batch.reused_media_count = max(0, len(required_keys) - len(new_asset_ids))
            batch.progress_done = ready_assets
            batch.progress_total = len(unique_assets)
            batch.save(update_fields=[
                'new_media_count', 'reused_media_count', 'progress_done',
                'progress_total', 'updated_at',
            ])

        transaction.on_commit(kick_quality_import_pump)

    # Safe metadata-only writes for old direct imports do not perform remote I/O.
    _record_media_baselines(all_decisions)
    return batch, replay


def enqueue_quality_manifest(
    payload: Any,
    *,
    uploaded_files: Mapping[str, Any],
    uploaded_by,
    uploaded_on: date | None = None,
    selected_row_keys: set[str] | None = None,
) -> tuple[QualityImportBatch, bool]:
    """Retry one intake transaction when a concurrent idempotent write wins."""

    try:
        return _enqueue_quality_manifest_once(
            payload,
            uploaded_files=uploaded_files,
            uploaded_by=uploaded_by,
            uploaded_on=uploaded_on,
            selected_row_keys=selected_row_keys,
        )
    except IntegrityError:
        for upload in uploaded_files.values():
            seek = getattr(upload, 'seek', None)
            if callable(seek):
                seek(0)
        return _enqueue_quality_manifest_once(
            payload,
            uploaded_files=uploaded_files,
            uploaded_by=uploaded_by,
            uploaded_on=uploaded_on,
            selected_row_keys=selected_row_keys,
        )


def _upgrade_incremental_result_shape(value: Any) -> dict[str, Any] | None:
    """Backfill fields added after older terminal results were persisted."""

    if not isinstance(value, dict):
        return None
    raw_rows = value.get('rows')
    if not isinstance(raw_rows, list):
        return value
    defaults = {
        'row_key': '',
        'import_row_id': None,
        'editable': False,
        'failure_code': '',
        'validation_errors': [],
        'occurrence_location': '',
        'lot_qty': None,
        'inspection_qty': None,
        'defect_qty': None,
        'defect_rate': '',
        'judgement': '',
        'disposition': '',
        'action_result': '',
        'media_keys': [],
    }
    rows = []
    for row in raw_rows:
        if not isinstance(row, dict):
            rows.append(row)
            continue
        normalized = {**defaults, **row}
        if not normalized['row_key']:
            normalized['row_key'] = 'legacy:{sheet}:{number}:{sequence}'.format(
                sheet=normalized.get('sheet_name') or '',
                number=normalized.get('source_row_number') or 0,
                sequence=normalized.get('source_sequence') or '',
            )
        rows.append(normalized)
    return {**value, 'rows': rows}


def serialize_quality_import_job(batch: QualityImportBatch) -> dict[str, Any]:
    summary = batch.delta_summary or {}
    return {
        'id': batch.pk,
        'status': batch.status,
        'phase': batch.phase,
        'progress_done': batch.progress_done,
        'progress_total': batch.progress_total,
        'attempt_count': batch.attempt_count,
        'next_attempt_at': batch.next_attempt_at.isoformat() if batch.next_attempt_at else None,
        'filename': batch.original_filename,
        'total_rows': batch.total_rows,
        'result': _upgrade_incremental_result_shape(summary.get('incremental_result')),
        'warnings': list(batch.warnings or []),
    }


def _job_row_dict(row: QualityImportRow) -> dict[str, Any]:
    return {
        'sheet_name': row.sheet_name,
        'sheet_role': row.sheet_role,
        'source_row_number': row.source_row_number,
        'source_sequence': row.source_sequence,
        'business_key': row.business_key,
        'content_sha256': row.content_sha256,
        'report_date': row.report_date,
        'section': row.section,
        'occurrence_location': row.occurrence_location,
        'model': row.model,
        'part_no': row.part_no,
        'item_name': row.item_name,
        'lot_qty': row.lot_qty,
        'inspection_qty': row.inspection_qty,
        'defect_qty': row.defect_qty,
        'defect_rate': row.defect_rate,
        'judgement': row.judgement,
        'phenomenon': row.phenomenon,
        'disposition': row.disposition,
        'action_result': row.action_result,
        'raw_data': row.raw_data or {},
        'warnings': list(row.warnings or []),
    }


def _job_media_item(row: QualityImportRow, metadata: dict[str, Any]) -> dict[str, Any]:
    attachment_by_anchor = {
        (item.source_anchor_col, item.source_index, item.source_sha256): item
        for item in row.media.all()
    }
    attachment = attachment_by_anchor.get((
        int(metadata['source_anchor_col']),
        int(metadata['source_index']),
        str(metadata['source_sha256']),
    ))
    asset = attachment.asset if attachment is not None else None
    return {
        'key': metadata['key'],
        'source_sheet_name': row.sheet_name,
        'source_anchor_row': int(metadata['source_anchor_row']),
        'source_anchor_col': int(metadata['source_anchor_col']),
        'source_index': int(metadata['source_index']),
        'original_filename': metadata['original_filename'],
        'content_type': asset.content_type if asset else metadata['content_type'],
        'byte_size': asset.byte_size if asset else 0,
        'sha256': asset.sha256 if asset else str(metadata['source_sha256']),
        'source_sha256': str(metadata['source_sha256']),
        'original_byte_size': int(metadata['original_byte_size']),
        'storage_key': asset.storage_key if asset else '',
        'content': None,
        'extension': asset.extension if asset else '',
        'original_width': attachment.source_width if attachment else None,
        'original_height': attachment.source_height if attachment else None,
        'width': asset.width if asset else None,
        'height': asset.height if asset else None,
        'warnings': list(attachment.warnings or []) if attachment else [],
        '_asset': asset,
    }


def _job_result_payload(
    *,
    batch: QualityImportBatch,
    rows: list[dict[str, Any]],
    images_found: int,
    images_ignored: int,
) -> dict[str, Any]:
    created_ids = sorted({item['report_id'] for item in rows if item['status'] == 'created' and item['report_id']})
    skipped_ids = sorted({item['report_id'] for item in rows if item['status'] == 'skipped' and item['report_id']})
    changed_ids = sorted({item['report_id'] for item in rows if item['status'] == 'changed' and item['report_id']})
    return {
        'filename': batch.original_filename,
        'total_rows': len(rows),
        'created_count': sum(item['status'] == 'created' for item in rows),
        'skipped_count': sum(item['status'] == 'skipped' for item in rows),
        'changed_count': sum(item['status'] == 'changed' for item in rows),
        'failed_count': sum(item['status'] == 'failed' for item in rows),
        'images_found': images_found,
        'images_saved': sum(item['images_saved'] for item in rows),
        'images_failed': 0,
        'images_ignored': images_ignored,
        'images_skipped': sum(
            min(item['images_found'], MAX_IMAGES_PER_REPORT)
            for item in rows
            if item['status'] in {'skipped', 'changed'}
        ),
        'created_report_ids': created_ids,
        'skipped_report_ids': skipped_ids,
        'changed_report_ids': changed_ids,
        'warnings': sorted(set(batch.warnings or [])),
        'rows': sorted(
            rows,
            key=lambda item: (
                item['status'] != 'failed',
                item['sheet_name'],
                -item['source_row_number'],
            ),
        ),
    }


def update_incremental_result_after_publish(
    row: QualityImportRow,
    report: QualityReport,
) -> None:
    """Make a terminal incremental checkpoint reflect an inline-corrected row.

    Browser-direct prepare is idempotent and may replay the persisted terminal
    result.  Updating that checkpoint in the same transaction as publication
    prevents the original validation failure from reappearing on a same-file
    retry.
    """

    batch = QualityImportBatch.objects.select_for_update().get(pk=row.batch_id)
    if batch.dataset_key != INCREMENTAL_JOB_DATASET_KEY:
        return
    summary = dict(batch.delta_summary or {})
    result = _upgrade_incremental_result_shape(summary.get('incremental_result'))
    if not isinstance(result, dict) or not isinstance(result.get('rows'), list):
        return
    metadata = (row.raw_data or {}).get('_incremental_job') or {}
    row_key = str(metadata.get('row_key') or row.source_key or '')
    result_rows = [item for item in result['rows'] if isinstance(item, dict)]
    matched = any(
        item.get('import_row_id') == row.pk
        or (row_key and item.get('row_key') == row_key)
        for item in result_rows
    )
    if not matched:
        return

    attached_media = list(row.media.select_related('asset').order_by('source_index', 'id'))
    images_saved = sum(bool(item.asset_id and item.asset and item.asset.file) for item in attached_media)
    job_row = _job_row_dict(row)
    validation_messages = {
        str(item.get('message') or '')
        for item in (metadata.get('validation_errors') or [])
        if isinstance(item, dict)
    }
    corrected = RowDecision(
        row=job_row,
        media=[],
        selected_media=[],
        status='created',
        report=report,
        warnings=[
            warning
            for warning in (row.warnings or [])
            if warning not in validation_messages
        ],
        message='Registered after correcting input errors.',
    )
    corrected_payload = _decision_row(corrected, preview=False)
    corrected_payload.update({
        'import_row_id': row.pk,
        'row_key': row_key,
        'images_found': int(metadata.get('images_found') or len(attached_media)),
        'images_saved': images_saved,
        'media_keys': [
            str(item.get('key'))
            for item in (metadata.get('media') or [])
            if isinstance(item, dict) and item.get('key')
        ],
    })
    updated_rows = [
        corrected_payload
        if (
            item.get('import_row_id') == row.pk
            or (row_key and item.get('row_key') == row_key)
        )
        else item
        for item in result_rows
    ]
    summary['incremental_result'] = _job_result_payload(
        batch=batch,
        rows=updated_rows,
        images_found=int(result.get('images_found') or 0),
        images_ignored=int(result.get('images_ignored') or 0),
    )
    batch.delta_summary = summary
    batch.results_persisted_at = timezone.now()
    batch.save(update_fields=['delta_summary', 'results_persisted_at', 'updated_at'])


def finalize_quality_import_job(batch_id: int, owner: str) -> dict[str, Any]:
    """Create reports after every staged asset is durable; safe to retry."""

    batch = QualityImportBatch.objects.select_related('uploaded_by').get(pk=batch_id)
    if batch.dataset_key != INCREMENTAL_JOB_DATASET_KEY:
        raise _manifest_error('invalid_job', 'The batch is not an incremental registration job.')
    if batch.status != QualityImportBatch.Status.PROCESSING or batch.processing_owner != owner:
        raise _manifest_error('processing_lease_lost', 'The registration lease was lost.')
    existing_result = (batch.delta_summary or {}).get('incremental_result')
    if isinstance(existing_result, dict):
        return existing_result

    QualityImportBatch.objects.filter(pk=batch.pk, processing_owner=owner).update(
        phase='registering_reports',
        last_heartbeat_at=timezone.now(),
    )
    row_models = list(
        QualityImportRow.objects.filter(batch=batch)
        .select_related('approved_report')
        .prefetch_related('media__asset')
        .order_by('sheet_name', 'source_row_number', 'id')
    )
    parsed_rows = [_job_row_dict(row) for row in row_models]
    media: list[dict[str, Any]] = []
    media_by_row_id: dict[int, list[dict[str, Any]]] = {}
    for row in row_models:
        metadata = (row.raw_data or {}).get('_incremental_job') or {}
        row_media = [
            _job_media_item(row, item)
            for item in (metadata.get('media') or [])
            if isinstance(item, dict)
        ]
        media_by_row_id[row.pk] = row_media
        media.extend(row_media)
    parsed = ParsedWorkbook(
        sheet_names=list(batch.sheet_names or []),
        properties={},
        rows=parsed_rows,
        media=media,
        warnings=list(batch.warnings or []),
    )
    context = ManifestContext(
        filename=batch.original_filename,
        file_size=batch.file_size,
        source_sha256=batch.sha256,
        parsed=parsed,
        media_by_key={item['key']: item for item in media},
    )
    decisions = _classify(context) if parsed_rows else []
    decision_by_row_key = {
        stable_source_key(decision.row): decision
        for decision in decisions
    }
    result_rows: list[dict[str, Any]] = []

    for row_model, row in zip(row_models, parsed_rows):
        row_key = stable_source_key(row)
        decision = decision_by_row_key[row_key]
        selected_media = media_by_row_id[row_model.pk]
        metadata = (row_model.raw_data or {}).get('_incremental_job') or {}
        images_found = int(metadata.get('images_found') or len(selected_media))

        if row_model.approved_report_id:
            report = row_model.approved_report
            checkpoint = RowDecision(
                row=row,
                media=decision.media,
                selected_media=selected_media,
                status='created',
                report=report,
                warnings=decision.warnings,
                message='Registered.',
            )
            payload = _decision_row(checkpoint, preview=False)
            payload['images_found'] = images_found
            payload['images_saved'] = len(selected_media)
            payload['import_row_id'] = row_model.pk
            result_rows.append(payload)
            continue

        if decision.status != 'new':
            payload = _decision_row(decision, preview=False)
            payload['images_found'] = images_found
            payload['images_saved'] = (
                len(selected_media)
                if decision.editable
                else 0
            )
            payload['import_row_id'] = row_model.pk
            result_rows.append(payload)
            continue

        image_urls: list[str | None] = []
        for item in selected_media:
            asset = item.get('_asset')
            if (
                asset is None
                or asset.upload_state != QualityImportAsset.UploadState.READY
                or not asset.file
            ):
                raise _manifest_error(
                    'normalized_checkpoint_incomplete',
                    'A report image did not reach durable storage.',
                )
            image_urls.append(asset.file.url)
        clean_media = [
            {key: value for key, value in item.items() if key != '_asset'}
            for item in selected_media
        ]
        values = _report_values(
            row,
            image_urls=image_urls,
            filename=batch.original_filename,
            source_sha256=batch.sha256,
            uploaded_by=batch.uploaded_by,
            media_items=clean_media,
        )
        try:
            with transaction.atomic():
                # ``approved_report`` is nullable.  Keep it out of the locking
                # query because PostgreSQL cannot apply a bare ``FOR UPDATE``
                # to the nullable side of the resulting outer join.
                locked_row = QualityImportRow.objects.select_for_update().get(pk=row_model.pk)
                if locked_row.approved_report_id:
                    report = locked_row.approved_report
                else:
                    report = QualityReport.objects.create(**values)
                    locked_row.approved_report = report
                    locked_row.review_status = QualityImportRow.ReviewStatus.PUBLISHED
                    locked_row.reviewed_by = batch.uploaded_by
                    locked_row.reviewed_at = timezone.now()
                    locked_row.published_at = timezone.now()
                    locked_row.save(update_fields=[
                        'approved_report', 'review_status', 'reviewed_by',
                        'reviewed_at', 'published_at', 'updated_at',
                    ])
        except IntegrityError:
            report = QualityReport.objects.filter(excel_import_key=row['business_key']).first()
            if report is None:
                raise
            differences = _concurrent_report_differences(
                report,
                row,
                clean_media,
                source_sha256=batch.sha256,
            )
            conflict = RowDecision(
                row=row,
                media=decision.media,
                selected_media=selected_media,
                status='changed' if differences else 'unchanged',
                report=report,
                warnings=[*decision.warnings, 'existing_match:concurrent_job', *differences],
                message=(
                    'Another request registered a different version; review it before applying changes.'
                    if differences
                    else 'Existing report was created by another request and skipped.'
                ),
            )
            payload = _decision_row(conflict, preview=False)
            payload['images_found'] = images_found
            result_rows.append(payload)
            continue

        created = RowDecision(
            row=row,
            media=decision.media,
            selected_media=selected_media,
            status='created',
            report=report,
            warnings=decision.warnings,
            message='Registered.',
        )
        payload = _decision_row(created, preview=False)
        payload['images_found'] = images_found
        payload['images_saved'] = len(selected_media)
        payload['import_row_id'] = row_model.pk
        result_rows.append(payload)

    _record_media_baselines(decisions)
    summary = batch.delta_summary or {}
    result = _job_result_payload(
        batch=batch,
        rows=result_rows,
        images_found=int(summary.get('images_found') or 0),
        images_ignored=int(summary.get('images_ignored') or 0),
    )
    with transaction.atomic():
        locked_batch = QualityImportBatch.objects.select_for_update().get(pk=batch.pk)
        if locked_batch.processing_owner != owner:
            raise _manifest_error('processing_lease_lost', 'The registration lease was lost.')
        locked_summary = dict(locked_batch.delta_summary or {})
        locked_summary['incremental_result'] = result
        locked_batch.delta_summary = locked_summary
        locked_batch.results_persisted_at = timezone.now()
        locked_batch.save(update_fields=['delta_summary', 'results_persisted_at', 'updated_at'])
    return result


def commit_quality_manifest(
    payload: Any,
    *,
    uploaded_files: Mapping[str, Any],
    uploaded_by,
    uploaded_on: date | None = None,
    selected_row_keys: set[str] | None = None,
) -> dict[str, Any]:
    context = _validate_manifest(payload, uploaded_on=uploaded_on or date.today())
    _ensure_monthly_direct_scope(context)
    all_decisions = _classify(context)
    decisions_by_key = {
        stable_source_key(decision.row): decision
        for decision in all_decisions
    }
    if selected_row_keys is not None:
        unknown_row_keys = selected_row_keys - set(decisions_by_key)
        if unknown_row_keys:
            raise _manifest_error('invalid_row_selection', 'Commit references an unknown workbook row.')
        decisions = [
            decision for decision in all_decisions
            if stable_source_key(decision.row) in selected_row_keys
        ]
    else:
        decisions = all_decisions
    if len(decisions) > MAX_COMMIT_ROWS:
        raise _manifest_error(
            'commit_too_large',
            f'Commit may contain at most {MAX_COMMIT_ROWS} workbook rows.',
        )
    required_keys = {
        item['key']
        for decision in decisions
        if decision.status == 'new'
        for item in decision.selected_media
    }
    selected_media_keys = {
        item['key']
        for decision in decisions
        for item in decision.selected_media
    }
    provided_keys = set(uploaded_files)
    if len(required_keys) > MAX_COMMIT_MEDIA_ITEMS or len(provided_keys) > MAX_COMMIT_MEDIA_ITEMS:
        raise _manifest_error(
            'commit_too_large',
            f'Commit may contain at most {MAX_COMMIT_MEDIA_ITEMS} images.',
        )
    provided_bytes = sum(
        max(0, int(getattr(upload, 'size', 0) or 0))
        for upload in uploaded_files.values()
    )
    if provided_bytes > MAX_COMMIT_MEDIA_BYTES:
        raise _manifest_error(
            'commit_too_large',
            'Uploaded images exceed the 20 MiB request limit.',
        )
    required_bytes = sum(
        int(context.media_by_key[key]['original_byte_size'])
        for key in required_keys
    )
    if required_bytes > MAX_COMMIT_MEDIA_BYTES:
        raise _manifest_error(
            'commit_too_large',
            'Commit images exceed the 20 MiB request limit.',
        )
    if provided_keys - selected_media_keys:
        raise _manifest_error('unexpected_media', 'Commit contains media that is not required.')
    missing_keys = required_keys - provided_keys
    if missing_keys:
        raise _manifest_error('missing_media', 'One or more required images were not uploaded.')

    normalized_by_key: dict[str, dict[str, Any]] = {}
    normalized_total = 0
    cache_by_source_hash: dict[str, dict[str, Any]] = {}
    for key in required_keys:
        upload = uploaded_files.get(key)
        if upload is None:
            raise _manifest_error('missing_media', 'A required image was not uploaded.')
        manifest_item = context.media_by_key[key]
        cached = cache_by_source_hash.get(manifest_item['source_sha256'])
        if cached is not None:
            normalized_by_key[key] = {**manifest_item, **cached}
            continue
        normalized = _read_uploaded_media(upload, manifest_item)
        normalized_total += len(normalized['content'])
        if normalized_total > MAX_NORMALIZED_MEDIA_TOTAL_BYTES:
            raise _manifest_error(
                'normalized_images_too_large',
                'Normalized images exceed the aggregate safe limit.',
            )
        cached_values = {
            field: normalized[field]
            for field in (
                'content', 'sha256', 'source_sha256', 'byte_size', 'content_type',
                'extension', 'original_width', 'original_height', 'width', 'height',
            )
        }
        cache_by_source_hash[manifest_item['source_sha256']] = cached_values
        normalized_by_key[key] = normalized

    unlinked = _unlinked_media_count(context)
    results: list[dict[str, Any]] = []
    created_report_ids: list[int] = []
    skipped_report_ids: list[int] = []
    changed_report_ids: list[int] = []
    images_saved = 0
    images_failed = 0
    images_skipped = 0
    images_ignored = unlinked if selected_row_keys is None else 0
    prepared: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []

    for decision in decisions:
        over_limit = max(0, len(decision.media) - MAX_IMAGES_PER_REPORT)
        images_ignored += over_limit
        if decision.status == 'unchanged':
            if decision.report:
                skipped_report_ids.append(decision.report.pk)
            images_skipped += len(decision.selected_media)
            results.append(_decision_row(decision, preview=False))
        elif decision.status == 'changed':
            if decision.report:
                changed_report_ids.append(decision.report.pk)
            images_skipped += len(decision.selected_media)
            results.append(_decision_row(decision, preview=False))
        elif decision.status == 'failed':
            images_ignored += len(decision.selected_media)
            results.append(_decision_row(decision, preview=False))
        else:
            keys = [item['key'] for item in decision.selected_media]
            prepared.append((
                decision.row,
                [normalized_by_key[key] for key in keys],
            ))

    selected_items = [item for _row, items in prepared for item in items]
    if selected_items and not quality_import_media_upload_available():
        raise _manifest_error(
            'production_storage_required',
            'Cloudinary image storage is required for Excel quality imports in production.',
        )

    run_id = uuid.uuid4().hex
    for prepared_index, image_urls, image_failures in _iter_row_image_results(run_id, prepared):
        row, selected_media = prepared[prepared_index]
        all_media = _media_by_row(context.parsed).get((row['sheet_name'], row['source_row_number']), [])
        row_warnings = list(row.get('warnings') or [])
        if len(all_media) > MAX_IMAGES_PER_REPORT:
            row_warnings.append(f'images_over_limit:{len(all_media) - MAX_IMAGES_PER_REPORT}')
        if any(url is None for url in image_urls):
            images_failed += len(selected_media)
            row_warnings.extend(image_failures)
            failed_decision = RowDecision(
                row=row,
                media=all_media,
                selected_media=selected_media,
                status='failed',
                report=None,
                warnings=row_warnings,
                message='One or more images could not be stored; this row was not registered.',
            )
            results.append(_decision_row(failed_decision, preview=False))
            continue
        values = _report_values(
            row,
            image_urls=image_urls,
            filename=context.filename,
            source_sha256=context.source_sha256,
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
            images_skipped += len(selected_media)
            differences = _concurrent_report_differences(
                report,
                row,
                selected_media,
                source_sha256=context.source_sha256,
            )
            if differences:
                changed_report_ids.append(report.pk)
                concurrent_decision = RowDecision(
                    row=row,
                    media=all_media,
                    selected_media=selected_media,
                    status='changed',
                    report=report,
                    warnings=[
                        *row_warnings,
                        'existing_match:concurrent_commit',
                        *differences,
                    ],
                    message='Another request registered a different version; review it before applying changes.',
                )
            else:
                skipped_report_ids.append(report.pk)
                concurrent_decision = RowDecision(
                    row=row,
                    media=all_media,
                    selected_media=selected_media,
                    status='unchanged',
                    report=report,
                    warnings=[*row_warnings, 'existing_match:concurrent_commit'],
                    message='Existing report was created by another request and skipped.',
                )
            results.append(_decision_row(concurrent_decision, preview=False))
            continue
        except Exception:
            images_failed += len(selected_media)
            LOGGER.exception(
                'Quality incremental row registration failed sheet=%s row=%s',
                row['sheet_name'],
                row['source_row_number'],
            )
            failed_decision = RowDecision(
                row=row,
                media=all_media,
                selected_media=selected_media,
                status='failed',
                report=None,
                warnings=[*row_warnings, 'database_registration_failed'],
                message='Database registration failed for this row.',
            )
            results.append(_decision_row(failed_decision, preview=False))
            continue

        saved_for_row = sum(bool(url) for url in image_urls)
        images_saved += saved_for_row
        created_report_ids.append(report.pk)
        created_decision = RowDecision(
            row=row,
            media=all_media,
            selected_media=selected_media,
            status='created',
            report=report,
            warnings=row_warnings,
            message='Registered.',
        )
        row_payload = _decision_row(created_decision, preview=False)
        row_payload['images_saved'] = saved_for_row
        results.append(row_payload)

    # The full manifest is authenticated by the same editor and was parsed
    # canonically above, so an empty/small row chunk can still establish
    # missing fingerprints for unchanged legacy direct-import metadata.
    _record_media_baselines(all_decisions)
    results.sort(key=lambda item: (item['sheet_name'], item['source_row_number']))
    return {
        'filename': context.filename,
        'total_rows': len(decisions),
        'created_count': sum(item['status'] == 'created' for item in results),
        'skipped_count': sum(item['status'] == 'skipped' for item in results),
        'changed_count': sum(item['status'] == 'changed' for item in results),
        'failed_count': sum(item['status'] == 'failed' for item in results),
        'images_found': sum(len(decision.media) for decision in decisions),
        'images_saved': images_saved,
        'images_failed': images_failed,
        'images_ignored': images_ignored,
        'images_skipped': images_skipped,
        'created_report_ids': list(dict.fromkeys(created_report_ids)),
        'skipped_report_ids': list(dict.fromkeys(skipped_report_ids)),
        'changed_report_ids': list(dict.fromkeys(changed_report_ids)),
        'warnings': context.parsed.warnings,
        'rows': results,
    }
