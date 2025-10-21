import { FolderOpen, Save, X, ChevronLeft, ChevronRight, Eye, Trash2 } from 'lucide-react';
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

export default function QualityReportHistory() {
  const { t, lang } = useLang();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(() => {
    const defaultTo = dayjs().format('YYYY-MM-DD');
    const defaultFrom = dayjs().subtract(29, 'day').format('YYYY-MM-DD');
    return {
      dateFrom: defaultFrom,
      dateTo: defaultTo,
      model: '',
      part_no: '',
      includeSimilar: false,
    };
  });
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [editingId, setEditingId] = useState<number | null>(null);
  const [actionResults, setActionResults] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [selectedReport, setSelectedReport] = useState<QualityReport | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [modelInputValue, setModelInputValue] = useState('');
  const [partInputValue, setPartInputValue] = useState('');
  const [selectedModelOption, setSelectedModelOption] = useState<ModelOption | null>(null);
  const [selectedPartOption, setSelectedPartOption] = useState<PartOption | null>(null);
  const dateInputLang = lang === 'zh' ? 'zh-CN' : 'ko-KR';
  const datePlaceholder = lang === 'zh' ? '年-月-日' : '년-월-일';
  const dateInputClassName = 'text-center placeholder:text-center cursor-pointer';
  const [openCalendar, setOpenCalendar] = useState<'from' | 'to' | null>(null);
  const fromFieldRef = useRef<HTMLDivElement | null>(null);
  const toFieldRef = useRef<HTMLDivElement | null>(null);
  const dateLocale = lang === 'zh' ? zhCN : ko;
  const hasPartFilter = filters.part_no.trim().length > 0;
  const modelQuery = modelInputValue.trim();
  const partQuery = partInputValue.trim();
  const activeModelCodeRaw = (selectedModelOption?.model_code || filters.model || '').trim();
  const normalizedActiveModelCode = activeModelCodeRaw.toUpperCase();
  const hasActiveModel = normalizedActiveModelCode.length > 0;

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
    const [currentMonth, setCurrentMonth] = useState(selectedDate || dayjs().toDate());
    
    const handleSelect = (date: Date | undefined) => {
      const formatted = date ? dayjs(date).format('YYYY-MM-DD') : '';
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
  const { data, isLoading, isError } = useQuery({
    queryKey: ['quality-reports', filters, page, pageSize],
    queryFn: async () => {
      const params: Record<string, any> = {
        page,
        page_size: pageSize,
        report_dt_after: filters.dateFrom || undefined,
        report_dt_before: filters.dateTo || undefined,
      };

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

      const { data } = await api.get('/quality/reports/', {
        params,
      });
      return data;
    },
    placeholderData: (previousData) => previousData,
  });

  const reports = data?.results || [];
  const totalCount = data?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const handleSaveActionResult = async (reportId: number) => {
    const actionResult = actionResults[reportId] || '';
    setSavingId(reportId);
    try {
      await api.patch(`/quality/reports/${reportId}/`, {
        action_result: actionResult
      });
      toast.success(t('save_success'));
      queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      setEditingId(null);
    } catch (err) {
      toast.error(t('save_fail'));
    } finally {
      setSavingId(null);
    }
  };

  const handleDeleteReport = async (reportId: number) => {
    if (!window.confirm(t('quality.confirm_delete'))) {
      return;
    }
    
    setIsDeleting(true);
    try {
      await api.delete(`/quality/reports/${reportId}/`);
      toast.success(t('delete_success'));
      queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      setSelectedReport(null);
    } catch (err) {
      toast.error(t('delete_fail'));
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
        {/* 필터 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
        {/* 테이블 */}
        <div className="overflow-x-auto border border-indigo-200 rounded-lg shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gradient-to-r from-indigo-50 to-blue-50 whitespace-nowrap">
              <tr className="border-b border-indigo-200">
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('date')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.section')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('model')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('part_no')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.lot_size')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.defect_rate')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.judgement')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.image_upload')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700 min-w-[250px]">{t('quality.action_result')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-100 bg-white">
              {isLoading ? (
                <tr><td colSpan={10} className="text-center py-10 text-gray-500">{t('loading')}...</td></tr>
              ) : isError ? (
                <tr><td colSpan={10} className="text-center py-10 text-red-500">{t('error_loading_data')}</td></tr>
              ) : reports.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-10 text-gray-500">{t('no_data')}</td></tr>
              ) : (
                reports.map((r: QualityReport) => {
                  const isEditing = editingId === r.id;
                  const currentValue = actionResults[r.id] !== undefined ? actionResults[r.id] : (r.action_result || '');
                  
                  return (
                    <tr key={r.id} className="hover:bg-indigo-50/50 transition-colors duration-150">
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{(r.report_dt || '').replace('T', ' ').slice(0, 16)}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.section}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.model}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.part_no}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.lot_qty}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.defect_rate}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.judgement}</td>
                      <td className="px-3 py-3 text-center">
                        {(() => {
                          const images = [r.image1, r.image2, r.image3].filter(Boolean) as string[];
                          if (images.length === 0) {
                            return <span className="text-gray-400 text-xs">-</span>;
                          }
                          
                          // 이미지 URL 처리 (Cloudinary는 절대 URL 반환)
                          const getImageUrl = (url: string) => {
                            // 이미 절대 URL인 경우 (Cloudinary)
                            if (url.startsWith('http://') || url.startsWith('https://')) {
                              return url;
                            }
                            // 상대 경로인 경우 (로컬 개발 또는 기존 이미지)
                            // API 베이스 URL 사용 (프록시를 통해 백엔드로 전달)
                            const apiBase = import.meta.env.VITE_API_BASE_URL || '';
                            // /media로 시작하는 경우 백엔드 서버 URL 사용
                            if (url.startsWith('/media')) {
                              // 개발 환경: localhost:8000, 프로덕션: API 서버
                              const backendUrl = apiBase || 'http://localhost:8000';
                              return `${backendUrl}${url}`;
                            }
                            return `${apiBase}${url.startsWith('/') ? url : '/' + url}`;
                          };
                          
                          return (
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => {
                                  setSelectedImages(images.map(getImageUrl));
                                  setCurrentImageIndex(0);
                                }}
                                className="relative"
                              >
                                <img
                                  src={getImageUrl(images[0])}
                                  alt="Thumbnail"
                                  className="w-12 h-12 object-cover rounded border border-indigo-200 hover:border-indigo-400 transition-all cursor-pointer"
                                  onError={(e) => {
                                    console.error('Image load error:', images[0]);
                                    e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect fill="%23ddd" width="48" height="48"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999"%3E?%3C/text%3E%3C/svg%3E';
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
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Input
                            value={currentValue}
                            onChange={(e) => {
                              setActionResults(prev => ({ ...prev, [r.id]: e.target.value }));
                              if (!isEditing) setEditingId(r.id);
                            }}
                            placeholder={t('quality.action_result_placeholder')}
                            className="text-sm min-w-[200px]"
                          />
                          {isEditing && (
                            <Button
                              size="sm"
                              onClick={() => handleSaveActionResult(r.id)}
                              disabled={savingId === r.id}
                              className="bg-indigo-600 hover:bg-indigo-700 text-white whitespace-nowrap"
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
                          <button
                            onClick={() => handleDeleteReport(r.id)}
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title={t('quality.delete_report')}
                            disabled={isDeleting}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
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
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>{t('quality.prev_page')}</Button>
          <span className="text-xs text-gray-500">{page} / {totalPages}</span>
          <Button type="button" variant="secondary" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>{t('quality.next_page')}</Button>
        </div>
      </div>

      {/* 이미지 모달 (다중 이미지 지원) */}
      {selectedImages.length > 0 && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4"
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
                const images = [selectedReport.image1, selectedReport.image2, selectedReport.image3].filter(Boolean) as string[];
                if (images.length === 0) return null;
                
                // 이미지 URL 처리 (Cloudinary는 절대 URL 반환)
                const getImageUrl = (url: string) => {
                  // 이미 절대 URL인 경우 (Cloudinary)
                  if (url.startsWith('http://') || url.startsWith('https://')) {
                    return url;
                  }
                  // 상대 경로인 경우 (로컬 개발 또는 기존 이미지)
                  // API 베이스 URL 사용 (프록시를 통해 백엔드로 전달)
                  const apiBase = import.meta.env.VITE_API_BASE_URL || '';
                  // /media로 시작하는 경우 백엔드 서버 URL 사용
                  if (url.startsWith('/media')) {
                    // 개발 환경: localhost:8000, 프로덕션: API 서버
                    const backendUrl = apiBase || 'http://localhost:8000';
                    return `${backendUrl}${url}`;
                  }
                  return `${apiBase}${url.startsWith('/') ? url : '/' + url}`;
                };
                
                return (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('quality.image_upload')}
                    </label>
                    <div className="grid grid-cols-3 gap-4">
                      {images.map((img, idx) => (
                        <div key={idx} className="relative group">
                          <img
                            src={getImageUrl(img)}
                            alt={`Image ${idx + 1}`}
                            className="w-full h-48 object-cover rounded-lg border-2 border-gray-200 cursor-pointer hover:border-indigo-400 transition-all"
                            onClick={() => {
                              setSelectedImages(images.map(getImageUrl));
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
              <Button
                variant="danger"
                onClick={() => handleDeleteReport(selectedReport.id)}
                disabled={isDeleting}
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
