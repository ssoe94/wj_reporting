import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { AlertTriangle, CheckCircle2, Clock3, PauseCircle, Save } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLang } from '@/i18n';
import { useAuth } from '@/contexts/AuthContext';
import { getProductionConsoleData, getProductionPlanItems, getProductionStatusData, upsertProductionExecution } from '@/lib/api';
import { extractInjectionMachineInfo, getInjectionMachineOrder, getMachiningLineOrder } from '@/lib/productionUtils';
import { getFieldStationById, matchesFieldStation } from '@/lib/fieldTerminal';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';

type PlanType = 'injection' | 'machining';
type StatusType = 'pending' | 'running' | 'completed' | 'paused';
type NumericField = 'actual_qty' | 'defect_qty' | 'idle_time' | 'personnel_count' | 'operating_ct';
type TextField = 'note' | 'start_datetime' | 'end_datetime';

interface ConsoleRow {
  key: string;
  execution_id?: number | null;
  plan_date: string;
  plan_type: PlanType;
  machine_name: string;
  machine_number?: number | null;
  sequence: number;
  part_no: string;
  model_name: string;
  part_spec?: string;
  lot_no?: string | null;
  planned_quantity: number;
  actual_qty: number;
  defect_qty: number;
  idle_time: number;
  personnel_count: number;
  operating_ct?: number | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
  note?: string;
  status: StatusType;
  progress: number;
  cavity?: number;
  baseline_ct?: number | null;
  target_cycle_time?: number | null;
  standard_cycle_time?: number | null;
  mean_cycle_time?: number | null;
}

interface ConsoleResponse {
  date: string;
  plan_type: PlanType;
  summary: {
    total_planned: number;
    total_actual: number;
    total_defect: number;
    achievement_rate: number;
    defect_rate: number;
    pending_count: number;
    running_count: number;
    paused_count: number;
    completed_count: number;
    avg_operating_ct: number;
  };
  rows: ConsoleRow[];
}

interface PlanItemCard {
  id: number;
  machine_name: string;
  sequence: number | null;
  part_no: string;
  model_name?: string | null;
  part_spec?: string | null;
  planned_quantity: number;
}

interface ProductionConsoleProps {
  planType: PlanType;
  stationFilter?: string | null;
  kioskMode?: boolean;
  title?: string;
  subtitle?: string;
  businessDate?: string;
  onBusinessDateChange?: (date: string) => void;
}

interface TableRowView {
  row: ConsoleRow;
  displaySequence: number;
  isGroupStart: boolean;
  groupKey: string;
  groupLabel: string;
}

const statusTone: Record<StatusType, string> = {
  pending: 'bg-slate-100 text-slate-700',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  paused: 'bg-amber-100 text-amber-700',
};

const parseNumericValue = (field: NumericField, value: string) => {
  if (value.trim() === '') {
    return field === 'operating_ct' ? null : 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return field === 'operating_ct' ? null : 0;
  }
  return parsed < 0 ? 0 : parsed;
};

const toLocalInput = (value?: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 16);
  }
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
};

const deriveStatus = (row: ConsoleRow): StatusType => {
  if (row.planned_quantity > 0 && row.actual_qty >= row.planned_quantity) return 'completed';
  if (row.idle_time > 0 && row.actual_qty < row.planned_quantity) return 'paused';
  if (row.actual_qty > 0 || row.start_datetime) return 'running';
  return 'pending';
};

const formatDisplayNumber = (value?: number | null, suffix = '') => {
  if (value === null || value === undefined) return '-';
  return `${value.toLocaleString()}${suffix}`;
};

const getMachineGroupKey = (planType: PlanType, row: ConsoleRow) => {
  if (planType === 'injection' && typeof row.machine_number === 'number') {
    return `machine-${row.machine_number}`;
  }
  return row.machine_name || row.key;
};

const getMachineDisplayLabel = (planType: PlanType, row: ConsoleRow, t: (key: string) => string) => {
  if (planType !== 'injection') {
    return row.machine_name;
  }

  const { machineNumber, tonLabel } = extractInjectionMachineInfo(row.machine_name);
  if (typeof machineNumber === 'number' && tonLabel) {
    return `${machineNumber}${t('console_machine_suffix')} ${tonLabel}`;
  }
  if (typeof machineNumber === 'number') {
    return `${machineNumber}${t('console_machine_suffix')}`;
  }
  return row.machine_name;
};

