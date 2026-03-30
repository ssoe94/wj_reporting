import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import dayjs from 'dayjs';

import api from '../../lib/api';
import { useLang } from '../../i18n';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

type HistoricalReport = {
  id: number;
  report_dt: string;
  section: string;
  part_no: string;
  judgement: string;
  defect_rate: string;
  phenomenon: string;
  disposition: string;
  action_result: string;
  images: string[];
};

type DailyAttentionItem = {
  machine_name: string;
  machine_number: number | null;
  sequence: number | null;
  part_prefix: string;
  part_nos: string[];
  model_names: string[];
  lot_nos: string[];
  planned_quantity: number;
  plan_row_count: number;
  matching_report_count: number;
  latest_report_dt: string | null;
  top_phenomena: Array<{ phenomenon: string; count: number }>;
  reports: HistoricalReport[];
};

type DailyAttentionResponse = {
  date: string;
  total_plan_count: number;
  total_matching_reports: number;
  without_history_count: number;
  items: DailyAttentionItem[];
};

type PhenomenonGroup = {
  phenomenon: string;
  reports: HistoricalReport[];
  totalCount: number;
  sectionCounts: Array<{ section: string; count: number }>;
  primaryOrder: number;
};

const SECTION_ORDER: Record<string, number> = {
  CS: 0,
  OQC: 1,
  LQC: 2,
};

function normalizeSection(section: string): string {
  const value = (section || '').trim().toUpperCase();
  if (value.startsWith('LQC')) return 'LQC';
  if (value.startsWith('OQC')) return 'OQC';
  if (value.startsWith('CS')) return 'CS';
  return value || 'ETC';
}

function groupReportsByPhenomenon(reports: HistoricalReport[], emptyLabel: string): PhenomenonGroup[] {
  const groups = new Map<string, HistoricalReport[]>();

  reports.forEach((report) => {
    const phenomenon = (report.phenomenon || '').trim() || emptyLabel;
    const current = groups.get(phenomenon) ?? [];
    current.push(report);
    groups.set(phenomenon, current);
  });

  return Array.from(groups.entries())
    .map(([phenomenon, groupedReports]) => {
      const sortedReports = [...groupedReports].sort((a, b) => {
        const sectionDiff = (SECTION_ORDER[normalizeSection(a.section)] ?? 99) - (SECTION_ORDER[normalizeSection(b.section)] ?? 99);
        if (sectionDiff !== 0) return sectionDiff;
        return dayjs(b.report_dt).valueOf() - dayjs(a.report_dt).valueOf();
      });

      const sectionCountMap = new Map<string, number>();
      sortedReports.forEach((report) => {
        const section = normalizeSection(report.section);
        sectionCountMap.set(section, (sectionCountMap.get(section) ?? 0) + 1);
      });

      const sectionCounts = Array.from(sectionCountMap.entries())
        .map(([section, count]) => ({ section, count }))
        .sort((a, b) => (SECTION_ORDER[a.section] ?? 99) - (SECTION_ORDER[b.section] ?? 99));

      const primaryOrder = Math.min(...sectionCounts.map((entry) => SECTION_ORDER[entry.section] ?? 99));

      return {
        phenomenon,
        reports: sortedReports,
        totalCount: sortedReports.length,
        sectionCounts,
        primaryOrder,
      };
    })
    .sort((a, b) => {
      if (a.primaryOrder !== b.primaryOrder) return a.primaryOrder - b.primaryOrder;
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
      return a.phenomenon.localeCompare(b.phenomenon);
    });
}

