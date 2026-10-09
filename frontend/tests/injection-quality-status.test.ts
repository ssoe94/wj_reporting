import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveInjectionQuality,
  injectionQualityScopeKey,
  parseInjectionQuality,
  reduceInjectionQuality,
  type ExpectedInjectionQualityScope,
  type PublicInjectionQuality,
} from '../src/domains/production/injection-quality-status.ts';

const NOW = Date.parse('2026-10-03T03:38:00Z');
const SCOPE: ExpectedInjectionQualityScope = {
  businessDate: '2026-10-03', machineNumber: 1, currentPlanId: 70, planVersion: 'a'.repeat(64),
};
function payload(): PublicInjectionQuality {
  return {
    schema_version: 'injection-quality-status.v1', business_date: SCOPE.businessDate,
    machine_number: 1, current_plan_id: 70, plan_version: SCOPE.planVersion,
    binding_generation: 2, read_generation: 3, binding_status: 'verified', availability: 'ok',
    freshness: 'fresh', fresh_until: '2026-10-03T03:40:00+00:00',
    last_attempt_started_at: '2026-10-03T03:37:59+00:00', last_attempt_completed_at: '2026-10-03T03:38:00+00:00',
    last_success_at: '2026-10-03T03:38:00+00:00', observed_at: '2026-10-03T03:37:59+00:00',
    refresh_after_seconds: null, complete: true,
    first: { status: 'passed', last_known_status: 'passed', checks: [
      { kind: 'first', status: 'passed', checked_at: '2026-10-03T03:18:00+00:00', warnings: [] },
    ] },
    periodic: { status: 'unknown', last_known_status: 'unknown', checks: [],
      last_checked_at: null, last_result: 'unknown', next_due_at: null, schedule_status: 'unverified' },
    other_checks: [], warnings: [],
  };
}

test('missing or malformed data defaults to unavailable', () => {
  for (const value of [undefined, null, {}, [], { ...payload(), fresh_until: undefined },
    { ...payload(), freshness: 'live' }, { ...payload(), read_generation: -1 },
    { ...payload(), observed_at: '2026-10-03 03:38:00' }]) {
    const state = reduceInjectionQuality(null, value, SCOPE);
    assert.equal(state.data, null);
    assert.equal(deriveInjectionQuality(state, SCOPE, NOW).freshness, 'unavailable');
  }
});

test('all scope fields require exact equality', () => {
  for (const changes of [{ businessDate: '2026-10-02' }, { machineNumber: 2 },
    { currentPlanId: 71 }, { currentPlanId: null }, { planVersion: 'b'.repeat(64) }]) {
    assert.equal(parseInjectionQuality(payload(), { ...SCOPE, ...changes }), null);
  }
  assert.equal(injectionQualityScopeKey({ ...SCOPE, businessDate: '2026-02-30' }), null);
  assert.equal(injectionQualityScopeKey({ ...SCOPE, machineNumber: 18 }), null);
});

test('no current plan cannot accept a verified live pass', () => {
  assert.equal(parseInjectionQuality({ ...payload(), current_plan_id: null }, { ...SCOPE, currentPlanId: null }), null);
});

test('malformed calendar timestamp is unavailable rather than silently normalized', () => {
  assert.equal(parseInjectionQuality({ ...payload(), observed_at: '2026-02-30T03:38:00Z' }, SCOPE), null);
});

test('impossible completed-at and success-at combinations are rejected', () => {
  for (const fields of [{ last_attempt_completed_at: null },
    { last_success_at: '2026-10-03T03:39:00Z' }, { last_attempt_started_at: '2026-10-03T03:39:00Z' },
    { binding_generation: null }]) assert.equal(parseInjectionQuality({ ...payload(), ...fields }, SCOPE), null);
});

test('projection hook failure reports error without inventing a completed MES read', () => {
  const value = payload();
  Object.assign(value, { binding_status: 'unresolved', binding_generation: null, availability: 'error',
    freshness: 'unavailable', fresh_until: null, complete: false, last_attempt_started_at: null,
    last_attempt_completed_at: null, last_success_at: null, observed_at: null,
    first: { status: 'unknown', last_known_status: 'unknown', checks: [] }, warnings: ['quality_projection_unavailable'] });
  const view = deriveInjectionQuality(reduceInjectionQuality(null, value, SCOPE), SCOPE, NOW);
  assert.equal(view.availability, 'error');
  assert.equal(view.firstStatus, 'unknown');
  assert.equal(view.data?.last_success_at, null);
});

