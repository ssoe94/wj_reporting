import { useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { useEcos } from '@/hooks/useEcos';
import type { Eco } from '@/hooks/useEcos';

export default function EcoManager() {
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const { data: ecos = [] } = useEcos(keyword);
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const today = new Date().toISOString().slice(0,10);
  const [form, setForm] = useState<Partial<Eco>>({
    eco_no: '',
    customer: '',
    description: '',
    received_date: today,
    due_date: '',
    status: 'OPEN',
    note: '',
  });

  const upsert = useMutation({
    mutationFn: async (payload: Partial<Eco>) => {
      if(payload.id) {
        return api.patch(`/ecos/${payload.id}/`, payload);
      }
      return api.post('/ecos/', payload);
    },
    onSuccess: ()=>{
      queryClient.invalidateQueries({queryKey:['ecos']});
      setDialogOpen(false);
    }
  });

  const handleSubmit = (e: React.FormEvent)=>{
    e.preventDefault();
    upsert.mutate(form);
  };

  return (
    <>
      <div className="flex justify-between mb-2 gap-2 items-center">
        <input
          type="text"
          placeholder={t('eco_search_placeholder')}
          className="border rounded px-2 py-1 text-sm flex-1"
          value={keyword}
          onChange={(e)=>setKeyword(e.target.value)}
        />
        <Button size="sm" onClick={()=>{setForm({eco_no:'',customer:'',description:'',received_date:today,due_date:'',status:'OPEN',note:''}); setDialogOpen(true);}}>
          {t('new_eco')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2 text-left">{t('eco_no')}</th>
              <th className="px-3 py-2 text-left">{t('customer')}</th>
              <th className="px-3 py-2 text-left">{t('description')}</th>
              <th className="px-3 py-2 text-left">{t('received_date')}</th>
              <th className="px-3 py-2 text-left">{t('due_date')}</th>
              <th className="px-3 py-2 text-left">{t('status')}</th>
              <th className="px-3 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
            {ecos.map(e=>(
              <tr key={e.id} className="border-t">
                <td className="px-3 py-1 font-mono">{e.eco_no}</td>
                <td className="px-3 py-1">{e.customer}</td>
                <td className="px-3 py-1">{e.description}</td>
                <td className="px-3 py-1">{e.received_date}</td>
                <td className="px-3 py-1">{e.due_date}</td>
                <td className="px-3 py-1">{e.status}</td>
                <td className="px-3 py-1 text-right">
                  <Button size="sm" variant="ghost" onClick={()=>{setForm(e); setDialogOpen(true);}}>{t('edit')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Card className="w-96">
            <CardContent className="space-y-4 pt-6">
              <h3 className="text-lg font-semibold mb-2">{form.id ? t('edit_eco') : t('add_eco')}</h3>
              <form className="space-y-3" onSubmit={handleSubmit}>
                <div>
                  <Label htmlFor="eco_no">{t('eco_no')}</Label>
                  <Input id="eco_no" value={form.eco_no || ''} onChange={(e)=>setForm({...form, eco_no:e.target.value})} required />
                </div>
                <div>
                  <Label htmlFor="customer">{t('customer')}</Label>
                  <Input id="customer" value={form.customer || ''} onChange={(e)=>setForm({...form, customer:e.target.value})} />
                </div>
                <div>
                  <Label htmlFor="description">{t('description')}</Label>
                  <Input id="description" value={form.description || ''} onChange={(e)=>setForm({...form, description:e.target.value})} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="received_date">{t('received_date')}</Label>
                    <Input id="received_date" type="date" value={form.received_date || ''} onChange={(e)=>setForm({...form, received_date:e.target.value})} />
                  </div>
                  <div>
                    <Label htmlFor="due_date">{t('due_date')}</Label>
                    <Input id="due_date" type="date" value={form.due_date || ''} onChange={(e)=>setForm({...form, due_date:e.target.value})} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="status">{t('status')}</Label>
                  <select id="status" value={form.status || 'OPEN'} onChange={(e)=>setForm({...form, status:e.target.value})} className="border rounded px-2 py-1 w-full">
                    <option value="OPEN">OPEN</option>
                    <option value="WIP">WIP</option>
                    <option value="CLOSED">CLOSED</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="note">{t('header_note')}</Label>
                  <Input id="note" value={form.note || ''} onChange={(e)=>setForm({...form, note:e.target.value})} />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={()=>setDialogOpen(false)}>{t('cancel')}</Button>
                  <Button type="submit" size="sm" disabled={upsert.isPending}>{upsert.isPending ? t('saving') : t('save')}</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
} 