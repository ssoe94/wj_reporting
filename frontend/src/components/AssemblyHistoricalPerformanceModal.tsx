import { Dialog } from '@headlessui/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import AssemblyHistoricalPerformanceChart from './AssemblyHistoricalPerformanceChart';
import { Button } from './ui/button';
import { motion, AnimatePresence } from 'framer-motion';
import dayjs from 'dayjs';
import { useLang } from '@/i18n';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  partPrefix: string;
}

// API로부터 받아오는 데이터의 타입
interface AssemblyPerformanceData {
  id: number;
  date: string;
  part_no: string;
  line_no: string;
  actual_qty: number;
  uph: number;
  upph: number;
}

// 어셈블리 리포트 타입 (useAssemblyReports에서 가져온 타입과 호환)
interface AssemblyReport {
  id: number;
  date: string;
  line_no: string;
  part_no: string;
  model: string;
  plan_qty: number;
  input_qty: number;
  actual_qty: number;
  rework_qty: number;
  supply_type: string;
  injection_defect: number;
  outsourcing_defect: number;
  processing_defect: number;
  total_defect_qty: number;
  total_time: number | null;
  idle_time: number | null;
  operation_time: number | null;
  workers: number;
  note: string;
}

const fetchAssemblyHistoricalPerformance = async (partPrefix: string): Promise<AssemblyPerformanceData[]> => {
  if (!partPrefix) return [];
  const { data } = await api.get('/assembly/reports/historical-performance/', {
    params: { part_prefix: partPrefix },
  });
  return data;
};

export default function AssemblyHistoricalPerformanceModal({ isOpen, onClose, partPrefix }: Props) {
  const { t } = useLang();
  const [showDetailRecord, setShowDetailRecord] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<AssemblyReport | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['assemblyHistoricalPerformance', partPrefix],
    queryFn: () => fetchAssemblyHistoricalPerformance(partPrefix),
    enabled: isOpen && !!partPrefix,
  });

  useEffect(() => {
    setShowDetailRecord(false);
    setSelectedRecord(null);
    setDetailLoading(false);
    setDetailError(null);
  }, [partPrefix]);

  // 바차트 클릭 핸들러 - 해당 날짜와 Part No.의 특정 생산 기록 찾기
  const handleBarClick = async (recordSummary: AssemblyPerformanceData) => {
    setDetailError(null);
    setDetailLoading(true);
    try {
      const { data: record } = await api.get(`/assembly/reports/${recordSummary.id}/`);
      setSelectedRecord(record);
      setShowDetailRecord(true);
    } catch (_err) {
      setSelectedRecord(null);
      setDetailError(t('fetch_detailed_data_fail'));
      setShowDetailRecord(true);
    } finally {
      setDetailLoading(false);
    }
  };

  // 뒤로 가기 핸들러
  const handleBackToChart = () => {
    setShowDetailRecord(false);
    setSelectedRecord(null);
    setDetailLoading(false);
    setDetailError(null);
  };

  // 모달 닫기 핸들러
  const handleClose = () => {
    setShowDetailRecord(false);
    setSelectedRecord(null);
    setDetailLoading(false);
    setDetailError(null);
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <Dialog.Panel className="relative bg-white rounded-lg w-full max-w-6xl p-6 space-y-2 max-h-[90vh] overflow-hidden">
        <AnimatePresence mode="wait">
          {!showDetailRecord ? (
            <motion.div
              key="chart"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              <Dialog.Title className="text-xl font-bold">
                {t('assembly_production_analysis')} - {partPrefix}**
              </Dialog.Title>

              <div className="min-h-[20rem] flex items-center justify-center">
                {isLoading && <p>{t('loading')}</p>}
                {error && <p className="text-red-500">{t('data_loading_error')}</p>}
                {data && data.length > 0 && <AssemblyHistoricalPerformanceChart data={data} onBarClick={handleBarClick} />}
                {data && data.length === 0 && <p>{t('no_data')}</p>}
              </div>

              <div className="flex justify-end">
                <Button variant="secondary" onClick={handleClose}>{t('close')}</Button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="detail"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
              className="max-h-[80vh] overflow-y-auto"
            >
              <div className="flex items-center gap-4 mb-4">
                <Button variant="secondary" onClick={handleBackToChart}>
                  ← {t('back')}
                </Button>
                <Dialog.Title className="text-xl font-bold">
                  {dayjs(selectedRecord?.date).format('YYYY.MM.DD')} – {selectedRecord?.line_no} {t('line_unit')} {t('detailed_record')}
                </Dialog.Title>
              </div>

              {detailLoading && (
                <div className="text-center py-10 text-gray-500">{t('loading_detailed_data')}</div>
              )}

              {detailError && (
                <div className="text-center py-10 text-red-500">{detailError}</div>
              )}

              {selectedRecord && !detailLoading && !detailError && (
                <div className="grid grid-cols-2 gap-4 text-sm bg-gray-50 p-4 rounded-lg">
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('report_date')}</span>
                      <span>{selectedRecord.date}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('line')}</span>
                      <span>{selectedRecord.line_no}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('model')}</span>
                      <span>{selectedRecord.model}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">Part No</span>
                      <span className="font-medium text-blue-600">{selectedRecord.part_no}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('plan_qty')}</span>
                      <span>{selectedRecord.plan_qty.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('input_qty')}</span>
                      <span>{selectedRecord.input_qty.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('actual_qty')}</span>
                      <span className="font-medium text-green-600">{selectedRecord.actual_qty.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('rework_qty')}</span>
                      <span>{selectedRecord.rework_qty.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('supply_type')}</span>
                      <span>{selectedRecord.supply_type}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('injection_defect')}</span>
                      <span className="text-red-600">{selectedRecord.injection_defect}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('outsourcing_defect')}</span>
                      <span className="text-red-600">{selectedRecord.outsourcing_defect}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('processing_defect')}</span>
                      <span className="text-red-600">{selectedRecord.processing_defect}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('defect_total')}</span>
                      <span className="font-medium text-red-600">{selectedRecord.total_defect_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('total_time')}</span>
                      <span>{selectedRecord.total_time ? `${selectedRecord.total_time}${t('minutes_unit')}` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('idle_time')}</span>
                      <span>{selectedRecord.idle_time ? `${selectedRecord.idle_time}${t('minutes_unit')}` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('prod_time')}</span>
                      <span className="font-medium text-blue-600">{selectedRecord.operation_time ? `${selectedRecord.operation_time}${t('minutes_unit')}` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('worker_count')}</span>
                      <span>{selectedRecord.workers}{t('people_unit')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('analysis_metric_uph')}</span>
                      <span className="font-medium text-orange-600">
                        {selectedRecord.actual_qty && selectedRecord.operation_time ?
                          `${((selectedRecord.actual_qty / (selectedRecord.operation_time / 60)).toFixed(1))}` :
                          '-'
                        }
                      </span>
                    </div>
                  </div>
                  {selectedRecord.note && (
                    <div className="col-span-2 pt-2 border-t border-gray-200">
                      <span className="text-gray-500 font-medium">{t('header_note')}</span>
                      <p className="mt-1 text-gray-700">{selectedRecord.note}</p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end mt-6">
                <Button variant="secondary" onClick={handleClose}>{t('close')}</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Dialog.Panel>
    </Dialog>
  );
}
