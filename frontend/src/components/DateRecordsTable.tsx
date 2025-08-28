import React from 'react';
import { useReports } from '@/hooks/useReports';
import type { Report } from '@/hooks/useReports';
import { useStdCT } from '@/hooks/useStdCT';
import { Dialog } from '@headlessui/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import ReportForm from '@/components/ReportForm';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { useLang } from '@/i18n';
import dayjs from 'dayjs';
// using unicode arrows, no icon lib needed

interface Props {
  date: string; // YYYY-MM-DD
}

export default function DateRecordsTable({ date }: Props) {
  const { data: reports = [] } = useReports();
  const { t } = useLang();
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

  // react-query client
  const queryClient = useQueryClient();

  const handleSave = async (data: Partial<Report>) => {
    if(!detail) return;
    try {
      await api.patch(`/reports/${detail.id}/`, data);
      toast.success('수정되었습니다');
      queryClient.invalidateQueries({ queryKey:['reports']});
      setEditing(false);
      setDetail(null);
    } catch {
      toast.error('수정 실패');
    }
  };

  // 삭제 핸들러
  const handleDelete = async () => {
    if (!detail) return;
    if (!confirm(t('confirm_delete') || '정말 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/reports/${detail.id}/`);
      toast.success(t('delete_success') || '삭제되었습니다');
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setDetail(null);
    } catch {
      toast.error(t('delete_fail') || '삭제 실패');
    }
  };

  if (!date) return null;
  if (!list.length) return <p className="text-gray-500 text-sm">선택한 날짜에 생산 기록이 없습니다.</p>;

  const totals = React.useMemo(() => {
    return list.reduce(
      (acc, r) => {
        acc.plan += Number(r.plan_qty || 0);
        acc.actual += Number(r.actual_qty || 0);
        acc.defect += Number(r.actual_defect || 0);
        return acc;
      },
      { plan: 0, actual: 0, defect: 0 }
    );
  }, [list]);

  const achievementRate = React.useMemo(() => {
    if (!totals.plan) return null;
    return (totals.actual / totals.plan) * 100;
  }, [totals]);

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
                if (!r.actual_qty) return '-';
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
        {/* Summary row */}
        <tr className="border-t-2 border-gray-300 bg-slate-50">
          <td className="px-2 py-2 text-right font-semibold" colSpan={3}>합계</td>
          <td className="px-2 py-2 text-right font-bold text-blue-700">{totals.plan.toLocaleString()}</td>
          <td className="px-2 py-2 text-right font-bold text-green-700">{totals.actual.toLocaleString()}</td>
          <td className="px-2 py-2 text-right font-bold text-red-600">{totals.defect.toLocaleString()}</td>
          <td className="px-2 py-2 text-right text-gray-700 font-semibold" colSpan={3}>
            달성율: {achievementRate === null ? '-' : `${achievementRate.toFixed(1)}%`}
          </td>
        </tr>
      </tbody>
    </table>
    {detail && (
      <Dialog open={!!detail} onClose={()=>setDetail(null)} className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
        <Dialog.Panel className="relative bg-white rounded-lg w-full max-w-xl p-6 space-y-4">
          {!editing ? (
           <>
             <Dialog.Title className="text-lg font-bold">
               {dayjs(detail!.date).format('YYYY.MM.DD')} – {detail!.machine_no}号机
             </Dialog.Title>
             <div className="grid grid-cols-2 gap-2 text-sm">
               <span className="text-gray-500">{t('report_date')}</span><span>{detail!.date}</span>
               <span className="text-gray-500">{t('machine')}</span><span>{detail!.machine_no}</span>
               <span className="text-gray-500">{t('model')}</span><span>{detail!.model}</span>
               <span className="text-gray-500">Part No</span><span>{detail!.part_no}</span>
               <span className="text-gray-500">{t('plan_qty')}</span><span>{detail!.plan_qty}</span>
               <span className="text-gray-500">{t('actual_qty')}</span><span>{detail!.actual_qty}</span>
               <span className="text-gray-500">{t('actual_defect')}</span><span>{detail!.actual_defect}</span>
               <span className="text-gray-500">{t('start_dt')}</span><span>{detail!.start_datetime ? dayjs(detail!.start_datetime).format('YYYY-MM-DD HH:mm') : '-'}</span>
               <span className="text-gray-500">{t('end_dt')}</span><span>{detail!.end_datetime ? dayjs(detail!.end_datetime).format('YYYY-MM-DD HH:mm') : '-'}</span>
               <span className="text-gray-500">{t('total_time')}</span><span>{detail!.total_time ? `${detail!.total_time}${t('minutes_unit')}` : '-'}</span>
               <span className="text-gray-500">{t('idle_time')}</span><span>{detail!.total_time && detail!.operation_time ? `${detail!.total_time - detail!.operation_time}${t('minutes_unit')}` : '-'}</span>
               <span className="text-gray-500">{t('run_time')}</span><span>{detail!.operation_time ? `${detail!.operation_time}${t('minutes_unit')}` : '-'}</span>
               <span className="text-gray-500">{t('header_note')}</span><span className="col-span-1">{detail!.note}</span>
             </div>
             <div className="flex justify-end gap-2">
               <Button variant="info" onClick={()=>{setEditing(true);}}>{t('edit')}</Button>
               <Button variant="danger" onClick={handleDelete}>{t('delete')}</Button>
               <Button variant="secondary" onClick={()=>setDetail(null)}>{t('close')}</Button>
             </div>
           </>
          ) : (
           <>
             <Dialog.Title className="text-lg font-bold">{dayjs(detail!.date).format('YYYY.MM.DD')} – {detail!.machine_no}号机 {t('edit')}</Dialog.Title>
             <ReportForm initialData={detail!} onSave={handleSave} onCancel={()=>setEditing(false)} />
           </>
          )}
        </Dialog.Panel>
      </Dialog>
    )}
    </>
  );
} 