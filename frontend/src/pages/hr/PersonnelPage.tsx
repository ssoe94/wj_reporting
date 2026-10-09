import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Edit3, Plus, Save, Search, ShieldCheck, Trash2, Undo2, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import { getHrAccess, updateHrAccess, updateHrWorkspace } from '../../domains/hr/api';
import { buildAssignments, getDepartmentTree, getDescendantIds, moveEmployee, validateDepartments, MAX_DEPARTMENTS } from '../../domains/hr/layout';
import type { HrAccessUser, HrDepartment, HrEmployee, HrWorkspace } from '../../domains/hr/types';
import HrImportPanel from './HrImportPanel';
import HrAllocationBoard from './HrAllocationBoard';
import HrCostRibbon from './HrCostRibbon';
import { formatEmployeeCode } from '../../domains/hr/visualization';
import { centsToAmount } from '../../domains/hr/import';
import { COMPANY_CLASSIFICATION } from '../../domains/hr/company-structure';
import { hrAssignmentPath, hrDepartmentLabel } from '../../domains/hr/labels';
import { HrLoadState, HrShell, HrSource, currentHrMonth, isHrConflict, layoutSummary, localHrError, money, safeHrError, useHrWorkspace } from './hrCommon';

type LayoutDraft = { departments: HrDepartment[]; employees: HrEmployee[] };
type DepartmentForm = { id: string; name: string; function: string; parent_id: string | null; isNew: boolean };
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
  return <div className="hr-access">
    {error && <div role="alert" className="hr-alert is-error">{error}<button className="hr-button" onClick={() => setReload((value) => value + 1)} disabled={busyId !== null}>{ko ? '다시 불러오기' : '重新加载'}</button></div>}
    {loading ? <p role="status">{ko ? '권한을 불러오는 중입니다.' : '正在加载权限。'}</p> : <>
      <label className="hr-search"><Search size={17} /><input aria-label={ko ? '계정 검색' : '搜索账号'} placeholder={ko ? '이름·계정 검색' : '搜索姓名或账号'} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="hr-table-scroll hr-access-table"><table><thead><tr><th>{ko ? '계정' : '账号'}</th><th>{ko ? '이름' : '姓名'}</th><th>{ko ? '상태' : '状态'}</th><th>{ko ? '인사 담당자' : '人事负责人'}</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id}><td>{user.username}</td><td>{user.name || '—'}</td><td>{user.is_superuser ? 'SUPERUSER' : !user.is_active ? (ko ? '비활성' : '已停用') : (ko ? '활성' : '有效')}</td><td>{user.is_superuser ? (ko ? '기본 접근' : '默认访问') : <label className="hr-checkbox"><input type="checkbox" checked={user.granted} disabled={busyId !== null || !user.is_active} onChange={() => void toggle(user)} aria-label={`${user.name || user.username} ${ko ? '인사 담당자 권한' : '人事负责人权限'}`} />{busyId === user.id ? (ko ? '저장 중…' : '正在保存…') : user.granted ? (ko ? '허용' : '允许') : (ko ? '미허용' : '未允许')}</label>}</td></tr>)}</tbody></table></div>
      {!visible.length && <p className="hr-muted">{ko ? '조건에 맞는 계정이 없습니다.' : '没有符合条件的账号。'}</p>}
    </>}
  </div>;
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dirty = Boolean(draft && layoutKey(draft) !== baseline);
  const busy = saving || importBusy;

  function receiveWorkspace(data: HrWorkspace) {
    const value = { departments: data.departments.map((item) => ({ ...item })), employees: data.employees.map((item) => ({ ...item })) };
    setDraft(value); setBaseline(layoutKey(value)); setSaveError(''); setConflict(false); setDepartmentForm(null);
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
  const companyNodes = workspace?.company_structure?.classification.nodes ?? EMPTY_DEPARTMENTS;
  const hasCompanyCells = companyNodes.some((node) => departments.some((department) => department.id === node.id));
  const chartSummary = useMemo(() => ({departments: departments.map((department) => {
    const stats = summary.totals.get(department.id)!;
    return {id:department.id, direct_total:stats.direct === null ? null : centsToAmount(stats.direct), total:stats.total === null ? null : centsToAmount(stats.total),
      known_direct_total:centsToAmount(stats.knownDirect), known_total:centsToAmount(stats.knownTotal),
      direct_count:stats.directCount,headcount:stats.headcount,direct_missing_cost_count:stats.directMissingCount,missing_cost_count:stats.missingCount};
  })}), [departments, summary]);
  const tree = useMemo(() => getDepartmentTree(departments), [departments]);
  const forbiddenParents = useMemo(() => departmentForm && !departmentForm.isNew ? getDescendantIds(departments, departmentForm.id) : new Set<string>(), [departments, departmentForm]);
  function applyCompanyCells() {
    if (!draft || busy) return;
    const known = new Set(departments.map((department) => department.id));
    const next = [...departments, ...companyNodes.filter((node) => !known.has(node.id)).map((node) => ({...node}))];
    try { validateDepartments(next); setDraft({...draft, departments:next}); setNotice(ko ? '회사 부문·기능 분류도를 적용했습니다. 변경 저장이 필요합니다.' : '已应用公司部门·职能分类图，请保存更改。'); }
    catch (failure) { setSaveError(localHrError(failure, lang, ko ? '분류도를 적용하지 못했습니다.' : '无法应用分类图。')); }
  }
  function changeMonth(next: string) {
    if (busy || next === month) return;
    if ((dirty || departmentForm) && !window.confirm(ko ? '저장하지 않은 변경을 버리고 대상 월을 바꿀까요?' : '放弃未保存的更改并切换月份吗？')) return;
    setNotice(''); setSaveError(''); setConflict(false); setDepartmentForm(null); setDraft(null); setBaseline(''); setMonth(next);
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
      const targetDepartment = draft.departments.find((item) => item.id === target);
      const name = targetDepartment ? hrAssignmentPath(targetDepartment.id, departments, lang) : (ko ? '미배치 명단' : '待配置名单');
      setNotice(ko ? `${formatEmployeeCode(employee.code)} 사번을 ${name}(으)로 이동했습니다. 변경 저장이 필요합니다.` : `已将 ${formatEmployeeCode(employee.code)} 移至 ${name}，请保存更改。`);
    } catch (failure) { setSaveError(safeHrError(failure, ko ? '인원을 이동하지 못했습니다.' : '无法移动人员。')); }
  }
  function beginDepartment(department?: HrDepartment, parent?: string) {
    if (busy) return;
    setFormError(''); setDepartmentForm(department ? { ...department, name: hrDepartmentLabel(department.id, department.name, lang), function: department.function ? hrDepartmentLabel(department.id, department.function, lang) : '', isNew: false } : {
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
    if (window.confirm(ko ? `${hrDepartmentLabel(department.id, department.name, lang)} 부서를 배치도에서 삭제할까요? 변경 저장 전에는 되돌릴 수 있습니다.` : `从配置图删除 ${department.name} 部门吗？保存之前可撤销。`)) {
      setDraft({ ...draft, departments: departments.filter((item) => item.id !== department.id) }); setNotice(ko ? '빈 부서를 삭제했습니다. 변경 저장이 필요합니다.' : '已删除空部门，请保存更改。');
    }
  }
  function renderDepartment(node: ReturnType<typeof getDepartmentTree>[number]) {
    const department = node.department;
    const label = hrDepartmentLabel(department.id, department.name, lang);
    const members = employees.filter((employee) => employee.department_id === department.id);
    const totals = summary.totals.get(department.id);
    const isCollapsed = collapsed.has(department.id);
    return <div className="hr-department-branch" key={department.id}>
      <section className="hr-department-box" aria-label={label}>
        <div className="hr-department-heading"><div><h3>{label}</h3><p>{department.function ? hrDepartmentLabel(department.id, department.function, lang) : (ko ? '기능 미등록' : '尚未填写职能')}</p></div><div className="hr-actions">
          <button className="hr-icon-button" onClick={() => beginDepartment(department)} disabled={busy} aria-label={`${label} ${ko ? '부서 편집' : '编辑部门'}`}><Edit3 size={17} /></button>
          <button className="hr-icon-button" onClick={() => beginDepartment(undefined, department.id)} disabled={busy || departments.length >= MAX_DEPARTMENTS} aria-label={`${label} ${ko ? '하위 부서 추가' : '添加下级部门'}`}><Plus size={17} /></button>
          <button className="hr-icon-button" onClick={() => removeDepartment(department)} disabled={busy} aria-label={`${label} ${ko ? '빈 부서 삭제' : '删除空部门'}`}><Trash2 size={16} /></button></div></div>
        <div className="hr-department-figures"><span>{ko ? '직접 배치' : '直接配置'} <strong>{members.length} {ko ? '명' : '人'}</strong></span><span>{ko ? '직접 인건비' : '直接成本'} <strong>{money(totals ? totals.direct : 0, workspace!.currency, lang)}</strong></span>
          {node.children.length > 0 && <span>{ko ? '하위 포함' : '含下级'} <strong>{totals?.headcount ?? 0} {ko ? '명' : '人'} · {money(totals ? totals.total : 0, workspace!.currency, lang)}</strong></span>}</div>

      </section>
      {node.children.length > 0 && <>
        <button className="hr-tree-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(department.id)) next.delete(department.id); else next.add(department.id); return next; })}>{isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}{ko ? '하위 부서' : '下级部门'} {node.children.length}</button>
        {!isCollapsed && <div className="hr-department-children">{node.children.map(renderDepartment)}</div>}
      </>}
    </div>;
  }

  return <HrShell page="personnel" month={month} onMonthChange={changeMonth} monthDisabled={busy} actions={<>
    <button className="hr-button" disabled={!dirty || busy} onClick={discard}><Undo2 size={15} />{ko ? '되돌리기' : '撤销更改'}</button>
    <button className="hr-button is-primary" disabled={!dirty || busy || conflict || Boolean(departmentForm)} onClick={() => void save()}><Save size={15} />{saving ? (ko ? '저장 중…' : '正在保存…') : (ko ? '변경 저장' : '保存更改')}</button>
  </>}>
    {!allowed || loading || error || !workspace || !draft ? <HrLoadState allowed={allowed} loading={loading} error={error} retry={refresh} /> : <>
      <HrCostRibbon departments={departments} employees={employees} currency={workspace.currency} basis={workspace.cost_basis === 'gross_salary' ? (ko ? '세전 급여' : '应发工资') : workspace.cost_basis === 'employer_total' ? (ko ? '회사 부담 총액' : '公司承担总额') : workspace.cost_basis_label} hasSource={Boolean(workspace.source)} />
      {dirty && <p className="hr-draft-indicator" role="status">{ko ? '저장 전 변경사항이 있습니다.' : '有尚未保存的更改。'}</p>}
      {saveError && <p role="alert" className="hr-alert is-error">{saveError}</p>}
      {conflict && <div role="alert" className="hr-alert is-warning"><span>{ko ? '최신 버전과 충돌했습니다. 초안을 확인한 뒤 다시 불러오세요.' : '与最新版本冲突，请确认草稿后重新加载。'}</span><button className="hr-button" disabled={busy} onClick={loadLatest}>{ko ? '최신 내용 불러오기' : '加载最新资料'}</button></div>}
      {notice && <p className="hr-floating-notice" role="status" aria-live="polite">{notice}</p>}
      {hasCompanyCells || departments.length > 0 ? <HrAllocationBoard key={month} departments={departments} employees={employees} summary={chartSummary} currency={workspace.currency} catalog={workspace.company_structure.classification} onMove={move} disabled={busy || Boolean(departmentForm)} /> : <div className="hr-panel hr-state"><h3>{ko ? '회사 부문·기능 분류' : '公司部门·职能分类'}</h3><p>{ko ? '분류를 적용하고 급여표를 올려 인원을 배치하세요.' : '应用分类并上传工资表后配置人员。'}</p><button className="hr-button" onClick={applyCompanyCells} disabled={busy}>{ko ? '분류도 적용' : '应用分类图'}</button></div>}
      <HrSource workspace={workspace} />
      <HrImportPanel workspace={workspace} disabled={dirty || Boolean(departmentForm)} onBusyChange={setImportBusy} onConflict={() => setConflict(true)} onImported={(data) => { setWorkspace(data); setNotice(ko ? '월별 자료를 가져왔습니다.' : '已导入月度资料。'); }} />
      <details className="hr-panel hr-disclosure" open={departmentForm ? true : undefined}>
        <summary>{ko ? '분류 편집' : '编辑分类'}{departmentForm ? (ko ? ' · 편집 중' : ' · 编辑中') : ''}</summary>
        <div className="hr-compact-toolbar"><button className="hr-button" disabled={busy || companyNodes.every((node)=>departments.some((department)=>department.id===node.id))} onClick={applyCompanyCells}>{ko ? '회사 분류 적용' : '应用公司分类'}</button><span className="hr-muted">{departments.length} / {MAX_DEPARTMENTS} · {ko ? '최대 8단계' : '最多 8 级'}</span><button className="hr-button" disabled={busy || departments.length >= MAX_DEPARTMENTS} onClick={() => beginDepartment()}><Plus size={15} />{ko ? '추가 분류' : '添加分类'}</button></div>
        {departmentForm && <section className="hr-department-editor" aria-label={ko ? '부서 정보 편집' : '编辑部门信息'}>
          <div className="hr-section-heading"><h2>{departmentForm.isNew ? (ko ? '새 분류' : '新分类') : (ko ? '분류 편집' : '编辑分类')}</h2><button className="hr-icon-button" aria-label={ko ? '편집 취소' : '取消编辑'} onClick={() => setDepartmentForm(null)}><X size={17} /></button></div>
          <form onSubmit={(event) => { event.preventDefault(); applyDepartment(); }}>
            <div className="hr-form-grid"><label className="hr-field">{ko ? '이름' : '名称'}<input autoFocus maxLength={100} required value={departmentForm.name} onChange={(event) => setDepartmentForm({ ...departmentForm, name: event.target.value })} /></label><label className="hr-field">{ko ? '상위 분류' : '上级分类'}<select disabled={COMPANY_CLASSIFICATION.nodes.some((node)=>node.id===departmentForm.id)} value={departmentForm.parent_id ?? ''} onChange={(event) => setDepartmentForm({ ...departmentForm, parent_id: event.target.value || null })}><option value="">{ko ? '최상위' : '顶级'}</option>{departments.filter((item) => item.id !== departmentForm.id && !forbiddenParents.has(item.id)).map((item) => <option key={item.id} value={item.id}>{hrDepartmentLabel(item.id, item.name, lang)}</option>)}</select></label></div>
            <label className="hr-field">{ko ? '담당 기능' : '负责职能'}<textarea rows={2} maxLength={500} value={departmentForm.function} onChange={(event) => setDepartmentForm({ ...departmentForm, function: event.target.value })} /></label>
            {formError && <p role="alert" className="hr-alert is-error">{formError}</p>}
            <div className="hr-actions"><button type="submit" className="hr-button is-primary"><Check size={15} />{ko ? '반영' : '应用'}</button><button type="button" className="hr-button" onClick={() => setDepartmentForm(null)}>{ko ? '취소' : '取消'}</button></div>
          </form>
        </section>}
        <div className="hr-org">{tree.map(renderDepartment)}</div>
      </details>
      {workspace.history.length > 0 && <details className="hr-panel hr-history hr-disclosure"><summary>{ko ? '저장 이력' : '保存历史'} ({workspace.history.length})</summary><ol>{workspace.history.map((entry) => <li key={entry.version}><strong>v{entry.version}</strong> {entry.action} · {entry.actor} · {new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.created_at))}</li>)}</ol></details>}
      {user?.is_superuser === true && <details className="hr-panel hr-disclosure"><summary><ShieldCheck size={16} /> {ko ? '인사 담당자 권한' : '人事负责人权限'}</summary><HrAccessPanel /></details>}
    </>}
  </HrShell>;
}
