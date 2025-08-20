import React, { useState } from 'react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { useLang } from '../i18n';
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
      if (err.response?.status === 400 && err.response.data) {
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
            onChange={(_, v) => {
              setSelectedModelDesc(v);
              if (v) {
                setForm((f) => ({ ...f, model: v.model_code, type: v.description, partNo: '', resin: '', netG: '', srG: '', ct: '' }));
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
                setForm((f) => ({
                  ...f,
                  partNo: v.part_no,
                  model: v.model_code,
                  type: v.description,
                  resin: v?.resin_type || '',
                  netG: String(v?.net_weight_g || ''),
                  srG: String(v?.sr_weight_g || ''),
                  ct: String(v?.cycle_time_sec || ''),
                }));
                const modelSpec = uniqueModelDesc.find((m) => m.model_code === v.model_code && m.description === v.description);
                if (modelSpec) setSelectedModelDesc(modelSpec);
              }
            }}
            value={selectedPartSpec}
            renderOption={(props, option) => {
              if ('isAddNew' in option && option.isAddNew) {
                return (
                  <li {...props} className="bg-blue-50 hover:bg-blue-100 border-t border-blue-200">
                    <div className="flex items-center justify-center gap-2 text-blue-700 font-medium py-2 text-sm">
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
              <Button type="submit" className="gap-2">
                <PlusCircle className="h-4 w-4" /> {t('save')}
              </Button>
            </div>
          </CardContent>
        </Card>
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
                id="newPartNo"
              />
              <input placeholder="Model Code" className="border rounded px-2 py-1 col-span-2" id="newModelCode"/>
              <input placeholder="Description" className="border rounded px-2 py-1 col-span-2" id="newDescription"/>
              <input placeholder="Mold Type" className="border rounded px-2 py-1" id="newMoldType"/>
              <input placeholder="Color" className="border rounded px-2 py-1" id="newColor"/>
              <input placeholder="Resin Type" className="border rounded px-2 py-1" id="newResinType"/>
              <input placeholder="Resin Code" className="border rounded px-2 py-1" id="newResinCode"/>
              <input placeholder="Net(g)" className="border rounded px-2 py-1" id="newNetWeight"/>
              <input placeholder="S/R(g)" className="border rounded px-2 py-1" id="newSrWeight"/>
              <input placeholder="C/T(초)" className="border rounded px-2 py-1" id="newCycleTime"/>
              <input placeholder="Cavity" className="border rounded px-2 py-1" id="newCavity"/>
              <input type="date" className="border rounded px-2 py-1" defaultValue={new Date().toISOString().slice(0,10)} id="newValidFrom"/>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={()=>setShowAddPartModal(false)}>취소</Button>
              <Button size="sm" onClick={async()=>{
                try{
                  const partNo = (document.getElementById('newPartNo') as HTMLInputElement).value;
                  const modelCode = (document.getElementById('newModelCode') as HTMLInputElement).value;
                  const description = (document.getElementById('newDescription') as HTMLInputElement).value;
                  const moldType = (document.getElementById('newMoldType') as HTMLInputElement).value;
                  const color = (document.getElementById('newColor') as HTMLInputElement).value;
                  const resinType = (document.getElementById('newResinType') as HTMLInputElement).value;
                  const resinCode = (document.getElementById('newResinCode') as HTMLInputElement).value;
                  const netWeight = (document.getElementById('newNetWeight') as HTMLInputElement).value;
                  const srWeight = (document.getElementById('newSrWeight') as HTMLInputElement).value;
                  const cycleTime = (document.getElementById('newCycleTime') as HTMLInputElement).value;
                  const cavity = (document.getElementById('newCavity') as HTMLInputElement).value;
                  const validFrom = (document.getElementById('newValidFrom') as HTMLInputElement).value;

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
};

export default RecordForm; 