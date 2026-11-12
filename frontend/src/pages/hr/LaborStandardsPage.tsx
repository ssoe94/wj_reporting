import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessHr } from '../../domains/auth/hr-access';
import { useLang } from '../../i18n';
import { getHrLaborActualPayments, getHrLaborCalendar, getHrLaborStandards, saveHrLaborActualPayments, saveHrLaborCalendar, saveHrLaborStandards } from '../../domains/hr/labor-standards-api';
import { actualPaymentIssue, laborCalendarDates, laborContributionLabel, laborDayLabel, laborDefaultDay, laborHistoryChanges, laborSummaryRows, pendingLaborItems } from '../../domains/hr/labor-standards';
import type { HrContribution, HrLaborActualPayments, HrLaborCalendar, HrLaborDayType, HrLaborHistory, HrLaborRules, HrLaborStandards } from '../../domains/hr/labor-standards';
import { getHrRoster } from '../../domains/hr/api';
import type { HrRosterEntry } from '../../domains/hr/workbook-types';
import { currentHrMonth, HrLoadState, HrShell, isHrConflict } from './hrCommon';

type FormActivity = { dirty: boolean; busy: boolean };
type FormProps<T> = { initial: T; ko: boolean; onActivity: (activity: FormActivity) => void; restart: () => void };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function useLaborResource<T>(month: string, identity: string, allowed: boolean, get: (month: string, signal?: AbortSignal) => Promise<T>) {
  const scope = `${identity}:${month}`;
  const [result, setResult] = useState<{ scope: string; value: T } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setResult(null); setFailure(null);
    if (allowed) get(month, controller.signal).then((value) => { if (!controller.signal.aborted) setResult({ scope, value }); })
      .catch(() => { if (!controller.signal.aborted) setFailure(scope); });
    return () => controller.abort();
  }, [month, scope, allowed, get, reload]);
  return { value: allowed && result?.scope === scope ? result.value : null, error: failure === scope,
    restart: () => { setResult(null); setReload((value) => value + 1); }, update: (value: T) => setResult({ scope, value }) };
}

function Pending({ value, ko }: { value: boolean; ko: boolean }) {
  return value ? <span className="hr-labor-pending-label">{ko ? '미입력' : '未填写'}</span> : null;
}
function Confirmation({ confirmed, ko }: { confirmed: boolean; ko: boolean }) {
  return <span className={confirmed ? 'hr-muted' : 'hr-labor-pending-label'}>{confirmed ? (ko ? '확정' : '已确认') : (ko ? '미확정' : '未确认')}</span>;
}
function LaborHistory({ history, ko, roster = [] }: { history: HrLaborHistory[]; ko: boolean; roster?: HrRosterEntry[] }) {
  const labels: Record<string, string> = {
    multipliers: ko ? '할증 배수' : '加成倍数', contract: ko ? '계약직' : '合同工', hourly: ko ? '시급직' : '小时工',
    workday: ko ? '평일' : '平日', rest_day: ko ? '휴일' : '休息日', public_holiday: ko ? '법정 공휴일' : '法定节假日',
    days_per_month: ko ? '월 환산 일수' : '月折算天数', hours_per_day: ko ? '하루 기준 시간' : '日标准时数',
    hourly_premium: ko ? '시급직 할증' : '小时工加成', enabled: ko ? '적용 여부' : '是否适用', confirmed: ko ? '확정 여부' : '是否确认',
    department_overtime: ko ? '부서별 야근 시간' : '部门加班时数', weekday_excluded_titles: ko ? '제외 직무' : '除外职务', titles: ko ? '직무 목록' : '职务列表',
    department_hours_include_fixed_overtime: ko ? '고정 연장수당 포함' : '包含固定平时加班', employer_contributions: ko ? '회사 부담' : '公司承担',
    contributions: ko ? '보험·공적금 기준' : '保险与公积金标准', applies_to: ko ? '적용' : '适用范围', hourly_rates: ko ? '시급' : '时薪', company_default: ko ? '회사 기본' : '公司默认', employee_overrides: ko ? '직원별 예외' : '员工例外', employee_id: ko ? '직원' : '员工', effective_month: ko ? '적용 시작 월' : '生效起始月份', amount: ko ? '금액' : '金额', reason: ko ? '사유' : '原因', rule: ko ? '기준액 규칙' : '基数规则', common_amount: ko ? '회사 공통 기준액' : '公司统一基数', employee_amounts: ko ? '직원별 기준액' : '员工基数', lower: ko ? '하한' : '下限', upper: ko ? '상한' : '上限', items: ko ? '항목' : '项目', employer_rate: ko ? '회사 요율' : '公司费率', employee_rate: ko ? '직원 요율' : '员工费率', pension: ko ? '양로' : '养老', medical: ko ? '의료' : '医疗', unemployment: ko ? '실업' : '失业', work_injury: ko ? '공상' : '工伤', maternity: ko ? '생육' : '生育', amounts: ko ? '납부액' : '缴费金额', total: ko ? '총액' : '总额', evidence_memo: ko ? '근거 메모' : '依据备注',
    social_insurance: ko ? '사회보험' : '社会保险', housing_fund: ko ? '공적금' : '公积金', rate_percent: ko ? '요율 (%)' : '费率 (%)', base: ko ? '기준액' : '基数', fixed_amount: ko ? '고정 기준액' : '固定基数',
  };
  function display(value: unknown, path: string): string {
    if (path.endsWith('employee_id') && value != null) { const person = roster.find((item) => item.id === value); if (person) return `${person.code} ${person.name}`; }
    if ((value === null || value === undefined) && /^\d{4}-\d{2}-\d{2}$/.test(path)) {
      return `${ko ? '요일 기본값' : '按星期默认'} (${laborDayLabel(laborDefaultDay(path), ko)})`;
    }
    if (value === null || value === undefined) return ko ? '미입력' : '未填写';
    if (typeof value === 'boolean') return value ? (ko ? '예' : '是') : (ko ? '아니오' : '否');
    if (Array.isArray(value)) return value.length ? value.map((entry) => typeof entry === 'object' ? JSON.stringify(entry) : String(entry)).join(', ') : (ko ? '없음' : '无');
    if (value === 'gross') return ko ? '응발액' : '应发工资';
    if (value === 'fixed') return ko ? '고정 기준액' : '固定基数';
    if (value === 'common') return ko ? '회사 공통 기준액' : '公司统一基数';
    if (value === 'employee') return ko ? '직원별 기준액' : '员工基数';
    if (['workday', 'rest_day', 'public_holiday', 'adjusted_workday'].includes(String(value))) return laborDayLabel(value as HrLaborDayType, ko);
    return String(value);
  }
  return <details className="hr-labor-history"><summary>{ko ? '변경 이력' : '变更记录'} ({history.length})</summary>
    {!history.length ? <p className="hr-muted">{ko ? '변경 이력이 없습니다.' : '暂无变更记录。'}</p> : <ol>{history.map((item) => <li key={item.id}>
      <div className="hr-labor-history-meta"><strong>v{item.version}</strong><time dateTime={item.created_at}>{new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.created_at))}</time><span>{item.actor_label}</span></div>
      <p>{ko ? '사유' : '原因'}: {item.reason}</p>
      <ul>{laborHistoryChanges(item.before, item.after).map((change) => <li key={change.path}><strong>{change.path.split('.').map((part) => labels[part] ?? part).join(' · ')}</strong>: {display(change.before, change.path)} → {display(change.after, change.path)}</li>)}</ul>
    </li>)}</ol>}
  </details>;
}
function SaveFeedback({ conflict, message, ko, restart }: { conflict: boolean; message: string; ko: boolean; restart: () => void }) {
  return <>{message && <p className="hr-alert is-error" role="alert">{message}</p>}{conflict && <div className="hr-alert is-warning" role="alert"><span>{ko ? '다른 변경과 충돌했습니다. 초안을 유지했습니다. 최신 기준을 확인한 뒤 다시 편집해 주세요.' : '资料已被更新，当前草稿已保留。请加载最新资料后重新编辑。'}</span><button type="button" className="hr-button" onClick={() => {
    if (window.confirm(ko ? '현재 초안을 버리고 최신 내용을 불러올까요?' : '放弃当前草稿并加载最新资料吗？')) restart();
  }}>{ko ? '최신 내용으로 다시 시작' : '加载最新资料重新编辑'}</button></div>}</>;
}

