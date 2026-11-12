import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessHr } from '../../domains/auth/hr-access';
import { useLang } from '../../i18n';
import { getHrLaborCalendar, getHrLaborStandards, saveHrLaborCalendar, saveHrLaborStandards } from '../../domains/hr/labor-standards-api';
import { laborCalendarDates, laborDayLabel, laborDefaultDay, laborHistoryChanges, pendingLaborItems } from '../../domains/hr/labor-standards';
import type { HrEmployerContribution, HrLaborCalendar, HrLaborDayType, HrLaborHistory, HrLaborRules, HrLaborStandards } from '../../domains/hr/labor-standards';
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
    restart: () => { setResult(null); setReload((value) => value + 1); } };
}

function Pending({ value, ko }: { value: boolean; ko: boolean }) {
  return value ? <span className="hr-labor-pending-label">{ko ? '미입력' : '未填写'}</span> : null;
}
function Confirmation({ confirmed, ko }: { confirmed: boolean; ko: boolean }) {
  return <span className={confirmed ? 'hr-muted' : 'hr-labor-pending-label'}>{confirmed ? (ko ? '확정' : '已确认') : (ko ? '미확정' : '未确认')}</span>;
}
function LaborHistory({ history, ko }: { history: HrLaborHistory[]; ko: boolean }) {
  const labels: Record<string, string> = {
    multipliers: ko ? '할증 배수' : '加成倍数', contract: ko ? '계약직' : '合同工', hourly: ko ? '시급직' : '小时工',
    workday: ko ? '평일' : '平日', rest_day: ko ? '휴일' : '休息日', public_holiday: ko ? '법정 공휴일' : '法定节假日',
    days_per_month: ko ? '월 환산 일수' : '月折算天数', hours_per_day: ko ? '하루 기준 시간' : '日标准时数',
    hourly_premium: ko ? '시급직 할증' : '小时工加成', enabled: ko ? '적용 여부' : '是否适用', confirmed: ko ? '확정 여부' : '是否确认',
    department_overtime: ko ? '부서별 야근 시간' : '部门加班时数', weekday_excluded_titles: ko ? '제외 직무' : '除外职务', titles: ko ? '직무 목록' : '职务列表',
    department_hours_include_fixed_overtime: ko ? '고정 연장수당 포함' : '包含固定平时加班', employer_contributions: ko ? '회사 부담' : '公司承担',
    social_insurance: ko ? '사회보험' : '社会保险', housing_fund: ko ? '공적금' : '公积金', rate_percent: ko ? '요율 (%)' : '费率 (%)', base: ko ? '기준액' : '基数', fixed_amount: ko ? '고정 기준액' : '固定基数',
  };
  function display(value: unknown, path: string): string {
    if ((value === null || value === undefined) && /^\d{4}-\d{2}-\d{2}$/.test(path)) {
      return `${ko ? '요일 기본값' : '按星期默认'} (${laborDayLabel(laborDefaultDay(path), ko)})`;
    }
    if (value === null || value === undefined) return ko ? '미입력' : '未填写';
    if (typeof value === 'boolean') return value ? (ko ? '예' : '是') : (ko ? '아니오' : '否');
    if (Array.isArray(value)) return value.length ? value.join(', ') : (ko ? '없음' : '无');
    if (value === 'gross') return ko ? '응발액' : '应发工资';
    if (value === 'fixed') return ko ? '고정 기준액' : '固定基数';
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

export function LaborRulesForm({ initial, ko, onActivity, restart }: FormProps<HrLaborStandards>) {
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
  function contribution(fund: 'social_insurance' | 'housing_fund', type: 'contract' | 'hourly', change: Partial<HrEmployerContribution>) {
    setDraft({ ...draft, employer_contributions: { ...draft.employer_contributions, [fund]: { ...draft.employer_contributions[fund], [type]: { ...draft.employer_contributions[fund][type], ...change } } } });
  }
  async function save() {
    if (busy || conflict || !reason.trim() || invalidDepartments || (!dirty && saved.version > 0)) return;
    setBusy(true); setMessage('');
    try {
      const result = await saveHrLaborStandards(saved.month, { version: saved.version, reason: reason.trim(), rules });
      setSaved(result); setDraft(copy(result.rules)); setDepartments(Object.entries(result.rules.department_overtime).map(([name, hours]) => ({ name, hours }))); setTitles(result.rules.weekday_excluded_titles.titles.join('\n')); setReason('');
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
    <fieldset disabled={busy} className="hr-labor-fieldset"><legend>{ko ? '확인할 지급 규칙' : '待确认的支付规则'}</legend>
      <div className="hr-labor-fields"><label className="hr-field">{ko ? '시급직 할증' : '小时工加成'}<select aria-label={ko ? '시급직 할증' : '小时工加成'} value={draft.hourly_premium.enabled ? 'yes' : 'no'} onChange={(event) => setDraft({ ...draft, hourly_premium: { ...draft.hourly_premium, enabled: event.target.value === 'yes' } })}><option value="no">{ko ? '미적용' : '不适用'}</option><option value="yes">{ko ? '적용' : '适用'}</option></select></label><label className="hr-checkbox"><input type="checkbox" checked={draft.hourly_premium.confirmed} onChange={(event) => setDraft({ ...draft, hourly_premium: { ...draft.hourly_premium, confirmed: event.target.checked } })} />{ko ? '시급직 할증 규칙 확정' : '确认小时工加成规则'} <Confirmation confirmed={draft.hourly_premium.confirmed} ko={ko} /></label></div>
      <label className="hr-field">{ko ? '평일 연장수당 제외 직무 (한 줄에 하나)' : '平日加班费除外职务（每行一项）'}<textarea rows={3} value={titles} placeholder={ko ? '급여 원본의 직무 라벨' : '工资表职务原始标签'} onChange={(event) => setTitles(event.target.value)} /></label>
      <label className="hr-checkbox"><input type="checkbox" checked={draft.weekday_excluded_titles.confirmed} onChange={(event) => setDraft({ ...draft, weekday_excluded_titles: { ...draft.weekday_excluded_titles, confirmed: event.target.checked } })} />{ko ? '제외 직무 목록 확정' : '确认除外职务列表'} <Confirmation confirmed={draft.weekday_excluded_titles.confirmed} ko={ko} /></label>
      <p className="hr-muted">{ko ? '제외 직무도 휴일·법정 공휴일 수당은 적용합니다.' : '除外职务仍适用休息日与法定节假日津贴。'}</p>
      <label className="hr-field">{ko ? '부서 기본 야근 시간이 固定平时加班을 포함하는가' : '部门默认加班时数是否包含固定平时加班'}<select aria-label={ko ? '고정 연장수당 포함 여부' : '是否包含固定平时加班'} className={draft.department_hours_include_fixed_overtime === null ? 'is-pending' : ''} value={draft.department_hours_include_fixed_overtime === null ? '' : draft.department_hours_include_fixed_overtime ? 'yes' : 'no'} onChange={(event) => setDraft({ ...draft, department_hours_include_fixed_overtime: event.target.value === '' ? null : event.target.value === 'yes' })}><option value="">{ko ? '미확정' : '未确认'}</option><option value="yes">{ko ? '예' : '是'}</option><option value="no">{ko ? '아니오' : '否'}</option></select></label>
    </fieldset>
    <fieldset disabled={busy} className="hr-labor-fieldset"><legend>{ko ? '회사 부담 사회보험 · 공적금' : '公司承担的社会保险 · 公积金'}</legend>
      <p className="hr-muted">{ko ? '직원 공제액과 별개로 회사 부담 요율을 입력합니다.' : '请填写公司承担费率，与员工扣款分开。'}</p>
      {(['social_insurance', 'housing_fund'] as const).map((fund) => <div key={fund} className="hr-labor-contribution"><h3>{fund === 'social_insurance' ? (ko ? '사회보험' : '社会保险') : (ko ? '공적금' : '公积金')}</h3>{(['contract', 'hourly'] as const).map((type) => {
        const item = draft.employer_contributions[fund][type]; const label = `${fund === 'social_insurance' ? (ko ? '사회보험' : '社会保险') : (ko ? '공적금' : '公积金')} ${type === 'contract' ? (ko ? '계약직' : '合同工') : (ko ? '시급직' : '小时工')}`;
        return <div key={type} className="hr-labor-fields"><strong>{type === 'contract' ? (ko ? '계약직' : '合同工') : (ko ? '시급직' : '小时工')}</strong><label className="hr-field">{ko ? '요율 (%)' : '费率 (%)'}<input aria-label={`${label} ${ko ? '요율' : '费率'}`} type="number" min="0" max="100" step="any" className={item.rate_percent === null ? 'is-pending' : ''} value={item.rate_percent ?? ''} placeholder={ko ? '미입력' : '未填写'} onChange={(event) => contribution(fund, type, { rate_percent: event.target.value || null })} /><Pending value={item.rate_percent === null} ko={ko} /></label><label className="hr-field">{ko ? '기준액 규칙' : '基数规则'}<select aria-label={`${label} ${ko ? '기준액 규칙' : '基数规则'}`} className={item.base === null ? 'is-pending' : ''} value={item.base ?? ''} onChange={(event) => contribution(fund, type, { base: (event.target.value || null) as HrEmployerContribution['base'], ...(event.target.value !== 'fixed' ? { fixed_amount: null } : {}) })}><option value="">{ko ? '미입력' : '未填写'}</option><option value="gross">{ko ? '응발액' : '应发工资'}</option><option value="fixed">{ko ? '고정 기준액' : '固定基数'}</option></select></label>{item.base === 'fixed' && <label className="hr-field">{ko ? '고정 기준액 (CNY)' : '固定基数 (CNY)'}<input aria-label={`${label} ${ko ? '고정 기준액' : '固定基数'}`} type="number" min="0" step="any" className={item.fixed_amount === null ? 'is-pending' : ''} value={item.fixed_amount ?? ''} placeholder={ko ? '미입력' : '未填写'} onChange={(event) => contribution(fund, type, { fixed_amount: event.target.value || null })} /><Pending value={item.fixed_amount === null} ko={ko} /></label>}</div>;
      })}</div>)}
    </fieldset>
    <SaveFeedback conflict={conflict} message={message} ko={ko} restart={restart} />
    <div className="hr-labor-save"><label className="hr-field">{ko ? '기준 변경 사유' : '标准变更原因'}<input maxLength={500} required disabled={busy} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="hr-button is-primary" disabled={busy || conflict || !reason.trim() || invalidDepartments || (!dirty && saved.version > 0)}>{busy ? (ko ? '저장 중…' : '正在保存…') : (ko ? '기준 저장' : '保存标准')}</button></div>
    <LaborHistory history={saved.history} ko={ko} />
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

export default function LaborStandardsPage() {
  const { user } = useAuth(); const allowed = canAccessHr(user);
  const { lang } = useLang(); const ko = lang === 'ko';
  const [month, setMonth] = useState(currentHrMonth);
  const identity = String(user?.id ?? '');
  const standards = useLaborResource(month, identity, allowed, getHrLaborStandards);
  const calendar = useLaborResource(month, identity, allowed, getHrLaborCalendar);
  const [rulesActivity, setRulesActivity] = useState<FormActivity>({ dirty: false, busy: false });
  const [calendarActivity, setCalendarActivity] = useState<FormActivity>({ dirty: false, busy: false });
  const dirty = rulesActivity.dirty || calendarActivity.dirty; const busy = rulesActivity.busy || calendarActivity.busy;
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLink = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === '_blank' || target.hasAttribute('download') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || target.href === window.location.href) return;
      if (busy || !window.confirm(ko ? '저장하지 않은 기준·달력 변경을 버리고 이동할까요?' : '放弃未保存的标准或日历更改并离开吗？')) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', onLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onLink, true); };
  }, [dirty, busy, ko]);
  function changeMonth(next: string) {
    if (busy || next === month) return;
    if (dirty && !window.confirm(ko ? '저장하지 않은 기준·달력 변경을 버리고 적용 월을 바꿀까요?' : '放弃未保存的标准或日历更改并切换月份吗？')) return;
    setRulesActivity({ dirty: false, busy: false }); setCalendarActivity({ dirty: false, busy: false }); setMonth(next);
  }
  if (!allowed) return <main className="hr-page"><HrLoadState allowed={false} loading={false} error="" retry={() => {}} /></main>;
  return <HrShell page="labor-standards" month={month} onMonthChange={changeMonth} monthDisabled={busy} monthLabel={ko ? '적용 시작 월' : '生效起始月份'}>
    <div className="hr-labor-standards">
      {standards.value ? <LaborRulesForm key={`rules:${identity}:${month}`} initial={standards.value} ko={ko} onActivity={setRulesActivity} restart={standards.restart} /> : <HrLoadState allowed={allowed} loading={!standards.error} error={ko ? '인건비 기준을 불러오지 못했습니다.' : '无法加载人工成本标准。'} retry={standards.restart} />}
      {calendar.value ? <LaborCalendarForm key={`calendar:${identity}:${month}`} initial={calendar.value} ko={ko} onActivity={setCalendarActivity} restart={calendar.restart} /> : <HrLoadState allowed={allowed} loading={!calendar.error} error={ko ? '근무 달력을 불러오지 못했습니다.' : '无法加载工作日历。'} retry={calendar.restart} />}
    </div>
  </HrShell>;
}
