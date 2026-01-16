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

  // Separate state for idleTime to manage its changes independently
  const [idleTime, setIdleTime] = useState<number | string>(() => {
    const total = initialData.total_time || 0;
    const op = initialData.operation_time || 0;
    return total > op ? total - op : 0;
  });

  // Persist original values for comparison UI
  const [initialValues] = useState(() => {
    const total = initialData.total_time || 0;
    const op = initialData.operation_time || 0;
    return {
      total_time: total,
      operation_time: op,
      idle_time: total > op ? total - op : 0,
    };
  });

  const set = (k: keyof Report, v: any) => {
    setF(prev => ({ ...prev, [k]: v }));
  };

  // Auto-update total_time when start/end datetimes change
  useEffect(() => {
    if (f.start_datetime && f.end_datetime) {
      try {
        const start = new Date(f.start_datetime);
        const end = new Date(f.end_datetime);
        const diffMs = end.getTime() - start.getTime();
        const newTotalTime = diffMs > 0 ? Math.floor(diffMs / 60000) : 0;
        set('total_time', newTotalTime);
      } catch (_e) {
        // Invalid date string, do nothing
      }
    }
  }, [f.start_datetime, f.end_datetime]);

  // Derived values for display
  const currentTotalTime = f.total_time || 0;
  const currentIdleTime = Number(idleTime) || 0;
  const currentOperationTime = currentTotalTime - currentIdleTime > 0 ? currentTotalTime - currentIdleTime : 0;

  const handleSaveClick = () => {
    const note = f.note || '';
    let proceedToSave = true;

    // If idle time is 0 but there is a note, confirm with the user
    if (currentIdleTime === 0 && note.trim() !== '') {
      if (!window.confirm(t('confirm_idle_zero') || '부동시간이 0이 맞습니까?')) {
        proceedToSave = false;
      }
    }

    if (proceedToSave) {
      // Pass the final calculated operation_time to the parent
      const payload = { ...f };
      delete payload.operation_time; // Remove derived field
      payload.idle_time = currentIdleTime; // Add idle_time
      onSave(payload);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      {/* Other Fields */}
      <label className="text-gray-500">{t('report_date')}</label>
      <Input type="date" value={f.date ?? ''} onChange={(e) => set('date', e.target.value)} />
      <label className="text-gray-500">{t('machine')}</label>
      <Input type="number" value={f.machine_no ?? ''} onChange={(e) => set('machine_no', +e.target.value)} />
      <label className="text-gray-500">{t('model')}</label>
      <Input value={f.model ?? ''} onChange={(e) => set('model', e.target.value)} />
      <label className="text-gray-500">Part No</label>
      <Input value={f.part_no ?? ''} onChange={(e) => set('part_no', e.target.value)} />
      <label className="text-gray-500">{t('plan_qty')}</label>
      <Input type="number" value={f.plan_qty ?? ''} onChange={(e) => set('plan_qty', +e.target.value)} />
      <label className="text-gray-500">{t('actual_qty')}</label>
      <Input type="number" value={f.actual_qty ?? ''} onChange={(e) => set('actual_qty', +e.target.value)} />
      <label className="text-gray-500">{t('reported_defect')}</label>
      <Input type="number" value={f.reported_defect ?? ''} onChange={(e) => set('reported_defect', +e.target.value)} />
      <label className="text-gray-500">{t('actual_defect')}</label>
      <Input type="number" value={f.actual_defect ?? ''} onChange={(e) => set('actual_defect', +e.target.value)} />

      {/* Time Fields with Comparison UI */}
      <label className="text-gray-500">{t('start_dt')}</label>
      <Input type="datetime-local" value={f.start_datetime?.slice(0, 16) ?? ''} onChange={(e) => set('start_datetime', e.target.value)} />

      <label className="text-gray-500">{t('end_dt')}</label>
      <Input type="datetime-local" value={f.end_datetime?.slice(0, 16) ?? ''} onChange={(e) => set('end_datetime', e.target.value)} />

      <label className="text-gray-500">{t('total_time')}</label>
      <div className="flex items-center gap-2">
        <Input type="number" value={f.total_time ?? ''} onChange={(e) => set('total_time', +e.target.value)} />
        <span className="text-xs text-gray-500 whitespace-nowrap">
          ({initialValues.total_time} → {currentTotalTime})
        </span>
      </div>

      <label className="text-gray-500">{t('idle_time')}</label>
      <div className="flex items-center gap-2">
        <Input type="number" value={idleTime} onChange={(e) => setIdleTime(e.target.value === '' ? '' : +e.target.value)} />
        <span className="text-xs text-gray-500 whitespace-nowrap">
          ({initialValues.idle_time} → {currentIdleTime})
        </span>
      </div>

      <label className="text-gray-500">{t('run_time')}</label>
      <div className="flex items-center gap-2">
        <Input type="number" value={currentOperationTime} disabled className="bg-gray-100" />
        <span className="text-xs text-gray-500 whitespace-nowrap">
          ({initialValues.operation_time} → {currentOperationTime})
        </span>
      </div>

      <label className="text-gray-500">{t('header_note')}</label>
      <Textarea value={f.note ?? ''} onChange={(e) => set('note', e.target.value)} className="col-span-2 md:col-span-1" />

      {/* Action Buttons */}
      <div className="col-span-2 flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
        <Button onClick={handleSaveClick}>{t('save')}</Button>
      </div>
    </div>
  );
}