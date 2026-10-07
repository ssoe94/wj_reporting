import { inspectionDisplayLabel } from './displayLabel';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { getInspectionRoleSettings, saveInspectionRoleSetting } from './api';
import { inspectionCopy } from './copy';
import { inspectionRoleCopy } from './roleCopy';
import type { InspectionRoleSetting, InspectionRoleSettings } from './roleModel';
import { createInspectionKey, inspectionError } from './workflow';

import { createRoleShiftDraft, roleShiftActorLabel, roleShiftDraftError, roleShiftPresetTimes, roleShiftSettingDraft as settingDraft, roleShiftSettingPayload, SHIFT_TIMEZONE } from './roleShiftSettingsModel';
import type { RoleShiftDraft as SettingDraft, RoleShiftPreset } from './roleShiftSettingsModel';
import { getWeeklyInspectionRoleSettings, saveWeeklyInspectionRoleSettings } from './weeklyRosterApi';
import { WEEKLY_ROSTER_SLOTS, currentWeeklyRosterWeek, normalizeWeeklyRosterName, weeklyRosterAddDays, weeklyRosterDraft, weeklyRosterNameMatches, weeklyRosterPayload, weeklyRosterPersonLabel, weeklyRosterSlotKey, weeklyRosterWeekFromInput, weeklyRosterWeekInput } from './weeklyRosterModel';
import type { WeeklyRosterDraftPerson, WeeklyRosterPayload, WeeklyRosterSettings } from './weeklyRosterModel';
const presetFor = (draft: SettingDraft): RoleShiftPreset => draft.start_time === '08:00' && draft.end_time === '20:00' ? 'day' : draft.start_time === '20:00' && draft.end_time === '08:00' ? 'night' : 'custom';

type RoleSettingsProps = { userId: number; sessionId: string | null; lang: 'ko' | 'zh'; onDirty: (dirty: boolean) => void; onLocked: (locked: boolean, pending: boolean) => void; onClose: () => void };

