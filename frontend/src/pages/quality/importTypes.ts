export type QualityExcelImportRowStatus = 'created' | 'skipped' | 'changed' | 'failed';
export type QualityExcelPreviewRowStatus = 'new' | 'unchanged' | 'changed' | 'failed';

export type QualityWorkbookCell = string | number | boolean | null;

export interface QualityExcelImportValidationError {
  field: string;
  code: string;
  message: string;
}

export interface QualityWorkbookSheetManifest {
  sheet_name: string;
  rows: QualityWorkbookCell[][];
}

export interface QualityWorkbookMediaManifest {
  key: string;
  source_sheet_name: string;
  source_anchor_row: number;
  source_anchor_col: number;
  source_index: number;
  original_filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
}

export interface QualityWorkbookManifest {
  version: 'quality-incremental-v1';
  filename: string;
  file_size: number;
  workbook_sha256: string;
  workbook_properties: { title?: string };
  sheets: QualityWorkbookSheetManifest[];
  media: QualityWorkbookMediaManifest[];
  warnings: string[];
}

export interface QualityExcelImportRowResult {
  row_key: string;
  import_row_id: number | null;
  editable: boolean;
  failure_code: string;
  validation_errors: QualityExcelImportValidationError[];
  sheet_name: string;
  source_row_number: number;
  source_sequence: string;
  status: QualityExcelImportRowStatus;
  report_id: number | null;
  report_date: string | null;
  section: string;
  occurrence_location: string;
  model: string;
  part_no: string;
  lot_qty: number | null;
  inspection_qty: number | null;
  defect_qty: number | null;
  defect_rate: string;
  judgement: string;
  phenomenon: string;
  disposition: string;
  action_result: string;
  images_found: number;
  images_saved: number;
  media_keys: string[];
  warnings: string[];
  message: string;
}

export interface QualityImportRowReviewPayload {
  report_date: string;
  section: string;
  occurrence_location: string;
  model: string;
  part_no: string;
  defect_rate: string;
  judgement: string;
  phenomenon: string;
  review_status: 'reviewed';
}

export interface QualityImportRowWorkflowResult {
  id: number;
  reviewed_content_sha256: string;
  report_date: string | null;
  section: string;
  occurrence_location: string;
  model: string;
  part_no: string;
  lot_qty: number | null;
  inspection_qty: number | null;
  defect_qty: number | null;
  defect_rate: string;
  judgement: string;
  phenomenon: string;
  disposition: string;
  action_result: string;
  review_status: 'draft' | 'reviewed' | 'rejected' | 'unchanged' | 'published';
  approved_report: number | null;
  idempotent_replay?: boolean;
}

export interface QualityImportPublishConflict {
  code: string;
  error: string;
  confirmation_required?: boolean;
  approved_report?: number;
  original_import_row?: number;
}

export interface QualityExcelImportResult {
  filename: string;
  total_rows: number;
  created_count: number;
  skipped_count: number;
  changed_count: number;
  failed_count: number;
  images_found: number;
  images_saved: number;
  images_failed: number;
  images_ignored: number;
  images_skipped: number;
  created_report_ids: number[];
  skipped_report_ids: number[];
  changed_report_ids: number[];
  warnings: string[];
  rows: QualityExcelImportRowResult[];
}

export interface QualityExcelPreviewRowResult
  extends Omit<QualityExcelImportRowResult, 'status'> {
  status: QualityExcelPreviewRowStatus;
}

export interface QualityExcelImportPreview {
  version: 'quality-incremental-v1';
  filename: string;
  total_rows: number;
  new_count: number;
  unchanged_count: number;
  changed_count: number;
  failed_count: number;
  images_found: number;
  images_to_upload: number;
  images_ignored: number;
  required_media_keys: string[];
  warnings: string[];
  rows: QualityExcelPreviewRowResult[];
}

export interface QualityExcelImportProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

export type QualityExcelImportJobStatus =
  | 'queued'
  | 'processing'
  | 'ready'
  | 'ready_with_warnings'
  | 'failed';

export interface QualityExcelImportJob {
  id: number;
  status: QualityExcelImportJobStatus;
  phase: string;
  progress_done: number;
  progress_total: number;
  attempt_count: number;
  next_attempt_at: string | null;
  filename: string;
  total_rows: number;
  result: QualityExcelImportResult | null;
  warnings: string[];
  idempotent_replay?: boolean;
}

export interface QualityExcelDirectUploadParameters {
  cloud_name: string;
  api_key: string;
  timestamp: number;
  signature: string;
  public_id: string;
  allowed_formats: string;
  upload_preset: 'wj-quality-import-browser-direct-v1';
  overwrite: false;
  unique_filename: false;
}

export interface QualityExcelDirectUploadIntent {
  asset_sha256: string;
  media_keys: string[];
  source_byte_size: number;
  source_content_type: string;
  upload: QualityExcelDirectUploadParameters;
}

export interface QualityExcelDirectJob
  extends Omit<QualityExcelImportJob, 'status' | 'idempotent_replay'> {
  status: QualityExcelImportJobStatus | 'staging';
  idempotent_replay: boolean;
  delivery_mode: 'browser_direct';
  upload_intents: QualityExcelDirectUploadIntent[];
}

export interface QualityCloudinaryUploadReceipt {
  public_id: string;
  version: number;
  signature: string;
}

export interface QualityReportHistoryScope {
  reportIds: number[];
  kind: 'created' | 'skipped' | 'changed' | 'all';
}
