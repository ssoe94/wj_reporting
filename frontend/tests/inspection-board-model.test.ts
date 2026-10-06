import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInspectionBoardMachines, inspectionBoardActivity, type InspectionBoardModelInput,
} from '../src/domains/production/inspection-board-model.ts';
import { buildRealtimeProgressSummary } from '../src/domains/production/realtime-progress.ts';
import type { PublicInjectionQuality } from '../src/domains/production/injection-quality-status.ts';

const DAY = '2026-10-04';
const NOW = Date.parse('2026-10-04T03:38:00Z');
const VERSION = 'a'.repeat(64);

function quality(): PublicInjectionQuality {
  return { schema_version: 'injection-quality-status.v1', business_date: DAY,
    machine_number: 1, current_plan_id: 70, plan_version: VERSION,
    binding_generation: 2, read_generation: 10, binding_status: 'verified', availability: 'ok',
    freshness: 'fresh', fresh_until: '2026-10-04T03:40:00Z',
    last_attempt_started_at: '2026-10-04T03:37:59Z', last_attempt_completed_at: '2026-10-04T03:38:00Z',
    last_success_at: '2026-10-04T03:38:00Z', observed_at: '2026-10-04T03:37:59Z',
    refresh_after_seconds: null, complete: false,
    first: { status: 'unknown', last_known_status: 'unknown', checks: [
      { kind: 'first', status: 'passed', checked_at: '2026-10-04T03:18:00Z', warnings: [] },
    ] },
    periodic: { status: 'unknown', last_known_status: 'unknown', checks: [],
      last_checked_at: null, last_result: 'unknown', next_due_at: null, schedule_status: 'unverified' },
    other_checks: [], warnings: [] };
}

function fixture(): InspectionBoardModelInput {
  return { businessDate: DAY, requestedBusinessDate: DAY, nowMs: NOW, transportError: false,
    planData: { plan_date: DAY, injection: {
      records: [{ id: 70, machine_name: '850T-1', sequence: 1, part_no: 'SYNTHETIC-PART',
        model_name: 'SYNTHETIC-MODEL', lot_no: 'SYNTHETIC-LOT', planned_quantity: 100, cavity: 2,
        updated_at: '2026-10-04T03:00:00Z' }],
      machine_summary: [], model_summary: [], daily_totals: [],
    }, machining: { records: [], machine_summary: [], model_summary: [], daily_totals: [] } },
    mesData: { timestamp: '2026-10-04T03:38:00Z',
      time_slots: [{ hour_offset: 0, time: '2026-10-04T03:38:00Z', label: '11:38', interval_minutes: 2 }],
      machines: [{ machine_number: 1, machine_name: '1호기', tonnage: '850T', display_name: '1호기' }],
      actual_production_matrix: { '1': [12] }, cumulative_production_matrix: {}, oil_temperature_matrix: {},
      machine_sources: { '1': { status: 'ok', latest_capacity_at: '2026-10-04T03:38:00Z',
        sample_count: 1, observed_slot_count: 1, total_slot_count: 1 } } },
    statusData: { injection: [{ machine_number: 1, machine_name: '850T-1', total_planned: 100,
      total_actual: 24, progress: 24, shot_count: 12,
      transition: { phase: 'running', current_plan_id: 70, from_plan_id: null, to_plan_id: null,
        stopped_at: null, estimated_start_at: null, confirmation_status: 'none', setup_shots: 0 },
      parts: [{ plan_id: 70, part_no: 'SYNTHETIC-PART', model_name: 'SYNTHETIC-MODEL',
        planned_quantity: 100, actual_quantity: 24, allocated_shots: 12, cavity: 2,
        status: 'in_progress', progress: 24 }],
      inspection_scope: { business_date: DAY, machine_number: 1, current_plan_id: 70,
        plan_version: VERSION, plan_updated_at: '2026-10-04T03:00:00Z' }, inspection_status: quality(),
    }], machining: [] } };
}

function first(input = fixture()) { return buildInspectionBoardMachines(input)[0]; }