export function LegacyRoleSettings({ userId, sessionId, lang, onDirty, onLocked, onClose }: RoleSettingsProps) {
  const text = inspectionRoleCopy[lang];
  const common = inspectionCopy[lang];
  const [data, setData] = useState<InspectionRoleSettings | null>(null);
  const [selected, setSelected] = useState<InspectionRoleSetting | null>(null);
  const emptyDraft = () => ({ ...createRoleShiftDraft(), label: text.day });
  const [draft, setDraft] = useState<SettingDraft>(emptyDraft);
  const [preset, setPreset] = useState<RoleShiftPreset>('day');
  const original = useRef(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<InspectionRoleSetting | null>(null);
  const [pending, setPending] = useState<{ id: number | null; payload: Record<string, unknown>; key: string } | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const ownsSession = useCallback(() => { if (!mounted.current) return false; try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; } }, [sessionId]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original.current);
  const blocked = busy || Boolean(pending) || conflict || data?.can_configure !== true;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (ownsSession()) onDirty(dirty); }, [dirty, onDirty, ownsSession]);
  useEffect(() => { if (ownsSession()) onLocked(busy || Boolean(pending), busy); }, [busy, pending, onLocked, ownsSession]);
  const load = useCallback(async () => {
    if (!ownsSession()) return;
    setError('');
    try { const result = await getInspectionRoleSettings(sessionId); if (ownsSession()) setData(result); }
    catch (cause) { if (ownsSession()) setError(inspectionError(cause, common.loadError).message); }
  }, [common.loadError, ownsSession, sessionId]);
  useEffect(() => { void load(); }, [load]);
  const choose = (setting: InspectionRoleSetting | null) => {
    if (!ownsSession() || busy || pending || (dirty && !window.confirm(common.discard))) return;
    const next = setting ? settingDraft(setting) : emptyDraft();
    setSelected(setting); setDraft(next); setPreset(presetFor(next)); original.current = next; setConflict(false); setLatest(null); setError(''); setMessage('');
  };
  const update = (patch: Partial<SettingDraft>) => { if (ownsSession() && !blocked) { setDraft({ ...draft, ...patch }); setMessage(''); } };
  const run = async (attempt: NonNullable<typeof pending>) => {
    if (!ownsSession() || lock.current) return;
    lock.current = true; setBusy(true); setPending(attempt); setError('');
    try {
      const result = await saveInspectionRoleSetting(attempt.id, attempt.payload, attempt.key, sessionId, userId);
      if (!ownsSession()) return;
      const next = settingDraft(result); setSelected(result); setDraft(next); setPreset(presetFor(next)); original.current = next; setPending(null); setConflict(false); setLatest(null); setMessage(text.saved);
      setData((previous) => previous ? { ...previous, settings: [...previous.settings.filter((row) => row.id !== result.id), result] } : previous);
    } catch (cause) {
      if (!ownsSession()) return;
      const failure = inspectionError(cause, common.failure);
      const body = (cause as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const code = body?.code;
      const validation = code === 'weekly_setting_managed' ? (lang === 'ko' ? '주간 담당자 카드에서 이 설정을 변경하세요. 입력은 유지했습니다.' : '请在每周人员卡片中修改此设置。已保留输入。')
        : code === 'shift_overlap' || code === 'shift_schedule_ambiguous' ? text.overlap : code === 'duplicate_shift_code' ? text.duplicate
        : body?.appearance_assignee || body?.dimension_assignee ? text.ineligible
          : body?.effective_from_local ? text.fromAlignment : body?.effective_until_local ? text.untilAlignment : null;
      setConflict(failure.conflict && !validation); setError(validation || (failure.conflict ? text.conflict : failure.uncertain ? text.uncertain : failure.message));
      if (!failure.uncertain) setPending(null);
    } finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ownsSession() || blocked || !dirty) return;
    const invalid = roleShiftDraftError(draft, data?.candidates || []);
    const errors: Record<string, string> = { local_datetime_invalid: text.datetimeInvalid, period_order: text.periodOrder, effective_from_required: text.fromRequired, effective_from_alignment: text.fromAlignment, effective_until_alignment: text.untilAlignment, actor_ineligible: text.ineligible };
    if (invalid || (selected && !draft.reason.trim())) { setError(invalid ? errors[invalid] || text.invalid : common.reasonRequired); return; }
    const payload = roleShiftSettingPayload(draft, selected);
    void run({ id: selected?.id || null, payload, key: createInspectionKey() });
  };
  const compare = async () => {
    if (!ownsSession() || busy || pending || !selected) return;
    setBusy(true);
    try { const result = await getInspectionRoleSettings(sessionId); if (ownsSession()) { setData(result); setLatest(result.settings.find((row) => row.id === selected.id) || null); } }
    catch (cause) { if (ownsSession()) setError(inspectionError(cause, common.loadError).message); }
    finally { if (ownsSession()) setBusy(false); }
  };
  return <section className="inspection-detail inspection-role-settings" aria-labelledby="inspection-role-settings-title" aria-busy={busy}>
    <div className="inspection-detail-heading"><h2 id="inspection-role-settings-title">{text.settings}</h2><button type="button" className="inspection-button" disabled={busy || Boolean(pending)} onClick={onClose}>{common.cancel}</button></div>
    <div className="inspection-actions">{data?.settings.map((setting) => <button type="button" className="inspection-button" key={setting.id} aria-pressed={selected?.id === setting.id} disabled={busy || Boolean(pending)} onClick={() => choose(setting)}>{inspectionDisplayLabel(setting.label, lang)} · {setting.start_time?.slice(0, 5) || '—'}–{setting.end_time?.slice(0, 5) || '—'} · {setting.effective_from_local?.replace('T', ' ') || '—'}{!setting.active ? ` · ${text.pending}` : ''}</button>)}<button type="button" className="inspection-button" disabled={busy || Boolean(pending) || data?.can_configure !== true} onClick={() => choose(null)}>{text.newSetting}</button></div>
    {data && !data.settings.length && <p className="inspection-muted">{text.noSettings}</p>}
    {data?.can_configure === false && <p role="status">{text.denied}</p>}
    {error && <p className="inspection-message is-error" role="alert">{error}</p>}{message && <p className="inspection-message is-success" role="status">{message}</p>}
    {pending && !busy && <button type="button" className="inspection-button" onClick={() => void run(pending)}>{text.retry}</button>}
    {conflict && <div className="inspection-message"><button type="button" className="inspection-button" disabled={busy} onClick={() => void compare()}>{text.compare}</button>{latest && <><p>{common.version} {selected?.version} → {latest.version} · {latest.label}</p><div className="inspection-actions"><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { setSelected(latest); original.current = settingDraft(latest); setPreset(presetFor(draft)); setConflict(false); setLatest(null); setError(''); } }}>{text.useDraft}</button><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { const next = settingDraft(latest); setSelected(latest); setDraft(next); setPreset(presetFor(next)); original.current = next; setConflict(false); setLatest(null); setError(''); } }}>{text.discard}</button></div></>}</div>}
    <p className="inspection-muted">{text.chinaTime}</p>
    <form onSubmit={submit}><fieldset disabled={blocked} className="inspection-item"><legend>{selected ? text.editExisting : text.createPeriod}</legend><div className="inspection-form-grid">
      <label>{text.preset}<select id="inspection-shift-preset" value={preset} onChange={(event) => { if (!ownsSession() || blocked) return; const value = event.target.value as RoleShiftPreset; setPreset(value); if (value !== 'custom') update({ ...roleShiftPresetTimes(value), ...(!draft.label || [text.day, text.night].includes(draft.label) ? { label: text[value] } : {}) }); }}><option value="day">{text.day} · 08:00–20:00</option><option value="night">{text.night} · 20:00–{lang === 'ko' ? '다음날' : '次日'} 08:00</option><option value="custom">{text.custom}</option></select></label>
      <label>{text.label} *<input id="inspection-shift-label" required maxLength={128} value={draft.label} onChange={(event) => update({ label: event.target.value })} /></label>
      <label>{text.start}<input id="inspection-shift-start" type="time" required={draft.active} value={draft.start_time} onChange={(event) => { update({ start_time: event.target.value }); if (ownsSession() && !blocked) setPreset('custom'); }} /></label>
      <label>{text.end}<input id="inspection-shift-end" type="time" required={draft.active} value={draft.end_time} onChange={(event) => { update({ end_time: event.target.value }); if (ownsSession() && !blocked) setPreset('custom'); }} /></label>
      <label>{text.fromLocal}{draft.active ? ' *' : ''}<input id="inspection-shift-effective-from" type="datetime-local" step="60" required={draft.active} value={draft.effective_from_local} onChange={(event) => update({ effective_from_local: event.target.value })} /></label>
      <label>{text.untilLocal}<input id="inspection-shift-effective-until" type="datetime-local" step="60" value={draft.effective_until_local} onChange={(event) => update({ effective_until_local: event.target.value })} /><small>{text.untilOptional}</small></label>
      {(['appearance', 'dimension'] as const).map((area) => <label key={area}>{text[area]} · {text.owner}<select id={`inspection-shift-${area}-assignee`} value={draft[`${area}_assignee`]} required={draft.active} onChange={(event) => update({ [`${area}_assignee`]: event.target.value })}><option value="">{text.choose}</option>{data?.candidates.map((actor) => <option value={actor.id} key={actor.id}>{roleShiftActorLabel(actor, lang)}</option>)}</select></label>)}
      <p className="inspection-form-full inspection-muted">{lang === 'ko' ? 'WJ 입력 담당자입니다. MES 실행 권한은 별도로 확인합니다.' : '此处设置 WJ 录入负责人，MES 执行权限另行确认。'}</p>
      {selected && <label className="inspection-form-full">{text.reason} *<textarea id="inspection-shift-change-reason" required maxLength={500} value={draft.reason} onChange={(event) => update({ reason: event.target.value })} /></label>}
    </div><label className="inspection-check"><input id="inspection-shift-active" type="checkbox" checked={draft.active} onChange={(event) => update({ active: event.target.checked })} />{text.active}</label></fieldset><button type="submit" className="inspection-button is-primary" disabled={blocked || !dirty}>{busy ? common.busy : text.saveSetting}</button></form>
    <details className="inspection-help"><summary><span aria-hidden="true">ⓘ</span> {lang === 'ko' ? '적용 기간·담당자 안내' : '适用期间与负责人说明'}</summary><p>{text.periodHint}</p><p>{text.preserveSnapshotHint}</p><p>{text.periodBoundaryHint}</p><p>{text.accountHint}</p><dl className="inspection-meta"><div><dt>{text.internalCode}</dt><dd>{draft.code}</dd></div><div><dt>{text.timezone}</dt><dd>{SHIFT_TIMEZONE}</dd></div><div><dt>{text.fromLocal}</dt><dd>{draft.effective_from_local?.replace('T', ' ') || '—'}</dd></div><div><dt>{text.untilLocal}</dt><dd>{draft.effective_until_local?.replace('T', ' ') || '—'}</dd></div>{selected && <><div><dt>{text.fromUTC}</dt><dd>{selected.effective_from || '—'}</dd></div><div><dt>{text.untilUTC}</dt><dd>{selected.effective_until || '—'}</dd></div></>}</dl></details>
  </section>;
}

