import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface PartSpec {
  id?: number;
  part_no: string;
  model_code: string;
  description: string;
}

export default function ModelsManager() {
  const queryClient = useQueryClient();
  const { data: parts = [] } = useQuery<PartSpec[]>({
    queryKey: ['parts-admin'],
    queryFn: async () => {
      const { data } = await api.get('/parts/?ordering=part_no');
      return data;
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<PartSpec>({ part_no: '', model_code: '', description: '' });

  const upsert = useMutation({
    mutationFn: async (payload: PartSpec) => {
      if (payload.id) {
        return api.patch(`/parts/${payload.id}/`, payload);
      }
      return api.post('/parts/', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parts-admin'] });
      setDialogOpen(false);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    upsert.mutate(form);
  };

  return (
    <>
      <div className="flex justify-end mb-2">
        <Button size="sm" onClick={() => { setForm({ part_no: '', model_code: '', description: '' }); setDialogOpen(true); }}>
          + 새 모델
        </Button>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-3 py-2 text-left">Part No</th>
              <th className="px-3 py-2 text-left">Model</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-3 py-1 font-mono">{p.part_no}</td>
                <td className="px-3 py-1">{p.model_code}</td>
                <td className="px-3 py-1">{p.description}</td>
                <td className="px-3 py-1 text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setForm(p); setDialogOpen(true); }}>수정</Button>
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
              <h3 className="text-lg font-semibold mb-2">{form.id ? '모델 수정' : '새 모델 추가'}</h3>
              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <Label htmlFor="part_no">Part No</Label>
                  <Input id="part_no" value={form.part_no} onChange={(e) => setForm({ ...form, part_no: e.target.value })} required />
                </div>
                <div>
                  <Label htmlFor="model_code">Model</Label>
                  <Input id="model_code" value={form.model_code} onChange={(e) => setForm({ ...form, model_code: e.target.value })} required />
                </div>
                <div>
                  <Label htmlFor="desc">Description</Label>
                  <Input id="desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>취소</Button>
                  <Button type="submit" size="sm" disabled={upsert.isPending}>{upsert.isPending ? '저장중...' : '저장'}</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
} 