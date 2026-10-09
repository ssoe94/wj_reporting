import assert from 'node:assert/strict';
import test from 'node:test';
import { filterInspectionManagement, inspectionPredatesBusinessDay } from '../src/pages/quality/inspection-requests/managementFilters.ts';
import type { ManagementFilter } from '../src/pages/quality/inspection-requests/managementFilters.ts';
import type { InspectionKanban, InspectionMachine, InspectionPlan, KanbanInspectionRequest } from '../src/pages/quality/inspection-requests/kanban.ts';
import type { MesReadObservation } from '../src/pages/quality/inspection-requests/mesReadObservation.ts';

const all: ManagementFilter = { stage: 'all', machine: 'all', search: '' };
const dayStart = '2026-10-06T08:00:00+08:00';
const request = (id: number, fields: Partial<KanbanInspectionRequest> = {}): KanbanInspectionRequest => ({
  id, work_order_ref: `WO-${id}`, task_ref: `TASK-${id}`, part_no: `PART-${id}`, equipment_ref: '', lot_ref: `LOT-${id}`,
  inspection_type: 'first', target_quantity: '1', uom: 'EA', warehouse_ref: '', work_started_at: dayStart,
  inspection_items: [], require_evidence: false, quantity_mode: 'recorded', judgement_policy: 'strict_items',
  measurements: [], evidence: [], inspected_quantity: '0', accepted_quantity: '0', rejected_quantity: '0', judgement: '', notes: '',
  source_kind: 'manual', parent: null, assigned_to: null, assigned_to_name: '', status: 'draft', version: 1,
  submitted_by: null, submitted_at: null, reviewed_by: null, reviewed_at: null, review_reason: '',
  sync_status: 'not_synced', mes_completion_status: 'not_completed', injection_receipt_readiness: 'not_verified',
  mes_checked_at: null, external_result_id: '', mes_state: { task_status: null, qc_status: null, state_version: null, receipt_allowed: null },
  last_error_code: '', created_at: dayStart, updated_at: dayStart,
  capabilities: { can_edit: true, can_submit: true, can_review: false, can_reinspect: false, can_sync: false, can_refresh: false },
  ...fields,
});
const plan = (id: number, fields: Partial<InspectionPlan> = {}): InspectionPlan => ({
  id, machine_name: '', part_no: `PLAN-PART-${id}`, lot_no: `PLAN-LOT-${id}`, sequence: 1,
  planned_quantity: '1', updated_at: dayStart, execution_status: null, ...fields,
});
const observation = (id: string, fields: Partial<MesReadObservation> = {}): MesReadObservation => ({
  observation_key: `fixture:${id}`, identity: id, qc_id: id, qc_code: `QC-${id}`, work_order_id: `MES-WO-${id}`,
  production_task_id: `MES-TASK-${id}`, equipment_id: null, snapshot_id: null, plan_name: `MES-PLAN-${id}`,
  kind: 'first', lifecycle: { code: null, message: null }, judgement: { code: null, message: null },
  observed_at: dayStart, source_updated_at: null, evidence_kind: 'synthetic_contract_fixture', warnings: [],
  binding_status: 'unresolved', read_only: true, current_state_verified: false, physical_operation_verified: false, items: [], ...fields,
});
const machine = (number: number, requests: KanbanInspectionRequest[] = [], plans: InspectionPlan[] = [], observations: MesReadObservation[] = []): InspectionMachine => ({
  machine_number: number, station_id: `imm${number}`, mapping_status: 'mapped', plan_status: plans.length ? 'present' : 'missing',
  plans, requests, mes_observations: observations, request_count: requests.length, requests_truncated: false,
  dry_run: { enabled: false, mode: 'dry_run', candidate: 'unknown', recommendation: 'unknown', blocking_reasons: [], plan_version: 'fixture', requires_new_first_inspection_on_resume: 'unknown' },
});
function snapshot(): InspectionKanban {
  const completed = request(103, { status: 'approved', sync_status: 'succeeded', mes_completion_status: 'completed',
    mes_state: { task_status: 2, qc_status: 1, state_version: null, receipt_allowed: null }, mes_checked_at: dayStart });
  const machines = Array.from({ length: 17 }, (_, index) => machine(index + 1));
  machines[0] = machine(1, [request(101, { equipment_ref: 'imm1' }), request(102, { status: 'approved' }), completed,
    { ...completed, id: 104, sync_status: 'unknown' }, { ...completed, id: 105, mes_checked_at: null },
    { ...completed, id: 106, sync_status: 'pending' }], [plan(901, { machine_name: 'imm1', part_no: 'Alpha-Mold' }), plan(902)], [observation('A')]);
  machines[9] = machine(10, [request(201, { equipment_ref: 'imm10', part_no: 'Direct-Needle' })], [plan(910, { machine_name: 'imm10' })], [observation('B')]);
  machines[10] = machine(11, [], [plan(911, { machine_name: 'imm11', part_no: 'Only-Plan' })]);
  machines[11] = machine(12, [], [], [observation('C')]);
  return {
    schema_version: 'inspection-kanban.v1', business_date: '2026-10-06', day_start: dayStart, day_end: '2026-10-07T08:00:00+08:00', generated_at: dayStart,
    plan_snapshot: { source: 'ProductionPlan', version: 'fixture', latest_changed_at: null, shift_stored: false, work_task_binding_available: false, complete: true },
    machines, unmapped_requests: [request(301, { work_order_ref: 'Unmapped-Order' }), request(302, { status: 'submitted' })],
    unmapped_plans: [plan(999, { part_no: 'Unmapped-Product' })], mes_unmapped_observations: [observation('Unmapped')],
    requests_truncated: false, plans_truncated: false, executions_truncated: false,
    counts: { requests_displayed: 9, plans_displayed: 5, unmapped_requests: 2, unmapped_plans: 1 },
  };
}
const requestIds = (result: ReturnType<typeof filterInspectionManagement>) => [...result.machines.flatMap((item) => item.requests), ...result.unmappedRequests].map((item) => item.id);

