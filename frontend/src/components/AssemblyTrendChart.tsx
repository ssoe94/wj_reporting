import React from 'react';
import { useAssemblyReports } from '@/hooks/useAssemblyReports';
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

export default function AssemblyTrendChart() {
  const { data } = useAssemblyReports();
  const reports = (data as any)?.results ?? (Array.isArray(data) ? data : []);

  const dailyData: DataPoint[] = React.useMemo(() => {
    const map = new Map<string, DataPoint>();
    reports.forEach((r: any) => {
      const entry = map.get(r.date) || { date: r.date, plan: 0, actual: 0, achievementRate: 0 };
      entry.plan += Number(r.plan_qty || 0);
      entry.actual += Number(r.actual_qty || 0);
      map.set(r.date, entry);
    });

    const allDates = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    if (allDates.length === 0) return [];

    allDates.forEach((item) => {
      item.achievementRate = item.plan > 0 ? Math.round((item.actual / item.plan) * 100) : 0;
    });

    return allDates.slice(-15);
  }, [reports]);

  if (!dailyData.length) {
    return <p className="text-gray-500 text-sm">No data</p>;
  }

  return (
    <div className="w-full h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={dailyData} margin={{ top: 20, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} tickLine={{ stroke: '#666' }} axisLine={{ stroke: '#666' }} />
          <YAxis tick={{ fontSize: 12 }} tickLine={{ stroke: '#666' }} axisLine={{ stroke: '#666' }} />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '4px' }}
            formatter={(value: any, name: string) => [value, name]}
            labelFormatter={(label) => {
              const dp = dailyData.find((d) => d.date === label);
              return dp ? `${label} (달성율: ${dp.achievementRate}%)` : label;
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