const weeklyCopy = {
  ko: {
    title: '주간 검사 담당자', week: '적용 주', previous: '이전 주', next: '다음 주', current: '이번 주',
    name: '담당자 이름', choose: '미배정', add: '새 이름 입력', newName: '새 담당자 이름',
    range: '적용 기간', monday: '월', sunday: '일', save: '이번 주 담당자 저장', saved: '주간 담당자를 저장했습니다.',
    loading: '주간 담당자를 불러오는 중…', advanced: '고급 설정', detail: '교대 시각·기존 계정 설정',
    fixedTimes: '주간 08:00–20:00 · 야간 20:00–다음날 08:00 · 중국 현지 시각',
    sundayNight: '일요일 야간은 다음 월요일 08:00까지 적용합니다.',
    homonym: '같은 이름의 다른 사람 추가', note: '이름 구분 메모', notePlaceholder: '예: 2조',
    reuse: '저장된 같은 이름을 사용합니다. 다른 사람이라면 구분 메모를 추가하세요.',
    draftHomonym: '다른 카드에 같은 이름이 있습니다. 동명이인이라면 짧은 구분 메모를 입력하세요.',
    invalid: '담당자 이름을 입력하세요. 이름은 128자, 구분 메모는 64자까지 가능합니다.',
    samePerson: '같은 교대의 치수·외관 담당자는 서로 다른 사람을 선택하세요.',
    needsNote: '같은 이름이 있습니다. 저장된 담당자를 선택하거나 구분 메모를 입력하세요.',
    unavailable: '선택한 이름을 사용할 수 없습니다. 최신 명단에서 다시 선택하세요.',
    scheduleConflict: '기존 교대 기간과 겹칩니다. 고급 설정에서 기존 기간을 확인하세요. 입력은 유지했습니다.',
    latest: '최신 담당자', reload: '다시 불러오기', denied: '주간 담당자 설정 권한이 없습니다.',
    preserve: '이미 시작한 검사의 담당자 기록은 유지합니다.',
  },
  zh: {
    title: '每周检验人员', week: '适用周', previous: '上一周', next: '下一周', current: '本周',
    name: '负责人姓名', choose: '未分配', add: '输入新姓名', newName: '新人员姓名',
    range: '适用期间', monday: '周一', sunday: '周日', save: '保存本周人员', saved: '已保存本周人员。',
    loading: '正在加载本周人员…', advanced: '高级设置', detail: '班次时间与现有账号设置',
    fixedTimes: '白班 08:00–20:00 · 夜班 20:00–次日 08:00 · 中国当地时间',
    sundayNight: '周日夜班适用至下周一 08:00。',
    homonym: '添加同名的另一人', note: '同名区分备注', notePlaceholder: '例如：二组',
    reuse: '将使用已保存的同名人员。如为另一人，请添加区分备注。',
    draftHomonym: '其他卡片中已有相同姓名。如为同名的另一人，请填写简短的区分备注。',
    invalid: '请输入姓名。姓名最多 128 字，区分备注最多 64 字。',
    samePerson: '同一班次的尺寸与外观负责人须为不同人员。',
    needsNote: '已有同名人员。请选择已保存人员，或填写区分备注。',
    unavailable: '无法使用所选姓名，请从最新名单重新选择。',
    scheduleConflict: '与现有班次期间重叠。请在高级设置中检查原有期间。已保留输入。',
    latest: '最新人员', reload: '重新加载', denied: '暂无每周人员设置权限。',
    preserve: '已开始检验的人员记录保持不变。',
  },
};

