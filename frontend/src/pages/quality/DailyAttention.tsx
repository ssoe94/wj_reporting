import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  Factory,
  FolderOpen,
  Layers3,
  Printer,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import dayjs from 'dayjs';

import api from '../../lib/api';
import { useLang } from '../../i18n';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

type HistoricalReport = {
  id: number;
  report_dt: string;
  section: string;
  part_no: string;
  judgement: string;
  defect_rate: string;
  phenomenon: string;
  disposition: string;
  action_result: string;
  images: string[];
};

type DailyAttentionItem = {
  source_key?: string;
  match_basis?: 'part_prefix_9';
  machine_name: string;
  machine_number: number | null;
  sequence: number | null;
  part_prefix: string;
  part_nos: string[];
  model_names: string[];
  lot_nos: string[];
  planned_quantity: number;
  plan_row_count: number;
  matching_report_count: number;
  latest_report_dt: string | null;
  top_phenomena: Array<{ phenomenon: string; count: number }>;
  reports: HistoricalReport[];
};

type LocalizedText = {
  ko: string;
  zh: string;
};

type QualityTrend = {
  status: 'increase' | 'stable_or_decrease' | 'insufficient_data';
  reason:
    | 'count_and_share_increase'
    | 'increase_rule_not_met'
    | 'zero_window_denominator'
    | 'small_window_denominator'
    | 'small_issue_sample';
  recent_count: number;
  previous_count: number;
  recent_denominator: number;
  previous_denominator: number;
  recent_share_pct: number | null;
  previous_share_pct: number | null;
  share_change_pp: number | null;
  count_change: number;
  denominator_basis: 'unique_matching_reports_in_current_plan_prefixes';
};

type QualityPlanTarget = {
  machine_name: string;
  sequence: number | null;
  model_name: string;
  part_no: string;
  lot_no: string;
  planned_quantity: number;
};

type QualityReportMetric = {
  metric_key: string;
  canonical_key?: string;
  label: LocalizedText;
  classification_basis:
    | 'canonical_alias_v1'
    | 'unclassified_recorded_text_hash'
    | 'unclassified'
    | 'missing_recorded_phenomenon'
    | 'explicit_keyword_v1'
    | 'unlocated';
  evidence_count: number;
  repeat_status: 'repeated' | 'single';
  latest_report_dt: string | null;
  all_history_denominator: number;
  all_history_denominator_basis: 'unique_matching_reports_in_current_plan_prefixes';
  all_history_share_pct: number | null;
  trend: QualityTrend;
  impact_scope: {
    plan_group_count: number;
    planned_quantity: number;
    machine_names: string[];
    model_names: string[];
    part_nos: string[];
    part_prefixes: string[];
    plan_targets: QualityPlanTarget[];
    historical_model_names: string[];
    historical_part_nos: string[];
  };
};

type QualityDeterministicReport = {
  schema_version: 'quality-daily-report.v1';
  calculated_at: string;
  as_of_date: string;
  history_coverage: 'all_history';
  match_basis: 'part_prefix_9';
  trend_policy: {
    window_days: number;
    recent_start: string;
    recent_end: string;
    previous_start: string;
    previous_end: string;
    min_window_denominator: number;
    min_combined_issue_count: number;
    increase_rule: 'count_and_share_must_both_increase';
    zero_denominator_policy: 'insufficient_data';
    small_sample_policy: 'insufficient_data';
    window_anchor: 'selected_plan_date';
  };
  coverage: {
    plan_group_count: number;
    distinct_prefix_count: number;
    matched_report_count: number;
    without_history_count: number;
    latest_report_dt: string | null;
    model_names: string[];
    part_nos: string[];
    problem_type_count: number;
    occurrence_location_count: number;
  };
  problem_types: QualityReportMetric[];
  occurrence_locations: QualityReportMetric[];
  calculation_basis: Record<string, unknown>;
};

type QualityNarrativeItem = {
  metric_key: string;
  narrative: LocalizedText;
};

type QualityPublicMetricSignal = {
  metric_key: string;
  dimension: 'problem_type' | 'location';
  label: LocalizedText;
  evidence_count: number;
  denominator: number;
  share_pct: number | null;
  trend: QualityTrend;
};

type QualityReportNarrative = {
  schema_version: 'quality-daily-report-narrative.v1';
  summary: LocalizedText;
  executive_summary: LocalizedText;
  priorities: Array<{
    priority_rank: number;
    target_ref: string;
    machine_name: string;
    machine_number: number | null;
    model_names: string[];
    part_nos: string[];
    primary_metric_key: string | null;
    signals: QualityPublicMetricSignal[];
    headline: LocalizedText;
    checkpoints: { ko: string[]; zh: string[] };
  }>;
  repeated_issues: QualityNarrativeItem[];
  accelerating_issues: QualityNarrativeItem[];
  affected_targets: Array<{
    target_ref: string;
    machine_name: string;
    machine_number: number | null;
    model_names: string[];
    part_nos: string[];
    primary_metric_key: string | null;
    signals: QualityPublicMetricSignal[];
    headline: LocalizedText;
  }>;
  shift_checks: { ko: string[]; zh: string[] };
  caveats: { ko: string[]; zh: string[] };
};

type QualityDailyReport = {
  schema_version: 'quality-daily-page-report.v1';
  contract_version: 'quality-daily-public-report.v2';
  status: 'ready' | 'pending' | 'stale' | 'unavailable';
  reason:
    | null
    | 'generation_pending'
    | 'plan_changed'
    | 'evidence_changed'
    | 'no_plan'
    | 'not_generated'
    | 'generation_failed'
    | 'llm_fallback'
    | 'store_unavailable';
  business_date: string;
  source_revision: string | null;
  source_plan_last_changed_at: string | null;
  source_evidence_last_changed_at: string | null;
  generated_at: string | null;
  completed_at: string | null;
  model_id: 'gemma4_26b_a4b';
  ai_schema_version: 'quality-daily-attention-ai.v1';
  deterministic_schema_version: 'quality-daily-report.v1';
  disclaimer: LocalizedText;
  narrative: QualityReportNarrative | null;
  deterministic: QualityDeterministicReport;
  generation_source: string | null;
  llm_fallback: boolean;
  llm_fallback_code: string;
  data_policy: Record<string, unknown>;
};

type DailyAttentionResponse = {
  date: string;
  source_plan_last_changed_at?: string | null;
  source_evidence_last_changed_at?: string | null;
  total_plan_count: number;
  total_matching_reports: number;
  without_history_count: number;
  items: DailyAttentionItem[];
  report?: QualityDailyReport | null;
};

type MetricDimension = 'problem' | 'location';

type DimensionedMetric = QualityReportMetric & {
  dimension: MetricDimension;
};

type PhenomenonGroup = {
  phenomenon: string;
  reports: HistoricalReport[];
  totalCount: number;
  sectionCounts: Array<{ section: string; count: number }>;
  primaryOrder: number;
};

type PrintableImage = {
  id: string;
  imageUrl: string;
  phenomenon: string;
  reportDt: string;
  section: string;
  partNo: string;
  disposition: string;
  actionResult: string;
};

type PrintSelectionState = {
  item: DailyAttentionItem;
  groups: PhenomenonGroup[];
  images: PrintableImage[];
  selectedIds: string[];
};

type PrintLabels = {
  title: string;
  machine: string;
  partNo: string;
  plannedQty: string;
  models: string;
  lots: string;
  history: string;
  none: string;
  latest: string;
  section: string;
  action: string;
  date: string;
  selectedPhotos: string;
  topPhenomena: string;
};

const SECTION_ORDER: Record<string, number> = {
  CS: 0,
  OQC: 1,
  LQC: 2,
};

function normalizeSection(section: string): string {
  const value = (section || '').trim().toUpperCase();
  if (value.startsWith('CS')) return 'CS';
  if (value.startsWith('OQC')) return 'OQC';
  if (value.startsWith('LQC')) return 'LQC';
  return value || 'ETC';
}

