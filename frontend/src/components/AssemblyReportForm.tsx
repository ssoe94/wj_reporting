import { useState } from 'react';
import { format } from 'date-fns';
import { Button } from './ui/button';
import PermissionButton from './common/PermissionButton';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Autocomplete, TextField } from '@mui/material';
import type { AssemblyReport } from '../types/assembly';
import { useLang } from '../i18n';
import { usePartSpecSearch, usePartListByModel } from '../hooks/usePartSpecs';
import { useAssemblyPartsByModel, useAssemblyPartspecsByModel } from '../hooks/useAssemblyParts';
import type { PartSpec } from '../hooks/usePartSpecs';
import { Plus, PlusCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import React from 'react';

interface AssemblyReportFormProps {
  onSubmit: (data: Omit<AssemblyReport, 'id'>) => void;
  initialData?: AssemblyReport;
  isLoading?: boolean;
}

export default function AssemblyReportForm({ onSubmit, isLoading }: AssemblyReportFormProps) {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const [productQuery, setProductQuery] = useState('');
  const [selectedModelDesc, setSelectedModelDesc] = useState<PartSpec | null>(null);
  const [selectedPartSpec, setSelectedPartSpec] = useState<PartSpec | null>(null);
  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [prefillSimilar, setPrefillSimilar] = useState<Partial<PartSpec> | null>(null);
  const { data: searchResults = [] } = usePartSpecSearch(productQuery.toUpperCase());
  const { data: modelParts = [] } = usePartListByModel(selectedModelDesc?.model_code);
  const { data: asmPartsByModel = [] } = useAssemblyPartsByModel(selectedModelDesc?.model_code);
  const { data: asmPartspecsByModel = [] } = useAssemblyPartspecsByModel(selectedModelDesc?.model_code);
  
  const uniqueModelDesc = React.useMemo(() => {
    const map = new Map<string, PartSpec>();
    searchResults.forEach((it) => {
      const key = `${it.model_code}|${it.description}`;
      if (!map.has(key)) map.set(key, it);
    });
    return Array.from(map.values());
  }, [searchResults]);

  const [formData, setFormData] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    line_no: '',
    part_no: '',
    model: '',
    plan_qty: 0,
    input_qty: 0, // 투입수량
    actual_qty: 0, // 생산수량 
    injection_defect: 0, // 입고불량-사출
    outsourcing_defect: 0, // 입고불량-외주
    processing_defect: 0, // 가공불량
    total_time: 0, // 총시간(분)
    idle_time: 0, // 부동시간(분)
    operation_time: 0, // 작업시간(분) - 계산됨
    workers: 1, // 작업인원
    note: '',
  });

  // 자동 계산 로직
  const calculatedValues = React.useMemo(() => {
    const totalDefects = formData.injection_defect + formData.outsourcing_defect + formData.processing_defect;
    const incomingDefects = formData.injection_defect + formData.outsourcing_defect;
    const actualOperationTime = formData.total_time - formData.idle_time; // 작업시간 = 총시간 - 부동시간
    
    // UPH = 생산수량 / 작업시간(시간)
    const uph = actualOperationTime > 0 ? Math.round((formData.actual_qty / (actualOperationTime / 60)) * 100) / 100 : 0;
    
    // UPPH = 생산수량 / (작업시간(시간) × 작업인원)
    const upph = (actualOperationTime > 0 && formData.workers > 0) ? 
      Math.round((formData.actual_qty / ((actualOperationTime / 60) * formData.workers)) * 100) / 100 : 0;
    
    // 가동률 = 작업시간 / 총시간 × 100
    const operationRate = formData.total_time > 0 ? 
      Math.round((actualOperationTime / formData.total_time) * 100 * 100) / 100 : 0;
    
    // 생산달성률 = 생산수량 / 계획수량 × 100  
    const achievementRate = formData.plan_qty > 0 ? 
      Math.round((formData.actual_qty / formData.plan_qty) * 100 * 100) / 100 : 0;

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

  const handleChange = (field: string, value: any) => {
    setFormData(prev => {
      const newData = { ...prev, [field]: value };
      
      // 작업시간 자동 계산
      if (field === 'total_time' || field === 'idle_time') {
        newData.operation_time = Math.max(0, newData.total_time - newData.idle_time);
      }
      
      return newData;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 기본 정보 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <Label htmlFor="date">{t('report_date')} *</Label>
          <Input
            type="date"
            value={formData.date}
            onChange={(e) => handleChange('date', e.target.value)}
            required
          />
        </div>

        <div>
          <Label htmlFor="line_no">{t('assembly_line_no')}</Label>
          <select
            id="line_no"
            value={formData.line_no}
            onChange={(e) => handleChange('line_no', e.target.value)}
            className="block w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 transition"
          >
            <option value="">{t('line_select')}</option>
            <option value="Line A">Line A</option>
            <option value="Line B">Line B</option>
            <option value="Line C">Line C</option>
            <option value="Line D">Line D</option>
          </select>
        </div>

        {/* 모델 검색 */}
        <div>
          <Label>{t('model_search')}</Label>
          <Autocomplete<PartSpec>
            options={uniqueModelDesc}
            getOptionLabel={(opt) => `${opt.model_code} – ${opt.description}`}
            onInputChange={(_, v) => setProductQuery(v)}
            onChange={(_, v) => {
              setSelectedModelDesc(v);
              if (v) {
                setFormData((f) => ({ ...f, model: v.model_code, part_no: '' }));
                setSelectedPartSpec(null);
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
              const baseOptions = selectedModelDesc
                ? (modelParts.length
                    ? modelParts
                    : ((asmPartspecsByModel as any).length ? (asmPartspecsByModel as any) : (asmPartsByModel as any)))
                : searchResults;
              // 검색어가 2글자 이상이고 결과가 없으면 "새로 추가" 옵션 추가
              if (productQuery.trim().length >= 2 && baseOptions.length === 0) {
                return [{ isAddNew: true, part_no: productQuery.trim() } as any];
              }
              // 모델은 선택했지만 해당 모델의 Part가 전혀 없을 때
              if (selectedModelDesc && baseOptions.length === 0) {
                return [{ isAddNewForModel: true } as any];
              }
              return baseOptions;
            })()}
            openOnFocus
            loading={!selectedModelDesc ? false : (Array.isArray(modelParts) ? false : true)}
            filterOptions={(opts, state) => {
              let filtered: any[] = opts.slice();
              // 1) 모델 코드로 1차 필터
              if (selectedModelDesc) {
                filtered = filtered.filter((o: any) => ('isAddNew' in o) || ('isAddNewForModel' in o) ? true : o.model_code === selectedModelDesc.model_code);
              }
              // 2) 입력 텍스트로 2차 필터 (부분일치)
              const input = (state.inputValue || '').trim().toUpperCase();
              if (input) {
                filtered = filtered.filter((o: any) => ('isAddNew' in o) || ('isAddNewForModel' in o) ? true : String(o.part_no || '').toUpperCase().includes(input));
              }
              // 3) 완전 무결과면 "추가" 옵션 제공
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
                try {
                  const desired = (productQuery || '').trim();
                  // 유사 Part 탐색: "맨앞 9자리"가 일치하는 항목만
                  const norm = desired.replace(/\s+/g, '').toUpperCase();
                  const prefix9 = norm.slice(0, 9);
                  let list: any[] = [];
                  if (prefix9.length === 9) {
                    // 1차: assembly 파트 검색
                    const { data } = await api.get('/assembly/products/search-parts/', { params: { search: prefix9, prefix_only: 1 } });
                    let all = Array.isArray(data) ? data : [];
                    list = all.filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9));
                    if (selectedModelDesc) list = list.filter((it: any) => it.model === selectedModelDesc.model_code);
                    // 2차: 없으면 injection 파트 스펙에서 검색
                    if (list.length === 0) {
                      const res = await api.get('/parts/', { params: { search: prefix9, page_size: 10 } });
                      const inj = Array.isArray(res?.data?.results) ? res.data.results : [];
                      list = inj
                        .filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9))
                        .map((it: any) => ({ part_no: it.part_no, model: it.model_code, description: it.description }));
                      if (selectedModelDesc) list = list.filter((it: any) => it.model === selectedModelDesc.model_code);
                    }
                  }
                  setPrefillSimilar(null);
                  if (list.length > 0) {
                    // 첫 후보 사용 (맨앞 9자리 동일 집합)
                    const top = list[0];
                    const promptText = t('similar_parts_prompt')
                      .replace('{first}', top.part_no)
                      .replace('{count}', String(list.length));
                    const ok = window.confirm(promptText);
                    if (ok) setPrefillSimilar({ model_code: top.model, description: top.description } as any);
                  }
                } catch (_) {
                  setPrefillSimilar(null);
                }
                setShowAddPartModal(true);
                return;
              }
              
              setSelectedPartSpec(v as PartSpec);
              if (v && !('isAddNew' in v)) {
                setFormData((f) => ({
                  ...f,
                  part_no: v.part_no,
                  model: v.model_code,
                }));
                const modelSpec = uniqueModelDesc.find((m) => m.model_code === v.model_code && m.description === v.description);
                if (modelSpec) setSelectedModelDesc(modelSpec);
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

      {/* 생산 수량 정보 */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-green-700">{t('production_qty_section')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <div>
            <Label htmlFor="plan_qty">{t('plan_qty_required')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.plan_qty}
              onChange={(e) => handleChange('plan_qty', Number(e.target.value))}
              required
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="input_qty">{t('input_qty')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.input_qty}
              onChange={(e) => handleChange('input_qty', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="actual_qty">{t('production_qty_required')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.actual_qty}
              onChange={(e) => handleChange('actual_qty', Number(e.target.value))}
              required
              className="text-center bg-blue-50"
            />
          </div>

          <div>
            <Label htmlFor="injection_defect">{t('incoming_defect_injection')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.injection_defect}
              onChange={(e) => handleChange('injection_defect', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="outsourcing_defect">{t('incoming_defect_outsourcing')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.outsourcing_defect}
              onChange={(e) => handleChange('outsourcing_defect', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="processing_defect">{t('processing_defect')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.processing_defect}
              onChange={(e) => handleChange('processing_defect', Number(e.target.value))}
              className="text-center"
            />
          </div>
        </div>
      </div>

      {/* 시간 및 인원 정보 */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-green-700">{t('time_and_personnel')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <Label htmlFor="total_time">{t('total_time_min_required')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.total_time}
              onChange={(e) => handleChange('total_time', Number(e.target.value))}
              required
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="idle_time">{t('idle_time_min')}</Label>
            <Input
              type="number"
              min="0"
              value={formData.idle_time}
              onChange={(e) => handleChange('idle_time', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label>{t('operation_time_min')}</Label>
            <Input
              type="number"
              value={calculatedValues.actualOperationTime}
              disabled
              className="text-center bg-gray-100"
            />
          </div>

          <div>
            <Label>{t('uptime_rate')}</Label>
            <Input
              type="number"
              value={calculatedValues.operationRate}
              disabled
              className="text-center bg-gray-100"
            />
          </div>

          <div>
            <Label htmlFor="workers">{t('worker_count')}</Label>
            <Input
              type="number"
              min="1"
              value={formData.workers}
              onChange={(e) => handleChange('workers', Number(e.target.value))}
              className="text-center"
            />
          </div>
        </div>
      </div>

      {/* 자동 계산 지표 */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-green-700">{t('performance_indicators')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <Label>UPH</Label>
            <Input
              value={calculatedValues.uph}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">{t('production_per_hour')}</p>
          </div>

          <div>
            <Label>UPPH</Label>
            <Input
              value={calculatedValues.upph}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">{t('production_per_person_hour')}</p>
          </div>

          <div>
            <Label>{t('operation_rate_percent')}</Label>
            <Input
              value={calculatedValues.operationRate}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">{t('operation_time_ratio')}</p>
          </div>

          <div>
            <Label>{t('production_achievement_rate')}</Label>
            <Input
              value={calculatedValues.achievementRate}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">{t('production_vs_plan')}</p>
          </div>
        </div>

        {/* 요약 정보 */}
        <div className="bg-green-50 p-4 rounded-lg">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="font-medium text-green-700">{t('total_defect_colon')}</span>
              <span className="ml-2 font-semibold">{calculatedValues.totalDefects}개</span>
            </div>
            <div>
              <span className="font-medium text-green-700">{t('incoming_defect_colon')}</span>
              <span className="ml-2 font-semibold">{calculatedValues.incomingDefects}개</span>
            </div>
            <div>
              <span className="font-medium text-green-700">{t('processing_defect_rate')}</span>
              <span className="ml-2 font-semibold">
                {formData.actual_qty > 0 ? 
                  Math.round((formData.processing_defect / formData.actual_qty) * 100 * 100) / 100 : 0}%
              </span>
            </div>
          </div>
        </div>
      </div>


      {/* 비고 */}
      <div>
        <Label htmlFor="note">{t('header_note')}</Label>
        <Textarea
          placeholder={t('note_placeholder')}
          rows={3}
          value={formData.note}
          onChange={(e) => handleChange('note', e.target.value)}
        />
      </div>

      {/* 제출 버튼 */}
      <div className="flex justify-end space-x-4">
        <PermissionButton
          permission="can_edit_machining"
          type="submit"
          className="px-3 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-all duration-200 inline-flex items-center gap-2 whitespace-nowrap"
          disabled={isLoading}
        >
          {!isLoading && <PlusCircle className="h-4 w-4 shrink-0" />}
          {isLoading ? t('saving') : t('save')}
        </PermissionButton>
      </div>

      {/* Add Part Modal */}
      {showAddPartModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">{t('add_new_part_spec')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <input 
                placeholder="Part No" 
                className="border rounded px-2 py-1 col-span-2" 
                defaultValue={productQuery}
                id="assemblyNewPartNo"
              />
              <input placeholder="Model Code" className="border rounded px-2 py-1 col-span-2" id="assemblyNewModelCode" defaultValue={selectedModelDesc?.model_code || prefillSimilar?.model_code || ''}/>
              <input placeholder="Description" className="border rounded px-2 py-1 col-span-2" id="assemblyNewDescription" defaultValue={prefillSimilar?.description || selectedModelDesc?.description || ''}/>
              <input placeholder="Mold Type" className="border rounded px-2 py-1" id="assemblyNewMoldType" defaultValue={(prefillSimilar as any)?.mold_type || ''}/>
              <input placeholder="Color" className="border rounded px-2 py-1" id="assemblyNewColor" defaultValue={(prefillSimilar as any)?.color || ''}/>
              <input placeholder="Resin Type" className="border rounded px-2 py-1" id="assemblyNewResinType" defaultValue={(prefillSimilar as any)?.resin_type || ''}/>
              <input placeholder="Resin Code" className="border rounded px-2 py-1" id="assemblyNewResinCode" defaultValue={(prefillSimilar as any)?.resin_code || ''}/>
              <input placeholder="Net(g)" className="border rounded px-2 py-1" id="assemblyNewNetWeight" defaultValue={((prefillSimilar as any)?.net_weight_g ?? '') as any}/>
              <input placeholder="S/R(g)" className="border rounded px-2 py-1" id="assemblyNewSrWeight" defaultValue={((prefillSimilar as any)?.sr_weight_g ?? '') as any}/>
              <input placeholder="C/T(초)" className="border rounded px-2 py-1" id="assemblyNewCycleTime" defaultValue={((prefillSimilar as any)?.cycle_time_sec ?? '') as any}/>
              <input placeholder="Cavity" className="border rounded px-2 py-1" id="assemblyNewCavity" defaultValue={((prefillSimilar as any)?.cavity ?? '') as any}/>
              <input type="date" className="border rounded px-2 py-1" defaultValue={((prefillSimilar as any)?.valid_from || new Date().toISOString().slice(0,10)) as any} id="assemblyNewValidFrom"/>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={()=>setShowAddPartModal(false)}>{t('cancel')}</Button>
              <Button size="sm" onClick={async()=>{
                try{
                  const partNo = (document.getElementById('assemblyNewPartNo') as HTMLInputElement).value;
                  const modelCode = (document.getElementById('assemblyNewModelCode') as HTMLInputElement).value;
                  const description = (document.getElementById('assemblyNewDescription') as HTMLInputElement).value;
                  // Optional spec fields are currently not sent; keep inputs for UX but omit unused variables

                  const newPart = await api.post('/api/assembly/partspecs/create-or-update/',{
                    part_no: partNo,
                    model_code: modelCode,
                    description: description
                  });
                  
                  toast.success(t('new_part_added_success'));
                  queryClient.invalidateQueries({queryKey:['assembly-partspecs']});
                  queryClient.invalidateQueries({queryKey:['assembly-partno-search']});
                  setShowAddPartModal(false);
                  
                  // 새로 생성된 Part를 자동으로 선택
                  const createdPart = newPart.data;
                  setSelectedPartSpec(createdPart);
                  setFormData((f) => ({
                    ...f,
                    part_no: createdPart.part_no,
                    model: createdPart.model_code,
                  }));
                  const modelSpec = uniqueModelDesc.find((m) => m.model_code === createdPart.model_code && m.description === createdPart.description);
                  if (modelSpec) setSelectedModelDesc(modelSpec);
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