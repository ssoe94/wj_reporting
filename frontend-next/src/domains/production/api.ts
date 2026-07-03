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

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
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

function normalizeProductionStatus(data: Partial<ProductionStatusResponse> | null | undefined): ProductionStatusResponse {
  return {
    injection: asArray(data?.injection).map((machine) => ({
      ...machine,
      parts: asArray(machine.parts),
    })),
    machining: asArray(data?.machining).map((machine) => ({
      ...machine,
      parts: asArray(machine.parts),
    })),
  };
}

export async function getProductionStatus(date: string) {
  const response = await http.get<ProductionStatusResponse>(`/production/status/?date=${encodeURIComponent(date)}`);
  return normalizeProductionStatus(response.data);
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
  cavity_pattern?: string | null;
  parts_per_shot?: number;
  cavity_group?: string | null;
  total_cavity?: number;
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

function normalizePlanBucket(bucket: Partial<ProductionPlanSummaryBucket> | null | undefined): ProductionPlanSummaryBucket {
  return {
    records: asArray(bucket?.records),
    machine_summary: asArray(bucket?.machine_summary),
    model_summary: asArray(bucket?.model_summary),
    daily_totals: asArray(bucket?.daily_totals),
  };
}

function normalizeProductionPlanSummary(
  data: Partial<ProductionPlanSummaryResponse> | null | undefined,
  date: string,
): ProductionPlanSummaryResponse {
  return {
    plan_date: data?.plan_date ?? date,
    latest_updated_at: data?.latest_updated_at ?? null,
    injection: normalizePlanBucket(data?.injection),
    machining: normalizePlanBucket(data?.machining),
  };
}

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
    mes_material_names?: string[];
  }>;
};

function normalizeProductionMesReportStats(
  data: Partial<ProductionMesReportStatsResponse> | null | undefined,
  date: string,
  planType: PlanType,
): ProductionMesReportStatsResponse {
  return {
    date: data?.date ?? date,
    plan_type: data?.plan_type ?? planType,
    range_mode: data?.range_mode ?? "business_day",
    range_start: data?.range_start ?? "",
    range_end: data?.range_end ?? "",
    latest_synced_at: data?.latest_synced_at ?? null,
    summary: {
      total_planned: Number(data?.summary?.total_planned ?? 0),
      total_mes: Number(data?.summary?.total_mes ?? 0),
      gap_qty: Number(data?.summary?.gap_qty ?? 0),
      achievement_rate: Number(data?.summary?.achievement_rate ?? 0),
      matched_rows: Number(data?.summary?.matched_rows ?? 0),
      plan_only_rows: Number(data?.summary?.plan_only_rows ?? 0),
      mes_only_rows: Number(data?.summary?.mes_only_rows ?? 0),
      raw_mes_count: Number(data?.summary?.raw_mes_count ?? 0),
      grouped_mes_count: Number(data?.summary?.grouped_mes_count ?? 0),
    },
    rows: asArray(data?.rows),
  };
}

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

function normalizeMachiningProvision(
  data: Partial<MachiningProvisionResponse> | null | undefined,
  businessDate: string,
): MachiningProvisionResponse {
  return {
    business_date: data?.business_date ?? businessDate,
    range: {
      plan_date_from: data?.range?.plan_date_from ?? businessDate,
      plan_date_to: data?.range?.plan_date_to ?? businessDate,
      range_start: data?.range?.range_start ?? "",
      range_end: data?.range?.range_end ?? "",
    },
    summary: {
      total_planned: Number(data?.summary?.total_planned ?? 0),
      mes_qty: Number(data?.summary?.mes_qty ?? 0),
      manual_open_qty: Number(data?.summary?.manual_open_qty ?? 0),
      manual_matched_qty: Number(data?.summary?.manual_matched_qty ?? 0),
      effective_actual_qty: Number(data?.summary?.effective_actual_qty ?? 0),
      gap_qty: Number(data?.summary?.gap_qty ?? 0),
      achievement_rate: Number(data?.summary?.achievement_rate ?? 0),
      open_manual_count: Number(data?.summary?.open_manual_count ?? 0),
      mismatch_count: Number(data?.summary?.mismatch_count ?? 0),
      advance_qty: Number(data?.summary?.advance_qty ?? 0),
    },
    rows: asArray(data?.rows).map((row) => ({
      ...row,
      manual_reports: asArray(row.manual_reports),
    })),
  };
}

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
  return {
    injection: asArray(response.data?.injection),
    machining: asArray(response.data?.machining),
  };
}

