import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBoardInspection } from '../src/domains/production/injection-quality-binding.ts';

function fixture() {
  return { businessDate: '2026-10-03', requestedBusinessDate: '2026-10-03', machineNumber: 1,
    currentPlanId: 70, planDate: '2026-10-03', machinePlanIds: [70, 71],
    planRecords: [{ id: 70, updated_at: '2026-10-03T03:00:00Z' }, { id: 71, updated_at: '2026-10-03T03:00:00Z' }],
    statusMachines: [{ machine_number: 1, parts: [{ plan_id: 70 }, { plan_id: 71 }],
      inspection_scope: { business_date: '2026-10-03', machine_number: 1, current_plan_id: 70,
        plan_version: 'a'.repeat(64), plan_updated_at: '2026-10-03T11:00:00+08:00' },
      inspection_status: { marker: 'not-a-real-payload' } }] };
}

test('default old API and absent plan binding produce no quality payload', () => {
  assert.equal(selectBoardInspection({ ...fixture(), statusMachines: [] }).payload, null);
  assert.equal(selectBoardInspection({ ...fixture(), currentPlanId: null }).payload, null);
  const input = fixture();
  assert.equal(selectBoardInspection({ ...input, statusMachines: input.statusMachines.map(row =>
    ({ ...row, inspection_scope: null, inspection_status: null })) }).payload, null);
});

test('same canonical row and plan revision permits subsequent strict payload validation', () => {
  const input = fixture();
  const result = selectBoardInspection(input);
  assert.equal(result.payload, input.statusMachines[0].inspection_status);
  assert.equal(result.scope.currentPlanId, 70);
});

test('date rollover and current plan switch drop old quality immediately', () => {
  assert.equal(selectBoardInspection({ ...fixture(), requestedBusinessDate: '2026-10-04' }).payload, null);
  assert.equal(selectBoardInspection({ ...fixture(), currentPlanId: 71 }).payload, null);
});

test('new plan revision cannot reuse retained status data', () => {
  const input = fixture();
  input.planRecords[0].updated_at = '2026-10-03T03:01:00Z';
  assert.equal(selectBoardInspection(input).payload, null);
});

test('delete add and reorder invalidate even with unchanged latest timestamp', () => {
  for (const ids of [[70], [70, 71, 72], [71, 70]]) {
    assert.equal(selectBoardInspection({ ...fixture(), machinePlanIds: ids }).payload, null);
  }
});

test('missing revision or duplicate current plan cannot establish a match', () => {
  const input = fixture();
  assert.equal(selectBoardInspection({ ...input, planRecords: [{ id: 70 }] }).payload, null);
  assert.equal(selectBoardInspection({ ...input, planRecords: [input.planRecords[0], input.planRecords[0]] }).payload, null);
});
