import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Report } from '@/hooks/useReports';
import { Button } from '@/components/ui/button';
import { useLang } from '@/i18n';

interface Props {
  initialData: Partial<Report>;
  onSave: (data: Partial<Report>) => void;
  onCancel: () => void;
}

export default function ReportForm({ initialData, onSave, onCancel }: Props) {
  const [f, setF] = useState<Partial<Report>>(initialData);
  const { t } = useLang();

  useEffect(() => {
    setF(initialData);
  }, [initialData]);

  const set = (k: keyof Report, v: any) => {
    setF(prev => ({ ...prev, [k]: v }));
  };

  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      <label className="text-gray-500">{t('report_date')}</label>
      <Input type="date" value={f.date ?? ''} onChange={(e)=>set('date', e.target.value)} />
      <label className="text-gray-500">{t('machine')}</label>
      <Input type="number" value={f.machine_no ?? ''} onChange={(e)=>set('machine_no', +e.target.value)} />
      <label className="text-gray-500">{t('model')}</label>
      <Input value={f.model ?? ''} onChange={(e)=>set('model', e.target.value)} />
      <label className="text-gray-500">Part No</label>
      <Input value={f.part_no ?? ''} onChange={(e)=>set('part_no', e.target.value)} />
      <label className="text-gray-500">{t('plan_qty')}</label>
      <Input type="number" value={f.plan_qty ?? ''} onChange={(e)=>set('plan_qty', +e.target.value)} />
      <label className="text-gray-500">{t('actual_qty')}</label>
      <Input type="number" value={f.actual_qty ?? ''} onChange={(e)=>set('actual_qty', +e.target.value)} />
      <label className="text-gray-500">{t('reported_defect')}</label>
      <Input type="number" value={f.reported_defect ?? ''} onChange={(e)=>set('reported_defect', +e.target.value)} />
      <label className="text-gray-500">{t('actual_defect')}</label>
      <Input type="number" value={f.actual_defect ?? ''} onChange={(e)=>set('actual_defect', +e.target.value)} />
      <label className="text-gray-500">{t('start_dt')}</label>
      <Input type="datetime-local" value={f.start_datetime?.slice(0,16) ?? ''} onChange={(e)=>set('start_datetime', e.target.value)} />
      <label className="text-gray-500">{t('end_dt')}</label>
      <Input type="datetime-local" value={f.end_datetime?.slice(0,16) ?? ''} onChange={(e)=>set('end_datetime', e.target.value)} />
      <label className="text-gray-500">{t('total_time')}</label>
      <Input type="number" value={f.total_time ?? ''} onChange={(e)=>set('total_time', +e.target.value)} />
      <label className="text-gray-500">{t('idle_time')}</label>
      <Input type="number" value={f.total_time && f.operation_time ? f.total_time - f.operation_time : ''} onChange={(e)=>{
        const idle = +e.target.value;
        const total = f.total_time || 0;
        set('operation_time', Math.max(total - idle, 0));
      }} />
      <label className="text-gray-500">{t('header_note')}</label>
      <Textarea value={f.note ?? ''} onChange={(e)=>set('note', e.target.value)} />
      <div className="col-span-2 flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button onClick={()=>onSave(f)}>{t('save')}</Button>
      </div>
    </div>
  );
} 