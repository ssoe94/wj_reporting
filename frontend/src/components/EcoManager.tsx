import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EcoForm from '@/components/EcoForm';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { useEcos } from '@/hooks/useEcos';
import { useEcosByPart } from '@/hooks/useEcosByPart';
import { usePartEcoCount } from '@/hooks/usePartEcoCount';
import { useEcosByParts } from '@/hooks/useEcosByParts';
import type { Eco } from '@/hooks/useEcos';
import { toast } from 'react-toastify';
import { Pencil, Trash2 } from 'lucide-react';

export default function EcoManager() {
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'eco'|'part'>('eco');
  const [statusFilter, setStatusFilter] = useState<'ALL'|'OPEN'|'CLOSED'>('ALL');
  const [selectedParts, setSelectedParts] = useState<string[]>([]);
  const [selectedPart, setSelectedPart] = useState<string>('');
  const { data: ecos = [] } = mode==='eco' ? useEcos(keyword) : useEcosByPart(selectedPart || '');
  // status filtering
  const filteredEcos = statusFilter==='ALL' ? ecos : ecos.filter((e:any)=>e.status===statusFilter);
  const { data: partCounts = [] } = usePartEcoCount(mode==='part'?keyword:'');
  const ecosBySelectedParts = useEcosByParts(selectedParts);
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string,string>>({});
  const today = new Date().toISOString().slice(0,10);
  const emptyForm: Partial<Eco> = {
    eco_no: '',
    eco_model: '',
    customer: '',
    prepared_date: today,
    issued_date: today,
    received_date: today,
    due_date: '',
    status: 'OPEN',
    change_reason: '',
    change_details: '',
    applicable_work_order: '',
    storage_action: '',
    inventory_finished: null,
    inventory_material: null,
    applicable_date: '',
    form_type: 'REGULAR',
    note: '',
  };
  const [form, setForm] = useState<Partial<Eco>>(emptyForm);

  const upsert = useMutation({
    mutationFn: async (payload: Partial<Eco>) => {
      if(payload.id) {
        return api.patch(`ecos/${payload.id}/`, payload);
      }
      return api.post('ecos/', payload);
    },
    onSuccess: ()=>{
      queryClient.invalidateQueries({queryKey:['ecos']});
      setKeyword('');
      setDialogOpen(false);
      setErrors({});
      toast.success(t('save_success'));
    },
    onError: (err:any)=>{
      try {
        const data = err.response?.data || err.data || {};
        setErrors(data);
        const firstKey = Object.keys(data)[0];
        const firstMsg = Array.isArray(data[firstKey]) ? data[firstKey][0] : data[firstKey];
        toast.error(firstMsg || t('save_fail'));
      } catch {
        toast.error(t('save_fail'));
      }
    }
  });

  const del = useMutation({
    mutationFn: async (id:number)=> api.delete(`ecos/${id}/`),
    onSuccess: ()=>{
      queryClient.invalidateQueries({queryKey:['ecos']});
      toast.success(t('delete_success'));
    },
    onError: ()=>{
      toast.error(t('delete_fail'));
    }
  });

  const handleDelete = (eco:Eco)=>{
    if(!eco.id) return;
    if(!window.confirm(t('delete_confirm'))) return;
    del.mutate(eco.id);
  };

  const handleUpsert = (payload: Partial<Eco>) => {
    setErrors({});
    // header fields only
    const { details, ...headerRaw } = payload as any;
    // 빈 값 제거 ('' 또는 null) → DRF validation 오류 방지
    const header: Record<string, any> = {};
    Object.entries(headerRaw).forEach(([k,v])=>{
      if(v!=='' && v!==null && v!==undefined) header[k]=v;
    });
    (async ()=>{
      try{
        let ecoId = payload.id;
        if(payload.id){
          // 수정: PATCH 후 id 유지
          await api.patch(`ecos/${payload.id}/`, header);
        }else{
          // 신규: POST 후 id 획득
          const { data } = await api.post('ecos/', header);
          ecoId = data.id;
        }
        if(details && details.length){
          await api.post(`ecos/${ecoId}/details/bulk/`, {details});
        }
        queryClient.invalidateQueries({queryKey:['ecos']});
        toast.success(t('save_success'));
        setDialogOpen(false);
      }catch(err:any){
        toast.error(t('save_fail'));
      }
    })();
  };

  return (
    <>
      <div className="flex justify-between mb-2 gap-2 items-center">
        <div className="flex flex-1 gap-2">
          <select value={mode} onChange={e=>{setKeyword(''); setMode(e.target.value as any);}} className="border rounded px-2">
            <option value="eco">{t('eco_no')}</option>
            <option value="part">PART NO.</option>
          </select>
          <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value as any)} className="border rounded px-2">
            <option value="ALL">{t('all')}</option>
            <option value="OPEN">OPEN</option>
            <option value="CLOSED">CLOSED</option>
          </select>
        <Input
          type="text"
            placeholder={mode==='eco'? t('eco_search_placeholder') : t('part_search_placeholder')}
          className="flex-1"
          value={keyword}
            onChange={(e)=>{setKeyword(e.target.value); if(mode==='part'){setSelectedPart('')}}}
        />
        </div>
        <Button size="sm" onClick={()=>{setForm(emptyForm); setDialogOpen(true);}}>
          {t('new_eco')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded border">
        {mode==='eco' ? (
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2 text-left">{t('eco_no')}</th>
                <th className="px-3 py-2 text-left">{t('eco_model')}</th>
              <th className="px-3 py-2 text-left">{t('change_reason')}</th>
              <th className="px-3 py-2 text-left">{t('issued_date')}</th>
              <th className="px-3 py-2 text-left">{t('status')}</th>
              <th className="px-3 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
              {filteredEcos.map((e: any)=>(
              <tr key={e.id} className="border-t">
                  <td className="px-3 py-1 font-mono cursor-pointer text-blue-600 underline" onClick={async ()=>{
                    setErrors({});
                    try {
                      const { data } = await api.get(`ecos/${e.id}/`);
                      setForm(data);
                    } catch {
                      setForm(e);
                    }
                    setDialogOpen(true);
                  }}>{e.eco_no}</td>
                <td className="px-3 py-1">{e.eco_model}</td>
                <td className="px-3 py-1">{e.change_reason}</td>
                <td className="px-3 py-1">{e.issued_date}</td>
                <td className="px-3 py-1">{e.status}</td>
                  <td className="px-3 py-1 text-right flex justify-end gap-1">
                    <Button size="icon" variant="ghost" onClick={async ()=>{
                      setErrors({});
                      try{
                        const { data } = await api.get(`ecos/${e.id}/`);
                        setForm(data);
                      }catch{
                        setForm(e);
                      }
                      setDialogOpen(true);
                    }} aria-label={t('edit')}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={()=>handleDelete(e)} aria-label={t('delete')} disabled={del.isPending}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        ) : (
          <>
          {!selectedPart ? (
            <>
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100"><tr className="border-y"><th className="px-3 py-2 text-left">Part No</th><th className="px-3 py-2 text-left">{t('description') || 'Description'}</th><th className="px-3 py-2 text-center">{t('eco_count')}</th></tr></thead>
              <tbody>
                {partCounts.map(pc=> {
                  const checked = selectedParts.includes(pc.part_no);
                  return (
                    <tr key={pc.part_no} className="border-t hover:bg-slate-50">
                      <td className="px-3 py-1 font-mono flex items-center gap-2">
                        <input type="checkbox" checked={checked} onChange={()=>{
                          setSelectedPart('');
                          setSelectedParts(prev=>checked? prev.filter(p=>p!==pc.part_no): [...prev, pc.part_no]);
                        }} />
                        <span className="cursor-pointer" onClick={()=>setSelectedPart(pc.part_no)}>{pc.part_no}</span>
                      </td>
                      <td className="px-3 py-1 text-xs cursor-pointer hover:bg-yellow-50" onClick={() => {
                        const newDesc = prompt(`${pc.part_no} ${t('description_edit_prompt')}:`, pc.description || '');
                        if (newDesc !== null && newDesc !== pc.description) {
                          // API 호출하여 description 업데이트
                          api.patch(`parts/${pc.part_no}/update-description/`, { description: newDesc })
                            .then(() => {
                              queryClient.invalidateQueries({queryKey:['part-eco-count']});
                              toast.success(t('update_success'));
                            })
                            .catch(() => {
                              toast.error(t('update_fail'));
                            });
                        }
                      }}>{pc.description || '-'}</td>
                      <td className="px-3 py-1 text-center">{pc.count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {selectedParts.length>0 && (
              <div className="mt-4">
                <h4 className="font-semibold mb-2 pl-2">{t('selected_part_eco_details')}</h4>
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="px-3 py-2 text-center">{t('part') || 'Part'}</th>
                      <th className="px-3 py-2 text-center">{t('eco') || 'ECO'}</th>
                      <th className="px-3 py-2 text-center">{t('change_details')}</th>
                      <th className="px-3 py-2 text-center">{t('part_status') || 'Part Status'}</th>
                      <th className="px-3 py-2 text-center">{t('eco_status') || 'ECO Status'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedParts.map(partNo => {
                      // 관련된 rows 추출
                      const rows = ecosBySelectedParts.data?.filter((eco:any)=> statusFilter==='ALL'||eco.status===statusFilter).flatMap((eco:any)=>
                        (eco.details||[]).filter((d:any)=>d.part_no.toUpperCase()===partNo.toUpperCase()).map((d:any)=>(
                          {
                            part_no: d.part_no,
                            eco_id: eco.id,
                            eco_no: eco.eco_no,
                            change_details: d.change_details,
                            part_status: d.status,
                            eco_status: eco.status,
                          }
                        ))
                      ) || [];
                      return rows.map((row,idx)=>(
                        <tr key={`${row.part_no}-${row.eco_no}`} className={`border-t ${idx===0?'border-gray-300':'border-gray-200'}`}>
                          {idx===0 && (
                            <td className="px-3 py-1 font-mono text-center" rowSpan={rows.length}>{row.part_no}</td>
                          )}
                          <td className="px-3 py-1 font-mono text-center cursor-pointer text-blue-600 underline" onClick={async ()=>{
                            setErrors({});
                            const { data } = await api.get(`ecos/${row.eco_id}/`);
                            setForm(data);
                            setDialogOpen(true);
                          }}>{row.eco_no}</td>
                          <td className="px-3 py-1 text-xs text-left whitespace-pre-wrap">{row.change_details}</td>
                          <td className="px-3 py-1 text-center">{row.part_status}</td>
                          <td className="px-3 py-1 text-center">{row.eco_status}</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100"><tr><th className="px-3 py-2 text-left">{t('eco')}</th><th className="px-3 py-2 text-left">{t('change_details')}</th><th className="px-3 py-2 text-left">{t('part_status')}</th><th className="px-3 py-2 text-left">{t('eco_status')}</th></tr></thead>
              <tbody>
                {filteredEcos.flatMap((eco:any)=> (eco.details||[]).filter((d:any)=>d.part_no===selectedPart).map((d:any)=>(
                  <tr key={eco.id+'-'+d.id} className="border-t">
                    <td className="px-3 py-1 font-mono">{eco.eco_no}</td>
                    <td className="px-3 py-1 text-xs">{d.change_details}</td>
                    <td className="px-3 py-1">{d.status}</td>
                    <td className="px-3 py-1">{eco.status}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          )}
          </>
          )}
      </div>

      <EcoForm
        initial={form}
        open={dialogOpen}
        onClose={()=>setDialogOpen(false)}
        onSubmit={handleUpsert}
        isSaving={upsert.isPending}
        errors={errors}
      />
    </>
  );
} 