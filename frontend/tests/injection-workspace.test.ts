import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInjectionLink, createInjectionCsv, resolveInjectionScope } from '../src/domains/injection/workspace.ts';

test('read links retain a historical day and the same machine through every tab', () => {
  const scope = resolveInjectionScope('?date=2026-09-04&machine=17', '2026-09-06');
  assert.deepEqual(scope, { date: '2026-09-04', machineNumber: 17 });
  assert.equal(buildInjectionLink('/injection/dashboard', scope, '#field-records'), '/injection/dashboard?date=2026-09-04&machine=17#field-records');
  assert.deepEqual(resolveInjectionScope(buildInjectionLink('', scope).slice(1), '2026-09-06'), scope);
});

test('invalid and future dates fall back to the supplied Shanghai business day', () => {
  for (const date of ['2026-02-30', '2026-09-07', '2026-9-4', 'yesterday', '']) {
    assert.equal(resolveInjectionScope(`?date=${date}`, '2026-09-06').date, '2026-09-06');
  }
  assert.equal(resolveInjectionScope('?date=2024-02-29', '2026-09-06').date, '2024-02-29');
});

test('only supported station numbers are accepted; all machines stays explicit', () => {
  for (const machine of ['0', '18', '-1', '1.5', '1e1', '1abc', '01', '']) {
    assert.equal(resolveInjectionScope(`?machine=${machine}`, '2026-09-06').machineNumber, null);
  }
  assert.equal(buildInjectionLink('/mes/monitoring', { date: '2026-09-06', machineNumber: null }), '/mes/monitoring?date=2026-09-06');
});

test('CSV preserves missing versus zero and escapes delimiters, line breaks and formulas', () => {
  const csv = createInjectionCsv([['missing', 'zero', 'note'], [null, 0, 'a,"b"\nc'], ['=1+1', ' @SUM(A1)', -2]]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"","0","a,""b""\nc"'));
  assert.ok(csv.includes('"\'=1+1","\' @SUM(A1)","-2"'));
});
