import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ko, zhCN } from 'date-fns/locale';
import { Dialog } from '@headlessui/react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Terminal, X } from 'lucide-react';

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

interface SetupInfo {
  part_no: string;
  model_code: string;
  target_cycle_time: number;
  personnel_count: number;
  status: string;
  setup_date: string;
}

interface ProductionMatrixData {
  timestamp: string;
  time_slots: TimeSlot[];
  interval_type?: '10min' | '30min' | '1hour' | '1day';
  columns?: number;
  machines: MachineInfo[];
  cumulative_production_matrix: { [key: string]: number[] };
  actual_production_matrix: { [key: string]: number[] };
  oil_temperature_matrix: { [key: string]: number[] };
  power_kwh_matrix?: { [key: string]: number[] };
  power_usage_matrix?: { [key: string]: number[] };
  setup_data_map: { [key: string]: SetupInfo };
}

// 생산 매트릭스 데이터 조회 (24시간)
interface ChartSlotData {
  slotIndex: number;
  time: string;
  label: string;
  axisLabel: string;
  totalActual: number;
  totalCumulative: number;
  avgTemperature: number | null;
}

interface UpdateStatusPayload {
  status?: 'idle' | 'running' | 'completed' | 'failed';
  job_id?: string;
  total_steps?: number;
  completed_steps?: number;
  percent?: number;
  started_at?: string;
  finished_at?: string;
  last_slot?: string | null;
  error?: string;
}

interface UpdateProgress {
  status: 'idle' | 'running' | 'completed' | 'failed';
  jobId?: string;
  totalSteps: number;
  completedSteps: number;
  percent: number;
  startedAt?: string;
  finishedAt?: string;
  lastSlot?: string | null;
  error?: string;
}

const fetchProductionMatrix = async (interval: string = '10min', columns: number = 24, lang: string = 'ko'): Promise<ProductionMatrixData> => {
  const params = new URLSearchParams({ interval, columns: columns.toString(), lang });
  const response = await api.get(`/injection/production-matrix/?${params}`);
  return response.data;
};

const normalizeUpdateProgress = (payload: UpdateStatusPayload): UpdateProgress => {
  const rawStatus = payload.status;
  const status: UpdateProgress['status'] = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'running' || rawStatus === 'idle'
    ? rawStatus
    : rawStatus === undefined
      ? 'idle'
      : 'running';
  const totalSteps = payload.total_steps ?? 0;
  const completedSteps = payload.completed_steps ?? 0;
  const percent = payload.percent ?? (totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0);
  return {
    status,
    jobId: payload.job_id,
    totalSteps,
    completedSteps,
    percent,
    startedAt: payload.started_at,
    finishedAt: payload.finished_at,
    lastSlot: payload.last_slot ?? null,
    error: payload.error,
  };
};

const getCumulativeStyle = (value: number) => {
  if (value === 0) return 'text-gray-400';
  if (value < 100) return 'text-blue-600';
  if (value < 500) return 'text-green-600';
  return 'text-purple-600 font-semibold';
};

const getActualCellStyle = (actual: number, targetInterval: number | null) => {
  if (actual <= 0) {
    return {
      cellClass: 'bg-gray-100 border-gray-200',
      textClass: 'text-gray-400',
    };
  }
  if (targetInterval === null || targetInterval <= 0) {
    return {
      cellClass: 'bg-amber-50 border-amber-200',
      textClass: 'text-amber-700 font-semibold',
    };
  }

  const ratio = actual / targetInterval;

  if (ratio >= 0.95) { // 95% 이상: 매우 좋음
    return {
      cellClass: 'bg-green-100 border-green-200',
      textClass: 'text-green-800 font-bold',
    };
  }
  if (ratio >= 0.8) { // 80% 이상: 양호
    return {
      cellClass: 'bg-blue-50 border-blue-200',
      textClass: 'text-blue-700 font-semibold',
    };
  }
  // 80% 미만: 주의
  return {
    cellClass: 'bg-red-100 border-red-200',
    textClass: 'text-red-700 font-bold',
  };
};

