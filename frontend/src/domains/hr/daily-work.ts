import type { HrLaborDayType } from './labor-standards.ts';
export type HrAttendance = 'present' | 'absent' | 'personal_leave' | 'sick_leave' | 'off';
export type HrWork = { attendance: HrAttendance; regular_hours: string | null; weekday_hours: string | null; rest_hours: string | null; holiday_hours: string | null; personal_leave_hours: string | null; sick_leave_hours: string | null };
export const WORK_HOUR_FIELDS = ['regular_hours', 'weekday_hours', 'rest_hours', 'holiday_hours', 'personal_leave_hours', 'sick_leave_hours'] as const;
export const WORK_FIELDS = ['attendance', ...WORK_HOUR_FIELDS] as const;
export type HrWorkField = typeof WORK_FIELDS[number];
export type HrWorkEmployee = { id: number; code: string; name: string; employment_type: 'contract' | 'hourly'; department: string; title: string };
export type HrDayEstimate = { status: 'ready' | 'partial_missing'; amount: string | null; known_amount: string; deduction_status: 'none' | 'unconfirmed'; basis: Record<string, unknown> };
export type HrDailyRow = { employee: HrWorkEmployee; defaults: HrWork; work: HrWork; modified: string[]; estimate: HrDayEstimate };
export type HrDailySummary = { headcount: number; contract: number; hourly: number; present: number; absent: number; leave: number; off: number; overtime_hours: string; overtime_partial: boolean; status: 'ready' | 'partial_missing'; amount: string | null; known_amount: string };
export type HrDailyEventKind = 'hire' | 'terminate' | 'transfer' | 'title_change' | 'employment_change' | 'cancel';
export type HrDailyEvent = { id: number; date: string; kind: HrDailyEventKind; employee: Pick<HrWorkEmployee, 'id' | 'code' | 'name'>; before: Record<string, unknown>; after: Record<string, unknown>; reason: string; actor_label: string; created_at: string; cancelled: boolean; target_id: number | null };
export type HrDailySheet = {
  date: string; day_type: HrLaborDayType; version: number; status: 'estimated' | 'draft' | 'confirmed'; context: string; event_revision: number; can_edit: boolean;
  rows: HrDailyRow[]; summary: HrDailySummary; departments: (HrDailySummary & { department: string })[];
  days: { date: string; day_type: HrLaborDayType; status: 'estimated' | 'draft' | 'confirmed' }[];
  events: HrDailyEvent[]; history: { version: number; before: Record<string, unknown>; after: Record<string, unknown>; reason: string; actor_label: string; created_at: string }[];
};
export type HrWorkOverrides = Record<number, Partial<HrWork>>;
export type HrDailyInput = { version: number; context: string; rows: { employee_id: number; work: Partial<HrWork> }[] };
export type HrDailyEventInput = { revision: number; kind: HrDailyEventKind; reason: string; employee_id?: number; target_id?: number; changes?: { code?: string; name?: string; employment_type?: 'contract' | 'hourly'; department?: string; title?: string; base_salary?: string | null; fixed_overtime?: string | null; hourly_rate?: string | null } };
export function workValueEqual(a: unknown, b: unknown) {
  if (a === b) return true;
  return typeof a === 'string' && typeof b === 'string' && /^\d+(\.\d+)?$/.test(a) && /^\d+(\.\d+)?$/.test(b) && Number(a) === Number(b);
}
export function effectiveWork(row: HrDailyRow, overrides: HrWorkOverrides): HrWork {
  const changed = overrides[row.employee.id] ?? {}; const work = { ...row.defaults, ...changed };
  if (work.attendance === 'absent' || work.attendance === 'off') for (const field of WORK_HOUR_FIELDS) work[field] = '0';
  else if (work.attendance === 'personal_leave' || work.attendance === 'sick_leave') for (const field of WORK_HOUR_FIELDS) if (!(field in changed)) work[field] = '0';
  return work;
}
export function overridesFromSheet(sheet: HrDailySheet): HrWorkOverrides {
  const result: HrWorkOverrides = {};
  for (const row of sheet.rows) for (const field of WORK_FIELDS) if (row.modified.includes(field)) {
    result[row.employee.id] = { ...result[row.employee.id], [field]: row.work[field] };
  }
  return result;
}
export function setDailyWork(sheet: HrDailySheet, overrides: HrWorkOverrides, id: number, change: Partial<HrWork>): HrWorkOverrides {
  const row = sheet.rows.find((item) => item.employee.id === id); if (!row) return overrides;
  const value = { ...overrides[id], ...change };
  const attendance = value.attendance ?? row.defaults.attendance;
  const baseline = { ...row.defaults };
  if (attendance === 'absent' || attendance === 'off') for (const field of WORK_HOUR_FIELDS) delete value[field];
  if (attendance === 'personal_leave' || attendance === 'sick_leave') for (const field of WORK_HOUR_FIELDS) baseline[field] = '0';
  for (const field of WORK_FIELDS) if (field in value && workValueEqual(value[field], baseline[field])) delete value[field];
  const result = { ...overrides }; if (Object.keys(value).length) result[id] = value; else delete result[id]; return result;
}
export function dailyRowsPayload(overrides: HrWorkOverrides) {
  return Object.entries(overrides).filter(([, value]) => Object.keys(value).length).sort(([a], [b]) => Number(a) - Number(b)).map(([id, work]) => ({ employee_id: Number(id), work: Object.fromEntries(WORK_FIELDS.filter((field) => field in work).map((field) => [field, work[field]])) as Partial<HrWork> }));
}
export const dailyDraftKey = (overrides: HrWorkOverrides) => JSON.stringify(dailyRowsPayload(overrides));
export function dailyBulkDefaults(sheet: HrDailySheet, overrides: HrWorkOverrides, department: string) {
  const next = { ...overrides }; for (const row of sheet.rows) if (row.employee.department === department) delete next[row.employee.id]; return next;
}
export function dailyBulkOff(sheet: HrDailySheet, overrides: HrWorkOverrides, department: string) {
  let next = overrides;
  for (const row of sheet.rows) if (row.employee.department === department) next = setDailyWork(sheet, next, row.employee.id, { attendance: 'off' });
  return next;
}
export function dailyOvertimeField(type: HrLaborDayType) { return type === 'public_holiday' ? 'holiday_hours' : type === 'rest_day' ? 'rest_hours' : 'weekday_hours'; }
export function dailyBulkOvertime(sheet: HrDailySheet, overrides: HrWorkOverrides, ids: number[], hours: string | null) {
  return ids.reduce((next, id) => {
    const row = sheet.rows.find((entry) => entry.employee.id === id); if (!row) return next;
    const work = effectiveWork(row, next); const field = dailyOvertimeField(sheet.day_type);
    if (work.attendance === 'absent' || (field === 'weekday_hours' && (row.estimate.basis.weekday_exempt === true || work.attendance === 'off'))) return next;
    return setDailyWork(sheet, next, id, { [field]: hours, ...(work.attendance === 'off' && field !== 'weekday_hours' && hours !== null && Number(hours) > 0 ? { attendance: 'present' as const } : {}) });
  }, overrides);
}
export function copyPreviousDaily(previous: HrDailySheet, current: HrDailySheet, overrides: HrWorkOverrides) {
  let result = overrides; let copied = 0; let retained = 0;
  const sameCategory = dailyOvertimeField(previous.day_type) === dailyOvertimeField(current.day_type);
  for (const row of current.rows) {
    const from = previous.rows.find((item) => item.employee.id === row.employee.id); if (!from) continue;
    if (sameCategory) { result = setDailyWork(current, result, row.employee.id, from.work); copied += 1; }
    else if (['absent', 'personal_leave', 'sick_leave'].includes(from.work.attendance)) {
      result = setDailyWork(current, result, row.employee.id, { attendance: from.work.attendance, regular_hours: '0', weekday_hours: '0', rest_hours: '0', holiday_hours: '0', personal_leave_hours: from.work.personal_leave_hours, sick_leave_hours: from.work.sick_leave_hours }); copied += 1;
    } else retained += 1;
  }
  return { overrides: result, copied, retained };
}
export function dailyLocalChanges(original: HrDailySheet, overrides: HrWorkOverrides) {
  const saved = overridesFromSheet(original);
  return original.rows.flatMap((row) => {
    const work = effectiveWork(row, overrides); const current = overrides[row.employee.id] ?? {}; const before = saved[row.employee.id] ?? {};
    return WORK_FIELDS.filter((field) => !workValueEqual(current[field], before[field])
      && (field === 'attendance' || !['absent', 'off'].includes(work.attendance))
      && !workValueEqual(work[field], row.work[field])).map((field) => ({ employee: row.employee, field, before: row.work[field], value: work[field], restoreDefault: !(field in current) }));
  });
}
export function reapplyDailyChanges(original: HrDailySheet, overrides: HrWorkOverrides, latest: HrDailySheet) {
  let result = overridesFromSheet(latest); const removed = new Set<number>();
  for (const change of dailyLocalChanges(original, overrides)) {
    if (!latest.rows.some((row) => row.employee.id === change.employee.id)) { removed.add(change.employee.id); continue; }
    if (change.restoreDefault) { const value = { ...result[change.employee.id] }; delete value[change.field]; result = { ...result, [change.employee.id]: value }; result = setDailyWork(latest, result, change.employee.id, {}); }
    else result = setDailyWork(latest, result, change.employee.id, { [change.field]: change.value });
  }
  return { overrides: result, removed: [...removed] };
}
export function dailyDateOffset(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export function todayHrDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}-${parts.find((part) => part.type === 'day')?.value}`;
}
export function initialDailyDate(search = window.location.search, today = todayHrDate()) {
  const query = new URLSearchParams(search);
  const date = query.get('date');
  const selectedMonth = query.get('month');
  const month = selectedMonth && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(selectedMonth) ? selectedMonth : null;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && (!month || date.slice(0, 7) === month)) {
    const parsed = new Date(`${date}T12:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) return date;
  }
  return month && today.slice(0, 7) !== month ? `${month}-01` : today;
}
