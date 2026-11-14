import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Eye, EyeOff, Search } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessHr } from '../../domains/auth/hr-access';
import { getHrDashboard } from '../../domains/hr/dashboard-api';
import { hrFlowHref } from '../../domains/hr/flow';
import { dashboardAncestorIds, dashboardEmployment, dashboardMoney, dashboardNumber, dashboardSearch, dashboardStatus } from '../../domains/hr/dashboard';
import type { DashboardCounts, DashboardMetric, DashboardNode, DashboardPerson, HrDashboard } from '../../domains/hr/dashboard';
import { useLang } from '../../i18n';
import { HrLoadState, HrShell, useHrMonth } from './hrCommon';
import DashboardDetails from './DashboardDetails';
import './hr-dashboard.css';

const EMPLOYMENT = ['contract', 'hourly'] as const;
const PAGE_SIZE = 25;
const nodeName = (node: DashboardNode, ko: boolean) => node.unassigned ? (ko ? '미배정' : '未分配') : node.name;
const showCount = (metric: DashboardMetric, ko: boolean) => dashboardNumber(metric.value, ko, ko ? '명' : ' 人');
const showHours = (metric: DashboardMetric, ko: boolean) => dashboardNumber(metric.value, ko, ko ? '시간' : ' 小时');
const showPercent = (metric: DashboardMetric, ko: boolean) => dashboardNumber(metric.value, ko, '%');
const showMoney = (metric: DashboardMetric, ko: boolean) => dashboardMoney(metric.value, ko);

function MetricText({ metric, ko, format = showCount, status = true }: {
  metric: DashboardMetric; ko: boolean; format?: (metric: DashboardMetric, ko: boolean) => string; status?: boolean;
}) {
  return <><span className="hr-dashboard-figure">{format(metric, ko)}</span>
    {status && metric.status === 'partial' && <small className="hr-dashboard-warning">{dashboardStatus(metric.status, ko)}</small>}</>;
}

function CountBreakdown({ counts, ko }: { counts: DashboardCounts; ko: boolean }) {
  const kinds = Number(counts.unknown.value ?? 0) > 0 ? [...EMPLOYMENT, 'unknown' as const] : EMPLOYMENT;
  return <span className="hr-dashboard-counts">{kinds.map(kind => <span key={kind}>{dashboardEmployment(kind, ko)} <MetricText metric={counts[kind]} ko={ko} status={false} /></span>)}</span>;
}

function DashboardKpis({ data, ko }: { data: HrDashboard; ko: boolean }) {
  const { headcount, movements, turnover, cost, load } = data;
  const forecast = cost.forecast;
  const labels = [ko ? '입사' : '入职', ko ? '퇴사' : '离职', ko ? '전환' : '转用工类型'];
  return <section className="hr-dashboard-kpis" aria-label={ko ? '인사 주요 지표' : '人事关键指标'}>
    <article className="hr-panel">
      <h3>{ko ? '재직 인원' : '在职人数'}</h3>
      <strong><MetricText metric={headcount.total} ko={ko} /></strong>
      <CountBreakdown counts={headcount} ko={ko} />
    </article>
    <article className="hr-panel">
      <h3>{ko ? '전월 대비 인원 변동' : '较上月人员变动'}</h3>
      <dl>{([movements.hires, movements.exits, movements.transfers]).map((move, i) => <div key={labels[i]}><dt>{labels[i]}</dt><dd><MetricText metric={move.total} ko={ko} /></dd></div>)}</dl>
    </article>
    <article className="hr-panel">
      <h3>{ko ? '3개월 이직률' : '三个月离职率'}</h3>
      <dl>{EMPLOYMENT.map(kind => <div key={kind}><dt>{dashboardEmployment(kind, ko)}</dt><dd><MetricText metric={turnover[kind]} ko={ko} format={showPercent} /></dd></div>)}</dl>
    </article>
    <article className="hr-panel">
      <h3>{ko ? '기준 월 인건비 (실제)' : '基准月人工成本（实际）'}</h3>
      <strong><MetricText metric={cost.actual.total} ko={ko} format={showMoney} /></strong>
      <small>{ko ? '지급 총액' : '应发工资'} <MetricText metric={cost.actual.gross} ko={ko} format={showMoney} /></small>
    </article>
    <article className="hr-panel">
      <h3>{ko ? '이달 예상 인건비' : '本月预计人工成本'}</h3>
      <strong><MetricText metric={forecast.total.value == null && forecast.status !== 'missing' ? forecast.known_amount : forecast.total} ko={ko} format={showMoney} status={false} /></strong>
      <small className={forecast.status === 'ready' ? '' : 'hr-dashboard-warning'}>{forecast.month} · {dashboardStatus(forecast.status, ko)}{forecast.total.value == null && forecast.known_amount.value != null && forecast.status !== 'missing' ? (ko ? ' · 확인 금액' : ' · 已知金额') : ''}</small>
      <Link className="hr-dashboard-text-link" to={hrFlowHref('work', 'forecast', forecast.month)}>{ko ? '예상 상세' : '预测详情'} <ChevronRight size={14} /></Link>
    </article>
    <article className="hr-panel">
      <h3>{ko ? '1인당 야근 시간 (추정)' : '人均加班时数（估算）'}</h3>
      <strong><MetricText metric={load.contract_average} ko={ko} format={showHours} /></strong>
      <small>{ko ? '계약직 기준' : '合同工口径'}</small>
      <small>{ko ? '시급직 표준 초과' : '小时工超标准'} <MetricText metric={load.hourly_average} ko={ko} format={showHours} /></small>
    </article>
  </section>;
}

