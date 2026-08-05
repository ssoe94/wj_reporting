import React from 'react';
import dayjs from 'dayjs';
import { useAssemblyReportsTrendData } from '@/hooks/useAssemblyReports';
import { useLang } from '@/i18n';
import {
  AreaChart,
  Area,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { ChartNoAxesCombined, Target, TrendingUp } from 'lucide-react';

interface DataPoint {
  date: string;
  plan: number;
  actual: number;
  achievementRate: number;
}

export default function AssemblyTrendChart() {
  const { t, lang } = useLang();
  const { data } = useAssemblyReportsTrendData();
  const isLiteMode = document.documentElement.classList.contains('lite-mode');
  const copy = lang === 'zh'
    ? {
      title: '近 30 天生产趋势',
      description: '比较每日计划、实际产量和达成率。',
      empty: '保存生产记录后，将在此处显示趋势。',
    }
    : {
      title: '최근 30일 생산 추이',
      description: '일자별 계획·실적과 달성률의 흐름을 비교합니다.',
      empty: '생산 기록을 저장하면 이곳에 추이가 표시됩니다.',
    };
  const dailyData: DataPoint[] = React.useMemo(() => {
    const reports = Array.isArray(data) ? data : [];
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
  }, [data]);

  const { yMin, yMax, ticks } = React.useMemo(() => {
    if (!dailyData.length) {
      return { yMin: 0, yMax: 500, ticks: [0, 500] };
    }

    const allValues = dailyData.flatMap(d => [d.plan, d.actual]);
    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues);

    const yMin = Math.max(0, Math.floor((dataMin - 1) / 500) * 500);
    const yMax = Math.max(500, Math.ceil((dataMax + 1) / 500) * 500);

    const tickValues = [];
    for (let i = yMin; i <= yMax; i += 500) {
      tickValues.push(i);
    }

    return { yMin, yMax, ticks: tickValues };
  }, [dailyData]);

  const chartColors = {
    grid: isLiteMode ? '#1f2937' : '#dbe8f1',
    axis: isLiteMode ? '#1f2937' : '#627789',
    planArea: isLiteMode ? '#64748b' : '#7890a3',
    actualArea: isLiteMode ? '#0369a1' : '#168fc2',
    achievementLine: isLiteMode ? '#15803d' : '#159d5d',
  } as const;

  const totals = React.useMemo(() => dailyData.reduce(
    (acc, item) => ({ plan: acc.plan + item.plan, actual: acc.actual + item.actual }),
    { plan: 0, actual: 0 },
  ), [dailyData]);

  const totalAchievementRate = totals.plan > 0 ? Math.round((totals.actual / totals.plan) * 1000) / 10 : 0;

  return (
    <section className="assembly-trend-card">
      <div className="assembly-trend-card__header">
        <div className="assembly-trend-card__title">
          <span aria-hidden="true"><ChartNoAxesCombined /></span>
          <div>
            <h2>{copy.title}</h2>
            <p>{copy.description}</p>
          </div>
        </div>
        <div className="assembly-trend-card__summary" aria-label={t('achievement_rate')}>
          <span><Target aria-hidden="true" /> {t('plan_qty')} <strong>{totals.plan.toLocaleString()}</strong></span>
          <span><TrendingUp aria-hidden="true" /> {t('actual_qty')} <strong>{totals.actual.toLocaleString()}</strong></span>
          <span>{t('achievement_rate')} <strong>{totalAchievementRate.toFixed(1)}%</strong></span>
        </div>
      </div>

      <div className="assembly-trend-card__legend" aria-hidden="true">
        <span><i style={{ backgroundColor: chartColors.planArea }} />{t('plan_qty')}</span>
        <span><i style={{ backgroundColor: chartColors.actualArea }} />{t('actual_qty')}</span>
        <span><i style={{ backgroundColor: chartColors.achievementLine }} />{t('achievement_rate')}</span>
      </div>

      <div className="assembly-trend-card__chart">
        {dailyData.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dailyData} margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="assemblyTrendPlan" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.planArea} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={chartColors.planArea} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="assemblyTrendActual" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.actualArea} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={chartColors.actualArea} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="4 5" stroke={chartColors.grid} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: chartColors.axis }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={26}
                tickFormatter={(value: string) => (value?.length > 5 ? value.slice(5) : value)}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 11, fill: chartColors.axis }}
                tickLine={false}
                axisLine={false}
                domain={[yMin, yMax]}
                ticks={ticks}
                allowDataOverflow
                type="number"
                width={48}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: chartColors.axis }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `${value}%`}
                domain={[0, (dataMax: number) => Math.max(100, dataMax ? Math.ceil(dataMax * 1.1) : 100)]}
                width={42}
              />
              <Tooltip
                cursor={{ stroke: '#9ec6dc', strokeDasharray: '4 4' }}
                contentStyle={{
                  backgroundColor: 'rgba(255, 255, 255, 0.97)',
                  border: '1px solid rgba(79, 139, 184, 0.2)',
                  borderRadius: '12px',
                  boxShadow: '0 14px 30px rgba(46, 87, 128, 0.14)',
                }}
                formatter={(value: any, name: string) => {
                  if (name === t('plan_qty') || name === t('actual_qty')) {
                    return [Number(value).toLocaleString(), name];
                  }
                  return [`${value}%`, name];
                }}
                labelFormatter={(label) => {
                  const dp = dailyData.find((d) => d.date === label);
                  return dp ? `${label} · ${t('achievement_rate')} ${dp.achievementRate}%` : label;
                }}
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="plan"
                name={t('plan_qty')}
                stroke={chartColors.planArea}
                strokeWidth={2}
                fill="url(#assemblyTrendPlan)"
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="actual"
                name={t('actual_qty')}
                stroke={chartColors.actualArea}
                strokeWidth={2.4}
                fill="url(#assemblyTrendActual)"
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="achievementRate"
                name={t('achievement_rate')}
                stroke={chartColors.achievementLine}
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="assembly-trend-card__empty">
            <ChartNoAxesCombined aria-hidden="true" />
            <strong>{t('no_data')}</strong>
            <p>{copy.empty}</p>
          </div>
        )}
      </div>
    </section>
  );
}
