import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { RefreshCw, Users } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessHr } from '../../domains/auth/hr-access';
import { useLang } from '../../i18n';
import { getHrWorkspace } from '../../domains/hr/api';
import { amountToCents } from '../../domains/hr/import';
import type { HrWorkspace, HrCurrency, HrDepartment, HrEmployee } from '../../domains/hr/types';
import './hr.css';

export type HrLang = 'ko' | 'zh';

export function currentHrMonth() {
  const selected = new URLSearchParams(window.location.search).get('month');
  if (selected && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(selected)) return selected;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
}

export function money(value: string | number | null, currency: HrCurrency, lang: HrLang) {
  if (value === null) return '—';
  const cents = typeof value === 'number' ? value : amountToCents(value);
  const formatted = new Intl.NumberFormat(lang === 'ko' ? 'ko-KR' : 'zh-CN', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(cents / 100);
  return currency === 'CNY' ? formatted.replace('CN¥', '¥') : formatted;
}

export function compactMoney(value: string | number | null, currency: HrCurrency, lang: HrLang) {
  if (value === null) return '—';
  const cents = typeof value === 'number' ? value : amountToCents(value);
  return new Intl.NumberFormat(lang === 'ko' ? 'ko-KR' : 'zh-CN', {
    style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
  }).format(cents / 100).replace('CN¥', '¥');
}

export function safeHrError(error: unknown, fallback: string) {
  const failure = error as { response?: { status?: number; data?: { detail?: unknown; error?: unknown; message?: unknown } }; message?: string };
  const data = failure?.response?.data;
  const detail = data?.detail ?? data?.error ?? data?.message;
  return typeof detail === 'string' ? detail : fallback;
}

export function localHrError(error: unknown, lang: HrLang, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  if (lang === 'ko') return message || fallback;
  const translations: [string, string][] = [
    ['제목 행을 선택', '请选择有效的表头行。'], ['서로 다른 열', '每个项目必须选择不同的列。'],
    ['사번이 비어', '员工编号为空。'], ['이름이 비어', '姓名为空。'], ['중복 사번', '员工编号重复，每个编号只能出现一次。'],
    ['숫자 결과가 없습니다', '公式缺少已保存的数值结果，请在 Excel 中重新计算并保存，或粘贴为数值。'],
    ['오류 셀', '请修正错误单元格。'], ['문자 또는 숫자', '请使用文本或数值单元格。'],
    ['직원 한 명', '每位员工的人工成本不得超过 999999999.99。'], ['소수점은 두 자리', '人工成本须为非负数，最多保留两位小数。'],
    ['인건비는', '人工成本须为有效的非负数。'], ['범위를 초과', '人工成本超出可处理范围。'],
    ['가져올 직원이 없습니다', '没有可导入的员工，请检查表头行和列映射。'],
    ['사번은 64자', '员工编号最多 64 字符，姓名与职务最多 100 字符。'],
    ['5000명', '最多可导入 5000 位员工。'], ['5100행', '每张工作表最多 5100 行、200 列。'],
    ['열은 200개', '最多可读取 200 列。'], ['시트는 50개', '最多可读取 50 张工作表。'],
    ['파일에 데이터가 없습니다', '文件中没有数据。'], ['빈 파일', '不能上传空文件。'],
    ['파일을 읽을 수 없습니다', '无法读取文件，请检查 XLSX 或 UTF-8 CSV 格式。'], ['XLSX 또는 CSV', '请选择 XLSX 或 CSV 文件。'],
    ['10MB', '文件大小不得超过 10 MB。'], ['부서명을 입력', '请填写部门名称。'],
    ['부서 계층을 순환', '部门层级不能形成循环。'], ['8단계', '部门层级最多 8 级。'],
    ['200개', '最多可创建 200 个部门。'], ['상위 부서를 찾을 수', '找不到上级部门。'],
    ['부서 ID는 64자', '部门名称最多 100 字符，职能最多 500 字符。'],
  ];
  const translated = translations.find(([source]) => message.includes(source))?.[1] ?? fallback;
  const row = message.match(/^(\d+)행:/)?.[1];
  return row ? `第 ${row} 行：${translated}` : translated;
}

export function isHrConflict(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status === 409;
}

export function useHrWorkspace(month: string) {
  const { user } = useAuth();
  const allowed = canAccessHr(user);
  const { lang } = useLang();
  const language = useRef(lang);
  useEffect(() => { language.current = lang; }, [lang]);
  const [workspace, setWorkspace] = useState<HrWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    const identity = ++request.current;
    const controller = new AbortController();
    setWorkspace(null); setError('');
    if (!allowed) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    getHrWorkspace(month, controller.signal).then((data) => {
      if (!controller.signal.aborted && identity === request.current) setWorkspace(data);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted && identity === request.current) {
        const status = (failure as { response?: { status?: number } })?.response?.status;
        setError(status === 401 || status === 403
          ? (language.current === 'ko' ? '인사 자료를 조회할 권한이 없습니다.' : '没有查看人事资料的权限。')
          : (language.current === 'ko' ? '인사 자료를 불러오지 못했습니다. 다시 시도해 주세요.' : '无法加载人事资料，请重试。'));
      }
    }).finally(() => { if (!controller.signal.aborted && identity === request.current) setLoading(false); });
    return () => controller.abort();
  }, [month, reload, allowed, user?.id]);
  // A month picker rerender precedes the effect cleanup: never label the previous
  // month's payroll as the newly selected month, even for that first frame.
  const selectedWorkspace = workspace?.month === month ? workspace : null;
  return { workspace: selectedWorkspace, setWorkspace, loading: loading || (allowed && !selectedWorkspace && !error), error, allowed, refresh: () => setReload((value) => value + 1) };
}