function PathText({ path, unassigned, ko }: { path: string[]; unassigned: boolean; ko: boolean }) {
  return <>{[ko ? '회사' : '公司', ...(unassigned ? [ko ? '미배정' : '未分配'] : path)].join(' › ')}</>;
}

function PersonTrend({ person, ko, field }: { person: DashboardPerson; ko: boolean; field: 'load' | 'payroll' }) {
  const title = useId();
  const format = field === 'payroll' ? showMoney : showHours;
  const label = field === 'payroll' ? (ko ? '지급 총액 (CNY)' : '应发工资（CNY）') : person.employment === 'hourly'
    ? (ko ? '표준 초과 시간 (추정)' : '超标准工时（估算）') : (ko ? '야근·휴일 시간 (추정)' : '加班及节假日工时（估算）');
  const points = person.trend.map(row => ({ month: row.month.slice(5), value: row[field].value == null ? null : Number(row[field].value) }));
  return <section className="hr-dashboard-mini" aria-labelledby={title} data-private-money={field === 'payroll' ? '' : undefined}>
    <h4 id={title}>{label}</h4>
    {points.some(point => point.value != null) ? <>
      <div className="hr-dashboard-mini-plot"><ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 7, right: 10, bottom: 0, left: 0 }}>
          <XAxis dataKey="month" tick={{ fill: 'var(--hr-muted)', fontSize: 12 }} tickLine={false} />
          <YAxis hide domain={[0, 'auto']} />
          <Tooltip formatter={value => field === 'payroll' ? dashboardMoney(value as number, ko) : dashboardNumber(value as number, ko)}
            contentStyle={{ backgroundColor: 'var(--hr-surface)', borderColor: 'var(--hr-border)' }} />
          <Line dataKey="value" name={label} type="linear" stroke="var(--hr-accent)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer></div>
      <details><summary>{ko ? '월별 값 보기' : '查看月度数据'}</summary>
        <dl className="hr-dashboard-mini-values">{person.trend.map(row => <div key={row.month}><dt>{row.month}</dt><dd><MetricText metric={row[field]} ko={ko} format={format} /></dd></div>)}</dl>
      </details>
    </> : <p className="hr-muted">{ko ? '표시할 월별 자료가 없습니다.' : '暂无可显示的月度数据。'}</p>}
  </section>;
}

function tenureText(person: DashboardPerson, ko: boolean) {
  return dashboardNumber(person.tenure.value, ko, ko ? '개월 이상' : ' 个月以上');
}

