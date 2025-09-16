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
import { Tag, Percent, Gauge } from 'lucide-react';
import AssemblyHistoricalPerformanceModal from './AssemblyHistoricalPerformanceModal';

interface Props {
  date: string; // YYYY-MM-DD
}

export default function AssemblyDateRecordsTable({ date }: Props) {
  const { t } = useLang();
  const { data: reportsData } = useAssemblyReports({ date });
  const reports = reportsData?.results || [];
  const [detail, setDetail] = useState<AssemblyReport | null>(null);
  const [editing, setEditing] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editingData, setEditingData] = useState<AssemblyReport | null>(null);
  const [showHistoricalModal, setShowHistoricalModal] = useState(false);
  const [selectedPartPrefix, setSelectedPartPrefix] = useState('');
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
      await api.patch(`/assembly/reports/${detail.id}/`, data);
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
      await api.delete(`/assembly/reports/${detail.id}/`);
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
    const parts = [] as string[];
    if (report.injection_defect > 0) parts.push(`${t('assembly_injection_defect')}: ${report.injection_defect}`);
    if (report.outsourcing_defect > 0) parts.push(`${t('assembly_outsourcing_defect')}: ${report.outsourcing_defect}`);
    if (report.processing_defect > 0) parts.push(`${t('assembly_processing_defect')}: ${report.processing_defect}`);
    return `${total} (${parts.join(', ')})`;
  };

  // Part No. 클릭 핸들러
  const handlePartNoClick = (partNo: string, event: React.MouseEvent) => {
    event.stopPropagation(); // 테이블 행 클릭 이벤트 방지
    setSelectedPartPrefix(partNo);
    setShowHistoricalModal(true);
  };

  if (!date) return null;
  if (!list.length) return <p className="text-gray-500 text-sm">{t('no_data')}</p>;

  const totalPlan = list.reduce((sum: number, r: AssemblyReport) => sum + (r.plan_qty || 0), 0);
  const totalActual = list.reduce((sum: number, r: AssemblyReport) => sum + (r.actual_qty || 0), 0);
  const totalDefect = list.reduce((sum: number, r: AssemblyReport) => sum + (r.total_defect_qty || 0), 0);
  const achievementRate = totalPlan > 0 ? (totalActual / totalPlan) * 100 : 0;

  return (
    <>
      <table className="min-w-full text-sm rounded-md border-separate border-spacing-0 mt-4">
        <thead className="bg-green-600 text-white">
          <tr>
            <th className="px-2 py-1">{t('assembly_line_no')}</th>
            <th className="px-2 py-1">{t('model')}</th>
            <th className="px-2 py-1">{t('part_no')}</th>
            <th className="px-2 py-1">{t('assembly_plan_qty')}</th>
            <th className="px-2 py-1">{t('assembly_actual_qty')}</th>
            <th className="px-2 py-1">{t('assembly_defect_qty')}</th>
            <th className="px-2 py-1">{t('achievement_rate')}</th>
            <th className="px-2 py-1">{t('defect_rate')}</th>
            <th className="px-2 py-1">{t('uph')}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r: AssemblyReport) => (
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
                <span className={`${(r.achievement_rate || 0) >= 100 ? 'text-green-600' : (r.achievement_rate || 0) >= 80 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {r.achievement_rate}%
                </span>
              </td>
              <td className="px-2 py-1 text-right">
                <span className={`${(r.defect_rate || 0) <= 2 ? 'text-green-600' : (r.defect_rate || 0) <= 5 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {r.defect_rate}%
                </span>
              </td>
              <td className="px-2 py-1 text-right">
                {(() => {
                  const uph = r.uph || 0;
                  const color = uph >= 100 ? 'text-green-600' : uph >= 50 ? 'text-yellow-600' : 'text-red-600';
                  return (
                    <span className={color}>
                      {uph || '-'}
                    </span>
                  );
                })()}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-green-100 font-semibold">
          <tr>
            <td className="px-2 py-1 text-center" colSpan={3}>{t('sum')}</td>
            <td className="px-2 py-1 text-right">{totalPlan.toLocaleString()}</td>
            <td className="px-2 py-1 text-right">{totalActual.toLocaleString()}</td>
            <td className="px-2 py-1 text-right">{totalDefect.toLocaleString()}</td>
            <td className="px-2 py-1 text-right" colSpan={3}>
              {t('achievement_rate')}: {achievementRate.toFixed(1)}%
            </td>
          </tr>
        </tfoot>
      </table>

      {detail && (
        <Dialog open={!!detail} onClose={() => setDetail(null)} className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
          <Dialog.Panel className="relative bg-white rounded-lg w-full max-w-5xl p-4 space-y-3 max-h-[80vh] overflow-y-auto text-sm">
            {!editing ? (
              <>
                <Dialog.Title className="text-lg font-bold">
                  {dayjs(detail.date).format('YYYY.MM.DD')} – {detail.line_no} 라인
                </Dialog.Title>
                {/* Header chips */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-2">
                    {(() => {
                      const s = (detail as any)?.supply_type || '';
                      const label = s === 'JIT' ? 'JIT' : (s === 'CSK' ? 'CSKD' : (s || 'N/A'));
                      return (
                        <span className="px-2 py-1 rounded-full bg-blue-50 text-blue-700 text-xs inline-flex items-center gap-1">
                          <Tag className="w-3 h-3" /> {t('supply_type')}: {label}
                        </span>
                      );
                    })()}
                    <span className="px-2 py-1 rounded-full bg-gray-50 text-gray-700 text-xs inline-flex items-center gap-1">
                      {t('report_date')}: {detail.date}
                    </span>
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <span className="px-2 py-1 rounded-md bg-green-50 text-green-700 text-xs inline-flex items-center gap-1">
                      <Percent className="w-3 h-3" /> {t('achievement_rate')}: {detail.achievement_rate}%
                    </span>
                    <span className="px-2 py-1 rounded-md bg-amber-50 text-amber-700 text-xs inline-flex items-center gap-1">
                      <Percent className="w-3 h-3" /> {t('defect_rate')}: {detail.defect_rate}%
                    </span>
                    <span className="px-2 py-1 rounded-md bg-indigo-50 text-indigo-700 text-xs inline-flex items-center gap-1">
                      <Gauge className="w-3 h-3" /> {t('uph')}: {detail.uph || '-'}
                    </span>
                  </div>
                </div>

                {/* Info cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-1">
                  <div className="rounded-lg shadow-sm">
                    <div className="px-3 py-2 font-semibold text-blue-700 bg-blue-50">基本信息 / 기본 정보</div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <span className="text-gray-500">{t('assembly_line_no')}</span><span>{detail.line_no}</span>
                      <span className="text-gray-500">{t('model')}</span><span>{detail.model}</span>
                      <span className="text-gray-500">{t('part_no')}</span>
                      <span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePartNoClick(detail.part_no, e);
                          }}
                          className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                          title="Part No. 히스토리 보기"
                        >
                          {detail.part_no}
                        </button>
                      </span>
                      <span className="text-gray-500">{t('supply_type')}</span><span>{(detail as any)?.supply_type || '-'}</span>
                      <span className="text-gray-500">{t('header_note')}</span><span className="col-span-1">{detail.note || '-'}</span>
                    </div>
                  </div>
                  <div className="rounded-lg shadow-sm">
                    <div className="px-3 py-2 font-semibold text-emerald-700 bg-emerald-50">生产概要 / 생산 요약</div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <span className="text-gray-500">{t('plan_qty_summary')}</span><span className="font-mono text-right">{detail.plan_qty?.toLocaleString()}</span>
                      <span className="text-gray-500">{t('actual_qty_summary')}</span><span className="font-mono text-right">{detail.actual_qty?.toLocaleString()}</span>
                      <span className="text-gray-500">{t('injection_defect_summary')}</span><span className="font-mono text-right">{detail.injection_defect?.toLocaleString()}</span>
                      <span className="text-gray-500">{t('processing_defect_summary')}</span><span className="font-mono text-right">{detail.processing_defect?.toLocaleString()}</span>
                      <span className="text-gray-500">{t('incoming_defect_summary')}</span><span className="font-mono text-right">{detail.incoming_defect_qty?.toLocaleString()}</span>
                      <span className="text-gray-500">{t('total_defect_summary')}</span><span className="font-mono text-right">{detail.total_defect_qty?.toLocaleString()}</span>
                      <span className="text-gray-500">{t('total_time_summary')}</span><span className="font-mono text-right">{detail.total_time ? `${detail.total_time}${t('minutes_unit')}` : '-'}</span>
                      <span className="text-gray-500">{t('operation_time_summary')}</span><span className="font-mono text-right">{detail.operation_time ? `${detail.operation_time}${t('minutes_unit')}` : '-'}</span>
                      <span className="text-gray-500">{t('idle_time_summary')}</span><span className="font-mono text-right">{detail.idle_time ? `${detail.idle_time}${t('minutes_unit')}` : '-'}</span>
                      <span className="text-gray-500">{t('workers_summary')}</span><span className="font-mono text-right">{detail.workers}{t('people_unit')}</span>
                      <span className="text-gray-500">{t('achievement_rate_summary')}</span><span className="font-mono text-right">{detail.achievement_rate}%</span>
                      <span className="text-gray-500">{t('defect_rate_summary')}</span><span className="font-mono text-right">{detail.defect_rate}%</span>
                      <span className="text-gray-500">UPH</span><span className="font-mono text-right">{detail.uph || '-'}</span>
                      <span className="text-gray-500">UPPH</span><span className="font-mono text-right">{detail.upph || '-'}</span>
                    </div>
                  </div>
                </div>

                {/* Defects detail tables */}
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-lg shadow-sm">
                    <div className="px-3 py-2 font-semibold text-amber-700 bg-amber-50">{t('assembly_injection_defect')}</div>
                    <table className="w-full text-sm">
                      <tbody>
                        {(() => {
                          const inc = (detail as any)?.incoming_defects_detail || {};
                          const items = ['scratch','black_dot','eaten_meat','air_mark','deform','short_shot','broken_pillar','flow_mark','sink_mark','whitening'];
                          return items.map(k => (
                            <tr key={k} className="odd:bg-gray-50">
                              <td className="px-3 py-1 text-gray-700">{t(`def_${k}`)}</td>
                              <td className="px-3 py-1 text-right font-mono">{Number(inc[k]||0)}</td>
                            </tr>
                          ));
                        })()}
                        <tr className="bg-gray-50">
                          <td className="px-3 py-1 font-semibold">{t('sum')}</td>
                          <td className="px-3 py-1 text-right font-mono font-semibold">{(() => {
                            const inc = (detail as any)?.incoming_defects_detail || {};
                            const items = ['scratch','black_dot','eaten_meat','air_mark','deform','short_shot','broken_pillar','flow_mark','sink_mark','whitening'];
                            return items.reduce((a,k)=> a + (Number(inc[k]||0)), 0);
                          })()}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="rounded-lg shadow-sm">
                    <div className="px-3 py-2 font-semibold text-cyan-700 bg-cyan-50">{t('processing_defect')}</div>
                    <table className="w-full text-sm">
                      <tbody>
                        {(() => {
                          const pr = (detail as any)?.processing_defects_detail || {};
                          const items = ['scratch','printing','rework','other'];
                          return items.map(k => (
                            <tr key={k} className="odd:bg-gray-50">
                              <td className="px-3 py-1 text-gray-700">{t(`def_${k}`)}</td>
                              <td className="px-3 py-1 text-right font-mono">{Number(pr[k]||0)}</td>
                            </tr>
                          ));
                        })()}
                        <tr className="bg-gray-50">
                          <td className="px-3 py-1 font-semibold">{t('sum')}</td>
                          <td className="px-3 py-1 text-right font-mono font-semibold">{(() => {
                            const pr = (detail as any)?.processing_defects_detail || {};
                            const items = ['scratch','printing','rework','other'];
                            return items.reduce((a: number, k: string)=> a + (Number(pr[k]||0)), 0);
                          })()}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="warning" className="font-semibold" onClick={async () => {
                    if (!detail) return;
                    try {
                      setLoadingEdit(true);
                      setEditing(true);
                      const { data } = await api.get(`/assembly/reports/${detail.id}/`);
                      const norm = (v: any, d: any) => (v === null || v === undefined || Number.isNaN(v) ? d : v);
                      setEditingData({
                        ...detail,
                        ...data,
                        plan_qty: norm(data.plan_qty, 0),
                        actual_qty: norm(data.actual_qty, 0),
                        input_qty: norm(data.input_qty, 0),
                        total_time: norm(data.total_time, 0),
                        idle_time: norm(data.idle_time, 0),
                        operation_time: norm(data.operation_time, 0),
                        injection_defect: norm(data.injection_defect, 0),
                        outsourcing_defect: norm(data.outsourcing_defect, 0),
                        processing_defect: norm(data.processing_defect, 0),
                        workers: norm(data.workers, 1),
                        note: data.note || '',
                        line_no: data.line_no || '',
                        model: data.model || '',
                        part_no: data.part_no || '',
                      });
                    } catch (_) {
                      setEditingData(detail);
                    } finally {
                      setLoadingEdit(false);
                    }
                  }}>{t('edit')}</Button>
                  <Button variant="danger" className="font-semibold" onClick={handleDelete}>{t('delete')}</Button>
                  <Button variant="secondary" className="font-semibold" onClick={() => setDetail(null)}>{t('close')}</Button>
                </div>
              </>
            ) : (
              <>
                <Dialog.Title className="text-lg font-bold">
                  {dayjs(detail.date).format('YYYY.MM.DD')} – {detail.line_no} 라인 {t('edit')}
                </Dialog.Title>
                {loadingEdit && (
                  <div className="py-10 text-center text-gray-500 text-sm">Loading…</div>
                )}
                {!loadingEdit && (
                  <AssemblyReportForm
                    onSubmit={handleSave}
                    isLoading={false}
                    initialData={editingData || detail}
                    compact
                  />
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setEditing(false)}>{t('cancel')}</Button>
                </div>
              </>
            )}
          </Dialog.Panel>
        </Dialog>
      )}

      {/* Historical Performance Modal */}
      <AssemblyHistoricalPerformanceModal
        isOpen={showHistoricalModal}
        onClose={() => setShowHistoricalModal(false)}
        partPrefix={selectedPartPrefix}
      />
    </>
  );
}