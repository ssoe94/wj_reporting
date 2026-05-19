import { http } from "@/shared/api/http";
import { isDevSessionActive } from "@/domains/auth/dev-session";
import {
  getMockPlanDates,
  getMockPlanItems,
  getMockPlanSummary,
  mockUploadProductionPlanFile,
  mockUpdateProductionPlanItem,
} from "@/domains/production/mock-production";

const USE_REMOTE_PRODUCTION_API = import.meta.env.VITE_USE_REMOTE_PRODUCTION_API === "true";

function shouldUseMockProductionApi() {
  return isDevSessionActive() && !USE_REMOTE_PRODUCTION_API;
}

export type ProductionStatusPart = {
  part_no: string | null;
  model_name: string | null;
  planned_quantity: number;
  actual_quantity: number;
  progress: number;
  mes_qty?: number;
  manual_open_qty?: number;
  matched_manual_qty?: number;
  defect_qty?: number;
  status?: string | null;
};

export type ProductionStatusMachine = {
  machine_name: string;
  total_planned: number;
  total_actual: number;
  progress: number;
  total_mes?: number;
  total_manual_open?: number;
  total_manual_matched?: number;
  total_defect?: number;
  parts: ProductionStatusPart[];
};

export type ProductionStatusResponse = {
  injection: ProductionStatusMachine[];
  machining: ProductionStatusMachine[];
};

export async function getProductionStatus(date: string) {
  const response = await http.get<ProductionStatusResponse>(`/production/status/?date=${encodeURIComponent(date)}`);
  return response.data;
}

export type PlanType = "injection" | "machining";

export type ProductionPlanDatesResponse = {
  injection: string[];
  machining: string[];
};

export type ProductionPlanRecord = {
  id?: number;
  machine_name: string | null;
  lot_no?: string | null;
  model_name?: string | null;
  part_spec?: string | null;
  product_family_code?: string | null;
  product_family_name?: string | null;
  is_finished_product?: boolean;
  part_no?: string | null;
  planned_quantity: number;
  cavity?: number;
  sequence?: number | null;
  created_at?: string;
  updated_at?: string;
};

export type ProductionPlanSummaryBucket = {
  records: ProductionPlanRecord[];
  machine_summary: Array<{
    machine_name: string | null;
    plan_qty: number;
    plan_date: string;
  }>;
  model_summary: Array<{
    model_name: string | null;
    plan_qty: number;
    plan_date: string;
  }>;
  daily_totals: Array<{
    date: string;
    plan_qty: number;
  }>;
};

export type ProductionPlanSummaryResponse = {
  plan_date: string;
  latest_updated_at?: string | null;
  injection: ProductionPlanSummaryBucket;
  machining: ProductionPlanSummaryBucket;
};

export type ProductionPlanChangeLog = {
  id: number;
  plan_date: string;
  plan_type: PlanType;
  action: "upload" | "create" | "update" | "reorder" | "delete";
  machine_name: string | null;
  part_no: string | null;
  model_name: string | null;
  lot_no: string | null;
  plan_id: number | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  summary: string;
  changed_by_name: string | null;
  created_at: string;
};

export type ProductionPlanChangeLogResponse = {
  date: string;
  latest_updated_at: string | null;
  logs: ProductionPlanChangeLog[];
};

export type ProductionMesReportStatsResponse = {
  date: string;
  plan_type: PlanType;
  range_mode: string;
  range_start: string;
  range_end: string;
  latest_synced_at: string | null;
  summary: {
    total_planned: number;
    total_mes: number;
    gap_qty: number;
    achievement_rate: number;
    matched_rows: number;
    plan_only_rows: number;
    mes_only_rows: number;
    raw_mes_count: number;
    grouped_mes_count: number;
  };
  rows: Array<{
    equipment_key: string;
    equipment_name: string;
    equipment_label: string;
    part_no: string;
    model_name: string;
    planned_qty: number;
    mes_qty: number;
    gap_qty: number;
    achievement_rate: number | null;
    mes_report_count: number;
    latest_report_time: string | null;
    compare_status: "matched" | "plan_only" | "mes_only";
    process_code: string;
    plan_row_count: number;
  }>;
};

export type MachiningManualReport = {
  id: number;
  business_date: string;
  plan_date: string;
  plan_id: number | null;
  machine_name: string;
  equipment_key: string;
  part_no: string;
  model_name: string;
  lot_no: string | null;
  sequence: number;
  planned_qty_at_report: number;
  good_qty: number;
  defect_qty: number;
  total_reported_qty: number;
  matched_qty: number;
  open_qty: number;
  reason_code: string;
  note: string;
  status: "open" | "partial" | "matched" | "mismatch" | "cancelled";
  credit_business_date: string;
  reported_by_name: string | null;
  reported_at: string | null;
  updated_at: string | null;
  defect_items: Array<{
    id: number;
    defect_category: string;
    defect_type: string;
    quantity: number;
    note: string;
  }>;
};

