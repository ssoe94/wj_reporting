export type HrLaborDayType = 'workday' | 'rest_day' | 'public_holiday' | 'adjusted_workday';
export type HrContributionItem = { employer_rate: string | null; employee_rate: string | null };
export type HrContributionBase = { rule: null | 'common' | 'employee' | 'gross'; common_amount: string | null; employee_amounts: Record<string, string>; lower: string | null; upper: string | null };
export type HrContribution = { applies_to: { contract: boolean | null; hourly: boolean | null }; base: HrContributionBase; items: Record<string, HrContributionItem> };
export type HrHourlyOverride = { employee_id: number; effective_month: string; amount: string; reason: string };
export type HrActualPaymentAmounts = Record<'social_insurance' | 'housing_fund', { total: string | null; contract: string | null; hourly: string | null }>;
export type HrLaborActualPayments = { month: string; version: number; measurement: 'actual'; amounts: HrActualPaymentAmounts; evidence_memo: string; history: HrLaborHistory[] };
export type HrLaborRules = {
  multipliers: { workday: string; rest_day: string; public_holiday: string };
  contract: { days_per_month: string; hours_per_day: string };
  hourly_premium: { enabled: boolean; confirmed: boolean };
  department_overtime: Record<string, string | null>;
  weekday_excluded_titles: { titles: string[]; confirmed: boolean };
  department_hours_include_fixed_overtime: boolean | null;
  contributions: Record<'social_insurance' | 'housing_fund', HrContribution>;
  hourly_rates: { company_default: { amount: string | null; confirmed: boolean }; employee_overrides: HrHourlyOverride[] };
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
export function laborContributionLabel(key: string, ko: boolean) {
  return ({ social_insurance: ko ? '사회보험' : '社会保险', housing_fund: ko ? '공적금' : '公积金', pension: ko ? '양로' : '养老', medical: ko ? '의료' : '医疗', unemployment: ko ? '실업' : '失业', work_injury: ko ? '공상' : '工伤', maternity: ko ? '생육' : '生育' } as Record<string, string>)[key] ?? key;
}
export function pendingLaborItems(rules: HrLaborRules, ko: boolean): string[] {
  const result: string[] = [];
  if (rules.hourly_rates.company_default.amount === null) result.push(ko ? '회사 기본 시급 미입력' : '公司默认时薪未填写');
  else if (!rules.hourly_rates.company_default.confirmed) result.push(ko ? '회사 기본 시급 미확정' : '公司默认时薪未确认');
  if (!rules.hourly_premium.confirmed) result.push(ko ? '시급직 할증 미확정' : '小时工加成未确认');
  if (!rules.weekday_excluded_titles.confirmed) result.push(ko ? '평일 연장수당 제외 직무 미확정' : '平日加班费除外职务未确认');
  if (rules.department_hours_include_fixed_overtime === null) result.push(ko ? '고정 연장수당 포함 여부 미확정' : '是否包含固定平时加班未确认');
  for (const [name, hours] of Object.entries(rules.department_overtime)) if (hours === null) result.push(`${name} ${ko ? '야근 시간 미입력' : '加班时数未填写'}`);
  for (const key of ['social_insurance', 'housing_fund'] as const) {
    const fund = rules.contributions[key]; const label = laborContributionLabel(key, ko);
    if (Object.values(fund.applies_to).some((value) => value === null)) result.push(`${label} ${ko ? '고용형태별 적용 미확정' : '适用用工类型未确认'}`);
    if (!fund.base.rule || (fund.base.rule === 'common' && fund.base.common_amount === null) || (fund.base.rule === 'employee' && !Object.keys(fund.base.employee_amounts).length)) result.push(`${label} ${ko ? '기준액 미입력' : '基数未填写'}`);
    for (const [item, rates] of Object.entries(fund.items)) if (rates.employer_rate === null || rates.employee_rate === null) result.push(`${label} · ${laborContributionLabel(item, ko)} ${ko ? '요율 미입력' : '费率未填写'}`);
  }
  return result;
}
export type HrLaborSummaryRow = { id: string; label: string; value: string; status: 'confirmed' | 'unconfirmed' | 'missing'; month: string | null };
export function laborSummaryRows(rules: HrLaborRules, month: string | null, ko: boolean): HrLaborSummaryRow[] {
  const rows: HrLaborSummaryRow[] = [
    { id: 'hours', label: ko ? '하루 기준 시간' : '日标准时数', value: rules.contract.hours_per_day, status: 'confirmed', month },
    { id: 'days', label: ko ? '월 기준 일수' : '月标准天数', value: rules.contract.days_per_month, status: 'confirmed', month },
    ...Object.entries(rules.multipliers).map(([type, value]) => ({ id: type, label: `${laborDayLabel(type as HrLaborDayType, ko)} ${ko ? '배수' : '倍数'}`, value, status: 'confirmed' as const, month })),
    { id: 'hourly', label: ko ? '회사 기본 시급 (CNY)' : '公司默认时薪 (CNY)', value: `${rules.hourly_rates.company_default.amount ?? '—'}${rules.hourly_rates.company_default.amount === '24.50' && !rules.hourly_rates.company_default.confirmed ? (ko ? ' · 합성 기본값 / 확인 필요' : ' · 合成默认值 / 待确认') : ''}`, status: rules.hourly_rates.company_default.amount === null ? 'missing' : rules.hourly_rates.company_default.confirmed ? 'confirmed' : 'unconfirmed', month },
  ];
  for (const key of ['social_insurance', 'housing_fund'] as const) {
    const fund = rules.contributions[key]; const label = laborContributionLabel(key, ko);
    for (const [item, rates] of Object.entries(fund.items)) rows.push({ id: `${key}.${item}`, label: `${label} · ${laborContributionLabel(item, ko)} (%)`, value: `${ko ? '회사' : '公司'} ${rates.employer_rate ?? '—'} / ${ko ? '직원' : '员工'} ${rates.employee_rate ?? '—'}`, status: rates.employer_rate === null || rates.employee_rate === null ? 'missing' : 'confirmed', month });
    const rule = fund.base.rule;
    rows.push({ id: `${key}.base`, label: `${label} ${ko ? '기준액' : '基数'}`, value: rule === 'gross' ? (ko ? '응발액' : '应发工资') : rule === 'common' ? `${ko ? '회사 공통' : '公司统一'} ${fund.base.common_amount ?? '—'} CNY` : rule === 'employee' ? `${ko ? '직원별' : '按员工'} ${Object.keys(fund.base.employee_amounts).length}${ko ? '명' : '人'}` : '—', status: !rule || (rule === 'common' && fund.base.common_amount === null) || (rule === 'employee' && !Object.keys(fund.base.employee_amounts).length) ? 'missing' : 'confirmed', month });
    rows.push({ id: `${key}.bounds`, label: `${label} ${ko ? '기준액 하한 / 상한' : '基数下限 / 上限'}`, value: `${fund.base.lower ?? (ko ? '제한 없음' : '不限')} / ${fund.base.upper ?? (ko ? '제한 없음' : '不限')}`, status: fund.base.rule === null ? 'missing' : 'confirmed', month });
    const applies = (type: 'contract' | 'hourly') => fund.applies_to[type] === null ? (ko ? '미확정' : '未确认') : fund.applies_to[type] ? (ko ? '적용' : '适用') : (ko ? '미적용' : '不适用');
    rows.push({ id: `${key}.applies`, label: `${label} ${ko ? '적용' : '适用范围'}`, value: `${ko ? '계약직' : '合同工'} ${applies('contract')} / ${ko ? '시급직' : '小时工'} ${applies('hourly')}`, status: Object.values(fund.applies_to).some((value) => value === null) ? 'unconfirmed' : 'confirmed', month });
  }
  return rows;
}
export function laborHistoryChanges(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  function flatten(value: unknown, path: string, output: Record<string, unknown>) {
    if (value !== null && typeof value === 'object' && (!Array.isArray(value) || value.every((item) => item !== null && typeof item === 'object'))) {
      for (const [key, child] of Object.entries(value)) flatten(child, path ? `${path}.${key}` : key, output);
    } else output[path] = value;
  }
  const oldValues: Record<string, unknown> = {}; const newValues: Record<string, unknown> = {};
  flatten(before ?? {}, '', oldValues); flatten(after, '', newValues);
  return [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])].flatMap((path) => JSON.stringify(oldValues[path]) === JSON.stringify(newValues[path]) ? [] : [{ path, before: oldValues[path], after: newValues[path] }]);
}

export function actualPaymentIssue(amounts: HrActualPaymentAmounts): 'invalid_amount' | 'total_required' | 'breakdown_mismatch' | null {
  const cents = (value: string) => { const [whole, decimal = ''] = value.split('.'); return Number(`${whole}${decimal.padEnd(2, '0')}`); };
  for (const fund of Object.values(amounts)) {
    for (const amount of Object.values(fund)) if (amount !== null && (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(amount) || !Number.isSafeInteger(cents(amount)) || cents(amount) > 99_999_999_999)) return 'invalid_amount';
    if (fund.total === null) { if ((fund.contract === null) !== (fund.hourly === null)) return 'total_required'; continue; }
    const total = cents(fund.total); const partial = (fund.contract === null ? 0 : cents(fund.contract)) + (fund.hourly === null ? 0 : cents(fund.hourly));
    if (partial > total || (fund.contract !== null && fund.hourly !== null && partial !== total)) return 'breakdown_mismatch';
  }
  return null;
}
