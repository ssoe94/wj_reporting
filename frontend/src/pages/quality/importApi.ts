import axios, { type AxiosResponse } from 'axios';
import api from '../../lib/api';
import type {
  QualityCloudinaryUploadReceipt,
  QualityExcelDirectJob,
  QualityExcelDirectUploadIntent,
  QualityExcelImportPreview,
  QualityExcelImportJob,
  QualityExcelImportResult,
  QualityImportPublishConflict,
  QualityImportRowReviewPayload,
  QualityImportRowWorkflowResult,
  QualityWorkbookManifest,
} from './importTypes';

export const QUALITY_IMPORT_MAX_FILE_BYTES = 80 * 1024 * 1024;
const QUALITY_IMPORT_DIRECT_UPLOAD_PRESET = 'wj-quality-import-browser-direct-v1';

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

function isOptionalCount(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isValidationErrors(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => (
    isRecord(item)
    && typeof item.field === 'string'
    && typeof item.code === 'string'
    && typeof item.message === 'string'
  ));
}

function isImportRow(value: unknown, statuses: ReadonlySet<string>): boolean {
  return isRecord(value)
    && typeof value.row_key === 'string'
    && (value.import_row_id === null || (Number.isSafeInteger(value.import_row_id) && Number(value.import_row_id) > 0))
    && typeof value.editable === 'boolean'
    && typeof value.failure_code === 'string'
    && isValidationErrors(value.validation_errors)
    && typeof value.sheet_name === 'string'
    && isCount(value.source_row_number)
    && typeof value.source_sequence === 'string'
    && typeof value.status === 'string'
    && statuses.has(value.status)
    && isOptionalReportId(value.report_id)
    && isOptionalString(value.report_date)
    && typeof value.section === 'string'
    && typeof value.occurrence_location === 'string'
    && typeof value.model === 'string'
    && typeof value.part_no === 'string'
    && isOptionalCount(value.lot_qty)
    && isOptionalCount(value.inspection_qty)
    && isOptionalCount(value.defect_qty)
    && typeof value.defect_rate === 'string'
    && typeof value.judgement === 'string'
    && typeof value.phenomenon === 'string'
    && typeof value.disposition === 'string'
    && typeof value.action_result === 'string'
    && isCount(value.images_found)
    && isCount(value.images_saved)
    && isStringArray(value.media_keys)
    && isStringArray(value.warnings)
    && typeof value.message === 'string';
}

const IMPORT_ROW_REVIEW_STATUSES = new Set([
  'draft', 'reviewed', 'rejected', 'unchanged', 'published',
]);

function isImportRowWorkflowResult(value: unknown): value is QualityImportRowWorkflowResult {
  return isRecord(value)
    && Number.isSafeInteger(value.id)
    && Number(value.id) > 0
    && /^[0-9a-f]{64}$/.test(String(value.reviewed_content_sha256 || ''))
    && isOptionalString(value.report_date)
    && typeof value.section === 'string'
    && typeof value.occurrence_location === 'string'
    && typeof value.model === 'string'
    && typeof value.part_no === 'string'
    && isOptionalCount(value.lot_qty)
    && isOptionalCount(value.inspection_qty)
    && isOptionalCount(value.defect_qty)
    && typeof value.defect_rate === 'string'
    && typeof value.judgement === 'string'
    && typeof value.phenomenon === 'string'
    && typeof value.disposition === 'string'
    && typeof value.action_result === 'string'
    && typeof value.review_status === 'string'
    && IMPORT_ROW_REVIEW_STATUSES.has(value.review_status)
    && isOptionalReportId(value.approved_report)
    && (value.idempotent_replay === undefined || typeof value.idempotent_replay === 'boolean');
}

function assertImportRowWorkflowResponse(
  value: unknown,
  contentType: unknown,
): asserts value is QualityImportRowWorkflowResult {
  if (!isJsonResponse(contentType) || !isImportRowWorkflowResult(value)) {
    throw new Error('서버의 실패 행 수정 응답 형식이 올바르지 않습니다. 잠시 후 다시 확인해 주세요.');
  }
}