function LaborContributionEditor({ fund, value, ko, roster, rosterDisabled, onChange }: { fund: 'social_insurance' | 'housing_fund'; value: HrContribution; ko: boolean; roster: HrRosterEntry[]; rosterDisabled: boolean; onChange: (value: HrContribution) => void }) {
  const [employee, setEmployee] = useState(''); const [amount, setAmount] = useState('');
  const label = laborContributionLabel(fund, ko);
  const baseChange = (change: Partial<HrContribution['base']>) => onChange({ ...value, base: { ...value.base, ...change } });
  return <section className="hr-labor-contribution" data-fund={fund}>
    <h3>{label}</h3>
    <div className="hr-labor-fields">{(['contract', 'hourly'] as const).map((type) => <label className="hr-field" key={type}>{type === 'contract' ? (ko ? '계약직 적용' : '适用合同工') : (ko ? '시급직 적용' : '适用小时工')}<select aria-label={`${label} ${type === 'contract' ? (ko ? '계약직 적용' : '适用合同工') : (ko ? '시급직 적용' : '适用小时工')}`} className={value.applies_to[type] === null ? 'is-pending' : ''} value={value.applies_to[type] === null ? '' : value.applies_to[type] ? 'yes' : 'no'} onChange={(event) => onChange({ ...value, applies_to: { ...value.applies_to, [type]: event.target.value === '' ? null : event.target.value === 'yes' } })}><option value="">{ko ? '미확정' : '未确认'}</option><option value="yes">{ko ? '적용' : '适用'}</option><option value="no">{ko ? '미적용' : '不适用'}</option></select></label>)}</div>
    <div className="hr-table-scroll"><table className="hr-labor-rate-table"><thead><tr><th>{ko ? '항목' : '项目'}</th><th>{ko ? '회사 요율 (%)' : '公司费率 (%)'}</th><th>{ko ? '직원 요율 (%)' : '员工费率 (%)'}</th></tr></thead><tbody>{Object.entries(value.items).map(([item, rates]) => <tr key={item}><th scope="row">{laborContributionLabel(item, ko)}</th>{(['employer_rate', 'employee_rate'] as const).map((side) => <td key={side}><input aria-label={`${label} ${laborContributionLabel(item, ko)} ${side === 'employer_rate' ? (ko ? '회사 요율' : '公司费率') : (ko ? '직원 요율' : '员工费率')}`} type="number" min="0" max="100" step="any" className={rates[side] === null ? 'is-pending' : ''} value={rates[side] ?? ''} placeholder={ko ? '미입력' : '未填写'} onChange={(event) => onChange({ ...value, items: { ...value.items, [item]: { ...rates, [side]: event.target.value || null } } })} /><Pending value={rates[side] === null} ko={ko} /></td>)}</tr>)}</tbody></table></div>
    <label className="hr-field">{ko ? '기준액 규칙' : '基数规则'}<select aria-label={`${label} ${ko ? '기준액 규칙' : '基数规则'}`} className={value.base.rule === null ? 'is-pending' : ''} value={value.base.rule ?? ''} onChange={(event) => baseChange({ rule: (event.target.value || null) as HrContribution['base']['rule'] })}><option value="">{ko ? '미입력' : '未填写'}</option><option value="common">{ko ? '회사 공통 기준액' : '公司统一基数'}</option><option value="employee">{ko ? '직원별 기준액' : '员工基数'}</option><option value="gross">{ko ? '응발액' : '应发工资'}</option></select></label>
    {value.base.rule === 'common' && <label className="hr-field">{ko ? '회사 공통 기준액 (CNY)' : '公司统一基数 (CNY)'}<input aria-label={`${label} ${ko ? '회사 공통 기준액' : '公司统一基数'}`} type="number" min="0" step="any" className={value.base.common_amount === null ? 'is-pending' : ''} value={value.base.common_amount ?? ''} placeholder={ko ? '미입력' : '未填写'} onChange={(event) => baseChange({ common_amount: event.target.value || null })} /><Pending value={value.base.common_amount === null} ko={ko} /></label>}
    {value.base.rule === 'employee' && <div className="hr-labor-employee-bases">{Object.entries(value.base.employee_amounts).map(([id, employeeAmount]) => {
      const person = roster.find((entry) => entry.id === Number(id));
      return <div className="hr-labor-fields" key={id}><label className="hr-field">{person ? `${person.code} · ${person.name}` : `${ko ? '명부 직원' : '名册员工'} #${id}`}<input aria-label={`${label} ${ko ? '직원 기준액' : '员工基数'} ${id}`} type="number" min="0" step="any" value={employeeAmount} onChange={(event) => baseChange({ employee_amounts: { ...value.base.employee_amounts, [id]: event.target.value } })} /></label><button type="button" className="hr-button" aria-label={`${label} ${ko ? '직원 기준액 제거' : '移除员工基数'} ${id}`} onClick={() => { const next = { ...value.base.employee_amounts }; delete next[id]; baseChange({ employee_amounts: next }); }}>{ko ? '제거' : '移除'}</button></div>;
    })}<div className="hr-labor-fields"><label className="hr-field">{ko ? '명부 직원' : '名册员工'}<select aria-label={`${label} ${ko ? '기준액 직원 선택' : '选择基数员工'}`} disabled={rosterDisabled} value={employee} onChange={(event) => setEmployee(event.target.value)}><option value="">{ko ? '직원 선택' : '选择员工'}</option>{roster.filter((entry) => !(String(entry.id) in value.base.employee_amounts)).map((entry) => <option key={entry.id} value={entry.id}>{entry.code} · {entry.name}</option>)}</select></label><label className="hr-field">{ko ? '직원별 기준액 (CNY)' : '员工基数 (CNY)'}<input aria-label={`${label} ${ko ? '추가할 직원 기준액' : '待添加员工基数'}`} type="number" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><button type="button" className="hr-button" disabled={rosterDisabled || !employee || !amount.trim() || employee in value.base.employee_amounts} onClick={() => { baseChange({ employee_amounts: { ...value.base.employee_amounts, [employee]: amount } }); setEmployee(''); setAmount(''); }}>{ko ? '직원 기준액 추가' : '添加员工基数'}</button></div></div>}
    <div className="hr-labor-fields">{(['lower', 'upper'] as const).map((bound) => <label className="hr-field" key={bound}>{bound === 'lower' ? (ko ? '기준액 하한 (CNY)' : '基数下限 (CNY)') : (ko ? '기준액 상한 (CNY)' : '基数上限 (CNY)')}<input aria-label={`${label} ${bound === 'lower' ? (ko ? '기준액 하한' : '基数下限') : (ko ? '기준액 상한' : '基数上限')}`} type="number" min="0" step="any" value={value.base[bound] ?? ''} placeholder={ko ? '제한 없음' : '不限'} onChange={(event) => baseChange({ [bound]: event.target.value || null })} /></label>)}</div>
  </section>;
}