function PersonCard({ person, node, ko, reveal, back }: { person: DashboardPerson; node?: DashboardNode; ko: boolean; reveal: boolean; back: () => void }) {
  const total = person.employment === 'hourly' ? person.load.excess : person.load.total;
  const average = person.employment === 'hourly' ? node?.load.hourly_average : node?.load.contract_average;
  return <article className="hr-dashboard-person-card">
    <div className="hr-dashboard-person-heading">
      <div><h3>{person.name}</h3><span className="hr-muted">{person.code}</span></div>
      <button type="button" className="hr-button" onClick={back}>{ko ? '사람 목록' : '人员列表'}</button>
    </div>
    <p className="hr-dashboard-path"><PathText path={person.path} unassigned={Boolean(node?.unassigned)} ko={ko} /></p>
    <dl className="hr-dashboard-person-facts">
      <div><dt>{ko ? '직무' : '职务'}</dt><dd>{person.title || '—'}</dd></div>
      <div><dt>{ko ? '고용형태' : '用工类型'}</dt><dd>{dashboardEmployment(person.employment, ko)}</dd></div>
      <div><dt>{ko ? '근속 (급여 기록 기준)' : '工龄（工资记录口径）'}</dt><dd>{tenureText(person, ko)}</dd></div>
      {reveal && <div data-private-money><dt>{ko ? '지급 총액' : '应发工资'}</dt><dd>{showMoney(person.payroll, ko)}</dd></div>}
      {reveal && person.employment === 'hourly' && <div data-private-money><dt>{ko ? '적용 시급' : '适用时薪'}</dt><dd><MetricText metric={person.load.rate} ko={ko} format={showMoney} /></dd></div>}
    </dl>
    <div className="hr-dashboard-person-load">
      <h4>{ko ? '파트 평균과 비교 (추정)' : '与小组平均比较（估算）'}</h4>
      <dl>
        <div><dt>{person.employment === 'hourly' ? (ko ? '본인 표준 초과' : '本人超标准') : (ko ? '본인 야근·휴일' : '本人加班及节假日')}</dt><dd><MetricText metric={total} ko={ko} format={showHours} /></dd></div>
        <div><dt>{ko ? '소속 평균' : '所属小组平均'}</dt><dd>{average && person.employment !== 'unknown' ? <MetricText metric={average} ko={ko} format={showHours} /> : '—'}</dd></div>
      </dl>
      {person.employment === 'contract' && <dl>{(['weekday', 'rest', 'holiday'] as const).map((kind, i) => <div key={kind}>
        <dt>{(ko ? ['평일', '휴일', '공휴일'] : ['平日', '休息日', '法定节假日'])[i]}</dt><dd><MetricText metric={person.load[kind]} ko={ko} format={showHours} /></dd>
      </div>)}</dl>}
      {person.employment === 'hourly' && <dl><div><dt>{ko ? '총 근무시간 (추정)' : '总工作时数（估算）'}</dt><dd><MetricText metric={person.load.worked} ko={ko} format={showHours} /></dd></div></dl>}
    </div>
    <h4>{ko ? '최근 6개월' : '近六个月'}</h4>
    <div className="hr-dashboard-mini-grid">
      <PersonTrend person={person} ko={ko} field="load" />
      {reveal && <PersonTrend person={person} ko={ko} field="payroll" />}
    </div>
  </article>;
}

function PeopleList({ people, ko, reveal, onPerson, page, setPage }: {
  people: DashboardPerson[]; ko: boolean; reveal: boolean; onPerson: (person: DashboardPerson) => void;
  page: number; setPage: (page: number) => void;
}) {
  if (!people.length) return <p className="hr-muted" role="status">{ko ? '표시할 직원이 없습니다.' : '没有可显示的人员。'}</p>;
  const pages = Math.ceil(people.length / PAGE_SIZE);
  const visible = people.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return <>
    <table className="hr-dashboard-people-table">
      <thead><tr><th scope="col">{ko ? '직원' : '员工'}</th><th scope="col">{ko ? '직무 · 고용형태' : '职务 · 用工类型'}</th>
        <th scope="col" className="is-number">{ko ? '근속' : '工龄'}</th><th scope="col" className="is-number">{ko ? '부담 (추정)' : '工作负荷（估算）'}</th>
        {reveal && <th scope="col" className="is-number">{ko ? '지급 총액' : '应发工资'}</th>}</tr></thead>
      <tbody>{visible.map(person => <tr key={person.key}>
        <td><button type="button" className="hr-dashboard-person-select" data-dashboard-person={person.key} onClick={() => onPerson(person)}><strong>{person.name}</strong><span>{person.code}</span><span className="hr-dashboard-person-origin"><PathText path={person.path} unassigned={person.path.includes('')} ko={ko} /></span></button></td>
        <td data-label={ko ? '직무 · 고용형태' : '职务 · 用工类型'}>{person.title || '—'}<small>{dashboardEmployment(person.employment, ko)}</small></td>
        <td className="is-number" data-label={ko ? '근속' : '工龄'}>{tenureText(person, ko)}</td>
        <td className="is-number" data-label={ko ? '부담 (추정)' : '工作负荷（估算）'}><MetricText metric={person.employment === 'hourly' ? person.load.excess : person.load.total} ko={ko} format={showHours} />{person.employment === 'hourly' && <small>{ko ? '표준 초과' : '超标准'}</small>}</td>
        {reveal && <td className="is-number" data-private-money data-label={ko ? '지급 총액' : '应发工资'}><MetricText metric={person.payroll} ko={ko} format={showMoney} /></td>}
      </tr>)}</tbody>
    </table>
    {pages > 1 && <div className="hr-pagination"><button className="hr-button" type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>{ko ? '이전' : '上一页'}</button>
      <span>{page + 1} / {pages}</span><button className="hr-button" type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{ko ? '다음' : '下一页'}</button></div>}
  </>;
}

