import assert from 'node:assert/strict';
import test from 'node:test';
import { injectionQuantityStatus, rowCanEvaluate, scopedProduction } from '../src/domains/injection/production-evidence.ts';
import type { InjectionEquipmentRow, OverviewBoardModel } from '../src/domains/boards/overview/types.ts';

const row = (overrides = {}) => ({ machineNumber: 1, capacityDataAvailable: true, hasPlan: true,
  actualQuantity: 0, plannedQuantity: 100, productionState: 'planned_stopped', sourceStatus: 'ok', ...overrides }) as InjectionEquipmentRow;
const model = (rows: InjectionEquipmentRow[], complete = true) => ({
  processes: { injection: { plannedQuantity: 100, actualQuantity: 0, capacityCoverageComplete: complete } },
  freshness: { sources: [{ key: 'injection_production', status: 'ok', stale: false }] },
  warnings: [], equipment: { injectionRows: rows },
}) as unknown as OverviewBoardModel;

test('observed zero pieces remain zero for a planned, sampled machine', () => {
  assert.equal(rowCanEvaluate(row(), true), true);
  assert.equal(scopedProduction(model([row()]), { date: '2026-09-04', machineNumber: 1 }).actual, 0);
});
test('missing capacity and absent metadata do not turn compatibility zeros into evidence', () => {
  assert.equal(rowCanEvaluate(row({ capacityDataAvailable: false }), true), false);
  assert.equal(rowCanEvaluate(row({ capacityDataAvailable: undefined }), true), false);
  assert.equal(scopedProduction(model([row({ capacityDataAvailable: false })]), { date: '2026-09-04', machineNumber: 1 }).actual, null);
});
test('running without a plan has no resolved piece quantity', () => {
  assert.equal(injectionQuantityStatus(row({ hasPlan: false, productionState: 'running_without_plan' })), 'quantity_unresolved_without_plan');
  assert.equal(scopedProduction(model([row({ hasPlan: false })]), { date: '2026-09-04', machineNumber: 1 }).actual, null);
});
test('incomplete fleet withholds totals while a sampled selected machine remains readable', () => {
  const data = model([row(), row({ machineNumber: 2, capacityDataAvailable: false })], false);
  const fleet = scopedProduction(data, { date: '2026-09-04', machineNumber: null });
  assert.equal(fleet.actual, null);
  assert.equal(fleet.completion, null);
  assert.equal(scopedProduction(data, { date: '2026-09-04', machineNumber: 1 }).actual, 0);
});
test('empty plan cannot establish a factory production zero', () => {
  const data = model([]); data.processes.injection.plannedQuantity = 0;
  assert.equal(scopedProduction(data, { date: '2026-09-04', machineNumber: null }).actual, null);
});
test('context failure and stale capacity withhold comparisons', () => {
  const data = model([row()]); data.warnings = ['production_context_unavailable'];
  assert.equal(scopedProduction(data, { date: '2026-09-04', machineNumber: 1 }).canEvaluate, false);
  assert.equal(injectionQuantityStatus(row({ capacityDataAvailable: false, dataWarning: 'injection_capacity_data_stale' })), 'injection_capacity_data_stale');
  assert.equal(rowCanEvaluate(row(), false), false);
});
