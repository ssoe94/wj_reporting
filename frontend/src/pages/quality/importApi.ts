import type { AxiosProgressEvent } from 'axios';
import api from '../../lib/api';
import type {
  QualityImportBatch,
  QualityImportClientUploadProgress,
  QualityImportPage,
  QualityImportRow,
  QualityImportRowFilters,
  QualityImportRowUpdate,
  QualityImportUploadResult,
} from './importTypes';

const IMPORT_BATCHES_PATH = '/quality/import-batches/';
export const QUALITY_IMPORT_MAX_FILE_BYTES = 80 * 1024 * 1024;

type UploadProgressCallback = (progress: QualityImportClientUploadProgress) => void;

function normalizePage<T>(payload: QualityImportPage<T> | T[]): QualityImportPage<T> {
  if (Array.isArray(payload)) {
    return {
      count: payload.length,
      next: null,
      previous: null,
      results: payload,
    };
  }
  return payload;
}

function toPercent(completedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completedBytes / totalBytes) * 100)));
}

function emitUploadProgress(
  callback: UploadProgressCallback | undefined,
  progress: Omit<QualityImportClientUploadProgress, 'percent'>,
): void {
  callback?.({
    ...progress,
    percent: toPercent(progress.uploadedBytes, progress.totalBytes),
  });
}

export async function uploadQualityImportBatch(
  file: File,
  onProgress?: UploadProgressCallback,
): Promise<QualityImportUploadResult> {
  if (file.size <= 0) throw new Error('The selected workbook is empty.');
  if (file.size > QUALITY_IMPORT_MAX_FILE_BYTES) {
    throw new Error('The workbook exceeds the 80 MB upload limit.');
  }

  const formData = new FormData();
  formData.append('file', file);
  emitUploadProgress(onProgress, {
    uploadedBytes: 0,
    totalBytes: file.size,
  });
  const response = await api.post<QualityImportBatch>(IMPORT_BATCHES_PATH, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 5 * 60 * 1000,
    onUploadProgress: (event: AxiosProgressEvent) => {
      emitUploadProgress(onProgress, {
        uploadedBytes: Math.min(event.loaded, file.size),
        totalBytes: file.size,
      });
    },
  });
  emitUploadProgress(onProgress, {
    uploadedBytes: file.size,
    totalBytes: file.size,
  });
  return {
    batch: response.data,
    alreadyAccepted: Boolean(response.data.idempotent_replay),
  };
}

export async function listQualityImportBatches(): Promise<QualityImportPage<QualityImportBatch>> {
  const response = await api.get<QualityImportPage<QualityImportBatch> | QualityImportBatch[]>(
    IMPORT_BATCHES_PATH,
  );
  return normalizePage(response.data);
}

export async function getQualityImportBatch(id: number): Promise<QualityImportBatch> {
  const response = await api.get<QualityImportBatch>(`${IMPORT_BATCHES_PATH}${id}/`);
  return response.data;
}

export async function retryQualityImportBatch(id: number): Promise<QualityImportBatch> {
  const response = await api.post<QualityImportBatch>(`${IMPORT_BATCHES_PATH}${id}/retry/`, {});
  return response.data;
}

export async function listQualityImportRows(
  batchId: number,
  filters: QualityImportRowFilters,
): Promise<QualityImportPage<QualityImportRow>> {
  const response = await api.get<QualityImportPage<QualityImportRow> | QualityImportRow[]>(
    `${IMPORT_BATCHES_PATH}${batchId}/rows/`,
    {
      params: {
        page: filters.page ?? 1,
        page_size: filters.pageSize ?? 20,
        sheet_name: filters.sheetName || undefined,
        review_status: filters.reviewStatus || undefined,
        delta_status: filters.deltaStatus || undefined,
      },
    },
  );
  return normalizePage(response.data);
}

export async function updateQualityImportRow(
  rowId: number,
  payload: QualityImportRowUpdate,
): Promise<QualityImportRow> {
  const response = await api.patch<QualityImportRow>(`/quality/import-rows/${rowId}/`, payload);
  return response.data;
}

export async function publishQualityImportRow(
  rowId: number,
  options: { confirmDuplicate?: boolean; duplicateReason?: string } = {},
): Promise<QualityImportRow & { idempotent_replay: boolean; updated_existing_report?: boolean }> {
  const response = await api.post<QualityImportRow & { idempotent_replay: boolean; updated_existing_report?: boolean }>(
    `/quality/import-rows/${rowId}/publish/`,
    options.confirmDuplicate
      ? { confirm_duplicate: true, duplicate_reason: options.duplicateReason?.trim() || '' }
      : {},
  );
  return response.data;
}

/**
 * Import media is served by an authenticated API endpoint. Loading it through
 * axios ensures the normal JWT interceptor is applied before it becomes an
 * object URL suitable for an <img> element.
 */
export async function getQualityImportMediaObjectUrl(url: string): Promise<string> {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url);
    const isImportMediaApi = parsed.pathname.includes('/api/quality/import-media/');
    if (parsed.origin !== window.location.origin && !isImportMediaApi) return url;
    url = `${parsed.pathname}${parsed.search}`;
  }
  const apiPath = url.startsWith('/api/') ? url.slice('/api'.length) : url;
  const response = await api.get<Blob>(apiPath, {
    responseType: 'blob',
    timeout: 60 * 1000,
  });
  return URL.createObjectURL(response.data);
}
