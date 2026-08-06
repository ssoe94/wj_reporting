import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, ArrowLeft, CheckCircle, Clock, Table, XCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import CycleTimeTableForm from '@/components/setup/CycleTimeTableForm';
import MachineSetupModal from '@/components/setup/MachineSetupModal';
import SetupDashboard from '@/components/setup/SetupDashboard';
import SetupHistory from '@/components/setup/SetupHistory';
import { useLang } from '@/i18n';
import api from '@/lib/api';

export default function InjectionSetupPanel() {
  const { t } = useLang();
  const [showHistory, setShowHistory] = useState(false);
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [selectedMachine, setSelectedMachine] = useState<{ id: number; setup: any } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const setupsByMachine = useMemo(() => {
    const map = new Map<number, any>();
    (dashboardData?.recent_setups || []).forEach((setup: any) => {
      if (typeof setup.machine_no === 'number') {
        const previous = map.get(setup.machine_no);
        if (!previous || new Date(setup.setup_date).getTime() > new Date(previous.setup_date).getTime()) {
          map.set(setup.machine_no, setup);
        }
      }
    });
    return map;
  }, [dashboardData?.recent_setups]);

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

  useEffect(() => {
    void loadDashboardData();
  }, []);

  const handleMachineClick = (machineId: number) => {
    const setup = setupsByMachine.get(machineId);
    setSelectedMachine({ id: machineId, setup });
    setIsModalOpen(true);
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setSelectedMachine(null);
  };

  const handleModalSuccess = () => {
    void loadDashboardData();
    setIsModalOpen(false);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'TESTING':
        return <Clock className="h-4 w-4 text-blue-600" />;
      case 'APPROVED':
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      case 'REJECTED':
        return <XCircle className="h-4 w-4 text-red-600" />;
      default:
        return <AlertCircle className="h-4 w-4 text-yellow-600" />;
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
      <div id="cycle-time" className="space-y-4">
        <div className="h-8 w-1/4 animate-pulse rounded bg-slate-200" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          {[...Array(4)].map((_, index) => (
            <div key={index} className="h-32 animate-pulse rounded-2xl bg-slate-200" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div id="cycle-time" className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-blue-700">
            C/T setup
          </div>
          <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-900">{t('setup.page_title')}</h2>
          <p className="mt-1 text-sm text-slate-500">
            사출기별 C/T, 인원, 테스트 기록과 변경 이력을 대시보드 안에서 관리합니다.
          </p>
        </div>
        <Button
          onClick={() => {
            if (showHistory) {
              setShowHistory(false);
              return;
            }
            setShowHistory(true);
            setIsInitialLoad(false);
          }}
          className="flex items-center gap-2 bg-blue-500 text-white hover:bg-blue-600"
          variant="primary"
          size="sm"
        >
          {showHistory ? <ArrowLeft className="h-4 w-4" /> : <Table className="h-4 w-4" />}
          {showHistory ? t('setup.history_return_button') : t('setup.history_button')}
        </Button>
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
