import type { LocalizedLabel, QualityAnalysis, QualityLanguage } from './model.ts';

export interface QualityReportTotals {
  calendar_day_count: number; operating_day_count: number | null; report_count: number; injection_report_count: number;
  shot_count: number | null; reports_per_operating_day: number | null; injection_reports_per_10k_shots: number | null;
}
export interface QualityReportDay {
  date: string; planned_quantity: number; planned_machine_count: number; shot_count: number; running_machine_count: number;
  operating: boolean; pending: boolean; report_count: number; injection_report_count: number; displayed: boolean;
}
export interface QualityReportWeek extends QualityReportTotals {
  week_start: string; week_end: string; top_type: { key: string; label: LocalizedLabel | string; report_count: number } | null;
}
export interface QualityReportMachine { machine_number: number; shot_count: number; running_day_count: number; report_count: number; reports_per_10k_shots: number | null }
export interface QualityReportTypeChange { key: string; label: LocalizedLabel | string; current_count: number; previous_count: number; change: number }
export interface QualityRecurringIssue {
  model_display: string; part_no: string; type_key: string; type_label: LocalizedLabel | string;
  report_count: number; day_count: number; first_date: string; last_date: string; sample_report_ids: number[];
}
export interface QualityReport {
  schema_version: 'quality-report.v1';
  operations: {
    status: 'ready' | 'unavailable'; injection_scope: boolean; min_running_shots: number; min_operating_shots: number; shot_unit: number; reported_through: string | null;
    days: QualityReportDay[]; summary: QualityReportTotals; machines: QualityReportMachine[];
  };
  weekly: QualityReportWeek[];
  comparison: {
    previous_start: string; previous_end: string; report_count: number; operating_day_count: number | null;
    reports_per_operating_day: number | null; types: QualityReportTypeChange[];
  } | null;
  recurring: QualityRecurringIssue[];
}

function fail(): never { throw new Error('invalid_quality_report'); }
function record(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
function count(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); return value as number; }
function optionalCount(value: unknown) { return value === null ? null : count(value); }
function rate(value: unknown) { if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail(); }
function labelled(value: unknown) { if (typeof value === 'string') return; const label = record(value); if (typeof label.ko !== 'string' || typeof label.zh !== 'string') fail(); }
function totals(value: unknown) {
  const row = record(value);
  count(row.calendar_day_count); count(row.report_count); count(row.injection_report_count);
  optionalCount(row.operating_day_count); optionalCount(row.shot_count); rate(row.reports_per_operating_day); rate(row.injection_reports_per_10k_shots);
  if (Number(row.injection_report_count) > Number(row.report_count) || Number(row.operating_day_count ?? 0) > Number(row.calendar_day_count)) fail();
  return row as unknown as QualityReportTotals;
}

/** The report extension must agree with the core daily totals before any date is hidden. */
export function parseQualityReport(value: unknown, trend: QualityAnalysis['trend']): QualityReport {
  const report = record(value); const operations = record(report.operations);
  if (report.schema_version !== 'quality-report.v1' || !['ready', 'unavailable'].includes(String(operations.status))
    || typeof operations.injection_scope !== 'boolean' || (operations.reported_through !== null && typeof operations.reported_through !== 'string')) fail();
  count(operations.min_running_shots); count(operations.min_operating_shots); count(operations.shot_unit);
  const days = Array.isArray(operations.days) ? operations.days : fail();
  if (days.length !== trend.length) fail();
  days.forEach((value, index) => {
    const day = record(value);
    for (const key of ['planned_quantity', 'planned_machine_count', 'shot_count', 'running_machine_count', 'report_count', 'injection_report_count']) count(day[key]);
    if (day.date !== trend[index].date || day.report_count !== trend[index].report_count || typeof day.operating !== 'boolean' || typeof day.displayed !== 'boolean' || typeof day.pending !== 'boolean'
      || (day.pending && (day.displayed || day.operating))
      || Number(day.injection_report_count) > Number(day.report_count) || (!day.displayed && Number(day.report_count) > 0)
      || (operations.status !== 'ready' && !day.displayed && !day.pending)) fail();
  });
  const summary = totals(operations.summary);
  if (summary.report_count !== trend.reduce((sum, row) => sum + row.report_count, 0)) fail();
  (Array.isArray(operations.machines) ? operations.machines : fail()).forEach(value => {
    const row = record(value); const machine = count(row.machine_number);
    if (machine < 1 || machine > 17) fail();
    count(row.shot_count); count(row.running_day_count); count(row.report_count); rate(row.reports_per_10k_shots);
  });
  const weekly = Array.isArray(report.weekly) ? report.weekly : fail();
  weekly.forEach(value => {
    const week = record(value); totals(week);
    if (typeof week.week_start !== 'string' || typeof week.week_end !== 'string' || week.week_start > week.week_end) fail();
    if (week.top_type !== null) { const top = record(week.top_type); if (typeof top.key !== 'string') fail(); labelled(top.label); count(top.report_count); }
  });
  if (weekly.reduce((sum, week) => sum + Number(record(week).report_count), 0) !== summary.report_count) fail();
  if (report.comparison !== null) {
    const comparison = record(report.comparison);
    if (typeof comparison.previous_start !== 'string' || typeof comparison.previous_end !== 'string') fail();
    count(comparison.report_count); optionalCount(comparison.operating_day_count); rate(comparison.reports_per_operating_day);
    (Array.isArray(comparison.types) ? comparison.types : fail()).forEach(value => {
      const row = record(value); if (typeof row.key !== 'string') fail(); labelled(row.label);
      if (count(row.current_count) - count(row.previous_count) !== row.change) fail();
    });
  }
  (Array.isArray(report.recurring) ? report.recurring : fail()).forEach(value => {
    const row = record(value);
    for (const key of ['model_display', 'part_no', 'type_key', 'first_date', 'last_date']) if (typeof row[key] !== 'string') fail();
    labelled(row.type_label);
    const ids = Array.isArray(row.sample_report_ids) ? row.sample_report_ids : fail();
    ids.forEach(id => { if (count(id) === 0) fail(); });
    if (count(row.report_count) < 2 || count(row.day_count) < 1 || Number(row.day_count) > Number(row.report_count) || ids.length > 5) fail();
  });
  return report as unknown as QualityReport;
}

