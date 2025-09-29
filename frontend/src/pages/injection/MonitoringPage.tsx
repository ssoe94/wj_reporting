import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ko, zhCN } from 'date-fns/locale';
import { useLang } from '@/i18n';
import api from '@/lib/api';

// 타입 정의
interface MachineInfo {
  machine_number: number;
  machine_name: string;
  tonnage: string;
  display_name: string;
}

interface TimeSlot {
  hour_offset: number;
  time: string;
  label: string;
  interval_minutes?: number;
}

interface ProductionMatrixData {
  timestamp: string;
  time_slots: TimeSlot[];
  interval_type?: '30min' | '1hour';
  columns?: number;
  machines: MachineInfo[];
  cumulative_production_matrix: { [key: string]: number[] };
  actual_production_matrix: { [key: string]: number[] };
  oil_temperature_matrix: { [key: string]: number[] };
}

// 생산 매트릭스 데이터 조회 (24시간)
const fetchProductionMatrix = async (interval: string = '1hour', lang: string = 'ko'): Promise<ProductionMatrixData> => {
  const params = new URLSearchParams({ interval, columns: '24', lang });
  const response = await api.get(`/production-matrix/?${params}`);
  return response.data;
};

const getCumulativeStyle = (value: number) => {
  if (value === 0) return 'text-gray-400';
  if (value < 100) return 'text-blue-600';
  if (value < 500) return 'text-green-600';
  return 'text-purple-600 font-semibold';
};

const getActualCellStyle = (value: number) => {
  if (value > 0) {
    return {
      cellClass: 'bg-amber-50 border-amber-200',
      textClass: 'text-amber-700 font-semibold',
    };
  }
  return {
    cellClass: 'bg-gray-100 border-gray-200',
    textClass: 'text-gray-400',
  };
};

const getTemperatureStyle = (value: number | null, slotTime: string) => {
  if (value === null || Number.isNaN(value)) {
    return 'text-gray-400';
  }
  const date = new Date(slotTime);
  const month = date.getMonth() + 1;
  const isWinter = month >= 10 || month <= 3;
  const lower = isWinter ? 25 : 35;
  const upper = isWinter ? 35 : 45;
  if (value < lower) return 'text-blue-600 font-semibold';
  if (value > upper) return 'text-red-600 font-semibold';
  return 'text-green-600';
};

