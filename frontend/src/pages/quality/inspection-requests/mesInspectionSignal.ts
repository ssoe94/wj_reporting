import type { InspectionKanban, InspectionMachine } from './kanban';
import { inspectionBusinessDate } from './kanban.ts';

/** Optional, read-only evidence. The producer must verify enums, identity and timing paths. */
export type MesInspectionKind = 'first' | 'periodic' | 'production';
export type MesCurrentWork = {
  work_order_id: string; production_task_id: string; plan_id: string;
  part_no: string; product_name: string | null;
  production_status: 'running' | 'paused' | 'stopped' | 'completed' | 'unknown';
};
export type MesInspectionRecord = {
  qc_id: string; work_order_id: string; production_task_id: string; plan_id: string;
  kind: MesInspectionKind; current_state_verified: boolean;
  state: 'requested' | 'needed' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  judgement: 'pass' | 'fail' | null;
  requested_at: string | null; planned_at: string | null;
  official_deadline_at: string | null; completed_at: string | null;
};
export type MesInspectionSignalEvidence = {
  schema_version: 'mes-inspection-signal.v1';
  source_kind: 'mes_readback' | 'synthetic_contract_fixture';
  business_date: string; machine_number: number; current_plan_id: number; plan_version: string;
  observed_at: string; fresh_until: string | null;
  current_state_verified: boolean; stale: boolean; complete: boolean;
  current_work: MesCurrentWork | null;
  first_inspection_required: boolean | null;
  inspections: MesInspectionRecord[];
};
export type MesInspectionBadgeState = 'requested' | 'needed' | 'in_progress' | 'overdue' | 'completed' | 'failed' | 'unknown';
export type MesInspectionBadge = {
  kind: MesInspectionKind | null; state: MesInspectionBadgeState;
  elapsed_minutes: number | null; planned_at: string | null; official_deadline_at: string | null;
};
export type StationMesInspectionView = {
  source_kind: MesInspectionSignalEvidence['source_kind'] | null;
  evidence_state: 'current' | 'unavailable' | 'stale' | 'work_changed' | 'stopped' | 'unverified';
  observed_at: string | null;
  current_work: MesCurrentWork | null; badges: MesInspectionBadge[];
};

// A bare local date/time must not silently inherit the browser's timezone.
const stamp = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const reference = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const kinds: MesInspectionKind[] = ['first', 'periodic', 'production'];
const badge = (kind: MesInspectionKind | null, state: MesInspectionBadgeState = 'unknown'): MesInspectionBadge =>
  ({ kind, state, elapsed_minutes: null, planned_at: null, official_deadline_at: null });

