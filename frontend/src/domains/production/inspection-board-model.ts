import type { InjectionProductionMatrix } from '../mes/api';
import type { ProductionPlanSummaryResponse, ProductionStatusResponse } from './api';
import { isBoardMachineStale } from './board-availability.ts';
import { getBoardCycleTime, getBoardTone, isMesDataReadyForBusinessDate, type BoardTone } from './board-machine-status.ts';
import { selectBoardInspection } from './injection-quality-binding.ts';
import {
  deriveInjectionQuality, injectionQualityScopeKey, reduceInjectionQuality,
  type ExpectedInjectionQualityScope, type InjectionQualityState, type InjectionQualityView,
} from './injection-quality-status.ts';
import { buildRealtimeProgressSummary } from './realtime-progress.ts';

export type InspectionBoardModelInput = {
  businessDate: string;
  requestedBusinessDate: string;
  planData: ProductionPlanSummaryResponse | undefined;
  mesData: InjectionProductionMatrix | undefined;
  statusData: ProductionStatusResponse | undefined;
  nowMs: number;
  transportError: boolean;
  previousQualityStates?: Readonly<Record<number, InjectionQualityState | null>>;
};

export type InspectionBoardMachine = {
  machineNumber: number;
  tonnage: string;
  currentPlanId: number | null;
  currentParts: string[];
  model: string;
  /** Existing machine/business-day production totals, never inspection counts. */
  productionQuantity: number | null;
  plannedQuantity: number | null;
  productionTone: BoardTone;
  currentCycleTimeSec: number | null;
  qualityScope: ExpectedInjectionQualityScope;
  qualityState: InjectionQualityState;
  qualityView: InjectionQualityView;
};

const quantity = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const label = (value: string | null | undefined) => typeof value === 'string' ? value.trim() : '';
const UNRESOLVED_VERSION = '0'.repeat(64);

function retainedScope(state: InjectionQualityState | null | undefined): ExpectedInjectionQualityScope | null {
  if (!state?.scopeKey) return null;
  try {
    const value: unknown = JSON.parse(state.scopeKey);
    if (!Array.isArray(value) || value.length !== 4) return null;
    const scope = { businessDate: value[0], machineNumber: value[1], currentPlanId: value[2], planVersion: value[3] };
    return injectionQualityScopeKey(scope) === state.scopeKey ? scope : null;
  } catch { return null; }
}

/** Compose existing production calculations and strict public quality readers.
 * The numeric order is 1..17, not a physical factory-line or floor-map relation.
 * No request-level save phase, inspection quantity or disposition is inferred.
 */
