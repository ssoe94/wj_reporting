import type { InspectionRequest } from './model';
import type { InspectionAction } from './workflow';
import { inspectionConfirmsScopedRefresh } from './navigation.ts';

type StageObservation = Pick<InspectionRequest, 'id' | 'version' | 'sync_status' | 'mes_completion_status' | 'mes_checked_at' | 'last_error_code' | 'mes_workflow'>;
export type InspectionMesResult = 'saved' | 'completed' | 'approval_pending';

/** A write acknowledgement alone cannot establish a saved or completed QC. */
export function inspectionMesMutationResult(action: InspectionAction, observed: StageObservation, latest: StageObservation, reloadFailed = false): InspectionMesResult | null {
  if (!['mes-save', 'mes-finish'].includes(action) || reloadFailed
    || !Number.isSafeInteger(observed.id) || observed.id <= 0 || latest.id !== observed.id
    || !Number.isSafeInteger(observed.version) || observed.version <= 0
    || !Number.isSafeInteger(latest.version) || latest.version < observed.version
    || !inspectionConfirmsScopedRefresh(observed) || !inspectionConfirmsScopedRefresh(latest)
    || observed.mes_checked_at !== latest.mes_checked_at
    || observed.mes_workflow?.phase !== latest.mes_workflow?.phase
    || observed.mes_completion_status !== latest.mes_completion_status) return null;
  if (action === 'mes-save') return latest.mes_workflow?.phase === 'saved' ? 'saved' : null;
  if (latest.mes_workflow?.phase !== 'completed') return null;
  return latest.mes_completion_status === 'approval_pending' ? 'approval_pending'
    : latest.mes_completion_status === 'completed' ? 'completed' : null;
}

type ProjectionClient = { invalidateQueries: (filters: { queryKey: readonly string[] }) => Promise<unknown> };

/** Re-read the existing public projections; never synthesize plan completion. */
export function refreshInspectionProjectionQueries(client: ProjectionClient): void {
  void Promise.allSettled([
    client.invalidateQueries({ queryKey: ['production-status'] }),
    client.invalidateQueries({ queryKey: ['inspection-overview'] }),
  ]);
}
