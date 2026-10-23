import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDate, historyFilters, validHistoryFilters, includesCurrentHistoryDay, quantity, historyTime } from '../src/domains/inventory/movement-history.ts';

test('Shanghai business date changes at 08:00 regardless of host timezone', () => {
  assert.equal(businessDate(new Date('2026-10-18T23:59:59Z')), '2026-10-18');
  assert.equal(businessDate(new Date('2026-10-19T00:00:00Z')), '2026-10-19');
  assert.equal(historyTime('2026-10-18T23:59:00Z'), '2026-10-19 07:59:00');
});

test('defaults span seven business dates through the current day and applied URL filters survive', () => {
  const defaults = historyFilters(new URLSearchParams(), new Date('2026-01-01T00:00:00Z'));
  assert.equal(defaults.start_date, '2025-12-26');
  assert.equal(defaults.end_date, '2026-01-01');
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

test('current-day refresh selection follows the Shanghai 08:00 boundary', () => {
  const params = new URLSearchParams('start_date=2026-10-23&end_date=2026-10-23');
  const filters = historyFilters(params);
  assert.equal(includesCurrentHistoryDay(filters, new Date('2026-10-22T23:59:59Z')), false);
  assert.equal(includesCurrentHistoryDay(filters, new Date('2026-10-23T00:00:00Z')), true);
  assert.equal(includesCurrentHistoryDay(filters, new Date('2026-10-23T07:30:00Z')), true);
  assert.equal(includesCurrentHistoryDay(filters, new Date('2026-10-24T00:00:00Z')), false);
  assert.equal(includesCurrentHistoryDay({ ...filters, direction: 'invalid' } as typeof filters, new Date('2026-10-23T07:30:00Z')), false);
  const beforeBoundary = historyFilters(new URLSearchParams(), new Date('2026-10-22T23:59:59Z'));
  assert.equal(beforeBoundary.end_date, '2026-10-22');
  assert.equal(beforeBoundary.start_date, '2026-10-16');
});

test('quantity formatting keeps four places and large decimal precision', () => {
  assert.equal(quantity('1234567890123456.1234'), '1,234,567,890,123,456.1234');
  assert.equal(quantity('-1234.5000'), '-1,234.5');
  assert.equal(quantity('0.0000'), '0');
});
