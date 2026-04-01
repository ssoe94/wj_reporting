import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { AlertTriangle, CheckCircle2, Clock3, PauseCircle, Save } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLang } from '@/i18n';
import { useAuth } from '@/contexts/AuthContext';
import { getProductionConsoleData, upsertProductionExecution } from '@/lib/api';
import { extractInjectionMachineInfo, getInjectionMachineOrder, getMachiningLineOrder } from '@/lib/productionUtils';
import { getFieldStationById, matchesFieldStation } from '@/lib/fieldTerminal';

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

interface ProductionConsoleProps {
  planType: PlanType;
  stationFilter?: string | null;
  kioskMode?: boolean;
  title?: string;
  subtitle?: string;
}

interface TableRowView {
  row: ConsoleRow;
  displaySequence: number;
  isGroupStart: boolean;
  groupKey: string;
  groupLabel: string;
}

const getLocalDate = () => {
  const now = new Date();
  const adjusted = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 10);
};

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
  stationFilter = null,
  kioskMode = false,
  title,
  subtitle,
}: ProductionConsoleProps) {
  const { t } = useLang();
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(getLocalDate);
  const [rows, setRows] = useState<ConsoleRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});

  const canEdit = Boolean(
    user?.is_staff ||
    user?.permissions?.is_admin ||
    (planType === 'injection' ? hasPermission('can_edit_injection') : hasPermission('can_edit_assembly')),
  );

  const { data, isLoading } = useQuery<ConsoleResponse>({
    queryKey: ['production-console', planType, selectedDate],
    queryFn: () => getProductionConsoleData(selectedDate, planType),
  });

  useEffect(() => {
    setRows(data?.rows ?? []);
    setSelectedKey((current) => {
      if (!data?.rows?.length) return null;
      if (current && data.rows.some((row) => row.key === current)) return current;
      return data.rows[0].key;
    });
    setDirtyMap({});
  }, [data]);

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

  return (
    <div className={kioskMode ? 'space-y-4' : 'space-y-6'}>
      <Card className="border-blue-100 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className={`${kioskMode ? 'text-xl' : 'text-2xl'} font-black tracking-tight text-slate-900`}>
                {title || t('console_title')}
              </h2>
              <p className="text-sm text-slate-500">{subtitle || t('console_subtitle')}</p>
            </div>
            <div className="flex items-center gap-3">
              <Input
                type="date"
                value={selectedDate}
                onChange={(event) => setSelectedDate(event.target.value)}
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
                <div key={card.label} className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">{card.label}</p>
                      <p className="mt-2 text-3xl font-black tracking-tight text-slate-900">{card.value}</p>
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
            <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {t('console_pending_count')}: <span className="font-bold">{liveSummary.pendingCount}</span>
            </div>
            <div className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
              {t('console_running_count')}: <span className="font-bold">{liveSummary.runningCount}</span>
            </div>
            <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
              {t('console_paused_count')}: <span className="font-bold">{liveSummary.pausedCount}</span>
            </div>
            <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {t('console_completed_count')}: <span className="font-bold">{liveSummary.completedCount}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className={`${kioskMode ? 'gap-4' : 'gap-6'} grid xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.95fr)]`}>
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">{t('console_work_table')}</h3>
                <p className="text-sm text-slate-500">{t('console_work_table_hint')}</p>
              </div>
              <div className="text-sm text-slate-500">
                {t('achievement_rate')}: <span className="font-bold text-slate-900">{liveSummary.achievementRate}%</span>
                {' / '}
                {t('quality.defect_rate')}: <span className="font-bold text-slate-900">{liveSummary.defectRate}%</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
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
                      <td colSpan={11} className="px-4 py-12 text-center text-slate-500">{t('loading')}</td>
                    </tr>
                  ) : tableRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-12 text-center text-slate-500">{t('no_data')}</td>
                    </tr>
                  ) : (
                    tableRows.map(({ row, displaySequence, isGroupStart, groupKey, groupLabel }) => {
                      const derivedStatus = deriveStatus(row);
                      return (
                        <tr
                          key={row.key}
                          data-group={groupKey}
                          className={`bg-white transition-colors hover:bg-slate-50 ${
                            isGroupStart ? 'border-t-4 border-t-slate-200' : 'border-t border-slate-100'
                          }`}
                          onClick={() => setSelectedKey(row.key)}
                        >
                          <td className="px-4 py-3 font-semibold text-slate-800">{groupLabel}</td>
                          <td className="px-3 py-3 text-center text-slate-600">{displaySequence}</td>
                          <td className="px-3 py-3 font-mono text-slate-800">{row.part_no || '-'}</td>
                          <td className="max-w-[180px] px-3 py-3 text-slate-600">
                            <div className="truncate">{row.model_name || '-'}</div>
                          </td>
                          <td className="px-3 py-3 text-center text-slate-600">{row.lot_no || '-'}</td>
                          <td className="px-3 py-3 text-right font-semibold text-slate-800">{row.planned_quantity.toLocaleString()}</td>
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
                          <td className="px-3 py-3 text-right font-semibold text-slate-700">{row.progress.toFixed(1)}%</td>
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

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">{t('console_row_detail')}</h3>
                <p className="text-sm text-slate-500">{t('console_row_detail_hint')}</p>
              </div>
              {selectedRow && dirtyMap[selectedRow.key] && (
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
                  {t('console_unsaved')}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {selectedRow ? (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-slate-50 p-4">
                    <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">{t('part_no')}</div>
                    <div className="mt-2 font-mono text-base font-bold text-slate-900">{selectedRow.part_no || '-'}</div>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-4">
                    <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                      {planType === 'injection' ? t('machine') : t('line')}
                    </div>
                    <div className="mt-2 text-base font-bold text-slate-900">{getMachineDisplayLabel(planType, selectedRow, t)}</div>
                  </div>
                  <div className="col-span-2 rounded-xl bg-slate-50 p-4">
                    <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">{t('model')}</div>
                    <div className="mt-2 text-base font-bold text-slate-900">{selectedRow.model_name || '-'}</div>
                    {selectedRow.part_spec ? <div className="mt-1 text-xs text-slate-500">{selectedRow.part_spec}</div> : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    {t('plan_qty')}: <span className="font-bold">{selectedRow.planned_quantity.toLocaleString()}</span>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    {t('achievement_rate')}: <span className="font-bold">{selectedRow.progress.toFixed(1)}%</span>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    {t('console_target_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.target_cycle_time, 's')}</span>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    {t('console_baseline_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.baseline_ct, 's')}</span>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    {t('console_standard_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.standard_cycle_time, 's')}</span>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    {t('console_mean_ct')}: <span className="font-bold">{formatDisplayNumber(selectedRow.mean_cycle_time, 's')}</span>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t('console_start_time')}</label>
                    <Input
                      type="datetime-local"
                      value={toLocalInput(selectedRow.start_datetime)}
                      onChange={(event) => handleTextChange(selectedRow.key, 'start_datetime', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t('console_end_time')}</label>
                    <Input
                      type="datetime-local"
                      value={toLocalInput(selectedRow.end_datetime)}
                      onChange={(event) => handleTextChange(selectedRow.key, 'end_datetime', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t('console_idle_minutes')}</label>
                    <Input
                      type="number"
                      min="0"
                      value={selectedRow.idle_time}
                      onChange={(event) => handleNumericChange(selectedRow.key, 'idle_time', event.target.value)}
                      disabled={!canEdit}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t('console_personnel')}</label>
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
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t('console_operating_ct')}</label>
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
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t('cavity')}</label>
                    <Input value={selectedRow.cavity ?? 1} disabled />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">{t('console_note')}</label>
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
              <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-16 text-center text-slate-500">
                {t('console_select_row_hint')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
