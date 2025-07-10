import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EcoForm from '@/components/EcoForm';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { useEcos } from '@/hooks/useEcos';
import type { Eco } from '@/hooks/useEcos';
import { toast } from 'react-toastify';
import { Pencil, Trash2 } from 'lucide-react';

export default function EcoManager() {
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const { data: ecos = [] } = useEcos(keyword);
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
    upsert.mutate(payload);
  };

  return (
    <>
      <div className="flex justify-between mb-2 gap-2 items-center">
        <Input
          type="text"
          placeholder={t('eco_search_placeholder')}
          className="flex-1"
          value={keyword}
          onChange={(e)=>setKeyword(e.target.value)}
        />
        <Button size="sm" onClick={()=>{setForm(emptyForm); setDialogOpen(true);}}>
          {t('new_eco')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2 text-left">{t('eco_no')}</th>
              <th className="px-3 py-2 text-left">{t('eco_model')}</th>
              <th className="px-3 py-2 text-left">{t('change_reason')}</th>
              <th className="px-3 py-2 text-left">{t('prepared_date')}</th>
              <th className="px-3 py-2 text-left">{t('issued_date')}</th>
              <th className="px-3 py-2 text-left">{t('status')}</th>
              <th className="px-3 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
            {ecos.map(e=>(
              <tr key={e.id} className="border-t">
                <td className="px-3 py-1 font-mono">{e.eco_no}</td>
                <td className="px-3 py-1">{e.eco_model}</td>
                <td className="px-3 py-1">{e.change_reason}</td>
                <td className="px-3 py-1">{e.prepared_date}</td>
                <td className="px-3 py-1">{e.issued_date}</td>
                <td className="px-3 py-1">{e.status}</td>
                <td className="px-3 py-1 text-right flex justify-end gap-1">
                  <Button size="icon" variant="ghost" onClick={()=>{setErrors({}); setForm(e); setDialogOpen(true);}} aria-label={t('edit')}>
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