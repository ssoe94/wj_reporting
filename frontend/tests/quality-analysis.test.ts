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
    type_pareto: [
      { key: 'scratch', label: 'scratch', report_count: 3, sample_report_ids: [1, 2, 3], share_of_type_occurrences_percent: 75, cumulative_type_share_percent: 75 },
      { key: 'sink', label: 'sink', report_count: 1, sample_report_ids: [3], share_of_type_occurrences_percent: 25, cumulative_type_share_percent: 100 },
    ],
    type_pareto_summary: { classified_report_count: 3, excluded_report_count: 0, unclassified_report_count: 0, missing_phenomenon_report_count: 0, multi_type_report_count: 1, type_occurrence_count: 4, counting_policy: 'unique_report_type', quantity_policy: 'not_attributed' },
    type_pareto_exclusions: [],
    concentrations: { machines: concentrate([group('unknown', 2, 1, 0, [1, 2]), group('1', 1, 1, 4, [3])]), parts: concentrate([group('PART1', 3, 2, 4, [1, 2, 3])]), sections: concentrate([group('LQC_INJ', 3, 2, 4, [1, 2, 3])]) },
    data_quality: { missing_defect_qty_count: 1, missing_inspection_qty_count: 2, invalid_quantity_count: 0, paired_quantity_record_count: 1, inconsistent_quantity_count: 0, missing_part_count: 0, missing_phenomenon_count: 0, unclassified_type_count: 0, multi_type_count: 1, unassigned_machine_count: 2, duplicate_candidate_group_count: 1, duplicate_candidate_report_count: 2 },
    options: { sections: [{ value: 'LQC_INJ', label: { ko: '사출', zh: '注塑' } }], machines: [{ value: '1', label: 'IMM01', report_count: 1 }, { value: 'unknown', label: 'unknown', report_count: 2 }] },
    freshness: { generated_at: latest, latest_report_at: latest, latest_updated_at: latest },
    warnings: ['defect_quantity_incomplete', 'duplicate_candidates_not_removed'], limitations: ['Recorded incidents are not all inspected units.'], calculation_basis: ['Legacy Pareto keeps one report per bucket. Type Pareto counts each unique report-type occurrence without attributing defect quantity.'],
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
  data.pareto = []; data.type_pareto = []; data.type_pareto_exclusions = [];
  Object.assign(data.type_pareto_summary, { classified_report_count: 0, excluded_report_count: 0, unclassified_report_count: 0, missing_phenomenon_report_count: 0, multi_type_report_count: 0, type_occurrence_count: 0 });
  Object.values(data.concentrations).forEach(group => { group.items = []; group.total_group_count = 0; });
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

function withTypeExclusion() {
  const data = fixture();
  Object.assign(data.type_pareto_summary, { classified_report_count: 2, excluded_report_count: 1, unclassified_report_count: 1, type_occurrence_count: 3 });
  data.type_pareto = [
    { key: 'scratch', label: 'scratch', report_count: 2, sample_report_ids: [1, 3], share_of_type_occurrences_percent: 66.67, cumulative_type_share_percent: 66.67 },
    { key: 'sink', label: 'sink', report_count: 1, sample_report_ids: [3], share_of_type_occurrences_percent: 33.33, cumulative_type_share_percent: 100 },
  ];
  data.type_pareto_exclusions = [{ key: 'unclassified', label: { ko: '미분류', zh: '未分类' }, report_count: 1, sample_report_ids: [2] }];
  data.data_quality.unclassified_type_count = 1;
  data.pareto = [
    { key: 'multiple', label: 'multiple', report_count: 1, defect_quantity_record_count: 1, reported_defect_qty: 4, sample_report_ids: [3], share_of_reports_percent: 33.33, cumulative_report_share_percent: 33.33 },
    { key: 'scratch', label: 'scratch', report_count: 1, defect_quantity_record_count: 1, reported_defect_qty: 0, sample_report_ids: [1], share_of_reports_percent: 33.33, cumulative_report_share_percent: 66.67 },
    { key: 'unclassified', label: 'unclassified', report_count: 1, defect_quantity_record_count: 0, reported_defect_qty: null, sample_report_ids: [2], share_of_reports_percent: 33.33, cumulative_report_share_percent: 100 },
  ];
  return data;
}