export function buildInspectionBoardMachines(input: InspectionBoardModelInput): InspectionBoardMachine[] {
  const sameDate = input.businessDate === input.requestedBusinessDate;
  const planData = sameDate && input.planData?.plan_date === input.businessDate ? input.planData : undefined;
  const start = Date.parse(`${input.businessDate}T08:00:00+08:00`);
  const latestMs = Date.parse(input.mesData?.time_slots.at(-1)?.time ?? '');
  const mesDateMatches = sameDate && Number.isFinite(latestMs)
    && isMesDataReadyForBusinessDate(new Date(latestMs), input.businessDate)
    && latestMs < start + 86_400_000;
  const mesData = mesDateMatches ? input.mesData : undefined;
  const statusData = sameDate && input.statusData ? {
    ...input.statusData,
    // A retained response with an explicit older day cannot supply today's row.
    injection: input.statusData.injection.filter(row => !row.inspection_scope
      || row.inspection_scope.business_date === input.businessDate),
  } : undefined;
  const summary = buildRealtimeProgressSummary(planData, mesData, statusData, input.businessDate);
  // Same Shanghai 08:00 display clock used by the existing injection board.
  const elapsedRate = mesDateMatches ? Math.max(0, Math.min(100, (latestMs - start) / 86_400_000 * 100)) : 0;
  const planRecords = planData?.injection.records ?? [];

  return Array.from({ length: 17 }, (_, index): InspectionBoardMachine => {
    const machineNumber = index + 1;
    const rows = summary.rows.filter(row => row.key === String(machineNumber));
    const row = rows.length === 1 ? rows[0] : undefined;
    const statuses = statusData?.injection.filter(item => item.machine_number === machineNumber) ?? [];
    const status = statuses.length === 1 ? statuses[0] : undefined;
    const machines = mesData?.machines.filter(item => item.machine_number === machineNumber) ?? [];
    const machine = machines.length === 1 ? machines[0] : undefined;
    const machinePlanIds = planRecords.filter(record => row?.segments.some(segment => segment.planId === record.id))
      .map(record => record.id);
    const candidate = status?.transition?.current_plan_id;
    const current = planRecords.filter(record => record.id === candidate && machinePlanIds.includes(record.id));
    const candidatePlanId = Number.isSafeInteger(candidate) && Number(candidate) > 0
      && current.length === 1 && row?.segments.filter(segment => segment.planId === candidate).length === 1
      && status?.parts.filter(part => part.plan_id === candidate).length === 1 ? candidate! : null;
    const selection = selectBoardInspection({
      businessDate: input.businessDate, requestedBusinessDate: input.requestedBusinessDate,
      machineNumber, currentPlanId: candidatePlanId, planDate: planData?.plan_date,
      machinePlanIds, planRecords, statusMachines: statusData?.injection ?? [],
    });
    const matchedPlan = selection.scope.planVersion !== UNRESOLVED_VERSION;
    const currentPlanId = matchedPlan ? candidatePlanId : null;
    const currentRecord = currentPlanId === null ? undefined : current[0];
    const previous = input.previousQualityStates?.[machineNumber];
    const priorScope = retainedScope(previous);
    // Missing datasets cannot establish a scope change. Quarantine their old
    // payload while retaining its generation floor; never display that scope
    // as today's current plan. A verified new scope resets through the reducer.
    const retainFloor = !matchedPlan && sameDate && priorScope?.businessDate === input.businessDate
      && priorScope.machineNumber === machineNumber
      && (candidatePlanId === null || candidatePlanId === priorScope.currentPlanId);
    const qualityState = reduceInjectionQuality(previous, matchedPlan ? selection.payload : null,
      retainFloor ? priorScope : selection.scope);
    const qualityView = deriveInjectionQuality(qualityState, selection.scope, input.nowMs,
      { transportError: input.transportError });
    const sourceTime = Date.parse(mesData?.machine_sources?.[String(machineNumber)]?.latest_capacity_at ?? '');
    const mixedPlan = planData !== undefined && Number.isSafeInteger(candidate) && Number(candidate) > 0
      && status?.inspection_scope != null && !matchedPlan;
    const stale = input.transportError || mixedPlan || !Number.isFinite(input.nowMs) || !mesDateMatches
      || latestMs > input.nowMs || sourceTime > input.nowMs || sourceTime < start
      || isBoardMachineStale(mesData?.machine_sources, machineNumber, input.nowMs);
    const productionTone = getBoardTone(row, elapsedRate, stale);
    const values = mesData?.actual_production_matrix[String(machineNumber)];
    const observed = mesData?.capacity_observed_matrix?.[String(machineNumber)];
    const source = mesData?.machine_sources?.[String(machineNumber)];
    const hasMatrixObservation = machine !== undefined && Array.isArray(values) && values.some((value, index) => {
      const at = Date.parse(mesData?.time_slots[index]?.time ?? '');
      return Number.isFinite(value) && value >= 0 && at >= start && at <= input.nowMs
        && (value > 0 || (observed ? observed[index] === true : (source?.observed_slot_count ?? 0) > 0));
    });
    const hasActual = (status !== undefined && quantity(status.total_actual) !== null)
      || hasMatrixObservation;
    const tonnage = label(machine?.tonnage).match(/^(\d+)\s*T?$/i)?.[1]
      ?? label(row?.label).match(/(\d+)\s*T/i)?.[1] ?? '-';
    const part = label(currentRecord?.part_no);
    return { machineNumber, tonnage, currentPlanId, currentParts: part ? [part] : [],
      model: label(currentRecord?.model_name) || label(currentRecord?.part_spec),
      productionQuantity: hasActual && !mixedPlan ? quantity(row?.estimatedQty) : null,
      plannedQuantity: row?.hasPlan && !mixedPlan ? quantity(row.plannedQty) : null,
      productionTone, currentCycleTimeSec: getBoardCycleTime(row, productionTone),
      qualityScope: selection.scope, qualityState, qualityView };
  });
}
