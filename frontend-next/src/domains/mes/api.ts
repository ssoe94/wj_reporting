import { http } from "@/shared/api/http";

export type MesDataSource = "injection" | "machining" | "inventory";

export type TimeSlot = {
  hour_offset: number;
  time: string;
  label: string;
  interval_minutes?: number;
};

export type InjectionMachineInfo = {
  machine_number: number;
  machine_name: string;
  tonnage: string;
  display_name: string;
};

export type InjectionProductionMatrix = {
  timestamp: string;
  time_slots: TimeSlot[];
  rollup_time_slots?: TimeSlot[];
  hourly_rollup_time_slots?: TimeSlot[];
  rollup_bucket_minutes?: number;
  interval_type?: "1min" | "2min" | "10min" | "30min" | "1hour" | "1day";
  columns?: number;
  machines: InjectionMachineInfo[];
  cumulative_production_matrix: Record<string, number[]>;
  actual_production_matrix: Record<string, number[]>;
  rollup_production_matrix?: Record<string, number[]>;
  rollup_source?: boolean;
  hourly_production_matrix?: Record<string, number[]>;
  hourly_rollup_source?: boolean;
  oil_temperature_matrix: Record<string, number[]>;
  power_kwh_matrix?: Record<string, number[]>;
  power_usage_matrix?: Record<string, number[]>;
  mes_source?: boolean;
};

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function asNumberArrayRecord(value: unknown): Record<string, number[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, row]) => [
      key,
      Array.isArray(row) ? row.map((item) => Number(item) || 0) : [],
    ]),
  );
}

function normalizeInjectionProductionMatrix(data: Partial<InjectionProductionMatrix> | null | undefined): InjectionProductionMatrix {
  return {
    timestamp: data?.timestamp ?? new Date().toISOString(),
    time_slots: asArray(data?.time_slots),
    rollup_time_slots: data?.rollup_time_slots ? asArray(data.rollup_time_slots) : undefined,
    hourly_rollup_time_slots: data?.hourly_rollup_time_slots ? asArray(data.hourly_rollup_time_slots) : undefined,
    rollup_bucket_minutes: data?.rollup_bucket_minutes,
    interval_type: data?.interval_type,
    columns: data?.columns,
    machines: asArray(data?.machines),
    cumulative_production_matrix: asNumberArrayRecord(data?.cumulative_production_matrix),
    actual_production_matrix: asNumberArrayRecord(data?.actual_production_matrix),
    rollup_production_matrix: data?.rollup_production_matrix
      ? asNumberArrayRecord(data.rollup_production_matrix)
      : undefined,
    rollup_source: data?.rollup_source,
    hourly_production_matrix: data?.hourly_production_matrix
      ? asNumberArrayRecord(data.hourly_production_matrix)
      : undefined,
    hourly_rollup_source: data?.hourly_rollup_source,
    oil_temperature_matrix: asNumberArrayRecord(data?.oil_temperature_matrix),
    power_kwh_matrix: data?.power_kwh_matrix ? asNumberArrayRecord(data.power_kwh_matrix) : undefined,
    power_usage_matrix: data?.power_usage_matrix ? asNumberArrayRecord(data.power_usage_matrix) : undefined,
    mes_source: data?.mes_source,
  };
}

export type SnapshotUpdateStatus = {
  status?: "idle" | "running" | "completed" | "failed" | "skipped";
  job_id?: string;
  percent?: number;
  completed_steps?: number;
  total_steps?: number;
  last_slot?: string | null;
  error?: string;
};

export type InjectionMonitoringDatesResponse = {
  dates: string[];
  latest_timestamp: string | null;
  earliest_timestamp: string | null;
};

const MES_API_BASE_URL =
  import.meta.env.VITE_MES_API_BASE_URL ||
  (import.meta.env.DEV ? "https://wj-reporting.onrender.com/api" : "");

function mesEndpoint(path: string) {
  const baseUrl = MES_API_BASE_URL.trim().replace(/\/$/, "");
  if (!baseUrl || baseUrl === "/api") {
    return path;
  }
  return `${baseUrl}${path}`;
}

async function fetchInjectionProductionMatrix(date?: string) {
  try {
    const twoMinuteParams = new URLSearchParams({
      interval: "2min",
      columns: "721",
    });
    if (date) {
      twoMinuteParams.set("date", date);
    }
    const twoMinuteResponse = await http.get<InjectionProductionMatrix>(
      mesEndpoint(`/injection/production-matrix/?${twoMinuteParams.toString()}`),
      { skipAuth: true },
    );
    return normalizeInjectionProductionMatrix(twoMinuteResponse.data);
  } catch {
    const fallbackParams = new URLSearchParams({
      interval: "10min",
      columns: date ? "145" : "144",
    });
    if (date) {
      fallbackParams.set("date", date);
    }
    const fallbackResponse = await http.get<InjectionProductionMatrix>(
      mesEndpoint(`/injection/production-matrix/?${fallbackParams.toString()}`),
      { skipAuth: true },
    );
    return normalizeInjectionProductionMatrix(fallbackResponse.data);
  }
}

export async function getInjectionProductionMatrix() {
  return fetchInjectionProductionMatrix();
}

export async function getInjectionProductionMatrixForDate(date: string) {
  return fetchInjectionProductionMatrix(date);
}

export async function getInjectionMonitoringDates() {
  const response = await http.get<InjectionMonitoringDatesResponse>(
    mesEndpoint("/injection/monitoring-dates/"),
    { skipAuth: true },
  );
  return {
    dates: asArray(response.data?.dates),
    latest_timestamp: response.data?.latest_timestamp ?? null,
    earliest_timestamp: response.data?.earliest_timestamp ?? null,
  };
}

export async function getInjectionUtilizationMatrix(columns = 336) {
  const params = new URLSearchParams({
    interval: "1hour",
    columns: String(columns),
  });
  const response = await http.get<InjectionProductionMatrix>(
    mesEndpoint(`/injection/production-matrix/?${params.toString()}`),
    { skipAuth: true },
  );
  return response.data;
}

export async function requestInjectionSnapshotUpdate() {
  const response = await http.post<SnapshotUpdateStatus>(
    mesEndpoint("/injection/update-recent-snapshots/"),
    { hours: 24, step_minutes: 2 },
    { skipAuth: true },
  );
  return response.data;
}

export async function getInjectionSnapshotUpdateStatus(jobId?: string) {
  const params = jobId ? `?job_id=${encodeURIComponent(jobId)}` : "";
  const response = await http.get<SnapshotUpdateStatus>(
    mesEndpoint(`/injection/update-recent-snapshots/status/${params}`),
    { skipAuth: true },
  );
  return response.data;
}