test('a compound report contributes once to each type without increasing distinct report totals', () => {
  const data = parseQualityAnalysis(fixture(), scope);
  assert.equal(data.summary.report_count, 3);
  assert.equal(data.type_pareto_summary.classified_report_count, 3);
  assert.equal(data.type_pareto_summary.multi_type_report_count, 1);
  assert.equal(data.type_pareto_summary.type_occurrence_count, 4);
  assert.equal(data.type_pareto.reduce((sum, row) => sum + row.report_count, 0), 4);
  assert.ok(data.type_pareto.every(row => row.sample_report_ids.includes(3)));
  assert.equal(data.type_pareto.at(-1)?.cumulative_type_share_percent, 100);
});

test('unknown types are excluded with evidence while classified shares use type occurrences', () => {
  const data = parseQualityAnalysis(withTypeExclusion(), scope);
  assert.equal(data.summary.report_count, 3);
  assert.equal(data.type_pareto_summary.classified_report_count, 2);
  assert.equal(data.type_pareto_summary.excluded_report_count, 1);
  assert.deepEqual(data.type_pareto_exclusions[0].sample_report_ids, [2]);
  assert.ok(data.type_pareto.every(row => !row.sample_report_ids.includes(2)));
  assert.equal(data.type_pareto[0].share_of_type_occurrences_percent, 66.67);
  assert.equal(data.type_pareto.at(-1)?.cumulative_type_share_percent, 100);
});

test('all reports may be excluded without inventing a zero-type classification success', () => {
  const data = fixture();
  data.type_pareto = [];
  Object.assign(data.type_pareto_summary, { classified_report_count: 0, excluded_report_count: 3, unclassified_report_count: 2, missing_phenomenon_report_count: 1, multi_type_report_count: 0, type_occurrence_count: 0 });
  data.type_pareto_exclusions = [
    { key: 'missing', label: 'missing', report_count: 1, sample_report_ids: [3] },
    { key: 'unclassified', label: 'unclassified', report_count: 2, sample_report_ids: [1, 2] },
  ];
  data.data_quality.missing_phenomenon_count = 1; data.data_quality.unclassified_type_count = 2; data.data_quality.multi_type_count = 0;
  data.pareto = [
    { ...data.pareto[0], key: 'unclassified', label: 'unclassified' },
    { ...data.pareto[1], key: 'missing', label: 'missing' },
  ];
  assert.equal(parseQualityAnalysis(data, scope).type_pareto.length, 0);
  assert.equal(data.summary.report_count, 3);
  assert.equal(data.type_pareto_exclusions.reduce((sum, row) => sum + row.report_count, 0), 3);
});

test('type summaries reject wrong report partition, occurrence denominator and unsupported policies', () => {
  for (const change of [
    { classified_report_count: 2 }, { excluded_report_count: 1 }, { unclassified_report_count: 1 },
    { multi_type_report_count: 4 }, { type_occurrence_count: 3 }, { multi_type_report_count: 0 },
    { quantity_policy: 'proportional' }, { counting_policy: 'per_alias' },
  ]) {
    const data = fixture(); Object.assign(data.type_pareto_summary, change);
    assert.throws(() => parseQualityAnalysis(data, scope), /type_denominator/);
  }
});

test('type shares never borrow the distinct-report denominator or accept an incomplete cumulative line', () => {
  const wrongBase = fixture(); wrongBase.type_pareto[0].share_of_type_occurrences_percent = 100;
  assert.throws(() => parseQualityAnalysis(wrongBase, scope), /share/);
  const wrongEnd = fixture(); wrongEnd.type_pareto[1].cumulative_type_share_percent = 99.99;
  assert.throws(() => parseQualityAnalysis(wrongEnd, scope), /share/);
  const wrongPrecision = withTypeExclusion(); wrongPrecision.type_pareto[0].share_of_type_occurrences_percent = 66.66;
  assert.throws(() => parseQualityAnalysis(wrongPrecision, scope), /share/);
});

test('duplicate type aliases, descending-order violations and legacy multiple buckets are rejected', () => {
  const duplicate = fixture(); duplicate.type_pareto[1].key = duplicate.type_pareto[0].key;
  assert.throws(() => parseQualityAnalysis(duplicate, scope), /order/);
  const multiple = fixture(); multiple.type_pareto[1].key = 'multiple';
  assert.throws(() => parseQualityAnalysis(multiple, scope), /excluded/);
  const reversed = fixture(); reversed.type_pareto.reverse();
  reversed.type_pareto[0].cumulative_type_share_percent = 25; reversed.type_pareto[1].cumulative_type_share_percent = 100;
  assert.throws(() => parseQualityAnalysis(reversed, scope), /order/);
});

