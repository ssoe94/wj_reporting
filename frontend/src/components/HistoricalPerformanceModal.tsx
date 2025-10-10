import { Dialog } from '@headlessui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import api from '@/lib/api';
import HistoricalPerformanceChart from './HistoricalPerformanceChart';
import { Button } from './ui/button';
import { useLang } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { useAllReports } from '@/hooks/useReports';
import type { Report } from '@/hooks/useReports';
import dayjs from 'dayjs';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  partPrefix: string;
}

// API로부터 받아오는 데이터의 타입
interface PerformanceData {
  date: string;
  part_no: string;
  actual_qty: number;
  actual_cycle_time: number;
}

const fetchHistoricalPerformance = async (partPrefix: string): Promise<PerformanceData[]> => {
  if (!partPrefix) return [];
  const { data } = await api.get('/reports/historical-performance/', {
    params: { part_prefix: partPrefix },
  });
  return data;
};

export default function HistoricalPerformanceModal({ isOpen, onClose, partPrefix }: Props) {
  const { t } = useLang();
  const [showDetailRecord, setShowDetailRecord] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<Report | null>(null);
  const { data: reportsData } = useAllReports();
  const reports = reportsData ?? [];

  const { data, isLoading, error } = useQuery({
    queryKey: ['historicalPerformance', partPrefix],
    queryFn: () => fetchHistoricalPerformance(partPrefix),
    enabled: isOpen && !!partPrefix, // 모달이 열려있고 partPrefix가 있을 때만 쿼리 실행
  });

  // 바차트 클릭 핸들러 - 해당 날짜와 Part No.의 특정 생산 기록 찾기
  const handleBarClick = (date: string, partNo: string) => {
    const record = reports.find(r => r.date === date && r.part_no === partNo);
    if (record) {
      setSelectedRecord(record);
      setShowDetailRecord(true);
    }
  };

  // 뒤로 가기 핸들러
  const handleBackToChart = () => {
    setShowDetailRecord(false);
    setSelectedRecord(null);
  };

  // 모달 닫기 핸들러
  const handleClose = () => {
    setShowDetailRecord(false);
    setSelectedRecord(null);
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
                {t('historical_performance_title')} - {partPrefix}**
              </Dialog.Title>

              <div className="min-h-[20rem] flex items-center justify-center">
                {isLoading && <p>{t('loading')}...</p>}
                {error && <p className="text-red-500">{t('error_loading_data')}</p>}
                {data && data.length > 0 && <HistoricalPerformanceChart data={data} onBarClick={handleBarClick} />}
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
                  {dayjs(selectedRecord?.date).format('YYYY.MM.DD')} – {selectedRecord?.machine_no}호기 {t('detailed_record')}
                </Dialog.Title>
              </div>

              {selectedRecord && (
                <div className="grid grid-cols-2 gap-4 text-sm bg-gray-50 p-4 rounded-lg">
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('report_date')}</span>
                      <span>{selectedRecord.date}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('machine')}</span>
                      <span>{selectedRecord.machine_no}</span>
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
                      <span>{selectedRecord.plan_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('actual_qty')}</span>
                      <span className="font-medium text-green-600">{selectedRecord.actual_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('actual_defect')}</span>
                      <span className="text-red-600">{selectedRecord.actual_defect}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('start_dt')}</span>
                      <span>{selectedRecord.start_datetime ? dayjs(selectedRecord.start_datetime).format('HH:mm') : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('end_dt')}</span>
                      <span>{selectedRecord.end_datetime ? dayjs(selectedRecord.end_datetime).format('HH:mm') : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('total_time')}</span>
                      <span>{selectedRecord.total_time ? `${selectedRecord.total_time}${t('minutes_unit')}` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('idle_time')}</span>
                      <span>{selectedRecord.total_time && selectedRecord.operation_time ? `${selectedRecord.total_time - selectedRecord.operation_time}${t('minutes_unit')}` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('run_time')}</span>
                      <span className="font-medium text-blue-600">{selectedRecord.operation_time ? `${selectedRecord.operation_time}${t('minutes_unit')}` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('achievement_rate')}</span>
                      <span className="font-medium text-green-600">{selectedRecord.achievement_rate ? `${selectedRecord.achievement_rate.toFixed(1)}%` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">{t('table_ct')}</span>
                      <span className="font-medium text-orange-600">
                        {selectedRecord.actual_qty && selectedRecord.operation_time ?
                          `${((selectedRecord.operation_time * 60) / selectedRecord.actual_qty).toFixed(1)}초` :
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
