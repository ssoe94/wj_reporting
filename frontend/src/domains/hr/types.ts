export type HrCurrency = "CNY" | "KRW" | "USD";
export type HrCostBasis = "employer_total" | "gross_salary" | "custom";

export type HrDepartment = {
  id: string;
  name: string;
  parent_id: string | null;
  function: string;
};

export type HrImportRow = {
  code: string;
  name: string;
  title: string;
  amount: string | null;
  period?: string;
  source_department?: string;
  department_id?: string | null;
};

export type HrEmployee = HrImportRow & {
  department_id: string | null;
};

export type HrAssignment = Pick<HrEmployee, "code" | "department_id">;

export type HrDepartmentSummary = {
  id: string;
  direct_total: string | null;
  total: string | null;
  known_direct_total: string;
  known_total: string;
  direct_missing_cost_count: number;
  missing_cost_count: number;
  direct_count: number;
  headcount: number;
  share: string | null;
};

export type HrWorkspace = {
  company_structure: {
    classification: {version:string;nodes:HrDepartment[];leaders:{id:string;label:string}[];groups:{id:string;label:string;row:number;column:number;children:string[]}[]};
    organization: {nodes:{id:string;label:string;name:string;parent_id:string|null}[];edges:{from:string;to:string}[]};
  };
  month: string;
  currency: HrCurrency;
  cost_basis: HrCostBasis;
  cost_basis_label: string;
  version: number;
  departments: HrDepartment[];
  employees: HrEmployee[];
  source: null | {
    filename: string;
    fingerprint: string;
    row_count: number;
    total: string | null;
    known_total: string;
    missing_cost_count: number;
  };
  summary: {
    total: string | null;
    known_total: string;
    known_cost_count: number;
    missing_cost_count: number;
    cost_complete: boolean;
    assigned_total: string | null;
    unassigned_total: string | null;
    employee_count: number;
    assigned_count: number;
    unassigned_count: number;
    departments: HrDepartmentSummary[];
  };
  updated_at: string | null;
  history: {
    version: number;
    action: string;
    actor: string;
    created_at: string;
  }[];
};

export type HrMonthList = {
  months: { month: string; currency: HrCurrency; version: number }[];
};

export type HrImportPayload = {
  rows: HrImportRow[];
  currency: HrCurrency;
  cost_basis: HrCostBasis;
  cost_basis_label: string;
  source_filename: string;
  month?: string;
  apply_classification?: boolean;
  allow_missing_cost?: boolean;
};

export type HrImportPreview = {
  rows: HrImportRow[];
  total: string | null;
  known_total: string;
  missing_cost_count: number;
  known_cost_count: number;
  row_count: number;
  fingerprint: string;
};

export type HrImportCommit = HrImportPayload & {
  version: number;
  expected_total: string | null;
};

export type HrLayoutUpdate = {
  version: number;
  departments: HrDepartment[];
  assignments: HrAssignment[];
};

export type HrAccessUser = {
  id: number;
  username: string;
  name: string;
  granted: boolean;
  is_superuser: boolean;
  is_active: boolean;
};
