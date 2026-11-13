import { useEffect, useState } from 'react';
import type { HrDailyEventInput, HrDailyEventKind, HrDailySheet } from '../../domains/hr/daily-work';

const dailyEventLabel = (kind: HrDailyEventKind, ko: boolean) => ({ hire: ko ? '입사' : '入职', terminate: ko ? '퇴사' : '离职', transfer: ko ? '부서 이동' : '部门调动', title_change: ko ? '직무 변경' : '职务变更', employment_change: ko ? '고용형태 변경' : '用工类型变更', cancel: ko ? '이벤트 취소' : '撤销事件' })[kind];
export default function HrDailyEvents({ sheet, ko, busy, blocked, onSubmit, onDraft }: { sheet: HrDailySheet; ko: boolean; busy: boolean; blocked: boolean; onSubmit: (value: Omit<HrDailyEventInput, 'revision'>) => Promise<boolean>; onDraft: (dirty: boolean) => void }) {
  const [kind, setKind] = useState<HrDailyEventKind>('hire'); const [employee, setEmployee] = useState(''); const [target, setTarget] = useState<number | null>(null);
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [type, setType] = useState<'contract' | 'hourly'>('contract');
  const [department, setDepartment] = useState(''); const [title, setTitle] = useState(''); const [salary, setSalary] = useState(''); const [fixed, setFixed] = useState(''); const [rate, setRate] = useState(''); const [reason, setReason] = useState('');
  const dirty = Boolean(employee || target || code || name || department || title || salary || fixed || rate || reason);
  useEffect(() => { onDraft(dirty); return () => onDraft(false); }, [dirty, onDraft]);
  const valid = reason.trim() && (kind === 'cancel' ? target : kind === 'hire' ? code.trim() && name.trim() && department.trim() && title.trim() && (type === 'hourly' || (salary.trim() && fixed.trim())) : employee && (kind === 'transfer' ? department.trim() : kind === 'title_change' ? title.trim() : true));
  function clear() { setEmployee(''); setTarget(null); setCode(''); setName(''); setDepartment(''); setTitle(''); setSalary(''); setFixed(''); setRate(''); setReason(''); }
  async function submit() {
    if (!valid || busy || blocked || !sheet.can_edit) return;
    const changes: NonNullable<HrDailyEventInput['changes']> = kind === 'hire' ? { code: code.trim(), name: name.trim(), employment_type: type, department: department.trim(), title: title.trim(), ...(type === 'contract' ? { base_salary: salary, fixed_overtime: fixed } : rate.trim() ? { hourly_rate: rate } : {}) }
      : kind === 'transfer' ? { department: department.trim() } : kind === 'title_change' ? { title: title.trim() } : kind === 'employment_change' ? { employment_type: type, ...(type === 'contract' && salary.trim() ? { base_salary: salary } : {}), ...(type === 'contract' && fixed.trim() ? { fixed_overtime: fixed } : {}), ...(type === 'hourly' && rate.trim() ? { hourly_rate: rate } : {}) } : {};
    const success = await onSubmit({ kind, reason: reason.trim(), ...(kind === 'cancel' ? { target_id: target! } : kind === 'hire' ? { changes } : { employee_id: Number(employee), ...(Object.keys(changes).length ? { changes } : {}) }) });
    if (success) { clear(); setKind('hire'); }
  }
  function beforeAfter(before: Record<string, unknown>, after: Record<string, unknown>) {
    const labels = {
      employment_type: ko ? '고용형태' : '用工类型',
      department: ko ? '부서' : '部门',
      title: ko ? '직무' : '职务',
      base_salary: ko ? '기본급' : '基本工资',
      fixed_overtime: ko ? '고정 연장수당' : '固定平时加班',
      hourly_rate: ko ? '시급' : '时薪',
      active: ko ? '재직' : '在职',
      last_work_day: ko ? '마지막 근무일' : '最后工作日',
    };
    function display(value: unknown): string {
      if (value == null) return '—';
      if (value === 'contract') return ko ? '계약직' : '合同工';
      if (value === 'hourly') return ko ? '시급직' : '小时工';
      if (typeof value === 'boolean') return value ? (ko ? '예' : '是') : (ko ? '아니오' : '否');
      return String(value);
    }
    return Object.entries(labels).flatMap(([key, label]) => {
      const previous = display(before[key]);
      const current = display(after[key]);
      return previous === current ? [] : [`${label} ${previous} → ${current}`];
    }).join(' · ');
  }
  return <section className="hr-panel hr-daily-events"><div className="hr-section-heading"><h2>{ko ? '인원 변동' : '人员变动'}</h2><span>{sheet.date}</span></div>
    {!sheet.events.length ? <p className="hr-muted">{ko ? '이날 적용되는 이벤트가 없습니다.' : '当天无生效事件。'}</p> : <ol className="hr-daily-event-list">{sheet.events.map((event) => <li key={event.id} data-event-id={event.id}>
      <div><strong>{dailyEventLabel(event.kind, ko)} · {event.employee.code} {event.employee.name}</strong> {event.cancelled && <span>{ko ? '취소됨' : '已撤销'}</span>}</div>
      <p>{beforeAfter(event.before, event.after)}</p><p>{ko ? '사유' : '原因'}: {event.reason} · {event.actor_label} · <time dateTime={event.created_at}>{new Intl.DateTimeFormat(ko ? 'ko-KR' : 'zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(event.created_at))}</time></p>
      {event.kind !== 'cancel' && !event.cancelled && sheet.can_edit && <button type="button" className="hr-button" disabled={busy || blocked} onClick={() => { clear(); setKind('cancel'); setTarget(event.id); }}>{ko ? '취소 이벤트 작성' : '填写撤销事件'}</button>}
    </li>)}</ol>}
    {sheet.can_edit && <form className="hr-daily-event-form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h3>{ko ? '변동 입력' : '填写变动'}</h3>
      {blocked && <p className="hr-alert is-warning">{ko ? '근무표 초안을 먼저 저장하거나 되돌린 뒤 인원 변동을 등록하세요.' : '请先保存或还原出勤表草稿，再登记人员变动。'}</p>}
      <fieldset disabled={busy}><div className="hr-daily-event-fields"><label className="hr-field">{ko ? '변동 종류' : '变动类型'}<select aria-label={ko ? '변동 종류' : '变动类型'} value={kind} onChange={(event) => { clear(); setKind(event.target.value as HrDailyEventKind); }}>{(['hire', 'terminate', 'transfer', 'title_change', 'employment_change', ...(target ? ['cancel'] : [])] as HrDailyEventKind[]).map((value) => <option key={value} value={value}>{dailyEventLabel(value, ko)}</option>)}</select></label>
      {kind !== 'hire' && kind !== 'cancel' && <label className="hr-field">{ko ? '변동 직원' : '变动员工'}<select aria-label={ko ? '변동 직원' : '变动员工'} value={employee} onChange={(event) => { const row = sheet.rows.find((item) => item.employee.id === Number(event.target.value)); setEmployee(event.target.value); if (row) { setType(row.employee.employment_type); setDepartment(row.employee.department); setTitle(row.employee.title); } }}><option value="">{ko ? '직원 선택' : '选择员工'}</option>{sheet.rows.map((row) => <option key={row.employee.id} value={row.employee.id}>{row.employee.code} · {row.employee.name}</option>)}</select></label>}
      {kind === 'cancel' && <p>{ko ? '취소할 이벤트' : '待撤销事件'} #{target}</p>}
      {kind === 'hire' && <><label className="hr-field">{ko ? '신규 사번' : '新员工工号'}<input maxLength={64} required value={code} onChange={(event) => setCode(event.target.value)} /></label><label className="hr-field">{ko ? '신규 이름' : '新员工姓名'}<input maxLength={100} required value={name} onChange={(event) => setName(event.target.value)} /></label></>}
      {(kind === 'hire' || kind === 'employment_change') && <label className="hr-field">{ko ? '변경 고용형태' : '变更用工类型'}<select aria-label={ko ? '변경 고용형태' : '变更用工类型'} value={type} onChange={(event) => setType(event.target.value as 'contract' | 'hourly')}><option value="contract">{ko ? '계약직' : '合同工'}</option><option value="hourly">{ko ? '시급직' : '小时工'}</option></select></label>}
      {(kind === 'hire' || kind === 'transfer') && <label className="hr-field">{ko ? '변경 부서' : '变更部门'}<input list="hr-daily-department-options" maxLength={100} required value={department} onChange={(event) => setDepartment(event.target.value)} /></label>}
      {(kind === 'hire' || kind === 'title_change') && <label className="hr-field">{ko ? '변경 직무' : '变更职务'}<input maxLength={100} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
      {(kind === 'hire' || kind === 'employment_change') && (type === 'contract' ? <><label className="hr-field">{ko ? '기본급 (CNY)' : '基本工资 (CNY)'}<input type="number" min="0" step="0.01" required={kind === 'hire'} value={salary} onChange={(event) => setSalary(event.target.value)} /></label><label className="hr-field">{ko ? '고정 연장수당 (CNY)' : '固定平时加班 (CNY)'}<input type="number" min="0" step="0.01" required={kind === 'hire'} value={fixed} onChange={(event) => setFixed(event.target.value)} /></label></> : <label className="hr-field">{ko ? '시급 예외 (선택)' : '例外时薪（可选）'}<input type="number" min="0" step="any" value={rate} onChange={(event) => setRate(event.target.value)} /></label>)}
      </div><datalist id="hr-daily-department-options">{[...new Set(sheet.rows.map((row) => row.employee.department))].filter(Boolean).map((department) => <option key={department} value={department} />)}</datalist><p className="hr-muted">{ko ? `적용일: ${sheet.date}. 퇴사는 이 날짜가 마지막 근무일입니다.` : `生效日：${sheet.date}。离职时此日为最后工作日。`}</p><label className="hr-field">{ko ? '인원 변동 사유' : '人员变动原因'}<input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label></fieldset>
      <div className="hr-actions"><button className="hr-button is-primary" disabled={!valid || busy || blocked}>{ko ? '변동 등록' : '登记变动'}</button><button type="button" className="hr-button" disabled={busy} onClick={clear}>{ko ? '입력 비우기' : '清空输入'}</button></div>
    </form>}
  </section>;
}
