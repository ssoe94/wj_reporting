import { IntegrationTrialBadge } from './TrialPresentation';
import { isIntegrationTrial, integrationTrialCopy } from './integrationTrial';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import MesConnectionDialog from '@/components/MesConnectionDialog';
import { editableInspectionDraft, getInspectionRequest, inspectionDraftPayload, mutateInspectionRequest } from './api';
import type { InspectionCapabilities, InspectionDraft, InspectionMeasurement, InspectionRequest } from './api';
import { inspectionActionLabels, inspectionCopy, inspectionDataSourceCopy, inspectionMesObservationCopy, inspectionOperationLabels, inspectionRequestStatusLabels, inspectionTime, inspectionTypeLabels } from './copy';
import { createInspectionKey, inspectionError, inspectionMutationAttempt, inspectionRecoveryKey, inspectionRequiresMesConnection, parseInspectionRecovery, safeInspectionEvidenceUrl } from './workflow';
import type { InspectionAction, InspectionRecovery, MutationAttempt } from './workflow';
import { inspectionRequestKind } from './kanban';
import { inspectionKanbanCopy } from './kanbanCopy';
import { inspectionHasUnsavedWork, inspectionNextReconciliationRequired, inspectionRemoteReconciliationRequired } from './navigation';
import { inspectionMesMutationResult } from './mesWorkflowResult';

type InspectionEditorDraft = InspectionDraft & { review_reason_draft?: string };

function readRecovery(userId: number, requestId: number): InspectionRecovery<InspectionEditorDraft> | null {
  try {
    const recovery = parseInspectionRecovery<InspectionEditorDraft>(sessionStorage.getItem(inspectionRecoveryKey(userId, requestId)), userId, requestId);
    return recovery && Array.isArray(recovery.draft.measurements) && Array.isArray(recovery.draft.evidence) && typeof recovery.draft.notes === 'string' ? recovery : null;
  } catch { return null; }
}

