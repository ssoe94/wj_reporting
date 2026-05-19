import { http } from "@/shared/api/http";
import { isDevSessionActive } from "@/domains/auth/dev-session";

export async function getInjectionSummary(date?: string) {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  const response = await http.get(`/injection/reports/summary/${query}`);
  return response.data;
}

export type AnalyticsDailyProgress = {
  business_date: string;
  process: "injection" | "machining";
  planned_qty: number;
  actual_qty: number;
  gap_qty: number;
  progress_rate: number;
  time_progress_rate: number | null;
  status: "ahead" | "on_track" | "behind" | "no_plan";
  active_equipment_count: number;
  running_equipment_count: number;
  total_equipment_count: number;
  source_row_counts: Record<string, number>;
  warnings: string[];
};

export type AnalyticsEquipmentProgress = {
  business_date: string;
  process: "injection" | "machining";
  equipment_key: string;
  equipment_label: string;
  equipment_name: string;
  planned_qty: number;
  actual_qty: number;
  gap_qty: number;
  progress_rate: number;
  recent_60m_shots: number;
  recent_60m_avg_ct_sec: number | null;
  is_running: boolean;
  completed_count: number;
  in_progress_count: number;
  pending_count: number;
};

export type AnalyticsExceptionEvent = {
  id?: number;
  source_key: string;
  business_date: string;
  process: "injection" | "machining" | "";
  exception_type: string;
  severity: "info" | "warning" | "critical";
  status: "open" | "acknowledged" | "resolved" | "ignored";
  equipment_key: string;
  equipment_label: string;
  part_no: string;
  title: string;
  detail: string;
  detected_at: string;
  resolved_at: string | null;
};

export type AnalyticsProductionProgressResponse = {
  scope: {
    business_date: string;
    range_start: string;
    range_end: string;
    reference_time: string | null;
    processes: Array<"injection" | "machining">;
  };
  freshness: {
    source_latest_at: string | null;
    mart_generated_at: string | null;
    is_stale: boolean;
    is_persisted: boolean;
  };
  used_data: Array<{
    name: string;
    row_count: number;
    filters: Record<string, unknown>;
  }>;
  calculation_basis: string[];
  warnings: string[];
  daily: AnalyticsDailyProgress[];
  equipment: AnalyticsEquipmentProgress[];
  exceptions: AnalyticsExceptionEvent[];
};

function getMockAnalyticsProductionProgress(date: string): AnalyticsProductionProgressResponse {
  return {
    scope: {
      business_date: date,
      range_start: `${date}T08:00:00+08:00`,
      range_end: `${date}T08:00:00+08:00`,
      reference_time: `${date}T10:20:00+08:00`,
      processes: ["injection", "machining"],
    },
    freshness: {
      source_latest_at: `${date}T10:18:00+08:00`,
      mart_generated_at: `${date}T10:21:00+08:00`,
      is_stale: false,
      is_persisted: true,
    },
    used_data: [
      { name: "ProductionPlan", row_count: 2, filters: { plan_date: date } },
      { name: "InjectionMonitoringRecord", row_count: 3, filters: { business_date: date } },
      { name: "ProductionMesReportRecord", row_count: 2, filters: { business_date: date } },
    ],
    calculation_basis: [
      "기준일은 08:00 ~ 익일 08:00 기준입니다.",
      "사출 실적은 MES 형합수 x Cavity를 생산계획 순서대로 배분해 추정합니다.",
    ],
    warnings: [],
    daily: [
      {
        business_date: date,
        process: "injection",
        planned_qty: 100,
        actual_qty: 40,
        gap_qty: -60,
        progress_rate: 40,
        time_progress_rate: 32,
        status: "on_track",
        active_equipment_count: 1,
        running_equipment_count: 1,
        total_equipment_count: 17,
        source_row_counts: { plan_row_count: 1, monitoring_row_count: 3 },
        warnings: [],
      },
      {
        business_date: date,
        process: "machining",
        planned_qty: 180,
        actual_qty: 120,
        gap_qty: -60,
        progress_rate: 66.7,
        time_progress_rate: null,
        status: "no_plan",
        active_equipment_count: 1,
        running_equipment_count: 0,
        total_equipment_count: 2,
        source_row_counts: { plan_row_count: 2, mes_row_count: 2 },
        warnings: [],
      },
    ],
    equipment: [
      {
        business_date: date,
        process: "injection",
        equipment_key: "1",
        equipment_label: "850T-1",
        equipment_name: "850T-1",
        planned_qty: 100,
        actual_qty: 40,
        gap_qty: -60,
        progress_rate: 40,
        recent_60m_shots: 10,
        recent_60m_avg_ct_sec: 360,
        is_running: true,
        completed_count: 0,
        in_progress_count: 1,
        pending_count: 0,
      },
      {
        business_date: date,
        process: "machining",
        equipment_key: "A",
        equipment_label: "A라인",
        equipment_name: "A LINE",
        planned_qty: 180,
        actual_qty: 120,
        gap_qty: -60,
        progress_rate: 66.7,
        recent_60m_shots: 0,
        recent_60m_avg_ct_sec: null,
        is_running: true,
        completed_count: 0,
        in_progress_count: 1,
        pending_count: 1,
      },
    ],
    exceptions: [
      {
        source_key: `${date}:machining:plan_only:A:PART-B`,
        business_date: date,
        process: "machining",
        exception_type: "plan_only",
        severity: "warning",
        status: "open",
        equipment_key: "A",
        equipment_label: "A라인",
        part_no: "PART-B",
        title: "A라인 PART-B 계획만 있음",
        detail: "계획은 있지만 실적이 아직 없습니다.",
        detected_at: `${date}T10:21:00+08:00`,
        resolved_at: null,
      },
    ],
  };
}

export async function getAnalyticsProductionProgress(date: string, language: "ko" | "zh") {
  if (isDevSessionActive()) {
    return getMockAnalyticsProductionProgress(date);
  }

  const response = await http.get<AnalyticsProductionProgressResponse>(
    `/analytics/production-progress/?date=${encodeURIComponent(date)}&language=${encodeURIComponent(language)}`,
  );
  return response.data;
}
