import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQualityAnalysis, qualityScopeParams, resolveQualityScope, validateQualityScope } from '../src/domains/quality/model.ts';
import type { QualityAnalysis, QualityGroup, QualityProductionContext, QualityProductionMatchCounts, QualityScope } from '../src/domains/quality/model.ts';
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
  assert.equal(data.summary.defect_quantity_record_count, 2);
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
  assert.equal(parseQualityAnalysis(data, scope).summary.report_count, 0);
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

function productionContext(data: QualityAnalysis): QualityProductionContext {
  const basis = (overrides: Partial<QualityProductionMatchCounts>): QualityProductionMatchCounts => ({ production_record: 0, stored_plan: 0, recorded_only: 0, ambiguous: 0, unmatched: 0, not_injection: 0, ...overrides });
  const model = { model_display: 'MODEL - B/C', part_no: 'PART1' };
  const machineRows = data.concentrations.machines.items.map((row, index) => ({ ...row, ...model,
    machine_number: index === 0 ? null : 1, match_basis_counts: index === 0 ? basis({ stored_plan: 1, recorded_only: 1 }) : basis({ production_record: 1 }),
  }));
  return {
    schema_version: 'quality-production-context.v1', status: 'ready', policy: 'unique_dated_part_model_candidate_v1',
    summary: { report_count: 3, production_record_match_count: 1, plan_match_count: 1, recorded_only_count: 1, ambiguous_count: 0, unmatched_count: 0, not_injection_count: 0, missing_model_count: 1 },
    model_parts: { ...data.concentrations.parts, items: [{ ...data.concentrations.parts.items[0], ...model, label: model.model_display, machine_number: null, match_basis_counts: basis({ production_record: 1, stored_plan: 1, recorded_only: 1 }) }] },
    machine_models: { ...data.concentrations.machines, items: machineRows },
    limitations: ['Dated candidates do not establish production-time incident causation.'],
  };
}
function withProductionEvidence() {
  const data = fixture(); data.production_context = productionContext(data);
  return data;
}

test('model-first production groups preserve original report and quantity totals with exclusive source evidence', () => {
  const data = parseQualityAnalysis(withProductionEvidence(), scope);
  assert.equal(data.production_context?.model_parts.items[0].model_display, 'MODEL - B/C');
  assert.equal(data.production_context?.model_parts.items[0].part_no, 'PART1');
  assert.equal(data.production_context?.model_parts.items[0].reported_defect_qty, 4);
  assert.deepEqual(data.production_context?.model_parts.items[0].sample_report_ids, [1, 2, 3]);
  assert.equal(data.production_context?.summary.report_count, data.summary.report_count);
  assert.equal(data.production_context?.summary.missing_model_count, 1);
});

test('missing display text and dated machine candidates do not rewrite the recorded-machine filter', () => {
  const data = withProductionEvidence();
  data.production_context!.model_parts.items[0].model_display = '';
  data.production_context!.model_parts.items[0].part_no = '';
  data.production_context!.machine_models.items[0].machine_number = 2;
  const parsed = parseQualityAnalysis(data, scope);
  assert.equal(parsed.production_context?.model_parts.items[0].model_display, '');
  assert.equal(parsed.production_context?.machine_models.items[0].machine_number, 2);
  assert.equal(parsed.concentrations.machines.items[0].key, 'unknown');
});

test('context partition errors invalidate only the production context', () => {
  for (const change of [{ report_count: 4 }, { plan_match_count: 0 }, { missing_model_count: 4 }, { ambiguous_count: -1 }]) {
    const source = withProductionEvidence(); Object.assign(source.production_context!.summary, change);
    const original = structuredClone(source); const parsed = parseQualityAnalysis(source, scope);
    assert.equal(parsed.production_context, undefined); assert.ok(parsed.warnings.includes('production_context_invalid'));
    assert.deepEqual(parsed.summary, source.summary); assert.deepEqual(source, original);
  }
});

test('production groups reject duplicate samples, invalid machines, allocations and quantity duplication', () => {
  for (const change of [
    (data: QualityAnalysis) => { data.production_context!.model_parts.items[0].match_basis_counts.production_record = 2; },
    (data: QualityAnalysis) => { data.production_context!.model_parts.items[0].machine_number = 1; },
    (data: QualityAnalysis) => { data.production_context!.machine_models.items[0].machine_number = 18; },
    (data: QualityAnalysis) => { data.production_context!.machine_models.items[1].sample_report_ids = [1]; },
    (data: QualityAnalysis) => { data.production_context!.machine_models.items[0].reported_defect_qty = 4; },
    (data: QualityAnalysis) => { data.production_context!.model_parts.items[0].share_of_reports_percent = 99.99; },
    (data: QualityAnalysis) => { data.production_context!.machine_models.items[0].key = '1'; },
    (data: QualityAnalysis) => { data.production_context!.machine_models.items.reverse(); },
    (data: QualityAnalysis) => { data.production_context!.machine_models.top_n = 5; },
  ]) {
    const data = withProductionEvidence(); change(data);
    assert.equal(parseQualityAnalysis(data, scope).production_context, undefined);
  }
});

test('unavailable production links retain recorded model groups without claiming candidate matches', () => {
  const data = withProductionEvidence(); const context = data.production_context!;
  context.status = 'unavailable';
  Object.assign(context.summary, { production_record_match_count: 0, plan_match_count: 0, recorded_only_count: 3 });
  for (const group of [context.model_parts, context.machine_models]) for (const row of group.items) {
    Object.assign(row.match_basis_counts, { production_record: 0, stored_plan: 0, recorded_only: row.report_count });
  }
  assert.equal(parseQualityAnalysis(data, scope).production_context?.status, 'unavailable');
  context.summary.production_record_match_count = 1; context.summary.recorded_only_count = 2;
  assert.equal(parseQualityAnalysis(data, scope).production_context, undefined);
});

test('a missing or broken extension is isolated and needs no invented fallback data', () => {
  const original = fixture(); const old = parseQualityAnalysis(original, scope);
  assert.equal(old.production_context, undefined); assert.equal(old.report, undefined);
  assert.deepEqual(old.warnings, original.warnings);
  const source = withProductionEvidence();
  Object.assign(source, { production_context: null, report: { operations: null } });
  const data = parseQualityAnalysis(source, scope);
  assert.equal(data.summary.reported_defect_qty, 4);
  assert.ok(['production_context_invalid', 'report_invalid'].every(warning => data.warnings.includes(warning)));
});
