import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, ChevronDown, ChevronRight, Search, Users, X } from 'lucide-react';
import { useLang } from '../../i18n';
import { amountToCents } from '../../domains/hr/import';
import type { HrWorkspace } from '../../domains/hr/types';
import { flattenDepartments, getDepartmentTree, getDescendantIds } from '../../domains/hr/layout';
import { HrLoadState, HrShell, HrSource, currentHrMonth, money, useHrWorkspace } from './hrCommon';

const EMPTY_DEPARTMENTS: HrWorkspace['departments'] = [];
const EMPTY_EMPLOYEES: HrWorkspace['employees'] = [];

export default function LaborCostPage() {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [month, setMonth] = useState(currentHrMonth);
  const { workspace, loading, error, allowed, refresh } = useHrWorkspace(month);
  const [barScope, setBarScope] = useState<'direct' | 'roots'>('direct');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [search, setSearch] = useState('');
  const departments = workspace?.departments ?? EMPTY_DEPARTMENTS;
  const employees = workspace?.employees ?? EMPTY_EMPLOYEES;
  const summary = workspace?.summary;
  const tree = useMemo(() => getDepartmentTree(departments), [departments]);
  const flattened = useMemo(() => flattenDepartments(departments), [departments]);
  const byId = useMemo(() => new Map(summary?.departments.map((item) => [item.id, item]) ?? []), [summary]);
  const selectedDepartment = departments.find((item) => item.id === selected);
  const selectedSummary = selected ? byId.get(selected) : null;
  const selectedPeople = useMemo(() => {
    if (selected === null) return [];
    const ids = selected === '__unassigned' ? new Set<string>() : new Set([selected]);
    if (includeChildren && selected !== '__unassigned' && departments.some((item) => item.id === selected)) {
      getDescendantIds(departments, selected).forEach((id) => ids.add(id));
    }
    return employees.filter((employee) => (selected === '__unassigned' ? employee.department_id === null : employee.department_id !== null && ids.has(employee.department_id))
      && `${employee.name} ${employee.code} ${employee.title}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  }, [selected, includeChildren, departments, employees, search]);
  const bars = useMemo(() => {
    if (!summary) return [];
    const values = flattened.filter(({ department }) => barScope === 'direct' || department.parent_id === null).map(({ department, depth }) => {
      const totals = byId.get(department.id);
      return { id: department.id, name: department.name, depth: barScope === 'direct' ? depth : 0, amount: barScope === 'direct' ? totals?.direct_total ?? '0.00' : totals?.total ?? '0.00', count: barScope === 'direct' ? totals?.direct_count ?? 0 : totals?.headcount ?? 0 };
    });
    values.push({ id: '__unassigned', name: ko ? '미배치' : '待配置', depth: 0, amount: summary.unassigned_total, count: summary.unassigned_count });
    return values;
  }, [summary, flattened, barScope, byId, ko]);
  const maxCents = Math.max(1, ...bars.map((bar) => amountToCents(bar.amount)));

  function selectDepartment(id: string) { setSelected(id); setSearch(''); setIncludeChildren(false); }
  function changeMonth(next: string) { setSelected(null); setCollapsed(new Set()); setMonth(next); }
  function renderNode(node: ReturnType<typeof getDepartmentTree>[number]) {
    const department = node.department; const total = byId.get(department.id); const closed = collapsed.has(department.id);
    return <div className="hr-cost-branch" key={department.id}>
      <div className="hr-cost-node"><button className={`hr-cost-box${selected === department.id ? ' is-selected' : ''}`} onClick={() => selectDepartment(department.id)} aria-label={`${department.name} ${ko ? '인원과 인건비 보기' : '查看人员与成本'}`}>
        <h3>{department.name}</h3><p>{department.function || (ko ? '기능 미등록' : '尚未填写职能')}</p>
        <div className="hr-cost-major"><span>{ko ? '하위 포함 합계' : '含下级合计'}</span><strong>{money(total?.total ?? '0.00', workspace!.currency, lang)}</strong><small>{total?.headcount ?? 0} {ko ? '명' : '人'}</small></div>
        <div className="hr-cost-direct"><span>{ko ? '직접 인건비' : '直接成本'}</span><b>{money(total?.direct_total ?? '0.00', workspace!.currency, lang)}</b><span>{total?.direct_count ?? 0} {ko ? '명' : '人'}</span></div>
      </button>{node.children.length > 0 && <button className="hr-tree-toggle" aria-expanded={!closed} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(department.id)) next.delete(department.id); else next.add(department.id); return next; })}>{closed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}{ko ? '하위 부서' : '下级部门'} ({node.children.length})</button>}</div>
      {!closed && node.children.length > 0 && <div className="hr-cost-children">{node.children.map(renderNode)}</div>}
    </div>;
  }
  return <HrShell page="labor-cost" month={month} onMonthChange={changeMonth}>
    {!allowed || loading || error || !workspace || !summary ? <HrLoadState loading={loading} error={error} allowed={allowed} retry={refresh} /> : <>
      <HrSource workspace={workspace} />
      {!workspace.source ? <section className="hr-panel hr-state"><BarChart3 size={32} /><h2>{ko ? '이 월의 인건비 자료가 없습니다.' : '本月尚无人工成本资料。'}</h2><p>{ko ? '인원 배치 페이지에서 월별 테이블을 올리고 부서를 배치한 뒤 집계를 확인해 주세요.' : '请在人员配置页面上传月度成本表并配置部门，再查看汇总。'}</p><Link className="hr-button" to="/hr/personnel">{ko ? '인원 배치·자료 올리기' : '人员配置·上传资料'}</Link></section> : <>
        <div className="hr-kpis"><div><span>{ko ? '월 인건비 총계' : '月人工成本总计'}</span><strong>{money(summary.total, workspace.currency, lang)}</strong><small>{workspace.currency} · {workspace.cost_basis === 'custom' ? workspace.cost_basis_label : workspace.cost_basis === 'gross_salary' ? (ko ? '세전 급여' : '税前工资') : (ko ? '회사 부담 총인건비' : '公司人工总成本')}</small></div>
          <div><span>{ko ? '부서 배치 인건비' : '部门已配置成本'}</span><strong>{money(summary.assigned_total, workspace.currency, lang)}</strong><small>{summary.assigned_count.toLocaleString()} {ko ? '명' : '人'}</small></div>
          <div><span>{ko ? '미배치 인건비' : '待配置成本'}</span><strong>{money(summary.unassigned_total, workspace.currency, lang)}</strong><small>{summary.unassigned_count.toLocaleString()} {ko ? '명' : '人'}</small></div>
          <div><span>{ko ? '전체 인원' : '人员总数'}</span><strong>{summary.employee_count.toLocaleString()} {ko ? '명' : '人'}</strong><small>{departments.length.toLocaleString()} {ko ? '개 부서' : '个部门'}</small></div></div>
        <section className="hr-panel hr-cost-chart"><div className="hr-section-heading"><div><h2>{ko ? '부문별 인건비 비교' : '各部门人工成本比较'}</h2><p>{barScope === 'direct' ? (ko ? '각 부서에 직접 배치한 인건비와 미배치 금액입니다. 같은 인원을 한 번씩 집계합니다.' : '显示各部门直接配置的人工成本与待配置金额，每位员工仅计入一次。') : (ko ? '최상위 부문에 하위 조직을 포함한 합계와 미배치 금액입니다. 부문 간 인원을 중복 집계하지 않습니다.' : '显示顶级部门含下级组织的合计及待配置金额，部门之间不重复计算人员。')}</p></div>
          <div className="hr-segmented"><button aria-pressed={barScope === 'direct'} onClick={() => setBarScope('direct')}>{ko ? '부서 직접 인건비' : '部门直接成本'}</button><button aria-pressed={barScope === 'roots'} onClick={() => setBarScope('roots')}>{ko ? '최상위 부문 합계' : '顶级部门合计'}</button></div></div>
          <div className="hr-bars">{bars.map((bar) => <button className={`hr-bar-row${bar.id === '__unassigned' ? ' is-unassigned' : ''}`} key={bar.id} onClick={() => selectDepartment(bar.id)}><span className="hr-bar-label" style={{ paddingInlineStart: `${bar.depth * 12}px` }}>{bar.name}<small>{bar.count.toLocaleString()} {ko ? '명' : '人'}</small></span><span className="hr-bar-track" aria-hidden="true"><span style={{ width: `${amountToCents(bar.amount) / maxCents * 100}%` }} /></span><strong>{money(bar.amount, workspace.currency, lang)}</strong></button>)}</div>
        </section>
        <section className="hr-panel hr-cost-org"><div className="hr-section-heading"><div><h2>{ko ? '부서 계층과 기능' : '部门层级与职能'}</h2><p>{ko ? '상위 박스의 합계에는 하위 박스가 포함됩니다. 조직 박스의 합계를 서로 더하면 중복됩니다. 박스를 눌러 인원을 확인하세요.' : '上级框合计包含下级框，不可将各组织框合计再次相加。点击部门框查看人员。'}</p></div></div>
          {tree.length ? <div className="hr-cost-tree">{tree.map(renderNode)}</div> : <p className="hr-muted">{ko ? '아직 부서가 없습니다. 전체 인원이 미배치에 포함됩니다.' : '尚无部门，全部人员计入待配置。'}</p>}
          {summary.unassigned_count > 0 && <button className="hr-unassigned-summary" onClick={() => selectDepartment('__unassigned')}><Users size={20} /><span>{ko ? '미배치' : '待配置'} · {summary.unassigned_count.toLocaleString()} {ko ? '명' : '人'}</span><strong>{money(summary.unassigned_total, workspace.currency, lang)}</strong></button>}
        </section>
        <section className="hr-panel"><div className="hr-section-heading"><div><h2>{ko ? '부서별 상세 집계' : '各部门详细汇总'}</h2><p>{ko ? '직접 인건비의 합계 + 미배치 금액 = 월 인건비 총계. 하위 포함 합계와 비중은 부서별 조회용이며, 행 간 합산하지 않습니다.' : '直接成本合计 + 待配置金额 = 月人工成本总计。含下级合计与占比仅供逐部门查看，不可跨行相加。'}</p></div></div>
          <div className="hr-table-scroll"><table><thead><tr><th>{ko ? '부서·기능' : '部门·职能'}</th><th className="hr-number">{ko ? '직접 인원' : '直接人数'}</th><th className="hr-number">{ko ? '직접 인건비' : '直接成本'}</th><th className="hr-number">{ko ? '하위 포함 인원' : '含下级人数'}</th><th className="hr-number">{ko ? '하위 포함 합계' : '含下级合计'}</th><th className="hr-number">{ko ? '하위 포함 비중' : '含下级占比'}</th></tr></thead><tbody>{flattened.map(({ department, depth }) => {
            const totals = byId.get(department.id);
            return <tr key={department.id}><td style={{ paddingInlineStart: `${16 + depth * 14}px` }}><button className="hr-text-button" onClick={() => selectDepartment(department.id)}>{department.name}</button><span className="hr-table-function">{department.function || '—'}</span></td><td className="hr-number">{totals?.direct_count ?? 0}</td><td className="hr-number">{money(totals?.direct_total ?? '0.00', workspace.currency, lang)}</td><td className="hr-number">{totals?.headcount ?? 0}</td><td className="hr-number">{money(totals?.total ?? '0.00', workspace.currency, lang)}</td><td className="hr-number">{totals?.share ?? '0.00'}%</td></tr>;
          })}<tr className="hr-unassigned-table-row"><td><button className="hr-text-button" onClick={() => selectDepartment('__unassigned')}>{ko ? '미배치' : '待配置'}</button></td><td className="hr-number">{summary.unassigned_count}</td><td className="hr-number">{money(summary.unassigned_total, workspace.currency, lang)}</td><td className="hr-number">—</td><td className="hr-number">—</td><td className="hr-number">—</td></tr></tbody><tfoot><tr><th>{ko ? '월 총계' : '月总计'}</th><th className="hr-number">{summary.employee_count}</th><th className="hr-number">{money(summary.total, workspace.currency, lang)}</th><th colSpan={3} /></tr></tfoot></table></div>
        </section>
        {selected !== null && <section className="hr-panel hr-cost-detail" aria-label={ko ? '선택한 부서 인원' : '所选部门人员'}><div className="hr-section-heading"><div><h2>{selected === '__unassigned' ? (ko ? '미배치 인원' : '待配置人员') : selectedDepartment?.name}</h2><p>{selected === '__unassigned' ? money(summary.unassigned_total, workspace.currency, lang) : `${includeChildren ? (ko ? '하위 포함 합계' : '含下级合计') : (ko ? '직접 인건비' : '直接成本')} · ${money((includeChildren ? selectedSummary?.total : selectedSummary?.direct_total) ?? '0.00', workspace.currency, lang)}`}</p></div><button className="hr-icon-button" aria-label={ko ? '인원 상세 닫기' : '关闭人员详情'} onClick={() => setSelected(null)}><X size={20} /></button></div>
          <div className="hr-detail-toolbar">{selected !== '__unassigned' && <label className="hr-checkbox"><input type="checkbox" checked={includeChildren} onChange={(event) => setIncludeChildren(event.target.checked)} />{ko ? '하위 부서 인원 포함' : '包含下级部门人员'}</label>}
            <label className="hr-search"><Search size={17} /><input aria-label={ko ? '부서 인원 검색' : '搜索部门人员'} value={search} placeholder={ko ? '이름·사번·직책 검색' : '搜索姓名、编号或职务'} onChange={(event) => setSearch(event.target.value)} /></label></div>
          <div className="hr-table-scroll"><table><thead><tr><th>{ko ? '사번' : '编号'}</th><th>{ko ? '이름' : '姓名'}</th><th>{ko ? '직책' : '职务'}</th><th>{ko ? '배치 부서' : '配置部门'}</th><th className="hr-number">{ko ? '월 인건비' : '月人工成本'}</th></tr></thead><tbody>{selectedPeople.map((employee) => <tr key={employee.code}><td>{employee.code}</td><td>{employee.name}</td><td>{employee.title || '—'}</td><td>{departments.find((item) => item.id === employee.department_id)?.name ?? (ko ? '미배치' : '待配置')}</td><td className="hr-number">{money(employee.amount, workspace.currency, lang)}</td></tr>)}</tbody></table></div>
          {!selectedPeople.length && <p className="hr-muted">{ko ? '표시할 인원이 없습니다.' : '没有可显示的人员。'}</p>}
        </section>}
      </>}
    </>}
  </HrShell>;
}
