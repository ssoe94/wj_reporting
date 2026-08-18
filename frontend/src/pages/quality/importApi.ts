import type { AxiosProgressEvent } from 'axios';
import api from '../../lib/api';
import type {
  QualityExcelImportPreview,
  QualityExcelImportProgress,
  QualityExcelImportResult,
  QualityWorkbookManifest,
} from './importTypes';

export const QUALITY_IMPORT_MAX_FILE_BYTES = 80 * 1024 * 1024;

type UploadProgressCallback = (progress: QualityExcelImportProgress) => void;

function isJsonResponse(contentType: unknown): boolean {
  return /\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(String(contentType || ''));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isIdArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.every((item) => Number.isSafeInteger(item) && item > 0);
}

function isOptionalReportId(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isImportRow(value: unknown, statuses: ReadonlySet<string>): boolean {
  return isRecord(value)
    && typeof value.row_key === 'string'
    && typeof value.sheet_name === 'string'
    && isCount(value.source_row_number)
    && typeof value.source_sequence === 'string'
    && typeof value.status === 'string'
    && statuses.has(value.status)
    && isOptionalReportId(value.report_id)
    && isOptionalString(value.report_date)
    && typeof value.section === 'string'
    && typeof value.model === 'string'
    && typeof value.part_no === 'string'
    && typeof value.phenomenon === 'string'
    && isCount(value.images_found)
    && isCount(value.images_saved)
    && isStringArray(value.media_keys)
    && isStringArray(value.warnings)
    && typeof value.message === 'string';
}

const PREVIEW_STATUSES = new Set(['new', 'unchanged', 'changed', 'failed']);
const COMMIT_STATUSES = new Set(['created', 'skipped', 'changed', 'failed']);

function assertPreviewResponse(value: unknown, contentType: unknown): asserts value is QualityExcelImportPreview {
  if (
    !isJsonResponse(contentType)
    || !isRecord(value)
    || value.version !== 'quality-incremental-v1'
    || typeof value.filename !== 'string'
    || !isCount(value.total_rows)
    || !isCount(value.new_count)
    || !isCount(value.unchanged_count)
    || !isCount(value.changed_count)
    || !isCount(value.failed_count)
    || !isCount(value.images_found)
    || !isCount(value.images_to_upload)
    || !isCount(value.images_ignored)
    || !isStringArray(value.required_media_keys)
    || !isStringArray(value.warnings)
    || !Array.isArray(value.rows)
    || !value.rows.every((row) => isImportRow(row, PREVIEW_STATUSES))
  ) {
    throw new Error('서버의 Excel 비교 응답 형식이 올바르지 않습니다. 잠시 후 다시 시도해 주세요.');
  }
}

function assertCommitResponse(value: unknown, contentType: unknown): asserts value is QualityExcelImportResult {
  if (
    !isJsonResponse(contentType)
    || !isRecord(value)
    || typeof value.filename !== 'string'
    || !isCount(value.total_rows)
    || !isCount(value.created_count)
    || !isCount(value.skipped_count)
    || !isCount(value.changed_count)
    || !isCount(value.failed_count)
    || !isCount(value.images_found)
    || !isCount(value.images_saved)
    || !isCount(value.images_failed)
    || !isCount(value.images_ignored)
    || !isCount(value.images_skipped)
    || !isIdArray(value.created_report_ids)
    || !isIdArray(value.skipped_report_ids)
    || !isIdArray(value.changed_report_ids)
    || !isStringArray(value.warnings)
    || !Array.isArray(value.rows)
    || !value.rows.every((row) => isImportRow(row, COMMIT_STATUSES))
  ) {
    throw new Error('서버의 Excel 등록 응답 형식이 올바르지 않습니다. 다시 시도하면 완료된 건은 건너뜁니다.');
  }
}

function emitUploadProgress(
  callback: UploadProgressCallback | undefined,
  uploadedBytes: number,
  totalBytes: number,
): void {
  callback?.({
    uploadedBytes,
    totalBytes,
    percent: totalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)))
      : 0,
  });
}

export async function previewQualityExcel(
  manifest: QualityWorkbookManifest,
): Promise<QualityExcelImportPreview> {
  const response = await api.post<QualityExcelImportPreview>(
    '/quality/excel-import/preview/',
    manifest,
    { timeout: 60_000 },
  );
  assertPreviewResponse(response.data, response.headers['content-type']);
  return response.data;
}

export async function commitQualityExcel(
  manifest: QualityWorkbookManifest,
  media: Map<string, Blob>,
  rowKeys: readonly string[],
  onProgress?: UploadProgressCallback,
): Promise<QualityExcelImportResult> {
  const formData = new FormData();
  const serializedManifest = JSON.stringify(manifest);
  formData.append('manifest', serializedManifest);
  formData.append('row_keys', JSON.stringify(rowKeys));

  const mediaByKey = new Map(manifest.media.map((item) => [item.key, item]));
  let totalBytes = new TextEncoder().encode(serializedManifest).byteLength;
  for (const [key, blob] of media) {
    const item = mediaByKey.get(key);
    if (!item) throw new Error(`Unknown workbook media key: ${key}`);
    formData.append(`media_${key}`, blob, item.original_filename);
    totalBytes += blob.size;
  }

  emitUploadProgress(onProgress, 0, totalBytes);
  const response = await api.post<QualityExcelImportResult>(
    '/quality/excel-import/commit/',
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 2 * 60 * 1000,
      onUploadProgress: (event: AxiosProgressEvent) => {
        emitUploadProgress(onProgress, Math.min(event.loaded, totalBytes), totalBytes);
      },
    },
  );
  assertCommitResponse(response.data, response.headers['content-type']);
  emitUploadProgress(onProgress, totalBytes, totalBytes);
  return response.data;
}