test('plan switches invalidate retained state synchronously before any new response', () => {
  const previous = reduceInjectionQuality(null, payload(), SCOPE);
  const nextScope = { ...SCOPE, currentPlanId: 71, planVersion: 'b'.repeat(64) };
  assert.equal(deriveInjectionQuality(previous, nextScope, NOW).data, null);
  const next = reduceInjectionQuality(previous, payload(), nextScope);
  assert.equal(next.data, null);
  assert.equal(next.maxReadGeneration, null);
});

test('older read generations do not overwrite newer error or result for same scope', () => {
  const initial = reduceInjectionQuality(null, payload(), SCOPE);
  const failed = { ...payload(), read_generation: 5, availability: 'error' as const, freshness: 'stale' as const };
  const recent = reduceInjectionQuality(initial, failed, SCOPE);
  const reordered = reduceInjectionQuality(recent, { ...payload(), read_generation: 4 }, SCOPE);
  assert.strictEqual(reordered, recent);
  assert.equal(deriveInjectionQuality(reordered, SCOPE, NOW).firstStatus, 'unknown');
});

test('invalid data clears display but preserves high-water mark against delayed responses', () => {
  const recent = reduceInjectionQuality(null, { ...payload(), read_generation: 10 }, SCOPE);
  const cleared = reduceInjectionQuality(recent, undefined, SCOPE);
  assert.equal(cleared.data, null);
  assert.equal(cleared.maxReadGeneration, 10);
  assert.equal(reduceInjectionQuality(cleared, payload(), SCOPE).data, null);
});

test('generation is independent between machines and new plan scopes', () => {
  const recent = reduceInjectionQuality(null, { ...payload(), read_generation: 100 }, SCOPE);
  const otherScope = { ...SCOPE, machineNumber: 2 };
  const other = reduceInjectionQuality(recent, { ...payload(), machine_number: 2 }, otherScope);
  assert.equal(other.data?.read_generation, 3);
  assert.equal(deriveInjectionQuality(recent, otherScope, NOW).data, null);
});

test('equal read generation and older binding cannot replace newer evidence', () => {
  const recent = reduceInjectionQuality(null, { ...payload(), read_generation: 10, binding_generation: 4 }, SCOPE);
  assert.strictEqual(reduceInjectionQuality(recent, { ...payload(), read_generation: 10, binding_generation: 3 }, SCOPE), recent);
  assert.strictEqual(reduceInjectionQuality(recent, { ...payload(), read_generation: 11, binding_generation: 3 }, SCOPE), recent);
  assert.equal(reduceInjectionQuality(recent, { ...payload(), read_generation: 11, binding_generation: 5 }, SCOPE).data?.binding_generation, 5);
});

test('freshness expires on server deadline without a new fetch', () => {
  const state = reduceInjectionQuality(null, payload(), SCOPE);
  assert.equal(deriveInjectionQuality(state, SCOPE, NOW).firstStatus, 'passed');
  const stale = deriveInjectionQuality(state, SCOPE, Date.parse(payload().fresh_until!));
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.firstStatus, 'unknown');
  assert.equal(stale.data?.first.last_known_status, 'passed');
  assert.equal(stale.historical, true);
});

test('transport failure masks aggregates but preserves explicitly historical individual failure', () => {
  const value = payload();
  value.first.checks[0].status = 'failed';
  value.first.status = 'failed';
  const state = reduceInjectionQuality(null, value, SCOPE);
  const view = deriveInjectionQuality(state, SCOPE, NOW, { transportError: true });
  assert.equal(view.firstStatus, 'unknown');
  assert.equal(view.availability, 'error');
  assert.equal(view.counts.failed, 1);
  assert.equal(view.historical, true);
  assert.equal(deriveInjectionQuality(state, SCOPE, NOW).firstStatus, 'failed');
  assert.equal(deriveInjectionQuality(null, SCOPE, NOW, { transportError: true }).availability, 'error');
});

