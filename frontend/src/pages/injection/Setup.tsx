import { useState, useEffect } from 'react';
import { Clock, CheckCircle, XCircle, AlertCircle, Table, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import SetupDashboard from '@/components/setup/SetupDashboard';
import CycleTimeTableForm from '@/components/setup/CycleTimeTableForm';
import SetupHistory from '@/components/setup/SetupHistory';
import MachineSetupModal from '@/components/setup/MachineSetupModal';
import { useLang } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { useMemo } from 'react';

export default function InjectionSetupPage() {
  const { t } = useLang();
  const [showHistory, setShowHistory] = useState(false);
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // 모달 상태
  const [selectedMachine, setSelectedMachine] = useState<{ id: number; setup: any } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const setupsByMachine = useMemo(() => {
    const map = new Map<number, any>();
    // 백엔드에서 이미 오늘 날짜로 필터링된 데이터를 보내므로
    // 프론트엔드에서 날짜 체크 불필요 (시간대 문제 방지)
    (dashboardData?.recent_setups || []).forEach((s: any) => {
      if (typeof s.machine_no === 'number') {
        const prev = map.get(s.machine_no);
        if (!prev || new Date(s.setup_date).getTime() > new Date(prev.setup_date).getTime()) {
          map.set(s.machine_no, s);
        }
      }
    });
    return map;
  }, [dashboardData?.recent_setups]);


  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/injection/setup/dashboard/');
      setDashboardData(response.data);
    } catch (error) {
      toast.error(t('setup.load_dashboard_fail'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleMachineClick = (machineId: number) => {
    const setup = setupsByMachine.get(machineId);
    setSelectedMachine({ id: machineId, setup: setup });
    setIsModalOpen(true);
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setSelectedMachine(null);
  };

  const handleModalSuccess = () => {
    loadDashboardData(); // 데이터 새로고침
    setIsModalOpen(false);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'TESTING':
        return <Clock className="w-4 h-4 text-blue-600" />;
      case 'APPROVED':
        return <CheckCircle className="w-4 h-4 text-green-600" />;
      case 'REJECTED':
        return <XCircle className="w-4 h-4 text-red-600" />;
      default:
        return <AlertCircle className="w-4 h-4 text-yellow-600" />;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'SETUP':
        return t('setup.status_setting');
      case 'TESTING':
        return t('setup.status_testing');
      case 'APPROVED':
        return t('setup.status_approved');
      case 'REJECTED':
        return t('setup.status_rejected');
      default:
        return status;
    }
  };

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-32 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-gray-900">{t('setup.page_title')}</h1>
          <Button
            onClick={() => {
              if (showHistory) {
                setShowHistory(false);
                return;
              }
              setShowHistory(true);
              setIsInitialLoad(false);
            }}
            className="flex items-center gap-2 bg-blue-500 hover:bg-blue-600 text-white"
            variant="primary"
            size="sm"
          >
            {showHistory ? (
              <ArrowLeft className="w-4 h-4" />
            ) : (
              <Table className="w-4 h-4" />
            )}
            {showHistory ? t('setup.history_return_button') : t('setup.history_button')}
          </Button>
        </div>

      </div>

      <AnimatePresence mode="wait">
        {!showHistory ? (
          <motion.div
            key="dashboard"
            initial={isInitialLoad ? false : { opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3 }}
          >
            {dashboardData && (
              <SetupDashboard
                data={dashboardData}
                setupsByMachine={setupsByMachine}
                onRefresh={loadDashboardData}
                getStatusIcon={getStatusIcon}
                getStatusText={getStatusText}
                onMachineClick={handleMachineClick}
                onHistoryClick={() => {
                  setShowHistory(true);
                  setIsInitialLoad(false);
                }}
              />
            )}

            <div className="mt-8">
              <CycleTimeTableForm onSuccess={loadDashboardData} />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="history"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.3 }}
          >

            <SetupHistory />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 사출기 설정 모달 */}
      <MachineSetupModal
        isOpen={isModalOpen}
        onClose={handleModalClose}
        onSuccess={handleModalSuccess}
        machineId={selectedMachine?.id || 0}
        setup={selectedMachine?.setup}
      />
    </div>
  );
}