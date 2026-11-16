import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessHr } from '../../domains/auth/hr-access';
import { getLaborForecast } from '../../domains/hr/labor-forecast-api';
import { hrFlowHref } from '../../domains/hr/flow';
import { comparisonForecastMetric, forecastChartPoints, forecastComponents, forecastMetricLabel, forecastReasonLabel } from '../../domains/hr/labor-forecast';
import type { ForecastBasis, ForecastComparison, ForecastComponent, ForecastEmployee, ForecastGroup, ForecastMetric, LaborForecast } from '../../domains/hr/labor-forecast';
import { laborGrossPayLabel } from '../../domains/hr/labor-standards';
import { useLang } from '../../i18n';
import { HrLoadState, HrShell, useHrMonth } from './hrCommon';
import './hr-forecast.css';

const labels: Record<ForecastComponent, [string, string]> = {
  fixed_pay: ['고정 급여', '固定工资'],
  overtime: ['야근·휴일 수당', '加班及节假日津贴'],
  hourly_work: ['시급직 근무', '小时工工资'],
  social_insurance: ['사회보험(회사)', '社会保险（公司）'],
  housing_fund: ['공적금(회사)', '住房公积金（公司）'],
};
const formatters = ['ko-KR', 'zh-CN'].map(locale => new Intl.NumberFormat(locale, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));
const textLabel = (key: ForecastComponent, ko: boolean) => labels[key][ko ? 0 : 1];
const percentage = (value: string | null) => value == null ? '—' : `${value}%`;
const money = (value: string | null, ko: boolean) => value == null ? '—' : `${value.startsWith('-') ? '−' : ''}¥${formatters[ko ? 0 : 1].format(Math.abs(Number(value)))}`;
const difference = (value: string | null, ko: boolean) => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${money(value, ko)}`;
const knownCaption = (ko: boolean) => ko ? '확인된 금액' : '已知金额';
const groupName = (name: string, ko: boolean) => name || (ko ? '미분류' : '未分类');
const employmentLabel = (name: string, ko: boolean) => name === 'contract' ? (ko ? '계약직' : '合同工')
  : name === 'hourly' ? (ko ? '시급직' : '小时工') : groupName(name, ko);
const record = (value: unknown): ForecastBasis | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as ForecastBasis : undefined;

function Amount({ metric, ko }: { metric: ForecastMetric; ko: boolean }) {
  const status = forecastMetricLabel(metric, ko);
  if (!status) return <span className="hr-forecast-money">{money(metric.amount, ko)}</span>;
  return <span className="hr-forecast-metric">
    <span className="hr-forecast-missing">{status}</span>
    {metric.status === 'partial_missing' && <small>{knownCaption(ko)} <span className="hr-forecast-money">{money(metric.known_amount, ko)}</span></small>}
  </span>;
}

function Summary({ forecast, ko }: { forecast: LaborForecast; ko: boolean }) {
  const title = useId();
  const previous = forecast.previous;
  const wageOnly = previous?.total_difference == null && previous?.wage_difference != null;
  return <section className="hr-panel hr-forecast-summary" aria-labelledby={title}>
    <div className="hr-forecast-total">
      <h2 id={title}>{forecast.month} {ko ? '예상 인건비' : '预计人工成本'}</h2>
      <strong><Amount metric={forecast.total} ko={ko} /></strong>
    </div>
    <dl>
      <div><dt>{ko ? '기준일' : '基准日'}</dt><dd>{forecast.as_of}</dd></div>
      <div><dt>{ko ? '입력 실적 / 남은 날짜' : '录入实绩 / 剩余日期'}</dt>
        <dd>{forecast.days.entered} / {forecast.days.remaining} {ko ? '일' : '天'}</dd>
        {forecast.days.default_elapsed > 0 && <small>{ko ? '지난 미입력' : '已过未录入'} {forecast.days.default_elapsed} {ko ? '일' : '天'}</small>}
      </div>
      <div><dt>{ko ? '전월 실제 대비' : '较上月实际'}</dt>
        <dd>{previous ? difference(previous.total_difference ?? previous.wage_difference ?? null, ko) : '—'}</dd>
        {previous && <small>{previous.month} · {wageOnly ? (ko ? '급여만 비교' : '仅比较工资') : (ko ? '예상 − 실제' : '预测 − 实际')}</small>}
      </div>
    </dl>
  </section>;
}

function Components({ forecast, ko }: { forecast: LaborForecast; ko: boolean }) {
  const title = useId();
  const denominator = String(forecast.basis.percentage_denominator ?? forecast.total.amount ?? forecast.total.known_amount);
  const fixedUnavailable = forecast.employees.some(employee =>
    Array.isArray(employee.basis.fixed_pay_periods)
    && employee.basis.fixed_pay_periods.some(period => record(period)?.missing_reason === 'fixed_pay_not_acquired'));
  return <section className="hr-forecast-components" aria-labelledby={title}>
    <div className="hr-forecast-heading">
      <h2 id={title}>{ko ? '인건비 구성' : '人工成本构成'}</h2>
      <span>{ko ? '비율 분모' : '比例分母'} · {forecast.total.status === 'ready' ? (ko ? '예상 총액' : '预计总额') : knownCaption(ko)} {money(denominator, ko)}</span>
    </div>
    <div className="hr-forecast-card-grid">
      {forecastComponents.map(key => {
        const metric = forecast.components[key];
        return <article className="hr-panel hr-forecast-card" data-component={key} key={key}>
          <h3>{textLabel(key, ko)}</h3>
          <div className="hr-forecast-card-value">
            <strong><Amount metric={metric} ko={ko} /></strong>
            <span className="hr-forecast-money">{percentage(metric.percentage)}</span>
          </div>
          {key === 'fixed_pay' && fixedUnavailable && <small className="hr-forecast-missing">{forecastReasonLabel('fixed_pay_not_acquired', ko)}</small>}
          {metric.estimate && <dl>
            <div><dt>{ko ? '실제 납부' : '实际缴费'}</dt><dd>{metric.actual ? <Amount metric={metric.actual} ko={ko} /> : '—'}</dd></div>
            <div><dt>{ko ? '요율 추정' : '按费率估算'}</dt><dd><Amount metric={metric.estimate} ko={ko} /></dd></div>
          </dl>}
        </article>;
      })}
    </div>
  </section>;
}

function EmployeeBasis({ employee, ko }: { employee: ForecastEmployee; ko: boolean }) {
  const basis = employee.basis;
  const periods: ForecastBasis[] = Array.isArray(basis.fixed_pay_periods)
    ? basis.fixed_pay_periods.map(record).filter((item): item is ForecastBasis => !!item) : [];
  const rateLabels: Record<string, [string, string]> = {
    pension: ['양로보험', '养老保险'], medical: ['의료보험', '医疗保险'], unemployment: ['실업보험', '失业保险'],
    work_injury: ['산재보험', '工伤保险'], maternity: ['출산보험', '生育保险'], housing_fund: ['공적금', '住房公积金'],
  };
  return <div className="hr-forecast-basis">
    <strong>{ko ? '계산 근거' : '计算依据'}</strong>
    <dl>
      <div><dt>{ko ? '인건비 기준' : '人工成本标准'}</dt><dd>{String(basis.standard_month ?? '—')} · v{String(basis.standard_version ?? '—')}</dd></div>
      <div><dt>{ko ? '급여 출처 월' : '工资来源月份'}</dt><dd>{String(basis.source_month ?? '—')}</dd></div>
      <div><dt>{ko ? '재직 근무일 / 월 근무일' : '在职工作日 / 当月工作日'}</dt><dd>{String(basis.active_workdays ?? '—')} / {String(basis.month_workdays ?? '—')}</dd></div>
      <div><dt>{ko ? '계약직 근무일' : '合同工工作日'}</dt><dd>{String(basis.contract_workdays ?? '—')}</dd></div>
    </dl>
    {periods.map((period, index) => <div key={index} className="hr-forecast-period">
      <span>{ko ? '고정 급여 일할' : '固定工资折算'} · {String(period.eligible_workdays ?? '—')} / {String(period.month_workdays ?? '—')} {ko ? '일' : '天'}</span>
      {period.source_month != null && <span>{ko ? '출처' : '来源'} {String(period.source_month)}</span>}
      {period.monthly_known_amount != null && <span>{ko ? '월 기준' : '月基准'} {money(String(period.monthly_known_amount), ko)}</span>}
      {typeof period.missing_reason === 'string' && <small className="hr-forecast-missing">{forecastReasonLabel(period.missing_reason, ko)}</small>}
    </div>)}
    {(['overtime', 'hourly_work'] as const).map(key => {
      const variable = employee.components[key].basis.periods;
      return Array.isArray(variable) && variable.length > 0 ? <details className="hr-forecast-variable-basis" key={key}>
        <summary>{textLabel(key, ko)} · {ko ? '단가·시간 보기' : '查看单价与时数'}</summary>
        <ul>{variable.map((entry, index) => {
          const item = record(entry?.basis);
          if (!item) return null;
          const hours = record(item.hours_per_date);
          const factors = record(item.multipliers);
          return <li key={index}>
            {item.source === 'entered' ? (ko ? '입력 실적' : '录入实绩') : (ko ? '기본값 예상' : '默认预测')}
            {' · '}{String(item.date_count ?? '—')}{ko ? '일' : '天'}
            {' · '}{ko ? '시간당' : '每小时'} {money(item.unit_rate == null ? null : String(item.unit_rate), ko)}
            {hours && <> · {ko ? '일별 정규/평일 야근/휴일/공휴일' : '每日正常/平日加班/休息日/节假日'} {['regular', 'weekday', 'weekend', 'holiday'].map(hour => String(hours[hour] ?? '—')).join(' / ')} {ko ? '시간' : '小时'}</>}
            {factors && <> · {ko ? '평일/휴일/공휴일 배수' : '平日/休息日/节假日倍数'} {['workday', 'rest_day', 'public_holiday'].map(day => String(factors[day] ?? '—')).join(' / ')}</>}
          </li>;
        })}</ul>
      </details> : null;
    })}
    {(['social_insurance', 'housing_fund'] as const).map(key => {
      const metric = employee.components[key];
      const items = record(metric.basis.items);
      const basisData = record(metric.basis.basis) ?? metric.basis;
      const rates = items ? Object.entries(items).flatMap(([name, item]) => {
        const rate = record(record(item)?.rates)?.employer_rate;
        return rate == null ? [] : [`${rateLabels[name]?.[ko ? 0 : 1] ?? name} ${rate}%`];
      }) : [];
      return basisData.base_amount != null || rates.length ? <p key={key}>
        {textLabel(key, ko)} · {ko ? '기준액' : '基数'} {money(basisData.base_amount == null ? null : String(basisData.base_amount), ko)}
        {rates.length > 0 && ` · ${rates.join(' · ')}`}
      </p> : null;
    })}
  </div>;
}

type EmployeeAmounts = Pick<ForecastEmployee, 'total' | 'components'>;

function EmployeeRows({ members, scoped, ko }: {
  members: { employee: ForecastEmployee; amounts: EmployeeAmounts }[];
  scoped: boolean;
  ko: boolean;
}) {
  return <div className="hr-forecast-employees">
    <p>{scoped
      ? (ko ? '이 분류에 속하는 직원별 금액입니다. 계산 근거는 직원의 월 전체를 기준으로 표시합니다.' : '金额按此分组显示，计算依据涵盖员工全月。')
      : (ko ? '직원별 월 전체 예상 · 이동한 직원의 다른 부서 근무도 포함합니다.' : '员工全月预测 · 包含调动员工在其他部门的工时。')}</p>
    {members.map(({ employee, amounts }) => <details key={employee.id}>
      <summary>
        <span><strong>{employee.name}</strong><small>{employee.code} · {employmentLabel(employee.employment_type, ko)}</small></span>
        <Amount metric={amounts.total} ko={ko} />
      </summary>
      <dl className="hr-forecast-employee-components">
        {forecastComponents.map(key => <div key={key}><dt>{textLabel(key, ko)}</dt><dd><Amount metric={amounts.components[key]} ko={ko} /></dd></div>)}
      </dl>
      <EmployeeBasis employee={employee} ko={ko} />
    </details>)}
  </div>;
}

function Departments({ forecast, ko }: { forecast: LaborForecast; ko: boolean }) {
  const [view, setView] = useState<'source' | 'visual' | 'employment'>('source');
  const [expanded, setExpanded] = useState<string | null>(null);
  const title = useId();
  const expandedId = useId();
  const employees = useMemo(() => new Map(forecast.employees.map(person => [person.id, person])), [forecast.employees]);
  const groups: ForecastGroup[] = view === 'visual' ? forecast.visual_departments : view === 'employment' ? forecast.employment : forecast.departments;
  const selected = groups.find(group => group.name === expanded);
  const members = selected?.employee_ids.flatMap(id => {
    const employee = employees.get(id);
    return employee ? [{ employee, amounts: selected?.employee_amounts?.[String(id)] ?? employee }] : [];
  }) ?? [];
  return <section className="hr-panel hr-forecast-departments" aria-labelledby={title}>
    <div className="hr-forecast-heading">
      <h2 id={title}>{ko ? '부서별 인건비' : '部门人工成本'}</h2>
      <div className="hr-forecast-switch" role="group" aria-label={ko ? '인건비 분류' : '人工成本分组'}>
        {([['source', '급여 원본 부서', '工资原表部门'], ['visual', '시각화 부서', '可视化部门'], ['employment', '고용형태', '用工类型']] as const)
          .map(([key, korean, chinese]) => <button key={key} type="button" className="hr-button" aria-pressed={view === key}
            onClick={() => { setView(key); setExpanded(null); }}>{ko ? korean : chinese}</button>)}
      </div>
    </div>
    <p className="hr-forecast-note">{view === 'employment'
      ? (ko ? '고용형태별 실제 납부액이 있으면 합계에 반영합니다. 비중 분모는 고용형태별 확인 금액의 합계입니다.' : '按用工类型提供的实缴额计入合计。占比以各用工类型的已知金额合计为分母。')
      : (ko ? '부서·직원별 회사 부담금은 요율 추정으로 표시합니다. 비중은 분류별 확인된 금액을 기준으로 합니다.' : '部门和员工的公司承担额按费率估算。占比以各分组口径的已知金额合计为分母。')}</p>
    {!groups.length ? <p className="hr-forecast-note">{ko ? '이달에 집계할 직원이 없습니다.' : '本月无可汇总员工。'}</p> :
      <div className="hr-table-scroll" tabIndex={0} role="region" aria-label={ko ? '부서별 인건비 표' : '部门人工成本表'}>
        <table>
          <thead><tr>
            <th scope="col">{view === 'employment' ? (ko ? '고용형태' : '用工类型') : (ko ? '부서' : '部门')}</th>
            <th scope="col" className="hr-number">{ko ? '인원' : '人数'}</th>
            {forecastComponents.map(key => <th scope="col" className="hr-number" key={key}>{textLabel(key, ko)}</th>)}
            <th scope="col" className="hr-number">{ko ? '합계' : '合计'}</th>
            <th scope="col" className="hr-number">{ko ? '1인당' : '人均'}</th>
            <th scope="col" className="hr-number">{ko ? '비중' : '占比'}</th>
          </tr></thead>
          <tbody>{groups.map(group => {
            const open = group.name === expanded;
            const name = view === 'employment' ? employmentLabel(group.name, ko) : groupName(group.name, ko);
            return <Fragment key={group.name}><tr data-expanded={open}>
              <th scope="row"><button type="button" className="hr-forecast-expand" aria-expanded={open} aria-controls={open ? expandedId : undefined}
                onClick={() => setExpanded(open ? null : group.name)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span>{name}</span></button></th>
              <td className="hr-number">{group.headcount}</td>
              {forecastComponents.map(key => <td className="hr-number" key={key}><Amount metric={group.components[key]} ko={ko} /></td>)}
              <td className="hr-number"><Amount metric={group.total} ko={ko} /></td>
              <td className="hr-number">{money(group.per_person, ko)}</td>
              <td className="hr-number">{percentage(group.percentage)}</td>
            </tr>
            {open && <tr className="hr-forecast-expanded"><td colSpan={10}><div id={expandedId}><EmployeeRows members={members} scoped={Boolean(group.employee_amounts)} ko={ko} /></div></td></tr>}
            </Fragment>;
          })}</tbody>
        </table>
      </div>}
  </section>;
}

function ForecastChart({ forecast, ko }: { forecast: LaborForecast; ko: boolean }) {
  const title = useId();
  const points = useMemo(() => forecastChartPoints(forecast.daily), [forecast.daily]);
  const variablePay = record(forecast.basis.variable_pay);
  const entered = ko ? '입력 실적' : '录入实绩';
  const defaults = ko ? '기본값 예상' : '默认预测';
  const sourceLabel = (source: 'entered' | 'default') => source === 'entered' ? entered : defaults;
  return <section className="hr-panel hr-forecast-chart" aria-labelledby={title}>
    <div className="hr-forecast-heading"><h2 id={title}>{ko ? '일별 수당·시급직 급여 누적' : '每日津贴与小时工工资累计'}</h2><span>{forecast.month} · CNY</span></div>
    <p className="hr-forecast-note">{ko ? '확인된 금액을 누적합니다. 월 고정 급여·회사 부담금은 구성 카드에서 확인할 수 있습니다.' : '图表累计已知金额。月固定工资及公司承担额见构成卡片。'}</p>
    <ul className="hr-forecast-legend">
      {([['entered', entered], ['default', defaults]] as const).map(([key, label]) => {
        const total = variablePay?.[key] as ForecastMetric | undefined;
        return <li key={key}><span className={`hr-forecast-legend-mark is-${key}`} aria-hidden="true" />
          {label}{total && <Amount metric={total} ko={ko} />}
        </li>;
      })}
    </ul>
    <div className="hr-forecast-chart-plot" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--hr-border)" />
          <XAxis dataKey="date" tickFormatter={(date: string) => date.slice(-2)} tick={{ fill: 'var(--hr-muted)', fontSize: 13 }} minTickGap={12} />
          <YAxis width={64} tickFormatter={(value: number) => value >= 1_000 ? `${value / 1_000}k` : String(value)}
            tick={{ fill: 'var(--hr-muted)', fontSize: 13 }} />
          <Tooltip content={({ active, payload }) => {
            const point = payload?.[0]?.payload as typeof points[number] | undefined;
            return active && point ? <div className="hr-forecast-tooltip">
              <strong>{point.date} · {sourceLabel(point.source)}</strong>
              <span>{ko ? '당일' : '当日'} {money(point.known_amount, ko)}</span>
              <span>{ko ? '누적' : '累计'} {money(point.cumulative_known_amount, ko)}</span>
              {point.status !== 'ready' && <span className="hr-forecast-missing">{ko ? '일부 미입력' : '部分未填写'}</span>}
            </div> : null;
          }} />
          <Area type="linear" dataKey="entered" name={entered} stackId="known" stroke="var(--wj-info)" strokeWidth={2}
            fill="var(--wj-info)" fillOpacity={0.16} isAnimationActive={false} />
          <Area type="linear" dataKey="default" name={defaults} stackId="known" stroke="var(--wj-violet)" strokeWidth={2}
            strokeDasharray="5 4" fill="var(--wj-violet)" fillOpacity={0.11} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <details className="hr-forecast-chart-data">
      <summary>{ko ? '그래프 데이터 보기' : '查看图表数据'}</summary>
      <div className="hr-table-scroll" tabIndex={0} role="region" aria-label={ko ? '일별 그래프 데이터' : '每日图表数据'}>
        <table>
          <thead><tr><th scope="col">{ko ? '날짜' : '日期'}</th><th scope="col">{ko ? '자료' : '数据来源'}</th>
            <th scope="col" className="hr-number">{ko ? '당일 확인 금액' : '当日已知金额'}</th>
            <th scope="col" className="hr-number">{ko ? '누적 확인 금액' : '累计已知金额'}</th></tr></thead>
          <tbody>{forecast.daily.map(day => <tr key={day.date}>
            <th scope="row">{day.date}</th><td>{sourceLabel(day.source)}</td>
            <td className="hr-number">{money(day.known_amount, ko)}{day.status !== 'ready' && <small className="hr-forecast-missing">{ko ? '일부 미입력' : '部分未填写'}</small>}</td>
            <td className="hr-number">{money(day.cumulative_known_amount, ko)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </section>;
}

function ComparisonTable({ comparison, forecast, ko }: { comparison: ForecastComparison; forecast: LaborForecast; ko: boolean }) {
  return <div className="hr-table-scroll" tabIndex={0} role="region" aria-label={ko ? '구성별 예상과 실제 차이' : '各项预测与实际差额'}>
    <table>
      <thead><tr><th scope="col">{ko ? '구성' : '构成'}</th><th scope="col" className="hr-number">{ko ? '예상' : '预测'}</th>
        <th scope="col" className="hr-number">{comparison.month} {ko ? '실제' : '实际'}</th>
        <th scope="col" className="hr-number">{ko ? '예상 − 실제' : '预测 − 实际'}</th></tr></thead>
      <tbody>
        {forecastComponents.map(key => <tr key={key}><th scope="row">{textLabel(key, ko)}</th>
          <td className="hr-number"><Amount metric={comparisonForecastMetric(forecast.components, key, comparison)} ko={ko} />
            {comparisonForecastMetric(forecast.components, key, comparison) !== forecast.components[key] && <small>{ko ? '요율 추정' : '按费率估算'}</small>}</td>
          <td className="hr-number"><Amount metric={comparison.actual.components[key]} ko={ko} /></td>
          <td className="hr-number">{difference(comparison.components[key], ko)}</td></tr>)}
        <tr className="hr-forecast-total-row"><th scope="row">{ko ? '합계' : '合计'}</th>
          <td className="hr-number"><Amount metric={forecast.total} ko={ko} /></td>
          <td className="hr-number"><Amount metric={comparison.actual.total} ko={ko} /></td>
          <td className="hr-number">{difference(comparison.total_difference, ko)}</td></tr>
      </tbody>
    </table>
  </div>;
}

function Comparison({ forecast, ko }: { forecast: LaborForecast; ko: boolean }) {
  const title = useId();
  const { comparison, previous } = forecast;
  if (!comparison && !previous) return null;
  const actualDeductions = comparison?.actual.basis.deductions as ForecastMetric | undefined;
  return <section className="hr-panel hr-forecast-comparison" aria-labelledby={title}>
    <h2 id={title}>{comparison ? (ko ? '예상 대 실제' : '预测与实际对比') : (ko ? '전월 실제 대조' : '上月实际对比')}</h2>
    {comparison && <>
      <ComparisonTable comparison={comparison} forecast={forecast} ko={ko} />
      {forecastComponents.some(key => comparisonForecastMetric(forecast.components, key, comparison) !== forecast.components[key]) &&
        <p className="hr-forecast-note">{ko ? '합계의 회사 부담금은 실제 납부액을 우선 반영합니다.' : '合计中的公司承担额优先采用实缴金额。'}</p>}
      {actualDeductions && Number(actualDeductions.known_amount) > 0 && <p className="hr-forecast-note">
        {ko ? `실제 ${laborGrossPayLabel(ko)}에 반영된 공제` : '应发工资中已扣金额'} · <Amount metric={actualDeductions} ko={ko} />
      </p>}
      {comparison.reasons.length > 0 && <ul className="hr-forecast-reasons">{comparison.reasons.map(reason => {
        const label = forecastReasonLabel(reason, ko);
        return label && <li key={reason}>{label}</li>;
      })}</ul>}
      <h3>{ko ? '직원별 급여 차이 상위' : '员工工资差额排行'}</h3>
      {comparison.employees.length ? <div className="hr-table-scroll" tabIndex={0} role="region" aria-label={ko ? '직원별 급여 차이' : '员工工资差额'}>
        <table><thead><tr><th scope="col">{ko ? '직원' : '员工'}</th><th scope="col" className="hr-number">{ko ? '예상' : '预测'}</th>
          <th scope="col" className="hr-number">{ko ? '실제' : '实际'}</th><th scope="col" className="hr-number">{ko ? '예상 − 실제' : '预测 − 实际'}</th></tr></thead>
          <tbody>{comparison.employees.map(employee => <tr key={employee.id}><th scope="row">{employee.name}<small>{employee.code}</small></th>
            <td className="hr-number">{money(employee.forecast, ko)}</td><td className="hr-number">{money(employee.actual, ko)}</td>
            <td className="hr-number">{difference(employee.difference, ko)}</td></tr>)}</tbody></table>
      </div> : <p className="hr-forecast-note">{ko ? '표시할 직원별 급여 차이가 없습니다.' : '暂无可显示的员工工资差额。'}</p>}
    </>}
    {previous && <details className="hr-forecast-previous">
      <summary>{ko ? '전월 실제와 구성별 차이' : '与上月实际的各项差额'} · {previous.month}</summary>
      <ComparisonTable comparison={previous} forecast={forecast} ko={ko} />
    </details>}
  </section>;
}

function ForecastContent({ month, allowed, ko }: { month: string; allowed: boolean; ko: boolean }) {
  const [attempt, retry] = useState(0);
  const [forecast, setForecast] = useState<LaborForecast | null>(null);
  const [failure, setFailure] = useState<'denied' | 'error' | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    getLaborForecast(month, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.month !== month) setFailure('error');
      else setForecast(data);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const status = (error as { response?: { status?: number } }).response?.status;
      setFailure(status === 401 || status === 403 ? 'denied' : 'error');
    });
    return () => controller.abort();
  }, [month, allowed, attempt]);

  if (!allowed || failure || !forecast || forecast.month !== month) return <HrLoadState
    allowed={allowed && failure !== 'denied'} loading={!failure}
    error={ko ? '인건비 예상을 불러오지 못했습니다.' : '无法加载人工成本预测。'}
    retry={() => { setFailure(null); retry(value => value + 1); }} />;
  const hasForecast = forecast.payroll.uploaded || forecast.employees.length > 0 || forecast.total.status !== 'missing';
  return <div className="hr-forecast" lang={ko ? 'ko' : 'zh-CN'}>
    <Summary forecast={forecast} ko={ko} />
    {!forecast.payroll.uploaded && <section className="hr-panel hr-forecast-empty">
      <p>{ko ? '이달 급여표가 없습니다. 급여표를 올리면 예상과 실제를 비교할 수 있습니다.' : '本月尚未上传工资表。上传后可对比预测与实际。'}</p>
      <Link className="hr-button" to={hrFlowHref('personnel', 'upload', month)}>{ko ? '급여표 올리기' : '上传工资表'}</Link>
    </section>}
    {hasForecast && <Components forecast={forecast} ko={ko} />}
    {forecast.deductions.status === 'unconfirmed' && <p className="hr-forecast-deductions">
      <strong>{forecastReasonLabel('deduction_unconfirmed', ko)}</strong>
      <span>{([['personal_leave_hours', '개인 휴가', '事假'], ['sick_leave_hours', '병가', '病假']] as const).map(([key, korean, chinese], index) => <Fragment key={key}>
        {index > 0 && ' · '}{ko ? korean : chinese} {forecast.deductions[key]} {ko ? '시간' : '小时'}
        {forecast.deductions.missing_hours?.includes(key) && (ko ? ' (일부 미입력)' : '（部分未填写）')}
      </Fragment>)}</span>
    </p>}
    {hasForecast && <><Departments forecast={forecast} ko={ko} /><ForecastChart forecast={forecast} ko={ko} /></>}
    <Comparison forecast={forecast} ko={ko} />
  </div>;
}

export default function LaborForecastPage() {
  const { lang } = useLang();
  const { user } = useAuth();
  const [month, setMonth] = useHrMonth();
  const allowed = canAccessHr(user);
  return <HrShell page="labor-forecast" month={month} onMonthChange={setMonth}>
    <ForecastContent key={`${user?.id ?? 'anonymous'}:${month}:${allowed}`} month={month} allowed={allowed} ko={lang === 'ko'} />
  </HrShell>;
}