/** Actual request/deadline times only. generated_at and local WJ stages are never inputs. */
export function stationMesInspectionView(machine: InspectionMachine | undefined, snapshot: InspectionKanban | null,
  nowMs: number, options: { transportError?: boolean } = {}): StationMesInspectionView {
  const evidence = machine?.mes_inspection_signal;
  const observedAt = stamp(evidence?.observed_at);
  // Keep the last source time visible after expiry or a failed refresh. A page
  // refresh timestamp is never evidence that MES was observed again.
  const observationTime = evidence?.schema_version === 'mes-inspection-signal.v1'
    && ['mes_readback', 'synthetic_contract_fixture'].includes(evidence.source_kind)
    && evidence.machine_number === machine?.machine_number && evidence.business_date === snapshot?.business_date
    && observedAt !== null && Number.isFinite(nowMs) && observedAt <= nowMs ? evidence.observed_at : null;
  const unknown = (reason: StationMesInspectionView['evidence_state'], work: MesCurrentWork | null = null): StationMesInspectionView => ({
    source_kind: evidence?.source_kind === 'synthetic_contract_fixture' || evidence?.source_kind === 'mes_readback' ? evidence.source_kind : null,
    evidence_state: reason, observed_at: observationTime, current_work: work, badges: [badge(null)],
  });
  if (!machine || !snapshot || !evidence || !Number.isFinite(nowMs)) return unknown('unavailable');
  if (evidence.schema_version !== 'mes-inspection-signal.v1'
    || !['mes_readback', 'synthetic_contract_fixture'].includes(evidence.source_kind)) return unknown('unverified');
  const freshUntil = stamp(evidence.fresh_until);
  if (options.transportError || evidence.stale === true || (freshUntil !== null && nowMs >= freshUntil)) return unknown('stale');
  if (evidence.current_state_verified !== true || evidence.stale !== false || evidence.complete !== true
    || observedAt === null || observedAt > nowMs || freshUntil === null || freshUntil <= observedAt) return unknown('unverified');
  const currentPlans = machine.plans.filter((plan) => plan.execution_status === 'running');
  if (evidence.business_date !== snapshot.business_date || snapshot.business_date !== inspectionBusinessDate(new Date(nowMs)) || evidence.machine_number !== machine.machine_number
    || evidence.plan_version !== snapshot.plan_snapshot.version || currentPlans.length !== 1
    || evidence.current_plan_id !== currentPlans[0].id || !snapshot.plan_snapshot.complete
    || snapshot.plans_truncated || snapshot.executions_truncated) return unknown('work_changed');
  const work = evidence.current_work;
  if (!work || ![work.work_order_id, work.production_task_id, work.plan_id, work.part_no].every(reference)
    || work.part_no !== currentPlans[0].part_no) return unknown('work_changed');
  if (!['running', 'paused', 'stopped', 'completed', 'unknown'].includes(work.production_status)) return unknown('unverified');
  if (work.production_status !== 'running') return unknown(work.production_status === 'unknown' ? 'unverified' : 'stopped', work);
  if (!Array.isArray(evidence.inspections) || evidence.inspections.length > 50) return unknown('unverified', work);
  const records = evidence.inspections;
  const identities = new Set<string>();
  for (const item of records) {
    if (!item || !reference(item.qc_id) || identities.has(item.qc_id) || !kinds.includes(item.kind)
      || item.current_state_verified !== true || !['requested', 'needed', 'in_progress', 'completed', 'failed', 'cancelled', 'unknown'].includes(item.state)
      || ![null, 'pass', 'fail'].includes(item.judgement)) return unknown('unverified', work);
    identities.add(item.qc_id);
    if (item.work_order_id !== work.work_order_id || item.production_task_id !== work.production_task_id || item.plan_id !== work.plan_id) return unknown('work_changed', work);
    const requested = stamp(item.requested_at), completed = stamp(item.completed_at);
    if ([item.requested_at, item.planned_at, item.official_deadline_at, item.completed_at].some(value => value !== null && stamp(value) === null)
      || (requested !== null && requested > observedAt) || (completed !== null && (completed > observedAt || (requested !== null && completed < requested)))) return unknown('unverified', work);
  }
  const firstRecords = records.filter(item => item.kind === 'first');
  const firstPassed = firstRecords.length === 1 && firstRecords[0].state === 'completed'
    && firstRecords[0].judgement === 'pass' && stamp(firstRecords[0].completed_at) !== null;
  const completionBlocked = (firstRecords.length > 0 && !firstPassed) || typeof evidence.first_inspection_required !== 'boolean'
    || (evidence.first_inspection_required === true && !firstPassed);
  const badges = kinds.flatMap<MesInspectionBadge>(kind => {
    const group = records.filter(item => item.kind === kind);
    if (!group.length) return kind === 'first' && evidence.first_inspection_required === true ? [badge(kind, 'needed')] : [];
    const failed = group.find(item => item.state === 'failed' || item.judgement === 'fail');
    if (failed) return [badge(kind, 'failed')];
    // A repeated inspection series needs an explicit current QC; never choose a latest row by timestamp.
    if (group.length !== 1) return [badge(kind)];
    const item = group[0];
    if (item.state === 'cancelled' || item.state === 'unknown') return [badge(kind)];
    if (item.state === 'completed') return [badge(kind,
      !completionBlocked && item.judgement === 'pass' && stamp(item.completed_at) !== null ? 'completed' : 'unknown')];
    const deadline = stamp(item.official_deadline_at), planned = stamp(item.planned_at), requested = stamp(item.requested_at);
    const state: MesInspectionBadgeState = deadline !== null && nowMs > deadline ? 'overdue'
      : item.state === 'in_progress' ? 'in_progress'
      : item.state === 'needed' || (planned !== null && nowMs >= planned) ? 'needed' : item.state;
    return [{ kind, state, elapsed_minutes: requested === null ? null : Math.max(0, Math.floor((nowMs - requested) / 60_000)),
      planned_at: item.planned_at, official_deadline_at: item.official_deadline_at }];
  });
  return { source_kind: evidence.source_kind, evidence_state: 'current', observed_at: observationTime, current_work: work, badges: badges.length ? badges : [badge(null)] };
}

export function stationMesBadgeLabel(value: MesInspectionBadge, lang: 'ko' | 'zh'): string {
  const ko = lang === 'ko';
  const kind = value.kind ? (ko ? { first: '초검', periodic: '타임체크', production: '생산검사' } : { first: '首检', periodic: '巡检', production: '生产检验' })[value.kind] : 'MES';
  const state = (ko ? { requested: '요청', needed: '검사 필요', in_progress: '검사 중', overdue: '기한 초과', completed: '완료', failed: '불합격', unknown: '미확인' }
    : { requested: '申请', needed: '需检验', in_progress: '检验中', overdue: '已超时', completed: '已完成', failed: '不合格', unknown: '未确认' })[value.state];
  return `${kind} ${state}`;
}
