export type QualityImportBatchStatus =
  | 'queued'
  | 'processing'
  | 'ready'
  | 'ready_with_warnings'
  | 'failed';

export type QualityImportDeltaStatus = 'added' | 'changed' | 'unchanged';

export interface QualityImportDeltaDay {
  added: number;
  changed: number;
  unchanged: number;
  missing: number;
}

export interface QualityImportMissingRow {
  row_id: number;
  sheet_name: string;
  source_row_number: number;
  report_date: string | null;
  model: string;
  part_no: string;
}

export interface QualityImportDeltaSummary {
  by_date: Record<string, QualityImportDeltaDay>;
  missing?: QualityImportMissingRow[];
  selection_scope?: QualityImportSelectionScope;
  baseline_batch_ids?: number[];
}

export type QualityImportMode = 'date_range' | 'full';

export interface QualityImportScopeRequest {
  mode: QualityImportMode;
  rangeStart?: string;
  rangeEnd?: string;
}

export interface QualityImportSelectionScope {
  mode: QualityImportMode;
  range_start: string | null;
  range_end: string | null;
  source_total_rows: number;
  selected_rows: number;
  retained_rows?: number;
  excluded_rows: number;
  undated_rows: number;
}

export type QualityImportReviewStatus = 'draft' | 'reviewed' | 'rejected' | 'published' | 'unchanged';
export type QualityImportEditableReviewStatus = Exclude<QualityImportReviewStatus, 'published' | 'unchanged'>;

export interface QualityImportBatch {
  id: number;
  original_filename: string;
  file_size: number;
  status: QualityImportBatchStatus;
  sheet_names: string[];
  total_rows: number;
  total_media: number;
  warning_count: number;
  baseline_batch: number | null;
  dataset_key: string;
  source_total_rows: number;
  added_count: number;
  changed_count: number;
  unchanged_count: number;
  missing_count: number;
  new_media_count: number;
  reused_media_count: number;
  delta_summary: QualityImportDeltaSummary;
  created_at: string;
  uploaded_by: number | string | null;
  idempotent_replay?: boolean;
}

export interface QualityImportClientUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface QualityImportUploadResult {
  batch: QualityImportBatch;
  alreadyAccepted: boolean;
}

export interface QualityImportMedia {
  id: number;
  kind: string;
  content_type: string | null;
  byte_size: number | null;
  sha256: string | null;
  filename: string;
  url: string | null;
  width: number | null;
  height: number | null;
  source_anchor: string;
  mirror_state: 'pending' | 'mirrored' | 'failed' | null;
  mirrored_at?: string | null;
  warnings: string[];
}

export interface QualityImportRow {
  id: number;
  batch: number;
  sheet_name: string;
  sheet_role: string;
  source_row_number: number;
  source_sequence: string;
  source_key: string;
  content_sha256: string;
  business_key: string;
  delta_status: QualityImportDeltaStatus;
  baseline_row: number | null;
  supersedes: number | null;
  duplicate_of: number | null;
  report_date: string | null;
  section: string;
  occurrence_location: string;
  model: string;
  part_no: string;
  item_name: string;
  lot_qty: number | null;
  inspection_qty: number | null;
  defect_qty: number | null;
  defect_rate: string;
  judgement: string;
  phenomenon: string;
  disposition: string;
  action_result: string;
  raw_data: Record<string, unknown>;
  warnings: string[];
  review_status: QualityImportReviewStatus;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  approved_report?: number | null;
  published_at?: string | null;
  duplicate_override_by?: string | null;
  duplicate_override_at?: string | null;
  duplicate_override_reason?: string;
  duplicate_match?: QualityImportDuplicateMatch | null;
  created_at?: string;
  updated_at?: string;
  media: QualityImportMedia[];
}

export type QualityImportDuplicateLevel = 'confirmed' | 'likely';
export type QualityImportDuplicateAction = 'link_existing' | 'update_existing' | 'separate';

export interface QualityImportDuplicateReportSummary {
  report_dt: string;
  report_date: string;
  section: string;
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
  images: string[];
}

export interface QualityImportDuplicateMatch {
  level: QualityImportDuplicateLevel;
  score: number;
  report_id: number;
  version: string;
  source_kind: 'manual' | 'excel';
  reasons: string[];
  allowed_actions: QualityImportDuplicateAction[];
  report: QualityImportDuplicateReportSummary;
}

export interface QualityImportPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface QualityImportRowFilters {
  page?: number;
  pageSize?: number;
  sheetName?: string;
  reviewStatus?: QualityImportReviewStatus | '';
  deltaStatus?: QualityImportDeltaStatus | '';
}

export type QualityImportRowUpdate = Partial<Pick<
  QualityImportRow,
  | 'report_date'
  | 'section'
  | 'occurrence_location'
  | 'model'
  | 'part_no'
  | 'item_name'
  | 'lot_qty'
  | 'inspection_qty'
  | 'defect_qty'
  | 'defect_rate'
  | 'judgement'
  | 'phenomenon'
  | 'disposition'
  | 'action_result'
>> & {
  review_status?: QualityImportEditableReviewStatus;
};