export default function DailyAttentionPage() {
  const { t, lang } = useLang();
  const [targetDate, setTargetDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, Record<string, boolean>>>({});

  const noPhenomenonLabel = lang === 'zh' ? '未填写现象' : '현상 미기재';
  const expandAllLabel = lang === 'zh' ? '모두 펼치기' : '모두 펼치기';
  const collapseAllLabel = lang === 'zh' ? '모두 접기' : '모두 접기';
  const rowsLabel = lang === 'zh' ? '행' : 'rows';

  const { data, isLoading, isError, isFetching, refetch } = useQuery<DailyAttentionResponse>({
    queryKey: ['quality-daily-attention', targetDate],
    queryFn: async () => {
      const response = await api.get('/quality/daily-attention/', { params: { date: targetDate } });
      return response.data;
    },
  });

  const sortedItems = useMemo(() => {
    const items = data?.items ?? [];
    return [...items].sort((a, b) => {
      const machineA = a.machine_number ?? 999;
      const machineB = b.machine_number ?? 999;
      if (machineA !== machineB) return machineA - machineB;
      return (a.sequence ?? 999) - (b.sequence ?? 999);
    });
  }, [data]);

  const groupedPhenomenaMap = useMemo(() => {
    const map: Record<string, PhenomenonGroup[]> = {};
    sortedItems.forEach((item) => {
      const itemKey = `${item.machine_name}-${item.sequence}-${item.part_prefix}`;
      map[itemKey] = groupReportsByPhenomenon(item.reports, noPhenomenonLabel);
    });
    return map;
  }, [sortedItems, noPhenomenonLabel]);

  const isPhenomenonOpen = (itemKey: string, phenomenon: string) =>
    collapsedGroups[itemKey]?.[phenomenon] !== false;

  const togglePhenomenon = (itemKey: string, phenomenon: string) => {
    setCollapsedGroups((prev) => {
      const nextItem = { ...(prev[itemKey] ?? {}) };
      nextItem[phenomenon] = !isPhenomenonOpen(itemKey, phenomenon);
      return { ...prev, [itemKey]: nextItem };
    });
  };

  const setAllPhenomena = (itemKey: string, groups: PhenomenonGroup[], expanded: boolean) => {
    const nextState = groups.reduce<Record<string, boolean>>((acc, group) => {
      acc[group.phenomenon] = expanded;
      return acc;
    }, {});
    setCollapsedGroups((prev) => ({ ...prev, [itemKey]: nextState }));
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-gray-200 bg-gradient-to-r from-amber-50 to-white px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-amber-600" />
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{t('quality.daily_attention_title')}</h1>
            <p className="text-sm text-gray-600">{t('quality.daily_attention_description')}</p>
          </div>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-end md:justify-between">
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">{t('date')}</label>
              <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="w-[180px]" />
            </div>
            <Button type="button" variant="secondary" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? `${t('loading')}...` : t('search')}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <div className="text-slate-500">{t('quality.daily_attention_total_plans')}</div>
              <div className="text-xl font-bold text-slate-800">{data?.total_plan_count ?? 0}</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
              <div className="text-amber-700">{t('quality.daily_attention_total_matches')}</div>
              <div className="text-xl font-bold text-amber-800">{data?.total_matching_reports ?? 0}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
              <div className="text-emerald-700">{t('quality.daily_attention_without_history')}</div>
              <div className="text-xl font-bold text-emerald-800">{data?.without_history_count ?? 0}</div>
            </div>
          </div>
        </div>
      </section>

      {isLoading ? (
        <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center text-gray-500">{t('loading')}...</div>
      ) : isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-6 py-12 text-center text-red-600">{t('error_loading_data')}</div>
      ) : sortedItems.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center text-gray-500">{t('no_data')}</div>
      ) : (
        <div className="space-y-4">
          {sortedItems.map((item) => {
            const itemKey = `${item.machine_name}-${item.sequence}-${item.part_prefix}`;
            const phenomenonGroups = groupedPhenomenaMap[itemKey] ?? [];

            return (
              <section key={itemKey} className="rounded-xl border border-gray-200 bg-white shadow-sm">
                <div className="flex flex-col gap-3 border-b border-gray-200 bg-gradient-to-r from-slate-50 to-white px-4 py-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-lg font-semibold text-slate-900">
                      {item.machine_name} / {item.part_nos.join(', ')}
                    </div>
                    <div className="mt-1 text-sm text-slate-600">
                      {(item.model_names.length > 0 ? item.model_names.join(', ') : '-')} · {t('quality.daily_attention_planned_qty')}: {item.planned_quantity.toLocaleString()}
                      {item.lot_nos.length > 0 ? ` · LOT ${item.lot_nos.join(', ')}` : ''}
                      {item.plan_row_count > 1 ? ` · ${item.plan_row_count} ${rowsLabel}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
                      {t('quality.daily_attention_focus_prefix')}: {item.part_prefix || '-'}
                    </span>
                    <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-800">
                      {t('quality.daily_attention_matching_reports')}: {item.matching_report_count}
                    </span>
                    <span className="rounded-full bg-blue-100 px-3 py-1 font-medium text-blue-800">
                      {t('quality.daily_attention_latest_issue')}: {item.latest_report_dt ? dayjs(item.latest_report_dt).format('YYYY-MM-DD') : '-'}
                    </span>
                  </div>
                </div>

                <div className="grid gap-4 px-4 py-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                      <FolderOpen className="h-4 w-4" />
                      {t('quality.daily_attention_top_phenomena')}
                    </div>
                    {phenomenonGroups.length === 0 ? (
                      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-4 text-sm text-emerald-700">
                        {t('quality.daily_attention_no_history')}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {phenomenonGroups.map((group) => (
                          <div key={`${itemKey}-${group.phenomenon}`} className="rounded-lg border border-amber-200 bg-white px-3 py-2">
                            <div className="font-medium text-amber-900">{group.phenomenon}</div>
                            <div className="mt-1 text-sm text-amber-700">
                              {group.totalCount} · {group.sectionCounts.map((entry) => `${entry.section} ${entry.count}`).join(' / ')}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <CalendarDays className="h-4 w-4" />
                        {t('quality.daily_attention_historical_reports')} ({item.reports.length})
                      </div>
                      {phenomenonGroups.length > 0 && (
                        <div className="flex items-center gap-2">
                          <Button type="button" variant="secondary" onClick={() => setAllPhenomena(itemKey, phenomenonGroups, true)}>
                            {expandAllLabel}
                          </Button>
                          <Button type="button" variant="secondary" onClick={() => setAllPhenomena(itemKey, phenomenonGroups, false)}>
                            {collapseAllLabel}
                          </Button>
                        </div>
                      )}
                    </div>

                    {phenomenonGroups.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
                        {t('quality.daily_attention_no_history')}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {phenomenonGroups.map((group) => {
                          const isOpen = isPhenomenonOpen(itemKey, group.phenomenon);
                          return (
                            <section key={`${itemKey}-${group.phenomenon}`} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                              <button
                                type="button"
                                onClick={() => togglePhenomenon(itemKey, group.phenomenon)}
                                className="flex w-full items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-left"
                              >
                                <div>
                                  <div className="font-semibold text-slate-900">{group.phenomenon}</div>
                                  <div className="mt-1 text-sm text-slate-600">
                                    {group.totalCount} · {group.sectionCounts.map((entry) => `${entry.section} ${entry.count}`).join(' / ')}
                                  </div>
                                </div>
                                {isOpen ? <ChevronDown className="h-5 w-5 text-slate-500" /> : <ChevronRight className="h-5 w-5 text-slate-500" />}
                              </button>

                              {isOpen && (
                                <div className="grid gap-3 border-t border-gray-200 p-4 md:grid-cols-2 xl:grid-cols-3">
                                  {group.reports.map((report) => (
                                    <article key={report.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                                      <div className="aspect-[4/3] bg-gray-100">
                                        {report.images.length > 0 ? (
                                          <img src={report.images[0]} alt={report.phenomenon || report.part_no} className="h-full w-full object-cover" />
                                        ) : (
                                          <div className="flex h-full items-center justify-center text-sm text-gray-400">
                                            {t('quality.daily_attention_no_image')}
                                          </div>
                                        )}
                                      </div>
                                      <div className="space-y-2 px-3 py-3 text-sm">
                                        <div className="flex items-center justify-between gap-2">
                                          <div className="font-semibold text-slate-900">{report.phenomenon || noPhenomenonLabel}</div>
                                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                                            {normalizeSection(report.section)}
                                          </span>
                                        </div>
                                        <div className="text-slate-600">{dayjs(report.report_dt).format('YYYY-MM-DD')} · {report.section}</div>
                                        <div className="text-slate-600">{report.part_no}</div>
                                        <div className="line-clamp-3 text-slate-700">{report.disposition || report.action_result || '-'}</div>
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
