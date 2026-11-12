import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { dashboardEmployment, dashboardMoney, dashboardNumber, dashboardStatus } from '../../domains/hr/dashboard';
import type { DashboardMetric, DashboardNotice, DashboardPerson, HrDashboard } from '../../domains/hr/dashboard';
import './hr-dashboard-details.css';

type Copy = readonly [ko: string, zh: string];
type Format = 'number' | 'hours' | 'percent' | 'money';
const t = (ko: boolean, pair: Copy) => pair[ko ? 0 : 1];
const law = 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_d9aa750028b14b99a776cb93726a360d.html';
const number = (value: DashboardMetric['value'], ko: boolean, format: Format = 'number') =>
  format === 'money' ? dashboardMoney(value, ko) : dashboardNumber(value, ko, format === 'percent' ? '%' : format === 'hours' ? t(ko, ['시간', '小时']) : '');

function Value({ metric, ko, format }: { metric: DashboardMetric; ko: boolean; format?: Format }) {
  return <span className="hr-dash-value">
    <span>{number(metric.value, ko, format)}</span>
    {metric.status === 'partial' && <small>{dashboardStatus(metric.status, ko)}</small>}
  </span>;
}

function ActualCost({ data, ko }: { data: HrDashboard; ko: boolean }) {
  const id = useId();
  const labels = [
    ['fixed', ['고정 급여', '固定工资']], ['overtime', ['야근·휴일 수당', '加班及节假日津贴']],
    ['hourly', ['시급직 급여', '小时工工资']], ['deductions', ['계약직 공제', '合同工扣款']],
    ['social_insurance', ['사회보험 실제 납부', '社保实缴']], ['housing_fund', ['공적금 실제 납부', '公积金实缴']],
  ] as const;
  return <section className="hr-panel hr-dash-cost" aria-labelledby={id}>
    <header className="hr-dash-section-header"><h2 id={id}>{t(ko, ['기준 월 인건비 구성', '基准月人工成本明细'])}</h2><span>{data.source?.month} · CNY</span></header>
    <dl className="hr-dash-measures">
      {labels.map(([key, label]) => <div key={key}><dt>{t(ko, label)}</dt><dd><Value metric={data.cost.actual[key]} ko={ko} format="money" /></dd></div>)}
    </dl>
  </section>;
}

