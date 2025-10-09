import { Dialog } from '@headlessui/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import AssemblyHistoricalPerformanceChart from './AssemblyHistoricalPerformanceChart';
import { Button } from './ui/button';
import { motion, AnimatePresence } from 'framer-motion';
import dayjs from 'dayjs';

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
    } catch (err) {
      setSelectedRecord(null);
      setDetailError('상세 데이터를 가져오지 못했습니다.');
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
                가공 생산 분석 - {partPrefix}**
              </Dialog.Title>

              <div className="min-h-[20rem] flex items-center justify-center">
                {isLoading && <p>로딩 중...</p>}
                {error && <p className="text-red-500">데이터 로딩 오류</p>}
                {data && data.length > 0 && <AssemblyHistoricalPerformanceChart data={data} onBarClick={handleBarClick} />}
                {data && data.length === 0 && <p>데이터가 없습니다</p>}
              </div>

              <div className="flex justify-end">
                <Button variant="secondary" onClick={handleClose}>닫기</Button>
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
                  ← 뒤로
                </Button>
                <Dialog.Title className="text-xl font-bold">
                  {dayjs(selectedRecord?.date).format('YYYY.MM.DD')} – {selectedRecord?.line_no}호기 상세 기록
                </Dialog.Title>
              </div>

              {detailLoading && (
                <div className="text-center py-10 text-gray-500">상세 데이터를 불러오는 중...</div>
              )}

              {detailError && (
                <div className="text-center py-10 text-red-500">{detailError}</div>
              )}

              {selectedRecord && !detailLoading && !detailError && (
                <div className="grid grid-cols-2 gap-4 text-sm bg-gray-50 p-4 rounded-lg">
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">생산 날짜</span>
                      <span>{selectedRecord.date}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">라인</span>
                      <span>{selectedRecord.line_no}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">모델</span>
                      <span>{selectedRecord.model}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">Part No</span>
                      <span className="font-medium text-blue-600">{selectedRecord.part_no}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">계획 수량</span>
                      <span>{selectedRecord.plan_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">투입 수량</span>
                      <span>{selectedRecord.input_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">실제 생산량</span>
                      <span className="font-medium text-green-600">{selectedRecord.actual_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">재작업 수량</span>
                      <span>{selectedRecord.rework_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">공급 타입</span>
                      <span>{selectedRecord.supply_type}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">사출 불량</span>
                      <span className="text-red-600">{selectedRecord.injection_defect}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">외주 불량</span>
                      <span className="text-red-600">{selectedRecord.outsourcing_defect}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">가공 불량</span>
                      <span className="text-red-600">{selectedRecord.processing_defect}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">총 불량</span>
                      <span className="font-medium text-red-600">{selectedRecord.total_defect_qty}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">총 시간</span>
                      <span>{selectedRecord.total_time ? `${selectedRecord.total_time}분` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">대기 시간</span>
                      <span>{selectedRecord.idle_time ? `${selectedRecord.idle_time}분` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">작업 시간</span>
                      <span className="font-medium text-blue-600">{selectedRecord.operation_time ? `${selectedRecord.operation_time}분` : '-'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">작업자 수</span>
                      <span>{selectedRecord.workers}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500 font-medium">UPH</span>
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
                      <span className="text-gray-500 font-medium">비고</span>
                      <p className="mt-1 text-gray-700">{selectedRecord.note}</p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end mt-6">
                <Button variant="secondary" onClick={handleClose}>닫기</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Dialog.Panel>
    </Dialog>
  );
}
