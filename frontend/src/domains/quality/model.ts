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
export interface QualityConcentration { items: QualityGroup[]; total_group_count: number; top_n: number; other_report_count: number }
export interface QualityAnalysis {
  schema_version: 'quality-analysis.v1';
  status: 'ok' | 'partial' | 'no_records';
  filters: { start_date: string; end_date: string; section: string | null; machine_number: string | number | null; timezone: string; date_basis: string };
  summary: QualityQuantities & { inspection_quantity_record_count: number; recorded_inspection_qty: number | null; zero_defect_report_count: number; latest_report_at: string | null };
  trend: Array<QualityQuantities & { date: string }>;
  pareto: QualityPareto[];
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
function checkShare(value: unknown, expected: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || Math.abs(value - expected) > 0.11) throw new Error('invalid_quality_share');
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
  return data as unknown as QualityAnalysis;
}

export function qualityCsvCell(value: string | number | null | undefined) {
  const original = value == null ? '' : String(value);
  const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(original) ? `'${original}` : original;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function createQualityAnalysisCsv(data: QualityAnalysis, language: QualityLanguage) {
  const rows: Array<Array<string | number | null>> = [
    ['source', 'QualityReport / /api/quality/analysis/'], ['start_date', data.filters.start_date], ['end_date_inclusive', data.filters.end_date],
    ['date_basis', 'report_dt / Asia/Shanghai / 00:00 to next day 00:00'], ['section', data.filters.section || 'all'], ['machine_number', data.filters.machine_number ?? 'all'],
    ['generated_at', data.freshness.generated_at], ['latest_updated_at', data.freshness.latest_updated_at],
    ['quantity_basis', 'Recorded defect quantity only; null means no known quantity. Counts are reports, not defective pieces.'],
    ['share_denominator_reports', data.summary.report_count], ['duplicate_policy', 'Potential duplicates retained; no automatic exclusion.'],
    ['inspection_quantity_record_count', data.summary.inspection_quantity_record_count], ['recorded_inspection_qty_not_unique_units', data.summary.recorded_inspection_qty],
    ['rate_policy', 'No overall defect rate; inspection and defect denominator alignment is not established.'], [],
    ['group', 'key', 'label', 'report_count', 'defect_quantity_record_count', 'reported_defect_qty', 'share_of_reports_percent', 'cumulative_report_share_percent', 'sample_report_ids'],
    ['summary', '', '', data.summary.report_count, data.summary.defect_quantity_record_count, data.summary.reported_defect_qty, null, null, ''],
  ];
  for (const row of data.trend) rows.push(['daily', row.date, '', row.report_count, row.defect_quantity_record_count, row.reported_defect_qty, null, null, '']);
  for (const row of data.pareto) rows.push(['pareto', row.key, qualityLabel(row.label, language), row.report_count, row.defect_quantity_record_count, row.reported_defect_qty, row.share_of_reports_percent, row.cumulative_report_share_percent, row.sample_report_ids.join('|')]);
  for (const name of ['machines', 'parts', 'sections'] as const) {
    const concentration = data.concentrations[name];
    for (const row of concentration.items) rows.push([name, row.key, qualityLabel(row.label, language), row.report_count, row.defect_quantity_record_count, row.reported_defect_qty, row.share_of_reports_percent, null, row.sample_report_ids.join('|')]);
    if (concentration.other_report_count) rows.push([`${name}_other_groups`, '', `Groups beyond top ${concentration.top_n}`, concentration.other_report_count, null, null, null, null, '']);
  }
  for (const [key, value] of Object.entries(data.data_quality)) rows.push(['data_quality', key, '', value]);
  for (const limitation of data.limitations) rows.push(['limitation', limitation]);
  return `\uFEFF${rows.map(row => row.map(qualityCsvCell).join(',')).join('\r\n')}\r\n`;
}
