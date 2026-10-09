import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Check, ChevronDown, ChevronRight, Edit3, GripVertical, Plus, Save, Search, ShieldCheck, Trash2, Undo2, Users, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import { getHrAccess, updateHrAccess, updateHrWorkspace } from '../../domains/hr/api';
import { buildAssignments, getDepartmentTree, getDescendantIds, moveEmployee, validateDepartments, MAX_DEPARTMENTS } from '../../domains/hr/layout';
import type { HrAccessUser, HrDepartment, HrEmployee, HrWorkspace } from '../../domains/hr/types';
import HrImportPanel from './HrImportPanel';
import { HrLoadState, HrShell, HrSource, currentHrMonth, isHrConflict, layoutSummary, localHrError, money, safeHrError, useHrWorkspace } from './hrCommon';

type LayoutDraft = { departments: HrDepartment[]; employees: HrEmployee[] };
type DepartmentForm = { id: string; name: string; function: string; parent_id: string | null; isNew: boolean };
const DRAG_TYPE = 'application/x-wj-hr-employee';
const EMPTY_DEPARTMENTS: HrDepartment[] = [];
const EMPTY_EMPLOYEES: HrEmployee[] = [];
const layoutKey = (value: LayoutDraft) => JSON.stringify({ departments: value.departments, assignments: buildAssignments(value.employees) });

