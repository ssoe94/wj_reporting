import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDate, historyFilters, validHistoryFilters, quantity, historyTime } from '../src/domains/inventory/movement-history.ts';

test('Shanghai business date changes at 08:00 regardless of host timezone', () => {
  assert.equal(businessDate(new Date('2026-10-18T23:59:59Z')), '2026-10-18');
  assert.equal(businessDate(new Date('2026-10-19T00:00:00Z')), '2026-10-19');
  assert.equal(historyTime('2026-10-18T23:59:00Z'), '2026-10-19 07:59:00');
});

test('defaults span seven closed business dates and applied URL filters survive', () => {
  const defaults = historyFilters(new URLSearchParams(), new Date('2026-01-01T00:00:00Z'));
  assert.equal(defaults.start_date, '2025-12-25');
  assert.equal(defaults.end_date, '2025-12-31');
  const filters = historyFilters(new URLSearchParams('start_date=2026-10-01&end_date=2026-10-19&search=H55&direction=out&ordering=desc'));
  assert.equal(filters.search, 'H55');
  assert.equal(filters.direction, 'out');
  assert.equal(filters.ordering, 'desc');
  assert.ok(validHistoryFilters(filters));
  for (const change of [{start_date:'2026-02-30'}, {end_date:'2026-01-01'}, {start_date:'2024-01-01'},
    {start_date:''}, {direction:'invalid'}, {ordering:'invalid'}, {search:'x'.repeat(101)}]) {
    assert.equal(validHistoryFilters({...filters, ...change} as typeof filters), false);
  }
});

test('quantity formatting keeps four places and large decimal precision', () => {
  assert.equal(quantity('1234567890123456.1234'), '1,234,567,890,123,456.1234');
  assert.equal(quantity('-1234.5000'), '-1,234.5');
  assert.equal(quantity('0.0000'), '0');
});