test('type samples are unique within each type and bounded by classified report evidence', () => {
  const duplicateId = fixture(); duplicateId.type_pareto[0].sample_report_ids = [1, 1];
  assert.throws(() => parseQualityAnalysis(duplicateId, scope), /samples/);
  const excessPerRow = fixture(); excessPerRow.type_pareto[1].sample_report_ids = [1, 3];
  assert.throws(() => parseQualityAnalysis(excessPerRow, scope), /samples/);
  const excessDistinct = fixture(); excessDistinct.type_pareto[1].sample_report_ids = [4];
  assert.throws(() => parseQualityAnalysis(excessDistinct, scope), /reconcile/);
  const excessiveCount = withTypeExclusion(); excessiveCount.type_pareto[0].report_count = 3;
  assert.throws(() => parseQualityAnalysis(excessiveCount, scope), /type_evidence/);
});

test('excluded report counts reconcile and excluded sample IDs cannot also be classified', () => {
  const missing = withTypeExclusion(); missing.type_pareto_exclusions = [];
  assert.throws(() => parseQualityAnalysis(missing, scope), /exclusions/);
  const overlap = withTypeExclusion(); overlap.type_pareto_exclusions[0].sample_report_ids = [3];
  assert.throws(() => parseQualityAnalysis(overlap, scope), /overlapping/);
  const wrongKind = withTypeExclusion(); wrongKind.type_pareto_exclusions[0].key = 'missing';
  assert.throws(() => parseQualityAnalysis(wrongKind, scope), /exclusion/);
  const inside = withTypeExclusion(); inside.type_pareto[1].key = 'unclassified';
  assert.throws(() => parseQualityAnalysis(inside, scope), /excluded/);
});

test('type rows cannot carry duplicated defect quantities', () => {
  const data = fixture(); Object.assign(data.type_pareto[0], { defect_quantity_record_count: 2, reported_defect_qty: 4 });
  assert.throws(() => parseQualityAnalysis(data, scope), /type_evidence/);
});

test('CSV exports type occurrences and exclusions with empty quantity columns and separate denominators', () => {
  const data = parseQualityAnalysis(withTypeExclusion(), scope);
  const csv = createQualityAnalysisCsv(data, 'ko');
  assert.match(csv, /"share_denominator_reports","3"/);
  assert.match(csv, /"share_denominator_type_occurrences","3"/);
  assert.match(csv, /"classified_report_count","2"/);
  assert.match(csv, /"type_pareto_quantity_policy","not_attributed"/);
  const lines = csv.split('\r\n');
  assert.ok(!lines.some(line => line.startsWith('"pareto",')));
  assert.ok(!lines.some(line => line.startsWith('"type_pareto","multiple"')));
  assert.ok(lines.some(line => line.startsWith('"type_pareto_exclusion","unclassified"')));
  for (const line of lines.filter(line => line.startsWith('"type_pareto",') || line.startsWith('"type_pareto_exclusion",'))) {
    const cells = line.split(',');
    assert.equal(cells[4], '""'); assert.equal(cells[5], '""'); assert.equal(cells[6], '""');
  }
  const typeLine = lines.find(line => line.startsWith('"type_pareto","scratch"'))!;
  assert.match(typeLine, /"66.67","66.67","3","1\|3"$/);
  const concentrationLine = lines.find(line => line.startsWith('"parts",'))!;
  assert.match(concentrationLine, /"100","","","3","1\|2\|3"$/);
  assert.match(createQualityAnalysisCsv(fixture(), 'ko'), /"share_denominator_type_occurrences","4"/);
});

test('Python half-even two-decimal shares remain valid at exact rounding ties', () => {
  const data = fixture();
  data.summary.report_count = 32; data.trend[0].report_count = 31;
  Object.assign(data.pareto[0], { report_count: 31, share_of_reports_percent: 96.88, cumulative_report_share_percent: 96.88 });
  Object.assign(data.pareto[1], { key: 'sink', label: 'sink', share_of_reports_percent: 3.12 });
  Object.assign(data.concentrations.machines.items[0], { report_count: 31, share_of_reports_percent: 96.88 });
  data.concentrations.machines.items[1].share_of_reports_percent = 3.12;
  data.concentrations.parts.items[0].report_count = 32; data.concentrations.sections.items[0].report_count = 32;
  Object.assign(data.type_pareto_summary, { classified_report_count: 32, multi_type_report_count: 0, type_occurrence_count: 32 });
  Object.assign(data.type_pareto[0], { report_count: 31, sample_report_ids: [1, 2], share_of_type_occurrences_percent: 96.88, cumulative_type_share_percent: 96.88 });
  data.type_pareto[1].share_of_type_occurrences_percent = 3.12;
  Object.assign(data.data_quality, { missing_defect_qty_count: 30, missing_inspection_qty_count: 31, multi_type_count: 0, unassigned_machine_count: 31 });
  assert.equal(parseQualityAnalysis(data, scope).type_pareto[1].share_of_type_occurrences_percent, 3.12);
  data.type_pareto[1].share_of_type_occurrences_percent = 3.125;
  assert.throws(() => parseQualityAnalysis(data, scope), /share/);
});

