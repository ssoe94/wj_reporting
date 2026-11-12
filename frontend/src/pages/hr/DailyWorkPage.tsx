import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { canAccessHr } from '../../domains/auth/hr-access';
import { useLang } from '../../i18n';
import { createHrDailyEvent, getHrDailyWork, previewHrDailyWork, saveHrDailyWork } from '../../domains/hr/daily-work-api';
import { copyPreviousDaily, dailyBulkDefaults, dailyBulkOff, dailyBulkOvertime, dailyDateOffset, dailyDraftKey, dailyLocalChanges, dailyOvertimeField, dailyRowsPayload, effectiveWork, initialDailyDate, overridesFromSheet, reapplyDailyChanges, setDailyWork, todayHrDate, WORK_HOUR_FIELDS } from '../../domains/hr/daily-work';
import type { HrAttendance, HrDailyEventInput, HrDailyRow, HrDailySheet, HrWork, HrWorkField, HrWorkOverrides } from '../../domains/hr/daily-work';
import { laborDayLabel } from '../../domains/hr/labor-standards';
import { currentHrMonth, HrLoadState, HrShell, isHrConflict } from './hrCommon';
import HrDailyEvents from './HrDailyEvents';

const dailyWorkLabel = (field: HrWorkField, ko: boolean) => ({ attendance: ko ? '출근 상태' : '出勤状态', regular_hours: ko ? '정규 시간' : '正常工时', weekday_hours: ko ? '평일 야근' : '平日加班', rest_hours: ko ? '휴일 근무' : '休息日工作', holiday_hours: ko ? '공휴일 근무' : '节假日工作', personal_leave_hours: ko ? '개인 휴가 시간' : '事假时数', sick_leave_hours: ko ? '병가 시간' : '病假时数' })[field];
const attendanceLabel = (value: HrAttendance, ko: boolean) => ({ present: ko ? '출근' : '出勤', absent: ko ? '결근' : '缺勤', personal_leave: ko ? '개인 휴가' : '事假', sick_leave: ko ? '병가' : '病假', off: ko ? '휴무' : '休息' })[value];
const statusLabel = (status: HrDailySheet['status'], ko: boolean) => status === 'confirmed' ? (ko ? '확정' : '已确认') : status === 'draft' ? (ko ? '입력 중' : '填写中') : (ko ? '기본값 추정' : '默认估算');
const money = (amount: string | null, ko: boolean) => amount === null ? (ko ? '일부 미입력' : '部分未填写') : new Intl.NumberFormat(ko ? 'ko-KR' : 'zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }).format(Number(amount)).replace('CN¥', '¥');
function nextField(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
  event.preventDefault();
  const area = event.currentTarget.closest('.hr-daily-table');
  const controls = Array.from(area?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([disabled]), select:not([disabled])') ?? []);
  const current = controls.indexOf(event.currentTarget as HTMLInputElement); const next = controls[current + (event.shiftKey ? -1 : 1)]; next?.focus(); if (next instanceof HTMLInputElement && next.type === 'number') next.select();
}
function dailyHourDisabled(sheet: HrDailySheet, row: HrDailyRow, work: HrWork, field: typeof WORK_HOUR_FIELDS[number]) {
  if (work.attendance === 'absent' || work.attendance === 'off') return true;
  if (field === 'personal_leave_hours') return work.attendance !== 'personal_leave';
  if (field === 'sick_leave_hours') return work.attendance !== 'sick_leave';
  if (field === 'regular_hours') return row.employee.employment_type !== 'hourly' || !['workday', 'adjusted_workday'].includes(sheet.day_type);
  return field !== dailyOvertimeField(sheet.day_type) || (field === 'weekday_hours' && row.estimate.basis.weekday_exempt === true);
}

export function DailySheetEditor({ initial, ko, onActivity, onSheet }: { initial: HrDailySheet; ko: boolean; onActivity: (value: { dirty: boolean; busy: boolean }) => void; onSheet: (value: HrDailySheet) => void }) {
  const [sheet, setSheet] = useState(initial); const [overrides, setOverrides] = useState<HrWorkOverrides>(() => overridesFromSheet(initial));
  const [preview, setPreview] = useState<{ key: string; sheet: HrDailySheet } | null>(null); const [previewError, setPreviewError] = useState(false);
  const [busy, setBusy] = useState(false); const [reason, setReason] = useState(''); const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<number[]>([]); const [hours, setHours] = useState(''); const [copying, setCopying] = useState(false);
  const [conflict, setConflict] = useState(false); const [latest, setLatest] = useState<HrDailySheet | null>(null); const [latestError, setLatestError] = useState(false); const [latestReload, setLatestReload] = useState(0);
  const [eventDraft, setEventDraft] = useState(false); const [previewReload, setPreviewReload] = useState(0);
  const alive = useRef(true); const generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  const key = dailyDraftKey(overrides); const baseline = dailyDraftKey(overridesFromSheet(sheet)); const dirty = key !== baseline;
  const displayed = dirty && preview?.key === key ? preview.sheet : sheet;
  const pending = dirty && preview?.key !== key;
  const disabled = !sheet.can_edit || busy || copying || conflict;
  useEffect(() => { onActivity({ dirty: dirty || eventDraft, busy: busy || copying }); return () => onActivity({ dirty: false, busy: false }); }, [dirty, eventDraft, busy, copying, onActivity]);
  useEffect(() => {
    const controller = new AbortController(); const request = ++generation.current; setPreviewError(false);
    if (!dirty || disabled) return () => controller.abort();
    const timer = window.setTimeout(() => {
      previewHrDailyWork(sheet.date, { version: sheet.version, context: sheet.context, rows: JSON.parse(key) }, controller.signal).then((value) => {
        if (!controller.signal.aborted && request === generation.current) setPreview({ key, sheet: value });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && request === generation.current) { setPreviewError(true); if (isHrConflict(error)) setConflict(true); }
      });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, dirty, disabled, sheet.date, sheet.version, sheet.context, previewReload]); // key serializes the complete override set
  useEffect(() => {
    if (!conflict) return;
    const controller = new AbortController(); setLatest(null); setLatestError(false);
    getHrDailyWork(sheet.date, controller.signal).then((value) => { if (!controller.signal.aborted) setLatest(value); }).catch(() => { if (!controller.signal.aborted) setLatestError(true); });
    return () => controller.abort();
  }, [conflict, sheet.date, latestReload]);
  function receive(value: HrDailySheet) { setSheet(value); setOverrides(overridesFromSheet(value)); setPreview(null); setConflict(false); setLatest(null); setPreviewError(false); setSelected([]); onSheet(value); }
  function edit(id: number, field: HrWorkField, value: string | null) { if (disabled) return; setOverrides((current) => setDailyWork(sheet, current, id, { [field]: value })); setMessage(''); }
  async function save(status: 'draft' | 'confirmed') {
    if (disabled || (status === 'confirmed' && !reason.trim())) return;
    setBusy(true); setMessage('');
    try { const value = await saveHrDailyWork(sheet.date, { version: sheet.version, context: sheet.context, rows: dailyRowsPayload(overrides), status, reason: reason.trim() }); if (alive.current) { receive(value); setReason(''); setMessage(ko ? '근무표를 저장했습니다.' : '出勤表已保存。'); } }
    catch (error) { if (alive.current) { if (isHrConflict(error)) setConflict(true); else setMessage(ko ? '저장하지 못했습니다. 입력값을 확인하고 다시 시도하세요.' : '保存失败，请检查输入值后重试。'); } } finally { if (alive.current) setBusy(false); }
  }
  async function copyPrevious() {
    if (disabled) return;
    if (dirty && !window.confirm(ko ? '현재 근무표 초안에 전날 값을 적용할까요?' : '将前一天的数值应用到当前出勤草稿吗？')) return;
    setCopying(true); setMessage('');
    try { const previous = await getHrDailyWork(dailyDateOffset(sheet.date, -1)); if (alive.current) { const result = copyPreviousDaily(previous, sheet, overrides); setOverrides(result.overrides); setMessage(ko ? `${result.copied}명 복사 · 날짜 유형이 다른 ${result.retained}명은 현재 근무값 유지` : `已复制${result.copied}人，日期类型不同的${result.retained}人保留当前工时`); } }
    catch { if (alive.current) setMessage(ko ? '전날 근무표를 불러오지 못했습니다.' : '无法加载前一天出勤表。'); } finally { if (alive.current) setCopying(false); }
  }
  async function submitEvent(value: Omit<HrDailyEventInput, 'revision'>) {
    if (disabled || dirty) return false;
    setBusy(true); setMessage('');
    try { const result = await createHrDailyEvent(sheet.date, { ...value, revision: sheet.event_revision }); if (alive.current) { receive(result); setMessage(ko ? '인원 변동을 등록했습니다.' : '人员变动已登记。'); return true; } }
    catch (error) { if (alive.current) { if (isHrConflict(error)) setConflict(true); else setMessage(ko ? '인원 변동을 등록하지 못했습니다. 사번·입력값·사유를 확인하세요.' : '人员变动登记失败，请检查工号、输入值及原因。'); } } finally { if (alive.current) setBusy(false); }
    return false;
  }
  const changes = dailyLocalChanges(sheet, overrides);
  const groups = [...new Set(sheet.rows.map((row) => row.employee.department))];
  const calculatedRows = new Map(displayed.rows.map((row) => [row.employee.id, row.estimate]));
  const formatValue = (field: HrWorkField, value: unknown) => field === 'attendance' && typeof value === 'string' ? attendanceLabel(value as HrAttendance, ko) : value == null ? (ko ? '미입력' : '未填写') : String(value);
  function renderRow(row: HrDailyRow) {
    const work = effectiveWork(row, overrides); const calculated = calculatedRows.get(row.employee.id) ?? row.estimate;
    return <tr key={row.employee.id} className="hr-daily-row" data-employee-id={row.employee.id}>
      <td data-label={ko ? '선택' : '选择'}><label className="hr-daily-check"><input type="checkbox" aria-label={`${row.employee.code} ${ko ? '선택' : '选择'}`} checked={selected.includes(row.employee.id)} disabled={disabled} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, row.employee.id] : ids.filter((id) => id !== row.employee.id))} /></label></td>
      <td data-label={ko ? '사번' : '工号'}>{row.employee.code}</td><td data-label={ko ? '이름' : '姓名'}><strong>{row.employee.name}</strong><span className="hr-daily-type">{row.employee.employment_type === 'contract' ? (ko ? '계약직' : '合同工') : (ko ? '시급직' : '小时工')}</span></td><td data-label={ko ? '직무' : '职务'}>{row.employee.title || '—'}</td>
      <td data-label={dailyWorkLabel('attendance', ko)}><select aria-label={`${row.employee.code} ${dailyWorkLabel('attendance', ko)}`} data-field="attendance" className={'attendance' in (overrides[row.employee.id] ?? {}) ? 'is-edited' : 'is-default'} value={work.attendance} disabled={disabled} onKeyDown={nextField} onChange={(event) => edit(row.employee.id, 'attendance', event.target.value)}>{(['present', 'absent', 'personal_leave', 'sick_leave', 'off'] as const).map((status) => <option key={status} value={status}>{attendanceLabel(status, ko)}</option>)}</select></td>
      {WORK_HOUR_FIELDS.map((field) => <td key={field} data-label={dailyWorkLabel(field, ko)}><input type="number" inputMode="decimal" min="0" max="24" step="0.25" aria-label={`${row.employee.code} ${dailyWorkLabel(field, ko)}`} data-field={field} className={field in (overrides[row.employee.id] ?? {}) ? 'is-edited' : 'is-default'} value={work[field] ?? ''} placeholder={ko ? '미입력' : '未填写'} disabled={disabled || dailyHourDisabled(sheet, row, work, field)} onKeyDown={nextField} onChange={(event) => edit(row.employee.id, field, event.target.value || null)} /></td>)}
      <td data-label={ko ? '추정 금액' : '估算金额'} className="hr-daily-estimate"><strong>{pending ? '…' : money(calculated.amount, ko)}</strong>{!pending && calculated.amount === null && <span>{ko ? '확인된 금액' : '已知金额'} {money(calculated.known_amount, ko)}</span>}{calculated.deduction_status === 'unconfirmed' && <span className="hr-labor-pending-label">{ko ? '공제 산식 미확정' : '扣款公式未确认'}</span>}<details><summary>{ko ? '계산 근거' : '计算依据'}</summary><pre>{JSON.stringify(calculated.basis, null, 2)}</pre></details></td>
    </tr>;
  }
  return <section className="hr-daily-editor">
    <div className="hr-daily-state"><strong>{statusLabel(sheet.status, ko)} · v{sheet.version}</strong>{dirty && <span>{ko ? '저장 전 변경' : '尚未保存的更改'}</span>}{!sheet.can_edit && <span>{ko ? '조회 전용' : '只读'}</span>}</div>
    <div className="hr-daily-summary" aria-live="polite">
      <div><span>{ko ? '재직 인원' : '在职人数'}</span><strong>{displayed.summary.headcount}</strong><small>{ko ? '계약직' : '合同工'} {displayed.summary.contract} · {ko ? '시급직' : '小时工'} {displayed.summary.hourly}</small></div>
      <div><span>{ko ? '출근 / 결근 / 휴가 / 휴무' : '出勤 / 缺勤 / 请假 / 休息'}</span><strong>{pending ? '…' : `${displayed.summary.present} / ${displayed.summary.absent} / ${displayed.summary.leave} / ${displayed.summary.off}`}</strong></div>
      <div><span>{ko ? '야근 총시간' : '加班总时数'}</span><strong>{pending ? '…' : displayed.summary.overtime_hours}</strong>{!pending && displayed.summary.overtime_partial && <small className="hr-labor-pending-label">{ko ? '확인된 시간 · 일부 미입력' : '已知时数 · 部分未填写'}</small>}</div>
      <div><span>{ko ? '그날 추정 수당' : '当天估算津贴'}</span><strong>{pending ? '…' : money(displayed.summary.amount, ko)}</strong>{!pending && displayed.summary.amount === null && <small>{ko ? '확인된 금액' : '已知金额'} {money(displayed.summary.known_amount, ko)}</small>}</div>
    </div>
    <p className="hr-muted">{ko ? '월 기본급·사회보험은 제외한 야근·휴일 수당과 시급직 근무 금액입니다.' : '仅含加班、休息日与节假日津贴和小时工工作金额，不含月基本工资及社会保险。'}</p>
    {pending && !previewError && !conflict && <p className="hr-daily-preview-state" role="status">{ko ? '입력값으로 다시 계산하는 중입니다…' : '正在按输入值重新计算…'}</p>}
    {previewError && !conflict && <div className="hr-alert is-error" role="alert">{ko ? '미리 계산하지 못했습니다. 시간은 0~24, 해당 하루 합계는 24시간 이내인지 확인하세요.' : '预计算失败，请确认时数为0至24且当天适用时数合计不超过24小时。'}<button className="hr-button" onClick={() => setPreviewReload((value) => value + 1)}>{ko ? '계산 다시 시도' : '重新计算'}</button></div>}
    {message && <p role="status" className="hr-alert">{message}</p>}
    {conflict && <section className="hr-panel hr-daily-conflict" role="alert"><h2>{ko ? '최신 근무표와 비교' : '与最新出勤表比较'}</h2><p>{ko ? '초안은 유지했습니다. 최신 자료를 확인한 뒤 내 변경을 다시 적용하거나 초안을 버리세요.' : '草稿已保留。请查看最新资料后重新应用自己的更改，或放弃草稿。'}</p>{latest ? <><p>v{sheet.version} → v{latest.version}</p><div className="hr-table-scroll"><table><thead><tr>{(ko ? ['직원', '항목', '내 초안', '최신 값'] : ['员工', '项目', '我的草稿', '最新值']).map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{changes.map((change) => { const server = latest.rows.find((row) => row.employee.id === change.employee.id); return <tr key={`${change.employee.id}:${change.field}`}><td>{change.employee.code} {change.employee.name}</td><td>{dailyWorkLabel(change.field, ko)}</td><td>{formatValue(change.field, change.value)}</td><td>{server ? formatValue(change.field, server.work[change.field]) : (ko ? '현재 명부에 없음' : '当前名册中不存在')}</td></tr>; })}</tbody></table></div>{changes.some((change) => !latest.rows.some((row) => row.employee.id === change.employee.id)) && <p className="hr-labor-pending-label">{ko ? '최신 명부에 없는 직원의 변경은 다시 적용할 때 제외됩니다.' : '重新应用时将排除最新名册中不存在员工的更改。'}</p>}<div className="hr-actions"><button className="hr-button is-primary" onClick={() => { const result = reapplyDailyChanges(sheet, overrides, latest); receive(latest); setOverrides(result.overrides); setMessage(ko ? '내 변경을 최신 근무표에 다시 적용했습니다. 확인 후 저장하세요.' : '已将自己的更改重新应用到最新出勤表，请确认后保存。'); }}>{ko ? '내 변경을 최신에 다시 적용' : '将我的更改应用到最新资料'}</button><button className="hr-button" onClick={() => { receive(latest); setReason(''); }}>{ko ? '근무 초안을 버리고 최신 사용' : '放弃出勤草稿并使用最新资料'}</button></div></> : latestError ? <button className="hr-button" onClick={() => setLatestReload((value) => value + 1)}>{ko ? '최신 자료 다시 시도' : '重试加载最新资料'}</button> : <p>{ko ? '최신 자료 조회 중…' : '正在加载最新资料…'}</p>}</section>}
    <div className="hr-daily-bulk"><button className="hr-button" disabled={disabled} onClick={() => void copyPrevious()}>{copying ? (ko ? '복사 중…' : '复制中…') : (ko ? '전날 복사' : '复制前一天')}</button><label className="hr-field">{ko ? '선택 직원 야근 시간' : '所选员工加班时数'}<input aria-label={ko ? '선택 직원 야근 시간' : '所选员工加班时数'} type="number" min="0" max="24" step="0.25" value={hours} disabled={disabled} onChange={(event) => setHours(event.target.value)} /></label><button className="hr-button" disabled={disabled || !selected.length || hours === '' || Number(hours) < 0 || Number(hours) > 24} onClick={() => { setOverrides(dailyBulkOvertime(sheet, overrides, selected, hours)); setMessage(ko ? '적용 가능한 직원의 야근 시간을 반영했습니다. 결근·근무일 휴무·제외 직무는 유지합니다.' : '已更新适用员工的加班时数，缺勤、工作日休息和除外职务保持原样。'); }}>{ko ? `${selected.length}명에 적용` : `应用到${selected.length}人`}</button><button className="hr-button" disabled={disabled || !dirty} onClick={() => { if (window.confirm(ko ? '근무표 초안만 버리고 저장된 값으로 되돌릴까요?' : '仅放弃出勤草稿并恢复已保存值吗？')) { setOverrides(overridesFromSheet(sheet)); setPreview(null); } }}>{ko ? '근무 초안 되돌리기' : '还原出勤草稿'}</button></div>
    <details className="hr-daily-copy-help"><summary>{ko ? '전날 복사 규칙' : '前一天复制规则'}</summary><p>{ko ? '사번이 연결된 동일 직원을 복사합니다. 같은 날짜 유형(근무일·조정 근무일은 같은 유형)은 근무값 전체를 복사합니다. 유형이 다르면 결근·개인 휴가·병가와 휴가 시간만 복사하고, 나머지 직원의 현재 근무값은 유지합니다.' : '按关联员工复制。相同日期类型（工作日与调休工作日视为同类）复制全部出勤值；类型不同时仅复制缺勤、事假、病假及请假时数，其余员工保留当前工时。'}</p></details>
    {groups.map((department) => <section className="hr-panel hr-daily-department" key={department}><div className="hr-section-heading"><h2>{department || (ko ? '부서 미입력' : '部门未填写')}</h2><div className="hr-actions"><button className="hr-button" disabled={disabled} onClick={() => setOverrides(dailyBulkDefaults(sheet, overrides, department))}>{ko ? '부서 기본값 적용' : '应用部门默认值'}</button><button className="hr-button" disabled={disabled} onClick={() => setOverrides(dailyBulkOff(sheet, overrides, department))}>{ko ? '부서 전체 휴무' : '部门全员休息'}</button></div></div>
      <div className="hr-table-scroll hr-daily-table"><table><thead><tr>{(ko ? ['선택', '사번', '이름', '직무', '출근 상태', '정규 시간', '평일 야근', '휴일 근무', '공휴일 근무', '개인 휴가 시간', '병가 시간', '추정 금액'] : ['选择', '工号', '姓名', '职务', '出勤状态', '正常工时', '平日加班', '休息日工作', '节假日工作', '事假时数', '病假时数', '估算金额']).map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{sheet.rows.filter((row) => row.employee.department === department).map(renderRow)}</tbody></table></div>
      <p className="hr-daily-department-total">{ko ? '부서 추정' : '部门估算'}: {pending ? '…' : money(displayed.departments.find((entry) => entry.department === department)?.amount ?? null, ko)}</p>
    </section>)}
    {!sheet.rows.length && <div className="hr-panel hr-state">{ko ? '이 날짜에 재직 중인 직원이 없습니다.' : '此日期无在职员工。'}</div>}
    <div className="hr-panel hr-daily-save"><label className="hr-field">{ko ? '근무표 변경 사유 (확정 시 필수)' : '出勤表变更原因（确认时必填）'}<input maxLength={500} value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} /></label><button className="hr-button" disabled={disabled} onClick={() => void save('draft')}>{ko ? '입력 중으로 저장' : '保存为填写中'}</button><button className="hr-button is-primary" disabled={disabled || !reason.trim()} onClick={() => void save('confirmed')}>{ko ? '근무표 확정' : '确认出勤表'}</button></div>
    <HrDailyEvents sheet={sheet} ko={ko} busy={busy || copying} blocked={dirty || conflict} onSubmit={submitEvent} onDraft={setEventDraft} />
    <details className="hr-panel hr-daily-history"><summary>{ko ? '근무표 변경 이력' : '出勤表变更记录'} ({sheet.history.length})</summary>{sheet.history.map((entry) => <article key={entry.version}><strong>v{entry.version} · {entry.actor_label}</strong><time dateTime={entry.created_at}>{new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.created_at))}</time><p>{entry.reason || (ko ? '사유 없음' : '无原因')}</p><details><summary>{ko ? '변경 전 → 후' : '变更前 → 后'}</summary><pre>{JSON.stringify(entry.before, null, 2)}{'\n→\n'}{JSON.stringify(entry.after, null, 2)}</pre></details></article>)}</details>
  </section>;
}