export interface QualityReportTrendPoint { date: string; value: number | null; average: number | null; shot_count: number | null; running_machine_count: number | null }

/** Displayed days only; the average covers the latest seven displayed days with known values. */
export function getReportTrendSeries(data: Pick<QualityAnalysis, 'trend'> & { report?: QualityReport }, metric: 'reports' | 'quantity'): QualityReportTrendPoint[] {
  const days = new Map(data.report?.operations.days.map(day => [day.date, day]) ?? []);
  const ready = data.report?.operations.status === 'ready';
  // Without the MES calendar, a blank date has unknown operating and entry
  // status. Only dates with a stored report can safely appear in the preview.
  const shown = data.trend.filter(row => data.report ? days.get(row.date)?.displayed ?? true : row.report_count > 0);
  return shown.map((row, index) => {
    const window = shown.slice(Math.max(0, index - 6), index + 1).map(item => metric === 'reports' ? item.report_count : item.reported_defect_qty);
    const known = Boolean(data.report) && window.length === 7 && window.every(value => value !== null);
    const day = days.get(row.date);
    return {
      date: row.date, value: metric === 'reports' ? row.report_count : row.reported_defect_qty,
      average: known ? (window as number[]).reduce((sum, value) => sum + value, 0) / 7 : null,
      shot_count: ready && day ? day.shot_count : null, running_machine_count: ready && day ? day.running_machine_count : null,
    };
  });
}

/** The injection comparison chart omits setup and plan-only days without injection reports. */
export function getProductionIntensitySeries(report: QualityReport, series: QualityReportTrendPoint[]) {
  const days = new Map(report.operations.days.map(day => [day.date, day]));
  return series.filter(point => {
    const day = days.get(point.date);
    return day?.displayed && (day.shot_count >= report.operations.min_operating_shots || day.injection_report_count > 0);
  });
}

export function percentChange(current: number | null | undefined, previous: number | null | undefined) {
  return typeof current === 'number' && typeof previous === 'number' && previous > 0 ? (current - previous) / previous * 100 : null;
}

function localized(value: LocalizedLabel | string, language: QualityLanguage) { return typeof value === 'string' ? value : value[language]; }
function decimal(value: number, language: QualityLanguage, digits = 1) { return value.toLocaleString(language === 'zh' ? 'zh-CN' : 'ko-KR', { maximumFractionDigits: digits }); }