export function LaborRulesForm({ initial, ko, onActivity, restart, roster = [], rosterError = false, rosterLoading = false, retryRoster, onSaved }: FormProps<HrLaborStandards> & { roster?: HrRosterEntry[]; rosterError?: boolean; rosterLoading?: boolean; retryRoster?: () => void; onSaved?: (value: HrLaborStandards) => void }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => copy(initial.rules));
  const [departments, setDepartments] = useState(() => Object.entries(initial.rules.department_overtime).map(([name, hours]) => ({ name, hours })));
  const [titles, setTitles] = useState(initial.rules.weekday_excluded_titles.titles.join('\n'));
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false); const [message, setMessage] = useState('');
  const rules: HrLaborRules = { ...draft, department_overtime: Object.fromEntries(departments.map((row) => [row.name.trim(), row.hours])),
    weekday_excluded_titles: { ...draft.weekday_excluded_titles, titles: [...new Set(titles.split('\n').map((title) => title.trim()).filter(Boolean))] } };
  const invalidDepartments = departments.some((row) => !row.name.trim()) || new Set(departments.map((row) => row.name.trim())).size !== departments.length;
  const dirty = invalidDepartments || JSON.stringify(rules) !== JSON.stringify(saved.rules);
  const pending = pendingLaborItems(rules, ko);
  useEffect(() => { onActivity({ dirty, busy }); return () => onActivity({ dirty: false, busy: false }); }, [dirty, busy, onActivity]);
  const invalidOverrides = rules.hourly_rates.employee_overrides.some((item) => item.employee_id < 1 || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(item.effective_month) || !item.amount.trim() || !item.reason.trim())
    || new Set(rules.hourly_rates.employee_overrides.map((item) => `${item.employee_id}:${item.effective_month}`)).size !== rules.hourly_rates.employee_overrides.length;
  async function save() {
    if (busy || conflict || !reason.trim() || invalidDepartments || invalidOverrides || (!dirty && saved.version > 0)) return;
    setBusy(true); setMessage('');
    try {
      const result = await saveHrLaborStandards(saved.month, { version: saved.version, reason: reason.trim(), rules });
      setSaved(result); onSaved?.(result); setDraft(copy(result.rules)); setDepartments(Object.entries(result.rules.department_overtime).map(([name, hours]) => ({ name, hours }))); setTitles(result.rules.weekday_excluded_titles.titles.join('\n')); setReason('');
    } catch (error) {
      if (isHrConflict(error)) setConflict(true);
      else setMessage(ko ? '기준을 저장하지 못했습니다. 입력 값과 사유를 확인해 주세요.' : '无法保存标准，请检查输入值和原因。');
    } finally { setBusy(false); }
  }
  return <form className="hr-panel hr-labor-rules-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="hr-section-heading"><h2>{ko ? '인건비 기준' : '人工成本标准'}</h2><span>{saved.month} · v{saved.version}</span></div>
    <p className="hr-muted">{ko ? '적용 시작 월' : '生效起始月份'}: {saved.month}{ko ? '부터 다음 기준 전까지' : '起至下一标准生效前'}</p>
    {saved.version === 0 && <p className="hr-alert is-warning" role="status">{saved.source_month ? (ko ? `${saved.source_month} 기준 v${saved.source_version}을 복사한 미저장 초안입니다.` : `由 ${saved.source_month} 标准 v${saved.source_version} 复制的未保存草稿。`) : (ko ? '사용자 결정 기본값입니다. 아직 저장되지 않았습니다.' : '以下为用户决定的默认值，尚未保存。')}</p>}
    {saved.periods.length > 0 && <p className="hr-muted">{ko ? '저장된 시작 월' : '已保存的生效月份'}: {saved.periods.map((period) => period.month).join(' · ')}</p>}
    {pending.length > 0 && <details className="hr-labor-pending"><summary>{ko ? '미입력 · 미확정' : '未填写 · 未确认'} {pending.length}{ko ? '항목' : '项'}</summary><ul>{pending.map((item) => <li key={item}>{item}</li>)}</ul></details>}
    <fieldset disabled={busy} className="hr-labor-fieldset">
      <legend>{ko ? '할증과 계약직 시간당 기준액' : '加成与合同工每小时基数'}</legend>
      <div className="hr-labor-fields">{(['workday', 'rest_day', 'public_holiday'] as const).map((type) => <label className="hr-field" key={type}>{laborDayLabel(type, ko)} {ko ? '배수' : '倍数'}<input type="number" min="0" step="any" required value={draft.multipliers[type]} onChange={(event) => setDraft({ ...draft, multipliers: { ...draft.multipliers, [type]: event.target.value } })} /></label>)}</div>
      <p className="hr-muted">{ko ? '계약직 시간당 기준액 = 基本工资 ÷ 월 환산 일수 ÷ 하루 기준 시간' : '合同工每小时基数 = 基本工资 ÷ 月折算天数 ÷ 日标准时数'}</p>
      <div className="hr-labor-fields"><label className="hr-field">{ko ? '월 환산 일수' : '月折算天数'}<input type="number" min="0.01" step="any" required value={draft.contract.days_per_month} onChange={(event) => setDraft({ ...draft, contract: { ...draft.contract, days_per_month: event.target.value } })} /></label><label className="hr-field">{ko ? '하루 기준 시간' : '日标准时数'}<input type="number" min="0.01" step="any" required value={draft.contract.hours_per_day} onChange={(event) => setDraft({ ...draft, contract: { ...draft.contract, hours_per_day: event.target.value } })} /></label></div>
    </fieldset>
    <fieldset disabled={busy} className="hr-labor-fieldset"><legend>{ko ? '부서별 평일 기본 야근 시간' : '部门平日默认加班时数'}</legend>
      <div className="hr-table-scroll"><table className="hr-labor-departments"><thead><tr><th>{ko ? '급여 원본 부서 라벨' : '工资表部门原始标签'}</th><th>{ko ? '시간 / 일' : '小时 / 日'}</th><th>{ko ? '편집' : '编辑'}</th></tr></thead><tbody>{departments.map((row, index) => <tr key={index}><td><input aria-label={`${ko ? '부서 원본 라벨' : '部门原始标签'} ${index + 1}`} maxLength={100} value={row.name} onChange={(event) => setDepartments(departments.map((item, current) => current === index ? { ...item, name: event.target.value } : item))} /></td><td><input className={row.hours === null ? 'is-pending' : ''} aria-label={`${row.name || index + 1} ${ko ? '기본 야근 시간' : '默认加班时数'}`} type="number" min="0" max="24" step="any" value={row.hours ?? ''} placeholder={ko ? '미입력' : '未填写'} onChange={(event) => setDepartments(departments.map((item, current) => current === index ? { ...item, hours: event.target.value || null } : item))} /><Pending value={row.hours === null} ko={ko} /></td><td><button className="hr-button" type="button" aria-label={`${row.name || index + 1} ${ko ? '기준 제거' : '移除标准'}`} onClick={() => setDepartments(departments.filter((_, current) => current !== index))}>{ko ? '제거' : '移除'}</button></td></tr>)}</tbody></table></div>
      <button type="button" className="hr-button" onClick={() => setDepartments([...departments, { name: '', hours: null }])}>{ko ? '부서 추가' : '添加部门'}</button>
      {invalidDepartments && <p className="hr-labor-pending-label" role="alert">{ko ? '부서 라벨을 빈칸이나 중복 없이 입력하세요.' : '部门标签不能为空或重复。'}</p>}
    </fieldset>
    <fieldset disabled={busy} className="hr-labor-fieldset"><legend>{ko ? '지급 규칙' : '支付规则'}</legend>
      <div className="hr-labor-fields"><label className="hr-field">{ko ? '시급직 할증' : '小时工加成'}<select aria-label={ko ? '시급직 할증' : '小时工加成'} value={draft.hourly_premium.enabled ? 'yes' : 'no'} onChange={(event) => setDraft({ ...draft, hourly_premium: { ...draft.hourly_premium, enabled: event.target.value === 'yes' } })}><option value="no">{ko ? '미적용' : '不适用'}</option><option value="yes">{ko ? '적용' : '适用'}</option></select></label><label className="hr-checkbox"><input type="checkbox" checked={draft.hourly_premium.confirmed} onChange={(event) => setDraft({ ...draft, hourly_premium: { ...draft.hourly_premium, confirmed: event.target.checked } })} />{ko ? '시급직 할증 규칙 확정' : '确认小时工加成规则'} <Confirmation confirmed={draft.hourly_premium.confirmed} ko={ko} /></label></div>
      <label className="hr-field">{ko ? '평일 연장수당 제외 직무 (한 줄에 하나)' : '平日加班费除外职务（每行一项）'}<textarea rows={3} value={titles} placeholder={ko ? '급여 원본의 직무 라벨' : '工资表职务原始标签'} onChange={(event) => setTitles(event.target.value)} /></label>
      <label className="hr-checkbox"><input type="checkbox" checked={rules.weekday_excluded_titles.titles.includes('工程师')} onChange={(event) => setTitles(event.target.checked ? [...rules.weekday_excluded_titles.titles, '工程师'].join('\n') : rules.weekday_excluded_titles.titles.filter((title) => title !== '工程师').join('\n'))} />{ko ? '工程师도 평일 실적 야근 제외' : '工程师也不计平日实际加班费'}</label>
      <label className="hr-checkbox"><input type="checkbox" checked={draft.weekday_excluded_titles.confirmed} onChange={(event) => setDraft({ ...draft, weekday_excluded_titles: { ...draft.weekday_excluded_titles, confirmed: event.target.checked } })} />{ko ? '제외 직무 목록 확정' : '确认除外职务列表'} <Confirmation confirmed={draft.weekday_excluded_titles.confirmed} ko={ko} /></label>
      <p className="hr-muted">{ko ? '확정(사용자 2026-11-12): Part長·部长·财务部长兼办公室主任·技术生产总经理는 모든 부서에 적용합니다. 휴일·법정 공휴일 수당은 유지합니다.' : '用户于2026-11-12确认：Part長、部长、财务部长兼办公室主任、技术生产总经理适用于所有部门，仍计休息日及法定节假日津贴。'}</p>
      <label className="hr-field">{ko ? '부서 기본 야근 시간이 固定平时加班을 포함하는가' : '部门默认加班时数是否包含固定平时加班'}<select aria-label={ko ? '고정 연장수당 포함 여부' : '是否包含固定平时加班'} className={draft.department_hours_include_fixed_overtime === null ? 'is-pending' : ''} value={draft.department_hours_include_fixed_overtime === null ? '' : draft.department_hours_include_fixed_overtime ? 'yes' : 'no'} onChange={(event) => setDraft({ ...draft, department_hours_include_fixed_overtime: event.target.value === '' ? null : event.target.value === 'yes' })}><option value="">{ko ? '미확정' : '未确认'}</option><option value="yes">{ko ? '예' : '是'}</option><option value="no">{ko ? '아니오 (확정)' : '否（已确认）'}</option></select></label><p className="hr-muted">{ko ? '부서 시간은 실적 야근만 뜻합니다. 고정 연장수당은 월 고정액으로 최근 급여 월의 값을 별도로 이어받습니다.' : '部门时数仅指实际加班。固定平时加班按月固定额单列，沿用最近工资月份的金额。'}</p>
    </fieldset>
    <fieldset disabled={busy} className="hr-labor-fieldset hr-hourly-rates"><legend>{ko ? '시급 단가' : '时薪单价'}</legend>
      <div className="hr-labor-fields"><label className="hr-field">{ko ? '회사 기본 시급 (CNY)' : '公司默认时薪 (CNY)'}<input type="number" min="0" step="any" value={draft.hourly_rates.company_default.amount ?? ''} onChange={(event) => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, company_default: { ...draft.hourly_rates.company_default, amount: event.target.value || null } } })} /></label><label className="hr-checkbox"><input type="checkbox" checked={draft.hourly_rates.company_default.confirmed} onChange={(event) => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, company_default: { ...draft.hourly_rates.company_default, confirmed: event.target.checked } } })} />{ko ? '회사 기본 시급 확정' : '确认公司默认时薪'}</label></div>
      {(draft.hourly_rates.company_default.amount === null || !draft.hourly_rates.company_default.confirmed) && <p className="hr-labor-pending-label">{draft.hourly_rates.company_default.amount === null ? (ko ? '회사 기본 시급 미입력' : '公司默认时薪未填写') : draft.hourly_rates.company_default.amount === '24.50' ? (ko ? '합성 기본값 · 미확정: 인사팀이 단가를 확인하세요.' : '合成默认值 · 未确认：请人事部门核实时薪。') : (ko ? '미확정: 인사팀이 단가를 확인하세요.' : '未确认：请人事部门核实时薪。')}</p>}
      <p className="hr-muted">{ko ? '적용 순서: 해당 직원의 유효한 예외 → 회사 기본. 기본 근무는 1배, 야근은 날짜별 배수를 적용합니다.' : '适用顺序：员工有效例外 → 公司默认。基本工作按1倍，加班按日期类型加成。'}</p>
      {rosterError && <p role="alert" className="hr-alert is-error">{ko ? '명부를 불러오지 못했습니다.' : '无法加载员工名册。'}<button type="button" className="hr-button" onClick={retryRoster}>{ko ? '명부 다시 시도' : '重试员工名册'}</button></p>}
      {draft.hourly_rates.employee_overrides.map((item, index) => <div className="hr-hourly-override" key={index}>
        <label className="hr-field">{ko ? '명부 직원' : '名册员工'}<select aria-label={`${ko ? '시급 예외 직원' : '时薪例外员工'} ${index + 1}`} disabled={rosterLoading || rosterError} value={item.employee_id || ''} onChange={(event) => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, employee_overrides: draft.hourly_rates.employee_overrides.map((entry, current) => current === index ? { ...entry, employee_id: Number(event.target.value) } : entry) } })}><option value="">{rosterLoading ? (ko ? '불러오는 중' : '加载中') : (ko ? '직원 선택' : '选择员工')}</option>{roster.map((person) => <option key={person.id} value={person.id}>{person.code} · {person.name}</option>)}</select></label>
        <label className="hr-field">{ko ? '적용 시작 월' : '生效起始月份'}<input aria-label={`${ko ? '시급 예외 시작 월' : '时薪例外起始月份'} ${index + 1}`} placeholder="YYYY-MM" maxLength={7} value={item.effective_month} onChange={(event) => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, employee_overrides: draft.hourly_rates.employee_overrides.map((entry, current) => current === index ? { ...entry, effective_month: event.target.value } : entry) } })} /></label>
        <label className="hr-field">{ko ? '시급 (CNY)' : '时薪 (CNY)'}<input aria-label={`${ko ? '시급 예외 금액' : '时薪例外金额'} ${index + 1}`} type="number" min="0" step="any" value={item.amount} onChange={(event) => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, employee_overrides: draft.hourly_rates.employee_overrides.map((entry, current) => current === index ? { ...entry, amount: event.target.value } : entry) } })} /></label>
        <label className="hr-field">{ko ? '예외 사유' : '例外原因'}<input aria-label={`${ko ? '시급 예외 사유' : '时薪例外原因'} ${index + 1}`} maxLength={500} value={item.reason} onChange={(event) => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, employee_overrides: draft.hourly_rates.employee_overrides.map((entry, current) => current === index ? { ...entry, reason: event.target.value } : entry) } })} /></label>
        <button type="button" className="hr-button" aria-label={`${ko ? '시급 예외 제거' : '移除时薪例外'} ${index + 1}`} onClick={() => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, employee_overrides: draft.hourly_rates.employee_overrides.filter((_, current) => current !== index) } })}>{ko ? '제거' : '移除'}</button>
      </div>)}
      <button type="button" className="hr-button" disabled={rosterLoading || rosterError} onClick={() => setDraft({ ...draft, hourly_rates: { ...draft.hourly_rates, employee_overrides: [...draft.hourly_rates.employee_overrides, { employee_id: 0, effective_month: saved.month, amount: '', reason: '' }] } })}>{ko ? '직원 시급 예외 추가' : '添加员工时薪例外'}</button>
      {invalidOverrides && <p role="alert" className="hr-labor-pending-label">{ko ? '직원·시작 월·시급·사유를 입력하고 같은 직원과 월의 중복을 확인하세요.' : '请填写员工、起始月份、时薪及原因，且同一员工与月份不可重复。'}</p>}
    </fieldset>
    <fieldset disabled={busy} className="hr-labor-fieldset"><legend>{ko ? '사회보험 · 공적금 요율 (추정 계산용)' : '社会保险 · 公积金费率（用于估算）'}</legend>
      <p className="hr-muted">{ko ? '요율로 계산한 금액은 추정입니다. 청구서의 실제 회사 납부액은 별도로 입력합니다.' : '按费率计算的金额为估算值，账单实际公司缴费金额请单独填写。'}</p>
      {(['social_insurance', 'housing_fund'] as const).map((fund) => <LaborContributionEditor key={fund} fund={fund} value={draft.contributions[fund]} ko={ko} roster={roster} rosterDisabled={rosterLoading || rosterError} onChange={(value) => setDraft({ ...draft, contributions: { ...draft.contributions, [fund]: value } })} />)}
    </fieldset>
    <SaveFeedback conflict={conflict} message={message} ko={ko} restart={restart} />
    <div className="hr-labor-save"><label className="hr-field">{ko ? '기준 변경 사유' : '标准变更原因'}<input maxLength={500} required disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="hr-button is-primary" disabled={busy || conflict || !reason.trim() || invalidDepartments || invalidOverrides || (!dirty && saved.version > 0)}>{busy ? (ko ? '저장 중…' : '正在保存…') : (ko ? '기준 저장' : '保存标准')}</button></div>
    <LaborHistory history={saved.history} ko={ko} roster={roster} />
  </form>;
}