export default function InjectionMonitoringPage() {
  const { t, lang } = useLang();
  const [interval, _setMonitoringInterval] = useState<'30min' | '1hour'>('1hour');
  const [isUpdating, setIsUpdating] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<ProductionMatrixData>({
    queryKey: ['productionMatrix', interval, lang],
    queryFn: () => fetchProductionMatrix(interval, lang),
    refetchOnWindowFocus: false, // 자동 갱신 비활성화
  });

  const handleUpdate = async () => {
    if (isUpdating) return;

    setIsUpdating(true);
    try {
      const response = await api.post('/update-recent-snapshots/', { hours: 3 });

      if (response.status === 202) {
        alert(t('monitoring.update_started_in_background'));
      } else if (response.status !== 200 && response.status !== 202) {
        const errorData = response.data;
        const errorMessage = errorData?.message ? `${errorData.message} (Details: ${errorData.details || 'N/A'})` : `HTTP error ${response.status}`;
        throw new Error(errorMessage);
      } else {
        await queryClient.invalidateQueries({ queryKey: ['productionMatrix', interval, lang] });
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      alert(`${t('monitoring.update_failed')}: ${errorMessage}`);
      console.error('Failed to trigger update:', err);
    } finally {
      setIsUpdating(false);
    }
  };

  if (isLoading) {
    return <div className="p-4">{t('loading')}</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500">Error: {error.message}</div>;
  }

  if (!data) return null;

  const reversedTimeSlots = [...data.time_slots].reverse();

  return (
    <div className="p-4 md:p-6 bg-gray-50 min-h-screen">
      <div className="max-w-full mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">{t('monitoring.title')}</h1>
            <p className="text-sm text-gray-600 mt-1">
              {t('monitoring.last_updated')}: {format(new Date(data.timestamp), 'yyyy-MM-dd HH:mm:ss', { locale: lang === 'ko' ? ko : zhCN })}
            </p>
          </div>

          <div className="flex items-center space-x-4">
             <button
              onClick={handleUpdate}
              disabled={isUpdating}
              className={`px-4 py-2 rounded-lg transition-colors w-48 text-center ${
                isUpdating
                  ? 'bg-gray-400 text-gray-600 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {isUpdating ? t('monitoring.updating_button') : t('monitoring.update_button')}
            </button>
          </div>
        </div>

        {isUpdating && (
          <div className="mb-4 bg-blue-50 border border-blue-200 p-4 rounded-lg">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              <span className="text-blue-700 text-sm">{t('monitoring.updating_message')}</span>
            </div>
          </div>
        )}

        <div className="bg-white shadow-lg rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-white sticky top-0 z-10">
                <tr>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider border-r border-gray-200">
                    {t('monitoring.machine_header')}
                  </th>
                  {reversedTimeSlots.map((slot) => (
                    <th
                      key={slot.hour_offset}
                      scope="col"
                      className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider border-r border-gray-200 min-w-[100px]"
                    >
                      <>
                        <span>{format(new Date(slot.time), 'yyyy-MM-dd', { locale: lang === 'ko' ? ko : zhCN })}</span>
                        <br />
                        <span className="font-bold">{format(new Date(slot.time), 'HH:mm', { locale: lang === 'ko' ? ko : zhCN })}</span>
                      </>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {data.machines.map((machine) => {
                  const cumulativeData = data.cumulative_production_matrix[machine.machine_number.toString()]?.slice().reverse() || [];
                  const actualData = data.actual_production_matrix[machine.machine_number.toString()]?.slice().reverse() || [];
                  const tempData = data.oil_temperature_matrix[machine.machine_number.toString()]?.slice().reverse() || [];

                  return (
                    <tr key={machine.machine_number} className="hover:bg-gray-50">
                      <td className="px-4 py-4 whitespace-nowrap border-r border-gray-200 text-center">
                        <div className="text-sm font-medium text-gray-900">
                          {(machine.display_name.endsWith('T') ? machine.display_name : `${machine.display_name}T`).replace('호기', t('호기'))}
                        </div>
                      </td>
                      {reversedTimeSlots.map((slot, index) => {
                        const cumulative = cumulativeData[index] || 0;
                        const actual = actualData[index] || 0;
                        const rawTemp = tempData[index];
                        const temperature = rawTemp === undefined ? null : Number(rawTemp);
                        const { cellClass, textClass } = getActualCellStyle(actual);
                        const tempClass = getTemperatureStyle(temperature, slot.time);

                        return (
                          <td
                            key={index}
                            className={`px-2 py-3 text-center text-xs border-r ${cellClass}`}
                          >
                            {cumulative > 0 || actual > 0 || (temperature !== null && temperature !== 0) ? (
                              <div className="space-y-0.5">
                                <div className={`${getCumulativeStyle(cumulative)} text-xs`}>
                                  {t('monitoring.cumulative_label')}: {cumulative.toLocaleString()}
                                </div>
                                <div className={`${textClass} text-xs font-medium`}>
                                  {data.interval_type === '30min' ? t('monitoring.per_30min_label') : t('monitoring.per_hour_label')}: {actual}{t('monitoring.unit_label')}
                                </div>
                                <div className={`${tempClass} text-xs`}>
                                  {t('monitoring.temp_label')}: {temperature !== null ? temperature.toFixed(1) : '-'}°C
                                </div>
                              </div>
                            ) : (
                              <span className="text-gray-300 text-lg">{t('monitoring.no_data_char')}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}