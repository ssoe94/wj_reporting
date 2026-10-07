import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { getInspectionRoleSettings, saveInspectionRoleSetting } from './api';
import { inspectionCopy } from './copy';
import { inspectionRoleCopy } from './roleCopy';
import type { InspectionRoleSetting, InspectionRoleSettings } from './roleModel';
import { createInspectionKey, inspectionError } from './workflow';

type SettingDraft = { code: string; label: string; timezone: string; start_time: string; end_time: string; appearance_assignee: string; dimension_assignee: string; active: boolean; reason: string };
const emptyDraft = (): SettingDraft => ({ code: '', label: '', timezone: '', start_time: '', end_time: '', appearance_assignee: '', dimension_assignee: '', active: false, reason: '' });
const settingDraft = (setting: InspectionRoleSetting): SettingDraft => ({ code: setting.code, label: setting.label, timezone: setting.timezone, start_time: setting.start_time?.slice(0, 5) || '', end_time: setting.end_time?.slice(0, 5) || '', appearance_assignee: setting.appearance_assignee === null ? '' : String(setting.appearance_assignee), dimension_assignee: setting.dimension_assignee === null ? '' : String(setting.dimension_assignee), active: setting.active, reason: '' });

export default function RoleSettings({ userId, sessionId, lang, onDirty, onLocked, onClose }: { userId: number; sessionId: string | null; lang: 'ko' | 'zh'; onDirty: (dirty: boolean) => void; onLocked: (locked: boolean, pending: boolean) => void; onClose: () => void }) {
  const text = inspectionRoleCopy[lang];
  const common = inspectionCopy[lang];
  const [data, setData] = useState<InspectionRoleSettings | null>(null);
  const [selected, setSelected] = useState<InspectionRoleSetting | null>(null);
  const [draft, setDraft] = useState<SettingDraft>(emptyDraft);
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
    setSelected(setting); setDraft(next); original.current = next; setConflict(false); setLatest(null); setError(''); setMessage('');
  };
  const update = (patch: Partial<SettingDraft>) => { if (ownsSession() && !blocked) { setDraft({ ...draft, ...patch }); setMessage(''); } };
  const run = async (attempt: NonNullable<typeof pending>) => {
    if (!ownsSession() || lock.current) return;
    lock.current = true; setBusy(true); setPending(attempt); setError('');
    try {
      const result = await saveInspectionRoleSetting(attempt.id, attempt.payload, attempt.key, sessionId, userId);
      if (!ownsSession()) return;
      const next = settingDraft(result); setSelected(result); setDraft(next); original.current = next; setPending(null); setConflict(false); setLatest(null); setMessage(text.saved);
      setData((previous) => previous ? { ...previous, settings: [...previous.settings.filter((row) => row.id !== result.id), result] } : previous);
    } catch (cause) {
      if (!ownsSession()) return;
      const failure = inspectionError(cause, common.failure);
      setConflict(failure.conflict); setError(failure.conflict ? text.conflict : failure.uncertain ? text.uncertain : failure.message);
      if (!failure.uncertain) setPending(null);
    } finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ownsSession() || blocked || !dirty) return;
    if (!draft.code.trim() || !draft.label.trim() || (selected && !draft.reason.trim()) || (draft.active && (!draft.timezone.trim() || !draft.start_time || !draft.end_time || !draft.appearance_assignee || !draft.dimension_assignee || draft.appearance_assignee === draft.dimension_assignee))) { setError(text.invalid); return; }
    const payload = { ...(selected ? { version: selected.version, reason: draft.reason.trim() } : { code: draft.code.trim() }), label: draft.label.trim(), ...(draft.timezone.trim() ? { timezone: draft.timezone.trim() } : {}), start_time: draft.start_time || null, end_time: draft.end_time || null, appearance_assignee: draft.appearance_assignee ? Number(draft.appearance_assignee) : null, dimension_assignee: draft.dimension_assignee ? Number(draft.dimension_assignee) : null, active: draft.active };
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
    <p className="inspection-muted">{text.configurationHint}</p>
    <div className="inspection-actions">{data?.settings.map((setting) => <button type="button" className="inspection-button" key={setting.id} aria-pressed={selected?.id === setting.id} disabled={busy || Boolean(pending)} onClick={() => choose(setting)}>{setting.label}{!setting.active ? ` · ${text.pending}` : ''}</button>)}<button type="button" className="inspection-button" disabled={busy || Boolean(pending) || data?.can_configure !== true} onClick={() => choose(null)}>{text.newSetting}</button></div>
    {data && !data.settings.length && <p className="inspection-muted">{text.noSettings}</p>}
    {data?.can_configure === false && <p role="status">{text.denied}</p>}
    {error && <p className="inspection-message is-error" role="alert">{error}</p>}{message && <p className="inspection-message is-success" role="status">{message}</p>}
    {pending && !busy && <button type="button" className="inspection-button" onClick={() => void run(pending)}>{text.retry}</button>}
    {conflict && <div className="inspection-message"><button type="button" className="inspection-button" disabled={busy} onClick={() => void compare()}>{text.compare}</button>{latest && <><p>{common.version} {selected?.version} → {latest.version} · {latest.label}</p><div className="inspection-actions"><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { setSelected(latest); original.current = settingDraft(latest); setConflict(false); setLatest(null); setError(''); } }}>{text.useDraft}</button><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { const next = settingDraft(latest); setSelected(latest); setDraft(next); original.current = next; setConflict(false); setLatest(null); setError(''); } }}>{text.discard}</button></div></>}</div>}
    <form onSubmit={submit}><fieldset disabled={blocked} className="inspection-item"><div className="inspection-form-grid">
      <label>{lang === 'ko' ? '교대 코드' : '班次代码'} *<input required maxLength={64} disabled={Boolean(selected) || blocked} value={draft.code} onChange={(event) => update({ code: event.target.value })} /></label>
      <label>{text.label} *<input required maxLength={128} value={draft.label} onChange={(event) => update({ label: event.target.value })} /></label>
      <label>{text.timezone}<input maxLength={64} value={draft.timezone} placeholder="Asia/Shanghai" onChange={(event) => update({ timezone: event.target.value })} /></label>
      <label>{text.start}<input type="time" value={draft.start_time} onChange={(event) => update({ start_time: event.target.value })} /></label>
      <label>{text.end}<input type="time" value={draft.end_time} onChange={(event) => update({ end_time: event.target.value })} /></label>
      {(['appearance', 'dimension'] as const).map((area) => <label key={area}>{text[area]} · {text.owner}<select value={draft[`${area}_assignee`]} onChange={(event) => update({ [`${area}_assignee`]: event.target.value })}><option value="">{text.choose}</option>{data?.candidates.map((actor) => <option value={actor.id} key={actor.id}>{actor.name}</option>)}</select></label>)}
      {selected && <label className="inspection-form-full">{text.reason} *<textarea required maxLength={500} value={draft.reason} onChange={(event) => update({ reason: event.target.value })} /></label>}
    </div><label className="inspection-check"><input type="checkbox" checked={draft.active} onChange={(event) => update({ active: event.target.checked })} />{text.active}</label></fieldset><button type="submit" className="inspection-button is-primary" disabled={blocked || !dirty}>{busy ? common.busy : text.saveSetting}</button></form>
  </section>;
}
