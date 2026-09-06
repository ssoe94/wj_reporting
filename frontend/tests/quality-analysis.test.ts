import assert from 'node:assert/strict';
import test from 'node:test';
import { createQualityAnalysisCsv, parseQualityAnalysis, qualityCsvCell, qualityScopeParams, quantityCoverage, resolveQualityScope, validateQualityScope } from '../src/domains/quality/model.ts';
import type { QualityAnalysis, QualityGroup, QualityScope } from '../src/domains/quality/model.ts';
// Synthetic evidence only: no API, production dataset or database access.
const scope: QualityScope = { startDate: '2026-09-05', endDate: '2026-09-06', section: '', machineNumber: '' };
function fixture(): QualityAnalysis {
  const group = (key: string, count: number, known: number, qty: number | null, ids: number[]): QualityGroup => ({ key, label: key, report_count: count, defect_quantity_record_count: known, reported_defect_qty: qty, share_of_reports_percent: Math.round(count / 3 * 10000) / 100, sample_report_ids: ids });
  const concentrate = (items: QualityGroup[]) => ({ items, total_group_count: items.length, top_n: 20, other_report_count: 0 });
  const latest = '2026-09-06T09:00:00+08:00';
  return {
    schema_version: 'quality-analysis.v1', status: 'partial',
    filters: { start_date: scope.startDate, end_date: scope.endDate, section: null, machine_number: null, timezone: 'Asia/Shanghai', date_basis: 'report_dt_calendar_day' },
    summary: { report_count: 3, defect_quantity_record_count: 2, reported_defect_qty: 4, inspection_quantity_record_count: 1, recorded_inspection_qty: 10, zero_defect_report_count: 1, latest_report_at: latest },
    trend: [{ date: scope.startDate, report_count: 2, defect_quantity_record_count: 1, reported_defect_qty: 0 }, { date: scope.endDate, report_count: 1, defect_quantity_record_count: 1, reported_defect_qty: 4 }],
    pareto: [{ ...group('scratch', 2, 1, 0, [1, 2]), cumulative_report_share_percent: 66.67 }, { ...group('multiple', 1, 1, 4, [3]), cumulative_report_share_percent: 100 }],
    concentrations: { machines: concentrate([group('unknown', 2, 1, 0, [1, 2]), group('1', 1, 1, 4, [3])]), parts: concentrate([group('PART1', 3, 2, 4, [1, 2, 3])]), sections: concentrate([group('LQC_INJ', 3, 2, 4, [1, 2, 3])]) },
    data_quality: { missing_defect_qty_count: 1, missing_inspection_qty_count: 2, invalid_quantity_count: 0, paired_quantity_record_count: 1, inconsistent_quantity_count: 0, missing_part_count: 0, missing_phenomenon_count: 0, unclassified_type_count: 0, multi_type_count: 1, unassigned_machine_count: 2, duplicate_candidate_group_count: 1, duplicate_candidate_report_count: 2 },
    options: { sections: [{ value: 'LQC_INJ', label: { ko: '사출', zh: '注塑' } }], machines: [{ value: '1', label: 'IMM01', report_count: 1 }, { value: 'unknown', label: 'unknown', report_count: 2 }] },
    freshness: { generated_at: latest, latest_report_at: latest, latest_updated_at: latest },
    warnings: ['defect_quantity_incomplete', 'duplicate_candidates_not_removed'], limitations: ['Recorded incidents are not all inspected units.'], calculation_basis: ['Each report belongs to one Pareto bucket.'],
  };
}
function withoutQuantities() {
  const data = fixture();
  data.summary.defect_quantity_record_count = 0; data.summary.reported_defect_qty = null; data.summary.zero_defect_report_count = 0;
  data.data_quality.missing_defect_qty_count = 3; data.data_quality.paired_quantity_record_count = 0;
  for (const row of [...data.trend, ...data.pareto, ...Object.values(data.concentrations).flatMap(group => group.items)]) { row.defect_quantity_record_count = 0; row.reported_defect_qty = null; }
  return data;
}
test('known zero, missing quantity and partial coverage retain distinct meanings', () => {
  const data = parseQualityAnalysis(fixture(), scope);
  assert.equal(data.trend[0].reported_defect_qty, 0); assert.equal(data.summary.reported_defect_qty, 4);
  assert.equal(quantityCoverage(data.summary), 2 / 3 * 100);
  assert.equal(parseQualityAnalysis(withoutQuantities(), scope).summary.reported_defect_qty, null);
});
test('no known quantity cannot become zero', () => {
  const data = withoutQuantities(); data.summary.reported_defect_qty = 0;
  assert.throws(() => parseQualityAnalysis(data, scope), /not_zero/);
});
test('empty report window is not proof of zero defects', () => {
  const data = fixture(); data.status = 'no_records';
  data.summary = { report_count: 0, defect_quantity_record_count: 0, reported_defect_qty: null, inspection_quantity_record_count: 0, recorded_inspection_qty: null, zero_defect_report_count: 0, latest_report_at: null };
  data.trend.forEach(row => { row.report_count = 0; row.defect_quantity_record_count = 0; row.reported_defect_qty = null; });
  data.pareto = []; Object.values(data.concentrations).forEach(group => { group.items = []; group.total_group_count = 0; });
  Object.keys(data.data_quality).forEach(key => { data.data_quality[key as keyof typeof data.data_quality] = 0; });
  data.freshness.latest_report_at = null; data.freshness.latest_updated_at = null;
  assert.equal(quantityCoverage(parseQualityAnalysis(data, scope).summary), null);
});
test('mixed types and duplicate candidates remain counted once as saved reports', () => {
  const data = parseQualityAnalysis(fixture(), scope);
  assert.equal(data.pareto.find(row => row.key === 'multiple')?.report_count, 1);
  assert.equal(data.summary.report_count, 3); assert.equal(data.data_quality.duplicate_candidate_report_count, 2);
});
test('duplicate Pareto allocation is rejected', () => {
  const data = fixture(); data.pareto.push({ ...data.pareto[0] }); assert.throws(() => parseQualityAnalysis(data, scope));
});
test('Pareto shares use all selected reports as denominator', () => {
  const data = fixture(); data.pareto[0].share_of_reports_percent = 100; assert.throws(() => parseQualityAnalysis(data, scope), /share/);
});
test('daily totals must reconcile with headline quantities', () => {
  const data = fixture(); data.trend[1].reported_defect_qty = 5; assert.throws(() => parseQualityAnalysis(data, scope), /reconcile/);
});
test('truncated concentrations account for reports outside the table', () => {
  const data = fixture(); data.concentrations.machines.items = [data.concentrations.machines.items[0]];
  assert.throws(() => parseQualityAnalysis(data, scope), /concentration/);
  data.concentrations.machines.other_report_count = 1;
  assert.equal(parseQualityAnalysis(data, scope).concentrations.machines.other_report_count, 1);
});
test('wrong date, machine or calendar basis cannot be displayed', () => {
  for (const change of [{ end_date: '2026-09-07' }, { machine_number: 1 }, { date_basis: 'business_day_08' }]) {
    const data = fixture(); Object.assign(data.filters, change); assert.throws(() => parseQualityAnalysis(data, scope), /scope/);
  }
});
test('missing or repeated trend dates are rejected', () => {
  const data = fixture(); data.trend.pop(); assert.throws(() => parseQualityAnalysis(data, scope), /trend/);
  const repeated = fixture(); repeated.trend[1].date = repeated.trend[0].date; assert.throws(() => parseQualityAnalysis(repeated, scope), /trend/);
});
test('malformed evidence and negative quantities fail instead of becoming empty', () => {
  assert.throws(() => parseQualityAnalysis(null, scope));
  const data = fixture(); data.summary.reported_defect_qty = -1; assert.throws(() => parseQualityAnalysis(data, scope), /quantity/);
});
test('end-date-only URLs anchor their default 30 days to that end date', () => {
  const data = resolveQualityScope('?end_date=2026-07-31', '2026-09-06'); assert.equal(data.startDate, '2026-07-02'); assert.equal(data.endDate, '2026-07-31');
});
test('invalid dates, reversed or overlong ranges and ambiguous filters fail', () => {
  for (const search of ['start_date=2026-02-30', 'start_date=2026-09-06&end_date=2026-09-05', 'start_date=2025-01-01&end_date=2026-09-06', 'machine_number=01', 'machine_number=1&machine_number=2']) assert.throws(() => resolveQualityScope(search, '2026-09-06'));
  assert.equal(validateQualityScope({ ...scope, startDate: '2025-09-06' }).startDate, '2025-09-06');
});
test('query preserves selected process and unknown equipment', () => {
  assert.equal(qualityScopeParams({ ...scope, section: 'LQC_INJ', machineNumber: 'unknown' }).toString(), 'start_date=2026-09-05&end_date=2026-09-06&section=LQC_INJ&machine_number=unknown');
});
test('CSV preserves null versus zero and carries scope and denominator', () => {
  assert.equal(qualityCsvCell(null), '""'); assert.equal(qualityCsvCell(0), '"0"');
  const csv = createQualityAnalysisCsv(fixture(), 'ko'); assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /2026-09-05/); assert.match(csv, /share_denominator_reports","3/);
  assert.match(csv, /No overall defect rate/); assert.match(csv, /Potential duplicates retained/);
  assert.match(createQualityAnalysisCsv(withoutQuantities(), 'ko'), /"summary","","","3","0",""/);
});
test('CSV text cannot execute spreadsheet formulas', () => {
  const data = fixture(); data.concentrations.parts.items[0].label = '=SUM(A1:A2)';
  assert.match(createQualityAnalysisCsv(data, 'ko'), /'=SUM\(A1:A2\)/); assert.equal(qualityCsvCell('  @attack'), '"\'  @attack"');
});
