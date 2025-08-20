import { useState } from 'react';
import { format } from 'date-fns';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Autocomplete, TextField } from '@mui/material';
import type { AssemblyReport } from '../types/assembly';
import { useLang } from '../i18n';
import { usePartSpecSearch, usePartListByModel } from '../hooks/usePartSpecs';
import type { PartSpec } from '../hooks/usePartSpecs';
import { Plus } from 'lucide-react';
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
            <option value="">라인 선택</option>
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
          <Autocomplete<PartSpec | { isAddNew: boolean; part_no: string }>
            options={(() => {
              const baseOptions = selectedModelDesc ? modelParts : searchResults;
              // 검색어가 2글자 이상이고 결과가 없으면 "새로 추가" 옵션 추가
              if (productQuery.trim().length >= 2 && baseOptions.length === 0) {
                return [{ isAddNew: true, part_no: productQuery.trim() } as any];
              }
              return baseOptions;
            })()}
            getOptionLabel={(opt) => {
              if ('isAddNew' in opt && opt.isAddNew) {
                return `➕ "${opt.part_no}" 새 Part 추가`;
              }
              return `${opt.part_no}`;
            }}
            onInputChange={(_, v) => setProductQuery(v)}
            onChange={(_, v) => {
              if (v && 'isAddNew' in v && v.isAddNew) {
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
              if ('isAddNew' in option && option.isAddNew) {
                return (
                  <li {...props} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                    <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                      <Plus className="h-3 w-3" />
                      <span>"{option.part_no}" 새 Part 추가</span>
                    </div>
                  </li>
                );
              }
              return (
                <li {...props}>
                  <div className="flex flex-col">
                    <span className="font-mono font-medium">{option.part_no}</span>
                    {option.model_code && (
                      <span className="text-sm text-gray-600">{option.model_code} - {option.description}</span>
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
        <h3 className="text-lg font-medium text-green-700">생산 수량</h3>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <div>
            <Label htmlFor="plan_qty">계획수량 *</Label>
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
            <Label htmlFor="input_qty">투입수량</Label>
            <Input
              type="number"
              min="0"
              value={formData.input_qty}
              onChange={(e) => handleChange('input_qty', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="actual_qty">생산수량 *</Label>
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
            <Label htmlFor="injection_defect">입고불량-사출</Label>
            <Input
              type="number"
              min="0"
              value={formData.injection_defect}
              onChange={(e) => handleChange('injection_defect', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="outsourcing_defect">입고불량-외주</Label>
            <Input
              type="number"
              min="0"
              value={formData.outsourcing_defect}
              onChange={(e) => handleChange('outsourcing_defect', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label htmlFor="processing_defect">가공불량</Label>
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
        <h3 className="text-lg font-medium text-green-700">시간 및 인원</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <Label htmlFor="total_time">총시간 (분) *</Label>
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
            <Label htmlFor="idle_time">부동시간 (분)</Label>
            <Input
              type="number"
              min="0"
              value={formData.idle_time}
              onChange={(e) => handleChange('idle_time', Number(e.target.value))}
              className="text-center"
            />
          </div>

          <div>
            <Label>작업시간 (분)</Label>
            <Input
              type="number"
              value={calculatedValues.actualOperationTime}
              disabled
              className="text-center bg-gray-100"
            />
          </div>

          <div>
            <Label htmlFor="workers">작업인원 (명)</Label>
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
        <h3 className="text-lg font-medium text-green-700">성과 지표</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <Label>UPH</Label>
            <Input
              value={calculatedValues.uph}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">시간당 생산량</p>
          </div>

          <div>
            <Label>UPPH</Label>
            <Input
              value={calculatedValues.upph}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">인당 시간당 생산량</p>
          </div>

          <div>
            <Label>가동률 (%)</Label>
            <Input
              value={calculatedValues.operationRate}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">작업시간/총시간</p>
          </div>

          <div>
            <Label>생산달성률 (%)</Label>
            <Input
              value={calculatedValues.achievementRate}
              disabled
              className="text-center bg-green-50 font-semibold"
            />
            <p className="text-xs text-gray-500 mt-1">생산/계획수량</p>
          </div>
        </div>

        {/* 요약 정보 */}
        <div className="bg-green-50 p-4 rounded-lg">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="font-medium text-green-700">총 불량:</span>
              <span className="ml-2 font-semibold">{calculatedValues.totalDefects}개</span>
            </div>
            <div>
              <span className="font-medium text-green-700">입고 불량:</span>
              <span className="ml-2 font-semibold">{calculatedValues.incomingDefects}개</span>
            </div>
            <div>
              <span className="font-medium text-green-700">가공 불량률:</span>
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
          placeholder="추가 정보나 특이사항을 입력하세요"
          rows={3}
          value={formData.note}
          onChange={(e) => handleChange('note', e.target.value)}
        />
      </div>

      {/* 제출 버튼 */}
      <div className="flex justify-end space-x-4">
        <Button type="submit" disabled={isLoading}>
          {isLoading ? t('saving') : t('save')}
        </Button>
      </div>

      {/* Add Part Modal */}
      {showAddPartModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">새 Part Spec 추가</h3>
            <div className="grid grid-cols-2 gap-3">
              <input 
                placeholder="Part No" 
                className="border rounded px-2 py-1 col-span-2" 
                defaultValue={productQuery}
                id="assemblyNewPartNo"
              />
              <input placeholder="Model Code" className="border rounded px-2 py-1 col-span-2" id="assemblyNewModelCode"/>
              <input placeholder="Description" className="border rounded px-2 py-1 col-span-2" id="assemblyNewDescription"/>
              <input placeholder="Mold Type" className="border rounded px-2 py-1" id="assemblyNewMoldType"/>
              <input placeholder="Color" className="border rounded px-2 py-1" id="assemblyNewColor"/>
              <input placeholder="Resin Type" className="border rounded px-2 py-1" id="assemblyNewResinType"/>
              <input placeholder="Resin Code" className="border rounded px-2 py-1" id="assemblyNewResinCode"/>
              <input placeholder="Net(g)" className="border rounded px-2 py-1" id="assemblyNewNetWeight"/>
              <input placeholder="S/R(g)" className="border rounded px-2 py-1" id="assemblyNewSrWeight"/>
              <input placeholder="C/T(초)" className="border rounded px-2 py-1" id="assemblyNewCycleTime"/>
              <input placeholder="Cavity" className="border rounded px-2 py-1" id="assemblyNewCavity"/>
              <input type="date" className="border rounded px-2 py-1" defaultValue={new Date().toISOString().slice(0,10)} id="assemblyNewValidFrom"/>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={()=>setShowAddPartModal(false)}>취소</Button>
              <Button size="sm" onClick={async()=>{
                try{
                  const partNo = (document.getElementById('assemblyNewPartNo') as HTMLInputElement).value;
                  const modelCode = (document.getElementById('assemblyNewModelCode') as HTMLInputElement).value;
                  const description = (document.getElementById('assemblyNewDescription') as HTMLInputElement).value;
                  const moldType = (document.getElementById('assemblyNewMoldType') as HTMLInputElement).value;
                  const color = (document.getElementById('assemblyNewColor') as HTMLInputElement).value;
                  const resinType = (document.getElementById('assemblyNewResinType') as HTMLInputElement).value;
                  const resinCode = (document.getElementById('assemblyNewResinCode') as HTMLInputElement).value;
                  const netWeight = (document.getElementById('assemblyNewNetWeight') as HTMLInputElement).value;
                  const srWeight = (document.getElementById('assemblyNewSrWeight') as HTMLInputElement).value;
                  const cycleTime = (document.getElementById('assemblyNewCycleTime') as HTMLInputElement).value;
                  const cavity = (document.getElementById('assemblyNewCavity') as HTMLInputElement).value;
                  const validFrom = (document.getElementById('assemblyNewValidFrom') as HTMLInputElement).value;

                  const newPart = await api.post('/parts/',{
                    part_no: partNo,
                    model_code: modelCode,
                    description: description,
                    mold_type: moldType,
                    color: color,
                    resin_type: resinType,
                    resin_code: resinCode,
                    net_weight_g: Number(netWeight) || null,
                    sr_weight_g: Number(srWeight) || null,
                    cycle_time_sec: Number(cycleTime) || null,
                    cavity: Number(cavity) || null,
                    valid_from: validFrom
                  });
                  
                  toast.success('새 Part가 추가되었습니다');
                  queryClient.invalidateQueries({queryKey:['parts-all']});
                  queryClient.invalidateQueries({queryKey:['parts-search']});
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
                  toast.error('저장 실패');
                }
              }}>저장</Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}