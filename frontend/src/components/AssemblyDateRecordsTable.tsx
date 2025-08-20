import { useState } from 'react';
import { useAssemblyReports } from '../hooks/useAssemblyReports';
import type { AssemblyReport } from '../types/assembly';
import { Dialog } from '@headlessui/react';
import { Button } from './ui/button';
import AssemblyReportForm from './AssemblyReportForm';
import { api } from '../lib/api';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useLang } from '../i18n';

interface Props {
  date: string; // YYYY-MM-DD
}

export default function AssemblyDateRecordsTable({ date }: Props) {
  const { t } = useLang();
  const { data: reportsData } = useAssemblyReports({ date });
  const reports = reportsData?.results || [];
  const [detail, setDetail] = useState<AssemblyReport | null>(null);
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();

  const list = reports
    .filter((r: AssemblyReport) => r.date === date)
    .sort((a: AssemblyReport, b: AssemblyReport) => {
      if (a.line_no !== b.line_no) return (a.line_no || '').localeCompare(b.line_no || '');
      return (a.start_datetime || '').localeCompare(b.start_datetime || '');
    });

  const handleSave = async (data: Partial<AssemblyReport>) => {
    if (!detail) return;
    try {
      await api.patch(`/assembly/api/reports/${detail.id}/`, data);
      toast.success(t('update_success'));
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
      setEditing(false);
      setDetail(null);
    } catch {
      toast.error(t('update_fail'));
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    if (!confirm(t('confirm_delete'))) return;
    try {
      await api.delete(`/assembly/api/reports/${detail.id}/`);
      toast.success(t('delete_success'));
      queryClient.invalidateQueries({ queryKey: ['assembly-reports'] });
      queryClient.invalidateQueries({ queryKey: ['assembly-reports-summary'] });
      setDetail(null);
    } catch {
      toast.error(t('delete_fail'));
    }
  };

  const formatDefectInfo = (report: AssemblyReport) => {
    const total = report.total_defect_qty || 0;
    if (total === 0) return '0';
    
    const parts = [];
    if (report.injection_defect > 0) parts.push(`${t('assembly_injection_defect')}: ${report.injection_defect}`);
    if (report.outsourcing_defect > 0) parts.push(`${t('assembly_outsourcing_defect')}: ${report.outsourcing_defect}`);
    if (report.processing_defect > 0) parts.push(`${t('assembly_processing_defect')}: ${report.processing_defect}`);
    
    return `${total} (${parts.join(', ')})`;
  };

  if (!date) return null;
  if (!list.length) return <p className="text-gray-500 text-sm">{t('no_data')}</p>;

  return (
    <>
      <table className="min-w-full text-sm border border-gray-400 rounded-md border-separate border-spacing-0 mt-4">
        <thead className="bg-green-600 text-white">
          <tr>
            <th className="px-2 py-1">{t('assembly_line_no')}</th>
            <th className="px-2 py-1">{t('model')}</th>
            <th className="px-2 py-1">{t('part_no')}</th>
            <th className="px-2 py-1">{t('assembly_plan_qty')}</th>
            <th className="px-2 py-1">{t('assembly_actual_qty')}</th>
            <th className="px-2 py-1">{t('assembly_defect_qty')}</th>
            <th className="px-2 py-1">{t('achievement_rate')}</th>
            <th className="px-2 py-1">불량률</th>
            <th className="px-2 py-1">{t('assembly_uptime_rate')}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r: any) => (
            <tr 
              key={r.id} 
              className="border-t border-gray-200 last:border-b-0 hover:bg-green-50 cursor-pointer" 
              onClick={() => { setDetail(r); setEditing(false); }}
            >
              <td className="px-2 py-1 text-center">{r.line_no}</td>
              <td className="px-2 py-1">{r.model}</td>
              <td className="px-2 py-1 text-center">{r.part_no}</td>
              <td className="px-2 py-1 text-right">{r.plan_qty?.toLocaleString()}</td>
              <td className="px-2 py-1 text-right">{r.actual_qty?.toLocaleString()}</td>
              <td className="px-2 py-1 text-right" title={formatDefectInfo(r)}>
                {r.total_defect_qty?.toLocaleString()}
              </td>
              <td className="px-2 py-1 text-right">
                <span className={`${
                  (r.achievement_rate || 0) >= 100 
                    ? 'text-green-600' 
                    : (r.achievement_rate || 0) >= 80 
                      ? 'text-yellow-600' 
                      : 'text-red-600'
                }`}>
                  {r.achievement_rate}%
                </span>
              </td>
              <td className="px-2 py-1 text-right">
                <span className={`${
                  (r.defect_rate || 0) <= 2 
                    ? 'text-green-600' 
                    : (r.defect_rate || 0) <= 5 
                      ? 'text-yellow-600' 
                      : 'text-red-600'
                }`}>
                  {r.defect_rate}%
                </span>
              </td>
              <td className="px-2 py-1 text-right">
                <span className={`${
                  (r.uptime_rate || 0) >= 80 
                    ? 'text-green-600' 
                    : (r.uptime_rate || 0) >= 60 
                      ? 'text-yellow-600' 
                      : 'text-red-600'
                }`}>
                  {r.uptime_rate}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      
      {detail && (
        <Dialog open={!!detail} onClose={() => setDetail(null)} className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
          <Dialog.Panel className="relative bg-white rounded-lg w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            {!editing ? (
              <>
                <Dialog.Title className="text-lg font-bold">
                  {dayjs(detail.date).format('YYYY.MM.DD')} – {detail.line_no} 라인
                </Dialog.Title>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-gray-500">{t('report_date')}</span><span>{detail.date}</span>
                  <span className="text-gray-500">{t('assembly_line_no')}</span><span>{detail.line_no}</span>
                  <span className="text-gray-500">{t('model')}</span><span>{detail.model}</span>
                  <span className="text-gray-500">{t('part_no')}</span><span>{detail.part_no}</span>
                  <span className="text-gray-500">{t('assembly_plan_qty')}</span><span>{detail.plan_qty?.toLocaleString()}</span>
                  <span className="text-gray-500">{t('assembly_actual_qty')}</span><span>{detail.actual_qty?.toLocaleString()}</span>
                  <span className="text-gray-500">{t('assembly_injection_defect')}</span><span>{detail.injection_defect?.toLocaleString()}</span>
                  <span className="text-gray-500">{t('assembly_outsourcing_defect')}</span><span>{detail.outsourcing_defect?.toLocaleString()}</span>
                  <span className="text-gray-500">{t('assembly_processing_defect')}</span><span>{detail.processing_defect?.toLocaleString()}</span>
                  <span className="text-gray-500">{t('assembly_incoming_defect')}</span><span>{detail.incoming_defect_qty?.toLocaleString()}</span>
                  <span className="text-gray-500">{t('assembly_defect_qty')}</span><span>{detail.total_defect_qty?.toLocaleString()}</span>
                  <span className="text-gray-500">{t('start_dt')}</span><span>{detail.start_datetime ? dayjs(detail.start_datetime).format('YYYY-MM-DD HH:mm') : '-'}</span>
                  <span className="text-gray-500">{t('end_dt')}</span><span>{detail.end_datetime ? dayjs(detail.end_datetime).format('YYYY-MM-DD HH:mm') : '-'}</span>
                  <span className="text-gray-500">{t('total_time')}</span><span>{detail.total_time ? `${detail.total_time}${t('min_unit')}` : '-'}</span>
                  <span className="text-gray-500">{t('assembly_operation_time')}</span><span>{detail.operation_time ? `${detail.operation_time}${t('min_unit')}` : '-'}</span>
                  <span className="text-gray-500">{t('achievement_rate')}</span><span>{detail.achievement_rate}%</span>
                  <span className="text-gray-500">불량률</span><span>{detail.defect_rate}%</span>
                  <span className="text-gray-500">{t('assembly_uptime_rate')}</span><span>{detail.uptime_rate}%</span>
                  <span className="text-gray-500">{t('header_note')}</span><span className="col-span-1">{detail.note}</span>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="info" onClick={() => { setEditing(true); }}>{t('edit')}</Button>
                  <Button variant="danger" onClick={handleDelete}>{t('delete')}</Button>
                  <Button variant="secondary" onClick={() => setDetail(null)}>{t('close')}</Button>
                </div>
              </>
            ) : (
              <>
                <Dialog.Title className="text-lg font-bold">
                  {dayjs(detail.date).format('YYYY.MM.DD')} – {detail.line_no} 라인 {t('edit')}
                </Dialog.Title>
                <AssemblyReportForm 
                  onSubmit={handleSave} 
                  isLoading={false}
                />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setEditing(false)}>{t('cancel')}</Button>
                </div>
              </>
            )}
          </Dialog.Panel>
        </Dialog>
      )}
    </>
  );
}