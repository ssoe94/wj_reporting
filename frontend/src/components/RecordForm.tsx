import React, { useState } from 'react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { useLang } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import PermissionButton from './common/PermissionButton';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { Autocomplete, TextField } from '@mui/material';
import { usePartSpecSearch, usePartListByModel } from '../hooks/usePartSpecs';
import type { PartSpec } from '../hooks/usePartSpecs';
import machines from '../constants/machines';
import api from '../lib/api';
import { PlusCircle, Plus } from 'lucide-react';

// Utility functions (moved here for now, consider extracting to utils/date)
const roundTo5 = (d: Date) => {
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
  return d;
};
const toLocalInput = (d: Date) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};
const nowStr = toLocalInput(roundTo5(new Date()));
const getLocalDate = () => {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};
const formatTime = (mins: number, _t: (k: string) => string, lang: string) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (lang === 'zh') {
    return `${h}小时 ${m}分 (${mins}分)`;
  }
  return `${h}시간 ${m}분 (${mins}분)`;
};

interface RecordFormProps {
  onSaved?: () => void; // 호출 측에서 저장 후 추가 동작이 필요할 때
}

const RecordForm: React.FC<RecordFormProps> = ({ onSaved }) => {
  const { t, lang } = useLang();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [productQuery, setProductQuery] = useState('');
  const [selectedModelDesc, setSelectedModelDesc] = useState<PartSpec | null>(null);
  const [selectedPartSpec, setSelectedPartSpec] = useState<PartSpec | null>(null);
  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [, setPrefillSimilar] = useState<Partial<PartSpec> | null>(null);
  const [newPartForm, setNewPartForm] = useState({
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
    valid_from: '',
  });
  const [prefillOriginal, setPrefillOriginal] = useState<any | null>(null);
  const { data: searchResults = [] } = usePartSpecSearch(productQuery.toUpperCase());
  const { data: modelParts = [] } = usePartListByModel(selectedModelDesc?.model_code);
  const uniqueModelDesc = React.useMemo(() => {
    const map = new Map<string, PartSpec>();
    searchResults.forEach((it) => {
      const key = `${it.model_code}|${it.description}`;
      if (!map.has(key)) map.set(key, it);
    });
    return Array.from(map.values());
  }, [searchResults]);

  const [form, setForm] = useState(() => ({
    date: getLocalDate(),
    machineId: '',
    model: '',
    type: '',
    partNo: '',
    plan: '',
    actual: '',
    reportedDefect: '',
    realDefect: '',
    resin: '',
    netG: '',
    srG: '',
    ct: '',
    start: nowStr,
    end: nowStr,
    idle: '',
    note: '',
  }));

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm({ ...form, [e.target.id]: e.target.value });

  const diffMinutes = () => {
    if (!form.start || !form.end) return 0;
    const startDate = new Date(form.start);
    const endDate = new Date(form.end);
    const diffMs = endDate.getTime() - startDate.getTime();
    return diffMs > 0 ? Math.floor(diffMs / 60000) : 0;
  };
  const totalMinutes = diffMinutes();
  const runMinutes = totalMinutes && form.idle ? totalMinutes - Number(form.idle) : 0;

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const requiredErrors: string[] = [];
    if (!form.machineId) requiredErrors.push('사출기를 선택하세요');
    if (!form.model.trim()) requiredErrors.push('모델명을 입력하세요');
    if (!form.type) requiredErrors.push('구분을 선택하세요');
    if (!form.plan) requiredErrors.push('계획수량을 입력하세요');
    if (!form.actual) requiredErrors.push('실제수량을 입력하세요');
    if (!form.start || !form.end) requiredErrors.push('시작·종료 시간을 입력하세요');
    if (requiredErrors.length) {
      toast.error(requiredErrors[0]);
      return;
    }

    try {
      const machine = machines.find((m) => String(m.id) === form.machineId);
      const payload = {
        date: form.date,
        machine_no: machine ? machine.id : 0,
        tonnage: machine ? `${machine.ton}` : '',
        model: form.model,
        section: form.type,
        plan_qty: Number(form.plan || 0),
        actual_qty: Number(form.actual || 0),
        reported_defect: Number(form.reportedDefect || 0),
        actual_defect: Number(form.realDefect || 0),
        start_datetime: form.start,
        end_datetime: form.end,
        total_time: totalMinutes,
        operation_time: runMinutes,
        part_no: form.partNo,
        note: form.note,
      };
      await api.post('/reports/', payload);
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: ['reports-summary'] });
      toast.success('저장되었습니다');
      if (onSaved) onSaved();
      setForm({
        ...form,
        date: getLocalDate(),
        model: '',
        type: '',
        plan: '',
        actual: '',
        reportedDefect: '',
        realDefect: '',
        start: nowStr,
        end: nowStr,
        idle: '',
        note: '',
      });
    } catch (err: any) {
      console.error(err);
      if (err.response?.status === 403) {
        const message = user?.username?.includes('chinese') || user?.department?.includes('中') 
          ? '您没有保存数据的权限' 
          : '데이터를 저장할 권한이 없습니다';
        toast.error(message);
      } else if (err.response?.status === 400 && err.response.data) {
        const firstMsg = Object.values(err.response.data)[0] as any;
        toast.error(Array.isArray(firstMsg) ? firstMsg[0] : String(firstMsg));
      } else {
        toast.error('저장 중 오류가 발생했습니다');
      }
    }
  };

  const totalPieces = Number(form.actual || 0) + Number((form.realDefect || form.reportedDefect) || 0);
  const runSeconds = runMinutes * 60;
  const shotCt = totalPieces > 0 ? runSeconds / totalPieces : 0;
  const goodCt = Number(form.actual) > 0 ? runSeconds / Number(form.actual) : 0;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-y-6">
      {/* ── (1) 상단: 보고일자 / 사출기 / 모델 검색 / Part No. ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        {/* 보고일자 */}
        <div>
          <Label htmlFor="date">{t('report_date')}</Label>
          <Input id="date" type="date" value={form.date} onChange={handleChange} className="text-center" />
        </div>
        {/* 사출기 */}
        <div>
          <Label htmlFor="machineId">{t('machine')}</Label>
          <select
            id="machineId"
            value={form.machineId}
            onChange={handleChange}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500 text-center"
          >
            <option value="">{t('select')}</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{`${m.id}${lang === 'zh' ? '号机' : '호기'} - ${m.ton}T`}</option>
            ))}
          </select>
        </div>
        {/* 모델 검색 */}
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
                  filtered = [ { id: -1, model_code: '', description: '' } as any, ...filtered ];
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
                setForm((f) => ({ ...f, model: v.model_code, type: v.description, partNo: '', resin: '', netG: '', srG: '', ct: '' }));
                setSelectedPartSpec(null);
              }
              if (v && (v as any).id === -1) {
                const raw = (productQuery || '').trim();
                const parts = raw.split(/\s+[–-]\s+/);
                const modelCode = (parts[0] || '').trim().toUpperCase();
                const desc = (parts[1] || '').trim();
                setShowAddPartModal(true);
                setTimeout(()=>{
                  try{
                    (document.getElementById('newModelCode') as HTMLInputElement).value = modelCode;
                    (document.getElementById('newDescription') as HTMLInputElement).value = desc;
                  }catch(_){/* no-op */}
                },50);
              }
            }}
            value={selectedModelDesc}
            renderInput={(params) => <TextField {...params} size="small" placeholder={t('model_search')} />}
          />
        </div>
        {/* Part No. */}
        <div>
          <Label>Part No.</Label>
          <Autocomplete<PartSpec | { isAddNew: boolean; part_no: string } | { isAddNewForModel: boolean }>
            options={(() => {
              const baseOptions = selectedModelDesc ? modelParts : searchResults;
              // 검색어가 2글자 이상이고 결과가 없으면 "새로 추가" 옵션 추가
              if (productQuery.trim().length >= 2 && baseOptions.length === 0) {
                return [{ isAddNew: true, part_no: productQuery.trim() } as any];
              }
              if (selectedModelDesc && baseOptions.length === 0) {
                return [{ isAddNewForModel: true } as any];
              }
              return baseOptions;
            })()}
            filterOptions={(opts, state) => {
              let filtered: any[] = opts.slice();
              if (selectedModelDesc) {
                filtered = filtered.filter((o: any) => ('isAddNew' in o) || ('isAddNewForModel' in o) ? true : o.model_code === selectedModelDesc.model_code);
              }
              const input = (state.inputValue || '').trim().toUpperCase();
              if (input) {
                filtered = filtered.filter((o: any) => ('isAddNew' in o) || ('isAddNewForModel' in o) ? true : String(o.part_no || '').toUpperCase().includes(input));
              }
              if (filtered.length === 0 && input) {
                return [{ isAddNew: true, part_no: input } as any];
              }
              return filtered;
            }}
            getOptionLabel={(opt) => {
              if ('isAddNew' in opt && (opt as any).isAddNew) {
                return (opt as any).part_no || '';
              }
              if ('isAddNewForModel' in opt && (opt as any).isAddNewForModel) {
                return productQuery.trim();
              }
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
                    list = (Array.isArray(data) ? data : []).map((it: any) => ({
                      ...it,
                      source_system: it?.source_system || 'assembly',
                    }));
                    list = list.filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9));
                    if (selectedModelDesc) {
                      const selectedCode = (selectedModelDesc.model_code || '').toUpperCase();
                      list = list.filter((it: any) => {
                        const candidateModel = String(it.model_code ?? it.model ?? '').toUpperCase();
                        return candidateModel === selectedCode;
                      });
                    }
                    if (list.length === 0) {
                      const res = await api.get('/parts/', { params: { search: prefix9, page_size: 10 } });
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
                    const first = list[0];
                    const sourceSystem = String(first?.source_system || '').toLowerCase();
                    const msg = t('similar_parts_prompt').replace('{first}', first.part_no).replace('{count}', String(list.length));
                    const ok = window.confirm(msg);
                    if (ok) {
                      let detail: any = first;
                      const maybeNumericId = typeof first?.id === 'number' || /^[0-9]+$/.test(String(first?.id || ''));
                      const needsEnhancement = (obj: any) =>
                        ['mold_type', 'color', 'resin_type', 'resin_code', 'net_weight_g', 'sr_weight_g', 'cycle_time_sec', 'cavity'].every(
                          (key) => obj[key] === null || typeof obj[key] === 'undefined' || obj[key] === ''
                        );
                      if (needsEnhancement(detail) && sourceSystem === 'injection' && maybeNumericId) {
                        const targetId = Number(first.id);
                        try {
                          const { data: detailData } = await api.get(`/injection/parts/${targetId}/`);
                          if (detailData) detail = detailData;
                        } catch (error: any) {
                          if (error?.response?.status !== 404) {
                            console.warn('Failed to fetch injection part spec detail for prefill', error);
                          }
                          try {
                            const { data: searchData } = await api.get('/parts/', {
                              params: { search: first.part_no, page_size: 1 },
                            });
                            const pick = Array.isArray(searchData?.results)
                              ? searchData.results.find((it: any) =>
                                  String(it.part_no || '').toUpperCase() === String(first.part_no || '').toUpperCase()
                                )
                              : null;
                            if (pick) detail = pick;
                          } catch (fallbackError: any) {
                            if (fallbackError?.response?.status !== 404) {
                              console.warn('Failed to fetch part spec detail for prefill', fallbackError);
                            }
                          }
                        }
                      } else if (needsEnhancement(detail) && sourceSystem === 'assembly' && maybeNumericId) {
                        try {
                          const { data: detailData } = await api.get(`/assembly/partspecs/${Number(first.id)}/`);
                          if (detailData) detail = detailData;
                        } catch (error: any) {
                          if (error?.response?.status !== 404) {
                            console.warn('Failed to fetch assembly part spec detail for prefill', error);
                          }
                        }
                      }
                      if (needsEnhancement(detail) && first?.part_no) {
                        try {
                          const { data: searchData } = await api.get('/parts/', {
                            params: { search: first.part_no, page_size: 1 },
                          });
                          const pick = Array.isArray(searchData?.results)
                            ? searchData.results.find((it: any) =>
                                String(it.part_no || '').toUpperCase() === String(first.part_no || '').toUpperCase()
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
                      prefillData = {
                        model_code: normalize(detail.model_code ?? detail.model ?? selectedModelDesc?.model_code ?? ''),
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
                      };
                    }
                  }
                } catch (_) {
                  prefillData = null;
                }
                setPrefillSimilar(prefillData);
                const baseForm = {
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
                };
                setNewPartForm(baseForm);
                setPrefillOriginal(baseForm);
                setShowAddPartModal(true);
                return;
              }
              
              setSelectedPartSpec(v as PartSpec);
              if (v && !('isAddNew' in v)) {
                setForm((f) => ({
                  ...f,
                  partNo: v.part_no,
                  model: v.model_code,
                  type: v.description,
                  resin: (v as any)?.resin_type || '',
                  netG: String((v as any)?.net_weight_g || ''),
                  srG: String((v as any)?.sr_weight_g || ''),
                  ct: String((v as any)?.cycle_time_sec || ''),
                }));
                const modelSpec = uniqueModelDesc.find((m) => m.model_code === v.model_code && m.description === v.description);
                if (modelSpec) {
                  setSelectedModelDesc(modelSpec);
                } else {
                  setSelectedModelDesc({ id: -9997, part_no: '', model_code: v.model_code, description: v.description || '' } as any);
                  setProductQuery(v.model_code || '');
                }
              }
            }}
            value={selectedPartSpec}
            renderOption={(props, option) => {
              const { key, ...rest } = props as any;
              if ('isAddNew' in option && option.isAddNew) {
                return (
                  <li key={key} {...rest} className="bg-blue-50 hover:bg-blue-100 border-t border-blue-200">
                    <div className="flex items-center justify-center gap-2 text-blue-700 font-medium py-2 text-sm">
                      <Plus className="h-3 w-3" />
                      <span>"{option.part_no}" 새 Part 추가</span>
                    </div>
                  </li>
                );
              }
              const spec = option as PartSpec;
              return (
                <li key={key} {...rest}>
                  <div className="flex flex-col">
                    <span className="font-mono font-medium">{spec.part_no}</span>
                    {spec.model_code && (
                      <span className="text-sm text-gray-600">{spec.model_code} - {spec.description}</span>
                    )}
                  </div>
                </li>
              );
            }}
            renderInput={(params) => <TextField {...params} size="small" placeholder={`Part No. ${t('input_or_select')}`} />}
          />
        </div>
      </div>

      {/* ── (2) Part Spec 선택 시 요약 카드 ── */}
      {selectedPartSpec && (
        <Card className="bg-slate-50">
          <CardHeader className="text-blue-700 font-semibold text-lg">
            {form.model} / {form.partNo}
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-10 text-base">
            {/* Left */}
            <div className="grid grid-cols-[120px_1fr] gap-y-2">
              <span className="text-gray-500">Resin</span>
              <span className="font-medium font-mono">{form.resin || '-'}</span>
              <span className="text-gray-500">Color</span>
              <span className="font-medium font-mono">{selectedPartSpec.color || '-'}</span>
              <span className="text-gray-500">기준 C/T(초)</span>
              <span className="font-medium font-mono">{form.ct}</span>
            </div>
            {/* Right */}
            <div className="grid grid-cols-[120px_1fr] gap-y-2">
              <span className="text-gray-500">Net Wt (g)</span>
              <span className="font-medium font-mono">{form.netG}</span>
              <span className="text-gray-500">S/R Wt (g)</span>
              <span className="font-medium font-mono">{form.srG}</span>
              <span className="text-gray-500">기준 불량률</span>
              <span className="font-medium font-mono">
                {selectedPartSpec.defect_rate_pct != null ? `${(selectedPartSpec.defect_rate_pct * 100).toFixed(1)}%` : '-'}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── (3) 2-컬럼 그리드: 생산 시간 / 생산 보고 ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4 items-stretch">
        {/* 생산 시간 */}
        <Card className="h-full flex flex-col">
          <CardHeader className="font-semibold text-blue-700">{t('prod_time')}</CardHeader>
          <CardContent className="flex-1 space-y-4">
            {/* 시작/종료 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col">
                <Label htmlFor="start">{t('start_dt')}</Label>
                <Input id="start" type="datetime-local" step={300} value={form.start} onChange={handleChange} className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="end">{t('end_dt')}</Label>
                <Input id="end" type="datetime-local" step={300} value={form.end} onChange={handleChange} className="text-center" />
              </div>
            </div>
            {/* 총시간/부동시간 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col">
                <Label>{t('total_time')}</Label>
                <Input value={formatTime(totalMinutes, t, lang)} disabled className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="idle">{t('idle_time')}</Label>
                <Input id="idle" type="number" value={form.idle} onChange={handleChange} className="text-center" />
              </div>
            </div>
            {/* 부동시간 비고 */}
            <div className="flex flex-col">
              <Label htmlFor="note">{t('idle_note')}</Label>
              <Input id="note" type="text" value={form.note} onChange={handleChange} />
            </div>
            {/* 가동시간 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 flex flex-col">
                <Label>{t('run_time')}</Label>
                <Input value={formatTime(runMinutes, t, lang)} disabled className="text-center" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 생산 보고 입력 */}
        <Card className="h-full flex flex-col">
          <CardHeader className="font-semibold text-blue-700">{t('prod_report')}</CardHeader>
          <CardContent className="flex-1 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col">
                <Label htmlFor="plan">{t('plan_qty')}</Label>
                <Input id="plan" type="number" value={form.plan} onChange={handleChange} className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="actual">{t('actual_qty')}</Label>
                <Input id="actual" type="number" value={form.actual} onChange={handleChange} className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="reportedDefect">{t('reported_defect')}</Label>
                <Input id="reportedDefect" type="number" value={form.reportedDefect} onChange={handleChange} className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="realDefect">{t('actual_defect')}</Label>
                <Input id="realDefect" type="number" value={form.realDefect} onChange={handleChange} className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label>{t('total_pieces')}</Label>
                <Input value={totalPieces} disabled className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label>{t('shot_ct')}</Label>
                <Input value={shotCt.toFixed(1)} disabled className="text-center" />
              </div>
              <div className="flex flex-col">
                <Label>{t('good_ct')}</Label>
                <Input value={goodCt.toFixed(1)} disabled className="text-center" />
              </div>
            </div>
            <div className="flex justify-end">
              <PermissionButton
                permission="can_edit_injection"
                type="submit"
                className="px-3 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-all duration-200 inline-flex items-center gap-2 whitespace-nowrap"
              >
                <PlusCircle className="h-4 w-4 shrink-0" />
                <span>{t('save')}</span>
              </PermissionButton>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add Part Modal */}
      {showAddPartModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">새 Part Spec 추가</h3>
            <p className="text-xs text-gray-500">필수: Part No / Model Code / Description</p>
            <div className="grid grid-cols-2 gap-3">
              {(() => {
                const isEdited = (k: string) => prefillOriginal && String(newPartForm[k as keyof typeof newPartForm] ?? '') !== String(prefillOriginal[k] ?? '');
                const editedCls = (k: string) => isEdited(k) ? ' bg-blue-50 border-blue-300' : '';
                const prefilledCls = (k: string) => (prefillOriginal && prefillOriginal[k] && k !== 'part_no') ? ' bg-yellow-50 border-yellow-300' : '';
                return (
                  <>
                    <input
                      placeholder="Part No (MCK12345678…)"
                      className={`border rounded px-2 py-1 col-span-2 bg-green-50 border-green-300${editedCls('part_no')}`}
                      value={newPartForm.part_no}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, part_no: e.target.value }))}
                    />
                    <input
                      placeholder="Model Code (24TL510…)"
                      className={`border rounded px-2 py-1 col-span-2${prefilledCls('model_code')}${editedCls('model_code')}`}
                      value={newPartForm.model_code}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, model_code: e.target.value }))}
                    />
                    <input
                      placeholder="Description (C/A, B/C…)"
                      className={`border rounded px-2 py-1 col-span-2${prefilledCls('description')}${editedCls('description')}`}
                      value={newPartForm.description}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, description: e.target.value }))}
                    />
                    <input
                      placeholder="Mold Type"
                      className={`border rounded px-2 py-1${prefilledCls('mold_type')}${editedCls('mold_type')}`}
                      value={newPartForm.mold_type}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, mold_type: e.target.value }))}
                    />
                    <input
                      placeholder="Color"
                      className={`border rounded px-2 py-1${prefilledCls('color')}${editedCls('color')}`}
                      value={newPartForm.color}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, color: e.target.value }))}
                    />
                    <input
                      placeholder="Resin Type"
                      className={`border rounded px-2 py-1${prefilledCls('resin_type')}${editedCls('resin_type')}`}
                      value={newPartForm.resin_type}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, resin_type: e.target.value }))}
                    />
                    <input
                      placeholder="Resin Code"
                      className={`border rounded px-2 py-1${prefilledCls('resin_code')}${editedCls('resin_code')}`}
                      value={newPartForm.resin_code}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, resin_code: e.target.value }))}
                    />
                    <input
                      placeholder="Net(g)"
                      className={`border rounded px-2 py-1${prefilledCls('net_weight_g')}${editedCls('net_weight_g')}`}
                      value={newPartForm.net_weight_g}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, net_weight_g: e.target.value }))}
                    />
                    <input
                      placeholder="S/R(g)"
                      className={`border rounded px-2 py-1${prefilledCls('sr_weight_g')}${editedCls('sr_weight_g')}`}
                      value={newPartForm.sr_weight_g}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, sr_weight_g: e.target.value }))}
                    />
                    <input
                      placeholder="C/T(초)"
                      className={`border rounded px-2 py-1${prefilledCls('cycle_time_sec')}${editedCls('cycle_time_sec')}`}
                      value={newPartForm.cycle_time_sec}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, cycle_time_sec: e.target.value }))}
                    />
                    <input
                      placeholder="Cavity"
                      className={`border rounded px-2 py-1${prefilledCls('cavity')}${editedCls('cavity')}`}
                      value={newPartForm.cavity}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, cavity: e.target.value }))}
                    />
                    <input
                      type="date"
                      className={`border rounded px-2 py-1${prefilledCls('valid_from')}${editedCls('valid_from')}`}
                      value={newPartForm.valid_from}
                      onChange={(e) => setNewPartForm((f) => ({ ...f, valid_from: e.target.value }))}
                    />
                  </>
                );
              })()}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowAddPartModal(false)}>취소</Button>
              <PermissionButton
                permission="can_edit_injection"
                className="px-3 py-1 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-all duration-200"
                onClick={async () => {
                  try {
                    const partNo = newPartForm.part_no.trim();
                    const modelCode = newPartForm.model_code.trim();
                    const description = newPartForm.description.trim();
                    if (!partNo || !modelCode || !description) {
                      toast.error('Part No / Model Code / Description을 입력하세요');
                      return;
                    }
                    const newPart = await api.post('/parts/', {
                      part_no: partNo,
                      model_code: modelCode,
                      description,
                      mold_type: newPartForm.mold_type || undefined,
                      color: newPartForm.color || undefined,
                      resin_type: newPartForm.resin_type || undefined,
                      resin_code: newPartForm.resin_code || undefined,
                      net_weight_g: newPartForm.net_weight_g ? Number(newPartForm.net_weight_g) : null,
                      sr_weight_g: newPartForm.sr_weight_g ? Number(newPartForm.sr_weight_g) : null,
                      cycle_time_sec: newPartForm.cycle_time_sec ? Number(newPartForm.cycle_time_sec) : null,
                      cavity: newPartForm.cavity ? Number(newPartForm.cavity) : null,
                      valid_from: newPartForm.valid_from || undefined,
                    });

                    toast.success('새 Part가 추가되었습니다');
                    queryClient.invalidateQueries({ queryKey: ['parts-all'] });
                    queryClient.invalidateQueries({ queryKey: ['parts-search'] });
                    setShowAddPartModal(false);

                    const createdPart = newPart.data;
                    setSelectedPartSpec(createdPart);
                    setForm((f) => ({
                      ...f,
                      partNo: createdPart.part_no,
                      model: createdPart.model_code,
                      type: createdPart.description || '',
                      resin: createdPart.resin_type || '',
                      netG: String(createdPart.net_weight_g || ''),
                      srG: String(createdPart.sr_weight_g || ''),
                      ct: String(createdPart.cycle_time_sec || ''),
                    }));
                  } catch (err: any) {
                    if (err.response?.status === 403) {
                      const message = user?.username?.includes('chinese') || user?.department?.includes('中')
                        ? '您没有创建新零件的权限'
                        : '새 부품을 생성할 권한이 없습니다';
                      toast.error(message);
                    } else {
                      toast.error('저장 실패');
                    }
                  }
                }}
              >
                저장
              </PermissionButton>
            </div>
          </div>
        </div>
      )}
    </form>
  );
};

export default RecordForm; 
