export type BoardPartDay = { business_date: string; cycle_time_seconds: number | null; machine_numbers: number[] };

/** Keep unavailable production dates as gaps; never interpolate or substitute zero. */
export function boardPartTrend(daily: BoardPartDay[]) {
  const points = [...daily].sort((a, b) => a.business_date.localeCompare(b.business_date)).map((day) => ({
    ...day,
    label: day.business_date.slice(5),
    cycle_time_seconds: day.cycle_time_seconds !== null && Number.isFinite(day.cycle_time_seconds) && day.cycle_time_seconds > 0 ? day.cycle_time_seconds : null,
  }));
  const available = points.filter((day) => day.cycle_time_seconds !== null);
  const values = available.map((day) => day.cycle_time_seconds as number);
  const minimum = values.length ? Math.min(...values) : null;
  const maximum = values.length ? Math.max(...values) : null;
  return {
    points,
    latest: available.at(-1) ?? null,
    minimum,
    maximum,
    minimumPoint: available.find(day => day.cycle_time_seconds === minimum) ?? null,
    maximumPoint: available.find(day => day.cycle_time_seconds === maximum) ?? null,
  };
}
