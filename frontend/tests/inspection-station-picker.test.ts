import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectionStationNumbers, stationStage, stationDefaultRequest } from '../src/pages/quality/inspection-requests/stationPickerModel.ts';
import type { InspectionMachine, KanbanInspectionRequest } from '../src/pages/quality/inspection-requests/kanban.ts';
const request = (id: number, patch: Record<string, unknown> = {}) => ({ id, status: 'draft', sync_status: 'not_requested', mes_completion_status: 'not_requested', mes_checked_at: null, judgement: '', measurements: [], evidence: [], notes: '', ...patch }) as KanbanInspectionRequest;
const machine = (requests: KanbanInspectionRequest[]) => ({ machine_number: 7, requests }) as InspectionMachine;
test('fixed equipment ordering forms 1–9 and10–17 without guessed missing statuses', () => {
  assert.deepEqual(inspectionStationNumbers.slice(0, 9), [1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(inspectionStationNumbers.slice(9), [10,11,12,13,14,15,16,17]);
  assert.equal(stationStage(undefined), 'unknown');
  assert.equal(stationStage(machine([])), 'empty');
});
test('request summary uses strict existing stage rules, not local approval as MES completion', () => {
  assert.equal(stationStage(machine([request(1, { status: 'approved' })])), 'in_progress');
  assert.equal(stationStage(machine([request(2, { notes: 'entered' })])), 'in_progress');
  assert.equal(stationStage(machine([request(3, { sync_status: 'unknown' })])), 'blocked');
});
test('keep chosen request, otherwise pick a pending request without mutating source order', () => {
  const current = machine([request(8, { notes: 'entered' }), request(9)]);
  assert.equal(stationDefaultRequest(current, 8), 8);
  assert.equal(stationDefaultRequest(current, null), 9);
  assert.deepEqual(current.requests.map(row => row.id), [8,9]);
  assert.equal(stationDefaultRequest(undefined, null), null);
});
