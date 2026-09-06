import { getQualityTrendOmittedDates } from './trend.ts';

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
export interface QualityActivityDay {
  date: string; status: 'no_change' | 'activity' | 'unknown'; reason: string;
  can_collapse: boolean; observed_machine_count: number;
}
export interface QualityActivityCalendar {
  schema_version: 'quality-activity.v1'; status: 'ready' | 'not_applicable' | 'unavailable';
  source: 'InjectionMonitoringRecord'; timezone: 'Asia/Shanghai'; date_basis: 'calendar_day';
  policy: 'continuous_constant_capacity_v1'; max_gap_minutes: 10;
  expected_machine_count: number; days: QualityActivityDay[];
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
export interface QualityProductionShiftCounts {
  report_count: number | null; active_shift_count: number; no_change_shift_count: number;
  unknown_shift_count: number; open_shift_count: number; reports_per_shift: number | null;
}
export interface QualityProductionShiftDay extends QualityProductionShiftCounts { date: string; reason: string }
export interface QualityProductionShifts {
  schema_version: 'quality-shifts.v1'; status: 'ready' | 'not_applicable' | 'unavailable';
  timezone: 'Asia/Shanghai'; date_basis: 'production_business_day';
  source: 'InjectionMonitoringRecord'; report_source: 'QualityReport:LQC_INJ';
  source_status: { reports: 'ready' | 'unavailable'; monitoring: 'ready' | 'unavailable' };
  policy: 'observed_machine_shift_v1'; max_gap_minutes: 10; expected_machine_count: number;
  days: QualityProductionShiftDay[]; summary: QualityProductionShiftCounts; limitations: string[];
}
export interface QualityAnalysis {
  schema_version: 'quality-analysis.v1';
  status: 'ok' | 'partial' | 'no_records';
  filters: { start_date: string; end_date: string; section: string | null; machine_number: string | number | null; timezone: string; date_basis: string };
  summary: QualityQuantities & { inspection_quantity_record_count: number; recorded_inspection_qty: number | null; zero_defect_report_count: number; latest_report_at: string | null };
  trend: Array<QualityQuantities & { date: string }>;
  activity_calendar?: QualityActivityCalendar;
  production_context?: QualityProductionContext;
  production_shifts?: QualityProductionShifts;
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
export function quantityCoverage(summary: QualityQuantities) { return summary.report_count > 0 ? summary.defect_quantity_record_count / summary.report_count * 100 : null; }

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
function validateActivityCalendar(value: unknown, trend: QualityAnalysis['trend'], expected: QualityScope) {
  const calendar = object(value);
  const expectedMachines = expected.machineNumber === 'unknown' ? 0 : expected.machineNumber ? 1 : 17;
  const supported = (!expected.section || expected.section === 'LQC_INJ') && expected.machineNumber !== 'unknown';
  if (calendar.schema_version !== 'quality-activity.v1' || !['ready', 'not_applicable', 'unavailable'].includes(String(calendar.status))
    || calendar.source !== 'InjectionMonitoringRecord' || calendar.timezone !== 'Asia/Shanghai' || calendar.date_basis !== 'calendar_day'
    || calendar.policy !== 'continuous_constant_capacity_v1' || calendar.max_gap_minutes !== 10
    || calendar.expected_machine_count !== expectedMachines || (supported && calendar.status === 'not_applicable')
    || (!supported && calendar.status !== 'not_applicable')) throw new Error('invalid_quality_activity_calendar');
  const days = array(calendar.days);
  if (days.length !== trend.length) throw new Error('incomplete_quality_activity_calendar');
  days.forEach((value, index) => {
    const day = object(value); const reportDay = trend[index];
    text(day.reason); integer(day.observed_machine_count);
    if (day.date !== reportDay.date || !day.reason || !['no_change', 'activity', 'unknown'].includes(String(day.status))
      || typeof day.can_collapse !== 'boolean' || day.observed_machine_count > expectedMachines
      || (calendar.status !== 'ready' && (day.status !== 'unknown' || day.can_collapse || day.observed_machine_count !== 0))
      || (day.status === 'no_change' && (calendar.status !== 'ready' || day.observed_machine_count !== expectedMachines))
      || (day.status === 'activity' && day.observed_machine_count === 0)
      || (day.can_collapse && (calendar.status !== 'ready' || day.status !== 'no_change' || expectedMachines === 0
        || day.observed_machine_count !== expectedMachines || reportDay.report_count !== 0 || reportDay.reported_defect_qty !== null))) throw new Error('invalid_quality_activity_day');
  });
  return calendar as unknown as QualityActivityCalendar;
}
const PRODUCTION_MATCH_FIELDS = {
  production_record: 'production_record_match_count', stored_plan: 'plan_match_count', recorded_only: 'recorded_only_count',
  ambiguous: 'ambiguous_count', unmatched: 'unmatched_count', not_injection: 'not_injection_count',
} as const;
const SHIFT_COUNT_FIELDS = ['active_shift_count', 'no_change_shift_count', 'unknown_shift_count', 'open_shift_count'] as const;

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

function validateProductionShifts(value: unknown, trend: QualityAnalysis['trend'], expected: QualityScope) {
  const shifts = object(value); const sourceStatus = object(shifts.source_status);
  const expectedMachines = expected.machineNumber === 'unknown' ? 0 : expected.machineNumber ? 1 : 17;
  const supported = (!expected.section || expected.section === 'LQC_INJ') && expected.machineNumber !== 'unknown';
  for (const key of ['reports', 'monitoring']) if (!['ready', 'unavailable'].includes(String(sourceStatus[key]))) throw new Error('invalid_quality_shift_source');
  if (shifts.schema_version !== 'quality-shifts.v1' || !['ready', 'not_applicable', 'unavailable'].includes(String(shifts.status))
    || shifts.timezone !== 'Asia/Shanghai' || shifts.date_basis !== 'production_business_day'
    || shifts.source !== 'InjectionMonitoringRecord' || shifts.report_source !== 'QualityReport:LQC_INJ'
    || shifts.policy !== 'observed_machine_shift_v1' || shifts.max_gap_minutes !== 10 || shifts.expected_machine_count !== expectedMachines
    || (!supported && shifts.status !== 'not_applicable') || (supported && shifts.status === 'not_applicable')
    || (shifts.status === 'ready') !== (sourceStatus.reports === 'ready' && sourceStatus.monitoring === 'ready')
    || (shifts.status === 'not_applicable' && (sourceStatus.reports !== 'unavailable' || sourceStatus.monitoring !== 'unavailable'))) throw new Error('invalid_quality_production_shifts');
  function counts(value: unknown, totalShifts: number) {
    const row = object(value);
    if (row.report_count !== null) integer(row.report_count);
    for (const key of SHIFT_COUNT_FIELDS) integer(row[key]);
    if (SHIFT_COUNT_FIELDS.reduce((sum, key) => sum + Number(row[key]), 0) !== totalShifts
      || (sourceStatus.reports === 'ready') !== (row.report_count !== null)
      || (sourceStatus.monitoring !== 'ready' && (row.active_shift_count !== 0 || row.no_change_shift_count !== 0))) throw new Error('invalid_quality_shift_balance');
    const canCalculate = shifts.status === 'ready' && row.report_count !== null && row.unknown_shift_count === 0 && row.open_shift_count === 0 && Number(row.active_shift_count) > 0;
    if (!canCalculate) {
      if (row.reports_per_shift !== null) throw new Error('unverified_quality_shift_rate');
    } else {
      const ratio = Number(row.report_count) / Number(row.active_shift_count);
      if (typeof row.reports_per_shift !== 'number' || !Number.isFinite(row.reports_per_shift) || row.reports_per_shift < 0
        || Math.abs(row.reports_per_shift - ratio) > 0.00005000001
        || Math.abs(row.reports_per_shift * 10000 - Math.round(row.reports_per_shift * 10000)) > 0.000001) throw new Error('invalid_quality_shift_rate');
    }
    return row as unknown as QualityProductionShiftCounts;
  }
  const days = array(shifts.days);
  if (days.length !== trend.length) throw new Error('incomplete_quality_shift_dates');
  const parsedDays = days.map((value, index) => {
    const day = object(value); text(day.reason);
    if (day.date !== trend[index].date || !day.reason) throw new Error('invalid_quality_shift_date');
    return counts(day, expectedMachines * 2);
  });
  const summary = counts(shifts.summary, expectedMachines * 2 * trend.length);
  for (const key of SHIFT_COUNT_FIELDS) if (parsedDays.reduce((sum, row) => sum + row[key], 0) !== summary[key]) throw new Error('quality_shift_totals_do_not_reconcile');
  const expectedReports = parsedDays.some(row => row.report_count === null) ? null : parsedDays.reduce((sum, row) => sum + (row.report_count ?? 0), 0);
  if (summary.report_count !== expectedReports) throw new Error('quality_shift_reports_do_not_reconcile');
  array(shifts.limitations).forEach(text);
  return shifts as unknown as QualityProductionShifts;
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
    activity_calendar: () => validateActivityCalendar(data.activity_calendar, trend, expected),
    production_context: () => validateProductionContext(data.production_context, summary),
    production_shifts: () => validateProductionShifts(data.production_shifts, trend, expected),
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

export function qualityCsvCell(value: string | number | null | undefined) {
  const original = value == null ? '' : String(value);
  const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(original) ? `'${original}` : original;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function createQualityAnalysisCsv(data: QualityAnalysis, language: QualityLanguage, options: { collapseInactiveDays?: boolean } = {}) {
  const types = data.type_pareto_summary;
  const collapsedDates = new Set(getQualityTrendOmittedDates(data.trend, data.activity_calendar, options.collapseInactiveDays ?? false));
  const activityDays = new Map(data.activity_calendar?.days.map(day => [day.date, day]) ?? []);
  const activityInvalid = data.warnings.includes('activity_calendar_invalid');
  const context = data.production_context;
  const shifts = data.production_shifts;
  const rows: Array<Array<string | number | null>> = [
    ['source', 'QualityReport / /api/quality/analysis/'], ['start_date', data.filters.start_date], ['end_date_inclusive', data.filters.end_date],
    ['date_basis', 'report_dt / Asia/Shanghai / 00:00 to next day 00:00'], ['section', data.filters.section || 'all'], ['machine_number', data.filters.machine_number ?? 'all'],
    ['generated_at', data.freshness.generated_at], ['latest_updated_at', data.freshness.latest_updated_at],
    ['trend_collapse_inactive_days_requested', String(options.collapseInactiveDays ?? false)],
    ['trend_display_mode', collapsedDates.size ? 'confirmed_no_change_dates_collapsed' : 'calendar'],
    ['trend_displayed_date_count', data.trend.length - collapsedDates.size], ['trend_collapsed_date_count', collapsedDates.size],
    ['trend_raw_daily_rows_retained', 'true'], ['trend_activity_status', data.activity_calendar?.status ?? (activityInvalid ? 'invalid' : 'not_provided')],
    ['trend_activity_warning', activityInvalid ? 'activity_calendar_invalid' : 'none'],
    ['trend_activity_source', data.activity_calendar?.source ?? 'not_provided'],
    ['trend_activity_policy', data.activity_calendar?.policy ?? 'not_provided'],
    ['trend_activity_expected_machine_count', data.activity_calendar?.expected_machine_count ?? null],
    ['trend_activity_max_gap_minutes', data.activity_calendar?.max_gap_minutes ?? null],
    ['trend_activity_basis', 'Injection capacity logs only; no_change is not a confirmed holiday or proof of no quality incidents. All raw daily rows are retained.'],
    ['production_context_status', context?.status ?? (data.warnings.includes('production_context_invalid') ? 'invalid' : 'not_provided')],
    ['production_context_policy', context?.policy ?? 'not_provided'],
    ['production_context_basis', 'Model labels come from the recorded model and item name. Production-record or stored-plan links are dated candidates, not confirmed incident causation. Group shares use all selected calendar-day reports.'],
    ['production_context_missing_model_basis', 'missing_model_count counts blank QualityReport.model, even when an item name is present.'],
    ['production_shifts_status', shifts?.status ?? (data.warnings.includes('production_shifts_invalid') ? 'invalid' : 'not_provided')],
    ['production_shifts_policy', shifts?.policy ?? 'not_provided'],
    ['production_shifts_monitoring_source', shifts?.source ?? 'not_provided'],
    ['production_shifts_report_source', shifts?.report_source ?? 'not_provided'],
    ['production_shifts_reports_source_status', shifts?.source_status.reports ?? 'not_provided'],
    ['production_shifts_monitoring_source_status', shifts?.source_status.monitoring ?? 'not_provided'],
    ['production_shifts_expected_machine_count', shifts?.expected_machine_count ?? null],
    ['production_shifts_max_gap_minutes', shifts?.max_gap_minutes ?? null],
    ['production_shifts_date_basis', 'LQC_INJ report_dt and injection logs / Asia/Shanghai / 08:00 to next day 08:00; differs from the core calendar-day report window.'],
    ['production_shifts_ratio_basis', 'Reports per observed active machine-shift, not a defect rate or percentage. A machine-shift is 08:00-20:00 or 20:00-next 08:00. Imported 08:00 report timestamps do not establish the incident shift. Unknown or open shifts withhold the ratio.'],
    ['quantity_basis', 'Recorded defect quantity only; null means no known quantity. Type rows have no attributed quantity. Counts are reports, not defective pieces.'],
    ['share_denominator_reports', data.summary.report_count], ['share_denominator_type_occurrences', types.type_occurrence_count],
    ['type_pareto_counting_policy', types.counting_policy], ['type_pareto_quantity_policy', types.quantity_policy],
    ['classified_report_count', types.classified_report_count], ['excluded_report_count', types.excluded_report_count],
    ['unclassified_report_count', types.unclassified_report_count], ['missing_phenomenon_report_count', types.missing_phenomenon_report_count],
    ['multi_type_report_count', types.multi_type_report_count],
    ['share_basis', 'Concentrations use all selected reports; type Pareto uses unique report-type occurrences. A multi-type report appears once per matched type; type counts are not distinct report totals.'],
    ['duplicate_policy', 'Potential duplicates retained; no automatic exclusion.'],
    ['inspection_quantity_record_count', data.summary.inspection_quantity_record_count], ['recorded_inspection_qty_not_unique_units', data.summary.recorded_inspection_qty],
    ['rate_policy', 'No overall defect rate; inspection and defect denominator alignment is not established.'], [],
    ['group', 'key', 'label', 'report_count', 'defect_quantity_record_count', 'reported_defect_qty', 'share_of_reports_percent', 'share_of_type_occurrences_percent', 'cumulative_type_share_percent', 'share_denominator', 'sample_report_ids', 'activity_status', 'activity_reason', 'observed_machine_count', 'can_collapse', 'displayed_in_trend',
      'model_display', 'part_no', 'machine_number', ...Object.keys(PRODUCTION_MATCH_FIELDS), ...SHIFT_COUNT_FIELDS, 'reports_per_shift', 'shift_reason', 'row_date_basis'],
    ['summary', '', '', data.summary.report_count, data.summary.defect_quantity_record_count, data.summary.reported_defect_qty, null, null, null, null, ''],
  ];
  for (const row of data.trend) {
    const activity = activityDays.get(row.date);
    rows.push(['daily', row.date, '', row.report_count, row.defect_quantity_record_count, row.reported_defect_qty, null, null, null, null, '',
      activity?.status ?? 'unknown', activity?.reason ?? (activityInvalid ? 'activity_calendar_invalid' : 'activity_calendar_not_provided'), activity?.observed_machine_count ?? null,
      String(activity?.can_collapse ?? false), String(!collapsedDates.has(row.date))]);
  }
  for (const row of data.type_pareto) rows.push(['type_pareto', row.key, qualityLabel(row.label, language), row.report_count, null, null, null, row.share_of_type_occurrences_percent, row.cumulative_type_share_percent, types.type_occurrence_count, row.sample_report_ids.join('|')]);
  for (const row of data.type_pareto_exclusions) rows.push(['type_pareto_exclusion', row.key, qualityLabel(row.label, language), row.report_count, null, null, null, null, null, null, row.sample_report_ids.join('|')]);
  for (const name of ['machines', 'parts', 'sections'] as const) {
    const concentration = data.concentrations[name];
    for (const row of concentration.items) rows.push([name, row.key, qualityLabel(row.label, language), row.report_count, row.defect_quantity_record_count, row.reported_defect_qty, row.share_of_reports_percent, null, null, data.summary.report_count, row.sample_report_ids.join('|')]);
    if (concentration.other_report_count) rows.push([`${name}_other_groups`, '', `Groups beyond top ${concentration.top_n}`, concentration.other_report_count, null, null, null, null, null, null, '']);
  }
  if (context) {
    for (const [key, value] of Object.entries(context.summary)) rows.push(['production_context_summary', key, '', value]);
    for (const name of ['model_parts', 'machine_models'] as const) {
      const concentration = context[name];
      for (const row of concentration.items) rows.push([
        `production_${name}`, row.key, qualityLabel(row.label, language), row.report_count, row.defect_quantity_record_count, row.reported_defect_qty,
        row.share_of_reports_percent, null, null, data.summary.report_count, row.sample_report_ids.join('|'), null, null, null, null, null,
        row.model_display, row.part_no, row.machine_number, ...Object.keys(PRODUCTION_MATCH_FIELDS).map(key => row.match_basis_counts[key as keyof QualityProductionMatchCounts]),
        null, null, null, null, null, null, 'report_dt_calendar_day',
      ]);
      if (concentration.other_report_count) rows.push([`production_${name}_other_groups`, '', `Groups beyond top ${concentration.top_n}`, concentration.other_report_count]);
    }
    for (const limitation of context.limitations) rows.push(['production_context_limitation', limitation]);
  }
  if (shifts) {
    const addShiftRow = (kind: string, key: string, row: QualityProductionShiftCounts, reason: string) => rows.push([
      kind, key, '', row.report_count, null, null, null, null, null, null, '', null, null, null, null, null,
      null, null, null, null, null, null, null, null, null,
      ...SHIFT_COUNT_FIELDS.map(field => row[field]), row.reports_per_shift, reason, 'production_business_day',
    ]);
    addShiftRow('production_shifts_summary', '', shifts.summary, shifts.status);
    for (const day of shifts.days) addShiftRow('production_shifts_daily', day.date, day, day.reason);
    for (const limitation of shifts.limitations) rows.push(['production_shifts_limitation', limitation]);
  }
  for (const [key, value] of Object.entries(data.data_quality)) rows.push(['data_quality', key, '', value]);
  for (const limitation of data.limitations) rows.push(['limitation', limitation]);
  return `\uFEFF${rows.map(row => row.map(qualityCsvCell).join(',')).join('\r\n')}\r\n`;
}
