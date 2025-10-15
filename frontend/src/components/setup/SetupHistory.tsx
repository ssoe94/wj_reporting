import { useEffect, useState } from 'react';
import SetupHistoryTimeline from './SetupHistoryTimeline';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import TestRecordModal from './TestRecordModal';

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

interface SetupHistoryProps {
  getStatusText?: (status: string) => string;
}

const SetupHistory = ({ getStatusText }: SetupHistoryProps) => {
  const { t, lang } = useLang();
  const [setups, setSetups] = useState<Setup[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [selectedSetup, setSelectedSetup] = useState<Setup | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  const loadSetups = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/injection/setup/?ordering=-setup_date&limit=500');
      setSetups(response.data?.results || response.data || []);
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || t('history.load_fail'));
    } finally {
      setIsLoading(false);
    }
  };

  const refreshSetups = () => {
    loadSetups();
  };

  useEffect(() => {
    loadSetups();
  }, []);

  const defaultGetStatusText = (status: string) => status;

  return (
    <div className="space-y-6">
      {isLoading ? (
        <div className="p-6 text-center text-gray-500">{t('loading')}</div>
      ) : (
        <SetupHistoryTimeline
          setups={setups}
          getStatusText={getStatusText || defaultGetStatusText}
          onSelectSetups={(selected, focused) => {
            setSelectedSetup(focused || selected[0] || null);
            setShowDetailModal(true);
          }}
          t={t}
          lang={lang}
        />
      )}

      {/* 상세/테스트 기록 모달 */}
      {showDetailModal && selectedSetup && (
        <TestRecordModal
          setup={selectedSetup}
          onClose={() => {
            setShowDetailModal(false);
            setSelectedSetup(null);
          }}
          onSuccess={refreshSetups}
        />
      )}
    </div>
  );
};

export default SetupHistory;
