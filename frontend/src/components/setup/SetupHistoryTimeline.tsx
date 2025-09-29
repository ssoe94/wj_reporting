import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import MachineSetupModal from './MachineSetupModal';
import CycleTimeHistoryGraph from './CycleTimeHistoryGraph';

interface Setup {
  id: number;
  setup_date: string;
  machine_no: number;
  part_no: string;
  model_code: string;
  target_cycle_time: number;
  standard_cycle_time: number | null;
  mean_cycle_time: number | null;
  status: string;
  setup_by_name: string;
  note: string;
  test_records: any[];
  avg_test_cycle_time: number | null;
  test_count: number;
  quality_pass_rate: number | null;
}

interface SetupItem {
  model_code: string;
  part_no: string;
  target_cycle_time: number;
  count: number;
  latest_setup_date: string;
  setups: Setup[];
}

interface GroupedSetups {
  [date: string]: {
    [machineNo: number]: SetupItem[];
  };
}

interface SetupHistoryTimelineProps {
  setups: Setup[];
  loadSetups: () => void;
  getStatusIcon: (status: string) => React.ReactElement;
  getStatusText: (status: string) => string;
  onBackToDashboard?: () => void;
  t: (key: string, params?: any) => string;
  lang: 'ko' | 'zh';
}

const TimelineCell = ({ setups, onCellClick, t }: {
  setups: SetupItem[],
  onCellClick: (setups: Setup[]) => void,
  t: (key: string, params?: any) => string
}) => {
  if (setups.length === 0) {
    return <div className="border border-gray-200 rounded p-2 min-h-20 bg-gray-50"></div>;
  }

  const handleClick = () => {
    const allSetups = setups.flatMap(item => item.setups);
    onCellClick(allSetups);
  };

  return (
    <div
      className={`border rounded p-2 min-h-20 text-xs cursor-pointer transition-colors ${
        setups.length > 0
          ? 'bg-white border-indigo-200 hover:bg-indigo-50 shadow-sm'
          : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
      }`}
      onClick={handleClick}
    >
      {setups.map((setup, index) => (
        <div key={index} className="mb-2 last:mb-0">
          <div className="font-semibold text-gray-900 mb-1 leading-tight break-words" title={setup.model_code}>
            {setup.model_code}
          </div>
          <div className="text-gray-600 mb-1 leading-tight break-words" title={setup.part_no}>
            {setup.part_no}
          </div>
          <div className="flex items-center justify-between">
            <div className="text-blue-600 text-xs">
              {t('history.target_ct_label')}: {setup.target_cycle_time}{t('unit.seconds')}
            </div>
            {setup.count > 1 && (
              <div className="text-orange-500 text-xs bg-orange-100 px-1 rounded">
                ×{setup.count}
              </div>
            )}
          </div>
          {/* 추가 사이클 타임 정보 */}
          {setup.setups[0].standard_cycle_time && (
            <div className="text-green-600 text-xs mt-1">
              {t('history.standard_ct_label')}: {setup.setups[0].standard_cycle_time}{t('unit.seconds')}
            </div>
          )}
          {setup.setups[0].mean_cycle_time && (
            <div className="text-purple-600 text-xs">
              {t('history.mean_ct_label')}: {setup.setups[0].mean_cycle_time}{t('unit.seconds')}
            </div>
          )}
          {index < setups.length - 1 && (
            <hr className="my-2 border-gray-300" />
          )}
        </div>
      ))}
    </div>
  );
};