export function LaborCalendarForm({ initial, ko, onActivity, restart }: FormProps<HrLaborCalendar>) {
  const [saved, setSaved] = useState(initial); const [days, setDays] = useState(() => ({ ...initial.days }));
  const [selected, setSelected] = useState(`${initial.month}-01`);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false); const [message, setMessage] = useState('');
  const dirty = JSON.stringify(Object.entries(days).sort()) !== JSON.stringify(Object.entries(saved.days).sort());
  const dates = laborCalendarDates(initial.month);
  const offset = new Date(`${initial.month}-01T12:00:00Z`).getUTCDay();
  useEffect(() => { onActivity({ dirty, busy }); return () => onActivity({ dirty: false, busy: false }); }, [dirty, busy, onActivity]);
  async function save() {
    if (busy || conflict || !reason.trim() || (!dirty && saved.version > 0)) return;
    setBusy(true); setMessage('');
    try {
      const result = await saveHrLaborCalendar(saved.month, { version: saved.version, reason: reason.trim(), days });
      setSaved(result); setDays({ ...result.days }); setReason('');
    } catch (error) {
      if (isHrConflict(error)) setConflict(true);
      else setMessage(ko ? '달력을 저장하지 못했습니다. 날짜 유형과 사유를 확인해 주세요.' : '无法保存日历，请检查日期类型和原因。');
    } finally { setBusy(false); }
  }
  return <form className="hr-panel hr-labor-calendar-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="hr-section-heading"><h2>{ko ? '근무 달력' : '工作日历'}</h2><span>{saved.month} · v{saved.version}</span></div>
    <p className="hr-muted">{ko ? '기본: 토·일 휴일, 월~금 근무일. 법정 공휴일과 조정 근무일은 직접 지정합니다.' : '默认周六、周日为休息日，周一至周五为工作日。法定节假日与调休工作日请手动指定。'}</p>
    <fieldset disabled={busy} className="hr-labor-fieldset hr-labor-calendar-fieldset"><legend className="sr-only">{ko ? '날짜 유형 편집' : '编辑日期类型'}</legend>
      <div className="hr-labor-calendar-scroll"><div className="hr-labor-calendar-grid">
        {(ko ? ['일', '월', '화', '수', '목', '금', '토'] : ['日', '一', '二', '三', '四', '五', '六']).map((day) => <span className="hr-labor-weekday" key={day}>{day}</span>)}
        {Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
        {dates.map((date) => {
          const type = days[date] ?? laborDefaultDay(date);
          const text = ({ workday: ko ? '근무' : '工作', rest_day: ko ? '휴일' : '休息', public_holiday: ko ? '공휴' : '法假', adjusted_workday: ko ? '조정' : '调班' })[type];
          return <button type="button" key={date} data-date={date} data-day-type={type} data-override={Boolean(days[date])} className={`hr-labor-day ${type === 'rest_day' || type === 'public_holiday' ? 'is-rest' : ''}`} aria-label={`${date} ${laborDayLabel(type, ko)}`} aria-pressed={selected === date} onClick={() => setSelected(date)}><strong>{Number(date.slice(-2))}</strong><span>{text}{days[date] ? ' ·' : ''}</span></button>;
        })}
      </div></div>
      <div className="hr-labor-date-editor"><strong>{selected}</strong><label className="hr-field">{ko ? '선택 날짜 유형' : '所选日期类型'}<select aria-label={ko ? '선택 날짜 유형' : '所选日期类型'} value={days[selected] ?? ''} onChange={(event) => {
        const next = { ...days }; if (event.target.value) next[selected] = event.target.value as HrLaborDayType; else delete next[selected]; setDays(next);
      }}><option value="">{ko ? '요일 기본값' : '按星期默认'} ({laborDayLabel(laborDefaultDay(selected), ko)})</option>{(['workday', 'rest_day', 'public_holiday', 'adjusted_workday'] as const).map((type) => <option key={type} value={type}>{laborDayLabel(type, ko)}</option>)}</select></label></div>
    </fieldset>
    <SaveFeedback conflict={conflict} message={message} ko={ko} restart={restart} />
    <div className="hr-labor-save"><label className="hr-field">{ko ? '달력 변경 사유' : '日历变更原因'}<input maxLength={500} required disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="hr-button is-primary" disabled={busy || conflict || !reason.trim() || (!dirty && saved.version > 0)}>{busy ? (ko ? '저장 중…' : '正在保存…') : (ko ? '달력 저장' : '保存日历')}</button></div>
    <LaborHistory history={saved.history} ko={ko} />
  </form>;
}

