import { inspectionDisplayLabel } from './displayLabel';
import InspectionMeasurementVerdict from './InspectionMeasurementVerdict';
import { inspectionChoiceLabel, inspectionMeasurementPatch } from './measurementJudgement';
import InspectionFinalJudgementDialog from './InspectionFinalJudgementDialog';
import type { FinalInspectionChoice } from './InspectionFinalJudgementDialog';
import { inspectionEntryReady, inspectionEntryCount } from './inspectionEntryFlow';
import InspectionAuxiliaryTabs from './InspectionAuxiliaryTabs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { assertAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { getInspectionRequest, getInspectionRoleSettings, mutateInspectionRequest, mutateInspectionRole } from './api';
import type { InspectionCapabilities, InspectionEvidence, InspectionMeasurement, InspectionRequest } from './model';
import { inspectionCopy, inspectionMesObservationCopy, inspectionHistoryActionLabel, inspectionHistoryResultLabel, inspectionRequestStatusLabels, inspectionTime } from './copy';
import { inspectionRoleCopy } from './roleCopy';
import { inspectionRequiredAreasPresent, inspectionAreas, inspectionWorksheetAreas, inspectionRoleActorPayload, inspectionRoleAreaActorAllowed, inspectionRoleFinalJudgement, inspectionRoleItemEditable, inspectionRoleMappingValid, inspectionRoleMeasurements, inspectionRoleReconcileDraft, inspectionRoleSavePayload, inspectionRoleSuggestedItemAreas } from './roleModel';
import type { InspectionArea, InspectionRoleAction, InspectionRoleSettings } from './roleModel';
import { inspectionConfirmsScopedRefresh, inspectionRemoteReconciliationRequired } from './navigation';
import { createInspectionKey, inspectionError, safeInspectionEvidenceUrl } from './workflow';
import type { InspectionAction } from './workflow';
import { roleShiftDateCovered } from './roleShiftSettingsModel';

type Attempt = { kind: 'role' | 'legacy'; action: InspectionRoleAction | InspectionAction; payload: Record<string, unknown>; key: string };
type SummaryDraft = { inspected_quantity: string; accepted_quantity: string; rejected_quantity: string; notes: string };
type DraftRecovery = { schema: 1; user_id: number; request_id: number; saved_at: number; request_version: number; config_version: number; area_versions: Record<string, number>; measurements: InspectionMeasurement[]; evidence: Record<InspectionArea, InspectionEvidence[]>; summary: SummaryDraft; reason: string; judgements: Record<InspectionArea, '' | 'pass' | 'fail'>; shift_id: string; shift_date: string; item_areas: Record<string, string>; shared_terminal?: boolean; reconciliation_required?: boolean; whole_operation_id?: number | null; attempt: Attempt | null };
const summaryDraft = (request: InspectionRequest): SummaryDraft => ({ inspected_quantity: request.inspected_quantity || '', accepted_quantity: request.accepted_quantity || '', rejected_quantity: request.rejected_quantity || '', notes: request.notes || '' });
const areaEvidence = (request: InspectionRequest): Record<InspectionArea, InspectionEvidence[]> => ({ appearance: request.role_workflow?.areas.find((row) => row.area === 'appearance')?.evidence || [], dimension: request.role_workflow?.areas.find((row) => row.area === 'dimension')?.evidence || [] });
const recoveryKey = (userId: number, requestId: number) => `wj-inspection-role-draft:v1:${userId}:${requestId}`;
function readRecovery(userId: number, requestId: number): DraftRecovery | null {
  try {
    const raw = sessionStorage.getItem(recoveryKey(userId, requestId));
    if (!raw) return null;
    const value = JSON.parse(raw) as DraftRecovery;
    if (value.schema !== 1 || value.user_id !== userId || value.request_id !== requestId || !Array.isArray(value.measurements) || !value.evidence || !Array.isArray(value.evidence.appearance) || !Array.isArray(value.evidence.dimension) || !value.summary || !Number.isSafeInteger(value.request_version) || !Number.isSafeInteger(value.config_version) || !value.area_versions || !Number.isFinite(value.saved_at) || value.saved_at > Date.now() || (!value.attempt && value.reconciliation_required !== true && Date.now() - value.saved_at > 86_400_000)) return null;
    if (value.reconciliation_required !== undefined && typeof value.reconciliation_required !== 'boolean') return null;
    if (value.whole_operation_id != null && (!Number.isSafeInteger(value.whole_operation_id) || value.whole_operation_id <= 0)) return null;
    if (value.attempt && (!['role-configure', 'area-save', 'area-complete', 'area-reopen', 'role-results', 'submit', 'approve', 'reject', 'reinspect', 'review-failure', 'mes-full-save', 'mes-full-finish', 'mes-full-reconcile'].includes(value.attempt.action) || !['role', 'legacy'].includes(value.attempt.kind) || !/^[0-9a-f-]{36}$/i.test(value.attempt.key) || !value.attempt.payload || typeof value.attempt.payload !== 'object')) return null;
    return value;
  } catch { return null; }
}

