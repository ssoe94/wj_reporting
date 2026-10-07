import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectionConfirmsScopedRefresh, inspectionHasUnsavedWork, inspectionNavigationGate, inspectionNextReconciliationRequired, inspectionRemoteReconciliationRequired, isCurrentInspectionEditor, nextInspectionEditor } from '../src/pages/quality/inspection-requests/navigation.ts';
import type { InspectionEditorSelection } from '../src/pages/quality/inspection-requests/navigation.ts';

const emptyEditor = (): InspectionEditorSelection => ({ epoch: 0, kind: 'none', requestId: null });

test('busy or uncertain results block all editor exits before any discard decision', () => {
  for (const dirty of [false, true]) assert.equal(inspectionNavigationGate(dirty, true), 'blocked');
  assert.equal(inspectionNavigationGate(true, false), 'confirm');
  assert.equal(inspectionNavigationGate(false, false), 'allow');
  const draft = { version: 4, measurement: 'unsaved', reason: 'review basis' };
  const original = JSON.stringify(draft);
  assert.equal(inspectionNavigationGate(true, true), 'blocked');
  assert.equal(JSON.stringify(draft), original);
});

test('durable refresh failure remains locked through local reload and failed refresh; only a scoped observation clears it', () => {
  const prior = { sync_status: 'succeeded', mes_completion_status: 'completed', mes_checked_at: '2026-09-30T01:00:00Z', last_error_code: '', mes_state: { task_status: 2, qc_status: 1 } };
  let latch = inspectionNextReconciliationRequired(false, { kind: 'failure', reconciliation_required: true });
  assert.equal(inspectionNavigationGate(false, latch), 'blocked');
  assert.equal(inspectionRemoteReconciliationRequired(prior), false, 'a refresh failure may retain an old completed request state');
  latch = inspectionNextReconciliationRequired(latch, { kind: 'local_read' });
  assert.equal(latch, true, 'a WJ GET with an unchanged prior pass is not a MES refresh');
  latch = inspectionNextReconciliationRequired(latch, { kind: 'failure', reconciliation_required: false });
  assert.equal(latch, true, 'a blocked or unsuccessful refresh does not resolve an earlier unknown outcome');
  for (const observation of [
    { ...prior, sync_status: 'pending' }, { ...prior, mes_completion_status: 'unknown' },
    { ...prior, mes_checked_at: null }, { ...prior, mes_checked_at: 'invalid' },
    { ...prior, last_error_code: 'mes_outcome_unknown' }, { ...prior, mes_state: undefined },
    { ...prior, sync_status: 'unexpected' }, { ...prior, mes_completion_status: 'unexpected' },
    { ...prior, mes_state: { task_status: 6, qc_status: 1 } },
    { ...prior, mes_state: { task_status: 2, qc_status: 0 } },
  ]) {
    assert.equal(inspectionConfirmsScopedRefresh(observation), false);
    assert.equal(inspectionNextReconciliationRequired(latch, { kind: 'scoped_refresh', observation }), true);
    assert.equal(inspectionNextReconciliationRequired(false, { kind: 'scoped_refresh', observation }), true, 'invalid 200 cannot appear successful even without an earlier latch');
  }
  latch = inspectionNextReconciliationRequired(latch, { kind: 'scoped_refresh', observation: prior });
  assert.equal(latch, false);
  assert.equal(inspectionNavigationGate(false, latch), 'allow');
  assert.equal(inspectionConfirmsScopedRefresh({ ...prior, sync_status: 'failed', mes_completion_status: 'rejected', mes_state: { task_status: 5, qc_status: 4 } }), true, 'observing rejection resolves uncertainty without claiming a passed/completed inspection');
});

test('a newer failed observation after a successful scoped refresh invalidates the proof and locks navigation', () => {
  const observed = { version: 8, sync_status: 'succeeded', mes_completion_status: 'completed', mes_checked_at: '2026-09-30T01:00:00Z', last_error_code: '', mes_state: { task_status: 2, qc_status: 1 } };
  const latest = { ...observed, version: 10, last_error_code: 'mes_outcome_unknown', mes_checked_at: null };
  assert.equal(inspectionConfirmsScopedRefresh(observed), true);
  assert.equal(inspectionRemoteReconciliationRequired(latest), true, 'retained completion status cannot hide a newer unknown refresh');
  for (const previous of [false, true]) {
    const latch = inspectionNextReconciliationRequired(previous, { kind: 'scoped_refresh', observation: observed, latest });
    assert.equal(latch, true);
    assert.equal(inspectionNavigationGate(false, latch), 'blocked');
  }
  assert.equal(inspectionNextReconciliationRequired(true, { kind: 'scoped_refresh', observation: observed, latest: { ...observed, version: 10 } }), false);
});

test('review-only input and whitespace are protected without making unchanged results dirty', () => {
  assert.equal(inspectionHasUnsavedWork(false, ''), false);
  assert.equal(inspectionHasUnsavedWork(false, 'Review basis'), true);
  assert.equal(inspectionHasUnsavedWork(false, ' '), true);
  assert.equal(inspectionHasUnsavedWork(true, ''), true);
  assert.equal(inspectionNavigationGate(inspectionHasUnsavedWork(false, 'Review basis'), false), 'confirm');
});

