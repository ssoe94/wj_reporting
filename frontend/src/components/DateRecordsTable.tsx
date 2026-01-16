import React from 'react';
import { useReports } from '@/hooks/useReports';
import type { Report } from '@/hooks/useReports';
import { Dialog } from '@headlessui/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import ReportForm from '@/components/ReportForm';
import HistoricalPerformanceModal from '@/components/HistoricalPerformanceModal';
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
  const { data: reportsData, isLoading } = useReports({ date });
  const { t, lang } = useLang();
  const list = React.useMemo(() => {
    const reportsArray: Report[] = Array.isArray(reportsData)
      ? (reportsData as Report[])
      : reportsData?.results || [];

    return reportsArray
      .slice()
      .sort((a: Report, b: Report) => {
        if (a.machine_no !== b.machine_no) return (a.machine_no ?? 0) - (b.machine_no ?? 0);
        return a.start_datetime.localeCompare(b.start_datetime);
      });
  }, [reportsData]);

  const [detail, setDetail] = useState<Report | null>(null);
  const [editing, setEditing] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [selectedPartPrefix, setSelectedPartPrefix] = useState('');

  const SkeletonRow = () => (
    <tr className="animate-pulse">
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
      <td className="px-2 py-1"><div className="h-4 bg-gray-200 rounded"></div></td>
    </tr>
  );

  const SkeletonTable = () => (
    <table className="w-full border-collapse text-sm mt-4">
      <thead className="bg-blue-600 text-white">
        <tr>
          <th className="px-2 py-1">{t('table_machine')}</th>
          <th className="px-2 py-1">{t('table_model')}</th>
          <th className="px-2 py-1">{t('table_part_no')}</th>
          <th className="px-2 py-1">{t('table_plan')}</th>
          <th className="px-2 py-1">{t('table_actual')}</th>
          <th className="px-2 py-1">{t('table_defect')}</th>
          <th className="px-2 py-1">{t('table_run_time')}</th>
          <th className="px-2 py-1">{t('table_ct')}</th>
          <th className="px-2 py-1">{t('table_ct_delta')}</th>
        </tr>
      </thead>
      <tbody>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </tbody>
    </table>
  );

  // react-query client
  const queryClient = useQueryClient();

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

  const handleSave = async (data: Partial<Report>) => {
    if (!detail) return;
    try {
      await api.patch(`/injection/reports/${detail.id}/`, data);
      toast.success(t('update_success'));
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setEditing(false);
      setDetail(null);
    } catch {
      toast.error(t('update_fail'));
    }
  };

  // 삭제 핸들러
  const handleDelete = async () => {
    if (!detail) return;
    if (!confirm(t('confirm_delete') || '정말 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/injection/reports/${detail.id}/`);
      toast.success(t('delete_success') || '삭제되었습니다');
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setDetail(null);
    } catch {
      toast.error(t('delete_fail') || '삭제 실패');
    }
  };

  // Part No. 클릭 핸들러 - 앞자리 9자리를 prefix로 추출
  const handlePartNoClick = (partNo: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 모달 클릭 이벤트와 분리
    if (partNo && partNo.length >= 9) {
      const prefix = partNo.substring(0, 9);
      setSelectedPartPrefix(prefix);
      setHistoryModalOpen(true);
    }
  };

  if (!date) return null;
  if (isLoading) return <SkeletonTable />;
  if (!list.length) return <p className="text-gray-500 text-sm">{t('no_record_on_date')}</p>;

  return (
    <>
      <table
        className="w-full border-collapse text-sm mt-4"
      >
        <thead className="bg-blue-600 text-white">
          <tr>
            <th className="px-2 py-1">{t('table_machine')}</th>
            <th className="px-2 py-1">{t('table_model')}</th>
            <th className="px-2 py-1">{t('table_part_no')}</th>
            <th className="px-2 py-1">{t('table_plan')}</th>
            <th className="px-2 py-1">{t('table_actual')}</th>
            <th className="px-2 py-1">{t('table_defect')}</th>
            <th className="px-2 py-1">{t('table_run_time')}</th>
            <th className="px-2 py-1">{t('table_ct')}</th>
            <th className="px-2 py-1">{t('table_ct_delta')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {list.map((r) => (
            <tr key={r.id} className="hover:bg-blue-50 cursor-pointer" onClick={() => { setDetail(r); setEditing(false); }}>
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
                  const deviation = r.cycle_time_deviation;
                  if (deviation === null || deviation === undefined) return <span className="text-blue-500 font-semibold">New</span>;

                  const color = deviation > 0 ? 'text-red-600' : 'text-green-600';
                  return (
                    <span className={color + ' flex items-center justify-center gap-0.5'}>
                      {deviation > 0 ? '▲' : '▼'}
                      {Math.abs(deviation).toFixed(1)}
                    </span>
                  );
                })()}
              </td>
            </tr>
          ))}
          {/* Summary row */}
          <tr className="bg-blue-100">
            <td className="px-2 py-2 text-right font-semibold text-gray-700" colSpan={3}>{t('sum')}</td>
            <td className="px-2 py-2 text-right font-semibold text-gray-700">{totals.plan.toLocaleString()}</td>
            <td className="px-2 py-2 text-right font-semibold text-gray-700">{totals.actual.toLocaleString()}</td>
            <td className="px-2 py-2 text-right font-semibold text-gray-700">{totals.defect.toLocaleString()}</td>
            <td className="px-2 py-2 text-right font-semibold text-gray-700" colSpan={3}>
              {t('achievement_rate')}: {achievementRate === null ? '-' : `${achievementRate.toFixed(1)}%`}
            </td>
          </tr>
        </tbody>
      </table>
      {detail && (
        <Dialog open={!!detail} onClose={() => setDetail(null)} className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
          <Dialog.Panel className="relative bg-white rounded-lg w-full max-w-xl p-6 space-y-4">
            {!editing ? (
              <>
                <Dialog.Title className="text-lg font-bold">
                  {dayjs(detail!.date).format('YYYY.MM.DD')} – {detail!.machine_no}{lang === 'zh' ? '号机' : '호기'}
                </Dialog.Title>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-gray-500">{t('report_date')}</span><span>{detail!.date}</span>
                  <span className="text-gray-500">{t('machine')}</span><span>{detail!.machine_no}</span>
                  <span className="text-gray-500">{t('model')}</span><span>{detail!.model}</span>
                  <span className="text-gray-500">Part No</span>
                  <span>
                    <button
                      onClick={(e) => handlePartNoClick(detail!.part_no, e)}
                      className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                      title={t('part_no_history_tooltip')}
                    >
                      {detail!.part_no}
                    </button>
                  </span>
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
                  <Button variant="info" onClick={() => { setEditing(true); }}>{t('edit')}</Button>
                  <Button variant="danger" onClick={handleDelete}>{t('delete')}</Button>
                  <Button variant="secondary" onClick={() => setDetail(null)}>{t('close')}</Button>
                </div>
              </>
            ) : (
              <>
                <Dialog.Title className="text-lg font-bold">{dayjs(detail!.date).format('YYYY.MM.DD')} – {detail!.machine_no}{lang === 'zh' ? '号机' : '호기'} {t('edit')}</Dialog.Title>
                <ReportForm initialData={detail!} onSave={handleSave} onCancel={() => setEditing(false)} />
              </>
            )}
          </Dialog.Panel>
        </Dialog>
      )}

      {/* Historical Performance Modal */}
      <HistoricalPerformanceModal
        isOpen={historyModalOpen}
        onClose={() => setHistoryModalOpen(false)}
        partPrefix={selectedPartPrefix}
      />
    </>
  );
} 
