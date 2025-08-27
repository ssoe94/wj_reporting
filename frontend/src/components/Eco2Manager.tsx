import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EcoForm from '@/components/EcoForm';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { useUnifiedEcoSearch } from '@/hooks/useUnifiedEcoSearch';
import type { Eco } from '@/hooks/useEcos';
import { toast } from 'react-toastify';
import { Pencil, Trash2, Search, Info } from 'lucide-react';

const ctrlCls = "h-10 bg-white border border-gray-300 rounded-md px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
const rowCls = "bg-white border-t border-gray-200 hover:bg-gray-100 transition-colors";

export default function Eco2Manager() {
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL'|'OPEN'|'CLOSED'>('ALL');
  
  // 통합 검색 사용
  const { data: ecos = [], isLoading, error } = useUnifiedEcoSearch(keyword);
  
  // status filtering
  const filteredEcos = statusFilter === 'ALL' ? ecos : ecos.filter((e: any) => e.status === statusFilter);
  
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
      queryClient.invalidateQueries({queryKey:['unified-eco-search']});
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
      queryClient.invalidateQueries({queryKey:['unified-eco-search']});
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
    // 빈 값 제거
    const header: Record<string, any> = {};
    Object.entries(headerRaw).forEach(([k,v])=>{
      if(v!=='' && v!==null && v!==undefined) header[k]=v;
    });
    (async ()=>{
      try{
        let ecoId = payload.id;
        if(payload.id){
          await api.patch(`ecos/${payload.id}/`, header);
        }else{
          const { data } = await api.post('ecos/', header);
          ecoId = data.id;
        }
        if(details && details.length){
          await api.post(`ecos/${ecoId}/details/bulk/`, {details});
        }
        queryClient.invalidateQueries({queryKey:['unified-eco-search']});
        queryClient.invalidateQueries({queryKey:['ecos']});
        toast.success(t('save_success'));
        setDialogOpen(false);
      }catch(err:any){
        console.error('ECO save error:', err);
        const errorData = err.response?.data || err.data || {};
        console.error('Error response:', errorData);
        
        // 에러 메시지 표시
        if (errorData && typeof errorData === 'object') {
          const firstKey = Object.keys(errorData)[0];
          const firstMsg = Array.isArray(errorData[firstKey]) ? errorData[firstKey][0] : errorData[firstKey];
          toast.error(firstMsg || t('save_fail'));
          setErrors(errorData);
        } else {
          toast.error(t('save_fail'));
        }
      }
    })();
  };

  return (
    <>
      {/* Control Bar */}
      <div className="flex flex-wrap md:flex-nowrap items-center gap-2 mb-4">
        {/* 통합 검색 안내 */}
        <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 px-3 py-2 rounded-lg">
          <Info className="w-4 h-4" />
          <span>통합검색: ECO编号, 适用型号, Part no. 모두 검색 가능</span>
        </div>
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value as any)} className={ctrlCls}>
          <option value="ALL">{t('all')}</option>
          <option value="OPEN">OPEN</option>
          <option value="CLOSED">CLOSED</option>
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4" />
          <Input
            type="text"
            placeholder="ECO编号, 适用型号, Part no. 통합 검색..."
            className={"pl-10 w-full "+ctrlCls}
            value={keyword}
            onChange={(e)=>setKeyword(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={()=>{setForm(emptyForm); setDialogOpen(true);}}>{t('new_eco')}</Button>
      </div>

      {/* 검색 결과 상태 표시 */}
      <div className="mb-2 text-sm text-gray-600">
        {isLoading && "검색 중..."}
        {error && <span className="text-red-600">검색 중 오류가 발생했습니다.</span>}
        {!isLoading && !error && (
          <span>
            {keyword ? `"${keyword}" 검색 결과: ` : '최근 ECO 목록: '}
            총 {filteredEcos.length}건
          </span>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-3 py-2 text-left">{t('eco_no')}</th>
                <th className="px-3 py-2 text-left">{t('eco_model')}</th>
                <th className="px-3 py-2 text-left">{t('customer')}</th>
                <th className="px-3 py-2 text-left">{t('change_reason')}</th>
                <th className="px-3 py-2 text-left">{t('issued_date')}</th>
                <th className="px-3 py-2 text-left">{t('status')}</th>
                <th className="px-3 py-2 text-left">Part 개수</th>
                <th className="px-3 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {filteredEcos.map((e: any)=>(
                <tr key={e.id} className={rowCls}>
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
                  <td className="px-3 py-1">{e.eco_model || '-'}</td>
                  <td className="px-3 py-1">{e.customer || '-'}</td>
                  <td className="px-3 py-1 max-w-[200px] truncate">{e.change_reason}</td>
                  <td className="px-3 py-1">{e.issued_date}</td>
                  <td className="px-3 py-1">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      e.status === 'OPEN' ? 'bg-green-100 text-green-800' :
                      e.status === 'CLOSED' ? 'bg-gray-100 text-gray-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {e.status}
                    </span>
                  </td>
                  <td className="px-3 py-1 text-center">
                    {e.details ? e.details.length : 0}
                  </td>
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
              {!isLoading && filteredEcos.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                    {keyword ? '검색 결과가 없습니다.' : 'ECO 데이터가 없습니다.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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