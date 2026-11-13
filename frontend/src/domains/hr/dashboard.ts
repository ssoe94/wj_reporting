export type DashboardEmployment = 'contract' | 'hourly' | 'unknown';
export type DashboardMetric = {
  value: number | string | null;
  status: 'ready' | 'partial' | 'missing';
  basis: { month: string | null; formula: string; estimated: boolean; [key: string]: unknown };
};
export type DashboardCounts = Record<'total' | DashboardEmployment, DashboardMetric>;
export type DashboardMoves = Record<'hires' | 'exits' | 'transfers', DashboardCounts>;
export type DashboardNode = {
  id: string;
  name: string;
  parent_id: string | null;
  path: string[];
  direct: DashboardCounts;
  inclusive: DashboardCounts;
  payroll: DashboardMetric;
  per_person: DashboardMetric;
  overtime_pay: DashboardMetric;
  load: {
    contract_average: DashboardMetric;
    hourly_average: DashboardMetric;
    rest_worker_ratio: DashboardMetric;
    maximum: Record<'contract' | 'hourly', string | null>;
  };
  leaders: string[];
  unassigned: boolean;
};
export type DashboardPerson = {
  key: string;
  code: string;
  name: string;
  title: string;
  employment: DashboardEmployment;
  node_id: string;
  path: string[];
  tenure: DashboardMetric;
  payroll: DashboardMetric;
  load: Record<'weekday' | 'rest' | 'holiday' | 'total' | 'worked' | 'excess' | 'rate', DashboardMetric>;
  trend: { month: string; payroll: DashboardMetric; load: DashboardMetric }[];
};
export type DashboardNotice = {
  code: string;
  kind: 'info' | 'warning';
  metric: DashboardMetric;
  link: string;
  label?: string;
  month?: string;
};
export type HrDashboard = {
  month: string;
  today: string;
  source: { month: string; version: number; filename: string | null; row_count: number; basis: DashboardMetric['basis'] } | null;
  headcount: DashboardCounts;
  movements: DashboardMoves;
  turnover: Record<'contract' | 'hourly', DashboardMetric>;
  cost: {
    actual: Record<'total' | 'gross' | 'fixed' | 'overtime' | 'hourly' | 'deductions' | 'social_insurance' | 'housing_fund', DashboardMetric>;
    forecast: { month: string; total: DashboardMetric; known_amount: DashboardMetric; status: string };
  };
  load: {
    contract_average: DashboardMetric;
    hourly_average: DashboardMetric;
    above_reference: DashboardMetric;
    reference_hours: DashboardMetric;
    entered: Record<'days' | 'missing_days' | 'weekday' | 'rest' | 'holiday', DashboardMetric>;
    rankings: Record<'contract' | 'hourly', string[]>;
  };
  organization: { nodes: DashboardNode[]; people: DashboardPerson[] };
  trends: { month: string; headcount: DashboardCounts; movements: DashboardMoves; gross: DashboardMetric; per_person: DashboardMetric; overtime_share: DashboardMetric }[];
  insights: DashboardNotice[];
  needs: DashboardNotice[];
};

const numberFormat = (decimals: number) => ['ko-KR', 'zh-CN'].map(locale => new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: 2 }));
const decimalFormat = numberFormat(0);
const moneyFormat = numberFormat(2);

export function dashboardNumber(value: DashboardMetric['value'], ko: boolean, suffix = '') {
  return value == null ? '—' : `${decimalFormat[ko ? 0 : 1].format(Number(value))}${suffix}`;
}

export function dashboardMoney(value: DashboardMetric['value'], ko: boolean) {
  if (value == null) return '—';
  const amount = Number(value);
  return `${amount < 0 ? '−' : ''}¥${moneyFormat[ko ? 0 : 1].format(Math.abs(amount))}`;
}

export function dashboardEmployment(kind: DashboardEmployment, ko: boolean) {
  return ({ contract: ['계약직', '合同工'], hourly: ['시급직', '小时工'], unknown: ['고용형태 미확인', '用工类型未确认'] })[kind][ko ? 0 : 1];
}

export function dashboardStatus(status: string, ko: boolean) {
  if (status === 'ready') return ko ? '확인됨' : '已确认';
  if (status === 'partial' || status === 'partial_missing') return ko ? '일부 미확인' : '部分未确认';
  return ko ? '자료 없음' : '暂无资料';
}

export function dashboardSearch(people: DashboardPerson[], query: string) {
  const key = (text: string) => text.normalize('NFC').replace(/\s+/gu, '').toLowerCase();
  const term = key(query);
  return term ? people.filter(person => key(person.name).includes(term) || key(person.code).includes(term)) : [];
}

export function dashboardAncestorIds(id: string, byId: ReadonlyMap<string, DashboardNode>) {
  const path = new Set<string>();
  let current: string | null = id;
  while (current != null && !path.has(current) && byId.has(current)) {
    path.add(current);
    current = byId.get(current)?.parent_id ?? null;
  }
  return path;
}
