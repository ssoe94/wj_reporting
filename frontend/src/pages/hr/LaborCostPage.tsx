import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Save, Undo2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import { buildAssignments, flattenDepartments, moveEmployee } from '../../domains/hr/layout';
import { updateHrWorkspace } from '../../domains/hr/api';
import { centsToAmount } from '../../domains/hr/import';
import { hrDepartmentLabel, hrGroupLabel } from '../../domains/hr/labels';
import { formatEmployeeCode, getDepartmentCostBreakdowns } from '../../domains/hr/visualization';
import type { HrDepartment, HrEmployee, HrWorkspace } from '../../domains/hr/types';
import HrAllocationBoard from './HrAllocationBoard';
import HrCostRibbon from './HrCostRibbon';
import CompanyOrganizationChart from './CompanyOrganizationChart';
import { HrLoadState, HrShell, HrSource, currentHrMonth, isHrConflict, layoutSummary, money, useHrWorkspace } from './hrCommon';

const EMPTY_DEPARTMENTS: HrDepartment[] = [];
const EMPTY_EMPLOYEES: HrEmployee[] = [];
type LayoutDraft = { departments: HrDepartment[]; employees: HrEmployee[] };
const assignmentKey = (employees: HrEmployee[]) => JSON.stringify(buildAssignments(employees));

