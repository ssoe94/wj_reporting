export type InspectionEditorSelection = { epoch: number; kind: 'none' | 'create' | 'request'; requestId: number | null };

export function nextInspectionEditor(current: InspectionEditorSelection, kind: InspectionEditorSelection['kind'], requestId: number | null = null): InspectionEditorSelection {
  return { epoch: current.epoch + 1, kind, requestId: kind === 'request' ? requestId : null };
}

export function isCurrentInspectionEditor(expected: InspectionEditorSelection, current: InspectionEditorSelection): boolean {
  return expected.epoch === current.epoch && expected.kind === current.kind && expected.requestId === current.requestId;
}

export function inspectionNavigationGate(dirty: boolean, locked: boolean): 'blocked' | 'confirm' | 'allow' {
  return locked ? 'blocked' : dirty ? 'confirm' : 'allow';
}

type InspectionRouteLocation = { pathname: string; search: string; hash: string };

export function inspectionRouteLeaveGate(current: InspectionRouteLocation, next: InspectionRouteLocation, dirty: boolean, locked: boolean, owningPath?: string): 'blocked' | 'confirm' | 'allow' {
  // A component retained briefly during route exit must not block the next page's navigation.
  if (owningPath !== undefined && current.pathname !== owningPath) return 'allow';
  if (current.pathname === next.pathname && current.search === next.search && current.hash === next.hash) return 'allow';
  return inspectionNavigationGate(dirty, locked);
}

export function inspectionHasUnsavedWork(resultChanged: boolean, reviewReason: string): boolean {
  return resultChanged || reviewReason.length > 0;
}

export function inspectionRemoteReconciliationRequired(request: { sync_status: string; mes_completion_status: string; last_error_code?: string }): boolean {
  return ['pending', 'unknown'].includes(request.sync_status) || ['pending', 'unknown'].includes(request.mes_completion_status)
    || ['mes_outcome_unknown', 'stale_remote_observation'].includes(request.last_error_code || '');
}

/** Only use on the scoped MES refresh mutation response, never on a WJ GET. */
export function inspectionConfirmsScopedRefresh(request: {
  sync_status: string; mes_completion_status: string; mes_checked_at: string | null;
  mes_workflow?: { phase: string; last_verified_at: string | null };
  last_error_code: string; mes_state?: { task_status?: number | null; qc_status?: number | null };
}): boolean {
  if (request.mes_workflow && request.mes_workflow.phase !== 'unbound') {
    return !inspectionRemoteReconciliationRequired(request) && request.last_error_code === ''
      && request.sync_status === 'succeeded'
      && ['saved', 'completed'].includes(request.mes_workflow.phase)
      && typeof request.mes_checked_at === 'string' && Number.isFinite(Date.parse(request.mes_checked_at))
      && request.mes_workflow.last_verified_at === request.mes_checked_at
      && (request.mes_workflow.phase === 'saved' ? request.mes_completion_status === 'not_completed'
        : ['completed', 'approval_pending'].includes(request.mes_completion_status));
  }
  return !inspectionRemoteReconciliationRequired(request) && request.last_error_code === ''
    && ['not_synced', 'succeeded', 'failed', 'blocked', 'stale'].includes(request.sync_status)
    && ['not_completed', 'completed', 'approval_pending', 'cancelled', 'rejected', 'blocked'].includes(request.mes_completion_status)
    && typeof request.mes_checked_at === 'string' && Number.isFinite(Date.parse(request.mes_checked_at))
    && Number.isInteger(request.mes_state?.task_status) && (request.mes_state?.task_status ?? -1) >= 0 && (request.mes_state?.task_status ?? 6) <= 5
    && Number.isInteger(request.mes_state?.qc_status) && (request.mes_state?.qc_status ?? 0) >= 1 && (request.mes_state?.qc_status ?? 5) <= 4;
}

type RefreshObservation = Parameters<typeof inspectionConfirmsScopedRefresh>[0];

export function inspectionNextReconciliationRequired(current: boolean, event:
  | { kind: 'failure'; reconciliation_required: boolean }
  | { kind: 'local_read' }
  | { kind: 'scoped_refresh'; observation: RefreshObservation; latest?: RefreshObservation },
): boolean {
  if (event.kind === 'failure') return current || event.reconciliation_required;
  if (event.kind === 'local_read') return current;
  // A later WJ GET cannot establish a fresh observation, but it can reveal
  // a newer conflicting/failed observation that invalidates the scoped proof.
  return !inspectionConfirmsScopedRefresh(event.observation)
    || !inspectionConfirmsScopedRefresh(event.latest ?? event.observation);
}