export type MachiningProvisionRow = {
  business_date: string;
  plan_date: string | null;
  day_offset: number | null;
  plan_id: number | null;
  plan_identity_hash: string;
  machine_name: string;
  equipment_key: string;
  equipment_label: string;
  part_no: string;
  model_name: string;
  lot_no: string | null;
  sequence: number;
  planned_qty: number;
  mes_qty: number;
  direct_mes_qty: number;
  matched_manual_qty: number;
  manual_qty: number;
  manual_open_qty: number;
  effective_actual_qty: number;
  gap_qty: number;
  achievement_rate: number | null;
  status:
    | "mes_reported"
    | "manual_open"
    | "manual_matched"
    | "manual_partial"
    | "manual_mismatch"
    | "needs_review"
    | "unplanned_mes";
  defect_qty: number;
  manual_reports: MachiningManualReport[];
};

export type MachiningProvisionResponse = {
  business_date: string;
  range: {
    plan_date_from: string;
    plan_date_to: string;
    range_start: string;
    range_end: string;
  };
  summary: {
    total_planned: number;
    mes_qty: number;
    manual_open_qty: number;
    manual_matched_qty: number;
    effective_actual_qty: number;
    gap_qty: number;
    achievement_rate: number;
    open_manual_count: number;
    mismatch_count: number;
    advance_qty: number;
  };
  rows: MachiningProvisionRow[];
};

export type CreateMachiningManualReportPayload = {
  business_date: string;
  plan_id: number;
  good_qty: number;
  defect_qty?: number;
  defect_items?: Array<{
    defect_category: string;
    defect_type: string;
    quantity: number;
    note?: string;
  }>;
  reason_code?: string;
  note?: string;
};

export type ProductionPlanUploadResponse = {
  plan_type: PlanType;
  plan_date?: string;
  target_date?: string;
  available_days?: string[];
  records?: ProductionPlanRecord[];
  plan_long?: unknown[];
  machine_summary?: ProductionPlanSummaryBucket["machine_summary"];
  model_summary?: ProductionPlanSummaryBucket["model_summary"];
};

export type ProductionAiAskResponse = {
  answer: string;
  source: "calculated" | "intent_calculated" | "local_llm" | "timeout_or_llm_error";
  detail?: string;
  intent?: Record<string, unknown>;
  context?: {
    business_date: string;
    range_start: string;
    range_end: string;
    recent_range_start: string;
    recent_range_end: string;
  };
};

export type ProductionAiBriefingResponse = {
  answer: string;
  severity: "normal" | "warning" | "critical";
  facts: {
    injection: {
      actual_qty: number;
      planned_qty: number;
      progress_rate: number;
      time_progress_rate: number | null;
      gap_qty: number;
      status: "ahead" | "on_track" | "behind" | "no_plan";
      active_equipment_count: number;
      running_equipment_count: number;
      total_equipment_count: number;
    };
    machining: {
      actual_qty: number;
      planned_qty: number;
      progress_rate: number;
      time_progress_rate: number | null;
      gap_qty: number;
      status: "ahead" | "on_track" | "behind" | "no_plan";
      active_equipment_count: number;
      running_equipment_count: number;
      total_equipment_count: number;
    };
  };
  top_risks: Array<{
    type: string;
    label: string;
    gap_qty: number;
    process: string;
    detail: string;
  }>;
  used_data: Array<{
    name: string;
    row_count: number;
    filters: Record<string, unknown>;
  }>;
  calculation_basis: string[];
  context_pack?: Record<string, unknown>;
  cache: {
    hit: boolean;
    generated_at: string | null;
    expires_at: string | null;
  };
};

export type AiJobStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled";