test('multiple periodic observations stay unknown without hiding individual failed, waiting, or in-progress states', () => {
  const value = payload();
  value.periodic.checks = [
    { kind: 'periodic', status: 'failed', checked_at: '2026-10-03T03:10:00Z', warnings: [] },
    { kind: 'periodic', status: 'passed', checked_at: '2026-10-03T03:20:00Z', warnings: [] },
    { kind: 'periodic', status: 'waiting', checked_at: null, warnings: [] },
    { kind: 'periodic', status: 'in_progress', checked_at: null, warnings: [] },
  ];
  value.periodic.last_result = 'passed';
  value.periodic.status = 'passed'; // A future server regression cannot create a false green aggregate.
  value.warnings = ['periodic_series_unresolved'];
  const view = deriveInjectionQuality(reduceInjectionQuality(null, value, SCOPE), SCOPE, NOW);
  assert.equal(view.periodicStatus, 'unknown');
  assert.equal(view.counts.failed, 1);
  assert.equal(view.counts.waiting, 1);
  assert.equal(view.counts.in_progress, 1);
  assert.equal(view.data?.periodic.checks.length, 4);
});

test('incomplete populations and contradictory positive aggregates do not imply pass', () => {
  for (const value of [Object.assign(payload(), { complete: false }), payload()]) {
    if (value.complete) value.first.checks[0] = { kind: 'first', status: 'waiting', checked_at: null, warnings: [] };
    assert.equal(deriveInjectionQuality(reduceInjectionQuality(null, value, SCOPE), SCOPE, NOW).firstStatus, 'unknown');
  }
});

test('only known fields are copied and source arrays cannot mutate accepted evidence', () => {
  const value = { ...payload(), secret: 'never include', qc_id: '123' };
  const parsed = parseInjectionQuality(value, SCOPE)!;
  assert.equal('secret' in parsed, false);
  assert.equal('qc_id' in parsed, false);
  value.first.checks[0].warnings.push('plan_name_type_mismatch');
  value.first.checks[0].status = 'failed';
  assert.equal(parsed.first.checks[0].status, 'passed');
  assert.deepEqual(parsed.first.checks[0].warnings, []);
});

test('fixtures never become live because their deadline is in the future', () => {
  const value = { ...payload(), freshness: 'fixture' as const, complete: false };
  const view = deriveInjectionQuality(reduceInjectionQuality(null, value, SCOPE), SCOPE, NOW);
  assert.equal(view.freshness, 'fixture');
  assert.equal(view.firstStatus, 'unknown');
});

test('verified single-check schedule expires by clock but loses certainty when evidence expires', () => {
  const value = payload();
  value.periodic = { status: 'passed', last_known_status: 'passed',
    checks: [{ kind: 'periodic', status: 'passed', checked_at: '2026-10-03T03:20:00Z', warnings: [] }],
    last_checked_at: '2026-10-03T03:20:00Z', last_result: 'passed',
    next_due_at: '2026-10-03T03:39:00Z', schedule_status: 'scheduled' };
  const state = reduceInjectionQuality(null, value, SCOPE);
  assert.equal(deriveInjectionQuality(state, SCOPE, NOW).scheduleStatus, 'scheduled');
  assert.equal(deriveInjectionQuality(state, SCOPE, NOW + 60_000).scheduleStatus, 'overdue');
  assert.equal(deriveInjectionQuality(state, SCOPE, NOW + 120_000).scheduleStatus, 'unknown');
  value.periodic.checks.push({ ...value.periodic.checks[0] });
  assert.equal(parseInjectionQuality(value, SCOPE), null);
});


test('newer binding with a non-increasing read generation quarantines the former pass', () => {
  const recent = reduceInjectionQuality(null, { ...payload(), read_generation: 10, binding_generation: 4 }, SCOPE);
  for (const readGeneration of [9, 10]) {
    const changed = reduceInjectionQuality(recent, { ...payload(), read_generation: readGeneration, binding_generation: 5 }, SCOPE);
    assert.equal(changed.data, null);
    assert.equal(changed.maxReadGeneration, 10);
    assert.equal(changed.maxBindingGeneration, 5);
    assert.equal(deriveInjectionQuality(changed, SCOPE, NOW).firstStatus, 'unknown');
    const delayed = reduceInjectionQuality(changed, { ...payload(), read_generation: 11, binding_generation: 4 }, SCOPE);
    assert.equal(delayed.data, null);
    const recovered = reduceInjectionQuality(delayed, { ...payload(), read_generation: 12, binding_generation: 5 }, SCOPE);
    assert.equal(recovered.data?.binding_generation, 5);
    assert.equal(deriveInjectionQuality(recovered, SCOPE, NOW).firstStatus, 'passed');
  }
});
