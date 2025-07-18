import { useReports } from '@/hooks/useReports';
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
}

export default function ProdTrendChart() {
  const { data: reports = [] } = useReports();

  const dailyData: DataPoint[] = React.useMemo(() => {
    const map = new Map<string, DataPoint>();
    reports.forEach((r) => {
      const entry = map.get(r.date) || { date: r.date, plan: 0, actual: 0 };
      entry.plan += r.plan_qty;
      entry.actual += r.actual_qty;
      map.set(r.date, entry);
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [reports]);

  if (!dailyData.length) {
    return <p className="text-gray-500 text-sm">No data</p>;
  }

  return (
    <div className="w-full h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={dailyData} margin={{ top: 20, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="plan" stroke="#8884d8" name="Plan" />
          <Line type="monotone" dataKey="actual" stroke="#82ca9d" name="Actual" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
} 