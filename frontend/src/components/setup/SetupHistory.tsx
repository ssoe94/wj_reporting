import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Filter, TestTube, RefreshCw, Grid, List, ArrowLeft } from 'lucide-react';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import TestRecordModal from './TestRecordModal';
import SetupHistoryTimeline from './SetupHistoryTimeline';
import { useLang } from '@/i18n';

interface Setup {
  id: number;
  setup_date: string;
  machine_no: number;
  part_no: string;
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
  const [setups, setSetups] = useState<Setup[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [viewType, setViewType] = useState<'list' | 'timeline'>('timeline');
  const [filters, setFilters] = useState({
    machine_no: '',
    part_no: '',
    status: '',
    date_from: '',
    date_to: '',
  });

  const [selectedSetup, setSelectedSetup] = useState<Setup | null>(null);
  const [showTestModal, setShowTestModal] = useState(false);

  useEffect(() => {
    loadSetups();
  }, []);

  const loadSetups = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });

      const response = await api.get(`/setup/?${params.toString()}`);
      setSetups(response.data.results || response.data);
    } catch (error) {
      toast.error(t('history.load_fail'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleFilterChange = (field: string, value: string) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };


  const handleTestClick = (setup: Setup) => {
    setSelectedSetup(setup);
    setShowTestModal(true);
  };

  const refreshSetups = () => {
    loadSetups();
  };

  // 기본 아이콘 및 텍스트 함수들 (props가 없을 때 사용)
  const defaultGetStatusIcon = (status: string) => <span>●</span>;
  const defaultGetStatusText = (_status: string) => _status;

  // 타임라인 뷰를 사용하는 경우
  if (viewType === 'timeline') {
    return (
      <div className="space-y-6">
        {/* 상위 제목과 대시보드 버튼 */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">{t('history.title')}</h1>
            {onBackToDashboard && (
              <Button
                onClick={onBackToDashboard}
                className="flex items-center gap-2 bg-blue-500 hover:bg-blue-600 text-white"
                variant="primary"
                size="sm"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('history.back_to_dashboard')}
              </Button>
            )}
          </div>
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
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 뷰 전환 버튼 */}
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">{t('history.title')}</h3>
        <div className="flex gap-2">
          <Button
            variant={viewType === 'timeline' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setViewType('timeline')}
            className="flex items-center gap-2"
          >
            <Grid className="w-4 h-4" />
            {t('history.view_timeline')}
          </Button>
          <Button
            variant={viewType === 'list' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setViewType('list')}
            className="flex items-center gap-2"
          >
            <List className="w-4 h-4" />
            {t('history.view_list')}
          </Button>
        </div>
      </div>

      {/* 필터 */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
          <div>
            <Label htmlFor="filter-machine">{t('history.machine_no_label')}</Label>
            <Input
              id="filter-machine"
              type="number"
              placeholder={t('history.machine_no_label')}
              value={filters.machine_no}
              onChange={(e) => handleFilterChange('machine_no', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="filter-part">{t('history.part_no_label')}</Label>
            <Input
              id="filter-part"
              placeholder={t('history.part_no_label')}
              value={filters.part_no}
              onChange={(e) => handleFilterChange('part_no', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="filter-status">{t('history.status_label')}</Label>
            <select
              id="filter-status"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={filters.status}
              onChange={(e) => handleFilterChange('status', e.target.value)}
            >
              <option value="">{t('all')}</option>
              <option value="SETUP">{t('setup.status_setting')}</option>
              <option value="TESTING">{t('setup.status_testing')}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="filter-date-from">{t('history.date_from_label')}</Label>
            <Input
              id="filter-date-from"
              type="date"
              value={filters.date_from}
              onChange={(e) => handleFilterChange('date_from', e.target.value)}
            />
          </div>
          <div className="flex space-x-2">
            <Button onClick={loadSetups} className="flex items-center gap-2">
              <Filter className="w-4 h-4" />
              {t('history.filter_button')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setFilters({
                  machine_no: '',
                  part_no: '',
                  status: '',
                  date_from: '',
                  date_to: '',
                });
                loadSetups();
              }}
            >
              {t('history.reset_button')}
            </Button>
          </div>
        </div>
      </Card>

      {/* 셋업 목록 */}
      <Card className="p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{t('history.title')}</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshSetups}
            disabled={isLoading}
            className="flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            {t('history.refresh_button')}
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="animate-pulse bg-gray-200 h-20 rounded"></div>
            ))}
          </div>
        ) : setups.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            {t('history.no_data')}
          </div>
        ) : (
          <div className="space-y-3">
            {setups.map((setup) => (
              <div
                key={setup.id}
                className="p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    {getStatusIcon(setup.status)}
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-medium text-gray-900">
                          {t('history.machine_part_info', { machine_no: setup.machine_no, part_no: setup.part_no })}
                        </span>
                        <span className="text-sm text-gray-500">
                          {getStatusText(setup.status)}
                        </span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        <span>{t('history.target_ct_label')}: {setup.target_cycle_time}{t('unit.seconds')}</span>
                        {setup.standard_cycle_time && (
                          <span className="ml-3">{t('history.standard_label')}: {setup.standard_cycle_time}{t('unit.seconds')}</span>
                        )}
                        {setup.mean_cycle_time && (
                          <span className="ml-3">{t('history.mean_label')}: {setup.mean_cycle_time}{t('unit.seconds')}</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {t('history.setup_by_label')}: {setup.setup_by_name} |
                        {new Date(setup.setup_date).toLocaleString(lang === 'ko' ? 'ko-KR' : 'zh-CN')}
                        {setup.test_count > 0 && (
                          <span className="ml-2">{t('history.test_count_label', { count: setup.test_count })}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    {(setup.status === 'SETUP' || setup.status === 'TESTING') && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleTestClick(setup)}
                        className="flex items-center gap-1"
                      >
                        <TestTube className="w-4 h-4" />
                        {t('history.test_button')}
                      </Button>
                    )}
                  </div>
                </div>

                {setup.note && (
                  <div className="mt-3 text-sm text-gray-600 bg-white p-2 rounded border-l-4 border-blue-200">
                    <strong>{t('history.setup_note_label')}:</strong> {setup.note}
                  </div>
                )}

              </div>
            ))}
          </div>
        )}
      </Card>

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