function withActivityCalendar() {
  const data = fixture();
  data.trend = [
    { date: scope.startDate, report_count: 0, defect_quantity_record_count: 0, reported_defect_qty: null },
    { date: scope.endDate, report_count: 3, defect_quantity_record_count: 2, reported_defect_qty: 4 },
  ];
  data.activity_calendar = {
    schema_version: 'quality-activity.v1', status: 'ready', source: 'InjectionMonitoringRecord', timezone: 'Asia/Shanghai',
    date_basis: 'calendar_day', policy: 'continuous_constant_capacity_v1', max_gap_minutes: 10, expected_machine_count: 17,
    days: [
      { date: scope.startDate, status: 'no_change', reason: 'continuous_constant_capacity', can_collapse: true, observed_machine_count: 17 },
      { date: scope.endDate, status: 'activity', reason: 'capacity_changed', can_collapse: false, observed_machine_count: 17 },
    ],
  };
  return data;
}

test('validated injection-log metadata can mark only an empty quality date for collapse', () => {
  const source = withActivityCalendar();
  const data = parseQualityAnalysis(source, scope);
  assert.equal(data.activity_calendar?.days[0].can_collapse, true);
  assert.equal(data.activity_calendar?.days[1].can_collapse, false);
  assert.equal(data.summary.report_count, 3);
  assert.equal(data.trend.length, 2);
});

test('old servers without activity metadata retain all quality dates even when collapse is requested', () => {
  const data = parseQualityAnalysis(fixture(), scope);
  assert.equal(data.activity_calendar, undefined);
  assert.ok(!data.warnings.includes('activity_calendar_invalid'));
  const csv = createQualityAnalysisCsv(data, 'ko', { collapseInactiveDays: true });
  assert.match(csv, /"trend_display_mode","calendar"/);
  assert.match(csv, /"trend_collapsed_date_count","0"/);
  assert.match(csv, /"trend_activity_status","not_provided"/);
  assert.equal(csv.split('\r\n').filter(line => line.startsWith('"daily",')).length, 2);
});

test('activity metadata enforces selected-machine scope and supports other sections only as not applicable', () => {
  const selected = withActivityCalendar(); selected.filters.machine_number = 1;
  selected.activity_calendar!.expected_machine_count = 1;
  selected.activity_calendar!.days.forEach(day => { day.observed_machine_count = 1; });
  assert.equal(parseQualityAnalysis(selected, { ...scope, machineNumber: '1' }).activity_calendar?.expected_machine_count, 1);
  const other = withActivityCalendar(); other.filters.section = 'IQC';
  other.activity_calendar!.status = 'not_applicable';
  other.activity_calendar!.days.forEach(day => { day.status = 'unknown'; day.can_collapse = false; day.observed_machine_count = 0; day.reason = 'unsupported_section'; });
  assert.equal(parseQualityAnalysis(other, { ...scope, section: 'IQC' }).activity_calendar?.status, 'not_applicable');
  const unknown = withActivityCalendar(); unknown.filters.machine_number = 'unknown';
  unknown.activity_calendar!.expected_machine_count = 0; unknown.activity_calendar!.status = 'not_applicable';
  unknown.activity_calendar!.days.forEach(day => { day.status = 'unknown'; day.can_collapse = false; day.observed_machine_count = 0; day.reason = 'unsupported_machine'; });
  assert.equal(parseQualityAnalysis(unknown, { ...scope, machineNumber: 'unknown' }).activity_calendar?.expected_machine_count, 0);
  const unsupportedReady = withActivityCalendar(); unsupportedReady.filters.section = 'IQC';
  assert.equal(parseQualityAnalysis(unsupportedReady, { ...scope, section: 'IQC' }).activity_calendar, undefined);
});

test('unavailable activity source preserves the complete quality response and all displayed dates', () => {
  const source = withActivityCalendar(); source.activity_calendar!.status = 'unavailable';
  source.activity_calendar!.days.forEach(day => { day.status = 'unknown'; day.reason = 'source_query_failed'; day.can_collapse = false; day.observed_machine_count = 0; });
  const data = parseQualityAnalysis(source, scope);
  assert.equal(data.activity_calendar?.status, 'unavailable');
  assert.equal(data.summary.reported_defect_qty, 4);
  assert.match(createQualityAnalysisCsv(data, 'ko', { collapseInactiveDays: true }), /"trend_display_mode","calendar"/);
});

