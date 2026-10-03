import type { InjectionQualityView } from './injection-quality-status';

/** Same current-scope/freshness semantics for the board and the dashboard. */
export function injectionQualityAttention(view: InjectionQualityView) {
  const verified = view.freshness === 'fresh' && view.availability === 'ok'
    && view.data?.binding_status === 'verified' && view.data.complete;
  return {
    verified: Boolean(verified),
    failed: verified ? view.counts.failed > 0 : null,
    overdue: verified ? view.scheduleStatus === 'overdue' : null,
    // QC failure and QC completion provide no MES disposition/approval proof.
    disposition: verified && view.counts.failed > 0 ? 'needs_verification' : 'unlinked',
    approvalPending: null,
    actionOverdue: null,
  } as const;
}