export default function InspectionRequestDetail({ initial, userId, sessionId, lang, globalCapabilities, onChanged, onDirty, onLocked }: {
  initial: InspectionRequest; userId: number; sessionId: string | null; lang: 'ko' | 'zh'; globalCapabilities: InspectionCapabilities;
  onChanged: (request: InspectionRequest) => void; onDirty: (dirty: boolean) => void; onLocked: (locked: boolean, pending: boolean) => void;
}) {
  const text = inspectionCopy[lang];
  const dataSource = inspectionDataSourceCopy(lang, globalCapabilities.data_mode);
  const kanbanText = inspectionKanbanCopy[lang];
  const [request, setRequest] = useState(initial);
  const trial = isIntegrationTrial(request);
  const verdictCopy = trial ? integrationTrialCopy[lang] : { verdict: text.judgement, pass: text.pass, fail: text.fail };
  const [draft, setDraft] = useState(() => editableInspectionDraft(initial));
  const [version, setVersion] = useState(initial.version);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [attempt, setAttempt] = useState<MutationAttempt | null>(null);
  const [mesConnectionOpen, setMesConnectionOpen] = useState(false);
  const [recovery, setRecovery] = useState(() => readRecovery(userId, initial.id));
  const [reconciliationRequired, setReconciliationRequired] = useState(() => Boolean(readRecovery(userId, initial.id)?.reconciliation_required));
  const lock = useRef(false);
  const mounted = useRef(true);
  const ownsSession = useCallback(() => {
    if (!mounted.current) return false;
    try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; }
  }, [sessionId]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(editableInspectionDraft(request)), [draft, request]);
  const hasUnsavedWork = inspectionHasUnsavedWork(dirty, reason);
  const unresolved = Boolean(attempt) || Boolean(recovery?.attempt);
  const remoteUnresolved = reconciliationRequired || inspectionRemoteReconciliationRequired(request);
  const mesObservation = inspectionMesObservationCopy(lang, request, remoteUnresolved || unresolved);
  const disabled = busy || unresolved || conflict || needsReload || remoteUnresolved;
  const stagedMes = Boolean(request.mes_workflow && request.mes_workflow.phase !== 'unbound');
  const refreshDisabled = busy || unresolved || dirty || conflict || needsReload || (stagedMes
    ? !request.mes_workflow?.can_reconcile : !globalCapabilities.mes.can_refresh || !request.capabilities.can_refresh);
  const editable = request.capabilities.can_edit && !disabled;
  const unsafeEvidence = draft.evidence.some((item) => item.url && !safeInspectionEvidenceUrl(item.url)) || draft.measurements.some((item) => item.evidence_url && !safeInspectionEvidenceUrl(item.evidence_url));
  const persist = (changed: InspectionDraft, pending: MutationAttempt | null, baseVersion = version, reviewReason = reason, reconcile = reconciliationRequired) => {
    if (!ownsSession()) return;
    try { sessionStorage.setItem(inspectionRecoveryKey(userId, request.id), JSON.stringify({ schema: 1, user_id: userId, request_id: request.id, version: baseVersion, saved_at: Date.now(), draft: { ...changed, review_reason_draft: reviewReason }, attempt: pending, reconciliation_required: reconcile })); } catch { /* Optional per-tab recovery. */ }
  };
  const update = (patch: Partial<InspectionDraft>) => { if (!ownsSession()) return; const changed = { ...draft, ...patch }; setDraft(changed); setMessage(''); onDirty(inspectionHasUnsavedWork(JSON.stringify(changed) !== JSON.stringify(editableInspectionDraft(request)), reason)); persist(changed, attempt); };
  const updateReason = (value: string) => { if (!ownsSession()) return; setReason(value); onDirty(inspectionHasUnsavedWork(dirty, value)); persist(draft, attempt, version, value); };
  const updateMeasurement = (index: number, patch: Partial<InspectionMeasurement>) => update({ measurements: draft.measurements.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (ownsSession()) onDirty(hasUnsavedWork); }, [hasUnsavedWork, onDirty, ownsSession]);
  useEffect(() => { if (ownsSession()) onLocked(busy || unresolved || needsReload || remoteUnresolved, busy); }, [busy, unresolved, needsReload, remoteUnresolved, onLocked, ownsSession]);

  const adopt = (updated: InspectionRequest, reviewReason = '', refreshObservation?: InspectionRequest) => {
    if (!ownsSession()) return reconciliationRequired;
    const reconcile = inspectionNextReconciliationRequired(reconciliationRequired, refreshObservation ? { kind: 'scoped_refresh', observation: refreshObservation, latest: updated } : { kind: 'local_read' });
    setReconciliationRequired(reconcile);
    setRequest(updated); setDraft(editableInspectionDraft(updated)); setVersion(updated.version); setConflict(false); setNeedsReload(false); setAttempt(null); setRecovery(null); setReason(reviewReason);
    if (reviewReason || reconcile) persist(editableInspectionDraft(updated), null, updated.version, reviewReason, reconcile);
    else { try { sessionStorage.removeItem(inspectionRecoveryKey(userId, request.id)); } catch { /* Optional recovery. */ } }
    onChanged(updated);
    return reconcile;
  };
  const successes: Partial<Record<InspectionAction, string>> = { save: text.saved, submit: text.submitted, approve: text.approved, reject: text.rejectedMessage, reinspect: text.reinspected, refresh: text.refreshed, sync: text.synced, 'review-failure': text.approved, 'mes-save': text.mesStored, 'mes-finish': text.mesFinished, 'mes-reconcile': text.refreshed };
  const run = async (pending: MutationAttempt) => {
    if (lock.current || !ownsSession()) return;
    lock.current = true; onLocked(true, true); setBusy(true); setError(''); setMessage(''); setAttempt(pending); persist(draft, pending);
    try {
      const updated = await mutateInspectionRequest(request.id, pending, sessionId);
      if (!ownsSession()) return;
      let latest = updated;
      let reloadFailed = false;
      try { latest = await getInspectionRequest(updated.id, sessionId); } catch { reloadFailed = true; if (ownsSession()) setError(text.stateRefreshFailure); }
      if (!ownsSession()) return;
      const reconcile = adopt(latest, ['save', 'refresh'].includes(pending.action) ? reason : '', ['refresh', 'mes-reconcile'].includes(pending.action) ? updated : undefined);
      const mesResult = inspectionMesMutationResult(pending.action, updated, latest, reloadFailed);
      const stagedWrite = ['mes-save', 'mes-finish'].includes(pending.action);
      setNeedsReload(reloadFailed);
      if (stagedWrite && !mesResult && !reloadFailed) {
        setReconciliationRequired(true);
        persist(editableInspectionDraft(latest), null, latest.version, reason, true);
        setError(text.mesStageUnverified);
      }
      setMessage(reloadFailed || inspectionRemoteReconciliationRequired(latest) || reconcile || (stagedWrite && !mesResult) ? ''
        : mesResult === 'approval_pending' ? text.mesApprovalPending
          : pending.action === 'submit' && updated.status === 'failed' ? text.submittedFail : successes[pending.action] || '');
    } catch (cause) {
      if (!ownsSession()) return;
      const data = cause && typeof cause === 'object' && 'response' in cause ? (cause as { response?: { data?: { code?: string; request?: InspectionRequest } } }).response?.data : undefined;
      if (!remoteUnresolved && inspectionRequiresMesConnection(cause, pending, request) && data?.request) {
        // The server records that no provider write was dispatched. Keep the
        // user's draft and reason, accept its new version, and require a fresh
        // explicit stage click after reconnecting. Never resume from the dialog.
        const updated = data.request;
        setRequest(updated); setVersion(updated.version); setAttempt(null); setRecovery(null);
        setConflict(false); setNeedsReload(false); setError(text.mesReconnectRequired);
        persist(draft, null, updated.version, reason, reconciliationRequired);
        onChanged(updated); setMesConnectionOpen(true);
        return;
      }
      const failure = inspectionError(cause, text.failure, request.id);
      const reconcile = inspectionNextReconciliationRequired(reconciliationRequired, { kind: 'failure', reconciliation_required: failure.reconciliation_required });
      setReconciliationRequired(reconcile);
      setConflict(failure.conflict);
      setError(failure.conflict ? '' : `${failure.message}${failure.uncertain ? `\n${text.network}` : ''}${data?.code === 'mes_outcome_unknown' ? `\n${text.externalUnknown}` : ''}`);
      if (data?.request?.id === request.id) {
        setRequest(data.request); onChanged(data.request);
        if (!hasUnsavedWork && !failure.conflict && !failure.uncertain) { setVersion(data.request.version); setDraft(editableInspectionDraft(data.request)); }
      }
      if (!failure.uncertain) {
        setAttempt(null);
        if (!hasUnsavedWork && !failure.conflict && data?.request?.id === request.id && !reconcile) {
          try { sessionStorage.removeItem(inspectionRecoveryKey(userId, request.id)); } catch { /* Optional recovery. */ }
        } else {
          const serverDraft = !hasUnsavedWork && !failure.conflict && data?.request?.id === request.id ? data.request : null;
          persist(serverDraft ? editableInspectionDraft(serverDraft) : draft, null, serverDraft?.version ?? version, reason, reconcile);
        }
      }
    } finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const act = (action: InspectionAction) => {
    if (!ownsSession() || lock.current || (['refresh', 'mes-reconcile'].includes(action) ? refreshDisabled : disabled)) return;
    if (action === 'mes-finish' && !window.confirm(text.mesFinishConfirm)) return;
    if (action === 'save' && unsafeEvidence) { setError(text.unsafeEvidence); return; }
    if (['reject', 'reinspect', 'review-failure'].includes(action) && !reason.trim()) { setError(text.reasonRequired); return; }
    const payload = action === 'save' ? inspectionDraftPayload(draft, version, request.quantity_mode) : { version, reason: reason.trim() };
    void run(inspectionMutationAttempt(null, action, payload, () => createInspectionKey()));
  };
  const reload = async () => {
    if (!ownsSession() || lock.current || unresolved) return;
    if (hasUnsavedWork && !window.confirm(text.discard)) return;
    if (!ownsSession()) return;
    lock.current = true; onLocked(true, true); setBusy(true); setError('');
    try { const latest = await getInspectionRequest(request.id, sessionId); if (ownsSession()) { adopt(latest); setMessage(''); } } catch (cause) { if (ownsSession()) setError(inspectionError(cause, text.loadError).message); }
    finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const meta = (label: string, value: string | number | null | undefined, className?: string) => <div className={className}><dt>{label}</dt><dd>{value === null || value === undefined || value === '' ? '—' : value}</dd></div>;

  return <section className="inspection-detail" aria-labelledby="inspection-detail-title" aria-busy={busy}>
    {mesConnectionOpen && <MesConnectionDialog onClose={() => setMesConnectionOpen(false)} />}
    {globalCapabilities.data_mode !== 'wj_local_beta' && <p className="inspection-beta-context"><strong>{dataSource.notice}</strong></p>}
    {trial && <div className="inspection-trial-context"><IntegrationTrialBadge lang={lang} /><p>{integrationTrialCopy[lang].excluded}{request.mes_workflow?.qc_code ? ` · ${request.mes_workflow.phase === 'unbound' ? (lang === 'ko' ? '준비 코드 · MES 생성 전: ' : '准备代码 · MES 尚未创建：') : ''}${request.mes_workflow.qc_code}` : ''}</p>{request.mes_workflow?.test_label && <small>{request.mes_workflow.test_label}</small>}</div>}
    <div className="inspection-detail-heading"><div><small>{text.requestId} #{request.id}</small><h2 id="inspection-detail-title">{request.work_order_ref}</h2><p>{request.part_no} · {request.equipment_ref}</p></div><span className="inspection-status" data-status={request.status}>{inspectionRequestStatusLabels[lang][request.status]}</span></div>
    {message && <div className="inspection-message is-success" role="status">{message}</div>}
    {error && <div className="inspection-message is-error" role="alert">{error}</div>}
    {remoteUnresolved && <div className="inspection-message" role="status">{text.reconciliationRequired}</div>}
    {attempt && !busy && <div className="inspection-message"><p>{text.network}</p><button type="button" className="inspection-button" onClick={() => void run(attempt)}>{text.retryOperation}</button></div>}
    {recovery && <div className="inspection-message"><strong>{text.recovery}</strong><p>{recovery.attempt ? text.recoveryPending : text.recoveryHint}</p><div className="inspection-actions">
      <button type="button" className="inspection-button" disabled={busy} onClick={() => { if (!ownsSession()) return; const { review_reason_draft: recoveredReason, ...recoveredDraft } = recovery.draft; setDraft(recoveredDraft); setReason(typeof recoveredReason === 'string' ? recoveredReason : ''); setVersion(recovery.version); setAttempt(recovery.attempt); setConflict(recovery.version !== request.version && !recovery.attempt); setRecovery(null); }}>{text.restore}</button>
      {!recovery.attempt && !recovery.reconciliation_required && !remoteUnresolved && <button type="button" className="inspection-button" onClick={() => { if (!ownsSession()) return; try { sessionStorage.removeItem(inspectionRecoveryKey(userId, request.id)); } catch { /* Optional recovery. */ } setRecovery(null); }}>{text.discardRecovery}</button>}
    </div></div>}
    {conflict && <div className="inspection-message is-error" role="alert"><p>{text.conflict}</p><button type="button" className="inspection-button" disabled={busy || unresolved} onClick={() => void reload()}>{text.reload}</button></div>}
    {request.nonconformance && <section className="inspection-message" role="status">
      <strong>{lang === 'ko' ? '불량조치 미해결' : '不合格处置未解决'}</strong>
      <p>{request.nonconformance.owner_name} · {request.nonconformance.quantity ?? (lang === 'ko' ? '수량 미확인' : '数量未确认')} {request.nonconformance.uom}</p>
      <details className="inspection-help"><summary><span aria-hidden="true">ⓘ</span> {lang === 'ko' ? '불량조치 확인' : '不合格处置说明'}</summary><p>{lang === 'ko' ? 'QC 검사 완료와 불량조치 종료는 별도입니다. 특채·폐기·재작업의 MES 승인 및 재고 연동을 확인해야 합니다.' : 'QC 检验完成不代表不合格处置结束。需确认让步接收、报废及返工的 MES 审批和库存关联。'}</p></details>
    </section>}
    <dl className="inspection-meta inspection-snapshot">
      {meta(text.inspectionType, kanbanText[inspectionRequestKind(request)])}{meta(text.task, request.task_ref, 'inspection-snapshot-secondary')}{meta(text.quantity, `${request.target_quantity} ${request.uom}`)}
      {meta(text.owner, request.assigned_to_name || text.unassigned, 'inspection-snapshot-owner')}{meta(text.lot, request.lot_ref, 'inspection-snapshot-secondary')}{meta(text.createdAt, inspectionTime(request.created_at, lang), 'inspection-snapshot-secondary')}
    </dl>
    <details className="inspection-fold inspection-help"><summary><span aria-hidden="true">ⓘ</span> {lang === 'ko' ? '작업 정보·검사 기준' : '作业信息·检验规则'}</summary><dl className="inspection-meta">
      {meta(text.workOrder, request.work_order_ref)}{meta(text.task, request.task_ref)}{meta(text.part, request.part_no)}{meta(text.equipment, request.equipment_ref)}
      {meta(text.inspectionType, inspectionTypeLabels[lang][request.inspection_type])}{meta(text.quantity, `${request.target_quantity} ${request.uom}`)}
      {meta(text.quantityPolicy, request.quantity_mode === 'not_recorded' ? text.quantityNotRecorded : text.quantityRecorded)}{meta(text.evidence, request.require_evidence ? text.required : text.optional)}
      {meta(text.judgementPolicy, request.judgement_policy === 'independent' ? text.independentJudgement : text.strictItems)}
      {meta(text.uom, request.uom)}{meta(text.warehouse, request.warehouse_ref)}{meta(text.lot, request.lot_ref)}
      {meta(text.owner, request.assigned_to_name || text.unassigned)}{meta(text.source, globalCapabilities.data_mode === 'synthetic_preview' || request.source_kind === 'local_manual' ? dataSource.requests : request.source_kind)}{meta(text.version, request.version)}{request.parent && meta(text.parent, `#${request.parent}`)}
      {meta(text.workStarted, inspectionTime(request.work_started_at, lang))}{meta(text.createdAt, inspectionTime(request.created_at, lang))}{meta(text.updatedAt, inspectionTime(request.updated_at, lang))}
      {meta(text.submittedAt, inspectionTime(request.submitted_at, lang))}{meta(text.reviewedAt, inspectionTime(request.reviewed_at, lang))}
    </dl><p className="inspection-muted">{text.timezone} · {text.immutable}</p></details>
    <section className="inspection-section"><h3>{text.items}</h3>
      {!request.capabilities.can_edit && <p className="inspection-muted">{text.readOnly}</p>}
      {request.inspection_items.map((item, index) => {
        const measurement = draft.measurements[index];
        const safeLink = safeInspectionEvidenceUrl(measurement?.evidence_url || '');
        return <fieldset className="inspection-item" key={item.id} disabled={!editable}><legend>{index + 1}. {item.label}</legend>
          <p>{item.required !== false ? text.required : text.optional} · {item.kind === 'number' ? text.number : item.kind === 'choice' ? text.choice : text.text}{item.unit ? ` · ${item.unit}` : ''}{item.minimum ? ` · ${text.minimum}: ${item.minimum}` : ''}{item.maximum ? ` · ${text.maximum}: ${item.maximum}` : ''}{item.evidence_required ? ` · ${text.evidenceRequired}` : ''}</p>
          <div className="inspection-form-grid"><label>{text.measurement}{item.required !== false ? ' *' : ''}{item.kind === 'choice' ? <select value={measurement?.value || ''} onChange={(event) => updateMeasurement(index, { value: event.target.value })}><option value="">{text.choose}</option>{item.options?.map((option) => <option value={option} key={option}>{option}</option>)}</select> : <input maxLength={1000} inputMode={item.kind === 'number' ? 'decimal' : 'text'} value={measurement?.value || ''} onChange={(event) => updateMeasurement(index, { value: event.target.value })} />}</label>
            <label>{verdictCopy.verdict} · {item.required !== false ? text.required : text.requiredWhenFilled}<select value={measurement?.judgement || ''} onChange={(event) => updateMeasurement(index, { judgement: event.target.value as InspectionMeasurement['judgement'] })}><option value="">{text.choose}</option><option value="pass">{verdictCopy.pass}</option><option value="fail">{verdictCopy.fail}</option></select></label>
            <details className="inspection-form-full inspection-optional-field" open={item.evidence_required || Boolean(measurement?.evidence_url)}><summary>{text.itemEvidence} · {item.evidence_required ? text.required : text.optional}</summary><label>{text.itemEvidence}{item.evidence_required ? ' *' : ''}<input type="url" maxLength={500} value={measurement?.evidence_url || ''} autoCapitalize="none" spellCheck={false} onChange={(event) => updateMeasurement(index, { evidence_url: event.target.value })} /><small>{text.evidenceHint}</small></label></details>
          </div>{safeLink && <a href={safeLink} target="_blank" rel="noopener noreferrer">{text.openEvidence} <ExternalLink size={14} aria-hidden="true" /></a>}
        </fieldset>;
      })}
    </section>
    <details className="inspection-section inspection-fold" open={request.require_evidence || draft.evidence.length > 0}><summary>{text.evidence} · {request.require_evidence ? text.required : text.optional}</summary><p className="inspection-muted">{text.evidenceHint}</p>
      {draft.evidence.map((item, index) => {
        const safeLink = safeInspectionEvidenceUrl(item.url);
        return <div className={`inspection-evidence-row${item.url && !safeLink ? ' is-invalid' : ''}`} key={index}>
          <label>{text.evidenceName} {index + 1}<input maxLength={128} disabled={!editable} value={item.label} onChange={(event) => update({ evidence: draft.evidence.map((row, rowIndex) => rowIndex === index ? { ...row, label: event.target.value } : row) })} /></label>
          <label>{text.evidenceUrl}<input type="url" maxLength={500} disabled={!editable} value={item.url} autoCapitalize="none" spellCheck={false} onChange={(event) => update({ evidence: draft.evidence.map((row, rowIndex) => rowIndex === index ? { ...row, url: event.target.value } : row) })} /></label>
          <button type="button" className="inspection-button is-danger" disabled={!editable} aria-label={`${text.remove}: ${text.evidence} ${index + 1}`} onClick={() => update({ evidence: draft.evidence.filter((_, rowIndex) => rowIndex !== index) })}>{text.remove}</button>
          {safeLink && <a href={safeLink} target="_blank" rel="noopener noreferrer">{text.openEvidence}<ExternalLink size={14} aria-hidden="true" /></a>}
        </div>;
      })}<button type="button" className="inspection-button" disabled={!editable || draft.evidence.length >= 10} onClick={() => update({ evidence: [...draft.evidence, { label: '', url: '' }] })}><Plus size={16} aria-hidden="true" />{text.addEvidence}</button>
    </details>
    <section className="inspection-section"><h3>{request.quantity_mode === 'not_recorded' ? verdictCopy.verdict : trial ? verdictCopy.verdict : text.results}</h3><div className="inspection-form-grid">
      {request.quantity_mode === 'recorded' && (['inspected_quantity', 'accepted_quantity', 'rejected_quantity'] as const).map((name) => <label key={name}>{name === 'inspected_quantity' ? text.inspected : name === 'accepted_quantity' ? text.accepted : text.rejected} ({request.uom}) *<input inputMode="decimal" maxLength={30} disabled={!editable} value={draft[name]} onChange={(event) => update({ [name]: event.target.value })} /></label>)}
      <label>{verdictCopy.verdict} *<select disabled={!editable} value={draft.judgement} onChange={(event) => update({ judgement: event.target.value as InspectionDraft['judgement'] })}><option value="">{text.choose}</option><option value="pass">{verdictCopy.pass}</option><option value="fail">{verdictCopy.fail}</option></select></label>
      <label className="inspection-form-full">{text.notes}<textarea maxLength={2000} disabled={!editable} value={draft.notes} onChange={(event) => update({ notes: event.target.value })} /></label>
    </div><details className="inspection-help"><summary><span aria-hidden="true">ⓘ</span> {text.judgementPolicy}</summary><p>{request.judgement_policy === 'independent' ? text.independentHint : text.strictHint}</p><p>{request.quantity_mode === 'not_recorded' ? text.quantityNotRecordedHint : text.quantityHint}</p></details>
      {dirty && <p className="inspection-muted" role="status">{text.dirty} {text.saveFirst}</p>}
      <div className="inspection-actions"><button type="button" className="inspection-button" disabled={!editable || !dirty || unsafeEvidence} onClick={() => act('save')}>{busy ? text.busy : text.save}</button>
        <button type="button" className="inspection-button is-primary" disabled={disabled || dirty || !request.capabilities.can_submit} onClick={() => act('submit')}>{text.submit}</button>
        <button type="button" className="inspection-button" disabled={busy || unresolved} onClick={() => void reload()}><RefreshCw size={16} aria-hidden="true" />{text.reload}</button>
      </div>{unsafeEvidence && <p className="inspection-muted" role="alert">{text.unsafeEvidence}</p>}
    </section>
    <details className="inspection-section inspection-fold" open={request.capabilities.can_review || request.capabilities.can_reinspect}><summary>{text.review}</summary><details className="inspection-help"><summary><span aria-hidden="true">ⓘ</span> {lang === 'ko' ? '검수 기준' : '审核规则'}</summary><p>{text.independent}</p></details>
      {request.review_reason && <p className="inspection-message">{text.reviewReason}: {request.review_reason}</p>}
      <label>{text.reason}<textarea disabled={disabled || (!request.capabilities.can_review && !request.capabilities.can_reinspect)} maxLength={500} value={reason} placeholder={text.reasonHint} onChange={(event) => updateReason(event.target.value)} /></label>
      <div className="inspection-actions" style={{ marginTop: 12 }}>
        {request.capabilities.can_review_failure && <button type="button" className="inspection-button" disabled={disabled || dirty || request.submitted_by === userId || !reason.trim()} onClick={() => act('review-failure')}>{lang === 'ko' ? '불합격 결과 검수 승인' : '审核不合格检验结果'}</button>}
        <button type="button" className="inspection-button is-primary" disabled={disabled || dirty || !request.capabilities.can_review || request.submitted_by === userId} onClick={() => act('approve')}>{text.approve}</button>
        <button type="button" className="inspection-button is-danger" disabled={disabled || dirty || !request.capabilities.can_review || request.submitted_by === userId || !reason.trim()} onClick={() => act('reject')}>{text.reject}</button>
        <button type="button" className="inspection-button" disabled={disabled || dirty || !request.capabilities.can_reinspect || !reason.trim()} onClick={() => act('reinspect')}>{text.reinspect}</button>
      </div>
    </details>
    <section className="inspection-section" aria-labelledby="inspection-mes-title"><h3 id="inspection-mes-title">{text.mes}</h3>
      {mesObservation.hint && <p className="inspection-message" role="status">{mesObservation.hint}</p>}
      <dl className="inspection-meta">
      {meta(text.syncStatus, mesObservation.sync)}{meta(text.mesCompletion, mesObservation.completion)}
      {meta(text.mesQcStatus, mesObservation.qc)}{meta(text.mesChecked, mesObservation.checkedAt)}
    </dl>
      {!globalCapabilities.mes.enabled && request.mes_workflow?.phase !== 'completed' && <p className="inspection-muted" role="status">{lang === 'ko' ? '이 검사요청의 MES 처리 준비가 필요합니다.' : '此检验申请需准备 MES 处理。'}</p>}
      <div className="inspection-actions inspection-mes-actions">
        <button type="button" className={`inspection-button${!disabled && !dirty && request.mes_workflow?.can_save ? ' is-primary' : ''}`} disabled={disabled || dirty || !request.mes_workflow?.can_save} onClick={() => act('mes-save')}>{text.mesSave}</button>
        <button type="button" className={`inspection-button${!disabled && !dirty && request.mes_workflow?.can_finish ? ' is-primary' : ''}`} disabled={disabled || dirty || !request.mes_workflow?.can_finish} onClick={() => act('mes-finish')}>{text.mesFinish}</button>
        <button type="button" className={`inspection-button${remoteUnresolved && !refreshDisabled ? ' is-primary' : ''}`} disabled={refreshDisabled} onClick={() => act(stagedMes ? 'mes-reconcile' : 'refresh')}>{text.refreshMes}</button>
      </div>
      <details className="inspection-help"><summary><span aria-hidden="true">ⓘ</span> {lang === 'ko' ? 'MES 처리·입고 안내' : 'MES 处理·入库说明'}</summary><p>{text.mesStageHint}</p>
        <dl className="inspection-meta">{meta(text.receiptReadiness, mesObservation.readiness)}{meta(text.mesTaskStatus, mesObservation.task)}{meta(text.externalResult, request.external_result_id)}{meta(text.errorCode, request.last_error_code)}</dl>
        {mesObservation.priorReadiness && <p>{text.receiptReadiness} · {mesObservation.priorReadiness}</p>}<p>{text.receiptHint}</p>
        {!globalCapabilities.mes.enabled && <p>{dataSource.hint}</p>}
        {request.mes_workflow?.test_label && <p>{text.mesTestLabel}: {request.mes_workflow.test_label}</p>}
      </details>
    </section>
    <details className="inspection-section inspection-fold"><summary>{text.history} ({request.audit.length})</summary>{request.audit.length ? <ol className="inspection-history">{request.audit.map((item) => <li key={item.id}><strong>{inspectionActionLabels[lang][item.action] || item.action}</strong> · {item.actor_name} · {text.version} {item.version}<p>{item.reason}</p><small>{inspectionTime(item.created_at, lang)}</small></li>)}</ol> : <p className="inspection-muted">{text.noHistory}</p>}</details>
    <details className="inspection-section inspection-fold"><summary>{text.operations} ({request.operations.length})</summary>{request.operations.length ? <ol className="inspection-history">{request.operations.map((item) => { const action = item.scope.split(':').slice(-1)[0]; return <li key={item.id}><strong>{inspectionActionLabels[lang][action] || action}</strong> · <span className="inspection-status" data-status={item.status}>{inspectionOperationLabels[lang][item.status] || item.status}</span><p>{item.response_status ? `HTTP ${item.response_status} · ` : ''}{inspectionTime(item.created_at, lang)}</p></li>; })}</ol> : <p className="inspection-muted">{text.noOperations}</p>}</details>
  </section>;
}
