export type MesStatsPlanType = 'injection' | 'machining';
export type MesReportPresence = 'both' | 'plan_only' | 'report_only' | 'none';

export interface MesStatsRow {
  equipment_key: string;
  equipment_name: string;
  equipment_label: string;
  part_no: string;
  model_name: string;
  planned_qty: number;
  mes_qty: number;
  mes_report_count: number;
  latest_report_time: string | null;
  process_code: string;
  plan_row_count: number;
}

export interface MesStatsResponse {
  date: string;
  plan_type: MesStatsPlanType;
  range_mode: 'day';
  range_start: string;
  range_end: string;
  latest_synced_at?: string | null;
  summary: {
    total_planned: number;
    total_mes: number;
    raw_mes_count: number;
    grouped_mes_count: number;
  };
  rows: MesStatsRow[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function count(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}
function timestamp(value: unknown) {
  return value === null || (typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
}

/** Validate the selected day and source totals before an HTTP success can become evidence. */
export function parseMesReportStats(value: unknown, date: string, planType: MesStatsPlanType): MesStatsResponse {
  if (!record(value) || value.date !== date || value.plan_type !== planType || value.range_mode !== 'day'
    || typeof value.range_start !== 'string' || typeof value.range_end !== 'string'
    || Date.parse(value.range_start) !== Date.parse(`${date}T08:00:00+08:00`)
    || Date.parse(value.range_end) !== Date.parse(`${date}T08:00:00+08:00`) + 86_400_000
    || !record(value.summary) || !Array.isArray(value.rows)
    || !finite(value.summary.total_planned) || value.summary.total_planned < 0 || !finite(value.summary.total_mes)
    || !count(value.summary.raw_mes_count) || !count(value.summary.grouped_mes_count)
    || (value.latest_synced_at !== undefined && !timestamp(value.latest_synced_at))) {
    throw new Error('mes_report_evidence_invalid');
  }
  const keys = new Set<string>();
  for (const row of value.rows) {
    if (!record(row) || ['equipment_key', 'equipment_name', 'equipment_label', 'part_no', 'model_name', 'process_code'].some((key) => typeof row[key] !== 'string')
      || !row.part_no || !finite(row.planned_qty) || row.planned_qty < 0 || !finite(row.mes_qty)
      || !count(row.plan_row_count) || !count(row.mes_report_count) || !timestamp(row.latest_report_time)
      || (row.plan_row_count === 0 && row.planned_qty !== 0) || (row.mes_report_count === 0 && row.mes_qty !== 0)) {
      throw new Error('mes_report_evidence_invalid');
    }
    const key = planType === 'machining' ? row.part_no : `${row.equipment_key}\u0000${row.part_no}`;
    if (keys.has(key as string)) throw new Error('mes_report_evidence_duplicate');
    keys.add(key as string);
  }
  const result = value as unknown as MesStatsResponse;
  const sum = (field: 'mes_qty' | 'planned_qty' | 'mes_report_count') => result.rows.reduce((total, row) => total + row[field], 0);
  if (Math.abs(sum('planned_qty') - result.summary.total_planned) > 1e-6
    || Math.abs(sum('mes_qty') - result.summary.total_mes) > 1e-6
    || sum('mes_report_count') !== result.summary.grouped_mes_count) {
    throw new Error('mes_report_evidence_totals_mismatch');
  }
  return result;
}

/** Presence follows record counts, never positive quantity or legacy `matched`. */
export function getMesReportRowEvidence(row: MesStatsRow) {
  const hasPlan = row.plan_row_count > 0;
  const hasReport = row.mes_report_count > 0;
  const presence: MesReportPresence = hasPlan ? hasReport ? 'both' : 'plan_only' : hasReport ? 'report_only' : 'none';
  return {
    presence,
    planQuantity: hasPlan ? row.planned_qty : null,
    reportQuantity: hasReport ? row.mes_qty : null,
    observedGap: hasPlan && hasReport ? row.mes_qty - row.planned_qty : null,
  };
}

export function getMesReportEvidence(data: MesStatsResponse | undefined, query: { isError: boolean; isPending: boolean }) {
  const state = query.isError ? 'error' : query.isPending ? 'loading' : !data ? 'unavailable' : data.rows.length ? 'ready' : 'empty';
  const usable = state === 'ready';
  const responseUsable = usable || state === 'empty';
  const rows = usable ? data!.rows : [];
  const presences = rows.map((row) => getMesReportRowEvidence(row).presence);
  const reportCount = responseUsable ? data!.summary.grouped_mes_count : null;
  const reportTimeOutsideRange = responseUsable && rows.some((row) => row.latest_report_time !== null && (
    Date.parse(row.latest_report_time) < Date.parse(data!.range_start)
    || Date.parse(row.latest_report_time) >= Date.parse(data!.range_end)
  ));
  return {
    state,
    rows,
    planQuantity: usable && rows.some((row) => row.plan_row_count > 0) ? data!.summary.total_planned : null,
    reportQuantity: usable && reportCount! > 0 ? data!.summary.total_mes : null,
    reportCount,
    rawReportCount: responseUsable ? data!.summary.raw_mes_count : null,
    bothCount: usable ? presences.filter((presence) => presence === 'both').length : null,
    planOnlyCount: usable ? presences.filter((presence) => presence === 'plan_only').length : null,
    reportOnlyCount: usable ? presences.filter((presence) => presence === 'report_only').length : null,
    latestReportTime: rows.map((row) => row.latest_report_time).filter((time): time is string => Boolean(time)).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null,
    latestStoredTime: usable ? data!.latest_synced_at ?? null : null,
    rangeMismatch: responseUsable && (data!.summary.raw_mes_count !== data!.summary.grouped_mes_count || reportTimeOutsideRange),
  };
}
