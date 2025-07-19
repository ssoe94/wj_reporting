import React from 'react';
import { useReports } from '@/hooks/useReports';
import type { Report } from '@/hooks/useReports';
import { useStdCT } from '@/hooks/useStdCT';
// using unicode arrows, no icon lib needed

interface Props {
  date: string; // YYYY-MM-DD
}

export default function DateRecordsTable({ date }: Props) {
  const { data: reports = [] } = useReports();
  const list = React.useMemo(() => {
    return reports
      .filter((r: Report) => r.date === date)
      .sort((a: Report, b: Report) => {
        if (a.machine_no !== b.machine_no) return (a.machine_no ?? 0) - (b.machine_no ?? 0);
        return a.start_datetime.localeCompare(b.start_datetime);
      });
  }, [reports, date]);

  const partNos = list.map((r) => r.part_no).filter(Boolean);
  const { data: stdMap = {} } = useStdCT(partNos);

  if (!date) return null;
  if (!list.length) return <p className="text-gray-500 text-sm">선택한 날짜에 생산 기록이 없습니다.</p>;

  return (
    <table
      className="min-w-full text-sm border border-gray-400 rounded-md border-separate border-spacing-0 mt-4"
    >
      <thead className="bg-blue-600 text-white">
        <tr>
          <th className="px-2 py-1">Machine</th>
          <th className="px-2 py-1">Model</th>
          <th className="px-2 py-1">Part No</th>
          <th className="px-2 py-1">Plan</th>
          <th className="px-2 py-1">Actual</th>
          <th className="px-2 py-1">Defect</th>
          <th className="px-2 py-1">Run&nbsp;Time<br/>(min)</th>
          <th className="px-2 py-1">CT&nbsp;/&nbsp;Δ</th>
        </tr>
      </thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.id} className="border-t border-gray-200 last:border-b-0">
            <td className="px-2 py-1 text-center">{r.machine_no}</td>
            <td className="px-2 py-1">{r.model}</td>
            <td className="px-2 py-1 text-center font-mono">{r.part_no}</td>
            <td className="px-2 py-1 text-right">{r.plan_qty}</td>
            <td className="px-2 py-1 text-right">{r.actual_qty}</td>
            <td className="px-2 py-1 text-right">{r.actual_defect}</td>
            <td className="px-2 py-1 text-right">{Math.round(r.operation_time)}</td>
            <td className="px-2 py-1 text-center">
              {(() => {
                const std = stdMap[r.part_no] || 0;
                if (!std || !r.actual_qty) return '-';
                const actualCt = (r.operation_time * 60) / r.actual_qty;
                const delta = actualCt - std;
                const color = delta > 0 ? 'text-red-600' : 'text-green-600';
                return (
                  <span className={color + ' flex items-center justify-center gap-0.5'}>
                    {actualCt.toFixed(1)}
                    &nbsp;
                    {delta > 0 ? '▲' : '▼'}
                    {Math.abs(delta).toFixed(1)}
                  </span>
                );
              })()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
} 