export function HrShell({ page, month, onMonthChange, monthDisabled, children, actions }: {
  page: 'personnel' | 'labor-cost'; month: string; onMonthChange: (month: string) => void;
  monthDisabled?: boolean; children: ReactNode; actions?: ReactNode;
}) {
  const { lang } = useLang();
  const ko = lang === 'ko';
  const location = useLocation(); const navigate = useNavigate();
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get('month') === month) return;
    query.set('month', month);
    navigate({pathname:location.pathname,search:query.toString()}, {replace:true});
  }, [month, location.pathname, location.search, navigate]);
  return <main className="hr-page">
    <header className="hr-work-header">
      <div className="hr-work-title"><h1>{ko ? '인원 · 인건비' : '人员 · 人工成本'}</h1></div>
      <nav aria-label={ko ? '인사·총무 페이지' : '人事·总务页面'} className="hr-tabs">
        <Link className={page === 'personnel' ? 'is-active' : ''} aria-current={page === 'personnel' ? 'page' : undefined} to={`/hr/personnel?month=${month}`}><Users size={16} />{ko ? '인원 배치' : '人员配置'}</Link>
        <Link className={page === 'labor-cost' ? 'is-active' : ''} aria-current={page === 'labor-cost' ? 'page' : undefined} to={`/hr/labor-cost?month=${month}`}>{ko ? '인건비 집계' : '人工成本汇总'}</Link>
      </nav>
      <label className="hr-month">{ko ? '대상 월' : '月份'}<input type="month" value={month} disabled={monthDisabled} onInput={(event) => { if (/^\d{4}-\d{2}$/.test(event.currentTarget.value)) onMonthChange(event.currentTarget.value); }} /></label>
      {actions && <div className="hr-header-actions">{actions}</div>}
    </header>
    {children}
  </main>;
}

export function HrLoadState({ loading, error, allowed, retry }: { loading: boolean; error: string; allowed: boolean; retry: () => void }) {
  const { lang } = useLang();
  const ko = lang === 'ko';
  return <section className="hr-panel hr-state" role={error || !allowed ? 'alert' : 'status'}>
    <p>{!allowed ? (ko ? 'superuser와 지정된 인사 담당자만 이 페이지를 볼 수 있습니다.' : '仅 superuser 和已授权的人事负责人可以查看此页面。')
      : loading ? (ko ? '인사 자료를 불러오는 중입니다.' : '正在加载人事资料。') : error}</p>
    {allowed && !loading && <button className="hr-button" onClick={retry}><RefreshCw size={16} />{ko ? '다시 불러오기' : '重新加载'}</button>}
  </section>;
}

export function HrSource({ workspace }: { workspace: HrWorkspace }) {
  const { lang } = useLang();
  const ko = lang === 'ko';
  if (!workspace.source) return null;
  const basis = workspace.cost_basis === 'employer_total' ? (ko ? '회사 부담 총인건비' : '公司承担的人工总成本')
    : workspace.cost_basis === 'gross_salary' ? (ko ? '세전 급여' : '税前工资') : workspace.cost_basis_label;
  return <div className="hr-source">
    <span><strong>{ko ? '자료' : '资料'}</strong> {workspace.source.filename}</span>
    <span>{workspace.source.row_count.toLocaleString()} {ko ? '명' : '人'} · {workspace.currency} · {basis}</span>
    <span>{ko ? '최근 저장' : '最近保存'}: {workspace.updated_at ? new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(workspace.updated_at)) : '—'}</span>
  </div>;
}

export function layoutSummary(departments: HrDepartment[], employees: HrEmployee[]) {
  const totals = new Map(departments.map((department) => [department.id, { direct: 0 as number | null, total: 0 as number | null, knownDirect: 0, knownTotal: 0, directMissingCount: 0, missingCount: 0, directCount: 0, headcount: 0 }]));
  let knownTotal = 0; let knownAssigned = 0; let assignedCount = 0; let missingCostCount = 0; let assignedMissing = 0;
  for (const employee of employees) {
    const unknown = employee.amount === null;
    const cents = unknown ? 0 : amountToCents(employee.amount); knownTotal += cents; missingCostCount += Number(unknown);
    if (!employee.department_id) continue;
    const direct = totals.get(employee.department_id);
    if (!direct) continue;
    knownAssigned += cents; assignedCount += 1; assignedMissing += Number(unknown);
    direct.knownDirect += cents; direct.directCount += 1; direct.directMissingCount += Number(unknown);
    direct.direct = direct.directMissingCount ? null : direct.knownDirect;
    let id: string | null = employee.department_id;
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      const branch = totals.get(id);
      if (!branch) break;
      branch.knownTotal += cents; branch.headcount += 1; branch.missingCount += Number(unknown);
      branch.total = branch.missingCount ? null : branch.knownTotal;
      id = departments.find((department) => department.id === id)?.parent_id ?? null;
    }
  }
  return { total: missingCostCount ? null : knownTotal, assigned: assignedMissing ? null : knownAssigned,
    unassigned: missingCostCount - assignedMissing ? null : knownTotal - knownAssigned,
    knownTotal, knownAssigned, missingCostCount, costComplete: missingCostCount === 0,
    assignedCount, unassignedCount: employees.length - assignedCount, totals };
}
