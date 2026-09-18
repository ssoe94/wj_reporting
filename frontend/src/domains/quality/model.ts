import { parseQualityReport } from './report.ts';
import type { QualityReport } from './report.ts';

export type QualityLanguage = 'ko' | 'zh';
export type LocalizedLabel = { ko: string; zh: string };
export type QualityScope = { startDate: string; endDate: string; section: string; machineNumber: string };
export const QUALITY_SECTIONS = ['LQC_INJ', 'LQC_ASM', 'IQC', 'OQC', 'CS'] as const;
export const SECTION_LABELS: Record<string, LocalizedLabel> = {
  LQC_INJ: { ko: '사출 공정검사', zh: '注塑过程检验' }, LQC_ASM: { ko: '가공·조립 공정검사', zh: '加工·组装过程检验' },
  IQC: { ko: '수입검사', zh: '来料检验' }, OQC: { ko: '출하검사', zh: '出货检验' }, CS: { ko: '고객 품질', zh: '客户品质' },
};
export interface QualityQuantities { report_count: number; defect_quantity_record_count: number; reported_defect_qty: number | null }
export interface QualityGroup extends QualityQuantities { key: string; label: string | LocalizedLabel; share_of_reports_percent: number; sample_report_ids: number[] }
export interface QualityPareto extends QualityGroup { cumulative_report_share_percent: number }
export interface QualityTypeEvidence { key: string; label: string | LocalizedLabel; report_count: number; sample_report_ids: number[] }
export interface QualityTypePareto extends QualityTypeEvidence { share_of_type_occurrences_percent: number; cumulative_type_share_percent: number }
export interface QualityTypeExclusion extends QualityTypeEvidence { key: 'unclassified' | 'missing' }
export interface QualityTypeParetoSummary {
  classified_report_count: number; excluded_report_count: number; unclassified_report_count: number;
  missing_phenomenon_report_count: number; multi_type_report_count: number; type_occurrence_count: number;
  counting_policy: 'unique_report_type'; quantity_policy: 'not_attributed';
}
export interface QualityConcentration { items: QualityGroup[]; total_group_count: number; top_n: number; other_report_count: number }
export interface QualityProductionMatchCounts {
  production_record: number; stored_plan: number; recorded_only: number;
  ambiguous: number; unmatched: number; not_injection: number;
}
export interface QualityProductionGroup extends QualityGroup {
  model_display: string; part_no: string; machine_number: number | null;
  match_basis_counts: QualityProductionMatchCounts;
}
export interface QualityProductionConcentration extends Omit<QualityConcentration, 'items'> { items: QualityProductionGroup[] }
export interface QualityProductionContext {
  schema_version: 'quality-production-context.v1'; status: 'ready' | 'unavailable';
  policy: 'unique_dated_part_model_candidate_v1';
  summary: {
    report_count: number; production_record_match_count: number; plan_match_count: number;
    recorded_only_count: number; ambiguous_count: number; unmatched_count: number;
    not_injection_count: number; missing_model_count: number;
  };
  model_parts: QualityProductionConcentration; machine_models: QualityProductionConcentration;
  limitations: string[];
}
export interface QualityAnalysis {
  schema_version: 'quality-analysis.v1';
  status: 'ok' | 'partial' | 'no_records';
  filters: { start_date: string; end_date: string; section: string | null; machine_number: string | number | null; timezone: string; date_basis: string };
  summary: QualityQuantities & { inspection_quantity_record_count: number; recorded_inspection_qty: number | null; zero_defect_report_count: number; latest_report_at: string | null };
  trend: Array<QualityQuantities & { date: string }>;
  production_context?: QualityProductionContext;
  report?: QualityReport;
  pareto: QualityPareto[];
  type_pareto: QualityTypePareto[];
  type_pareto_summary: QualityTypeParetoSummary;
  type_pareto_exclusions: QualityTypeExclusion[];
  concentrations: { machines: QualityConcentration; parts: QualityConcentration; sections: QualityConcentration };
  data_quality: {
    missing_defect_qty_count: number; missing_inspection_qty_count: number; invalid_quantity_count: number;
    paired_quantity_record_count: number; inconsistent_quantity_count: number; missing_part_count: number;
    missing_phenomenon_count: number; unclassified_type_count: number; multi_type_count: number; unassigned_machine_count: number;
    duplicate_candidate_group_count: number; duplicate_candidate_report_count: number;
  };
  options: { sections: Array<{ value: string; label: LocalizedLabel }>; machines: Array<{ value: string | number; label: string | LocalizedLabel; report_count: number }> };
  freshness: { generated_at: string; latest_report_at: string | null; latest_updated_at: string | null };
  warnings: string[]; limitations: string[]; calculation_basis: string[];
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function defaultQualityScope(today: string): QualityScope {
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return { startDate: start.toISOString().slice(0, 10), endDate: today, section: '', machineNumber: '' };
}
export function validateQualityScope(scope: QualityScope) {
  if (!validDate(scope.startDate) || !validDate(scope.endDate) || scope.startDate > scope.endDate
    || (Date.parse(scope.endDate) - Date.parse(scope.startDate)) / 86400000 > 365) throw new Error('invalid_quality_period');
  if (scope.section && !QUALITY_SECTIONS.includes(scope.section as typeof QUALITY_SECTIONS[number])) throw new Error('invalid_quality_section');
  if (scope.machineNumber && !/^(?:[1-9]|1[0-7]|unknown)$/.test(scope.machineNumber)) throw new Error('invalid_quality_machine');
  return scope;
}
export function resolveQualityScope(search: string, today: string): QualityScope {
  const params = new URLSearchParams(search);
  if (['start_date', 'end_date', 'section', 'machine_number'].some(key => params.getAll(key).length > 1)) throw new Error('duplicate_quality_filter');
  const endDate = params.get('end_date') ?? today;
  if (!validDate(endDate)) throw new Error('invalid_quality_period');
  const fallback = defaultQualityScope(endDate);
  return validateQualityScope({ startDate: params.get('start_date') ?? fallback.startDate, endDate,
    section: params.get('section') ?? '', machineNumber: params.get('machine_number') ?? '' });
}
export function qualityScopeParams(scope: QualityScope) {
  validateQualityScope(scope);
  const params = new URLSearchParams({ start_date: scope.startDate, end_date: scope.endDate });
  if (scope.section) params.set('section', scope.section);
  if (scope.machineNumber) params.set('machine_number', scope.machineNumber);
  return params;
}
export function qualityLabel(value: string | LocalizedLabel, language: QualityLanguage) { return typeof value === 'string' ? value : value[language]; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_quality_analysis');
  return value as Record<string, unknown>;
}
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid_quality_quantity'); }
function text(value: unknown): asserts value is string { if (typeof value !== 'string') throw new Error('invalid_quality_text'); }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('invalid_quality_collection'); return value; }
function timestamp(value: unknown, nullable = true) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid_quality_timestamp');
}
function label(value: unknown) { if (typeof value === 'string') return; const labels = object(value); text(labels.ko); text(labels.zh); }
function quantities(value: unknown) {
  const row = object(value); integer(row.report_count); integer(row.defect_quantity_record_count);
  if (row.defect_quantity_record_count > row.report_count) throw new Error('invalid_quality_coverage');
  if (row.defect_quantity_record_count === 0) { if (row.reported_defect_qty !== null) throw new Error('missing_quality_quantity_is_not_zero'); }
  else integer(row.reported_defect_qty);
  return row as unknown as QualityQuantities;
}
function checkShare(value: unknown, expected: number, tolerance = 0.11) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || Math.abs(value - expected) > tolerance) throw new Error('invalid_quality_share');
}
function group(value: unknown, total: number) {
  const row = object(value); const qty = quantities(row); text(row.key); label(row.label);
  if (qty.report_count > total) throw new Error('invalid_quality_group');
  checkShare(row.share_of_reports_percent, total ? qty.report_count / total * 100 : 0);
  const ids = array(row.sample_report_ids); ids.forEach(id => { integer(id); if (id === 0) throw new Error('invalid_quality_report_id'); });
  if (ids.length > 5 || ids.length > qty.report_count || new Set(ids).size !== ids.length) throw new Error('invalid_quality_samples');
  return row as unknown as QualityGroup;
}
function reconcile(rows: QualityQuantities[], summary: QualityQuantities) {
  if (rows.reduce((sum, row) => sum + row.report_count, 0) !== summary.report_count
    || rows.reduce((sum, row) => sum + row.defect_quantity_record_count, 0) !== summary.defect_quantity_record_count
    || rows.reduce((sum, row) => sum + (row.reported_defect_qty ?? 0), 0) !== (summary.reported_defect_qty ?? 0)) throw new Error('quality_totals_do_not_reconcile');
}
function typeEvidence(value: unknown, maximumReports: number) {
  const row = object(value); text(row.key); label(row.label); integer(row.report_count);
  if (!row.key || row.report_count === 0 || row.report_count > maximumReports
    || row.reported_defect_qty !== undefined || row.defect_quantity_record_count !== undefined) throw new Error('invalid_quality_type_evidence');
  const ids = array(row.sample_report_ids);
  ids.forEach(id => { integer(id); if (id === 0) throw new Error('invalid_quality_report_id'); });
  if (ids.length > 5 || ids.length > row.report_count || new Set(ids).size !== ids.length) throw new Error('invalid_quality_samples');
  return row as unknown as QualityTypeEvidence;
}
function checkTypeShare(value: unknown, numerator: number, denominator: number) {
  // Accept Python's half-even rounding at exact ties without accepting extra precision.
  checkShare(value, denominator ? numerator / denominator * 100 : 0, 0.00500001);
  if (typeof value !== 'number' || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw new Error('invalid_quality_share');
}
function validateTypePareto(data: Record<string, unknown>, reportCount: number) {
  const raw = object(data.type_pareto_summary);
  for (const key of ['classified_report_count', 'excluded_report_count', 'unclassified_report_count', 'missing_phenomenon_report_count', 'multi_type_report_count', 'type_occurrence_count']) integer(raw[key]);
  const summary = raw as unknown as QualityTypeParetoSummary;
  if (summary.counting_policy !== 'unique_report_type' || summary.quantity_policy !== 'not_attributed'
    || summary.classified_report_count + summary.excluded_report_count !== reportCount
    || summary.unclassified_report_count + summary.missing_phenomenon_report_count !== summary.excluded_report_count
    || summary.multi_type_report_count > summary.classified_report_count
    || summary.type_occurrence_count < summary.classified_report_count + summary.multi_type_report_count
    || (summary.multi_type_report_count === 0 && summary.type_occurrence_count !== summary.classified_report_count)) throw new Error('invalid_quality_type_denominator');
  let cumulative = 0;
  const idsByType = new Map<number, number>();
  const rows = array(data.type_pareto).map(value => {
    const row = typeEvidence(value, summary.classified_report_count) as QualityTypePareto;
    if (['missing', 'unclassified', 'unknown', 'multiple'].includes(row.key)) throw new Error('excluded_quality_type_in_pareto');
    cumulative += row.report_count;
    checkTypeShare(row.share_of_type_occurrences_percent, row.report_count, summary.type_occurrence_count);
    checkTypeShare(row.cumulative_type_share_percent, cumulative, summary.type_occurrence_count);
    row.sample_report_ids.forEach(id => idsByType.set(id, (idsByType.get(id) ?? 0) + 1));
    return row;
  });
  if (new Set(rows.map(row => row.key)).size !== rows.length
    || rows.some((row, index) => index > 0 && (rows[index - 1].report_count < row.report_count
      || (rows[index - 1].report_count === row.report_count && rows[index - 1].key > row.key)))) throw new Error('invalid_quality_type_pareto_order');
  if (cumulative !== summary.type_occurrence_count || (rows.length === 0) !== (summary.classified_report_count === 0)
    || summary.type_occurrence_count > summary.classified_report_count + summary.multi_type_report_count * (rows.length - 1)
    || idsByType.size > summary.classified_report_count
    || [...idsByType.values()].filter(count => count > 1).length > summary.multi_type_report_count) throw new Error('quality_type_totals_do_not_reconcile');
  const excludedIds = new Set<number>();
  const exclusions = array(data.type_pareto_exclusions).map(value => {
    const row = typeEvidence(value, summary.excluded_report_count) as QualityTypeExclusion;
    if (!['missing', 'unclassified'].includes(row.key)
      || row.report_count !== (row.key === 'missing' ? summary.missing_phenomenon_report_count : summary.unclassified_report_count)) throw new Error('invalid_quality_type_exclusion');
    for (const id of row.sample_report_ids) {
      if (idsByType.has(id) || excludedIds.has(id)) throw new Error('overlapping_quality_type_exclusions');
      excludedIds.add(id);
    }
    return row;
  });
  if (new Set(exclusions.map(row => row.key)).size !== exclusions.length
    || exclusions.some((row, index) => index > 0 && exclusions[index - 1].key > row.key)
    || exclusions.reduce((sum, row) => sum + row.report_count, 0) !== summary.excluded_report_count) throw new Error('quality_type_exclusions_do_not_reconcile');
}
const PRODUCTION_MATCH_FIELDS = {
  production_record: 'production_record_match_count', stored_plan: 'plan_match_count', recorded_only: 'recorded_only_count',
  ambiguous: 'ambiguous_count', unmatched: 'unmatched_count', not_injection: 'not_injection_count',
} as const;

function validateProductionContext(value: unknown, core: QualityQuantities) {
  const context = object(value); const summary = object(context.summary);
  if (context.schema_version !== 'quality-production-context.v1' || !['ready', 'unavailable'].includes(String(context.status))
    || context.policy !== 'unique_dated_part_model_candidate_v1') throw new Error('invalid_quality_production_context');
  for (const key of ['report_count', 'missing_model_count', ...Object.values(PRODUCTION_MATCH_FIELDS)]) {
    integer(summary[key]);
    if (Number(summary[key]) > core.report_count) throw new Error('invalid_quality_production_count');
  }
  if (summary.report_count !== core.report_count
    || Object.values(PRODUCTION_MATCH_FIELDS).reduce((sum, key) => sum + Number(summary[key]), 0) !== core.report_count
    || (context.status === 'unavailable' && (summary.production_record_match_count !== 0 || summary.plan_match_count !== 0 || summary.ambiguous_count !== 0))) throw new Error('invalid_quality_production_partition');
  for (const name of ['model_parts', 'machine_models'] as const) {
    const concentration = object(context[name]);
    integer(concentration.total_group_count); integer(concentration.other_report_count);
    const rows = array(concentration.items).map(value => {
      const row = group(value, core.report_count) as QualityProductionGroup;
      text(row.model_display); text(row.part_no);
      if (!row.key || row.report_count === 0 || (row.machine_number !== null
        && (!Number.isSafeInteger(row.machine_number) || row.machine_number < 1 || row.machine_number > 17))
        || (name === 'model_parts' && row.machine_number !== null)) throw new Error('invalid_quality_production_group');
      checkTypeShare(row.share_of_reports_percent, row.report_count, core.report_count);
      const counts = object(row.match_basis_counts);
      for (const key of Object.keys(PRODUCTION_MATCH_FIELDS)) integer(counts[key]);
      if (Object.keys(PRODUCTION_MATCH_FIELDS).reduce((sum, key) => sum + Number(counts[key]), 0) !== row.report_count) throw new Error('invalid_quality_production_basis');
      return row;
    });
    if (concentration.top_n !== 20 || concentration.total_group_count > core.report_count
      || rows.length !== Math.min(20, concentration.total_group_count) || new Set(rows.map(row => row.key)).size !== rows.length
      || rows.some((row, index) => index > 0 && (rows[index - 1].report_count < row.report_count
        || (rows[index - 1].report_count === row.report_count && rows[index - 1].key > row.key)))
      || rows.reduce((sum, row) => sum + row.report_count, 0) + concentration.other_report_count !== core.report_count
      || (concentration.other_report_count === 0) !== (concentration.total_group_count === rows.length)) throw new Error('invalid_quality_production_concentration');
    const seenIds = new Set<number>();
    for (const row of rows) for (const id of row.sample_report_ids) {
      if (seenIds.has(id)) throw new Error('overlapping_quality_production_samples');
      seenIds.add(id);
    }
    for (const [basis, summaryField] of Object.entries(PRODUCTION_MATCH_FIELDS)) {
      const visible = rows.reduce((sum, row) => sum + row.match_basis_counts[basis as keyof QualityProductionMatchCounts], 0);
      if (visible > Number(summary[summaryField]) || (concentration.other_report_count === 0 && visible !== summary[summaryField])) throw new Error('quality_production_basis_does_not_reconcile');
    }
    const known = rows.reduce((sum, row) => sum + row.defect_quantity_record_count, 0);
    const quantity = rows.reduce((sum, row) => sum + (row.reported_defect_qty ?? 0), 0);
    if (known > core.defect_quantity_record_count || quantity > (core.reported_defect_qty ?? 0)) throw new Error('invalid_quality_production_quantity');
    if (concentration.other_report_count === 0) reconcile(rows, core);
  }
  array(context.limitations).forEach(text);
  return context as unknown as QualityProductionContext;
}

export function parseQualityAnalysis(value: unknown, expected: QualityScope): QualityAnalysis {
  const data = object(value); const filters = object(data.filters);
  if (data.schema_version !== 'quality-analysis.v1' || filters.start_date !== expected.startDate || filters.end_date !== expected.endDate
    || String(filters.section ?? '') !== expected.section || String(filters.machine_number ?? '') !== expected.machineNumber
    || filters.timezone !== 'Asia/Shanghai' || filters.date_basis !== 'report_dt_calendar_day') throw new Error('quality_analysis_scope_mismatch');
  text(filters.date_basis);
  const summary = quantities(data.summary); const rawSummary = object(data.summary);
  if (!['ok', 'partial', 'no_records'].includes(String(data.status)) || (data.status === 'no_records') !== (summary.report_count === 0)) throw new Error('invalid_quality_status');
  integer(rawSummary.inspection_quantity_record_count); integer(rawSummary.zero_defect_report_count);
  if (rawSummary.inspection_quantity_record_count > summary.report_count || rawSummary.zero_defect_report_count > summary.defect_quantity_record_count) throw new Error('invalid_quality_coverage');
  if (rawSummary.inspection_quantity_record_count === 0) { if (rawSummary.recorded_inspection_qty !== null) throw new Error('missing_inspection_is_not_zero'); }
  else integer(rawSummary.recorded_inspection_qty);
  timestamp(rawSummary.latest_report_at);
  const trend = array(data.trend).map(value => { const row = object(value); text(row.date); if (!validDate(row.date) || row.date < expected.startDate || row.date > expected.endDate) throw new Error('invalid_quality_trend_date'); quantities(row); return row as unknown as QualityAnalysis['trend'][number]; });
  if (new Set(trend.map(row => row.date)).size !== trend.length || trend.some((row, index) => index > 0 && trend[index - 1].date >= row.date)
    || trend.length !== (Date.parse(expected.endDate) - Date.parse(expected.startDate)) / 86400000 + 1) throw new Error('incomplete_quality_trend');
  reconcile(trend, summary);
  let cumulative = 0;
  const pareto = array(data.pareto).map(value => { const row = group(value, summary.report_count) as QualityPareto; cumulative += row.report_count; checkShare(row.cumulative_report_share_percent, summary.report_count ? cumulative / summary.report_count * 100 : 0); return row; });
  if (new Set(pareto.map(row => row.key)).size !== pareto.length || pareto.some((row, index) => index > 0 && pareto[index - 1].report_count < row.report_count)) throw new Error('invalid_quality_pareto_order');
  reconcile(pareto, summary);
  validateTypePareto(data, summary.report_count);
  const concentrations = object(data.concentrations);
  for (const name of ['machines', 'parts', 'sections']) {
    const concentration = object(concentrations[name]); integer(concentration.total_group_count); integer(concentration.top_n); integer(concentration.other_report_count);
    const rows = array(concentration.items).map(value => group(value, summary.report_count));
    if (rows.length > concentration.top_n || rows.length > concentration.total_group_count || new Set(rows.map(row => row.key)).size !== rows.length
      || rows.reduce((sum, row) => sum + row.report_count, 0) + concentration.other_report_count !== summary.report_count) throw new Error('invalid_quality_concentration');
  }
  const quality = object(data.data_quality);
  for (const name of ['missing_defect_qty_count', 'missing_inspection_qty_count', 'invalid_quantity_count', 'paired_quantity_record_count', 'inconsistent_quantity_count', 'missing_part_count', 'missing_phenomenon_count', 'unclassified_type_count', 'multi_type_count', 'unassigned_machine_count', 'duplicate_candidate_group_count', 'duplicate_candidate_report_count']) { integer(quality[name]); if (Number(quality[name]) > summary.report_count) throw new Error('invalid_quality_check_count'); }
  const freshness = object(data.freshness); timestamp(freshness.generated_at, false); timestamp(freshness.latest_report_at); timestamp(freshness.latest_updated_at);
  const options = object(data.options);
  array(options.sections).forEach(value => { const row = object(value); text(row.value); label(row.label); });
  array(options.machines).forEach(value => { const row = object(value); if (!/^(?:[1-9]|1[0-7]|unknown)$/.test(String(row.value))) throw new Error('invalid_quality_machine_option'); label(row.label); integer(row.report_count); });
  for (const key of ['warnings', 'limitations', 'calculation_basis']) array(data[key]).forEach(text);
  const result = { ...data, warnings: [...data.warnings as string[]] } as unknown as QualityAnalysis;
  const auxiliaryChecks = {
    production_context: () => validateProductionContext(data.production_context, summary),
    report: () => parseQualityReport(data.report, trend),
  };
  for (const [field, validate] of Object.entries(auxiliaryChecks)) {
    if (data[field] === undefined) continue;
    try {
      validate();
    } catch {
      // Isolate auxiliary failures; valid core reports and other evidence remain usable.
      Object.assign(result, { [field]: undefined });
      result.warnings = [...new Set([...result.warnings, `${field}_invalid`])];
    }
  }
  return result;
}
