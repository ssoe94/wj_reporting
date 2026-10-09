import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Maximize2, Minus, Plus, Search, X } from 'lucide-react';
import { useLang } from '../../i18n';
import { COMPANY_CLASSIFICATION } from '../../domains/hr/company-structure';
import { getDescendantIds } from '../../domains/hr/layout';
import type { HrCurrency, HrDepartment, HrEmployee } from '../../domains/hr/types';
import { money } from './hrCommon';
import './company-structure.css';

const DRAG_TYPE = 'application/x-wj-hr-employee';
export type CompanyChartSummary = {
  departments: readonly {
    id: string; direct_total: string | null; total: string | null; direct_count: number; headcount: number;
    known_direct_total?: string; known_total?: string; missing_cost_count?: number; direct_missing_cost_count?: number;
  }[];
};
export type CompanyClassificationChartProps = {
  departments: HrDepartment[]; employees: HrEmployee[]; summary: CompanyChartSummary; currency: HrCurrency;
  onSelect?: (id: string) => void; onMove?: (code: string, target: string | null) => void; disabled?: boolean;
  catalog?: typeof COMPANY_CLASSIFICATION;
};

/** Only the secondary reporting chart uses a scaled viewport. */
export function CompanyChartViewport({ title, description, width, height, children, canvasClass, label }: {
  title: string; description: string; width: number; height: number; children: ReactNode;
  canvasClass?: string; label: string;
}) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [zoom, setZoom] = useState(0.3);
  const [fitted, setFitted] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const fitSize = useCallback(() => viewport.current ? Math.max(0.12, Math.min(1, (viewport.current.clientWidth - 2) / width, 420 / height)) : 0.3, [width, height]);
  useLayoutEffect(() => {
    if (!fitted) return;
    const fit = () => setZoom(fitSize());
    fit();
    if (typeof ResizeObserver === 'undefined' || !viewport.current) return;
    const observer = new ResizeObserver(fit); observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [fitted, fitSize]);
  return <div className="company-chart company-chart-secondary">
    <div className="company-chart-heading"><div><h2>{title}</h2><p>{description}</p></div><div className="company-chart-controls">
      <button className="hr-icon-button" aria-label={ko ? '조직도 축소' : '缩小组织图'} disabled={zoom <= 0.12} onClick={() => { setFitted(false); setZoom((value) => Math.max(0.12, value - 0.1)); }}><Minus size={16} /></button>
      <span>{Math.round(zoom * 100)}%</span><button className="hr-icon-button" aria-label={ko ? '조직도 확대' : '放大组织图'} disabled={zoom >= 1.3} onClick={() => { setFitted(false); setZoom((value) => Math.min(1.3, value + 0.1)); }}><Plus size={16} /></button>
      <button className="hr-button" onClick={() => { setFitted(true); setZoom(fitSize()); viewport.current?.scrollTo({ left: 0, top: 0 }); }}><Maximize2 size={15} />{ko ? '맞춤' : '适应'}</button>
    </div></div>
    <div ref={viewport} className="company-chart-viewport" tabIndex={0} role="region" aria-label={label}><div className="company-chart-stage" style={{ width: width * zoom, height: height * zoom }}><div className={`company-chart-canvas ${canvasClass ?? ''}`} style={{ width, height, left: '50%', marginLeft: -(width * zoom) / 2, transform: `scale(${zoom})` }}>{children}</div></div></div>
  </div>;
}

