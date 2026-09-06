import type { InjectionProductionMatrix } from "./api";

export type MonitoringQuery = {
  data: unknown;
  isError: boolean;
  isPending: boolean;
};
export type MonitoringState = "loading" | "error" | "empty" | "ready";

/** Errors take precedence over a retained success so cached values cannot look current. */
export function getMonitoringState(queries: MonitoringQuery[], hasEvidence = true): MonitoringState {
  if (queries.some((query) => query.isError)) return "error";
  if (queries.some((query) => query.isPending)) return "loading";
  if (!hasEvidence || queries.some((query) => query.data === undefined || query.data === null)) return "empty";
  return "ready";
}

export function hasMonitoringMatrix(data: InjectionProductionMatrix | undefined) {
  return Boolean(data?.time_slots.length && data.machines.length && Object.keys(data.actual_production_matrix).length);
}

/** Slot time is a display grid; capacity sample time is the data freshness evidence. */
export function getMonitoringCoverage(data: InjectionProductionMatrix | undefined, machineNumber: number | null = null) {
  const machines = data?.machines.filter((machine) => machineNumber === null || machine.machine_number === machineNumber) ?? [];
  const sources = machines.map((machine) => data?.machine_sources?.[String(machine.machine_number)]);
  const known = sources.length > 0 && sources.every(Boolean);
  const unavailable = !known || sources.some((source) => source?.status === "missing");
  const stale = sources.some((source) => source?.status === "stale");
  const observations = machines.map((machine) => data?.capacity_observed_matrix?.[String(machine.machine_number)]);
  const totalSlots = machines.length * (data?.time_slots.length ?? 0);
  const observedSlots = observations.reduce((sum, row) => sum + (row?.filter(Boolean).length ?? 0), 0);
  const policyUnverified = data?.counter_policy !== "reset-aware-v1"
    || Boolean(data?.warnings?.includes("stored_rollup_counter_policy_unversioned"));
  const ready = known && !policyUnverified && sources.every((source, index) => source?.status === "ok" && source.sample_count > 0 && observations[index]?.some(Boolean));
  return { known, unavailable, stale, ready, policyUnverified, observedSlots, totalSlots, hasGaps: totalSlots === 0 || observedSlots < totalSlots };
}

/** Exact range coverage is required before a previous-period comparison is meaningful. */
export function coversMonitoringWindow(data: InjectionProductionMatrix | undefined, start: Date | null, end: Date | null) {
  if (!data || !start || !end || !hasMonitoringMatrix(data)) return false;
  const first = Date.parse(data.time_slots[0].time);
  const last = Date.parse(data.time_slots[data.time_slots.length - 1].time);
  return Number.isFinite(first) && Number.isFinite(last) && first <= start.getTime() && last >= end.getTime();
}

export function hasObservedCapacityInWindow(data: InjectionProductionMatrix, machineNumber: number, start: Date, end: Date) {
  const observed = data.capacity_observed_matrix?.[String(machineNumber)];
  return Boolean(observed?.some((sample, index) => {
    const time = Date.parse(data.time_slots[index]?.time ?? "");
    return sample === true && isMonitoringSlotInWindow(time, start, end);
  }));
}

/** Matrix timestamps identify the beginning of a bucket, never its endpoint. */
export function isMonitoringSlotInWindow(time: number, start: Date, end: Date) {
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

/** Trim only the local inference input, retaining API freshness provenance separately. */
export function trimMonitoringSlots(data: InjectionProductionMatrix | undefined, start: Date, end: Date) {
  if (!data) return undefined;
  const indices = data.time_slots.flatMap((slot, index) => isMonitoringSlotInWindow(Date.parse(slot.time), start, end) ? [index] : []);
  const slice = <T,>(values: Record<string, T[]> | undefined) => values
    ? Object.fromEntries(Object.entries(values).map(([key, row]) => [key, indices.map((index) => row[index])]))
    : undefined;
  return {
    ...data,
    time_slots: indices.map((index) => data.time_slots[index]),
    actual_production_matrix: slice(data.actual_production_matrix) ?? {},
    cumulative_production_matrix: slice(data.cumulative_production_matrix) ?? {},
    oil_temperature_matrix: slice(data.oil_temperature_matrix) ?? {},
    power_kwh_matrix: slice(data.power_kwh_matrix),
    power_usage_matrix: slice(data.power_usage_matrix),
    capacity_observed_matrix: slice(data.capacity_observed_matrix),
  };
}
