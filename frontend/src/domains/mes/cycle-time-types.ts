export type CycleTimeQuality = "available" | "limited" | "unavailable" | "no_production";
export type CycleTimeAttribution = "execution_interval" | "plan_estimated" | "unattributed" | "mixed";

export type CycleTimeMetrics = {
  cycle_time_seconds: number | null;
  positive_interval_seconds: number;
  shot_count: number;
  observed_seconds: number;
  sample_count: number;
  coverage_percent: number | null;
  quality: CycleTimeQuality;
  warnings?: string[];
};

export type CycleTimePart = CycleTimeMetrics & {
  part_no: string | null;
  lot_no?: string | null;
  sequence?: number | null;
  attribution: CycleTimeAttribution;
};

export type CycleTimeDaily = CycleTimeMetrics & {
  business_date: string;
  machine_number: number;
  machine_name: string;
  parts: CycleTimePart[];
  preservation_status?: "archived";
};

export type CycleTimeHourly = CycleTimeDaily & {
  device_code: string;
  bucket_start: string;
  bucket_end: string;
  revision: number;
  archived_at: string;
  source_latest_at: string | null;
  preservation_status: "archived";
};

export type CycleTimeHistoryScope = {
  startDate: string;
  endDate: string;
  machineNumber: number | null;
  partNo: string | null;
};

export type CycleTimeHistoryResponse = {
  scope: {
    start_date: string;
    end_date: string;
    machine_number: number | null;
    part_no: string | null;
    timezone: "Asia/Shanghai";
    day_start_hour: 8;
  };
  calculation: { version: string; method: string; maximum_interval_seconds: number; completed_hours_only?: boolean; archive_delay_minutes?: number };
  summary: CycleTimeMetrics;
  daily: CycleTimeDaily[];
  hourly: CycleTimeHourly[];
  hourly_available: boolean;
  parts: CycleTimePart[];
  warnings: string[];
};
