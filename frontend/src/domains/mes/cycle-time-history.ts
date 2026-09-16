import type { CycleTimeAttribution, CycleTimeDaily, CycleTimeHistoryScope, CycleTimeMetrics, CycleTimePart } from "./cycle-time-types.ts";

const DAY_MS = 86_400_000;
export const CYCLE_TIME_MAX_DAYS = 366;

export function isCycleTimeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function shiftCycleTimeDate(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function cycleTimeRangeDays(startDate: string, endDate: string): number {
  if (!isCycleTimeDate(startDate) || !isCycleTimeDate(endDate)) return 0;
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS) + 1;
}

export function validCycleTimeRange(startDate: string, endDate: string, currentDate: string): boolean {
  const days = cycleTimeRangeDays(startDate, endDate);
  return days >= 1 && days <= CYCLE_TIME_MAX_DAYS && endDate <= currentDate;
}

export function resolveCycleTimeScope(search: string, date: string, machineNumber: number | null, currentDate: string): CycleTimeHistoryScope {
  const params = new URLSearchParams(search);
  const requestedStart = params.get("ct_start") ?? "";
  const requestedEnd = params.get("ct_end") ?? "";
  const validRange = validCycleTimeRange(requestedStart, requestedEnd, currentDate);
  const partNo = params.get("part_no")?.trim() || null;
  return {
    startDate: validRange ? requestedStart : shiftCycleTimeDate(date, -6),
    endDate: validRange ? requestedEnd : date,
    // A Part No drilldown always follows the part across machines.
    machineNumber: partNo ? null : machineNumber,
    partNo,
  };
}

export function cycleTimeQueryParams(scope: CycleTimeHistoryScope): URLSearchParams {
  const params = new URLSearchParams({ start_date: scope.startDate, end_date: scope.endDate });
  if (scope.partNo) params.set("part_no", scope.partNo);
  else if (scope.machineNumber !== null) params.set("machine_number", String(scope.machineNumber));
  return params;
}

export function cycleTimePartSearch(search: string, partNo: string | null): URLSearchParams {
  const params = new URLSearchParams(search);
  if (partNo?.trim()) params.set("part_no", partNo.trim());
  else params.delete("part_no");
  return params;
}

/** Weight only intervals that actually support a C/T estimate; missing is never zero. */
export function weightedCycleTime(rows: CycleTimeMetrics[]): number | null {
  const usable = rows.filter((row) => row.cycle_time_seconds !== null && Number.isFinite(row.cycle_time_seconds)
    && row.shot_count > 0 && row.positive_interval_seconds > 0);
  const shots = usable.reduce((total, row) => total + row.shot_count, 0);
  return shots > 0 ? usable.reduce((total, row) => total + row.positive_interval_seconds, 0) / shots : null;
}

export type CycleTimeTrendPoint = { date: string; label: string; [key: string]: number | string | null };

export function cycleTimeAttribution(parts: CycleTimePart[]): CycleTimeAttribution {
  const sources = [...new Set(parts.map((part) => part.attribution))];
  return sources.length > 1 ? "mixed" : sources[0] ?? "unattributed";
}

export function buildCycleTimeTrend(rows: CycleTimeDaily[], startDate: string, endDate: string) {
  const days = cycleTimeRangeDays(startDate, endDate);
  if (days < 1 || days > CYCLE_TIME_MAX_DAYS) return { machines: [], points: [] };
  const machines = [...new Set(rows.map((row) => row.machine_number))].sort((a, b) => a - b);
  const groups = new Map<string, CycleTimeDaily[]>();
  for (const row of rows) {
    const key = `${row.business_date}:${row.machine_number}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const points: CycleTimeTrendPoint[] = Array.from({ length: days }, (_, index) => {
    const date = shiftCycleTimeDate(startDate, index);
    const point: CycleTimeTrendPoint = { date, label: date.slice(5) };
    for (const machine of machines) {
      const machineRows = groups.get(`${date}:${machine}`) ?? [];
      point[`machine_${machine}`] = weightedCycleTime(machineRows);
      point[`attribution_${machine}`] = cycleTimeAttribution(machineRows.flatMap((row) => row.parts));
    }
    return point;
  });
  return { machines, points };
}

/** Compare the actual adjacent business day; do not skip over missing days. */
export function cycleTimePreviousDay(rows: CycleTimeDaily[], endDate: string) {
  const current = weightedCycleTime(rows.filter((row) => row.business_date === endDate));
  const previous = weightedCycleTime(rows.filter((row) => row.business_date === shiftCycleTimeDate(endDate, -1)));
  return { current, previous, change: current !== null && previous !== null ? current - previous : null };
}
