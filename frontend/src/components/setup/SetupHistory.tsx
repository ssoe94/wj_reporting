import { useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import TestRecordModal from './TestRecordModal';
import SetupHistoryTimeline from './SetupHistoryTimeline';
import { Button } from '@/components/ui/button';
import { useLang } from '@/i18n';

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
  onBackToDashboard?: () => void;
}

export default function SetupHistory({ getStatusIcon, getStatusText, onBackToDashboard }: SetupHistoryProps) {
  const { t, lang } = useLang();
  const [setups] = useState<Setup[]>([]);

  const [selectedSetup, setSelectedSetup] = useState<Setup | null>(null);
  const [showTestModal, setShowTestModal] = useState(false);

  const loadSetups = async () => {
    // Placeholder - 실제로는 SetupHistoryTimeline에서 처리
  };

  const refreshSetups = () => {
    loadSetups();
  };

  // 기본 아이콘 및 텍스트 함수들 (props가 없을 때 사용)
  const defaultGetStatusIcon = () => <span>●</span>;
  const defaultGetStatusText = (status: string) => status;

  return (
    <div className="space-y-6">
      {/* 상위 제목과 대시보드 버튼 */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{t('history.title')}</h1>
        {onBackToDashboard && (
          <Button
            onClick={onBackToDashboard}
            className="flex items-center gap-2 bg-blue-500 hover:bg-blue-600 text-white"
            variant="primary"
            size="sm"
          >
            <LayoutDashboard className="w-4 h-4" />
            {t('setup.dashboard_button')}
          </Button>
        )}
      </div>

      <SetupHistoryTimeline
        setups={setups}
        loadSetups={loadSetups}
        getStatusIcon={getStatusIcon || defaultGetStatusIcon}
        getStatusText={getStatusText || defaultGetStatusText}
        onBackToDashboard={undefined} // 상위에서 처리하므로 undefined 전달
        t={t}
        lang={lang}
      />

      {/* 테스트 기록 모달 */}
      {showTestModal && selectedSetup && (
        <TestRecordModal
          setup={selectedSetup}
          onClose={() => {
            setShowTestModal(false);
            setSelectedSetup(null);
          }}
          onSuccess={refreshSetups}
        />
      )}
    </div>
  );
}
