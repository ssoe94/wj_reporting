import test from 'node:test';
import assert from 'node:assert/strict';
import { boardPartTrend } from '../src/domains/production/board-part-trend.ts';
const day = (business_date: string, cycle_time_seconds: number | null) => ({ business_date, cycle_time_seconds, machine_numbers: [12] });

test('trend preserves missing dates and sorts chronologically without changing the input', () => {
  const input = [day('2026-09-16', 80), day('2026-09-14', 60), day('2026-09-15', null)];
  const result = boardPartTrend(input);
  assert.deepEqual(result.points.map(p => p.cycle_time_seconds), [60, null, 80]);
  assert.equal(result.minimum, 60);
  assert.equal(result.maximum, 80);
  assert.equal(result.minimumPoint?.business_date, '2026-09-14');
  assert.equal(result.maximumPoint?.business_date, '2026-09-16');
  assert.equal(result.latest?.business_date, '2026-09-16');
  assert.equal(input[0].business_date, '2026-09-16');
});

test('latest metric identifies the actual recorded date without relabeling it as today', () => {
  const result = boardPartTrend([day('2026-09-14', 91.4), day('2026-09-15', null), day('2026-09-16', null)]);
  assert.equal(result.latest?.business_date, '2026-09-14');
  assert.equal(result.latest?.cycle_time_seconds, 91.4);
  assert.equal(result.minimum, result.maximum);
  assert.equal(result.minimumPoint?.business_date, result.maximumPoint?.business_date);
});

test('empty and invalid measurements do not become zero-valued chart points or range metrics', () => {
  for (const rows of [[], [day('2026-09-14', null), day('2026-09-15', 0), day('2026-09-16', NaN)]]) {
    const result = boardPartTrend(rows);
    assert.equal(result.latest, null);
    assert.equal(result.minimum, null);
    assert.equal(result.maximum, null);
    assert.ok(result.points.every(p => p.cycle_time_seconds === null));
  }
});
