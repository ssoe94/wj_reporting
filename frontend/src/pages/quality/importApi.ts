import type { AxiosProgressEvent } from 'axios';
import api from '../../lib/api';
import type { QualityExcelImportProgress, QualityExcelImportResult } from './importTypes';

export const QUALITY_IMPORT_MAX_FILE_BYTES = 80 * 1024 * 1024;

type UploadProgressCallback = (progress: QualityExcelImportProgress) => void;

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

export async function uploadQualityExcel(
  file: File,
  onProgress?: UploadProgressCallback,
): Promise<QualityExcelImportResult> {
  const formData = new FormData();
  formData.append('file', file);

  emitUploadProgress(onProgress, 0, file.size);
  const response = await api.post<QualityExcelImportResult>('/quality/excel-import/', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 5 * 60 * 1000,
    onUploadProgress: (event: AxiosProgressEvent) => {
      emitUploadProgress(onProgress, Math.min(event.loaded, file.size), file.size);
    },
  });
  emitUploadProgress(onProgress, file.size, file.size);
  return response.data;
}
