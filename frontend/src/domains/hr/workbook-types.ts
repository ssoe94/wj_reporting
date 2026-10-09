import type { HrEmployee, HrImportRow, HrWorkspace } from './types';

export type HrEmploymentType = 'contract' | 'hourly';
export type HrReferenceRow = {
  code?: string; name: string; employment_type: HrEmploymentType;
  source_department: string; source_function: string; source_row: number;
  department_id?: string | null;
};
export type HrClassificationReference = { filename: string; rows: HrReferenceRow[]; fingerprint?: string };
export type HrClassificationReferenceState = {
  reference: HrClassificationReference | null;
  version: number;
  updated_at: string | null;
};
export type HrClassificationReferenceCommit = { version: number; reference: HrClassificationReference };
export type HrPayrollSource = { id: string; filename: string; employment_type: HrEmploymentType };
export type HrWorkbookRow = HrImportRow & {
  period: string; employment_type: HrEmploymentType; source_file: string;
  source_sheet: string; source_row: number; original_code: string;
};
export type HrWorkbookMonth = { month: string; rows: HrWorkbookRow[] };
type HrWorkbookBatchFiles = {
  files: HrPayrollSource[];
  months: HrWorkbookMonth[];
  assignment_policy: 'preserve' | 'reference';
};
export type HrWorkbookBatch = HrWorkbookBatchFiles & (
  | { classification: HrClassificationReference; classification_version?: never }
  | { classification?: never; classification_version: number }
);
export type HrWorkbookMonthPreview = {
  month: string; version: number; row_count: number; total: string | null;
  known_total: string; missing_cost_count: number;
  imported_count: number; retained_count: number; unassigned_count: number;
  fingerprint: string; rows: HrEmployee[];
};
export type HrWorkbookBatchPreview = {
  classification: HrClassificationReference;
  months: HrWorkbookMonthPreview[];
  preview_token: string;
};
export type HrWorkbookBatchCommit = HrWorkbookBatch & {
  preview_token: string;
  confirmations: { month: string; version: number; expected_total: string | null; fingerprint: string }[];
};
export type HrWorkbookBatchResult = { workspaces: HrWorkspace[] };
export type HrWorkbookIssue = {
  key: string; file: string; sheet: string; row: number; month: string;
  code: string; suggested_code?: string; message: string;
};