function HrAccessPanel() {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [users, setUsers] = useState<HrAccessUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    getHrAccess(controller.signal).then((result) => { if (!controller.signal.aborted) setUsers(result.users); })
      .catch(() => { if (!controller.signal.aborted) setError(ko ? '인사 담당자 권한을 불러오지 못했습니다.' : '无法加载人事负责人权限。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, ko]);
  async function toggle(user: HrAccessUser) {
    setBusyId(user.id); setError('');
    try { await updateHrAccess(user.id, !user.granted); const result = await getHrAccess(); setUsers(result.users); }
    catch (failure) { setError(safeHrError(failure, ko ? '권한을 저장하지 못했습니다. 다시 불러와 상태를 확인해 주세요.' : '权限保存失败，请重新加载以确认状态。')); }
    finally { setBusyId(null); }
  }
  const visible = users.filter((user) => `${user.name} ${user.username}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="hr-panel hr-access"><div className="hr-section-heading"><div><h2><ShieldCheck size={18} />{ko ? '인사 담당자 접근 권한' : '人事负责人访问权限'}</h2><p>{ko ? 'superuser가 인사 담당자를 지정합니다. 지정된 활성 계정은 두 페이지의 조회와 편집이 가능합니다.' : '由 superuser 指定人事负责人。已授权的有效账号可查看和编辑这两个页面。'}</p></div></div>
    {error && <div role="alert" className="hr-alert is-error">{error}<button className="hr-button" onClick={() => setReload((value) => value + 1)} disabled={busyId !== null}>{ko ? '다시 불러오기' : '重新加载'}</button></div>}
    {loading ? <p role="status">{ko ? '권한을 불러오는 중입니다.' : '正在加载权限。'}</p> : <>
      <label className="hr-search"><Search size={17} /><input aria-label={ko ? '계정 검색' : '搜索账号'} placeholder={ko ? '이름·계정 검색' : '搜索姓名或账号'} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="hr-table-scroll hr-access-table"><table><thead><tr><th>{ko ? '계정' : '账号'}</th><th>{ko ? '이름' : '姓名'}</th><th>{ko ? '상태' : '状态'}</th><th>{ko ? '인사 담당자' : '人事负责人'}</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id}><td>{user.username}</td><td>{user.name || '—'}</td><td>{user.is_superuser ? 'SUPERUSER' : !user.is_active ? (ko ? '비활성' : '已停用') : (ko ? '활성' : '有效')}</td><td>{user.is_superuser ? (ko ? '기본 접근' : '默认访问') : <label className="hr-checkbox"><input type="checkbox" checked={user.granted} disabled={busyId !== null || !user.is_active} onChange={() => void toggle(user)} aria-label={`${user.name || user.username} ${ko ? '인사 담당자 권한' : '人事负责人权限'}`} />{busyId === user.id ? (ko ? '저장 중…' : '正在保存…') : user.granted ? (ko ? '허용' : '允许') : (ko ? '미허용' : '未允许')}</label>}</td></tr>)}</tbody></table></div>
      {!visible.length && <p className="hr-muted">{ko ? '조건에 맞는 계정이 없습니다.' : '没有符合条件的账号。'}</p>}
    </>}
  </section>;
}

export default function PersonnelPage() {
  const { lang } = useLang(); const ko = lang === 'ko'; const { user } = useAuth();
  const [month, setMonth] = useState(currentHrMonth);
  const { workspace, setWorkspace, loading, error, allowed, refresh } = useHrWorkspace(month);
  const [draft, setDraft] = useState<LayoutDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const [departmentForm, setDepartmentForm] = useState<DepartmentForm | null>(null);
  const [formError, setFormError] = useState('');
  const [search, setSearch] = useState('');
  const [rosterScope, setRosterScope] = useState<'unassigned' | 'all'>('unassigned');
  const [rosterDepartment, setRosterDepartment] = useState<string | null>(null);
  const [rosterPage, setRosterPage] = useState(0);
  const [moveEditorCode, setMoveEditorCode] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const draggingCode = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dropAccepted = useRef(false);
  const dirty = Boolean(draft && layoutKey(draft) !== baseline);
  const busy = saving || importBusy;

  function receiveWorkspace(data: HrWorkspace) {
    const value = { departments: data.departments.map((item) => ({ ...item })), employees: data.employees.map((item) => ({ ...item })) };
    setDraft(value); setBaseline(layoutKey(value)); setSaveError(''); setConflict(false); setDepartmentForm(null); setDestinations({});
  }
  useEffect(() => { if (workspace) receiveWorkspace(workspace); }, [workspace]);
  useEffect(() => { setDraft(null); setBaseline(''); setDepartmentForm(null); setNotice(''); }, [user?.id]);
  useEffect(() => {
    if (!dirty && !busy && !departmentForm) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLink = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(element instanceof HTMLAnchorElement) || element.target === '_blank' || element.hasAttribute('download') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const next = new URL(element.href, window.location.href);
      if (next.pathname === window.location.pathname && next.search === window.location.search && next.origin === window.location.origin) return;
      if (busy || !window.confirm(ko ? '저장하지 않은 배치 변경을 버리고 이동할까요?' : '放弃未保存的配置更改并离开吗？')) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', onLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onLink, true); };
  }, [dirty, busy, ko, departmentForm]);

  const departments = draft?.departments ?? EMPTY_DEPARTMENTS;
  const employees = draft?.employees ?? EMPTY_EMPLOYEES;
  const summary = useMemo(() => layoutSummary(departments, employees), [departments, employees]);
  const tree = useMemo(() => getDepartmentTree(departments), [departments]);
  const forbiddenParents = useMemo(() => departmentForm && !departmentForm.isNew ? getDescendantIds(departments, departmentForm.id) : new Set<string>(), [departments, departmentForm]);
  const roster = useMemo(() => employees.filter((employee) => (rosterScope === 'all' || !employee.department_id)
    && (!rosterDepartment || employee.department_id === rosterDepartment)
    && `${employee.name} ${employee.code} ${employee.title}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [employees, rosterScope, rosterDepartment, search]);
  const pageCount = Math.max(1, Math.ceil(roster.length / 50));
  const visiblePage = Math.min(rosterPage, pageCount - 1);
  const visibleRoster = roster.slice(visiblePage * 50, (visiblePage + 1) * 50);
  useEffect(() => { setRosterPage(0); }, [search, rosterScope, rosterDepartment]);

  function changeMonth(next: string) {
    if (busy || next === month) return;
    if ((dirty || departmentForm) && !window.confirm(ko ? '저장하지 않은 변경을 버리고 대상 월을 바꿀까요?' : '放弃未保存的更改并切换月份吗？')) return;
    setNotice(''); setSaveError(''); setConflict(false); setDepartmentForm(null); setRosterDepartment(null); setMoveEditorCode(null); setMonth(next);
  }
  function discard() {
    if (!workspace || busy) return;
    if (window.confirm(ko ? '저장하지 않은 배치 변경을 버릴까요?' : '放弃未保存的配置更改吗？')) { receiveWorkspace(workspace); setNotice(ko ? '저장하지 않은 변경을 버렸습니다.' : '已放弃未保存的更改。'); }
  }
  function loadLatest() {
    if (busy || !window.confirm(ko ? '작성 중인 배치 변경과 업로드 미리보기를 버리고 서버의 최신 내용을 불러올까요?' : '放弃当前配置更改与上传预览，并加载服务器最新资料吗？')) return;
    setNotice(''); refresh();
  }
  async function save() {
    if (!draft || !workspace || !dirty || busy || conflict) return;
    setSaving(true); setSaveError(''); setNotice('');
    try {
      validateDepartments(draft.departments);
      const result = await updateHrWorkspace(month, { version: workspace.version, departments: draft.departments, assignments: buildAssignments(draft.employees) });
      setWorkspace(result); setNotice(ko ? '인원 배치와 변경 이력을 저장했습니다.' : '已保存人员配置和更改历史。');
    } catch (failure) {
      setConflict(isHrConflict(failure));
      setSaveError(isHrConflict(failure)
        ? (ko ? '다른 사용자가 먼저 변경했습니다. 작성 내용은 화면에 유지됩니다. 필요한 배치를 확인한 뒤 최신 내용을 불러와 다시 편집해 주세요.' : '其他用户已先行修改，当前配置仍保留在页面中。请确认需要保留的配置后加载最新资料并重新编辑。')
        : safeHrError(failure, ko ? '저장하지 못했습니다. 작성 내용은 유지됩니다.' : '保存失败，当前配置已保留。'));
    } finally { setSaving(false); }
  }
  function move(code: string, target: string | null) {
    if (!draft || busy) return;
    const employee = draft.employees.find((item) => item.code === code);
    if (!employee || employee.department_id === target) { setNotice(ko ? '현재 배치와 같습니다.' : '与当前配置相同。'); return; }
    try {
      const next = moveEmployee(draft.employees, code, target, draft.departments);
      setDraft({ ...draft, employees: next }); setSaveError('');
      setMoveEditorCode(null);
      const name = draft.departments.find((item) => item.id === target)?.name ?? (ko ? '미배치 명단' : '待配置名单');
      setNotice(ko ? `${employee.name}님을 ${name}(으)로 이동했습니다. 변경 저장이 필요합니다.` : `已将 ${employee.name} 移至 ${name}，请保存更改。`);
    } catch (failure) { setSaveError(safeHrError(failure, ko ? '인원을 이동하지 못했습니다.' : '无法移动人员。')); }
  }
  function dragStart(event: DragEvent, employee: HrEmployee) {
    if (busy) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DRAG_TYPE, employee.code);
    draggingCode.current = employee.code;
    setDragging(employee.code); dropAccepted.current = false; setNotice(ko ? `${employee.name}님을 놓을 부서를 선택해 주세요.` : `请将 ${employee.name} 放到目标部门。`);
  }
  function dragEnd() {
    if (!dropAccepted.current) setNotice(ko ? '이동을 취소했습니다. 기존 배치를 유지합니다.' : '已取消移动，保持原有配置。');
    draggingCode.current = null;
    setDragging(null); setDropTarget(null);
  }
  function drop(event: DragEvent, target: string | null) {
    event.preventDefault(); event.stopPropagation();
    const code = event.dataTransfer.getData(DRAG_TYPE);
    if (!draggingCode.current || code !== draggingCode.current || busy) return;
    dropAccepted.current = true; draggingCode.current = null; move(code, target); setDragging(null); setDropTarget(null);
  }
  function dropProps(target: string | null) {
    const key = target ?? '__unassigned';
    return {
      onDragOver: (event: DragEvent) => { if (draggingCode.current && !busy) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(key); } },
      onDragLeave: (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget((value) => value === key ? null : value); },
      onDrop: (event: DragEvent) => drop(event, target),
    };
  }
  function beginDepartment(department?: HrDepartment, parent?: string) {
    if (busy) return;
    setFormError(''); setDepartmentForm(department ? { ...department, isNew: false } : {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `dept-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: '', function: '', parent_id: parent ?? null, isNew: true,
    });
  }
  function applyDepartment() {
    if (!departmentForm || !draft) return;
    const { isNew, ...department } = departmentForm;
    const next = isNew ? [...draft.departments, { ...department, name: department.name.trim(), function: department.function.trim() }]
      : draft.departments.map((item) => item.id === department.id ? { ...department, name: department.name.trim(), function: department.function.trim() } : item);
    try { validateDepartments(next); setDraft({ ...draft, departments: next }); setDepartmentForm(null); setFormError(''); setNotice(ko ? '부서 정보를 반영했습니다. 변경 저장이 필요합니다.' : '已更新部门信息，请保存更改。'); }
    catch (failure) { setFormError(localHrError(failure, lang, ko ? '부서 정보를 확인해 주세요.' : '请检查部门名称、层级与职能。')); }
  }
  function removeDepartment(department: HrDepartment) {
    if (!draft || busy) return;
    if (employees.some((item) => item.department_id === department.id) || departments.some((item) => item.parent_id === department.id)) {
      setSaveError(ko ? '인원과 하위 부서를 먼저 이동한 뒤 빈 부서를 삭제할 수 있습니다.' : '请先移动人员和下级部门，再删除空部门。'); return;
    }
    if (window.confirm(ko ? `${department.name} 부서를 배치도에서 삭제할까요? 변경 저장 전에는 되돌릴 수 있습니다.` : `从配置图删除 ${department.name} 部门吗？保存之前可撤销。`)) {
      setDraft({ ...draft, departments: departments.filter((item) => item.id !== department.id) }); setNotice(ko ? '빈 부서를 삭제했습니다. 변경 저장이 필요합니다.' : '已删除空部门，请保存更改。');
    }
  }
  function employeeCard(employee: HrEmployee, compact = false) {
    const destination = destinations[employee.code] ?? employee.department_id ?? '';
    const currentName = departments.find((item) => item.id === employee.department_id)?.name;
    return <article key={employee.code} className={`hr-employee${dragging === employee.code ? ' is-dragging' : ''}${compact ? ' is-compact' : ''}`} draggable={!busy}
      onDragStart={(event) => dragStart(event, employee)} onDragEnd={dragEnd}>
      <div className="hr-employee-heading"><GripVertical size={17} className="hr-grip" aria-hidden="true" /><div><strong>{employee.name}</strong><span>{employee.code}{employee.title ? ` · ${employee.title}` : ''}</span></div><b>{money(employee.amount, workspace!.currency, lang)}</b></div>
      {!compact && <span className="hr-employee-current">{currentName ?? (ko ? '미배치' : '待配置')}</span>}
      <button className="hr-employee-edit" disabled={busy} aria-expanded={moveEditorCode === employee.code} aria-label={`${employee.name} ${ko ? '배치 변경' : '更改配置'}`} onClick={() => setMoveEditorCode((value) => value === employee.code ? null : employee.code)}><Edit3 size={14} />{ko ? '배치 변경' : '更改配置'}</button>
      {moveEditorCode === employee.code && <div className="hr-employee-move"><select aria-label={`${employee.name} ${ko ? '이동할 부서' : '目标部门'}`} value={destination} disabled={busy} onChange={(event) => setDestinations((value) => ({ ...value, [employee.code]: event.target.value }))}><option value="">{ko ? '미배치' : '待配置'}</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select>
        <button className="hr-button" disabled={busy || destination === (employee.department_id ?? '')} onClick={() => move(employee.code, destination || null)}>{ko ? '이동' : '移动'}</button></div>}
    </article>;
  }
  function renderDepartment(node: ReturnType<typeof getDepartmentTree>[number]) {
    const department = node.department;
    const members = employees.filter((employee) => employee.department_id === department.id);
    const totals = summary.totals.get(department.id);
    const isCollapsed = collapsed.has(department.id);
    return <div className="hr-department-branch" key={department.id}>
      <section className={`hr-department-box${dropTarget === department.id ? ' is-drop-target' : ''}`} {...dropProps(department.id)} aria-label={department.name}>
        <div className="hr-department-heading"><div><h3>{department.name}</h3><p>{department.function || (ko ? '기능 미등록' : '尚未填写职能')}</p></div><div className="hr-actions">
          <button className="hr-icon-button" onClick={() => beginDepartment(department)} disabled={busy} aria-label={`${department.name} ${ko ? '부서 편집' : '编辑部门'}`}><Edit3 size={17} /></button>
          <button className="hr-icon-button" onClick={() => beginDepartment(undefined, department.id)} disabled={busy || departments.length >= MAX_DEPARTMENTS} aria-label={`${department.name} ${ko ? '하위 부서 추가' : '添加下级部门'}`}><Plus size={17} /></button>
          <button className="hr-icon-button" onClick={() => removeDepartment(department)} disabled={busy} aria-label={`${department.name} ${ko ? '빈 부서 삭제' : '删除空部门'}`}><Trash2 size={16} /></button></div></div>
        <div className="hr-department-figures"><span>{ko ? '직접 배치' : '直接配置'} <strong>{members.length} {ko ? '명' : '人'}</strong></span><span>{ko ? '직접 인건비' : '直接成本'} <strong>{money(totals?.direct ?? 0, workspace!.currency, lang)}</strong></span>
          {node.children.length > 0 && <span>{ko ? '하위 포함' : '含下级'} <strong>{totals?.headcount ?? 0} {ko ? '명' : '人'} · {money(totals?.total ?? 0, workspace!.currency, lang)}</strong></span>}</div>
        <div className="hr-department-members">{members.length ? members.slice(0, 12).map((employee) => employeeCard(employee, true)) : <div className="hr-drop-empty"><Users size={20} /><p>{dragging ? (ko ? '여기에 놓아 배치하세요' : '放到此处配置') : (ko ? '인원을 여기로 끌어 놓거나, 명단에서 배치 변경을 누른 뒤 부서를 선택하고 이동하세요.' : '将人员拖至此处，或在名单中点击更改配置后选择部门并移动。')}</p></div>}</div>
        {members.length > 12 && <button className="hr-button hr-department-more" onClick={() => { setRosterScope('all'); setRosterDepartment(department.id); setSearch(''); setRosterPage(0); }}>{ko ? `이 부서 전체 ${members.length}명 명단 보기` : `查看该部门全部 ${members.length} 人名单`}</button>}
      </section>
      {node.children.length > 0 && <>
        <button className="hr-tree-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(department.id)) next.delete(department.id); else next.add(department.id); return next; })}>{isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}{ko ? '하위 부서' : '下级部门'} {node.children.length}</button>
        {!isCollapsed && <div className="hr-department-children">{node.children.map(renderDepartment)}</div>}
      </>}
    </div>;
  }

  return <HrShell page="personnel" month={month} onMonthChange={changeMonth} monthDisabled={busy}>
    {!allowed || loading || error || !workspace || !draft ? <HrLoadState allowed={allowed} loading={loading} error={error} retry={refresh} /> : <>
      <HrSource workspace={workspace} />
      <HrImportPanel workspace={workspace} disabled={dirty || Boolean(departmentForm)} onBusyChange={setImportBusy} onConflict={() => setConflict(true)} onImported={(data) => { setWorkspace(data); setNotice(ko ? '월별 인건비를 가져왔습니다. 일치하는 사번의 배치를 유지했습니다.' : '已导入月度人工成本，并保留匹配员工编号的配置。'); }} />
      <div className="hr-layout-toolbar"><div><h2>{ko ? '부서·기능별 인원 배치도' : '部门·职能人员配置图'}</h2><p>{ko ? '드래그하여 배치하거나 각 인원의 부서 선택·이동 버튼을 사용하세요. 아래 합계는 작성 중인 배치 기준입니다.' : '可拖动配置，也可使用每位员工的部门选择和移动按钮。下方合计按当前草稿配置计算。'}</p></div>
        <div className="hr-actions"><button className="hr-button" disabled={busy || departments.length >= MAX_DEPARTMENTS} onClick={() => beginDepartment()}><Plus size={17} />{ko ? '부서 추가' : '添加部门'}</button><button className="hr-button is-primary" disabled={!dirty || busy || conflict || Boolean(departmentForm)} onClick={() => void save()}><Save size={17} />{saving ? (ko ? '저장 중…' : '正在保存…') : (ko ? '변경 저장' : '保存更改')}</button></div></div>
      {dirty && <div className="hr-alert is-warning"><span>{ko ? '저장하지 않은 배치 변경이 있습니다. 집계 페이지에는 저장한 배치만 반영됩니다.' : '有尚未保存的配置更改，汇总页面仅显示已保存的配置。'}</span><button className="hr-button" disabled={busy} onClick={discard}><Undo2 size={16} />{ko ? '변경 버리기' : '放弃更改'}</button></div>}
      {saveError && <p role="alert" className="hr-alert is-error">{saveError}</p>}
      {conflict && <div role="alert" className="hr-alert is-warning"><span>{ko ? '서버 최신 버전과 충돌했습니다. 작성한 배치를 확인한 뒤 명시적으로 다시 불러와 주세요.' : '与服务器最新版本冲突，请确认当前配置后主动重新加载。'}</span><button className="hr-button" disabled={busy} onClick={loadLatest}>{ko ? '최신 내용 불러오기' : '加载最新资料'}</button></div>}
      <p className="hr-notice" role="status" aria-live="polite">{notice}</p>
      <div className="hr-kpis is-layout"><div><span>{ko ? '인건비 총계' : '人工成本总计'}</span><strong>{money(summary.total, workspace.currency, lang)}</strong></div><div><span>{ko ? '배치 인원·인건비' : '已配置人数·成本'}</span><strong>{summary.assignedCount} {ko ? '명' : '人'}</strong><small>{money(summary.assigned, workspace.currency, lang)}</small></div><div><span>{ko ? '미배치 인원·인건비' : '待配置人数·成本'}</span><strong>{summary.unassignedCount} {ko ? '명' : '人'}</strong><small>{money(summary.unassigned, workspace.currency, lang)}</small></div><div><span>{ko ? '부서' : '部门'}</span><strong>{departments.length}</strong><small>{ko ? '최대 200개 · 최대 8단계' : '最多 200 个 · 最多 8 级'}</small></div></div>
      {departmentForm && <section className="hr-panel hr-department-editor" aria-label={ko ? '부서 정보 편집' : '编辑部门信息'}><div className="hr-section-heading"><h2>{departmentForm.isNew ? (ko ? '새 부서' : '新部门') : (ko ? '부서 편집' : '编辑部门')}</h2><button className="hr-icon-button" aria-label={ko ? '편집 취소' : '取消编辑'} onClick={() => setDepartmentForm(null)}><X size={18} /></button></div>
        <form onSubmit={(event) => { event.preventDefault(); applyDepartment(); }}><div className="hr-form-grid"><label className="hr-field">{ko ? '부서명' : '部门名称'}<input autoFocus maxLength={100} required value={departmentForm.name} onChange={(event) => setDepartmentForm({ ...departmentForm, name: event.target.value })} /></label><label className="hr-field">{ko ? '상위 부서' : '上级部门'}<select value={departmentForm.parent_id ?? ''} onChange={(event) => setDepartmentForm({ ...departmentForm, parent_id: event.target.value || null })}><option value="">{ko ? '최상위 부서' : '顶级部门'}</option>{departments.filter((item) => item.id !== departmentForm.id && !forbiddenParents.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
          <label className="hr-field">{ko ? '담당 기능' : '负责职能'}<textarea rows={2} maxLength={500} value={departmentForm.function} placeholder={ko ? '예: 사출 생산, 설비 보전, 품질 검사' : '例如：注塑生产、设备维护、质量检验'} onChange={(event) => setDepartmentForm({ ...departmentForm, function: event.target.value })} /></label>
          {formError && <p role="alert" className="hr-alert is-error">{formError}</p>}
          <div className="hr-actions"><button type="submit" className="hr-button is-primary"><Check size={16} />{ko ? '배치도에 반영' : '应用到配置图'}</button><button type="button" className="hr-button" onClick={() => setDepartmentForm(null)}>{ko ? '취소' : '取消'}</button></div></form>
      </section>}
      <div className={`hr-personnel-layout${dragging ? ' is-dragging' : ''}`}>
        <aside className={`hr-roster hr-panel${dropTarget === '__unassigned' ? ' is-drop-target' : ''}`} {...dropProps(null)}><div className="hr-section-heading"><h2>{ko ? '인원 명단' : '人员名单'}</h2><span>{roster.length} {ko ? '명' : '人'}</span></div>
          <div className="hr-roster-tabs"><button aria-pressed={rosterScope === 'unassigned' && !rosterDepartment} onClick={() => { setRosterScope('unassigned'); setRosterDepartment(null); }}>{ko ? '미배치' : '待配置'} ({summary.unassignedCount})</button><button aria-pressed={rosterScope === 'all' && !rosterDepartment} onClick={() => { setRosterScope('all'); setRosterDepartment(null); }}>{ko ? '전체' : '全部'} ({employees.length})</button></div>
          {rosterDepartment && <div className="hr-roster-filter"><span>{departments.find((item) => item.id === rosterDepartment)?.name}</span><button className="hr-icon-button" aria-label={ko ? '부서 필터 해제' : '清除部门筛选'} onClick={() => setRosterDepartment(null)}><X size={16} /></button></div>}
          <label className="hr-search"><Search size={17} /><input aria-label={ko ? '인원 검색' : '搜索人员'} value={search} placeholder={ko ? '이름·사번·직책 검색' : '搜索姓名、编号或职务'} onChange={(event) => setSearch(event.target.value)} /></label>
          <p className="hr-muted">{dragging ? (ko ? '여기에 놓으면 미배치로 이동합니다.' : '放到此处移回待配置名单。') : (ko ? '터치·키보드: 배치 변경 → 부서 선택 → 이동.' : '触屏或键盘：更改配置 → 选择部门 → 移动。')}</p>
          <div className="hr-roster-list">{visibleRoster.map((employee) => employeeCard(employee))}{!roster.length && <div className="hr-drop-empty"><Users size={24} /><p>{employees.length === 0 ? (ko ? '인건비 테이블을 올리면 인원 명단이 표시됩니다.' : '上传人工成本表后显示人员名单。') : search || rosterDepartment ? (ko ? '조건에 맞는 인원이 없습니다.' : '没有符合条件的人员。') : (ko ? '모든 인원을 배치했습니다.' : '全部人员已完成配置。')}</p></div>}</div>
          {pageCount > 1 && <div className="hr-pagination"><button className="hr-button" disabled={visiblePage === 0} onClick={() => setRosterPage(visiblePage - 1)}>{ko ? '이전' : '上一页'}</button><span>{visiblePage + 1} / {pageCount}</span><button className="hr-button" disabled={visiblePage >= pageCount - 1} onClick={() => setRosterPage(visiblePage + 1)}>{ko ? '다음' : '下一页'}</button></div>}
        </aside>
        <section className="hr-org" aria-label={ko ? '조직 배치도' : '组织配置图'}>{tree.length ? tree.map(renderDepartment) : <div className="hr-panel hr-state"><Users size={30} /><h3>{ko ? '첫 부서를 만들어 주세요.' : '请创建第一个部门。'}</h3><p>{ko ? '부서와 하위 조직을 만들고 담당 기능을 기록한 뒤, 인원을 배치할 수 있습니다.' : '创建部门及下级组织，填写负责职能后即可配置人员。'}</p><button className="hr-button" onClick={() => beginDepartment()} disabled={busy}><Plus size={16} />{ko ? '부서 추가' : '添加部门'}</button></div>}</section>
      </div>
      {workspace.history.length > 0 && <details className="hr-panel hr-history"><summary>{ko ? '저장 이력' : '保存历史'} ({workspace.history.length})</summary><ol>{workspace.history.map((entry) => <li key={entry.version}><strong>v{entry.version}</strong> {entry.action} · {entry.actor} · {new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.created_at))}</li>)}</ol></details>}
      {user?.is_superuser === true && <HrAccessPanel />}
    </>}
  </HrShell>;
}
