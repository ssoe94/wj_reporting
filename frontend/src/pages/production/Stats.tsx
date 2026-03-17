import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle, Database, RefreshCcw } from 'lucide-react';

import { useLang } from '../../i18n';
import { Button } from '../../components/ui/button';
import { getProductionMesReportStats } from '../../lib/api';

type PlanType = 'injection' | 'machining';

interface MesStatsRow {
  equipment_key: string;
  equipment_name: string;
  equipment_label: string;
  part_no: string;
  model_name: string;
  planned_qty: number;
  mes_qty: number;
  gap_qty: number;
  achievement_rate: number | null;
  mes_report_count: number;
  latest_report_time: string | null;
  compare_status: 'matched' | 'plan_only' | 'mes_only';
  process_code: string;
  plan_row_count: number;
}

interface MesStatsResponse {
  date: string;
  plan_type: PlanType;
  range_mode: 'day' | 'recent24h';
  range_start: string;
  range_end: string;
  summary: {
    total_planned: number;
    total_mes: number;
    gap_qty: number;
    achievement_rate: number;
    matched_rows: number;
    plan_only_rows: number;
    mes_only_rows: number;
    raw_mes_count: number;
    grouped_mes_count: number;
  };
  rows: MesStatsRow[];
}

const ctrlCls =
  'h-11 bg-white border border-gray-300 rounded-xl px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

const numberFormatter = new Intl.NumberFormat('ko-KR');

function formatNumber(value?: number | null) {
  return numberFormatter.format(Math.round(Number(value) || 0));
}

function formatPercent(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return `${value.toFixed(1)}%`;
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')} ${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`;
}

