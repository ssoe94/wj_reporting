import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  getMesReportEvidence, getMesReportRowEvidence, parseMesReportStats,
  type MesStatsResponse, type MesStatsRow,
} from '../src/domains/production/mes-report-evidence.ts';

const date = '2026-09-04';
const row: MesStatsRow = {
  equipment_key: '1', equipment_name: 'fixture', equipment_label: 'fixture',
  part_no: 'TEST-ONLY', model_name: '', planned_qty: 100, mes_qty: 0,
  mes_report_count: 1, latest_report_time: '2026-09-04T09:00:00+08:00',
  process_code: 'ZS', plan_row_count: 1,
};
function payload(rows: MesStatsRow[] = [row]): MesStatsResponse {
  return {
    date, plan_type: 'injection', range_mode: 'day',
    range_start: `${date}T08:00:00+08:00`, range_end: '2026-09-05T08:00:00+08:00',
    latest_synced_at: '2026-09-04T10:00:00+08:00',
    summary: {
      total_planned: rows.reduce((sum, item) => sum + item.planned_qty, 0),
      total_mes: rows.reduce((sum, item) => sum + item.mes_qty, 0),
      raw_mes_count: rows.reduce((sum, item) => sum + item.mes_report_count, 0),
      grouped_mes_count: rows.reduce((sum, item) => sum + item.mes_report_count, 0),
    }, rows,
  };
}
const success = { isError: false, isPending: false };

test('a stored zero report is present even when a legacy quantity-based status says plan_only', () => {
  const source = payload([{ ...row, mes_qty: 0 }]);
  const data = parseMesReportStats(source, date, 'injection');
  assert.deepEqual(getMesReportRowEvidence(data.rows[0]), { presence: 'both', planQuantity: 100, reportQuantity: 0, observedGap: -100 });
  assert.equal(getMesReportEvidence(data, success).bothCount, 1);
});

test('an unobserved report cannot become zero or a quantified deficit', () => {
  const data = payload([{ ...row, mes_report_count: 0, mes_qty: 0, latest_report_time: null }]);
  const evidence = getMesReportEvidence(parseMesReportStats(data, date, 'injection'), success);
  assert.equal(evidence.planQuantity, 100);
  assert.equal(evidence.reportQuantity, null);
  assert.equal(getMesReportRowEvidence(evidence.rows[0]).observedGap, null);
  assert.equal(evidence.planOnlyCount, 1);
});

test('reported quantity without a plan has no invented zero target', () => {
  const item = { ...row, plan_row_count: 0, planned_qty: 0, mes_qty: 25 };
  assert.deepEqual(getMesReportRowEvidence(item), { presence: 'report_only', planQuantity: null, reportQuantity: 25, observedGap: null });
});

test('both source records does not establish quantity equality', () => {
  const data = payload([{ ...row, mes_qty: 25 }]);
  assert.equal(getMesReportRowEvidence(data.rows[0]).presence, 'both');
  assert.equal(getMesReportRowEvidence(data.rows[0]).observedGap, -75);
});

test('loading, errors, and empty source responses never render KPI zero', () => {
  for (const query of [{ isError: false, isPending: true }, { isError: true, isPending: false }]) {
    const evidence = getMesReportEvidence(payload(), query);
    assert.equal(evidence.planQuantity, null);
    assert.equal(evidence.reportQuantity, null);
    assert.deepEqual(evidence.rows, []);
  }
  const empty = getMesReportEvidence(parseMesReportStats(payload([]), date, 'injection'), success);
  assert.equal(empty.state, 'empty');
  assert.equal(empty.reportQuantity, null);
});

test('scope and 08:00 half-open business window must match the request', () => {
  assert.throws(() => parseMesReportStats(payload(), '2026-09-05', 'injection'));
  assert.throws(() => parseMesReportStats(payload(), date, 'machining'));
  assert.throws(() => parseMesReportStats({ ...payload(), range_end: '2026-09-05T08:10:00+08:00' }, date, 'injection'));
});