function Burden({ data, ko, reveal }: { data: HrDashboard; ko: boolean; reveal: boolean }) {
  const id = useId();
  const [rank, setRank] = useState<'contract' | 'hourly'>('contract');
  const people = new Map(data.organization.people.map(person => [person.key, person]));
  const parents = new Set(data.organization.nodes.flatMap(node => node.parent_id == null ? [] : [node.parent_id]));
  const parts = data.organization.nodes.filter(node => !node.unassigned && (node.parent_id != null || !parents.has(node.id)));
  const entered = data.load.entered;
  const enteredMonth = data.today.slice(0, 7);
  const threshold = data.load.reference_hours.value;
  const top = data.load.rankings[rank].map(key => people.get(key)).filter((person): person is DashboardPerson => !!person);
  const name = (key: string | null) => key ? people.get(key)?.name ?? '—' : '—';
  const rankHours = rank === 'contract' ? t(ko, ['야근 시간(추정)', '加班时数（估算）']) : t(ko, ['표준 초과 시간(추정)', '超出标准工时（估算）']);
  const totalHours = t(ko, ['총 근무 시간(추정)', '总工时（估算）']);
  return <section aria-labelledby={id} className="hr-panel hr-dash-burden">
    <header className="hr-dash-section-header"><h2 id={id}>{t(ko, ['근무 부담', '工作负荷'])}</h2><span>{data.source?.month} · {t(ko, ['급여 기준 추정', '按工资估算'])}</span></header>
    <div className="hr-dash-reference" data-above={Number(data.load.above_reference.value) > 0 || undefined}>
      <div>
        <strong>{t(ko, ['월 ', '每月'])}{number(threshold, ko, 'hours')} {t(ko, ['참고선', '参考线'])}</strong>
        <span> · <a href={law} target="_blank" rel="noopener noreferrer">{t(ko, ['중국 노동법 제41조', '《中华人民共和国劳动法》第四十一条'])}</a></span>
        <p>{t(ko, ['계약직의 급여에서 역산한 야근 시간만 비교합니다. 참고용 추정치입니다.', '仅对照合同工按工资反推的加班时数。估算结果仅供参考。'])}</p>
      </div>
      <strong>{t(ko, ['참고선 초과 인원', '超出参考线人数'])} <Value metric={data.load.above_reference} ko={ko} /></strong>
    </div>
    <div className="hr-dash-burden-grid">
      <section aria-label={t(ko, ['파트별 부담', '分组负荷'])}>
        <h3>{t(ko, ['파트별 부담', '分组负荷'])}</h3>
        <p className="hr-dash-note">{t(ko, ['휴일 근무 비율은 휴일 시간을 역산할 수 있는 계약직 기준입니다.', '休息日出勤率以可反推休息日工时的合同工为分母。'])}</p>
        {parts.length > 0 ? <div className="hr-table-scroll hr-dash-table-scroll" role="region" aria-label={t(ko, ['파트별 부담 표', '分组负荷表'])} tabIndex={0}>
          <table className="hr-dash-part-table">
            <thead><tr>
              <th scope="col">{t(ko, ['파트', '分组'])}</th>
              <th scope="col" className="is-number">{t(ko, ['계약직 평균 야근', '合同工人均加班'])}</th>
              <th scope="col" className="is-number">{t(ko, ['시급직 평균 표준 초과', '小时工人均超出标准'])}</th>
              <th scope="col" className="is-number">{t(ko, ['휴일 근무자 비율', '休息日出勤率'])}</th>
              <th scope="col">{t(ko, ['최대 부담자', '负荷最高人员'])}</th>
            </tr></thead>
            <tbody>{parts.map(node => <tr key={node.id}>
              <th scope="row">{node.path.length ? node.path.join(' › ') : node.name}</th>
              <td className="is-number"><Value metric={node.load.contract_average} ko={ko} format="hours" /></td>
              <td className="is-number"><Value metric={node.load.hourly_average} ko={ko} format="hours" /></td>
              <td className="is-number"><Value metric={node.load.rest_worker_ratio} ko={ko} format="percent" /></td>
              <td>
                <span className="hr-dash-maximum">{dashboardEmployment('contract', ko)} · {name(node.load.maximum.contract)}</span>
                <span className="hr-dash-maximum">{dashboardEmployment('hourly', ko)} · {name(node.load.maximum.hourly)}</span>
              </td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="hr-dash-note">{t(ko, ['등록된 파트가 없습니다.', '暂无分组。'])}</p>}
      </section>
      <section aria-label={t(ko, ['부담 상위 10명', '负荷前十名'])}>
        <div className="hr-dash-section-header">
          <h3>{t(ko, ['부담 상위 10명', '负荷前十名'])}</h3>
          <div className="hr-segmented" role="group" aria-label={t(ko, ['고용형태', '用工类型'])}>
            {(['contract', 'hourly'] as const).map(kind => <button type="button" key={kind} aria-pressed={rank === kind} onClick={() => setRank(kind)}>{dashboardEmployment(kind, ko)}</button>)}
          </div>
        </div>
        {rank === 'hourly' && <p className="hr-dash-note">{t(ko, ['월 표준 174시간을 넘는 추정 시간입니다.', '按超出月标准174小时的估算时数排序。'])}</p>}
        {top.length > 0 ? <div className="hr-table-scroll hr-dash-table-scroll" role="region" aria-label={t(ko, ['개인별 부담 순위 표', '个人负荷排名表'])} tabIndex={0}>
          <table className="hr-dash-rank-table">
            <thead><tr><th scope="col">{t(ko, ['직원', '员工'])}</th><th scope="col" className="is-number">{rankHours}</th>
              {rank === 'hourly' && <th scope="col" className="is-number">{totalHours}</th>}
              {reveal && rank === 'hourly' && <th scope="col" className="is-number">{t(ko, ['적용 시급', '适用时薪'])}</th>}
            </tr></thead>
            <tbody>{top.map(person => {
              const hours = rank === 'contract' ? person.load.total : person.load.excess;
              const above = rank === 'contract' && hours.basis.above_reference === true;
              return <tr key={person.key}>
                <th scope="row">{person.name}<small>{person.code}</small></th>
                <td className={above ? 'is-number hr-dash-over' : 'is-number'}><Value metric={hours} ko={ko} format="hours" /></td>
                {rank === 'hourly' && <td className="is-number"><Value metric={person.load.worked} ko={ko} format="hours" /></td>}
                {reveal && rank === 'hourly' && <td className="is-number" data-private-money><Value metric={person.load.rate} ko={ko} format="money" /></td>}
              </tr>;
            })}</tbody>
          </table>
        </div> : <p className="hr-dash-note">{t(ko, ['추정할 수 있는 직원 자료가 없습니다.', '暂无可估算的员工数据。'])}</p>}
      </section>
    </div>
    <section className="hr-dash-entered" aria-label={t(ko, ['이달 입력 실적', '本月录入实绩'])}>
      <header className="hr-dash-section-header"><h3>{t(ko, ['이달 입력 실적', '本月录入实绩'])}</h3><Link to={`/hr/daily-work?month=${enteredMonth}`}>{t(ko, ['일별 근무 보기', '查看每日出勤'])}</Link></header>
      <p className="hr-dash-note">{enteredMonth} · {t(ko, ['직접 입력된 시간만 합산했습니다.', '仅汇总手动录入的工时。'])}</p>
      <dl className="hr-dash-measures">
        <div><dt>{t(ko, ['입력 일수', '已录入天数'])}</dt><dd><Value metric={entered.days} ko={ko} /></dd></div>
        <div><dt>{t(ko, ['미입력 일수', '未录入天数'])}</dt><dd><Value metric={entered.missing_days} ko={ko} /></dd></div>
        {([['weekday', ['평일 야근', '平日加班']], ['rest', ['휴일 근무', '休息日出勤']], ['holiday', ['공휴일 근무', '法定节假日出勤']]] as const).map(([key, label]) => <div key={key}>
          <dt>{t(ko, label)}</dt>
          <dd><Value metric={entered[key]} ko={ko} format="hours" /></dd>
        </div>)}
      </dl>
    </section>
  </section>;
}

type ChartSeries = { key: string; label: string; color: string; kind?: 'line'; stack?: string; format?: Format; right?: boolean };
type ChartPoint = { month: string; metrics: Record<string, DashboardMetric> };
const chartColors = ['var(--wj-info)', 'var(--wj-violet)', 'var(--hr-muted)'] as const;
const xTick = (month: string) => month.slice(2).replace('-', '.');
const yTick = (value: number) => Math.abs(value) >= 1000 ? `${Number((value / 1000).toPrecision(3))}k` : String(value);

function TrendChart({ title, caption, points, series, ko }: { title: string; caption: string; points: ChartPoint[]; series: ChartSeries[]; ko: boolean }) {
  const id = useId();
  const plotted = points.map(({ month, metrics }) => ({
    month, ...Object.fromEntries(series.map(({ key }) => [key, metrics[key].value == null ? null : Number(metrics[key].value)])),
  }));
  const known = points.some(({ metrics }) => series.some(({ key }) => metrics[key].value != null));
  const right = series.some(item => item.right);
  const wholeNumbers = series.every(item => !item.format || item.format === 'number');
  return <figure className="hr-panel hr-dash-chart" aria-labelledby={id}>
    <figcaption><h3 id={id}>{title}</h3><p className="hr-dash-note">{caption}</p></figcaption>
    {known ? <>
      <div className="hr-dash-chart-plot">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={plotted} margin={{ top: 10, right: 4, left: 0, bottom: 0 }} accessibilityLayer>
            <CartesianGrid stroke="var(--hr-border)" vertical={false} />
            <XAxis dataKey="month" tickFormatter={xTick} minTickGap={4} tick={{ fill: 'var(--hr-muted)', fontSize: 12 }} tickLine={false} />
            <YAxis yAxisId="left" tickFormatter={yTick} width={40} allowDecimals={!wholeNumbers} tick={{ fill: 'var(--hr-muted)', fontSize: 12 }} tickLine={false} axisLine={false} />
            {right && <YAxis yAxisId="right" orientation="right" tickFormatter={yTick} width={39} tick={{ fill: 'var(--hr-muted)', fontSize: 12 }} tickLine={false} axisLine={false} />}
            <Tooltip formatter={(value, name, item) => [number(String(value), ko, series.find(entry => entry.key === item.dataKey)?.format), name]}
              contentStyle={{ backgroundColor: 'var(--hr-surface)', border: '1px solid var(--hr-border)', borderRadius: 6, color: 'var(--hr-text)' }}
              itemStyle={{ color: 'var(--hr-text)' }} cursor={{ fill: 'var(--wj-surface-muted)' }} />
            {series.map(entry => entry.kind === 'line' ?
              <Line key={entry.key} yAxisId={entry.right ? 'right' : 'left'} type="linear" dataKey={entry.key} name={entry.label} stroke={entry.color} strokeWidth={2}
                strokeDasharray={entry.right ? '5 3' : undefined} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} /> :
              <Bar key={entry.key} yAxisId="left" dataKey={entry.key} name={entry.label} stackId={entry.stack} fill={entry.color} maxBarSize={28} isAnimationActive={false} />)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="hr-dash-chart-legend" aria-label={t(ko, ['범례', '图例'])}>{series.map(entry => <li key={entry.key}><span aria-hidden="true" style={{ borderColor: entry.color }} className={entry.kind === 'line' ? 'is-line' : undefined} />{entry.label}</li>)}</ul>
    </> : <div className="hr-dash-chart-empty">{t(ko, ['비교할 자료가 없습니다.', '暂无可比较的数据。'])}</div>}
    <details className="hr-dash-chart-data"><summary>{t(ko, ['월별 수치', '逐月数值'])}</summary>
      <div className="hr-table-scroll hr-dash-table-scroll" role="region" aria-label={title} tabIndex={0}>
        <table>
          <thead><tr><th scope="col">{t(ko, ['월', '月份'])}</th>{series.map(entry => <th scope="col" key={entry.key} className="is-number">{entry.label}</th>)}</tr></thead>
          <tbody>{points.map(({ month, metrics }) => <tr key={month}><th scope="row">{month}</th>
            {series.map(entry => <td key={entry.key} className="is-number"><Value metric={metrics[entry.key]} ko={ko} format={entry.format} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  </figure>;
}

function Trends({ data, ko }: { data: HrDashboard; ko: boolean }) {
  const id = useId();
  const chart = (pick: (row: HrDashboard['trends'][number]) => Record<string, DashboardMetric>) => data.trends.map(row => ({ month: row.month, metrics: pick(row) }));
  const headSeries = (['contract', 'hourly', 'unknown'] as const).filter(kind => kind !== 'unknown' || data.trends.some(row => Number(row.headcount.unknown.value) > 0))
    .map((key, index) => ({ key, label: dashboardEmployment(key, ko), color: chartColors[index], stack: 'population' }));
  const moveSeries = [
    { key: 'hires', label: t(ko, ['입사', '入职']), color: chartColors[0] },
    { key: 'exits', label: t(ko, ['퇴사', '离职']), color: chartColors[1] },
    { key: 'transfers', label: t(ko, ['전환', '用工转变']), color: chartColors[2] },
  ];
  return <section aria-labelledby={id}>
    <header className="hr-dash-section-header"><h2 id={id}>{t(ko, ['최근 6개월 추이', '最近六个月趋势'])}</h2>
      <span>{t(ko, ['급여 자료가 없는 달은 비워 표시합니다.', '无工资记录的月份留空。'])}</span>
    </header>
    <div className="hr-dash-charts">
      <TrendChart ko={ko} title={t(ko, ['고용형태별 재직 인원', '按用工类型统计在职人数'])} caption={t(ko, ['월별 급여 기록 기준 · 명', '按每月工资记录 · 人'])}
        points={chart(row => row.headcount)} series={headSeries} />
      <TrendChart ko={ko} title={t(ko, ['입사·퇴사·전환', '入职、离职与用工转变'])} caption={t(ko, ['연속된 두 달의 급여 명단 비교 · 명', '相邻两个月工资名单对比 · 人'])}
        points={chart(row => ({ hires: row.movements.hires.total, exits: row.movements.exits.total, transfers: row.movements.transfers.total }))} series={moveSeries} />
      <TrendChart ko={ko} title={t(ko, ['급여 합계와 1인당 급여', '工资合计与人均工资'])} caption={t(ko, ['왼쪽 축 합계 · 오른쪽 축 1인당 (CNY)', '左轴为合计，右轴为人均（CNY）'])}
        points={chart(row => ({ gross: row.gross, per_person: row.per_person }))}
        series={[{ key: 'gross', label: t(ko, ['급여 합계', '工资合计']), color: chartColors[0], format: 'money' },
          { key: 'per_person', label: t(ko, ['1인당 급여', '人均工资']), color: chartColors[1], kind: 'line', format: 'money', right: true }]} />
      <TrendChart ko={ko} title={t(ko, ['야근 수당 비중', '加班津贴占比'])} caption={t(ko, ['급여 대비 확인된 야근·휴일 수당 · %', '已知加班及节假日津贴占工资比例 · %'])}
        points={chart(row => ({ overtime_share: row.overtime_share }))}
        series={[{ key: 'overtime_share', label: t(ko, ['야근 수당 비중', '加班津贴占比']), color: chartColors[0], kind: 'line', format: 'percent' }]} />
    </div>
  </section>;
}

const notices: Record<string, { title: Copy; reason: Copy; format?: Format }> = {
  department_change: { title: ['전월 대비 부서 인원 변동', '部门人数较上月变动'], reason: ['같은 부서의 두 달 급여 명단 비교', '同一部门相邻两个月的工资名单对比'] },
  hourly_turnover: { title: ['시급직 3개월 이직률', '小时工三个月离职率'], reason: ['3개월 퇴사 합 ÷ 월평균 인원', '三个月离职总人数 ÷ 月均人数'], format: 'percent' },
  highest_load: { title: ['야근 부담이 큰 파트', '加班负荷最高的分组'], reason: ['계약직 1인당 역산 야근 시간', '合同工人均反推加班时数'], format: 'hours' },
  high_rest_share: { title: ['휴일 근무 비율이 높은 부서', '休息日出勤率较高的部门'], reason: ['역산 가능한 계약직 중 휴일 근무자 비율', '可反推工时的合同工中休息日出勤的比例'], format: 'percent' },
  above_reference: { title: ['36시간 참고선 초과 인원', '超出36小时参考线人数'], reason: ['급여에서 역산한 계약직 야근 시간', '按工资反推的合同工加班时数'] },
  unassigned: { title: ['미배정 직원', '未分配员工'], reason: ['기준 급여 월 부서 배정 기록', '基准工资月的部门分配记录'] },
  reupload_components: { title: ['급여 재업로드 필요', '需要重新上传工资表'], reason: ['수당·공제 구성 항목이 없어 야근 시간이나 급여 구성을 모두 확인할 수 없습니다.', '缺少津贴和扣款明细，无法完整核实加班时数或工资构成。'] },
  employment_unknown: { title: ['고용형태 확인 필요', '需要确认用工类型'], reason: ['기존 급여 행에 고용형태가 없습니다.', '旧工资记录中缺少用工类型。'] },
  roster_empty: { title: ['명부가 비어 있음', '人员名册为空'], reason: ['급여 파일을 다시 가져와 명부를 채워 주세요.', '请重新导入工资文件以建立人员名册。'] },
  social_insurance_rates: { title: ['사회보험 요율 미입력', '社保费率未录入'], reason: ['이달에 적용되는 인건비 기준', '本月适用的人工成本标准'] },
  housing_fund_rates: { title: ['공적금 요율 미입력', '公积金费率未录入'], reason: ['이달에 적용되는 인건비 기준', '本月适用的人工成本标准'] },
  hourly_rate_unconfirmed: { title: ['회사 기본 시급 미확정', '公司默认时薪未确认'], reason: ['이달 기준의 회사 기본 시급', '本月标准中的公司默认时薪'], format: 'money' },
  rest_hours_unconfigured: { title: ['휴일 기본 시간 미설정', '休息日默认工时未设置'], reason: ['이달 기준의 부서별 평균 시간', '本月标准中的部门人均工时'] },
  deduction_formula: { title: ['공제 산식 미확정', '扣款公式未确认'], reason: ['일별 휴가 공제에는 확정된 계산 기준이 없습니다.', '每日请假扣款暂无已确认的计算规则。'] },
  missing_daily_sheets: { title: ['이달 근무표 미입력', '本月出勤表未录入'], reason: ['이달 지난 날짜 중 근무표가 입력되지 않은 날', '本月已经过的日期中未录入出勤表的天数'] },
};

function destination(link: string, ko: boolean) {
  const route = link.split(/[?#]/u)[0];
  const paths: Record<string, Copy> = {
    '/hr/personnel': ['인원 배치', '人员配置'], '/hr/roster': ['인원 명부', '人员名册'],
    '/hr/labor-cost': ['인건비 집계', '人工成本汇总'], '/hr/labor-standards': ['인건비 기준', '人工成本标准'],
    '/hr/labor-forecast': ['인건비 예상', '人工成本预测'], '/hr/daily-work': ['일별 근무', '每日出勤'],
    '/hr/dashboard': ['인사 대시보드', '人事总览'],
  };
  return t(ko, paths[route] ?? ['관련 탭', '相关页面']);
}

function NoticeList({ ko, items, title }: { ko: boolean; items: DashboardNotice[]; title: string }) {
  const id = useId();
  return <section className="hr-panel hr-dash-notice-list" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    {items.length ? <ul>{items.map((item, index) => {
      const text = notices[item.code];
      const month = item.month ?? item.metric.basis.month;
      return <li key={`${item.code}:${month}:${index}`} data-kind={item.kind} data-notice={item.code}>
        <div><span className="hr-dash-notice-kind">{t(ko, item.kind === 'warning' ? ['주의', '注意'] : ['정보', '信息'])}</span>
          <strong>{text ? t(ko, text.title) : item.code}</strong>
          {item.label && <span className="hr-dash-notice-target"> · {item.label}</span>}
        </div>
        <Value metric={item.metric} ko={ko} format={text?.format} />
        <small>{month ? `${month} · ` : ''}{text ? t(ko, text.reason) : item.metric.basis.formula}</small>
        <Link to={item.link}>{destination(item.link, ko)}</Link>
      </li>;
    })}</ul> : <p className="hr-dash-note">{t(ko, ['표시할 항목이 없습니다.', '暂无提示。'])}</p>}
  </section>;
}

export default function DashboardDetails({ data, ko, reveal }: { data: HrDashboard; ko: boolean; reveal: boolean }) {
  return <div className="hr-dashboard-details">
    {data.source && <><Burden data={data} ko={ko} reveal={reveal} /><ActualCost data={data} ko={ko} /><Trends data={data} ko={ko} /></>}
    <div className="hr-dash-notice-grid">
      <NoticeList ko={ko} items={data.insights} title={t(ko, ['인사이트', '重点观察'])} />
      <NoticeList ko={ko} items={data.needs} title={t(ko, ['확인 필요', '待确认事项'])} />
    </div>
  </div>;
}