export default function RoleInspectionRequestDetail({ initial, userId, sessionId, lang, globalCapabilities, onChanged, onDirty, onLocked, onOpenSettings }: {
  initial: InspectionRequest; userId: number; sessionId: string | null; lang: 'ko' | 'zh'; globalCapabilities: InspectionCapabilities;
  onChanged: (request: InspectionRequest) => void; onDirty: (dirty: boolean) => void; onLocked: (locked: boolean, pending: boolean) => void; onOpenSettings?: () => void;
}) {
  const text = inspectionRoleCopy[lang]; const common = inspectionCopy[lang];
  const [request, setRequest] = useState(initial);
  const workflow = request.role_workflow!;
  const [measurements, setMeasurements] = useState(() => inspectionRoleMeasurements(initial));
  const [evidence, setEvidence] = useState(() => areaEvidence(initial));
  const [summary, setSummary] = useState(() => summaryDraft(initial));
  const [reason, setReason] = useState('');
  const [judgements, setJudgements] = useState<Record<InspectionArea, '' | 'pass' | 'fail'>>({ appearance: '', dimension: '' });
  const [settings, setSettings] = useState<InspectionRoleSettings | null>(null);
  const [shiftId, setShiftId] = useState('');
  const [shiftDate, setShiftDate] = useState('');
  const [sharedTerminal, setSharedTerminal] = useState(true);
  const [itemAreas, setItemAreas] = useState<Record<string, string>>(() => ({ ...(initial.role_workflow?.configured ? {} : inspectionRoleSuggestedItemAreas(initial.inspection_items)), ...initial.role_workflow?.item_areas }));
  const [onlyUnfilled, setOnlyUnfilled] = useState(false);
  const [finalOpen, setFinalOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null); const [conflict, setConflict] = useState(false); const [needsReload, setNeedsReload] = useState(false); const [latest, setLatest] = useState<InspectionRequest | null>(null);
  const [recovery, setRecovery] = useState(() => readRecovery(userId, initial.id));
  const [reconciliationRequired, setReconciliationRequired] = useState(() => inspectionRemoteReconciliationRequired(initial) || recovery?.reconciliation_required === true);
  const mounted = useRef(true); const lock = useRef(false);
  const baseVersions = useRef({ request_version: initial.version, config_version: initial.role_workflow!.config_version, area_versions: Object.fromEntries(initial.role_workflow!.areas.map((area) => [area.area, area.version])) });
  const ownsSession = useCallback(() => { if (!mounted.current) return false; try { assertAuthSessionCurrent(sessionId); return true; } catch { return false; } }, [sessionId]);
  const originalRows = useMemo(() => inspectionRoleMeasurements(request), [request]);
  const areaDirty = (area: InspectionArea) => JSON.stringify(measurements.filter((row) => workflow.item_areas[row.item_id] === area)) !== JSON.stringify(originalRows.filter((row) => workflow.item_areas[row.item_id] === area)) || JSON.stringify(evidence[area]) !== JSON.stringify(areaEvidence(request)[area]);
  const summaryDirty = JSON.stringify(summary) !== JSON.stringify(summaryDraft(request));
  const dataDirty = inspectionAreas.some(areaDirty) || summaryDirty;
  const dirty = dataDirty || Boolean(reason.trim()) || Boolean(shiftId) || Boolean(shiftDate) || (!workflow.configured && !sharedTerminal) || JSON.stringify(itemAreas) !== JSON.stringify(workflow.item_areas);
  const blocked = finalizing || busy || Boolean(attempt) || conflict || needsReload || Boolean(recovery) || reconciliationRequired;
  const finalJudgement = inspectionRoleFinalJudgement(workflow);
  const mesUnresolved = Boolean(attempt) || conflict || needsReload || Boolean(recovery) || reconciliationRequired || inspectionRemoteReconciliationRequired(request);
  const mesObservation = inspectionMesObservationCopy(lang, request, mesUnresolved);
  const canSummaryEdit = globalCapabilities.can_manage === true && request.assigned_to === userId && request.status === 'draft' && !['pending', 'unknown', 'succeeded'].includes(request.sync_status) && request.mes_completion_status !== 'completed' && !blocked;
  const canConfigure = !workflow.configured && workflow.can_configure === true && globalCapabilities.can_manage_role_settings === true;
  const activeSettings = settings?.settings.filter((setting) => setting.active) || [];
  const worksheetItems = inspectionWorksheetAreas.flatMap((area) => request.inspection_items.filter((item) => workflow.item_areas[item.id] === area));
  const visibleWorksheetItems = worksheetItems.filter((item) => !onlyUnfilled || !measurements.find((row) => row.item_id === item.id)?.value.trim() || !measurements.find((row) => row.item_id === item.id)?.judgement);
  const areasSaved = inspectionRequiredAreasPresent(request.inspection_items, workflow.item_areas) && inspectionEntryReady(request.inspection_items, originalRows) && (!request.require_evidence || inspectionAreas.every((area) => areaEvidence(request)[area].length > 0));
  const canFinalise = globalCapabilities.can_submit !== false && (workflow.areas.some((area) => area.status !== 'complete') || request.capabilities.can_submit) && request.status === 'draft' && request.assigned_to === userId && !dirty && areasSaved && workflow.areas.every((area) => area.status === 'complete' || (area.can_complete && inspectionRoleAreaActorAllowed(workflow, area.area, userId)));
  const areaProgress = Object.fromEntries(inspectionWorksheetAreas.map((area) => {
    const items = request.inspection_items.filter((item) => workflow.item_areas[item.id] === area);
    return [area, { total: items.length, entered: inspectionEntryCount(items, measurements), saved: items.filter((item) => { const row = measurements.find((entry) => entry.item_id === item.id); const stored = originalRows.find((entry) => entry.item_id === item.id); return stored?.value.trim() && stored.judgement && JSON.stringify(row) === JSON.stringify(stored); }).length, inspector: workflow.areas.find((row) => row.area === area)?.assigned_to_name }];
  })) as Record<InspectionArea, { total: number; entered: number; saved: number; inspector?: string }>;

  const persist = (pending: Attempt | null = attempt) => {
    if (!ownsSession()) return;
    try { sessionStorage.setItem(recoveryKey(userId, request.id), JSON.stringify({ schema: 1, user_id: userId, request_id: request.id, saved_at: Date.now(), ...baseVersions.current, measurements, evidence, summary, reason, judgements, shift_id: shiftId, shift_date: shiftDate, item_areas: itemAreas, shared_terminal: sharedTerminal, reconciliation_required: reconciliationRequired, whole_operation_id: request.mes_workflow?.operation_id || null, attempt: pending })); } catch { /* Optional, per-account and per-tab recovery. */ }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (ownsSession()) onDirty(dirty || Boolean(recovery)); }, [dirty, recovery, onDirty, ownsSession]);
  useEffect(() => { if (ownsSession()) onLocked(finalizing || busy || Boolean(attempt) || Boolean(recovery?.attempt) || needsReload || reconciliationRequired, busy); }, [finalizing, busy, attempt, recovery, needsReload, reconciliationRequired, onLocked, ownsSession]);
  useEffect(() => {
    if (!ownsSession() || !canConfigure) return;
    let active = true;
    void getInspectionRoleSettings(sessionId).then((result) => { if (active && ownsSession()) setSettings(result); }).catch((cause) => { if (active && ownsSession()) setError(inspectionError(cause, common.loadError).message); });
    return () => { active = false; };
  }, [canConfigure, common.loadError, ownsSession, sessionId]);
  useEffect(() => {
    if (!ownsSession() || recovery) return;
    if (dirty || attempt || reconciliationRequired) persist(attempt);
    else { try { sessionStorage.removeItem(recoveryKey(userId, request.id)); } catch { /* Optional recovery. */ } }
  });
  const adopt = (updated: InspectionRequest, action?: Attempt['action'], preserveDraft = false, savedArea?: InspectionArea) => {
    if (!ownsSession() || updated.id !== request.id || !updated.role_workflow) return;
    const keepAreaDrafts = preserveDraft || action === 'role-results' || action?.startsWith('area-') === true;
    const draftAreas = preserveDraft ? inspectionAreas : inspectionAreas.filter(areaDirty);
    const concurrentDraftAreas = keepAreaDrafts && !preserveDraft ? draftAreas.filter((area) => area !== savedArea && updated.role_workflow!.areas.find((row) => row.area === area)?.version !== workflow.areas.find((row) => row.area === area)?.version) : [];
    const previousVersions = baseVersions.current.area_versions;
    baseVersions.current = { request_version: updated.version, config_version: updated.role_workflow.config_version, area_versions: Object.fromEntries(updated.role_workflow.areas.map((area) => [area.area, concurrentDraftAreas.includes(area.area) ? previousVersions[area.area] : area.version])) };
    setRequest(updated); onChanged(updated);
    setReconciliationRequired((previous) => previous || inspectionRemoteReconciliationRequired(updated));
    setMeasurements(keepAreaDrafts ? inspectionRoleReconcileDraft(measurements, updated, userId, savedArea, draftAreas) : inspectionRoleMeasurements(updated));
    if (keepAreaDrafts) { const freshEvidence = areaEvidence(updated); setEvidence(Object.fromEntries(inspectionAreas.map((area) => [area, area !== savedArea && draftAreas.includes(area) && inspectionRoleAreaActorAllowed(updated.role_workflow!, area, userId) && updated.role_workflow!.areas.find((row) => row.area === area)?.can_save ? evidence[area] : freshEvidence[area]])) as Record<InspectionArea, InspectionEvidence[]>); } else setEvidence(areaEvidence(updated));
    if (!preserveDraft && (action === 'role-results' || !summaryDirty)) setSummary(summaryDraft(updated));
    if (!preserveDraft || updated.role_workflow.configured) { setItemAreas({ ...updated.role_workflow.item_areas }); setShiftId(''); setShiftDate(''); }
    setJudgements((previous) => Object.fromEntries(inspectionAreas.map((area) => [area, keepAreaDrafts && (area !== savedArea || action === 'area-save') && inspectionRoleAreaActorAllowed(updated.role_workflow!, area, userId) && updated.role_workflow!.areas.find((row) => row.area === area)?.can_complete ? previous[area] : ''])) as Record<InspectionArea, '' | 'pass' | 'fail'>); setAttempt(null); setConflict(concurrentDraftAreas.length > 0); setNeedsReload(false); setLatest(null); setRecovery(null); if (!keepAreaDrafts) setReason('');
    return concurrentDraftAreas.length > 0;
  };
  const run = async (pending: Attempt) => {
    if (!ownsSession() || lock.current) return;
    lock.current = true; onLocked(true, true); setBusy(true); setAttempt(pending); setError(''); setMessage(''); persist(pending);
    try {
      const updated = pending.kind === 'role'
        ? await mutateInspectionRole(request.id, { action: pending.action as InspectionRoleAction, payload: pending.payload, key: pending.key }, sessionId)
        : await mutateInspectionRequest(request.id, { action: pending.action as InspectionAction, payload: pending.payload, key: pending.key }, sessionId);
      if (!ownsSession()) return;
      if (pending.action === 'reinspect' && updated.id !== request.id) {
        setAttempt(null); setRecovery(null); try { sessionStorage.removeItem(recoveryKey(userId, request.id)); } catch { /* Optional recovery. */ }
        onChanged(updated); return;
      }
      let current = updated; let reloadFailed = false;
      try { current = await getInspectionRequest(updated.id, sessionId); } catch { reloadFailed = true; }
      if (!ownsSession()) return;
      if (pending.action.startsWith('mes-full-')) {
        setReconciliationRequired(!inspectionConfirmsScopedRefresh(updated) || !inspectionConfirmsScopedRefresh(current));
      }
      const concurrentConflict = adopt(current, pending.action, false, inspectionAreas.includes(pending.payload.area as InspectionArea) ? pending.payload.area as InspectionArea : undefined);
      if (reloadFailed) { setNeedsReload(true); setError(common.stateRefreshFailure); } else if (concurrentConflict) setError(text.conflict); else { setMessage(text.saved);
        if (pending.action === 'area-save') {
          const ready = inspectionRequiredAreasPresent(current.inspection_items, current.role_workflow!.item_areas) && inspectionEntryReady(current.inspection_items, inspectionRoleMeasurements(current)) && (!current.require_evidence || inspectionAreas.every((area) => areaEvidence(current)[area].length));
          const otherDrafts = inspectionAreas.some((area) => area !== pending.payload.area && areaDirty(area));
          if (globalCapabilities.can_submit !== false && current.status === 'draft' && current.role_workflow!.areas.every((area) => area.status === 'complete' || (area.can_complete && inspectionRoleAreaActorAllowed(current.role_workflow!, area.area, userId))) && ready && !otherDrafts && !summaryDirty && !reason.trim() && current.assigned_to === userId) setFinalOpen(true);

        }
        if (current.status !== 'draft') setFinalOpen(false);
        return current;
      }
    } catch (cause) {
      if (!ownsSession()) return;
      const failure = inspectionError(cause, common.failure, request.id);
      setConflict(failure.conflict); setError(failure.conflict ? text.conflict : failure.uncertain ? text.uncertain : failure.message);
      if (pending.action.startsWith('mes-full-') && (failure.uncertain || failure.reconciliation_required)) setReconciliationRequired(true);
      if (!failure.uncertain && !failure.reconciliation_required) { setAttempt(null); persist(null); }
      if (pending.action.startsWith('mes-full-')) {
        try {
          const current = await getInspectionRequest(request.id, sessionId);
          if (ownsSession() && !dataDirty) { setRequest(current); onChanged(current); }
        } catch { /* Keep the pending key and known state until an explicit read succeeds. */ }
      }
    } finally { lock.current = false; if (ownsSession()) setBusy(false); }
  };
  const send = (action: Attempt['action'], payload: Record<string, unknown>, kind: Attempt['kind'] = 'role') => { if (ownsSession() && !blocked) void run({ kind, action, payload, key: createInspectionKey() }); };
  const updateMeasurement = (itemId: string, patch: Partial<InspectionMeasurement>) => { if (!ownsSession() || blocked || !inspectionRoleItemEditable(workflow, itemId, userId)) return; setMeasurements((rows) => rows.map((row) => row.item_id === itemId ? { ...row, ...inspectionMeasurementPatch(request.inspection_items.find((item) => item.id === itemId)!, workflow.item_areas[itemId], patch) } : row)); setMessage(''); };
  const nextMeasurement = (itemId: string, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || blocked || !ownsSession()) return;
    const next = visibleWorksheetItems.slice(visibleWorksheetItems.findIndex((item) => item.id === itemId) + 1).find((item) => workflow.item_areas[item.id] === workflow.item_areas[itemId] && inspectionRoleItemEditable(workflow, item.id, userId));
    if (!next) return;
    event.preventDefault();
    const index = request.inspection_items.findIndex((item) => item.id === next.id);
    const input = document.getElementById(`inspection-item-${request.id}-${index}-value`);
    input?.focus();
  };
  const saveArea = (area: InspectionArea) => {
    if (!areaDirty(area)) { if (canFinalise) setFinalOpen(true); return; }
    try {
      const payload = inspectionRoleSavePayload(workflow, area, userId, measurements, evidence[area]);
      if ((payload.measurements as InspectionMeasurement[]).some((row) => row.evidence_url && !safeInspectionEvidenceUrl(row.evidence_url)) || evidence[area].some((row) => row.url && !safeInspectionEvidenceUrl(row.url))) { setError(common.unsafeEvidence); return; }
      send('area-save', payload);
    } catch { setError(text.noPermission); }
  };
  const confirmFinal = async (choice: FinalInspectionChoice, finalReason: string) => {
    if (blocked || !canFinalise) return;
    setFinalizing(true); let current = request;
    try {
      for (const area of inspectionWorksheetAreas) {
        const state = current.role_workflow!.areas.find((row) => row.area === area)!;
        if (state.status === 'complete') continue;
        const result = await run({ kind: 'role', action: 'area-complete', key: createInspectionKey(), payload: { area, area_version: state.version, config_version: current.role_workflow!.config_version, ...inspectionRoleActorPayload(current.role_workflow!, area, userId), judgement: state.measurements.some((row) => row.value.trim() && row.judgement === 'fail') ? 'fail' : 'pass' } });
        if (!result || !ownsSession()) return;
        current = result;
      }
      await run({ kind: 'legacy', action: 'submit', key: createInspectionKey(), payload: { version: current.version, judgement: choice, reason: finalReason } });
    } finally { if (ownsSession()) setFinalizing(false); }
  };
  const compare = async () => {
    if (!ownsSession() || busy || (attempt && !attempt.action.startsWith('mes-full-'))) return;
    setBusy(true);
    try {
      const result = await getInspectionRequest(request.id, sessionId);
      if (ownsSession()) {
        setLatest(result);
        if (attempt?.action.startsWith('mes-full-') && !dataDirty) {
          setRequest(result); onChanged(result);
          setReconciliationRequired((previous) => previous || inspectionRemoteReconciliationRequired(result));
        }
      }
    }
    catch (cause) { if (ownsSession()) setError(inspectionError(cause, common.loadError).message); }
    finally { if (ownsSession()) setBusy(false); }
  };
  const configure = () => {
    const shift = activeSettings.find((setting) => String(setting.id) === shiftId);
    if (!shift || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDate) || !inspectionRoleMappingValid(request.inspection_items.map((item) => item.id), itemAreas) || !reason.trim()) { setError(text.mappingInvalid); return; }
    if (!roleShiftDateCovered(shift, shiftDate)) { setError(text.outsidePeriod); return; }
    send('role-configure', { config_version: workflow.config_version, shift_setting_id: shift.id, shift_version: shift.version, shift_date: shiftDate, item_areas: itemAreas, shared_terminal: sharedTerminal, reason: reason.trim() });
  };
  const historyRows = [
    ...request.audit.map((row) => ({ key: `audit-${row.id}`, at: row.created_at, actor: row.actor_name || '—', action: inspectionHistoryActionLabel(lang, row.action), result: inspectionHistoryResultLabel(lang, row.action, row.status) })),
    ...request.operations.map((row) => ({ key: `operation-${row.id}`, at: row.created_at, actor: '—', action: inspectionHistoryActionLabel(lang, row.scope.split(':').slice(-1)[0]), result: inspectionHistoryResultLabel(lang, '', row.status, true) })),
  ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const whole = request.mes_workflow?.mode === 'whole_snapshot' ? request.mes_workflow : undefined;
  const wholeReady = Boolean(whole?.source_digest) && !blocked && !dataDirty && !mesUnresolved;
  return <section className="inspection-detail inspection-role-detail" aria-labelledby="inspection-detail-title" aria-busy={busy}>
    {finalOpen && <InspectionFinalJudgementDialog lang={lang} busy={busy || finalizing} blocked={blocked || !canFinalise} error={error} passAllowed={!measurements.some((row) => row.judgement === 'fail')} concessionEnabled={true} onClose={() => setFinalOpen(false)} onConfirm={(choice, finalReason) => void confirmFinal(choice, finalReason)} />}
    <div className="inspection-detail-heading"><div><h2 id="inspection-detail-title">{request.part_no || request.work_order_ref || common.requests}</h2><p>{text.title}{workflow.shift_snapshot?.label ? ` · ${inspectionDisplayLabel(workflow.shift_snapshot.label, lang)}` : ''}</p><span className="inspection-status" data-status={request.status}>{inspectionRequestStatusLabels[lang][request.status]}</span></div><section className="inspection-mes-strip" aria-label={common.mes}>
      <div className="inspection-mes-states" role="status" title={`${common.mesChecked}: ${mesObservation.checkedAt}`}>
        <span className="inspection-mes-chip" data-state={mesUnresolved ? 'unknown' : request.sync_status}><span>{common.mesSyncShort}</span><strong>{mesObservation.sync}</strong></span>
        <span className="inspection-mes-chip" data-state={mesUnresolved ? 'unknown' : request.mes_completion_status}><span>{common.mesCompletionShort}</span><strong>{mesObservation.completion}</strong></span>
      </div>
      <div className="inspection-actions"><button type="button" className="inspection-button" disabled={!wholeReady || !whole?.can_save} title={whole?.enabled ? text.mesHint : text.mesBlocked} onClick={() => send('mes-full-save', { source_digest: whole?.source_digest }, 'legacy')}>{text.mesPartial}</button><button type="button" className="inspection-button" disabled={!wholeReady || !whole?.can_finish} title={whole?.enabled ? text.mesHint : text.mesBlocked} onClick={() => send('mes-full-finish', { source_digest: whole?.source_digest }, 'legacy')}>{common.mesFinish}</button>{whole?.can_reconcile && whole.operation_id && <button type="button" className="inspection-button" disabled={busy || finalizing || dataDirty || Boolean(recovery)} onClick={() => { if (ownsSession()) void run({ kind: 'legacy', action: 'mes-full-reconcile', payload: { operation_id: whole.operation_id }, key: createInspectionKey() }); }}>{common.reload}</button>}</div>
    </section>{message && <span className="inspection-role-save-feedback" role="status">{message}</span>}</div>{workflow.configured && <><div className="inspection-role-sheet-toolbar">
        {workflow.shared_terminal?.enabled && <span className="inspection-role-terminal"><strong>{text.terminal}</strong> · {text.terminalOperator}: {workflow.shared_terminal.operator_name || '—'}</span>}
        <label className="inspection-checkbox"><input id="inspection-role-only-unfilled" type="checkbox" checked={onlyUnfilled} onChange={(event) => setOnlyUnfilled(event.target.checked)} />{text.onlyUnfilled}</label>
      </div></>}
    {error && <p className="inspection-message is-error" role="alert">{error}</p>}
    {attempt && !busy && <div className="inspection-message"><p>{text.uncertain}</p><button type="button" className="inspection-button" onClick={() => attempt.action.startsWith('mes-full-') ? void compare() : void run(attempt)}>{attempt.action.startsWith('mes-full-') ? common.reload : text.retry}</button></div>}
    {recovery && <div className="inspection-message inspection-recovery-message"><strong>{common.recovery}</strong><p>{common.recoveryHint}</p><div className="inspection-actions"><button type="button" className="inspection-button" onClick={() => { if (!ownsSession()) return; baseVersions.current = { request_version: recovery.request_version, config_version: recovery.config_version, area_versions: recovery.area_versions }; setMeasurements(recovery.measurements); setEvidence(recovery.evidence); setSummary(recovery.summary); setReason(recovery.reason); setJudgements(recovery.judgements || { appearance: '', dimension: '' }); setShiftId(recovery.shift_id || ''); setShiftDate(recovery.shift_date || ''); setItemAreas(recovery.item_areas || {}); setSharedTerminal(recovery.shared_terminal !== false); setAttempt(recovery.attempt); setConflict(recovery.request_version !== request.version || recovery.config_version !== workflow.config_version || workflow.areas.some((area) => recovery.area_versions[area.area] !== area.version)); setRecovery(null); }}>{common.restore}</button>{!recovery.attempt && <button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { setRecovery(null); try { sessionStorage.removeItem(recoveryKey(userId, request.id)); } catch { /* Optional recovery. */ } } }}>{common.discardRecovery}</button>}</div></div>}
    {conflict && <div className="inspection-message"><p>{text.conflict}</p><button type="button" className="inspection-button" disabled={busy} onClick={() => void compare()}>{text.compare}</button>{latest?.role_workflow && <><p>{common.version} {request.version} → {latest.version}</p><div className="inspection-table-scroll"><table className="inspection-history-table"><thead><tr><th>{common.itemName}</th><th>{lang === 'ko' ? '내 입력' : '我的输入'}</th><th>{lang === 'ko' ? '현재 저장 값' : '当前保存值'}</th></tr></thead><tbody>{measurements.filter((row) => workflow.item_areas[row.item_id] && inspectionRoleAreaActorAllowed(workflow, workflow.item_areas[row.item_id], userId)).map((row) => <tr key={row.item_id}><td>{request.inspection_items.find((item) => item.id === row.item_id)?.label}</td><td>{row.value || '—'} · {row.judgement || '—'}</td><td>{inspectionRoleMeasurements(latest).find((item) => item.item_id === row.item_id)?.value || '—'} · {inspectionRoleMeasurements(latest).find((item) => item.item_id === row.item_id)?.judgement || '—'}</td></tr>)}</tbody></table></div><div className="inspection-actions"><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { adopt(latest, undefined, true); setError(''); } }}>{text.useDraft}</button><button type="button" className="inspection-button" onClick={() => { if (ownsSession()) { setSummary(summaryDraft(latest)); adopt(latest); setError(''); } }}>{text.discard}</button></div></>}</div>}
    {!workflow.configured && <section className="inspection-section"><h3>{text.configuration}</h3><p className="inspection-muted">{text.empty}</p><p className="inspection-muted">{text.configurationHint}</p>{onOpenSettings && <button type="button" className="inspection-button" disabled={blocked} onClick={onOpenSettings}>{text.settings}</button>}{!canConfigure && <p>{text.denied}</p>}{canConfigure && <fieldset disabled={blocked}><label>{lang === 'ko' ? '검사 교대 날짜' : '检验班次日期'} *<input id="inspection-role-shift-date" type="date" value={shiftDate} onChange={(event) => { if (ownsSession()) setShiftDate(event.target.value); }} /></label><label>{text.label}<select id="inspection-role-shift-setting" value={shiftId} onChange={(event) => { if (ownsSession()) setShiftId(event.target.value); }}><option value="">{text.choose}</option>{activeSettings.map((shift) => <option key={shift.id} value={shift.id}>{inspectionDisplayLabel(shift.label, lang)} · {shift.start_time?.slice(0, 5)}–{shift.end_time?.slice(0, 5)} · {shift.timezone} · {shift.effective_from_local?.replace('T', ' ') || '—'}–{shift.effective_until_local?.replace('T', ' ') || '∞'}</option>)}</select></label>{settings && !activeSettings.length && <p>{text.noSettings}</p>}{shiftId && shiftDate && !activeSettings.some((shift) => String(shift.id) === shiftId && roleShiftDateCovered(shift, shiftDate)) && <p role="status" className="inspection-message">{text.outsidePeriod}</p>}<div className="inspection-form-grid">{request.inspection_items.map((item) => <label key={item.id}>{inspectionDisplayLabel(item.label, lang)}<select value={itemAreas[item.id] || ''} onChange={(event) => { if (ownsSession()) setItemAreas({ ...itemAreas, [item.id]: event.target.value }); }}><option value="">{text.choose}</option>{inspectionAreas.map((area) => <option key={area} value={area}>{text[area]}</option>)}</select></label>)}</div><p className="inspection-muted">{text.mappingSuggestion}</p><label className="inspection-checkbox inspection-role-terminal-option"><input id="inspection-role-shared-terminal" type="checkbox" checked={sharedTerminal} onChange={(event) => { if (ownsSession()) setSharedTerminal(event.target.checked); }} />{text.sharedTerminal}</label><p className="inspection-muted">{text.sharedTerminalHint}</p><label className="inspection-reason-field">{text.reason}<textarea maxLength={500} value={reason} onChange={(event) => { if (ownsSession()) setReason(event.target.value); }} /></label><button type="button" className="inspection-button is-primary" disabled={blocked || !shiftId || !shiftDate || !reason.trim() || !activeSettings.some((shift) => String(shift.id) === shiftId && roleShiftDateCovered(shift, shiftDate))} onClick={configure}>{text.configure}</button></fieldset>}</section>}
    {workflow.configured && <section className="inspection-section inspection-role-workspace" aria-label={text.worksheet}>
      <div className="inspection-area-cards" data-card-count={inspectionWorksheetAreas.length}>{inspectionWorksheetAreas.map((cardArea) => <section key={cardArea} className="inspection-area-card" data-card-area={cardArea} aria-labelledby={`inspection-card-${request.id}-${cardArea}`}>
        <header className="inspection-area-card-heading"><h3 id={`inspection-card-${request.id}-${cardArea}`}>{text[cardArea]}</h3><span>{areaProgress[cardArea].inspector || text.unassigned}</span><span className="inspection-area-card-progress">{lang === 'ko' ? '입력' : '录入'} {areaProgress[cardArea].entered}/{areaProgress[cardArea].total} · {lang === 'ko' ? '저장' : '保存'} {areaProgress[cardArea].saved}/{areaProgress[cardArea].total}</span></header>
      <div className="inspection-table-scroll inspection-role-sheet-scroll" role="region" aria-label={`${text[cardArea]} · ${text.worksheet}`} tabIndex={0}>
        <table className="inspection-items-table inspection-role-worksheet"><caption className="sr-only">{text[cardArea]} · {text.worksheet}</caption>
          <colgroup><col style={{ width: '5%' }} /><col style={{ width: '33%' }} /><col style={{ width: '24%' }} /><col style={{ width: '26%' }} /><col style={{ width: '12%' }} /></colgroup><thead><tr><th scope="col">#</th><th scope="col">{common.itemName} · {common.criteriaUnit}</th><th scope="col">{common.measurement}</th><th scope="col">{common.judgement}</th><th scope="col">{text.savedState}</th></tr></thead>
          <tbody>{visibleWorksheetItems.filter((item) => workflow.item_areas[item.id] === cardArea).map((item) => {
            const index = request.inspection_items.findIndex((entry) => entry.id === item.id);
            const area = workflow.item_areas[item.id];
            const state = workflow.areas.find((entry) => entry.area === area);
            const row = measurements.find((entry) => entry.item_id === item.id);
            const saved = originalRows.find((entry) => entry.item_id === item.id);
            const changed = JSON.stringify(row) !== JSON.stringify(saved);
            const savedValue = Boolean(saved?.value.trim() || saved?.judgement || saved?.evidence_url);
            const rowState = changed ? 'unsaved' : savedValue ? 'saved' : 'empty';
            const editable = !blocked && inspectionRoleItemEditable(workflow, item.id, userId);
            const valueId = `inspection-item-${request.id}-${index}-value`;
            const judgementId = `inspection-item-${request.id}-${index}-judgement`;
            const author = state?.item_authorship?.[item.id];
            return <tr key={item.id} data-inspection-item={item.id} data-inspection-area={area}>
              <td>{worksheetItems.findIndex((entry) => entry.id === item.id) + 1}</td>
              <th scope="row"><div className="inspection-role-sheet-label"><span>{inspectionDisplayLabel(item.label, lang)}</span><small className="inspection-role-spec">{item.minimum || item.maximum ? `${item.minimum || '—'}–${item.maximum || '—'}` : item.required !== false ? common.required : common.optional}{item.unit ? ` ${item.unit}` : ''}{item.evidence_required ? ` · ${common.evidenceRequired}` : ''}</small></div></th>
              <td><label className="sr-only" htmlFor={valueId}>{inspectionDisplayLabel(item.label, lang)} · {common.measurement}</label>{item.kind === 'choice' ? <select id={valueId} disabled={!editable} value={row?.value || ''} onChange={(event) => updateMeasurement(item.id, { value: event.target.value })}><option value="">{common.choose}</option>{item.options?.map((option) => <option value={option} key={option}>{inspectionChoiceLabel(inspectionDisplayLabel(option, lang), lang)}</option>)}</select> : <input id={valueId} disabled={!editable} maxLength={1000} inputMode={item.kind === 'number' ? 'decimal' : 'text'} value={row?.value || ''} onChange={(event) => updateMeasurement(item.id, { value: event.target.value })} onKeyDown={(event) => nextMeasurement(item.id, event)} />}{!editable && [...(row?.value || '')].length > 8 && <details className="inspection-help inspection-full-value"><summary><span aria-hidden="true">ⓘ</span> {common.fullValue}</summary><p>{row?.value}</p></details>}</td>
              <td><InspectionMeasurementVerdict item={item} area={area} value={row?.value || ''} recordedJudgement={row?.judgement} lang={lang}><label className="sr-only" htmlFor={judgementId}>{inspectionDisplayLabel(item.label, lang)} · {common.judgement}</label><select id={judgementId} disabled={!editable} value={row?.judgement || ''} onChange={(event) => updateMeasurement(item.id, { judgement: event.target.value as InspectionMeasurement['judgement'] })}><option value="">{common.choose}</option><option value="pass">{common.pass}</option><option value="fail">{common.fail}</option></select></InspectionMeasurementVerdict></td>
              <td><span className="inspection-role-row-state" data-state={rowState} title={author ? `${text.inspector}: ${author.inspector_name} · ${text.recordedBy}: ${author.recorded_by_name} · ${inspectionTime(author.recorded_at, lang)}` : undefined}>{rowState === 'saved' ? text.savedRow : rowState === 'unsaved' ? text.unsavedRow : text.emptyRow}</span>{author && <span className="sr-only"> · {text.recordedBy}: {author.recorded_by_name}</span>}</td>
            </tr>;
          })}{!visibleWorksheetItems.some((item) => workflow.item_areas[item.id] === cardArea) && <tr><td colSpan={5} className="inspection-muted">{worksheetItems.some((item) => workflow.item_areas[item.id] === cardArea) ? text.noUnfilled : lang === 'ko' ? '검사 항목 미등록 · 치수와 외관은 모두 필수입니다. 검사 기준을 등록해야 최종 판정할 수 있습니다.' : '未配置检验项目 · 尺寸与外观均为必检。请配置标准后再进行最终判定。'}</td></tr>}</tbody>
        </table>
      </div>
      <div className="inspection-role-savebar">{workflow.areas.filter((area) => area.area === cardArea).map((state) => <div key={state.area} className="inspection-role-area-control" data-inspection-area={state.area}>
        {inspectionRoleAreaActorAllowed(workflow, state.area, userId) && <button type="button" className="inspection-button is-primary" data-area-action="save" disabled={blocked || !state.can_save || !areaProgress[cardArea].total} onClick={() => saveArea(state.area)}>{text[state.area]} {text.save}</button>}
        {state.can_reopen && <button type="button" className="inspection-button" disabled={blocked || dataDirty || !reason.trim()} onClick={() => send('area-reopen', { area: state.area, area_version: state.version, config_version: workflow.config_version, ...inspectionRoleActorPayload(workflow, state.area, userId), reason: reason.trim() })}>{text.reopen}</button>}
        {!inspectionAreas.every((candidate) => inspectionRoleAreaActorAllowed(workflow, candidate, userId)) && state?.can_complete && <button type="button" className="inspection-button" disabled={blocked || areaDirty(state.area) || !inspectionEntryReady(request.inspection_items.filter((item) => workflow.item_areas[item.id] === state.area), originalRows) || (request.require_evidence && !evidence[state.area].length)} onClick={() => send('area-complete', { area: state.area, area_version: state.version, config_version: workflow.config_version, ...inspectionRoleActorPayload(workflow, state.area, userId), judgement: state.measurements.some((row) => row.value.trim() && row.judgement === 'fail') ? 'fail' : 'pass' })}>{text[state.area]} {text.complete}</button>}
      </div>)}</div>
      </section>)}</div>
      <div className="inspection-role-submit-control inspection-cards-final-action">
        <p className="inspection-role-final" role="status">{text.final}: <strong>{finalJudgement === 'pass' ? text.bothOk : finalJudgement === 'fail' ? text.failed : finalJudgement === 'concession' ? lang === 'ko' ? '한도승인 · 독립 검수 필요' : '让步合格 · 需独立审核' : canFinalise ? (lang === 'ko' ? '저장 완료 · 판정 선택 대기' : '已保存 · 等待选择判定') : (lang === 'ko' ? '영역별 입력·저장 대기' : '等待各区域填写并保存')}</strong></p>
        <div className="inspection-final-actions"><span className="inspection-entry-hint">{lang === 'ko' ? '각각 저장 → 최종 판정' : '分别保存 → 最终判定'}</span><button type="button" className="inspection-button" disabled={blocked || !canFinalise} onClick={() => setFinalOpen(true)}>{lang === 'ko' ? '최종 판정' : '最终判定'}</button></div>
        <details className="inspection-help inspection-save-help"><summary><span aria-hidden="true">ⓘ</span> {lang === 'ko' ? '저장·완료 안내' : '保存与完成说明'}</summary><p>{lang === 'ko' ? '저장은 입력값을 보관합니다. 치수와 외관을 모두 저장한 뒤 최종 판정을 선택하면 검사 완료를 기록합니다. MES 저장·완료 상태는 상단에서 별도로 확인합니다.' : '保存会保留填写的数据。尺寸与外观均保存后，选择最终判定以记录检验完成。MES 保存与完成状态请分别在上方确认。'}</p></details>
      </div>
      {!workflow.my_item_ids.length && <p className="inspection-muted">{text.noPermission}</p>}
    </section>}
    <InspectionAuxiliaryTabs label={lang === 'ko' ? '검사 보조 메뉴' : '检验辅助菜单'}>
    {workflow.configured && <details data-panel="evidence" className="inspection-help inspection-role-proof"><summary><span aria-hidden="true">ⓘ</span> {common.attachments} · {request.require_evidence || request.inspection_items.some((item) => item.evidence_required) ? common.requiredEvidenceHint : common.evidenceOptional}</summary><p>{common.evidenceHint}</p><div className="inspection-role-evidence-grid">{inspectionWorksheetAreas.map((area) => {
      const state = workflow.areas.find((row) => row.area === area);
      const areaEditable = !blocked && inspectionRoleAreaActorAllowed(workflow, area, userId) && state?.can_save === true;
      const areaItems = request.inspection_items.filter((item) => workflow.item_areas[item.id] === area);
      return <div key={area} data-inspection-evidence-area={area}><h4>{text[area]} · {state?.assigned_to_name || text.unassigned}</h4>
        <div className="inspection-item-evidence-fields">{areaItems.map((item) => { const row = measurements.find((entry) => entry.item_id === item.id); const link = safeInspectionEvidenceUrl(row?.evidence_url || ''); return <div key={item.id}><label>{inspectionDisplayLabel(item.label, lang)}{item.evidence_required ? ' *' : ''}<input aria-label={`${inspectionDisplayLabel(item.label, lang)} · ${common.itemEvidence}${item.evidence_required ? ' *' : ''}`} placeholder="https://…" autoCapitalize="none" spellCheck={false} type="url" maxLength={500} disabled={blocked || !inspectionRoleItemEditable(workflow, item.id, userId)} value={row?.evidence_url || ''} onChange={(event) => updateMeasurement(item.id, { evidence_url: event.target.value })} /></label>{link && <a href={link} target="_blank" rel="noopener noreferrer">{common.openEvidence}</a>}</div>; })}</div>
        <div className="inspection-common-evidence-fields">{evidence[area].map((row, index) => <div className="inspection-evidence-row" key={index}><label>{common.evidenceName}<input maxLength={128} disabled={!areaEditable} value={row.label} onChange={(event) => { if (ownsSession()) setEvidence((current) => ({ ...current, [area]: current[area].map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry) })); }} /></label><label>{common.evidenceUrl}<input type="url" maxLength={500} disabled={!areaEditable} value={row.url} onChange={(event) => { if (ownsSession()) setEvidence((current) => ({ ...current, [area]: current[area].map((entry, i) => i === index ? { ...entry, url: event.target.value } : entry) })); }} /></label><button type="button" className="inspection-button" disabled={!areaEditable} onClick={() => { if (ownsSession()) setEvidence((current) => ({ ...current, [area]: current[area].filter((_, i) => i !== index) })); }}>{common.remove}</button></div>)}</div>
        <button type="button" className="inspection-button" disabled={!areaEditable || evidence[area].length >= 10} onClick={() => { if (ownsSession()) setEvidence((current) => ({ ...current, [area]: [...current[area], { label: '', url: '' }] })); }}>{common.addEvidence}</button>
      </div>;
    })}</div></details>}
    <details data-panel="results" className="inspection-role-summary-fields"><summary>{lang === 'ko' ? '검사 수량·메모' : '检验数量·备注'}</summary><div className="inspection-summary-grid">{request.quantity_mode === 'recorded' && (['inspected_quantity', 'accepted_quantity', 'rejected_quantity'] as const).map((name) => <label key={name}>{name === 'inspected_quantity' ? common.inspected : name === 'accepted_quantity' ? common.accepted : common.rejected} ({request.uom})<input maxLength={30} inputMode="decimal" disabled={!canSummaryEdit} value={summary[name]} onChange={(event) => { if (ownsSession()) setSummary({ ...summary, [name]: event.target.value }); }} /></label>)}<label className="inspection-summary-note">{common.notes}<textarea maxLength={2000} disabled={!canSummaryEdit} value={summary.notes} onChange={(event) => { if (ownsSession()) setSummary({ ...summary, notes: event.target.value }); }} /></label></div><div className="inspection-actions"><button type="button" className="inspection-button" disabled={!canSummaryEdit || !summaryDirty} onClick={() => send('role-results', { version: request.version, ...summary, ...(request.quantity_mode === 'not_recorded' ? { inspected_quantity: '0', accepted_quantity: '0', rejected_quantity: '0' } : {}) })}>{common.save}</button><button type="button" className="inspection-button" disabled={busy || Boolean(attempt)} onClick={() => { if (!dirty || window.confirm(common.discard)) void getInspectionRequest(request.id, sessionId).then((updated) => { if (ownsSession()) { setSummary(summaryDraft(updated)); adopt(updated); } }).catch((cause) => { if (ownsSession()) setError(inspectionError(cause, common.loadError).message); }); }}>{common.reload}</button></div>{dirty && <p className="inspection-muted" role="status">{text.draft}</p>}</details>
    <details data-panel="review" className="inspection-section inspection-fold" open={request.capabilities.can_review || request.capabilities.can_reinspect || workflow.areas.some((area) => area.can_reopen)}><summary>{common.review}</summary>{request.review_reason && <p>{common.reviewReason}: {request.review_reason}</p>}<label className="inspection-reason-field">{text.reason}<textarea disabled={blocked} maxLength={500} value={reason} onChange={(event) => { if (ownsSession()) setReason(event.target.value); }} /></label><div className="inspection-actions">{request.capabilities.can_review_failure && <button type="button" className="inspection-button" disabled={blocked || dataDirty || request.submitted_by === userId || !reason.trim()} onClick={() => send('review-failure', { version: request.version, reason: reason.trim() }, 'legacy')}>{lang === 'ko' ? '불합격 결과 검수 승인' : '审核不合格检验结果'}</button>}<button type="button" className="inspection-button" disabled={blocked || dataDirty || !request.capabilities.can_review || request.submitted_by === userId || (request.judgement === 'concession' && !reason.trim())} onClick={() => send('approve', { version: request.version, reason: reason.trim() }, 'legacy')}>{common.approve}</button><button type="button" className="inspection-button" disabled={blocked || dataDirty || !request.capabilities.can_review || request.submitted_by === userId || !reason.trim()} onClick={() => send('reject', { version: request.version, reason: reason.trim() }, 'legacy')}>{common.reject}</button><button type="button" className="inspection-button" disabled={blocked || dataDirty || !request.capabilities.can_reinspect || !reason.trim()} onClick={() => send('reinspect', { version: request.version, reason: reason.trim() }, 'legacy')}>{common.reinspect}</button></div></details>
    <details data-panel="mes" className="inspection-section inspection-fold"><summary>{common.mesDetails}</summary><dl className="inspection-meta"><div><dt>{common.mesQcStatus}</dt><dd>{mesObservation.qc}</dd></div><div><dt>{common.mesChecked}</dt><dd>{mesObservation.checkedAt}</dd></div></dl>{!whole?.enabled && <p className="inspection-muted">{text.mesBlocked}</p>}<details className="inspection-help"><summary><span aria-hidden="true">ⓘ</span> {text.mesPartial}</summary><p>{text.mesHint}</p></details></details>
    <details data-panel="context" className="inspection-help inspection-fold"><summary><span aria-hidden="true">ⓘ</span> {lang === 'ko' ? '작업 정보·검사 기준' : '作业信息·检验规则'}</summary><dl className="inspection-meta"><div><dt>{common.workOrder}</dt><dd>{request.work_order_ref}</dd></div><div><dt>{common.task}</dt><dd>{request.task_ref}</dd></div><div><dt>{common.owner}</dt><dd>{request.assigned_to_name || text.unassigned}</dd></div><div><dt>{common.version}</dt><dd>{request.version}</dd></div>{workflow.shift_snapshot && <><div><dt>{text.label}</dt><dd>{inspectionDisplayLabel(workflow.shift_snapshot.label, lang)} · {workflow.shift_snapshot.shift_date || '—'} · {workflow.shift_snapshot.start_time?.slice(0, 5)}–{workflow.shift_snapshot.end_time?.slice(0, 5)} · {workflow.shift_snapshot.timezone}</dd></div><div><dt>{text.fromLocal}</dt><dd>{workflow.shift_snapshot.effective_from_local?.replace('T', ' ') || '—'}</dd></div><div><dt>{text.untilLocal}</dt><dd>{workflow.shift_snapshot.effective_until_local?.replace('T', ' ') || '—'}</dd></div><div><dt>{text.fromUTC}</dt><dd>{workflow.shift_snapshot.effective_from || '—'}</dd></div><div><dt>{text.untilUTC}</dt><dd>{workflow.shift_snapshot.effective_until || '—'}</dd></div></>}</dl></details>
    <details data-panel="history" className="inspection-section inspection-fold inspection-handling-history"><summary>{common.handlingHistory} ({historyRows.length})</summary>{historyRows.length ? <div className="inspection-table-scroll" tabIndex={0} role="region" aria-label={common.handlingHistory}><table className="inspection-history-table"><caption className="sr-only">{common.handlingHistory}</caption><thead><tr><th scope="col">{common.historyTime}</th><th scope="col">{common.historyActor}</th><th scope="col">{common.historyAction}</th><th scope="col">{common.historyResult}</th></tr></thead><tbody>{historyRows.map((row) => <tr key={row.key}><td>{inspectionTime(row.at, lang)}</td><td>{row.actor}</td><td>{row.action}</td><td>{row.result}</td></tr>)}</tbody></table></div> : <p className="inspection-muted">{common.noOperations}</p>}</details>
    </InspectionAuxiliaryTabs>
  </section>;
}
