import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FolderOpen,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useLang } from '../../i18n';
import { useState, useEffect, useRef, useMemo } from 'react';
import { Label } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import { toast } from 'react-toastify';
import dayjs from 'dayjs';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { ko, zhCN } from 'date-fns/locale';
import { Autocomplete, TextField } from '@mui/material';
import { usePartSpecSearch, usePartListByModel } from '../../hooks/usePartSpecs';
import {
  useAssemblyPartNoSearch,
  useAssemblyModelSearch,
  useAssemblyPartspecsByModel,
  useAssemblyPartsByModel,
} from '../../hooks/useAssemblyParts';
import { useAuth } from '../../contexts/AuthContext';
import type { QualityReportHistoryScope } from './importTypes';

// 서버에서 받아올 데이터 타입 정의
interface QualityReport {
  id: number;
  report_dt: string;
  section: string;
  model: string;
  part_no: string;
  lot_qty: number | null;
  inspection_qty?: number | null;
  defect_qty?: number | null;
  defect_rate: string;
  judgement: string;
  phenomenon?: string;
  disposition?: string;
  action_result?: string;
  image1?: string;
  image2?: string;
  image3?: string;
  image4?: string;
  image5?: string;
}

const IMAGE_ERROR_PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect fill="%23ddd" width="48" height="48"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999"%3E?%3C/text%3E%3C/svg%3E';

function resolveImageUrl(url: string) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const apiBase = import.meta.env.VITE_API_BASE_URL || '';
  if (url.startsWith('/media')) {
    return `${apiBase || 'http://localhost:8000'}${url}`;
  }
  return `${apiBase}${url.startsWith('/') ? url : `/${url}`}`;
}

function getReportImages(report: QualityReport) {
  return [report.image1, report.image2, report.image3, report.image4, report.image5].filter(Boolean) as string[];
}

type ModelOption = {
  model_code: string;
  description?: string | null;
};

type PartOption = {
  part_no: string;
  model_code?: string | null;
  description?: string | null;
};

type ReportOrdering = '-report_dt,-id' | 'report_dt,id' | '-created_at,-id';

const FILTER_AUTOCOMPLETE_SX = {
  '& .MuiAutocomplete-inputRoot': {
    boxSizing: 'border-box',
    height: 'var(--wj-control-height)',
    minHeight: 'var(--wj-control-height)',
    paddingTop: '0 !important',
    paddingBottom: '0 !important',
  },
  '& .MuiAutocomplete-inputRoot input.MuiAutocomplete-input': {
    boxSizing: 'border-box',
    height: 'var(--wj-control-height-inner)',
    minHeight: 'var(--wj-control-height-inner)',
    paddingTop: '0 !important',
    paddingBottom: '0 !important',
  },
};

interface QualityReportHistoryProps {
  reportScope?: QualityReportHistoryScope | null;
  onClearReportScope?: () => void;
}

