import React from 'react';
import {
  ResponsiveContainer,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Area,
  AreaChart,
} from 'recharts';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useAssemblyReports } from '@/hooks/useAssemblyReports';
import { usePeriod } from '@/contexts/PeriodContext';
import { useLang } from '@/i18n';
import dayjs from 'dayjs';
import type { AssemblyReport } from '@/types/assembly';

const DETAIL_LABEL_KEY_MAP: Record<string, string> = {
  scratch: 'def_scratch',
  black_dot: 'def_black_dot',
  eaten_meat: 'def_eaten_meat',
  air_mark: 'def_air_mark',
  deform: 'def_deform',
  short_shot: 'def_short_shot',
  broken_pillar: 'def_broken_pillar',
  flow_mark: 'def_flow_mark',
  sink_mark: 'def_sink_mark',
  whitening: 'def_whitening',
  printing: 'def_printing',
  rework: 'def_rework',
  other: 'def_other',
  processing_other: 'def_processing_other',
  incoming_other: 'def_incoming_other',
};

const round1 = (value: number) => Math.round(value * 10) / 10;

interface AggregatedMetrics {
  totalPlan: number;
  totalActual: number;
  totalDefect: number;
  totalRework: number;
  operationMinutes: number;
  workerMinutes: number;
  achievementRate: number;
  qualityRate: number;
  defectRate: number;
  reworkRate: number;
  uph: number | null;
  upph: number | null;
}

const computeAggregates = (entries: AssemblyReport[]) => {
  if (!entries.length) return null;

  const totals = entries.reduce(
    (acc, item) => {
      const plan = item.plan_qty || 0;
      const actual = item.actual_qty || 0;
      const rework = item.rework_qty || 0;
      const processing = item.processing_defect || 0;
      const outsourcing = item.outsourcing_defect || 0;
      const injection = item.injection_defect || 0;
      const totalDefect = processing + outsourcing + injection;

      acc.totalPlan += plan;
      acc.totalActual += actual;
      acc.totalRework += rework;
      acc.totalDefect += totalDefect;
      acc.operationMinutes += item.operation_time || 0;
      const workers = item.workers ?? 0;
      acc.workerMinutes += (item.operation_time || 0) * (workers || 0);
      return acc;
    },
    {
      totalPlan: 0,
      totalActual: 0,
      totalDefect: 0,
      totalRework: 0,
      operationMinutes: 0,
      workerMinutes: 0,
    }
  );

  const totalQty = totals.totalActual + totals.totalDefect;
  const achievementRate = totals.totalPlan > 0 ? round1((totals.totalActual / totals.totalPlan) * 100) : 0;
  const qualityRate = totalQty > 0 ? round1((totals.totalActual / totalQty) * 100) : 0;
  const defectRate = totalQty > 0 ? round1((totals.totalDefect / totalQty) * 100) : 0;
  const reworkRate = (totals.totalActual + totals.totalRework) > 0 ? round1((totals.totalRework / (totals.totalActual + totals.totalRework)) * 100) : 0;
  const uph = totals.operationMinutes > 0 ? round1(totals.totalActual / (totals.operationMinutes / 60)) : null;
  const upph = totals.workerMinutes > 0 ? round1(totals.totalActual / (totals.workerMinutes / 60)) : null;

  return {
    totalPlan: totals.totalPlan,
    totalActual: totals.totalActual,
    totalDefect: totals.totalDefect,
    totalRework: totals.totalRework,
    operationMinutes: totals.operationMinutes,
    workerMinutes: totals.workerMinutes,
    achievementRate,
    qualityRate,
    defectRate,
    reworkRate,
    uph,
    upph,
  } satisfies AggregatedMetrics;
};

