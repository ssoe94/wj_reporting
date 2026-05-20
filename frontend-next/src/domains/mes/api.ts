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
  interval_type?: "1min" | "2min" | "10min" | "30min" | "1hour" | "1day";
  columns?: number;
  machines: InjectionMachineInfo[];
  cumulative_production_matrix: Record<string, number[]>;
  actual_production_matrix: Record<string, number[]>;
  oil_temperature_matrix: Record<string, number[]>;
  power_kwh_matrix?: Record<string, number[]>;
  power_usage_matrix?: Record<string, number[]>;
  mes_source?: boolean;
};

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
    return twoMinuteResponse.data;
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
    return fallbackResponse.data;
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
  return response.data;
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
