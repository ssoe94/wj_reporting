import React from 'react';
import dayjs from 'dayjs';
import { useAssemblyReportsTrendData } from '@/hooks/useAssemblyReports';
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

export default function AssemblyTrendChart() {
  const { data } = useAssemblyReportsTrendData();
  const reports = (data as any) ?? [];
  const isLiteMode = document.documentElement.classList.contains('lite-mode');

  const dailyData: DataPoint[] = React.useMemo(() => {
    const map = new Map<string, DataPoint>();

    reports.forEach((r: any) => {
      const entry = map.get(r.date) || { date: r.date, plan: 0, actual: 0, achievementRate: 0 };
      entry.plan += Number(r.plan_qty || 0);
      entry.actual += Number(r.actual_qty || 0);
      map.set(r.date, entry);
    });

    const allDates = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    if (!allDates.length) return [] as DataPoint[];

    allDates.forEach((item) => {
      item.achievementRate = item.plan > 0 ? Math.round((item.actual / item.plan) * 100) : 0;
    });

    const maxDate = dayjs(allDates[allDates.length - 1].date);
    const cutoff = maxDate.clone().subtract(29, 'day');
    return allDates
      .filter((item) => dayjs(item.date).diff(cutoff, 'day') >= 0)
      .slice(-30);
  }, [reports]);

  const { yMin, yMax, ticks } = React.useMemo(() => {
    if (!dailyData.length) {
      return { yMin: 0, yMax: 500, ticks: [0, 500] };
    }

    const allValues = dailyData.flatMap(d => [d.plan, d.actual]);
    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues);

    const yMin = Math.floor((dataMin - 1) / 500) * 500;
    const yMax = Math.ceil((dataMax + 1) / 500) * 500;

    const tickValues = [];
    for (let i = yMin; i <= yMax; i += 500) {
      tickValues.push(i);
    }

    return { yMin, yMax, ticks: tickValues };
  }, [dailyData]);

  if (!dailyData.length) {
    return <p className="text-gray-500 text-sm">No data</p>;
  }

  const chartColors = {
    grid: isLiteMode ? '#1f2937' : '#e5e7eb',
    axis: isLiteMode ? '#1f2937' : '#4b5563',
    planArea: isLiteMode ? '#fb923c' : '#f97316',
    actualArea: isLiteMode ? '#f87171' : '#ec4899',
    achievementLine: isLiteMode ? '#0ea5e9' : '#0ea5e9',
  } as const;

  return (
    <div className="w-full h-72">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={dailyData} margin={{ top: 20, right: 20, bottom: 5, left: 0 }}>
          <defs>
            <linearGradient id="assemblyTrendPlan" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={chartColors.planArea} stopOpacity={0.24} />
              <stop offset="95%" stopColor={chartColors.planArea} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="assemblyTrendActual" x1="0" y1="0" x2="0" y2="1">
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
            domain={[yMin, yMax]}
            ticks={ticks}
            allowDataOverflow={true}
            type="number"
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 12, fill: chartColors.axis }}
            tickLine={{ stroke: chartColors.axis }}
            axisLine={{ stroke: chartColors.axis }}
            tickFormatter={(value) => `${value}%`}
            domain={[0, (dataMax: number) => Math.min(100, dataMax ? Math.ceil(dataMax * 1.1) : 100)]}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '4px' }}
            formatter={(value: any, name: string) => {
              if (name === 'Plan' || name === 'Actual') {
                return [Number(value).toLocaleString(), name];
              }
              return [`${value}%`, name];
            }}
            labelFormatter={(label) => {
              const dp = dailyData.find((d) => d.date === label);
              return dp ? `${label} (달성율: ${dp.achievementRate}%)` : label;
            }}
          />
          <Legend wrapperStyle={{ color: chartColors.axis }} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="plan"
            name="Plan"
            stroke={chartColors.planArea}
            strokeWidth={1}
            fill="url(#assemblyTrendPlan)"
            dot={{ r: 2 }}
          />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="actual"
            name="Actual"
            stroke={chartColors.actualArea}
            strokeWidth={1}
            fill="url(#assemblyTrendActual)"
            dot={{ r: 2 }}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="achievementRate"
            name="Achievement"
            strokeWidth={1}
            dot={{ r: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