function parsePublishConflict(value: unknown): QualityImportPublishConflict | null {
  if (
    !isRecord(value)
    || typeof value.code !== 'string'
    || typeof value.error !== 'string'
  ) return null;
  return {
    code: value.code,
    error: value.error,
    confirmation_required: typeof value.confirmation_required === 'boolean'
      ? value.confirmation_required
      : undefined,
    approved_report: Number.isSafeInteger(value.approved_report) && Number(value.approved_report) > 0
      ? Number(value.approved_report)
      : undefined,
    original_import_row: Number.isSafeInteger(value.original_import_row) && Number(value.original_import_row) > 0
      ? Number(value.original_import_row)
      : undefined,
  };
}

export class QualityImportPublishConflictError extends Error {
  readonly conflict: QualityImportPublishConflict;

  constructor(conflict: QualityImportPublishConflict) {
    super(conflict.error);
    this.name = 'QualityImportPublishConflictError';
    this.conflict = conflict;
  }
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

function isCommitResponse(value: unknown): value is QualityExcelImportResult {
  return isRecord(value)
    && typeof value.filename === 'string'
    && isCount(value.total_rows)
    && isCount(value.created_count)
    && isCount(value.skipped_count)
    && isCount(value.changed_count)
    && isCount(value.failed_count)
    && isCount(value.images_found)
    && isCount(value.images_saved)
    && isCount(value.images_failed)
    && isCount(value.images_ignored)
    && isCount(value.images_skipped)
    && isIdArray(value.created_report_ids)
    && isIdArray(value.skipped_report_ids)
    && isIdArray(value.changed_report_ids)
    && isStringArray(value.warnings)
    && Array.isArray(value.rows)
    && value.rows.every((row) => isImportRow(row, COMMIT_STATUSES));
}

const JOB_STATUSES = new Set(['queued', 'processing', 'ready', 'ready_with_warnings', 'failed']);
const DIRECT_JOB_STATUSES = new Set([...JOB_STATUSES, 'staging']);
const TERMINAL_DIRECT_STATUSES = new Set(['ready', 'ready_with_warnings']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLOUD_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ALLOWED_FORMATS_PATTERN = /^[a-z0-9]+(?:,[a-z0-9]+)*$/;
const ALLOWED_FORMATS_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg,jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif,tiff',
  'image/webp': 'webp',
};
const PREPARE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function isRetryablePrepareError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.code === 'ERR_CANCELED') return false;
  if (!error.response) {
    return Boolean(error.request)
      || ['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK'].includes(error.code || '');
  }
  return [500, 502, 503, 504].includes(error.response.status);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, milliseconds); });
}

type ValidatedJobEnvelope = Omit<QualityExcelImportJob, 'status'> & { status: string };

function isJobResponse(
  value: unknown,
  statuses: ReadonlySet<string>,
): value is ValidatedJobEnvelope {
  return isRecord(value)
    && Number.isSafeInteger(value.id)
    && Number(value.id) > 0
    && typeof value.status === 'string'
    && statuses.has(value.status)
    && typeof value.phase === 'string'
    && isCount(value.progress_done)
    && isCount(value.progress_total)
    && isCount(value.attempt_count)
    && isOptionalString(value.next_attempt_at)
    && typeof value.filename === 'string'
    && isCount(value.total_rows)
    && (value.result === null || isCommitResponse(value.result))
    && isStringArray(value.warnings)
    && (value.idempotent_replay === undefined || typeof value.idempotent_replay === 'boolean')
    && (!['ready', 'ready_with_warnings'].includes(String(value.status)) || isCommitResponse(value.result));
}

function assertJobResponse(
  value: unknown,
  contentType: unknown,
  statuses: ReadonlySet<string> = JOB_STATUSES,
): asserts value is QualityExcelImportJob {
  if (!isJsonResponse(contentType) || !isJobResponse(value, statuses)) {
    throw new Error('서버의 Excel 작업 상태 응답 형식이 올바르지 않습니다. 잠시 후 상태를 다시 확인해 주세요.');
  }
}