function normalizePhenomenonLabel(value: string, emptyLabel: string): string {
  const raw = (value || '').trim();
  if (!raw) return emptyLabel;

  const normalized = raw
    .normalize('NFKC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[，、,;；/／|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[。．.]+$/g, '')
    .trim()
    .replace(/\s/g, '');

  if (!normalized) return emptyLabel;

  const tokens = new Set<string>();

  if (
    normalized.includes('脏污') ||
    normalized.includes('油污') ||
    normalized.includes('油渍') ||
    normalized.includes('油点') ||
    normalized.includes('灰尘') ||
    normalized.includes('污渍') ||
    normalized.includes('擦拭印')
  ) {
    tokens.add('脏污');
  }

  if (normalized.includes('白色粉末') || normalized.includes('粉末残留')) {
    tokens.add('白色粉末残留');
  }

  if (normalized.includes('毛刺') || normalized.includes('飞边')) {
    tokens.add('毛刺未去除');
  }

  if (normalized.includes('毛絮')) {
    tokens.add('毛絮残留');
  }

  if (normalized.includes('糊斑')) {
    tokens.add('糊斑');
  }

  if (normalized.includes('气印')) {
    tokens.add('气印发白');
  }

  if (normalized.includes('缩印') || normalized.includes('缩影')) {
    tokens.add('缩印');
  }

  if (normalized.includes('缺胶')) {
    tokens.add('缺胶');
  }

  if (normalized.includes('发亮') || normalized.includes('高光')) {
    tokens.add('发亮');
  }

  if (
    normalized.includes('拉伤') ||
    normalized.includes('擦伤') ||
    normalized.includes('削伤') ||
    normalized.includes('磕伤') ||
    normalized.includes('夹伤') ||
    normalized.includes('损伤')
  ) {
    tokens.add('擦伤/碰伤');
  }

  if (
    normalized.includes('夹色') ||
    normalized.includes('黑点') ||
    normalized.includes('料花')
  ) {
    tokens.add('夹色/黑点/料花');
  }

  if (
    normalized.includes('标签') ||
    normalized.includes('重码') ||
    normalized.includes('漏贴')
  ) {
    tokens.add('标签异常');
  }

  if (
    normalized.includes('包装') ||
    normalized.includes('包裹') ||
    normalized.includes('水渍')
  ) {
    tokens.add('包装异常');
  }

  if (tokens.size > 0) {
    return Array.from(tokens).join(' / ');
  }

  return normalized;
}

function groupReportsByPhenomenon(reports: HistoricalReport[], emptyLabel: string): PhenomenonGroup[] {
  const groups = new Map<string, HistoricalReport[]>();

  reports.forEach((report) => {
    const phenomenon = normalizePhenomenonLabel(report.phenomenon || '', emptyLabel);
    const current = groups.get(phenomenon) ?? [];
    current.push({
      ...report,
      phenomenon,
    });
    groups.set(phenomenon, current);
  });

  return Array.from(groups.entries())
    .map(([phenomenon, groupedReports]) => {
      const sortedReports = [...groupedReports].sort((a, b) => {
        const sectionDiff = (SECTION_ORDER[normalizeSection(a.section)] ?? 99) - (SECTION_ORDER[normalizeSection(b.section)] ?? 99);
        if (sectionDiff !== 0) return sectionDiff;
        return dayjs(b.report_dt).valueOf() - dayjs(a.report_dt).valueOf();
      });

      const sectionCountMap = new Map<string, number>();
      sortedReports.forEach((report) => {
        const section = normalizeSection(report.section);
        sectionCountMap.set(section, (sectionCountMap.get(section) ?? 0) + 1);
      });

      const sectionCounts = Array.from(sectionCountMap.entries())
        .map(([section, count]) => ({ section, count }))
        .sort((a, b) => (SECTION_ORDER[a.section] ?? 99) - (SECTION_ORDER[b.section] ?? 99));

      const primaryOrder = sectionCounts.length > 0
        ? Math.min(...sectionCounts.map((entry) => SECTION_ORDER[entry.section] ?? 99))
        : 99;

      return {
        phenomenon,
        reports: sortedReports,
        totalCount: sortedReports.length,
        sectionCounts,
        primaryOrder,
      };
    })
    .sort((a, b) => {
      if (a.primaryOrder !== b.primaryOrder) return a.primaryOrder - b.primaryOrder;
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
      return a.phenomenon.localeCompare(b.phenomenon);
    });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSectionCounts(sectionCounts: Array<{ section: string; count: number }>): string {
  return sectionCounts.map((entry) => `${entry.section} ${entry.count}`).join(' / ');
}

function localizedText(value: LocalizedText | null | undefined, lang: string): string {
  if (!value) return '';
  return lang === 'zh' ? value.zh : value.ko;
}

function formatMetricNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toLocaleString();
}

function formatMetricPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}%`;
}

function formatReportDate(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : '-';
}

function formatReportDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '-';
}

function percentageWidth(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '0%';
  return `${Math.max(0, Math.min(100, value))}%`;
}

function metricPriority(metric: DimensionedMetric): number {
  const trendScore = metric.trend.status === 'increase' ? 1_000_000 : 0;
  const repeatScore = metric.repeat_status === 'repeated' ? 100_000 : 0;
  return trendScore + repeatScore + metric.evidence_count;
}

function sortMetrics(metrics: DimensionedMetric[]): DimensionedMetric[] {
  return [...metrics].sort((a, b) => {
    const scoreDiff = metricPriority(b) - metricPriority(a);
    if (scoreDiff !== 0) return scoreDiff;
    return localizedText(a.label, 'ko').localeCompare(localizedText(b.label, 'ko'));
  });
}

function metricDimensionLabel(metric: DimensionedMetric, lang: string): string {
  return metric.dimension === 'location'
    ? (lang === 'zh' ? '发生位置' : '발생위치')
    : (lang === 'zh' ? '问题类型' : '문제유형');
}

function metricTrendLabel(metric: DimensionedMetric, lang: string): string {
  if (metric.trend.status === 'increase') {
    return lang === 'zh' ? '最近增加' : '최근 증가';
  }
  if (metric.trend.status === 'insufficient_data') {
    return lang === 'zh' ? '样本不足' : '표본 부족';
  }
  return lang === 'zh' ? '未满足增加标准' : '증가 기준 미충족';
}

function firstMetricTarget(metric: DimensionedMetric): QualityPlanTarget | null {
  return metric.impact_scope.plan_targets[0] ?? null;
}

function findMetricForTarget(
  metrics: DimensionedMetric[],
  machineName: string,
  modelNames: string[],
  partNos: string[],
): DimensionedMetric | null {
  const modelSet = new Set(modelNames.filter(Boolean));
  const partSet = new Set(partNos.filter(Boolean));
  return metrics.find((metric) => metric.impact_scope.plan_targets.some((target) => (
    target.machine_name === machineName &&
    (
      (target.model_name && modelSet.has(target.model_name)) ||
      (target.part_no && partSet.has(target.part_no))
    )
  ))) ?? null;
}

function ReportStatusBadge({
  report,
  lang,
  narrativeReady,
}: {
  report: QualityDailyReport | null;
  lang: string;
  narrativeReady: boolean;
}) {
  const status = report?.status === 'ready' && !narrativeReady
    ? 'unavailable'
    : report?.status ?? 'unavailable';
  const staleLabel = report?.reason === 'evidence_changed'
    ? (lang === 'zh' ? '质量依据变更 · 等待更新' : '품질 근거 변경 · 갱신 대기')
    : (lang === 'zh' ? '计划变更 · 等待更新' : '계획 변경 · 갱신 대기');
  const config = {
    ready: {
      label: lang === 'zh' ? 'AI 分析完成' : 'AI 분석 완료',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      Icon: CheckCircle2,
    },
    pending: {
      label: lang === 'zh' ? 'AI 分析生成中' : 'AI 분석 생성 중',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
      Icon: Clock3,
    },
    stale: {
      label: staleLabel,
      className: 'border-amber-200 bg-amber-50 text-amber-700',
      Icon: CircleAlert,
    },
    unavailable: {
      label: lang === 'zh' ? '仅显示数据分析' : '데이터 분석만 표시',
      className: 'border-slate-200 bg-slate-50 text-slate-600',
      Icon: Database,
    },
  }[status];
  const Icon = config.Icon;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${config.className}`}>
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  );
}

