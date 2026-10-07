import test from 'node:test';
import assert from 'node:assert/strict';
import { stationMesBadgeLabel, stationMesInspectionView } from '../src/pages/quality/inspection-requests/mesInspectionSignal.ts';
import type { MesInspectionRecord, MesInspectionSignalEvidence } from '../src/pages/quality/inspection-requests/mesInspectionSignal.ts';
import { stationProductionSummary } from '../src/pages/quality/inspection-requests/stationPickerModel.ts';
import type { InspectionKanban, InspectionMachine } from '../src/pages/quality/inspection-requests/kanban.ts';

const now = Date.parse('2026-10-07T08:00:00Z');
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const record = (patch: Partial<MesInspectionRecord> = {}): MesInspectionRecord => ({
  qc_id: 'qc-first', work_order_id: 'work-7', production_task_id: 'task-7', plan_id: 'mes-plan-7',
  kind: 'first', current_state_verified: true, state: 'requested', judgement: null,
  requested_at: at(-120), planned_at: null, official_deadline_at: null, completed_at: null, ...patch,
});
const evidence = (patch: Partial<MesInspectionSignalEvidence> = {}): MesInspectionSignalEvidence => ({
  schema_version: 'mes-inspection-signal.v1', source_kind: 'synthetic_contract_fixture', business_date: '2026-10-07',
  machine_number: 7, current_plan_id: 7, plan_version: 'current-plan-version', observed_at: at(0), fresh_until: at(10),
  current_state_verified: true, stale: false, complete: true, first_inspection_required: false,
  current_work: { work_order_id: 'work-7', production_task_id: 'task-7', plan_id: 'mes-plan-7', part_no: 'PART-7', product_name: '제품명', production_status: 'running' },
  inspections: [record()], ...patch,
});
function fixture(value: MesInspectionSignalEvidence | undefined = evidence()) {
  const machine = { machine_number: 7, plans: [{ id: 7, part_no: 'PART-7', execution_status: 'running', sequence: 1 }], requests: [], mes_inspection_signal: value } as unknown as InspectionMachine;
  const snapshot = { business_date: '2026-10-07', plan_snapshot: { version: 'current-plan-version', complete: true }, plans_truncated: false, executions_truncated: false, machines: [machine] } as unknown as InspectionKanban;
  return { machine, snapshot, view: (time = now, transportError = false) => stationMesInspectionView(machine, snapshot, time, { transportError }) };
}
const passed = (patch: Partial<MesInspectionRecord> = {}) => record({ state: 'completed', judgement: 'pass', completed_at: at(-30), ...patch });

