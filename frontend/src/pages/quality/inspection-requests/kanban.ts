import { isIntegrationTrial, type TrialIdentity, type IntegrationTrial } from './integrationTrial.ts';
import type { InspectionRequest } from './model';
import type { MesReadObservation } from './mesReadObservation';

export type InspectionStage = 'waiting' | 'in_progress' | 'completed' | 'blocked';
export type InspectionPlanAlignment = {
  status: 'part_listed' | 'part_not_listed' | 'unknown';
  matching_plan_ids: number[];
  task_binding_verified: false;
};
export type KanbanInspectionRequest = Omit<InspectionRequest, 'audit' | 'operations'> & { plan_alignment?: InspectionPlanAlignment };
export type InspectionPlan = {
  id: number; machine_name: string; part_no: string; lot_no: string; sequence: number;
  planned_quantity: string; updated_at: string; execution_status: string | null;
};
export type InspectionMachine = {
  machine_number: number; station_id: string; mapping_status: string;
  plan_status: 'present' | 'missing' | 'unknown'; plans: InspectionPlan[];
  mes_observations?: MesReadObservation[];
  requests: KanbanInspectionRequest[]; request_count: number; requests_truncated: boolean;
  dry_run: { enabled: false; mode: 'dry_run'; candidate: string; recommendation: string;
    blocking_reasons: string[]; plan_version: string; requires_new_first_inspection_on_resume: string };
};
export type InspectionKanban = {
  integration_trials?: IntegrationTrial[];
  schema_version: 'inspection-kanban.v1'; business_date: string; day_start: string; day_end: string; generated_at: string;
  plan_snapshot: { source: 'ProductionPlan'; version: string; latest_changed_at: string | null;
    shift_stored: false; work_task_binding_available: false; complete: boolean; freshness_verified?: false };
  mes_read_snapshot?: { availability: 'unavailable' | 'fixture_observations'; displayed: number; complete: false; current_state_verified: false };
  mes_unmapped_observations?: MesReadObservation[];
  machines: InspectionMachine[]; unmapped_requests: KanbanInspectionRequest[]; unmapped_plans: InspectionPlan[];
  requests_truncated: boolean; plans_truncated: boolean; executions_truncated: boolean;
  counts: { requests_displayed: number; plans_displayed: number; unmapped_requests: number; unmapped_plans: number };
};

/** The Shanghai production day rolls over at 08:00, independent of the browser timezone. */
export function inspectionBusinessDate(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(shifted);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function inspectionElapsedMinutes(createdAt: string, now: Date = new Date()): number | null {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(now.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - created) / 60_000));
}

type StageRequest = TrialIdentity & Pick<InspectionRequest, 'status' | 'sync_status' | 'mes_completion_status' | 'mes_checked_at' | 'judgement' | 'measurements' | 'evidence' | 'notes'> & { mes_state?: Pick<InspectionRequest['mes_state'], 'qc_status'>; inspected_quantity?: string; last_error_code?: string };
export function inspectionRequestStage(request: StageRequest): InspectionStage {
  // WJ approval alone does not establish an externally observed MES completion.
  if (['mes_outcome_unknown', 'stale_remote_observation'].includes(request.last_error_code || '')
    || ['unknown', 'stale', 'blocked', 'failed'].includes(request.sync_status)
    || ['unknown', 'blocked', 'cancelled', 'rejected'].includes(request.mes_completion_status)) return 'blocked';
  if (request.status === 'rejected' || request.status === 'failed') return 'blocked';
  if ([2, 4].includes(request.mes_state?.qc_status || 0)) return 'blocked';
  if (request.mes_completion_status === 'completed') {
    if (request.sync_status === 'pending') return 'in_progress';
    return request.sync_status === 'succeeded' && request.mes_state?.qc_status === 1
      && request.mes_checked_at && !Number.isNaN(new Date(request.mes_checked_at).getTime()) ? 'completed' : 'blocked';
  }
  if (request.status !== 'draft' || request.judgement || request.notes.trim() || request.evidence.length || Number(request.inspected_quantity) > 0
    || request.measurements.some((item) => item.value.trim() || item.judgement || item.evidence_url)) return 'in_progress';
  return 'waiting';
}

export function inspectionRequestKind(request: Pick<InspectionRequest, 'parent' | 'inspection_type'>): 'first' | 'process' | 'final' | 'general' | 'reinspection' {
  return request.parent ? 'reinspection' : request.inspection_type;
}

export function inspectionStageCounts(requests: StageRequest[]): Record<InspectionStage, number> {
  const counts = { waiting: 0, in_progress: 0, completed: 0, blocked: 0 };
  for (const request of requests) if (!isIntegrationTrial(request)) counts[inspectionRequestStage(request)] += 1;
  return counts;
}

/** Part/LOT agreement is only a display association; it never establishes MES task binding. */
export function inspectionPlanAlignment(request: Pick<KanbanInspectionRequest, 'plan_alignment'>): InspectionPlanAlignment['status'] {
  return request.plan_alignment?.status || 'unknown';
}

export function inspectionDisplayPlans(plans: InspectionPlan[]): InspectionPlan[] {
  return [...plans].sort((a, b) => Number(b.execution_status === 'running') - Number(a.execution_status === 'running') || a.sequence - b.sequence || a.id - b.id);
}

export function validateInspectionKanban(result: InspectionKanban, requestedDate: string): InspectionKanban {
  const numbers = result?.machines?.map((machine) => machine.machine_number).sort((a, b) => a - b);
  if (result?.schema_version !== 'inspection-kanban.v1' || result.business_date !== requestedDate
    || numbers?.length !== 17 || numbers.some((number, index) => number !== index + 1)) throw new Error('Inspection kanban identity mismatch');
  return result;
}