export default function AssemblyDashboard() {
  const { data: assemblyData } = useAssemblyReports();
  const { startDate, endDate, excludeWeekends } = usePeriod();
  const { t } = useLang();
  const isLiteMode = document.documentElement.classList.contains('lite-mode');

  const formatDetailLabel = React.useCallback(
    (key: string) => {
      const normalized = key.replace(/[-\s]+/g, '_').toLowerCase();
      const translationKey = DETAIL_LABEL_KEY_MAP[normalized];
      if (translationKey) return t(translationKey as any);
      return normalized
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    },
    [t]
  );

  const records = React.useMemo(() => assemblyData?.results ?? [], [assemblyData]);

  const uniqueDates = React.useMemo(() => {
    if (!records.length) return { minDate: '', maxDate: '' };
    const sortedDates = [...new Set(records.map(r => r.date))].sort();
    return { minDate: sortedDates[0], maxDate: sortedDates[sortedDates.length - 1] };
  }, [records]);

  const filteredRecords = React.useMemo(() => {
    if (!records.length) return [];
    return records.filter((record) => {
      if (startDate && record.date < startDate) return false;
      if (endDate && record.date > endDate) return false;
      if (excludeWeekends) {
        const day = dayjs(record.date).day();
        if (day === 0 || day === 6) return false;
      }
      return true;
    });
  }, [records, startDate, endDate, excludeWeekends]);

  const overallMetrics = React.useMemo(() => computeAggregates(records), [records]);
  const rangeMetrics = React.useMemo(() => computeAggregates(filteredRecords), [filteredRecords]);

  const rangeLabel = startDate && endDate ? `${startDate} ~ ${endDate}` : '';
  const overallLabel =
    uniqueDates.minDate && uniqueDates.maxDate ? `${uniqueDates.minDate} ~ ${uniqueDates.maxDate}` : '';

  const chartData = React.useMemo(() => {
    const groups = new Map<string, AssemblyReport[]>();
    filteredRecords.forEach((report) => {
      if (!groups.has(report.date)) {
        groups.set(report.date, []);
      }
      groups.get(report.date)!.push(report);
    });

    return Array.from(groups.entries())
      .map(([date, dayRecords]) => {
        const metrics = computeAggregates(dayRecords);
        const totals = dayRecords.reduce(
          (acc, item) => {
            acc.plan += item.plan_qty || 0;
            acc.actual += item.actual_qty || 0;
            acc.defect += (item.injection_defect || 0) + (item.outsourcing_defect || 0) + (item.processing_defect || 0);
            return acc;
          },
          { plan: 0, actual: 0, defect: 0 }
        );

        return {
          date,
          plan: totals.plan,
          actual: totals.actual,
          defect: totals.defect,
          achievement: metrics?.achievementRate ?? 0,
          quality: metrics?.qualityRate ?? 0,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredRecords]);

  const defectBreakdown = React.useMemo(() => {
    if (!filteredRecords.length) {
      return { total: 0, items: [] as Array<{ key: string; label: string; value: number; percent: number }> };
    }

    const totals = filteredRecords.reduce(
      (acc, item) => {
        acc.processing += item.processing_defect || 0;
        acc.outsourcing += item.outsourcing_defect || 0;
        acc.injection += item.injection_defect || 0;
        return acc;
      },
      { processing: 0, outsourcing: 0, injection: 0 }
    );

    const total = totals.processing + totals.outsourcing + totals.injection;
    if (total === 0) {
      return { total: 0, items: [] as Array<{ key: string; label: string; value: number; percent: number }> };
    }

    const items = [
      { key: 'processing', label: t('analysis_defect_processing'), value: totals.processing },
      { key: 'outsourcing', label: t('analysis_defect_outsourcing'), value: totals.outsourcing },
      { key: 'injection', label: t('analysis_defect_injection'), value: totals.injection },
    ].filter(item => item.value > 0);

    return {
      total,
      items: items.map(item => ({
        ...item,
        percent: round1((item.value / total) * 100),
      })),
    };
  }, [filteredRecords, t]);

  const assemblyChartColors = {
    planArea: isLiteMode ? '#fb923c' : '#f97316',
    actualArea: isLiteMode ? '#f87171' : '#ec4899',
    achievementLine: isLiteMode ? '#0ea5e9' : '#0ea5e9',
    qualityLine: isLiteMode ? '#22c55e' : '#22c55e',
  } as const;

  const processingDetailTotals = React.useMemo(() => {
    const acc = new Map<string, number>();
    filteredRecords.forEach((report) => {
      const details = report.processing_defects_detail || {};
      Object.entries(details).forEach(([key, value]) => {
        const qty = Number(value || 0);
        if (!qty) return;
        acc.set(key, (acc.get(key) ?? 0) + qty);
      });
    });
    return Array.from(acc.entries())
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, label: formatDetailLabel(key), value }));
  }, [filteredRecords, formatDetailLabel]);

  const outsourcingDetailTotals = React.useMemo(() => {
    const acc = new Map<string, number>();
    filteredRecords.forEach((report) => {
      const dynamic = Array.isArray(report.outsourcing_defects_dynamic)
        ? (report.outsourcing_defects_dynamic as any[])
        : [];
      dynamic.forEach((item) => {
        const typeLabel = String(item?.type || item?.label || '').trim();
        const qty = Number(item?.quantity ?? item?.qty ?? 0);
        if (!typeLabel || !qty) return;
        acc.set(typeLabel, (acc.get(typeLabel) ?? 0) + qty);
      });
    });
    return Array.from(acc.entries())
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, label: key, value }));
  }, [filteredRecords]);

  const incomingDetailTotals = React.useMemo(() => {
    const acc = new Map<string, number>();
    filteredRecords.forEach((report) => {
      const details = report.incoming_defects_detail || {};
      Object.entries(details).forEach(([key, value]) => {
        const qty = Number(value || 0);
        if (!qty) return;
        acc.set(key, (acc.get(key) ?? 0) + qty);
      });
    });
    return Array.from(acc.entries())
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, label: formatDetailLabel(key), value }));
  }, [filteredRecords, formatDetailLabel]);

  const noRangeData = !rangeMetrics || chartData.length === 0;
  const defectColors: Record<string, string> = {
    processing: '#f97316',
    outsourcing: '#6366f1',
    injection: '#ef4444',
  };

  const defectDetailTree = React.useMemo(() => {
    if (!defectBreakdown.total)
      return [] as Array<{
        key: string;
        label: string;
        total: number;
        percentOfTotal: number;
        children: Array<{
          key: string;
          label: string;
          value: number;
          percentOfCategory: number;
          percentOfTotal: number;
        }>;
      }>;

    const nodes: Array<{
      key: string;
      label: string;
      total: number;
      percentOfTotal: number;
      children: Array<{
        key: string;
        label: string;
        value: number;
        percentOfCategory: number;
        percentOfTotal: number;
      }>;
    }> = [];

    const totalByKey = Object.fromEntries(defectBreakdown.items.map((item) => [item.key, item.value]));

    const makeChildren = (
      list: Array<{ key: string; label: string; value: number }>,
      categoryTotal: number
    ) =>
      list.map((item) => ({
        ...item,
        percentOfCategory: categoryTotal > 0 ? round1((item.value / categoryTotal) * 100) : 0,
        percentOfTotal: defectBreakdown.total > 0 ? round1((item.value / defectBreakdown.total) * 100) : 0,
      }));

    if (processingDetailTotals.length) {
      const total = totalByKey.processing ?? processingDetailTotals.reduce((sum, item) => sum + item.value, 0);
      nodes.push({
        key: 'processing',
        label: t('analysis_defect_processing'),
        total,
        percentOfTotal: total > 0 ? round1((total / defectBreakdown.total) * 100) : 0,
        children: makeChildren(processingDetailTotals, total),
      });
    }

    if (outsourcingDetailTotals.length) {
      const total = totalByKey.outsourcing ?? outsourcingDetailTotals.reduce((sum, item) => sum + item.value, 0);
      nodes.push({
        key: 'outsourcing',
        label: t('analysis_defect_outsourcing'),
        total,
        percentOfTotal: total > 0 ? round1((total / defectBreakdown.total) * 100) : 0,
        children: makeChildren(outsourcingDetailTotals, total),
      });
    }

    if (incomingDetailTotals.length) {
      const total = totalByKey.injection ?? incomingDetailTotals.reduce((sum, item) => sum + item.value, 0);
      nodes.push({
        key: 'injection',
        label: t('analysis_defect_injection'),
        total,
        percentOfTotal: total > 0 ? round1((total / defectBreakdown.total) * 100) : 0,
        children: makeChildren(incomingDetailTotals, total),
      });
    }

    return nodes;
  }, [
    defectBreakdown,
    processingDetailTotals,
    outsourcingDetailTotals,
    incomingDetailTotals,
    t,
  ]);

  const metricCards = [
    { key: 'achievementRate', label: t('analysis_metric_achievement'), unit: '%' },
    { key: 'qualityRate', label: t('analysis_metric_quality'), unit: '%' },
    { key: 'defectRate', label: t('analysis_metric_defect'), unit: '%' },
    { key: 'reworkRate', label: t('analysis_metric_rework'), unit: '%' },
    { key: 'uph', label: t('analysis_metric_uph'), unit: t('analysis_metric_per_hour') },
    { key: 'upph', label: t('analysis_metric_upph'), unit: t('analysis_metric_per_person_hour') },
  ] as const;

  const summaryRows = [
    { key: 'range', title: t('analysis_selected_period'), subtitle: rangeLabel, metrics: rangeMetrics },
    { key: 'overall', title: t('analysis_all_data'), subtitle: overallLabel, metrics: overallMetrics },
  ] as const;

  const formatValue = (value: number | null | undefined, unit: string) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return '-';
    }
    if (unit === '%') {
      return `${value}%`;
    }
    return `${value}${unit ? ` ${unit}` : ''}`;
  };

  const getMetricColor = (value: number | null | undefined, key: string, unit: string) => {
    if (value === null || value === undefined) return 'text-gray-400';
    if (unit !== '%') return 'text-blue-600';
    if (key === 'defectRate' || key === 'reworkRate') {
      if (value <= 3) return 'text-green-600';
      if (value <= 6) return 'text-yellow-600';
      return 'text-red-600';
    }
    if (value >= 85) return 'text-green-600';
    if (value >= 70) return 'text-yellow-600';
    return 'text-red-600';
  };

  const defectPeriodLabel = rangeLabel || overallLabel || '';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {metricCards.map((metric) => (
          <Card key={metric.key}>
            <CardHeader className="pb-2">
              <h4 className="text-sm font-medium text-gray-600">{metric.label}</h4>
            </CardHeader>
            <CardContent className="space-y-3">
              {summaryRows.map((row) => {
                const value = row.metrics?.[metric.key as keyof AggregatedMetrics] as number | null | undefined;
                return (
                  <div key={row.key} className="flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-gray-500">{row.title}</span>
                      {row.subtitle && (
                        <span className="text-[11px] text-gray-400">{row.subtitle}</span>
                      )}
                    </div>
                    <span className={`text-lg font-semibold ${getMetricColor(value, metric.key, metric.unit)}`}>
                      {formatValue(value, metric.unit)}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>

      {noRangeData && (
        <p className="text-xs text-orange-600">{t('analysis_no_period_data')}</p>
      )}

      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold">{t('analysis_metric_trend_title')}</h3>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="h-72">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 20, right: 20, bottom: 5, left: 0 }}>
                  <defs>
                    <linearGradient id="assemblyPlanGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={assemblyChartColors.planArea} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={assemblyChartColors.planArea} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="assemblyActualGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={assemblyChartColors.actualArea} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={assemblyChartColors.actualArea} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={isLiteMode ? '#1f2937' : '#e5e7eb'} vertical />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: isLiteMode ? '#1f2937' : '#4b5563' }}
                    tickFormatter={value => value.slice(5)}
                    interval={Math.max(Math.floor(chartData.length / 14), 0)}
                    height={32}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11, fill: isLiteMode ? '#1f2937' : '#4b5563' }}
                    tickFormatter={(value) => value.toLocaleString()}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: isLiteMode ? '#1f2937' : '#4b5563' }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <Tooltip
                    formatter={(value: number, name) => {
                      if (name === t('analysis_metric_achievement') || name === t('analysis_metric_quality')) {
                        return [`${round1(value)}%`, name];
                      }
                      return [value.toLocaleString(), name];
                    }}
                  />
                  <Legend wrapperStyle={{ color: isLiteMode ? '#1f2937' : '#4b5563' }} />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="plan"
                    name={t('analysis_chart_plan')}
                    stroke={assemblyChartColors.planArea}
                    fill="url(#assemblyPlanGradient)"
                    strokeWidth={2}
                  />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="actual"
                    name={t('analysis_chart_actual')}
                    stroke={assemblyChartColors.actualArea}
                    fill="url(#assemblyActualGradient)"
                    strokeWidth={2}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="achievement"
                    name={t('analysis_metric_achievement')}
                    stroke={assemblyChartColors.achievementLine}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="quality"
                    name={t('analysis_metric_quality')}
                    stroke={assemblyChartColors.qualityLine}
                    strokeWidth={2}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">
                {t('analysis_no_period_data')}
              </div>
            )}
          </div>

          <div className="border-t pt-6 space-y-5">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-gray-700">
                  {t('analysis_defect_detail_title')}
                  {defectPeriodLabel && (
                    <span className="ml-2 text-xs font-normal text-gray-400">{defectPeriodLabel}</span>
                  )}
                </h4>
                <p className="text-xs text-gray-500">{t('analysis_defect_detail_hint')}</p>
              </div>
              {defectBreakdown.total > 0 && (
                <div className="text-xs text-gray-500">
                  {t('analysis_defect_total')}: {defectBreakdown.total.toLocaleString()}
                </div>
              )}
            </div>

            {defectDetailTree.length > 0 ? (
              <div className="space-y-4">
                {defectDetailTree.map((category) => (
                  <div key={category.key} className="rounded-xl border border-gray-200/70 bg-gray-50 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: defectColors[category.key] ?? '#2563eb' }}
                        />
                        {category.label}
                      </div>
                      <div className="text-sm font-semibold text-gray-700">
                        {category.total.toLocaleString()}
                        <span className="ml-2 text-xs text-gray-400">({category.percentOfTotal}%)</span>
                      </div>
                    </div>

                    <div className="mt-3 space-y-3">
                      {category.children.map((child) => (
                        <div key={child.key} className="space-y-1">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-gray-600">{child.label}</span>
                            <span className="font-medium text-gray-800">
                              {child.value.toLocaleString()}
                              <span className="ml-2 text-xs text-gray-400">({child.percentOfTotal}%)</span>
                            </span>
                          </div>
                          <div className="h-2 rounded-full bg-white shadow-inner">
                            <div
                              className="h-2 rounded-full"
                              style={{
                                width: `${Math.min(child.percentOfCategory, 100)}%`,
                                backgroundColor: defectColors[category.key] ?? '#2563eb',
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-500">
                {t('analysis_defect_no_data')}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
