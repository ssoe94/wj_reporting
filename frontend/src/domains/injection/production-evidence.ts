import type { InjectionEquipmentRow, OverviewBoardModel } from '../boards/overview/types';
import { getProcessEvidence } from '../analysis/model.ts';
import type { InjectionScope } from './workspace';

/** A compatibility zero without capacity or a plan is not evidence of zero pieces. */
export function injectionQuantityStatus(row: InjectionEquipmentRow) {
  if (row.capacityDataAvailable !== true) return row.dataWarning || 'capacity_unavailable';
  if (row.hasPlan !== true || row.productionState === 'running_without_plan') return 'quantity_unresolved_without_plan';
  if (row.actualQuantity === null || !Number.isFinite(row.actualQuantity) || row.actualQuantity < 0) return 'quantity_unavailable';
  return 'ok';
}

export function rowCanEvaluate(row: InjectionEquipmentRow, sourceReady: boolean) {
  return sourceReady && injectionQuantityStatus(row) === 'ok';
}

export function scopedProduction(model: OverviewBoardModel, scope: InjectionScope) {
  const evidence = getProcessEvidence(model, 'injection');
  const rows = model.equipment.injectionRows.filter((row) => scope.machineNumber === null || row.machineNumber === scope.machineNumber);
  const selected = scope.machineNumber === null ? null : rows[0];
  const contextUnavailable = model.warnings.includes('production_context_unavailable');
  const planned = scope.machineNumber === null ? evidence.process.plannedQuantity : selected?.plannedQuantity ?? null;
  // Individual capacity evidence takes precedence over fleet activity freshness.
  const canEvaluate = !contextUnavailable && (scope.machineNumber === null
    ? evidence.canEvaluate && evidence.process.capacityCoverageComplete === true && planned !== null && planned > 0
    : Boolean(selected && rowCanEvaluate(selected, true)));
  const actual = !canEvaluate ? null : scope.machineNumber === null ? evidence.actual : selected?.actualQuantity ?? null;
  return { ...evidence, rows, planned, actual, canEvaluate, contextUnavailable,
    completion: canEvaluate && planned !== null && planned > 0 && actual !== null ? actual / planned * 100 : null };
}
