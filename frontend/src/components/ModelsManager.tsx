import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';
import { toast } from 'react-toastify';

export default function ModelsManager() {
  const queryClient = useQueryClient();
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const { data: parts = [] } = useQuery<PartSpec[]>({
    queryKey: ['parts-admin', keyword],
    queryFn: async () => {
      const params: Record<string, any> = {
        ordering: 'model_code',
        page_size: 1000,
      };
      if (keyword.trim()) params.search = keyword.trim();
      const { data } = await api.get('/parts/', { params });
      return Array.isArray(data) ? data : data.results;
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string,string>>({});
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<Partial<PartSpec>>({
    part_no: '',
    model_code: '',
    description: '',
    valid_from: today,
  });

  const upsert = useMutation({
    mutationFn: async (payload: Partial<PartSpec>) => {
      if (payload.id) {
        return api.patch(`parts/${payload.id}/`, payload);
      }
      return api.post('parts/', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parts-admin'] });
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const required = ['part_no', 'model_code'];
    const missing: Record<string,string> = {};
    required.forEach((k)=>{ const val=(form as any)[k]; if(!val||String(val).trim()==='') missing[k]='required'; });
    if(Object.keys(missing).length){
      setErrors(missing);
      toast.error(t('required_error'));
      return;
    }
    setErrors({});
    upsert.mutate(form as PartSpec);
  };

  return (
    <>
      <div className="flex justify-between mb-2 gap-2 items-center">
        <input
          type="text"
          placeholder={t('search_placeholder')}
          className="border rounded px-2 py-1 text-sm flex-1"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button size="sm" onClick={() => { setForm({ part_no: '', model_code: '', description: '', valid_from: today }); setDialogOpen(true); }}>
          {t('new_model')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2 text-left">Part No</th>
              <th className="px-3 py-2 text-left">Model</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-left">Mold</th>
              <th className="px-3 py-2 text-left">Color</th>
              <th className="px-3 py-2 text-left">Resin</th>
              <th className="px-3 py-2 text-left">Net(g)</th>
              <th className="px-3 py-2 text-left">S/R(g)</th>
              <th className="px-3 py-2 text-left">CT(s)</th>
              <th className="px-3 py-2 text-left">Cavity</th>
              <th className="px-3 py-2 text-left">Valid From</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-3 py-1 font-mono">{p.part_no}</td>
                <td className="px-3 py-1">{p.model_code}</td>
                <td className="px-3 py-1">{p.description}</td>
                <td className="px-3 py-1">{p.mold_type}</td>
                <td className="px-3 py-1">{p.color}</td>
                <td className="px-3 py-1">{p.resin_type}</td>
                <td className="px-3 py-1 text-right">{p.net_weight_g}</td>
                <td className="px-3 py-1 text-right">{p.sr_weight_g}</td>
                <td className="px-3 py-1 text-right">{p.cycle_time_sec}</td>
                <td className="px-3 py-1 text-right">{p.cavity}</td>
                <td className="px-3 py-1">{p.valid_from}</td>
                <td className="px-3 py-1 text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setForm(p); setDialogOpen(true); }}>{t('edit')}</Button>
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
              <h3 className="text-lg font-semibold mb-2">{form.id ? t('edit_model') : t('add_model')}</h3>
              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <Label htmlFor="part_no">Part No</Label>
                  <Input id="part_no" value={form.part_no || ''} onChange={(e) => setForm({ ...form, part_no: e.target.value })} className={errors.part_no ? 'border-red-500' : ''} />
                </div>
                <div>
                  <Label htmlFor="model_code">Model</Label>
                  <Input id="model_code" value={form.model_code || ''} onChange={(e) => setForm({ ...form, model_code: e.target.value })} className={errors.model_code ? 'border-red-500' : ''} />
                </div>
                <div>
                  <Label htmlFor="desc">Description</Label>
                  <Input id="desc" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="mold">Mold Type</Label>
                    <Input id="mold" value={form.mold_type || ''} onChange={(e) => setForm({ ...form, mold_type: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="color">Color</Label>
                    <Input id="color" value={form.color || ''} onChange={(e) => setForm({ ...form, color: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="resin">Resin Type</Label>
                    <Input id="resin" value={form.resin_type || ''} onChange={(e) => setForm({ ...form, resin_type: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="resinCode">Resin Code</Label>
                    <Input id="resinCode" value={form.resin_code || ''} onChange={(e) => setForm({ ...form, resin_code: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label htmlFor="net">Net(g)</Label>
                    <Input id="net" type="number" value={form.net_weight_g ?? ''} onChange={(e) => setForm({ ...form, net_weight_g: e.target.value ? Number(e.target.value) : null })} />
                  </div>
                  <div>
                    <Label htmlFor="sr">S/R(g)</Label>
                    <Input id="sr" type="number" value={form.sr_weight_g ?? ''} onChange={(e) => setForm({ ...form, sr_weight_g: e.target.value ? Number(e.target.value) : null })} />
                  </div>
                  <div>
                    <Label htmlFor="ct">{t('ct_sec')}</Label>
                    <Input id="ct" type="number" value={form.cycle_time_sec ?? ''} onChange={(e) => setForm({ ...form, cycle_time_sec: e.target.value ? Number(e.target.value) : null })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="cavity">Cavity</Label>
                    <Input id="cavity" type="number" value={form.cavity ?? ''} onChange={(e) => setForm({ ...form, cavity: e.target.value ? Number(e.target.value) : null })} />
                  </div>
                  <div>
                    <Label htmlFor="valid">Valid From</Label>
                    <Input id="valid" type="date" value={form.valid_from || ''} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} />
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>{t('cancel')}</Button>
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