test('always returns ordered machines 1..17 without invented empty-data quantities or line labels', () => {
  const input = fixture();
  const machines = buildInspectionBoardMachines({ ...input, planData: undefined, mesData: undefined, statusData: undefined });
  assert.deepEqual(machines.map(machine => machine.machineNumber), Array.from({ length: 17 }, (_, index) => index + 1));
  assert.deepEqual([machines.slice(0, 6).length, machines.slice(6, 12).length, machines.slice(12).length], [6, 6, 5]);
  for (const machine of machines) {
    assert.equal(machine.currentPlanId, null);
    assert.deepEqual(machine.currentParts, []);
    assert.equal(machine.productionQuantity, null);
    assert.equal(machine.plannedQuantity, null);
    assert.equal(machine.tonnage, '-');
    assert.equal(machine.productionTone, 'stale');
    assert.equal(machine.qualityView.firstStatus, 'unknown');
    assert.equal('line' in machine, false);
  }
});

test('production totals are existing calculator outputs, independent of observed QC counts', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const machine = first(input);
  const existing = buildRealtimeProgressSummary(input.planData, input.mesData, input.statusData, DAY).rows[0];
  assert.equal(machine.productionQuantity, existing.estimatedQty);
  assert.equal(machine.productionQuantity, 24);
  assert.equal(machine.plannedQuantity, existing.plannedQty);
  assert.deepEqual(machine.currentParts, ['SYNTHETIC-PART']);
  assert.equal(machine.model, 'SYNTHETIC-MODEL');
  assert.equal(machine.tonnage, '850');
  assert.equal(machine.qualityView.counts.passed, 1);
  assert.equal(machine.qualityView.firstStatus, 'unknown');
  assert.equal(machine.qualityView.data?.complete, false);
  for (const absent of ['inspectionQuantity', 'inspected_quantity', 'saving', 'savePhase', 'disposition', 'ngQuantity']) {
    assert.equal(absent in machine, false);
  }
  assert.equal(JSON.stringify(input), before);
});

test('a plan without measured production is known planned quantity and unknown actual quantity', () => {
  const machine = first({ ...fixture(), mesData: undefined, statusData: undefined });
  assert.equal(machine.plannedQuantity, 100);
  assert.equal(machine.productionQuantity, null);
  assert.equal(machine.currentPlanId, null);
  assert.deepEqual(machine.currentParts, []);
});

test('current product never falls back to an in-progress or pending plan', () => {
  const input = fixture();
  input.statusData!.injection[0].transition!.current_plan_id = null;
  const machine = first(input);
  assert.equal(machine.currentPlanId, null);
  assert.deepEqual(machine.currentParts, []);
  assert.equal(machine.model, '');
  assert.equal(machine.productionQuantity, 24);
  assert.equal(machine.qualityState.data, null);
});

test('current product requires one exact plan row and cannot borrow a different machine plan', () => {
  for (const mode of ['duplicate', 'other-machine', 'missing'] as const) {
    const input = fixture();
    if (mode === 'duplicate') input.planData!.injection.records.push({ ...input.planData!.injection.records[0] });
    if (mode === 'other-machine') input.planData!.injection.records[0].machine_name = '850T-2';
    if (mode === 'missing') input.planData = undefined;
    const machine = first(input);
    assert.equal(machine.currentPlanId, null, mode);
    assert.deepEqual(machine.currentParts, [], mode);
    assert.equal(machine.qualityState.data, null, mode);
  }
});

test('wrong payload plan version and independently revised plan invalidate quality', () => {
  const mismatch = fixture();
  mismatch.statusData!.injection[0].inspection_status = { ...quality(), plan_version: 'b'.repeat(64) };
  assert.equal(first(mismatch).qualityState.data, null);
  const revised = fixture();
  revised.planData!.injection.records[0].updated_at = '2026-10-04T03:01:00Z';
  revised.planData!.injection.records[0].part_no = 'SYNTHETIC-REVISED-PART';
  revised.planData!.injection.records[0].model_name = 'SYNTHETIC-REVISED-MODEL';
  const machine = first(revised);
  assert.equal(machine.qualityState.data, null);
  assert.equal(machine.currentPlanId, null);
  assert.deepEqual(machine.currentParts, []);
  assert.equal(machine.model, '');
  assert.equal(machine.productionTone, 'stale');
  assert.equal(machine.productionQuantity, null);
});

test('retained same-day observations age using their source deadlines, not render time', () => {
  const input = fixture();
  const initial = first(input);
  const later = first({ ...input, nowMs: NOW + 360_000, previousQualityStates: { 1: initial.qualityState } });
  assert.equal(later.productionTone, 'stale');
  assert.equal(later.currentCycleTimeSec, null);
  assert.equal(later.productionQuantity, 24);
  assert.equal(later.qualityView.freshness, 'stale');
  assert.equal(later.qualityView.historical, true);
  assert.equal(later.qualityView.firstStatus, 'unknown');
  assert.equal(later.qualityView.counts.passed, 1);
});

