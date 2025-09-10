import { History, PlusCircle, Plus } from 'lucide-react';
import { useLang } from '../../i18n';
import { useState } from 'react';
import { Label } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import PermissionButton from '../../components/common/PermissionButton';
import { toast } from 'react-toastify';
import { Autocomplete, TextField } from '@mui/material';
import DateTimeField from '../../components/DateTimeField';

import type { PartSpec } from '../../hooks/usePartSpecs';
import { usePartSpecSearch, usePartListByModel } from '../../hooks/usePartSpecs';
import { useAssemblyPartsByModel, useAssemblyPartspecsByModel, useAssemblyPartNoSearch, useAssemblyModelSearch } from '../../hooks/useAssemblyParts';
import { useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import { Button } from '../../components/ui/button';

export default function QualityReport() {
  const { t, lang } = useLang();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    report_dt: '',  // 보고일시 (datetime-local)
    section: 'LQC_INJ', // 보고부문 기본값: LQC - 注塑
    model: '',      // 型号
    part_no: '',    // PART NO.
    phenomenon: '', // 不良现象
    inspection_qty: '', // 검사수
    defect_qty: '',     // 불량수
    defect_rate: '',    // 불량률(자동계산 표시용)
    lot_qty: '',    // LOT SIZE
    judgement: 'NG',// 判定结果
    disposition: '',// 处理方式
  });

  // 모델/Part 선택 (어셈블리/사출과 동일한 UX)
  const [productQuery, setProductQuery] = useState('');
  const [selectedModelDesc, setSelectedModelDesc] = useState<PartSpec | null>(null);
  const [selectedPartSpec, setSelectedPartSpec] = useState<PartSpec | null>(null);
  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [newPartForm, setNewPartForm] = useState<any>({
    part_no: '',
    model_code: '',
    description: '',
  });
  const [prefillOriginal, setPrefillOriginal] = useState<any | null>(null);
  
  // Removed unused variables
  

  const { data: searchResults = [] } = usePartSpecSearch(productQuery.toUpperCase());
  const { data: modelParts = [] } = usePartListByModel(selectedModelDesc?.model_code);
  const { data: asmPartsByModel = [] } = useAssemblyPartsByModel(selectedModelDesc?.model_code);
  const { data: asmPartspecsByModel = [] } = useAssemblyPartspecsByModel(selectedModelDesc?.model_code);
  const { data: asmPartNoSearch = [] } = useAssemblyPartNoSearch(productQuery || '');
  const { data: asmModelSearch = [] } = useAssemblyModelSearch(productQuery || '');

  const uniqueModelDesc = ((): PartSpec[] => {
    const map = new Map<string, PartSpec>();
    // 기존 파트스펙 검색 결과
    searchResults.forEach((it: any) => {
      const key = `${it.model_code}|${it.description || ''}`;
      if (!map.has(key)) map.set(key, it);
    });
    // 어셈블리 모델 검색 결과 병합
    (Array.isArray(asmModelSearch) ? asmModelSearch as any[] : []).forEach((it: any) => {
      const modelCode = it.model || it.model_code;
      if (!modelCode) return;
      const desc = it.description || '';
      const key = `${modelCode}|${desc}`;
      if (!map.has(key)) map.set(key, { model_code: modelCode, description: desc, id: 0, part_no: '' } as any);
    });
    // 현재 선택된 모델도 후보에 포함
    if (selectedModelDesc?.model_code) {
      const key = `${selectedModelDesc.model_code}|${selectedModelDesc.description || ''}`;
      if (!map.has(key)) map.set(key, selectedModelDesc as any);
    }
    return Array.from(map.values());
  })();

  const handleChange = (k: string, v: any) => setForm(prev => ({ ...prev, [k]: v }));

  // 이력(로컬) 관리 및 필터/페이지네이션
  type QualityRecord = typeof form & { saved_at: string };
  const [records, setRecords] = useState<QualityRecord[]>([]);
  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    model: '',
    part_no: ''
  });
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const filtered = records.filter(r => {
    const dt = (r.report_dt || r.saved_at || '').slice(0,10);
    if (filters.dateFrom && dt < filters.dateFrom) return false;
    if (filters.dateTo && dt > filters.dateTo) return false;
    if (filters.model && !String(r.model || '').toUpperCase().includes(filters.model.toUpperCase())) return false;
    if (filters.part_no && !String(r.part_no || '').toUpperCase().includes(filters.part_no.toUpperCase())) return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const view = filtered.slice((page - 1) * pageSize, page * pageSize);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 검증
    if (!form.report_dt) {
      toast.error(lang === 'zh' ? '请选择 报告日期时间' : '보고일시를 선택하세요');
      return;
    }
    if (!form.model || !form.part_no) {
      toast.error(lang === 'zh' ? '请填写 型号/Part No.' : '모델/Part No.를 입력하세요');
      return;
    }
    (async () => {
      try {
        const insp = Number(form.inspection_qty) || 0;
        const defect = Number(form.defect_qty) || 0;
        const rate = insp > 0 ? Math.round((defect / insp) * 10000) / 100 : 0;
        const payload = {
          report_dt: form.report_dt,
          section: form.section,
          model: form.model,
          part_no: form.part_no,
          lot_qty: form.lot_qty ? Number(form.lot_qty) : null,
          inspection_qty: form.inspection_qty ? Number(form.inspection_qty) : null,
          defect_qty: form.defect_qty ? Number(form.defect_qty) : null,
          defect_rate: `${rate}%`,
          judgement: form.judgement || 'NG',
          phenomenon: form.phenomenon,
          disposition: form.disposition,
        } as any;

        const { data } = await api.post('/quality/reports/', payload);
        toast.success(lang === 'zh' ? '已保存' : '저장되었습니다');
        setRecords(prev => [{ ...data, saved_at: new Date().toISOString() }, ...prev]);
        setForm({
          report_dt: '',
          section: form.section,
          model: '',
          part_no: '',
          phenomenon: '',
          inspection_qty: '',
          defect_qty: '',
          defect_rate: '',
          lot_qty: '',
          judgement: 'NG',
          disposition: '',
        });
      } catch (err: any) {
        toast.error(lang === 'zh' ? '保存失败' : '저장에 실패했습니다');
      }
    })();
  };

  return (
    <>
      {/* 불량보고 이력 카드 */}
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm mb-6">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <History className="w-5 h-5 text-rose-500" />
          <h2 className="text-base font-semibold text-gray-800">{t('quality_history')}</h2>
        </div>
        <div className="px-4 pt-6 space-y-3">
          {/* 필터 */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <div>
              <Label>{t('date_from')}</Label>
              <Input type="date" value={filters.dateFrom} onChange={e=>{ setPage(1); setFilters(f=>({ ...f, dateFrom: e.target.value })); }} />
            </div>
            <div>
              <Label>{t('date_to')}</Label>
              <Input type="date" value={filters.dateTo} onChange={e=>{ setPage(1); setFilters(f=>({ ...f, dateTo: e.target.value })); }} />
            </div>
            <div>
              <Label>{t('model')}</Label>
              <Input value={filters.model} onChange={e=>{ setPage(1); setFilters(f=>({ ...f, model: e.target.value })); }} placeholder="24TL510…" />
            </div>
            <div>
              <Label>PART NO.</Label>
              <Input value={filters.part_no} onChange={e=>{ setPage(1); setFilters(f=>({ ...f, part_no: e.target.value })); }} placeholder="ABJ76507616" />
            </div>
            <div />
          </div>
          {/* 테이블 - 인벤토리 상세 테이블 디자인 적용 */}
          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-slate-100 whitespace-nowrap">
                  <tr>
                    <th className="px-3 py-2 text-center">{t('date')}</th>
                    <th className="px-3 py-2 text-center">{t('quality_section')}</th>
                    <th className="px-3 py-2 text-center">{t('model')}</th>
                    <th className="px-3 py-2 text-center">PART NO.</th>
                    <th className="px-3 py-2 text-center">{t('lot_qty')}</th>
                    <th className="px-3 py-2 text-center">{t('defect_rate_label')}</th>
                    <th className="px-3 py-2 text-center">{t('judgement_result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-gray-400" colSpan={7}>No data</td>
                    </tr>
                  ) : (
                    view.map((r, idx) => (
                      <tr key={idx} className="bg-white border-t border-gray-200 hover:bg-gray-100 transition-colors whitespace-nowrap">
                        <td className="px-3 py-2 text-center">{(r.report_dt || '').replace('T',' ').slice(0,16)}</td>
                        <td className="px-3 py-2 text-center">{r.section}</td>
                        <td className="px-3 py-2 text-center">{r.model}</td>
                        <td className="px-3 py-2 text-center">{r.part_no}</td>
                        <td className="px-3 py-2 text-center">{r.lot_qty}</td>
                        <td className="px-3 py-2 text-center">{r.defect_rate}</td>
                        <td className="px-3 py-2 text-center">{r.judgement}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          {/* 페이지네이션 */}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={()=> setPage(p=> Math.max(1, p-1))} disabled={page<=1}>Prev</Button>
            <span className="text-xs text-gray-500">{page} / {totalPages}</span>
            <Button type="button" variant="secondary" onClick={()=> setPage(p=> Math.min(totalPages, p+1))} disabled={page>=totalPages}>Next</Button>
          </div>
        </div>
      </div>

      {/* 불량보고 입력 카드 */}
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <History className="w-5 h-5 text-rose-500" />
        <h2 className="text-base font-semibold text-gray-800">{t('nav_quality_report')}</h2>
      </div>
        {/* 입력 폼 */}
        <form onSubmit={handleSubmit} className="px-4 pb-6 space-y-6">
        {/* 상단 기본 정보: 5열 1행 (보고일시/보고부문/모델/PART NO./LOT SIZE) */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div>
            <Label htmlFor="report_dt">{t('report_datetime')}</Label>
            <DateTimeField
              value={form.report_dt || ''}
              onChange={(v)=> handleChange('report_dt', v)}
              locale={lang==='zh' ? 'zh' : 'ko'}
              minuteStep={5}
            />
          </div>
          <div>
            <Label htmlFor="section">{t('quality_section')}</Label>
            <select
              id="section"
              value={form.section}
              onChange={(e)=>handleChange('section', e.target.value)}
              className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500"
            >
              <option value="LQC_INJ">LQC - {lang==='zh'?'注塑':'사출'}</option>
              <option value="LQC_ASM">LQC - {lang==='zh'?'加工':'가공'}</option>
              <option value="IQC">IQC</option>
              <option value="OQC">OQC</option>
              <option value="CS">CS</option>
            </select>
          </div>
          <div>
            <Label>{t('model')}</Label>
            <Autocomplete<PartSpec | { isAddModel: true; model_code: string; description?: string }>
              options={uniqueModelDesc}
              openOnFocus
              includeInputInList
              getOptionLabel={(opt) => opt.description ? `${opt.model_code} – ${opt.description}` : `${opt.model_code}`}
              isOptionEqualToValue={(a, b) => (a?.model_code === b?.model_code) && ((a?.description || '') === (b?.description || ''))}
              onInputChange={(_, v) => setProductQuery(v)}
              value={selectedModelDesc}
              onChange={(_, v) => {
                setSelectedModelDesc(v as PartSpec | null);
                if (v && 'model_code' in v) {
                  setForm((f)=>({ ...f, model: v.model_code, part_no: '' }));
                  setSelectedPartSpec(null);
                }
              }}
              filterOptions={(opts, state) => {
                const input = (state.inputValue || '').trim().toUpperCase();
                let filtered = !input ? opts : opts.filter(o => String((o as any).model_code || '').toUpperCase().includes(input)
                  || String(o.description || '').toUpperCase().includes(input));
                if (input && filtered.length === 0) {
                  filtered = [{ isAddModel: true, model_code: state.inputValue }] as any;
                }
                return filtered as any;
              }}
              renderInput={(params) => <TextField {...params} size="small" placeholder={t('model_search')} />}
              renderOption={(props, option) => {
                const { key, ...rest } = props as any;
                if ((option as any).isAddModel) {
                  return (
                    <li key={key} {...rest} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                      <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                        <Plus className="h-3 w-3" />
                        <span>"{(option as any).model_code}" {t('add_new_part_prompt')}</span>
                      </div>
                    </li>
                  );
                }
                const spec = option as PartSpec;
                return (
                  <li key={key} {...rest}>
                    <div className="flex flex-col">
                      <span className="font-mono font-medium">{spec.model_code}</span>
                      {spec.description && <span className="text-sm text-gray-600">{spec.description}</span>}
                    </div>
                  </li>
                );
              }}
            />
          </div>
          <div>
            <Label>PART NO.</Label>
            <Autocomplete<PartSpec | { isAddNew: boolean; part_no: string } | { isAddNewForModel: boolean }>
              options={(() => {
                const baseOptions = selectedModelDesc
                  ? ((asmPartspecsByModel as any).length ? (asmPartspecsByModel as any) : ((asmPartsByModel as any).length ? (asmPartsByModel as any) : modelParts))
                  : (() => {
                      const asmOptions = Array.isArray(asmPartNoSearch)
                        ? (asmPartNoSearch as any[]).map((r:any)=> ({ part_no: r.part_no, model_code: (r as any).model || (r as any).model_code || '', description: r.description || '' }))
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
              renderOption={(props, option) => {
                const { key, ...rest } = props as any;
                if ('isAddNew' in option && (option as any).isAddNew) {
                  return (
                    <li key={key} {...rest} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                      <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                        <Plus className="h-3 w-3" />
                        <span>"{(option as any).part_no}" {t('add_new_part_prompt')}</span>
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
              filterOptions={(opts, state) => {
                let filtered: any[] = opts.slice();
                if (selectedModelDesc) {
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
                    }

                    if (list.length > 0) {
                      const top = list[0];
                      const ok = window.confirm(t('similar_parts_prompt').replace('{first}', top.part_no).replace('{count}', String(list.length)));
                      if (ok) {
                        prefillData = {
                          model_code: top.model,
                          description: top.description,
                        } as any;
                      }
                    }
                  
                  setPrefillSimilar(prefillData);
                  setNewPartForm((prev: any) => ({
                    ...prev,
                    part_no: desired,
                    model_code: (prefillData as any)?.model_code || selectedModelDesc?.model_code || '',
                    description: (prefillData as any)?.description || selectedModelDesc?.description || '',
                  }));
                  setPrefillOriginal({
                    part_no: desired,
                    model_code: (prefillData as any)?.model_code || selectedModelDesc?.model_code || '',
                    description: (prefillData as any)?.description || selectedModelDesc?.description || '',
                  });
                  setShowAddPartModal(true);
                  return;
                }
                setSelectedPartSpec(v as PartSpec);
                if (v && !('isAddNew' in v)) {
                  const modelCode = (v as any).model_code || (v as any).model || '';
                  setForm((f)=>({ ...f, part_no: (v as any).part_no, model: modelCode }));
                  const modelSpec = uniqueModelDesc.find((m) => m.model_code === modelCode && m.description === (v as any).description);
                  if (modelSpec) setSelectedModelDesc(modelSpec);
                  else if (modelCode) setSelectedModelDesc({ model_code: modelCode, description: (v as any).description || '' } as any);
                }
              }}
              value={selectedPartSpec}
              renderInput={(params) => <TextField {...params} size="small" placeholder={`Part No. ${t('input_or_select')}`} />}
            />
          </div>
          <div>
            <Label htmlFor="lot_qty">{t('lot_qty')}</Label>
            <Input id="lot_qty" value={form.lot_qty} onChange={(e)=>handleChange('lot_qty', e.target.value)} placeholder="400" />
          </div>
        </div>

        {/* 검사/불량/불량률/판정: 4열 1행 */}
        {(() => {
          const insp = Number(form.inspection_qty) || 0;
          const defect = Number(form.defect_qty) || 0;
          const rate = insp > 0 ? Math.round((defect / insp) * 10000) / 100 : 0;
          return (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <Label htmlFor="inspection_qty">{t('inspection_qty')}</Label>
                <Input id="inspection_qty" type="number" inputMode="numeric" min={0} value={form.inspection_qty} onChange={(e)=>handleChange('inspection_qty', e.target.value)} placeholder={lang==='zh'?'检验数':'검사수'} />
              </div>
              <div>
                <Label htmlFor="defect_qty">{t('defect_qty')}</Label>
                <Input id="defect_qty" type="number" inputMode="numeric" min={0} value={form.defect_qty} onChange={(e)=>handleChange('defect_qty', e.target.value)} placeholder={lang==='zh'?'不良数':'불량수'} />
              </div>
              <div>
                <Label htmlFor="defect_rate">{t('defect_rate_label')}</Label>
                <Input id="defect_rate" value={insp===0 && defect===0 ? '' : `${rate}%`} disabled className="bg-gray-100" />
              </div>
              <div>
                <Label htmlFor="judgement">{t('judgement_result')}</Label>
                <select
                  id="judgement"
                  value={form.judgement}
                  onChange={(e)=>handleChange('judgement', e.target.value)}
                  className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500"
                >
                  <option value="OK">OK</option>
                  <option value="NG">NG</option>
                </select>
              </div>
            </div>
          );
        })()}

        {/* 불량 현상 / 처리 방식: 2열 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="phenomenon">{t('defect_phenomenon')}</Label>
            <Textarea id="phenomenon" rows={3} value={form.phenomenon} onChange={(e)=>handleChange('phenomenon', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="disposition">{t('disposition')}</Label>
            <Textarea id="disposition" rows={3} value={form.disposition} onChange={(e)=>handleChange('disposition', e.target.value)} placeholder={lang==='zh' ? '需返工后使用' : '재작업 후 사용 필요'} />
          </div>
        </div>

        {/* 저장 버튼 */}
        <div className="flex justify-end">
          <PermissionButton
            permission="can_edit_machining"
            type="submit"
            className="px-6 py-3 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-medium transition-all duration-200 inline-flex items-center gap-2 whitespace-nowrap"
          >
            <PlusCircle className="h-5 w-5 shrink-0" />
            {t('save')}
          </PermissionButton>
        </div>
        </form>
      </div>

      {/* Add Part Modal */}
      {showAddPartModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">{t('add_new_part_spec')}</h3>
            <p className="text-xs text-gray-500">{lang==='zh' ? '必填: Part No / Model Code / Description' : '필수: Part No / Model Code / Description'}</p>
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Part No" className="border rounded px-2 py-1 col-span-2 bg-green-50 border-green-300" value={newPartForm.part_no} onChange={(e)=> setNewPartForm((f: any)=> ({...f, part_no: e.target.value}))} />
              <input placeholder="Model Code" className={`border rounded px-2 py-1 col-span-2${prefillOriginal?.model_code ? ' bg-yellow-50 border-yellow-300' : ''}`} value={newPartForm.model_code} onChange={(e)=> setNewPartForm((f:any)=> ({...f, model_code: e.target.value}))} />
              <input placeholder="Description" className={`border rounded px-2 py-1 col-span-2${prefillOriginal?.description ? ' bg-yellow-50 border-yellow-300' : ''}`} value={newPartForm.description} onChange={(e)=> setNewPartForm((f:any)=> ({...f, description: e.target.value}))} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="px-3 py-1 text-sm" onClick={()=>setShowAddPartModal(false)}>{t('cancel')}</button>
              <button className="px-3 py-1 bg-blue-600 text-white text-sm rounded" onClick={async()=>{
                try{
                  const partNo = String(newPartForm.part_no || '').trim();
                  const modelCode = String(newPartForm.model_code || '').trim();
                  const description = String(newPartForm.description || '').trim();
                  if (!partNo || !modelCode || !description) {
                    toast.error(lang==='zh' ? '请输入 Part No / Model Code / Description' : 'Part No / Model Code / Description을 입력하세요');
                    return;
                  }
                  const newPart = await api.post('/assembly/partspecs/create-or-update/',{ part_no: partNo, model_code: modelCode, description });
                  toast.success(t('new_part_added_success'));
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs-by-model'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partno-search'] });
                  // 품질 페이지의 모델/부품 자동완성 캐시도 무효화
                  queryClient.invalidateQueries({ queryKey: ['parts-search'] });
                  queryClient.invalidateQueries({ queryKey: ['parts-model'] });
                  queryClient.invalidateQueries({ queryKey: ['parts-all'] });
                  setShowAddPartModal(false);
                  const createdPart = newPart.data || {};
                  const createdModelCode = createdPart.model_code || modelCode;
                  // const createdDesc = createdPart.description || description || ''; // Currently unused
                  setProductQuery(createdModelCode);
                  setForm((f) => ({ ...f, part_no: createdPart.part_no || partNo, model: createdModelCode }));
                }catch(err:any){
                  toast.error(t('save_fail'));
                }
              }}>{t('save')}</button>
            </div>
      </div>
    </div>
      )}
    </>
  );
}



  </div>
    </div>
      )}
    </>
  );
}