export function LaborStandardsOverview({ standards, ko, roster }: { standards: HrLaborStandards; ko: boolean; roster: HrRosterEntry[] }) {
  const latest = new Map<number, HrLaborRules['hourly_rates']['employee_overrides'][number]>();
  for (const item of standards.rules.hourly_rates.employee_overrides) if (item.effective_month <= standards.month && (!latest.has(item.employee_id) || latest.get(item.employee_id)!.effective_month < item.effective_month)) latest.set(item.employee_id, item);
  const rows = laborSummaryRows(standards.rules, standards.source_month, ko);
  for (const item of latest.values()) {
    const person = roster.find((entry) => entry.id === item.employee_id);
    rows.push({ id: `employee-${item.employee_id}`, label: `${ko ? '시급 예외' : '时薪例外'} · ${person ? `${person.code} ${person.name}` : `#${item.employee_id}`}`, value: `${item.amount} CNY`, status: 'confirmed', month: item.effective_month });
  }
  return <section className="hr-panel hr-labor-overview"><div className="hr-section-heading"><h2>{ko ? '현재 단가·요율 한눈에 보기' : '当前单价与费率一览'}</h2><span>{standards.month}</span></div><p className="hr-muted">{ko ? '저장된 기준과 기본값입니다. 아래의 미저장 편집은 저장 후 반영됩니다. 요율에 따른 금액은 추정이며 실제 납부액과 구분합니다.' : '此处显示已保存标准与默认值，下方草稿将在保存后更新。按费率计算的金额为估算，与实际缴费金额区分。'}</p><div className="hr-table-scroll"><table><thead><tr>{(ko ? ['항목', '현재 값', '상태', '적용 시작 월'] : ['项目', '当前值', '状态', '生效起始月份']).map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id} data-summary-id={row.id}><th scope="row">{row.label}</th><td>{row.value}</td><td><span className={row.status === 'confirmed' ? '' : 'hr-labor-pending-label'}>{row.status === 'confirmed' ? (ko ? '확정' : '已确认') : row.status === 'unconfirmed' ? (ko ? '미확정' : '未确认') : (ko ? '미입력' : '未填写')}</span></td><td>{row.month ?? (ko ? '미저장' : '未保存')}</td></tr>)}</tbody></table></div></section>;
}