test('late results cannot replace a later selected request, including reopening the same request', async () => {
  let selected = nextInspectionEditor(emptyEditor(), 'request', 8);
  const oldRequest = selected;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let applied = 0;
  const lateResult = pending.then(() => { if (isCurrentInspectionEditor(oldRequest, selected)) applied += 1; });
  selected = nextInspectionEditor(selected, 'request', 12);
  selected = nextInspectionEditor(selected, 'request', 8);
  assert.equal(selected.requestId, oldRequest.requestId);
  release?.();
  await lateResult;
  assert.equal(applied, 0);
  assert.equal(isCurrentInspectionEditor(selected, selected), true);
});

test('late create callbacks and lock reports are fenced after cancel and another create session', () => {
  let selected = nextInspectionEditor(emptyEditor(), 'create');
  const firstCreation = selected;
  selected = nextInspectionEditor(selected, 'none');
  selected = nextInspectionEditor(selected, 'create');
  assert.equal(isCurrentInspectionEditor(firstCreation, selected), false);
  assert.equal(selected.kind, 'create');
  assert.equal(selected.requestId, null);
  const request = nextInspectionEditor(selected, 'request', 15);
  assert.equal(isCurrentInspectionEditor(selected, request), false);
  assert.equal(request.requestId, 15);
});

test('durable pending and unknown MES outcomes retain reconciliation lock independently of local review approval', () => {
  const local = { status: 'approved', sync_status: 'not_synced', mes_completion_status: 'not_completed' };
  assert.equal(inspectionRemoteReconciliationRequired(local), false);
  for (const state of ['pending', 'unknown']) {
    const sync = { ...local, sync_status: state };
    const completion = { ...local, mes_completion_status: state };
    assert.equal(inspectionRemoteReconciliationRequired(sync), true);
    assert.equal(inspectionRemoteReconciliationRequired(completion), true);
    // A successful WJ GET/reload with the same remote state does not reconcile the MES result.
    const reloaded = JSON.parse(JSON.stringify(sync));
    assert.equal(inspectionNavigationGate(false, inspectionRemoteReconciliationRequired(reloaded)), 'blocked');
  }
  assert.equal(inspectionRemoteReconciliationRequired({ ...local, sync_status: 'succeeded', mes_completion_status: 'completed' }), false);
});

test('separate-stage readback clears uncertainty only with matching verified timestamp and phase', () => {
  const saved = { sync_status: 'succeeded', mes_completion_status: 'not_completed', last_error_code: '',
    mes_checked_at: '2026-10-03T05:00:00Z', mes_workflow: { phase: 'saved', last_verified_at: '2026-10-03T05:00:00Z' } };
  assert.equal(inspectionConfirmsScopedRefresh(saved), true);
  assert.equal(inspectionConfirmsScopedRefresh({ ...saved, mes_workflow: { ...saved.mes_workflow, phase: 'save_unknown' } }), false);
  assert.equal(inspectionConfirmsScopedRefresh({ ...saved, mes_workflow: { ...saved.mes_workflow, last_verified_at: null } }), false);
  assert.equal(inspectionConfirmsScopedRefresh({ ...saved, mes_completion_status: 'completed' }), false);
  assert.equal(inspectionNextReconciliationRequired(true, { kind: 'local_read' }), true);
  assert.equal(inspectionNextReconciliationRequired(true, { kind: 'scoped_refresh', observation: saved }), false);
});

test('whole-snapshot readback resolves the correct full stage while a local read or an unknown phase retains the lock', () => {
  for (const [phase, completion] of [['full_saved', 'not_completed'], ['full_completed', 'completed']] as const) {
    const observed = { sync_status: 'succeeded', mes_completion_status: completion, last_error_code: '',
      mes_checked_at: '2026-10-07T10:11:59Z', mes_workflow: { phase, last_verified_at: '2026-10-07T10:11:59Z' } };
    assert.equal(inspectionConfirmsScopedRefresh(observed), true);
    assert.equal(inspectionNextReconciliationRequired(true, { kind: 'local_read' }), true);
    assert.equal(inspectionNextReconciliationRequired(true, { kind: 'scoped_refresh', observation: observed }), false);
    for (const state of ['full_save_pending', 'full_save_unknown', 'full_finish_pending', 'full_finish_unknown']) {
      const uncertain = { ...observed, mes_workflow: { ...observed.mes_workflow, phase: state } };
      assert.equal(inspectionConfirmsScopedRefresh(uncertain), false);
      assert.equal(inspectionNextReconciliationRequired(true, { kind: 'scoped_refresh', observation: uncertain }), true);
    }
    assert.equal(inspectionConfirmsScopedRefresh({ ...observed, mes_completion_status: phase === 'full_saved' ? 'completed' : 'not_completed' }), false);
    assert.equal(inspectionConfirmsScopedRefresh({ ...observed, mes_workflow: { ...observed.mes_workflow, last_verified_at: null } }), false);
  }
});
