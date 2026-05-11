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
  status?: "idle" | "running" | "completed" | "failed";
  job_id?: string;
  percent?: number;
  completed_steps?: number;
  total_steps?: number;
  last_slot?: string | null;
  error?: string;
};

const MES_API_BASE_URL =
  import.meta.env.VITE_MES_API_BASE_URL ||
  (import.meta.env.DEV ? "https://wj-reporting.onrender.com/api" : "/api");

function mesEndpoint(path: string) {
  return `${MES_API_BASE_URL.replace(/\/$/, "")}${path}`;
}

export async function getInjectionProductionMatrix() {
  const twoMinuteProbeParams = new URLSearchParams({
    interval: "2min",
    columns: "30",
  });
  const twoMinuteProbeResponse = await http.get<InjectionProductionMatrix>(
    mesEndpoint(`/injection/production-matrix/?${twoMinuteProbeParams.toString()}`),
    { skipAuth: true },
  );
  const firstSlotInterval = twoMinuteProbeResponse.data.time_slots[0]?.interval_minutes;

  if (firstSlotInterval === 2) {
    const twoMinuteParams = new URLSearchParams({
      interval: "2min",
      columns: "720",
    });
    const twoMinuteResponse = await http.get<InjectionProductionMatrix>(
      mesEndpoint(`/injection/production-matrix/?${twoMinuteParams.toString()}`),
      { skipAuth: true },
    );
    return twoMinuteResponse.data;
  }

  const fallbackParams = new URLSearchParams({
    interval: "10min",
    columns: "144",
  });
  const fallbackResponse = await http.get<InjectionProductionMatrix>(
    mesEndpoint(`/injection/production-matrix/?${fallbackParams.toString()}`),
    { skipAuth: true },
  );
  return fallbackResponse.data;
}

export async function requestInjectionSnapshotUpdate() {
  const response = await http.post<SnapshotUpdateStatus>(
    mesEndpoint("/injection/update-recent-snapshots/"),
    { mode: "latest" },
    { skipAuth: true },
  );
  return response.data;
}
