export const forecastComponents = ['fixed_pay', 'overtime', 'hourly_work', 'social_insurance', 'housing_fund'] as const;
export type ForecastComponent = typeof forecastComponents[number];
export type ForecastBasis = Record<string, unknown>;
export type ForecastMetric = {
  amount: string | null;
  known_amount: string;
  status: 'ready' | 'partial_missing' | 'missing';
  percentage: string | null;
  basis: ForecastBasis;
  estimate?: ForecastMetric;
  actual?: ForecastMetric;
};
export type ForecastComponents = Record<ForecastComponent, ForecastMetric>;
export type ForecastGroup = {
  name: string;
  headcount: number;
  total: ForecastMetric;
  components: ForecastComponents;
  per_person: string | null;
  percentage: string | null;
  employee_ids: number[];
  employee_amounts?: Record<string, { total: ForecastMetric; components: ForecastComponents }>;
  basis: ForecastBasis;
};
export type ForecastEmployee = {
  id: number;
  code: string;
  name: string;
  department: string;
  employment_type: 'contract' | 'hourly';
  total: ForecastMetric;
  components: ForecastComponents;
  basis: ForecastBasis;
};
export type ForecastDay = {
  date: string;
  source: 'entered' | 'default';
  known_amount: string;
  cumulative_known_amount: string;
  entered_cumulative_known_amount: string;
  default_cumulative_known_amount: string;
  status: ForecastMetric['status'];
};
export type ForecastComparison = {
  month: string;
  actual: { total: ForecastMetric; components: ForecastComponents; basis: ForecastBasis };
  total_difference: string | null;
  wage_difference?: string | null;
  components: Record<ForecastComponent, string | null>;
  employees: { id: number; code: string; name: string; forecast: string; actual: string; difference: string }[];
  reasons: string[];
  basis: ForecastBasis;
};
export type LaborForecast = {
  month: string;
  as_of: string;
  currency: 'CNY';
  basis: ForecastBasis;
  days: { entered: number; remaining: number; default_elapsed: number };
  total: ForecastMetric;
  components: ForecastComponents;
  departments: ForecastGroup[];
  visual_departments: ForecastGroup[];
  employment: ForecastGroup[];
  employees: ForecastEmployee[];
  daily: ForecastDay[];
  comparison: ForecastComparison | null;
  previous: ForecastComparison | null;
  deductions: { status: 'unconfirmed' | 'none'; personal_leave_hours: string; sick_leave_hours: string; missing_hours?: string[]; amount: null };
  payroll: { uploaded: boolean; version: number | null };
};

export function comparisonForecastMetric(components: ForecastComponents, key: ForecastComponent, comparison: ForecastComparison) {
  const component = components[key];
  // Current-period fund deltas compare the rate estimate with the actual
  // payment, even though the company forecast adopts the payment.
  return comparison.basis.fund_component_basis === 'estimate_minus_actual'
    && (key === 'social_insurance' || key === 'housing_fund')
    ? component.estimate ?? component : component;
}

export function forecastChartPoints(days: ForecastDay[]) {
  // Convert the server's cumulative decimal strings for SVG coordinates only.
  return days.map(day => ({
    ...day,
    entered: Number(day.entered_cumulative_known_amount),
    default: Number(day.default_cumulative_known_amount),
  }));
}

export function forecastMetricLabel(metric: ForecastMetric, ko: boolean) {
  if (metric.status === 'ready' && metric.amount != null) return null;
  return metric.status === 'missing'
    ? (ko ? '미입력' : '未填写')
    : (ko ? '일부 미입력' : '部分未填写');
}

export function forecastReasonLabel(reason: string, ko: boolean) {
  switch (reason) {
    case 'fixed_pay_not_acquired':
      return ko ? '기준 급여 미확보(재업로드 필요)' : '未取得基准工资（需重新上传）';
    case 'other_fixed_items_not_acquired':
      return ko ? '입사·변경 기록의 기본급과 고정 연장수당만 반영했습니다. 기타 고정 항목은 미확보입니다.' : '已计入入职或变动记录中的基本工资与固定加班费，其他固定项目尚未取得。';
    case 'no_workdays':
      return ko ? '이달 근무일이 없어 급여 일할 비율을 계산할 수 없습니다.' : '本月没有工作日，无法计算工资折算比例。';
    case 'hourly_no_premium':
      return ko ? '과거 시급직 급여표에 할증 열이 없어 적용 기준이 다를 수 있습니다.' : '历史小时工工资表缺少加成列，适用口径可能不同。';
    case 'deduction_unconfirmed':
      return ko ? '개인 휴가·병가 공제 산식 미확정' : '事假、病假扣款公式待确认';
    case 'variable_fixed_items':
      return ko ? '상여·고온수당 등 고정 급여에 포함된 항목은 월별로 달라질 수 있습니다.' : '计入固定工资的奖金、高温津贴等项目可能按月变动。';
    case 'actual_vs_estimate':
      return ko ? '회사 부담 실제 납부액과 요율로 계산한 추정액에 차이가 있습니다.' : '公司实缴金额与按费率计算的估算金额存在差异。';
    default:
      return null;
  }
}
