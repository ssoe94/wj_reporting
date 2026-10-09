import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Eye, EyeOff, GripVertical, Search, X } from 'lucide-react';
import { useLang } from '../../i18n';
import { COMPANY_CLASSIFICATION } from '../../domains/hr/company-structure';
import { hrDepartmentLabel } from '../../domains/hr/labels';
import { amountToCents } from '../../domains/hr/import';
import { getDescendantIds } from '../../domains/hr/layout';
import { formatEmployeeCode, getEmployeeCodeCollisions, getMovePreview } from '../../domains/hr/visualization';
import type { HrEmployee } from '../../domains/hr/types';
import type { CompanyClassificationChartProps } from './CompanyClassificationChart';
import { compactMoney } from './hrCommon';
import './hr-allocation-board.css';

const ORDER = ['injection', 'quality', 'machining', 'sales', 'materials', 'mold-maintenance', 'administration'];
const UNASSIGNED = '__unassigned';
type Selection = { type: 'person'; code: string } | { type: 'function'; id: string; children: boolean };
type Drag = { code: string; pointer: number; startX: number; startY: number; x: number; y: number; offsetX: number; offsetY: number; active: boolean; target: string | null | undefined };

export default function HrAllocationBoard({ departments, employees, summary, currency, onMove, disabled = false, catalog = COMPANY_CLASSIFICATION }: CompanyClassificationChartProps) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const capture = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [revealName, setRevealName] = useState(false);
  const [destination, setDestination] = useState('');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(20);
  const [notice, setNotice] = useState('');
  const byId = useMemo(() => new Map(departments.map((department) => [department.id, department])), [departments]);
  const totals = useMemo(() => new Map(summary.departments.map((item) => [item.id, item])), [summary]);
  const peopleByCell = useMemo(() => {
    const result = new Map<string | null, HrEmployee[]>();
    for (const person of employees) { const items = result.get(person.department_id) ?? []; items.push(person); result.set(person.department_id, items); }
    return result;
  }, [employees]);
  const collisions = useMemo(() => getEmployeeCodeCollisions(employees.map((person) => person.code)), [employees]);
  const canEdit = Boolean(onMove && !disabled);
  const fullCost = useMemo(() => employees.some((person) => person.amount === null) ? null : employees.reduce((sum, person) => sum + amountToCents(person.amount!), 0), [employees]);
  const groups = [...catalog.groups].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const canonical = new Set(catalog.nodes.map((node) => node.id));
  const extras = departments.filter((department) => !canonical.has(department.id));
  const leaders = catalog.leaders.filter((leader) => byId.has(leader.id));
  const filtered = useMemo(() => employees.filter((person) => (scope !== 'unassigned' || person.department_id === null)
    && `${formatEmployeeCode(person.code)} ${person.code}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [employees, scope, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 6)); const currentPage = Math.min(page, pageCount - 1);
  const visiblePeople = filtered.slice(currentPage * 6, currentPage * 6 + 6);
  const selectedPerson = selection?.type === 'person' ? employees.find((person) => person.code === selection.code) : undefined;
  const selectedPeople = useMemo(() => {
    if (selection?.type !== 'function') return [];
    const ids = selection.children ? getDescendantIds(departments, selection.id) : new Set<string>();
    ids.add(selection.id); return employees.filter((person) => person.department_id !== null && ids.has(person.department_id));
  }, [selection, departments, employees]);
  const dragCode = drag?.active ? drag.code : undefined;
  const dragTarget = drag?.target;
  const movePreview = useMemo(() => dragCode !== undefined && dragTarget !== undefined ? getMovePreview(departments, employees, dragCode, dragTarget) : null, [departments, employees, dragCode, dragTarget]);
  const buttonPreview = useMemo(() => selectedPerson && canEdit ? getMovePreview(departments, employees, selectedPerson.code, destination || null) : null, [departments, employees, selectedPerson, canEdit, destination]);

  function label(id: string | null) {
    if (id === null) return ko ? '미배치' : '待配置';
    return hrDepartmentLabel(id, byId.get(id)?.name ?? catalog.nodes.find((node) => node.id === id)?.name, lang);
  }
  function path(id: string | null) {
    if (id === null) return label(null);
    const labels: string[] = []; const seen = new Set<string>(); let next: string | null = id;
    while (next !== null && !seen.has(next)) { seen.add(next); labels.unshift(label(next)); next = byId.get(next)?.parent_id ?? null; }
    return labels.join(' › ');
  }
  function codeLabel(code: string) { return `${formatEmployeeCode(code)}${collisions.has(code) ? ` (${ko ? '원본' : '原编号'} ${code})` : ''}`; }
  function amount(value: string | null | undefined) { return value == null ? (ko ? '미입력' : '未填写') : compactMoney(value, currency, lang); }
  function endDrag(cancelled = false) {
    const current = dragRef.current; dragRef.current = null; setDrag(null);
    if (capture.current && current && capture.current.hasPointerCapture(current.pointer)) capture.current.releasePointerCapture(current.pointer);
    capture.current = null;
    if (cancelled && current?.active) setNotice(ko ? '이동을 취소했습니다.' : '已取消移动。');
  }
  useEffect(() => {
    // An import, saved response or month remount must never retain a revealed identity.
    setRevealName(false); setSelection(null); setDrag(null); dragRef.current = null;
  }, [employees]);
  useEffect(() => { if (disabled) { setDrag(null); dragRef.current = null; } }, [disabled]);
  useEffect(() => {
    const cancel = () => { dragRef.current = null; setDrag(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { cancel(); setSelection(null); setRevealName(false); }
      if (event.key === 'Tab' && dialog.current) {
        const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]'));
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('blur', cancel); };
  }, []);
  useEffect(() => {
    if (!dragCode || !canEdit || !root.current) return;
    const board = root.current;
    const lanes = board.querySelector<HTMLElement>('.hr-lanes-scroll');
    let vertical = board.parentElement;
    while (vertical && !(vertical.scrollHeight > vertical.clientHeight && /auto|scroll/.test(getComputedStyle(vertical).overflowY))) vertical = vertical.parentElement;
    const scroller = vertical ?? document.scrollingElement;
    let frame = 0;
    let previousTime = 0;
    const speed = (position: number, start: number, end: number) => position < start + 56 ? -Math.min(1, (start + 56 - position) / 56) : position > end - 56 ? Math.min(1, (position - end + 56) / 56) : 0;
    const tick = (time: number) => {
      const current = dragRef.current;
      if (!current?.active) return;
      const distance = Math.min(32, previousTime ? time - previousTime : 16) * .7;
      previousTime = time;
      if (lanes && lanes.scrollWidth > lanes.clientWidth) {
        const rect = lanes.getBoundingClientRect();
        if (current.y >= rect.top && current.y <= rect.bottom) lanes.scrollBy({ left: speed(current.x, Math.max(0, rect.left), Math.min(window.innerWidth, rect.right)) * distance, behavior: 'instant' });
      }
      const rect = vertical?.getBoundingClientRect();
      scroller?.scrollBy({ top: speed(current.y, Math.max(0, rect?.top ?? 0), Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight)) * distance, behavior: 'instant' });
      // The pointer can stay still while the content moves underneath it.
      const hit = document.elementFromPoint(current.x, current.y)?.closest<HTMLElement>('[data-hr-drop]');
      const value = hit && board.contains(hit) ? hit.dataset.hrDrop : undefined;
      const target = value === UNASSIGNED ? null : value && byId.has(value) ? value : undefined;
      if (target !== current.target) { const next = { ...current, target }; dragRef.current = next; setDrag(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragCode, canEdit, byId]);
  useEffect(() => {
    if (!selection) return;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { previousFocus.current?.focus(); };
  }, [selection]);
  function openPerson(person: HrEmployee) { previousFocus.current = document.activeElement as HTMLElement; setRevealName(false); setDestination(person.department_id ?? ''); setSelection({ type: 'person', code: person.code }); }
  function openFunction(id: string, children = false) { if (!byId.has(id)) return; previousFocus.current = document.activeElement as HTMLElement; setRevealName(false); setLimit(20); setSelection({ type: 'function', id, children }); }
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, person: HrEmployee) {
    if (!canEdit || event.button !== 0) return;
    const rect = event.currentTarget.closest('.hr-person-pill')!.getBoundingClientRect();
    const value: Drag = { code: person.code, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, active: false, target: undefined };
    dragRef.current = value; capture.current = event.currentTarget; event.currentTarget.setPointerCapture(event.pointerId);
  }
  function trackDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = dragRef.current; if (!current || current.pointer !== event.pointerId || !canEdit) return;
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
    event.preventDefault();
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-hr-drop]');
    const value = hit && root.current?.contains(hit) ? hit.dataset.hrDrop : undefined;
    const target = value === UNASSIGNED ? null : value && byId.has(value) ? value : undefined;
    const next = { ...current, active: true, x: event.clientX, y: event.clientY, target }; dragRef.current = next; setDrag(next);
  }
  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = dragRef.current; if (!current || current.pointer !== event.pointerId) return;
    const preview = current.active && current.target !== undefined && canEdit ? getMovePreview(departments, employees, current.code, current.target) : null;
    endDrag(!preview?.changes);
    if (preview?.changes && current.target !== undefined) onMove?.(current.code, current.target);
  }
  function staffPill(person: HrEmployee, dock = false) {
    return <div key={person.code} className={`hr-person-pill${dock ? ' is-dock' : ''}${drag?.active && drag.code === person.code ? ' is-dragging' : ''}`} data-person-code={person.code}>
      <button type="button" className="hr-person-open" onClick={() => openPerson(person)} aria-label={`${codeLabel(person.code)} ${ko ? '상세' : '详情'}`}>
        <strong>{formatEmployeeCode(person.code)}</strong>{collisions.has(person.code) && <small>{ko ? '원본' : '原编号'} {person.code}</small>}
        {dock && <><b>{amount(person.amount)}</b><small title={path(person.department_id)}>{path(person.department_id)}</small></>}
      </button>
      {onMove && <button type="button" className="hr-person-grip" disabled={disabled} aria-label={`${codeLabel(person.code)} ${ko ? '끌어서 이동' : '拖动配置'}`} title={ko ? '끌어서 이동' : '拖动配置'} onPointerDown={(event) => startDrag(event, person)} onPointerMove={trackDrag} onPointerUp={finishDrag} onPointerCancel={() => endDrag(true)} onLostPointerCapture={() => { if (dragRef.current) endDrag(true); }} onClick={(event) => { if (event.detail === 0) openPerson(person); }}><GripVertical size={16} /></button>}
    </div>;
  }
  function functionCell(id: string, management = false) {
    const stats = totals.get(id); const people = peopleByCell.get(id) ?? []; const available = byId.has(id);
    const hovered = drag?.active && drag.target === id;
    return <section key={id} className={`hr-function-cell${hovered ? ' is-drop-target' : ''}${!available ? ' is-unavailable' : ''}`} data-hr-drop={canEdit && available ? id : undefined} aria-label={path(id)}>
      <button type="button" className="hr-function-title" disabled={!available} onClick={() => openFunction(id)}><strong>{management ? (ko ? '부문 관리' : '部门管理') : label(id)}</strong><span>{stats?.direct_count ?? 0}{ko ? '명' : '人'}</span><b>{!stats?.direct_count ? '—' : stats.direct_total === null ? (ko ? '미확정' : '待确认') : compactMoney(stats.direct_total, currency, lang)}</b></button>
      <div className="hr-function-people">{people.slice(0, 3).map((person) => staffPill(person))}</div>
      {people.length > 3 && <button type="button" className="hr-function-more" onClick={() => openFunction(id)}>+{people.length - 3}{ko ? '명 더 보기' : '人 查看更多'}</button>}
      {people.length === 0 && <span className="hr-function-empty">{onMove ? (ko ? '여기에 배치' : '拖到此处') : (ko ? '배치 없음' : '暂无人员')}</span>}
      {stats?.direct_missing_cost_count ? <small className="hr-function-missing">{ko ? '금액 미입력' : '金额未填'} {stats.direct_missing_cost_count}{ko ? '명' : '人'}</small> : null}
      {hovered && <span className="hr-drop-hint">{movePreview?.changes ? (ko ? '여기로 이동' : '移到此处') : (ko ? '현재 배치' : '当前位置')}</span>}
    </section>;
  }
  function previewContent(preview: NonNullable<typeof movePreview>) {
    return <><h3>{ko ? '이동 미리보기' : '移动预览'}</h3><p className="hr-preview-path">{path(preview.fromId)} <ArrowRight size={13} /> {path(preview.toId)}</p>{preview.groups.map((group) => <div className="hr-move-comparison" key={group.id ?? UNASSIGNED}><span>{label(group.id)}</span><span>{group.beforeCount} → {group.afterCount}{ko ? '명' : '人'}</span><b>{group.beforeAmount === null ? (ko ? '미확정' : '待确认') : compactMoney(group.beforeAmount, currency, lang)} <ArrowRight size={13} /> {group.afterAmount === null ? (ko ? '미확정' : '待确认') : compactMoney(group.afterAmount, currency, lang)}</b></div>)}<small>{ko ? '전체 인원·인건비 합계 유지' : '总人数与人工成本保持不变'}</small></>;
  }

  return <div ref={root} className={`hr-allocation-board${drag?.active ? ' is-dragging' : ''}`}>
    <p className="hr-board-scroll-hint">{ko ? '좌우로 이동하여 모든 부문을 확인하세요.' : '左右滑动查看所有部门。'}</p>
    <div className="hr-lanes-scroll" tabIndex={0} role="region" aria-label={ko ? '부문별 인원 배치판' : '部门人员配置板'}><div className="hr-department-lanes">
      {groups.map((group) => {
        const stats = totals.get(group.id); const share = fullCost !== null && fullCost > 0 && stats?.total !== null && stats?.total !== undefined ? amountToCents(stats.total) / fullCost * 100 : null;
        return <section key={group.id} className="hr-department-lane" data-lane={group.id}>
          <button className="hr-lane-header" disabled={!byId.has(group.id)} onClick={() => openFunction(group.id, true)} data-hr-drop={canEdit && byId.has(group.id) ? group.id : undefined}>
            <strong>{label(group.id)}</strong><span>{stats?.headcount ?? 0}{ko ? '명' : '人'}{share !== null && <small>{share.toFixed(1)}%</small>}</span><b>{!stats?.headcount ? '—' : stats.total === null ? (ko ? '미확정' : '待确认') : compactMoney(stats.total, currency, lang)}</b>
            {share !== null && <span className="hr-lane-cost-meter" aria-hidden="true"><i style={{ width: `${share}%` }} /></span>}
          </button>
          {(stats?.direct_count ?? 0) > 0 && functionCell(group.id, true)}
          {group.children.map((id) => functionCell(id))}
        </section>;
      })}
    </div></div>
    {(extras.length > 0 || leaders.some((leader) => (peopleByCell.get(leader.id)?.length ?? 0) > 0)) && <details className="hr-board-additional"><summary>{ko ? '경영진·추가 분류' : '管理层·其他分类'} <span>{employees.filter((person) => person.department_id && (extras.some((item) => item.id === person.department_id) || leaders.some((item) => item.id === person.department_id))).length}{ko ? '명' : '人'}</span></summary><div>{leaders.map((leader) => functionCell(leader.id))}{extras.map((department) => functionCell(department.id))}</div></details>}
    <section className={`hr-people-dock${drag?.active && drag.target === null ? ' is-drop-target' : ''}`} aria-label={ko ? '인원 찾기' : '查找人员'}>
      <div className="hr-dock-toolbar"><h2>{ko ? '인원 찾기' : '查找人员'} <small>{employees.length}{ko ? '명' : '人'}</small></h2>
        <label className="hr-search"><Search size={16} /><input aria-label={ko ? '사번 검색' : '搜索工号'} placeholder={ko ? '사번 검색' : '搜索工号'} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label>
        <select aria-label={ko ? '명단 범위' : '名单范围'} value={scope} onChange={(event) => { setScope(event.target.value); setPage(0); }}><option value="all">{ko ? '전체 인원' : '全部人员'}</option><option value="unassigned">{ko ? '미배치' : '待配置'} ({peopleByCell.get(null)?.length ?? 0})</option></select>
        {onMove && <span className="hr-unassigned-target" data-hr-drop={canEdit ? UNASSIGNED : undefined}>{ko ? '여기에 놓으면 미배치' : '拖到此处取消配置'}</span>}
        <div className="hr-dock-pagination"><button className="hr-icon-button" aria-label={ko ? '이전 인원' : '上一页人员'} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><span>{currentPage + 1} / {pageCount}</span><button className="hr-icon-button" aria-label={ko ? '다음 인원' : '下一页人员'} disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div>
      </div>
      <div className="hr-dock-people">{visiblePeople.map((person) => staffPill(person, true))}</div>
      {!filtered.length && <p className="hr-dock-empty">{employees.length === 0 ? (ko ? '월별 급여표를 올려 주세요.' : '请上传月度工资表。') : (ko ? '조건에 맞는 사번이 없습니다.' : '没有符合条件的工号。')}</p>}
    </section>
    {drag?.active && <div className="hr-drag-person" style={{ left: Math.max(0, Math.min(window.innerWidth - 180, drag.x - drag.offsetX)), top: Math.max(0, Math.min(window.innerHeight - 55, drag.y - drag.offsetY)) }} aria-hidden="true"><strong>{codeLabel(drag.code)}</strong><span>{amount(employees.find((person) => person.code === drag.code)?.amount)}</span></div>}
    {movePreview?.changes && <aside className="hr-drag-preview" aria-live="polite">{previewContent(movePreview)}</aside>}
    {notice && <span className="hr-board-status" role="status">{notice}</span>}
    {selection && <div className="hr-person-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelection(null); setRevealName(false); } }}><div ref={dialog} className="hr-person-dialog" role="dialog" aria-modal="true" aria-labelledby="hr-person-detail-title">
      <header><h2 id="hr-person-detail-title">{selectedPerson ? codeLabel(selectedPerson.code) : selection.type === 'function' ? path(selection.id) : ''}</h2><button className="hr-icon-button" aria-label={ko ? '상세 닫기' : '关闭详情'} onClick={() => { setSelection(null); setRevealName(false); }}><X size={19} /></button></header>
      {selectedPerson ? <>
        <div className="hr-person-facts"><span>{ko ? '배치' : '配置'}<strong>{path(selectedPerson.department_id)}</strong></span><span>{ko ? '월 인건비' : '月人工成本'}<strong>{amount(selectedPerson.amount)}</strong></span><span>{ko ? '원본 부서' : '原始部门'}<strong>{selectedPerson.source_department || '—'}</strong></span></div>
        <div className="hr-name-reveal"><button className="hr-button" aria-pressed={revealName} onClick={() => setRevealName((value) => !value)}>{revealName ? <EyeOff size={16} /> : <Eye size={16} />}{revealName ? (ko ? '이름 숨기기' : '隐藏姓名') : (ko ? '이름 확인' : '查看姓名')}</button>{revealName && <strong>{selectedPerson.name}</strong>}</div>
        {onMove && <div className="hr-person-move-form"><label>{ko ? '이동할 분류' : '目标分类'}<select aria-label={ko ? '이동할 분류' : '目标分类'} value={destination} disabled={disabled} onChange={(event) => setDestination(event.target.value)}><option value="">{label(null)}</option>{departments.map((department) => <option key={department.id} value={department.id}>{path(department.id)}</option>)}</select></label>
          {buttonPreview?.changes && <div className="hr-person-move-preview">{previewContent(buttonPreview)}</div>}
          <button className="hr-button is-primary" disabled={!canEdit || !buttonPreview?.changes} onClick={() => { onMove?.(selectedPerson.code, destination || null); setSelection(null); setRevealName(false); }}>{ko ? '이동 적용' : '应用移动'}</button>
        </div>}
      </> : <><p className="hr-muted">{selectedPeople.length}{ko ? '명' : '人'}</p><div className="hr-function-person-list">{selectedPeople.slice(0, limit).map((person) => <button key={person.code} onClick={() => openPerson(person)}><strong>{codeLabel(person.code)}</strong><span>{amount(person.amount)}</span><ChevronRight size={15} /></button>)}</div>{selectedPeople.length > limit && <button className="hr-button" onClick={() => setLimit((value) => value + 20)}>{ko ? '더 보기' : '查看更多'} ({Math.min(limit, selectedPeople.length)} / {selectedPeople.length})</button>}{!selectedPeople.length && <p>{ko ? '배치된 인원이 없습니다.' : '暂无配置人员。'}</p>}</>}
    </div></div>}
  </div>;
}
