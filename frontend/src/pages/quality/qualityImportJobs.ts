import type {
  QualityCloudinaryUploadReceipt,
  QualityExcelImportPreview,
} from './importTypes';

const STORAGE_KEY = 'quality-excel-import-jobs:v2';
const LEGACY_STORAGE_KEY = 'quality-excel-import-jobs:v1';

export interface PersistedQualityImportChunk {
  rowKeys: string[];
  mediaKeys: string[];
  jobId: number | null;
  receipts: PersistedQualityImportReceipt[];
}

export interface PersistedQualityImportReceipt extends QualityCloudinaryUploadReceipt {
  assetSha256: string;
}

export interface PersistedQualityImportWorkflow {
  version: 2;
  deliveryMode: 'browser_direct';
  filename: string;
  workbookSha256: string;
  selectedSheetName: string;
  preview: QualityExcelImportPreview;
  chunks: PersistedQualityImportChunk[];
  acceptedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPersistedReceipt(value: unknown, jobId: number | null): value is PersistedQualityImportReceipt {
  if (!isRecord(value) || jobId == null || typeof value.assetSha256 !== 'string') return false;
  const expectedPublicId = new RegExp(
    `^(?:media/)?quality-import/pending/${jobId}/${value.assetSha256}-[0-9a-f]{24}$`,
  );
  return /^[0-9a-f]{64}$/.test(value.assetSha256)
    && typeof value.public_id === 'string'
    && expectedPublicId.test(value.public_id)
    && Number.isSafeInteger(value.version)
    && Number(value.version) > 0
    && typeof value.signature === 'string'
    && value.signature.length > 0
    && value.signature.length <= 256;
}

function isPersistedWorkflow(value: unknown): value is PersistedQualityImportWorkflow {
  if (
    !isRecord(value)
    || value.version !== 2
    || value.deliveryMode !== 'browser_direct'
    || typeof value.filename !== 'string'
    || !/^[0-9a-f]{64}$/.test(String(value.workbookSha256 || ''))
    || typeof value.selectedSheetName !== 'string'
    || typeof value.acceptedAt !== 'string'
    || !isRecord(value.preview)
    || value.preview.version !== 'quality-incremental-v1'
    || value.preview.filename !== value.filename
    || !Array.isArray(value.preview.rows)
    || !Array.isArray(value.chunks)
  ) return false;

  return value.chunks.length > 0 && value.chunks.every((chunk) => {
    if (!isRecord(chunk)) return false;
    const jobId = chunk.jobId === null
      ? null
      : Number.isSafeInteger(chunk.jobId) && Number(chunk.jobId) > 0
        ? Number(chunk.jobId)
        : -1;
    return jobId !== -1
      && isStringArray(chunk.rowKeys)
      && new Set(chunk.rowKeys).size === chunk.rowKeys.length
      && isStringArray(chunk.mediaKeys)
      && new Set(chunk.mediaKeys).size === chunk.mediaKeys.length
      && Array.isArray(chunk.receipts)
      && chunk.receipts.length <= chunk.mediaKeys.length
      && chunk.receipts.every((receipt) => isPersistedReceipt(receipt, jobId))
      && new Set(chunk.receipts.map((receipt) => receipt.assetSha256)).size === chunk.receipts.length;
  });
}

export function loadQualityImportWorkflow(): PersistedQualityImportWorkflow | null {
  try {
    // v1 depended on a backend worker and automatic polling. It must never be
    // resumed by the browser-direct flow.
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isPersistedWorkflow(parsed)) return parsed;
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // active in-memory workflow continues; recovery then requires reselecting
    // and rescanning the same workbook in the current page.
  }
  return null;
}

export function saveQualityImportWorkflow(workflow: PersistedQualityImportWorkflow): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(workflow));
  } catch {
    // Persistence is a recovery aid, not a prerequisite for direct delivery.
  }
}

export function clearQualityImportWorkflow(workbookSha256?: string): void {
  try {
    if (workbookSha256) {
      const current = loadQualityImportWorkflow();
      if (current && current.workbookSha256 !== workbookSha256) return;
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // No-op when session storage is unavailable.
  }
}

export function acceptedQualityImportJobIds(
  workflow: PersistedQualityImportWorkflow,
): number[] {
  return workflow.chunks.flatMap((chunk) => chunk.jobId == null ? [] : [chunk.jobId]);
}