test('malformed success and contradictory totals are rejected rather than normalized to zero', () => {
  assert.throws(() => parseMesReportStats({}, date, 'injection'));
  assert.throws(() => parseMesReportStats(payload([{ ...row, mes_qty: Number.NaN }]), date, 'injection'));
  assert.throws(() => parseMesReportStats(payload([{ ...row, mes_report_count: 0, mes_qty: 12 }]), date, 'injection'));
  assert.throws(() => parseMesReportStats({ ...payload(), summary: { ...payload().summary, total_mes: 50 } }, date, 'injection'));
  assert.throws(() => parseMesReportStats(payload([{ ...row, latest_report_time: '2026-09-04T09:00:00' }]), date, 'injection'));
});

test('duplicate report groups and duplicate cross-line machining groups are rejected', () => {
  assert.throws(() => parseMesReportStats(payload([row, row]), date, 'injection'));
  const source = { ...payload([row, { ...row, equipment_key: '2' }]), plan_type: 'machining' };
  assert.throws(() => parseMesReportStats(source, date, 'machining'));
});

test('different report-time and stored-day counts require a date attribution warning', () => {
  const source = payload();
  source.summary.raw_mes_count = 2;
  const evidence = getMesReportEvidence(parseMesReportStats(source, date, 'injection'), success);
  assert.equal(evidence.rangeMismatch, true);
  assert.equal(evidence.reportCount, 1);
  assert.equal(evidence.latestReportTime, row.latest_report_time);
  assert.equal(evidence.latestStoredTime, source.latest_synced_at);
});

test('a real cached QueryObserver refresh failure suppresses previously successful totals', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let fail = false;
  const observer = new QueryObserver(client, {
    queryKey: ['mes-report-evidence-fixture'],
    queryFn: async () => {
      if (fail) throw new Error('synthetic refresh failure');
      return parseMesReportStats(payload(), date, 'injection');
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    fail = true;
    await observer.refetch();
    const result = observer.getCurrentResult();
    assert.ok(result.data);
    assert.equal(result.isError, true);
    const evidence = getMesReportEvidence(result.data, result);
    assert.equal(evidence.state, 'error');
    assert.equal(evidence.planQuantity, null);
    assert.equal(evidence.reportCount, null);
    assert.deepEqual(evidence.rows, []);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('an empty stored-day grouping preserves report-time diagnostics and mismatch', () => {
  const source = payload([]);
  source.summary.raw_mes_count = 1;
  const parsed = parseMesReportStats(source, date, 'injection');
  const evidence = getMesReportEvidence(parsed, success);
  assert.equal(evidence.state, 'empty');
  assert.equal(evidence.rawReportCount, 1);
  assert.equal(evidence.reportCount, 0);
  assert.equal(evidence.rangeMismatch, true);
  assert.equal(evidence.reportQuantity, null);
  const failed = getMesReportEvidence(parsed, { isError: true, isPending: false });
  assert.equal(failed.rawReportCount, null);
  assert.equal(failed.rangeMismatch, false);
});

test('equal row counts do not hide report timestamps outside the business window', () => {
  for (const time of ['2026-09-04T07:59:59+08:00', '2026-09-05T08:00:00+08:00', '2026-09-05T09:00:00+08:00']) {
    const source = payload([{ ...row, mes_qty: 25, latest_report_time: time }]);
    const evidence = getMesReportEvidence(parseMesReportStats(source, date, 'injection'), success);
    assert.equal(evidence.state, 'ready');
    assert.equal(evidence.rangeMismatch, true);
    assert.equal(evidence.reportQuantity, 25);
    assert.equal(evidence.latestReportTime, time);
  }
});

test('opening timestamp is included and the last second before next 08:00 remains in range', () => {
  for (const time of ['2026-09-04T08:00:00+08:00', '2026-09-05T07:59:59+08:00']) {
    const source = payload([{ ...row, latest_report_time: time }]);
    assert.equal(getMesReportEvidence(parseMesReportStats(source, date, 'injection'), success).rangeMismatch, false);
  }
});