export default function QualityReportHistory({
  reportScope = null,
  onClearReportScope,
}: QualityReportHistoryProps) {
  const { t, lang } = useLang();
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canEditQuality = Boolean(user?.is_staff || hasPermission('can_edit_quality'));
  const [filters, setFilters] = useState(() => ({
    dateFrom: '',
    dateTo: '',
    model: '',
    part_no: '',
    includeSimilar: false,
    keyword: '',
    section: '',
  }));
  const [keywordInput, setKeywordInput] = useState('');
  const [ordering, setOrdering] = useState<ReportOrdering>('-report_dt,-id');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [pageInput, setPageInput] = useState('1');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [actionResults, setActionResults] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [selectedReport, setSelectedReport] = useState<QualityReport | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedReportIds, setSelectedReportIds] = useState<Set<number>>(() => new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[] | null>(null);
  const [modelInputValue, setModelInputValue] = useState('');
  const [partInputValue, setPartInputValue] = useState('');
  const [selectedModelOption, setSelectedModelOption] = useState<ModelOption | null>(null);
  const [selectedPartOption, setSelectedPartOption] = useState<PartOption | null>(null);
  const dateInputLang = lang === 'zh' ? 'zh-CN' : 'ko-KR';
  const datePlaceholder = lang === 'zh' ? '年-月-日' : '년-월-일';
  const dateInputClassName = 'text-center placeholder:text-center cursor-pointer';
  const [openCalendar, setOpenCalendar] = useState<'from' | 'to' | null>(null);
  const [calendarMonths, setCalendarMonths] = useState<Record<'from' | 'to', Date>>(() => ({
    from: dayjs().subtract(29, 'day').toDate(),
    to: dayjs().toDate(),
  }));
  const fromFieldRef = useRef<HTMLDivElement | null>(null);
  const toFieldRef = useRef<HTMLDivElement | null>(null);
  const listTopRef = useRef<HTMLDivElement | null>(null);
  const selectAllToolbarRef = useRef<HTMLInputElement | null>(null);
  const selectAllTableRef = useRef<HTMLInputElement | null>(null);
  const dateLocale = lang === 'zh' ? zhCN : ko;
  const hasPartFilter = filters.part_no.trim().length > 0;
  const modelQuery = modelInputValue.trim();
  const partQuery = partInputValue.trim();
  const activeModelCodeRaw = (selectedModelOption?.model_code || filters.model || '').trim();
  const normalizedActiveModelCode = activeModelCodeRaw.toUpperCase();
  const hasActiveModel = normalizedActiveModelCode.length > 0;
  const scopedReportIds = useMemo(
    () => [...new Set((reportScope?.reportIds || []).filter((id) => Number.isSafeInteger(id) && id > 0))],
    [reportScope],
  );
  const reportScopeKey = scopedReportIds.join(',');
  const isAllDates = !filters.dateFrom && !filters.dateTo;
  const recent30DateFrom = dayjs().subtract(29, 'day').format('YYYY-MM-DD');
  const recent30DateTo = dayjs().format('YYYY-MM-DD');
  const isRecent30Days = filters.dateFrom === recent30DateFrom && filters.dateTo === recent30DateTo;
  const activeFilterCount = [
    Boolean(filters.keyword.trim()),
    Boolean(filters.section),
    !isAllDates,
    Boolean(filters.model.trim()),
    Boolean(filters.part_no.trim()),
  ].filter(Boolean).length;
  const hasCustomizedView = activeFilterCount > 0 || ordering !== '-report_dt,-id';

  const applyDatePreset = (preset: 'all' | 'recent30') => {
    setPage(1);
    setOpenCalendar(null);
    setFilters((previous) => ({
      ...previous,
      dateFrom: preset === 'all' ? '' : recent30DateFrom,
      dateTo: preset === 'all' ? '' : recent30DateTo,
    }));
  };

  const applyKeywordSearch = () => {
    const keyword = keywordInput.trim();
    setPage(1);
    setFilters((previous) => (
      previous.keyword === keyword ? previous : { ...previous, keyword }
    ));
  };

  const resetSearchView = () => {
    setFilters({
      dateFrom: '',
      dateTo: '',
      model: '',
      part_no: '',
      includeSimilar: false,
      keyword: '',
      section: '',
    });
    setKeywordInput('');
    setOrdering('-report_dt,-id');
    setModelInputValue('');
    setPartInputValue('');
    setSelectedModelOption(null);
    setSelectedPartOption(null);
    setOpenCalendar(null);
    setShowAdvancedFilters(false);
    setPage(1);
  };

  // 모델 검색용 - modelQuery 사용
  const { data: modelSearchResults = [] } = usePartSpecSearch(modelQuery.toUpperCase());
  const { data: assemblyModelResults = [] } = useAssemblyModelSearch(modelQuery || '');
  
  // Part 검색용 - partQuery 사용 (항상 검색)
  const { data: partSearchResults = [] } = usePartSpecSearch(partQuery.toUpperCase());
  const { data: assemblyPartSearchResults = [] } = useAssemblyPartNoSearch(partQuery || '');

  // 모델이 선택되었을 때 해당 모델의 part 목록 가져오기
  const { data: partListByModel = [] } = usePartListByModel(activeModelCodeRaw || undefined);
  const { data: asmPartsByModel = [] } = useAssemblyPartsByModel(activeModelCodeRaw || undefined);
  const { data: asmPartspecsByModel = [] } = useAssemblyPartspecsByModel(activeModelCodeRaw || undefined);

  const modelOptions = useMemo<ModelOption[]>(() => {
    const map = new Map<string, ModelOption>();
    const add = (opt?: Partial<ModelOption> | null) => {
      const rawCode = (opt?.model_code || (opt as any)?.model || '').toString().trim();
      if (!rawCode) return;
      const normalized = rawCode.toUpperCase();
      const desc = (opt?.description || '').toString().trim();
      const key = `${normalized}|${desc}`;
      if (!map.has(key)) {
        map.set(key, { model_code: rawCode, description: desc });
      }
    };

    (Array.isArray(modelSearchResults) ? modelSearchResults : []).forEach((item: any) => {
      add({ model_code: item.model_code, description: item.description });
    });

    const assemblyModels = Array.isArray(assemblyModelResults)
      ? assemblyModelResults
      : Array.isArray((assemblyModelResults as any)?.results)
        ? (assemblyModelResults as any).results
        : [];
    assemblyModels.forEach((item: any) => {
      add({ model_code: item.model_code || item.model, description: item.description });
    });

    if (selectedModelOption) {
      add(selectedModelOption);
    }
    if (activeModelCodeRaw) {
      add({ model_code: activeModelCodeRaw });
    }

    return Array.from(map.values()).sort((a, b) => {
      const codeCompare = a.model_code.localeCompare(b.model_code);
      if (codeCompare !== 0) return codeCompare;
      return (a.description || '').localeCompare(b.description || '');
    });
  }, [activeModelCodeRaw, assemblyModelResults, modelSearchResults, selectedModelOption]);

  const partOptions = useMemo<PartOption[]>(() => {
    const map = new Map<string, PartOption>();
    const add = (opt?: Partial<PartOption> | null) => {
      const partNoRaw = (opt?.part_no || '').toString().trim();
      if (!partNoRaw) return;
      const modelCodeRaw = ((opt?.model_code ?? (opt as any)?.model) || '').toString().trim();
      const desc = (opt?.description || '').toString().trim();
      const key = `${partNoRaw.toUpperCase()}|${modelCodeRaw.toUpperCase()}|${desc}`;
      if (!map.has(key)) {
        map.set(key, {
          part_no: partNoRaw,
          model_code: modelCodeRaw,
          description: desc,
        });
      }
    };

    // 모델이 선택된 경우: 해당 모델의 part 추가
    if (selectedModelOption) {
      (Array.isArray(partListByModel) ? partListByModel : []).forEach((item: any) => {
        add({ part_no: item.part_no, model_code: item.model_code, description: item.description });
      });
      (Array.isArray(asmPartsByModel) ? asmPartsByModel : []).forEach((item: any) => {
        add({ part_no: item.part_no, model_code: item.model_code || item.model, description: item.description });
      });
      (Array.isArray(asmPartspecsByModel) ? asmPartspecsByModel : []).forEach((item: any) => {
        add({ part_no: item.part_no, model_code: item.model_code, description: item.description });
      });
    }
    
    // 검색 결과도 항상 추가 (모델 선택 여부와 관계없이)
    (Array.isArray(partSearchResults) ? partSearchResults : []).forEach((item: any) => {
      add({ part_no: item.part_no, model_code: item.model_code, description: item.description });
    });

    const assemblyPartList = Array.isArray(assemblyPartSearchResults)
      ? assemblyPartSearchResults
      : Array.isArray((assemblyPartSearchResults as any)?.results)
        ? (assemblyPartSearchResults as any).results
        : [];
    assemblyPartList.forEach((item: any) => {
      add({
        part_no: item.part_no,
        model_code: item.model_code || item.model,
        description: item.description,
      });
    });

    (Array.isArray(partListByModel) ? partListByModel : []).forEach((item: any) => {
      add({ part_no: item.part_no, model_code: item.model_code ?? item.model, description: item.description });
    });

    (Array.isArray(asmPartsByModel) ? asmPartsByModel : []).forEach((item: any) => {
      add({ part_no: item.part_no, model_code: item.model_code ?? item.model, description: item.description });
    });

    (Array.isArray(asmPartspecsByModel) ? asmPartspecsByModel : []).forEach((item: any) => {
      add({ part_no: item.part_no, model_code: item.model_code ?? item.model, description: item.description });
    });

    if (selectedPartOption) {
      add(selectedPartOption);
    }

    let list = Array.from(map.values());
    if (hasActiveModel) {
      list = list.filter((opt) => {
        const optCode = (opt.model_code || '').trim().toUpperCase();
        if (!optCode) return true;
        return optCode === normalizedActiveModelCode;
      });
    }

    return list.sort((a, b) => a.part_no.localeCompare(b.part_no));
  }, [
    asmPartsByModel,
    asmPartspecsByModel,
    assemblyPartSearchResults,
    hasActiveModel,
    normalizedActiveModelCode,
    partListByModel,
    partSearchResults,
    selectedModelOption,
    selectedPartOption,
  ]);

  useEffect(() => {
    if (!openCalendar) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (openCalendar === 'from' && fromFieldRef.current && !fromFieldRef.current.contains(target)) {
        setOpenCalendar(null);
      }
      if (openCalendar === 'to' && toFieldRef.current && !toFieldRef.current.contains(target)) {
        setOpenCalendar(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openCalendar]);

  const renderDateInput = (type: 'from' | 'to') => {
    const value = type === 'from' ? filters.dateFrom : filters.dateTo;
    const selectedDate = value ? dayjs(value, 'YYYY-MM-DD').toDate() : undefined;
    const fieldRef = type === 'from' ? fromFieldRef : toFieldRef;
    const currentMonth = calendarMonths[type];
    const setCurrentMonth = (month: Date) => {
      setCalendarMonths(previous => ({ ...previous, [type]: month }));
    };
    
    const handleSelect = (date: Date | undefined) => {
      const formatted = date ? dayjs(date).format('YYYY-MM-DD') : '';
      if (date) setCurrentMonth(date);
      setPage(1);
      setFilters(f => ({
        ...f,
        [type === 'from' ? 'dateFrom' : 'dateTo']: formatted,
      }));
      setOpenCalendar(null);
    };

    const clearLabel = lang === 'zh' ? '清除' : '초기화';
    const todayLabel = lang === 'zh' ? '今天' : '오늘';

    return (
      <div ref={fieldRef} className="relative">
        <Input
          type="text"
          lang={dateInputLang}
          placeholder={datePlaceholder}
          className={dateInputClassName}
          readOnly
          value={value}
          onClick={() => setOpenCalendar(prev => (prev === type ? null : type))}
        />
        {openCalendar === type && (
          <div className="absolute left-0 top-full z-20 mt-2">
            <div className="w-[280px] rounded-lg border bg-white shadow-lg overflow-hidden">
              <div className="bg-gradient-to-r from-indigo-50 to-blue-50 px-3 py-2 border-b flex items-center justify-between">
                <button 
                  type="button" 
                  onClick={() => setCurrentMonth(dayjs(currentMonth).subtract(1, 'month').toDate())}
                  className="p-1 rounded hover:bg-white/50 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4 text-gray-600" />
                </button>
                <span className="text-sm font-semibold text-gray-800">
                  {dayjs(currentMonth).format(lang === 'zh' ? 'YYYY年 M月' : 'YYYY년 M월')}
                </span>
                <button 
                  type="button" 
                  onClick={() => setCurrentMonth(dayjs(currentMonth).add(1, 'month').toDate())}
                  className="p-1 rounded hover:bg-white/50 transition-colors"
                >
                  <ChevronRight className="w-4 h-4 text-gray-600" />
                </button>
              </div>
              <div className="p-3">
                <DayPicker
                  mode="single"
                  locale={dateLocale}
                  selected={selectedDate}
                  month={currentMonth}
                  onMonthChange={setCurrentMonth}
                  onSelect={handleSelect}
                  weekStartsOn={1}
                  className="mx-auto"
                  classNames={{
                    month: 'w-full',
                    day: 'h-8 w-8 text-sm rounded hover:bg-indigo-50 transition-colors',
                    day_selected: 'bg-indigo-500 text-white font-semibold hover:bg-indigo-600',
                    day_today: 'font-bold text-indigo-600',
                    nav: 'hidden',
                    caption: 'hidden',
                    head_cell: 'text-xs font-medium text-gray-500 w-8',
                    table: 'w-full border-collapse',
                    row: 'mt-0.5',
                  }}
                />
              </div>
              <div className="bg-gray-50 border-t px-3 py-2 flex items-center justify-between">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => handleSelect(new Date())}
                >
                  {todayLabel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => handleSelect(undefined)}
                >
                  {clearLabel}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // useQuery를 사용하여 서버에서 데이터 가져오기
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['quality-reports', filters, ordering, page, pageSize, reportScopeKey],
    queryFn: async () => {
      const params: Record<string, any> = {
        page,
        page_size: pageSize,
        ordering,
      };

      if (filters.dateFrom) params.report_dt_after = filters.dateFrom;
      if (filters.dateTo) params.report_dt_before = filters.dateTo;
      if (filters.keyword.trim()) params.search = filters.keyword.trim();
      if (filters.section) params.section = filters.section;

      const modelFilter = filters.model.trim();
      if (modelFilter) {
        params.model__icontains = modelFilter;
      }

      const partFilterRaw = filters.part_no.trim();
      if (partFilterRaw) {
        const normalizedPart = partFilterRaw.replace(/\s+/g, '').toUpperCase();
        if (filters.includeSimilar) {
          params.part_no__istartswith = normalizedPart.slice(0, 9);
        } else {
          params.part_no__icontains = normalizedPart;
        }
      }

      if (scopedReportIds.length > 0) {
        const { data } = await api.post(
          '/quality/reports/by-ids/',
          { ids: scopedReportIds },
          { params },
        );
        return data;
      }

      const { data } = await api.get('/quality/reports/', {
        params,
      });
      return data;
    },
    placeholderData: reportScopeKey ? undefined : (previousData) => previousData,
  });

  const reports: QualityReport[] = Array.isArray(data?.results) ? data.results : [];
  const totalCount = data?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const visibleReportIds = useMemo(() => reports.map((report) => report.id), [reports]);
  const selectedVisibleCount = visibleReportIds.filter((id) => selectedReportIds.has(id)).length;
  const reportMutationInFlight = isDeleting || savingId !== null;
  const allVisibleSelected = visibleReportIds.length > 0 && selectedVisibleCount === visibleReportIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  useEffect(() => {
    setPage(1);
  }, [reportScopeKey]);

  useEffect(() => {
    setSelectedReportIds(new Set());
  }, [filters, ordering, page, reportScopeKey]);

  useEffect(() => {
    if (selectAllToolbarRef.current) selectAllToolbarRef.current.indeterminate = someVisibleSelected;
    if (selectAllTableRef.current) selectAllTableRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  useEffect(() => {
    const visible = new Set(visibleReportIds);
    setSelectedReportIds((current) => {
      if ([...current].every((id) => visible.has(id))) return current;
      return new Set([...current].filter((id) => visible.has(id)));
    });
  }, [visibleReportIds]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const navigateToPage = (nextPage: number) => {
    const clampedPage = Math.min(Math.max(nextPage, 1), totalPages);
    if (clampedPage === page) {
      setPageInput(String(clampedPage));
      return;
    }
    setPage(clampedPage);
    setPageInput(String(clampedPage));
    window.requestAnimationFrame(() => {
      listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const handlePageJump = () => {
    const nextPage = Number.parseInt(pageInput, 10);
    if (Number.isNaN(nextPage)) {
      setPageInput(String(page));
      return;
    }
    const clampedPage = Math.min(Math.max(nextPage, 1), totalPages);
    navigateToPage(clampedPage);
  };

  const handleSaveActionResult = async (reportId: number) => {
    if (!canEditQuality) return;
    const actionResult = actionResults[reportId] || '';
    setSavingId(reportId);
    try {
      await api.patch(`/quality/reports/${reportId}/`, {
        action_result: actionResult
      });
      toast.success(t('save_success'));
      queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      setEditingId(null);
    } catch (_err) {
      toast.error(t('save_fail'));
    } finally {
      setSavingId(null);
    }
  };

  const toggleReportSelection = (reportId: number) => {
    if (!canEditQuality || reportMutationInFlight) return;
    setSelectedReportIds((current) => {
      const next = new Set(current);
      if (next.has(reportId)) next.delete(reportId);
      else next.add(reportId);
      return next;
    });
  };

  const toggleVisibleReports = () => {
    if (!canEditQuality || reportMutationInFlight) return;
    setSelectedReportIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleReportIds.forEach((id) => next.delete(id));
      else visibleReportIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const handleDeleteReport = (reportId: number) => {
    if (!canEditQuality || reportMutationInFlight) return;
    setPendingDeleteIds([reportId]);
  };

  const requestSelectedDelete = () => {
    if (!canEditQuality || reportMutationInFlight || selectedVisibleCount === 0) return;
    setPendingDeleteIds(
      visibleReportIds.filter((id) => selectedReportIds.has(id)).sort((a, b) => a - b),
    );
  };

  const confirmReportDelete = async () => {
    if (!canEditQuality || !pendingDeleteIds?.length || reportMutationInFlight) return;
    const deleteIds = [...pendingDeleteIds];
    setIsDeleting(true);
    try {
      await api.post('/quality/reports/bulk-delete/', {
        ids: deleteIds,
        confirmation: `DELETE_REPORTS:${deleteIds.length}`,
      });
      toast.success(lang === 'zh'
        ? `已删除 ${deleteIds.length.toLocaleString()} 条报告。`
        : `선택한 보고서 ${deleteIds.length.toLocaleString()}건을 삭제했습니다.`);
      setSelectedReportIds((current) => {
        const next = new Set(current);
        deleteIds.forEach((id) => next.delete(id));
        return next;
      });
      if (selectedReport && deleteIds.includes(selectedReport.id)) setSelectedReport(null);
      setPendingDeleteIds(null);
      await queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
    } catch (error: unknown) {
      const payload = (error as { response?: { data?: { code?: string } } })?.response?.data;
      if (payload?.code === 'bulk_delete_jobs_active') {
        toast.error(lang === 'zh'
          ? 'Excel 登记仍在处理中。请等待完成后再删除。'
          : 'Excel 등록이 처리 중입니다. 완료 후 다시 삭제해 주세요.');
      } else if (payload?.code === 'bulk_delete_scope_changed') {
        toast.error(lang === 'zh'
          ? '所选报告已发生变化。请刷新后重新选择。'
          : '선택한 보고서가 변경되었습니다. 새로 조회한 뒤 다시 선택해 주세요.');
        setSelectedReportIds(new Set());
        setPendingDeleteIds(null);
        await queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      } else {
        toast.error(t('delete_fail'));
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 bg-gradient-to-r from-indigo-50 to-white">
        <FolderOpen className="w-5 h-5 text-indigo-600" />
        <h2 className="text-base font-semibold text-gray-800">{t('quality.history_title')}</h2>
      </div>
      <div className="p-4 space-y-4">
        {reportScopeKey && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
            <strong className="min-w-0 flex-1">
              {t(`quality.import_scope_${reportScope?.kind || 'all'}`, { count: scopedReportIds.length.toLocaleString() })}
            </strong>
            <Button type="button" variant="secondary" size="sm" onClick={onClearReportScope}>
              {t('quality.import_scope_clear')}
            </Button>
          </div>
        )}
        {/* 검색 / 정렬 */}
        <section className="rounded-xl border border-slate-200 bg-slate-50/80 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-800">
                  {lang === 'zh' ? '搜索与排序' : '검색 및 정렬'}
                </h3>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                  {lang === 'zh' ? `共 ${totalCount.toLocaleString()} 条` : `총 ${totalCount.toLocaleString()}건`}
                </span>
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">
                    {lang === 'zh' ? `${activeFilterCount} 个筛选条件` : `필터 ${activeFilterCount}개 적용`}
                  </span>
                )}
                {isFetching && (
                  <span className="text-xs font-medium text-indigo-600" role="status">
                    {lang === 'zh' ? '正在更新…' : '조회 중…'}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {lang === 'zh'
                  ? '可同时搜索型号、Part No.、不良现象和处理方式。'
                  : '모델, Part No., 불량 현상과 처리 방식을 한 번에 검색합니다.'}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={resetSearchView}
              disabled={!hasCustomizedView}
              className="shrink-0 gap-1.5 text-slate-600"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {lang === 'zh' ? '重置' : '초기화'}
            </Button>
          </div>

          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(300px,1.45fr)_minmax(140px,0.6fr)_minmax(170px,0.7fr)_minmax(132px,0.5fr)]">
            <form
              className="min-w-0 sm:col-span-2 lg:col-span-1"
              onSubmit={(event) => {
                event.preventDefault();
                applyKeywordSearch();
              }}
            >
              <Label htmlFor="quality-history-keyword" className="mb-1.5 block text-xs font-semibold text-slate-600">
                {lang === 'zh' ? '综合搜索' : '통합 검색'}
              </Label>
              <div className="flex min-w-0 gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <Input
                    id="quality-history-keyword"
                    type="search"
                    value={keywordInput}
                    onChange={(event) => setKeywordInput(event.target.value)}
                    placeholder={lang === 'zh' ? '搜索型号、Part No.、不良现象' : '모델, Part No., 불량 현상 검색'}
                    className="h-[var(--wj-control-height)] min-h-[var(--wj-control-height)] pl-10"
                  />
                </div>
                <Button type="submit" size="sm" className="h-[var(--wj-control-height)] min-h-[var(--wj-control-height)] shrink-0 px-4">
                  {lang === 'zh' ? '搜索' : '검색'}
                </Button>
              </div>
            </form>

            <div className="min-w-0">
              <Label htmlFor="quality-history-section" className="mb-1.5 block text-xs font-semibold text-slate-600">
                {lang === 'zh' ? '报告部门' : '보고 부서'}
              </Label>
              <select
                id="quality-history-section"
                value={filters.section}
                onChange={(event) => {
                  setFilters((previous) => ({ ...previous, section: event.target.value }));
                  setPage(1);
                }}
                className="ui-input h-[var(--wj-control-height)] min-h-[var(--wj-control-height)] w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">{lang === 'zh' ? '全部部门' : '전체 부서'}</option>
                <option value="LQC_INJ">LQC - {t('quality.section_injection')}</option>
                <option value="LQC_ASM">LQC - {t('quality.section_assembly')}</option>
                <option value="IQC">IQC</option>
                <option value="OQC">OQC</option>
                <option value="CS">CS</option>
              </select>
            </div>

            <div className="min-w-0">
              <Label htmlFor="quality-history-ordering" className="mb-1.5 block text-xs font-semibold text-slate-600">
                {lang === 'zh' ? '排序方式' : '정렬 기준'}
              </Label>
              <div className="relative">
                <select
                  id="quality-history-ordering"
                  value={ordering}
                  onChange={(event) => {
                    setOrdering(event.target.value as ReportOrdering);
                    setPage(1);
                  }}
                  className="ui-input h-[var(--wj-control-height)] min-h-[var(--wj-control-height)] w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-3 pr-10 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="-report_dt,-id">{lang === 'zh' ? '报告日期：最新优先' : '보고일 최신순'}</option>
                  <option value="report_dt,id">{lang === 'zh' ? '报告日期：最早优先' : '보고일 오래된순'}</option>
                  <option value="-created_at,-id">{lang === 'zh' ? '登记时间：最新优先' : '최근 등록순'}</option>
                </select>
                <ArrowUpDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              </div>
            </div>

            <div className="min-w-0">
              <span className="mb-1.5 block text-xs font-semibold text-slate-600">
                {lang === 'zh' ? '其他条件' : '추가 조건'}
              </span>
              <Button
                type="button"
                size="sm"
                variant={showAdvancedFilters ? 'primary' : 'secondary'}
                aria-expanded={showAdvancedFilters}
                onClick={() => setShowAdvancedFilters((previous) => !previous)}
                className="h-[var(--wj-control-height)] min-h-[var(--wj-control-height)] w-full gap-2 px-4"
              >
                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                {lang === 'zh' ? '详细筛选' : '상세 필터'}
              </Button>
            </div>
          </div>

          {showAdvancedFilters && (
            <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-4">
            <span className="text-xs font-semibold text-gray-500">
              {lang === 'zh' ? '查询期间' : '조회 기간'}
            </span>
            <Button
              type="button"
              size="sm"
              variant={isAllDates ? 'primary' : 'secondary'}
              aria-pressed={isAllDates}
              onClick={() => applyDatePreset('all')}
            >
              {lang === 'zh' ? '全部期间' : '전체 기간'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={isRecent30Days ? 'primary' : 'secondary'}
              aria-pressed={isRecent30Days}
              onClick={() => applyDatePreset('recent30')}
            >
              {lang === 'zh' ? '最近 30 天' : '최근 30일'}
            </Button>
          </div>
          <div>
            <Label>{t('start_date')}</Label>
            {renderDateInput('from')}
          </div>
          <div>
            <Label>{t('end_date')}</Label>
            {renderDateInput('to')}
          </div>
          <div>
            <Label>{t('model')}</Label>
            <Autocomplete<ModelOption, false, false, true>
              options={modelOptions}
              freeSolo
              fullWidth
              size="small"
              value={selectedModelOption}
              inputValue={modelInputValue}
              onInputChange={(_, newInput) => {
                setModelInputValue(newInput);
                const trimmed = newInput.trim();
                const normalized = trimmed.toUpperCase();
                setFilters((prev) => {
                  const prevNormalized = (prev.model || '').trim().toUpperCase();
                  if (!trimmed) {
                    if (!prev.model && !prev.part_no && !prev.includeSimilar) return prev;
                    return { ...prev, model: '', part_no: '', includeSimilar: false };
                  }
                  if (normalized === prevNormalized) return prev;
                  const next = { ...prev, model: trimmed };
                  if (prev.part_no) {
                    next.part_no = '';
                    next.includeSimilar = false;
                  }
                  return next;
                });
                if (!trimmed) {
                  setSelectedModelOption(null);
                  setSelectedPartOption(null);
                  setPartInputValue('');
                } else if (
                  selectedModelOption &&
                  trimmed.toUpperCase() !== (selectedModelOption.model_code || '').toUpperCase()
                ) {
                  setSelectedModelOption(null);
                  setSelectedPartOption(null);
                  setPartInputValue('');
                }
                setPage(1);
              }}
              onChange={(_, newValue) => {
                if (typeof newValue === 'string') {
                  const trimmed = newValue.trim();
                  const normalized = trimmed.toUpperCase();
                  setSelectedModelOption(null);
                  setModelInputValue(trimmed);
                  setFilters((prev) => {
                    const prevNormalized = (prev.model || '').trim().toUpperCase();
                    if (!trimmed) {
                      if (!prev.model && !prev.part_no && !prev.includeSimilar) return prev;
                    }
                    const next = { ...prev, model: trimmed };
                    if (!trimmed) {
                      next.part_no = '';
                      next.includeSimilar = false;
                      setSelectedPartOption(null);
                      setPartInputValue('');
                    }
                    return normalized === prevNormalized && trimmed ? prev : next;
                  });
                  setPage(1);
                  return;
                }

                if (newValue) {
                  const modelCodeRaw = (newValue.model_code || '').trim();
                  const normalized = modelCodeRaw.toUpperCase();
                  setSelectedModelOption({
                    model_code: modelCodeRaw,
                    description: newValue.description || '',
                  });
                  setModelInputValue(modelCodeRaw);
                  setFilters((prev) => {
                    const prevNormalized = (prev.model || '').trim().toUpperCase();
                    const next = { ...prev, model: modelCodeRaw };
                    if (prev.part_no) {
                      next.part_no = '';
                    }
                    if (prev.includeSimilar) {
                      next.includeSimilar = false;
                    }
                    if (normalized === prevNormalized && !prev.part_no && !prev.includeSimilar) {
                      return prev;
                    }
                    return next;
                  });
                  setSelectedPartOption(null);
                  setPartInputValue('');
                  setPage(1);
                  return;
                }

                setSelectedModelOption(null);
                setModelInputValue('');
                setSelectedPartOption(null);
                setPartInputValue('');
                setFilters((prev) => {
                  if (!prev.model && !prev.part_no && !prev.includeSimilar) return prev;
                  return { ...prev, model: '', part_no: '', includeSimilar: false };
                });
                setPage(1);
              }}
              isOptionEqualToValue={(option, value) => {
                if (typeof option === 'string' || typeof value === 'string') return false;
                return option.model_code === value.model_code && (option.description || '') === (value.description || '');
              }}
              getOptionLabel={(option) => {
                if (typeof option === 'string') return option;
                return option.description ? `${option.model_code} – ${option.description}` : option.model_code;
              }}
              filterOptions={(options, state) => {
                const input = (state.inputValue || '').trim().toUpperCase();
                if (!input) return options;
                return options.filter(
                  (opt: string | ModelOption) => {
                    if (typeof opt === 'string') return opt.toUpperCase().includes(input);
                    return opt.model_code.toUpperCase().includes(input) ||
                      (opt.description || '').toUpperCase().includes(input);
                  }
                );
              }}
              renderOption={(props, option) => {
                const { key, ...rest } = props as any;
                if (typeof option === 'string') {
                  return (
                    <li key={key} {...rest}>
                      <span className="font-mono font-medium">{option}</span>
                    </li>
                  );
                }
                return (
                  <li key={key} {...rest}>
                    <div className="flex flex-col">
                      <span className="font-mono font-medium">{option.model_code}</span>
                      {option.description ? (
                        <span className="text-xs text-gray-500">{option.description}</span>
                      ) : null}
                    </div>
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  placeholder={t('model_search')}
                  sx={FILTER_AUTOCOMPLETE_SX}
                  InputProps={{
                    ...params.InputProps,
                    className: (params.InputProps.className || '') + ' text-sm',
                  }}
                />
              )}
              noOptionsText={t('no_data')}
              autoHighlight
              slotProps={{
                popper: {
                  sx: { zIndex: 2000 },
                },
              }}
            />
          </div>
          <div>
            <Label>{t('part_no')}</Label>
            <Autocomplete<PartOption, false, false, true>
              options={partOptions}
              freeSolo
              openOnFocus
              fullWidth
              size="small"
              value={selectedPartOption}
              inputValue={partInputValue}
              onInputChange={(_, newInput) => {
                setPartInputValue(newInput);
                const trimmed = newInput.trim();
                const normalized = trimmed.toUpperCase();
                setFilters((prev) => {
                  const prevNormalized = (prev.part_no || '').trim().toUpperCase();
                  if (!trimmed) {
                    if (!prev.part_no && !prev.includeSimilar) return prev;
                    return { ...prev, part_no: '', includeSimilar: false };
                  }
                  if (normalized === prevNormalized) return prev;
                  return { ...prev, part_no: trimmed };
                });
                if (!trimmed) {
                  setSelectedPartOption(null);
                } else if (
                  selectedPartOption &&
                  trimmed.toUpperCase() !== selectedPartOption.part_no.toUpperCase()
                ) {
                  setSelectedPartOption(null);
                }
                setPage(1);
              }}
              onChange={(_, newValue) => {
                if (typeof newValue === 'string') {
                  const trimmed = newValue.trim();
                  const normalized = trimmed.toUpperCase();
                  setSelectedPartOption(null);
                  setPartInputValue(trimmed);
                  setFilters((prev) => {
                    const prevNormalized = (prev.part_no || '').trim().toUpperCase();
                    if (!trimmed) {
                      if (!prev.part_no && !prev.includeSimilar) return prev;
                      return { ...prev, part_no: '', includeSimilar: false };
                    }
                    if (normalized === prevNormalized) return prev;
                    return { ...prev, part_no: trimmed };
                  });
                  setPage(1);
                  return;
                }

                if (newValue) {
                  const partNoRaw = (newValue.part_no || '').trim();
                  const normalizedPart = partNoRaw.toUpperCase();
                  const modelCodeRaw = (newValue.model_code || '').trim();
                  const normalizedModel = modelCodeRaw.toUpperCase();
                  setSelectedPartOption({
                    part_no: partNoRaw,
                    model_code: modelCodeRaw,
                    description: newValue.description || '',
                  });
                  setPartInputValue(partNoRaw);
                  setFilters((prev) => {
                    const prevNormalizedPart = (prev.part_no || '').trim().toUpperCase();
                    const prevNormalizedModel = (prev.model || '').trim().toUpperCase();
                    const trimmedPart = partNoRaw;
                    let changed = false;
                    const next = { ...prev };

                    if (trimmedPart && normalizedPart !== prevNormalizedPart) {
                      next.part_no = trimmedPart;
                      changed = true;
                    }
                    if (!trimmedPart && prev.part_no) {
                      next.part_no = '';
                      next.includeSimilar = false;
                      changed = true;
                    }
                    if (modelCodeRaw && normalizedModel !== prevNormalizedModel) {
                      next.model = modelCodeRaw;
                      changed = true;
                    }

                    return changed ? next : prev;
                  });

                  if (newValue.model_code) {
                    const match = modelOptions.find(
                      (opt) =>
                        (opt.model_code || '').trim() === modelCodeRaw &&
                        (opt.description || '') === (newValue.description || '')
                    );
                    const nextModel = match || {
                      model_code: modelCodeRaw,
                      description: newValue.description || '',
                    };
                    setSelectedModelOption(nextModel);
                    setModelInputValue(nextModel.model_code || '');
                  }
                  setPage(1);
                  return;
                }

                setSelectedPartOption(null);
                setPartInputValue('');
                setFilters((prev) => {
                  if (!prev.part_no && !prev.includeSimilar) return prev;
                  return { ...prev, part_no: '', includeSimilar: false };
                });
                setPage(1);
              }}
              isOptionEqualToValue={(option, value) => {
                if (typeof option === 'string' || typeof value === 'string') {
                  return option === value;
                }
                return option.part_no === value.part_no;
              }}
              getOptionLabel={(option) => (typeof option === 'string' ? option : option.part_no)}
              filterOptions={(options, state) => {
                let filtered = options.slice();

                // 모델이 지정된 경우 해당 모델의 part만 필터링
                if (hasActiveModel) {
                  filtered = filtered.filter((opt) => {
                    if (typeof opt === 'string') return true;
                    const optCode = (opt.model_code || '').toUpperCase();
                    if (!optCode) return true;
                    return optCode === normalizedActiveModelCode;
                  });
                }

                // 입력값으로 필터링
                const input = (state.inputValue || '').trim().toUpperCase();
                if (input) {
                  filtered = filtered.filter((opt) => {
                    const value = typeof opt === 'string' ? opt : (opt.part_no || '');
                    return value.toUpperCase().includes(input);
                  });
                }

                return filtered;
              }}
              renderOption={(props, option) => {
                const { key, ...rest } = props as any;
                if (typeof option === 'string') {
                  return (
                    <li key={key} {...rest}>
                      <span className="font-mono font-medium">{option}</span>
                    </li>
                  );
                }
                return (
                  <li key={key} {...rest}>
                    <div className="flex flex-col">
                      <span className="font-mono font-medium">{option.part_no}</span>
                      {(option.model_code || option.description) && (
                        <span className="text-xs text-gray-500">
                          {[option.model_code, option.description].filter(Boolean).join(' - ')}
                        </span>
                      )}
                    </div>
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  placeholder={t('quality.part_no_placeholder')}
                  sx={FILTER_AUTOCOMPLETE_SX}
                  InputProps={{
                    ...params.InputProps,
                    className: (params.InputProps.className || '') + ' text-sm',
                  }}
                />
              )}
              noOptionsText={t('no_data')}
              autoHighlight
              slotProps={{
                popper: {
                  sx: { zIndex: 2000 },
                },
              }}
            />
            <label
              className={`mt-2 inline-flex items-center gap-2 text-sm ${
                hasPartFilter ? 'text-gray-600' : 'text-gray-400 cursor-not-allowed'
              }`}
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                checked={filters.includeSimilar}
                disabled={!hasPartFilter}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setFilters((prev) => {
                    if (!prev.part_no.trim()) {
                      if (!prev.includeSimilar) return prev;
                      return { ...prev, includeSimilar: false };
                    }
                    if (prev.includeSimilar === checked) return prev;
                    return { ...prev, includeSimilar: checked };
                  });
                  setPage(1);
                }}
              />
              <span>{t('quality.show_similar_parts')}</span>
            </label>
          </div>
            </div>
          )}
        </section>
        <div ref={listTopRef} className="scroll-mt-24" aria-hidden="true" />
        {canEditQuality && (
          <div className={`sticky top-2 z-10 flex flex-col gap-2 rounded-xl border px-3 py-2.5 shadow-sm backdrop-blur sm:flex-row sm:items-center ${selectedVisibleCount > 0 ? 'border-rose-200 bg-rose-50/95' : 'border-slate-200 bg-white/95'}`}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm font-semibold text-slate-700 hover:bg-white">
                <input
                  ref={selectAllToolbarRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={visibleReportIds.length === 0 || reportMutationInFlight}
                  onChange={toggleVisibleReports}
                  className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>{lang === 'zh' ? '选择本页' : '현재 페이지 선택'}</span>
              </label>
              <p className="min-w-0 flex-1 truncate text-right text-sm text-slate-600 sm:text-left" aria-live="polite">
                {lang === 'zh'
                  ? `已选 ${selectedVisibleCount.toLocaleString()} / ${visibleReportIds.length.toLocaleString()} 条`
                  : `${selectedVisibleCount.toLocaleString()} / ${visibleReportIds.length.toLocaleString()}건 선택`}
              </p>
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={selectedVisibleCount === 0 || reportMutationInFlight}
                onClick={() => setSelectedReportIds(new Set())}
                className="min-w-0 text-slate-600"
              >
                {lang === 'zh' ? '取消选择' : '선택 해제'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={selectedVisibleCount === 0 || reportMutationInFlight}
                onClick={requestSelectedDelete}
                className="min-w-0 bg-rose-600 text-white hover:bg-rose-700 disabled:bg-slate-300"
              >
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {lang === 'zh' ? '删除所选' : '선택 삭제'}
              </Button>
            </div>
          </div>
        )}
        {/* 모바일 카드 목록 */}
        <div className="space-y-3 xl:hidden" aria-busy={isFetching}>
          {isLoading ? (
            <div className="rounded-xl border border-indigo-100 bg-white px-4 py-10 text-center text-sm text-gray-500">
              {t('loading')}...
            </div>
          ) : isError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-10 text-center text-sm text-red-600">
              {t('error_loading_data')}
            </div>
          ) : reports.length === 0 ? (
            <div className="rounded-xl border border-indigo-100 bg-white px-4 py-10 text-center text-sm text-gray-500">
              {t('no_data')}
            </div>
          ) : (
            reports.map((r: QualityReport) => {
              const isEditing = editingId === r.id;
              const currentValue = actionResults[r.id] !== undefined
                ? actionResults[r.id]
                : (r.action_result || '');
              const images = getReportImages(r);

              return (
                <article
                  key={r.id}
                  className={`min-w-0 overflow-hidden rounded-xl border bg-white shadow-sm transition ${selectedReportIds.has(r.id) ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-indigo-200'}`}
                >
                  <div className="flex items-start justify-between gap-3 border-b border-indigo-100 bg-gradient-to-r from-indigo-50 to-blue-50 px-4 py-3">
                    <div className="flex min-w-0 items-start gap-2">
                      {canEditQuality && (
                        <label className="-ml-2 -mt-1 inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg hover:bg-white/70">
                          <input
                            type="checkbox"
                            checked={selectedReportIds.has(r.id)}
                            disabled={reportMutationInFlight}
                            onChange={() => toggleReportSelection(r.id)}
                            aria-label={`${(r.report_dt || '').slice(0, 10)} ${r.section} ${r.part_no} ${lang === 'zh' ? '选择报告' : '보고서 선택'}`}
                            className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </label>
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-500">{t('date')}</p>
                        <p className="mt-0.5 text-sm font-semibold text-gray-900">
                          {(r.report_dt || '').slice(0, 10)}
                        </p>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                      r.judgement === 'OK'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-red-100 text-red-800'
                    }`}>
                      {r.judgement || '-'}
                    </span>
                  </div>

                  <div className="space-y-4 p-4">
                    <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3">
                      {[
                        [t('quality.section'), r.section],
                        [t('model'), r.model],
                        [t('part_no'), r.part_no],
                        [t('quality.lot_size'), r.lot_qty],
                        [t('quality.defect_rate'), r.defect_rate],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="min-w-0">
                          <dt className="text-xs font-medium text-gray-500">{label}</dt>
                          <dd className="mt-1 break-words text-sm font-medium text-gray-800">
                            {value ?? '-'}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    <div className="min-w-0 border-t border-gray-100 pt-3">
                      <p className="text-xs font-medium text-gray-500">{t('quality.defect_phenomenon')}</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-gray-900">
                        {r.phenomenon || '-'}
                      </p>
                    </div>

                    <div className="border-t border-gray-100 pt-3">
                      <p className="text-xs font-medium text-gray-500">{t('quality.image_upload')}</p>
                      {images.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedImages(images.map(resolveImageUrl));
                            setCurrentImageIndex(0);
                          }}
                          className="mt-2 flex min-h-14 w-full items-center gap-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2 text-left transition-colors hover:bg-indigo-50"
                          aria-label={`${t('quality.image_upload')} ${images.length}`}
                        >
                          <span className="relative shrink-0">
                            <img
                              src={resolveImageUrl(images[0])}
                              alt=""
                              className="h-12 w-12 rounded-md border border-indigo-200 object-cover"
                              onError={(event) => {
                                event.currentTarget.src = IMAGE_ERROR_PLACEHOLDER;
                              }}
                            />
                            {images.length > 1 && (
                              <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1 text-[11px] font-bold text-white">
                                {images.length}
                              </span>
                            )}
                          </span>
                          <span className="min-w-0 flex-1 text-sm font-medium text-indigo-700">
                            {t('quality.view_detail')}
                          </span>
                          <Eye className="h-5 w-5 shrink-0 text-indigo-600" aria-hidden="true" />
                        </button>
                      ) : (
                        <p className="mt-1 text-sm text-gray-400">-</p>
                      )}
                    </div>

                    <div className="border-t border-gray-100 pt-3">
                      <Label htmlFor={`mobile-action-result-${r.id}`} className="text-xs font-medium text-gray-500">
                        {t('quality.action_result')}
                      </Label>
                      {canEditQuality ? (
                        <Input
                          id={`mobile-action-result-${r.id}`}
                          value={currentValue}
                          onChange={(event) => {
                            setActionResults((previous) => ({ ...previous, [r.id]: event.target.value }));
                            if (!isEditing) setEditingId(r.id);
                          }}
                          placeholder={t('quality.action_result_placeholder')}
                          className="mt-2 h-11 w-full min-w-0 text-base"
                        />
                      ) : (
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">
                          {currentValue || '-'}
                        </p>
                      )}
                      {canEditQuality && isEditing && (
                        <Button
                          size="sm"
                          onClick={() => handleSaveActionResult(r.id)}
                          disabled={savingId === r.id}
                          className="mt-2 w-full bg-indigo-600 text-white hover:bg-indigo-700"
                        >
                          <Save className={`mr-2 h-4 w-4 ${savingId === r.id ? 'animate-pulse' : ''}`} />
                          {savingId === r.id ? t('saving') : t('quality.save_action')}
                        </Button>
                      )}
                    </div>

                    <div className={`grid gap-2 border-t border-gray-100 pt-3 ${canEditQuality ? 'grid-cols-2' : 'grid-cols-1'}`}>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setSelectedReport(r)}
                        className="min-w-0"
                      >
                        <Eye className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{t('quality.view_detail')}</span>
                      </Button>
                      {canEditQuality && (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => handleDeleteReport(r.id)}
                          disabled={reportMutationInFlight}
                          className="min-w-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                        >
                          <Trash2 className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="truncate">{t('quality.delete_report')}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>

        {/* 데스크톱 테이블 */}
        <div className="hidden overflow-x-auto rounded-lg border border-indigo-200 shadow-sm xl:block" aria-busy={isFetching}>
          <table className="w-full min-w-[1230px] table-fixed text-sm">
            <thead className="bg-gradient-to-r from-indigo-50 to-blue-50 whitespace-nowrap">
              <tr className="border-b border-indigo-200">
                {canEditQuality && (
                  <th className="w-12 px-2 py-3 text-center">
                    <input
                      ref={selectAllTableRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={visibleReportIds.length === 0 || isDeleting}
                      onChange={toggleVisibleReports}
                      aria-label={lang === 'zh' ? '选择当前页全部报告' : '현재 페이지 보고서 전체 선택'}
                      className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                )}
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('date')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.section')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('model')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('part_no')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.lot_size')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.defect_rate')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.judgement')}</th>
                <th className="px-2 py-3 text-center font-semibold text-gray-700 w-[140px]">{t('quality.defect_phenomenon')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.image_upload')}</th>
                <th className="px-2 py-3 text-center font-semibold text-gray-700 w-[144px]">{t('quality.action_result')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-100 bg-white">
              {isLoading ? (
                <tr><td colSpan={canEditQuality ? 12 : 11} className="text-center py-10 text-gray-500">{t('loading')}...</td></tr>
              ) : isError ? (
                <tr><td colSpan={canEditQuality ? 12 : 11} className="text-center py-10 text-red-500">{t('error_loading_data')}</td></tr>
              ) : reports.length === 0 ? (
                <tr><td colSpan={canEditQuality ? 12 : 11} className="text-center py-10 text-gray-500">{t('no_data')}</td></tr>
              ) : (
                reports.map((r: QualityReport) => {
                  const isEditing = editingId === r.id;
                  const currentValue = actionResults[r.id] !== undefined ? actionResults[r.id] : (r.action_result || '');
                  
                  return (
                    <tr key={r.id} className={`transition-colors duration-150 ${selectedReportIds.has(r.id) ? 'bg-indigo-50' : 'hover:bg-indigo-50/50'}`}>
                      {canEditQuality && (
                        <td className="px-2 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={selectedReportIds.has(r.id)}
                            disabled={reportMutationInFlight}
                            onChange={() => toggleReportSelection(r.id)}
                            aria-label={`${(r.report_dt || '').slice(0, 10)} ${r.section} ${r.part_no} ${lang === 'zh' ? '选择报告' : '보고서 선택'}`}
                            className="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>
                      )}
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{(r.report_dt || '').slice(0, 10)}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.section}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.model}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.part_no}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.lot_qty}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.defect_rate}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.judgement}</td>
                      <td className="px-2 py-3 text-center text-gray-700">
                        <div className="mx-auto max-w-[140px] truncate text-center" title={r.phenomenon || '-'}>
                          {r.phenomenon || '-'}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-center">
                        {(() => {
                          const images = getReportImages(r);
                          if (images.length === 0) {
                            return <span className="text-gray-400 text-xs">-</span>;
                          }
                          
                          return (
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => {
                                  setSelectedImages(images.map(resolveImageUrl));
                                  setCurrentImageIndex(0);
                                }}
                                className="relative"
                              >
                                <img
                                  src={resolveImageUrl(images[0])}
                                  alt="Thumbnail"
                                  className="w-12 h-12 object-cover rounded border border-indigo-200 hover:border-indigo-400 transition-all cursor-pointer"
                                  onError={(e) => {
                                    console.error('Image load error:', images[0]);
                                    e.currentTarget.src = IMAGE_ERROR_PLACEHOLDER;
                                  }}
                                />
                                {images.length > 1 && (
                                  <span className="absolute -top-1 -right-1 bg-indigo-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                                    {images.length}
                                  </span>
                                )}
                              </button>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 w-[144px] align-top">
                        <div className="flex flex-col gap-1">
                          {canEditQuality ? (
                            <Input
                              value={currentValue}
                              onChange={(e) => {
                                setActionResults(prev => ({ ...prev, [r.id]: e.target.value }));
                                if (!isEditing) setEditingId(r.id);
                              }}
                              placeholder={t('quality.action_result_placeholder')}
                              className="text-sm w-full min-w-0"
                            />
                          ) : (
                            <p className="whitespace-pre-wrap break-words text-sm leading-5 text-gray-700">
                              {currentValue || '-'}
                            </p>
                          )}
                          {canEditQuality && isEditing && (
                            <Button
                              size="sm"
                              onClick={() => handleSaveActionResult(r.id)}
                              disabled={savingId === r.id}
                              className="bg-indigo-600 hover:bg-indigo-700 text-white whitespace-nowrap px-2 text-xs"
                            >
                              {savingId === r.id ? (
                                <span className="flex items-center gap-1">
                                  <Save className="w-3 h-3 animate-pulse" />
                                  {t('saving')}
                                </span>
                              ) : (
                                <span className="flex items-center gap-1">
                                  <Save className="w-3 h-3" />
                                  {t('quality.save_action')}
                                </span>
                              )}
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => setSelectedReport(r)}
                            className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                            title={t('quality.view_detail')}
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {canEditQuality && (
                            <button
                              onClick={() => handleDeleteReport(r.id)}
                              className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title={t('quality.delete_report')}
                              disabled={reportMutationInFlight}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {/* 페이지네이션 */}
        <nav
          aria-label={lang === 'zh' ? '报告列表分页' : '보고 이력 페이지 이동'}
          className="flex flex-nowrap items-center justify-between gap-3 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/80 px-2.5 py-2 sm:px-3"
        >
          <p className="shrink-0 whitespace-nowrap text-xs font-medium text-slate-600">
            <strong className="font-semibold text-slate-900">{totalCount.toLocaleString()}</strong>
            {lang === 'zh' ? ' 条结果' : '건의 결과'}
          </p>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => navigateToPage(page - 1)}
              disabled={page <= 1 || isFetching}
              aria-label={t('quality.prev_page')}
              className="!h-[42px] !min-h-[42px] gap-1 px-2.5"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{lang === 'zh' ? '上一页' : '이전'}</span>
            </Button>

            <span
              className="min-w-[72px] whitespace-nowrap rounded-lg bg-white px-2.5 py-2 text-center text-sm font-semibold text-slate-800 ring-1 ring-slate-200"
              aria-live="polite"
            >
              {page} <span className="font-normal text-slate-400">/</span> {totalPages}
            </span>

            {totalPages > 1 && (
              <div className="hidden items-center gap-1.5 md:flex">
                <label htmlFor="quality-history-page-input" className="text-xs font-medium text-slate-500">
                  {lang === 'zh' ? '页码' : '페이지'}
                </label>
                <div className="w-16 shrink-0">
                  <Input
                    id="quality-history-page-input"
                    type="number"
                    min={1}
                    max={totalPages}
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handlePageJump();
                      }
                    }}
                    aria-label={lang === 'zh' ? '输入要跳转的页码' : '이동할 페이지 번호'}
                    className="!h-[42px] !min-h-[42px] py-1 text-center"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handlePageJump}
                  disabled={isFetching}
                  className="!h-[42px] !min-h-[42px] px-2.5"
                >
                  {lang === 'zh' ? '跳转' : '이동'}
                </Button>
              </div>
            )}

            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => navigateToPage(page + 1)}
              disabled={page >= totalPages || isFetching}
              aria-label={t('quality.next_page')}
              className="!h-[42px] !min-h-[42px] gap-1 px-2.5"
            >
              <span className="hidden sm:inline">{lang === 'zh' ? '下一页' : '다음'}</span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </nav>
      </div>

      {/* 이미지 모달 (다중 이미지 지원) */}
      {selectedImages.length > 0 && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-[70] p-4"
          onClick={() => {
            setSelectedImages([]);
            setCurrentImageIndex(0);
          }}
        >
          <div className="relative max-w-5xl max-h-[90vh] w-full">
            {/* 닫기 버튼 */}
            <button
              onClick={() => {
                setSelectedImages([]);
                setCurrentImageIndex(0);
              }}
              className="absolute -top-12 right-0 text-white hover:text-gray-300 transition-colors z-10"
            >
              <X className="w-8 h-8" />
            </button>

            {/* 이미지 카운터 */}
            {selectedImages.length > 1 && (
              <div className="absolute -top-12 left-1/2 transform -translate-x-1/2 text-white text-sm">
                {currentImageIndex + 1} / {selectedImages.length}
              </div>
            )}

            {/* 이미지 컨테이너 */}
            <div className="relative">
              <img
                src={selectedImages[currentImageIndex]}
                alt={`Image ${currentImageIndex + 1}`}
                className="w-full h-full max-h-[85vh] object-contain rounded-lg"
                onClick={(e) => e.stopPropagation()}
              />

              {/* 이전 버튼 */}
              {selectedImages.length > 1 && currentImageIndex > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex(prev => prev - 1);
                  }}
                  className="absolute left-4 top-1/2 transform -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full p-3 transition-all"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
              )}

              {/* 다음 버튼 */}
              {selectedImages.length > 1 && currentImageIndex < selectedImages.length - 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex(prev => prev + 1);
                  }}
                  className="absolute right-4 top-1/2 transform -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full p-3 transition-all"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              )}
            </div>

            {/* 썸네일 네비게이션 */}
            {selectedImages.length > 1 && (
              <div className="flex justify-center gap-2 mt-4">
                {selectedImages.map((img, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentImageIndex(idx);
                    }}
                    className={`w-16 h-16 rounded border-2 overflow-hidden transition-all ${
                      idx === currentImageIndex
                        ? 'border-indigo-500 scale-110'
                        : 'border-gray-400 opacity-60 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={img}
                      alt={`Thumbnail ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 상세보기 모달 */}
      {selectedReport && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedReport(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 헤더 */}
            <div className="sticky top-0 bg-gradient-to-r from-indigo-600 to-blue-600 text-white px-6 py-4 flex items-center justify-between rounded-t-lg">
              <h3 className="text-lg font-semibold">{t('quality.detail_title')}</h3>
              <button
                onClick={() => setSelectedReport(null)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* 내용 */}
            <div className="p-6 space-y-6">
              {/* 기본 정보 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.report_datetime')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.report_dt.replace('T', ' ').slice(0, 16)}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.section')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.section}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('model')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.model}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('part_no')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.part_no}
                  </div>
                </div>
              </div>

              {/* 수량 정보 */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.lot_size')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.lot_qty || '-'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.inspection_qty')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {(selectedReport as any).inspection_qty || '-'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.defect_qty')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {(selectedReport as any).defect_qty || '-'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.defect_rate')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.defect_rate}
                  </div>
                </div>
              </div>

              {/* 판정 결과 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('quality.judgement')}
                </label>
                <div className={`inline-block px-4 py-2 rounded-full font-semibold ${
                  selectedReport.judgement === 'OK' 
                    ? 'bg-green-100 text-green-800' 
                    : 'bg-red-100 text-red-800'
                }`}>
                  {selectedReport.judgement}
                </div>
              </div>

              {/* 불량 현상 */}
              {(selectedReport as any).phenomenon && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.defect_phenomenon')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border whitespace-pre-wrap">
                    {(selectedReport as any).phenomenon}
                  </div>
                </div>
              )}

              {/* 처리 방식 */}
              {(selectedReport as any).disposition && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.disposition')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border whitespace-pre-wrap">
                    {(selectedReport as any).disposition}
                  </div>
                </div>
              )}

              {/* 처리 결과 */}
              {selectedReport.action_result && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.action_result')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border whitespace-pre-wrap">
                    {selectedReport.action_result}
                  </div>
                </div>
              )}

              {/* 이미지 */}
              {(() => {
                const images = getReportImages(selectedReport);
                if (images.length === 0) return null;
                
                return (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('quality.image_upload')}
                    </label>
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
                      {images.map((img, idx) => (
                        <div key={idx} className="relative group">
                          <img
                            src={resolveImageUrl(img)}
                            alt={`Image ${idx + 1}`}
                            className="w-full h-48 object-cover rounded-lg border-2 border-gray-200 cursor-pointer hover:border-indigo-400 transition-all"
                            onClick={() => {
                              setSelectedImages(images.map(resolveImageUrl));
                              setCurrentImageIndex(idx);
                            }}
                            onError={(e) => {
                              console.error('Image load error:', img);
                              e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23ddd" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999" font-size="20"%3EImage Error%3C/text%3E%3C/svg%3E';
                            }}
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all rounded-lg flex items-center justify-center">
                            <Eye className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* 푸터 - 액션 버튼 */}
            <div className="sticky bottom-0 bg-gray-50 px-6 py-4 flex items-center justify-end gap-3 rounded-b-lg border-t">
              <Button
                variant="secondary"
                onClick={() => setSelectedReport(null)}
              >
                {t('close')}
              </Button>
              {canEditQuality && (
                <Button
                  variant="danger"
                  onClick={() => handleDeleteReport(selectedReport.id)}
                  disabled={reportMutationInFlight}
                  className="bg-red-600 hover:bg-red-700 text-white"
                >
                  {isDeleting ? (
                    <span className="flex items-center gap-2">
                      <Trash2 className="w-4 h-4 animate-pulse" />
                      {t('deleting')}...
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Trash2 className="w-4 h-4" />
                      {t('quality.delete_report')}
                    </span>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={pendingDeleteIds !== null}
        onClose={() => {
          if (!isDeleting) setPendingDeleteIds(null);
        }}
        className="relative z-[90]"
      >
        <DialogBackdrop className="fixed inset-0 bg-slate-950/55 backdrop-blur-sm" />
        <div className="fixed inset-0 overflow-y-auto p-4 sm:p-6">
          <div className="flex min-h-full items-center justify-center">
            <DialogPanel className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-rose-100 p-2.5 text-rose-700">
                  <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-lg font-bold text-slate-950">
                    {lang === 'zh' ? '删除所选报告' : '선택한 보고서 삭제'}
                  </DialogTitle>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {lang === 'zh'
                      ? `将永久删除所选 ${pendingDeleteIds?.length || 0} 条报告。此操作无法撤销。`
                      : `선택한 보고서 ${pendingDeleteIds?.length || 0}건을 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
                  </p>
                  <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
                    {lang === 'zh'
                      ? '为避免影响共享图片，Cloudinary 原始文件会保留。'
                      : '공유 사진 손상을 막기 위해 Cloudinary 원본 파일은 보존합니다.'}
                  </p>
                </div>
              </div>
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={isDeleting}
                  onClick={() => setPendingDeleteIds(null)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  type="button"
                  autoFocus
                  variant="danger"
                  disabled={reportMutationInFlight}
                  onClick={() => void confirmReportDelete()}
                  className="bg-rose-600 text-white hover:bg-rose-700 disabled:cursor-wait disabled:opacity-60"
                >
                  <Trash2 className={`mr-2 h-4 w-4 ${isDeleting ? 'animate-pulse' : ''}`} aria-hidden="true" />
                  {isDeleting
                    ? (lang === 'zh' ? '正在删除…' : '삭제 중…')
                    : (lang === 'zh' ? '确认删除' : '삭제 확인')}
                </Button>
              </div>
            </DialogPanel>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
