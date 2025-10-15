import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import machines from '@/constants/machines';
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { useLang } from '@/i18n';

interface SetupDashboardProps {
  data: {
    total_setups_today: number;
    pending_approvals: number;
    approved_today: number;
    rejected_today: number;
    active_machines: number[];
    recent_setups: any[];
  };
  onRefresh: () => void;
  getStatusIcon: (status: string) => React.ReactElement;
  getStatusText: (status: string) => string;
  onMachineClick?: (machineId: number) => void;
  onHistoryClick?: () => void;
  setupsByMachine: Map<number, any>;
}

export default function SetupDashboard({ data, onRefresh, onMachineClick, setupsByMachine }: SetupDashboardProps) {
  const { t } = useLang();
  const stats: any[] = [];

  // part_no -> { model_code, description } 매핑
  const [partInfoMap, setPartInfoMap] = useState<Record<string, { model_code?: string; description?: string }>>({});

  useEffect(() => {
    const partNos = Array.from(setupsByMachine.values())
      .map((s: any) => s?.part_no)
      .filter((p: any) => typeof p === 'string' && p);
    const unique = Array.from(new Set(partNos));
    if (unique.length === 0) return;

    let cancelled = false;
    (async () => {
      const entries: Array<[string, { model_code?: string; description?: string }]> = [];
      for (const pn of unique) {
        try {
          const { data } = await api.get('/injection/parts/', { params: { search: pn, page_size: 5 } });
          const results = data?.results || [];
          const exact = results.find((r: any) => r.part_no === pn) || results[0] || {};
          entries.push([pn, { model_code: exact.model_code, description: exact.description }]);
        } catch (e) {
          entries.push([pn, {}]);
        }
      }
      if (!cancelled) {
        setPartInfoMap(prev => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    })();

    return () => { cancelled = true; };
  }, [setupsByMachine]);

  const formatModelLabel = (partNo: string, fallbackModel?: string) => {
    const info = partInfoMap[partNo];
    const code = info?.model_code || fallbackModel;
    const desc = info?.description || '';
    if (code && desc) return `${code} - ${desc}`;
    if (code) return code;
    return '-';
  };

  return (
    <div className="space-y-6">
      {/* 통계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {stats.map((stat, index) => (
          <Card key={index} className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 mb-1">{stat.title}</p>
                <p className="text-2xl font-semibold text-gray-900">{stat.value}</p>
              </div>
              <div className={`${stat.color} p-3 rounded-lg text-white`}>
                {stat.icon}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* 활성 사출기 현황 (1~17호기, 6열 카드) */}
      <Card className="p-6">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-900">{t('dashboard.active_machines_title')}</h3>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            className="flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            {t('dashboard.refresh_button')}
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {machines
            .filter(m => m.id >= 1 && m.id <= 17)
            .sort((a, b) => a.id - b.id)
            .map(machine => {
              const isActive = (data.active_machines || []).includes(machine.id);
              const setup = setupsByMachine.get(machine.id);
              const partNo = setup?.part_no || '-';
              const modelLabel = formatModelLabel(partNo, setup?.model_code || setup?.model);
              const targetCycleTime = setup?.target_cycle_time ?? null;
              const meanCycleTime = setup?.mean_cycle_time ?? null;

              const cardBase = 'rounded-lg p-3 border h-36';
              const cardColor = isActive
                ? 'bg-green-50 border-green-200 text-green-900'
                : 'bg-gray-100 border-gray-200 text-gray-800';

              if (!setup) {
                return (
                  <button
                    key={machine.id}
                    className={`${cardBase} ${cardColor} w-full text-left hover:shadow-md transition-shadow duration-200 cursor-pointer hover:scale-105 transform transition-transform flex flex-col`}
                    onClick={() => onMachineClick?.(machine.id)}
                    title={t('dashboard.click_to_setup')}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold">{machine.id}{t('dashboard.machine_id_unit')} - {machine.ton}T</span>
                    </div>
                    <div className="flex-grow flex items-center justify-center">
                      <span className="text-gray-500 text-[10px]">{t('dashboard.no_setup')}</span>
                    </div>
                  </button>
                );
              }

              return (
                <button
                  key={machine.id}
                  className={`${cardBase} ${cardColor} w-full text-left hover:shadow-md transition-shadow duration-200 relative cursor-pointer hover:scale-105 transform transition-transform flex flex-col`}
                  onClick={() => onMachineClick?.(machine.id)}
                  title={t('dashboard.click_to_edit')}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold">{machine.id}{t('dashboard.machine_id_unit')} - {machine.ton}T</span>
                    {isActive && <span className="text-xs font-medium">{t('dashboard.active_label')}</span>}
                  </div>
                  <div className="text-xs">
                    <div className="truncate"><span className="text-gray-500">{t('dashboard.model_label')}</span> : {modelLabel}</div>
                    <div className="truncate"><span className="text-gray-500">{t('dashboard.part_label')}</span> : {partNo}</div>
                    {targetCycleTime !== null ? (
                      <div>
                        <span className="text-gray-500">{t('dashboard.target_ct_label')}</span> : {targetCycleTime}{t('unit.seconds')}
                        {meanCycleTime !== null && (
                          <span style={{ color: targetCycleTime > meanCycleTime ? 'red' : 'green' }}>
                            {' ('}
                            {targetCycleTime > meanCycleTime ? '▲' : '▼'}
                            {Math.abs(targetCycleTime - meanCycleTime)}
                            {t('unit.seconds')}
                            {')'}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div>
                        <span className="text-gray-500">{t('dashboard.cycletime_label')}</span> : -
                      </div>
                    )}
                    {meanCycleTime !== null && (
                        <div>
                            <span className="text-gray-500">平均设定C/T</span> : {meanCycleTime}{t('unit.seconds')}
                        </div>
                    )}
                    {setup && setup.personnel_count !== null && (
                      <div>
                        <span className="text-gray-500">{t('dashboard.personnel_label')}</span> : {setup.personnel_count}{t('people_unit')}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
        </div>
      </Card>

      {/* 최근 셋업 현황 카드 제거됨 */}
    </div>
  );
}