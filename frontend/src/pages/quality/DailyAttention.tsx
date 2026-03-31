import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight, FolderOpen, Printer } from 'lucide-react';
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

type PrintLabels = {
  title: string;
  machine: string;
  partNo: string;
  plannedQty: string;
  models: string;
  lots: string;
  history: string;
  none: string;
  latest: string;
  section: string;
  action: string;
  date: string;
};

const SECTION_ORDER: Record<string, number> = {
  CS: 0,
  OQC: 1,
  LQC: 2,
};

function normalizeSection(section: string): string {
  const value = (section || '').trim().toUpperCase();
  if (value.startsWith('CS')) return 'CS';
  if (value.startsWith('OQC')) return 'OQC';
  if (value.startsWith('LQC')) return 'LQC';
  return value || 'ETC';
}

function normalizePhenomenonLabel(value: string, emptyLabel: string): string {
  const raw = (value || '').trim();
  if (!raw) return emptyLabel;

  const normalized = raw
    .normalize('NFKC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[，、,;；/／|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[。．.]+$/g, '')
    .trim()
    .replace(/\s/g, '');

  if (!normalized) return emptyLabel;

  const tokens = new Set<string>();

  if (
    normalized.includes('脏污') ||
    normalized.includes('油污') ||
    normalized.includes('油渍') ||
    normalized.includes('油点') ||
    normalized.includes('灰尘') ||
    normalized.includes('污渍') ||
    normalized.includes('擦拭印')
  ) {
    tokens.add('脏污');
  }

  if (normalized.includes('白色粉末') || normalized.includes('粉末残留')) {
    tokens.add('白色粉末残留');
  }

  if (normalized.includes('毛刺') || normalized.includes('飞边')) {
    tokens.add('毛刺未去除');
  }

  if (normalized.includes('毛絮')) {
    tokens.add('毛絮残留');
  }

  if (normalized.includes('糊斑')) {
    tokens.add('糊斑');
  }

  if (normalized.includes('气印')) {
    tokens.add('气印发白');
  }

  if (normalized.includes('缩印') || normalized.includes('缩影')) {
    tokens.add('缩印');
  }

  if (normalized.includes('缺胶')) {
    tokens.add('缺胶');
  }

  if (normalized.includes('发亮') || normalized.includes('高光')) {
    tokens.add('发亮');
  }

  if (
    normalized.includes('拉伤') ||
    normalized.includes('擦伤') ||
    normalized.includes('削伤') ||
    normalized.includes('磕伤') ||
    normalized.includes('夹伤') ||
    normalized.includes('损伤')
  ) {
    tokens.add('擦伤/碰伤');
  }

  if (
    normalized.includes('夹色') ||
    normalized.includes('黑点') ||
    normalized.includes('料花')
  ) {
    tokens.add('夹色/黑点/料花');
  }

  if (
    normalized.includes('标签') ||
    normalized.includes('重码') ||
    normalized.includes('漏贴')
  ) {
    tokens.add('标签异常');
  }

  if (
    normalized.includes('包装') ||
    normalized.includes('包裹') ||
    normalized.includes('水渍')
  ) {
    tokens.add('包装异常');
  }

  if (tokens.size > 0) {
    return Array.from(tokens).join(' / ');
  }

  return normalized;
}

function groupReportsByPhenomenon(reports: HistoricalReport[], emptyLabel: string): PhenomenonGroup[] {
  const groups = new Map<string, HistoricalReport[]>();

  reports.forEach((report) => {
    const phenomenon = normalizePhenomenonLabel(report.phenomenon || '', emptyLabel);
    const current = groups.get(phenomenon) ?? [];
    current.push({
      ...report,
      phenomenon,
    });
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

      const primaryOrder = sectionCounts.length > 0
        ? Math.min(...sectionCounts.map((entry) => SECTION_ORDER[entry.section] ?? 99))
        : 99;

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSectionCounts(sectionCounts: Array<{ section: string; count: number }>): string {
  return sectionCounts.map((entry) => `${entry.section} ${entry.count}`).join(' / ');
}

function buildPrintDocumentHtml(params: {
  date: string;
  item: DailyAttentionItem;
  groups: PhenomenonGroup[];
  labels: PrintLabels;
  noPhenomenonLabel: string;
}) {
  const { date, item, groups, labels, noPhenomenonLabel } = params;

  const groupHtml = groups.length === 0
    ? `<div class="empty">${escapeHtml(labels.none)}</div>`
    : groups.map((group) => {
        const cardsHtml = group.reports.map((report) => {
          const imageHtml = report.images.length > 0
            ? report.images.map((image, index) => `
                <figure class="image-card">
                  <img src="${escapeHtml(image)}" alt="${escapeHtml(`${group.phenomenon} ${index + 1}`)}" />
                </figure>
              `).join('')
            : `<div class="image-empty">${escapeHtml(labels.none)}</div>`;

          return `
            <article class="report-card">
              <div class="report-meta-row">
                <div class="report-title">${escapeHtml(report.phenomenon || noPhenomenonLabel)}</div>
                <div class="report-badge">${escapeHtml(normalizeSection(report.section))}</div>
              </div>
              <div class="report-meta">${escapeHtml(labels.date)}: ${escapeHtml(dayjs(report.report_dt).format('YYYY-MM-DD'))}</div>
              <div class="report-meta">${escapeHtml(labels.partNo)}: ${escapeHtml(report.part_no || '-')}</div>
              <div class="report-meta">${escapeHtml(labels.section)}: ${escapeHtml(report.section || '-')}</div>
              <div class="report-meta">${escapeHtml(labels.action)}: ${escapeHtml(report.disposition || report.action_result || '-')}</div>
              <div class="image-grid">${imageHtml}</div>
            </article>
          `;
        }).join('');

        return `
          <section class="phenomenon-block">
            <div class="phenomenon-header">
              <div>
                <div class="phenomenon-title">${escapeHtml(group.phenomenon)}</div>
                <div class="phenomenon-meta">${group.totalCount} / ${escapeHtml(formatSectionCounts(group.sectionCounts))}</div>
              </div>
            </div>
            <div class="report-grid">${cardsHtml}</div>
          </section>
        `;
      }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(`${labels.title} - ${item.machine_name}`)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #0f172a;
      font-family: "Microsoft YaHei", "PingFang SC", "Malgun Gothic", sans-serif;
      background: #ffffff;
    }
    .page {
      width: 100%;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      border-bottom: 2px solid #dbeafe;
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      margin: 0 0 6px;
    }
    .subtitle, .meta-text {
      font-size: 12px;
      color: #475569;
      line-height: 1.5;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    .summary-card {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px 12px;
      background: #f8fafc;
      page-break-inside: avoid;
    }
    .summary-label {
      font-size: 11px;
      color: #64748b;
      margin-bottom: 4px;
    }
    .summary-value {
      font-size: 14px;
      font-weight: 700;
      word-break: break-word;
    }
    .phenomenon-block {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      margin-bottom: 12px;
      overflow: hidden;
      page-break-inside: avoid;
    }
    .phenomenon-header {
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      padding: 10px 12px;
    }
    .phenomenon-title {
      font-size: 15px;
      font-weight: 700;
    }
    .phenomenon-meta {
      margin-top: 4px;
      font-size: 12px;
      color: #475569;
    }
    .report-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      padding: 12px;
    }
    .report-card {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px;
      page-break-inside: avoid;
    }
    .report-meta-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: flex-start;
      margin-bottom: 6px;
    }
    .report-title {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.4;
    }
    .report-badge {
      font-size: 11px;
      border-radius: 999px;
      padding: 3px 8px;
      background: #e2e8f0;
      white-space: nowrap;
    }
    .report-meta {
      font-size: 12px;
      color: #475569;
      margin-bottom: 4px;
      line-height: 1.45;
      word-break: break-word;
    }
    .image-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .image-card {
      margin: 0;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
      background: #ffffff;
    }
    .image-card img {
      display: block;
      width: 100%;
      height: auto;
      object-fit: cover;
    }
    .image-empty, .empty {
      border: 1px dashed #cbd5e1;
      border-radius: 10px;
      background: #f8fafc;
      color: #64748b;
      padding: 16px;
      font-size: 12px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="header">
      <div>
        <h1 class="title">${escapeHtml(labels.title)}</h1>
        <div class="subtitle">${escapeHtml(labels.machine)}: ${escapeHtml(item.machine_name)}</div>
        <div class="subtitle">${escapeHtml(labels.date)}: ${escapeHtml(dayjs(date).format('YYYY-MM-DD'))}</div>
      </div>
      <div class="meta-text">${escapeHtml(labels.history)}: ${item.matching_report_count}</div>
    </header>

    <section class="summary-grid">
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.partNo)}</div>
        <div class="summary-value">${escapeHtml(item.part_nos.join(', ') || '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.plannedQty)}</div>
        <div class="summary-value">${item.planned_quantity.toLocaleString()}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.models)}</div>
        <div class="summary-value">${escapeHtml(item.model_names.join(', ') || '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.lots)}</div>
        <div class="summary-value">${escapeHtml(item.lot_nos.join(', ') || '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.latest)}</div>
        <div class="summary-value">${escapeHtml(item.latest_report_dt ? dayjs(item.latest_report_dt).format('YYYY-MM-DD') : '-')}</div>
      </div>
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.history)}</div>
        <div class="summary-value">${item.matching_report_count.toLocaleString()}</div>
      </div>
    </section>

    ${groupHtml}
  </div>
  <script>
    window.onload = function () {
      setTimeout(function () {
        window.print();
      }, 120);
    };
    window.onafterprint = function () {
      window.close();
    };
  </script>
</body>
</html>`;
}

export default function DailyAttentionPage() {
  const { t, lang } = useLang();
  const [targetDate, setTargetDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, Record<string, boolean>>>({});

  const noPhenomenonLabel = lang === 'zh' ? '未填写现象' : '현상 미입력';
  const expandAllLabel = lang === 'zh' ? '全部 펼치기' : '모두 펼치기';
  const collapseAllLabel = lang === 'zh' ? '全部 접기' : '모두 접기';
  const rowsLabel = lang === 'zh' ? '행' : '행';
  const printLabel = lang === 'zh' ? 'A4 PDF / 打印' : 'A4 PDF / 인쇄';

  const printLabels: PrintLabels = {
    title: t('quality.daily_attention_title'),
    machine: lang === 'zh' ? '注塑机' : '사출기',
    partNo: t('part_no'),
    plannedQty: t('quality.daily_attention_planned_qty'),
    models: lang === 'zh' ? '机种' : '모델',
    lots: 'LOT',
    history: t('quality.daily_attention_historical_reports'),
    none: t('quality.daily_attention_no_history'),
    latest: t('quality.daily_attention_latest_issue'),
    section: lang === 'zh' ? '区段' : '구분',
    action: lang === 'zh' ? '处理结果' : '처리 결과',
    date: t('date'),
  };

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

  const handlePrintItem = (item: DailyAttentionItem, groups: PhenomenonGroup[]) => {
    const printWindow = window.open('', '_blank', 'width=1200,height=900');
    if (!printWindow) return;

    const html = buildPrintDocumentHtml({
      date: targetDate,
      item,
      groups,
      labels: printLabels,
      noPhenomenonLabel,
    });

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
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
                      {(item.model_names.length > 0 ? item.model_names.join(', ') : '-')} | {t('quality.daily_attention_planned_qty')}: {item.planned_quantity.toLocaleString()}
                      {item.lot_nos.length > 0 ? ` | LOT ${item.lot_nos.join(', ')}` : ''}
                      {item.plan_row_count > 1 ? ` | ${item.plan_row_count} ${rowsLabel}` : ''}
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
                    <Button type="button" variant="secondary" onClick={() => handlePrintItem(item, phenomenonGroups)} className="gap-2">
                      <Printer className="h-4 w-4" />
                      {printLabel}
                    </Button>
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
                              {group.totalCount} | {formatSectionCounts(group.sectionCounts)}
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
                                    {group.totalCount} | {formatSectionCounts(group.sectionCounts)}
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
                                        <div className="text-slate-600">{dayjs(report.report_dt).format('YYYY-MM-DD')} | {report.section}</div>
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