test('transport failure preserves factual values and marks quality historical without granting success', () => {
  const input = fixture();
  const initial = first(input);
  const failed = first({ ...input, transportError: true, previousQualityStates: { 1: initial.qualityState } });
  assert.equal(failed.productionQuantity, 24);
  assert.equal(failed.productionTone, 'stale');
  assert.equal(failed.qualityView.availability, 'error');
  assert.equal(failed.qualityView.firstStatus, 'unknown');
  assert.equal(failed.qualityView.historical, true);
  assert.equal(failed.qualityView.counts.passed, 1);
});

test('delayed older read generation cannot replace a newer result', () => {
  const input = fixture();
  const initial = first(input);
  const delayed = quality();
  delayed.read_generation = 9;
  delayed.first = { status: 'failed', last_known_status: 'failed', checks: [
    { kind: 'first', status: 'failed', checked_at: '2026-10-04T03:18:00Z', warnings: [] },
  ] };
  input.statusData!.injection[0].inspection_status = delayed;
  const machine = first({ ...input, previousQualityStates: { 1: initial.qualityState } });
  assert.strictEqual(machine.qualityState, initial.qualityState);
  assert.equal(machine.qualityView.counts.failed, 0);
  assert.equal(machine.qualityState.maxReadGeneration, 10);
});

test('missing quality payload preserves the scope high-water mark and rejects a delayed response', () => {
  const input = fixture();
  const initial = first(input);
  input.statusData!.injection[0].inspection_status = undefined;
  const cleared = first({ ...input, previousQualityStates: { 1: initial.qualityState } });
  assert.equal(cleared.qualityState.data, null);
  assert.equal(cleared.qualityState.maxReadGeneration, 10);
  input.statusData!.injection[0].inspection_status = { ...quality(), read_generation: 9 };
  const delayed = first({ ...input, previousQualityStates: { 1: cleared.qualityState } });
  assert.equal(delayed.qualityState.data, null);
});

test('whole plan or status source loss quarantines its payload but retains generation against delayed restoration', () => {
  for (const missing of ['planData', 'statusData'] as const) {
    const input = fixture();
    const initial = first(input);
    const lost = first({ ...input, [missing]: undefined, previousQualityStates: { 1: initial.qualityState } });
    assert.equal(lost.currentPlanId, null, missing);
    assert.equal(lost.qualityView.data, null, missing);
    assert.equal(lost.qualityState.data, null, missing);
    assert.equal(lost.qualityState.maxReadGeneration, 10, missing);
    input.statusData!.injection[0].inspection_status = { ...quality(), read_generation: 9 };
    const delayed = first({ ...input, previousQualityStates: { 1: lost.qualityState } });
    assert.equal(delayed.qualityState.data, null, missing);
    input.statusData!.injection[0].inspection_status = { ...quality(), read_generation: 11 };
    const restored = first({ ...input, previousQualityStates: { 1: delayed.qualityState } });
    assert.equal(restored.qualityState.data?.read_generation, 11, missing);
  }
});

test('empty or unobserved zero matrix is unknown while an observed zero stays zero', () => {
  const input = fixture();
  input.statusData = undefined;
  input.mesData!.actual_production_matrix['1'] = [];
  assert.equal(first(input).productionQuantity, null);
  input.mesData!.actual_production_matrix['1'] = [0];
  input.mesData!.capacity_observed_matrix = { '1': [false] };
  assert.equal(first(input).productionQuantity, null);
  input.mesData!.capacity_observed_matrix = { '1': [true] };
  assert.equal(first(input).productionQuantity, 0);
});

test('an exact new plan scope resets generation without retaining the old plan result', () => {
  const input = fixture();
  const initial = first(input);
  input.planData!.injection.records[0] = { ...input.planData!.injection.records[0], id: 71,
    part_no: 'SYNTHETIC-NEXT-PART', model_name: 'SYNTHETIC-NEXT-MODEL' };
  const status = input.statusData!.injection[0];
  status.parts[0].plan_id = 71;
  status.transition!.current_plan_id = 71;
  status.inspection_scope = { ...status.inspection_scope!, current_plan_id: 71, plan_version: 'b'.repeat(64) };
  status.inspection_status = { ...quality(), current_plan_id: 71, plan_version: 'b'.repeat(64),
    read_generation: 1, binding_generation: 1 };
  const machine = first({ ...input, previousQualityStates: { 1: initial.qualityState } });
  assert.equal(machine.currentPlanId, 71);
  assert.deepEqual(machine.currentParts, ['SYNTHETIC-NEXT-PART']);
  assert.equal(machine.qualityState.maxReadGeneration, 1);
  assert.equal(machine.qualityState.data?.current_plan_id, 71);
});