function Organization({ data, ko, reveal }: { data: HrDashboard; ko: boolean; reveal: boolean }) {
  const { nodes, people } = data.organization;
  const { roots, byId, byParent, paths, maxLoad, personById } = useMemo(() => {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const byParent = new Map<string, DashboardNode[]>();
    const roots: DashboardNode[] = [];
    for (const node of nodes) {
      if (node.parent_id == null || !byId.has(node.parent_id)) roots.push(node);
      else byParent.set(node.parent_id, [...(byParent.get(node.parent_id) ?? []), node]);
    }
    const paths = new Map(nodes.map(node => [node.id, dashboardAncestorIds(node.id, byId)]));
    const maxLoad = {
      contract: Math.max(1, ...nodes.map(node => Number(node.load.contract_average.value ?? 0))),
      hourly: Math.max(1, ...nodes.map(node => Number(node.load.hourly_average.value ?? 0))),
    };
    return { roots, byId, byParent, paths, maxLoad, personById: new Map(people.map(person => [person.key, person])) };
  }, [nodes, people]);
  const [selectedId, setSelectedId] = useState<string | null>(() => (roots.find(node => Number(node.inclusive.total.value) > 0) ?? roots[0])?.id ?? null);
  const [open, setOpen] = useState(() => new Set<string>());
  const [query, setQuery] = useState('');
  const [personKey, setPersonKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const searching = query.trim().length > 0;
  const matches = useMemo(() => dashboardSearch(people, query), [people, query]);
  const highlighted = useMemo(() => new Set(matches.flatMap(person => [...(paths.get(person.node_id) ?? [])])), [matches, paths]);
  const selected = selectedId == null ? undefined : byId.get(selectedId);
  const person = personKey == null ? undefined : personById.get(personKey);
  const visible = searching ? matches : selected ? people.filter(person => paths.get(person.node_id)?.has(selected.id)) : people;
  const leaders = selected?.leaders.map(key => personById.get(key)).filter((value): value is DashboardPerson => Boolean(value)) ?? [];
  const sourceMonth = data.source?.month ?? data.month;
  const heading = useId();

  function selectPerson(value: DashboardPerson) {
    if (searching) {
      setSelectedId(value.node_id);
      setOpen(previous => new Set([...previous, ...(paths.get(value.node_id) ?? [])]));
    }
    setPersonKey(value.key);
  }

  function renderTree(nodes: DashboardNode[], ancestors = new Set<string>()) {
    return <ul className="hr-dashboard-tree">{nodes.filter(node => !ancestors.has(node.id)).map(node => {
      const children = byParent.get(node.id) ?? [];
      const expanded = open.has(node.id) || children.some(child => highlighted.has(child.id));
      const title = nodeName(node, ko);
      const hourlyOnly = node.load.contract_average.value == null && node.load.hourly_average.value != null;
      const average = hourlyOnly ? node.load.hourly_average : node.load.contract_average;
      const focus = highlighted.has(node.id);
      return <li key={node.id}>
        <div className="hr-dashboard-tree-row" data-dashboard-path-match={focus}>
          {children.length > 0 ? <button type="button" className="hr-icon-button" data-dashboard-expand={node.id} aria-expanded={expanded}
            aria-label={expanded ? (ko ? `${title} 접기` : `折叠${title}`) : (ko ? `${title} 펼치기` : `展开${title}`)}
            onClick={() => setOpen(previous => { const next = new Set(previous); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>
            {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button> : <span className="hr-dashboard-tree-spacer" />}
          <button type="button" className="hr-dashboard-node" data-dashboard-node={node.id} aria-pressed={node.id === selectedId}
            onClick={() => { setSelectedId(node.id); setPersonKey(null); setQuery(''); setPage(0); }}>
            <span className="hr-dashboard-node-text"><strong>{title}</strong><span>{showCount(node.inclusive.total, ko)}</span></span>
            <span className="hr-dashboard-node-data"><span>{showMoney(node.payroll, ko)}</span>
              <span>{hourlyOnly ? (ko ? '표준 초과 ' : '超标准 ') : ''}{showHours(average, ko)}</span></span>
            {average.value != null && <span className="hr-dashboard-load-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Number(average.value) / maxLoad[hourlyOnly ? 'hourly' : 'contract'] * 100)}%` }} /></span>}
          </button>
        </div>
        {expanded && children.length > 0 && renderTree(children, new Set([...ancestors, node.id]))}
      </li>;
    })}</ul>;
  }

  return <section className="hr-panel hr-dashboard-organization" aria-labelledby={heading}>
    <div className="hr-dashboard-org-heading"><div><h2 id={heading}>{ko ? '조직 지도' : '组织地图'}</h2>
      <p className="hr-muted">{ko ? '막대는 계약직 평균 야근 시간 추정입니다. 시급직만 계산되는 곳은 평균 표준 초과 시간을 표시합니다.' : '横条为合同工平均加班时数估算。仅能估算小时工时，显示平均超标准时数。'}</p></div>
      <label className="hr-search"><Search size={17} aria-hidden="true" /><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPersonKey(null); setPage(0); }}
        aria-label={ko ? '사번·이름 검색' : '搜索工号或姓名'} placeholder={ko ? '사번·이름 검색' : '搜索工号或姓名'} /></label>
    </div>
    <div className="hr-dashboard-map">
      <div className="hr-dashboard-map-tree" aria-label={ko ? '부서·파트 계층' : '部门与小组层级'}>{renderTree(roots)}</div>
      <div className="hr-dashboard-map-content">
        {person ? <PersonCard person={person} node={byId.get(person.node_id)} ko={ko} reveal={reveal} back={() => setPersonKey(null)} /> : <>
          <div className="hr-dashboard-selection">
            <div><h3>{searching ? (ko ? '검색 결과' : '搜索结果') : selected ? nodeName(selected, ko) : (ko ? '사람 목록' : '人员列表')}</h3>
              {searching ? <p className="hr-muted" role="status">{dashboardNumber(matches.length, ko, ko ? '명' : ' 人')}</p>
                : selected && <p className="hr-dashboard-path"><PathText path={selected.path} unassigned={selected.unassigned} ko={ko} /></p>}</div>
            <Link className="hr-button" to={hrFlowHref('personnel', 'assign', sourceMonth)}>{ko ? '인원 배치에서 편집' : '在人员配置中编辑'}</Link>
          </div>
          {!searching && selected && <div className="hr-dashboard-node-facts">
            <div><strong>{ko ? '직속' : '直属'} {showCount(selected.direct.total, ko)}</strong><CountBreakdown counts={selected.direct} ko={ko} /></div>
            <div><strong>{ko ? '하위 포함' : '含下属'} {showCount(selected.inclusive.total, ko)}</strong><CountBreakdown counts={selected.inclusive} ko={ko} /></div>
            <div><strong>{ko ? '1인당 급여' : '人均工资'}</strong><MetricText metric={selected.per_person} ko={ko} format={showMoney} /></div>
            <div><strong>{ko ? '야근·휴일 수당' : '加班及节假日津贴'}</strong><MetricText metric={selected.overtime_pay} ko={ko} format={showMoney} /></div>
            {leaders.length > 0 && <div className="hr-dashboard-leaders"><strong>{ko ? '리더 후보 (직무 기준 추정)' : '负责人候选（按职务推测）'}</strong><span>{leaders.map(leader => leader.name).join(' · ')}</span></div>}
          </div>}
          <PeopleList people={visible} ko={ko} reveal={reveal} onPerson={selectPerson} page={page} setPage={setPage} />
        </>}
      </div>
    </div>
  </section>;
}

function DashboardRequest({ month, ko, allowed, reveal, toggleReveal }: {
  month: string; ko: boolean; allowed: boolean; reveal: boolean; toggleReveal: () => void;
}) {
  const [data, setData] = useState<HrDashboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    getHrDashboard(month, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [month, allowed, attempt]);
  if (!data) return <HrLoadState allowed={allowed} loading={!failed} error={failed ? (ko ? '인사 대시보드를 불러오지 못했습니다.' : '无法加载人事总览。') : ''}
    retry={() => { setFailed(false); setAttempt(value => value + 1); }} />;
  const reupload = Boolean(data.source && data.needs.some(need => need.code === 'reupload_components' && need.month === data.source?.month));
  const rosterEmpty = data.needs.some(need => need.code === 'roster_empty');
  return <div className="hr-dashboard" lang={ko ? 'ko' : 'zh-CN'}>
    <div className="hr-dashboard-top">
      <div><h2>{ko ? '인사 대시보드' : '人事总览'}</h2><p className="hr-dashboard-source" data-dashboard-source>
        {data.source ? <><span>{ko ? '기준 급여 월' : '工资基准月'} <strong>{data.source.month}</strong></span>
          <span>{ko ? '업로드 버전' : '上传版本'} v{data.source.version}</span>
          <span>{dashboardNumber(data.source.row_count, ko, ko ? '행' : ' 行')}</span>
          {data.source.filename && <span>{data.source.filename}</span>}</> : <span>{ko ? '기준 급여 자료 없음' : '暂无工资基准资料'}</span>}
        <span>{ko ? '오늘' : '今天'} {data.today} (Asia/Shanghai)</span></p></div>
      {data.source && <button type="button" className="hr-button hr-dashboard-privacy" aria-pressed={reveal} onClick={toggleReveal}>
        {reveal ? <EyeOff size={17} /> : <Eye size={17} />}{reveal ? (ko ? '개인 금액 가리기' : '隐藏个人金额') : (ko ? '개인 금액 보기' : '显示个人金额')}
      </button>}
    </div>
    {data.source && (reupload || rosterEmpty) && <aside className="hr-alert is-warning hr-dashboard-source-notice" aria-label={ko ? '기준 자료 확인' : '基准资料待核对'}>
      <div>{reupload && <p>{ko ? '급여 구성 항목이 없는 기록의 야근·휴일 수당과 시간은 확인할 수 없습니다.' : '缺少工资明细的记录无法确认加班及节假日津贴和工时。'}</p>}
        {rosterEmpty && <p>{ko ? '인원 명부가 비어 있습니다. 조직과 인원은 기존 급여 기록을 기준으로 표시합니다.' : '人员名册为空，组织和人数按已有工资记录显示。'}</p>}</div>
      <Link className="hr-dashboard-text-link" to={hrFlowHref('personnel', 'upload', data.source.month)}>{ko ? '급여 파일 다시 가져오기' : '重新导入工资表'} <ChevronRight size={14} /></Link>
    </aside>}
    {data.source ? <><DashboardKpis data={data} ko={ko} /><Organization key={data.source.month} data={data} ko={ko} reveal={reveal} /></>
      : <section className="hr-panel hr-dashboard-empty"><h3>{ko ? '급여가 업로드되지 않았습니다' : '尚未上传工资表'}</h3>
        <p>{ko ? '대상 월까지의 CNY 지급 총액 자료가 없습니다. 인원 배치에서 급여를 가져오면 조직과 인원 지표를 볼 수 있습니다.' : '截至所选月份暂无人民币应发工资资料。在人员配置中导入工资表后即可查看组织和人员指标。'}</p>
        <Link className="hr-button" to={hrFlowHref('personnel', 'upload', month)}>{ko ? '급여 파일 올리기' : '上传工资表'}</Link></section>}
    <DashboardDetails data={data} ko={ko} reveal={reveal} />
  </div>;
}

function DashboardSession({ ko, allowed, identity }: { ko: boolean; allowed: boolean; identity: string }) {
  const [month, setMonth] = useHrMonth();
  const storageKey = `wj:hr-dashboard:reveal:${identity}`;
  const [reveal, setReveal] = useState(() => {
    try { return sessionStorage.getItem(storageKey) === 'yes'; } catch { return false; }
  });
  function toggleReveal() {
    const next = !reveal;
    setReveal(next);
    try { if (next) sessionStorage.setItem(storageKey, 'yes'); else sessionStorage.removeItem(storageKey); } catch { /* Session storage is optional. */ }
  }
  return <HrShell page="dashboard" month={month} onMonthChange={setMonth}>
    <DashboardRequest key={`${month}:${allowed}`} month={month} ko={ko} allowed={allowed} reveal={reveal} toggleReveal={toggleReveal} />
  </HrShell>;
}

export default function HrDashboardPage() {
  const { user } = useAuth();
  const { lang } = useLang();
  const identity = String(user?.id ?? 'anonymous');
  return <DashboardSession key={identity} identity={identity} ko={lang === 'ko'} allowed={canAccessHr(user)} />;
}
