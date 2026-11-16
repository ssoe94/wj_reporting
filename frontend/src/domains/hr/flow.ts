import {
  HR_DASHBOARD_PATH, HR_DAILY_WORK_PATH, HR_LABOR_COST_PATH, HR_LABOR_FORECAST_PATH,
  HR_LABOR_STANDARDS_PATH, HR_PERSONNEL_PATH, HR_ROSTER_PATH, HR_WORK_PATH,
} from '../auth/hr-access.ts';

export const HR_PAGES = [
  { page: 'dashboard', path: HR_DASHBOARD_PATH, label: ['인사 대시보드', '人事总览'] },
  { page: 'personnel', path: HR_PERSONNEL_PATH, label: ['급여·인원', '工资·人员'] },
  { page: 'work', path: HR_WORK_PATH, label: ['근무·인건비 예상', '出勤·人工成本预测'] },
] as const;

export const PERSONNEL_STEPS = ['upload', 'roster', 'assign', 'cost'] as const;
export const WORK_STEPS = ['daily', 'forecast', 'standards'] as const;
export type HrFlowPage = typeof HR_PAGES[number]['page'];
export type PersonnelStep = typeof PERSONNEL_STEPS[number];
export type WorkStep = typeof WORK_STEPS[number];
export type HrStep = PersonnelStep | WorkStep;

export const LEGACY_HR_ROUTES = [
  { path: HR_ROSTER_PATH, page: 'personnel', step: 'roster' },
  { path: HR_LABOR_COST_PATH, page: 'personnel', step: 'cost' },
  { path: HR_DAILY_WORK_PATH, page: 'work', step: 'daily' },
  { path: HR_LABOR_FORECAST_PATH, page: 'work', step: 'forecast' },
  { path: HR_LABOR_STANDARDS_PATH, page: 'work', step: 'standards' },
] as const;

const labels = {
  upload: ['급여 파일 올리기', '上传工资表'],
  roster: ['사번 확인', '工号确认'],
  assign: ['부서·파트 배치', '部门·小组配置'],
  cost: ['인건비 집계', '人工成本汇总'],
  daily: ['일별 근무', '每日出勤'],
  forecast: ['이달 예상', '本月预测'],
  standards: ['기준', '标准设置'],
};

export function hrStepLabel(step: HrStep, ko: boolean) {
  return labels[step][ko ? 0 : 1];
}

export function hrPageForPath(pathname: string) {
  const path = pathname.replace(/\/+$/, '').toLowerCase();
  return HR_PAGES.find(item => item.path === path)?.page
    ?? LEGACY_HR_ROUTES.find(item => item.path === path)?.page;
}

export function personnelStep(search: string, hasPayroll: boolean): PersonnelStep {
  const step = new URLSearchParams(search).get('step');
  return PERSONNEL_STEPS.find(item => item === step) ?? (hasPayroll ? 'assign' : 'upload');
}

export function workStep(search: string): WorkStep {
  const step = new URLSearchParams(search).get('step');
  return WORK_STEPS.find(item => item === step) ?? 'daily';
}

export function hrFlowHref(page: HrFlowPage, step?: HrStep, month?: string, search = '', hash = '') {
  const params = new URLSearchParams(search);
  if (step) params.set('step', step);
  else params.delete('step');
  if (month) params.set('month', month);
  const query = params.toString();
  return HR_PAGES.find(item => item.page === page)!.path + (query ? `?${query}` : '') + hash;
}

export function legacyHrHref(pathname: string, search: string, hash = '') {
  const path = pathname.replace(/\/+$/, '').toLowerCase();
  const legacy = LEGACY_HR_ROUTES.find(item => item.path === path);
  return legacy ? hrFlowHref(legacy.page, legacy.step, undefined, search, hash) : null;
}
