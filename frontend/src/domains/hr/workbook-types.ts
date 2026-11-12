import type { HrEmployee, HrImportRow, HrPayrollComponents, HrWorkspace } from './types';

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
  payroll_components?: HrPayrollComponents;
};
export type HrWorkbookMonth = { month: string; rows: HrWorkbookRow[] };
type HrWorkbookBatchFiles = {
  files: HrPayrollSource[];
  months: HrWorkbookMonth[];
  assignment_policy: 'preserve' | 'reference';
  roster_decisions?: HrRosterDecision[];
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
  evidence?: { code: string; roster?: boolean; months: { period: string; fixedPayDifference: number | null }[] };
};

export type HrRosterEntry = {
  id: number; code: string; name: string; employment_type: HrEmploymentType;
  department: string; status: 'active' | 'departed'; first_month: string; last_month: string;
  version: number; previous_codes: string[]; in_month: boolean;
};
export type HrRosterHistory = {
  id: number; created_at: string; actor_label: string; reason: string;
  previous_code: string; new_code: string;
  previous_status: string; new_status: string;
  previous_employment_type: string; new_employment_type: string;
  previous_department: string; new_department: string;
};
export type HrCodeReview = {
  key: string; name: string; employment_type: HrEmploymentType;
  codes: { code: string; months: string[] }[];
  employment_types?: { employment_type: HrEmploymentType; months: string[] }[];
};

export type HrRosterDecision = Pick<HrRosterEntry, 'name' | 'employment_type' | 'code' | 'version'> & { reason: string };