export type AiJob = {
  id: number;
  job_type: "production_daily_analysis" | "production_machine_analysis";
  status: AiJobStatus;
  scope: Record<string, unknown>;
  input_payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  error_message: string;
  claimed_by: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  model_name: string;
  prompt_version: string;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateAiJobPayload = {
  job_type: AiJob["job_type"];
  scope?: Record<string, unknown>;
  input_payload?: Record<string, unknown>;
};

export async function getProductionPlanDates() {
  if (shouldUseMockProductionApi()) {
    return getMockPlanDates();
  }
  const response = await http.get<ProductionPlanDatesResponse>("/production/plan-dates/");
  return response.data;
}

export async function getProductionPlanSummary(date: string) {
  if (shouldUseMockProductionApi()) {
    return getMockPlanSummary(date);
  }
  const response = await http.get<ProductionPlanSummaryResponse>(
    `/production/plan-summary/?date=${encodeURIComponent(date)}`,
  );
  return response.data;
}

export async function getProductionPlanChangeLogs(date: string) {
  const response = await http.get<ProductionPlanChangeLogResponse>(
    `/production/plan-change-logs/?date=${encodeURIComponent(date)}`,
  );
  return response.data;
}

export async function getProductionMesReportStats(date: string, planType: PlanType) {
  const response = await http.get<ProductionMesReportStatsResponse>(
    `/production/mes-report-stats/?date=${encodeURIComponent(date)}&plan_type=${encodeURIComponent(planType)}`,
  );
  return response.data;
}

export async function getMachiningProvision(businessDate: string, days = 3) {
  const response = await http.get<MachiningProvisionResponse>(
    `/production/machining/provision/?business_date=${encodeURIComponent(businessDate)}&days=${encodeURIComponent(days)}`,
  );
  return response.data;
}

export async function createMachiningManualReport(payload: CreateMachiningManualReportPayload) {
  const response = await http.post<MachiningManualReport>("/production/machining/manual-reports/", payload);
  return response.data;
}

export async function getProductionPlanItems(date: string, planType: PlanType) {
  if (shouldUseMockProductionApi()) {
    return getMockPlanItems(date, planType);
  }

  async function getSummaryRecords() {
    const summary = await getProductionPlanSummary(date);
    return summary[planType].records;
  }

  try {
    const [itemsResponse, summaryRecords] = await Promise.all([
      http.get<ProductionPlanRecord[]>(
        `/production/plans/?date=${encodeURIComponent(date)}&plan_type=${encodeURIComponent(planType)}`,
      ),
      getSummaryRecords().catch(() => [] as ProductionPlanRecord[]),
    ]);
    if (!itemsResponse.data.length && summaryRecords.length) {
      return summaryRecords;
    }
    return mergeCavityFromSummary(itemsResponse.data, summaryRecords);
  } catch (error) {
    try {
      return await getSummaryRecords();
    } catch {
      throw error;
    }
  }
}

export async function uploadProductionPlanFile(file: File, planType: PlanType, targetDate: string) {
  if (shouldUseMockProductionApi()) {
    return mockUploadProductionPlanFile(file, planType, targetDate);
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("plan_type", planType);
  formData.append("date", targetDate);

  const response = await http.post<ProductionPlanUploadResponse>("/production/plan/upload/", formData, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
  return response.data;
}

export type ProductionPlanUpdatePayload = Partial<
  Pick<
    ProductionPlanRecord,
    "machine_name" | "lot_no" | "model_name" | "part_spec" | "part_no" | "planned_quantity" | "sequence"
  >
>;

export type ProductionPartCavityResponse = {
  part_no: string;
  cavity: number;
};

export async function updateProductionPlanItem(
  date: string,
  planType: PlanType,
  id: number,
  updates: ProductionPlanUpdatePayload,
) {
  if (shouldUseMockProductionApi()) {
    return mockUpdateProductionPlanItem(date, planType, id, updates);
  }

  const response = await http.patch<ProductionPlanRecord>(`/production/plans/${id}/`, updates);
  return response.data;
}

export async function updateProductionPartCavity(partNo: string, cavity: number) {
  if (shouldUseMockProductionApi()) {
    return { part_no: partNo.trim().toUpperCase(), cavity: Math.max(1, Math.round(Number(cavity) || 1)) };
  }

  const response = await http.post<ProductionPartCavityResponse>("/production/part-cavity/", {
    part_no: partNo,
    cavity,
  });
  return response.data;
}

export async function askProductionAi(date: string, question: string, language: "ko" | "zh") {
  const response = await http.post<ProductionAiAskResponse>(
    "/production/ai/ask/",
    { date, question, language },
    { timeout: 60_000 },
  );
  return response.data;
}

export async function getProductionAiBriefing(date: string, language: "ko" | "zh") {
  const response = await http.get<ProductionAiBriefingResponse>(
    `/production/ai/briefing/?date=${encodeURIComponent(date)}&language=${encodeURIComponent(language)}`,
  );
  return response.data;
}

export async function createAiJob(payload: CreateAiJobPayload) {
  const response = await http.post<AiJob>("/ai/jobs/", payload);
  return response.data;
}

export async function getAiJob(jobId: number) {
  const response = await http.get<AiJob>(`/ai/jobs/${jobId}/`);
  return response.data;
}

export async function cancelAiJob(jobId: number) {
  const response = await http.post<AiJob>(`/ai/jobs/${jobId}/cancel/`);
  return response.data;
}

function mergeCavityFromSummary(records: ProductionPlanRecord[], summaryRecords: ProductionPlanRecord[]) {
  if (!summaryRecords.length) return records;

  const cavityMap = new Map<string, number>();
  summaryRecords.forEach((record) => {
    const partNo = (record.part_no || "").trim().toUpperCase();
    if (partNo) cavityMap.set(partNo, Math.max(1, Number(record.cavity) || 1));
  });

  return records.map((record) => {
    const partNo = (record.part_no || "").trim().toUpperCase();
    return {
      ...record,
      cavity: cavityMap.get(partNo) ?? record.cavity ?? 1,
    };
  });
}