function shareOfTotal(part: number | null, total: number | null) {
  if (part === null || total === null || total <= 0) return null;
  const denominator = BigInt(total);
  const hundredths = (BigInt(part) * 20000n + denominator) / (denominator * 2n);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

export default function LaborCostPage() {
  const { lang } = useLang(); const ko = lang === 'ko';
  const { user } = useAuth();
  const [month, setMonth] = useState(currentHrMonth);
  const { workspace, setWorkspace, loading, error, allowed, refresh } = useHrWorkspace(month);
  const [draft, setDraft] = useState<LayoutDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const userId = useRef(user?.id);
  userId.current = user?.id;
  const dirty = Boolean(draft && assignmentKey(draft.employees) !== baseline);

  function receiveWorkspace(data: HrWorkspace) {
    const next = { departments: data.departments.map((department) => ({ ...department })), employees: data.employees.map((employee) => ({ ...employee })) };
    setDraft(next); setBaseline(assignmentKey(next.employees)); setSaveError(''); setConflict(false);
  }
  useEffect(() => { if (workspace) receiveWorkspace(workspace); }, [workspace]);
  useEffect(() => { setDraft(null); setBaseline(''); setSaveError(''); setConflict(false); setNotice(''); }, [user?.id]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dirty && !saving) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download') || event.defaultPrevented
        || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const next = new URL(anchor.href, window.location.href);
      if (next.origin === window.location.origin && next.pathname === window.location.pathname && next.search === window.location.search) return;
      if (savingRef.current || !window.confirm(ko ? '저장하지 않은 배치 변경을 버리고 이동할까요?' : '放弃未保存的配置更改并离开吗？')) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', onLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onLink, true); };
  }, [dirty, saving, ko]);

  const departments = draft?.departments ?? EMPTY_DEPARTMENTS;
  const employees = draft?.employees ?? EMPTY_EMPLOYEES;
  const metrics = useMemo(() => layoutSummary(departments, employees), [departments, employees]);
  const summary = useMemo(() => ({ departments: departments.map((department) => {
    const total = metrics.totals.get(department.id)!;
    return { id: department.id, direct_total: total.direct === null ? null : centsToAmount(total.direct), total: total.total === null ? null : centsToAmount(total.total),
      known_direct_total: centsToAmount(total.knownDirect), known_total: centsToAmount(total.knownTotal), direct_count: total.directCount, headcount: total.headcount,
      direct_missing_cost_count: total.directMissingCount, missing_cost_count: total.missingCount, share: shareOfTotal(total.total, metrics.total) };
  }) }), [departments, metrics]);
  const flattened = useMemo(() => flattenDepartments(departments), [departments]);
  const totals = useMemo(() => new Map(summary?.departments.map((entry) => [entry.id, entry]) ?? []), [summary]);
  const roleTotals = useMemo(() => getDepartmentCostBreakdowns(departments, employees, workspace?.company_structure.classification.groups.map((group) => group.id) ?? []), [departments, employees, workspace]);
  function changeMonth(next: string) {
    if (savingRef.current || next === month) return;
    if (dirty && !window.confirm(ko ? '저장하지 않은 배치 변경을 버리고 대상 월을 바꿀까요?' : '放弃未保存的配置更改并切换月份吗？')) return;
    setDraft(null); setBaseline(''); setSaveError(''); setConflict(false); setNotice(''); setMonth(next);
  }
  function move(code: string, target: string | null) {
    if (!draft || savingRef.current || !allowed) return;
    const person = draft.employees.find((employee) => employee.code === code);
    if (!person || person.department_id === target) return;
    try {
      setDraft({ ...draft, employees: moveEmployee(draft.employees, code, target, draft.departments) });
      setSaveError(''); setNotice(ko ? `${formatEmployeeCode(code)} 사번의 배치를 변경했습니다. 변경 저장이 필요합니다.` : `已更改工号 ${formatEmployeeCode(code)} 的配置，请保存更改。`);
    } catch { setSaveError(ko ? '배치를 변경하지 못했습니다. 현재 초안은 유지됩니다.' : '无法更改配置，当前草稿已保留。'); }
  }
  function discard() {
    if (!workspace || savingRef.current) return;
    if (window.confirm(ko ? '저장하지 않은 배치 변경을 버릴까요?' : '放弃未保存的配置更改吗？')) { receiveWorkspace(workspace); setNotice(ko ? '저장하지 않은 변경을 되돌렸습니다.' : '已撤销未保存的更改。'); }
  }
  function loadLatest() {
    if (savingRef.current || !window.confirm(ko ? '작성 중인 배치 초안을 버리고 서버의 최신 자료를 불러올까요?' : '放弃当前配置草稿并加载服务器最新资料吗？')) return;
    setNotice(''); refresh();
  }
  async function save() {
    if (!draft || !workspace || !dirty || savingRef.current || conflict || !allowed) return;
    const actor = user?.id;
    savingRef.current = true; setSaving(true); setSaveError(''); setNotice('');
    try {
      const result = await updateHrWorkspace(month, { version: workspace.version, departments: draft.departments, assignments: buildAssignments(draft.employees) });
      if (mounted.current && userId.current === actor) { receiveWorkspace(result); setWorkspace(result); setNotice(ko ? '인원 배치와 변경 이력을 저장했습니다.' : '已保存人员配置及更改历史。'); }
    } catch (failure) {
      if (mounted.current && userId.current === actor) {
        const stale = isHrConflict(failure); setConflict(stale);
        setSaveError(stale ? (ko ? '다른 사용자가 먼저 저장했습니다. 작성한 초안은 유지됩니다. 내용을 확인한 뒤 최신 자료를 명시적으로 불러와 다시 편집해 주세요.' : '其他用户已先行保存，当前草稿已保留。请确认内容后主动加载最新资料并重新编辑。')
          : (ko ? '저장하지 못했습니다. 작성한 배치 초안은 유지됩니다.' : '保存失败，当前配置草稿已保留。'));
      }
    } finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }

  return <HrShell page="labor-cost" month={month} onMonthChange={changeMonth} monthDisabled={saving} actions={<>
    <button className="hr-button" disabled={!dirty || saving} onClick={discard}><Undo2 size={15} />{ko ? '되돌리기' : '撤销更改'}</button>
    <button className="hr-button is-primary" disabled={!dirty || saving || conflict} onClick={() => void save()}><Save size={15} />{saving ? (ko ? '저장 중…' : '正在保存…') : (ko ? '변경 저장' : '保存更改')}</button>
  </>}>
    {!allowed || loading || error || !workspace || !draft ? <HrLoadState loading={loading} error={error} allowed={allowed} retry={refresh} /> : <>
      {dirty && <p className="hr-draft-indicator" role="status">{ko ? '저장 전 배치 변경이 있습니다. 아래 합계와 집계표는 현재 초안 기준입니다.' : '配置更改尚未保存，下方合计及汇总表按当前草稿显示。'}</p>}
      {saveError && <p className="hr-alert is-error" role="alert">{saveError}</p>}
      {conflict && <div className="hr-alert is-warning"><span>{ko ? '최신 버전과 충돌했습니다. 초안을 확인한 뒤 최신 자료를 불러오세요.' : '与最新版本冲突，请确认草稿后加载最新资料。'}</span><button className="hr-button" disabled={saving} onClick={loadLatest}>{ko ? '최신 내용 불러오기' : '加载最新资料'}</button></div>}
      {notice && <p className="hr-floating-notice" role="status" aria-live="polite">{notice}</p>}
      {!workspace.source && <div className="hr-empty-intake">{ko ? '이 월에 가져온 급여표가 없습니다.' : '本月尚未导入工资表。'} <Link to={`/hr/personnel?month=${month}`}>{ko ? '자료 올리기' : '上传资料'}</Link></div>}
      <HrCostRibbon departments={departments} employees={employees} currency={workspace.currency} basis={workspace.cost_basis === 'gross_salary' ? (ko ? '세전 급여' : '应发工资') : workspace.cost_basis === 'employer_total' ? (ko ? '회사 부담 총액' : '公司承担总额') : workspace.cost_basis_label} hasSource={Boolean(workspace.source)} />
      <HrAllocationBoard key={month} departments={departments} employees={employees} summary={summary} currency={workspace.currency} catalog={workspace.company_structure.classification} onMove={move} disabled={saving} />
      <HrSource workspace={workspace} />
      <div className="hr-secondary-views">
        <details className="hr-disclosure"><summary>{ko ? '관리자·작업 인건비 집계표' : '管理人员·作业成本汇总表'}</summary><div className="hr-table-scroll"><table><thead><tr><th>{ko ? '부서' : '部门'}</th><th className="hr-number">{ko ? '관리자 인원' : '管理人数'}</th><th className="hr-number">{ko ? '관리자 인건비' : '管理成本'}</th><th className="hr-number">{ko ? '작업·실무 인원' : '作业·实务人数'}</th><th className="hr-number">{ko ? '작업·실무 인건비' : '作业·实务成本'}</th><th className="hr-number">{ko ? '부서 합계' : '部门合计'}</th></tr></thead><tbody>{workspace.company_structure.classification.groups.map((group) => {
          const split = roleTotals.get(group.id); const name = hrGroupLabel(group.id, departments.find((department) => department.id === group.id)?.name, lang);
          const cost = (value: string | null | undefined) => value === undefined ? '—' : value === null ? (ko ? '미확정' : '待确认') : money(value, workspace.currency, lang);
          return <tr key={group.id}><td>{name}</td><td className="hr-number">{split?.management.count ?? 0}</td><td className="hr-number">{cost(split?.management.amount)}</td><td className="hr-number">{split?.operations.count ?? 0}</td><td className="hr-number">{cost(split?.operations.amount)}</td><td className="hr-number">{cost(split?.total.amount)}</td></tr>;
        })}</tbody></table></div></details>
        <details className="hr-disclosure"><summary>{ko ? '전체 조직도' : '完整组织图'}</summary><CompanyOrganizationChart organization={workspace.company_structure.organization} /></details>
        <details className="hr-disclosure"><summary>{ko ? '상세 집계표' : '详细汇总表'}</summary><div className="hr-table-scroll"><table><thead><tr><th>{ko ? '부문·기능' : '部门·职能'}</th><th className="hr-number">{ko ? '직접 인원' : '直接人数'}</th><th className="hr-number">{ko ? '직접 비용' : '直接成本'}</th><th className="hr-number">{ko ? '하위 포함 비용' : '含下级成本'}</th><th className="hr-number">{ko ? '비중' : '占比'}</th></tr></thead><tbody>{flattened.map(({department,depth}) => {
          const total = totals.get(department.id);
          return <tr key={department.id}><td style={{paddingInlineStart: `${12 + depth * 12}px`}}><span>{roleTotals.has(department.id) ? hrGroupLabel(department.id, department.name, lang) : hrDepartmentLabel(department.id, department.name, lang)}</span></td><td className="hr-number">{total?.direct_count ?? 0}</td><td className="hr-number">{money(total?.direct_total ?? null,workspace.currency,lang)}</td><td className="hr-number">{money(total?.total ?? null,workspace.currency,lang)}</td><td className="hr-number">{total?.share == null ? '—' : `${total.share}%`}</td></tr>;
        })}</tbody></table></div></details>
      </div>
    </>}
  </HrShell>;
}