test('default projection preserves all source content, including empty machines and contextual plans', () => {
  const source = snapshot();
  const before = structuredClone(source);
  const result = filterInspectionManagement(source, all);
  assert.deepEqual(result, { machines: source.machines, unmappedRequests: source.unmapped_requests,
    unmappedPlans: source.unmapped_plans, mesUnmappedObservations: source.mes_unmapped_observations, requestCount: 9 });
  assert.equal(result.machines.length, 17);
  for (const stage of ['waiting', 'in_progress', 'completed', 'blocked'] as const) {
    filterInspectionManagement(source, { ...all, stage, search: 'Alpha' });
  }
  assert.deepEqual(source, before);
});

test('stage filters reuse strict MES completion and keep unknown observations blocked, not delayed', () => {
  const source = snapshot();
  const expected = { waiting: [101, 201, 301], in_progress: [102, 106, 302], completed: [103], blocked: [104, 105] };
  for (const stage of Object.keys(expected) as (keyof typeof expected)[]) {
    const result = filterInspectionManagement(source, { ...all, stage });
    assert.deepEqual(requestIds(result), expected[stage]);
    assert.equal(result.requestCount, expected[stage].length);
    assert.ok(result.machines.every((item) => item.requests.length > 0));
    assert.ok(result.machines.every((item) => item.mes_observations?.length === 0));
    assert.deepEqual(result.mesUnmappedObservations, []);
    assert.deepEqual(result.unmappedPlans, []);
  }
  assert.deepEqual(filterInspectionManagement(source, { ...all, stage: 'completed' }).machines[0].plans, source.machines[0].plans);
  // These are local presentation stages, not model.status values or backend query parameters.
  assert.deepEqual(requestIds(filterInspectionManagement(source, { ...all, stage: 'approved' as ManagementFilter['stage'] })), []);
  assert.deepEqual(requestIds(filterInspectionManagement(source, { ...all, stage: 'delayed' as ManagementFilter['stage'] })), []);
  assert.equal(source.machines[0].requests.find((item) => item.id === 102)?.status, 'approved');
});