test('actual request elapsed has no invented deadline and survives refresh timestamp changes', () => {
  const f = fixture();
  assert.equal(f.view().badges[0].state, 'requested');
  assert.equal(f.view().badges[0].elapsed_minutes, 120);
  f.snapshot.generated_at = at(4);
  f.machine.mes_inspection_signal!.observed_at = at(4);
  assert.equal(f.view(now + 4 * 60_000).badges[0].elapsed_minutes, 124);
  const longWait = fixture(evidence({ inspections: [record({ requested_at: at(-10_000) })] })).view();
  assert.equal(longWait.badges[0].state, 'requested');
  assert.equal(longWait.badges[0].elapsed_minutes, 10_000);
});
test('planned time requires inspection; only a supplied official deadline makes it overdue', () => {
  assert.equal(fixture(evidence({ inspections: [record({ planned_at: at(-1) })] })).view().badges[0].state, 'needed');
  assert.equal(fixture(evidence({ inspections: [record({ official_deadline_at: at(1) })] })).view().badges[0].state, 'requested');
  assert.equal(fixture(evidence({ inspections: [record({ official_deadline_at: at(-1) })] })).view().badges[0].state, 'overdue');
  assert.equal(fixture(evidence({ inspections: [record({ state: 'in_progress', planned_at: at(-1) })] })).view().badges[0].state, 'in_progress');
  const missingTime = fixture(evidence({ inspections: [record({ state: 'needed', requested_at: null })] })).view().badges[0];
  assert.equal(missingTime.state, 'needed');
  assert.equal(missingTime.elapsed_minutes, null);
});
test('green requires current complete bound running MES evidence and an explicit completion/pass', () => {
  const valid = evidence({ inspections: [passed()] });
  assert.equal(fixture(valid).view().badges[0].state, 'completed');
  for (const patch of [{ state: 'requested' }, { judgement: null }, { judgement: 'fail' }, { completed_at: null }, { current_state_verified: false }] as Partial<MesInspectionRecord>[]) {
    assert.notEqual(fixture(evidence({ inspections: [passed(patch)] })).view().badges[0].state, 'completed');
  }
  for (const patch of [{ complete: false }, { current_state_verified: false }, { stale: true }, { first_inspection_required: null }, { fresh_until: null }, { fresh_until: at(-1) }] as Partial<MesInspectionSignalEvidence>[]) {
    assert.notEqual(fixture({ ...valid, ...patch }).view().badges[0].state, 'completed');
  }
  assert.notEqual(fixture(valid).view(now, true).badges[0].state, 'completed');
  assert.equal(fixture(valid).view(now + 10 * 60_000).evidence_state, 'stale');
});
test('work/plan/day/part changes and ambiguous current plans cannot retain green', () => {
  for (const patch of [{ work_order_id: 'old-work' }, { production_task_id: 'old-task' }, { plan_id: 'old-plan' }]) {
    assert.equal(fixture(evidence({ inspections: [passed(patch)] })).view().evidence_state, 'work_changed');
  }
  for (const patch of [{ business_date: '2026-10-06' }, { current_plan_id: 8 }, { plan_version: 'old-version' }, { machine_number: 8 }] as Partial<MesInspectionSignalEvidence>[]) {
    assert.equal(fixture(evidence({ ...patch, inspections: [passed()] })).view().evidence_state, 'work_changed');
  }
  const f = fixture(evidence({ inspections: [passed()] }));
  f.machine.plans[0].part_no = 'NEW-PART';
  assert.equal(f.view().evidence_state, 'work_changed');
  f.machine.plans[0].part_no = 'PART-7';
  f.machine.plans.push({ ...f.machine.plans[0], id: 8 });
  assert.equal(f.view().evidence_state, 'work_changed');
});
test('stopped production, missing observations, and duplicate QC never show green', () => {
  for (const production_status of ['paused', 'stopped', 'completed', 'unknown'] as const) {
    const source = evidence({ inspections: [passed()] });
    source.current_work!.production_status = production_status;
    assert.notEqual(fixture(source).view().badges[0].state, 'completed');
  }
  assert.equal(fixture(evidence({ inspections: [] })).view().badges[0].state, 'unknown');
  assert.equal(fixture(evidence({ inspections: [passed(), passed()] })).view().evidence_state, 'unverified');
});
test('first failure suppresses periodic green and inspection kinds remain distinct', () => {
  const view = fixture(evidence({ inspections: [passed({ judgement: 'fail' }), passed({ qc_id: 'qc-periodic', kind: 'periodic' }), record({ qc_id: 'qc-production', kind: 'production' })] })).view();
  assert.deepEqual(view.badges.map(row => [row.kind, row.state]), [['first', 'failed'], ['periodic', 'unknown'], ['production', 'requested']]);
  assert.equal(stationMesBadgeLabel(view.badges[0], 'ko'), '초검 불합격');
  assert.equal(stationMesBadgeLabel(view.badges[1], 'zh'), '巡检 未确认');
  const required = fixture(evidence({ first_inspection_required: true, inspections: [passed({ qc_id: 'qc-periodic', kind: 'periodic' })] })).view();
  assert.deepEqual(required.badges.map(row => [row.kind, row.state]), [['first', 'needed'], ['periodic', 'unknown']]);
  const series = fixture(evidence({ inspections: [passed({ kind: 'periodic' }), passed({ qc_id: 'another-qc', kind: 'periodic' })] })).view();
  assert.equal(series.badges[0].state, 'unknown');
  for (const first_inspection_required of [true, false]) {
    const ambiguous = fixture(evidence({ first_inspection_required, inspections: [passed(), record({ qc_id: 'another-first' }), passed({ qc_id: 'periodic-pass', kind: 'periodic' })] })).view();
    assert.deepEqual(ambiguous.badges.map(row => [row.kind, row.state]), [['first', 'unknown'], ['periodic', 'unknown']]);
  }
});
test('malformed/future timestamps are unverified; completion and observation are not request times', () => {
  for (const patch of [{ requested_at: at(1) }, { requested_at: '2026-10-07T08:00:00' }, { official_deadline_at: 'bad' }, { completed_at: at(1) }, { requested_at: at(-1), completed_at: at(-2) }]) {
    assert.equal(fixture(evidence({ inspections: [passed(patch)] })).view().evidence_state, 'unverified');
  }
  assert.equal(fixture(evidence({ inspections: [passed({ requested_at: null })] })).view().badges[0].elapsed_minutes, null);
});
test('legacy WJ-only DTO keeps plan labels and local pass never becomes MES green', () => {
  const f = fixture();
  delete f.machine.mes_inspection_signal;
  f.machine.requests = [{ status: 'approved', judgement: 'pass', mes_completion_status: 'completed' }] as InspectionMachine['requests'];
  assert.equal(f.view().badges[0].state, 'unknown');
  const production = stationProductionSummary(f.machine, f.view(), 'ko');
  assert.equal(production.part, 'PART-7');
  assert.equal(production.product, 'WJ 계획 품번');
  assert.equal(production.production, 'WJ 가동 기록');
});
