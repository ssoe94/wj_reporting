import React from 'react';
import { useReports } from '@/hooks/useReports';
import type { Report } from '@/hooks/useReports';
import { useStdCT } from '@/hooks/useStdCT';
import { Dialog } from '@headlessui/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
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
  const [detail, setDetail] = useState<Report|null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Report>>({});
  const queryClient = useQueryClient();

  if (!date) return null;
  if (!list.length) return <p className="text-gray-500 text-sm">선택한 날짜에 생산 기록이 없습니다.</p>;

  return (
    <>
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
          <th className="px-2 py-1">CT(s)</th>
          <th className="px-2 py-1">Δ CT(s)</th>
        </tr>
      </thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.id} className="border-t border-gray-200 last:border-b-0 hover:bg-blue-50 cursor-pointer" onClick={()=>{setDetail(r); setEditing(false);}}>
            <td className="px-2 py-1 text-center">{r.machine_no}</td>
            <td className="px-2 py-1">{r.model}</td>
            <td className="px-2 py-1 text-center">{r.part_no}</td>
            <td className="px-2 py-1 text-right">{r.plan_qty}</td>
            <td className="px-2 py-1 text-right">{r.actual_qty}</td>
            <td className="px-2 py-1 text-right">{r.actual_defect}</td>
            <td className="px-2 py-1 text-right">{Math.round(r.operation_time)}</td>
            <td className="px-2 py-1 text-center">{(() => {
                const std = stdMap[r.part_no] || 0;
                if (!std || !r.actual_qty) return '-';
                const actualCt = (r.operation_time * 60) / r.actual_qty;
                return actualCt.toFixed(1);
              })()}</td>
            <td className="px-2 py-1 text-center">
              {(() => {
                const std = stdMap[r.part_no] || 0;
                if (!std || !r.actual_qty) return '-';
                const actualCt = (r.operation_time * 60) / r.actual_qty;
                const delta = actualCt - std;
                const color = delta > 0 ? 'text-red-600' : 'text-green-600';
                return (
                  <span className={color + ' flex items-center justify-center gap-0.5'}>
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
    {detail && (
      <Dialog open={!!detail} onClose={()=>setDetail(null)} className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
        <Dialog.Panel className="relative bg-white rounded-lg w-full max-w-xl p-6 space-y-4">
          {!editing ? (
           <>
             <Dialog.Title className="text-lg font-bold">Record #{detail!.id}</Dialog.Title>
             <div className="grid grid-cols-2 gap-2 text-sm">
               <span className="text-gray-500">Date</span><span>{detail!.date}</span>
               <span className="text-gray-500">Machine</span><span>{detail!.machine_no}</span>
               <span className="text-gray-500">Model</span><span>{detail!.model}</span>
               <span className="text-gray-500">Part No</span><span>{detail!.part_no}</span>
               <span className="text-gray-500">Plan</span><span>{detail!.plan_qty}</span>
               <span className="text-gray-500">Actual</span><span>{detail!.actual_qty}</span>
               <span className="text-gray-500">Defect</span><span>{detail!.actual_defect}</span>
               <span className="text-gray-500">Run Time</span><span>{detail!.operation_time}</span>
               <span className="text-gray-500">Note</span><span className="col-span-1">{detail!.note}</span>
             </div>
             <div className="flex justify-end gap-2">
               <Button variant="ghost" onClick={()=>setDetail(null)}>닫기</Button>
               <Button onClick={()=>{setForm(detail!); setEditing(true);}}>수정</Button>
             </div>
           </>
          ) : (
           <>
             <Dialog.Title className="text-lg font-bold">편집 – #{detail!.id}</Dialog.Title>
             <div className="grid grid-cols-2 gap-3 text-sm">
               <label className="text-gray-500">Plan</label>
               <Input type="number" value={form.plan_qty ?? ''} onChange={e=>setForm({...form, plan_qty:+e.target.value})} />
               <label className="text-gray-500">Actual</label>
               <Input type="number" value={form.actual_qty ?? ''} onChange={e=>setForm({...form, actual_qty:+e.target.value})} />
               <label className="text-gray-500">Defect</label>
               <Input type="number" value={form.actual_defect ?? ''} onChange={e=>setForm({...form, actual_defect:+e.target.value})} />
               <label className="text-gray-500">Note</label>
               <Textarea value={form.note ?? ''} onChange={e=>setForm({...form, note:e.target.value})} />
             </div>
             <div className="flex justify-end gap-2">
               <Button variant="ghost" onClick={()=>setEditing(false)}>취소</Button>
               <Button onClick={async ()=>{
                 try {
                   await api.patch(`/reports/${detail!.id}/`, form);
                   toast.success('수정되었습니다');
                   queryClient.invalidateQueries({ queryKey:['reports']});
                   setEditing(false);
                   setDetail(null);
                 } catch { toast.error('수정 실패'); }
               }}>저장</Button>
             </div>
           </>
          )}
        </Dialog.Panel>
      </Dialog>
    )}
    </>
  );
} 