export function LaborActualPaymentsForm({ initial, ko, onActivity, restart }: FormProps<HrLaborActualPayments>) {
  const [saved, setSaved] = useState(initial); const [amounts, setAmounts] = useState(() => copy(initial.amounts));
  const [memo, setMemo] = useState(initial.evidence_memo); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false); const [message, setMessage] = useState('');
  const dirty = JSON.stringify(amounts) !== JSON.stringify(saved.amounts) || memo !== saved.evidence_memo;
  const issue = actualPaymentIssue(amounts); const hasAmount = Object.values(amounts).some((fund) => Object.values(fund).some((value) => value !== null));
  const missingMemo = hasAmount && !memo.trim();
  useEffect(() => { onActivity({ dirty, busy }); return () => onActivity({ dirty: false, busy: false }); }, [dirty, busy, onActivity]);
  async function save() {
    if (busy || conflict || !reason.trim() || issue || missingMemo || (!dirty && saved.version > 0)) return;
    setBusy(true); setMessage('');
    try {
      const result = await saveHrLaborActualPayments(saved.month, { version: saved.version, reason: reason.trim(), amounts, evidence_memo: memo.trim() });
      setSaved(result); setAmounts(copy(result.amounts)); setMemo(result.evidence_memo); setReason('');
    } catch (error) {
      if (isHrConflict(error)) setConflict(true);
      else setMessage(ko ? '실제 납부액을 저장하지 못했습니다. 금액과 근거를 확인해 주세요.' : '无法保存实际缴费金额，请检查金额与依据。');
    } finally { setBusy(false); }
  }
  return <form className="hr-panel hr-labor-actual-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}><div className="hr-section-heading"><h2>{ko ? '월 실제 회사 부담 납부액' : '每月实际公司缴费金额'}</h2><span>{saved.month} · v{saved.version} · {ko ? '실제' : '实际'}</span></div>
    <p className="hr-muted">{ko ? '사회보험·공적금 청구서의 회사 부담 총액을 입력하세요. 직원 공제액과 요율에 따른 추정액은 포함하지 않습니다.' : '请填写社会保险与公积金账单中的公司承担总额，不含员工扣款及按费率估算的金额。'}</p>
    <fieldset disabled={busy} className="hr-labor-fieldset"><legend>{ko ? '실제 납부액 (CNY)' : '实际缴费金额 (CNY)'}</legend>{(['social_insurance', 'housing_fund'] as const).map((fund) => <div className="hr-labor-contribution" key={fund}><h3>{laborContributionLabel(fund, ko)}</h3><div className="hr-labor-fields">{(['total', 'contract', 'hourly'] as const).map((part) => {
      const label = part === 'total' ? (ko ? '회사 부담 총액' : '公司承担总额') : part === 'contract' ? (ko ? '계약직 (선택)' : '合同工（可选）') : (ko ? '시급직 (선택)' : '小时工（可选）');
      return <label className="hr-field" key={part}>{label}<input aria-label={`${laborContributionLabel(fund, ko)} ${label}`} type="number" min="0" step="0.01" className={part === 'total' && amounts[fund][part] === null ? 'is-pending' : ''} value={amounts[fund][part] ?? ''} placeholder={ko ? '미입력' : '未填写'} onChange={(event) => setAmounts({ ...amounts, [fund]: { ...amounts[fund], [part]: event.target.value || null } })} /><Pending value={part === 'total' && amounts[fund][part] === null} ko={ko} /></label>;
    })}</div></div>)}<p className="hr-muted">{ko ? '계약직·시급직 금액을 모두 입력하고 총액을 비우면 저장 시 서버가 합산합니다. 일부만 나누어 입력하면 총액도 입력하세요.' : '若填写合同工与小时工两项且总额留空，保存时由服务器合计。仅填写部分明细时须同时填写总额。'}</p><label className="hr-field">{ko ? '납부 근거 메모' : '缴费依据备注'}<textarea rows={2} maxLength={1000} value={memo} placeholder={ko ? '청구서 번호 또는 파일명' : '账单编号或文件名'} onChange={(event) => setMemo(event.target.value)} /></label></fieldset>
    {issue && <p className="hr-alert is-warning" role="alert">{issue === 'invalid_amount' ? (ko ? '금액은 0 이상, 소수 두 자리까지 입력하세요.' : '金额须为非负数，最多两位小数。') : issue === 'total_required' ? (ko ? '고용형태별 금액을 일부만 입력할 때는 총액이 필요합니다.' : '仅填写部分用工类型明细时必须填写总额。') : (ko ? '두 고용형태의 합계는 총액과 같아야 하며, 일부 내역도 총액을 넘을 수 없습니다.' : '两类用工金额之和须等于总额，部分明细也不得超过总额。')}</p>}
    {missingMemo && <p className="hr-labor-pending-label">{ko ? '실제 금액의 납부 근거 메모가 필요합니다.' : '填写实际金额时必须提供缴费依据备注。'}</p>}
    <SaveFeedback conflict={conflict} message={message} ko={ko} restart={restart} />
    <div className="hr-labor-save"><label className="hr-field">{ko ? '실제 납부액 변경 사유' : '实际缴费金额变更原因'}<input maxLength={500} required disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="hr-button is-primary" disabled={busy || conflict || !reason.trim() || Boolean(issue) || missingMemo || (!dirty && saved.version > 0)}>{busy ? (ko ? '저장 중…' : '正在保存…') : (ko ? '실제 납부액 저장' : '保存实际缴费金额')}</button></div><LaborHistory history={saved.history} ko={ko} />
  </form>;
}

