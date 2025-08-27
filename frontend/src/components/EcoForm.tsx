import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useLang } from '@/i18n';
import type { Eco } from '@/hooks/useEcos';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { toast } from 'react-toastify';
import PartMultiSelect from '@/components/PartMultiSelect';
import { useInventory } from '@/hooks/useInventory';

interface Props {
  initial: Partial<Eco>;
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: Partial<Eco>) => void;
  isSaving?: boolean;
  errors?: Record<string, string>;
}

export default function EcoForm({ initial, open, onClose, onSubmit, isSaving, errors = {} }: Props) {
  const { t } = useLang();
  const [form, setForm] = useState<Partial<Eco>>(initial);
  const [localErrors, setLocalErrors] = useState<Record<string,string>>({});
  interface Row { spec: PartSpec; change_details: string; status: 'OPEN' | 'CLOSED'; }
  const [rows, setRows] = useState<Row[]>([]);
  const invQuery = useInventory(rows.map(r=>r.spec.id));

  // reset form & clear local errors whenever dialog opens with new data
  useEffect(()=>{
    setForm(initial);
    // 초기 rows 세팅: initial.details 가 있으면 변환, 없으면 빈 배열
    const dets:any = (initial as any).details || [];
    if(Array.isArray(dets) && dets.length){
      const mapped = dets.map((d:any)=>({
        spec:{ id:d.eco_part_spec, part_no:d.part_no||'', description:d.description||'', model_code:'' } as PartSpec,
        change_details:d.change_details||'',
        status:d.status||'OPEN'
      })) as Row[];
      setRows(mapped);
    }else{
      setRows([]);
    }
    setLocalErrors({});
  },[initial, open]);

  const mergedErrors = {...errors, ...localErrors};

  const errClass = (field:string) => mergedErrors[field] ? 'border-red-500' : '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const required: (keyof Eco)[] = ['eco_no'];
    const missing: Record<string, string> = {};
    required.forEach((k) => {
      const val = (form as any)[k];
      if (!val || String(val).trim() === '') missing[String(k)] = 'required';
    });
    if (Object.keys(missing).length) {
      setLocalErrors(missing);
      toast.error(t('required_error'));
      return;
    }
    if(!rows.length){ toast.error(t('required_error')); return; }
    (form as any).details = rows.map(r=>({eco_part_spec: r.spec.id, change_details: r.change_details, status: r.status}));
    setLocalErrors({});
    onSubmit(form);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <Card className="w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <CardContent className="space-y-4 pt-6">
          <h3 className="text-lg font-semibold mb-2">{form.id ? t('edit_eco') : t('add_eco')}</h3>
          <form className="space-y-4" onSubmit={handleSubmit}>
            {/* 기본 정보 */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="eco_no">{t('eco_no')}</Label>
                <Input id="eco_no" value={form.eco_no || ''} onChange={(e)=>setForm({...form, eco_no:e.target.value})} className={errClass('eco_no')} />
              </div>
              <div>
                <Label htmlFor="eco_model">{t('eco_model')}</Label>
                <Input id="eco_model" value={form.eco_model || ''} onChange={(e)=>setForm({...form, eco_model:e.target.value})} />
              </div>
              <div>
                <Label htmlFor="customer">{t('customer')}</Label>
                <Input id="customer" value={form.customer || ''} onChange={(e)=>setForm({...form, customer:e.target.value})} />
              </div>
            </div>
            
            {/* 날짜 정보 */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="prepared_date">{t('prepared_date')}</Label>
                <Input id="prepared_date" type="date" value={form.prepared_date || ''} onChange={(e)=>setForm({...form, prepared_date:e.target.value})} />
              </div>
              <div>
                <Label htmlFor="issued_date">{t('issued_date')}</Label>
                <Input id="issued_date" type="date" value={form.issued_date || ''} onChange={(e)=>setForm({...form, issued_date:e.target.value})} className={errClass('issued_date')} />
              </div>
              <div>
                <Label htmlFor="applicable_date">{t('applicable_date')}</Label>
                <Input id="applicable_date" type="date" value={form.applicable_date || ''} onChange={(e)=>setForm({...form, applicable_date:e.target.value})} className={errClass('applicable_date')} />
              </div>
            </div>
            
            {/* 변경 사유 및 내용 */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="change_reason">{t('change_reason')}</Label>
                <textarea 
                  id="change_reason" 
                  value={form.change_reason || ''} 
                  onChange={(e)=>setForm({...form, change_reason:e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                />
              </div>
              <div>
                <Label htmlFor="change_details">{t('change_details')}</Label>
                <textarea 
                  id="change_details" 
                  value={form.change_details || ''} 
                  onChange={(e)=>setForm({...form, change_details:e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                />
              </div>
            </div>
            
            {/* 재고 정보 */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="inventory_finished">{t('inventory_finished')}</Label>
                <Input id="inventory_finished" type="number" value={form.inventory_finished || ''} onChange={(e)=>setForm({...form, inventory_finished:Number(e.target.value)})} />
              </div>
              <div>
                <Label htmlFor="inventory_material">{t('inventory_material')}</Label>
                <Input id="inventory_material" type="number" value={form.inventory_material || ''} onChange={(e)=>setForm({...form, inventory_material:Number(e.target.value)})} />
              </div>
              <div>
                <Label htmlFor="storage_action">{t('storage_action')}</Label>
                <Input id="storage_action" value={form.storage_action || ''} onChange={(e)=>setForm({...form, storage_action:e.target.value})} />
              </div>
            </div>
            
            {/* 적용 작업지시 */}
            <div>
              <Label htmlFor="applicable_work_order">{t('applicable_work_order')}</Label>
              <Input id="applicable_work_order" value={form.applicable_work_order || ''} onChange={(e)=>setForm({...form, applicable_work_order:e.target.value})} />
            </div>
            {/* 모델/Part 선택 */}
            <div className="space-y-2">
              <Label>{t('header_model')}</Label>
              <PartMultiSelect onAdd={(sel)=> setRows(prev=> {
                const existingIds = prev.map(r=>r.spec.id);
                const newRows = sel.filter(s=> !existingIds.includes(s.id)).map(s=>({spec:s, change_details:'', status:'OPEN'} as Row));
                return [...prev, ...newRows];
              })} />
              {rows.length>0 && (
                <table className="min-w-full text-sm border mt-2">
                  <thead className="bg-slate-100"><tr><th className="px-2 py-1 text-center">Part No</th><th className="px-2 py-1 text-center">Desc</th><th className="px-2 py-1">변경내용</th><th className="px-2 py-1">재고</th><th className="px-2 py-1">Status</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((row,i)=>(
                       <tr key={row.spec.id} className="border-t">
                         <td className="px-2 py-1 font-mono text-center">{row.spec.part_no}</td>
                         <td className="px-2 py-1 text-xs text-center">{row.spec.description}</td>
                         <td className="px-2 py-1"><Input value={row.change_details} onChange={e=>{
                           const val=e.target.value; setRows(r=>{const cp=[...r]; cp[i]={...cp[i], change_details:val}; return cp;});}} /></td>
                         <td className="px-2 py-1 text-right">{invQuery.data?.[row.spec.id] ?? '-'}</td>
                         <td className="px-2 py-1 text-center"><select value={row.status} onChange={e=>{const val=e.target.value as any; setRows(r=>{const cp=[...r]; cp[i]={...cp[i], status:val}; return cp;});}} className="border rounded px-1 py-0.5 text-xs"><option value="OPEN">OPEN</option><option value="CLOSED">CLOSED</option></select></td>
                         <td className="px-2 py-1 text-right"><Button type="button" size="icon" variant="ghost" onClick={()=>setRows(rows.filter((_,idx)=>idx!==i))}>×</Button></td>
                       </tr>
                     ))}
                  </tbody>
                </table>
              )}
            </div>
            {/* 비고/노트 제거 */}
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
              <Button type="submit" size="sm" disabled={isSaving}>{isSaving ? t('saving') : t('save')}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
} 