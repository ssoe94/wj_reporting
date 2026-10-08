import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectionMesMutationResult, refreshInspectionProjectionQueries } from '../src/pages/quality/inspection-requests/mesWorkflowResult.ts';
import { inspectionCopy } from '../src/pages/quality/inspection-requests/copy.ts';
import { inspectionRequestStage } from '../src/pages/quality/inspection-requests/kanban.ts';

const saved = () => ({ id: 42, version: 5, sync_status: 'succeeded', mes_completion_status: 'not_completed',
  last_error_code: '', mes_checked_at: '2026-10-06T03:30:00Z',
  mes_workflow: { phase: 'saved' as const, enabled: true, test_label: 'SYNTHETIC-QC-TEST',
    last_verified_at: '2026-10-06T03:30:00Z', can_save: false, can_finish: true, can_reconcile: true } });
const finished = (completion = 'completed') => ({ ...saved(), version: 6, mes_completion_status: completion,
  mes_workflow: { ...saved().mes_workflow, phase: 'completed' as const, can_finish: false } });

test('synthetic QC save, separate finish and approval remain distinct after verified readback', () => {
  assert.equal(inspectionMesMutationResult('mes-save', saved(), saved()), 'saved');
  assert.equal(inspectionMesMutationResult('mes-finish', saved(), saved()), null, 'saving is not finishing');
  assert.equal(inspectionMesMutationResult('mes-save', finished(), finished()), null, 'completion cannot be reported as a save');
  assert.equal(inspectionMesMutationResult('mes-finish', finished(), finished()), 'completed');
  assert.equal(inspectionMesMutationResult('mes-finish', finished('approval_pending'), finished('approval_pending')), 'approval_pending');
  const card = { ...saved(), status: 'approved' as const, judgement: 'pass' as const,
    measurements: [], evidence: [], notes: 'SYNTHETIC-QC-TEST', mes_state: { qc_status: 1 } };
  assert.equal(inspectionRequestStage(card), 'in_progress', 'saved QC remains unfinished');
  assert.equal(inspectionRequestStage({ ...card, ...finished('approval_pending') }), 'in_progress');
  assert.equal(inspectionRequestStage({ ...card, ...finished() }), 'completed');
  for (const language of ['ko', 'zh'] as const) {
    assert.notEqual(inspectionCopy[language].mesApprovalPending, inspectionCopy[language].mesFinished);
  }
});

test('a failed WJ reload or changed QC observation cannot earn a stage success', () => {
  assert.equal(inspectionMesMutationResult('mes-save', saved(), saved(), true), null);
  for (const latest of [
    { ...saved(), id: 43 }, { ...saved(), version: 4 }, { ...saved(), version: NaN },
    { ...saved(), mes_checked_at: null }, { ...saved(), mes_checked_at: 'invalid' },
    { ...saved(), mes_workflow: { ...saved().mes_workflow, last_verified_at: null } },
    { ...saved(), sync_status: 'unknown', last_error_code: 'mes_outcome_unknown' },
    { ...saved(), mes_workflow: { ...saved().mes_workflow, phase: 'save_unknown' as const } },
    { ...saved(), mes_workflow: undefined }, finished(),
    { ...saved(), mes_checked_at: '2026-10-06T03:31:00Z',
      mes_workflow: { ...saved().mes_workflow, last_verified_at: '2026-10-06T03:31:00Z' } },
  ]) assert.equal(inspectionMesMutationResult('mes-save', saved(), latest), null);
  assert.equal(inspectionMesMutationResult('save', saved(), saved()), null, 'local draft save has no MES proof');
  assert.equal(inspectionMesMutationResult('mes-finish', finished(), finished('approval_pending')), null);
});

test('verified stage changes invalidate public board/dashboard readers without overwriting production', async () => {
  const calls: readonly string[][] = [];
  const production = { planned_quantity: 500, actual_quantity: 120, progress: 24, complete: false };
  const before = JSON.stringify(production);
  const client = { invalidateQueries: async ({ queryKey }: { queryKey: readonly string[] }) => {
    (calls as string[][]).push([...queryKey]);
    if (queryKey[0] === 'production-status') throw new Error('SYNTHETIC transient refresh failure');
  } };
  refreshInspectionProjectionQueries(client);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.deepEqual(calls, [['production-status'], ['inspection-overview']]);
  assert.equal(JSON.stringify(production), before, 'single-QC success cannot change plan progress or completion');
});