export default function RoleSettings(props: RoleSettingsProps) {
  const { userId, sessionId, lang, onDirty, onLocked, onClose } = props;
  const text = weeklyCopy[lang];
  const role = inspectionRoleCopy[lang];
  const common = inspectionCopy[lang];
  const [weekStart, setWeekStart] = useState(currentWeeklyRosterWeek);
  const [weekInput, setWeekInput] = useState(() => weeklyRosterWeekInput(weekStart));
  const [data, setData] = useState<WeeklyRosterSettings | null>(null);
  const [draft, setDraft] = useState(() => weeklyRosterDraft());
  const original = useRef(draft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<WeeklyRosterSettings | null>(null);
  const [pending, setPending] = useState<{ payload: WeeklyRosterPayload; key: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [legacyDirty, setLegacyDirty] = useState(false);
  const [legacyLock, setLegacyLock] = useState({ locked: false, pending: false });
  const loadError = useRef(common.loadError);
  const mounted = useRef(true);
  const lock = useRef(false);
  const generation = useRef(0);
  const ownsSession = useCallback(() => { if (!mounted.current) return false; try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; } }, [sessionId]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original.current);
  const blocked = loading || busy || Boolean(pending) || conflict || legacyLock.locked || data?.can_configure !== true;
  const navigationBlocked = loading || busy || Boolean(pending) || legacyLock.locked;
  const onLegacyLocked = useCallback((locked: boolean, pending: boolean) => setLegacyLock({ locked, pending }), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);
  useEffect(() => { loadError.current = common.loadError; }, [common.loadError]);
  useEffect(() => { if (ownsSession()) onDirty(dirty || legacyDirty); }, [dirty, legacyDirty, onDirty, ownsSession]);
  useEffect(() => { if (ownsSession()) onLocked(busy || Boolean(pending) || legacyLock.locked, busy || legacyLock.pending); }, [busy, pending, legacyLock, onLocked, ownsSession]);

  const accept = (result: WeeklyRosterSettings) => {
    const next = weeklyRosterDraft(result);
    setData(result); setDraft(next); original.current = next;
    setConflict(false); setLatest(null); setError('');
  };
  const load = useCallback(async () => {
    if (!ownsSession()) return;
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = await getWeeklyInspectionRoleSettings(weekStart, sessionId);
      if (!ownsSession() || generation.current !== request) return;
      const next = weeklyRosterDraft(result);
      setData(result); setDraft(next); original.current = next;
    } catch (cause) {
      if (ownsSession() && generation.current === request) setError(inspectionError(cause, loadError.current).message);
    } finally { if (ownsSession() && generation.current === request) setLoading(false); }
  }, [ownsSession, sessionId, weekStart]);
  useEffect(() => { void load(); }, [load]);
  const changeWeek = (next: string) => {
    if (!ownsSession() || navigationBlocked) return;
    if (next === weekStart || (dirty && !window.confirm(common.discard))) { setWeekInput(weeklyRosterWeekInput(weekStart)); return; }
    generation.current += 1;
    setWeekStart(next); setWeekInput(weeklyRosterWeekInput(next)); setData(null);
    const empty = weeklyRosterDraft(); setDraft(empty); original.current = empty;
    setConflict(false); setLatest(null); setMessage(''); setError(''); setLoading(true);
  };
  const update = (key: string, patch: Partial<WeeklyRosterDraftPerson>) => {
    if (!ownsSession() || blocked) return;
    setDraft((previous) => ({ ...previous, [key]: { ...previous[key], ...patch } })); setMessage(''); setError('');
  };
  const run = async (attempt: NonNullable<typeof pending>) => {
    if (!ownsSession() || lock.current) return;
    lock.current = true; setBusy(true); setPending(attempt); setError(''); setMessage('');
    try {
      const result = await saveWeeklyInspectionRoleSettings(attempt.payload, attempt.key, sessionId, userId);
      if (!ownsSession()) return;
      accept(result); setPending(null); setMessage(text.saved);
    } catch (cause) {
      if (!ownsSession()) return;
      const failure = inspectionError(cause, common.failure);
      const code = (cause as { response?: { data?: { code?: string } } })?.response?.data?.code;
      const scheduleConflict = failure.conflict && (code === 'shift_overlap' || code === 'shift_schedule_ambiguous');
      setConflict(failure.conflict && !scheduleConflict);
      setError(scheduleConflict ? text.scheduleConflict : failure.conflict ? role.conflict : failure.uncertain ? role.uncertain : failure.message);
      if (!failure.uncertain) setPending(null);
    } finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ownsSession() || blocked || !dirty || !data) return;
    let payload: WeeklyRosterPayload;
    try { payload = weeklyRosterPayload(data, draft); }
    catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setError(code === 'weekly_same_person' ? text.samePerson : code === 'weekly_homonym_note_required' ? text.needsNote : code === 'weekly_person_unavailable' ? text.unavailable : text.invalid);
      return;
    }
    void run({ payload, key: createInspectionKey() });
  };
  const compare = async () => {
    if (!ownsSession() || busy || pending || lock.current) return;
    lock.current = true; setBusy(true);
    try { const result = await getWeeklyInspectionRoleSettings(weekStart, sessionId); if (ownsSession()) setLatest(result); }
    catch (cause) { if (ownsSession()) setError(inspectionError(cause, common.loadError).message); }
    finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const range = `${weekStart.replaceAll('-', '.')} (${text.monday}) — ${weeklyRosterAddDays(weekStart, 6).replaceAll('-', '.')} (${text.sunday})`;
  return <section className="inspection-detail inspection-weekly-settings" aria-labelledby="inspection-weekly-title" aria-busy={loading || busy}>
    <div className="inspection-detail-heading"><h2 id="inspection-weekly-title">{text.title}</h2><button type="button" className="inspection-button" disabled={busy || Boolean(pending) || legacyLock.locked} onClick={onClose}>{common.cancel}</button></div>
    <div className="inspection-weekly-toolbar">
      <label htmlFor="inspection-weekly-week">{text.week}<input id="inspection-weekly-week" type="week" value={weekInput} disabled={navigationBlocked} onChange={(event) => {
        if (!ownsSession()) return; const value = event.target.value; setWeekInput(value);
        const next = weeklyRosterWeekFromInput(value);
        if (next) changeWeek(next);
      }} onBlur={() => { if (ownsSession()) setWeekInput(weeklyRosterWeekInput(weekStart)); }} /></label>
      <div className="inspection-weekly-navigation"><button type="button" className="inspection-button" disabled={navigationBlocked} onClick={() => changeWeek(weeklyRosterAddDays(weekStart, -7))} aria-label={text.previous}>‹ <span>{text.previous}</span></button><button type="button" className="inspection-button" disabled={navigationBlocked || weekStart === currentWeeklyRosterWeek()} onClick={() => changeWeek(currentWeeklyRosterWeek())}>{text.current}</button><button type="button" className="inspection-button" disabled={navigationBlocked} onClick={() => changeWeek(weeklyRosterAddDays(weekStart, 7))} aria-label={text.next}><span>{text.next}</span> ›</button></div>
    </div>
    {loading && <p className="inspection-muted" role="status">{text.loading}</p>}
    {data?.can_configure === false && <p className="inspection-message" role="status">{text.denied}</p>}
    {error && <p className="inspection-message is-error" role="alert">{error}</p>}
    {message && <p className="inspection-message is-success" role="status">{message}</p>}
    {!data && !loading && <button type="button" className="inspection-button" onClick={() => void load()}>{text.reload}</button>}
    {pending && !busy && <button type="button" className="inspection-button" onClick={() => void run(pending)}>{role.retry}</button>}
    {conflict && <div className="inspection-message inspection-weekly-conflict"><button type="button" className="inspection-button" disabled={busy} onClick={() => void compare()}>{role.compare}</button>{latest && <><p>{text.latest}</p><ul>{WEEKLY_ROSTER_SLOTS.map((slot) => {
      const id = latest.slots.find((row) => row.shift === slot.shift && row.area === slot.area)?.inspector_id;
      const person = latest.roster.find((row) => row.id === id);
      return <li key={weeklyRosterSlotKey(slot)}>{role[slot.shift === 'DAY' ? 'day' : 'night']} · {role[slot.area]}: {person ? weeklyRosterPersonLabel(person) : text.choose}</li>;
    })}</ul><div className="inspection-actions"><button type="button" className="inspection-button" disabled={busy} onClick={() => {
      if (!ownsSession()) return; setData(latest); original.current = weeklyRosterDraft(latest); setConflict(false); setLatest(null); setError('');
    }}>{role.useDraft}</button><button type="button" className="inspection-button" disabled={busy} onClick={() => { if (ownsSession()) accept(latest); }}>{role.discard}</button></div></>}</div>}
    <form onSubmit={submit}>
      <div className="inspection-weekly-cards">
        {WEEKLY_ROSTER_SLOTS.map((slot) => {
          const key = weeklyRosterSlotKey(slot); const person = draft[key];
          const matches = weeklyRosterNameMatches(person.display_name, data?.roster || []);
          const draftHomonym = Boolean(normalizeWeeklyRosterName(person.display_name)) && Object.entries(draft).some(([otherKey, other]) => otherKey !== key && other.selection === 'new' && normalizeWeeklyRosterName(other.display_name) === normalizeWeeklyRosterName(person.display_name));
          return <fieldset className="inspection-weekly-card" key={key} disabled={blocked} data-weekly-slot={key}>
            <legend><span>{role[slot.shift === 'DAY' ? 'day' : 'night']}</span><strong>{role[slot.area]}</strong></legend>
            <div className="inspection-weekly-card-content">
              <label htmlFor={`inspection-weekly-${key}`}>{text.name}<select id={`inspection-weekly-${key}`} value={person.selection} onChange={(event) => update(key, { selection: event.target.value, display_name: '', distinguishing_note: '' })}>
                <option value="">{text.choose}</option>{data?.roster.filter((row) => row.active || String(row.id) === person.selection).map((row) => <option key={row.id} value={row.id}>{weeklyRosterPersonLabel(row)}</option>)}<option value="new">＋ {text.add}</option>
              </select></label>
              {person.selection === 'new' && <><label htmlFor={`inspection-weekly-${key}-name`}>{text.newName}<input id={`inspection-weekly-${key}-name`} autoComplete="off" required maxLength={128} value={person.display_name} onChange={(event) => update(key, { display_name: event.target.value, distinguishing_note: '' })} /></label>{(matches.length > 0 || draftHomonym) && <details className="inspection-weekly-homonym"><summary>{text.homonym}</summary><p>{matches.length ? text.reuse : text.draftHomonym}</p><label htmlFor={`inspection-weekly-${key}-note`}>{text.note}<input id={`inspection-weekly-${key}-note`} maxLength={64} placeholder={text.notePlaceholder} value={person.distinguishing_note} onChange={(event) => update(key, { distinguishing_note: event.target.value })} /></label></details>}</>}
              <div className="inspection-weekly-range"><span>{text.range}</span><output aria-label={`${role[slot.shift === 'DAY' ? 'day' : 'night']} ${role[slot.area]} ${text.range}`}>{range}</output></div>
            </div>
          </fieldset>;
        })}
      </div>
      <div className="inspection-weekly-save"><button type="submit" className="inspection-button is-primary" disabled={blocked || !dirty}>{busy ? common.busy : text.save}</button></div>
    </form>
    <details className="inspection-weekly-advanced" onToggle={(event) => { if (ownsSession() && event.currentTarget.open) setAdvancedOpen(true); }}><summary>{text.advanced}</summary><p>{text.fixedTimes}</p><p>{text.sundayNight}</p><p>{text.preserve}</p><details className="inspection-weekly-legacy"><summary>{text.detail}</summary>{advancedOpen && <fieldset className="inspection-weekly-legacy-fields" disabled={busy || Boolean(pending)}><LegacyRoleSettings {...props} onDirty={setLegacyDirty} onLocked={onLegacyLocked} /></fieldset>}</details></details>
  </section>;
}