const getTemperatureStyle = (value: number | null, slotTime: string) => {
  if (value === null || Number.isNaN(value) || value === 0) {
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
const getSlotValue = (values: number[] | undefined, slotIndex: number) => {
  if (!values || values.length === 0) return 0;
  const reverseIndex = values.length - 1 - slotIndex;
  if (reverseIndex < 0) return 0;
  return values[reverseIndex] ?? 0;
};

export default function InjectionMonitoringPage() {
  const { t, lang } = useLang();
  const [viewMode, setViewMode] = useState<'hour' | 'day'>('hour');
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateJobId, setUpdateJobId] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<ChartSlotData | null>(null);
  const queryClient = useQueryClient();
  const lastRefreshRef = useRef<number>(0);

  const monitoringInterval = viewMode === 'day' ? '1day' : '10min';
  const monitoringColumns = viewMode === 'day' ? 30 : 144;

  const { data, isLoading, error } = useQuery<ProductionMatrixData>({
    queryKey: ['productionMatrix', monitoringInterval, monitoringColumns, lang],
    queryFn: () => fetchProductionMatrix(monitoringInterval, monitoringColumns, lang),
    refetchInterval: isUpdating ? 10 * 1000 : 10 * 60 * 1000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false, // 자동 갱신 비활성화
  });

  const handleUpdate = async () => {
    if (isUpdating) return;

    setIsUpdating(true);
    let startedInBackground = false;
    try {
      const response = await api.post('/injection/update-recent-snapshots/', { mode: 'latest' });

      if (response.status === 202) {
        const payload = normalizeUpdateProgress(response.data || {});
        setUpdateJobId(payload.jobId ?? null);
        setUpdateProgress(payload.status === 'idle' ? { ...payload, status: 'running' } : payload);
        startedInBackground = true;
      } else if (response.status !== 200 && response.status !== 202) {
        const errorData = response.data;
        const errorMessage = errorData?.message ? `${errorData.message} (Details: ${errorData.details || 'N/A'})` : `HTTP error ${response.status}`;
        throw new Error(errorMessage);
      } else {
        await queryClient.invalidateQueries({ queryKey: ['productionMatrix', monitoringInterval, monitoringColumns, lang] });
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      alert(`${t('monitoring.update_failed')}: ${errorMessage}`);
      console.error('Failed to trigger update:', err);
      setUpdateProgress({
        status: 'failed',
        totalSteps: 0,
        completedSteps: 0,
        percent: 0,
        error: errorMessage,
      });
    } finally {
      if (!startedInBackground) {
        setIsUpdating(false);
      }
    }
  };

  const fetchUpdateStatus = useCallback(async (jobId?: string | null) => {
    const response = await api.get('/injection/update-recent-snapshots/status/', {
      params: jobId ? { job_id: jobId } : {},
    });
    return normalizeUpdateProgress(response.data || {});
  }, []);

  useEffect(() => {
    let active = true;
    fetchUpdateStatus()
      .then((progress) => {
        if (!active || progress.status === 'idle') return;
        setUpdateJobId(progress.jobId ?? null);
        setUpdateProgress(progress);
        if (progress.status === 'running') {
          setIsUpdating(true);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [fetchUpdateStatus]);

  useEffect(() => {
    if (!isUpdating) return;
    let active = true;

    const poll = async () => {
      try {
        const progress = await fetchUpdateStatus(updateJobId);
        if (!active) return;
        if (progress.status !== 'idle') {
          setUpdateProgress(progress);
        }

        if (progress.status === 'completed') {
          setIsUpdating(false);
          await queryClient.invalidateQueries({ queryKey: ['productionMatrix', monitoringInterval, monitoringColumns, lang] });
          return;
        }
        if (progress.status === 'failed') {
          setIsUpdating(false);
          return;
        }

        if (progress.status === 'running') {
          const now = Date.now();
          if (now - lastRefreshRef.current > 10000) {
            lastRefreshRef.current = now;
            await queryClient.invalidateQueries({ queryKey: ['productionMatrix', monitoringInterval, monitoringColumns, lang] });
          }
        }
      } catch (err) {
        console.error('Failed to fetch update status:', err);
      }
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [fetchUpdateStatus, isUpdating, lang, monitoringColumns, monitoringInterval, queryClient, updateJobId]);

  useEffect(() => {
    if (!updateProgress || updateProgress.status !== 'completed') return;
    const timer = setTimeout(() => setUpdateProgress(null), 5000);
    return () => clearTimeout(timer);
  }, [updateProgress]);

  const reversedTimeSlots = useMemo(() => (data ? [...data.time_slots].reverse() : []), [data]);
  const displaySlots = useMemo(() => {
    const slots = reversedTimeSlots.map((slot, index) => ({ slot, index }));
    if (viewMode === 'day') {
      return slots;
    }
    return slots.filter(({ slot }, idx) => idx === 0 || new Date(slot.time).getMinutes() === 0);
  }, [reversedTimeSlots, viewMode]);
  const prevSlotIndexMap = useMemo(() => {
    const map = new Map<number, number>();
    displaySlots.forEach((entry, displayIndex) => {
      const prevEntry = displaySlots[displayIndex + 1];
      if (prevEntry) {
        map.set(entry.index, prevEntry.index);
      }
    });
    return map;
  }, [displaySlots]);

  const getDeltaFromCumulative = useCallback((values: number[] | undefined, slotIndex: number) => {
    if (!values) return 0;
    const prevIndex = prevSlotIndexMap.get(slotIndex);
    if (prevIndex === undefined) return 0;

    const currentSlot = reversedTimeSlots[slotIndex];
    const prevSlot = reversedTimeSlots[prevIndex];
    if (!currentSlot || !prevSlot) return 0;

    const diffMinutes = Math.round(
      (new Date(currentSlot.time).getTime() - new Date(prevSlot.time).getTime()) / 60000,
    );
    if (diffMinutes !== 60) return 0;

    const currentVal = getSlotValue(values, slotIndex);
    const prevVal = getSlotValue(values, prevIndex);
    return currentVal >= prevVal ? currentVal - prevVal : 0;
  }, [prevSlotIndexMap, reversedTimeSlots]);

  const getMetricForSlot = useCallback((
    actualValues: number[] | undefined,
    cumulativeValues: number[] | undefined,
    slotIndex: number,
  ) => {
    if (!data) return 0;
    if (viewMode === 'day' || data.interval_type === '1day') {
      return getSlotValue(actualValues, slotIndex);
    }
    const slot = reversedTimeSlots[slotIndex];
    if (slot && new Date(slot.time).getMinutes() !== 0) {
      return getSlotValue(actualValues, slotIndex);
    }
    return getDeltaFromCumulative(cumulativeValues, slotIndex);
  }, [data, getDeltaFromCumulative, reversedTimeSlots, viewMode]);

  const getActualForSlot = useCallback((machineNumStr: string, slotIndex: number) => {
    if (!data) return 0;
    return getMetricForSlot(
      data.actual_production_matrix[machineNumStr],
      data.cumulative_production_matrix[machineNumStr],
      slotIndex,
    );
  }, [data, getMetricForSlot]);

  const getPowerForSlot = useCallback((machineNumStr: string, slotIndex: number) => {
    if (!data) return 0;
    return getMetricForSlot(
      data.power_usage_matrix?.[machineNumStr],
      data.power_kwh_matrix?.[machineNumStr],
      slotIndex,
    );
  }, [data, getMetricForSlot]);

  const chartData = useMemo<ChartSlotData[]>(() => {
    if (!data) return [];
    return displaySlots.map(({ slot, index }) => {
      let totalActual = 0;
      let totalCumulative = 0;
      let tempSum = 0;
      let tempCount = 0;

      data.machines.forEach((machine) => {
        const machineNumStr = machine.machine_number.toString();
        const actual = getActualForSlot(machineNumStr, index);
        const cumulative = getSlotValue(data.cumulative_production_matrix[machineNumStr], index);
        const tempValue = getSlotValue(data.oil_temperature_matrix[machineNumStr], index);

        totalActual += actual;
        totalCumulative += cumulative;

        if (tempValue > 0) {
          tempSum += tempValue;
          tempCount += 1;
        }
      });

      const avgTemperature = tempCount > 0 ? Number((tempSum / tempCount).toFixed(1)) : null;

      return {
        slotIndex: index,
        time: slot.time,
        label: format(new Date(slot.time), viewMode === 'day' ? 'yyyy-MM-dd' : 'MM-dd HH:mm', { locale: lang === 'ko' ? ko : zhCN }),
        axisLabel: format(new Date(slot.time), viewMode === 'day' ? 'MM-dd' : 'MM-dd HH:mm', { locale: lang === 'ko' ? ko : zhCN }),
        totalActual,
        totalCumulative,
        avgTemperature,
      };
    });
  }, [data, displaySlots, lang, viewMode, getActualForSlot]);

  const summaryStats = useMemo(() => {
    const latest = chartData[0];
    if (!data || !latest) {
      return {
        latestOutput: 0,
        totalCumulative: 0,
        avgTemperature: null as number | null,
        activeMachines: 0,
      };
    }

    const activeMachines = data.machines.reduce((count, machine) => {
      const machineNumStr = machine.machine_number.toString();
      const actual = getActualForSlot(machineNumStr, latest.slotIndex);
      const cumulative = getSlotValue(data.cumulative_production_matrix[machineNumStr], latest.slotIndex);
      return count + (actual > 0 || cumulative > 0 ? 1 : 0);
    }, 0);

    return {
      latestOutput: Math.round(latest.totalActual),
      totalCumulative: latest.totalCumulative,
      avgTemperature: latest.avgTemperature,
      activeMachines,
    };
  }, [chartData, data, getActualForSlot]);

  const selectedSlotRows = useMemo(() => {
    if (!data || !selectedSlot) return [];
    return data.machines.map((machine) => {
      const machineNumStr = machine.machine_number.toString();
      const setup = data.setup_data_map?.[machineNumStr];
      const targetUPH = setup && setup.target_cycle_time > 0 ? 3600 / setup.target_cycle_time : null;
      const actual = getActualForSlot(machineNumStr, selectedSlot.slotIndex);
      const powerUsage = getPowerForSlot(machineNumStr, selectedSlot.slotIndex);
      const cumulative = getSlotValue(data.cumulative_production_matrix[machineNumStr], selectedSlot.slotIndex);
      const tempValue = getSlotValue(data.oil_temperature_matrix[machineNumStr], selectedSlot.slotIndex);
      const temperature = tempValue > 0 ? tempValue : null;
      return {
        machine,
        setup,
        targetUPH,
        actual,
        powerUsage,
        cumulative,
        temperature,
      };
    });
  }, [data, getActualForSlot, getPowerForSlot, selectedSlot]);

  const handleChartClick = (chartEvent: any) => {
    if (!chartEvent || !chartEvent.activePayload || !chartEvent.activePayload[0]) return;
    const payload = chartEvent.activePayload[0].payload as ChartSlotData;
    setSelectedSlot(payload);
  };

  const ChartTooltip = ({ active, payload }: any) => {
    if (!active || !payload || payload.length === 0) return null;
    const slot = payload[0].payload as ChartSlotData;
    const outputLabel = viewMode === 'day' ? t('monitoring.daily_output') : t('monitoring.production_per_hour');
    const outputValue = Math.round(slot.totalActual).toLocaleString();
    const outputUnit = ` ${t('monitoring.unit_label')}`;
    return (
      <div className="bg-white p-3 border border-gray-200 rounded shadow-md text-xs space-y-1">
        <div className="font-semibold text-gray-900">{slot.label}</div>
        <div className="text-gray-700">
          {outputLabel}: {outputValue}
          {outputUnit}
        </div>
        <div className="text-gray-700">
          {t('monitoring.cumulative_label')}: {slot.totalCumulative.toLocaleString()}
        </div>
        <div className="text-gray-700">
          {t('monitoring.avg_temperature')}: {slot.avgTemperature !== null ? `${slot.avgTemperature.toFixed(1)}°C` : "-"}
        </div>
      </div>
    );
  };

  if (isLoading) {
    return <div className="p-4">{t('loading')}</div>;
  }

  if (error) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <Terminal className="h-4 w-4" />
          <AlertTitle>MES Data Error</AlertTitle>
          <AlertDescription>
            <p>MES ??? ??? ??????. MES ??? ?? ?? API ?? ??? ??????.</p>
            <p className="text-xs text-gray-500 mt-2">Details: {error.message}</p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!data) return null;

  const progressTone = updateProgress?.status === 'failed'
    ? {
      container: 'bg-red-50 border-red-200',
      bar: 'from-red-500 to-red-600',
      text: 'text-red-700',
      dot: 'bg-red-600',
    }
    : updateProgress?.status === 'completed'
      ? {
        container: 'bg-emerald-50 border-emerald-200',
        bar: 'from-emerald-500 to-emerald-600',
        text: 'text-emerald-700',
        dot: 'bg-emerald-600',
      }
      : {
        container: 'bg-blue-50 border-blue-200',
        bar: 'from-blue-500 via-sky-400 to-blue-600',
        text: 'text-blue-700',
        dot: 'bg-blue-600',
      };
  const progressTitle = updateProgress?.status === 'completed'
    ? t('monitoring.update_progress_completed')
    : updateProgress?.status === 'failed'
      ? t('monitoring.update_progress_failed')
      : t('monitoring.update_progress_title');
  const progressSubtitle = updateProgress?.status === 'completed'
    ? t('monitoring.update_progress_completed_hint')
    : updateProgress?.status === 'failed'
      ? t('monitoring.update_progress_failed_hint')
      : t('monitoring.updating_message');
  const progressPercent = updateProgress?.percent ?? 0;
  const progressSteps = {
    completed: updateProgress?.completedSteps ?? 0,
    total: updateProgress?.totalSteps ?? 0,
  };
  const progressLastSlot = updateProgress?.lastSlot
    ? format(new Date(updateProgress.lastSlot), 'yyyy-MM-dd HH:mm', { locale: lang === 'ko' ? ko : zhCN })
    : null;
  return (
    <div className="p-4 md:p-6 bg-gray-50 min-h-screen">
      <div className="mx-auto max-w-7xl w-full">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">{t('monitoring.title')}</h1>
            <p className="text-sm text-gray-600 mt-1">
              {t('monitoring.last_updated')}: {format(new Date(data.timestamp), 'yyyy-MM-dd HH:mm:ss', { locale: lang === 'ko' ? ko : zhCN })}
              <span className="mx-2 text-gray-300">|</span>
              {t('monitoring.auto_refresh')}
            </p>
          </div>

          <div className="flex items-center space-x-4">
            <button
              onClick={handleUpdate}
              disabled={isUpdating}
              className={`px-4 py-2 rounded-lg transition-colors w-48 text-center whitespace-nowrap ${isUpdating
                ? 'bg-gray-400 text-gray-600 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
            >
              {isUpdating ? t('monitoring.updating_button') : t('monitoring.update_button')}
            </button>
          </div>
        </div>

        {updateProgress && updateProgress.status !== 'idle' && (
          <div className={`mb-4 rounded-lg border p-4 ${progressTone.container}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {updateProgress.status === 'running' ? (
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-70 animate-ping"></span>
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-blue-600"></span>
                  </span>
                ) : (
                  <div className={`h-3 w-3 rounded-full ${progressTone.dot}`}></div>
                )}
                <div className="space-y-0.5">
                  <p className={`text-sm font-semibold ${progressTone.text}`}>{progressTitle}</p>
                  <p className="text-xs text-gray-600">
                    {progressSubtitle}
                  </p>
                </div>
              </div>
              <div className="text-xs text-gray-600">
                {progressSteps.total > 0 ? `${progressPercent}%` : ''}
              </div>
            </div>
            <div className="mt-3 h-2 w-full rounded-full bg-white/80 overflow-hidden">
              <div
                className={`h-full bg-gradient-to-r ${progressTone.bar} transition-all duration-700 ease-out ${updateProgress.status === 'running' ? 'animate-pulse' : ''}`}
                style={{ width: `${progressPercent}%` }}
              ></div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-600">
              {progressSteps.total > 0 && (
                <span>
                  {t('monitoring.update_progress_steps')}: {progressSteps.completed}/{progressSteps.total}
                </span>
              )}
              {progressLastSlot && (
                <span>
                  {t('monitoring.update_progress_last_slot')}: {progressLastSlot}
                </span>
              )}
              {updateProgress.status === 'failed' && updateProgress.error && (
                <span className="text-red-600">{updateProgress.error}</span>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="text-xs text-gray-500">
              {viewMode === 'day' ? t('monitoring.summary_latest_output_day') : t('monitoring.summary_latest_output')}
            </div>
            <div className="mt-2 text-2xl font-semibold text-gray-900">
              {summaryStats.latestOutput.toLocaleString()}
              <span className="text-sm text-gray-500 ml-1">{t('monitoring.unit_label')}</span>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="text-xs text-gray-500">{t('monitoring.summary_cumulative_total')}</div>
            <div className="mt-2 text-2xl font-semibold text-gray-900">
              {summaryStats.totalCumulative.toLocaleString()}
              <span className="text-sm text-gray-500 ml-1">{t('monitoring.unit_label')}</span>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="text-xs text-gray-500">{t('monitoring.summary_avg_temp')}</div>
            <div className="mt-2 text-2xl font-semibold text-gray-900">
              {summaryStats.avgTemperature !== null ? `${summaryStats.avgTemperature.toFixed(1)}°C` : '-'}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="text-xs text-gray-500">{t('monitoring.summary_active_machines')}</div>
            <div className="mt-2 text-2xl font-semibold text-gray-900">
              {summaryStats.activeMachines}/{data.machines.length}
            </div>
          </div>
        </div>

        <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-4 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">{t('monitoring.chart_title')}</h2>
              <p className="text-xs text-gray-500">{t('monitoring.chart_hint')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
              <div className="inline-flex items-center rounded-lg border border-gray-200 bg-gray-50 p-1">
                <button
                  type="button"
                  onClick={() => setViewMode('hour')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition ${viewMode === 'hour'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  {t('monitoring.view_hour')}
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('day')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition ${viewMode === 'day'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                    }`}
                >
                  {t('monitoring.view_day')}
                </button>
              </div>
            </div>
          </div>
          <div className="w-full h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }} onClick={handleChartClick}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="axisLabel" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                <Tooltip content={<ChartTooltip />} />
                <Legend />
                <Bar
                  yAxisId="left"
                  dataKey="totalActual"
                  name={viewMode === 'day' ? t('monitoring.daily_output') : t('monitoring.production_per_hour')}
                  fill="#3b82f6"
                  barSize={18}
                  style={{ cursor: 'pointer' }}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="avgTemperature"
                  name={t('monitoring.avg_temperature')}
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white shadow-lg rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-white sticky top-0 z-10">
                <tr>
                  <th scope="col" className="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider border-r border-gray-200 min-w-[170px]">
                    {t('monitoring.machine_header')}
                  </th>
                  {displaySlots.map(({ slot, index }) => {
                    const displayDate = new Date(slot.time);
                    return (
                    <th
                      key={`${slot.time}-${index}`}
                      scope="col"
                      className="px-2 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider border-r border-gray-200 min-w-[120px]"
                    >
                      {viewMode === 'day' ? (
                        <span className="font-bold">
                          {format(displayDate, 'yyyy-MM-dd', { locale: lang === 'ko' ? ko : zhCN })}
                        </span>
                      ) : (
                        <>
                          <span>{format(displayDate, 'yyyy-MM-dd', { locale: lang === 'ko' ? ko : zhCN })}</span>
                          <br />
                          <span className="font-bold">{format(displayDate, 'HH:mm', { locale: lang === 'ko' ? ko : zhCN })}</span>
                        </>
                      )}
                    </th>
                  );
                  })}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {data.machines.map((machine) => {
                  const machineNumStr = machine.machine_number.toString();
                  const setup = data.setup_data_map?.[machineNumStr];
                  const targetUPH = setup && setup.target_cycle_time > 0 ? 3600 / setup.target_cycle_time : null;

                  const cumulativeData = data.cumulative_production_matrix[machineNumStr]?.slice().reverse() || [];
                  const tempData = data.oil_temperature_matrix[machineNumStr]?.slice().reverse() || [];

                  return (
                    <tr key={machine.machine_number} className="hover:bg-gray-50">
                      <td className="px-4 py-4 whitespace-nowrap border-r border-gray-200 text-center">
                        <div className="text-sm font-medium text-gray-900">
                          {(machine.display_name.endsWith('T') ? machine.display_name : `${machine.display_name}T`).replace('호기', t('호기'))}
                        </div>
                        {setup ? (
                          <div className="text-xs text-gray-600 mt-1 space-y-0.5">
                            <div className="font-bold text-blue-700">{setup.part_no}</div>
                            <div>
                              <span className="font-semibold">{t('monitoring.target_uph')}:</span> {targetUPH ? Math.round(targetUPH) : '-'}
                            </div>
                            <div>
                              <span className="font-semibold">{t('monitoring.target_ct')}:</span> {setup.target_cycle_time}s
                            </div>
                            <div>
                              <span className="font-semibold">{t('monitoring.personnel')}:</span> {setup.personnel_count}
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 mt-1">{t('monitoring.no_setup_data')}</div>
                        )}
                      </td>
                      {displaySlots.map(({ slot, index }) => {
                        const cumulative = cumulativeData[index] || 0;
                        const actual = getActualForSlot(machineNumStr, index);
                        const powerUsage = getPowerForSlot(machineNumStr, index);
                        const rawTemp = tempData[index];
                        const temperature = rawTemp === undefined ? null : Number(rawTemp);

                        const targetInterval = viewMode === 'hour' ? targetUPH : null;
                        const { cellClass, textClass } = getActualCellStyle(actual, targetInterval);
                        const tempClass = getTemperatureStyle(temperature, slot.time);

                        return (
                          <td
                            key={index}
                            className={`px-2 py-3 text-center text-xs border-r ${cellClass}`}
                          >
                            {cumulative > 0 || actual > 0 || powerUsage > 0 || (temperature !== null && temperature !== 0) ? (
                              <div className="space-y-0.5">
                                <div className={`${getCumulativeStyle(cumulative)} text-xs`}>
                                  {t('monitoring.cumulative_label')}: {cumulative.toLocaleString()}
                                </div>
                                <div className={`${textClass} text-sm`}>
                                  {Math.round(actual).toLocaleString()}
                                  <span className="ml-1 text-xs text-gray-600">{t('monitoring.unit_label')}</span>
                                </div>
                                <div className={`${tempClass} text-xs`}>
                                  {t('monitoring.temp_label')}: {temperature !== null ? temperature.toFixed(1) : '-'}°C
                                </div>
                                <div className="text-xs text-emerald-700">
                                  {t('monitoring.power_usage')}: {powerUsage.toFixed(2)} {t('monitoring.power_unit')}
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
        <Dialog open={!!selectedSlot} onClose={() => setSelectedSlot(null)} className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
          {selectedSlot && (
            <Dialog.Panel className="relative bg-white rounded-lg w-full max-w-6xl p-6 space-y-4 max-h-[85vh] overflow-hidden">
              <div className="flex items-start justify-between">
                <div>
                  <Dialog.Title className="text-lg font-semibold text-gray-900">{t('monitoring.raw_data_title')}</Dialog.Title>
                  <p className="text-sm text-gray-500">
                    {t('monitoring.raw_data_subtitle')}: {format(new Date(selectedSlot.time), viewMode === 'day' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm', { locale: lang === 'ko' ? ko : zhCN })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedSlot(null)}
                  className="text-gray-400 hover:text-gray-600"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="overflow-auto border border-gray-200 rounded-lg">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('monitoring.machine_header')}
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('part_no')}
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('quality.model_code')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('monitoring.target_uph')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('monitoring.interval_output')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('monitoring.cumulative_label')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('monitoring.temp_label')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('monitoring.power_usage')}
                      </th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                        {t('monitoring.personnel')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {selectedSlotRows.map((row) => {
                      const machineLabel = (row.machine.display_name.endsWith('T') ? row.machine.display_name : `${row.machine.display_name}T`).replace('??', t('??'));
                      return (
                        <tr key={row.machine.machine_number}>
                          <td className="px-3 py-2 text-gray-800 whitespace-nowrap">{machineLabel}</td>
                          <td className="px-3 py-2 text-gray-600">{row.setup?.part_no || '-'}</td>
                          <td className="px-3 py-2 text-gray-600">{row.setup?.model_code || '-'}</td>
                          <td className="px-3 py-2 text-right text-gray-700">
                            {row.targetUPH ? Math.round(row.targetUPH).toLocaleString() : '-'}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-700">{row.actual.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right text-gray-700">{row.cumulative.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right text-gray-700">
                            {row.temperature !== null ? row.temperature.toFixed(1) : '-'}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-700">
                            {row.powerUsage !== undefined ? `${row.powerUsage.toFixed(2)} ${t('monitoring.power_unit')}` : '-'}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-700">
                            {row.setup?.personnel_count ?? '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Dialog.Panel>
          )}
        </Dialog>
      </div>
    </div>
  );
}