export default function ProductionConsole({
  planType,
  stationFilter: requestedStationFilter = null,
  kioskMode = false,
  title,
  subtitle,
  businessDate,
  onBusinessDateChange,
}: ProductionConsoleProps) {
  const requestedMachineFilter = planType === 'injection' && requestedStationFilter
    ? String(Number(requestedStationFilter.replace(/^imm/i, '')))
    : requestedStationFilter;
  const [stationFilter, setStationFilter] = useState(requestedMachineFilter);
  const { t, lang } = useLang();
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const currentBusinessDate = useShanghaiBusinessDate();
  const [localRequestedDate, setLocalRequestedDate] = useState<string | null>(null);
  const requestedDate = businessDate ?? localRequestedDate ?? currentBusinessDate;
  const [selectedDate, setSelectedDate] = useState(requestedDate);
  const [rows, setRows] = useState<ConsoleRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const dirtyMapRef = useRef(dirtyMap);
  const hasDirtyRows = Object.values(dirtyMap).some(Boolean);
  useEffect(() => { dirtyMapRef.current = dirtyMap; }, [dirtyMap]);
  useEffect(() => {
    if ((requestedDate !== selectedDate || requestedMachineFilter !== stationFilter) && !hasDirtyRows && !savingKey) {
      if (requestedDate !== selectedDate) setRows([]);
      setDirtyMap({});
      setSelectedDate(requestedDate);
      setStationFilter(requestedMachineFilter);
    }
  }, [requestedDate, selectedDate, requestedMachineFilter, stationFilter, hasDirtyRows, savingKey]);

  const canEdit = Boolean(
    user?.is_staff ||
    user?.permissions?.is_admin ||
    (planType === 'injection' ? hasPermission('can_edit_injection') : hasPermission('can_edit_assembly')),
  );

  const { data, isLoading, isError, isFetching, refetch } = useQuery<ConsoleResponse>({
    queryKey: ['production-console', planType, selectedDate],
    queryFn: () => getProductionConsoleData(selectedDate, planType),
  });

  const { data: productionStatusData } = useQuery<any>({
    queryKey: ['production-status', selectedDate],
    queryFn: () => getProductionStatusData(selectedDate),
    enabled: kioskMode && Boolean(stationFilter),
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: true,
    staleTime: 30 * 1000,
  });

  const { data: kioskPlanItems } = useQuery<PlanItemCard[]>({
    queryKey: ['production-plan-items-kiosk', selectedDate, planType],
    queryFn: () => getProductionPlanItems(selectedDate, planType),
    enabled: kioskMode,
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    setRows(current => (data?.rows ?? []).map(row => (
      dirtyMapRef.current[row.key]
        ? current.find(draft => draft.key === row.key && draft.plan_date === selectedDate) ?? row
        : row
    )));
    setSelectedKey((current) => {
      if (!data?.rows?.length) return null;
      if (current && data.rows.some((row) => row.key === current)) return current;
      return data.rows[0].key;
    });
  }, [data, selectedDate]);

  const visibleRows = useMemo(() => {
    if (!stationFilter) return rows;

    const fieldStation = getFieldStationById(
      planType === 'injection'
        ? `imm${stationFilter.padStart(2, '0')}`
        : `assy0${stationFilter.toUpperCase().charCodeAt(0) - 64}`,
    );

    if (fieldStation) {
      return rows.filter((row) => matchesFieldStation(row.machine_name, fieldStation));
    }

    return rows.filter((row) => {
      if (planType === 'injection') {
        return String(row.machine_number ?? extractInjectionMachineInfo(row.machine_name).machineNumber ?? '') === stationFilter;
      }
      return (row.machine_name || '').toUpperCase().includes(stationFilter.toUpperCase());
    });
  }, [planType, rows, stationFilter]);

  const selectedRow = useMemo(
    () => visibleRows.find((row) => row.key === selectedKey) ?? null,
    [selectedKey, visibleRows],
  );

  const tableRows = useMemo<TableRowView[]>(() => {
    const sorter = planType === 'injection' ? getInjectionMachineOrder : getMachiningLineOrder;
    const sortedRows = [...visibleRows].sort((a, b) => {
      const machineDiff = sorter(a.machine_name) - sorter(b.machine_name);
      if (machineDiff !== 0) return machineDiff;
      const nameDiff = (a.machine_name || '').localeCompare(b.machine_name || '');
      if (nameDiff !== 0) return nameDiff;
      const sequenceDiff = a.sequence - b.sequence;
      if (sequenceDiff !== 0) return sequenceDiff;
      return a.part_no.localeCompare(b.part_no);
    });

    const counters = new Map<string, number>();
    let previousGroupKey: string | null = null;

    return sortedRows.map((row) => {
      const groupKey = getMachineGroupKey(planType, row);
      const displaySequence = (counters.get(groupKey) ?? 0) + 1;
      counters.set(groupKey, displaySequence);

      const view: TableRowView = {
        row,
        displaySequence,
        isGroupStart: groupKey !== previousGroupKey,
        groupKey,
        groupLabel: getMachineDisplayLabel(planType, row, t),
      };

      previousGroupKey = groupKey;
      return view;
    });
  }, [planType, visibleRows, t]);

  const liveSummary = useMemo(() => {
    const totalPlanned = visibleRows.reduce((sum, row) => sum + row.planned_quantity, 0);
    const totalActual = visibleRows.reduce((sum, row) => sum + row.actual_qty, 0);
    const totalDefect = visibleRows.reduce((sum, row) => sum + row.defect_qty, 0);
    const statuses = visibleRows.map((row) => deriveStatus(row));
    const ctRows = visibleRows.filter((row) => row.operating_ct !== null && row.operating_ct !== undefined);

    return {
      totalPlanned,
      totalActual,
      totalDefect,
      achievementRate: totalPlanned > 0 ? Math.round((totalActual / totalPlanned) * 1000) / 10 : 0,
      defectRate: totalActual > 0 ? Math.round((totalDefect / totalActual) * 1000) / 10 : 0,
      pendingCount: statuses.filter((status) => status === 'pending').length,
      runningCount: statuses.filter((status) => status === 'running').length,
      pausedCount: statuses.filter((status) => status === 'paused').length,
      completedCount: statuses.filter((status) => status === 'completed').length,
      avgOperatingCt: ctRows.length
        ? Math.round((ctRows.reduce((sum, row) => sum + Number(row.operating_ct || 0), 0) / ctRows.length) * 10) / 10
        : 0,
    };
  }, [visibleRows]);

  useEffect(() => {
    setSelectedKey((current) => {
      if (!visibleRows.length) return null;
      if (current && visibleRows.some((row) => row.key === current)) return current;
      return visibleRows[0].key;
    });
  }, [visibleRows]);

  const handleNumericChange = (key: string, field: NumericField, value: string) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        const nextValue = parseNumericValue(field, value);
        const nextRow = { ...row, [field]: nextValue } as ConsoleRow;
        nextRow.status = deriveStatus(nextRow);
        nextRow.progress =
          nextRow.planned_quantity > 0 ? Math.round((nextRow.actual_qty / nextRow.planned_quantity) * 1000) / 10 : 0;
        return nextRow;
      }),
    );
    setDirtyMap((prev) => ({ ...prev, [key]: true }));
  };

  const handleTextChange = (key: string, field: TextField, value: string) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== key) return row;
        const nextRow = { ...row, [field]: value || null } as ConsoleRow;
        nextRow.status = deriveStatus(nextRow);
        return nextRow;
      }),
    );
    setDirtyMap((prev) => ({ ...prev, [key]: true }));
  };

  const saveRow = async (row: ConsoleRow) => {
    if (!canEdit) {
      toast.error(t('plan_edit_permission_required'));
      return;
    }

    try {
      setSavingKey(row.key);
      await upsertProductionExecution({
        plan_date: row.plan_date,
        plan_type: row.plan_type,
        machine_name: row.machine_name,
        part_no: row.part_no,
        lot_no: row.lot_no,
        sequence: row.sequence,
        planned_quantity: row.planned_quantity,
        model_name: row.model_name,
        actual_qty: row.actual_qty,
        defect_qty: row.defect_qty,
        idle_time: row.idle_time,
        personnel_count: row.personnel_count,
        operating_ct: row.operating_ct ?? null,
        start_datetime: row.start_datetime || null,
        end_datetime: row.end_datetime || null,
        note: row.note || '',
        status: deriveStatus(row),
      });
      setDirtyMap((prev) => ({ ...prev, [row.key]: false }));
      toast.success(t('save_success'));
      await queryClient.invalidateQueries({ queryKey: ['production-console', planType, selectedDate] });
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || error?.response?.data?.error || t('update_fail'));
    } finally {
      setSavingKey(null);
    }
  };

  const summaryCards = [
    {
      label: t('console_total_planned'),
      value: liveSummary.totalPlanned.toLocaleString(),
      icon: Clock3,
      tone: 'text-slate-700 bg-slate-100',
    },
    {
      label: t('console_total_actual'),
      value: liveSummary.totalActual.toLocaleString(),
      icon: CheckCircle2,
      tone: 'text-blue-700 bg-blue-100',
    },
    {
      label: t('console_total_defect'),
      value: liveSummary.totalDefect.toLocaleString(),
      icon: AlertTriangle,
      tone: 'text-rose-700 bg-rose-100',
    },
    {
      label: t('console_avg_operating_ct'),
      value: liveSummary.avgOperatingCt ? `${liveSummary.avgOperatingCt}s` : '-',
      icon: PauseCircle,
      tone: 'text-amber-700 bg-amber-100',
    },
  ];

  const kioskPlanCards = useMemo(() => {
    if (!kioskPlanItems?.length) {
      return [];
    }

    const filtered = stationFilter
      ? kioskPlanItems.filter((item) => {
          const fieldStation = getFieldStationById(
            planType === 'injection'
              ? `imm${stationFilter.padStart(2, '0')}`
              : `assy0${stationFilter.toUpperCase().charCodeAt(0) - 64}`,
          );

          if (fieldStation) {
            return matchesFieldStation(item.machine_name, fieldStation);
          }

          if (planType === 'injection') {
            return String(extractInjectionMachineInfo(item.machine_name).machineNumber ?? '') === stationFilter;
          }
          return String(item.machine_name || '').toUpperCase().includes(stationFilter.toUpperCase());
        })
      : kioskPlanItems;

    return [...filtered].sort((a, b) => {
      const seqDiff = Number(a.sequence ?? 999) - Number(b.sequence ?? 999);
      if (seqDiff !== 0) return seqDiff;
      return (a.part_no || '').localeCompare(b.part_no || '');
    });
  }, [kioskPlanItems, planType, stationFilter]);

  const kioskStationSummary = useMemo(() => {
    if (!stationFilter || !productionStatusData) {
      return null;
    }

    const source =
      planType === 'injection'
        ? Array.isArray(productionStatusData.injection) ? productionStatusData.injection : []
        : Array.isArray(productionStatusData.machining) ? productionStatusData.machining : [];

    const fieldStation = getFieldStationById(
      planType === 'injection'
        ? `imm${stationFilter.padStart(2, '0')}`
        : `assy0${stationFilter.toUpperCase().charCodeAt(0) - 64}`,
    );

    if (fieldStation) {
      return source.find((item: any) => matchesFieldStation(item.machine_name, fieldStation)) ?? null;
    }

    return (
      source.find((item: any) => {
        if (planType === 'injection') {
          return String(extractInjectionMachineInfo(item.machine_name).machineNumber ?? '') === stationFilter;
        }
        return String(item.machine_name || '').toUpperCase().includes(stationFilter.toUpperCase());
      }) ?? null
    );
  }, [planType, productionStatusData, stationFilter]);

  const kioskSummaryValues = kioskStationSummary
    ? {
        actual: Number(kioskStationSummary.total_actual || 0).toLocaleString(),
        planned: Number(kioskStationSummary.total_planned || 0).toLocaleString(),
        progress: `${Number(kioskStationSummary.progress || 0).toFixed(1)}%`,
      }
    : {
        actual: liveSummary.totalActual.toLocaleString(),
        planned: liveSummary.totalPlanned.toLocaleString(),
        progress: `${liveSummary.achievementRate}%`,
      };

  if (isLoading) return <Card><CardContent className={kioskMode ? "py-10 text-center text-slate-500" : "py-10 text-center text-[var(--wj-muted)]"}>{lang === 'zh' ? '正在查询执行记录…' : '실행 기록을 불러오는 중…'}</CardContent></Card>;
  if (isError) return (
    <Card className={kioskMode ? "border-amber-200" : "border-[var(--wj-warning-border)]"}><CardContent className={kioskMode ? "space-y-3 py-6 text-sm text-amber-900" : "space-y-3 py-6 text-sm text-[var(--wj-warning)]"}>
      <p role="alert">{lang === 'zh' ? '执行记录查询失败，无法确认数量。未保存的输入仍保留在本页面。' : '실행 기록을 불러오지 못해 수량을 확인할 수 없습니다. 미저장 입력은 이 화면에 보존됩니다.'}</p>
      <Button type="button" variant="secondary" disabled={isFetching} onClick={() => void refetch()}>{lang === 'zh' ? '重试' : '다시 조회'}</Button>
    </CardContent></Card>
  );

  const machineScopeLabel = (value: string | null) => value
    ? `${value}${planType === 'injection' ? (lang === 'zh' ? '号机' : '호기') : (lang === 'zh' ? '线' : '라인')}`
    : (lang === 'zh' ? '全部设备' : '전체 설비');
  const pendingScopeNotice = requestedDate !== selectedDate || requestedMachineFilter !== stationFilter ? (
    <div role="status" className={kioskMode ? "rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" : "rounded-lg border border-[var(--wj-warning-border)] bg-[var(--wj-warning-bg)] p-3 text-sm text-[var(--wj-warning)]"}>
      <p>{lang === 'zh'
        ? `当前编辑：${selectedDate} · ${machineScopeLabel(stationFilter)}。未保存输入仍显示在下方。保存后将切换至查询范围：${requestedDate} · ${machineScopeLabel(requestedMachineFilter)}。`
        : `현재 작성: ${selectedDate} · ${machineScopeLabel(stationFilter)}. 미저장 입력은 아래에 보존됩니다. 저장을 마치면 조회 범위 ${requestedDate} · ${machineScopeLabel(requestedMachineFilter)}로 이동합니다.`}</p>
      <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={Boolean(savingKey)} onClick={() => { setRows(data?.rows ?? []); setDirtyMap({}); }}>
        {lang === 'zh' ? '放弃未保存输入并切换查询范围' : '미저장 입력을 버리고 조회 범위로 이동'}
      </Button>
    </div>
  ) : null;

  if (kioskMode) {
    return (
      <div className="flex h-[calc(100vh-96px)] min-h-[820px] flex-col gap-2">
        {pendingScopeNotice}
        <div className="grid grid-cols-3 gap-2">
          <div className={kioskMode ? "border-2 border-slate-300 bg-sky-50 px-4 py-3 text-center" : "border-2 border-[var(--wj-border)] bg-[var(--wj-bg-strong)] px-4 py-3 text-center"}>
            <div className={kioskMode ? "text-lg font-bold text-slate-600" : "text-lg font-bold text-[var(--wj-muted)]"}>实绩</div>
            <div className={kioskMode ? "mt-1 text-4xl font-black text-slate-900" : "mt-1 text-4xl font-black text-[var(--wj-text)]"}>{kioskSummaryValues.actual}</div>
          </div>
          <div className={kioskMode ? "border-2 border-slate-300 bg-amber-50 px-4 py-3 text-center" : "border-2 border-[var(--wj-border)] bg-[var(--wj-warning-bg)] px-4 py-3 text-center"}>
            <div className={kioskMode ? "text-lg font-bold text-slate-600" : "text-lg font-bold text-[var(--wj-muted)]"}>计划</div>
            <div className={kioskMode ? "mt-1 text-4xl font-black text-slate-900" : "mt-1 text-4xl font-black text-[var(--wj-text)]"}>{kioskSummaryValues.planned}</div>
          </div>
          <div className={kioskMode ? "border-2 border-slate-300 bg-emerald-50 px-4 py-3 text-center" : "border-2 border-[var(--wj-border)] bg-[var(--wj-success-bg)] px-4 py-3 text-center"}>
            <div className={kioskMode ? "text-lg font-bold text-slate-600" : "text-lg font-bold text-[var(--wj-muted)]"}>达成率</div>
            <div className={kioskMode ? "mt-1 text-4xl font-black text-slate-900" : "mt-1 text-4xl font-black text-[var(--wj-text)]"}>{kioskSummaryValues.progress}</div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-2 xl:grid-cols-[22%_minmax(0,1.4fr)_minmax(360px,0.9fr)]">
          <div className={kioskMode ? "flex min-h-0 flex-col border-2 border-slate-300 bg-white" : "flex min-h-0 flex-col border-2 border-[var(--wj-border)] bg-[var(--wj-surface-solid)]"}>
            <div className={kioskMode ? "border-b-2 border-slate-300 bg-slate-100 px-4 py-3 text-center text-2xl font-black text-slate-900" : "border-b-2 border-[var(--wj-border)] bg-[var(--wj-bg-strong)] px-4 py-3 text-center text-2xl font-black text-[var(--wj-text)]"}>今日生产计划</div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="flex flex-col gap-2">
                {kioskPlanCards.map((item) => {
                  const matchedRow = visibleRows.find(
                    (row) =>
                      row.part_no === item.part_no &&
                      row.sequence === Number(item.sequence ?? row.sequence) &&
                      row.machine_name === item.machine_name,
                  );
                  const isSelected = matchedRow ? selectedKey === matchedRow.key : false;
                  return (
                    <button
                      key={`${item.id}-${item.part_no}`}
                      type="button"
                      onClick={() => {
                        if (matchedRow) {
                          setSelectedKey(matchedRow.key);
                        }
                      }}
                      className={kioskMode ? `min-h-[156px] border-2 px-4 py-4 text-left ${
                        isSelected
                          ? 'border-blue-700 bg-blue-100 text-slate-900'
                          : 'border-slate-300 bg-white text-slate-900'
                      }` : `min-h-[156px] border-2 px-4 py-4 text-left ${
                        isSelected
                          ? 'border-[var(--wj-accent)] bg-[var(--wj-accent-soft)] text-[var(--wj-text)]'
                          : 'border-[var(--wj-border)] bg-[var(--wj-surface-solid)] text-[var(--wj-text)]'
                      }`}
                    >
                      <div className="text-xl font-black leading-tight">{item.part_no || '-'}</div>
                      <div className={kioskMode ? "mt-3 text-lg font-bold leading-snug text-slate-700" : "mt-3 text-lg font-bold leading-snug text-[var(--wj-text)]"}>
                        {item.model_name || '-'}{item.part_spec ? ` - ${item.part_spec}` : ''}
                      </div>
                      <div className="mt-4 text-3xl font-black leading-none">计划 {Number(item.planned_quantity || 0).toLocaleString()}</div>
                    </button>
                  );
                })}
                {kioskPlanCards.length === 0 ? (
                  <div className={kioskMode ? "border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-lg font-bold text-slate-500" : "border-2 border-dashed border-[var(--wj-border)] bg-[var(--wj-surface-solid)] px-4 py-10 text-center text-lg font-bold text-[var(--wj-muted)]"}>
                    暂无今日计划
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className={kioskMode ? "flex min-h-0 flex-col border-2 border-slate-300 bg-white" : "flex min-h-0 flex-col border-2 border-[var(--wj-border)] bg-[var(--wj-surface-solid)]"}>
            <div className={kioskMode ? "flex items-center justify-between border-b-2 border-slate-300 bg-slate-100 px-4 py-3" : "flex items-center justify-between border-b-2 border-[var(--wj-border)] bg-[var(--wj-bg-strong)] px-4 py-3"}>
              <div className={kioskMode ? "text-2xl font-black text-slate-900" : "text-2xl font-black text-[var(--wj-text)]"}>今日执行输入</div>
              <div className={kioskMode ? "text-lg font-bold text-slate-700" : "text-lg font-bold text-[var(--wj-text)]"}>达成率 {liveSummary.achievementRate}%   不良率 {liveSummary.defectRate}%</div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="min-w-full text-lg">
                <thead className={kioskMode ? "sticky top-0 bg-slate-100 text-slate-700" : "sticky top-0 bg-[var(--wj-bg-strong)] text-[var(--wj-text)]"}>
                  <tr>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-center" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-center"}>顺序</th>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-left" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-left"}>Part No.</th>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-left" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-left"}>型号 / Part</th>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-right" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-right"}>计划</th>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-right" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-right"}>良品</th>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-right" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-right"}>不良</th>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-center" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-center"}>状态</th>
                    <th className={kioskMode ? "border-b-2 border-slate-300 px-3 py-3 text-center" : "border-b-2 border-[var(--wj-border)] px-3 py-3 text-center"}>保存</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td colSpan={8} className={kioskMode ? "px-4 py-16 text-center text-slate-500" : "px-4 py-16 text-center text-[var(--wj-muted)]"}>{t('loading')}</td>
                    </tr>
                  ) : tableRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className={kioskMode ? "px-4 py-16 text-center text-slate-500" : "px-4 py-16 text-center text-[var(--wj-muted)]"}>{t('no_data')}</td>
                    </tr>
                  ) : (
                    tableRows.map(({ row, displaySequence }) => {
                      const derivedStatus = deriveStatus(row);
                      const isSelected = row.key === selectedKey;
                      return (
                        <tr
                          key={row.key}
                          className={kioskMode ? isSelected ? 'bg-blue-50' : 'bg-white' : isSelected ? 'bg-[var(--wj-bg-strong)]' : 'bg-[var(--wj-surface-solid)]'}
                          onClick={() => setSelectedKey(row.key)}
                        >
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3 text-center font-bold text-slate-700" : "border-b border-[var(--wj-border)] px-3 py-3 text-center font-bold text-[var(--wj-text)]"}>{displaySequence}</td>
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3 font-mono text-xl font-black text-slate-900" : "border-b border-[var(--wj-border)] px-3 py-3 font-mono text-xl font-black text-[var(--wj-text)]"}>{row.part_no || '-'}</td>
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3 text-slate-700" : "border-b border-[var(--wj-border)] px-3 py-3 text-[var(--wj-text)]"}>
                            <div className={kioskMode ? "font-bold text-slate-900" : "font-bold text-[var(--wj-text)]"}>{row.model_name || '-'}</div>
                            <div className={kioskMode ? "mt-1 text-sm text-slate-500" : "mt-1 text-sm text-[var(--wj-muted)]"}>{row.part_spec || '-'}</div>
                          </td>
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3 text-right text-xl font-black text-slate-900" : "border-b border-[var(--wj-border)] px-3 py-3 text-right text-xl font-black text-[var(--wj-text)]"}>{row.planned_quantity.toLocaleString()}</td>
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3" : "border-b border-[var(--wj-border)] px-3 py-3"}>
                            <Input
                              type="number"
                              min="0"
                              value={row.actual_qty}
                              onChange={(event) => handleNumericChange(row.key, 'actual_qty', event.target.value)}
                              disabled={!canEdit}
                              className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 text-right text-xl font-black" : "h-12 rounded-none border-2 border-[var(--wj-border)] text-right text-xl font-black"}
                            />
                          </td>
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3" : "border-b border-[var(--wj-border)] px-3 py-3"}>
                            <Input
                              type="number"
                              min="0"
                              value={row.defect_qty}
                              onChange={(event) => handleNumericChange(row.key, 'defect_qty', event.target.value)}
                              disabled={!canEdit}
                              className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 text-right text-xl font-black" : "h-12 rounded-none border-2 border-[var(--wj-border)] text-right text-xl font-black"}
                            />
                          </td>
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3 text-center" : "border-b border-[var(--wj-border)] px-3 py-3 text-center"}>
                            <span className={`inline-block px-3 py-2 text-base font-bold ${statusTone[derivedStatus]}`}>
                              {t(`console_status_${derivedStatus}`)}
                            </span>
                          </td>
                          <td className={kioskMode ? "border-b border-slate-200 px-3 py-3 text-center" : "border-b border-[var(--wj-border)] px-3 py-3 text-center"}>
                            <Button
                              size="lg"
                              variant={dirtyMap[row.key] ? 'primary' : 'secondary'}
                              className={kioskMode ? "rounded-none border-2 border-slate-300 px-4 shadow-none" : "rounded-none border-2 border-[var(--wj-border)] px-4 shadow-none"}
                              onClick={(event) => {
                                event.stopPropagation();
                                void saveRow(row);
                              }}
                              disabled={!canEdit || savingKey === row.key}
                            >
                              <Save className="mr-2 h-4 w-4" />
                              {savingKey === row.key ? t('saving') : '保存'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className={kioskMode ? "flex min-h-0 flex-col border-2 border-slate-300 bg-white" : "flex min-h-0 flex-col border-2 border-[var(--wj-border)] bg-[var(--wj-surface-solid)]"}>
            <div className={kioskMode ? "flex items-center justify-between border-b-2 border-slate-300 bg-slate-100 px-4 py-3" : "flex items-center justify-between border-b-2 border-[var(--wj-border)] bg-[var(--wj-bg-strong)] px-4 py-3"}>
              <div className={kioskMode ? "text-2xl font-black text-slate-900" : "text-2xl font-black text-[var(--wj-text)]"}>当前计划详情</div>
              {selectedRow && dirtyMap[selectedRow.key] ? <div className={kioskMode ? "text-base font-bold text-amber-700" : "text-base font-bold text-[var(--wj-warning)]"}>待保存</div> : <div />}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {selectedRow ? (
                <div className="space-y-4">
                  <div className={kioskMode ? "border-2 border-slate-300 bg-slate-50 p-4" : "border-2 border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-4"}>
                    <div className={kioskMode ? "text-base font-bold text-slate-500" : "text-base font-bold text-[var(--wj-muted)]"}>Part No.</div>
                    <div className={kioskMode ? "mt-2 text-2xl font-black text-slate-900" : "mt-2 text-2xl font-black text-[var(--wj-text)]"}>{selectedRow.part_no || '-'}</div>
                  </div>
                  <div className={kioskMode ? "border-2 border-slate-300 bg-slate-50 p-4" : "border-2 border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-4"}>
                    <div className={kioskMode ? "text-base font-bold text-slate-500" : "text-base font-bold text-[var(--wj-muted)]"}>型号 / Part</div>
                    <div className={kioskMode ? "mt-2 text-2xl font-black text-slate-900" : "mt-2 text-2xl font-black text-[var(--wj-text)]"}>{selectedRow.model_name || '-'}</div>
                    <div className={kioskMode ? "mt-1 text-lg font-bold text-slate-600" : "mt-1 text-lg font-bold text-[var(--wj-muted)]"}>{selectedRow.part_spec || '-'}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className={kioskMode ? "border-2 border-slate-300 p-3 text-lg font-bold text-slate-800" : "border-2 border-[var(--wj-border)] p-3 text-lg font-bold text-[var(--wj-text)]"}>计划数量 {selectedRow.planned_quantity.toLocaleString()}</div>
                    <div className={kioskMode ? "border-2 border-slate-300 p-3 text-lg font-bold text-slate-800" : "border-2 border-[var(--wj-border)] p-3 text-lg font-bold text-[var(--wj-text)]"}>达成率 {selectedRow.progress.toFixed(1)}%</div>
                  </div>
                  <div className="grid gap-3">
                    <div>
                      <label className={kioskMode ? "mb-1 block text-base font-bold text-slate-700" : "mb-1 block text-base font-bold text-[var(--wj-text)]"}>开始时间</label>
                      <Input type="datetime-local" value={toLocalInput(selectedRow.start_datetime)} onChange={(event) => handleTextChange(selectedRow.key, 'start_datetime', event.target.value)} disabled={!canEdit} className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 text-base" : "h-12 rounded-none border-2 border-[var(--wj-border)] text-base"} />
                    </div>
                    <div>
                      <label className={kioskMode ? "mb-1 block text-base font-bold text-slate-700" : "mb-1 block text-base font-bold text-[var(--wj-text)]"}>结束时间</label>
                      <Input type="datetime-local" value={toLocalInput(selectedRow.end_datetime)} onChange={(event) => handleTextChange(selectedRow.key, 'end_datetime', event.target.value)} disabled={!canEdit} className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 text-base" : "h-12 rounded-none border-2 border-[var(--wj-border)] text-base"} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={kioskMode ? "mb-1 block text-base font-bold text-slate-700" : "mb-1 block text-base font-bold text-[var(--wj-text)]"}>停机(分)</label>
                        <Input type="number" min="0" value={selectedRow.idle_time} onChange={(event) => handleNumericChange(selectedRow.key, 'idle_time', event.target.value)} disabled={!canEdit} className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 text-base" : "h-12 rounded-none border-2 border-[var(--wj-border)] text-base"} />
                      </div>
                      <div>
                        <label className={kioskMode ? "mb-1 block text-base font-bold text-slate-700" : "mb-1 block text-base font-bold text-[var(--wj-text)]"}>人员</label>
                        <Input type="number" min="0" step="0.5" value={selectedRow.personnel_count} onChange={(event) => handleNumericChange(selectedRow.key, 'personnel_count', event.target.value)} disabled={!canEdit} className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 text-base" : "h-12 rounded-none border-2 border-[var(--wj-border)] text-base"} />
                      </div>
                    </div>
                    <div>
                      <label className={kioskMode ? "mb-1 block text-base font-bold text-slate-700" : "mb-1 block text-base font-bold text-[var(--wj-text)]"}>运行 C/T</label>
                      <Input type="number" min="0" step="0.1" value={selectedRow.operating_ct ?? ''} onChange={(event) => handleNumericChange(selectedRow.key, 'operating_ct', event.target.value)} disabled={!canEdit} className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 text-base" : "h-12 rounded-none border-2 border-[var(--wj-border)] text-base"} />
                    </div>
                    <div>
                      <label className={kioskMode ? "mb-1 block text-base font-bold text-slate-700" : "mb-1 block text-base font-bold text-[var(--wj-text)]"}>备注</label>
                      <Textarea rows={4} value={selectedRow.note || ''} onChange={(event) => handleTextChange(selectedRow.key, 'note', event.target.value)} disabled={!canEdit} className={kioskMode ? "rounded-none border-2 border-slate-300 text-base" : "rounded-none border-2 border-[var(--wj-border)] text-base"} />
                    </div>
                  </div>
                  <Button className={kioskMode ? "h-12 rounded-none border-2 border-slate-300 bg-slate-900 text-lg font-bold text-white shadow-none" : "h-12 rounded-none border-2 border-[var(--wj-border)] bg-[var(--wj-contrast-surface)] text-lg font-bold text-[var(--wj-on-contrast)] shadow-none"} onClick={() => void saveRow(selectedRow)} disabled={!canEdit || savingKey === selectedRow.key}>
                    <Save className="mr-2 h-4 w-4" />
                    {savingKey === selectedRow.key ? t('saving') : '保存当前计划'}
                  </Button>
                </div>
              ) : (
                <div className={kioskMode ? "border-2 border-dashed border-slate-300 px-4 py-16 text-center text-lg font-bold text-slate-400" : "border-2 border-dashed border-[var(--wj-border)] px-4 py-16 text-center text-lg font-bold text-[var(--wj-muted)]"}>请选择计划</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={kioskMode ? 'space-y-4' : 'space-y-6'}>
      {pendingScopeNotice}
      <Card className={kioskMode ? "border-blue-100 shadow-sm" : "border-[var(--wj-border)] shadow-sm"}>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className={kioskMode ? `${kioskMode ? 'text-xl' : 'text-2xl'} font-black tracking-tight text-slate-900` : `${kioskMode ? 'text-xl' : 'text-2xl'} font-black tracking-tight text-[var(--wj-text)]`}>
                {title || t('console_title')}
              </h2>
              <p className={kioskMode ? "text-sm text-slate-500" : "text-sm text-[var(--wj-muted)]"}>{subtitle || t('console_subtitle')}</p>
            </div>
            <div className="flex items-center gap-3">
              <Input
                type="date"
                value={selectedDate}
                onChange={(event) => {
                  if (!event.target.value) return;
                  setLocalRequestedDate(event.target.value);
                  onBusinessDateChange?.(event.target.value);
                }}
                className="w-[180px]"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className={`grid gap-4 md:grid-cols-2 ${kioskMode ? 'xl:grid-cols-2' : 'xl:grid-cols-4'}`}>
            {summaryCards.map((card) => {
              const Icon = card.icon;
              return (
                <div key={card.label} className={kioskMode ? "rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4" : "rounded-2xl border border-[var(--wj-border)] bg-gradient-to-br from-[var(--wj-surface-solid)] to-[var(--wj-surface-solid)] p-4"}>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className={kioskMode ? "text-xs font-bold uppercase tracking-[0.2em] text-slate-400" : "text-xs font-bold uppercase tracking-[0.2em] text-[var(--wj-muted)]"}>{card.label}</p>
                      <p className={kioskMode ? "mt-2 text-3xl font-black tracking-tight text-slate-900" : "mt-2 text-3xl font-black tracking-tight text-[var(--wj-text)]"}>{card.value}</p>
                    </div>
                    <div className={`rounded-2xl p-3 ${card.tone}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <div className={kioskMode ? "rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700" : "rounded-xl bg-[var(--wj-surface-solid)] px-4 py-3 text-sm text-[var(--wj-text)]"}>
              {t('console_pending_count')}: <span className="font-bold">{liveSummary.pendingCount}</span>
            </div>
            <div className={kioskMode ? "rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700" : "rounded-xl bg-[var(--wj-bg-strong)] px-4 py-3 text-sm text-[var(--wj-accent-strong)]"}>
              {t('console_running_count')}: <span className="font-bold">{liveSummary.runningCount}</span>
            </div>
            <div className={kioskMode ? "rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700" : "rounded-xl bg-[var(--wj-warning-bg)] px-4 py-3 text-sm text-[var(--wj-warning)]"}>
              {t('console_paused_count')}: <span className="font-bold">{liveSummary.pausedCount}</span>
            </div>
            <div className={kioskMode ? "rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700" : "rounded-xl bg-[var(--wj-success-bg)] px-4 py-3 text-sm text-[var(--wj-success)]"}>
              {t('console_completed_count')}: <span className="font-bold">{liveSummary.completedCount}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className={`${kioskMode ? 'gap-4' : 'gap-6'} grid xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.95fr)]`}>
        <Card className={kioskMode ? "border-slate-200 shadow-sm" : "border-[var(--wj-border)] shadow-sm"}>
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h3 className={kioskMode ? "text-lg font-bold text-slate-900" : "text-lg font-bold text-[var(--wj-text)]"}>{t('console_work_table')}</h3>
                <p className={kioskMode ? "text-sm text-slate-500" : "text-sm text-[var(--wj-muted)]"}>{t('console_work_table_hint')}</p>
              </div>
              <div className={kioskMode ? "text-sm text-slate-500" : "text-sm text-[var(--wj-muted)]"}>
                {t('achievement_rate')}: <span className={kioskMode ? "font-bold text-slate-900" : "font-bold text-[var(--wj-text)]"}>{liveSummary.achievementRate}%</span>
                {' / '}
                {t('quality.defect_rate')}: <span className={kioskMode ? "font-bold text-slate-900" : "font-bold text-[var(--wj-text)]"}>{liveSummary.defectRate}%</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className={kioskMode ? "bg-slate-50 text-slate-600" : "bg-[var(--wj-surface-solid)] text-[var(--wj-muted)]"}>
                  <tr>
                    <th className="px-4 py-3 text-left">{planType === 'injection' ? t('machine') : t('line')}</th>
                    <th className="px-3 py-3 text-center">{t('console_sequence')}</th>
                    <th className="px-3 py-3 text-left">{t('part_no')}</th>
                    <th className="px-3 py-3 text-left">{t('model')}</th>
                    <th className="px-3 py-3 text-center">{t('console_lot_no')}</th>
                    <th className="px-3 py-3 text-right">{t('plan_qty')}</th>
                    <th className="px-3 py-3 text-right">{t('actual_qty')}</th>
                    <th className="px-3 py-3 text-right">{t('actual_defect')}</th>
                    <th className="px-3 py-3 text-right">{t('achievement_rate')}</th>
                    <th className="px-3 py-3 text-center">{t('status')}</th>
                    <th className="px-4 py-3 text-center">{t('save')}</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td colSpan={11} className={kioskMode ? "px-4 py-12 text-center text-slate-500" : "px-4 py-12 text-center text-[var(--wj-muted)]"}>{t('loading')}</td>
                    </tr>
                  ) : tableRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className={kioskMode ? "px-4 py-12 text-center text-slate-500" : "px-4 py-12 text-center text-[var(--wj-muted)]"}>{t('no_data')}</td>
                    </tr>
                  ) : (
                    tableRows.map(({ row, displaySequence, isGroupStart, groupKey, groupLabel }) => {
                      const derivedStatus = deriveStatus(row);
                      return (
                        <tr
                          key={row.key}
                          data-group={groupKey}
                          className={kioskMode ? `bg-white transition-colors hover:bg-slate-50 ${
                            isGroupStart ? 'border-t-4 border-t-slate-200' : 'border-t border-slate-100'
                          }` : `bg-[var(--wj-surface-solid)] transition-colors hover:bg-[var(--wj-surface-solid)] ${
                            isGroupStart ? 'border-t-4 border-t-slate-200' : 'border-t border-[var(--wj-border)]'
                          }`}
                          onClick={() => setSelectedKey(row.key)}
                        >
                          <td className={kioskMode ? "px-4 py-3 font-semibold text-slate-800" : "px-4 py-3 font-semibold text-[var(--wj-text)]"}>{groupLabel}</td>
                          <td className={kioskMode ? "px-3 py-3 text-center text-slate-600" : "px-3 py-3 text-center text-[var(--wj-muted)]"}>{displaySequence}</td>
                          <td className={kioskMode ? "px-3 py-3 font-mono text-slate-800" : "px-3 py-3 font-mono text-[var(--wj-text)]"}>{row.part_no || '-'}</td>
                          <td className={kioskMode ? "max-w-[180px] px-3 py-3 text-slate-600" : "max-w-[180px] px-3 py-3 text-[var(--wj-muted)]"}>
                            <div className="truncate">{row.model_name || '-'}</div>
                          </td>
                          <td className={kioskMode ? "px-3 py-3 text-center text-slate-600" : "px-3 py-3 text-center text-[var(--wj-muted)]"}>{row.lot_no || '-'}</td>
                          <td className={kioskMode ? "px-3 py-3 text-right font-semibold text-slate-800" : "px-3 py-3 text-right font-semibold text-[var(--wj-text)]"}>{row.planned_quantity.toLocaleString()}</td>
                          <td className="w-[108px] px-3 py-3">
                            <Input
                              type="number"
                              min="0"
                              value={row.actual_qty}
                              onChange={(event) => handleNumericChange(row.key, 'actual_qty', event.target.value)}
                              disabled={!canEdit}
                              className="h-9 text-right"
                            />
                          </td>
                          <td className="w-[108px] px-3 py-3">
                            <Input
                              type="number"
                              min="0"
                              value={row.defect_qty}
                              onChange={(event) => handleNumericChange(row.key, 'defect_qty', event.target.value)}
                              disabled={!canEdit}
                              className="h-9 text-right"
                            />
                          </td>
                          <td className={kioskMode ? "px-3 py-3 text-right font-semibold text-slate-700" : "px-3 py-3 text-right font-semibold text-[var(--wj-text)]"}>{row.progress.toFixed(1)}%</td>
                          <td className="px-3 py-3 text-center">
                            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone[derivedStatus]}`}>
                              {t(`console_status_${derivedStatus}`)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Button
                              size="sm"
                              variant={dirtyMap[row.key] ? 'primary' : 'secondary'}
                              onClick={(event) => {
                                event.stopPropagation();
                                void saveRow(row);
                              }}
                              disabled={!canEdit || savingKey === row.key}
                            >
                              <Save className="mr-1 h-3.5 w-3.5" />
                              {savingKey === row.key ? t('saving') : dirtyMap[row.key] ? t('console_save_row') : t('save')}
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className={kioskMode ? "border-slate-200 shadow-sm" : "border-[var(--wj-border)] shadow-sm"}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className={kioskMode ? "text-lg font-bold text-slate-900" : "text-lg font-bold text-[var(--wj-text)]"}>{t('console_row_detail')}</h3>
                <p className={kioskMode ? "text-sm text-slate-500" : "text-sm text-[var(--wj-muted)]"}>{t('console_row_detail_hint')}</p>
              </div>
              {selectedRow && dirtyMap[selectedRow.key] && (
                <span className={kioskMode ? "rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700" : "rounded-full bg-[var(--wj-warning-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--wj-warning)]"}>
                  {t('console_unsaved')}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {selectedRow ? (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <div className={kioskMode ? "rounded-xl bg-slate-50 p-4" : "rounded-xl bg-[var(--wj-surface-solid)] p-4"}>
                    <div className={kioskMode ? "text-xs font-bold uppercase tracking-[0.2em] text-slate-400" : "text-xs font-bold uppercase tracking-[0.2em] text-[var(--wj-muted)]"}>{t('part_no')}</div>
                    <div className={kioskMode ? "mt-2 font-mono text-base font-bold text-slate-900" : "mt-2 font-mono text-base font-bold text-[var(--wj-text)]"}>{selectedRow.part_no || '-'}</div>
                  </div>
                  <div className={kioskMode ? "rounded-xl bg-slate-50 p-4" : "rounded-xl bg-[var(--wj-surface-solid)] p-4"}>
                    <div className={kioskMode ? "text-xs font-bold uppercase tracking-[0.2em] text-slate-400" : "text-xs font-bold uppercase tracking-[0.2em] text-[var(--wj-muted)]"}>
                      {planType === 'injection' ? t('machine') : t('line')}
                    </div>
                    <div className={kioskMode ? "mt-2 text-base font-bold text-slate-900" : "mt-2 text-base font-bold text-[var(--wj-text)]"}>{getMachineDisplayLabel(planType, selectedRow, t)}</div>
                  </div>
                  <div className={kioskMode ? "col-span-2 rounded-xl bg-slate-50 p-4" : "col-span-2 rounded-xl bg-[var(--wj-surface-solid)] p-4"}>
                    <div className={kioskMode ? "text-xs font-bold uppercase tracking-[0.2em] text-slate-400" : "text-xs font-bold uppercase tracking-[0.2em] text-[var(--wj-muted)]"}>{t('model')}</div>
                    <div className={kioskMode ? "mt-2 text-base font-bold text-slate-900" : "mt-2 text-base font-bold text-[var(--wj-text)]"}>{selectedRow.model_name || '-'}</div>
                    {selectedRow.part_spec ? <div className={kioskMode ? "mt-1 text-xs text-slate-500" : "mt-1 text-xs text-[var(--wj-muted)]"}>{selectedRow.part_spec}</div> : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className={kioskMode ? "rounded-xl border border-slate-200 bg-white p-3" : "rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-3"}>
                    {t('plan_qty')}: <span className="font-bold">{selectedRow.planned_quantity.toLocaleString()}</span>
                  </div>
                  <div className={kioskMode ? "rounded-xl border border-slate-200 bg-white p-3" : "rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-3"}>
                    {t('achievement_rate')}: <span className="font-bold">{selectedRow.progress.toFixed(1)}%</span>
                  </div>
                  <div className={kioskMode ? "rounded-xl border border-slate-200 bg-white p-3" : "rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-3"}>
                    {t('console_target_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.target_cycle_time, 's')}</span>
                  </div>
                  <div className={kioskMode ? "rounded-xl border border-slate-200 bg-white p-3" : "rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-3"}>
                    {t('console_baseline_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.baseline_ct, 's')}</span>
                  </div>
                  <div className={kioskMode ? "rounded-xl border border-slate-200 bg-white p-3" : "rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-3"}>
                    {t('console_standard_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.standard_cycle_time, 's')}</span>
                  </div>
                  <div className={kioskMode ? "rounded-xl border border-slate-200 bg-white p-3" : "rounded-xl border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-3"}>
                    {t('console_mean_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.mean_cycle_time, 's')}</span>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className={kioskMode ? "mb-1 block text-sm font-medium text-slate-700" : "mb-1 block text-sm font-medium text-[var(--wj-text)]"}>{t('console_start_time')}</label>
                    <Input
                      type="datetime-local"
                      value={toLocalInput(selectedRow.start_datetime)}
                      onChange={(event) => handleTextChange(selectedRow.key, 'start_datetime', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className={kioskMode ? "mb-1 block text-sm font-medium text-slate-700" : "mb-1 block text-sm font-medium text-[var(--wj-text)]"}>{t('console_end_time')}</label>
                    <Input
                      type="datetime-local"
                      value={toLocalInput(selectedRow.end_datetime)}
                      onChange={(event) => handleTextChange(selectedRow.key, 'end_datetime', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className={kioskMode ? "mb-1 block text-sm font-medium text-slate-700" : "mb-1 block text-sm font-medium text-[var(--wj-text)]"}>{t('console_idle_minutes')}</label>
                    <Input
                      type="number"
                      min="0"
                      value={selectedRow.idle_time}
                      onChange={(event) => handleNumericChange(selectedRow.key, 'idle_time', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className={kioskMode ? "mb-1 block text-sm font-medium text-slate-700" : "mb-1 block text-sm font-medium text-[var(--wj-text)]"}>{t('console_personnel')}</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.5"
                      value={selectedRow.personnel_count}
                      onChange={(event) => handleNumericChange(selectedRow.key, 'personnel_count', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className={kioskMode ? "mb-1 block text-sm font-medium text-slate-700" : "mb-1 block text-sm font-medium text-[var(--wj-text)]"}>{t('console_operating_ct')}</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.1"
                      value={selectedRow.operating_ct ?? ''}
                      onChange={(event) => handleNumericChange(selectedRow.key, 'operating_ct', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className={kioskMode ? "mb-1 block text-sm font-medium text-slate-700" : "mb-1 block text-sm font-medium text-[var(--wj-text)]"}>{t('cavity')}</label>
                    <Input value={selectedRow.cavity ?? 1} disabled />
                  </div>
                </div>

                <div>
                  <label className={kioskMode ? "mb-1 block text-sm font-medium text-slate-700" : "mb-1 block text-sm font-medium text-[var(--wj-text)]"}>{t('console_note')}</label>
                  <Textarea
                    rows={4}
                    value={selectedRow.note || ''}
                    onChange={(event) => handleTextChange(selectedRow.key, 'note', event.target.value)}
                    disabled={!canEdit}
                  />
                </div>

                <Button className="w-full" onClick={() => void saveRow(selectedRow)} disabled={!canEdit || savingKey === selectedRow.key}>
                  <Save className="mr-2 h-4 w-4" />
                  {savingKey === selectedRow.key ? t('saving') : t('console_save_row')}
                </Button>
              </div>
            ) : (
              <div className={kioskMode ? "rounded-2xl border border-dashed border-slate-300 px-6 py-16 text-center text-slate-500" : "rounded-2xl border border-dashed border-[var(--wj-border)] px-6 py-16 text-center text-[var(--wj-muted)]"}>
                {t('console_select_row_hint')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
