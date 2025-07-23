import { useReports } from '@/hooks/useReports';
import { useLang } from '@/i18n';
import React from 'react';
import {
  LineChart,
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
  const { data: reports = [] } = useReports();
  const { t } = useLang();

  const dailyData: DataPoint[] = React.useMemo(() => {
    const map = new Map<string, DataPoint>();
    reports.forEach((r) => {
      const entry = map.get(r.date) || { date: r.date, plan: 0, actual: 0, achievementRate: 0 };
      entry.plan += r.plan_qty;
      entry.actual += r.actual_qty;
      map.set(r.date, entry);
    });
    
    // 생산 기록이 있는 날짜들을 정렬하고 달성율 계산
    const allDates = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    
    if (allDates.length === 0) return [];
    
    // 달성율 계산
    allDates.forEach(item => {
      item.achievementRate = item.plan > 0 ? Math.round((item.actual / item.plan) * 100) : 0;
    });
    
    // 최신 날짜부터 최대 15개의 생산 기록 날짜만 선택
    const recentDates = allDates.slice(-15);
    
    return recentDates;
  }, [reports]);

  if (!dailyData.length) {
    return <p className="text-gray-500 text-sm">No data</p>;
  }

  return (
    <div className="w-full h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={dailyData} margin={{ top: 20, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
          <XAxis 
            dataKey="date" 
            tick={{ fontSize: 12 }}
            tickLine={{ stroke: '#666' }}
            axisLine={{ stroke: '#666' }}
          />
          <YAxis 
            tick={{ fontSize: 12 }}
            tickLine={{ stroke: '#666' }}
            axisLine={{ stroke: '#666' }}
          />
          <Tooltip 
            contentStyle={{ 
              backgroundColor: '#fff', 
              border: '1px solid #ccc',
              borderRadius: '4px'
            }}
            formatter={(value: any, name: string) => {
              if (name === 'Plan' || name === 'Actual') {
                return [value, name];
              }
              return [value, name];
            }}
            labelFormatter={(label) => {
              const dataPoint = dailyData.find(item => item.date === label);
              if (dataPoint) {
                return `${label} (${t('achievement_rate')}: ${dataPoint.achievementRate}%)`;
              }
              return label;
            }}
          />
          <Legend />
          <Line type="monotone" dataKey="plan" stroke="#8884d8" name="Plan" />
          <Line type="monotone" dataKey="actual" stroke="#82ca9d" name="Actual" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
} 