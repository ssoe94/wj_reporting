import { useState } from 'react';
import { format } from 'date-fns';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import PermissionButton from './common/PermissionButton';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Autocomplete, TextField } from '@mui/material';
import type { AssemblyReport } from '../types/assembly';
import { useLang } from '../i18n';
import { usePartSpecSearch, usePartListByModel } from '../hooks/usePartSpecs';
import { useAssemblyPartsByModel, useAssemblyPartspecsByModel, useAssemblyPartNoSearch } from '../hooks/useAssemblyParts';
import type { PartSpec } from '../hooks/usePartSpecs';
import { Plus, PlusCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import React from 'react';

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
  // 불량 상세 입력 (집계용)
  const incomingDefectItems = [
    { key: 'scratch', label: '划伤' },
    { key: 'black_dot', label: '黑点' },
    { key: 'eaten_meat', label: '吃肉' },
    { key: 'air_mark', label: '气印' },
    { key: 'deform', label: '变形' },
    { key: 'short_shot', label: '浇不足' },
    { key: 'broken_pillar', label: '断柱子' },
    { key: 'flow_mark', label: '料花' },
    { key: 'sink_mark', label: '缩瘪' },
    { key: 'whitening', label: '发白' },
    { key: 'other', label: '其他' },
  ] as const;
  const processingDefectItems = [
    { key: 'scratch', label: '划伤' },
    { key: 'printing', label: '印刷' },
    { key: 'rework', label: '加工修理' },
    { key: 'other', label: '其他' },
  ] as const;
  const [incomingDefectsDetail, setIncomingDefectsDetail] = useState<Record<string, number | ''>>(() => {
    const init: Record<string, number | ''> = {};
    incomingDefectItems.forEach(it => (init[it.key] = ''));
    return init;
  });
  const [processingDefectsDetail, setProcessingDefectsDetail] = useState<Record<string, number | ''>>(() => {
    const init: Record<string, number | ''> = {};
    processingDefectItems.forEach(it => (init[it.key] = ''));
    return init;
  });
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [incomingOpen, setIncomingOpen] = useState(true);
  const [processingOpen, setProcessingOpen] = useState(true);
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
      const prc = (initialData as any)?.processing_defects_detail;
      if (inc && typeof inc === 'object') {
        const next: Record<string, number | ''> = {};
        incomingDefectItems.forEach(it => {
          const v = inc[it.key];
          next[it.key] = (v === '' || v === null || v === undefined) ? '' : (Number(v) || 0);
        });
        setIncomingDefectsDetail(next);
      }
      if (prc && typeof prc === 'object') {
        const next: Record<string, number | ''> = {};
        processingDefectItems.forEach(it => {
          const v = prc[it.key];
          next[it.key] = (v === '' || v === null || v === undefined) ? '' : (Number(v) || 0);
        });
        setProcessingDefectsDetail(next);
      }
      setDetailsDirty(false);
    } catch (_) {}
  }, [initialData]);

  // 자동 계산 로직
  const calculatedValues = React.useMemo(() => {
    const inj = Number(formData.injection_defect) || 0;
    const out = Number(formData.outsourcing_defect) || 0;
    const proc = Number(formData.processing_defect) || 0;
    const totalDefects = inj + out + proc;
    const incomingDefects = inj + out;
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
  }, [formData]);

  // 불량 상세 변경 시(사용자 편집 시에만) 총합을 formData에 반영
  React.useEffect(() => {
    // 상세 변경 시 합계 반영 (서버 detail은 저장 시 함께 전송)
    if (!detailsDirty) return;
    const sumIncoming = Object.values(incomingDefectsDetail).reduce<number>((a, b) => a + (b === '' ? 0 : (Number(b) || 0)), 0);
    const sumProcessing = Object.values(processingDefectsDetail).reduce<number>((a, b) => a + (b === '' ? 0 : (Number(b) || 0)), 0);
    setFormData(prev => ({ ...prev, injection_defect: sumIncoming, processing_defect: sumProcessing }));
  }, [incomingDefectsDetail, processingDefectsDetail, detailsDirty]);

  const totalIncoming = React.useMemo(() => Object.values(incomingDefectsDetail).reduce<number>((a,b)=> a+(b===''?0:(Number(b)||0)),0), [incomingDefectsDetail]);
  const totalProcessing = React.useMemo(() => Object.values(processingDefectsDetail).reduce<number>((a,b)=> a+(b===''?0:(Number(b)||0)),0), [processingDefectsDetail]);
  const totalDefectsNow = totalIncoming + totalProcessing + (Number(formData.outsourcing_defect)||0);
  const denomForRate = Math.max(1, (Number(formData.input_qty)||0) || ((Number(formData.actual_qty)||0) + totalDefectsNow));
  const badgeClassFor = (sum: number) => {
    const pct = (sum / denomForRate) * 100;
    if (pct <= 2) return 'bg-green-50 text-green-700';
    if (pct <= 5) return 'bg-amber-50 text-amber-700';
    return 'bg-red-50 text-red-700';
  };

  const handleChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 필수 입력 검증: 날짜, 라인, 모델, Part No.
    if (!formData.date) {
      toast.error(lang === 'zh' ? '请填写报告日期' : '보고일자를 입력하세요');
      return;
    }
    if (!formData.line_no) {
      toast.error(lang === 'zh' ? '请选择产线号' : '라인번호를 선택하세요');
      return;
    }
    if (!formData.model || !selectedModelDesc) {
      toast.error(lang === 'zh' ? '请选择型号' : '모델을 선택하세요');
      return;
    }
    if (!formData.part_no) {
      toast.error(lang === 'zh' ? '请选择 Part No.' : 'Part No.를 선택하세요');
      return;
    }
    // 확인 다이얼로그: 계획 대비 달성률, 불량 안내
    const plan = Number(formData.plan_qty)||0;
    const actual = Number(formData.actual_qty)||0;
    const totalDefects = (Number(formData.injection_defect)||0) + (Number(formData.outsourcing_defect)||0) + (Number(formData.processing_defect)||0);
    const rate = plan > 0 ? ((actual / plan) * 100).toFixed(1) : '0.0';
    const confirmMsg = lang==='zh'
      ? `计划数量对比良品数量为 ${rate}% 。不良数量 ${totalDefects} 件。是否保存？`
      : `계획수량 대비 생산수량은 ${rate}% 입니다. 불량 수량은 ${totalDefects}개 입니다. 입력하시겠습니까?`;
    const ok = window.confirm(confirmMsg);
    if (!ok) return;
    try {
      const payload: any = {
        ...formData,
      };
      // 상세 불량 JSON 포함
      payload.incoming_defects_detail = { ...incomingDefectsDetail };
      payload.processing_defects_detail = { ...processingDefectsDetail };
      // 빈 문자열은 0으로 변환하여 서버로 전송
      ['plan_qty','input_qty','actual_qty','rework_qty','injection_defect','outsourcing_defect','processing_defect','total_time','idle_time','operation_time','workers'].forEach((k)=>{
        if (payload[k] === '' || payload[k] === undefined || payload[k] === null) payload[k] = 0;
      });
      const maybePromise = onSubmit(payload);
      if (maybePromise && typeof (maybePromise as any).then === 'function') {
        await (maybePromise as Promise<any>);
      }
      // 성공적으로 저장된 경우 폼 초기화
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
      setIncomingDefectsDetail(() => {
        const init: Record<string, number> = {};
        incomingDefectItems.forEach(it => (init[it.key] = 0));
        return init;
      });
      setProcessingDefectsDetail(() => {
        const init: Record<string, number> = {};
        processingDefectItems.forEach(it => (init[it.key] = 0));
        return init;
      });
    } catch (_) {
      // 에러시 초기화하지 않음
    }
  };

  // 숫자 입력 시 기본 0이 선택되어 덮어쓰도록 포커스 시 전체 선택
  const selectOnFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    try { e.target.select(); } catch (_) {}
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
                setNewPartForm((prev:any)=> ({
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
                      ? (asmPartNoSearch as any[]).map((r:any)=> ({ part_no: r.part_no, model_code: r.model, description: r.description || '' }))
                      : [];
                    const merged = [...asmOptions, ...searchResults];
                    const seen = new Set<string>();
                    return merged.filter((o:any)=>{
                      const key = String(o.part_no||'');
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
                    let all = Array.isArray(data) ? data : [];
                    list = all.filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9));
                    if (selectedModelDesc) list = list.filter((it: any) => it.model === selectedModelDesc.model_code);
                    if (list.length === 0) {
                      const res = await api.get('/parts/', { params: { search: prefix9, page_size: 10 } });
                      const inj = Array.isArray(res?.data?.results) ? res.data.results : [];
                      list = inj
                        .filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9))
                        .map((it: any) => ({
                          part_no: it.part_no,
                          model: it.model_code,
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
                        }));
                      if (selectedModelDesc) list = list.filter((it: any) => it.model === selectedModelDesc.model_code);
                    }
                  }
                  setPrefillSimilar(null);
                  if (list.length > 0) {
                    const top = list[0];
                    const promptText = t('similar_parts_prompt').replace('{first}', top.part_no).replace('{count}', String(list.length));
                    const ok = window.confirm(promptText);
                    if (ok) {
                      prefillData = {
                        model_code: top.model,
                        description: top.description,
                        mold_type: (top as any).mold_type,
                        color: (top as any).color,
                        resin_type: (top as any).resin_type,
                        resin_code: (top as any).resin_code,
                        net_weight_g: (top as any).net_weight_g,
                        sr_weight_g: (top as any).sr_weight_g,
                        cycle_time_sec: (top as any).cycle_time_sec,
                        cavity: (top as any).cavity,
                        valid_from: (top as any).valid_from,
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
                  valid_from: (prefillData as any)?.valid_from || new Date().toISOString().slice(0,10),
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
                  valid_from: (prefillData as any)?.valid_from || new Date().toISOString().slice(0,10),
                });
                setShowAddPartModal(true);
                return;
              }
              setSelectedPartSpec(v as PartSpec);
              if (v && !('isAddNew' in v)) {
                setFormData((f) => ({ ...f, part_no: v.part_no, model: v.model_code }));
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
            onChange={(e)=>handleChange('supply_type', e.target.value)}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500 text-center"
          >
            <option value="JIT">{"JIT / 上线"}</option>
            <option value="CSK">CSKD</option>
            <option value="SVC">SVC</option>
            <option value="REWORK">{lang==='zh' ? '返工' : 'REWORK'}</option>
          </select>
        </div>
      </div>

      {/* 생산기록 / 불량기록 레이아웃 */}
      <div className={`grid grid-cols-1 gap-6 mt-2 items-stretch ${compact ? 'text-sm' : ''}`}>
        <Card className={`h-full flex flex-col ${compact ? 'col-span-2' : ''}`}>
          <CardHeader className={`font-semibold text-blue-700 ${compact ? 'text-base' : ''}`}>{t('production_record')}</CardHeader>
          <CardContent className="flex-1">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 시간 기록 섹션 카드 */}
              <Card className="border-indigo-200 md:order-2">
                <CardHeader className="py-2 font-medium text-indigo-700">{t('time_record')}</CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="flex flex-col">
                      <Label htmlFor="operation_time">{t('operation_time_min')}</Label>
                      <Input id="operation_time" type="number" inputMode="numeric" min={0} value={formData.operation_time as any} onChange={(e) => handleChange('operation_time', e.target.value === '' ? '' : Number(e.target.value||0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="idle_time">{t('idle_time_min')}</Label>
                      <Input id="idle_time" type="number" inputMode="numeric" min={0} value={formData.idle_time as any} onChange={(e) => handleChange('idle_time', e.target.value === '' ? '' : Number(e.target.value||0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="total_time">{t('total_time')}</Label>
                      <Input id="total_time" value={(formData.operation_time === '' && formData.idle_time === '') ? '' : (Number(formData.operation_time||0) + Number(formData.idle_time||0))} disabled className={`text-center bg-gray-100 ${compact ? 'h-8 text-sm px-2' : ''}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* 수량/인원 기록 섹션 카드 */}
              <Card className="border-teal-200 md:order-1">
                <CardHeader className="py-2 font-medium text-teal-700">{t('qty_personnel_record')}</CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="flex flex-col">
                      <Label htmlFor="plan_qty">{t('plan_qty_required')}</Label>
                      <Input id="plan_qty" type="number" inputMode="numeric" min={0} value={formData.plan_qty as any} onChange={(e) => handleChange('plan_qty', e.target.value === '' ? '' : Number(e.target.value||0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="actual_qty">{t('production_qty_required')}</Label>
                      <Input id="actual_qty" type="number" inputMode="numeric" min={0} value={formData.actual_qty as any} onChange={(e) => handleChange('actual_qty', e.target.value === '' ? '' : Number(e.target.value||0))} onFocus={selectOnFocus} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} required />
                    </div>
                    <div className="flex flex-col">
                      <Label htmlFor="workers">{t('worker_count')}</Label>
                      <Input id="workers" type="number" min={0} value={formData.workers as any} onChange={(e) => handleChange('workers', e.target.value === '' ? '' : Number(e.target.value))} onFocus={selectOnFocus} className="text-center" />
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
            {/* 아코디언: Incoming */}
            <Card className="border-green-200">
              <CardHeader className="py-2 font-medium text-green-700">
                <button
                  type="button"
                  className="w-full flex flex-row items-center justify-between cursor-pointer select-none"
                  onClick={() => setIncomingOpen(o => !o)}
                >
                  <span>{t('assembly_incoming_defect')}</span>
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
                        onChange={(e)=> { setDetailsDirty(true); setIncomingDefectsDetail(prev => ({...prev, [it.key]: e.target.value === '' ? '' : (Number(e.target.value) || 0)})); }} />
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>

            {/* 아코디언: Processing */}
            <Card className="border-amber-200">
              <CardHeader className="py-2 font-medium text-amber-700">
                <button
                  type="button"
                  className="w-full flex flex-row items-center justify-between cursor-pointer select-none"
                  onClick={() => setProcessingOpen(o => !o)}
                >
                  <span>{t('processing_defect')}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">{t('sum')}:</span>
                    <span className={`px-2 py-0.5 rounded-md font-semibold ${badgeClassFor(totalProcessing)}`}>{totalProcessing}</span>
                  </div>
                </button>
              </CardHeader>
              {processingOpen && (
                <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  {processingDefectItems.map(it => (
                    <div key={it.key} className="flex flex-col">
                      <Label className="text-gray-600">{it.key === 'other' ? t('def_processing_other') : t(`def_${it.key}`)}</Label>
                      <Input type="number" inputMode="numeric" min={0} className={`text-center ${compact ? 'h-8 text-sm px-2' : ''}`} value={processingDefectsDetail[it.key] as any} onFocus={selectOnFocus}
                        onChange={(e)=> { setDetailsDirty(true); setProcessingDefectsDetail(prev => ({...prev, [it.key]: e.target.value === '' ? '' : (Number(e.target.value) || 0)})); }} />
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>
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
                  <Label>UPH</Label>
                  <Input value={calculatedValues.uph} disabled className="text-center bg-green-50 font-semibold" />
                  <p className="text-xs text-gray-500 mt-1">{t('production_per_hour')}</p>
                </div>
                <div>
                  <Label>UPPH</Label>
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
                  permission="can_edit_machining"
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
            <p className="text-xs text-gray-500">{lang==='zh' ? '必填: Part No / Model Code / Description' : '필수: Part No / Model Code / Description'}</p>
            <div className="grid grid-cols-2 gap-3">
              {(() => {
                const isEdited = (k: string) => prefillOriginal && String(newPartForm[k] ?? '') !== String(prefillOriginal[k] ?? '');
                const editedCls = (k: string) => isEdited(k) ? ' bg-blue-50 border-blue-300' : '';
                const prefilledCls = (k: string) => (prefillOriginal && prefillOriginal[k] && k !== 'part_no') ? ' bg-yellow-50 border-yellow-300' : '';
                return (
                  <>
                    <input 
                      placeholder="Part No (MCK12345678…)" 
                      className={`border rounded px-2 py-1 col-span-2 bg-green-50 border-green-300`}
                      value={newPartForm.part_no}
                      onChange={(e)=> setNewPartForm((f: any)=> ({...f, part_no: e.target.value}))}
                    />
                    <input placeholder="Model Code (24TL510…)" className={`border rounded px-2 py-1 col-span-2${prefilledCls('model_code')}${editedCls('model_code')}`} value={newPartForm.model_code} onChange={(e)=> setNewPartForm((f:any)=> ({...f, model_code: e.target.value}))} />
                    <input placeholder="Description (C/A, B/C…)" className={`border rounded px-2 py-1 col-span-2${prefilledCls('description')}${editedCls('description')}`} value={newPartForm.description} onChange={(e)=> setNewPartForm((f:any)=> ({...f, description: e.target.value}))} />
                    <input placeholder="Mold Type" className={`border rounded px-2 py-1${prefilledCls('mold_type')}${editedCls('mold_type')}`} value={newPartForm.mold_type} onChange={(e)=> setNewPartForm((f:any)=> ({...f, mold_type: e.target.value}))} />
                    <input placeholder="Color" className={`border rounded px-2 py-1${prefilledCls('color')}${editedCls('color')}`} value={newPartForm.color} onChange={(e)=> setNewPartForm((f:any)=> ({...f, color: e.target.value}))} />
                    <input placeholder="Resin Type" className={`border rounded px-2 py-1${prefilledCls('resin_type')}${editedCls('resin_type')}`} value={newPartForm.resin_type} onChange={(e)=> setNewPartForm((f:any)=> ({...f, resin_type: e.target.value}))} />
                    <input placeholder="Resin Code" className={`border rounded px-2 py-1${prefilledCls('resin_code')}${editedCls('resin_code')}`} value={newPartForm.resin_code} onChange={(e)=> setNewPartForm((f:any)=> ({...f, resin_code: e.target.value}))} />
                    <input placeholder="Net(g)" className={`border rounded px-2 py-1${prefilledCls('net_weight_g')}${editedCls('net_weight_g')}`} value={newPartForm.net_weight_g} onChange={(e)=> setNewPartForm((f:any)=> ({...f, net_weight_g: e.target.value}))} />
                    <input placeholder="S/R(g)" className={`border rounded px-2 py-1${prefilledCls('sr_weight_g')}${editedCls('sr_weight_g')}`} value={newPartForm.sr_weight_g} onChange={(e)=> setNewPartForm((f:any)=> ({...f, sr_weight_g: e.target.value}))} />
                    <input placeholder="C/T(초)" className={`border rounded px-2 py-1${prefilledCls('cycle_time_sec')}${editedCls('cycle_time_sec')}`} value={newPartForm.cycle_time_sec} onChange={(e)=> setNewPartForm((f:any)=> ({...f, cycle_time_sec: e.target.value}))} />
                    <input placeholder="Cavity" className={`border rounded px-2 py-1${prefilledCls('cavity')}${editedCls('cavity')}`} value={newPartForm.cavity} onChange={(e)=> setNewPartForm((f:any)=> ({...f, cavity: e.target.value}))} />
                    <input type="date" className={`border rounded px-2 py-1${prefilledCls('valid_from')}${editedCls('valid_from')}`} value={newPartForm.valid_from} onChange={(e)=> setNewPartForm((f:any)=> ({...f, valid_from: e.target.value}))} />
                  </>
                );
              })()}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={()=>setShowAddPartModal(false)}>{t('cancel')}</Button>
              <Button size="sm" onClick={async()=>{
                try{
                  const partNo = String(newPartForm.part_no || '').trim();
                  const modelCode = String(newPartForm.model_code || '').trim();
                  const description = String(newPartForm.description || '').trim();
                  if (!partNo || !modelCode || !description) {
                    toast.error(lang==='zh' ? '请输入 Part No / Model Code / Description' : 'Part No / Model Code / Description을 입력하세요');
                    return;
                  }
                  // Optional spec fields은 현재 전송하지 않음

                  const newPart = await api.post('/assembly/partspecs/create-or-update/',{
                    part_no: partNo,
                    model_code: modelCode,
                    description: description
                  });
                  
                  toast.success(t('new_part_added_success'));
                  // 새 PartSpec 즉시 반영을 위해 관련 쿼리 무효화
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs-by-model'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-parts-by-model'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-products'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partno-search'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-part-search'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-model-search'] });
                  setShowAddPartModal(false);
                  
                  // 새로 생성된 Part를 자동으로 선택 (옵션 목록에 아직 없어도 즉시 폼 상태 갱신)
                  const createdPart = newPart.data || {};
                  const createdModelCode = createdPart.model_code || modelCode;
                  const createdDesc = createdPart.description || description || '';
                  setProductQuery(createdModelCode);
                  setFormData((f) => ({
                    ...f,
                    part_no: createdPart.part_no || partNo,
                    model: createdModelCode,
                  }));
                  // 모델 선택 상태 강제 설정(검색 목록에 아직 없어도 임시 옵션으로 표시)
                  const foundModelSpec = uniqueModelDesc.find((m) => m.model_code === createdModelCode && m.description === createdDesc);
                  if (foundModelSpec) {
                    setSelectedModelDesc(foundModelSpec);
                  } else {
                    setSelectedModelDesc({ id: -9998, part_no: '', model_code: createdModelCode, description: createdDesc } as any);
                  }
                  // Part 선택값도 즉시 반영(옵션 리스트 갱신 전이더라도 표시)
                  setSelectedPartSpec({ part_no: createdPart.part_no || partNo, model_code: createdModelCode, description: createdDesc } as any);
                }catch(err:any){
                  toast.error(t('save_fail'));
                }
              }}>{t('save')}</Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}