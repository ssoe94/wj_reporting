export type HrLaborDayType = 'workday' | 'rest_day' | 'public_holiday' | 'adjusted_workday';
export type HrEmployerContribution = { rate_percent: string | null; base: 'gross' | 'fixed' | null; fixed_amount: string | null };
export type HrLaborRules = {
  multipliers: { workday: string; rest_day: string; public_holiday: string };
  contract: { days_per_month: string; hours_per_day: string };
  hourly_premium: { enabled: boolean; confirmed: boolean };
  department_overtime: Record<string, string | null>;
  weekday_excluded_titles: { titles: string[]; confirmed: boolean };
  department_hours_include_fixed_overtime: boolean | null;
  employer_contributions: Record<'social_insurance' | 'housing_fund', Record<'contract' | 'hourly', HrEmployerContribution>>;
};
export type HrLaborHistory = {
  id: number; version: number; before: Record<string, unknown> | null; after: Record<string, unknown>;
  reason: string; actor_label: string; created_at: string;
};
export type HrLaborStandards = {
  month: string; version: number; source_month: string | null; source_version: number;
  rules: HrLaborRules; periods: { month: string; version: number }[]; history: HrLaborHistory[];
};
export type HrLaborCalendar = { month: string; version: number; days: Record<string, HrLaborDayType>; history: HrLaborHistory[] };

export function laborCalendarDates(month: string) {
  const [year, ordinal] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, ordinal, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}
export function laborDefaultDay(date: string): HrLaborDayType {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? 'rest_day' : 'workday';
}
export function laborDayLabel(type: HrLaborDayType, ko: boolean) {
  return ({ workday: ko ? '근무일' : '工作日', rest_day: ko ? '휴일' : '休息日', public_holiday: ko ? '법정 공휴일' : '法定节假日', adjusted_workday: ko ? '조정 근무일' : '调休工作日' })[type];
}
export function pendingLaborItems(rules: HrLaborRules, ko: boolean): string[] {
  const result: string[] = [];
  if (!rules.hourly_premium.confirmed) result.push(ko ? '시급직 할증 미확정' : '小时工加成未确认');
  if (!rules.weekday_excluded_titles.confirmed) result.push(ko ? '평일 연장수당 제외 직무 미확정' : '平日加班费除外职务未确认');
  if (rules.department_hours_include_fixed_overtime === null) result.push(ko ? '고정 연장수당 포함 여부 미확정' : '是否包含固定平时加班未确认');
  for (const [name, hours] of Object.entries(rules.department_overtime)) if (hours === null) result.push(`${name} ${ko ? '야근 시간 미입력' : '加班时数未填写'}`);
  for (const fund of ['social_insurance', 'housing_fund'] as const) for (const type of ['contract', 'hourly'] as const) {
    const rule = rules.employer_contributions[fund][type];
    if (rule.rate_percent === null || rule.base === null || (rule.base === 'fixed' && rule.fixed_amount === null)) {
      result.push(`${fund === 'social_insurance' ? (ko ? '사회보험' : '社会保险') : (ko ? '공적금' : '公积金')} · ${type === 'contract' ? (ko ? '계약직' : '合同工') : (ko ? '시급직' : '小时工')} ${ko ? '미입력' : '未填写'}`);
    }
  }
  return result;
}
export function laborHistoryChanges(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  function flatten(value: unknown, path: string, output: Record<string, unknown>) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) flatten(child, path ? `${path}.${key}` : key, output);
    } else output[path] = value;
  }
  const oldValues: Record<string, unknown> = {}; const newValues: Record<string, unknown> = {};
  flatten(before ?? {}, '', oldValues); flatten(after, '', newValues);
  return [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])].flatMap((path) => JSON.stringify(oldValues[path]) === JSON.stringify(newValues[path]) ? [] : [{ path, before: oldValues[path], after: newValues[path] }]);
}