test('invalid auxiliary contracts are discarded with a warning without hiding core quality evidence', () => {
  for (const change of [
    { schema_version: 'quality-activity.v2' }, { source: 'ProductionPlan' }, { timezone: 'Asia/Seoul' },
    { date_basis: 'business_day_08' }, { policy: 'no_plan' }, { max_gap_minutes: 60 },
    { expected_machine_count: 1 }, { days: [] }, { status: 'not_applicable' },
  ]) {
    const source = withActivityCalendar(); Object.assign(source.activity_calendar!, change);
    const original = structuredClone(source);
    const data = parseQualityAnalysis(source, scope);
    assert.equal(data.activity_calendar, undefined);
    assert.ok(data.warnings.includes('activity_calendar_invalid'));
    assert.deepEqual(data.summary, source.summary);
    assert.deepEqual(data.trend, source.trend);
    assert.deepEqual(source, original);
    const csv = createQualityAnalysisCsv(data, 'ko', { collapseInactiveDays: true });
    assert.match(csv, /"trend_collapsed_date_count","0"/);
    assert.match(csv, /"trend_activity_status","invalid"/);
    assert.match(csv, /"trend_activity_warning","activity_calendar_invalid"/);
  }
});

test('activity dates, coverage and collapse flags cannot bypass quality-report evidence', () => {
  for (const change of [
    { date: scope.endDate }, { observed_machine_count: 16 }, { observed_machine_count: 18 },
    { observed_machine_count: -1 }, { observed_machine_count: 1.5 }, { can_collapse: 'true' },
    { status: 'activity' }, { status: 'unknown' }, { reason: '' },
  ]) {
    const data = withActivityCalendar(); Object.assign(data.activity_calendar!.days[0], change);
    assert.equal(parseQualityAnalysis(data, scope).activity_calendar, undefined);
  }
  const recorded = withActivityCalendar();
  Object.assign(recorded.activity_calendar!.days[1], { status: 'no_change', can_collapse: true });
  assert.equal(parseQualityAnalysis(recorded, scope).activity_calendar, undefined);
  const zeroQuantity = fixture(); zeroQuantity.activity_calendar = withActivityCalendar().activity_calendar;
  assert.equal(zeroQuantity.trend[0].reported_defect_qty, 0);
  assert.equal(parseQualityAnalysis(zeroQuantity, scope).activity_calendar, undefined);
});

test('invalid core quality contracts still fail even when auxiliary activity metadata is invalid', () => {
  const data = withActivityCalendar(); data.activity_calendar!.days = [];
  data.type_pareto_summary.type_occurrence_count = 1;
  assert.throws(() => parseQualityAnalysis(data, scope), /type_denominator/);
});

test('CSV defaults to calendar display and retains every original daily row when dates are collapsed', () => {
  const data = parseQualityAnalysis(withActivityCalendar(), scope);
  const original = structuredClone(data);
  const defaultCsv = createQualityAnalysisCsv(data, 'ko');
  assert.match(defaultCsv, /"trend_collapse_inactive_days_requested","false"/);
  assert.match(defaultCsv, /"trend_display_mode","calendar"/);
  const collapsedCsv = createQualityAnalysisCsv(data, 'ko', { collapseInactiveDays: true });
  assert.match(collapsedCsv, /"trend_display_mode","confirmed_no_change_dates_collapsed"/);
  assert.match(collapsedCsv, /"trend_displayed_date_count","1"/);
  assert.match(collapsedCsv, /"trend_collapsed_date_count","1"/);
  assert.match(collapsedCsv, /"trend_raw_daily_rows_retained","true"/);
  assert.match(collapsedCsv, /"trend_activity_policy","continuous_constant_capacity_v1"/);
  const lines = collapsedCsv.split('\r\n').filter(line => line.startsWith('"daily",'));
  assert.equal(lines.length, 2);
  const hidden = lines[0].split(','); const shown = lines[1].split(',');
  assert.equal(hidden[1], `"${scope.startDate}"`);
  assert.deepEqual(hidden.slice(3, 6), ['"0"', '"0"', '""']);
  assert.deepEqual(hidden.slice(11), ['"no_change"', '"continuous_constant_capacity"', '"17"', '"true"', '"false"']);
  assert.equal(shown[15], '"true"');
  assert.ok(defaultCsv.split('\r\n').filter(line => line.startsWith('"daily",')).every(line => line.endsWith('"true"')));
  assert.deepEqual(data, original);
});