export default function CompanyClassificationChart({ departments, employees, summary, currency, onSelect, onMove, disabled = false, catalog = COMPANY_CLASSIFICATION }: CompanyClassificationChartProps) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [selected, setSelected] = useState<string | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(20);
  const [hovered, setHovered] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const acceptedDrop = useRef(false);
  const actual = useMemo(() => new Map(departments.map((department) => [department.id, department])), [departments]);
  const totals = useMemo(() => new Map(summary.departments.map((item) => [item.id, item])), [summary]);
  const references = useMemo(() => new Map(catalog.nodes.map((node) => [node.id, node])), [catalog]);
  const extra = departments.filter((department) => !references.has(department.id));
  const leadersVisible = catalog.leaders.some((leader) => (totals.get(leader.id)?.direct_count ?? 0) > 0);
  const selectedDepartment = selected ? actual.get(selected) : null;
  const selectedPeople = useMemo(() => {
    if (!selected || !actual.has(selected)) return [];
    const ids = new Set([selected]);
    if (includeChildren) getDescendantIds(departments, selected).forEach((id) => ids.add(id));
    return employees.filter((employee) => employee.department_id && ids.has(employee.department_id)
      && `${employee.name} ${employee.code} ${employee.title}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  }, [selected, actual, includeChildren, departments, employees, search]);
  const displayMoney = (value: string) => money(value, currency, lang).replace('CN¥', '¥').replace('US$', '$');
  function path(id: string) {
    const labels: string[] = []; const visited = new Set<string>(); let node = actual.get(id);
    while (node && !visited.has(node.id)) { visited.add(node.id); labels.unshift(node.name); node = node.parent_id ? actual.get(node.parent_id) : undefined; }
    return labels.join(' / ') || references.get(id)?.name || id;
  }
  function select(id: string, children = false) {
    if (!actual.has(id)) return;
    setSelected((current) => current === id && includeChildren === children ? null : id);
    setIncludeChildren(children); setSearch(''); setLimit(20); onSelect?.(id);
  }
  function move(code: string, target: string | null) {
    if (!onMove || disabled) return;
    const employee = employees.find((item) => item.code === code);
    if (!employee || (target && !actual.has(target)) || employee.department_id === target) return;
    onMove(code, target);
    setNotice(ko ? `${employee.name} · ${target ? path(target) : '미배치'}로 이동했습니다.` : `${employee.name} 已移至 ${target ? path(target) : '待配置'}。`);
  }
  function canDrop(event: DragEvent, id: string) { return Boolean(onMove && !disabled && actual.has(id) && Array.from(event.dataTransfer.types).includes(DRAG_TYPE)); }
  function dropProps(id: string) {
    return {
      onDragOver: (event: DragEvent) => { if (canDrop(event, id)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setHovered(id); } },
      onDragLeave: (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setHovered((current) => current === id ? null : current); },
      onDrop: (event: DragEvent) => { if (!canDrop(event, id)) return; event.preventDefault(); event.stopPropagation(); const code = event.dataTransfer.getData(DRAG_TYPE); if (!employees.some((employee) => employee.code === code)) return; acceptedDrop.current = true; setHovered(null); move(code, id); },
    };
  }
  function price(id: string, group = false) {
    const value = totals.get(id);
    const amount = group ? value?.total : value?.direct_total;
    const count = group ? value?.headcount : value?.direct_count;
    const known = group ? value?.known_total : value?.known_direct_total;
    const missing = (group ? value?.missing_cost_count : value?.direct_missing_cost_count) ?? 0;
    return <span className={`company-compact-price${count === 0 ? ' is-empty' : ''}`}>
      <strong>{count === 0 || amount === undefined ? '—' : amount === null ? (ko ? '미확정' : '待确认') : displayMoney(amount)}</strong>
      {amount === null && <small>{(count ?? 0) > missing && known !== undefined ? `${ko ? '입력분' : '已录入'} ${displayMoney(known)}` : `${ko ? '미입력' : '未填写'} ${missing}${ko ? '명' : '人'}`}</small>}
    </span>;
  }
  function functionRow(id: string, management = false) {
    const value = totals.get(id); const available = actual.has(id);
    const name = management ? (ko ? '부문 관리' : '部门管理') : actual.get(id)?.name ?? references.get(id)?.name ?? id;
    return <button key={`${id}-${management ? 'direct' : 'function'}`} className={`company-function-row${hovered === id ? ' is-drop-target' : ''}${selected === id && !includeChildren ? ' is-selected' : ''}${value?.direct_count === 0 ? ' is-empty' : ''}`} disabled={!available} onClick={() => select(id)} aria-label={`${path(id)} ${ko ? '인원 보기' : '查看人员'}`} {...dropProps(id)}>
      <span className="company-function-label">{name}</span><span className="company-function-count">{value?.direct_count ?? '—'}{ko ? '명' : '人'}</span>{price(id)}
    </button>;
  }
  return <section className="company-classification-compact" aria-label={ko ? '부문·기능별 인원과 인건비' : '各部门·职能人员及人工成本'}>
    {leadersVisible && <div className="company-leaders-compact">{catalog.leaders.map((leader) => <button key={leader.id} className={`company-leader-cell${hovered === leader.id ? ' is-drop-target' : ''}`} disabled={!actual.has(leader.id)} onClick={() => select(leader.id)} {...dropProps(leader.id)}><span>{actual.get(leader.id)?.name ?? leader.label}</span><span>{totals.get(leader.id)?.direct_count ?? '—'}{ko ? '명' : '人'}</span>{price(leader.id)}</button>)}</div>}
    <div className="company-classification-grid">{catalog.groups.map((group) => {
      const total = totals.get(group.id); const available = actual.has(group.id);
      return <section key={group.id} className={`company-group-card${!available ? ' is-unavailable' : ''}`} aria-label={actual.get(group.id)?.name ?? group.label}>
        <button className={`company-group-header${hovered === group.id ? ' is-drop-target' : ''}${selected === group.id && includeChildren ? ' is-selected' : ''}`} disabled={!available} onClick={() => select(group.id, true)} {...dropProps(group.id)} aria-label={`${path(group.id)} ${ko ? '전체 인원 보기' : '查看全部人员'}`}>
          <strong>{actual.get(group.id)?.name ?? group.label}</strong><span className="company-group-stat"><span>{total?.headcount ?? '—'}{ko ? '명' : '人'}</span>{price(group.id, true)}</span>
        </button>
        <div className="company-group-functions">{(total?.direct_count ?? 0) > 0 && functionRow(group.id, true)}{group.children.map((id) => functionRow(id))}</div>
      </section>;
    })}</div>
    {extra.length > 0 && <details className="company-extra-compact"><summary>{ko ? '별도 부서·기능' : '其他部门·职能'} ({extra.length})</summary><div>{extra.map((department) => <button className="hr-button" key={department.id} onClick={() => select(department.id, true)}>{path(department.id)}</button>)}</div></details>}
    {selectedDepartment && <section className="company-people-drawer" aria-label={ko ? '선택한 분류 인원' : '所选分类人员'}>
      <div className="company-people-heading"><div><h3>{path(selectedDepartment.id)} <span>{selectedPeople.length}{ko ? '명' : '人'}</span></h3></div><button className="hr-icon-button" aria-label={ko ? '인원 목록 닫기' : '关闭人员名单'} onClick={() => setSelected(null)}><X size={18} /></button></div>
      <div className="company-people-toolbar"><label className="hr-search"><Search size={16} /><input value={search} aria-label={ko ? '인원 검색' : '搜索人员'} placeholder={ko ? '이름·사번 검색' : '搜索姓名或编号'} onChange={(event) => { setSearch(event.target.value); setLimit(20); }} /></label>{departments.some((department) => department.parent_id === selected) && <label className="hr-checkbox"><input type="checkbox" checked={includeChildren} onChange={(event) => { setIncludeChildren(event.target.checked); setLimit(20); }} />{ko ? '하위 기능 포함' : '包含下级职能'}</label>}</div>
      <div className="company-people-table-scroll"><table><thead><tr><th>{ko ? '인원' : '人员'}</th><th>{ko ? '원본 부서' : '原始部门'}</th><th className="hr-number">{ko ? '월 인건비' : '月人工成本'}</th>{onMove && <th>{ko ? '배치 변경' : '更改配置'}</th>}</tr></thead><tbody>{selectedPeople.slice(0, limit).map((employee) => {
        const destination = destinations[employee.code] ?? employee.department_id ?? '';
        return <tr key={employee.code} draggable={Boolean(onMove && !disabled)} onDragStart={(event) => { if (!onMove || disabled) { event.preventDefault(); return; } acceptedDrop.current = false; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DRAG_TYPE, employee.code); }} onDragEnd={(event) => { setHovered(null); if (!acceptedDrop.current && event.dataTransfer.dropEffect === 'none') setNotice(ko ? '이동을 취소했습니다.' : '已取消移动。'); }}><td><strong>{employee.name}</strong><small>{employee.code}{employee.title ? ` · ${employee.title}` : ''}</small></td><td>{employee.source_department || '—'}</td><td className="hr-number">{employee.amount === null ? (ko ? '미입력' : '未录入') : displayMoney(employee.amount)}</td>{onMove && <td><div className="company-people-move"><select value={destination} aria-label={`${employee.name} ${ko ? '이동할 부서' : '目标部门'}`} disabled={disabled} onChange={(event) => setDestinations((values) => ({ ...values, [employee.code]: event.target.value }))}><option value="">{ko ? '미배치' : '待配置'}</option>{departments.map((department) => <option key={department.id} value={department.id}>{path(department.id)}</option>)}</select><button className="hr-button" disabled={disabled || destination === (employee.department_id ?? '')} onClick={() => move(employee.code, destination || null)}>{ko ? '이동' : '移动'}</button></div></td>}</tr>;
      })}</tbody></table></div>
      {!selectedPeople.length && <p className="hr-muted">{ko ? '표시할 인원이 없습니다.' : '没有可显示的人员。'}</p>}
      {selectedPeople.length > limit && <button className="hr-button" onClick={() => setLimit((value) => value + 20)}>{ko ? '더 보기' : '查看更多'} ({Math.min(limit, selectedPeople.length)} / {selectedPeople.length})</button>}
    </section>}
    {onMove && notice && <p className="company-chart-notice" role="status" aria-live="polite">{notice}</p>}
  </section>;
}