test('machine selectors fail closed and bare numeric search never expands 1 into machine 10 or 11', () => {
  const source = snapshot();
  assert.deepEqual(filterInspectionManagement(source, { ...all, search: ' 1 ' }).machines.map((item) => item.machine_number), [1]);
  assert.deepEqual(filterInspectionManagement(source, { ...all, search: '10' }).machines.map((item) => item.machine_number), [10]);
  const selected = filterInspectionManagement(source, { ...all, machine: '1' });
  assert.deepEqual(selected.machines.map((item) => item.machine_number), [1]);
  assert.deepEqual([selected.unmappedRequests, selected.unmappedPlans, selected.mesUnmappedObservations], [[], [], []]);
  assert.deepEqual(filterInspectionManagement(source, { ...all, machine: '17' }).machines.map((item) => item.machine_number), [17]);
  assert.deepEqual(filterInspectionManagement(source, { ...all, search: '17' }).machines, []);
  for (const value of ['', '0', '18', '01', '1.0', '1 ', 'imm1', 'ALL']) {
    assert.deepEqual(filterInspectionManagement(source, { ...all, machine: value }), { machines: [], unmappedRequests: [], unmappedPlans: [], mesUnmappedObservations: [], requestCount: 0 });
  }
});

test('mixed-case plan search opens only its machine context; direct request search keeps all own plans', () => {
  const source = snapshot();
  const context = filterInspectionManagement(source, { ...all, search: '  aLpHa-MoLd  ' });
  assert.deepEqual(context.machines, [source.machines[0]]);
  assert.deepEqual(context.unmappedRequests, []);
  const direct = filterInspectionManagement(source, { ...all, search: 'dIrEcT-NeEdLe' });
  assert.deepEqual(requestIds(direct), [201]);
  assert.equal(direct.machines[0].plans, source.machines[9].plans);
  assert.equal(direct.machines[0].plan_status, 'present');
  assert.deepEqual(direct.machines[0].mes_observations, []);
  const staged = filterInspectionManagement(source, { ...all, stage: 'completed', search: 'alpha' });
  assert.deepEqual(requestIds(staged), [103]);
  assert.equal(staged.machines[0].plans, source.machines[0].plans);
  assert.deepEqual(filterInspectionManagement(source, { ...all, search: 'only-plan' }).machines.map((item) => item.machine_number), [11]);
  assert.deepEqual(filterInspectionManagement(source, { ...all, stage: 'waiting', search: 'only-plan' }).machines, []);
  assert.equal(source.plan_snapshot.work_task_binding_available, false);
});

test('all allowlisted request, plan and MES observation search fields work without reading unrelated content', () => {
  for (const field of ['work_order_ref', 'task_ref', 'part_no', 'equipment_ref', 'lot_ref'] as const) {
    const source = snapshot();
    source.machines[9].requests[0][field] = 'FiElD-NeEdLe';
    assert.deepEqual(requestIds(filterInspectionManagement(source, { ...all, search: 'field-needle' })), [201], field);
  }
  assert.deepEqual(requestIds(filterInspectionManagement(snapshot(), { ...all, search: '201' })), [201]);
  for (const field of ['machine_name', 'part_no', 'lot_no'] as const) {
    const source = snapshot();
    source.machines[9].plans[0][field] = 'FiElD-NeEdLe';
    assert.deepEqual(filterInspectionManagement(source, { ...all, search: 'field-needle' }).machines, [source.machines[9]], field);
  }
  assert.deepEqual(filterInspectionManagement(snapshot(), { ...all, search: '910' }).machines.map((item) => item.machine_number), [10]);
  for (const field of ['qc_code', 'qc_id', 'work_order_id', 'production_task_id', 'plan_name'] as const) {
    const source = snapshot();
    source.machines[11].mes_observations![0][field] = 'FiElD-NeEdLe';
    const result = filterInspectionManagement(source, { ...all, search: 'field-needle' });
    assert.deepEqual(result.machines.map((item) => item.machine_number), [12], field);
    assert.equal(result.machines[0].mes_observations?.length, 1);
    assert.equal(result.requestCount, 0);
    assert.deepEqual(filterInspectionManagement(source, { ...all, stage: 'waiting', search: 'field-needle' }).machines, []);
  }
  const source = snapshot();
  source.machines[0].requests[0].notes = 'excluded-private-note';
  assert.deepEqual(filterInspectionManagement(source, { ...all, search: 'excluded-private-note' }).machines, []);
});