function getStatusClass(status: MesStatsRow['compare_status']) {
  if (status === 'matched') return 'bg-green-100 text-green-700';
  if (status === 'plan_only') return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

export default function ProductionStatsPage() {
  const { t } = useLang();
  const [selectedDate, setSelectedDate] = useState(getBusinessDateString());
  const [planType, setPlanType] = useState<PlanType>('injection');
  const [search, setSearch] = useState('');

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery<MesStatsResponse>({
    queryKey: ['productionMesStats', selectedDate, planType],
    queryFn: () => getProductionMesReportStats(selectedDate, planType, 'day'),
    refetchOnWindowFocus: false,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
    retry: false,
  });

  const rows = useMemo(() => {
    const source = data?.rows || [];
    const keyword = search.trim().toUpperCase();
    if (!keyword) return source;
    return source.filter((row) =>
      [
        row.part_no,
        row.model_name,
        row.equipment_label,
        row.equipment_name,
        row.process_code,
      ]
        .join(' ')
        .toUpperCase()
        .includes(keyword)
    );
  }, [data?.rows, search]);

  const statusLabel = (status: MesStatsRow['compare_status']) => {
    if (status === 'matched') return t('prod_stats_status_matched');
    if (status === 'plan_only') return t('prod_stats_status_plan_only');
    return t('prod_stats_status_mes_only');
  };

  return (
    <div className="px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-500">
                {t('prod_stats_tag')}
              </p>
              <h1 className="text-3xl font-bold text-slate-900">{t('prod_stats_title')}</h1>
              <p className="max-w-3xl text-sm text-slate-600">{t('prod_stats_description')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value);
                }}
                className={ctrlCls}
              />
              <div className="inline-flex rounded-2xl border border-gray-200 bg-gray-50 p-1">
                <button
                  type="button"
                  onClick={() => setPlanType('injection')}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                    planType === 'injection' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600'
                  }`}
                >
                  {t('plan_toggle_injection')}
                </button>
                <button
                  type="button"
                  onClick={() => setPlanType('machining')}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                    planType === 'machining' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600'
                  }`}
                >
                  {t('plan_toggle_machining')}
                </button>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => refetch()}
                className="gap-2 rounded-xl"
              >
                <RefreshCcw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
                {t('prod_stats_refresh')}
              </Button>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
            <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
              {t('prod_stats_range_day')}
            </span>
            <span>
              {data
                ? `${formatDateTime(data.range_start)} ~ ${formatDateTime(data.range_end)}`
                : t('prod_stats_range_hint')}
            </span>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <p className="text-sm text-slate-500">{t('prod_stats_total_planned')}</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{formatNumber(data?.summary.total_planned)}</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <p className="text-sm text-slate-500">{t('prod_stats_total_mes')}</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{formatNumber(data?.summary.total_mes)}</p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <p className="text-sm text-slate-500">{t('prod_stats_gap_qty')}</p>
            <p className={`mt-2 text-3xl font-bold ${(data?.summary.gap_qty || 0) >= 0 ? 'text-blue-700' : 'text-red-700'}`}>
              {formatNumber(data?.summary.gap_qty)}
            </p>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <p className="text-sm text-slate-500">{t('prod_stats_achievement_rate')}</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{formatPercent(data?.summary.achievement_rate)}</p>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-blue-600" />
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{t('prod_stats_summary_title')}</h2>
                <p className="text-sm text-slate-500">{t('prod_stats_summary_hint')}</p>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">{t('prod_stats_matched_rows')}</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(data?.summary.matched_rows)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">{t('prod_stats_plan_only_rows')}</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(data?.summary.plan_only_rows)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">{t('prod_stats_mes_only_rows')}</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(data?.summary.mes_only_rows)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">{t('prod_stats_raw_mes_count')}</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(data?.summary.raw_mes_count)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs text-slate-500">{t('prod_stats_grouped_mes_count')}</p>
                <p className="mt-2 text-2xl font-bold text-slate-900">{formatNumber(data?.summary.grouped_mes_count)}</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
            <h2 className="text-lg font-semibold text-slate-900">{t('prod_stats_filter_title')}</h2>
            <p className="mt-1 text-sm text-slate-500">{t('prod_stats_filter_hint')}</p>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('prod_stats_search_placeholder')}
              className={`${ctrlCls} mt-4 w-full`}
            />
          </div>
        </section>

        <section className="rounded-3xl bg-white shadow-sm ring-1 ring-gray-100">
          <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{t('prod_stats_table_title')}</h2>
              <p className="text-sm text-slate-500">{t('prod_stats_table_hint')}</p>
            </div>
            <div className="text-sm text-slate-500">
              {t('prod_stats_rows_count', { count: rows.length.toLocaleString() })}
            </div>
          </div>

          {isLoading ? (
            <div className="px-6 py-16 text-center text-sm text-slate-500">{t('prod_stats_loading')}</div>
          ) : error ? (
            <div className="flex items-center justify-center gap-3 px-6 py-16 text-sm text-red-600">
              <AlertCircle className="h-5 w-5" />
              <span>{extractApiErrorMessage(error, t('prod_stats_error'))}</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full table-fixed">
                <thead className="bg-slate-50 text-slate-700">
                  <tr className="text-sm">
                    <th className="px-4 py-3 text-left font-semibold">{t('prod_stats_col_equipment')}</th>
                    <th className="px-4 py-3 text-left font-semibold">{t('prod_stats_col_part_no')}</th>
                    <th className="px-4 py-3 text-left font-semibold">{t('prod_stats_col_model')}</th>
                    <th className="px-4 py-3 text-right font-semibold">{t('prod_stats_col_plan_qty')}</th>
                    <th className="px-4 py-3 text-right font-semibold">{t('prod_stats_col_mes_qty')}</th>
                    <th className="px-4 py-3 text-right font-semibold">{t('prod_stats_col_gap_qty')}</th>
                    <th className="px-4 py-3 text-right font-semibold">{t('prod_stats_col_achievement')}</th>
                    <th className="px-4 py-3 text-center font-semibold">{t('prod_stats_col_mes_count')}</th>
                    <th className="px-4 py-3 text-left font-semibold">{t('prod_stats_col_latest_time')}</th>
                    <th className="px-4 py-3 text-center font-semibold">{t('prod_stats_col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-6 py-16 text-center text-sm text-slate-500">
                        {t('prod_stats_no_data')}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={`${row.equipment_key}-${row.part_no}`} className="border-t border-gray-100 text-sm">
                        <td className="px-4 py-3 font-semibold text-slate-900">{row.equipment_label}</td>
                        <td className="px-4 py-3 font-mono text-slate-800">{row.part_no}</td>
                        <td className="px-4 py-3 text-slate-700">{row.model_name || '-'}</td>
                        <td className="px-4 py-3 text-right text-slate-800">{formatNumber(row.planned_qty)}</td>
                        <td className="px-4 py-3 text-right text-slate-800">{formatNumber(row.mes_qty)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${row.gap_qty >= 0 ? 'text-blue-700' : 'text-red-700'}`}>
                          {formatNumber(row.gap_qty)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-800">{formatPercent(row.achievement_rate)}</td>
                        <td className="px-4 py-3 text-center text-slate-700">{formatNumber(row.mes_report_count)}</td>
                        <td className="px-4 py-3 text-slate-700">{formatDateTime(row.latest_report_time)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${getStatusClass(row.compare_status)}`}>
                            {statusLabel(row.compare_status)}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function extractApiErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback;
  const maybeAxios = error as {
    message?: string;
    response?: { data?: { detail?: string; sub_code?: string } };
  };
  const detail = maybeAxios.response?.data?.detail;
  const subCode = maybeAxios.response?.data?.sub_code;
  if (detail && subCode) return `${detail} (${subCode})`;
  if (detail) return detail;
  if (maybeAxios.message) return maybeAxios.message;
  return fallback;
}

function getBusinessDateString() {
  const now = new Date();
  const businessDate = new Date(now);
  if (now.getHours() < 8) {
    businessDate.setDate(businessDate.getDate() - 1);
  }
  return format(businessDate, 'yyyy-MM-dd');
}