export default function DailyWorkPage() {
  const { user } = useAuth(); const allowed = canAccessHr(user); const { lang } = useLang(); const ko = lang === 'ko';
  const [date, setDate] = useState(initialDailyDate); const [dateInput, setDateInput] = useState(date); const [dateError, setDateError] = useState(false);
  const [result, setResult] = useState<{ scope: string; value: HrDailySheet } | null>(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const [activity, setActivity] = useState({ dirty: false, busy: false }); const scope = `${user?.id}:${date}`;
  const stripRef = useRef<HTMLDivElement>(null);
  const location = useLocation(); const navigate = useNavigate(); const sheet = allowed && result?.scope === scope ? result.value : null;
  useEffect(() => {
    const controller = new AbortController(); setError(''); setResult(null);
    if (allowed) getHrDailyWork(date, controller.signal).then((value) => { if (!controller.signal.aborted) setResult({ scope, value }); }).catch(() => { if (!controller.signal.aborted) setError(scope); });
    return () => controller.abort();
  }, [date, allowed, scope, reload]);
  useEffect(() => {
    const strip = stripRef.current; const selected = strip?.querySelector<HTMLElement>('[aria-current="date"]');
    if (!strip || !selected) return;
    const viewport = strip.getBoundingClientRect(); const button = selected.getBoundingClientRect();
    if (button.left < viewport.left) strip.scrollLeft -= viewport.left - button.left;
    else if (button.right > viewport.right) strip.scrollLeft += button.right - viewport.right;
  }, [date, sheet?.date]);
  useEffect(() => { const query = new URLSearchParams(location.search); if (query.get('date') === date && query.get('month') === date.slice(0, 7)) return; query.set('date', date); query.set('month', date.slice(0, 7)); navigate({ pathname: location.pathname, search: query.toString() }, { replace: true }); }, [date, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (!activity.dirty && !activity.busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const onLink = (event: MouseEvent) => { const target = event.target instanceof Element ? event.target.closest('a[href]') : null; if (!(target instanceof HTMLAnchorElement) || target.target === '_blank' || target.hasAttribute('download') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || target.href === window.location.href) return; if (activity.busy || !window.confirm(ko ? '저장하지 않은 근무·인원 변동 입력을 버리고 이동할까요?' : '放弃未保存的出勤或人员变动输入并离开吗？')) { event.preventDefault(); event.stopImmediatePropagation(); } };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', onLink, true); return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onLink, true); };
  }, [activity, ko]);
  function changeDate(next: string) {
    if (activity.busy || next === date) return;
    if (activity.dirty && !window.confirm(ko ? '저장하지 않은 근무·인원 변동 입력을 버리고 날짜를 바꿀까요?' : '放弃未保存的出勤或人员变动输入并切换日期吗？')) return;
    setActivity({ dirty: false, busy: false }); setDate(next); setDateInput(next); setDateError(false);
  }
  function applyDate() { const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateInput) && !Number.isNaN(new Date(`${dateInput}T12:00:00Z`).getTime()) && new Date(`${dateInput}T12:00:00Z`).toISOString().slice(0, 10) === dateInput; if (!valid) { setDateError(true); return; } changeDate(dateInput); }
  if (!allowed) return <main className="hr-page"><HrLoadState allowed={false} loading={false} error="" retry={() => {}} /></main>;
  return <HrShell page="daily-work" month={date.slice(0, 7) || currentHrMonth()} onMonthChange={(month) => changeDate(`${month}-01`)} monthDisabled={activity.busy}>
    <section className="hr-panel hr-daily-date-nav"><div className="hr-actions"><button className="hr-button" disabled={activity.busy} onClick={() => changeDate(dailyDateOffset(date, -1))}>{ko ? '전날' : '前一天'}</button><label className="hr-field">{ko ? '근무 날짜' : '出勤日期'}<input value={dateInput} placeholder="YYYY-MM-DD" maxLength={10} disabled={activity.busy} onChange={(event) => setDateInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyDate(); }} /></label><button className="hr-button" disabled={activity.busy} onClick={applyDate}>{ko ? '날짜 적용' : '应用日期'}</button><button className="hr-button" disabled={activity.busy} onClick={() => changeDate(dailyDateOffset(date, 1))}>{ko ? '다음날' : '后一天'}</button><button className="hr-button" disabled={activity.busy} onClick={() => changeDate(todayHrDate())}>{ko ? '오늘' : '今天'}</button><strong>{sheet && laborDayLabel(sheet.day_type, ko)}</strong></div>{dateError && <p role="alert">{ko ? '유효한 날짜를 YYYY-MM-DD로 입력하세요.' : '请按YYYY-MM-DD输入有效日期。'}</p>}
      {sheet && <div ref={stripRef} className="hr-daily-date-strip" aria-label={ko ? '월 날짜 목록' : '本月日期列表'}>{sheet.days.map((day) => <button key={day.date} className="hr-daily-date" data-date={day.date} aria-current={day.date === date ? 'date' : undefined} disabled={activity.busy} onClick={() => changeDate(day.date)}><strong>{Number(day.date.slice(-2))}</strong><span>{laborDayLabel(day.day_type, ko)}</span><small>{statusLabel(day.status, ko)}</small></button>)}</div>}
    </section>
    {sheet ? <DailySheetEditor key={scope} initial={sheet} ko={ko} onActivity={setActivity} onSheet={(value) => setResult({ scope, value })} /> : <HrLoadState allowed={allowed} loading={error !== scope} error={ko ? '일별 근무표를 불러오지 못했습니다.' : '无法加载每日出勤表。'} retry={() => setReload((value) => value + 1)} />}
  </HrShell>;
}