test('new day cannot display retained previous-day products, quantities or quality', () => {
  const machine = first({ ...fixture(), requestedBusinessDate: '2026-10-05' });
  assert.equal(machine.currentPlanId, null);
  assert.deepEqual(machine.currentParts, []);
  assert.equal(machine.productionQuantity, null);
  assert.equal(machine.plannedQuantity, null);
  assert.equal(machine.qualityState.data, null);
});

test('wrong-day matrix and explicit old-day status cannot become current observations', () => {
  const input = fixture();
  input.mesData!.time_slots[0].time = '2026-10-03T03:38:00Z';
  input.statusData!.injection[0].inspection_scope!.business_date = '2026-10-03';
  const machine = first(input);
  assert.equal(machine.productionQuantity, null);
  assert.equal(machine.productionTone, 'stale');
  assert.equal(machine.currentPlanId, null);
  assert.equal(machine.qualityState.data, null);
});

test('production collection freshness and independently verified quality freshness remain separate', () => {
  const machine = first({ ...fixture(), mesData: undefined });
  assert.equal(machine.productionTone, 'stale');
  assert.equal(machine.productionQuantity, 24);
  assert.equal(machine.qualityView.freshness, 'fresh');
  assert.equal(machine.qualityView.data?.complete, false);
});

test('future source timestamps do not animate a live production machine', () => {
  const input = fixture();
  input.mesData!.machine_sources!['1'].latest_capacity_at = '2026-10-04T03:39:00Z';
  const machine = first(input);
  assert.equal(machine.productionTone, 'stale');
  assert.equal(machine.currentCycleTimeSec, null);
});


test('inspection board never invents due time or activity without linked evidence', () => {
  const empty = first({ ...fixture(), planData: undefined, statusData: undefined, mesData: undefined });
  assert.deepEqual(inspectionBoardActivity(empty.qualityView), {
    schedule: 'unconnected', nextDueAt: null, inspecting: false, observedAt: null,
  });
  const unverified = inspectionBoardActivity(first().qualityView);
  assert.equal(unverified.schedule, 'unknown');
  assert.equal(unverified.nextDueAt, null);
  assert.equal(unverified.inspecting, false);
  assert.equal(unverified.observedAt, quality().observed_at);
});

test('inspection board uses verified due deadline and removes live delay on stale data', () => {
  const input = fixture();
  const payload = quality();
  payload.complete = true;
  payload.periodic = { status: 'waiting', last_known_status: 'waiting',
    checks: [{ kind: 'periodic', status: 'waiting', checked_at: null, warnings: [] }],
    last_checked_at: null, last_result: 'unknown', next_due_at: '2026-10-04T03:39:00Z', schedule_status: 'scheduled' };
  input.statusData!.injection[0].inspection_status = payload;
  assert.equal(inspectionBoardActivity(first(input).qualityView).schedule, 'scheduled');
  const due = inspectionBoardActivity(first({ ...input, nowMs: Date.parse(payload.periodic.next_due_at!) }).qualityView);
  assert.equal(due.schedule, 'overdue');
  assert.equal(due.nextDueAt, payload.periodic.next_due_at);
  const stale = inspectionBoardActivity(first({ ...input, nowMs: Date.parse(payload.fresh_until!) }).qualityView);
  assert.equal(stale.schedule, 'unknown');
  assert.equal(stale.nextDueAt, null);
  assert.equal(stale.observedAt, payload.observed_at);
});

test('inspection animation requires fresh in-progress evidence and stops on failed transport', () => {
  const input = fixture();
  const payload = quality();
  payload.periodic.checks = [{ kind: 'periodic', status: 'in_progress', checked_at: null, warnings: [] }];
  input.statusData!.injection[0].inspection_status = payload;
  assert.equal(inspectionBoardActivity(first(input).qualityView).inspecting, true);
  assert.equal(inspectionBoardActivity(first({ ...input, transportError: true }).qualityView).inspecting, false);
  assert.equal(inspectionBoardActivity(first({ ...input, nowMs: Date.parse(payload.fresh_until!) }).qualityView).inspecting, false);
});
