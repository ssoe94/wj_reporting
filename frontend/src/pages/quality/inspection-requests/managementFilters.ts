import { isIntegrationTrial } from './integrationTrial.ts';
import { inspectionRequestStage } from './kanban.ts';
import type { InspectionKanban, InspectionMachine, InspectionPlan, InspectionStage, KanbanInspectionRequest } from './kanban';
import type { MesReadObservation } from './mesReadObservation';

export type ManagementFilter = { stage: 'all' | InspectionStage; machine: string; search: string };
export type FilteredInspectionManagement = {
  machines: InspectionMachine[];
  unmappedRequests: KanbanInspectionRequest[];
  unmappedPlans: InspectionPlan[];
  mesUnmappedObservations: MesReadObservation[];
  requestCount: number;
};

/** A local display projection; stage names are not backend request-status parameters. */
export function filterInspectionManagement(snapshot: InspectionKanban, filter: ManagementFilter): FilteredInspectionManagement {
  const empty = (): FilteredInspectionManagement => ({ machines: [], unmappedRequests: [], unmappedPlans: [], mesUnmappedObservations: [], requestCount: 0 });
  if (!['all', 'waiting', 'in_progress', 'completed', 'blocked'].includes(filter.stage)
    || !/^(all|unmapped|[1-9]|1[0-7])$/.test(filter.machine)) return empty();

  const query = filter.search.trim().toLowerCase();
  const hasSearch = query.length > 0;
  const hasStage = filter.stage !== 'all';
  const numericQuery = /^\d+$/.test(query);
  const matches = (...values: (string | number | null)[]) => values.some((value) => {
    const text = String(value ?? '').toLowerCase();
    // A bare number is an exact identifier, never a prefix for another machine or ID.
    return numericQuery ? text === query : text.includes(query);
  });
  const matchesRequest = (request: KanbanInspectionRequest) => matches(request.id, request.work_order_ref, request.task_ref, request.part_no, request.equipment_ref, request.lot_ref);
  const matchesPlan = (plan: InspectionPlan) => matches(plan.id, plan.machine_name, plan.part_no, plan.lot_no);
  const matchesObservation = (observation: MesReadObservation) => matches(observation.qc_code, observation.qc_id, observation.work_order_id, observation.production_task_id, observation.plan_name);
  const matchesStage = (request: KanbanInspectionRequest) => !isIntegrationTrial(request) && (!hasStage || inspectionRequestStage(request) === filter.stage);

  const machines = filter.machine === 'unmapped' ? [] : snapshot.machines.flatMap((machine) => {
    if (filter.machine !== 'all' && String(machine.machine_number) !== filter.machine) return [];
    // A plan/machine match opens only that machine's existing display context, not a task binding.
    const contextMatch = !hasSearch || String(machine.machine_number) === query || machine.plans.some(matchesPlan);
    const requests = machine.requests.filter((request) => matchesStage(request) && (contextMatch || matchesRequest(request)));
    const observations = hasStage ? [] : (machine.mes_observations || []).filter((observation) => contextMatch || matchesObservation(observation));
    if (hasStage ? !requests.length : hasSearch && !requests.length && !observations.length && !(contextMatch && machine.plans.length)) return [];
    if (!hasStage && contextMatch && requests.length === machine.requests.length) return [machine];
    return [{ ...machine, requests, request_count: requests.length,
      ...(machine.mes_observations === undefined ? {} : { mes_observations: observations }) }];
  });

  const includeUnmapped = filter.machine === 'all' || filter.machine === 'unmapped';
  const unmappedRequests = includeUnmapped ? snapshot.unmapped_requests.filter((request) => matchesStage(request) && (!hasSearch || matchesRequest(request))) : [];
  // Unmapped plans/observations cannot establish the stage of an unrelated WJ request.
  const unmappedPlans = includeUnmapped && !hasStage ? snapshot.unmapped_plans.filter((plan) => !hasSearch || matchesPlan(plan)) : [];
  const mesUnmappedObservations = includeUnmapped && !hasStage ? (snapshot.mes_unmapped_observations || []).filter((observation) => !hasSearch || matchesObservation(observation)) : [];
  return { machines, unmappedRequests, unmappedPlans, mesUnmappedObservations,
    requestCount: machines.reduce((count, machine) => count + machine.requests.length, unmappedRequests.length) };
}

/** Earlier production-day provenance only; elapsed age does not prove an overdue inspection. */
export function inspectionPredatesBusinessDay(createdAt: string, dayStart: string): boolean {
  const created = Date.parse(createdAt);
  const start = Date.parse(dayStart);
  return Number.isFinite(created) && Number.isFinite(start) && created < start;
}
