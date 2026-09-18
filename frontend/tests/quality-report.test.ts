import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQualityHighlights, createQualityReportCsv, getReportTrendSeries, parseQualityReport, percentChange } from '../src/domains/quality/report.ts';
import type { QualityReport, QualityReportDay, QualityReportTotals } from '../src/domains/quality/report.ts';
import type { QualityAnalysis } from '../src/domains/quality/model.ts';

// Synthetic evidence only: no API, production dataset or database access.
const counts = [2, 0, 3, 1, 0, 0, 4, 2, 1, 5];
const idle = new Set([4, 5]);
const date = (index: number) => `2026-09-${String(index + 1).padStart(2, '0')}`;
const trend: QualityAnalysis['trend'] = counts.map((value, index) => ({ date: date(index), report_count: value, defect_quantity_record_count: value ? 1 : 0, reported_defect_qty: value ? value * 2 : null }));
function totals(days: QualityReportDay[]): QualityReportTotals {
  const operating = days.filter(day => day.operating).length; const reports = days.reduce((sum, day) => sum + day.report_count, 0);
  const shots = days.reduce((sum, day) => sum + day.shot_count, 0);
  return { calendar_day_count: days.length, operating_day_count: operating, report_count: reports, injection_report_count: reports, shot_count: shots,
    reports_per_operating_day: operating ? Math.round(reports / operating * 100) / 100 : null, injection_reports_per_10k_shots: shots ? Math.round(reports / shots * 1000000) / 100 : null };
}
function report(): QualityReport {
  const days = counts.map((value, index) => ({ date: date(index), planned_quantity: idle.has(index) ? 0 : 1000, planned_machine_count: idle.has(index) ? 0 : 3,
    shot_count: idle.has(index) ? 0 : 5000, running_machine_count: idle.has(index) ? 0 : 3, operating: !idle.has(index), pending: false, report_count: value, injection_report_count: value, displayed: !idle.has(index) }));
  const label = { ko: '스크래치', zh: '擦伤' };
  return {
    schema_version: 'quality-report.v1',
    operations: { status: 'ready', injection_scope: true, min_running_shots: 10, min_operating_shots: 100, shot_unit: 10000, reported_through: date(9), days, summary: totals(days),
      machines: [{ machine_number: 1, shot_count: 40000, running_day_count: 8, report_count: 6, reports_per_10k_shots: 1.5 }] },
    weekly: [{ week_start: date(0), week_end: date(5), ...totals(days.slice(0, 6)), top_type: { key: 'scratch', label, report_count: 4 } },
      { week_start: date(6), week_end: date(9), ...totals(days.slice(6)), top_type: null }],
    comparison: { previous_start: '2026-08-22', previous_end: '2026-08-31', report_count: 9, operating_day_count: 9, reports_per_operating_day: 1,
      types: [{ key: 'scratch', label, current_count: 8, previous_count: 3, change: 5 }, { key: 'gas', label: { ko: '가스 마크', zh: '气痕' }, current_count: 1, previous_count: 4, change: -3 }] },
    recurring: [{ model_display: 'MODEL-A', part_no: 'PART-A', type_key: 'scratch', type_label: label, report_count: 4, day_count: 3, first_date: date(0), last_date: date(8), sample_report_ids: [1, 2, 3] }],
  };
}
function analysis(extension: QualityReport | null = report()) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  return { filters: { start_date: date(0), end_date: date(9), section: null, machine_number: null }, summary: { report_count: total, reported_defect_qty: total * 2 }, trend,
    type_pareto: [{ key: 'scratch', label: { ko: '스크래치', zh: '擦伤' }, report_count: 8, sample_report_ids: [1], share_of_type_occurrences_percent: 80, cumulative_type_share_percent: 80 }],
    production_context: { model_parts: { items: [{ model_display: 'MODEL-A', part_no: '=PART', label: 'MODEL-A', report_count: 6, share_of_reports_percent: 33.33, reported_defect_qty: 12 }] } },
    report: extension ?? undefined } as unknown as QualityAnalysis & { report?: QualityReport };
}