/** Deterministic sentences derived only from validated numbers in the response. */
export function buildQualityHighlights(data: QualityAnalysis & { report?: QualityReport }, language: QualityLanguage): string[] {
  const ko = language === 'ko'; const lines: string[] = []; const report = data.report;
  const total = data.summary.report_count;
  if (!total) return lines;
  const summary = report?.operations.summary; const comparison = report?.comparison;
  if (summary?.reports_per_operating_day != null && summary.operating_day_count) {
    const change = percentChange(summary.reports_per_operating_day, comparison?.reports_per_operating_day);
    const trendText = change === null ? '' : ko
      ? ` 직전 기간(${decimal(comparison!.reports_per_operating_day!, language)}건) 대비 ${change >= 0 ? '+' : ''}${decimal(change, language)}%.`
      : ` 较上一期间(${decimal(comparison!.reports_per_operating_day!, language)}条) ${change >= 0 ? '+' : ''}${decimal(change, language)}%。`;
    lines.push(ko
      ? `조업일 ${summary.operating_day_count}일 동안 신고 ${total}건, 조업일당 ${decimal(summary.reports_per_operating_day, language)}건.${trendText}`
      : `${summary.operating_day_count} 个生产日共报告 ${total} 条，每生产日 ${decimal(summary.reports_per_operating_day, language)} 条。${trendText}`);
  }
  const top = data.type_pareto.slice(0, 3);
  if (top.length) {
    const share = top[top.length - 1].cumulative_type_share_percent;
    const names = top.map(row => `${localized(row.label, language)} ${row.report_count}${ko ? '건' : '条'}`).join(' · ');
    lines.push(ko ? `상위 ${top.length}개 유형이 분류된 불량의 ${decimal(share, language)}%: ${names}.` : `前 ${top.length} 类占已分类不良的 ${decimal(share, language)}%：${names}。`);
  }
  const rising = comparison?.types.filter(row => row.change > 0).sort((a, b) => b.change - a.change)[0];
  const falling = comparison?.types.filter(row => row.change < 0).sort((a, b) => a.change - b.change)[0];
  if (rising || falling) {
    const parts = [
      rising && (ko ? `증가: ${localized(rising.label, language)} ${rising.previous_count}→${rising.current_count}건` : `增加：${localized(rising.label, language)} ${rising.previous_count}→${rising.current_count}条`),
      falling && (ko ? `감소: ${localized(falling.label, language)} ${falling.previous_count}→${falling.current_count}건` : `减少：${localized(falling.label, language)} ${falling.previous_count}→${falling.current_count}条`),
    ].filter(Boolean).join(' · ');
    lines.push(ko ? `직전 기간 대비 ${parts}.` : `较上一期间 ${parts}。`);
  }
  const model = data.production_context?.model_parts.items[0];
  if (model && model.report_count > 1) {
    const name = [model.model_display, model.part_no].filter(Boolean).join(' / ') || localized(model.label, language);
    lines.push(ko ? `신고 최다 품목은 ${name} (${model.report_count}건, ${decimal(model.share_of_reports_percent, language)}%).` : `报告最多的品项为 ${name}（${model.report_count}条，${decimal(model.share_of_reports_percent, language)}%）。`);
  }
  const repeat = report?.recurring[0];
  if (repeat && repeat.day_count > 1) {
    const name = [repeat.model_display, repeat.part_no].filter(Boolean).join(' / ');
    lines.push(ko
      ? `${name}에서 '${localized(repeat.type_label, language)}' 불량이 ${repeat.day_count}일에 걸쳐 ${repeat.report_count}건 반복 (${repeat.first_date.slice(5)}~${repeat.last_date.slice(5)}).`
      : `${name} 的${localized(repeat.type_label, language)}在 ${repeat.day_count} 天内重复 ${repeat.report_count} 条（${repeat.first_date.slice(5)}~${repeat.last_date.slice(5)}）。`);
  }
  // A week with only a day or two of production is too thin to call the worst week.
  const weeks = report?.weekly.filter(week => week.injection_reports_per_10k_shots !== null && (week.operating_day_count ?? 0) >= 3) ?? [];
  if (summary?.injection_reports_per_10k_shots != null && weeks.length > 1) {
    const worst = weeks.reduce((best, week) => week.injection_reports_per_10k_shots! > best.injection_reports_per_10k_shots! ? week : best);
    lines.push(ko
      ? `사출 1만 쇼트당 신고 ${decimal(summary.injection_reports_per_10k_shots, language, 2)}건. 가장 높았던 주는 ${worst.week_start.slice(5)}~${worst.week_end.slice(5)} (${decimal(worst.injection_reports_per_10k_shots!, language, 2)}건).`
      : `注塑每万模次报告 ${decimal(summary.injection_reports_per_10k_shots, language, 2)} 条，最高的一周为 ${worst.week_start.slice(5)}~${worst.week_end.slice(5)}（${decimal(worst.injection_reports_per_10k_shots!, language, 2)} 条）。`);
  }
  return lines;
}

