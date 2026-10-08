import assert from 'node:assert/strict';
import test from 'node:test';
import { isIntegrationTrial, parseIntegrationTrials } from '../src/pages/quality/inspection-requests/integrationTrial.ts';
import { inspectionStageCounts } from '../src/pages/quality/inspection-requests/kanban.ts';
const row = { request_id: '42', qc_code: 'QC-42', test_label: 'approved integration trial', phase: 'completed', trial_verdict: 'pass', observed_at: '2026-10-06T12:00:00Z', test_only: true, production_counted: false };
test('persisted trial identities override a normal source; names and verdicts never classify', () => {
  assert.equal(isIntegrationTrial({ source_kind: 'integration_test' }), true);
  assert.equal(isIntegrationTrial({ source_kind: 'manual', mes_workflow: { test_only: true } }), true);
  assert.equal(isIntegrationTrial({ source_kind: 'test', mes_workflow: { test_only: false } }), false);
});
test('trial projection copies only classified metadata and deduplicates request identity', () => {
  assert.deepEqual(parseIntegrationTrials([{ ...row, secret: 'omit' }, row]), [row]);
  assert.deepEqual(parseIntegrationTrials([{ ...row, trial_verdict: null, observed_at: null }]), [{ ...row, trial_verdict: null, observed_at: null }]);
});
test('missing classification, production inclusion and unobserved verdict cannot appear as verified trial', () => {
  for (const patch of [{ test_only: false }, { production_counted: true }, { observed_at: null }, { observed_at: 'bad' }, { trial_verdict: 'passed' }, { request_id: 42 }]) {
    assert.deepEqual(parseIntegrationTrials([{ ...row, ...patch }]), []);
  }
  assert.deepEqual(parseIntegrationTrials(undefined), []);
  assert.equal(parseIntegrationTrials([{ ...row, test_label: '', trial_verdict: null, observed_at: null }]).length, 1);
});
test('completed trial never contributes to production stage totals', () => {
  const request = { status: 'approved', sync_status: 'succeeded', mes_completion_status: 'completed', mes_state: { qc_status: 1 }, mes_checked_at: row.observed_at };
  const counts = inspectionStageCounts([request, { ...request, source_kind: 'integration_test' }, { ...request, mes_workflow: { test_only: true } }] as Parameters<typeof inspectionStageCounts>[0]);
  assert.equal(counts.completed, 1);
});
