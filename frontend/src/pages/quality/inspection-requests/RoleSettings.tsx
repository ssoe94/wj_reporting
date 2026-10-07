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
const presetFor = (draft: SettingDraft): RoleShiftPreset => draft.start_time === '08:00' && draft.end_time === '20:00' ? 'day' : draft.start_time === '20:00' && draft.end_time === '08:00' ? 'night' : 'custom';

export default function RoleSettings({ userId, sessionId, lang, onDirty, onLocked, onClose }: { userId: number; sessionId: string | null; lang: 'ko' | 'zh'; onDirty: (dirty: boolean) => void; onLocked: (locked: boolean, pending: boolean) => void; onClose: () => void }) {
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
      const validation = code === 'shift_overlap' ? text.overlap : code === 'duplicate_shift_code' ? text.duplicate
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
    <p className="inspection-muted">{text.periodHint}</p><p className="inspection-muted">{text.preserveSnapshotHint}</p>
    <div className="inspection-actions">{data?.settings.map((setting) => <button type="button" className="inspection-button" key={setting.id} aria-pressed={selected?.id === setting.id} disabled={busy || Boolean(pending)} onClick={() => choose(setting)}>{setting.label} · {setting.start_time?.slice(0, 5) || '—'}–{setting.end_time?.slice(0, 5) || '—'} · {setting.effective_from_local?.replace('T', ' ') || '—'}{!setting.active ? ` · ${text.pending}` : ''}</button>)}<button type="button" className="inspection-button" disabled={busy || Boolean(pending) || data?.can_configure !== true} onClick={() => choose(null)}>{text.newSetting}</button></div>
    {data && !data.settings.length && <p className="inspection-muted">{text.noSettings}</p>}
    {data?.can_configure === false && <p role="status">{text.denied}</p>}
    {error && <p className="inspection-message is-error" role="alert">{error}</p>}{message && <p className="inspection-message is-success" role="status">{message}</p>}
    {pending && !busy && <button type="button" className="inspection-button" onClick={() => void run(pending)}>{text.retry}</button>}
    {conflict && <div className="inspection-message"><button type="button" className="inspection-button" disabled={busy} onClick={() => void compare()}>{text.compare}</button>{latest && <><p>{common.version} {selected?.version} → {latest.version} · {latest.label}</p><div className="inspection-actions"><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { setSelected(latest); original.current = settingDraft(latest); setPreset(presetFor(draft)); setConflict(false); setLatest(null); setError(''); } }}>{text.useDraft}</button><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { const next = settingDraft(latest); setSelected(latest); setDraft(next); setPreset(presetFor(next)); original.current = next; setConflict(false); setLatest(null); setError(''); } }}>{text.discard}</button></div></>}</div>}
    <form onSubmit={submit}><fieldset disabled={blocked} className="inspection-item"><legend>{selected ? text.editExisting : text.createPeriod}</legend><div className="inspection-form-grid">
      <label>{text.preset}<select id="inspection-shift-preset" value={preset} onChange={(event) => { if (!ownsSession() || blocked) return; const value = event.target.value as RoleShiftPreset; setPreset(value); if (value !== 'custom') update({ ...roleShiftPresetTimes(value), ...(!draft.label || [text.day, text.night].includes(draft.label) ? { label: text[value] } : {}) }); }}><option value="day">{text.day} · 08:00–20:00</option><option value="night">{text.night} · 20:00–{lang === 'ko' ? '다음날' : '次日'} 08:00</option><option value="custom">{text.custom}</option></select></label>
      <label>{text.label} *<input id="inspection-shift-label" required maxLength={128} value={draft.label} onChange={(event) => update({ label: event.target.value })} /></label>
      <p className="inspection-form-full inspection-muted">{text.chinaTime}</p>
      <label>{text.start}<input id="inspection-shift-start" type="time" required={draft.active} value={draft.start_time} onChange={(event) => { update({ start_time: event.target.value }); if (ownsSession() && !blocked) setPreset('custom'); }} /></label>
      <label>{text.end}<input id="inspection-shift-end" type="time" required={draft.active} value={draft.end_time} onChange={(event) => { update({ end_time: event.target.value }); if (ownsSession() && !blocked) setPreset('custom'); }} /></label>
      <label>{text.fromLocal}{draft.active ? ' *' : ''}<input id="inspection-shift-effective-from" type="datetime-local" step="60" required={draft.active} value={draft.effective_from_local} onChange={(event) => update({ effective_from_local: event.target.value })} /></label>
      <label>{text.untilLocal}<input id="inspection-shift-effective-until" type="datetime-local" step="60" value={draft.effective_until_local} onChange={(event) => update({ effective_until_local: event.target.value })} /><small>{text.untilOptional}</small></label>
      {(['appearance', 'dimension'] as const).map((area) => <label key={area}>{text[area]} · {text.owner}<select id={`inspection-shift-${area}-assignee`} value={draft[`${area}_assignee`]} required={draft.active} onChange={(event) => update({ [`${area}_assignee`]: event.target.value })}><option value="">{text.choose}</option>{data?.candidates.map((actor) => <option value={actor.id} key={actor.id}>{roleShiftActorLabel(actor, lang)}</option>)}</select></label>)}
      <p className="inspection-form-full inspection-muted">{text.accountHint}</p>
      {selected && <label className="inspection-form-full">{text.reason} *<textarea id="inspection-shift-change-reason" required maxLength={500} value={draft.reason} onChange={(event) => update({ reason: event.target.value })} /></label>}
    </div><label className="inspection-check"><input id="inspection-shift-active" type="checkbox" checked={draft.active} onChange={(event) => update({ active: event.target.checked })} />{text.active}</label></fieldset><p className="inspection-muted">{text.periodBoundaryHint}</p><button type="submit" className="inspection-button is-primary" disabled={blocked || !dirty}>{busy ? common.busy : text.saveSetting}</button></form>
    <details className="inspection-help"><summary><span aria-hidden="true">ⓘ</span> {text.utcRecord} · {text.internalCode}</summary><dl className="inspection-meta"><div><dt>{text.internalCode}</dt><dd>{draft.code}</dd></div><div><dt>{text.timezone}</dt><dd>{SHIFT_TIMEZONE}</dd></div><div><dt>{text.fromLocal}</dt><dd>{draft.effective_from_local?.replace('T', ' ') || '—'}</dd></div><div><dt>{text.untilLocal}</dt><dd>{draft.effective_until_local?.replace('T', ' ') || '—'}</dd></div>{selected && <><div><dt>{text.fromUTC}</dt><dd>{selected.effective_from || '—'}</dd></div><div><dt>{text.untilUTC}</dt><dd>{selected.effective_until || '—'}</dd></div></>}</dl></details>
  </section>;
}
