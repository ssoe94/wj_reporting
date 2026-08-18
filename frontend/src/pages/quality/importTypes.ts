export type QualityExcelImportRowStatus = 'created' | 'skipped' | 'changed' | 'failed';
export type QualityExcelPreviewRowStatus = 'new' | 'unchanged' | 'changed' | 'failed';

export type QualityWorkbookCell = string | number | boolean | null;

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
  sheet_name: string;
  source_row_number: number;
  source_sequence: string;
  status: QualityExcelImportRowStatus;
  report_id: number | null;
  report_date: string | null;
  section: string;
  model: string;
  part_no: string;
  phenomenon: string;
  images_found: number;
  images_saved: number;
  media_keys: string[];
  warnings: string[];
  message: string;
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

export interface QualityReportHistoryScope {
  reportIds: number[];
  kind: 'created' | 'skipped' | 'changed' | 'all';
}
