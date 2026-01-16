import React, { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import PermissionButton from './common/PermissionButton';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Autocomplete, TextField } from '@mui/material';
import type { AssemblyReport } from '../types/assembly';
import { DefectTypeInput } from '@/components/assembly/DefectTypeInput';
import type { DefectEntry } from '@/components/assembly/DefectTypeInput';
import { useLocalDefectHistory } from '../hooks/useDefectHistory';
import { useLang } from '../i18n';
import { usePartSpecSearch, usePartListByModel } from '../hooks/usePartSpecs';
import { useAssemblyPartsByModel, useAssemblyPartspecsByModel, useAssemblyPartNoSearch } from '../hooks/useAssemblyParts';
import type { PartSpec } from '../hooks/usePartSpecs';
import { Plus, PlusCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

interface AssemblyReportFormProps {
  onSubmit: (data: Omit<AssemblyReport, 'id'>) => void | Promise<any>;
  initialData?: AssemblyReport;
  isLoading?: boolean;
}

export default function AssemblyReportForm({ onSubmit, isLoading, initialData, compact }: AssemblyReportFormProps & { compact?: boolean }) {
  const { t, lang } = useLang();
  const queryClient = useQueryClient();
  const [productQuery, setProductQuery] = useState('');
  const [selectedModelDesc, setSelectedModelDesc] = useState<PartSpec | null>(null);
  const [selectedPartSpec, setSelectedPartSpec] = useState<PartSpec | null>(null);
  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [, setPrefillSimilar] = useState<Partial<PartSpec> | null>(null);

  // 새로운 동적 불량 관리 상태
  const [processingDefects, setProcessingDefects] = useState<DefectEntry[]>([]);
  const [outsourcingDefects, setOutsourcingDefects] = useState<DefectEntry[]>([]);

  // 불량 히스토리 관리
  const { processingDefectHistory, outsourcingDefectHistory, recordDefectTypeUsage, deleteDefectType } = useLocalDefectHistory();
  // 불량 상세 입력 (집계용)
  const incomingDefectItems = React.useMemo(() => [
    { key: 'scratch', label: t('defect_scratch') },
    { key: 'black_dot', label: t('defect_black_dot') },
    { key: 'eaten_meat', label: t('defect_eaten_meat') },
    { key: 'air_mark', label: t('defect_air_mark') },
    { key: 'deform', label: t('defect_deform') },
    { key: 'short_shot', label: t('defect_short_shot') },
    { key: 'broken_pillar', label: t('defect_broken_pillar') },
    { key: 'flow_mark', label: t('defect_flow_mark') },
    { key: 'sink_mark', label: t('defect_sink_mark') },
    { key: 'whitening', label: t('defect_whitening') },
    { key: 'other', label: t('defect_other') },
  ], [t]);
  const [incomingDefectsDetail, setIncomingDefectsDetail] = useState<Record<string, number | ''>>(() => {
    const init: Record<string, number | ''> = {};
    incomingDefectItems.forEach(it => (init[it.key] = ''));
    return init;
  });
  const [incomingOpen, setIncomingOpen] = useState(true);
  const [newPartForm, setNewPartForm] = useState<any>({
    part_no: '',
    model_code: '',
    description: '',
    mold_type: '',
    color: '',
    resin_type: '',
    resin_code: '',
    net_weight_g: '',
    sr_weight_g: '',
    cycle_time_sec: '',
    cavity: '',
    valid_from: ''
  });
  const [prefillOriginal, setPrefillOriginal] = useState<any | null>(null);
  const { data: searchResults = [] } = usePartSpecSearch(productQuery.toUpperCase());
  const { data: modelParts = [] } = usePartListByModel(selectedModelDesc?.model_code);
  const { data: asmPartsByModel = [] } = useAssemblyPartsByModel(selectedModelDesc?.model_code);
  const { data: asmPartspecsByModel = [] } = useAssemblyPartspecsByModel(selectedModelDesc?.model_code);
  const { data: asmPartNoSearch = [] } = useAssemblyPartNoSearch(productQuery || '');


  const uniqueModelDesc = React.useMemo(() => {
    const map = new Map<string, PartSpec>();
    searchResults.forEach((it) => {
      const key = `${it.model_code}|${it.description}`;
      if (!map.has(key)) map.set(key, it);
    });
    return Array.from(map.values());
  }, [searchResults]);

  const [formData, setFormData] = useState({
    date: initialData?.date || format(new Date(), 'yyyy-MM-dd'),
    line_no: initialData?.line_no || '',
    part_no: initialData?.part_no || '',
    model: initialData?.model || '',
    supply_type: (initialData as any)?.supply_type || 'JIT',
    plan_qty: initialData ? (initialData?.plan_qty ?? 0) : '',
    input_qty: initialData ? ((initialData as any)?.input_qty ?? 0) : '',
    actual_qty: initialData ? (initialData?.actual_qty ?? 0) : '',
    rework_qty: initialData ? ((initialData as any)?.rework_qty ?? 0) : '',
    injection_defect: initialData ? (initialData?.injection_defect ?? 0) : '',
    outsourcing_defect: initialData ? (initialData?.outsourcing_defect ?? 0) : '',
    processing_defect: initialData ? (initialData?.processing_defect ?? 0) : '',
    total_time: initialData ? (initialData?.total_time ?? 0) : '',
    idle_time: initialData ? (initialData?.idle_time ?? 0) : '',
    operation_time: initialData ? (initialData?.operation_time ?? 0) : '',
    workers: initialData ? ((initialData as any)?.workers ?? 1) : '',
    note: initialData?.note || '',
  });

  React.useEffect(() => {
    if (!initialData) return;
    setFormData({
      date: initialData?.date || format(new Date(), 'yyyy-MM-dd'),
      line_no: initialData?.line_no || '',
      part_no: initialData?.part_no || '',
      model: initialData?.model || '',
      supply_type: (initialData as any)?.supply_type || 'JIT',
      plan_qty: initialData?.plan_qty ?? 0,
      input_qty: (initialData as any)?.input_qty ?? 0,
      actual_qty: initialData?.actual_qty ?? 0,
      rework_qty: (initialData as any)?.rework_qty ?? 0,
      injection_defect: initialData?.injection_defect ?? 0,
      outsourcing_defect: initialData?.outsourcing_defect ?? 0,
      processing_defect: initialData?.processing_defect ?? 0,
      total_time: initialData?.total_time ?? 0,
      idle_time: initialData?.idle_time ?? 0,
      operation_time: initialData?.operation_time ?? Math.max(0, (initialData?.total_time ?? 0) - (initialData?.idle_time ?? 0)),
      workers: (initialData as any)?.workers ?? 1,
      note: initialData?.note || '',
    });
    // 모델/Part select 초기 표시를 위해 선택값 설정
    const mdl = (initialData as any)?.model || '';
    const pno = (initialData as any)?.part_no || '';
    if (mdl) {
      setProductQuery(mdl);
      setSelectedModelDesc({ id: -9999, part_no: '', model_code: mdl, description: (initialData as any)?.description || mdl } as any);
    }
    if (pno) {
      setSelectedPartSpec({ id: -9999, part_no: pno, model_code: mdl, description: (initialData as any)?.description || '' } as any);
    }
    // 편집 진입 시, 상세 불량 표기를 집계값으로 프리필(사용자 입력 없을 때만)
    // 상세 불량: 서버에 저장된 detail이 있다면 그대로 로드
    try {
      const inc = (initialData as any)?.incoming_defects_detail;
      if (inc && typeof inc === 'object') {
        const next: Record<string, number | ''> = {};
        incomingDefectItems.forEach(it => {
          const v = inc[it.key];
          next[it.key] = (v === '' || v === null || v === undefined) ? '' : (Number(v) || 0);
        });
        setIncomingDefectsDetail(next);
      }
      // 동적 불량 데이터 로드
      if ((initialData as any).processing_defects_dynamic && Array.isArray((initialData as any).processing_defects_dynamic)) {
        setProcessingDefects((initialData as any).processing_defects_dynamic);
      }
      if ((initialData as any).outsourcing_defects_dynamic && Array.isArray((initialData as any).outsourcing_defects_dynamic)) {
        setOutsourcingDefects((initialData as any).outsourcing_defects_dynamic);
      }
    } catch (_) { }
  }, [initialData, incomingDefectItems]);

  // 새로운 동적 불량 관리로 인한 총합 계산
  const totalProcessingDefects = React.useMemo(() =>
    processingDefects.reduce((sum, defect) => sum + defect.quantity, 0),
    [processingDefects]
  );
  const totalOutsourcingDefects = React.useMemo(() =>
    outsourcingDefects.reduce((sum, defect) => sum + defect.quantity, 0),
    [outsourcingDefects]
  );

  const totalIncoming = React.useMemo(
    () => Object.values(incomingDefectsDetail).reduce<number>((a, b) => a + (b === '' ? 0 : (Number(b) || 0)), 0),
    [incomingDefectsDetail]
  );

  // 자동 계산 로직
  const calculatedValues = React.useMemo(() => {
    const inj = totalIncoming;
    const out = totalOutsourcingDefects;
    const proc = totalProcessingDefects;
    const totalDefects = inj + out + proc;
    const incomingDefects = inj; // 이제 사출불량만 집계
    const op = Number(formData.operation_time) || 0;
    const idle = Number(formData.idle_time) || 0;
    const total = op + idle; // 총시간 = 작업시간 + 부동시간
    const actualOperationTime = op; // 작업시간은 직접 입력

    // UPH = 생산수량 / 작업시간(시간)
    const act = Number(formData.actual_qty) || 0;
    const uph = actualOperationTime > 0 ? Math.round((act / (actualOperationTime / 60)) * 100) / 100 : 0;

    // UPPH = 생산수량 / (작업시간(시간) × 작업인원)
    const workers = Number(formData.workers) || 0;
    const upph = (actualOperationTime > 0 && workers > 0) ?
      Math.round((act / ((actualOperationTime / 60) * workers)) * 100) / 100 : 0;

    // 가동률 = 작업시간 / 총시간 × 100
    const operationRate = total > 0 ?
      Math.round((actualOperationTime / total) * 100 * 100) / 100 : 0;

    // 생산달성률 = 생산수량 / 계획수량 × 100  
    const plan = Number(formData.plan_qty) || 0;
    const achievementRate = plan > 0 ?
      Math.round((act / plan) * 100 * 100) / 100 : 0;

    return {
      totalDefects,
      incomingDefects,
      actualOperationTime,
      uph,
      upph,
      operationRate,
      achievementRate
    };
  }, [formData, totalProcessingDefects, totalOutsourcingDefects, totalIncoming]);
  const totalDefectsNow = totalIncoming + totalProcessingDefects + totalOutsourcingDefects;
  const denomForRate = Math.max(1, (Number(formData.input_qty) || 0) || ((Number(formData.actual_qty) || 0) + totalDefectsNow));
  const badgeClassFor = (sum: number) => {
    const pct = (sum / denomForRate) * 100;
    if (pct <= 2) return 'bg-green-50 text-green-700';
    if (pct <= 5) return 'bg-amber-50 text-amber-700';
    return 'bg-red-50 text-red-700';
  };

  useEffect(() => {
    setFormData(prev => {
      if (prev.injection_defect === totalIncoming) {
        return prev;
      }
      return { ...prev, injection_defect: totalIncoming };
    });
  }, [totalIncoming]);

  const handleChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 필수 입력 검증: 날짜, 라인, 모델, Part No., 계획수량, 생산수량
    if (!formData.date) {
      toast.error(lang === 'zh' ? '请填写报告日期' : '보고일자를 입력하세요');
      return;
    }
    if (!formData.line_no) {
      toast.error(t('select_line_error'));
      return;
    }
    if (!formData.model || !selectedModelDesc) {
      toast.error(t('select_model_error'));
      return;
    }
    if (!formData.part_no) {
      toast.error(t('select_part_no_error'));
      return;
    }
    if (!formData.plan_qty || Number(formData.plan_qty) <= 0) {
      toast.error(t('input_plan_qty_error'));
      return;
    }
    if (!formData.actual_qty || Number(formData.actual_qty) < 0) {
      toast.error(t('input_production_qty_error'));
      return;
    }

    // 불량 데이터 부분 입력 검증 (가공불량, 외주불량)
    const partialProcessingEntries = processingDefects.filter(entry =>
      (entry.type.trim() && entry.quantity === 0) || (!entry.type.trim() && entry.quantity > 0)
    );
    const partialOutsourcingEntries = outsourcingDefects.filter(entry =>
      (entry.type.trim() && entry.quantity === 0) || (!entry.type.trim() && entry.quantity > 0)
    );

    if (partialProcessingEntries.length > 0 || partialOutsourcingEntries.length > 0) {
      const warningMsg = t('incomplete_defect_warning');

      const confirmed = window.confirm(warningMsg);
      if (!confirmed) return;
    }

    // 확인 다이얼로그: 계획 대비 달성률, 불량 안내
    const plan = Number(formData.plan_qty) || 0;
    const actual = Number(formData.actual_qty) || 0;
    const totalDefects = totalIncoming + totalOutsourcingDefects + totalProcessingDefects;
    const rate = plan > 0 ? ((actual / plan) * 100).toFixed(1) : '0.0';
    const confirmMsg = t('save_confirm_with_stats', { rate, totalDefects });
    const ok = window.confirm(confirmMsg);
    if (!ok) return;
    try {
      const payload: any = {
        ...formData,
      };
      // 상세 불량 JSON 포함
      payload.incoming_defects_detail = { ...incomingDefectsDetail };

      // 빈 행 제거 (유형과 수량이 모두 비어있는 행)
      const validProcessingDefects = processingDefects.filter(
        entry => entry.type.trim() || entry.quantity > 0
      );
      const validOutsourcingDefects = outsourcingDefects.filter(
        entry => entry.type.trim() || entry.quantity > 0
      );

      // 새로운 동적 불량 데이터 추가 (빈 행 제거 후)
      payload.processing_defects_dynamic = validProcessingDefects;
      payload.outsourcing_defects_dynamic = validOutsourcingDefects;
      payload.injection_defect = totalIncoming;

      // 빈 문자열은 0으로 변환하여 서버로 전송
      // 동적 불량값을 기존 필드에 설정
      payload.processing_defect = totalProcessingDefects;
      payload.outsourcing_defect = totalOutsourcingDefects;

      ['plan_qty', 'input_qty', 'actual_qty', 'rework_qty', 'injection_defect', 'outsourcing_defect', 'processing_defect', 'total_time', 'idle_time', 'operation_time', 'workers'].forEach((k) => {
        if (payload[k] === '' || payload[k] === undefined || payload[k] === null) payload[k] = 0;
      });
      setFormData((f) => ({ ...f, ...payload }));
      const maybePromise = onSubmit(payload);
      if (maybePromise && typeof (maybePromise as any).then === 'function') {
        await (maybePromise as Promise<any>);
      }

      // 저장 성공 후 불량 유형들을 히스토리에 자동 추가
      validProcessingDefects.forEach(entry => {
        if (entry.type.trim()) {
          recordDefectTypeUsage('processing', entry.type.trim());
        }
      });
      validOutsourcingDefects.forEach(entry => {
        if (entry.type.trim()) {
          recordDefectTypeUsage('outsourcing', entry.type.trim());
        }
      });

      // 성공적으로 저장된 경우 폼 초기화
      resetForm();
    } catch (_err: any) {
      toast.error(lang === 'zh' ? '保存失败' : '저장에 실패했습니다');
    }
  };

  const resetForm = () => {
    setFormData({
      date: format(new Date(), 'yyyy-MM-dd'),
      line_no: '',
      part_no: '',
      model: '',
      supply_type: 'JIT',
      plan_qty: 0,
      input_qty: 0,
      actual_qty: 0,
      rework_qty: 0,
      injection_defect: 0,
      outsourcing_defect: 0,
      processing_defect: 0,
      total_time: 0,
      idle_time: 0,
      operation_time: 0,
      workers: 1,
      note: '',
    });
    setProductQuery('');
    setSelectedModelDesc(null);
    setSelectedPartSpec(null);
    setProcessingDefects([]);
    setOutsourcingDefects([]);
    setIncomingDefectsDetail(() => {
      const init: Record<string, number | ''> = {};
      incomingDefectItems.forEach(it => (init[it.key] = ''));
      return init;
    });
  };

  // 숫자 입력 시 기본 0이 선택되어 덮어쓰도록 포커스 시 전체 선택
  const selectOnFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    try { e.target.select(); } catch (_) { }
  };

  // Enter 키로 폼 제출 방지 및 다음 필드로 이동
  const handleKeyDown: React.KeyboardEventHandler<HTMLFormElement> = (ev) => {
    if (ev.key === 'Enter') {
      const target = ev.target as HTMLElement;
      const tag = (target.tagName || '').toLowerCase();
      // 텍스트영역 제외하고 엔터 입력 시 기본 제출 방지
      if (tag !== 'textarea') {
        ev.preventDefault();
        // 포커스 이동: form 내에서 다음 포커스 가능한 요소 찾기
        const form = ev.currentTarget;
        const focusables = Array.from(form.querySelectorAll<HTMLElement>(
          'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
        )).filter(el => !el.hasAttribute('disabled'));
        const idx = focusables.indexOf(target);
        const next = focusables[idx + 1];
        if (next) next.focus();
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="flex flex-col gap-y-6">
      {/* 상단: 보고일자 / 라인 / 모델 / Part No. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
        <div>
          <Label htmlFor="date">{t('report_date')}</Label>
          <Input type="date" value={formData.date} onChange={(e) => handleChange('date', e.target.value)} required className="text-center" />
        </div>
        <div>
          <Label htmlFor="line_no">{t('assembly_line_no')}</Label>
          <select
            id="line_no"
            value={formData.line_no}
            onChange={(e) => handleChange('line_no', e.target.value)}
            required
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500 text-center"
          >
            <option value="">{t('line_select')}</option>
            <option value="Line A">Line A</option>
            <option value="Line B">Line B</option>
            <option value="Line C">Line C</option>
            <option value="Line D">Line D</option>
          </select>
        </div>
        <div>
          <Label>{t('model_search')}</Label>
          <Autocomplete<PartSpec>
            options={uniqueModelDesc}
            getOptionLabel={(opt) => `${opt.model_code} – ${opt.description}`}
            onInputChange={(_, v) => setProductQuery(v)}
            filterOptions={(opts, state) => {
              const input = (state.inputValue || '').trim();
              let filtered = opts.slice();
              if (input) {
                const exists = filtered.some(o => `${o.model_code} – ${o.description}`.toUpperCase().includes(input.toUpperCase()));
                if (!exists) {
                  // 가상의 "새 모델로 Part 추가" 옵션을 노출
                  filtered = [
                    { model_code: '', description: '', id: -1 } as any,
                    ...filtered,
                  ];
                }
              }
              return filtered;
            }}
            renderOption={(props, option) => {
              const { key, ...rest } = props as any;
              if ((option as any).id === -1) {
                return (
                  <li key={key} {...rest} className="bg-blue-50 hover:bg-blue-100 border-t border-blue-200">
                    <div className="flex items-center justify-center gap-2 text-blue-700 font-medium py-2 text-sm">
                      <Plus className="h-3 w-3" />
                      <span>{t('add_new_part_spec')}</span>
                    </div>
                  </li>
                );
              }
              return (
                <li key={key} {...rest}>
                  <div className="flex flex-col">
                    <span className="font-mono font-medium">{option.model_code}</span>
                    <span className="text-sm text-gray-600">{option.description}</span>
                  </div>
                </li>
              );
            }}
            onChange={(_, v) => {
              setSelectedModelDesc(v);
              if (v && (v as any).id !== -1) {
                setFormData((f) => ({ ...f, model: v.model_code, part_no: '' }));
                setSelectedPartSpec(null);
              }
              if (v && (v as any).id === -1) {
                // 사용자가 모델 검색에서 없는 항목을 선택 → Part 추가 모달로 유도
                const raw = (productQuery || '').trim();
                // "MODEL – DESC" 또는 "MODEL - DESC" 형태 파싱
                const parts = raw.split(/\s+[–-]\s+/);
                const modelCode = (parts[0] || '').trim().toUpperCase();
                const desc = (parts[1] || '').trim();
                setNewPartForm((prev: any) => ({
                  ...prev,
                  part_no: '',
                  model_code: modelCode,
                  description: desc,
                }));
                setPrefillOriginal({ part_no: '', model_code: modelCode, description: desc });
                setShowAddPartModal(true);
              }
            }}
            value={selectedModelDesc}
            renderInput={(params) => <TextField {...params} size="small" placeholder={t('model_search')} required />}
          />
        </div>
        <div>
          <Label>Part No.</Label>
          <Autocomplete<PartSpec | { isAddNew: boolean; part_no: string } | { isAddNewForModel: boolean }>
            options={(() => {
              const baseOptions = selectedModelDesc
                ? (
                  (asmPartspecsByModel as any).length
                    ? (asmPartspecsByModel as any)
                    : ((asmPartsByModel as any).length
                      ? (asmPartsByModel as any)
                      : modelParts)
                )
                : (() => {
                  const asmOptions = Array.isArray(asmPartNoSearch)
                    ? (asmPartNoSearch as any[]).map((r: any) => ({ part_no: r.part_no, model_code: r.model, description: r.description || '' }))
                    : [];
                  const merged = [...asmOptions, ...searchResults];
                  const seen = new Set<string>();
                  return merged.filter((o: any) => {
                    const key = String(o.part_no || '');
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  });
                })();
              if (productQuery.trim().length >= 2 && baseOptions.length === 0) return [{ isAddNew: true, part_no: productQuery.trim() } as any];
              if (selectedModelDesc && baseOptions.length === 0) return [{ isAddNewForModel: true } as any];
              return baseOptions;
            })()}
            openOnFocus
            loading={!selectedModelDesc ? false : (Array.isArray(modelParts) ? false : true)}
            filterOptions={(opts, state) => {
              let filtered: any[] = opts.slice();
              if (selectedModelDesc) {
                // 모델 코드와 설명을 모두 고려하여 후보 축소 (둘 다 일치 우선)
                filtered = filtered.filter((o: any) => {
                  if (('isAddNew' in o) || ('isAddNewForModel' in o)) return true;
                  const modelOk = o.model_code === selectedModelDesc.model_code;
                  const descOk = !selectedModelDesc.description || !o.description || o.description === selectedModelDesc.description;
                  return modelOk && descOk;
                });
              }
              const input = (state.inputValue || '').trim().toUpperCase();
              if (input) filtered = filtered.filter((o: any) => ('isAddNew' in o) || ('isAddNewForModel' in o) ? true : String(o.part_no || '').toUpperCase().includes(input));
              if (filtered.length === 0 && input) return [{ isAddNew: true, part_no: input } as any];
              return filtered;
            }}
            getOptionLabel={(opt) => {
              if ('isAddNew' in opt && (opt as any).isAddNew) return (opt as any).part_no || '';
              if ('isAddNewForModel' in opt && (opt as any).isAddNewForModel) return productQuery.trim();
              return String((opt as any).part_no || '');
            }}
            onInputChange={(_, v) => setProductQuery(v)}
            onChange={async (_, v) => {
              if (v && ('isAddNew' in v || 'isAddNewForModel' in v)) {
                const desired = (productQuery || '').trim();
                let prefillData: any = null;
                try {
                  const norm = desired.replace(/\s+/g, '').toUpperCase();
                  const prefix9 = norm.slice(0, 9);
                  let list: any[] = [];
                  if (prefix9.length === 9) {
                    const { data } = await api.get('/assembly/products/search-parts/', { params: { search: prefix9, prefix_only: 1 } });
                    const all = Array.isArray(data) ? data : [];
                    list = all
                      .map((it: any) => ({
                        ...it,
                        source_system: it?.source_system || 'assembly',
                      }))
                      .filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9));
                    if (selectedModelDesc) {
                      const selectedCode = (selectedModelDesc.model_code || '').toUpperCase();
                      list = list.filter((it: any) => {
                        const candidateModel = String(it.model_code ?? it.model ?? '').toUpperCase();
                        return candidateModel === selectedCode;
                      });
                    }
                    if (list.length === 0) {
                      const res = await api.get('/injection/parts/', { params: { search: prefix9, page_size: 10 } });
                      const inj = Array.isArray(res?.data?.results) ? res.data.results : [];
                      list = inj
                        .filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9))
                        .map((it: any) => ({
                          id: it.id,
                          part_no: it.part_no,
                          model: it.model_code,
                          model_code: it.model_code,
                          description: it.description,
                          mold_type: it.mold_type,
                          color: it.color,
                          resin_type: it.resin_type,
                          resin_code: it.resin_code,
                          net_weight_g: it.net_weight_g,
                          sr_weight_g: it.sr_weight_g,
                          cycle_time_sec: it.cycle_time_sec,
                          cavity: it.cavity,
                          valid_from: it.valid_from,
                          source_system: 'injection',
                        }));
                      if (selectedModelDesc) {
                        const selectedCode = (selectedModelDesc.model_code || '').toUpperCase();
                        list = list.filter((it: any) => {
                          const candidateModel = String(it.model_code ?? it.model ?? '').toUpperCase();
                          return candidateModel === selectedCode;
                        });
                      }
                    }
                  }
                  setPrefillSimilar(null);
                  if (list.length > 0) {
                    const top = list[0];
                    const promptText = t('similar_parts_prompt')
                      .replace('{first}', top.part_no)
                      .replace('{count}', String(list.length));
                    const ok = window.confirm(promptText);
                    if (ok) {
                      let detail: any = top;
                      const sourceSystem = String(top?.source_system || '').toLowerCase();
                      const needsEnhancement = (obj: any) =>
                        ['mold_type', 'color', 'resin_type', 'resin_code', 'net_weight_g', 'sr_weight_g', 'cycle_time_sec', 'cavity'].every(
                          (key) => obj[key] === null || typeof obj[key] === 'undefined' || obj[key] === ''
                        );

                      if (needsEnhancement(detail) && sourceSystem === 'injection' && top?.part_no) {
                        try {
                          const { data: searchData } = await api.get('/injection/parts/', {
                            params: { search: top.part_no, page_size: 1 },
                          });
                          const pick = Array.isArray(searchData?.results)
                            ? searchData.results.find((it: any) =>
                              String(it.part_no || '').toUpperCase() === String(top.part_no || '').toUpperCase()
                            )
                            : null;
                          if (pick) detail = pick;
                        } catch (error: any) {
                          if (error?.response?.status !== 404) {
                            console.warn('Failed to fetch injection part spec detail for prefill', error);
                          }
                        }
                      } else if (needsEnhancement(detail) && sourceSystem === 'assembly' && top?.part_no) {
                        try {
                          const { data: searchData } = await api.get('/assembly/partspecs/', {
                            params: { search: top.part_no, page_size: 1 },
                          });
                          const results = Array.isArray(searchData?.results)
                            ? searchData.results
                            : Array.isArray(searchData)
                              ? searchData
                              : [];
                          const match = results.find((it: any) =>
                            String(it.part_no || '').toUpperCase() === String(top.part_no || '').toUpperCase()
                          );
                          if (match) detail = match;
                        } catch (error: any) {
                          if (error?.response?.status !== 404) {
                            console.warn('Failed to fetch assembly part spec detail for prefill', error);
                          }
                        }
                      }
                      if (needsEnhancement(detail) && top?.part_no) {
                        try {
                          const { data: searchData } = await api.get('/injection/parts/', {
                            params: { search: top.part_no, page_size: 1 },
                          });
                          const pick = Array.isArray(searchData?.results)
                            ? searchData.results.find((it: any) =>
                              String(it.part_no || '').toUpperCase() === String(top.part_no || '').toUpperCase()
                            )
                            : null;
                          if (pick) detail = pick;
                        } catch (fallbackError: any) {
                          if (fallbackError?.response?.status !== 404) {
                            console.warn('Failed to fetch part spec detail for prefill', fallbackError);
                          }
                        }
                      }
                      const normalize = (value: any) => {
                        if (value === null || typeof value === 'undefined') return '';
                        if (typeof value === 'number') return String(value);
                        return String(value);
                      };
                      const resolveModelCode = normalize(detail.model_code ?? detail.model ?? selectedModelDesc?.model_code ?? '');
                      prefillData = {
                        model_code: resolveModelCode,
                        description: normalize(detail.description ?? selectedModelDesc?.description ?? ''),
                        mold_type: normalize(detail.mold_type),
                        color: normalize(detail.color),
                        resin_type: normalize(detail.resin_type),
                        resin_code: normalize(detail.resin_code),
                        net_weight_g: normalize(detail.net_weight_g),
                        sr_weight_g: normalize(detail.sr_weight_g),
                        cycle_time_sec: normalize(detail.cycle_time_sec),
                        cavity: normalize(detail.cavity),
                        valid_from: normalize(detail.valid_from) || new Date().toISOString().slice(0, 10),
                      } as any;
                    }
                  }
                } catch (_) {
                  setPrefillSimilar(null);
                }
                // 모달 오픈 전, 새 파트 입력 기본값 준비 (Part No.는 항상 사용자가 입력한 값 유지)
                setPrefillSimilar(prefillData);
                setNewPartForm((prev: any) => ({
                  ...prev,
                  part_no: desired,
                  model_code: (prefillData as any)?.model_code || selectedModelDesc?.model_code || '',
                  description: (prefillData as any)?.description || selectedModelDesc?.description || '',
                  mold_type: (prefillData as any)?.mold_type || '',
                  color: (prefillData as any)?.color || '',
                  resin_type: (prefillData as any)?.resin_type || '',
                  resin_code: (prefillData as any)?.resin_code || '',
                  net_weight_g: (prefillData as any)?.net_weight_g ?? '',
                  sr_weight_g: (prefillData as any)?.sr_weight_g ?? '',
                  cycle_time_sec: (prefillData as any)?.cycle_time_sec ?? '',
                  cavity: (prefillData as any)?.cavity ?? '',
                  valid_from: (prefillData as any)?.valid_from || new Date().toISOString().slice(0, 10),
                }));
                setPrefillOriginal({
                  part_no: desired,
                  model_code: (prefillData as any)?.model_code || selectedModelDesc?.model_code || '',
                  description: (prefillData as any)?.description || selectedModelDesc?.description || '',
                  mold_type: (prefillData as any)?.mold_type || '',
                  color: (prefillData as any)?.color || '',
                  resin_type: (prefillData as any)?.resin_type || '',
                  resin_code: (prefillData as any)?.resin_code || '',
                  net_weight_g: (prefillData as any)?.net_weight_g ?? '',
                  sr_weight_g: (prefillData as any)?.sr_weight_g ?? '',
                  cycle_time_sec: (prefillData as any)?.cycle_time_sec ?? '',
                  cavity: (prefillData as any)?.cavity ?? '',
                  valid_from: (prefillData as any)?.valid_from || new Date().toISOString().slice(0, 10),
                });
                setShowAddPartModal(true);
                return;
              }
              setSelectedPartSpec(v as PartSpec);
              if (v && !('isAddNew' in v)) {
                setFormData((f) => ({ ...f, part_no: (v as any).part_no, model: (v as any).model_code }));
                const modelSpec = uniqueModelDesc.find((m) => m.model_code === v.model_code && m.description === v.description);
                if (modelSpec) {
                  setSelectedModelDesc(modelSpec);
                } else {
                  // fallback: 강제로 모델 선택 상태를 설정하여 자동완성 표시
                  setSelectedModelDesc({ id: -9996, part_no: '', model_code: v.model_code, description: v.description || '' } as any);
                  setProductQuery(v.model_code || '');
                }
              }
            }}
            value={selectedPartSpec}
            renderOption={(props, option) => {
              const { key, ...rest } = props as any;
              if ('isAddNew' in option && option.isAddNew) {
                return (
                  <li key={key} {...rest} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                    <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                      <Plus className="h-3 w-3" />
                      <span>"{option.part_no}" {t('add_new_part_prompt')}</span>
                    </div>
                  </li>
                );
              }
              const spec = option as PartSpec;
              return (
                <li key={key} {...rest}>
                  <div className="flex flex-col">
                    <span className="font-mono font-medium">{spec.part_no}</span>
                    {spec.model_code && <span className="text-sm text-gray-600">{spec.model_code} - {spec.description}</span>}
                  </div>
                </li>
              );
            }}
            renderInput={(params) => <TextField {...params} size="small" placeholder={`Part No. ${t('input_or_select')}`} required />}
          />
        </div>
        <div>
          <Label htmlFor="supply_type">{t('supply_type')}</Label>
          <select
            id="supply_type"
            value={formData.supply_type}
            onChange={(e) => handleChange('supply_type', e.target.value)}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500 text-center"
          >
            <option value="JIT">{t('jit_online')}</option>
            <option value="CSK">CSKD</option>
            <option value="SVC">SVC</option>
            <option value="REWORK">{t('rework')}</option>
            <option value="INSPECTION">{t('inspection')}</option>
          </select>
        </div>
      </div>

      {/* 생산기록 / 불량기록 레이아웃 */}
      <div className={`grid grid-cols-1 gap-6 mt-2 items-stretch ${compact ? 'text-sm' : ''}`}>
        <Card className={`h-full flex flex-col ${compact ? 'col-span-2' : ''}`}>
          <CardHeader className={`font-semibold text-blue-700 ${compact ? 'text-base' : ''}`}>{t('production_record')}</CardHeader>
          <CardContent className="flex-1">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 수량/인원 기록 섹션 카드 */}
              <Card className="border-teal-200 md:order-1">
                <CardHeader className="py-2 font-medium text-teal-700">{t('qty_personnel_record')}</CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="flex flex-col">
                      <Label htmlFor="plan_qty">{t('plan_qty_required')}</Label>
                      <Input id="plan_qty" type="number" inputMode="numeric" min={0} value={formData.plan_qty as any} onChange={(e) => handleChange('plan_qty', e.target.value === '' ? '' : Number(e.target.value || 0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="actual_qty">{t('production_qty_required')}</Label>
                      <Input id="actual_qty" type="number" inputMode="numeric" min={0} value={formData.actual_qty as any} onChange={(e) => handleChange('actual_qty', e.target.value === '' ? '' : Number(e.target.value || 0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="workers">{t('worker_count')}</Label>
                      <Input id="workers" type="number" min={0} value={formData.workers as any} onChange={(e) => handleChange('workers', e.target.value === '' ? '' : Number(e.target.value))} onFocus={selectOnFocus} className="text-center" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* 시간 기록 섹션 카드 */}
              <Card className="border-indigo-200 md:order-2">
                <CardHeader className="py-2 font-medium text-indigo-700">{t('time_record')}</CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="flex flex-col">
                      <Label htmlFor="operation_time">{t('operation_time_min')}</Label>
                      <Input id="operation_time" type="number" inputMode="numeric" min={0} value={formData.operation_time as any} onChange={(e) => handleChange('operation_time', e.target.value === '' ? '' : Number(e.target.value || 0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="idle_time">{t('idle_time_min')}</Label>
                      <Input id="idle_time" type="number" inputMode="numeric" min={0} value={formData.idle_time as any} onChange={(e) => handleChange('idle_time', e.target.value === '' ? '' : Number(e.target.value || 0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="total_time">{t('total_time')}</Label>
                      <Input id="total_time" value={(formData.operation_time === '' && formData.idle_time === '') ? '' : (Number(formData.operation_time || 0) + Number(formData.idle_time || 0))} disabled className={`text-center bg-gray-100 ${compact ? 'h-8 text-sm px-2' : ''}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </CardContent>
        </Card>

        <Card className={`h-full flex flex-col ${compact ? 'col-span-3' : ''}`}>
          <CardHeader className={`font-semibold text-blue-700 ${compact ? 'text-base' : ''}`}>{t('defect_record')}</CardHeader>
          <CardContent className="flex-1 space-y-4">
            {/* 사출불량 (기존 입고불량에서 변경) */}
            <Card className="border-green-200">
              <CardHeader className="py-2 font-medium text-green-700">
                <button
                  type="button"
                  className="w-full flex flex-row items-center justify-between cursor-pointer select-none"
                  onClick={() => setIncomingOpen(o => !o)}
                >
                  <span>{t('injection_defect')}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">{t('sum')}:</span>
                    <span className={`px-2 py-0.5 rounded-md font-semibold ${badgeClassFor(totalIncoming)}`}>{totalIncoming}</span>
                  </div>
                </button>
              </CardHeader>
              {incomingOpen && (
                <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  {incomingDefectItems.map(it => (
                    <div key={it.key} className="flex flex-col">
                      <Label className="text-gray-600">{it.key === 'other' ? t('def_incoming_other') : t(`def_${it.key}`)}</Label>
                      <Input type="number" inputMode="numeric" min={0} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} value={incomingDefectsDetail[it.key] as any} onFocus={selectOnFocus}
                        onChange={(e) => { setIncomingDefectsDetail(prev => ({ ...prev, [it.key]: e.target.value === '' ? '' : (Number(e.target.value) || 0) })); }} />
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>

            {/* 새로운 2열 불량 관리 섹션 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* 가공불량 */}
              <DefectTypeInput
                defectType="processing"
                value={processingDefects}
                onChange={setProcessingDefects}
                historyOptions={processingDefectHistory}
                onSelect={(type) => recordDefectTypeUsage('processing', type)}
                onDeleteHistory={(type) => deleteDefectType('processing', type)}
                className="border-amber-200"
              />

              {/* 외주불량 */}
              <DefectTypeInput
                defectType="outsourcing"
                value={outsourcingDefects}
                onChange={setOutsourcingDefects}
                historyOptions={outsourcingDefectHistory}
                onSelect={(type) => recordDefectTypeUsage('outsourcing', type)}
                onDeleteHistory={(type) => deleteDefectType('outsourcing', type)}
                className="border-purple-200"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 성과지표 + 비고를 한 카드로 가로 2컬럼 구성 */}
      <Card>
        <CardHeader className="font-semibold text-green-700">{t('performance_indicators')}</CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-4">
            {/* 좌: 성과지표 50% */}
            <div className="basis-full md:basis-[50%]">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{t('analysis_metric_uph')}</Label>
                  <Input value={calculatedValues.uph} disabled className="text-center bg-green-50 font-semibold" />
                  <p className="text-xs text-gray-500 mt-1">{t('production_per_hour')}</p>
                </div>
                <div>
                  <Label>{t('analysis_metric_upph')}</Label>
                  <Input value={calculatedValues.upph} disabled className="text-center bg-green-50 font-semibold" />
                  <p className="text-xs text-gray-500 mt-1">{t('production_per_person_hour')}</p>
                </div>
                <div>
                  <Label>{t('operation_rate_percent')}</Label>
                  <Input value={calculatedValues.operationRate} disabled className="text-center bg-green-50 font-semibold" />
                  <p className="text-xs text-gray-500 mt-1">{t('operation_time_ratio')}</p>
                </div>
                <div>
                  <Label>{t('production_achievement_rate')}</Label>
                  <Input value={calculatedValues.achievementRate} disabled className="text-center bg-green-50 font-semibold" />
                  <p className="text-xs text-gray-500 mt-1">{t('production_vs_plan')}</p>
                </div>
              </div>
            </div>

            {/* 우: 비고 50% */}
            <div className="basis-full md:basis-[50%] flex flex-col">
              <Label>{t('header_note')}</Label>
              <Textarea
                id="note"
                rows={5}
                value={formData.note}
                onChange={(e) => handleChange('note', e.target.value)}
                className="resize-none w-full"
              />
              {/* 저장 버튼 */}
              <div className="flex justify-end mt-3">
                <PermissionButton
                  permission="can_edit_assembly"
                  type="submit"
                  className="px-6 py-3 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-medium transition-all duration-200 inline-flex items-center gap-2 whitespace-nowrap"
                  disabled={isLoading}
                >
                  {!isLoading && <PlusCircle className="h-5 w-5 shrink-0" />}
                  {isLoading ? t('saving') : t('save')}
                </PermissionButton>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>




      {/* Add Part Modal */}
      {showAddPartModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">{t('add_new_part_spec')}</h3>
            <p className="text-xs text-gray-500">{t('quality.add_part_required_fields')}</p>
            <div className="grid grid-cols-2 gap-3">
              {(() => {
                const isEdited = (k: string) => prefillOriginal && String(newPartForm[k] ?? '') !== String(prefillOriginal[k] ?? '');
                const editedCls = (k: string) => isEdited(k) ? ' bg-blue-50 border-blue-300' : '';
                const prefilledCls = (k: string) => (prefillOriginal && prefillOriginal[k] && k !== 'part_no') ? ' bg-yellow-50 border-yellow-300' : '';
                return (
                  <>
                    <input
                      placeholder={`Part No (${t('quality.part_no_placeholder')}…)`}
                      className={`border rounded px-2 py-1 col-span-2 bg-green-50 border-green-300`}
                      value={newPartForm.part_no}
                      onChange={(e) => setNewPartForm((f: any) => ({ ...f, part_no: e.target.value }))}
                    />
                    <input placeholder={`Model Code (${t('quality.model_placeholder')}…)`} className={`border rounded px-2 py-1 col-span-2${prefilledCls('model_code')}${editedCls('model_code')}`} value={newPartForm.model_code} onChange={(e) => setNewPartForm((f: any) => ({ ...f, model_code: e.target.value }))} />
                    <input placeholder={`Description (${t('description')}…)`} className={`border rounded px-2 py-1 col-span-2${prefilledCls('description')}${editedCls('description')}`} value={newPartForm.description} onChange={(e) => setNewPartForm((f: any) => ({ ...f, description: e.target.value }))} />
                    <input placeholder={t('mold_type')} className={`border rounded px-2 py-1${prefilledCls('mold_type')}${editedCls('mold_type')}`} value={newPartForm.mold_type} onChange={(e) => setNewPartForm((f: any) => ({ ...f, mold_type: e.target.value }))} />
                    <input placeholder={t('color')} className={`border rounded px-2 py-1${prefilledCls('color')}${editedCls('color')}`} value={newPartForm.color} onChange={(e) => setNewPartForm((f: any) => ({ ...f, color: e.target.value }))} />
                    <input placeholder={t('resin_type')} className={`border rounded px-2 py-1${prefilledCls('resin_type')}${editedCls('resin_type')}`} value={newPartForm.resin_type} onChange={(e) => setNewPartForm((f: any) => ({ ...f, resin_type: e.target.value }))} />
                    <input placeholder={t('resin_code')} className={`border rounded px-2 py-1${prefilledCls('resin_code')}${editedCls('resin_code')}`} value={newPartForm.resin_code} onChange={(e) => setNewPartForm((f: any) => ({ ...f, resin_code: e.target.value }))} />
                    <input placeholder={t('net_g')} className={`border rounded px-2 py-1${prefilledCls('net_weight_g')}${editedCls('net_weight_g')}`} value={newPartForm.net_weight_g} onChange={(e) => setNewPartForm((f: any) => ({ ...f, net_weight_g: e.target.value }))} />
                    <input placeholder={t('sr_g')} className={`border rounded px-2 py-1${prefilledCls('sr_weight_g')}${editedCls('sr_weight_g')}`} value={newPartForm.sr_weight_g} onChange={(e) => setNewPartForm((f: any) => ({ ...f, sr_weight_g: e.target.value }))} />
                    <input placeholder={t('ct_s')} className={`border rounded px-2 py-1${prefilledCls('cycle_time_sec')}${editedCls('cycle_time_sec')}`} value={newPartForm.cycle_time_sec} onChange={(e) => setNewPartForm((f: any) => ({ ...f, cycle_time_sec: e.target.value }))} />
                    <input placeholder={t('cavity')} className={`border rounded px-2 py-1${prefilledCls('cavity')}${editedCls('cavity')}`} value={newPartForm.cavity} onChange={(e) => setNewPartForm((f: any) => ({ ...f, cavity: e.target.value }))} />
                    <input type="date" className={`border rounded px-2 py-1${prefilledCls('valid_from')}${editedCls('valid_from')}`} value={newPartForm.valid_from} onChange={(e) => setNewPartForm((f: any) => ({ ...f, valid_from: e.target.value }))} />
                  </>
                );
              })()}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowAddPartModal(false)}>{t('cancel')}</Button>
              <Button size="sm" onClick={async () => {
                try {
                  const partNo = String(newPartForm.part_no || '').trim().toUpperCase();
                  const modelCode = String(newPartForm.model_code || '').trim().toUpperCase();
                  const description = String(newPartForm.description || '').trim();
                  if (!partNo || !modelCode || !description) {
                    toast.error(lang === 'zh' ? '请填写 Part No / Model Code / Description' : 'Part No / Model Code / Description를 입력하세요.');
                    return;
                  }

                  const cleanNumber = (value: any, parser: (v: string) => number) => {
                    if (value === null || typeof value === 'undefined') return undefined;
                    const trimmed = String(value).trim();
                    if (trimmed === '') return undefined;
                    const parsed = parser(trimmed.replace(/,/g, ''));
                    return Number.isFinite(parsed) ? parsed : undefined;
                  };

                  const payload: Record<string, any> = {
                    part_no: partNo,
                    model_code: modelCode,
                    description,
                    valid_from: newPartForm.valid_from || new Date().toISOString().slice(0, 10),
                  };

                  if (newPartForm.mold_type) payload.mold_type = newPartForm.mold_type;
                  if (newPartForm.color) payload.color = newPartForm.color;
                  if (newPartForm.resin_type) payload.resin_type = newPartForm.resin_type;
                  if (newPartForm.resin_code) payload.resin_code = newPartForm.resin_code;

                  const netWeight = cleanNumber(newPartForm.net_weight_g, parseFloat);
                  if (typeof netWeight !== 'undefined') payload.net_weight_g = netWeight;
                  const srWeight = cleanNumber(newPartForm.sr_weight_g, parseFloat);
                  if (typeof srWeight !== 'undefined') payload.sr_weight_g = srWeight;
                  const cycleTime = cleanNumber(newPartForm.cycle_time_sec, (v) => parseInt(v, 10));
                  if (typeof cycleTime !== 'undefined') payload.cycle_time_sec = cycleTime;
                  const cavity = cleanNumber(newPartForm.cavity, (v) => parseInt(v, 10));
                  if (typeof cavity !== 'undefined') payload.cavity = cavity;

                  const newPartResponse = await api.post('/injection/parts/', payload);
                  const createdPart = newPartResponse.data || {};

                  try {
                    await api.post('/assembly/partspecs/create-or-update/', {
                      part_no: partNo,
                      model_code: modelCode,
                      description,
                    });
                  } catch (syncErr) {
                    console.warn('Failed to sync ECO part spec for assembly', syncErr);
                  }

                  toast.success(t('new_part_added_success'));
                  queryClient.invalidateQueries({ queryKey: ['parts-search'] });
                  queryClient.invalidateQueries({ queryKey: ['parts-all'] });
                  queryClient.invalidateQueries({ queryKey: ['parts-model'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs-by-model'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-parts-by-model'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-products'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partno-search'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-part-search'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-model-search'] });
                  setShowAddPartModal(false);

                  const createdModelCode = createdPart.model_code || modelCode;
                  const createdDesc = createdPart.description || description || '';
                  setProductQuery(createdModelCode);
                  setFormData((f) => ({
                    ...f,
                    part_no: createdPart.part_no || partNo,
                    model: createdModelCode,
                  }));
                  const foundModelSpec = uniqueModelDesc.find((m) => m.model_code === createdModelCode && m.description === createdDesc);
                  if (foundModelSpec) {
                    setSelectedModelDesc(foundModelSpec);
                  } else {
                    setSelectedModelDesc({ id: -9998, part_no: '', model_code: createdModelCode, description: createdDesc } as any);
                  }
                  setSelectedPartSpec({ part_no: createdPart.part_no || partNo, model_code: createdModelCode, description: createdDesc } as any);
                } catch (err: any) {
                  console.error('Failed to create new part:', err);
                  const errorMsg = err?.response?.data?.detail || err?.message || 'Unknown error';
                  toast.error(lang === 'zh' ? `保存失败: ${errorMsg}` : `저장 실패: ${errorMsg}`);
                }
              }}>{t('save')}</Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
