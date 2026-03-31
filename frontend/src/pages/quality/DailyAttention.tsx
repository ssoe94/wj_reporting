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

type PrintableImage = {
  id: string;
  imageUrl: string;
  phenomenon: string;
  reportDt: string;
  section: string;
  partNo: string;
  disposition: string;
  actionResult: string;
};

type PrintSelectionState = {
  item: DailyAttentionItem;
  groups: PhenomenonGroup[];
  images: PrintableImage[];
  selectedIds: string[];
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
  selectedPhotos: string;
  topPhenomena: string;
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

function collectPrintableImages(groups: PhenomenonGroup[]): PrintableImage[] {
  return groups.flatMap((group) =>
    group.reports.flatMap((report) =>
      report.images.map((imageUrl, imageIndex) => ({
        id: `${report.id}-${imageIndex}`,
        imageUrl,
        phenomenon: group.phenomenon,
        reportDt: report.report_dt,
        section: report.section,
        partNo: report.part_no,
        disposition: report.disposition,
        actionResult: report.action_result,
      })),
    ),
  );
}

function buildPrintDocumentHtml(params: {
  date: string;
  item: DailyAttentionItem;
  groups: PhenomenonGroup[];
  selectedImages: PrintableImage[];
  labels: PrintLabels;
  noPhenomenonLabel: string;
}) {
  const { date, item, groups, selectedImages, labels, noPhenomenonLabel } = params;

  const summaryHtml = groups.length === 0
    ? `<div class="empty">${escapeHtml(labels.none)}</div>`
    : groups.map((group) => `
        <div class="summary-tag">
          <div class="summary-tag-title">${escapeHtml(group.phenomenon)}</div>
          <div class="summary-tag-meta">${group.totalCount} | ${escapeHtml(formatSectionCounts(group.sectionCounts))}</div>
        </div>
      `).join('');

  const selectedGroupMap = new Map<string, PrintableImage[]>();
  selectedImages.forEach((image) => {
    const current = selectedGroupMap.get(image.phenomenon) ?? [];
    current.push(image);
    selectedGroupMap.set(image.phenomenon, current);
  });

  const selectedHtml = selectedImages.length === 0
    ? `<div class="empty">${escapeHtml(labels.none)}</div>`
    : Array.from(selectedGroupMap.entries()).map(([phenomenon, images]) => `
        <section class="photo-section">
          <div class="photo-section-header">
            <div class="photo-section-title">${escapeHtml(phenomenon || noPhenomenonLabel)}</div>
            <div class="photo-section-count">${images.length}</div>
          </div>
          <div class="photo-grid">
            ${images.map((image) => `
              <article class="photo-card">
                <figure class="photo-frame">
                  <img src="${escapeHtml(image.imageUrl)}" alt="${escapeHtml(image.phenomenon || noPhenomenonLabel)}" />
                </figure>
                <div class="photo-meta">
                  <div class="photo-meta-row">
                    <span class="photo-badge">${escapeHtml(normalizeSection(image.section))}</span>
                    <span>${escapeHtml(dayjs(image.reportDt).format('YYYY-MM-DD'))}</span>
                  </div>
                  <div>${escapeHtml(labels.partNo)}: ${escapeHtml(image.partNo || '-')}</div>
                  <div>${escapeHtml(labels.action)}: ${escapeHtml(image.disposition || image.actionResult || '-')}</div>
                </div>
              </article>
            `).join('')}
          </div>
        </section>
      `).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(`${labels.title} - ${item.machine_name}`)}</title>
  <style>
    @page { size: A4; margin: 9mm; }
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
      gap: 12px;
      align-items: flex-start;
      border-bottom: 2px solid #dbeafe;
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .title {
      font-size: 16px;
      font-weight: 700;
      margin: 0 0 4px;
    }
    .subtitle, .meta-text {
      font-size: 10px;
      color: #475569;
      line-height: 1.35;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 8px;
    }
    .summary-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 7px 9px;
      background: #f8fafc;
      page-break-inside: avoid;
    }
    .summary-label {
      font-size: 10px;
      color: #64748b;
      margin-bottom: 2px;
    }
    .summary-value {
      font-size: 11px;
      font-weight: 700;
      word-break: break-word;
    }
    .content-grid {
      display: grid;
      grid-template-columns: 180px minmax(0, 1fr);
      gap: 8px;
      align-items: flex-start;
    }
    .summary-panel {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #f8fafc;
      padding: 8px;
      page-break-inside: avoid;
    }
    .panel-title {
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .summary-tag {
      border: 1px solid #fbbf24;
      border-radius: 8px;
      background: #ffffff;
      padding: 6px 7px;
      margin-bottom: 6px;
    }
    .summary-tag-title {
      font-size: 11px;
      font-weight: 700;
      color: #9a3412;
    }
    .summary-tag-meta {
      margin-top: 2px;
      font-size: 10px;
      color: #475569;
    }
    .photo-panel {
      min-width: 0;
    }
    .photo-section {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 8px;
      page-break-inside: avoid;
    }
    .photo-section-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      padding: 7px 9px;
    }
    .photo-section-title {
      font-size: 12px;
      font-weight: 700;
    }
    .photo-section-count {
      min-width: 22px;
      height: 22px;
      border-radius: 999px;
      background: #fff7ed;
      color: #c2410c;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
    }
    .photo-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      padding: 8px;
    }
    .photo-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
      background: #ffffff;
      page-break-inside: avoid;
    }
    .photo-frame {
      margin: 0;
      background: #f8fafc;
      aspect-ratio: 4 / 3;
      overflow: hidden;
    }
    .photo-frame img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .photo-meta {
      padding: 7px;
      font-size: 10px;
      color: #475569;
      line-height: 1.35;
      word-break: break-word;
    }
    .photo-meta-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-bottom: 4px;
      color: #334155;
    }
    .photo-badge {
      font-size: 9px;
      border-radius: 999px;
      padding: 2px 6px;
      background: #e2e8f0;
    }
    .empty {
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
      background: #f8fafc;
      color: #64748b;
      padding: 12px;
      font-size: 10px;
      text-align: center;
    }
    @media print {
      .photo-section,
      .photo-card,
      .summary-panel {
        break-inside: avoid;
      }
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
      <div class="summary-card">
        <div class="summary-label">${escapeHtml(labels.selectedPhotos)}</div>
        <div class="summary-value">${selectedImages.length.toLocaleString()}</div>
      </div>
    </section>

    <section class="content-grid">
      <aside class="summary-panel">
        <div class="panel-title">${escapeHtml(labels.topPhenomena)}</div>
        ${summaryHtml}
      </aside>
      <div class="photo-panel">
        ${selectedHtml}
      </div>
    </section>
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
  const [printSelection, setPrintSelection] = useState<PrintSelectionState | null>(null);

  const noPhenomenonLabel = lang === 'zh' ? '未填写现象' : '현상 미입력';
  const expandAllLabel = lang === 'zh' ? '全部 펼치기' : '모두 펼치기';
  const collapseAllLabel = lang === 'zh' ? '全部 접기' : '모두 접기';
  const rowsLabel = lang === 'zh' ? '행' : '행';
  const printLabel = lang === 'zh' ? 'A4 PDF / 打印' : 'A4 PDF / 인쇄';
  const printPickerTitle = lang === 'zh' ? '选择要打印的照片' : '인쇄할 사진 선택';
  const printPickerDescription = lang === 'zh' ? '勾选后只打印所选照片。' : '체크한 사진만 인쇄 문서에 포함됩니다.';
  const selectAllPhotosLabel = lang === 'zh' ? '全部选择' : '전체 선택';
  const clearSelectedPhotosLabel = lang === 'zh' ? '全部取消' : '전체 해제';
  const printSelectedPhotosLabel = lang === 'zh' ? '选择后打印' : '선택 후 인쇄';
  const closeLabel = lang === 'zh' ? '关闭' : '닫기';
  const selectedCountLabel = lang === 'zh' ? '已选照片' : '선택 사진';
  const noSelectableImagesLabel = lang === 'zh' ? '可选图片不存在，将摘要直接打印。' : '선택할 사진이 없어 요약만 인쇄됩니다.';

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
    selectedPhotos: lang === 'zh' ? '选择照片数' : '선택 사진 수',
    topPhenomena: t('quality.daily_attention_top_phenomena'),
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

  const openPrintWindow = (item: DailyAttentionItem, groups: PhenomenonGroup[], selectedImages: PrintableImage[]) => {
    const printWindow = window.open('', '_blank', 'width=1200,height=900');
    if (!printWindow) return;

    const html = buildPrintDocumentHtml({
      date: targetDate,
      item,
      groups,
      selectedImages,
      labels: printLabels,
      noPhenomenonLabel,
    });

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
  };

  const handlePrintItem = (item: DailyAttentionItem, groups: PhenomenonGroup[]) => {
    const images = collectPrintableImages(groups);
    if (images.length === 0) {
      openPrintWindow(item, groups, []);
      return;
    }

    setPrintSelection({
      item,
      groups,
      images,
      selectedIds: images.map((image) => image.id),
    });
  };

  const togglePrintImage = (imageId: string) => {
    setPrintSelection((prev) => {
      if (!prev) return prev;
      const isSelected = prev.selectedIds.includes(imageId);
      return {
        ...prev,
        selectedIds: isSelected
          ? prev.selectedIds.filter((id) => id !== imageId)
          : [...prev.selectedIds, imageId],
      };
    });
  };

  const setAllPrintImages = (selected: boolean) => {
    setPrintSelection((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        selectedIds: selected ? prev.images.map((image) => image.id) : [],
      };
    });
  };

  const confirmPrintSelection = () => {
    if (!printSelection) return;
    const selectedImages = printSelection.images.filter((image) => printSelection.selectedIds.includes(image.id));
    openPrintWindow(printSelection.item, printSelection.groups, selectedImages);
    setPrintSelection(null);
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

      {printSelection && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">{printPickerTitle}</h2>
                  <p className="mt-1 text-sm text-slate-600">{printPickerDescription}</p>
                  <p className="mt-2 text-sm font-medium text-slate-800">
                    {printSelection.item.machine_name} / {printSelection.item.part_nos.join(', ')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
                    {selectedCountLabel}: {printSelection.selectedIds.length} / {printSelection.images.length}
                  </span>
                  <Button type="button" variant="secondary" onClick={() => setAllPrintImages(true)}>
                    {selectAllPhotosLabel}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setAllPrintImages(false)}>
                    {clearSelectedPhotosLabel}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {printSelection.images.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                  {noSelectableImagesLabel}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {printSelection.images.map((image) => {
                    const isSelected = printSelection.selectedIds.includes(image.id);
                    return (
                      <label
                        key={image.id}
                        className={`overflow-hidden rounded-xl border transition ${
                          isSelected
                            ? 'border-blue-400 bg-blue-50/60 shadow-sm'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <div className="relative aspect-[4/3] bg-slate-100">
                          <img src={image.imageUrl} alt={image.phenomenon} className="h-full w-full object-cover" />
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => togglePrintImage(image.id)}
                            className="absolute left-3 top-3 h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                        </div>
                        <div className="space-y-1 px-4 py-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-slate-900">{image.phenomenon || noPhenomenonLabel}</div>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                              {normalizeSection(image.section)}
                            </span>
                          </div>
                          <div className="text-slate-600">{dayjs(image.reportDt).format('YYYY-MM-DD')}</div>
                          <div className="text-slate-600">{image.partNo || '-'}</div>
                          <div className="line-clamp-2 text-slate-700">{image.disposition || image.actionResult || '-'}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <Button type="button" variant="secondary" onClick={() => setPrintSelection(null)}>
                {closeLabel}
              </Button>
              <Button type="button" onClick={confirmPrintSelection} disabled={printSelection.selectedIds.length === 0 && printSelection.images.length > 0}>
                {printSelectedPhotosLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