function cell(value: string | number | null | undefined) {
  const original = value == null ? '' : String(value);
  const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(original) ? `'${original}` : original;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Report-shaped CSV: summary, weeks, displayed days, types, items, machines and recurring issues. */
export function createQualityReportCsv(data: QualityAnalysis & { report?: QualityReport }, language: QualityLanguage) {
  const ko = language === 'ko'; const report = data.report; const summary = report?.operations.summary;
  const rows: Array<Array<string | number | null>> = [
    [ko ? '불량 분석 보고서' : '不良分析报告', `${data.filters.start_date} ~ ${data.filters.end_date}`, data.filters.section || (ko ? '전체 부문' : '全部部门'), data.filters.machine_number ?? (ko ? '전체 설비' : '全部设备')], [],
    [ko ? '요약' : '汇总'],
    [ko ? '생산량 연계 지표' : '产量关联指标', report ? (ko ? '포함' : '已包含') : (ko ? '미포함' : '未包含')],
    [ko ? '신고 건수' : '报告条数', data.summary.report_count], [ko ? '기록 불량 수량' : '记录不良数量', data.summary.reported_defect_qty],
    [ko ? '조업일' : '生产日', summary?.operating_day_count ?? null], [ko ? '조업일당 신고' : '每生产日报告', summary?.reports_per_operating_day ?? null],
    [ko ? '사출 쇼트 수' : '注塑模次', summary?.shot_count ?? null], [ko ? '사출 1만 쇼트당 신고' : '注塑每万模次报告', summary?.injection_reports_per_10k_shots ?? null],
    [ko ? '직전 기간 신고' : '上一期间报告', report?.comparison?.report_count ?? null], [],
    [ko ? '주간' : '周', ko ? '조업일' : '生产日', ko ? '신고' : '报告', ko ? '조업일당' : '每生产日', ko ? '쇼트' : '模次', ko ? '1만 쇼트당' : '每万模次', ko ? '최다 유형' : '最多类型'],
    ...(report?.weekly ?? []).map(week => [`${week.week_start}~${week.week_end}`, week.operating_day_count, week.report_count, week.reports_per_operating_day, week.shot_count, week.injection_reports_per_10k_shots, week.top_type ? localized(week.top_type.label, language) : '']), [],
    [ko ? '일자' : '日期', ko ? '신고' : '报告', ko ? '기록 불량수' : '记录不良数', ko ? '계획 수량' : '计划数量', ko ? '쇼트' : '模次', ko ? '가동 설비' : '运行设备'],
  ];
  const days = new Map(report?.operations.days.map(day => [day.date, day]) ?? []);
  for (const row of data.trend) {
    const day = days.get(row.date);
    if (day ? !day.displayed : !report && row.report_count === 0) continue;
    rows.push([row.date, row.report_count, row.reported_defect_qty, day?.planned_quantity ?? null, day?.shot_count ?? null, day?.running_machine_count ?? null]);
  }
  rows.push([], [ko ? '불량 유형' : '不良类型', ko ? '신고' : '报告', ko ? '비중 %' : '占比 %', ko ? '누적 %' : '累计 %', ko ? '직전 기간' : '上一期间']);
  const previous = new Map(report?.comparison?.types.map(row => [row.key, row.previous_count]) ?? []);
  for (const row of data.type_pareto) rows.push([localized(row.label, language), row.report_count, row.share_of_type_occurrences_percent, row.cumulative_type_share_percent, report?.comparison ? previous.get(row.key) ?? 0 : null]);
  rows.push([], [ko ? '모델' : '型号', 'Part No.', ko ? '신고' : '报告', ko ? '비중 %' : '占比 %', ko ? '기록 불량수' : '记录不良数']);
  for (const row of data.production_context?.model_parts.items ?? []) rows.push([row.model_display, row.part_no, row.report_count, row.share_of_reports_percent, row.reported_defect_qty]);
  if (report?.operations.machines.length) {
    rows.push([], [ko ? '설비' : '设备', ko ? '가동일' : '运行天数', ko ? '쇼트' : '模次', ko ? '신고' : '报告', ko ? '1만 쇼트당' : '每万模次']);
    for (const row of report.operations.machines) rows.push([`IMM${String(row.machine_number).padStart(2, '0')}`, row.running_day_count, row.shot_count, row.report_count, row.reports_per_10k_shots]);
  }
  if (report?.recurring.length) {
    rows.push([], [ko ? '반복 품목' : '重复品项', 'Part No.', ko ? '유형' : '类型', ko ? '신고' : '报告', ko ? '발생일' : '发生天数', ko ? '기간' : '期间']);
    for (const row of report.recurring) rows.push([row.model_display, row.part_no, localized(row.type_label, language), row.report_count, row.day_count, `${row.first_date}~${row.last_date}`]);
  }
  return `\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
