import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useLang } from '@/i18n';
import type { Eco } from '@/hooks/useEcos';
import { toast } from 'react-toastify';

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

  // reset form & clear local errors whenever dialog opens with new data
  useEffect(()=>{
    setForm(initial);
    setLocalErrors({});
  },[initial, open]);

  const mergedErrors = {...errors, ...localErrors};

  const errClass = (field:string) => mergedErrors[field] ? 'border-red-500' : '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const required: (keyof Eco)[] = ['eco_no', 'eco_model'];
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
    setLocalErrors({});
    onSubmit(form);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
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
                <Input id="eco_model" value={form.eco_model || ''} onChange={(e)=>setForm({...form, eco_model:e.target.value})} className={errClass('eco_model')} />
              </div>
              <div>
                <Label htmlFor="customer">{t('customer')}</Label>
                <Input id="customer" value={form.customer || ''} onChange={(e)=>setForm({...form, customer:e.target.value})} className={errClass('customer')} />
              </div>
              <div>
                <Label htmlFor="prepared_date">{t('prepared_date')}</Label>
                <Input id="prepared_date" type="date" value={form.prepared_date || ''} onChange={(e)=>setForm({...form, prepared_date:e.target.value})} className={errClass('prepared_date')} />
              </div>
              <div>
                <Label htmlFor="issued_date">{t('issued_date')}</Label>
                <Input id="issued_date" type="date" value={form.issued_date || ''} onChange={(e)=>setForm({...form, issued_date:e.target.value})} className={errClass('issued_date')} />
              </div>
              <div>
                <Label htmlFor="due_date">{t('due_date')}</Label>
                <Input id="due_date" type="date" value={form.due_date || ''} onChange={(e)=>setForm({...form, due_date:e.target.value})} className={errClass('due_date')} />
              </div>
            </div>
            {/* 변경 내용 */}
            <div>
              <Label htmlFor="change_reason">{t('change_reason')}</Label>
              <Input id="change_reason" value={form.change_reason || ''} onChange={(e)=>setForm({...form, change_reason:e.target.value})} className={errClass('change_reason')} />
            </div>
            <div>
              <Label htmlFor="change_details">{t('change_details')}</Label>
              <Input id="change_details" value={form.change_details || ''} onChange={(e)=>setForm({...form, change_details:e.target.value})} className={errClass('change_details')} />
            </div>
            <div>
              <Label htmlFor="applicable_work_order">{t('applicable_work_order')}</Label>
              <Input id="applicable_work_order" value={form.applicable_work_order || ''} onChange={(e)=>setForm({...form, applicable_work_order:e.target.value})} className={errClass('applicable_work_order')} />
            </div>
            {/* 재고 및 상태 */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="inventory_finished">{t('inventory_finished')}</Label>
                <Input id="inventory_finished" type="number" value={form.inventory_finished ?? ''} onChange={(e)=>setForm({...form, inventory_finished: e.target.value ? Number(e.target.value) : null})} className={errClass('inventory_finished')} />
              </div>
              <div>
                <Label htmlFor="inventory_material">{t('inventory_material')}</Label>
                <Input id="inventory_material" type="number" value={form.inventory_material ?? ''} onChange={(e)=>setForm({...form, inventory_material: e.target.value ? Number(e.target.value) : null})} className={errClass('inventory_material')} />
              </div>
              <div>
                <Label htmlFor="status">{t('status')}</Label>
                <select id="status" value={form.status || 'OPEN'} onChange={(e)=>setForm({...form, status: e.target.value})} className={`border rounded px-2 py-1 w-full ${errClass('status')}`}>
                  <option value="OPEN">OPEN</option>
                  <option value="WIP">WIP</option>
                  <option value="CLOSED">CLOSED</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="storage_action">{t('storage_action')}</Label>
                <Input id="storage_action" value={form.storage_action || ''} onChange={(e)=>setForm({...form, storage_action:e.target.value})} className={errClass('storage_action')} />
              </div>
              <div>
                <Label htmlFor="applicable_date">{t('applicable_date')}</Label>
                <Input id="applicable_date" type="date" value={form.applicable_date || ''} onChange={(e)=>setForm({...form, applicable_date:e.target.value})} className={errClass('applicable_date')} />
              </div>
              <div>
                <Label htmlFor="form_type">{t('status')}</Label>
                <select id="form_type" value={form.form_type || 'REGULAR'} onChange={(e)=>setForm({...form, form_type: e.target.value as any})} className={`border rounded px-2 py-1 w-full ${errClass('form_type')}`}>
                  <option value="REGULAR">{t('form_type_regular')}</option>
                  <option value="TEMP">{t('form_type_temp')}</option>
                </select>
              </div>
            </div>
            <div>
              <Label htmlFor="note">{t('header_note')}</Label>
              <Input id="note" value={form.note || ''} onChange={(e)=>setForm({...form, note:e.target.value})} className={errClass('note')} />
            </div>
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