test('a valid report extension is accepted and reconciles with the core daily totals', () => {
  assert.equal(parseQualityReport(report(), trend).operations.summary.operating_day_count, 8);
});

test('a hidden date may never carry reports and day totals must match the core trend', () => {
  const hidden = report(); hidden.operations.days[0].displayed = false;
  assert.throws(() => parseQualityReport(hidden, trend));
  const mismatch = report(); mismatch.operations.days[2].report_count = 9;
  assert.throws(() => parseQualityReport(mismatch, trend));
  const missing = report(); missing.operations.days.pop();
  assert.throws(() => parseQualityReport(missing, trend));
});

test('an unavailable production source cannot hide any date', () => {
  const unavailable = report(); unavailable.operations.status = 'unavailable';
  assert.throws(() => parseQualityReport(unavailable, trend));
  unavailable.operations.days.forEach(day => { day.displayed = true; });
  assert.equal(parseQualityReport(unavailable, trend).operations.status, 'unavailable');
});

test('a pending-entry date is hidden and never counted as operating', () => {
  const pending = report(); Object.assign(pending.operations.days[4], { pending: true });
  assert.equal(parseQualityReport(pending, trend).operations.days[4].pending, true);
  Object.assign(pending.operations.days[4], { operating: true });
  assert.throws(() => parseQualityReport(pending, trend));
});

test('weekly totals and type changes must reconcile', () => {
  const week = report(); week.weekly[0].report_count += 1;
  assert.throws(() => parseQualityReport(week, trend));
  const change = report(); change.comparison!.types[0].change = 1;
  assert.throws(() => parseQualityReport(change, trend));
});

test('the trend shows operating days only and averages the latest seven displayed days', () => {
  const series = getReportTrendSeries(analysis(), 'reports');
  assert.deepEqual(series.map(point => point.date), counts.map((_, index) => date(index)).filter((_, index) => !idle.has(index)));
  assert.equal(series[5].average, null);
  assert.equal(series[6].average, (2 + 0 + 3 + 1 + 4 + 2 + 1) / 7);
  assert.equal(series[0].shot_count, 5000);
});

test('an unknown quantity inside the window withholds the quantity average', () => {
  const series = getReportTrendSeries(analysis(), 'quantity');
  assert.equal(series[1].value, null);
  assert.equal(series[6].average, null);
});

test('old servers without the extension keep every calendar date', () => {
  assert.equal(getReportTrendSeries(analysis(null), 'reports').length, counts.length);
  assert.deepEqual(buildQualityHighlights(analysis(null), 'ko').length, 2);
});

test('highlights state operating-day intensity, change, leading types and recurrence from response numbers', () => {
  const lines = buildQualityHighlights(analysis(), 'ko');
  assert.match(lines[0], /조업일 8일 동안 신고 18건, 조업일당 2\.3건\. 직전 기간\(1건\) 대비 \+125%/);
  assert.ok(lines.some(line => line.includes('증가: 스크래치 3→8건') && line.includes('감소: 가스 마크 4→1건')));
  assert.ok(lines.some(line => line.includes('3일에 걸쳐 4건 반복')));
  assert.ok(buildQualityHighlights(analysis(), 'zh')[0].startsWith('8 个生产日共报告 18 条'));
});

test('percent change needs a positive previous value', () => {
  assert.equal(percentChange(3, 2), 50);
  assert.equal(percentChange(3, 0), null);
  assert.equal(percentChange(null, 2), null);
});

test('CSV lists displayed days only and neutralises spreadsheet formulas', () => {
  const csv = createQualityReportCsv(analysis(), 'ko');
  assert.ok(csv.includes(`"${date(0)}","2","4","1000","5000","3"`));
  assert.ok(!csv.includes(`"${date(4)}"`));
  assert.ok(csv.includes(`"'=PART"`));
  assert.ok(csv.includes('"IMM01","8","40000","6","1.5"'));
});
