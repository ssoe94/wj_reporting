import { http } from "@/shared/api/http";
import { isDevSessionActive } from "@/domains/auth/dev-session";
import {
  getMockPlanDates,
  getMockPlanItems,
  getMockPlanSummary,
  mockUploadProductionPlanFile,
  mockUpdateProductionPlanItem,
} from "@/domains/production/mock-production";

export async function getProductionStatus(date: string) {
  const response = await http.get(`/production/status/?date=${encodeURIComponent(date)}`);
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
  part_no?: string | null;
  planned_quantity: number;
  cavity?: number;
  sequence?: number | null;
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
  injection: ProductionPlanSummaryBucket;
  machining: ProductionPlanSummaryBucket;
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

export async function getProductionPlanDates() {
  if (isDevSessionActive()) {
    return getMockPlanDates();
  }
  const response = await http.get<ProductionPlanDatesResponse>("/production/plan-dates/");
  return response.data;
}

export async function getProductionPlanSummary(date: string) {
  if (isDevSessionActive()) {
    return getMockPlanSummary(date);
  }
  const response = await http.get<ProductionPlanSummaryResponse>(
    `/production/plan-summary/?date=${encodeURIComponent(date)}`,
  );
  return response.data;
}

export async function getProductionPlanItems(date: string, planType: PlanType) {
  if (isDevSessionActive()) {
    return getMockPlanItems(date, planType);
  }
  const response = await http.get<ProductionPlanRecord[]>(
    `/production/plans/?date=${encodeURIComponent(date)}&plan_type=${encodeURIComponent(planType)}`,
  );
  return response.data;
}

export async function uploadProductionPlanFile(file: File, planType: PlanType, targetDate: string) {
  if (isDevSessionActive()) {
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

export async function updateProductionPlanItem(
  date: string,
  planType: PlanType,
  id: number,
  updates: ProductionPlanUpdatePayload,
) {
  if (isDevSessionActive()) {
    return mockUpdateProductionPlanItem(date, planType, id, updates);
  }

  const response = await http.patch<ProductionPlanRecord>(`/production/plans/${id}/`, updates);
  return response.data;
}
