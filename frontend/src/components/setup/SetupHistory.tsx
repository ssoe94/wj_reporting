import { useEffect, useState } from 'react';
import SetupHistoryTimeline from './SetupHistoryTimeline';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
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
  getStatusIcon?: (status: string) => React.ReactElement;
  getStatusText?: (status: string) => string;
}

const SetupHistory = ({ getStatusIcon, getStatusText }: SetupHistoryProps) => {
  const { t, lang } = useLang();
  const [setups, setSetups] = useState<Setup[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [selectedSetup, setSelectedSetup] = useState<Setup | null>(null);
  const [selectedSetups, setSelectedSetups] = useState<Setup[]>([]);
  const [showDetailModal, setShowDetailModal] = useState(false);

  const navigate = useNavigate();

  const loadSetups = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/setup/?ordering=-setup_date&limit=500');
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

  // 기본 아이콘 및 텍스트 함수들 (props가 없을 때 사용)
  const defaultGetStatusIcon = () => <span>●</span>;
  const defaultGetStatusText = (status: string) => status;

  return (
    <div className="space-y-6">
      {isLoading ? (
        <div className="p-6 text-center text-gray-500">{t('loading')}</div>
      ) : (
        <SetupHistoryTimeline
          setups={setups}
          loadSetups={loadSetups}
          getStatusIcon={getStatusIcon || defaultGetStatusIcon}
          getStatusText={getStatusText || defaultGetStatusText}
          onSelectSetups={(selected, focused) => {
            setSelectedSetups(selected);
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
            setSelectedSetups([]);
          }}
          onSuccess={refreshSetups}
        />
      )}
    </div>
  );
};

export default SetupHistory;