export default function LaborStandardsPage() {
  const { user } = useAuth(); const allowed = canAccessHr(user);
  const { lang } = useLang(); const ko = lang === 'ko';
  const [month, setMonth] = useState(currentHrMonth);
  const identity = String(user?.id ?? '');
  const standards = useLaborResource(month, identity, allowed, getHrLaborStandards);
  const calendar = useLaborResource(month, identity, allowed, getHrLaborCalendar);
  const actual = useLaborResource(month, identity, allowed, getHrLaborActualPayments);
  const roster = useLaborResource(month, identity, allowed, getHrRoster);
  const [rulesActivity, setRulesActivity] = useState<FormActivity>({ dirty: false, busy: false });
  const [calendarActivity, setCalendarActivity] = useState<FormActivity>({ dirty: false, busy: false });
  const [actualActivity, setActualActivity] = useState<FormActivity>({ dirty: false, busy: false });
  const dirty = rulesActivity.dirty || calendarActivity.dirty || actualActivity.dirty; const busy = rulesActivity.busy || calendarActivity.busy || actualActivity.busy;
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLink = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === '_blank' || target.hasAttribute('download') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || target.href === window.location.href) return;
      if (busy || !window.confirm(ko ? '저장하지 않은 기준·달력·실제 납부액 변경을 버리고 이동할까요?' : '放弃未保存的标准、日历或实际缴费更改并离开吗？')) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', onLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onLink, true); };
  }, [dirty, busy, ko]);
  function changeMonth(next: string) {
    if (busy || next === month) return;
    if (dirty && !window.confirm(ko ? '저장하지 않은 기준·달력·실제 납부액 변경을 버리고 적용 월을 바꿀까요?' : '放弃未保存的标准、日历或实际缴费更改并切换月份吗？')) return;
    setRulesActivity({ dirty: false, busy: false }); setCalendarActivity({ dirty: false, busy: false }); setActualActivity({ dirty: false, busy: false }); setMonth(next);
  }
  if (!allowed) return <main className="hr-page"><HrLoadState allowed={false} loading={false} error="" retry={() => {}} /></main>;
  return <HrShell page="labor-standards" month={month} onMonthChange={changeMonth} monthDisabled={busy} monthLabel={ko ? '적용 시작 월' : '生效起始月份'}>
    {standards.value && <LaborStandardsOverview standards={standards.value} ko={ko} roster={roster.value ?? []} />}
    <div className="hr-labor-standards">
      {standards.value ? <LaborRulesForm key={`rules:${identity}:${month}`} initial={standards.value} ko={ko} onActivity={setRulesActivity} restart={standards.restart} onSaved={standards.update} roster={roster.value ?? []} rosterLoading={!roster.value && !roster.error} rosterError={roster.error} retryRoster={roster.restart} /> : <HrLoadState allowed={allowed} loading={!standards.error} error={ko ? '인건비 기준을 불러오지 못했습니다.' : '无法加载人工成本标准。'} retry={standards.restart} />}
      <div className="hr-labor-side-column">{calendar.value ? <LaborCalendarForm key={`calendar:${identity}:${month}`} initial={calendar.value} ko={ko} onActivity={setCalendarActivity} restart={calendar.restart} /> : <HrLoadState allowed={allowed} loading={!calendar.error} error={ko ? '근무 달력을 불러오지 못했습니다.' : '无法加载工作日历。'} retry={calendar.restart} />}
      {actual.value ? <LaborActualPaymentsForm key={`actual:${identity}:${month}`} initial={actual.value} ko={ko} onActivity={setActualActivity} restart={actual.restart} /> : <HrLoadState allowed={allowed} loading={!actual.error} error={ko ? '실제 납부액을 불러오지 못했습니다.' : '无法加载实际缴费金额。'} retry={actual.restart} />}
      </div>
    </div>
  </HrShell>;
}