test('unmapped searches remain independent and never associate a matching plan with unrelated records', () => {
  const source = snapshot();
  const unmapped = filterInspectionManagement(source, { ...all, machine: 'unmapped' });
  assert.deepEqual(unmapped.machines, []);
  assert.deepEqual(unmapped.unmappedRequests, source.unmapped_requests);
  assert.equal(unmapped.requestCount, 2);
  const requestMatch = filterInspectionManagement(source, { ...all, search: 'unmapped-order' });
  assert.deepEqual(requestIds(requestMatch), [301]);
  assert.deepEqual([requestMatch.unmappedPlans, requestMatch.mesUnmappedObservations], [[], []]);
  const planMatch = filterInspectionManagement(source, { ...all, search: 'unmapped-product' });
  assert.deepEqual(planMatch.unmappedPlans, source.unmapped_plans);
  assert.deepEqual([planMatch.machines, planMatch.unmappedRequests, planMatch.mesUnmappedObservations], [[], [], []]);
  const mesMatch = filterInspectionManagement(source, { ...all, search: 'qc-unmapped' });
  assert.deepEqual(mesMatch.mesUnmappedObservations, source.mes_unmapped_observations);
  assert.equal(mesMatch.requestCount, 0);
  const staged = filterInspectionManagement(source, { ...all, machine: 'unmapped', stage: 'waiting' });
  assert.deepEqual(requestIds(staged), [301]);
  assert.deepEqual([staged.unmappedPlans, staged.mesUnmappedObservations], [[], []]);
});

test('previous-production-day badge uses finite strict boundary comparison, never an age-based delay rule', () => {
  assert.equal(inspectionPredatesBusinessDay('2026-10-06T07:59:59.999+08:00', dayStart), true);
  assert.equal(inspectionPredatesBusinessDay('2026-10-06T00:00:00Z', dayStart), false);
  assert.equal(inspectionPredatesBusinessDay('2026-10-06T08:00:00+08:00', dayStart), false);
  assert.equal(inspectionPredatesBusinessDay('2026-10-07T08:00:00+08:00', dayStart), false);
  for (const value of ['', 'invalid', 'Infinity']) {
    assert.equal(inspectionPredatesBusinessDay(value, dayStart), false);
    assert.equal(inspectionPredatesBusinessDay(dayStart, value), false);
  }
});

test('trial requests stay outside production cards and counts for default and searched projections', () => {
  const source = snapshot();
  source.machines[0].requests.push(request(501, { source_kind: 'integration_test' }));
  source.unmapped_requests.push(request(502, { mes_workflow: { test_only: true } as KanbanInspectionRequest['mes_workflow'] }));
  const before = structuredClone(source);
  assert.equal(filterInspectionManagement(source, all).requestCount, 9);
  assert.equal(filterInspectionManagement(source, { ...all, search: '501' }).requestCount, 0);
  assert.equal(filterInspectionManagement(source, { ...all, machine: 'unmapped' }).requestCount, 2);
  assert.deepEqual(source, before);
});
