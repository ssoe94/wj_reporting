import { useAllReports } from '@/hooks/useReports';
import { useLang } from '@/i18n';
import React from 'react';
import dayjs from 'dayjs';
import {
  AreaChart,
  Area,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface DataPoint {
  date: string;
  plan: number;
  actual: number;
  achievementRate: number;
}

export default function ProdTrendChart() {
  const { data: reports = [] } = useAllReports();
  const { t } = useLang();
  const isLiteMode = document.documentElement.classList.contains('lite-mode');

  const dailyData: DataPoint[] = React.useMemo(() => {
    const map = new Map<string, DataPoint>();
    reports.forEach((r) => {
      const entry = map.get(r.date) || { date: r.date, plan: 0, actual: 0, achievementRate: 0 };
      entry.plan += r.plan_qty;
      entry.actual += r.actual_qty;
      map.set(r.date, entry);
    });

    const allDates = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));

    if (allDates.length === 0) return [];

    allDates.forEach(item => {
      item.achievementRate = item.plan > 0 ? Math.round((item.actual / item.plan) * 100) : 0;
    });

    const cutoff = dayjs().subtract(29, 'day');
    const recentDates = allDates
      .filter(item => dayjs(item.date).diff(cutoff, 'day') >= 0)
      .slice(-30);

    return recentDates;
  }, [reports]);

  if (!dailyData.length) {
    return <p className="text-gray-500 text-sm">No data</p>;
  }

  const chartColors = {
    grid: isLiteMode ? '#111827' : '#E5E7EB',
    axis: isLiteMode ? '#111827' : '#4B5563',
    planArea: isLiteMode ? '#0ea5e9' : '#0ea5e9',
    actualArea: isLiteMode ? '#14b8a6' : '#14b8a6',
    achievementLine: isLiteMode ? '#4338ca' : '#6366f1',
  };

  const tooltipStyle = {
    backgroundColor: '#ffffff',
    border: isLiteMode ? '2px solid #000000' : '1px solid #ccc',
    borderRadius: '4px',
    color: '#000000'
  };

  return (
    <div className="w-full h-72">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={dailyData} margin={{ top: 20, right: 20, bottom: 5, left: 0 }}>
          <defs>
            <linearGradient id="injectionPlanGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={chartColors.planArea} stopOpacity={0.24} />
              <stop offset="95%" stopColor={chartColors.planArea} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="injectionActualGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={chartColors.actualArea} stopOpacity={0.24} />
              <stop offset="95%" stopColor={chartColors.actualArea} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 12, fill: chartColors.axis }}
            tickLine={{ stroke: chartColors.axis }}
            axisLine={{ stroke: chartColors.axis }}
            interval={0}
            tickFormatter={(value: string) => (value?.length > 5 ? value.slice(5) : value)}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 12, fill: chartColors.axis }}
            tickLine={{ stroke: chartColors.axis }}
            axisLine={{ stroke: chartColors.axis }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 12, fill: chartColors.axis }}
            tickLine={{ stroke: chartColors.axis }}
            axisLine={{ stroke: chartColors.axis }}
            tickFormatter={(value) => `${value}%`}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: any, name: string) => {
              if (name === t('analysis_chart_plan') || name === t('analysis_chart_actual')) {
                return [value.toLocaleString(), name];
              }
              return [`${value}%`, name];
            }}
            labelFormatter={(label) => {
              const dataPoint = dailyData.find(item => item.date === label);
              if (dataPoint) {
                return `${label} (${t('analysis_metric_achievement')}: ${dataPoint.achievementRate}%)`;
              }
              return label;
            }}
          />
          <Legend wrapperStyle={{ color: chartColors.axis }} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="plan"
            name={t('analysis_chart_plan')}
            stroke={chartColors.planArea}
            strokeWidth={1}
            fill="url(#injectionPlanGradient)"
            dot={{ r: 2 }}
          />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="actual"
            name={t('analysis_chart_actual')}
            stroke={chartColors.actualArea}
            strokeWidth={1}
            fill="url(#injectionActualGradient)"
            dot={{ r: 2 }}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="achievementRate"
            name={t('analysis_metric_achievement')}
            stroke={chartColors.achievementLine}
            strokeWidth={1}
            dot={{ r: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