function isDirectUploadIntent(value: unknown): value is QualityExcelDirectUploadIntent {
  if (!isRecord(value) || !isRecord(value.upload)) return false;
  const upload = value.upload;
  const expectedAllowedFormats = typeof value.source_content_type === 'string'
    ? ALLOWED_FORMATS_BY_CONTENT_TYPE[value.source_content_type]
    : undefined;
  return typeof value.asset_sha256 === 'string'
    && SHA256_PATTERN.test(value.asset_sha256)
    && isStringArray(value.media_keys)
    && value.media_keys.length > 0
    && new Set(value.media_keys).size === value.media_keys.length
    && Number.isSafeInteger(value.source_byte_size)
    && Number(value.source_byte_size) > 0
    && typeof value.source_content_type === 'string'
    && value.source_content_type.startsWith('image/')
    && typeof upload.cloud_name === 'string'
    && upload.cloud_name.length <= 128
    && CLOUD_NAME_PATTERN.test(upload.cloud_name)
    && typeof upload.api_key === 'string'
    && upload.api_key.length > 0
    && upload.api_key.length <= 256
    && Number.isSafeInteger(upload.timestamp)
    && Number(upload.timestamp) > 0
    && typeof upload.signature === 'string'
    && upload.signature.length > 0
    && upload.signature.length <= 256
    && typeof upload.public_id === 'string'
    && upload.public_id.length > 0
    && upload.public_id.length <= 256
    && typeof upload.allowed_formats === 'string'
    && upload.allowed_formats.length <= 128
    && ALLOWED_FORMATS_PATTERN.test(upload.allowed_formats)
    && upload.allowed_formats === expectedAllowedFormats
    && upload.upload_preset === QUALITY_IMPORT_DIRECT_UPLOAD_PRESET
    && upload.overwrite === false
    && upload.unique_filename === false;
}

type DirectJobEnvelope = Omit<QualityExcelDirectJob, 'idempotent_replay'> & {
  idempotent_replay?: boolean;
};

function parseDirectJobResponse(
  value: unknown,
  contentType: unknown,
  requireReplay: boolean,
): DirectJobEnvelope {
  if (!isJsonResponse(contentType) || !isJobResponse(value, DIRECT_JOB_STATUSES)) {
    throw new Error('서버의 브라우저 직접 업로드 응답 형식이 올바르지 않습니다. 같은 파일로 다시 시도해 주세요.');
  }
  const candidate = value as ValidatedJobEnvelope & Record<string, unknown>;
  const uploadIntents = candidate.upload_intents;
  if (
    candidate.delivery_mode !== 'browser_direct'
    || !Array.isArray(uploadIntents)
    || !uploadIntents.every(isDirectUploadIntent)
    || new Set(uploadIntents.map((intent) => intent.asset_sha256)).size !== uploadIntents.length
    || (requireReplay && typeof candidate.idempotent_replay !== 'boolean')
  ) {
    throw new Error('서버의 브라우저 직접 업로드 응답 형식이 올바르지 않습니다. 같은 파일로 다시 시도해 주세요.');
  }
  return candidate as DirectJobEnvelope;
}

function validateDirectIntents(
  job: DirectJobEnvelope,
  manifest: QualityWorkbookManifest,
  expectedMediaKeys: readonly string[],
): void {
  const mediaByKey = new Map(manifest.media.map((item) => [item.key, item]));
  const allowedMediaKeys = new Set(expectedMediaKeys);
  const seenMediaKeys = new Set<string>();
  for (const intent of job.upload_intents) {
    const allowedPublicId = new RegExp(
      `^(?:media/)?quality-import/pending/${job.id}/${intent.asset_sha256}-[0-9a-f]{24}$`,
    );
    if (!allowedPublicId.test(intent.upload.public_id)) {
      throw new Error('서버가 지정한 Cloudinary 사진 경로가 올바르지 않습니다. 업로드를 중단했습니다.');
    }
    for (const mediaKey of intent.media_keys) {
      const media = mediaByKey.get(mediaKey);
      if (
        !media
        || !allowedMediaKeys.has(mediaKey)
        || seenMediaKeys.has(mediaKey)
        || media.sha256 !== intent.asset_sha256
        || media.byte_size !== intent.source_byte_size
        || media.content_type !== intent.source_content_type
      ) {
        throw new Error('서버의 사진 업로드 대상이 Excel 비교 결과와 일치하지 않습니다. 업로드를 중단했습니다.');
      }
      seenMediaKeys.add(mediaKey);
    }
  }
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

export async function prepareQualityExcelDirectJob(
  manifest: QualityWorkbookManifest,
  rowKeys: readonly string[],
  expectedMediaKeys: readonly string[],
): Promise<QualityExcelDirectJob> {
  let response: AxiosResponse<unknown>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await api.post<unknown>(
        '/quality/excel-import/direct/jobs/',
        { manifest, row_keys: rowKeys },
        { timeout: 60_000 },
      );
      break;
    } catch (error) {
      const delay = PREPARE_RETRY_DELAYS_MS[attempt];
      if (delay == null || !isRetryablePrepareError(error)) throw error;
      await wait(delay);
    }
  }
  if (response.status !== 202) {
    throw new Error('서버가 Excel 직접 업로드 준비를 확인하지 않았습니다. 같은 파일로 다시 시도해 주세요.');
  }
  const job = parseDirectJobResponse(response.data, response.headers['content-type'], true);
  validateDirectIntents(job, manifest, expectedMediaKeys);
  if (job.filename !== manifest.filename) {
    throw new Error('서버가 준비한 작업의 Excel 파일명이 일치하지 않습니다. 업로드를 중단했습니다.');
  }
  return job as QualityExcelDirectJob;
}