export default function SetupHistoryTimeline({ setups, loadSetups, t, lang }: SetupHistoryTimelineProps) {
  const [selectedSetups, setSelectedSetups] = useState<Setup[]>([]);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [selectedSetup, setSelectedSetup] = useState<Setup | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [currentDateRange, setCurrentDateRange] = useState(() => {
    // 오늘부터 5일 전까지의 범위로 초기화
    const today = new Date();
    const endDate = new Date(today);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 4); // 5일간 (오늘 포함)
    return { startDate, endDate };
  });


  // 사출기 번호 배열 (1-17호기)
  const machineNumbers = Array.from({ length: 17 }, (_, i) => i + 1);

  const handleCellClick = (cellSetups: Setup[]) => {
    setSelectedSetups(cellSetups);
    setShowDetailModal(true);
  };

  const handleEditSetup = (setup: Setup) => {
    setSelectedSetup(setup);
    setShowEditModal(true);
  };

  const handleEditModalClose = () => {
    setShowEditModal(false);
    setSelectedSetup(null);
  };

  const handleEditModalSuccess = () => {
    loadSetups(); // 데이터 새로고침
    setShowEditModal(false);
    setSelectedSetup(null);
    setShowDetailModal(false); // 상세 모달도 닫기
  };

  const handleDeleteSetup = async (setup: Setup) => {
    if (window.confirm(t('history.delete_confirm', { machine_no: setup.machine_no, part_no: setup.part_no }))) {
      try {
        await api.delete(`/setup/${setup.id}/`);
        toast.success(t('history.delete_success'));
        loadSetups(); // 데이터 새로고침
        setShowDetailModal(false); // 상세 모달 닫기
      } catch (error) {
        toast.error(t('history.delete_fail'));
      }
    }
  };



  // 날짜 범위 이동 함수들
  const handleDateRangeMove = (direction: 'prev' | 'next') => {
    const days = direction === 'prev' ? -1 : 1;
    setCurrentDateRange(prev => {
      const newStartDate = new Date(prev.startDate);
      const newEndDate = new Date(prev.endDate);
      newStartDate.setDate(prev.startDate.getDate() + days);
      newEndDate.setDate(prev.endDate.getDate() + days);
      return { startDate: newStartDate, endDate: newEndDate };
    });
  };

  // 5일간의 날짜 배열 생성
  const dateRange = useMemo(() => {
    const dates = [];
    const current = new Date(currentDateRange.startDate);
    while (current <= currentDateRange.endDate) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }, [currentDateRange]);

  // 날짜를 YYYY-MM-DD 형태로 포맷
  const formatDateForAPI = (date: Date) => {
    return date.toISOString().split('T')[0];
  };

  // 데이터 그룹핑 로직 (5일 범위로 제한)
  const groupedSetups = useMemo(() => {
    const grouped: GroupedSetups = {};

    // 현재 날짜 범위 내의 설정만 필터링
    const filteredSetups = setups.filter(setup => {
      const setupDate = new Date(setup.setup_date);
      setupDate.setHours(0, 0, 0, 0);
      const startDate = new Date(currentDateRange.startDate);
      const endDate = new Date(currentDateRange.endDate);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      return setupDate >= startDate && setupDate <= endDate;
    });

    // 날짜별로 그룹화 (언어에 독립적인 ISO 날짜 키 사용)
    for (const setup of filteredSetups) {
      const setupDate = new Date(setup.setup_date);
      const dateKey = setupDate.toISOString().split('T')[0]; // YYYY-MM-DD 형식으로 언어 독립적
      const machineKey = setup.machine_no;

      if (!grouped[dateKey]) {
        grouped[dateKey] = {};
      }
      if (!grouped[dateKey][machineKey]) {
        grouped[dateKey][machineKey] = [];
      }

      // 같은 값이 있는지 확인 (model_code, part_no, target_cycle_time)
      const existingIndex = grouped[dateKey][machineKey].findIndex(item =>
        item.model_code === setup.model_code &&
        item.part_no === setup.part_no &&
        item.target_cycle_time === setup.target_cycle_time
      );

      if (existingIndex >= 0) {
        // 같은 값이면 병합
        grouped[dateKey][machineKey][existingIndex].count += 1;
        grouped[dateKey][machineKey][existingIndex].setups.push(setup);
        // 최신 날짜로 업데이트
        if (new Date(setup.setup_date) > new Date(grouped[dateKey][machineKey][existingIndex].latest_setup_date)) {
          grouped[dateKey][machineKey][existingIndex].latest_setup_date = setup.setup_date;
        }
      } else {
        // 다른 값이면 새로 추가 (위쪽에 추가)
        grouped[dateKey][machineKey].unshift({
          model_code: setup.model_code,
          part_no: setup.part_no,
          target_cycle_time: setup.target_cycle_time,
          count: 1,
          latest_setup_date: setup.setup_date,
          setups: [setup]
        });
      }
    }

    return grouped;
  }, [setups, currentDateRange]);

  // 5일간의 날짜를 ISO 형식으로 변환 (역순으로 - 최신이 위)
  const displayDates = useMemo(() => {
    return [...dateRange].reverse().map(date => date.toISOString().split('T')[0]);
  }, [dateRange]);


  return (
    <div className="space-y-6">
      {/* 타이틀 및 날짜 네비게이션 */}
      <Card className="p-4">
        <div className="flex justify-center items-center gap-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleDateRangeMove('prev')}
            className="flex items-center gap-1"
            title={t('history.prev_dates')}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-4">
            <h3 className="text-lg font-semibold text-gray-900">{t('history.timeline_title')}</h3>
            <span className="text-sm text-gray-500">
              {formatDateForAPI(currentDateRange.startDate)} ~ {formatDateForAPI(currentDateRange.endDate)}
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleDateRangeMove('next')}
            className="flex items-center gap-1"
            title={t('history.next_dates')}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </Card>

      {/* 타임라인 그리드 */}
      <Card className="p-4">
        <div className="overflow-x-auto">
          <div className="grid gap-2 mb-2" style={{gridTemplateColumns: '100px repeat(5, 1fr)', minWidth: 'fit-content'}}>
            {/* 헤더 */}
            <div className="text-center font-semibold text-gray-700 p-2 bg-gray-100 rounded sticky left-0 z-10">
              {t('history.machine_unit')}
            </div>
            {displayDates.map((dateKey) => {
              // 해당 날짜에 데이터가 있는지 확인
              const hasData = groupedSetups[dateKey] && Object.keys(groupedSetups[dateKey]).length > 0;

              return (
                <div
                  key={dateKey}
                  className={`text-center font-semibold p-2 text-sm rounded transition-colors ${
                    hasData
                      ? 'bg-blue-100 text-blue-800 border-blue-200 border-2'
                      : 'bg-gray-50 text-gray-700'
                  }`}
                >
                  <div className="flex flex-col items-center">
                    <span className="font-semibold text-sm">
                      {(() => {
                        // ISO 날짜 키를 Date 객체로 변환하여 현재 언어로 포맷
                        const date = new Date(dateKey + 'T00:00:00');
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        const weekday = date.toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'zh-CN', {weekday: 'short'});
                        return `${month}.${day}. (${weekday})`;
                      })()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 데이터 행들 - 호기별 */}
          <div className="overflow-y-auto" style={{maxHeight: 'calc(100vh - 400px)'}}>
            <div className="space-y-2">
              {machineNumbers.map((machineNo) => {
                // 해당 호기에 현재 날짜 범위에서 데이터가 있는지 확인
                const hasData = displayDates.some(dateKey =>
                  groupedSetups[dateKey] && groupedSetups[dateKey][machineNo] && groupedSetups[dateKey][machineNo].length > 0
                );

                return (
                  <div key={machineNo} className="grid gap-2" style={{gridTemplateColumns: '100px repeat(5, 1fr)', minWidth: 'fit-content'}}>
                    {/* 호기 열 */}
                    <div className={`flex items-center justify-center p-3 rounded text-sm font-medium sticky left-0 z-10 transition-colors ${
                      hasData
                        ? 'bg-green-100 text-green-800 border-green-200 border-2'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      <div className="flex flex-col items-center">
                        <span className="font-semibold text-lg">{machineNo}</span>
                        <span className="text-xs">{t('history.machine_unit')}</span>
                      </div>
                    </div>

                    {/* 각 날짜별 셀 */}
                    {displayDates.map((dateKey) => (
                      <TimelineCell
                        key={dateKey}
                        setups={groupedSetups[dateKey] ? (groupedSetups[dateKey][machineNo] || []) : []}
                        onCellClick={handleCellClick}
                        t={t}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Card>

      {/* 상세 모달 */}
      {showDetailModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-4xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-4">
                <h3 className="text-lg font-semibold">{t('history.detail_title')}</h3>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowDetailModal(false)}
                >
                  <X className="w-4 h-4" />
                  {t('close')}
                </Button>
              </div>
            </div>


            <div className="space-y-3">
              {selectedSetups.map((setup) => (
                <div key={setup.id} className="p-4 rounded-lg transition-colors bg-gray-50">

                  {setup.note && (
                    <div className="mt-3 text-sm text-gray-600 bg-white p-2 rounded border-l-4 border-blue-200">
                      <strong>{t('history.setup_note_label')}:</strong> {setup.note}
                    </div>
                  )}
                </div>
              ))}
              {selectedSetups.length > 0 && (
                <div className="mt-4">
                  <CycleTimeHistoryGraph
                    partNo={selectedSetups[0].part_no}
                    onEdit={handleEditSetup}
                    onDelete={handleDeleteSetup}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 편집 모달 */}
      {selectedSetup && (
        <MachineSetupModal
          isOpen={showEditModal}
          onClose={handleEditModalClose}
          machineId={selectedSetup.machine_no}
          setup={selectedSetup}
          onSuccess={handleEditModalSuccess}
        />
      )}
    </div>
  );
}