import assert from 'node:assert/strict';
import test from 'node:test';
import * as service from '../src/domains/production/plan-workflow-service.ts';
import { serviceWorkflowFixture } from './fixtures/plan-workflow-service.ts';
import type { WorkflowData, WorkflowGroup, WorkflowRequest, WorkflowScope } from '../src/domains/production/plan-workflow-api.ts';

const UID = '00000000-0000-4000-8000-000000000001';
const OTHER_UID = '00000000-0000-4000-8000-000000000002';
const MES_ID = '17000000000000001';
const SCOPE: WorkflowScope = { start: '2026-10-08', end: '2026-10-10', plan_type: 'injection' };
test('queue never treats an old MES ID as completion after plan or material changes', () => {
  const data = serviceWorkflowFixture(['created']); const group = data.preview[0];
  assert.equal(service.planWorkflowStage(group, data.rows, 'created', MES_ID), 'created');
  group.blockers = ['mes_observation_incomplete'];
  assert.equal(service.planWorkflowStage(group, data.rows, 'created', MES_ID), 'created');
  group.blockers = [];
  assert.equal(service.planWorkflowStage(group, data.rows, 'uncertain', MES_ID), 'review');
  assert.equal(service.planWorkflowStage(group, data.rows, null, MES_ID), 'review');
  assert.equal(service.planWorkflowStage(group, data.rows, null, null), 'issue');
  group.blockers = ['material_confirmation']; data.rows[0].approval = null;
  assert.equal(service.planWorkflowStage(group, data.rows, 'created', MES_ID), 'materials');
  group.blockers = ['plan_quantity_review'];
  assert.equal(service.planWorkflowStage(group, data.rows, 'created', MES_ID), 'plan');
  assert.equal(service.planConfirmationTime('2026-10-09T23:00:00Z'), '2026-10-10 07:00');
});
function uid(index: number) { return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`; }

function fixture() {
  const request: WorkflowRequest = { uid: UID, work_order_code: 'WJ-SYNTHETIC-PLAN', operation: 'create',
    state: 'disabled', blockers: [], attempt: 0, mes_id: null, can_send: true, can_recheck: false };
  const group: WorkflowGroup = { key: 'a'.repeat(64), machine_name: 'SYNTHETIC-IMM01',
    part_no: 'SYNTHETIC-PART', quantity: '2300', planned_start: '2026-10-08T08:00:00+08:00',
    planned_end: '2026-10-11T08:00:00+08:00', operation: 'create', blockers: [],
    work_order_code: request.work_order_code, mes_id: null, members: [OTHER_UID],
    versions: { [OTHER_UID]: 1 }, reported_quantity: null, inbound_quantity: null };
  const data: WorkflowData = { write_enabled: true, can_edit: true, can_manage_defaults: true,
    rows: [], catalog: { dataset_id: null, refreshed_at: null, materials: [] }, preview: [group], requests: [request] };
  return { data, group, request };
}

function result(index: number, state = 'created', patch: Record<string, unknown> = {}) {
  return { uid: uid(index), code: `WJ-SYNTHETIC-${index}`, state, mes_id: MES_ID, blockers: [], ...patch };
}

test('selected creation requires explicit writer, edit and request permissions with an unconsumed create request', () => {
  const { data, group, request } = fixture(), attempted = new Set<string>();
  assert.equal(service.canSendPlanRequest(data, group, request, attempted), true);
  assert.equal(service.canSendPlanRequest(data, group, { ...request, state: 'prepared' }, attempted), true);
  assert.equal(service.canSendPlanRequest(data, { ...group, operation: 'unchanged' }, request, attempted), true,
    'a saved preparation may have an unchanged preview before its first MES send');
  for (const patch of [{ write_enabled: false }, { write_enabled: undefined }, { write_enabled: 'true' },
    { can_edit: false }, { can_edit: undefined }]) {
    assert.equal(service.canSendPlanRequest({ ...data, ...patch } as unknown as WorkflowData,
      group, request, attempted), false);
  }
  assert.equal(service.canSendPlanRequest(data, group, undefined, attempted), false);
  for (const patch of [{ can_send: false }, { can_send: undefined }, { attempt: undefined },
    { attempt: 1 }, { attempt: 2 }, { attempt: -1 }, { operation: 'update' }, { uid: 'invalid' },
    { blockers: ['material_confirmation'] }]) {
    assert.equal(service.canSendPlanRequest(data, group, { ...request, ...patch }, attempted), false);
  }
  for (const state of ['checking', 'sending', 'uncertain', 'readback_pending', 'review', 'confirmed',
    'created', 'already_exists', 'superseded']) {
    assert.equal(service.canSendPlanRequest(data, group, { ...request, state }, attempted), false, state);
  }
});

test('only explicit fresh failed preflight with attempt0 can release a local latch; actual send ambiguity remains fenced', () => {
  const { data, group, request } = fixture();
  const failedPreflight = { ...request, state: 'failed', attempt: 0, can_send: true, mes_id: '' };
  const attempted = new Set([request.uid]);
  assert.equal(service.canReleasePlanSendAttempt(failedPreflight), true);
  assert.equal(service.canSendPlanRequest(data, group, failedPreflight, attempted), false,
    'failed preflight metadata does not itself clear the local attempt set');
  assert.equal(service.canSendPlanRequest(data, group, failedPreflight, new Set()), true,
    'explicit reselection can proceed after the owner accepts a fresh server preflight result');
  for (const patch of [{ state: 'checking' }, { state: 'uncertain' }, { state: 'sending' },
    { state: 'prepared' }, { attempt: 1 }, { attempt: undefined }, { can_send: false },
    { can_send: undefined }, { operation: 'update' }, { blockers: ['readback_required'] },
    { mes_id: MES_ID }, { uid: 'invalid' }]) {
    assert.equal(service.canReleasePlanSendAttempt({ ...failedPreflight, ...patch }), false);
  }
  assert.equal(service.canReleasePlanSendAttempt({ ...failedPreflight,
    mes_id: Number(MES_ID) } as unknown as WorkflowRequest), false);
  assert.equal(service.canSendPlanRequest(data, group, { ...failedPreflight, attempt: 1 }, new Set()), false);
  assert.equal(service.canSendPlanRequest(data, group, { ...failedPreflight, can_send: false }, new Set()), false);
});

test('an update, blocker or existing MES identifier cannot be sent as a fresh selected creation', () => {
  const { data, group, request } = fixture(), attempted = new Set<string>();
  for (const patch of [{ operation: 'update' },
    { blockers: ['identity_confirmation'] }, { blockers: ['readback_required'] }, { mes_id: MES_ID }]) {
    assert.equal(service.canSendPlanRequest(data, { ...group, ...patch }, request, attempted), false);
  }
  assert.equal(service.canSendPlanRequest(data, group, { ...request, mes_id: MES_ID }, attempted), false);
  assert.equal(service.canSendPlanRequest(data, group,
    { ...request, mes_id: Number(MES_ID) } as unknown as WorkflowRequest, attempted), false,
    'a rounded numeric MES identifier cannot be treated as absence of an existing order');
});

test('request UID attempt latch stays effective when a WJ session is replaced and does not consume other requests', () => {
  const { data, group, request } = fixture();
  const originalSessionAttempts = new Set([request.uid]);
  const retainedAfterSessionChange = new Set(originalSessionAttempts);
  assert.equal(service.canSendPlanRequest(data, group, request, retainedAfterSessionChange), false);
  assert.equal(service.canSendPlanRequest(data, group, { ...request, uid: OTHER_UID }, retainedAfterSessionChange), true);
  assert.equal(service.canSendPlanRequest(data, group, request, new Set()), true);
});

test('readback requires its own server permission and a valid request identifier', () => {
  const { request } = fixture();
  assert.equal(service.canRecheckPlanRequest(undefined), false);
  assert.equal(service.canRecheckPlanRequest({ ...request, can_recheck: undefined }), false);
  assert.equal(service.canRecheckPlanRequest({ ...request, can_recheck: false }), false);
  assert.equal(service.canRecheckPlanRequest({ ...request, uid: 'invalid', can_recheck: true }), false);
  assert.equal(service.canRecheckPlanRequest({ ...request, state: 'uncertain', attempt: 1, can_recheck: true }), true);
});

test('an individual send preserves scope and exact UIDs but admits at most three requests', () => {
  const selected = [UID, OTHER_UID, uid(3)];
  assert.equal(service.PLAN_CREATE_BATCH_LIMIT, 50);
  assert.equal(service.PLAN_CREATE_REQUEST_LIMIT, 3);
  const body = service.planSendBody(SCOPE, selected);
  assert.deepEqual(body, { ...SCOPE, action: 'send', request_uids: selected });
  selected[0] = OTHER_UID;
  assert.equal(body.request_uids[0], UID, 'body owns a snapshot of the selected request identifiers');
  for (const ids of [[], [UID, UID], ['invalid'], Array.from({ length: 4 }, (_, index) => uid(index + 1)),
    Array.from({ length: 50 }, (_, index) => uid(index + 1))]) {
    assert.throws(() => service.planSendBody(SCOPE, ids));
  }
});

test('a valid selection retains its fifty-request limit and is split into ordered independent chunks of at most three', () => {
  const selected = Array.from({ length: 50 }, (_, index) => uid(index + 1));
  const chunks = service.splitPlanSelection(selected);
  assert.equal(chunks.length, 17);
  assert.deepEqual(chunks.map(chunk => chunk.length), [...Array(16).fill(3), 2]);
  assert.deepEqual(chunks.flat(), selected);
  assert.deepEqual(service.splitPlanSelection(selected.slice(0, 7)), [selected.slice(0, 3), selected.slice(3, 6), selected.slice(6, 7)]);
  assert.deepEqual(service.splitPlanSelection([UID]), [[UID]]);
  chunks.forEach(chunk => assert.doesNotThrow(() => service.planSendBody(SCOPE, chunk)));
  selected[0] = OTHER_UID;
  assert.equal(chunks[0][0], UID, 'chunks retain the original selection after caller mutation');
  chunks[1][0] = uid(99);
  assert.equal(chunks[0][0], UID, 'chunk arrays are independent');
});

test('selection validation rejects duplicate identifiers across chunks before any partial selection is returned', () => {
  const alphaUid = 'abcdef00-0000-4000-8000-000000000001';
  for (const ids of [[], [UID, UID], ['invalid'], [UID, OTHER_UID, uid(3), UID],
    [alphaUid, alphaUid.toUpperCase()],
    Array.from({ length: 51 }, (_, index) => uid(index + 1))]) {
    assert.throws(() => service.splitPlanSelection(ids));
  }
});

test('created and already-existing displays use the server outcome while unresolved states stay unresolved', () => {
  const { request } = fixture();
  assert.equal(service.planRequestState(undefined), null);
  for (const outcome of ['created', 'already_exists']) {
    const current = { ...request, state: 'confirmed', attempt: 1, mes_id: MES_ID,
      last_result: { outcome, mes_id: MES_ID, blockers: [], verified_scope: 'base_creation' } };
    assert.equal(service.planRequestState(current), outcome);
    assert.equal(service.planRequestState({ ...request, state: outcome, attempt: 1, mes_id: MES_ID }), outcome);
  }
  for (const state of ['uncertain', 'failed', 'review']) {
    assert.equal(service.planRequestState({ ...request, state, attempt: 1 }), state);
  }
});

test('MES identifiers remain exact decimal strings and rounded or malformed numeric values cannot be repaired', () => {
  assert.equal(service.safeMesId(MES_ID), MES_ID);
  for (const value of [Number(MES_ID), 17, null, undefined, '', '0', '017', '-17', '1e17',
    '17000000000000001.0', ' 17000000000000001', {}, Infinity]) {
    assert.equal(service.safeMesId(value), null);
  }
  const parsed = service.parsePlanSendResult({ results: [result(1)] }, [UID]);
  assert.equal(parsed[0].mes_id, MES_ID);
  assert.throws(() => service.parsePlanSendResult({ results: [result(1, 'created', { mes_id: Number(MES_ID) })] }, [UID]));
});

test('batch results preserve every selected outcome by UID, including partial failure and an already-existing order', () => {
  const states = ['created', 'already_exists', 'uncertain', 'failed', 'review'];
  const selected = states.map((_, index) => uid(index + 1));
  const rows = states.map((state, index) => result(index + 1, state, {
    mes_id: index < 2 ? MES_ID : null,
    blockers: state === 'uncertain' ? ['readback_required'] : state === 'failed' ? ['permission_required'] : [],
  })).reverse();
  const parsed = service.parsePlanSendResult({ results: rows }, selected);
  assert.equal(parsed.length, selected.length);
  for (const [index, state] of states.entries()) {
    const row = parsed.find(row => row.uid === uid(index + 1));
    assert.equal(row?.state, state);
    assert.equal(row?.mes_id, index < 2 ? MES_ID : null);
  }
  assert.deepEqual(parsed.find(row => row.state === 'uncertain')?.blockers, ['readback_required']);
});

test('canonical work-order code takes precedence while blocked results may omit the code and use an empty MES identifier', () => {
  const rows = service.parsePlanSendResult({ results: [
    result(1, 'created', { code: 'LEGACY-CODE', work_order_code: 'WJ-SYNTHETIC-CANONICAL' }),
    { uid: OTHER_UID, state: 'blocked', mes_id: '', blockers: ['material_confirmation'] },
  ] }, [UID, OTHER_UID]);
  assert.equal(rows[0].code, 'WJ-SYNTHETIC-CANONICAL');
  assert.deepEqual(rows[1], { uid: OTHER_UID, code: '', state: 'blocked', mes_id: null,
    blockers: ['material_confirmation'] });
  assert.equal(service.parsePlanSendResult({ results: [result(1)] }, [UID])[0].code, 'WJ-SYNTHETIC-1');
});

test('checking0 send responses remain pending safe projections and cannot release the request attempt latch', () => {
  const rows = service.parsePlanSendResult({ results: [result(1, 'checking', {
    work_order_code: 'WJ-SYNTHETIC-CHECKING', attempt: 0, mes_id: '',
    access_token: 'SYNTHETIC_PREFLIGHT_SECRET', raw: { token: 'SYNTHETIC_PREFLIGHT_SECRET' },
  })] }, [UID]);
  assert.deepEqual(rows, [{ uid: UID, code: 'WJ-SYNTHETIC-CHECKING', state: 'checking', mes_id: null, blockers: [] }]);
  const { data, group, request } = fixture();
  const checking = { ...request, state: 'checking', attempt: 0, can_recheck: true };
  assert.equal(service.canSendPlanRequest(data, group, checking, new Set()), false);
  assert.equal(service.canReleasePlanSendAttempt(checking), false);
  assert.equal(service.canRecheckPlanRequest(checking), true);
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_PREFLIGHT_SECRET'));
});

test('readback parser binds safe results to exactly the requested UID and rejects missing or spoofed response identity', () => {
  const valid = { uid: UID, work_order_code: 'WJ-SYNTHETIC-READBACK', state: 'created',
    mes_id: MES_ID, blockers: [], access_token: 'SYNTHETIC_READBACK_SECRET' };
  const parsed = service.parsePlanRecheckResult(valid, UID);
  assert.deepEqual(parsed, { uid: UID, code: 'WJ-SYNTHETIC-READBACK', state: 'created', mes_id: MES_ID, blockers: [] });
  assert.ok(!JSON.stringify(parsed).includes('SYNTHETIC_READBACK_SECRET'));
  assert.equal(service.parsePlanRecheckResult({ ...valid, state: 'already_exists' }, UID).state, 'already_exists');
  assert.deepEqual(service.parsePlanRecheckResult({ ...valid, state: 'uncertain', mes_id: '', blockers: ['readback_required'] }, UID),
    { uid: UID, code: 'WJ-SYNTHETIC-READBACK', state: 'uncertain', mes_id: null, blockers: ['readback_required'] });
  for (const value of [null, [], {}, { ...valid, uid: undefined }, { ...valid, uid: OTHER_UID },
    { ...valid, uid: Number('17000000000000001') }, { ...valid, state: 'finished' },
    { ...valid, mes_id: Number(MES_ID) }, { ...valid, blockers: undefined },
    { ...valid, blockers: ['Raw provider secret'] }]) {
    assert.throws(() => service.parsePlanRecheckResult(value, UID));
  }
  assert.throws(() => service.parsePlanRecheckResult(valid, 'invalid'));
});

test('incomplete, duplicate, unrelated or unsafe batch responses cannot be accepted as successful selected results', () => {
  for (const rows of [[result(1)], [result(1), result(1)], [result(1), result(3)],
    [result(1), result(2), result(3)]]) {
    assert.throws(() => service.parsePlanSendResult({ results: rows }, [UID, OTHER_UID]));
  }
  for (const response of [null, {}, { results: null }, { results: {} }, { results: [null] }]) {
    assert.throws(() => service.parsePlanSendResult(response, [UID]));
  }
  for (const patch of [{ uid: 'invalid' }, { code: 1 }, { state: 'finished' },
    { blockers: ['Raw provider secret'] }, { blockers: 'readback_required' }]) {
    assert.throws(() => service.parsePlanSendResult({ results: [result(1, 'created', patch)] }, [UID]));
  }
});