export async function completeQualityExcelDirectAsset(
  jobId: number,
  assetSha256: string,
  receipt: QualityCloudinaryUploadReceipt,
): Promise<void> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || !SHA256_PATTERN.test(assetSha256)) {
    throw new Error('사진 업로드 작업 식별자가 올바르지 않습니다.');
  }
  const response = await api.post<unknown>(
    `/quality/excel-import/direct/jobs/${jobId}/assets/${assetSha256}/complete/`,
    receipt,
    { timeout: 30_000 },
  );
  if (response.status !== 200) {
    throw new Error('서버가 Cloudinary 사진 저장을 확인하지 않았습니다. 같은 파일로 다시 시도해 주세요.');
  }
  const acknowledged = parseDirectJobResponse(response.data, response.headers['content-type'], false);
  if (acknowledged.id !== jobId) {
    throw new Error('서버가 다른 Excel 작업의 사진 확인 결과를 반환했습니다.');
  }
}

export async function finalizeQualityExcelDirectJob(jobId: number): Promise<QualityExcelImportJob> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error('Excel 직접 업로드 작업 식별자가 올바르지 않습니다.');
  }
  const response = await api.post<unknown>(
    `/quality/excel-import/direct/jobs/${jobId}/finalize/`,
    {},
    { timeout: 60_000 },
  );
  if (response.status !== 200) {
    throw new Error('서버가 Excel 등록 완료를 확인하지 않았습니다. 같은 파일로 다시 시도해 주세요.');
  }
  assertJobResponse(response.data, response.headers['content-type'], TERMINAL_DIRECT_STATUSES);
  if (!response.data.result) {
    throw new Error('서버가 Excel 등록 결과를 반환하지 않았습니다. 같은 파일로 다시 확인해 주세요.');
  }
  return response.data;
}

export async function reviewQualityImportRow(
  importRowId: number,
  payload: QualityImportRowReviewPayload,
): Promise<QualityImportRowWorkflowResult> {
  if (!Number.isSafeInteger(importRowId) || importRowId <= 0) {
    throw new Error('수정할 Excel 행 식별자가 올바르지 않습니다.');
  }
  const response = await api.patch<unknown>(
    `/quality/import-rows/${importRowId}/`,
    payload,
    { timeout: 30_000 },
  );
  assertImportRowWorkflowResponse(response.data, response.headers['content-type']);
  if (response.data.id !== importRowId || response.data.review_status !== 'reviewed') {
    throw new Error('서버가 수정한 Excel 행을 검토 완료 상태로 저장하지 못했습니다.');
  }
  return response.data;
}

export async function publishQualityImportRow(
  importRowId: number,
  expectedReviewedContentSha256: string,
): Promise<QualityImportRowWorkflowResult> {
  if (!Number.isSafeInteger(importRowId) || importRowId <= 0) {
    throw new Error('등록할 Excel 행 식별자가 올바르지 않습니다.');
  }
  if (!/^[0-9a-f]{64}$/.test(expectedReviewedContentSha256)) {
    throw new Error('검토한 Excel 행의 버전 정보가 올바르지 않습니다. 다시 수정해 주세요.');
  }
  try {
    const response = await api.post<unknown>(
      `/quality/import-rows/${importRowId}/publish/`,
      { expected_reviewed_content_sha256: expectedReviewedContentSha256 },
      { timeout: 60_000 },
    );
    assertImportRowWorkflowResponse(response.data, response.headers['content-type']);
    if (
      response.data.id !== importRowId
      || response.data.review_status !== 'published'
      || response.data.approved_report === null
    ) {
      throw new Error('서버가 수정한 Excel 행의 보고서 등록을 확인하지 못했습니다.');
    }
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 409) {
      const conflict = parsePublishConflict(error.response.data);
      if (conflict) throw new QualityImportPublishConflictError(conflict);
    }
    throw error;
  }
}
