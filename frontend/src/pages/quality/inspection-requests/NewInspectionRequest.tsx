import { useCallback, useEffect, useRef, useState } from 'react';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import type { FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { inspectionCopy, inspectionDataSourceCopy, inspectionTypeLabels } from './copy';
import { inspectionCreatePayload, mutateInspectionRequest } from './api';
import type { InspectionCreate, InspectionDataMode, InspectionItem, InspectionRequest } from './api';
import { createInspectionKey, inspectionError, inspectionMutationAttempt, inspectionRecoveryKey, parseInspectionRecovery } from './workflow';
import type { InspectionRecovery, MutationAttempt } from './workflow';

function newItem(): InspectionItem { return { id: createInspectionKey(), label: '', kind: 'text', unit: '', required: true, evidence_required: false }; }
function emptyRequest(): InspectionCreate {
  return { work_order_ref: '', task_ref: '', part_no: '', equipment_ref: '', inspection_type: 'first', target_quantity: '', uom: '', warehouse_ref: '', lot_ref: '', work_started_at: '', inspection_items: [newItem()], require_evidence: false, quantity_mode: 'recorded', judgement_policy: 'strict_items' };
}

export default function NewInspectionRequest({ userId, sessionId, lang, dataMode, onCreated, onCancel, onDirty, onLocked }: { userId: number; sessionId: string | null; lang: 'ko' | 'zh'; dataMode: InspectionDataMode; onCreated: (item: InspectionRequest) => void; onCancel: () => void; onDirty: (dirty: boolean) => void; onLocked: (locked: boolean, pending: boolean) => void }) {
  const text = inspectionCopy[lang];
  const dataSource = inspectionDataSourceCopy(lang, dataMode);
  const [form, setForm] = useState<InspectionCreate>(emptyRequest);
  const original = useRef(form);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<MutationAttempt | null>(null);
  const [optionInputs, setOptionInputs] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const mounted = useRef(true);
  const ownsSession = useCallback(() => {
    if (!mounted.current) return false;
    try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; }
  }, [sessionId]);
  const [recovery, setRecovery] = useState<InspectionRecovery<InspectionCreate> | null>(() => {
    try { return parseInspectionRecovery<InspectionCreate>(sessionStorage.getItem(inspectionRecoveryKey(userId, 0)), userId, 0); } catch { return null; }
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(original.current);
  const blocked = busy || Boolean(attempt) || Boolean(recovery?.attempt);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (ownsSession()) onDirty(dirty); }, [dirty, onDirty, ownsSession]);
  useEffect(() => { if (ownsSession()) onLocked(blocked, busy); }, [blocked, busy, onLocked, ownsSession]);

  const persist = (draft: InspectionCreate, pending: MutationAttempt | null) => {
    if (!ownsSession()) return;
    try { sessionStorage.setItem(inspectionRecoveryKey(userId, 0), JSON.stringify({ schema: 1, user_id: userId, request_id: 0, version: 0, saved_at: Date.now(), draft, attempt: pending })); } catch { /* Storage can be disabled; server remains authoritative. */ }
  };
  const update = (patch: Partial<InspectionCreate>) => { if (!ownsSession()) return; const changed = { ...form, ...patch }; setForm(changed); onDirty(JSON.stringify(changed) !== JSON.stringify(original.current)); persist(changed, attempt); };
  const updateItem = (index: number, patch: Partial<InspectionItem>) => update({ inspection_items: form.inspection_items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  const run = async (pending: MutationAttempt) => {
    if (lock.current || !ownsSession()) return;
    lock.current = true; onLocked(true, true); setBusy(true); setError(''); setAttempt(pending); persist(form, pending);
    try {
      const created = await mutateInspectionRequest(0, pending, sessionId);
      if (!ownsSession()) return;
      try { sessionStorage.removeItem(inspectionRecoveryKey(userId, 0)); } catch { /* Optional recovery. */ }
      setAttempt(null); onCreated(created);
    } catch (cause) {
      if (!ownsSession()) return;
      const failure = inspectionError(cause, text.failure);
      setError(`${failure.message}${failure.uncertain ? `\n${text.network}` : ''}`);
      if (!failure.uncertain) { setAttempt(null); persist(form, null); }
    } finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ownsSession() || attempt || recovery?.attempt) return;
    if (!form.inspection_items.length || form.inspection_items.some((item) => !item.label.trim())) { setError(text.templateRequired); return; }
    const started = new Date(form.work_started_at);
    if (Number.isNaN(started.getTime())) { setError(text.startedInvalid); return; }
    const payload = inspectionCreatePayload(form);
    void run(inspectionMutationAttempt(null, 'create', payload, () => createInspectionKey()));
  };
  const field = (name: keyof Pick<InspectionCreate, 'work_order_ref' | 'task_ref' | 'part_no' | 'equipment_ref' | 'uom' | 'warehouse_ref' | 'lot_ref'>, label: string) => (
    <label>{label} *<input required maxLength={name === 'uom' ? 32 : 128} value={form[name]} disabled={blocked} onChange={(event) => update({ [name]: event.target.value })} /></label>
  );

  return <section className="inspection-detail" aria-labelledby="inspection-new-title">
    <p className="inspection-beta-context"><strong>{dataSource.notice}</strong><span>{text.source}: {dataSource.requests}</span></p>
    <h2 id="inspection-new-title">{text.create}</h2><p className="inspection-muted">{text.createHint}</p>
    {recovery && <div className="inspection-message"><strong>{text.recovery}</strong><p>{recovery.attempt ? text.recoveryPending : text.recoveryHint}</p><div className="inspection-actions">
      <button type="button" className="inspection-button" onClick={() => { if (!ownsSession()) return; setForm(recovery.draft); setAttempt(recovery.attempt); setRecovery(null); }}>{text.restore}</button>
      {!recovery.attempt && <button type="button" className="inspection-button" onClick={() => { if (!ownsSession()) return; try { sessionStorage.removeItem(inspectionRecoveryKey(userId, 0)); } catch { /* Optional recovery. */ } setRecovery(null); }}>{text.discardRecovery}</button>}
    </div></div>}
    {error && <div role="alert" className="inspection-message is-error">{error}</div>}
    {attempt && !busy && <div className="inspection-message"><p>{text.network}</p><button className="inspection-button" type="button" onClick={() => void run(attempt)}>{text.retryOperation}</button></div>}
    <form onSubmit={submit}>
      <fieldset disabled={blocked} className="inspection-item"><legend>{text.workOrder} / {text.task}</legend><div className="inspection-form-grid">
        {field('work_order_ref', text.workOrder)}{field('task_ref', text.task)}{field('part_no', text.part)}{field('equipment_ref', text.equipment)}
        <label>{text.inspectionType}<select value={form.inspection_type} onChange={(event) => update({ inspection_type: event.target.value as InspectionCreate['inspection_type'] })}>{(['first', 'process', 'final'] as const).map((kind) => <option value={kind} key={kind}>{inspectionTypeLabels[lang][kind]}</option>)}</select></label>
        <label>{text.quantity} *<input required inputMode="decimal" maxLength={30} value={form.target_quantity} onChange={(event) => update({ target_quantity: event.target.value })} /></label>
        {field('uom', text.uom)}{field('warehouse_ref', text.warehouse)}{field('lot_ref', text.lot)}
        <label>{text.workStarted} *<input required type="datetime-local" value={form.work_started_at} onChange={(event) => update({ work_started_at: event.target.value })} /><small>{lang === 'ko' ? '입력 시간은 이 기기의 현지 시간입니다.' : '输入时间为此设备的本地时间。'}</small></label>
        <label>{text.quantityPolicy}<select value={form.quantity_mode} onChange={(event) => update({ quantity_mode: event.target.value as InspectionCreate['quantity_mode'] })}><option value="recorded">{text.quantityRecorded}</option><option value="not_recorded">{text.quantityNotRecorded}</option></select></label>
        <label>{text.judgementPolicy}<select value={form.judgement_policy} onChange={(event) => update({ judgement_policy: event.target.value as InspectionCreate['judgement_policy'] })}><option value="strict_items">{text.strictItems}</option><option value="independent">{text.independentJudgement}</option></select><small>{form.judgement_policy === 'independent' ? text.independentHint : text.strictHint}</small></label>
      </div><label className="inspection-check"><input type="checkbox" checked={form.require_evidence} onChange={(event) => update({ require_evidence: event.target.checked })} />{text.commonEvidenceRequired}</label></fieldset>
      <section className="inspection-section"><h3>{text.items}</h3>
        {form.inspection_items.map((item, index) => <fieldset className="inspection-item" disabled={blocked} key={item.id}><legend>{text.itemName} {index + 1}</legend><div className="inspection-form-grid">
          <label>{text.itemName} *<input required maxLength={128} value={item.label} onChange={(event) => updateItem(index, { label: event.target.value })} /></label>
          <label>{text.kind}<select value={item.kind} onChange={(event) => updateItem(index, { kind: event.target.value as InspectionItem['kind'] })}><option value="text">{text.text}</option><option value="number">{text.number}</option><option value="choice">{text.choice}</option></select></label>
          {item.kind === 'choice' && <label className="inspection-form-full">{text.options} *<input required maxLength={2580} value={optionInputs[item.id] ?? item.options?.join(', ') ?? ''} onChange={(event) => { if (!ownsSession()) return; setOptionInputs((previous) => ({ ...previous, [item.id]: event.target.value })); updateItem(index, { options: event.target.value.split(/[,，]/).map((option) => option.trim()).filter(Boolean) }); }} /><small>{text.optionsHint}</small></label>}
          <label>{text.itemUnit}<input maxLength={32} value={item.unit} onChange={(event) => updateItem(index, { unit: event.target.value })} /></label>
          {item.kind === 'number' && <><label>{text.minimum}<input inputMode="decimal" maxLength={30} value={item.minimum || ''} onChange={(event) => updateItem(index, { minimum: event.target.value })} /></label><label>{text.maximum}<input inputMode="decimal" maxLength={30} value={item.maximum || ''} onChange={(event) => updateItem(index, { maximum: event.target.value })} /></label></>}
        </div><label className="inspection-check"><input type="checkbox" checked={item.required} onChange={(event) => updateItem(index, { required: event.target.checked })} />{text.measurementRequired}</label><label className="inspection-check"><input type="checkbox" checked={item.evidence_required} onChange={(event) => updateItem(index, { evidence_required: event.target.checked })} />{text.evidenceRequired}</label>
          <button type="button" className="inspection-button is-danger" disabled={blocked || form.inspection_items.length === 1} aria-label={`${text.remove}: ${text.itemName} ${index + 1}`} onClick={() => update({ inspection_items: form.inspection_items.filter((_, itemIndex) => itemIndex !== index) })}>{text.remove}</button>
        </fieldset>)}
        <button type="button" className="inspection-button" disabled={blocked || form.inspection_items.length >= 50} onClick={() => update({ inspection_items: [...form.inspection_items, newItem()] })}><Plus size={16} aria-hidden="true" />{text.addItem}</button>
      </section>
      <div className="inspection-actions inspection-section"><button type="submit" className="inspection-button is-primary" disabled={blocked}>{busy ? text.busy : text.create}</button><button type="button" className="inspection-button" disabled={blocked} onClick={onCancel}>{text.cancel}</button></div>
    </form>
  </section>;
}
