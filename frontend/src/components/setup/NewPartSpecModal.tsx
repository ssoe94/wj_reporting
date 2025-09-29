import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import type { PartSpec } from '@/hooks/usePartSpecs';

interface NewPartSpecModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newPart: PartSpec) => void;
  initialPartNo: string;
  initialModelCode?: string;
}

export default function NewPartSpecModal({
  isOpen,
  onClose,
  onSuccess,
  initialPartNo,
  initialModelCode,
}: NewPartSpecModalProps) {
  const { t } = useLang();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [newPartForm, setNewPartForm] = useState<Partial<PartSpec>>({});

  useEffect(() => {
    if (isOpen) {
      const initialFormState = {
        part_no: initialPartNo,
        model_code: initialModelCode || '',
        description: '',
        cycle_time_sec: undefined,
        valid_from: new Date().toISOString().split('T')[0],
      };
      setNewPartForm(initialFormState);
      
      // Prefill logic
      const prefill = async () => {
        if (initialPartNo && initialPartNo.length >= 9) {
          try {
            const prefix = initialPartNo.substring(0, 9);
            const { data } = await api.get('/parts/', { params: { search: prefix, page_size: 1 } });
            if (data.results && data.results.length > 0) {
              const similarPart = data.results[0];
              const confirmPrefill = window.confirm(
                t('similar_parts_prompt', { first: similarPart.part_no, count: data.count })
              );
              if (confirmPrefill) {
                setNewPartForm({
                  ...initialFormState,
                  model_code: similarPart.model_code,
                  description: similarPart.description,
                  cycle_time_sec: similarPart.cycle_time_sec,
                });
              }
            }
          } catch (err) {
            console.error("Prefill search failed", err);
          }
        }
      };
      prefill();
    }
  }, [isOpen, initialPartNo, t]);

  const handleFormChange = (field: keyof PartSpec, value: any) => {
    setNewPartForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!newPartForm.part_no || !newPartForm.model_code || !newPartForm.description) {
      toast.error(t('required_error'));
      return;
    }

    setLoading(true);
    setError('');
    try {
      const response = await api.post('/parts/', newPartForm);
      toast.success(t('new_part_added_success'));
      onSuccess(response.data);
    } catch (err: any) {
      setError(err.response?.data?.detail || t('save_fail'));
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
        <h3 className="text-lg font-semibold mb-2">{t('add_new_part_spec')}</h3>
        <div className="grid grid-cols-1 gap-3">
          <input
            placeholder="Part No *"
            className="border rounded px-2 py-1"
            value={newPartForm.part_no || ''}
            onChange={(e) => handleFormChange('part_no', e.target.value)}
          />
          <input
            placeholder="Model Code *"
            className="border rounded px-2 py-1"
            value={newPartForm.model_code || ''}
            onChange={(e) => handleFormChange('model_code', e.target.value)}
          />
          <input
            placeholder="Description *"
            className="border rounded px-2 py-1"
            value={newPartForm.description || ''}
            onChange={(e) => handleFormChange('description', e.target.value)}
          />
          <input
            placeholder="Cycle Time (sec)"
            type="number"
            className="border rounded px-2 py-1"
            value={newPartForm.cycle_time_sec || ''}
            onChange={(e) => handleFormChange('cycle_time_sec', e.target.value ? parseInt(e.target.value) : undefined)}
          />
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={newPartForm.valid_from || ''}
            onChange={(e) => handleFormChange('valid_from', e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={loading}>
            {loading ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
