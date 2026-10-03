import test from 'node:test';
import assert from 'node:assert/strict';
import { injectionQualityAttention } from '../src/domains/production/injection-quality-attention.ts';
import type { InjectionQualityView } from '../src/domains/production/injection-quality-status';

function view(overrides: Partial<InjectionQualityView> = {}): InjectionQualityView {
  return { data: { binding_status: 'verified', complete: true } as InjectionQualityView['data'],
    freshness: 'fresh', availability: 'ok', firstStatus: 'failed', periodicStatus: 'passed',
    scheduleStatus: 'overdue', counts: { unknown: 0, waiting: 0, in_progress: 0, passed: 1, failed: 1 },
    historical: false, ...overrides };
}
test('board and dashboard flag fresh failure without inventing disposition completion or approval', () => {
  assert.deepEqual(injectionQualityAttention(view()), { verified: true, failed: true, overdue: true,
    disposition: 'needs_verification', approvalPending: null, actionOverdue: null });
});
test('stale, failed, fixture or incomplete reads cannot become current priority totals', () => {
  for (const value of [view({ freshness: 'stale' }), view({ availability: 'error' }),
    view({ freshness: 'fixture' }), view({ data: null }),
    view({ data: { binding_status: 'verified', complete: false } as InjectionQualityView['data'] })]) {
    const result = injectionQualityAttention(value);
    assert.equal(result.verified, false); assert.equal(result.failed, null); assert.equal(result.overdue, null);
    assert.equal(result.disposition, 'unlinked');
  }
});
