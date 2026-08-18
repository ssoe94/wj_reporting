export type QualityExcelImportRowStatus = 'created' | 'skipped' | 'failed';

export interface QualityExcelImportRowResult {
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
  warnings: string[];
  message: string;
}

export interface QualityExcelImportResult {
  filename: string;
  total_rows: number;
  created_count: number;
  skipped_count: number;
  failed_count: number;
  images_found: number;
  images_saved: number;
  images_failed: number;
  images_ignored: number;
  images_skipped: number;
  created_report_ids: number[];
  skipped_report_ids: number[];
  warnings: string[];
  rows: QualityExcelImportRowResult[];
}

export interface QualityExcelImportProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface QualityReportHistoryScope {
  reportIds: number[];
  kind: 'created' | 'skipped' | 'all';
}
