import axios from 'axios';
import { getQualityExcelJob } from './importApi';
import type {
  QualityExcelImportJob,
  QualityExcelImportJobProgress,
  QualityExcelImportPreview,
} from './importTypes';

const STORAGE_KEY = 'quality-excel-import-jobs:v1';
const TERMINAL_STATUSES = new Set(['ready', 'ready_with_warnings', 'failed']);
const POLL_INTERVAL_MS = 1_500;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export interface PersistedQualityImportChunk {
  rowKeys: string[];
  mediaKeys: string[];
  jobId: number | null;
}

export interface PersistedQualityImportWorkflow {
  version: 1;
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

function isPersistedWorkflow(value: unknown): value is PersistedQualityImportWorkflow {
  if (
    !isRecord(value)
    || value.version !== 1
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

  return value.chunks.length > 0 && value.chunks.every((chunk) => (
    isRecord(chunk)
    && isStringArray(chunk.rowKeys)
    && isStringArray(chunk.mediaKeys)
    && (
      chunk.jobId === null
      || (Number.isSafeInteger(chunk.jobId) && Number(chunk.jobId) > 0)
    )
  ));
}

export function loadQualityImportWorkflow(): PersistedQualityImportWorkflow | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isPersistedWorkflow(parsed)) return parsed;
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // active in-memory workflow continues even when recovery cannot persist.
  }
  return null;
}

export function saveQualityImportWorkflow(workflow: PersistedQualityImportWorkflow): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(workflow));
  } catch {
    // See loadQualityImportWorkflow: persistence is a recovery aid, not a
    // prerequisite for accepting the upload in the current tab.
  }
}

export function clearQualityImportWorkflow(workbookSha256?: string): void {
  try {
    if (workbookSha256) {
      const current = loadQualityImportWorkflow();
      if (current && current.workbookSha256 !== workbookSha256) return;
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // No-op when session storage is unavailable.
  }
}

export function acceptedQualityImportJobIds(
  workflow: PersistedQualityImportWorkflow,
): number[] {
  return workflow.chunks.flatMap((chunk) => chunk.jobId == null ? [] : [chunk.jobId]);
}

export function isQualityImportFullyAccepted(workflow: PersistedQualityImportWorkflow): boolean {
  return workflow.chunks.every((chunk) => chunk.jobId != null);
}

function aggregateProgress(jobs: readonly QualityExcelImportJob[]): QualityExcelImportJobProgress {
  const active = jobs.find((job) => job.status === 'processing')
    || jobs.find((job) => job.status === 'queued')
    || jobs.find((job) => job.status === 'failed')
    || jobs[jobs.length - 1];
  return {
    acceptedJobs: jobs.length,
    totalJobs: jobs.length,
    completedJobs: jobs.filter((job) => TERMINAL_STATUSES.has(job.status)).length,
    phase: active?.phase || 'queued',
    progressDone: jobs.reduce((total, job) => total + job.progress_done, 0),
    progressTotal: jobs.reduce((total, job) => total + job.progress_total, 0),
  };
}

function waitForNextPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Polling aborted.', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException('Polling aborted.', 'AbortError'));
    };
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForQualityImportJobs(
  jobIds: readonly number[],
  onProgress?: (progress: QualityExcelImportJobProgress) => void,
  signal?: AbortSignal,
): Promise<QualityExcelImportJob[]> {
  const uniqueJobIds = [...new Set(jobIds)];
  if (uniqueJobIds.length === 0) throw new Error('접수된 Excel 작업이 없습니다.');

  const jobsById = new Map<number, QualityExcelImportJob>();
  // The backend deliberately processes one durable batch at a time. Polling
  // one accepted job through its terminal state before moving to the next
  // avoids multiplying status traffic by the number of workbook chunks.
  for (const jobId of uniqueJobIds) {
    let consecutiveFailures = 0;
    while (true) {
      try {
        const job = await getQualityExcelJob(jobId, signal);
        jobsById.set(job.id, job);
        consecutiveFailures = 0;
        onProgress?.(aggregateProgress([...jobsById.values()]));
        if (TERMINAL_STATUSES.has(job.status)) break;
      } catch (error) {
        if (axios.isCancel(error) || signal?.aborted) throw error;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      }
      await waitForNextPoll(signal);
    }
  }
  return uniqueJobIds.map((jobId) => jobsById.get(jobId) as QualityExcelImportJob);
}