function MetricBarPanel({
  title,
  subtitle,
  metrics,
  lang,
  dimension,
}: {
  title: string;
  subtitle: string;
  metrics: QualityReportMetric[];
  lang: string;
  dimension: MetricDimension;
}) {
  const Icon = dimension === 'problem' ? BarChart3 : Target;
  const accent = dimension === 'problem'
    ? { icon: 'bg-blue-50 text-blue-700', bar: 'bg-blue-500', badge: 'bg-blue-50 text-blue-700' }
    : { icon: 'bg-violet-50 text-violet-700', bar: 'bg-violet-500', badge: 'bg-violet-50 text-violet-700' };
  const visibleMetrics = metrics.slice(0, 6);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-5 flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${accent.icon}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">{subtitle}</p>
        </div>
      </div>

      {visibleMetrics.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          {lang === 'zh' ? '无可分析的历史记录' : '분석 가능한 이력이 없습니다.'}
        </div>
      ) : (
        <div className="space-y-4">
          {visibleMetrics.map((metric) => (
            <div key={`${dimension}-${metric.metric_key}`}>
              <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-slate-800" title={localizedText(metric.label, lang)}>
                    {localizedText(metric.label, lang) || '-'}
                  </span>
                  {metric.repeat_status === 'repeated' && (
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.badge}`}>
                      {lang === 'zh' ? '反复' : '반복'}
                    </span>
                  )}
                </div>
                <span className="shrink-0 font-semibold tabular-nums text-slate-900">
                  {formatMetricPercent(metric.all_history_share_pct)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={metric.all_history_share_pct ?? 0}>
                <div className={`h-full rounded-full ${accent.bar}`} style={{ width: percentageWidth(metric.all_history_share_pct) }} />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                <span>
                  {lang === 'zh' ? '分析范围历史依据' : '분석 대상 전체 이력 근거'} {formatMetricNumber(metric.evidence_count)} / {formatMetricNumber(metric.all_history_denominator)}
                </span>
                <span>{lang === 'zh' ? '最近' : '최근'} {formatReportDate(metric.latest_report_dt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TrendMetricCard({ metric, lang, narrative }: { metric: DimensionedMetric; lang: string; narrative?: string }) {
  const isIncrease = metric.trend.status === 'increase';
  const isInsufficient = metric.trend.status === 'insufficient_data';
  const dimensionLabel = metric.dimension === 'problem'
    ? (lang === 'zh' ? '问题类型' : '문제유형')
    : (lang === 'zh' ? '发生位置' : '발생위치');
  const statusLabel = isIncrease
    ? (lang === 'zh' ? '数量与占比同时增加' : '건수·비중 동시 증가')
    : isInsufficient
      ? (lang === 'zh' ? '样本不足' : '표본 부족')
      : (lang === 'zh' ? '未满足增加标准' : '증가 기준 미충족');
  const badgeClass = isIncrease
    ? 'bg-rose-50 text-rose-700 ring-rose-200'
    : isInsufficient
      ? 'bg-slate-100 text-slate-600 ring-slate-200'
      : 'bg-emerald-50 text-emerald-700 ring-emerald-200';

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{dimensionLabel}</div>
          <h4 className="mt-1 truncate font-semibold text-slate-900" title={localizedText(metric.label, lang)}>
            {localizedText(metric.label, lang) || '-'}
          </h4>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${badgeClass}`}>
          {statusLabel}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {[
          {
            key: 'previous',
            label: lang === 'zh' ? '前 30 天' : '이전 30일',
            count: metric.trend.previous_count,
            denominator: metric.trend.previous_denominator,
            share: metric.trend.previous_share_pct,
            barClass: 'bg-slate-400',
          },
          {
            key: 'recent',
            label: lang === 'zh' ? '最近 30 天' : '최근 30일',
            count: metric.trend.recent_count,
            denominator: metric.trend.recent_denominator,
            share: metric.trend.recent_share_pct,
            barClass: isIncrease ? 'bg-rose-500' : 'bg-blue-500',
          },
        ].map((window) => (
          <div key={window.key}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-500">{window.label}</span>
              <span className="font-semibold tabular-nums text-slate-800">
                {formatMetricNumber(window.count)} / {formatMetricNumber(window.denominator)} · {formatMetricPercent(window.share)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${window.barClass}`} style={{ width: percentageWidth(window.share) }} />
            </div>
          </div>
        ))}
      </div>
      {narrative && (
        <p className="mt-4 border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">{narrative}</p>
      )}
    </article>
  );
}

function collectPrintableImages(groups: PhenomenonGroup[]): PrintableImage[] {
  return groups.flatMap((group) =>
    group.reports.flatMap((report) =>
      report.images.map((imageUrl, imageIndex) => ({
        id: `${report.id}-${imageIndex}`,
        imageUrl,
        phenomenon: group.phenomenon,
        reportDt: report.report_dt,
        section: report.section,
        partNo: report.part_no,
        disposition: report.disposition,
        actionResult: report.action_result,
      })),
    ),
  );
}

function buildPrintDocumentHtml(params: {
  date: string;
  item: DailyAttentionItem;
  groups: PhenomenonGroup[];
  selectedImages: PrintableImage[];
  labels: PrintLabels;
  noPhenomenonLabel: string;
}) {
  const { date, item, groups, selectedImages, labels, noPhenomenonLabel } = params;

  const summaryHtml = groups.length === 0
    ? `<div class="empty">${escapeHtml(labels.none)}</div>`
    : groups.map((group) => `
        <div class="summary-tag">
          <div class="summary-tag-title">${escapeHtml(group.phenomenon)}</div>
          <div class="summary-tag-meta">${group.totalCount} | ${escapeHtml(formatSectionCounts(group.sectionCounts))}</div>
        </div>
      `).join('');

  const selectedGroupMap = new Map<string, PrintableImage[]>();
  selectedImages.forEach((image) => {
    const current = selectedGroupMap.get(image.phenomenon) ?? [];
    current.push(image);
    selectedGroupMap.set(image.phenomenon, current);
  });

  const selectedHtml = selectedImages.length === 0
    ? `<div class="empty">${escapeHtml(labels.none)}</div>`
    : Array.from(selectedGroupMap.entries()).map(([phenomenon, images]) => `
        <section class="photo-section">
          <div class="photo-section-header">
            <div class="photo-section-title">${escapeHtml(phenomenon || noPhenomenonLabel)}</div>
            <div class="photo-section-count">${images.length}</div>
          </div>
          <div class="photo-grid">
            ${images.map((image) => `
              <article class="photo-card">
                <figure class="photo-frame">
                  <img src="${escapeHtml(image.imageUrl)}" alt="${escapeHtml(image.phenomenon || noPhenomenonLabel)}" />
                </figure>
                <div class="photo-meta">
                  <div class="photo-meta-row">
                    <span class="photo-badge">${escapeHtml(normalizeSection(image.section))}</span>
                    <span>${escapeHtml(dayjs(image.reportDt).format('YYYY-MM-DD'))}</span>
                  </div>
                  <div>${escapeHtml(labels.partNo)}: ${escapeHtml(image.partNo || '-')}</div>
                  <div>${escapeHtml(labels.action)}: ${escapeHtml(image.disposition || image.actionResult || '-')}</div>
                </div>
              </article>
            `).join('')}
          </div>
        </section>
      `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(`${labels.title} - ${item.machine_name}`)}</title>
  <style>
    @page { size: A4; margin: 9mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #0f172a;
      font-family: "Microsoft YaHei", "PingFang SC", "Malgun Gothic", sans-serif;
      background: #ffffff;
    }
    .page {
      width: 100%;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      border-bottom: 2px solid #dbeafe;
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .title {
      font-size: 16px;
      font-weight: 700;
      margin: 0 0 4px;
    }
    .subtitle, .meta-text {
      font-size: 10px;
      color: #475569;
      line-height: 1.35;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 8px;
    }
    .summary-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 7px 9px;
      background: #f8fafc;
      page-break-inside: avoid;
    }
    .summary-label {
      font-size: 10px;
      color: #64748b;
      margin-bottom: 2px;
    }
    .summary-value {
      font-size: 11px;
      font-weight: 700;
      word-break: break-word;
    }
    .content-grid {
      display: grid;
      grid-template-columns: 180px minmax(0, 1fr);
      gap: 8px;
      align-items: flex-start;
    }
    .summary-panel {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #f8fafc;
      padding: 8px;
      page-break-inside: avoid;
    }
    .panel-title {
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .summary-tag {
      border: 1px solid #fbbf24;
      border-radius: 8px;
      background: #ffffff;
      padding: 6px 7px;
      margin-bottom: 6px;
    }
    .summary-tag-title {
      font-size: 11px;
      font-weight: 700;
      color: #9a3412;
    }
    .summary-tag-meta {
      margin-top: 2px;
      font-size: 10px;
      color: #475569;
    }
    .photo-panel {
      min-width: 0;
    }
    .photo-section {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 8px;
      page-break-inside: avoid;
    }
    .photo-section-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      padding: 7px 9px;
    }
    .photo-section-title {
      font-size: 12px;
      font-weight: 700;
    }
    .photo-section-count {
      min-width: 22px;
      height: 22px;
      border-radius: 999px;
      background: #fff7ed;
      color: #c2410c;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
    }
    .photo-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      padding: 8px;
    }
    .photo-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
      background: #ffffff;
      page-break-inside: avoid;
    }
    .photo-frame {
      margin: 0;
      background: #f8fafc;
      aspect-ratio: 4 / 3;
      overflow: hidden;
    }
    .photo-frame img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .photo-meta {
      padding: 7px;
      font-size: 10px;
      color: #475569;
      line-height: 1.35;
      word-break: break-word;
    }
    .photo-meta-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-bottom: 4px;
      color: #334155;
    }
    .photo-badge {
      font-size: 9px;
      border-radius: 999px;
      padding: 2px 6px;
      background: #e2e8f0;
    }
    .empty {
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
      background: #f8fafc;
      color: #64748b;
      padding: 12px;
      font-size: 10px;
      text-align: center;
    }
    @media print {
      .photo-section,
      .photo-card,
      .summary-panel {
        break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="header">
      <div>
        <h1 class="title">${escapeHtml(labels.title)}</h1>
        <div class="subtitle">${escapeHtml(labels.machine)}: ${escapeHtml(item.machine_name)}</div>
        <div class="subtitle">${escapeHtml(labels.date)}: ${escapeHtml(dayjs(date).format('YYYY-MM-DD'))}</div>
      </div>
      <div class="meta-text">${escapeHtml(labels.history)}: ${item.matching_report_count}</div>
    </header>

    <section class="summary-grid">
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.partNo)}</div>
        <div class="summary-value">${escapeHtml(item.part_nos.join(', ') || '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.plannedQty)}</div>
        <div class="summary-value">${item.planned_quantity.toLocaleString()}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.models)}</div>
        <div class="summary-value">${escapeHtml(item.model_names.join(', ') || '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.lots)}</div>
        <div class="summary-value">${escapeHtml(item.lot_nos.join(', ') || '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.latest)}</div>
        <div class="summary-value">${escapeHtml(item.latest_report_dt ? dayjs(item.latest_report_dt).format('YYYY-MM-DD') : '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.history)}</div>
        <div class="summary-value">${item.matching_report_count.toLocaleString()}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.selectedPhotos)}</div>
        <div class="summary-value">${selectedImages.length.toLocaleString()}</div>
      </div>
    </section>

    <section class="content-grid">
      <aside class="summary-panel">
        <div class="panel-title">${escapeHtml(labels.topPhenomena)}</div>
        ${summaryHtml}
      </aside>
      <div class="photo-panel">
        ${selectedHtml}
      </div>
    </section>
  </div>
  <script>
    window.onload = function () {
      setTimeout(function () {
        window.print();
      }, 120);
    };
    window.onafterprint = function () {
      window.close();
    };
  </script>
</body>
</html>`;
}

export default function DailyAttentionPage() {
  const { t, lang } = useLang();
  const [targetDate, setTargetDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, Record<string, boolean>>>({});
  const [printSelection, setPrintSelection] = useState<PrintSelectionState | null>(null);

  const noPhenomenonLabel = lang === 'zh' ? '未填写现象' : '현상 미입력';
  const expandAllLabel = lang === 'zh' ? '全部展开' : '모두 펼치기';
  const collapseAllLabel = lang === 'zh' ? '全部折叠' : '모두 접기';
  const rowsLabel = lang === 'zh' ? '行' : '행';
  const printLabel = lang === 'zh' ? 'A4 PDF / 打印' : 'A4 PDF / 인쇄';
  const printPickerTitle = lang === 'zh' ? '选择要打印的照片' : '인쇄할 사진 선택';
  const printPickerDescription = lang === 'zh' ? '勾选后只打印所选照片。' : '체크한 사진만 인쇄 문서에 포함됩니다.';
  const selectAllPhotosLabel = lang === 'zh' ? '全部选择' : '전체 선택';
  const clearSelectedPhotosLabel = lang === 'zh' ? '全部取消' : '전체 해제';
  const printSelectedPhotosLabel = lang === 'zh' ? '选择后打印' : '선택 후 인쇄';
  const closeLabel = lang === 'zh' ? '关闭' : '닫기';
  const selectedCountLabel = lang === 'zh' ? '已选照片' : '선택 사진';
  const noSelectableImagesLabel = lang === 'zh' ? '可选图片不存在，将摘要直接打印。' : '선택할 사진이 없어 요약만 인쇄됩니다.';
  const analysisCopy = lang === 'zh'
    ? {
        eyebrow: 'QUALITY INTELLIGENCE',
        title: '全历史质量分析报告',
        scope: '分析范围：与所选生产计划料号前 9 位匹配的全部质量历史',
        executive: '执行摘要',
        executiveDescription: '面向交接班的结论优先简报',
        priorities: '今日优先确认 3 项',
        prioritiesDescription: '直接显示历史问题、发生位置、近期变化与当前计划对象',
        plannedTarget: '计划对象',
        problemTypes: '问题类型',
        problemTypesDescription: '按原始记录现象独立分类 · 分析对象全部历史内占比',
        locations: '发生位置',
        locationsDescription: '按明确位置关键词独立分类 · 分析对象全部历史内占比 · 不与问题类型组合推断',
        repeatedTrend: '反复问题与近期变化',
        repeatedTrendDescription: '最近 30 天与此前 30 天使用相同分母口径比较',
        affectedTargets: '计划对象影响范围',
        affectedTargetsDescription: '仅显示与历史依据明确匹配的当前计划机台、机种与料号',
        machine: '机台',
        modelPart: '机种 / 料号',
        plannedQty: '计划数量',
        historicalSignals: '历史关注依据',
        evidence: '依据',
        analysisBasis: '依据与解读边界',
        allHistory: '全部历史',
        matchBasis: '料号前 9 位匹配',
        analysisDate: '分析基准日',
        latestRefresh: '最近更新',
        evidenceCount: '历史依据',
        latestEvidence: '最新历史依据',
        shiftChecks: '交接班确认',
        caveats: '解读注意',
        rawTitle: '照片与原始质量记录',
        rawDescription: '以下保留现有机台、料号、照片及原始记录，可用于追溯分析依据。',
        noCurrentDefect: '本报告基于历史质量记录与当前生产计划的匹配结果，不表示当前正在发生不良。',
        noReport: 'AI 报告尚不可用。下方继续显示现有计划与原始历史记录。',
        noNarrative: 'AI 文字分析尚未完成，当前先显示可审计的数据分析结果。',
        noMetrics: '没有可展示的分类指标。',
        noTargets: '当前计划中没有与分类指标明确关联的对象。',
        trendRule: '仅当数量和占比同时增加时标记为“增加”',
        sampleRule: '每个比较窗口分母至少 {denominator} 件，合计依据至少 {issues} 件',
        historySummary: '所选计划共 {plans} 组，{prefixes} 个料号前缀在全历史中匹配到 {matches} 条记录；{without} 组暂无历史匹配。',
        deterministicPriority: 'AI 文字生成期间，按可审计指标优先级显示。',
        repeatedLabel: '反复历史项',
        increaseLabel: '近期增加',
        fallbackLabel: '数据优先级',
        more: '等',
      }
    : {
        eyebrow: 'QUALITY INTELLIGENCE',
        title: '전체 이력 품질 분석 보고서',
        scope: '분석 범위: 선택한 생산계획 품번 앞 9자리에 매칭되는 품질 전체 이력',
        executive: 'Executive Summary',
        executiveDescription: '교대 전 확인을 위한 결론 우선 브리핑',
        priorities: '오늘 우선확인 3',
        prioritiesDescription: '역사 문제·발생 위치·최근 변화·현재 계획 대상을 직접 표시',
        plannedTarget: '계획 대상',
        problemTypes: '문제유형',
        problemTypesDescription: '원본 기록 현상을 독립 분류 · 분석 대상 전체 이력 내 비중',
        locations: '발생위치',
        locationsDescription: '명시된 위치 키워드를 독립 분류 · 분석 대상 전체 이력 내 비중 · 문제유형과 조합 추정하지 않음',
        repeatedTrend: '반복 문제 및 최근 변화',
        repeatedTrendDescription: '최근 30일과 이전 30일을 동일한 분모 기준으로 비교',
        affectedTargets: '계획 대상 모델·호기 영향',
        affectedTargetsDescription: '역사 근거와 명시적으로 매칭된 현재 계획의 설비·모델·품번만 표시',
        machine: '호기',
        modelPart: '모델 / 품번',
        plannedQty: '계획수량',
        historicalSignals: '역사 유의 근거',
        evidence: '근거',
        analysisBasis: '분석 근거 및 해석 범위',
        allHistory: '전체 이력',
        matchBasis: '품번 앞 9자리 매칭',
        analysisDate: '분석 기준일',
        latestRefresh: '최근 갱신',
        evidenceCount: '역사 근거',
        latestEvidence: '최근 역사 근거',
        shiftChecks: '교대 확인사항',
        caveats: '해석 유의사항',
        rawTitle: '사진 및 원본 품질 이력',
        rawDescription: '아래에는 기존 설비·품번별 사진과 원본 기록을 보존해 분석 근거를 추적할 수 있습니다.',
        noCurrentDefect: '이 보고서는 과거 품질 이력과 현재 생산계획의 매칭 결과이며, 현재 불량 발생을 의미하지 않습니다.',
        noReport: 'AI 분석 보고서를 아직 사용할 수 없습니다. 아래 기존 계획 및 원본 이력은 계속 제공합니다.',
        noNarrative: 'AI 문장 분석이 아직 완료되지 않아 감사 가능한 데이터 분석 결과를 먼저 표시합니다.',
        noMetrics: '표시할 분류 지표가 없습니다.',
        noTargets: '현재 계획에서 분류 지표와 명시적으로 연결된 대상이 없습니다.',
        trendRule: '건수와 비중이 함께 증가한 경우에만 ‘증가’로 표시',
        sampleRule: '비교 구간별 분모 {denominator}건 이상, 합산 근거 {issues}건 이상',
        historySummary: '선택 계획 {plans}개 그룹, 품번 접두어 {prefixes}개에 대해 전체 이력 {matches}건이 매칭되었고 {without}개 그룹은 매칭 이력이 없습니다.',
        deterministicPriority: 'AI 문장 생성 중에는 감사 가능한 지표 우선순위를 표시합니다.',
        repeatedLabel: '반복 역사 항목',
        increaseLabel: '최근 증가',
        fallbackLabel: '데이터 우선순위',
        more: '외',
      };

  const printLabels: PrintLabels = {
    title: t('quality.daily_attention_title'),
    machine: lang === 'zh' ? '注塑机' : '사출기',
    partNo: t('part_no'),
    plannedQty: t('quality.daily_attention_planned_qty'),
    models: lang === 'zh' ? '机种' : '모델',
    lots: 'LOT',
    history: t('quality.daily_attention_historical_reports'),
    none: t('quality.daily_attention_no_history'),
    latest: t('quality.daily_attention_latest_issue'),
    section: lang === 'zh' ? '区段' : '구분',
    action: lang === 'zh' ? '处理结果' : '처리 결과',
    date: t('date'),
    selectedPhotos: lang === 'zh' ? '选择照片数' : '선택 사진 수',
    topPhenomena: t('quality.daily_attention_top_phenomena'),
  };

  const { data, isLoading, isError, isFetching, refetch } = useQuery<DailyAttentionResponse>({
    queryKey: ['quality-daily-attention', targetDate],
    queryFn: async () => {
      const response = await api.get('/quality/daily-attention/', { params: { date: targetDate } });
      return response.data;
    },
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
  });

  const sortedItems = useMemo(() => {
    const items = data?.items ?? [];
    return [...items].sort((a, b) => {
      const machineA = a.machine_number ?? 999;
      const machineB = b.machine_number ?? 999;
      if (machineA !== machineB) return machineA - machineB;
      return (a.sequence ?? 999) - (b.sequence ?? 999);
    });
  }, [data]);

  const groupedPhenomenaMap = useMemo(() => {
    const map: Record<string, PhenomenonGroup[]> = {};
    sortedItems.forEach((item) => {
      const itemKey = `${item.machine_name}-${item.sequence}-${item.part_prefix}`;
      map[itemKey] = groupReportsByPhenomenon(item.reports, noPhenomenonLabel);
    });
    return map;
  }, [sortedItems, noPhenomenonLabel]);

  const report = data?.report ?? null;
  const deterministic = (
    data?.date === targetDate &&
    report?.deterministic?.schema_version === 'quality-daily-report.v1' &&
    report.deterministic.as_of_date === targetDate
  ) ? report.deterministic : null;
  const canUseNarrative = Boolean(
    report &&
    deterministic &&
    report.status === 'ready' &&
    report.narrative &&
    !report.llm_fallback &&
    data?.date === targetDate &&
    report.business_date === targetDate &&
    report.source_revision &&
    report.contract_version === 'quality-daily-public-report.v2' &&
    report.schema_version === 'quality-daily-page-report.v1' &&
    report.model_id === 'gemma4_26b_a4b' &&
    report.ai_schema_version === 'quality-daily-attention-ai.v1' &&
    report.deterministic_schema_version === 'quality-daily-report.v1' &&
    report.narrative.schema_version === 'quality-daily-report-narrative.v1',
  );
  const narrative = canUseNarrative ? report?.narrative ?? null : null;

  const allMetrics = useMemo<DimensionedMetric[]>(() => {
    if (!deterministic) return [];
    return [
      ...deterministic.problem_types.map((metric) => ({ ...metric, dimension: 'problem' as const })),
      ...deterministic.occurrence_locations.map((metric) => ({ ...metric, dimension: 'location' as const })),
    ];
  }, [deterministic]);

  const sortedAnalysisMetrics = useMemo(() => sortMetrics(allMetrics), [allMetrics]);
  const fallbackPriorityMetrics = sortedAnalysisMetrics.slice(0, 3);
  const narrativePriorities = useMemo(
    () => [...(narrative?.priorities ?? [])].sort((a, b) => a.priority_rank - b.priority_rank).slice(0, 3),
    [narrative],
  );
  const affectedTargetLookup = useMemo(
    () => new Map((narrative?.affected_targets ?? []).map((target) => [target.target_ref, target])),
    [narrative],
  );
  const trendNarrativeLookup = useMemo(() => {
    const map = new Map<string, string>();
    [...(narrative?.repeated_issues ?? []), ...(narrative?.accelerating_issues ?? [])].forEach((item) => {
      map.set(item.metric_key, localizedText(item.narrative, lang));
    });
    return map;
  }, [narrative, lang]);
  const narrativeRankedMetrics = useMemo(() => {
    const metricByKey = new Map(allMetrics.map((metric) => [metric.metric_key, metric]));
    const rankedKeys = [
      ...(narrative?.accelerating_issues ?? []).map((item) => item.metric_key),
      ...(narrative?.repeated_issues ?? []).map((item) => item.metric_key),
    ];
    const ranked = rankedKeys
      .map((metricKey) => metricByKey.get(metricKey))
      .filter((metric): metric is DimensionedMetric => Boolean(metric));
    const used = new Set(ranked.map((metric) => metric.metric_key));
    return [...ranked, ...sortedAnalysisMetrics.filter((metric) => !used.has(metric.metric_key))];
  }, [narrative, allMetrics, sortedAnalysisMetrics]);
  const narrativeMetricLookup = useMemo(
    () => new Map(allMetrics.map((metric) => [metric.metric_key, metric])),
    [allMetrics],
  );
  const priorityCards = useMemo(() => {
    if (narrativePriorities.length > 0) {
      return narrativePriorities.map((priority) => {
        const affectedTarget = affectedTargetLookup.get(priority.target_ref);
        const machineName = priority.machine_name || affectedTarget?.machine_name || '';
        const machineNumber = priority.machine_number ?? affectedTarget?.machine_number ?? null;
        const priorityModels = priority.model_names ?? [];
        const priorityParts = priority.part_nos ?? [];
        const modelNames = priorityModels.length > 0 ? priorityModels : affectedTarget?.model_names ?? [];
        const partNos = priorityParts.length > 0 ? priorityParts : affectedTarget?.part_nos ?? [];
        return {
          key: priority.target_ref,
          title: localizedText(affectedTarget?.headline ?? priority.headline, lang),
          checkpoints: priority.checkpoints[lang === 'zh' ? 'zh' : 'ko'].slice(0, 2),
          machineName,
          machineNumber,
          modelNames,
          partNos,
          metric: priority.primary_metric_key
            ? narrativeMetricLookup.get(priority.primary_metric_key) ?? null
            : findMetricForTarget(narrativeRankedMetrics, machineName, modelNames, partNos),
        };
      });
    }

    return fallbackPriorityMetrics.map((metric) => {
      const target = firstMetricTarget(metric);
      return {
        key: `${metric.dimension}-${metric.metric_key}`,
        title: localizedText(metric.label, lang),
        checkpoints: [] as string[],
        machineName: target?.machine_name ?? metric.impact_scope.machine_names[0] ?? '',
        machineNumber: null,
        modelNames: target?.model_name ? [target.model_name] : metric.impact_scope.model_names,
        partNos: target?.part_no ? [target.part_no] : metric.impact_scope.part_nos,
        metric,
      };
    });
  }, [
    narrativePriorities,
    affectedTargetLookup,
    fallbackPriorityMetrics,
    narrativeRankedMetrics,
    narrativeMetricLookup,
    lang,
  ]);
  const trendMetrics = useMemo(() => {
    const trendRank = (metric: DimensionedMetric) => {
      if (metric.trend.status === 'increase') return 3;
      if (metric.trend.status === 'stable_or_decrease') return 2;
      return 1;
    };
    return [...allMetrics]
      .sort((a, b) => {
        const rankDiff = trendRank(b) - trendRank(a);
        if (rankDiff !== 0) return rankDiff;
        if (b.evidence_count !== a.evidence_count) return b.evidence_count - a.evidence_count;
        return localizedText(a.label, lang).localeCompare(localizedText(b.label, lang));
      })
      .slice(0, 4);
  }, [allMetrics, lang]);

  const impactedTargets = useMemo(() => {
    const targetMap = new Map<
      string,
      {
        target: QualityPlanTarget;
        signals: Array<{ metric: DimensionedMetric; label: string }>;
      }
    >();

    sortedAnalysisMetrics.forEach((metric) => {
      metric.impact_scope.plan_targets.forEach((target) => {
        const key = [
          target.machine_name,
          target.sequence ?? '',
          target.model_name,
          target.part_no,
          target.lot_no,
          target.planned_quantity,
        ].join('|');
        const entry = targetMap.get(key) ?? { target, signals: [] };
        if (!entry.signals.some((signal) => signal.metric.metric_key === metric.metric_key)) {
          entry.signals.push({ metric, label: localizedText(metric.label, lang) });
        }
        targetMap.set(key, entry);
      });
    });

    return Array.from(targetMap.values()).sort((a, b) => {
      const machineDiff = a.target.machine_name.localeCompare(b.target.machine_name, undefined, { numeric: true });
      if (machineDiff !== 0) return machineDiff;
      return (a.target.sequence ?? 999) - (b.target.sequence ?? 999);
    });
  }, [sortedAnalysisMetrics, lang]);

  const isPhenomenonOpen = (itemKey: string, phenomenon: string) =>
    collapsedGroups[itemKey]?.[phenomenon] !== false;

  const togglePhenomenon = (itemKey: string, phenomenon: string) => {
    setCollapsedGroups((prev) => {
      const nextItem = { ...(prev[itemKey] ?? {}) };
      nextItem[phenomenon] = !isPhenomenonOpen(itemKey, phenomenon);
      return { ...prev, [itemKey]: nextItem };
    });
  };

  const setAllPhenomena = (itemKey: string, groups: PhenomenonGroup[], expanded: boolean) => {
    const nextState = groups.reduce<Record<string, boolean>>((acc, group) => {
      acc[group.phenomenon] = expanded;
      return acc;
    }, {});
    setCollapsedGroups((prev) => ({ ...prev, [itemKey]: nextState }));
  };

  const openPrintWindow = (item: DailyAttentionItem, groups: PhenomenonGroup[], selectedImages: PrintableImage[]) => {
    const printWindow = window.open('', '_blank', 'width=1200,height=900');
    if (!printWindow) return;

    const html = buildPrintDocumentHtml({
      date: targetDate,
      item,
      groups,
      selectedImages,
      labels: printLabels,
      noPhenomenonLabel,
    });

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
  };

  const handlePrintItem = (item: DailyAttentionItem, groups: PhenomenonGroup[]) => {
    const images = collectPrintableImages(groups);
    if (images.length === 0) {
      openPrintWindow(item, groups, []);
      return;
    }

    setPrintSelection({
      item,
      groups,
      images,
      selectedIds: images.map((image) => image.id),
    });
  };

  const togglePrintImage = (imageId: string) => {
    setPrintSelection((prev) => {
      if (!prev) return prev;
      const isSelected = prev.selectedIds.includes(imageId);
      return {
        ...prev,
        selectedIds: isSelected
          ? prev.selectedIds.filter((id) => id !== imageId)
          : [...prev.selectedIds, imageId],
      };
    });
  };

  const setAllPrintImages = (selected: boolean) => {
    setPrintSelection((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        selectedIds: selected ? prev.images.map((image) => image.id) : [],
      };
    });
  };

  const confirmPrintSelection = () => {
    if (!printSelection) return;
    const selectedImages = printSelection.images.filter((image) => printSelection.selectedIds.includes(image.id));
    openPrintWindow(printSelection.item, printSelection.groups, selectedImages);
    setPrintSelection(null);
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-gray-200 bg-gradient-to-r from-amber-50 to-white px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{t('quality.daily_attention_title')}</h1>
            <p className="text-sm text-gray-600">{t('quality.daily_attention_description')}</p>
          </div>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-end md:justify-between">
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('date')}</label>
              <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="w-[180px]" />
            </div>
            <Button type="button" variant="secondary" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? `${t('loading')}...` : t('search')}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <div className="text-slate-500">{t('quality.daily_attention_total_plans')}</div>
              <div className="text-xl font-bold text-slate-800">{data?.total_plan_count ?? 0}</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
              <div className="text-amber-700">{t('quality.daily_attention_total_matches')}</div>
              <div className="text-xl font-bold text-amber-800">{data?.total_matching_reports ?? 0}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
              <div className="text-emerald-700">{t('quality.daily_attention_without_history')}</div>
              <div className="text-xl font-bold text-emerald-800">{data?.without_history_count ?? 0}</div>
            </div>
          </div>
        </div>
      </section>

      {isLoading ? (
        <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center text-gray-500">{t('loading')}...</div>
      ) : isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-6 py-12 text-center text-red-600">{t('error_loading_data')}</div>
      ) : (
        <div className="space-y-8">
          <section className="overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-sm">
            <div className="relative overflow-hidden bg-gradient-to-br from-slate-950 via-blue-950 to-blue-800 px-5 py-6 text-white sm:px-7 lg:px-8">
              <div className="absolute -right-20 -top-28 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
              <div className="absolute bottom-0 right-1/4 h-32 w-32 rounded-full bg-blue-300/10 blur-2xl" />
              <div className="relative flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-4xl">
                  <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-cyan-200">
                    <BrainCircuit className="h-4 w-4" />
                    {analysisCopy.eyebrow}
                  </div>
                  <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{analysisCopy.title}</h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-blue-100">{analysisCopy.scope}</p>
                </div>
                <div className="flex flex-col items-start gap-2 xl:items-end">
                  <ReportStatusBadge report={report} lang={lang} narrativeReady={canUseNarrative} />
                </div>
              </div>

              <div className="relative mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-sm text-blue-50 backdrop-blur-sm">
                <span className="inline-flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-cyan-200" />
                  {analysisCopy.analysisDate} <strong className="font-semibold text-white">{report?.business_date ?? targetDate}</strong>
                </span>
                <span className="hidden h-4 w-px bg-white/20 sm:block" />
                <span className="inline-flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-cyan-200" />
                  {analysisCopy.latestRefresh} <strong className="font-semibold text-white">{formatReportDateTime(canUseNarrative ? report?.completed_at ?? report?.generated_at : deterministic?.calculated_at)}</strong>
                </span>
                <span className="hidden h-4 w-px bg-white/20 sm:block" />
                <span className="inline-flex items-center gap-2">
                  <Database className="h-4 w-4 text-cyan-200" />
                  {analysisCopy.evidenceCount} <strong className="font-semibold tabular-nums text-white">{formatMetricNumber(deterministic?.coverage.matched_report_count)}</strong>
                </span>
              </div>
            </div>

            {!deterministic ? (
              <div className="m-5 rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center text-sm text-slate-600 sm:m-7">
                <Database className="mx-auto mb-3 h-7 w-7 text-slate-400" />
                {analysisCopy.noReport}
              </div>
            ) : (
              <div className="space-y-6 p-5 sm:p-7 lg:p-8">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    {
                      label: lang === 'zh' ? '计划组' : '계획 그룹',
                      value: deterministic.coverage.plan_group_count,
                      sub: `${lang === 'zh' ? '料号前缀' : '품번 접두어'} ${formatMetricNumber(deterministic.coverage.distinct_prefix_count)}`,
                      icon: Layers3,
                      color: 'text-blue-700 bg-blue-50',
                    },
                    {
                      label: lang === 'zh' ? '全历史匹配记录' : '전체 이력 매칭',
                      value: deterministic.coverage.matched_report_count,
                      sub: `${analysisCopy.latestEvidence} ${formatReportDate(deterministic.coverage.latest_report_dt)}`,
                      icon: Database,
                      color: 'text-indigo-700 bg-indigo-50',
                    },
                    {
                      label: lang === 'zh' ? '无历史匹配计划组' : '매칭 이력 없는 계획',
                      value: deterministic.coverage.without_history_count,
                      sub: analysisCopy.noCurrentDefect,
                      icon: ShieldCheck,
                      color: 'text-emerald-700 bg-emerald-50',
                    },
                    {
                      label: lang === 'zh' ? '分类维度' : '분류 차원',
                      value: deterministic.coverage.problem_type_count + deterministic.coverage.occurrence_location_count,
                      sub: `${analysisCopy.problemTypes} ${formatMetricNumber(deterministic.coverage.problem_type_count)} · ${analysisCopy.locations} ${formatMetricNumber(deterministic.coverage.occurrence_location_count)}`,
                      icon: BarChart3,
                      color: 'text-violet-700 bg-violet-50',
                    },
                  ].map((summary) => {
                    const Icon = summary.icon;
                    return (
                      <article key={summary.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs font-medium text-slate-500">{summary.label}</div>
                            <div className="mt-1 text-3xl font-bold tabular-nums text-slate-950">{formatMetricNumber(summary.value)}</div>
                          </div>
                          <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${summary.color}`}>
                            <Icon className="h-5 w-5" />
                          </div>
                        </div>
                        <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500" title={summary.sub}>{summary.sub}</p>
                      </article>
                    );
                  })}
                </div>

                <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
                  <section className="relative overflow-hidden rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-cyan-50 p-6 shadow-sm">
                    <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-cyan-200/30 blur-2xl" />
                    <div className="relative">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-700 text-white shadow-sm">
                          <Sparkles className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="text-lg font-bold text-slate-950">{analysisCopy.executive}</h3>
                          <p className="text-xs text-slate-500">{analysisCopy.executiveDescription}</p>
                        </div>
                      </div>

                      <p className="mt-5 text-[15px] font-medium leading-7 text-slate-800">
                        {narrative
                          ? localizedText(narrative.executive_summary, lang)
                          : analysisCopy.historySummary
                              .replace('{plans}', formatMetricNumber(deterministic.coverage.plan_group_count))
                              .replace('{prefixes}', formatMetricNumber(deterministic.coverage.distinct_prefix_count))
                              .replace('{matches}', formatMetricNumber(deterministic.coverage.matched_report_count))
                              .replace('{without}', formatMetricNumber(deterministic.coverage.without_history_count))}
                      </p>

                      {!narrative && (
                        <div className="mt-4 rounded-xl border border-blue-100 bg-white/80 px-4 py-3 text-sm leading-6 text-blue-800">
                          {analysisCopy.noNarrative}
                        </div>
                      )}

                      {narrative && narrative.shift_checks[lang === 'zh' ? 'zh' : 'ko'].length > 0 && (
                        <div className="mt-5 border-t border-blue-100 pt-4">
                          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-blue-700">{analysisCopy.shiftChecks}</div>
                          <ul className="space-y-2 text-sm leading-6 text-slate-700">
                            {narrative.shift_checks[lang === 'zh' ? 'zh' : 'ko'].slice(0, 3).map((check, index) => (
                              <li key={`${check}-${index}`} className="flex gap-2">
                                <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-blue-600" />
                                <span>{check}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <div className="mb-5 flex items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                        <Target className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-slate-950">{analysisCopy.priorities}</h3>
                        <p className="text-xs leading-5 text-slate-500">{analysisCopy.prioritiesDescription}</p>
                      </div>
                    </div>

                    {priorityCards.length > 0 ? (
                      <div className="grid gap-3 lg:grid-cols-3">
                        {priorityCards.map((priority, index) => {
                          const metric = priority.metric;
                          const dimension = metric ? metricDimensionLabel(metric, lang) : analysisCopy.plannedTarget;
                          const trendClass = metric?.trend.status === 'increase'
                            ? 'bg-rose-50 text-rose-700 ring-rose-200'
                            : 'bg-slate-100 text-slate-600 ring-slate-200';
                          const displayedModel = priority.modelNames[0] ?? '';
                          const displayedPart = priority.partNos[0] ?? '';
                          const additionalModelCount = Math.max(0, priority.modelNames.length - 1);
                          const additionalPartCount = Math.max(0, priority.partNos.length - 1);

                          return (
                            <article key={priority.key} className="flex min-h-[250px] flex-col rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50/80 p-4 shadow-sm">
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-950 text-sm font-bold text-white">{index + 1}</div>
                                <div className="flex flex-wrap justify-end gap-1.5">
                                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-500 ring-1 ring-inset ring-slate-200">{dimension}</span>
                                  {metric && <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${trendClass}`}>{metricTrendLabel(metric, lang)}</span>}
                                </div>
                              </div>
                              {metric && (
                                <div className="mt-4">
                                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{dimension}</div>
                                  <h4 className="mt-1 text-xl font-bold leading-7 text-slate-950">{localizedText(metric.label, lang) || '-'}</h4>
                                </div>
                              )}
                              {!metric && <h4 className="mt-4 text-lg font-bold leading-7 text-slate-950">{priority.title || '-'}</h4>}
                              {priority.checkpoints.length > 0 ? (
                                <ul className="mt-3 space-y-2 text-sm leading-5 text-slate-600">
                                  {priority.checkpoints.map((checkpoint, checkpointIndex) => (
                                    <li key={`${checkpoint}-${checkpointIndex}`} className="flex gap-2">
                                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                                      <span>{checkpoint}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mt-3 text-sm leading-6 text-slate-600">{metric ? analysisCopy.deterministicPriority : priority.title}</p>
                              )}
                              <div className="mt-auto border-t border-slate-200 pt-3 text-xs leading-5 text-slate-500">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-semibold text-slate-900">
                                    {priority.machineName || '-'}{priority.machineNumber != null ? ` · ${priority.machineNumber}` : ''}
                                  </span>
                                  {metric && (
                                    <strong className="tabular-nums text-slate-800">
                                      {analysisCopy.evidence} {formatMetricNumber(metric.evidence_count)} · {formatMetricPercent(metric.all_history_share_pct)}
                                    </strong>
                                  )}
                                </div>
                                <div className="mt-1 line-clamp-2" title={[...priority.modelNames, ...priority.partNos].join(', ')}>
                                  {displayedModel || '-'}{additionalModelCount > 0 ? ` ${analysisCopy.more} ${additionalModelCount}` : ''}
                                  {' · '}
                                  {displayedPart || '-'}{additionalPartCount > 0 ? ` ${analysisCopy.more} ${additionalPartCount}` : ''}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                        {analysisCopy.noMetrics}
                      </div>
                    )}
                  </section>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  <MetricBarPanel
                    title={analysisCopy.problemTypes}
                    subtitle={analysisCopy.problemTypesDescription}
                    metrics={[...deterministic.problem_types].sort((a, b) => b.evidence_count - a.evidence_count)}
                    lang={lang}
                    dimension="problem"
                  />
                  <MetricBarPanel
                    title={analysisCopy.locations}
                    subtitle={analysisCopy.locationsDescription}
                    metrics={[...deterministic.occurrence_locations].sort((a, b) => b.evidence_count - a.evidence_count)}
                    lang={lang}
                    dimension="location"
                  />
                </div>

                <section>
                  <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-5 w-5 text-rose-600" />
                        <h3 className="text-lg font-bold text-slate-950">{analysisCopy.repeatedTrend}</h3>
                      </div>
                      <p className="mt-1 text-sm text-slate-500">{analysisCopy.repeatedTrendDescription}</p>
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatReportDate(deterministic.trend_policy.previous_start)}–{formatReportDate(deterministic.trend_policy.previous_end)}
                      <span className="px-2">vs</span>
                      {formatReportDate(deterministic.trend_policy.recent_start)}–{formatReportDate(deterministic.trend_policy.recent_end)}
                    </div>
                  </div>
                  {trendMetrics.length > 0 ? (
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      {trendMetrics.map((metric) => (
                        <TrendMetricCard
                          key={`trend-${metric.dimension}-${metric.metric_key}`}
                          metric={metric}
                          lang={lang}
                          narrative={trendNarrativeLookup.get(metric.metric_key)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
                      {analysisCopy.noMetrics}
                    </div>
                  )}
                </section>

                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="flex flex-col gap-2 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <Factory className="h-5 w-5 text-blue-700" />
                        <h3 className="font-bold text-slate-950">{analysisCopy.affectedTargets}</h3>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{analysisCopy.affectedTargetsDescription}</p>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold tabular-nums text-slate-700 ring-1 ring-inset ring-slate-200">
                      {formatMetricNumber(impactedTargets.length)}
                    </span>
                  </div>
                  {impactedTargets.length === 0 ? (
                    <div className="px-5 py-10 text-center text-sm text-slate-500">{analysisCopy.noTargets}</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-[900px] w-full text-left text-sm">
                        <thead className="bg-white text-xs uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-5 py-3 font-semibold">{analysisCopy.machine}</th>
                            <th className="px-5 py-3 font-semibold">{analysisCopy.modelPart}</th>
                            <th className="px-5 py-3 text-right font-semibold">{analysisCopy.plannedQty}</th>
                            <th className="px-5 py-3 font-semibold">{analysisCopy.historicalSignals}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {impactedTargets.map(({ target, signals }) => (
                            <tr key={[target.machine_name, target.sequence, target.model_name, target.part_no, target.lot_no].join('|')} className="align-top hover:bg-slate-50/70">
                              <td className="whitespace-nowrap px-5 py-4 font-semibold text-slate-900">
                                {target.machine_name || '-'}
                                {target.sequence != null && <span className="ml-2 text-xs font-normal text-slate-400">#{target.sequence}</span>}
                              </td>
                              <td className="px-5 py-4">
                                <div className="font-medium text-slate-900">{target.model_name || '-'}</div>
                                <div className="mt-1 font-mono text-xs text-slate-500">{target.part_no || '-'}{target.lot_no ? ` · LOT ${target.lot_no}` : ''}</div>
                              </td>
                              <td className="px-5 py-4 text-right font-semibold tabular-nums text-slate-900">{formatMetricNumber(target.planned_quantity)}</td>
                              <td className="px-5 py-4">
                                <div className="flex flex-wrap gap-2">
                                  {signals.map(({ metric, label }) => (
                                    <span key={`${metric.dimension}-${metric.metric_key}`} className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                                      <span className={`h-1.5 w-1.5 rounded-full ${metric.dimension === 'problem' ? 'bg-blue-500' : 'bg-violet-500'}`} />
                                      {label || '-'}
                                      <strong className="tabular-nums">{formatMetricNumber(metric.evidence_count)}</strong>
                                    </span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                      <ShieldCheck className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-slate-950">{analysisCopy.analysisBasis}</h3>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium text-slate-600">
                        <span className="rounded-full bg-slate-100 px-3 py-1.5">{analysisCopy.allHistory}</span>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5">{analysisCopy.matchBasis}</span>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5">{analysisCopy.trendRule}</span>
                      </div>
                      <div className="mt-4 grid gap-4 text-sm leading-6 text-slate-600 lg:grid-cols-2">
                        <div className="space-y-2">
                          <p className="flex gap-2">
                            <CircleAlert className="mt-1 h-4 w-4 shrink-0 text-amber-600" />
                            <span>{analysisCopy.noCurrentDefect}</span>
                          </p>
                          <p className="flex gap-2">
                            <CircleAlert className="mt-1 h-4 w-4 shrink-0 text-amber-600" />
                            <span>
                              {analysisCopy.sampleRule
                                .replace('{denominator}', formatMetricNumber(deterministic.trend_policy.min_window_denominator))
                                .replace('{issues}', formatMetricNumber(deterministic.trend_policy.min_combined_issue_count))}
                            </span>
                          </p>
                          {localizedText(report?.disclaimer, lang) && (
                            <p className="flex gap-2">
                              <Database className="mt-1 h-4 w-4 shrink-0 text-blue-600" />
                              <span>{localizedText(report?.disclaimer, lang)}</span>
                            </p>
                          )}
                        </div>
                        {narrative && narrative.caveats[lang === 'zh' ? 'zh' : 'ko'].length > 0 && (
                          <div>
                            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{analysisCopy.caveats}</div>
                            <ul className="space-y-2">
                              {narrative.caveats[lang === 'zh' ? 'zh' : 'ko'].map((caveat, index) => (
                                <li key={`${caveat}-${index}`} className="flex gap-2">
                                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                                  <span>{caveat}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            )}
          </section>

          <div className="flex items-start gap-3 px-1">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <FolderOpen className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-950">{analysisCopy.rawTitle}</h2>
              <p className="mt-1 text-sm text-slate-500">{analysisCopy.rawDescription}</p>
            </div>
          </div>

          {sortedItems.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center text-gray-500">{t('no_data')}</div>
          ) : (
            <div className="space-y-4">
              {sortedItems.map((item) => {
            const itemKey = `${item.machine_name}-${item.sequence}-${item.part_prefix}`;
            const phenomenonGroups = groupedPhenomenaMap[itemKey] ?? [];

            return (
              <section key={itemKey} className="rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="flex flex-col gap-3 border-b border-gray-200 bg-gradient-to-r from-slate-50 to-white px-4 py-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-lg font-semibold text-slate-900">
                      {item.machine_name} / {item.part_nos.join(', ')}
                    </div>
                    <div className="mt-1 text-sm text-slate-600">
                      {(item.model_names.length > 0 ? item.model_names.join(', ') : '-')} | {t('quality.daily_attention_planned_qty')}: {item.planned_quantity.toLocaleString()}
                      {item.lot_nos.length > 0 ? ` | LOT ${item.lot_nos.join(', ')}` : ''}
                      {item.plan_row_count > 1 ? ` | ${item.plan_row_count} ${rowsLabel}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
                      {t('quality.daily_attention_focus_prefix')}: {item.part_prefix || '-'}
                    </span>
                    <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-800">
                      {t('quality.daily_attention_matching_reports')}: {item.matching_report_count}
                    </span>
                    <span className="rounded-full bg-blue-100 px-3 py-1 font-medium text-blue-800">
                      {t('quality.daily_attention_latest_issue')}: {item.latest_report_dt ? dayjs(item.latest_report_dt).format('YYYY-MM-DD') : '-'}
                    </span>
                    <Button type="button" variant="secondary" onClick={() => handlePrintItem(item, phenomenonGroups)} className="gap-2">
                      <Printer className="h-4 w-4" />
                      {printLabel}
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 px-4 py-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                      <FolderOpen className="h-4 w-4" />
                      {t('quality.daily_attention_top_phenomena')}
                    </div>
                    {phenomenonGroups.length === 0 ? (
                      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-4 text-sm text-emerald-700">
                        {t('quality.daily_attention_no_history')}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {phenomenonGroups.map((group) => (
                          <div key={`${itemKey}-${group.phenomenon}`} className="rounded-lg border border-amber-200 bg-white px-3 py-2">
                            <div className="font-medium text-amber-900">{group.phenomenon}</div>
                            <div className="mt-1 text-sm text-amber-700">
                              {group.totalCount} | {formatSectionCounts(group.sectionCounts)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <CalendarDays className="h-4 w-4" />
                        {t('quality.daily_attention_historical_reports')} ({item.reports.length})
                      </div>
                      {phenomenonGroups.length > 0 && (
                        <div className="flex items-center gap-2">
                          <Button type="button" variant="secondary" onClick={() => setAllPhenomena(itemKey, phenomenonGroups, true)}>
                            {expandAllLabel}
                          </Button>
                          <Button type="button" variant="secondary" onClick={() => setAllPhenomena(itemKey, phenomenonGroups, false)}>
                            {collapseAllLabel}
                          </Button>
                        </div>
                      )}
                    </div>

                    {phenomenonGroups.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
                        {t('quality.daily_attention_no_history')}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {phenomenonGroups.map((group) => {
                          const isOpen = isPhenomenonOpen(itemKey, group.phenomenon);
                          return (
                            <section key={`${itemKey}-${group.phenomenon}`} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                              <button
                                type="button"
                                onClick={() => togglePhenomenon(itemKey, group.phenomenon)}
                                className="flex w-full items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-left"
                              >
                                <div>
                                  <div className="font-semibold text-slate-900">{group.phenomenon}</div>
                                  <div className="mt-1 text-sm text-slate-600">
                                    {group.totalCount} | {formatSectionCounts(group.sectionCounts)}
                                  </div>
                                </div>
                                {isOpen ? <ChevronDown className="h-5 w-5 text-slate-500" /> : <ChevronRight className="h-5 w-5 text-slate-500" />}
                              </button>

                              {isOpen && (
                                <div className="grid gap-3 border-t border-gray-200 p-4 md:grid-cols-2 xl:grid-cols-3">
                                  {group.reports.map((report) => (
                                    <article key={report.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                                      <div className="aspect-[4/3] bg-gray-100">
                                        {report.images.length > 0 ? (
                                          <img src={report.images[0]} alt={report.phenomenon || report.part_no} className="h-full w-full object-cover" />
                                        ) : (
                                          <div className="flex h-full items-center justify-center text-sm text-gray-400">
                                            {t('quality.daily_attention_no_image')}
                                          </div>
                                        )}
                                      </div>
                                      <div className="space-y-2 px-3 py-3 text-sm">
                                        <div className="flex items-center justify-between gap-2">
                                          <div className="font-semibold text-slate-900">{report.phenomenon || noPhenomenonLabel}</div>
                                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                                            {normalizeSection(report.section)}
                                          </span>
                                        </div>
                                        <div className="text-slate-600">{dayjs(report.report_dt).format('YYYY-MM-DD')} | {report.section}</div>
                                        <div className="text-slate-600">{report.part_no}</div>
                                        <div className="line-clamp-3 text-slate-700">{report.disposition || report.action_result || '-'}</div>
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
              })}
            </div>
          )}
        </div>
      )}

      {printSelection && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">{printPickerTitle}</h2>
                  <p className="mt-1 text-sm text-slate-600">{printPickerDescription}</p>
                  <p className="mt-2 text-sm font-medium text-slate-800">
                    {printSelection.item.machine_name} / {printSelection.item.part_nos.join(', ')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
                    {selectedCountLabel}: {printSelection.selectedIds.length} / {printSelection.images.length}
                  </span>
                  <Button type="button" variant="secondary" onClick={() => setAllPrintImages(true)}>
                    {selectAllPhotosLabel}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setAllPrintImages(false)}>
                    {clearSelectedPhotosLabel}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {printSelection.images.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                  {noSelectableImagesLabel}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {printSelection.images.map((image) => {
                    const isSelected = printSelection.selectedIds.includes(image.id);
                    return (
                      <label
                        key={image.id}
                        className={`overflow-hidden rounded-xl border transition ${
                          isSelected
                            ? 'border-blue-400 bg-blue-50/60 shadow-sm'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <div className="relative aspect-[4/3] bg-slate-100">
                          <img src={image.imageUrl} alt={image.phenomenon} className="h-full w-full object-cover" />
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => togglePrintImage(image.id)}
                            className="absolute left-3 top-3 h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                        </div>
                        <div className="space-y-1 px-4 py-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-slate-900">{image.phenomenon || noPhenomenonLabel}</div>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                              {normalizeSection(image.section)}
                            </span>
                          </div>
                          <div className="text-slate-600">{dayjs(image.reportDt).format('YYYY-MM-DD')}</div>
                          <div className="text-slate-600">{image.partNo || '-'}</div>
                          <div className="line-clamp-2 text-slate-700">{image.disposition || image.actionResult || '-'}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <Button type="button" variant="secondary" onClick={() => setPrintSelection(null)}>
                {closeLabel}
              </Button>
              <Button type="button" onClick={confirmPrintSelection} disabled={printSelection.selectedIds.length === 0 && printSelection.images.length > 0}>
                {printSelectedPhotosLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
