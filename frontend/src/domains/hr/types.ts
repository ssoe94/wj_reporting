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
  amount: string;
};

export type HrEmployee = HrImportRow & {
  department_id: string | null;
};

export type HrAssignment = Pick<HrEmployee, "code" | "department_id">;

export type HrDepartmentSummary = {
  id: string;
  direct_total: string;
  total: string;
  direct_count: number;
  headcount: number;
  share: string;
};

export type HrWorkspace = {
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
    total: string;
  };
  summary: {
    total: string;
    assigned_total: string;
    unassigned_total: string;
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
};

export type HrImportPreview = {
  rows: HrImportRow[];
  total: string;
  row_count: number;
  fingerprint: string;
};

export type HrImportCommit = HrImportPayload & {
  version: number;
  expected_total: string;
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