export async function getProductionPlanSummary(date: string) {
  if (shouldUseMockProductionApi()) {
    return getMockPlanSummary(date);
  }
  const response = await http.get<ProductionPlanSummaryResponse>(
    `/production/plan-summary/?date=${encodeURIComponent(date)}`,
  );
  return normalizeProductionPlanSummary(response.data, date);
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
  return normalizeProductionMesReportStats(response.data, date, planType);
}

export async function getMachiningProvision(businessDate: string, days = 3) {
  const response = await http.get<MachiningProvisionResponse>(
    `/production/machining/provision/?business_date=${encodeURIComponent(businessDate)}&days=${encodeURIComponent(days)}`,
  );
  return normalizeMachiningProvision(response.data, businessDate);
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
    const items = asArray(itemsResponse.data);
    if (!items.length && summaryRecords.length) {
      return summaryRecords;
    }
    return mergeCavityFromSummary(items, summaryRecords);
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
  part_nos?: string[];
  cavity: number;
  cavity_pattern?: string | null;
  parts_per_shot?: number;
  cavity_group?: string | null;
  total_cavity?: number;
  parts?: Array<{
    part_no: string;
    cavity: number;
    cavity_pattern?: string | null;
    parts_per_shot?: number;
    cavity_group?: string | null;
    total_cavity?: number;
  }>;
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

export async function updateProductionPartCavity(partNo: string, cavityPattern: string | number) {
  if (shouldUseMockProductionApi()) {
    const cavity = parseCavityPattern(cavityPattern).cavity;
    return { part_no: partNo.trim().toUpperCase(), cavity, cavity_pattern: String(cavityPattern || `1x${cavity}`) };
  }

  const response = await http.post<ProductionPartCavityResponse>("/production/part-cavity/", {
    part_no: partNo,
    cavity_pattern: cavityPattern,
  });
  return response.data;
}

export async function updateProductionPartCavityGroup(partNos: string[], cavityPattern: string) {
  const normalizedPartNos = [...new Set(partNos.map((partNo) => partNo.trim().toUpperCase()).filter(Boolean))];
  if (shouldUseMockProductionApi()) {
    const parsed = parseCavityPattern(cavityPattern);
    return {
      part_no: normalizedPartNos[0] ?? "",
      part_nos: normalizedPartNos,
      cavity: parsed.cavity,
      cavity_pattern: parsed.pattern,
      parts_per_shot: parsed.partsPerShot,
      cavity_group: parsed.partsPerShot > 1 ? normalizedPartNos.join("+") : normalizedPartNos[0],
      total_cavity: parsed.cavity * parsed.partsPerShot,
    };
  }

  const response = await http.post<ProductionPartCavityResponse>("/production/part-cavity/", {
    part_nos: normalizedPartNos,
    cavity_pattern: cavityPattern,
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

  const cavityMap = new Map<string, Pick<ProductionPlanRecord, "cavity" | "cavity_pattern" | "parts_per_shot" | "cavity_group" | "total_cavity">>();
  summaryRecords.forEach((record) => {
    const partNo = (record.part_no || "").trim().toUpperCase();
    if (partNo) {
      cavityMap.set(partNo, {
        cavity: Math.max(1, Number(record.cavity) || 1),
        cavity_pattern: record.cavity_pattern ?? null,
        parts_per_shot: Math.max(1, Number(record.parts_per_shot) || 1),
        cavity_group: record.cavity_group ?? null,
        total_cavity: Math.max(1, Number(record.total_cavity) || Math.max(1, Number(record.cavity) || 1)),
      });
    }
  });

  return records.map((record) => {
    const partNo = (record.part_no || "").trim().toUpperCase();
    const meta = cavityMap.get(partNo);
    return {
      ...record,
      cavity: meta?.cavity ?? record.cavity ?? 1,
      cavity_pattern: meta?.cavity_pattern ?? record.cavity_pattern ?? null,
      parts_per_shot: meta?.parts_per_shot ?? record.parts_per_shot ?? 1,
      cavity_group: meta?.cavity_group ?? record.cavity_group ?? null,
      total_cavity: meta?.total_cavity ?? record.total_cavity ?? record.cavity ?? 1,
    };
  });
}

function parseCavityPattern(value: string | number | null | undefined) {
  const text = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "").replace("*", "x").replace("×", "x");
  const match = text.match(/^(\d+)x(\d+)$/);
  if (match) {
    return {
      pattern: `${Math.max(1, Number(match[1]) || 1)}x${Math.max(1, Number(match[2]) || 1)}`,
      partsPerShot: Math.max(1, Number(match[1]) || 1),
      cavity: Math.max(1, Number(match[2]) || 1),
    };
  }
  const cavity = Math.max(1, Math.round(Number(value) || 1));
  return { pattern: `1x${cavity}`, partsPerShot: 1, cavity };
}
