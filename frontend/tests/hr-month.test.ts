import assert from 'node:assert/strict';
import test from 'node:test';
import { hrMonthYears } from '../src/domains/hr/month.ts';

const now = new Date('2026-11-12T00:00:00Z');

test('usual month selection offers 2020 through next year', () => {
  assert.deepEqual(hrMonthYears('2026-11', now), ['2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027']);
});

test('historical and future URL years remain present at the selection bounds', () => {
  const historical = hrMonthYears('1900-01', now);
  assert.equal(historical[0], '1900');
  assert.equal(historical.at(-1), '2027');
  const future = hrMonthYears('2199-12', now);
  assert.equal(future[0], '2020');
  assert.equal(future.at(-1), '2199');
});

test('next-year range follows the Shanghai year boundary', () => {
  assert.equal(hrMonthYears('2026-12', new Date('2026-12-31T15:59:59Z')).at(-1), '2027');
  assert.equal(hrMonthYears('2026-12', new Date('2026-12-31T16:00:00Z')).at(-1), '2028');
});
